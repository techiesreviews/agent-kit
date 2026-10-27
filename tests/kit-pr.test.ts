import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { checkSteps, classify, featureListGuard, focusedUnitFiles, parseChanges, visiblePath } from "../scripts/agents/pr-tier.mjs";
import { sameReviewPatch } from "../scripts/agents/review-findings.mjs";
import { forEachAwait } from "./support/await-race.ts";
import type { ScoreRecord } from "./kit-score.test.ts";

const pr = resolve("scripts/agents/kit.d/pr");
const kit = resolve("scripts/agents/kit");
const cleanReview = "REVIEW_STATUS: complete\nDefects:\n- Spec: none.\n- Standards: none.\nValidation gaps: none.\nOptional nits: none.\n";
interface Call { tool: string; args: string[]; body?: string }
const fake = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const tool = basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
const bodyIndex = args.indexOf("--body-file");
const bodyField = args.find(arg => arg.startsWith("body=@"));
const bodyPath = bodyIndex >= 0 ? args[bodyIndex + 1] : bodyField?.slice("body=@".length);
appendFileSync(env.FAKE_CALLS, JSON.stringify({ tool, args, ...(bodyPath ? { body: readFileSync(bodyPath, "utf8") } : {}) }) + "\\n");
const scripts = { "unit.sh": "unit", "tickets.mjs": "tickets", "check-colours.mjs": "colours" };
const action = tool === "npm" ? (args[0] === "test" ? "unit" : args[1]) : scripts[tool] || (tool === "fake-kit" ? args[0] : args.slice(0, 2).join("-"));
if (env.FAKE_FAIL === action) {
  for (let i = 1; i <= 35; i++) console.error("failure line " + i);
  if (tool === "fake-kit") console.log("RESULT: fail child failure");
  process.exit(1);
}
if (tool === "fake-kit" && action === "review") {
  const count = readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
    .filter(call => call.tool === "fake-kit" && call.args[0] === "review").length;
  const folder = join(env.KIT_MAIN_ROOT, ".scratch/reviews", env.ASE_OWNER, count === 1 ? "fresh" : "fresh-" + count);
  mkdirSync(folder, { recursive: true });
  const report = (count > 1 && env.FAKE_REBASED_REVIEW) || env.FAKE_REVIEW || ${JSON.stringify(cleanReview)};
  if (!env.FAKE_REVIEW_MISSING) writeFileSync(join(folder, "result.md"), report);
  const { execFileSync } = require("node:child_process");
  const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
  writeFileSync(join(folder, "refs.txt"), git("rev-parse", "HEAD") + "\\n" + git("merge-base", "origin/" + (env.FAKE_BASE || "dev"), "HEAD") + "\\n");
  console.log("RESULT: ok review git diff base...HEAD evidence " + folder);
} else if (tool === "fake-kit") console.log("RESULT: ok " + args[0] + " done");
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
        if (env.FAKE_ADVANCE_PATCH) {
          writeFileSync(env.FAKE_ADVANCE + "/feature.txt", "First change\\n");
          git("add", "feature.txt");
        }
        git("add", "upstream.txt"); git("commit", "-m", "advance upstream"); git("push", "origin", "dev");
      }
      if (env.FAKE_AFTER_PUSH) require("node:child_process").execFileSync(env.FAKE_AFTER_PUSH, { stdio: "ignore", timeout: 10_000 });
      console.error(env.FAKE_BEHIND_TEXT || "head branch is behind"); process.exit(1);
    }
  } else if (action === "pr-view") {
    if (env.FAKE_VIEW_ERROR) process.exit(1);
    if (args.includes("comments")) {
      const comments = readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
        .filter(call => call.tool === "gh" && call.args[0] === "pr" && call.args[1] === "comment");
      console.log(JSON.stringify({ comments }));
      process.exit(0);
    }
    console.log(env.FAKE_MERGED || "abcdef0123456789abcdef0123456789abcdef01");
  }
}
`;

// Default branch: two commits to feature.txt (full tier). `changes` replaces them with one commit of these files.
// `settings` replaces this editor's settings; `workflows: false` leaves out the CI workflow.
function fixture(t: TestContext, changes?: Record<string, string>, override: Record<string, unknown> = {},
  { settings: own, workflows = true }: { settings?: Record<string, unknown>; workflows?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kit-pr-"));
  const children: ChildProcess[] = [], releases: string[] = [];
  t.after(async () => {
    for (const release of releases) writeFileSync(release, "cleanup");
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      child.kill("SIGTERM");
      return new Promise<void>(accept => child.once("close", () => accept()));
    }));
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = join(dir, "origin.git"), root = join(dir, "work"), main = join(dir, "main"), bin = join(dir, "bin");
  mkdirSync(bin); mkdirSync(main);
  for (const name of ["npm", "gh", "fake-kit", "fake.cjs"]) { writeFileSync(join(bin, name), fake); chmodSync(join(bin, name), 0o755); }
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
  // Repo scripts the smaller tiers run, as fakes that record their calls.
  mkdirSync(join(root, "scripts/agents"), { recursive: true }); mkdirSync(join(root, "tests"));
  const wrapper = `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)(${JSON.stringify(join(bin, "fake.cjs"))});\n`;
  for (const path of ["scripts/agents/tickets.mjs", "scripts/check-colours.mjs"]) writeFileSync(join(root, path), wrapper);
  writeFileSync(join(root, "scripts/agents/unit.sh"), fake); chmodSync(join(root, "scripts/agents/unit.sh"), 0o755);
  // KIT_HOME is this project's scripts/agents, holding the fakes, with the real commands and library beside them.
  for (const name of ["kit.d", "kit-lib.sh", "kit-lib.mjs"]) symlinkSync(resolve("scripts/agents", name), join(root, "scripts/agents", name));
  env.KIT_HOME = join(root, "scripts/agents");
  for (const name of ["a", "code-map"]) writeFileSync(join(root, `tests/${name}.test.ts`), `// ${name}\n`);
  writeFileSync(join(root, "tests/b.test.ts"), 'import "./fakes/thing.ts";\n');
  // This editor's settings, without its machine folders, and its specs command and CI workflow.
  const { mainRoot: _main, devRoot: _dev, ...settings } = JSON.parse(readFileSync("scripts/agents/kit.json", "utf8"));
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify(own ?? { ...settings, ...override }));
  mkdirSync(join(root, "scripts/agents/project.d"));
  writeFileSync(join(root, "scripts/agents/project.d/specs"), "#!/bin/sh\n", { mode: 0o755 });
  if (workflows) { mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows/ci.yml"), "on: pull_request\n"); }
  git("add", "."); git("commit", "-m", "base");
  git("branch", "main"); git("push", "origin", "dev", "main");
  git("checkout", "-b", "feature/kit-pr");
  const commit = (subject: string, file = "feature.txt", content = `${subject}\n`) => {
    writeFileSync(join(root, file), content); git("add", file); git("commit", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  let head: string;
  if (changes) {
    for (const [file, content] of Object.entries(changes)) { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), content); }
    git("add", "."); git("commit", "-m", "Scoped change"); head = git("rev-parse", "HEAD");
  } else { commit("First change"); head = commit("Second change"); }
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
  const start = (overrides: NodeJS.ProcessEnv) => {
    if (overrides.FAKE_HOLD_RELEASE) releases.push(overrides.FAKE_HOLD_RELEASE);
    const child = spawn(pr, ["--ticket", "ticket.md"], { cwd: root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((accept, reject) => {
      child.once("error", reject); child.once("close", status => accept({ status, stdout, stderr }));
    });
  };
  const calls = (): Call[] => existsSync(env.FAKE_CALLS!) ? readFileSync(env.FAKE_CALLS!, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const ghCalls = (verb: string) => calls().filter(call => call.tool === "gh" && call.args[0] === "pr" && call.args[1] === verb);
  const apiCalls = () => calls().filter(call => call.tool === "gh" && call.args[0] === "api");
  const body = () => ghCalls("create").at(-1)?.body || apiCalls().at(-1)?.body || "";
  const logDir = () => join(root, ".scratch/pr", readdirSync(join(root, ".scratch/pr")).at(-1)!);
  const peer = () => {
    const path = join(dir, "peer"); gitAt(dir, "clone", origin, path);
    gitAt(path, "config", "user.name", "Peer"); gitAt(path, "config", "user.email", "peer@example.com");
    return path;
  };
  const saveReview = (report: string, owner = env.ASE_OWNER!) => {
    const folder = join(main, ".scratch/reviews", owner, "20261019T100000Z");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "refs.txt"), `${git("rev-parse", "HEAD")}\n${git("merge-base", "origin/dev", "HEAD")}\n`);
    const path = join(folder, "result.md");
    writeFileSync(path, report);
    return path;
  };
  const rounds = (count: number, pending?: number, local = false) => {
    const folder = join(local ? root : main, ".scratch/kit-fix", encodeURIComponent("feature/kit-pr"));
    mkdirSync(folder, { recursive: true });
    for (let i = 1; i <= count; i++) writeFileSync(join(folder, `round-${i}.md`), "fix brief");
    if (pending) writeFileSync(join(folder, "pending.json"), JSON.stringify({ round: pending }));
  };
  return { dir, root, main, origin, bin, env, git, gitAt, head, commit, run, start, calls, ghCalls, apiCalls, body, logDir, peer, saveReview, rounds };
}

test("help and argument errors, including the kit front door", t => {
  const f = fixture(t);
  for (const arg of ["--help", "-h"]) {
    const result = f.run([arg]); assert.equal(result.status, 0); assert.match(result.stdout, /Usage: kit pr/); assert.match(result.stdout, /--waive/); assert.doesNotMatch(result.stdout, /RESULT:/);
  }
  for (const args of [["--wat"], ["--base"], ["--title"], ["--ticket", "--no-merge"], ["--base", "dev", "--base", "main"],
    ["--waive"], ["--waive", " "], ["--waive", "reason", "--waive", "again"]]) {
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

test("checks come from the settings file: every extra runs in order, a missing one is skipped with a line", t => {
  const f = fixture(t, { "scripts/agents/x.mjs": "x\n" }, { checks: { check: "npm run check", test: "npm test", extra: ["npm run extra-a", "npm run extra-b"] } });
  const result = f.run(["--dry-run", "--full"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const npm = f.calls().filter(call => call.tool === "npm").map(call => call.args.join(" "));
  assert.deepEqual(npm, ["run check", "test", "run extra-a", "run extra-b"]);
  assert.match(result.stdout, /^lint: skipped \(no checks\.lint in scripts\/agents\/kit\.json\)$/m);
  assert.match(result.stdout, /^kit-clean: ok\nkit-clean: ok$/m);
});

test("checks.extra holds kit-plumbing checks: a diff outside kit files never runs them", t => {
  const f = fixture(t, { "src/x.ts": "x\n" }, { checks: { check: "npm run check", test: "npm test", lint: "npm run lint", extra: ["npm run extra-a"] } });
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().filter(call => call.tool === "npm").map(call => call.args.join(" ")), ["run check", "test", "run lint"]);
  assert.doesNotMatch(result.stdout, /kit-clean/);
});

// techies-playground's minimal settings (research 04): lands on main, checks.test only, node --test, no CI workflow here.
const playground = { project: "techies-playground", branches: { land: "main", release: "main", ci: "main" }, checks: { test: "npm test" },
  unit: { run: "node --test", files: ["src/**/*.test.js"] } };

test("a project with only checks.test: pr --dry-run runs only npm test and skips the rest with a line each", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: false });
  const result = f.run(["--dry-run"], { FAKE_BASE: "main" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().map(call => [call.tool, ...call.args]), [["npm", "test"]]);
  for (const line of ["deps: skipped (no sharedNodeModules in scripts/agents/kit.json)", "check: skipped (no checks.check in scripts/agents/kit.json)",
    "unit: ok", "lint: skipped (no checks.lint in scripts/agents/kit.json)", "specs: skipped (no specs command in the project's commands folder)"])
    assert.ok(result.stdout.split("\n").includes(line), line);
  assert.match(result.stdout, /RESULT: ok dry-run [a-f0-9]{7} feature\/kit-pr -> main/);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /## Tests\n\nTier: full \(1 file, src\/app.js is code\)\n\n- check: skipped \(no checks.check in scripts\/agents\/kit.json\)\n- npm test: ok\n- lint: skipped \(no checks.lint in scripts\/agents\/kit.json\)\n- specs: skipped \(no specs command in the project's commands folder\)\n$/);
});

test("a repo with no remote gets no GitHub repo from pr before any check runs", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: false });
  f.git("remote", "remove", "origin");
  const result = f.run(["--dry-run"], {}, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail no GitHub repo \(no origin remote\); kit pr needs one to open a PR$/m);
  assert.deepEqual(f.calls(), []);
});

test("a land branch that gained commits after the branch started lands without a flag, and no workflows means no CI wait", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: false });
  // An editor save lands straight on main meanwhile (ticket 05 point 3).
  const peer = f.peer();
  f.gitAt(peer, "checkout", "main");
  writeFileSync(join(peer, "index.html"), "<h1>saved by the editor</h1>\n");
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "Edit index.html"); f.gitAt(peer, "push", "origin", "main");
  const saved = f.gitAt(peer, "rev-parse", "HEAD");
  const result = f.run([], { FAKE_BASE: "main" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ci: none \(no \.github\/workflows\); landing after review$/m);
  assert.match(result.stdout, /RESULT: ok merged #73 abcdef0/);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
  assert.equal(f.ghCalls("merge").length, 1);
  assert.equal(f.git("merge-base", "--is-ancestor", saved, "HEAD"), "");
  assert.equal(f.gitAt(f.origin, "rev-parse", "feature/kit-pr"), f.git("rev-parse", "HEAD"));
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
  assert.equal(f.ghCalls("edit").length, 0);
  assert.deepEqual(f.apiCalls()[0].args.slice(0, 5), ["api", "--method", "PATCH", "repos/{owner}/{repo}/pulls/73", "-F"]);
  assert.match(f.apiCalls()[0].args[5], /^body=@/);
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
  const complete = (text: string) => `${cleanReview}Optional note: ${text}`;
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

function stablePatch(root: string, base: string, head: string) {
  const diff = spawnSync("git", ["diff", "--binary", base, head], { cwd: root, encoding: "utf8" });
  assert.equal(diff.status, 0, diff.stderr);
  const patch = spawnSync("git", ["patch-id", "--stable"], { cwd: root, input: diff.stdout, encoding: "utf8" });
  assert.equal(patch.status, 0, patch.stderr);
  return patch.stdout.trim().split(/\s+/)[0];
}

test("sameReviewPatch rejects empty, missing and malformed patch IDs", () => {
  for (const id of ["", undefined, "bad-id", "a".repeat(39)]) assert.equal(sameReviewPatch(id, id), false);
});

test("same patch on a moved base reuses a clean review; a changed patch requires review", t => {
  for (const changed of [false, true]) {
    const f = fixture(t), base = f.git("merge-base", "origin/dev", "HEAD");
    const reviewedId = stablePatch(f.root, base, f.head);
    f.saveReview(cleanReview);
    const peer = f.peer();
    writeFileSync(join(peer, "upstream.txt"), "moved base\n");
    f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "base moved"); f.gitAt(peer, "push", "origin", "dev");
    f.git("fetch", "origin"); f.git("rebase", "origin/dev");
    if (changed) f.commit("Changed patch");
    const currentId = stablePatch(f.root, "origin/dev", "HEAD");
    assert.equal(sameReviewPatch(reviewedId, currentId), !changed);
    const result = f.run(["--no-merge"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), changed);
    assert.equal(result.stdout.includes("review: reused (same patch on new base)"), !changed);
  }
});

test("conflict resolution that changes the patch requires a fresh review", t => {
  const f = fixture(t);
  f.commit("feature conflict", "file.txt", "feature\n");
  const reviewedId = stablePatch(f.root, "origin/dev", "HEAD");
  f.saveReview(cleanReview);
  const peer = f.peer();
  writeFileSync(join(peer, "file.txt"), "upstream\n");
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "upstream conflict"); f.gitAt(peer, "push", "origin", "dev");
  f.git("fetch", "origin");
  const conflict = spawnSync("git", ["rebase", "origin/dev"], { cwd: f.root, env: f.env, encoding: "utf8" });
  assert.equal(conflict.status, 1);
  writeFileSync(join(f.root, "file.txt"), "resolved feature and upstream\n"); f.git("add", "file.txt");
  f.git("-c", "core.editor=true", "rebase", "--continue");
  assert.equal(sameReviewPatch(reviewedId, stablePatch(f.root, "origin/dev", "HEAD")), false);
  const result = f.run(["--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"));
});

test("a changed HEAD cannot reuse an incomplete, unreadable or finding-bearing patch review", t => {
  for (const report of ["REVIEW_STATUS: incomplete\n", "REVIEW_STATUS: complete\n", cleanReview.replace("Spec: none.", "Spec: a defect.")]) {
    const f = fixture(t); f.saveReview(report);
    f.git("commit", "--allow-empty", "-m", "New HEAD, same patch");
    const result = f.run(["--no-merge"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"));
  }
});

test("a saved review for another HEAD triggers kit review --pr", t => {
  const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261016T120000Z");
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "refs.txt"), "wrong\nbase\n"); writeFileSync(join(folder, "result.md"), "wrong report\n");
  const result = f.run(["--no-merge"]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().find(call => call.tool === "fake-kit" && call.args[0] === "review")?.args, ["review", "--base", "origin/dev", "--pr", "73"]);
  assert.equal(f.ghCalls("comment").length, 0);
});

test("saved and fresh reviews stop on findings before CI or merge, capped at 15 and 160 characters", t => {
  const long = "A".repeat(170);
  const report = `REVIEW_STATUS: complete\nDefects:\nSpec:\n- ${long}\n  More evidence on another line.\n${Array.from({ length: 15 }, (_, i) => `- Defect ${i + 2}.`).join("\n")}\nStandards: none.\nValidation gaps:\n- Missing coverage.\nOptional nits:\n- Rename a variable.\n`;
  for (const source of ["saved", "fresh"]) {
    const f = fixture(t);
    const path = source === "saved" ? f.saveReview(report) : join(f.main, ".scratch/reviews/ak-14/fresh/result.md");
    const result = f.run([], { FAKE_REVIEW: report });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail pr #73 review has 17 open findings (${path})`);
    assert.ok(result.stdout.includes(`Spec: ${"A".repeat(160)}\n`), result.stdout);
    assert.doesNotMatch(result.stdout, /A{161}/);
    for (let i = 2; i <= 15; i++) assert.ok(result.stdout.includes(`Spec: Defect ${i}.\n`));
    assert.doesNotMatch(result.stdout, /Spec: Defect 16\.|Validation gaps: Missing coverage|Rename a variable|review: ok/);
    assert.match(result.stdout, /^… and 2 more$/m);
    assert.equal(f.ghCalls("merge").length, 0);
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), source === "fresh");
    if (source === "saved") assert.ok(f.ghCalls("comment")[0].body?.includes(report));
  }
});

test("saved and fresh clean reviews still wait for CI and merge", t => {
  for (const source of ["saved", "fresh"]) {
    const f = fixture(t);
    if (source === "saved") f.saveReview(cleanReview);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /review: ok\n/);
    assert.match(result.stdout, /RESULT: ok merged #73/);
    assert.equal(f.ghCalls("merge").length, 1);
    assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), source === "fresh");
  }
});

test("a rerun after fixing findings in a new commit reviews the new HEAD and merges", t => {
  const f = fixture(t);
  const path = f.saveReview("REVIEW_STATUS: complete\nDefects:\nSpec:\n- Fix the defect.\nValidation gaps: none.\nOptional nits: none.\n");
  const stopped = f.run();
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.ok(stopped.stdout.includes(`RESULT: fail pr #73 review has 1 open findings (${path})`));
  const head = f.commit("Fix the defect");
  const result = f.run([], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "review").length, 1);
  assert.equal(f.ghCalls("merge").length, 1);
  assert.ok(f.ghCalls("merge")[0].args.includes(head));
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
});

test("unreadable or missing review evidence stops with one finding", t => {
  for (const source of ["saved", "fresh", "missing"]) {
    const f = fixture(t), report = "REVIEW_STATUS: complete\nNo structured report.\n";
    const path = source === "saved" ? f.saveReview(report) : join(f.main, ".scratch/reviews/ak-14/fresh/result.md");
    const result = f.run([], { FAKE_REVIEW: report, FAKE_REVIEW_MISSING: source === "missing" ? "1" : "" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^Review: review format unreadable$/m);
    assert.ok(result.stdout.includes(`RESULT: fail pr #73 review has 1 open findings (${path})`));
    assert.equal(f.ghCalls("merge").length, 0);
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
  }
});

test("lead waiver merges saved or fresh findings, comments and patches the body with the reason", t => {
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: A defect.\n- Standards: none.\nValidation gaps: Add coverage.\nOptional nits: Rename a variable.\n";
  for (const source of ["saved", "fresh"]) {
    const f = fixture(t);
    if (source === "saved") f.saveReview(report, "ke-lead");
    const reason = 'Accepted for follow-up: "ticket 02".';
    const result = f.run(["--waive", reason], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report, FAKE_EXISTING: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT: ok merged #73/);
    assert.equal(f.ghCalls("merge").length, 1);
    assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
    assert.equal(f.ghCalls("comment").at(-1)?.body, `Merged with 2 waived findings: ${reason}`);
    const patches = f.apiCalls().filter(call => call.args[1] === "--method");
    assert.equal(patches.length, 2);
    assert.deepEqual(patches[1].args.slice(0, 5), ["api", "--method", "PATCH", "repos/{owner}/{repo}/pulls/73", "-F"]);
    assert.match(patches[1].args[5], /^body=@/);
    assert.equal(patches[1].body, `${patches[0].body}\nmerged with 2 waived findings: ${reason}\n`);
  }
});

test("waiver is refused for non-leads before any child call, including docs tier", t => {
  for (const changes of [undefined, { "docs/guide.md": "# Guide\n" }]) {
    const f = fixture(t, changes);
    const result = f.run(["--waive", "Accept the findings"], {}, true);
    assert.equal(result.status, 2);
    assert.match(result.stdout, /RESULT: fail invalid arguments: --waive requires a \*-lead owner/);
    assert.deepEqual(f.calls(), []);
  }
});

test("waiver uses kitOwner's worktree fallback", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".scratch"), { recursive: true });
  writeFileSync(join(f.root, ".scratch/owner"), "2026-10-19T10:00:00Z ke-lead feature/kit-pr origin/dev\n");
  const result = f.run(["--waive", "Follow up later"], { ASE_OWNER: "", FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: A defect.\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings: Follow up later");
});

test("waiver does not claim a merge for no-merge, release, clean reviews or failed CI", t => {
  for (const mode of ["no-merge", "release", "clean", "ci-failure"]) {
    const f = fixture(t);
    const args = ["--waive", "Follow up later", ...(mode === "no-merge" ? ["--no-merge"] : mode === "release" ? ["--release", "--base", "main"] : [])];
    const result = f.run(args, { ASE_OWNER: "ke-lead", FAKE_REVIEW: mode === "clean" ? cleanReview : "REVIEW_STATUS: complete\nDefects:\n- Spec: A defect.\n", FAKE_FAIL: mode === "ci-failure" ? "wait" : "" });
    assert.equal(result.status, mode === "ci-failure" ? 1 : 0, result.stderr);
    assert.equal(f.ghCalls("comment").length, 0);
    assert.equal(f.apiCalls().some(call => call.body?.includes("waived findings")), false);
  }
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

test("the scoreboard record gets the PR, tier, CI result, merge SHA and time, and the waiver reason", t => {
  const f = fixture(t), result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(f.main, ".scratch/scoreboard/_untracked/ticket.json"), "utf8"));
  assert.equal(record.ticket, "ticket.md"); assert.equal(record.title, "Ticket title");
  const { at, ...landed } = record.landed;
  assert.deepEqual(landed, { pr: 73, tier: "full", ci: "pass", sha: "abcdef0123456789abcdef0123456789abcdef01", waived: null });
  assert.ok(Date.parse(at));
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: A defect.\n- Standards: none.\nValidation gaps: none.\nOptional nits: none.\n";
  const lead = fixture(t), waived = lead.run(["--waive", "Accepted for ticket 02."], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report });
  assert.equal(waived.status, 0, waived.stderr);
  assert.equal(JSON.parse(readFileSync(join(lead.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8")).landed.waived, "Accepted for ticket 02.");
  const failed = fixture(t), ci = failed.run([], { FAKE_FAIL: "wait" });
  assert.equal(ci.status, 1);
  const { landed: failedLanding } = JSON.parse(readFileSync(join(failed.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8"));
  assert.deepEqual(failedLanding, { pr: 73, tier: "full", ci: "fail" });
});

test("a queued PR records queued without a merge; a new PR number starts a fresh landing", t => {
  const f = fixture(t), path = join(f.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ landed: { pr: 70, sha: "b".repeat(40), at: "2026-10-01T00:00:00.000Z", ci: "pass", tier: "docs" } } satisfies Partial<ScoreRecord>));
  const result = f.run([], { FAKE_QUEUE: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).landed, { pr: 73, tier: "full", queued: true, waived: null });
});

test("queue uses auto-rebase, skips wait, and passes owner/name/base to graphql", t => {
  const f = fixture(t), result = f.run([], { FAKE_QUEUE: "1" });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok queued #73/);
  assert.deepEqual(f.ghCalls("merge")[0].args, ["pr", "merge", "73", "--auto", "--rebase", "--match-head-commit", f.head, "--repo", "test/repo"]);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
  const graphql = f.calls().find(call => call.args[0] === "api")!;
  for (const value of ["o=test", "n=repo", "b=dev", '.data.repository.mergeQueue.id // ""']) assert.ok(graphql.args.includes(value));
});

test("behind retry reuses the same patch review before waiting again and merging", t => {
  const f = fixture(t), peer = f.peer();
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_VIEW_ERROR: "1" });
  assert.equal(result.status, 0, result.stderr); assert.equal(f.ghCalls("merge").length, 2);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "wait").length, 2);
  const head = f.git("rev-parse", "HEAD"); assert.notEqual(head, f.head);
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
  assert.ok(result.stdout.includes(`RESULT: ok merged #73 ${head.slice(0, 7)}`));
  assert.equal(result.stdout.split("\n").filter(line => line === "push: ok").length, 2);
  const actions = f.calls().filter(call => (call.tool === "fake-kit" && ["review", "wait"].includes(call.args[0]))
    || (call.tool === "gh" && call.args[1] === "merge"));
  assert.deepEqual(actions.map(call => call.tool === "gh" ? "merge" : call.args[0]), ["review", "wait", "merge", "wait", "merge"]);
  assert.match(result.stdout, /review: reused \(same patch on new base\)/);
  assert.ok(f.ghCalls("comment")[0].body?.includes(`HEAD: ${head}`));
});

test("findings in the rebased HEAD review stop before another CI wait or merge", t => {
  const f = fixture(t), peer = f.peer();
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: Rebased HEAD has a defect.\n";
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REBASED_REVIEW: report });
  const head = f.git("rev-parse", "HEAD"), folder = join(f.main, ".scratch/reviews/ak-14/fresh-2");
  assert.notEqual(head, f.head);
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail pr #73 review has 1 open findings (${join(folder, "result.md")})`);
  assert.match(result.stdout, /^Spec: Rebased HEAD has a defect\.$/m);
  assert.equal(readFileSync(join(f.main, ".scratch/reviews/ak-14/fresh/result.md"), "utf8"), cleanReview);
  assert.equal(readFileSync(join(folder, "refs.txt"), "utf8"), `${head}\n${f.git("merge-base", "origin/dev", "HEAD")}\n`);
  const actions = f.calls().filter(call => (call.tool === "fake-kit" && ["review", "wait"].includes(call.args[0]))
    || (call.tool === "gh" && call.args[1] === "merge"));
  assert.deepEqual(actions.map(call => call.tool === "gh" ? "merge" : call.args[0]), ["review", "wait", "merge", "review"]);
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

const rows = (...paths: string[]) => paths.map(path => ({ status: "M", path }));

test("each path reaches a tier and the highest present wins", () => {
  assert.deepEqual(classify(rows("README.md", "docs/agents/runner.md", "docs/work/x/tickets/1-a.md", "GLOSSARY.md")),
    { tier: "docs", reason: "4 files, all docs", docs: true });
  assert.deepEqual(classify(rows("tests/a.test.ts", "fixtures/native-starter/index.html", "tests/native-save/x.spec.ts")),
    { tier: "tests", reason: "3 files, all tests", docs: false });
  assert.deepEqual(classify(rows("src/styles/app.css")), { tier: "css", reason: "1 file, all css", docs: false });
  assert.equal(classify(rows("src/main.ts")).tier, "full");
  assert.deepEqual(classify(rows("docs/a.md", "src/a.css")), { tier: "css", reason: "2 files, docs + css, highest css", docs: true });
  assert.equal(classify(rows("docs/a.md", "src/a.css", "tests/a.test.ts")).tier, "tests");
  assert.deepEqual(classify(rows("docs/a.md", "tests/a.test.ts", "worker/a.ts")), { tier: "full", reason: "3 files, worker/a.ts is code", docs: true });
  // Markdown inside tests or fixtures is test data; a deleted stylesheet may still be imported.
  assert.equal(classify(rows("fixtures/actual-starter/AGENTS.md")).tier, "tests");
  assert.equal(classify([{ status: "D", path: "src/old.css" }]).tier, "full");
  assert.equal(classify([]).tier, "full");
  assert.deepEqual(classify(rows("docs/a.md"), { full: true }), { tier: "full", reason: "1 file, --full", docs: false });
  assert.deepEqual(parseChanges("M\tdocs/a.md\nD\tsrc/b.css\n"), [{ status: "M", path: "docs/a.md" }, { status: "D", path: "src/b.css" }]);
});

test("tier steps: docs skips unit, specs and review; full keeps today's set", () => {
  assert.deepEqual(checkSteps({ tier: "docs", docs: true }), { steps: ["tickets", "unit-files"], review: false });
  assert.deepEqual(checkSteps({ tier: "css", docs: false }), { steps: ["colours", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "css", docs: true }), { steps: ["colours", "tickets", "unit-files", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "tests", docs: false }), { steps: ["check", "unit-files", "lint", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "full", docs: true }), { steps: ["check", "unit", "lint", "specs"], review: true });
});

test("focused unit files: changed tests, tests naming a changed helper or fixture, and docs guards", () => {
  const sources = { "tests/a.test.ts": "", "tests/b.test.ts": 'import "./fakes/memory-workspace.ts"; readFileSync("fixtures/native-starter/x")',
    "tests/code-map.test.ts": "", "tests/c.test.ts": "" };
  const changes = [...rows("tests/a.test.ts", "tests/fakes/memory-workspace.ts", "docs/x.md"), { status: "D", path: "tests/c.test.ts" }];
  assert.deepEqual(focusedUnitFiles(changes, classify(changes), sources), ["tests/a.test.ts", "tests/b.test.ts", "tests/code-map.test.ts"]);
  assert.deepEqual(focusedUnitFiles(rows("fixtures/native-starter/index.html"), { tier: "tests", docs: false }, sources), ["tests/b.test.ts"]);
  assert.deepEqual(focusedUnitFiles(rows("docs/x.md"), { tier: "docs", docs: true }, sources), ["tests/code-map.test.ts"]);
  // A test that reads a changed docs file (here a JSON one) runs with the docs tier.
  const owner = { ...sources, "tests/owner-setup.test.ts": 'readFile("docs/native-github-app.json")' };
  assert.deepEqual(focusedUnitFiles(rows("docs/native-github-app.json"), { tier: "docs", docs: true }, owner),
    ["tests/code-map.test.ts", "tests/owner-setup.test.ts"]);
});

test("a docs-only PR runs only doc guards, skips review, and still waits for CI and merges", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n", "AGENTS.md": "# Agents\n" }), result = f.run();
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.match(result.stdout, /^tier: docs \(2 files, all docs\)$/m); assert.match(result.stdout, /review: skipped \(docs tier\)/);
  const calls = f.calls();
  assert.deepEqual(calls.filter(call => call.tool === "tickets.mjs").map(call => call.args), [["check"]]);
  assert.deepEqual(calls.filter(call => call.tool === "unit.sh").map(call => call.args), [["tests/code-map.test.ts"]]);
  assert.equal(calls.some(call => call.tool === "npm"), false);
  assert.equal(calls.some(call => call.tool === "fake-kit" && ["review", "specs"].includes(call.args[0])), false);
  assert.ok(calls.some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
  assert.match(f.body(), /Tier: docs \(2 files, all docs\)/);
  assert.match(f.body(), /skipped for the docs tier \(CI still runs check, unit tests, lint and smoke browser tests; no Sol review\): npm run check, npm test \(all unit tests\), npm run lint, kit specs --affected, kit review/);
});

test("a tests-only PR runs check, the affected unit files, lint, specs and the review", t => {
  const f = fixture(t, { "tests/a.test.ts": "// changed\n", "tests/fakes/thing.ts": "export {};\n" }), result = f.run(["--no-merge"]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^tier: tests \(2 files, all tests\)$/m);
  const calls = f.calls();
  assert.deepEqual(calls.filter(call => call.tool === "npm").map(call => call.args), [["run", "check"], ["run", "lint"]]);
  assert.deepEqual(calls.filter(call => call.tool === "unit.sh").map(call => call.args), [["tests/a.test.ts", "tests/b.test.ts"]]);
  for (const name of ["specs", "review"]) assert.ok(calls.some(call => call.tool === "fake-kit" && call.args[0] === name), name);
  assert.ok(f.body().includes("- scripts/agents/unit.sh tests/a.test.ts tests/b.test.ts: ok"));
});

test("a KIT_HOME outside the project runs its own unit.sh by absolute path, as the PR body says", t => {
  const f = fixture(t, { "tests/a.test.ts": "// changed\n" });
  const home = join(f.dir, "kit-home");
  mkdirSync(home);
  for (const name of ["unit.sh", "tickets.mjs"]) copyFileSync(join(f.root, "scripts/agents", name), join(home, name));
  chmodSync(join(home, "unit.sh"), 0o755);
  const result = f.run(["--no-merge"], { KIT_HOME: home });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().filter(call => call.tool === "unit.sh").map(call => call.args), [["tests/a.test.ts"]]);
  assert.ok(f.body().includes(`- ${join(home, "unit.sh")} tests/a.test.ts: ok`), f.body());
});

test("a CSS-only PR runs the colour check and specs, keeps the review and reminds about shots", t => {
  // A lead's waiver passes the feature-list guard without adding a docs file; the clean review waives nothing else.
  const f = fixture(t, { "src/styles/app.css": "a { color: var(--ink); }\n" });
  const result = f.run(["--no-merge", "--waive", "Lead accepts"], { ASE_OWNER: "ke-lead" });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^tier: css \(1 file, all css\)$/m);
  assert.match(result.stdout, /reminder: visible CSS changes need kit shots evidence/);
  const calls = f.calls();
  assert.equal(calls.filter(call => call.tool === "check-colours.mjs").length, 1);
  assert.equal(calls.some(call => call.tool === "npm" || call.tool === "unit.sh"), false);
  for (const name of ["specs", "review"]) assert.ok(calls.some(call => call.tool === "fake-kit" && call.args[0] === name), name);
});

test("visible paths: CSS, components, ui, page builder except rules, icons and index.html", () => {
  for (const path of ["src/styles/app.css", "src/page-builder/panel.css", "src/components/button.ts", "src/ui/menu.ts",
    "src/page-builder/edit-bar.ts", "src/icons.ts", "index.html"]) assert.equal(visiblePath(path), true, path);
  for (const path of ["src/page-builder/rules/sections.ts", "src/main.ts", "worker/a.css", "docs/agents/features.md",
    "tests/a.test.ts", "fixtures/native-starter/index.html", "src/icons.test.ts"]) assert.equal(visiblePath(path), false, path);
  const css = rows("src/styles/app.css");
  assert.deepEqual(featureListGuard(css), { ok: false, line: "Feature list: missing; src/styles/app.css is visible" });
  assert.deepEqual(featureListGuard([...css, ...rows("docs/agents/features.md")]), { ok: true, line: "Feature list: updated (docs/agents/features.md)" });
  const ticket = "---\ntitle: T\n---\n\nFeature list: no change (not in Done)\n\n## Done (2026-10-25)\n\nBehaviour.\nFeature list: no change (token rename only)\n";
  assert.deepEqual(featureListGuard(css, { ticketText: ticket }), { ok: true, line: "Feature list: no change (token rename only)" });
  // The line only counts inside the last Done section, and needs a reason.
  assert.equal(featureListGuard(css, { ticketText: "Feature list: no change (outside)\n\n## Done\n\nBehaviour.\n" }).ok, false);
  assert.equal(featureListGuard(css, { ticketText: "## Done\n\nX.\n\n## Notes\n\nFeature list: no change (later section)\n" }).ok, false);
  assert.equal(featureListGuard(css, { ticketText: "## Done\n\nFeature list: no change ()\n" }).ok, false);
  assert.equal(featureListGuard(css, { ticketText: "## Done when\n\n- Feature list: no change (criteria)\n" }).ok, false);
  assert.deepEqual(featureListGuard(css, { ticketText: "## Done\n\n- Feature list: no change (rename (tokens))\n" }),
    { ok: true, line: "Feature list: no change (rename (tokens))" });
  assert.equal(featureListGuard([...css, { status: "D", path: "docs/agents/features.md" }]).ok, false);
  assert.deepEqual(featureListGuard(css, { waive: "Lead\naccepts" }), { ok: true, line: "Feature list: waived (Lead accepts); src/styles/app.css is visible" });
  for (const changes of [rows("src/page-builder/rules/sections.ts"), rows("docs/a.md", "tests/a.test.ts"), rows("src/main.ts")])
    assert.deepEqual(featureListGuard(changes), { ok: true });
});

test("a visible change without the feature list or a Done line stops before checks, push or CI", t => {
  for (const ticket of [false, true]) {
    const f = fixture(t, { "src/styles/app.css": "a { color: var(--ink); }\n" }), result = f.run(ticket ? ["--ticket", "ticket.md"] : []);
    assert.equal(result.status, 1);
    assert.ok(result.stdout.includes('RESULT: fail features: visible change without a feature-list update; edit docs/agents/features.md or add "Feature list: no change (<reason>)" to the ticket\'s Done'), result.stdout);
    assert.ok(result.stderr.includes('problem: visible change without a feature-list update; edit docs/agents/features.md or add "Feature list: no change (<reason>)" to the ticket\'s Done\n'), result.stderr);
    assert.match(result.stdout, /^Feature list: missing; src\/styles\/app\.css is visible$/m);
    assert.equal(f.calls().some(call => call.tool !== "fake-kit" || call.args[0] !== "deps"), false);
    assert.equal(f.gitAt(f.origin, "branch", "--list", "feature/kit-pr"), "");
  }
});

test("a visible change proceeds with a features.md change, a Done line or a lead's waiver, and the PR body says which", t => {
  const css = { "src/styles/app.css": "a { color: var(--ink); }\n" };
  const done = '---\ntitle: "Ticket title"\n---\n\nTask\n\n## Done (2026-10-25)\n\nRenamed a token.\nFeature list: no change (token rename only)\n';
  for (const [changes, args, overrides, line] of [
    [{ ...css, "docs/agents/features.md": "# Feature list\n" }, [], {}, "Feature list: updated (docs/agents/features.md)"],
    [{ ...css, "ticket.md": done }, ["--ticket", "ticket.md"], {}, "Feature list: no change (token rename only)"],
    [css, ["--waive", "Lead accepts"], { ASE_OWNER: "ke-lead" }, "Feature list: waived (Lead accepts); src/styles/app.css is visible"],
  ] as const) {
    const f = fixture(t, changes), result = f.run(["--no-merge", ...args], overrides);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /RESULT: ok opened #73/);
    assert.ok(result.stdout.includes(`${line}\n`), result.stdout);
    assert.match(f.body(), new RegExp(`## Tests\\n\\nTier: css \\([^)]*\\)\\n${line.replace(/[()]/g, "\\$&")}\\n`));
  }
});

test("a missing --ticket file fails at the features step before push", t => {
  const f = fixture(t, { "src/styles/app.css": "a { color: var(--ink); }\n" }), result = f.run(["--ticket", "missing.md"]);
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail features: .*ENOENT/);
  assert.equal(f.gitAt(f.origin, "branch", "--list", "feature/kit-pr"), "");
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a feature-list waiver at merge goes in a PR comment, the body and the scoreboard, beside waived findings", t => {
  const css = { "src/styles/app.css": "a { color: var(--ink); }\n" };
  const f = fixture(t, css), result = f.run(["--waive", "Lead accepts"], { ASE_OWNER: "ke-lead" });
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged without a feature-list update: Lead accepts");
  assert.match(f.apiCalls().at(-1)?.body ?? "", /\nmerged without a feature-list update: Lead accepts\n$/);
  const record = join(f.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json");
  assert.equal(JSON.parse(readFileSync(record, "utf8")).landed.waived, "Lead accepts");
  const both = fixture(t, css), report = "REVIEW_STATUS: complete\nDefects:\n- Spec: A defect.\n";
  const merged = both.run(["--waive", "Lead accepts"], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report, FAKE_QUEUE: "1" });
  assert.equal(merged.status, 0, merged.stdout + merged.stderr); assert.match(merged.stdout, /RESULT: ok queued #73/);
  assert.equal(both.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings and without a feature-list update: Lead accepts");
  assert.equal(JSON.parse(readFileSync(join(both.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8")).landed.waived, "Lead accepts");
});

test("a release with a missing --ticket skips the guard's read and fails at the body step", t => {
  const f = fixture(t, { "src/styles/app.css": "a { color: var(--ink); }\n" });
  const result = f.run(["--release", "--base", "main", "--dry-run", "--ticket", "missing.md"]);
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail body: .*ENOENT/);
});

test("a release skips the feature-list guard: its slices passed it on the way into dev", t => {
  const f = fixture(t, { "src/styles/app.css": "a { color: var(--ink); }\n" }), result = f.run(["--release", "--base", "main", "--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /RESULT: ok dry-run [a-f0-9]{7} feature\/kit-pr -> main/);
  assert.doesNotMatch(result.stdout, /Feature list/); assert.doesNotMatch(result.stderr, /problem:/);
  assert.doesNotMatch(readFileSync(join(f.logDir(), "body.md"), "utf8"), /Feature list/);
});

test("page-builder rules, docs-only and tests-only PRs are untouched by the feature-list guard", t => {
  for (const changes of [{ "src/page-builder/rules/sections.ts": "export {};\n" }, { "docs/guide.md": "# Guide\n" }, { "tests/a.test.ts": "// changed\n" }]) {
    const f = fixture(t, changes), result = f.run(["--no-merge"]);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /RESULT: ok opened #73/);
    assert.doesNotMatch(result.stdout, /Feature list/); assert.doesNotMatch(f.body(), /Feature list/);
  }
});

test("--full forces today's checks on a docs-only PR; a failing doc guard stops before push", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n" }), result = f.run(["--full", "--no-merge"]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /^tier: full \(1 file, --full\)$/m);
  assert.deepEqual(f.calls().filter(call => call.tool === "npm").map(call => call.args), [["run", "check"], ["test"], ["run", "lint"]]);
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"));
  for (const action of ["tickets", "unit"]) {
    const g = fixture(t, { "docs/guide.md": "# Guide\n" }), failed = g.run([], { FAKE_FAIL: action });
    assert.equal(failed.status, 1); assert.ok(failed.stdout.includes(`RESULT: fail ${action}:`), failed.stdout);
    assert.equal(g.calls().some(call => call.tool === "gh"), false);
  }
});

const minorReview = cleanReview.replace("Spec: none.", "Spec: P2: Minor defect.").replace("Validation gaps: none.", "Validation gaps: Add coverage.");

for (const pending of [false, true]) test(`P3 blocks with only two completed rounds (pending=${pending})`, t => {
  const f = fixture(t);
  f.rounds(pending ? 3 : 2, pending ? 3 : undefined);
  const report = cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect.");
  f.saveReview(report);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  assert.equal(f.ghCalls("merge").length, 0);
  assert.equal(f.calls().some(call => call.args[0] === "wait"), false);
});

for (const local of [false, true]) for (const source of ["saved", "fresh"]) test(`three completed rounds merge follow-ups, preserve coverage and avoid duplicates (local=${local}, source=${source})`, t => {
  const f = fixture(t);
  const ticket = '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-19)\n\nImplemented.\n\n## Notes\n\nKeep this section.\n';
  f.commit("Close ticket", "ticket.md", ticket);
  f.rounds(3, undefined, local);
  if (source === "saved") f.saveReview(minorReview);
  const expectedReviews = source === "saved" ? 0 : 1;
  const reviewed = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", "ticket.md"], { FAKE_REVIEW: minorReview });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /review: 2 follow-ups after 3 fix rounds \(non-blocking\)/);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  const head = f.git("rev-parse", "HEAD");
  assert.notEqual(head, reviewed);
  assert.equal(f.git("rev-parse", "HEAD^"), reviewed);
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.equal(f.git("diff", "--name-only", reviewed, head), "ticket.md");
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
  const updated = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.match(updated, /### Follow-ups\n\n- Spec \(P2\): P2: Minor defect.\n- Validation gaps \(gap\): Add coverage.\n\n## Notes/);
  const summary = "Follow-ups (non-blocking after 3 fix rounds):\n- Spec (P2): P2: Minor defect.\n- Validation gaps (gap): Add coverage.";
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1);
  assert.ok(f.apiCalls().some(call => call.body?.includes(summary)));
  assert.ok(f.ghCalls("merge")[0].args.includes(head));
  const calls = f.calls();
  assert.ok(calls.findIndex(call => call.body === summary) < calls.findIndex(call => call.args[0] === "wait"));
  assert.equal(calls.filter(call => call.tool === "fake-kit" && call.args[0] === "review").length, expectedReviews);
  const rerun = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), updated);
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "review").length, expectedReviews);
});

for (const defect of ["P0: Broken build.", "P1: Serious defect.", "No readable severity."]) test(`three rounds still block ${defect}`, t => {
  const f = fixture(t); f.rounds(3);
  const report = minorReview.replace("Standards: none.", `Standards: ${defect}`);
  f.saveReview(report);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  assert.ok(result.stdout.indexOf(`Standards: ${defect}`) < result.stdout.indexOf("Spec: P2:"));
  assert.equal(f.ghCalls("merge").length, 0);
});

test("three rounds still fail closed on unreadable review", t => {
  const f = fixture(t); f.rounds(3); f.saveReview("REVIEW_STATUS: complete\nNo structured review.");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
});

test("ticket-only coverage excludes any other changed path", t => {
  const f = fixture(t); f.rounds(3); f.saveReview(minorReview);
  f.commit("New implementation", "file.txt", "changed after review\n");
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "review").length, 1);
});

test("waiver and non-blocking follow-ups are recorded separately after three rounds", t => {
  const f = fixture(t); f.rounds(3);
  const report = minorReview.replace("Standards: none.", "Standards: P1: Serious defect.");
  const result = f.run(["--waive", "Lead accepts risk"], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings: Lead accepts risk");
  const body = f.apiCalls().at(-1)?.body || "";
  assert.match(body, /Follow-ups \(non-blocking after 3 fix rounds\):/);
  assert.match(body, /merged with 1 waived findings: Lead accepts risk/);
});


test("follow-ups extend an existing subsection without duplicating existing lines", t => {
  const f = fixture(t); f.rounds(3);
  f.commit("Close ticket", "ticket.md", '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-19)\n\nImplemented.\n\n### Follow-ups\n\n- Spec (P2): P2: Minor defect.\n\n### Evidence\n\nKeep evidence.\n');
  f.saveReview(minorReview);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.equal(ticket.split("### Follow-ups").length, 2);
  assert.equal(ticket.split("- Spec (P2): P2: Minor defect.").length, 2);
  assert.match(ticket, /- Validation gaps \(gap\): Add coverage.\n\n### Evidence/);
});

async function waitForFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `deadline waiting for ${path}`);
    await new Promise(accept => setTimeout(accept, 10));
  }
}

for (const phase of ["stage-before", "stage-after", "pre-commit"]) for (const change of ["branch", "HEAD", "unrelated edit"])
  test(`follow-up publication ${change === "unrelated edit" ? "preserves" : "refuses"} ${change} changes during ${phase}`, async t => {
    const count = await forEachAwait(race => {
      const f = fixture(t);
      f.rounds(3); f.saveReview(minorReview);
      f.git("branch", "other-branch");
      const ready = join(f.dir, "ready"), release = join(f.dir, "release");
      const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const hold = `
const { existsSync, writeFileSync } = require("node:fs");
async function hold() {
  writeFileSync(process.env.FAKE_HOLD_READY, "ready");
  await new Promise(accept => {
    const timer = setInterval(() => { if (existsSync(process.env.FAKE_HOLD_RELEASE)) { clearInterval(timer); accept(); } }, 10);
  });
}
`;
      if (phase === "pre-commit") {
        const hooks = join(f.root, ".git/test-hooks"); mkdirSync(hooks);
        f.git("config", "core.hooksPath", hooks);
        const hook = join(hooks, "pre-commit");
        writeFileSync(hook, `#!/usr/bin/env node\n${hold}\nhold();\n`); chmodSync(hook, 0o755);
      } else {
        const wrapper = join(f.bin, "git");
        writeFileSync(wrapper, `#!/usr/bin/env node
${hold}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const staging = args.includes("add");
(async () => {
  if (staging && process.env.FAKE_HOLD_PHASE === "stage-before") await hold();
  const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
  if (staging && process.env.FAKE_HOLD_PHASE === "stage-after") await hold();
  process.exitCode = result.status ?? 1;
})();
`); chmodSync(wrapper, 0o755);
      }
      const result = f.start({ FAKE_HOLD_PHASE: phase, FAKE_HOLD_READY: ready, FAKE_HOLD_RELEASE: release });
      return { f, ready, realGit, done: (async () => {
        await race.port(phase, () => waitForFile(ready))();
        writeFileSync(release, "go");
        return result;
      })() };
    }, async ({ f, ready, realGit }) => {
      await waitForFile(ready);
      if (change === "unrelated edit") {
        writeFileSync(join(f.root, "file.txt"), "concurrent unrelated edit\n");
        return;
      }
      // These concurrent user actions must bypass the deliberately held Git wrapper/hook.
      const args = change === "branch" ? ["switch", "other-branch"] : ["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "Concurrent HEAD"];
      const result = spawnSync(realGit, ["-C", f.root, ...args], { env: f.env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }, async ({ f, done }) => {
      const result = await done;
      if (change === "unrelated edit") {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /RESULT: ok merged #73/);
        assert.equal(readFileSync(join(f.root, "file.txt"), "utf8"), "concurrent unrelated edit\n");
        assert.equal(f.git("show", ":file.txt"), "base", "preserve the real index");
        assert.equal(f.git("show", "HEAD:file.txt"), "base");
        assert.equal(f.git("diff", "--name-only", f.head, "HEAD"), "ticket.md");
        assert.equal(f.git("diff", "--name-only"), "file.txt", "leave unrelated edits uncommitted");
        const remote = f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr");
        assert.equal(remote, f.git("rev-parse", "HEAD"));
        assert.equal(f.gitAt(f.origin, "show", `${remote}:file.txt`), "base");
        return;
      }
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, /RESULT: fail follow-ups: worktree branch or HEAD changed during commit/);
      assert.equal(f.git("rev-parse", "refs/heads/other-branch"), f.head);
      assert.equal(f.git("log", "-1", "--format=%s"), change === "HEAD" ? "Concurrent HEAD" : "Second change");
      assert.equal(f.git("rev-parse", "refs/heads/feature/kit-pr"), change === "HEAD" ? f.git("rev-parse", "HEAD") : f.head);
      assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), f.head, "never push after a stale follow-up commit");
      assert.equal(f.ghCalls("merge").length, 0);
      assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
    });
    assert.equal(count, 1);
  });


test("follow-ups create a dated Done section without changing Done when acceptance criteria", t => {
  const f = fixture(t); f.rounds(3);
  const original = '---\ntitle: "Ticket title"\n---\n\n## Files\n\n- `file.txt`\n\n## Done when\n\n- Required behaviour is present.\n- Required coverage passes.\n';
  f.commit("Write acceptance criteria", "ticket.md", original);
  f.saveReview(minorReview);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.ok(ticket.startsWith(original.trimEnd() + "\n\n## Done ("), ticket);
  assert.match(ticket.slice(original.trimEnd().length), /^\n\n## Done \(\d{4}-\d{2}-\d{2}\)\n\n### Follow-ups\n/);
  assert.equal(ticket.split("### Follow-ups").length, 2);
  assert.match(ticket, /- Spec \(P2\): P2: Minor defect./);
  assert.match(ticket, /- Validation gaps \(gap\): Add coverage./);
});


test("a hook cannot publish non-ticket paths from the private follow-up index", t => {
  const f = fixture(t); f.rounds(3); f.saveReview(minorReview);
  const hooks = join(f.root, ".git/test-hooks"); mkdirSync(hooks);
  f.git("config", "core.hooksPath", hooks);
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
writeFileSync("file.txt", "hook's unrelated edit\\n");
execFileSync("git", ["add", "--", "file.txt"]);
`); chmodSync(hook, 0o755);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail follow-ups: follow-ups commit changed files outside the captured ticket update/);
  assert.equal(f.git("rev-parse", "HEAD"), f.head, "validate paths before publishing locally");
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), f.head);
  assert.equal(f.git("show", ":file.txt"), "base");
  assert.equal(readFileSync(join(f.root, "file.txt"), "utf8"), "hook's unrelated edit\n");
  assert.equal(f.ghCalls("merge").length, 0);
});
