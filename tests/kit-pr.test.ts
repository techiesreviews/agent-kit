import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const pr = resolve("scripts/agents/kit.d/pr");
const kit = resolve("scripts/agents/kit");
interface Call { tool: string; args: string[]; body?: string }
const fake = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { basename } = require("node:path");
const tool = basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
const bodyIndex = args.indexOf("--body-file");
appendFileSync(env.FAKE_CALLS, JSON.stringify({ tool, args, ...(bodyIndex >= 0 ? { body: readFileSync(args[bodyIndex + 1], "utf8") } : {}) }) + "\\n");
const action = tool === "npm" ? (args[0] === "test" ? "unit" : args[1]) : tool === "fake-kit" ? args[0] : args.slice(0, 2).join("-");
if (env.FAKE_FAIL === action) {
  for (let i = 1; i <= 35; i++) console.error("failure line " + i);
  if (tool === "fake-kit") console.log("RESULT: fail child failure");
  process.exit(1);
}
if (tool === "fake-kit") console.log("RESULT: ok " + args[0] + " done");
else if (tool === "gh") {
  if (action === "pr-list") console.log(env.FAKE_EXISTING ? '[{"number":73}]' : "[]");
  else if (action === "pr-create") console.log(env.FAKE_BAD_URL ? "no URL" : "https://github.com/test/repo/pull/73");
  else if (action === "repo-view") console.log("test/repo");
  else if (action === "api-graphql") {
    if (env.FAKE_QUEUE_ERROR) { console.error("queue unavailable"); process.exit(1); }
    console.log(env.FAKE_QUEUE ? "queue-id" : "");
  } else if (action === "pr-merge") {
    const path = env.FAKE_CALLS + ".merges";
    const count = existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
    writeFileSync(path, String(count + 1));
    if (count < Number(env.FAKE_BEHIND || 0)) {
      if (env.FAKE_ADVANCE) {
        const { execFileSync } = require("node:child_process");
        const git = (...argv) => execFileSync("git", ["-C", env.FAKE_ADVANCE, ...argv], { stdio: "ignore", timeout: 10_000 });
        writeFileSync(env.FAKE_ADVANCE + "/upstream.txt", "upstream " + count + "\\n");
        git("add", "upstream.txt"); git("commit", "-m", "advance upstream"); git("push", "origin", "dev");
      }
      if (env.FAKE_AFTER_PUSH) require("node:child_process").execFileSync(env.FAKE_AFTER_PUSH, { stdio: "ignore", timeout: 10_000 });
      console.error(env.FAKE_BEHIND_TEXT || "head branch is behind"); process.exit(1);
    }
  } else if (action === "pr-view") {
    if (env.FAKE_VIEW_ERROR) process.exit(1);
    console.log(env.FAKE_MERGED || "abcdef0123456789abcdef0123456789abcdef01");
  }
}
`;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-pr-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git"), root = join(dir, "work"), main = join(dir, "main"), bin = join(dir, "bin");
  mkdirSync(bin); mkdirSync(main);
  for (const name of ["npm", "gh", "fake-kit"]) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
  // kit-lib's nodeEnv puts the Node directory first on PATH; where npm sits beside node (CI), that would
  // shadow the fake npm. A node link here makes bin the Node directory itself (same fix as kit-deps).
  symlinkSync(process.execPath, join(bin, "node"));
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: root, KIT_MAIN_ROOT: main,
    ASE_OWNER: "ak-14", KIT_PR_KIT: join(bin, "fake-kit"), FAKE_CALLS: join(dir, "calls.jsonl"), CLAUDECODE: "",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) if (key.startsWith("FAKE_") && key !== "FAKE_CALLS") delete env[key];
  const gitAt = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  gitAt(dir, "init", "--bare", "--initial-branch=dev", origin);
  gitAt(dir, "clone", origin, root);
  const git = (...args: string[]) => gitAt(root, ...args);
  git("config", "user.name", "Kit test"); git("config", "user.email", "kit@example.com");
  writeFileSync(join(root, ".gitignore"), ".scratch/\n");
  writeFileSync(join(root, "file.txt"), "base\n");
  writeFileSync(join(root, "ticket.md"), '---\ntitle: "Ticket title"\n---\n\nTask\n');
  git("add", "."); git("commit", "-m", "base");
  git("branch", "main"); git("push", "origin", "dev", "main");
  git("checkout", "-b", "feature/kit-pr");
  const commit = (subject: string, file = "feature.txt", content = `${subject}\n`) => {
    writeFileSync(join(root, file), content); git("add", file); git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  commit("First change"); const head = commit("Second change");
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}, front = false) => {
    const result = spawnSync(front ? kit : pr, front ? ["pr", ...args] : args, { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 25_000 });
    assert.equal(result.error, undefined, result.error?.message);
    const results = result.stdout.split("\n").filter(line => line.startsWith("RESULT: "));
    if (args.length !== 1 || !["--help", "-h"].includes(args[0])) {
      assert.equal(results.length, 1, result.stdout);
      assert.equal(result.stdout.trimEnd().split("\n").at(-1), results[0]);
    }
    return result;
  };
  const calls = (): Call[] => existsSync(env.FAKE_CALLS!) ? readFileSync(env.FAKE_CALLS!, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const ghCalls = (verb: string) => calls().filter(call => call.tool === "gh" && call.args[0] === "pr" && call.args[1] === verb);
  const body = () => ghCalls("create").at(-1)?.body || ghCalls("edit").at(-1)?.body || "";
  const logDir = () => join(root, ".scratch/pr", readdirSync(join(root, ".scratch/pr")).at(-1)!);
  const peer = () => {
    const path = join(dir, "peer"); gitAt(dir, "clone", origin, path);
    gitAt(path, "config", "user.name", "Peer"); gitAt(path, "config", "user.email", "peer@example.com");
    return path;
  };
  return { dir, root, main, origin, env, git, gitAt, head, commit, run, calls, ghCalls, body, logDir, peer };
}

test("help and argument errors, including the kit front door", t => {
  const f = fixture(t);
  for (const arg of ["--help", "-h"]) {
    const result = f.run([arg]); assert.equal(result.status, 0); assert.match(result.stdout, /Usage: kit pr/); assert.doesNotMatch(result.stdout, /RESULT:/);
  }
  for (const args of [["--wat"], ["--base"], ["--title"], ["--ticket", "--no-merge"], ["--base", "dev", "--base", "main"]]) {
    const result = f.run(args, {}, true); assert.equal(result.status, 2); assert.match(result.stderr, /Usage:/); assert.match(result.stdout, /RESULT: fail invalid arguments: /);
  }
  assert.deepEqual(f.calls(), []);
});

test("guards refuse dirty trees, protected branches, detached HEAD and invalid releases before child calls", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "untracked"), "dirty");
  let result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail guards: uncommitted changes/);
  rmSync(join(f.root, "untracked"));
  for (const branch of ["dev", "main"]) {
    f.git("checkout", branch); result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, new RegExp(`refusing branch ${branch}`));
  }
  f.git("checkout", "--detach", f.head); result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /detached HEAD/);
  f.git("checkout", "feature/kit-pr");
  for (const args of [["--base", "main"], ["--release"], ["--base", "feature/kit-pr"]]) {
    result = f.run(args); assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail guards:/);
  }
  assert.deepEqual(f.calls(), []);
});

test("deps failure stops before fetch, prints only log tail and one final result", t => {
  const f = fixture(t), result = f.run([], { FAKE_FAIL: "deps" });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail deps:/);
  assert.doesNotMatch(result.stderr, /failure line 1\n/); assert.match(result.stderr, /failure line 35/);
  assert.equal(existsSync(join(f.logDir(), "fetch.log")), false);
  assert.deepEqual(f.calls().map(call => call.args), [["deps", "check"]]);
});

test("rebase conflicts list files, abort and restore a clean branch", t => {
  const f = fixture(t); f.commit("feature conflict", "file.txt", "feature\n");
  const head = f.git("rev-parse", "HEAD"), peer = f.peer();
  writeFileSync(join(peer, "file.txt"), "upstream\n");
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "upstream conflict"); f.gitAt(peer, "push", "origin", "dev");
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail rebase: conflict in file.txt/);
  assert.equal(f.git("rev-parse", "HEAD"), head); assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(existsSync(join(f.root, ".git/rebase-merge")), false); assert.equal(existsSync(join(f.root, ".git/rebase-apply")), false);
});

test("dry-run builds the body, shows next commands and neither pushes nor calls gh", t => {
  const f = fixture(t), refs = f.gitAt(f.origin, "show-ref"), result = f.run(["--dry-run", "--ticket", "ticket.md"], {}, true);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok dry-run [a-f0-9]{7} feature\/kit-pr -> dev/);
  for (const text of ["branch: feature/kit-pr", "base: dev", `HEAD: ${f.head}`, "title: Ticket title", "body:", "'push'", "'create'", "'review'", "gh pr merge"])
    assert.ok(result.stdout.includes(text), text);
  assert.equal(f.gitAt(f.origin, "show-ref"), refs); assert.equal(f.calls().some(call => call.tool === "gh"), false);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /Ticket: Ticket title \(ticket.md\)/);
});

test("PR body includes ordered commits, checks, ticket and conditional Claude credit", t => {
  for (const mode of ["none", "env", "trailer"]) {
    const f = fixture(t);
    if (mode === "trailer") f.commit("Third change\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    const result = f.run(["--ticket", "ticket.md", "--no-merge"], { CLAUDECODE: mode === "env" ? "1" : "" });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}/);
    const body = f.body();
    assert.match(body, /^Ticket: Ticket title \(ticket.md\)\n\n## Summary\n\n- First change\n- Second change/);
    for (const line of ["- npm run check: ok", "- npm test: ok", "- npm run lint: ok", "- kit specs --affected --base origin/dev: RESULT: ok specs done"])
      assert.ok(body.includes(line), line);
    assert.equal(body.includes("🤖 Generated with [Claude Code](https://claude.com/claude-code)"), mode !== "none");
    if (mode !== "none") assert.match(body.trimEnd(), /🤖 Generated with \[Claude Code\]\(https:\/\/claude.com\/claude-code\)$/);
    const create = f.ghCalls("create")[0]; assert.equal(create.args[create.args.indexOf("--title") + 1], "Ticket title");
    assert.equal(f.ghCalls("merge").length, 0);
    assert.deepEqual(f.calls().filter(call => call.tool === "fake-kit").at(-1)?.args, ["review", "--base", "origin/dev", "--pr", "73", "--ticket", "ticket.md"]);
  }
});

test("explicit title wins; latest subject is the fallback; existing PR body is updated", t => {
  for (const explicit of [false, true]) {
    const f = fixture(t), result = f.run(["--no-merge", ...(explicit ? ["--title", "Chosen title", "--ticket", "ticket.md"] : [])]);
    assert.equal(result.status, 0, result.stderr);
    const args = f.ghCalls("create")[0].args;
    assert.equal(args[args.indexOf("--title") + 1], explicit ? "Chosen title" : "Second change");
  }
  const f = fixture(t), result = f.run(["--no-merge"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stderr); assert.equal(f.ghCalls("create").length, 0);
  assert.deepEqual(f.ghCalls("edit")[0].args.slice(0, 4), ["pr", "edit", "73", "--body-file"]);
  assert.match(f.body(), /## Summary/);
});

test("release into main opens but never waits or merges", t => {
  const f = fixture(t), result = f.run(["--base", "main", "--release"]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok opened #73/);
  assert.equal(f.ghCalls("merge").length, 0); assert.equal(f.calls().some(call => call.args[0] === "wait"), false);
  assert.ok(f.ghCalls("create")[0].args.includes("main"));
});

test("newest complete saved review of the whole PR is posted; incomplete, partial-scope and mismatched ones are skipped", t => {
  const f = fixture(t), parent = join(f.main, ".scratch/reviews/ak-14");
  const base = f.git("merge-base", "origin/dev", "HEAD"), parentCommit = f.git("rev-parse", "HEAD~1");
  const complete = (text: string) => `REVIEW_STATUS: complete\n${text}`;
  for (const [name, head, reviewedBase, report] of [["20261016T100000Z", f.head, base, complete("old")], ["20261016T110000Z", f.head, base, complete("chosen")],
    ["20261016T120000Z", "wrong-head", base, complete("wrong")], ["20261016T130000Z", f.head, base, ""],
    ["20261016T140000Z", f.head, base, "REVIEW_STATUS: incomplete\nhalf a report"], ["20261016T150000Z", f.head, parentCommit, complete("one commit only")]]) {
    const folder = join(parent, name); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "refs.txt"), `${head}\n${reviewedBase}\n`);
    if (report) writeFileSync(join(folder, "result.md"), `${report}\n`);
  }
  const result = f.run(["--no-merge"]);
  assert.equal(result.status, 0, result.stderr); assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), false);
  assert.equal(f.ghCalls("comment")[0].body, `Reused review: ${join(parent, "20261016T110000Z")}\nHEAD: ${f.head}\n\n${complete("chosen")}\n`);
});

test("an incomplete or single-commit review for this HEAD is not reused", t => {
  for (const kind of ["incomplete", "single-commit"]) {
    const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261016T120000Z");
    const base = kind === "incomplete" ? f.git("merge-base", "origin/dev", "HEAD") : f.git("rev-parse", "HEAD~1");
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "refs.txt"), `${f.head}\n${base}\n`);
    writeFileSync(join(folder, "result.md"), kind === "incomplete" ? "REVIEW_STATUS: incomplete\n" : "REVIEW_STATUS: complete\n");
    const result = f.run(["--no-merge"]); assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), kind);
    assert.equal(f.ghCalls("comment").length, 0, kind);
  }
});

test("a saved review for another HEAD triggers kit review --pr", t => {
  const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261016T120000Z");
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "refs.txt"), "wrong\nbase\n"); writeFileSync(join(folder, "result.md"), "wrong report\n");
  const result = f.run(["--no-merge"]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().find(call => call.tool === "fake-kit" && call.args[0] === "review")?.args, ["review", "--base", "origin/dev", "--pr", "73"]);
  assert.equal(f.ghCalls("comment").length, 0);
});

test("no queue waits for CI then merges with --repo, preserving the local branch", t => {
  for (const queueError of [false, true]) {
    const f = fixture(t), result = f.run([], { FAKE_QUEUE_ERROR: queueError ? "1" : "" });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok merged #73 abcdef0/);
    assert.deepEqual(f.ghCalls("merge")[0].args, ["pr", "merge", "73", "--rebase", "--delete-branch", "--match-head-commit", f.head, "--repo", "test/repo"]);
    const calls = f.calls(), wait = calls.findIndex(call => call.tool === "fake-kit" && call.args[0] === "wait");
    assert.deepEqual(calls[wait].args, ["wait", "ci", "--pr", "73"]);
    assert.ok(wait < calls.findIndex(call => call.args[1] === "merge"));
    assert.equal(f.git("branch", "--show-current"), "feature/kit-pr");
    assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), f.head);
  }
});

test("queue uses auto-rebase, skips wait, and passes owner/name/base to graphql", t => {
  const f = fixture(t), result = f.run([], { FAKE_QUEUE: "1" });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok queued #73/);
  assert.deepEqual(f.ghCalls("merge")[0].args, ["pr", "merge", "73", "--auto", "--rebase", "--match-head-commit", f.head, "--repo", "test/repo"]);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
  const graphql = f.calls().find(call => call.args[0] === "api")!;
  for (const value of ["o=test", "n=repo", "b=dev", '.data.repository.mergeQueue.id // ""']) assert.ok(graphql.args.includes(value));
});

test("behind retry fetches, rebases, pushes the new HEAD and waits again", t => {
  const f = fixture(t), peer = f.peer();
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_VIEW_ERROR: "1" });
  assert.equal(result.status, 0, result.stderr); assert.equal(f.ghCalls("merge").length, 2);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "wait").length, 2);
  const head = f.git("rev-parse", "HEAD"); assert.notEqual(head, f.head);
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
  assert.ok(result.stdout.includes(`RESULT: ok merged #73 ${head.slice(0, 7)}`));
  assert.equal(result.stdout.split("\n").filter(line => line === "push: ok").length, 2);
});

test("a PR head changed by someone else is never merged or overwritten", t => {
  const f = fixture(t), result = f.run([], { FAKE_BEHIND: "1", FAKE_BEHIND_TEXT: "GraphQL: Head branch was modified. Review and try the merge again." });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail merge: PR head is no longer [a-f0-9]{7}; review the new head first/);
  assert.equal(f.ghCalls("merge").length, 1);
  assert.equal(result.stdout.split("\n").filter(line => line === "push: ok").length, 1);
});

test("a retry push leases against our own last push, not a foreign push", t => {
  const f = fixture(t), peer = f.peer();
  // The peer pushes to our PR branch while the merge is refused as behind.
  const sneak = join(f.dir, "sneak.sh");
  writeFileSync(sneak, `#!/bin/sh\nset -e\ncd "${peer}"\ngit fetch -q origin feature/kit-pr\ngit checkout -q -B feature/kit-pr FETCH_HEAD\necho foreign > foreign.txt\ngit add foreign.txt\ngit commit -qm foreign\ngit push -q origin HEAD:feature/kit-pr\n`);
  chmodSync(sneak, 0o755);
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_AFTER_PUSH: sneak });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail push:/);
  assert.match(f.gitAt(f.origin, "log", "-1", "--format=%s", "refs/heads/feature/kit-pr"), /foreign/);
});

test("behind failures stop at three merge attempts", t => {
  const f = fixture(t), result = f.run([], { FAKE_BEHIND: "3" });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail merge: still behind after 3 attempts/);
  assert.equal(f.ghCalls("merge").length, 3);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "wait").length, 3);
  assert.equal(result.stdout.split("\n").filter(line => line === "push: ok").length, 3);
});

test("local, PR, review, CI and merge failures identify the step and stop", t => {
  for (const [action, step] of [["check", "check"], ["unit", "unit"], ["lint", "lint"], ["specs", "specs"],
    ["pr-list", "open"], ["pr-create", "open"], ["review", "review"], ["wait", "ci"], ["pr-merge", "merge"]]) {
    const f = fixture(t), result = f.run([], { FAKE_FAIL: action });
    assert.equal(result.status, 1, result.stderr); assert.ok(result.stdout.includes(`RESULT: fail ${step}:`), result.stdout);
    if (["check", "unit", "lint", "specs"].includes(step)) assert.equal(f.calls().some(call => call.tool === "gh"), false);
    if (["open", "review", "ci"].includes(step)) assert.equal(f.ghCalls("merge").length, 0);
  }
});

test("a colleague's commit already on the PR branch is not overwritten by the first push", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "-b", "feature/kit-pr"); writeFileSync(join(peer, "foreign.txt"), "foreign\n");
  f.gitAt(peer, "add", "foreign.txt"); f.gitAt(peer, "commit", "-qm", "foreign"); f.gitAt(peer, "push", "-q", "origin", "feature/kit-pr");
  const result = f.run(); assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail push:/);
  assert.match(f.gitAt(f.origin, "log", "-1", "--format=%s", "refs/heads/feature/kit-pr"), /foreign/);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a rerun after our own earlier push updates the branch", t => {
  const f = fixture(t);
  f.git("push", "-q", "origin", "HEAD:refs/heads/feature/kit-pr");
  const head = f.commit("Third change");
  const result = f.run(["--no-merge"]); assert.equal(result.status, 0, result.stderr);
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
});

test("push rejection and an unparseable create URL fail at their steps", t => {
  const f = fixture(t), hook = join(f.origin, "hooks/pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'push refused' >&2\nexit 1\n"); chmodSync(hook, 0o755);
  const rejected = f.run(); assert.equal(rejected.status, 1); assert.match(rejected.stdout, /RESULT: fail push:/);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
  rmSync(hook);
  const badUrl = f.run([], { FAKE_BAD_URL: "1" }); assert.equal(badUrl.status, 1); assert.match(badUrl.stdout, /RESULT: fail open: could not determine PR number/);
});
