import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { checkSteps, classify, featureListGuard, focusedUnitFiles, parseChanges, visiblePath } from "../pr-tier.mjs";
import { sameReviewPatch } from "../review-findings.mjs";
import { forEachAwait } from "./support/await-race.ts";
import { kitEnv } from "./support/kit-env.ts";
import type { ScoreRecord } from "./kit-score.test.ts";

const pr = resolve("kit.d/pr");
const kit = resolve("kit");
const cleanReview = "REVIEW_STATUS: complete\nDefects:\n- Spec: none.\n- Standards: none.\nValidation gaps: none.\nOptional nits: none.\n";
// A kit specs call also says whether the machine's full-run lock (full) and quiet lock (quiet) were held during it.
interface Call { tool: string; script?: string; args: string[]; body?: string; repo?: string; host?: string; full?: boolean; quiet?: boolean; holder?: string }
// Claude's review, not the second look that kit pr runs after it.
const claudeReview = (call: Call) => call.tool === "fake-kit" && call.args[0] === "review" && !call.args.includes("--second-look");
const fake = `#!/usr/bin/env node
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const tool = basename(process.argv[1]), args = process.argv.slice(2), env = process.env;
const bodyIndex = args.indexOf("--body-file");
const bodyField = args.find(arg => arg.startsWith("body=@"));
const bodyPath = bodyIndex >= 0 ? args[bodyIndex + 1] : bodyField?.slice("body=@".length);
// repo: the GH_REPO a call was told, when it was told one.
appendFileSync(env.FAKE_CALLS, JSON.stringify({ tool, script: process.argv[1], args, ...(bodyPath ? { body: readFileSync(bodyPath, "utf8") } : {}),
  ...(env.GH_REPO ? { repo: env.GH_REPO } : {}), ...(env.GH_HOST ? { host: env.GH_HOST } : {}),
  ...(tool === "fake-kit" && args[0] === "specs" ? { full: existsSync(join(env.XDG_STATE_HOME, "agent-kit/browser-run.lock")),
    quiet: existsSync(join(env.XDG_STATE_HOME, "agent-kit/quiet.lock")), holder: env.KIT_QUIET_HOLDER || "" } : {}) }) + "\\n");
const scripts = { "unit.sh": "unit", "tickets.mjs": "tickets", "check-colours.mjs": "colours" };
const action = tool === "npm" ? (args[0] === "test" ? "unit" : args[1]) : scripts[tool] || (tool === "fake-kit" ? args[0] : args.slice(0, 2).join("-"));
// FAKE_RELEASE_CHECK_STDERR: the check fails with only that stderr line and no RESULT line.
if (tool === "fake-kit" && action === "release-check" && env.FAKE_RELEASE_CHECK_STDERR) { console.error(env.FAKE_RELEASE_CHECK_STDERR); process.exit(3); }
// FAKE_RELEASE_CHECK is the real kit release-check, which kit pr --release then runs.
if (tool === "fake-kit" && action === "release-check" && env.FAKE_RELEASE_CHECK) {
  const run = require("node:child_process").spawnSync(env.FAKE_RELEASE_CHECK, args.slice(1), { stdio: "inherit" });
  process.exit(run.status ?? 1);
}
if (env.FAKE_FAIL === action) {
  for (let i = 1; i <= 35; i++) console.error("failure line " + i);
  if (env.FAKE_FAIL_TEXT) console.error(env.FAKE_FAIL_TEXT);
  if (tool === "fake-kit") console.log("RESULT: fail child failure");
  process.exit(1);
}
// FAKE_SPECS plans kit specs: its files are the --affected selection; a file in "full" fails only in a run with other
// files (as one does on a busy machine), one in "always" fails every time.
if (tool === "fake-kit" && action === "specs" && env.FAKE_SPECS) {
  const plan = JSON.parse(env.FAKE_SPECS), rest = args.slice(1);
  const files = rest[0] === "--affected" ? plan.files : rest.filter(arg => !arg.startsWith("-"));
  if (rest.includes("--list")) {
    for (const file of files) console.log(file + " [default] — changed");
    console.log("RESULT: ok specs " + files.length + " selected (list only)");
    process.exit(0);
  }
  const failed = files.filter(file => (plan.always || []).includes(file) || (files.length > 1 && (plan.full || []).includes(file)));
  for (const file of files) console.log(failed.includes(file) ? "✗ " + file + ": a test — timed out" : "✓ " + file + " (1 passed)");
  console.log(failed.length ? "RESULT: fail specs " + failed.length + " of " + files.length + " failed" : "RESULT: ok specs " + files.length + "/" + files.length + " passed");
  process.exit(failed.length ? 1 : 0);
}
// The second look: FAKE_SECOND=skip has no model to take it, =fail fails; FAKE_SECOND_REVIEW is its report (clean by default).
if (tool === "fake-kit" && action === "review" && args.includes("--second-look")) {
  if (env.FAKE_SECOND === "fail") { console.log("RESULT: fail second-look table broken evidence none"); process.exit(1); }
  if (env.FAKE_SECOND === "skip") {
    console.log("second look: skipped (grok-4.7 out of credit; opencode/deepseek-v4.1-flash-free out of credit)");
    console.log("RESULT: skip second look (grok-4.7 out of credit; opencode/deepseek-v4.1-flash-free out of credit)");
    process.exit(3);
  }
  const count = readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
    .filter(call => call.tool === "fake-kit" && call.args[0] === "review" && call.args.includes("--second-look")).length;
  const folder = join(env.KIT_MAIN_ROOT, ".scratch/reviews", env.ASE_OWNER, "second-" + count);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "result.md"), env.FAKE_SECOND_REVIEW || ${JSON.stringify(cleanReview)});
  writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model: "grok-4.7", ok: true }));
  const { execFileSync } = require("node:child_process");
  const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
  writeFileSync(join(folder, "refs.txt"), git("rev-parse", "HEAD") + "\\n" + git("merge-base", "origin/" + (env.FAKE_BASE || "dev"), "HEAD") + "\\n");
  console.log("second look: code (feature.txt) grok-4.7");
  console.log("RESULT: ok review git diff base...HEAD evidence " + folder);
} else if (tool === "fake-kit" && action === "review") {
  const count = readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
    .filter(call => call.tool === "fake-kit" && call.args[0] === "review" && !call.args.includes("--second-look")).length;
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
    // FAKE_LAND is a clone that lands the PR as GitHub's rebase merge does: every commit written anew, the last
    // one the merge commit pr view names. FAKE_LAND_RENAME lands the commit with that subject under another one;
    // FAKE_LAND_OTHER is the subject of another PR's commit that lands just before.
    if (env.FAKE_LAND) {
      const { execFileSync } = require("node:child_process");
      const git = (...argv) => execFileSync("git", ["-C", env.FAKE_LAND, ...argv], { encoding: "utf8", timeout: 10_000 }).trim();
      git("fetch", "-q", "origin"); git("checkout", "-q", "-B", "dev", "origin/dev");
      const commits = git("rev-list", "--reverse", "origin/dev..origin/feature/kit-pr").split("\\n").filter(Boolean);
      if (env.FAKE_LAND_OTHER) { writeFileSync(env.FAKE_LAND + "/other.txt", "other\\n"); git("add", "other.txt"); git("commit", "-q", "-m", env.FAKE_LAND_OTHER); }
      for (const sha of commits) {
        git("cherry-pick", "--allow-empty", sha);
        if (git("log", "-1", "--format=%s") === env.FAKE_LAND_RENAME) git("commit", "-q", "--amend", "-m", "Renamed on landing");
      }
      git("push", "-q", "origin", "dev");
      writeFileSync(env.FAKE_CALLS + ".landed", git("rev-parse", "HEAD"));
    }
  } else if (action === "pr-view") {
    if (env.FAKE_VIEW_ERROR) process.exit(1);
    if (args.includes("comments")) {
      const comments = readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
        .filter(call => call.tool === "gh" && call.args[0] === "pr" && call.args[1] === "comment");
      console.log(JSON.stringify({ comments }));
      process.exit(0);
    }
    const landed = env.FAKE_CALLS + ".landed";
    console.log(env.FAKE_MERGED || (existsSync(landed) ? readFileSync(landed, "utf8") : "abcdef0123456789abcdef0123456789abcdef01"));
  }
}
`;

// Default branch: two commits to feature.txt (full tier). `changes` replaces them with one commit of these files.
// `settings` replaces this editor's settings; `workflows: false` leaves out the CI workflow, a string replaces its text.
function fixture(t: TestContext, changes?: Record<string, string>, override: Record<string, unknown> = {},
  { settings: own, workflows = true }: { settings?: Record<string, unknown>; workflows?: boolean | string } = {}) {
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
  const env: NodeJS.ProcessEnv = { ...kitEnv(), PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: root, KIT_MAIN_ROOT: main,
    ASE_OWNER: "ak-14", KIT_PR_KIT: join(bin, "fake-kit"), FAKE_CALLS: join(dir, "calls.jsonl"), CLAUDECODE: "",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", XDG_STATE_HOME: join(dir, "state") };
  for (const key of Object.keys(env)) if (key.startsWith("FAKE_") && key !== "FAKE_CALLS") delete env[key];
  // The origin is a folder, so GH_REPO names the fake's repo (what its gh repo view answers); kit pr stops without one.
  env.GH_REPO = "test/repo"; delete env.GH_HOST;
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
  for (const name of ["kit.d", "kit-lib.sh", "kit-lib.mjs"]) symlinkSync(resolve(name), join(root, "scripts/agents", name));
  env.KIT_HOME = join(root, "scripts/agents");
  for (const name of ["a", "code-map"]) writeFileSync(join(root, `tests/${name}.test.ts`), `// ${name}\n`);
  writeFileSync(join(root, "tests/b.test.ts"), 'import "./fakes/thing.ts";\n');
  // This editor's settings, without its machine folders, and its specs command and CI workflow.
  const { mainRoot: _main, devRoot: _dev, ...settings } = JSON.parse(readFileSync("tests/fixtures/editor-kit.json", "utf8"));
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify(own ?? { ...settings, ...override }));
  mkdirSync(join(root, "scripts/agents/project.d"));
  writeFileSync(join(root, "scripts/agents/project.d/specs"), "#!/bin/sh\n", { mode: 0o755 });
  if (workflows) { mkdirSync(join(root, ".github/workflows"), { recursive: true }); writeFileSync(join(root, ".github/workflows/ci.yml"), typeof workflows === "string" ? workflows : "on: pull_request\n"); }
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

test("a project without checks.css skips the colour step with its line", t => {
  const f = fixture(t, { "worker/a.css": "a { color: red; }\n" }, { checks: { check: "npm run check", test: "npm test", lint: "npm run lint" } });
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^tier: css \(1 file, all css\)$/m);
  assert.match(result.stdout, /^colours: skipped \(no checks\.css in scripts\/agents\/kit\.json\)$/m);
  assert.equal(f.calls().some(call => call.tool === "check-colours.mjs"), false);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /^- colours: skipped \(no checks\.css in scripts\/agents\/kit\.json\)$/m);
});

test("with a PR workflow but no checks or specs command set, the body says CI still runs its workflows", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n" }, {}, { settings: { project: "kit-bare", branches: { land: "dev" }, paths: { docs: ["^docs/"] } } });
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /^- skipped for the docs tier \(CI still runs its workflows\): kit review$/m);
});

test("a project's own checks.css command runs in the css tier instead of check-colours.mjs", t => {
  const f = fixture(t, { "worker/a.css": "a { color: red; }\n" }, { checks: { css: "node tools/colours.mjs" } });
  // The checker reaches the base, so the PR's diff stays css-only; it records its call like the other fakes.
  const peer = f.peer();
  mkdirSync(join(peer, "tools"));
  writeFileSync(join(peer, "tools/colours.mjs"), `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)(${JSON.stringify(join(f.bin, "fake.cjs"))});\n`);
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "Add checker"); f.gitAt(peer, "push", "origin", "dev");
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^tier: css \(1 file, all css\)$/m);
  assert.match(result.stdout, /^colours: ok$/m);
  assert.deepEqual(f.calls().filter(call => ["colours.mjs", "check-colours.mjs"].includes(call.tool)).map(call => call.tool), ["colours.mjs"]);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /^- node tools\/colours\.mjs: ok$/m);
});

test("docs guards need paths.unitTests: without it the docs tier skips its unit step with a line", t => {
  const settings = { project: "kit-guards", branches: { land: "dev" }, paths: { docs: ["^docs/"] }, unit: { docsGuards: ["tests/code-map.test.ts"] } };
  const f = fixture(t, { "docs/guide.md": "# Guide\n" }, {}, { settings });
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^unit: skipped \(no paths\.unitTests in scripts\/agents\/kit\.json\)$/m);
  assert.equal(f.calls().some(call => call.tool === "unit.sh"), false);
});

// A project whose kit plumbing and unit tests live in other folders than this editor's.
const elsewhere = { project: "kit-other", branches: { land: "dev" }, checks: { check: "npm run check", test: "npm test", extra: "npm run extra-a" },
  paths: { tests: ["^spec/"], kit: ["^tools/kit/"], unitTests: ["^spec/[^/]+\\.test\\.js$"] } };

test("paths.kit drives the clean guard, and a string checks.extra runs as one command", t => {
  assert.equal(classify(parseChanges("M\tscripts/agents/x.mjs\nM\ttests/kit-a.test.ts\n"), { settings: elsewhere }).cleanGuard, undefined);
  assert.equal(classify(parseChanges("M\ttools/kit/x.mjs\n"), { settings: elsewhere }).cleanGuard, true);
  const f = fixture(t, { "tools/kit/x.mjs": "x\n" }, {}, { settings: elsewhere });
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().filter(call => call.tool === "npm").map(call => call.args.join(" ")), ["run check", "test", "run extra-a"]);
  assert.match(result.stdout, /^kit-clean: ok$/m);
});

test("paths.unitTests picks the focused unit files from their own folder", t => {
  const f = fixture(t, { "spec/a.test.js": "// changed\n", "spec/fakes/thing.js": "export {};\n" }, {}, { settings: elsewhere });
  // The base gains a unit test naming the changed helper; tests/b.test.ts names it too but is no unit test here.
  const peer = f.peer();
  mkdirSync(join(peer, "spec"));
  writeFileSync(join(peer, "spec/b.test.js"), 'import "./fakes/thing.js";\n');
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "Add b"); f.gitAt(peer, "push", "origin", "dev");
  const result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^tier: tests \(2 files, all tests\)$/m);
  assert.deepEqual(f.calls().filter(call => call.tool === "unit.sh").map(call => call.args), [["spec/a.test.js", "spec/b.test.js"]]);
});

test("without paths.unitTests or paths.kit their steps are skipped with a line, and a bad checks.extra fails", t => {
  const { kit: _kit, unitTests: _unit, ...paths } = elsewhere.paths;
  const settings = { ...elsewhere, paths };
  const f = fixture(t, { "spec/a.test.js": "// changed\n" }, {}, { settings });
  let result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^unit: skipped \(no paths\.unitTests in scripts\/agents\/kit\.json\)$/m);
  assert.equal(f.calls().some(call => call.tool === "unit.sh"), false);
  mkdirSync(join(f.root, "tools/kit"), { recursive: true });
  f.commit("Kit plumbing", "tools/kit/x.mjs");
  result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^kit-clean: skipped \(no paths\.kit in scripts\/agents\/kit\.json\)$/m);
  assert.equal(f.calls().some(call => call.tool === "npm" && call.args[1] === "extra-a"), false);
  for (const extra of [{ run: "npm run extra-a" }, ["npm run extra-a", 1], 7, "", [" "]]) {
    f.commit("Bad extra", "scripts/agents/kit.json", JSON.stringify({ ...settings, checks: { ...settings.checks, extra } }));
    result = f.run(["--dry-run"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(result.stdout.trimEnd().split("\n").at(-1), "RESULT: fail guards: checks.extra must be a list of commands");
  }
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
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /## Tests\n\nTier: full \(1 file, src\/app.js is code\)\n\n- skill guard: ok — line check: skipped \(no local skill folders\)\n- check: skipped \(no checks.check in scripts\/agents\/kit.json\)\n- npm test: ok\n- lint: skipped \(no checks.lint in scripts\/agents\/kit.json\)\n- specs: skipped \(no specs command in the project's commands folder\)\n$/);
});

test("with local skill folders and a clean change, the PR body says how many lines the skill guard checked", t => {
  // Made-up skill text in a fake skill folder, named by KIT_SKILL_DIRS; the change holds none of it.
  const home = mkdtempSync(join(tmpdir(), "kit-pr-skills-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "crane"), { recursive: true });
  writeFileSync(join(home, "crane/SKILL.md"), "# Crane\n\nFold the paper crane twice along the moonlit diagonal before the kettle sings\n");
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: false });
  const result = f.run(["--dry-run"], { FAKE_BASE: "main", KIT_SKILL_DIRS: home }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"),
    /\n- skill guard: ok — line check: \d+ lines against 1 skill lines from 1 skill files\n/);
});

test("a project's own skill in skillGuard.allow passes, and the PR body names it beside the line check", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n", ".claude/skills/heron/SKILL.md": "x\n" }, {},
    { settings: { ...playground, skillGuard: { allow: [".claude/skills/heron"] } }, workflows: false });
  const result = f.run(["--dry-run"], { FAKE_BASE: "main" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(readFileSync(join(f.logDir(), "body.md"), "utf8").includes(
    "\n- skill guard: ok — line check: skipped (no local skill folders); allowed own skills: .claude/skills/heron (skillGuard.allow; lines still checked)\n"));
});

test("kit pr stops on a skillGuard.allow entry that is not one skill folder, before any check", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n", ".claude/skills/heron/SKILL.md": "x\n" }, {},
    { settings: { ...playground, skillGuard: { allow: [".claude/skills"] } }, workflows: false });
  const result = f.run(["--dry-run"], { FAKE_BASE: "main" }, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /skillGuard\.allow entry "\.claude\/skills" is not one skill folder's repo path/);
  assert.deepEqual(f.calls(), []);
});

test("kit pr stops before any check when the branch tracks a skill file, naming the path and never the text", t => {
  // Made-up skill text in a fake skill folder, named by KIT_SKILL_DIRS.
  const home = mkdtempSync(join(tmpdir(), "kit-pr-skills-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const secret = "Fold the paper crane twice along the moonlit diagonal before the kettle sings";
  mkdirSync(join(home, ".claude/skills/crane"), { recursive: true });
  writeFileSync(join(home, ".claude/skills/crane/SKILL.md"), `# Crane\n\n${secret}\n`);
  for (const [files, problem] of [
    [{ "src/app.js": "export const app = 1;\n", "notes/skills/crane/SKILL.md": "x\n" }, /notes\/skills\/crane\/SKILL\.md: a skill file or skills\/ folder is tracked/],
    [{ "src/app.js": `// ${secret}\n` }, /src\/app\.js:1: holds a line from the local skill crane/],
  ] as const) {
    const f = fixture(t, { ...files }, {}, { settings: playground, workflows: false });
    const result = f.run(["--dry-run"], { FAKE_BASE: "main", KIT_SKILL_DIRS: join(home, ".claude/skills") }, true);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, problem);
    assert.doesNotMatch(result.stdout + result.stderr, /moonlit/);
    assert.deepEqual(f.calls(), []);
    assert.ok(!result.stdout.split("\n").includes("skills: ok"), result.stdout);
  }
});

test("--base main is an ordinary PR when main is both land and release, and still needs --release when land is dev", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: false });
  const same = f.run(["--dry-run", "--base", "main"], { FAKE_BASE: "main" }, true);
  assert.equal(same.status, 0, same.stdout + same.stderr);
  assert.match(same.stdout, /RESULT: ok dry-run [a-f0-9]{7} feature\/kit-pr -> main/);
  const split = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: { ...playground, branches: { land: "dev", release: "main" } } });
  const refused = split.run(["--dry-run", "--base", "main"], {}, true);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /RESULT: fail guards: --base main requires --release/);
});

test("with the playground settings and a CI workflow, pr still waits for CI and records ci: pass", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  const result = f.run([], { FAKE_BASE: "main" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ci: waiting for PR #73 checks$/m);
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args.join(" ") === "wait ci --pr 73"));
  assert.equal(JSON.parse(readFileSync(join(f.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8")).landed.ci, "pass");
});

test("a workflow the base gains during a behind retry is waited for after the rebase", t => {
  const f = fixture(t, undefined, {}, { workflows: false }), peer = f.peer();
  const script = join(f.dir, "add-ci.sh");
  writeFileSync(script, `#!/bin/sh\nset -e\ncd '${peer}'\nmkdir -p .github/workflows\necho 'on: pull_request' > .github/workflows/ci.yml\ngit add .\ngit commit -qm 'Add CI'\ngit push -q origin dev\n`, { mode: 0o755 });
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_AFTER_PUSH: script });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.split("\n");
  assert.ok(lines.indexOf("ci: none (no workflow in .github/workflows runs on pull requests); landing after review") < lines.indexOf("ci: waiting for PR #73 checks"), result.stdout);
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args.join(" ") === "wait ci --pr 73"));
});

test("only a workflow that runs for a PR branch is CI to wait for; deploy-only, scheduled and main-only ones land after review", t => {
  for (const [workflow, waits] of [
    ["name: Deploy\non:\n  push:\n    branches: [main] # deploy only\n  workflow_dispatch:\njobs: {}\n", false],
    ["on:\n  schedule:\n    - cron: '0 3 * * 1'\njobs:\n  sync:\n    if: github.event_name == 'pull_request'\n", false],
    // A paths filter alone may match a PR branch (below); beside plain branch names it is still deploy-only.
    ["# on: pull_request\n'on':\n  push:\n    branches: [main]\n    paths: ['src/**']\n", false],
    ["on: [push, workflow_dispatch]\n", true],
    ["on:\n  - push\n", true],
    ["\"on\":\n  push:\n  pull_request_target:\n    branches: [main]\n", true],
    ["on:\n  workflow_dispatch:\n  pull_request:\n", true],
    ["on:\n  push:\n    branches-ignore: [main]\n", true],
    ["on:\n  push:\n    branches: ['**']\n", true],
    ["on:\n  push:\n    paths: [src/**]\n", true],
    ["on:\n  push:\n    branches: [main]\n    paths: [src/**]\n", false],
    ["on: { push: { branches: [main] } }\n", false],
    ["on: { push: { branches: ['**'] } }\n", true],
    ["on: {push: {branches: [main, dev]}}\n", false],
    ["on: { push: {} }\n", true],
    ["on:\n  push:\n    branches:\n      - main\n", false],
    ["on:\n  push:\n    tags: [v*]\n", false],
    ["on:\n  push:\n    paths-ignore: [docs/**]\n", true],
    ["on:\n  push:\n    branches: []\n", true],
    ["on:\n  push:\n    branches-ignore: [main]\n    tags: [v*]\n", true],
    ["on:\n  push:\n    branches: [\n      main ]\n", true], // A flow list over lines is not read: waiting is the safe answer.
    ["on:\n  push:\n    branches: [ke-+]\n", true],
    ["on: { push: { branches: [main] }, schedule: [{ cron: '0 3 * * 1' }] }\n", false],
    // The Native Site Editor's workflows (copies): ci.yml (pull_request) is CI, deploy-preview.yml (push to dev) is not.
    [readFileSync("tests/fixtures/editor-workflows/ci.yml", "utf8"), true],
    [readFileSync("tests/fixtures/editor-workflows/deploy-preview.yml", "utf8"), false],
  ] as const) {
    const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: workflow });
    const result = f.run([], { FAKE_BASE: "main" }, true);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args.join(" ") === "wait ci --pr 73"), waits, workflow);
    const { landed } = JSON.parse(readFileSync(join(f.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8"));
    assert.equal(landed.ci, waits ? "pass" : "none", workflow);
  }
});

test("with no CI workflow the PR body does not claim CI runs the skipped checks", t => {
  const f = fixture(t, { "docs/note.md": "note\n" }, {}, { workflows: false });
  assert.equal(f.run(["--dry-run"]).status, 0);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /^- skipped for the docs tier \(no CI workflow runs them\): /m);
});

test("a repo with no remote gets no GitHub repo from pr before any check runs", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground, workflows: false });
  f.git("remote", "remove", "origin");
  const result = f.run(["--dry-run"], {}, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail no GitHub repo \(no origin remote\); kit pr needs one to open a PR$/m);
  assert.deepEqual(f.calls(), []);
});

test("a site made from the starter opens its PR in origin's repo: every gh call is told origin's, never upstream's", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  // origin names the site's GitHub repo (insteadOf takes git to the local one); upstream is the starter it was made from,
  // which gh, left to itself, would pick.
  f.git("config", `url.${f.origin}.insteadOf`, "https://github.com/acme/site.git");
  f.git("remote", "set-url", "origin", "https://github.com/acme/site.git");
  f.git("remote", "add", "upstream", "https://github.com/acme/starter.git");
  const result = f.run([], { FAKE_BASE: "main", GH_REPO: "acme/starter" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: ok merged #73 abcdef0/);
  const gh = f.calls().filter(call => call.tool === "gh");
  assert.deepEqual(new Set(gh.map(call => `${call.args[0]} ${call.args[1]}`)), new Set(["pr list", "pr create", "repo view", "api graphql", "pr merge", "pr view"]));
  assert.deepEqual(gh.filter(call => call.repo !== "acme/site" || call.host !== "github.com"), []);
  // gh repo view reads no GH_REPO, so the repo is named.
  assert.deepEqual(gh.find(call => call.args[0] === "repo")?.args.slice(0, 3), ["repo", "view", "acme/site"]);
  // Only gh is told: the project's checks and the kit commands kit pr runs (which work it out themselves) keep the
  // caller's environment as it was.
  const children = f.calls().filter(call => call.tool !== "gh");
  assert.ok(children.some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
  assert.ok(children.some(call => call.tool === "unit.sh" || call.tool === "npm"), JSON.stringify(children.map(call => call.tool)));
  assert.deepEqual(children.filter(call => call.repo !== "acme/starter" || call.host), []);
});

test("the dry-run plan names origin's repo, with its host, never upstream's", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  f.git("config", `url.${f.origin}.insteadOf`, "https://github.com/acme/site.git");
  f.git("remote", "set-url", "origin", "https://github.com/acme/site.git");
  f.git("remote", "add", "upstream", "https://github.com/acme/starter.git");
  const plan = f.run(["--dry-run"], {}, true);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /^'gh' 'pr' 'create' .* '--repo' 'acme\/site'$/m);
  assert.match(plan.stdout, /^gh pr merge N --rebase --delete-branch --repo acme\/site /m);
  f.git("config", `url.${f.origin}.insteadOf`, "git@git.example.com:acme/site.git");
  f.git("remote", "set-url", "origin", "git@git.example.com:acme/site.git");
  const enterprise = f.run(["--dry-run"], {}, true);
  assert.match(enterprise.stdout, /^'gh' 'pr' 'create' .* '--repo' 'git\.example\.com\/acme\/site'$/m);
  assert.match(enterprise.stdout, /^gh pr merge N --rebase --delete-branch --repo git\.example\.com\/acme\/site /m);
});

test("an enterprise origin keeps its host on every gh call, the merge's --repo too", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  f.git("config", `url.${f.origin}.insteadOf`, "git@git.example.com:acme/site.git");
  f.git("remote", "set-url", "origin", "git@git.example.com:acme/site.git");
  f.git("remote", "add", "upstream", "https://github.com/acme/starter.git");
  const result = f.run([], { FAKE_BASE: "main", GH_HOST: "github.com" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const gh = f.calls().filter(call => call.tool === "gh");
  // gh api takes its host from GH_HOST, not GH_REPO: the merge queue lookup goes to the enterprise host.
  assert.ok(gh.some(call => call.args[0] === "api"));
  assert.deepEqual(gh.filter(call => call.repo !== "git.example.com/acme/site" || call.host !== "git.example.com"), []);
  assert.deepEqual(gh.find(call => call.args[0] === "repo")?.args.slice(0, 3), ["repo", "view", "git.example.com/acme/site"]);
  // repo view answers OWNER/NAME (the fake's test/repo); the merge names the host again.
  const merge = f.ghCalls("merge").at(-1)!.args;
  assert.equal(merge[merge.indexOf("--repo") + 1], "git.example.com/test/repo");
});

test("a folder origin with no GH_REPO stops kit pr before any gh call, as gh would pick the upstream itself", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  f.git("remote", "add", "upstream", "https://github.com/acme/starter.git");
  const result = f.run([], { GH_REPO: "" }, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^RESULT: fail origin \\(${f.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) is not a GitHub repo gh knows, so gh would pick a repo itself; ` +
    "point origin at the project's GitHub repo, gh auth login for its host, or set GH_REPO$", "m"));
  assert.deepEqual(f.calls(), []);
  const plan = f.run(["--dry-run"], { GH_REPO: "" }, true);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /^note: origin is not a GitHub repo and GH_REPO is unset, so a real run stops before opening a PR$/m);
});

test("a GitLab origin stops kit pr before any gh call: no GitHub repo gh knows", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  writeFileSync(join(f.bin, "ssh"), '#!/bin/bash\necho "hostname $3"\n'); chmodSync(join(f.bin, "ssh"), 0o755);
  f.git("config", `url.${f.origin}.insteadOf`, "git@gitlab.com:acme/site.git");
  f.git("remote", "set-url", "origin", "git@gitlab.com:acme/site.git");
  f.git("remote", "add", "upstream", "https://github.com/acme/starter.git");
  const result = f.run([], { GH_REPO: "" }, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail origin \(git@gitlab\.com:acme\/site\.git\) is not a GitHub repo gh knows, so gh would pick a repo itself; /m);
  assert.deepEqual(f.calls(), []);
});

test("a token in origin's url never shows: kit pr's messages, logs, records and gh calls show the host only", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  const token = "ke63-fake-token-0000";
  // Every file kit pr writes (its logs, the PR body, the scoreboard) and every call the fakes saw.
  const written = (folder: string): string[] => !existsSync(folder) ? [] : readdirSync(folder, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory() ? written(join(folder, entry.name)) : [readFileSync(join(folder, entry.name), "utf8")]);
  const leaks = (result: { stdout: string; stderr: string }) => [result.stdout, result.stderr, ...written(join(f.root, ".scratch")),
    ...written(join(f.main, ".scratch")), existsSync(f.env.FAKE_CALLS!) ? readFileSync(f.env.FAKE_CALLS!, "utf8") : ""].filter(text => text.includes(token));
  // Not on GitHub: the real run stops naming the host only, and the dry run plans.
  const gitlab = `https://ke63:${token}@gitlab.example.com/acme/site.git`;
  f.git("config", `url.${f.origin}.insteadOf`, gitlab);
  f.git("remote", "set-url", "origin", gitlab);
  const stopped = f.run([], { GH_REPO: "" }, true);
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /^RESULT: fail origin \(https:\/\/gitlab\.example\.com\/acme\/site\.git\) is not a GitHub repo gh knows, /m);
  assert.deepEqual(leaks(stopped), []);
  const plan = f.run(["--dry-run"], { GH_REPO: "" }, true);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.deepEqual(leaks(plan), []);
  // On GitHub: a whole run, from push to merge, whose check of the landed commits fails with git naming the url.
  const github = `https://x-access-token:${token}@github.com/acme/site.git`;
  f.git("config", `url.${f.origin}.insteadOf`, github);
  f.git("remote", "set-url", "origin", github);
  const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(f.bin, "git"), `#!/bin/bash\nif [[ $1 == fetch && $# == 4 ]]; then echo 'fatal: ${github}' >&2; exit 1; fi\nexec ${real} "$@"\n`);
  chmodSync(join(f.bin, "git"), 0o755);
  const landed = f.run([], { FAKE_BASE: "main", GH_REPO: "" }, true);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /^landed: not checked \(fatal: https:\/\/github\.com\/acme\/site\.git\)$/m);
  assert.match(landed.stdout, /RESULT: ok merged #73 abcdef0/);
  assert.deepEqual(leaks(landed), []);
});

test("a token split across a child's output chunks, on a last line with no newline, is still hidden in the log and its tail", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(f.bin, "git"), `#!/bin/bash\nif [[ $1 == fetch ]]; then printf 'fatal: https://ke63:ke63-fake' >&2; sleep 0.2\n` +
    `printf -- '-token-0000@gitlab.example.com/a.git' >&2; exit 1; fi\nexec ${real} "$@"\n`);
  chmodSync(join(f.bin, "git"), 0o755);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail fetch: fatal: https:\/\/gitlab\.example\.com\/a\.git$/m);
  const log = readFileSync(join(f.logDir(), "fetch.log"), "utf8");
  assert.equal(log, "fatal: https://gitlab.example.com/a.git");
  assert.match(result.stderr, /^ {2}fatal: https:\/\/gitlab\.example\.com\/a\.git$/m);
  assert.equal(`${result.stdout}${result.stderr}`.includes("ke63-fake"), false, result.stdout + result.stderr);
});

test("a failing rebase or gh pr merge that names a tokened url fails with the host only, in RESULT, log tail and logs", t => {
  const token = "ke63-fake-token-0000", url = `https://x-access-token:${token}@github.com/acme/site.git`;
  const logs = (f: ReturnType<typeof fixture>) => readdirSync(f.logDir()).map(name => readFileSync(join(f.logDir(), name), "utf8")).join("");
  const merge = fixture(t), merged = merge.run([], { FAKE_FAIL: "pr-merge", FAKE_FAIL_TEXT: `fatal: ${url}` });
  assert.equal(merged.status, 1, merged.stdout + merged.stderr);
  assert.match(merged.stdout, /^RESULT: fail merge: fatal: https:\/\/github\.com\/acme\/site\.git$/m);
  assert.match(merged.stderr, /^ {2}fatal: https:\/\/github\.com\/acme\/site\.git$/m);
  assert.equal([merged.stdout, merged.stderr, logs(merge)].some(text => text.includes(token)), false);
  const rebase = fixture(t);
  const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(rebase.bin, "git"), `#!/bin/bash\nif [[ $1 == rebase && $2 != --abort ]]; then echo 'fatal: ${url}' >&2; exit 1; fi\nexec ${real} "$@"\n`);
  chmodSync(join(rebase.bin, "git"), 0o755);
  const rebased = rebase.run();
  assert.equal(rebased.status, 1, rebased.stdout + rebased.stderr);
  assert.match(rebased.stdout, /^RESULT: fail rebase: fatal: https:\/\/github\.com\/acme\/site\.git$/m);
  assert.equal([rebased.stdout, rebased.stderr, logs(rebase)].some(text => text.includes(token)), false);
});

test("with a folder origin, a GH_REPO already set is what gh is told, and the merge keeps its host", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  const result = f.run([], { FAKE_BASE: "main", GH_REPO: "git.example.com/acme/site" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // gh api goes by GH_HOST, so the host GH_REPO names is put there.
  assert.deepEqual(f.calls().filter(call => call.tool === "gh" && (call.repo !== "git.example.com/acme/site" || call.host !== "git.example.com")), []);
  assert.deepEqual(f.calls().find(call => call.tool === "gh" && call.args[0] === "repo")?.args.slice(0, 3), ["repo", "view", "git.example.com/acme/site"]);
  const merge = f.ghCalls("merge").at(-1)!.args;
  assert.equal(merge[merge.indexOf("--repo") + 1], "git.example.com/test/repo");
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
  assert.match(result.stdout, /^ci: none \(no workflow in \.github\/workflows runs on pull requests\); landing after review$/m);
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
    assert.deepEqual(f.calls().filter(call => call.tool === "fake-kit").slice(-2).map(call => call.args), [["review", "--base", "origin/dev", "--pr", "73", "--ticket", "ticket.md"],
      ["review", "--base", "origin/dev", "--pr", "73", "--ticket", "ticket.md", "--second-look"]]);
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

test("a release runs kit release-check --land first, a dry run too; only releases run it", t => {
  const f = fixture(t);
  for (const args of [["--base", "main", "--release", "--dry-run"], ["--base", "main", "--release"]]) {
    const before = f.calls().length, result = f.run(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.calls()[before].args, ["release-check", "--land"]);
    assert.match(result.stdout, /^logs: .+\nrelease-check: ok \(done\)\n/);
  }
  const before = f.calls().length, plain = f.run(["--no-merge"]);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.equal(f.calls().slice(before).some(call => call.args[0] === "release-check"), false);
  assert.doesNotMatch(plain.stdout, /release-check/);
});

test("a failed release check stops the release before the fetch and the push, with the check's own RESULT text", t => {
  const f = fixture(t), result = f.run(["--base", "main", "--release"], { FAKE_FAIL: "release-check" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESULT: fail release-check: child failure$/m);
  assert.deepEqual(f.calls().map(call => call.args[0]), ["release-check"]);
  assert.equal(existsSync(join(f.logDir(), "fetch.log")), false);
});

test("a release check that fails without a RESULT line is named by its last stderr line", t => {
  const f = fixture(t), result = f.run(["--base", "main", "--release"], { FAKE_RELEASE_CHECK_STDERR: "kit-lib: cannot read settings" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESULT: fail release-check: kit-lib: cannot read settings$/m);
  assert.equal(existsSync(join(f.logDir(), "fetch.log")), false);
});

test("the real release check passes a release cut at origin/dev, fails one with a commit that never landed, and takes a lead's waiver", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") };
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  let result = f.run(["--base", "main", "--release", "--dry-run"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^logs: .+\nrelease-check: ok \([a-f0-9]{7} is origin\/dev, nothing unsaved\)\n/);
  assert.match(result.stdout, /RESULT: ok dry-run [a-f0-9]{7} release\/cut -> main$/m);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /- kit release-check --land: [a-f0-9]{7} is origin\/dev, nothing unsaved/);
  f.commit("Never landed", "extra.txt"); writeFileSync(join(f.root, "draft.txt"), "draft\n");
  result = f.run(["--base", "main", "--release", "--dry-run"], real);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RESULT: fail release-check: unsaved files \(draft\.txt\): .+; HEAD [a-f0-9]{7} is 1 commit ahead of origin\/dev: a release carries only what landed on dev; land it with kit pr first$/m);
  rmSync(join(f.root, "draft.txt"));
  result = f.run(["--base", "main", "--release", "--dry-run", "--waive", "hotfix tonight"], { ...real, ASE_OWNER: "ke-lead" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /release-check: ok \(waived by ke-lead \(hotfix tonight\): HEAD [a-f0-9]{7} is 1 commit ahead of origin\/dev\)/);
  assert.deepEqual(f.calls().filter(call => call.args[0] === "release-check").at(-1)?.args, ["release-check", "--land", "--waive", "hotfix tonight"]);
  assert.match(readFileSync(join(f.logDir(), "body.md"), "utf8"), /- kit release-check --land: waived by ke-lead \(hotfix tonight\): HEAD [a-f0-9]{7} is 1 commit ahead of origin\/dev/);
});

test("a release cut at origin/dev passes the check before kit pr rebases it onto a main that has a commit dev lacks", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`release-check: ok \\(${cut.slice(0, 7)} is origin/dev, nothing unsaved\\)`));
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
  // The pushed release is the cut rebased onto origin/main: the hotfix stays and the landed change follows it.
  assert.notEqual(f.git("rev-parse", "HEAD"), cut);
  assert.equal(f.git("log", "--format=%s", "-2"), "Landed change\nHotfix on main");
});

test("a rerun after an earlier run rebased the cut onto a hotfixed main says to cut it again, and the new cut passes", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  let result = f.run(["--base", "main", "--release", "--no-merge"], { ...real, FAKE_FAIL: "review" });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail review: /);
  result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RESULT: fail release-check: HEAD [a-f0-9]{7} and origin\/dev have split \(2 commits ahead, 1 behind\): cut the release again from origin\/dev \(git reset --keep origin\/dev\) and rerun kit pr --release$/m);
  f.git("reset", "-q", "--hard", "origin/dev");
  result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
});

test("a lead's waiver lets unsaved files through the release check, and kit pr still stops on them before any push", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "draft.txt"), "draft\n");
  const result = f.run(["--base", "main", "--release", "--waive", "x"], { ASE_OWNER: "ke-lead", FAKE_RELEASE_CHECK: resolve("kit.d/release-check") });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /release-check: ok \(waived by ke-lead \(x\): unsaved files \(draft\.txt\)/);
  assert.match(result.stdout, /RESULT: fail guards: uncommitted changes$/m);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
  assert.equal(f.gitAt(f.origin, "branch", "--list", "feature/kit-pr"), "");
});

test("a release where the landing branch is the live one checks origin/main", t => {
  const f = fixture(t, undefined, { branches: { land: "main", release: "main", ci: "main" } });
  f.git("checkout", "-q", "main"); f.commit("Landed on main", "landed.txt"); f.git("push", "-q", "origin", "main");
  f.git("checkout", "-q", "-b", "release/live");
  const result = f.run(["--base", "main", "--release", "--dry-run"], { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_BASE: "main" });
  assert.match(result.stdout, /^logs: .+\nrelease-check: ok \([a-f0-9]{7} is origin\/main, nothing unsaved\)\n/);
});

test("a waived release check is named on the release's final RESULT line, a dry run's too; a waiver not needed is not", t => {
  const lead = { ASE_OWNER: "ke-lead", FAKE_RELEASE_CHECK: resolve("kit.d/release-check") };
  for (const dry of [false, true]) {
    const f = fixture(t), result = f.run(["--base", "main", "--release", "--waive", "hotfix tonight", ...(dry ? ["--dry-run"] : [])], lead);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, dry ? /RESULT: ok dry-run [a-f0-9]{7} feature\/kit-pr -> main \(release-check waived: hotfix tonight\)$/m
      : /RESULT: ok opened #73 [a-f0-9]{7} \(release-check waived: hotfix tonight\)$/m);
  }
  const f = fixture(t);
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge", "--waive", "x"], lead);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /release-check: ok \([a-f0-9]{7} is origin\/dev, nothing unsaved \(waiver not needed: x\)\)/);
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
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
  assert.equal(result.status, 0, result.stderr); assert.equal(f.calls().some(claudeReview), false);
  assert.equal(f.ghCalls("comment")[0].body, `Reused review: ${join(parent, "20261016T110000Z")}\nHEAD: ${f.head}\n\n${complete("chosen")}\n`);
});

test("an incomplete or single-commit review for this HEAD is not reused", t => {
  for (const kind of ["incomplete", "single-commit"]) {
    const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261016T120000Z");
    const base = kind === "incomplete" ? f.git("merge-base", "origin/dev", "HEAD") : f.git("rev-parse", "HEAD~1");
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "refs.txt"), `${f.head}\n${base}\n`);
    writeFileSync(join(folder, "result.md"), kind === "incomplete" ? "REVIEW_STATUS: incomplete\n" : "REVIEW_STATUS: complete\n");
    const result = f.run(["--no-merge"]); assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().some(claudeReview), kind);
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
    assert.equal(f.calls().some(claudeReview), changed);
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
  assert.ok(f.calls().some(claudeReview));
});

test("a changed HEAD cannot reuse an incomplete, unreadable or finding-bearing patch review", t => {
  for (const report of ["REVIEW_STATUS: incomplete\n", "REVIEW_STATUS: complete\n", cleanReview.replace("Spec: none.", "Spec: a.ts:1 a defect.")]) {
    const f = fixture(t); f.saveReview(report);
    f.git("commit", "--allow-empty", "-m", "New HEAD, same patch");
    const result = f.run(["--no-merge"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(f.calls().some(claudeReview));
  }
});

test("a saved review for another HEAD triggers kit review --pr", t => {
  const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261016T120000Z");
  mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, "refs.txt"), "wrong\nbase\n"); writeFileSync(join(folder, "result.md"), "wrong report\n");
  const result = f.run(["--no-merge"]); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls().find(claudeReview)?.args, ["review", "--base", "origin/dev", "--pr", "73"]);
  assert.equal(f.ghCalls("comment").length, 0);
});

test("saved and fresh reviews stop on findings before CI or merge, capped at 15 and 160 characters", t => {
  const long = `a.ts:1 ${"A".repeat(163)}`;
  const report = `REVIEW_STATUS: complete\nDefects:\nSpec:\n- ${long}\n  More evidence on another line.\n${Array.from({ length: 15 }, (_, i) => `- a.ts:${i + 2} Defect ${i + 2}.`).join("\n")}\nStandards: none.\nValidation gaps:\n- Missing coverage.\nOptional nits:\n- Rename a variable.\n`;
  for (const source of ["saved", "fresh"]) {
    const f = fixture(t);
    const path = source === "saved" ? f.saveReview(report) : join(f.main, ".scratch/reviews/ak-14/fresh/result.md");
    const result = f.run([], { FAKE_REVIEW: report });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail pr #73 review has 17 open findings (${path})`);
    assert.ok(result.stdout.includes(`Spec: ${long.slice(0, 160)}…\n`), result.stdout);
    assert.doesNotMatch(result.stdout, /A{154}/);
    for (let i = 2; i <= 15; i++) assert.ok(result.stdout.includes(`Spec: a.ts:${i} Defect ${i}.\n`));
    assert.doesNotMatch(result.stdout, /Spec: a\.ts:16 Defect 16\.|Validation gaps: Missing coverage|Rename a variable|review: ok/);
    assert.match(result.stdout, /^… and 2 more$/m);
    assert.equal(f.ghCalls("merge").length, 0);
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
    assert.equal(f.calls().some(claudeReview), source === "fresh");
    if (source === "saved") assert.ok(f.ghCalls("comment")[0].body?.includes(report));
  }
});

// Slice 12: a Standards group holding only a no-section-applies sentence is a note, so the review is clean.
const notesReview = "REVIEW_STATUS: complete\nDefects:\nSpec: none.\nStandards:\nNo section of CODING_STANDARDS.md applies to this change.\nValidation gaps: none.\nOptional nits: none.\n";

for (const report of [cleanReview, notesReview]) test(`saved and fresh clean reviews still wait for CI and merge (notes=${report === notesReview})`, t => {
  for (const source of ["saved", "fresh"]) {
    const f = fixture(t);
    if (source === "saved") f.saveReview(report);
    const result = f.run([], { FAKE_REVIEW: report });
    assert.doesNotMatch(result.stdout, /open findings/);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /review: ok\n/);
    assert.match(result.stdout, /RESULT: ok merged #73/);
    assert.equal(f.ghCalls("merge").length, 1);
    assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
    assert.equal(f.calls().some(claudeReview), source === "fresh");
  }
});

test("a rerun after fixing findings in a new commit reviews the new HEAD and merges", t => {
  const f = fixture(t);
  const path = f.saveReview("REVIEW_STATUS: complete\nDefects:\nSpec:\n- a.ts:1 Fix the defect.\nValidation gaps: none.\nOptional nits: none.\n");
  const stopped = f.run();
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.ok(stopped.stdout.includes(`RESULT: fail pr #73 review has 1 open findings (${path})`));
  const head = f.commit("Fix the defect");
  const result = f.run([], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.equal(f.calls().filter(claudeReview).length, 1);
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
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 A defect.\n- Standards: none.\nValidation gaps: Add coverage.\nOptional nits: Rename a variable.\n";
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
  const result = f.run(["--waive", "Follow up later"], { ASE_OWNER: "", FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 A defect.\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings: Follow up later");
});

test("waiver does not claim a merge for no-merge, release, clean reviews or failed CI", t => {
  for (const mode of ["no-merge", "release", "clean", "ci-failure"]) {
    const f = fixture(t);
    const args = ["--waive", "Follow up later", ...(mode === "no-merge" ? ["--no-merge"] : mode === "release" ? ["--release", "--base", "main"] : [])];
    const result = f.run(args, { ASE_OWNER: "ke-lead", FAKE_REVIEW: mode === "clean" ? cleanReview : "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 A defect.\n", FAKE_FAIL: mode === "ci-failure" ? "wait" : "" });
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
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 A defect.\n- Standards: none.\nValidation gaps: none.\nOptional nits: none.\n";
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
  assert.deepEqual(actions.map(call => call.tool === "gh" ? "merge" : call.args.includes("--second-look") ? "second" : call.args[0]), ["review", "second", "wait", "merge", "wait", "merge"]);
  assert.match(result.stdout, /second look: reused \(same patch on new base\)/);
  assert.match(result.stdout, /review: reused \(same patch on new base\)/);
  assert.ok(f.ghCalls("comment")[0].body?.includes(`HEAD: ${head}`));
});

test("findings in the rebased HEAD review stop before another CI wait or merge", t => {
  const f = fixture(t), peer = f.peer();
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 Rebased HEAD has a defect.\n";
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REBASED_REVIEW: report });
  const head = f.git("rev-parse", "HEAD"), folder = join(f.main, ".scratch/reviews/ak-14/fresh-2");
  assert.notEqual(head, f.head);
  assert.equal(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), head);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail pr #73 review has 1 open findings (${join(folder, "result.md")})`);
  assert.match(result.stdout, /^Spec: a\.ts:1 Rebased HEAD has a defect\.$/m);
  assert.equal(readFileSync(join(f.main, ".scratch/reviews/ak-14/fresh/result.md"), "utf8"), cleanReview);
  assert.equal(readFileSync(join(folder, "refs.txt"), "utf8"), `${head}\n${f.git("merge-base", "origin/dev", "HEAD")}\n`);
  const actions = f.calls().filter(call => (call.tool === "fake-kit" && ["review", "wait"].includes(call.args[0]))
    || (call.tool === "gh" && call.args[1] === "merge"));
  assert.deepEqual(actions.map(call => call.tool === "gh" ? "merge" : call.args.includes("--second-look") ? "second" : call.args[0]), ["review", "second", "wait", "merge", "review"]);
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

// A closed ticket whose Done names the branch's SHAs, as builders wrote them before rebase and landing rewrote them.
const shaTicket = (first: string, second: string) => `---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\n- Behaviour.\n- Commits: ${first} (build), ${second}\n  (round 1).\n- Tests: unit green.\n`;

test("a Done that names branch SHAs is pushed naming the commits by subject, in a ticket-only commit", t => {
  const f = fixture(t), first = f.git("rev-parse", "--short", "HEAD^"), second = f.git("rev-parse", "--short", "HEAD");
  const closed = f.commit("Close ticket", "ticket.md", shaTicket(first, second));
  const result = f.run(["--ticket", "ticket.md", "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^commits: ticket\.md names 3 commits by subject$/m);
  const pushed = f.gitAt(f.origin, "show", "refs/heads/feature/kit-pr:ticket.md");
  assert.equal(pushed, shaTicket(first, second).replace(/- Commits: [^]*\(round 1\)\./,
    '- Commits: "First change", "Second change", "Close ticket" and this commit.').trimEnd());
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket commits by subject");
  assert.equal(f.git("rev-parse", "HEAD^"), closed);
  assert.equal(f.git("diff", "--name-only", closed, "HEAD"), "ticket.md");
  assert.equal(f.git("status", "--porcelain"), "");
  // A rerun finds the line already named and adds no commit; a Done without the line gets none.
  const head = f.git("rev-parse", "HEAD");
  assert.equal(f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_EXISTING: "1" }).status, 0);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  const plain = fixture(t);
  plain.commit("Close ticket", "ticket.md", '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\nImplemented.\n');
  const before = plain.git("rev-parse", "HEAD"), untouched = plain.run(["--ticket", "ticket.md", "--no-merge"]);
  assert.equal(untouched.status, 0, untouched.stdout + untouched.stderr);
  assert.equal(plain.git("rev-parse", "HEAD"), before);
  assert.doesNotMatch(untouched.stdout, /^commits:/m);
});

test("a CRLF ticket's Commits line and its continuation are replaced whole, keeping CRLF", t => {
  const f = fixture(t), crlf = (text: string) => text.replaceAll("\n", "\r\n");
  const ticket = crlf('---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\n- Commits: 1111111 (build),\n  2222222\n  (round 1).\n- Tests: unit green.\n');
  f.commit("Close ticket", "ticket.md", ticket);
  const result = f.run(["--ticket", "ticket.md", "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pushed = spawnSync("git", ["-C", f.origin, "show", "refs/heads/feature/kit-pr:ticket.md"], { encoding: "utf8" }).stdout;
  assert.equal(pushed, crlf('---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\n- Commits: "First change", "Second change", "Close ticket" and this commit.\n- Tests: unit green.\n'));
});

test("a ticket edited during the rebase stops kit pr before it names commits, and the edit enters no commit", t => {
  const f = fixture(t), peer = f.peer();
  f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  writeFileSync(join(peer, "upstream.txt"), "upstream\n");
  f.gitAt(peer, "add", "upstream.txt"); f.gitAt(peer, "commit", "-qm", "advance upstream"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const hook = join(f.root, ".git/hooks/post-rewrite");
  writeFileSync(hook, "#!/bin/sh\necho 'Edited during the rebase.' >> ticket.md\n"); chmodSync(hook, 0o755);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail commits: worktree changed before naming commits$/m);
  assert.notEqual(f.git("log", "-1", "--format=%s"), "docs: ticket commits by subject");
  assert.equal(f.git("log", "--all", "--format=%h", "-S", "Edited during the rebase."), "");
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a rerun after a fix commit names the earlier subjects commit and adds a second one", t => {
  const f = fixture(t);
  f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  assert.equal(f.run(["--ticket", "ticket.md", "--no-merge"]).status, 0);
  f.commit("Review fixes round 1");
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(join(f.root, "ticket.md"), "utf8"),
    /^- Commits: "First change", "Second change", "Close ticket", "docs: ticket commits by subject", "Review fixes round 1" and this commit\.$/m);
  assert.equal(f.git("log", "--format=%s", "origin/dev..HEAD").split("\n").filter(subject => subject === "docs: ticket commits by subject").length, 2);
});

test("a clean review saved before the subjects commit is still reused after a rebase onto a moved base", t => {
  const f = fixture(t), peer = f.peer();
  f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  f.saveReview(cleanReview);
  writeFileSync(join(peer, "upstream.txt"), "upstream\n");
  f.gitAt(peer, "add", "upstream.txt"); f.gitAt(peer, "commit", "-qm", "advance upstream"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const result = f.run(["--ticket", "ticket.md", "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^commits: ticket\.md names 3 commits by subject$/m);
  assert.match(result.stdout, /^review: reused \(same patch on new base\)$/m);
  assert.equal(f.calls().filter(claudeReview).length, 0);
});

test("after a rebase merge rewrites every commit, kit pr prints each landed SHA and names a subject it cannot find", t => {
  for (const [rename, other] of [["", ""], ["Second change", ""], ["", "Second change"]]) {
    const f = fixture(t), peer = f.peer();
    f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
    const result = f.run(["--ticket", "ticket.md"], { FAKE_LAND: peer, FAKE_LAND_RENAME: rename, FAKE_LAND_OTHER: other });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    f.git("fetch", "-q", "origin");
    const branch = f.git("log", "--format=%h", "origin/dev..HEAD").split("\n");
    // Another PR's "Second change" landed first: it is on dev but never named.
    const landed = f.git("log", "--reverse", "--format=%h %s", "origin/main..origin/dev").split("\n").slice(other ? 1 : 0);
    assert.equal(landed.length, 4);
    const expected = landed.map(line => line.endsWith(" Renamed on landing") ? "not found on dev: Second change" : `landed: ${line}`);
    assert.deepEqual(result.stdout.split("\n").filter(line => /^(landed|not found on)/.test(line)), expected);
    assert.deepEqual(expected.map(line => line.split(" ")[0]), ["landed:", rename ? "not" : "landed:", "landed:", "landed:"]);
    for (const line of landed) assert.ok(!branch.includes(line.split(" ")[0]), `${line} kept a branch SHA`);
    assert.match(result.stdout, new RegExp(`^RESULT: ok merged #73 ${landed.at(-1)!.split(" ")[0].slice(0, 7)}$`, "m"));
  }
});

test("without a merge commit to walk back from, the landed lines say they were not checked and the merge still counts", t => {
  for (const [overrides, reason] of [[{}, /^landed: not checked \(.+\)$/m], [{ FAKE_VIEW_ERROR: "1" }, /^landed: not checked \(GitHub named no merge commit\)$/m]] as const) {
    const f = fixture(t), result = f.run(["--ticket", "ticket.md"], overrides);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, reason);
    assert.doesNotMatch(result.stdout, /^(landed: [a-f0-9]|not found on)/m);
    assert.match(result.stdout, /^RESULT: ok merged #73 [a-f0-9]{7}$/m);
  }
});

test("lines after a Commits line that are not indented under it, or are list items, survive the rewrite", t => {
  const f = fixture(t);
  const ticket = '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\n**Commits:** abc1234\n  (round 1)\nTests: green.\n1. Numbered note.\n';
  f.commit("Close ticket", "ticket.md", ticket);
  const result = f.run(["--ticket", "ticket.md", "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), ticket.replace("**Commits:** abc1234\n  (round 1)",
    '**Commits:** "First change", "Second change", "Close ticket" and this commit.'));
});

test("only the commit list is rewritten: text after its sentence end, the label and the lines after it stay", t => {
  const named = '"First change", "Second change", "Close ticket" and this commit';
  for (const [before, after] of [
    ["- Commits: abc1234 (build). Evidence: RESULT: ok unit 1/1.", `- Commits: ${named}. Evidence: RESULT: ok unit 1/1.`],
    ["- Commits: e0983020c (a path, a space), 71caafa25 (review round 1); the round-2 fixes follow them. Evidence: `RESULT: ok unit 41/41 (1 files)`.",
      `- Commits: ${named}; the round-2 fixes follow them. Evidence: \`RESULT: ok unit 41/41 (1 files)\`.`],
    ["- Commits:\n  - abc1234 build\n  - def5678 round 1", `- Commits: ${named}.`],
    ["**Commits on dev**: abc1234 \"v1.2 fix\".", `**Commits on dev**: ${named}.`],
  ]) {
    const f = fixture(t), frame = (line: string) => `---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\n${line}\n- Tests: green.\n`;
    f.commit("Close ticket", "ticket.md", frame(before));
    const result = f.run(["--ticket", "ticket.md", "--no-merge"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), frame(after));
    const head = f.git("rev-parse", "HEAD");
    assert.equal(f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_EXISTING: "1" }).status, 0);
    assert.equal(f.git("rev-parse", "HEAD"), head);
  }
});

test("a --dry-run and a --release leave the Commits line and HEAD alone", t => {
  for (const args of [["--dry-run"], ["--base", "main", "--release"]]) {
    const f = fixture(t);
    const head = f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
    const result = f.run(["--ticket", "ticket.md", ...args]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /^commits:/m);
    assert.equal(f.git("rev-parse", "HEAD"), head);
    assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), shaTicket("1111111", "2222222"));
  }
});

test("a commit with kit's subject that changes more than the ticket is not left out of the patch, so a fresh review runs", t => {
  const f = fixture(t), peer = f.peer();
  f.saveReview(cleanReview);
  writeFileSync(join(f.root, "file.txt"), "changed\n");
  writeFileSync(join(f.root, "ticket.md"), '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-28)\n\nImplemented.\n');
  f.git("add", "file.txt", "ticket.md"); f.git("commit", "-qm", "docs: ticket commits by subject");
  writeFileSync(join(peer, "upstream.txt"), "upstream\n");
  f.gitAt(peer, "add", "upstream.txt"); f.gitAt(peer, "commit", "-qm", "advance upstream"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const result = f.run(["--ticket", "ticket.md", "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /^review: reused/m);
  assert.equal(f.calls().filter(claudeReview).length, 1);
});

test("a refused subjects commit fails at its step and leaves the ticket as it was", t => {
  const f = fixture(t);
  const head = f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  const hook = join(f.root, ".git/hooks/commit-msg");
  writeFileSync(hook, "#!/bin/sh\necho 'message refused' >&2\nexit 1\n"); chmodSync(hook, 0o755);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail commits: git commit failed: .*message refused/m);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a behind retry rebases the subjects commit without adding another, and reuses the review", t => {
  const f = fixture(t), peer = f.peer();
  f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  const result = f.run(["--ticket", "ticket.md"], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.split("\n").filter(line => line.startsWith("commits: ")).length, 1);
  assert.match(result.stdout, /^review: reused \(same patch on new base\)$/m);
  assert.equal(f.calls().filter(claudeReview).length, 1);
  const pushed = "refs/heads/feature/kit-pr";
  assert.deepEqual(f.gitAt(f.origin, "log", "--format=%s", `dev..${pushed}`).split("\n"),
    ["docs: ticket commits by subject", "Close ticket", "Second change", "First change"]);
  assert.match(f.gitAt(f.origin, "show", `${pushed}:ticket.md`), /^- Commits: "First change", "Second change", "Close ticket" and this commit\.$/m);
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

// The pure tier rules read the settings of the project around them; these tests read the editor's (a copy).
function asEditor(body: () => void) {
  const root = mkdtempSync(join(tmpdir(), "kit-pr-editor-")), before = process.env.KIT_ROOT;
  try {
    mkdirSync(join(root, "scripts/agents"), { recursive: true });
    writeFileSync(join(root, "scripts/agents/kit.json"), readFileSync("tests/fixtures/editor-kit.json", "utf8"));
    process.env.KIT_ROOT = root;
    body();
  } finally {
    if (before === undefined) delete process.env.KIT_ROOT; else process.env.KIT_ROOT = before;
    rmSync(root, { recursive: true, force: true });
  }
}

test("each path reaches a tier and the highest present wins", () => asEditor(() => {
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
}));

test("tier steps: docs skips unit, specs and review; full keeps today's set", () => {
  assert.deepEqual(checkSteps({ tier: "docs", docs: true }), { steps: ["tickets", "unit-files"], review: false });
  assert.deepEqual(checkSteps({ tier: "css", docs: false }), { steps: ["colours", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "css", docs: true }), { steps: ["colours", "tickets", "unit-files", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "tests", docs: false }), { steps: ["check", "unit-files", "lint", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "full", docs: true }), { steps: ["check", "unit", "lint", "specs"], review: true });
});

test("focused unit files: changed tests, tests naming a changed helper or fixture, and docs guards", () => asEditor(() => {
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
}));

test("a docs-only PR runs only doc guards, skips Claude's review but not the second look, and still waits for CI and merges", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n", "AGENTS.md": "# Agents\n" }), result = f.run();
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.match(result.stdout, /^tier: docs \(2 files, all docs\)$/m); assert.match(result.stdout, /review: skipped \(docs tier\)/);
  const calls = f.calls();
  assert.deepEqual(calls.filter(call => call.tool === "tickets.mjs").map(call => call.args), [["check"]]);
  assert.deepEqual(calls.filter(call => call.tool === "unit.sh").map(call => call.args), [["tests/code-map.test.ts"]]);
  assert.equal(calls.some(call => call.tool === "npm"), false);
  assert.equal(calls.some(call => claudeReview(call) || (call.tool === "fake-kit" && call.args[0] === "specs")), false);
  assert.deepEqual(calls.filter(call => call.tool === "fake-kit" && call.args[0] === "review").map(call => call.args), [["review", "--base", "origin/dev", "--pr", "73", "--second-look"]]);
  assert.match(result.stdout, /^second look: code \(feature\.txt\) grok-4\.7$/m);
  assert.ok(calls.some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
  assert.match(f.body(), /Tier: docs \(2 files, all docs\)/);
  assert.match(f.body(), /skipped for the docs tier \(CI still runs check, unit tests, lint and browser tests\): npm run check, npm test \(all unit tests\), npm run lint, kit specs --affected, kit review/);
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

test("a docs-tier PR with a KIT_HOME outside the project runs that home's tickets.mjs, as the PR body says", t => {
  const f = fixture(t, { "docs/work/01-x.md": "---\ntitle: X\n---\n" });
  const home = join(f.dir, "kit-home");
  mkdirSync(home);
  for (const name of ["unit.sh", "tickets.mjs"]) copyFileSync(join(f.root, "scripts/agents", name), join(home, name));
  chmodSync(join(home, "unit.sh"), 0o755);
  const result = f.run(["--no-merge"], { KIT_HOME: home });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^tier: docs /m);
  assert.deepEqual(f.calls().filter(call => call.tool === "tickets.mjs").map(call => [call.script, call.args]), [[join(home, "tickets.mjs"), ["check"]]]);
  assert.ok(f.body().includes(`- node ${join(home, "tickets.mjs")} check: ok`), f.body());
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

test("visible paths: CSS, components, ui, page builder except rules, icons and index.html", () => asEditor(() => {
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
}));

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
  const both = fixture(t, css), report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 A defect.\n";
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
  assert.ok(f.calls().some(claudeReview));
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
  assert.equal(calls.filter(claudeReview).length, expectedReviews);
  const rerun = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), updated);
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1);
  assert.equal(f.calls().filter(claudeReview).length, expectedReviews);
});

for (const defect of ["P0: Broken build.", "P1: Serious defect.", "a.ts:1 No readable severity."]) test(`three rounds still block ${defect}`, t => {
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

test("a follow-ups commit after the subjects commit names it and becomes this commit; a rerun adds nothing", t => {
  const f = fixture(t);
  f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  f.rounds(3);
  const result = f.run(["--ticket", "ticket.md"], { FAKE_REVIEW: minorReview });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.git("log", "--format=%s", "-2").split("\n"), ["docs: ticket follow-ups from review", "docs: ticket commits by subject"]);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.match(ticket, /^- Commits: "First change", "Second change", "Close ticket", "docs: ticket commits by subject" and this commit\.$/m);
  assert.match(ticket, /### Follow-ups\n\n- Spec \(P2\): P2: Minor defect\./);
  const head = f.git("rev-parse", "HEAD");
  const rerun = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1", FAKE_REVIEW: minorReview });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), ticket);
});

test("ticket-only coverage excludes any other changed path", t => {
  const f = fixture(t); f.rounds(3); f.saveReview(minorReview);
  f.commit("New implementation", "file.txt", "changed after review\n");
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.calls().filter(claudeReview).length, 1);
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

const long = `P2: ${"Evidence names the file and line. ".repeat(6)}Fix: keep the whole sentence in the ticket.`;
const longGap = `${"Test to add: a case that names its fixture. ".repeat(4)}Assert the whole sentence.`;
const followupTicket = (lines: string[]) => `---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-19)\n\nImplemented.\n${lines.length ? `\n### Follow-ups\n\n${lines.join("\n")}\n` : ""}`;

test("a follow-up longer than 160 characters reaches the ticket in full and the PR summary marks the cut", t => {
  const f = fixture(t); f.rounds(3);
  f.commit("Close ticket", "ticket.md", followupTicket([]));
  assert.ok(long.length > 160);
  f.saveReview(minorReview.replace("P2: Minor defect.", long));
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.ok(ticket.includes(`\n- Spec (P2): ${long}\n`), ticket);
  const cut = `- Spec (P2): ${long.slice(0, 160).trimEnd()}…`;
  const summary = `Follow-ups (non-blocking after 3 fix rounds):\n${cut}\n- Validation gaps (gap): Add coverage.`;
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1);
  assert.ok(f.apiCalls().some(call => call.body?.includes(summary)));
  const head = f.git("rev-parse", "HEAD");
  const rerun = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), ticket);
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1);
});

for (const [length, cut] of [[160, false], [161, true]] as const) test(`a ${length}-character follow-up ${cut ? "is" : "is not"} marked … in the PR summary`, t => {
  const f = fixture(t); f.rounds(3);
  const text = `P2: ${"x".repeat(length - 4)}`;
  f.saveReview(minorReview.replace("P2: Minor defect.", text));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const expected = cut ? `- Spec (P2): ${text.slice(0, 160)}…\n` : `- Spec (P2): ${text}\n`;
  assert.ok(f.ghCalls("comment").at(-1)?.body?.includes(expected), f.ghCalls("comment").at(-1)?.body);
});

for (const emoji of ["😀", "👨‍👩‍👧", "🇳🇱", "👍🏽"]) test(`the PR summary cut keeps ${emoji} whole`, t => {
  const f = fixture(t); f.rounds(3);
  const text = `P2: ${"x".repeat(155)}${emoji}${emoji} tail`;
  f.saveReview(minorReview.replace("P2: Minor defect.", text));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = f.ghCalls("comment").at(-1)?.body || "";
  assert.ok(body.includes(`- Spec (P2): P2: ${"x".repeat(155)}${emoji}…\n`), body);
});

test("a rerun swaps follow-ups cut before full follow-ups for the full text and posts no second comment", t => {
  const f = fixture(t); f.rounds(3);
  const oldSpec = `- Spec (P2): ${long.slice(0, 160)}`, oldGap = `- Validation gaps (gap): ${longGap.slice(0, 160)}`;
  f.commit("Close ticket", "ticket.md", followupTicket([oldSpec, oldGap]));
  const oldSummary = `Follow-ups (non-blocking after 3 fix rounds):\n${oldSpec}\n${oldGap}`;
  const posted = { tool: "gh", args: ["pr", "comment", "73", "--body-file", "old.md"], body: oldSummary } satisfies Call;
  appendFileSync(f.env.FAKE_CALLS!, JSON.stringify(posted) + "\n");
  assert.deepEqual(f.ghCalls("comment"), [posted]);
  f.saveReview(minorReview.replace("P2: Minor defect.", long).replace("Add coverage.", longGap));
  const before = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), followupTicket([`- Spec (P2): ${long}`, `- Validation gaps (gap): ${longGap}`]));
  assert.equal(f.git("rev-parse", "HEAD^"), before);
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.deepEqual(f.ghCalls("comment").filter(call => call.body?.startsWith("Follow-ups")).map(call => call.body), [oldSummary]);
  const summary = `Follow-ups (non-blocking after 3 fix rounds):\n- Spec (P2): ${long.slice(0, 160).trimEnd()}…\n- Validation gaps (gap): ${longGap.slice(0, 160).trimEnd()}…`;
  const patched = f.apiCalls().findLast(call => call.body?.includes("Follow-ups"))?.body || "";
  assert.equal(patched.split(summary).length, 2, patched);
  assert.ok(!patched.includes(oldSummary), patched);
});

for (const eol of ["\n", "\r\n"]) test(`a rerun upgrades an old cut follow-up in place and adds a new one in full in one commit (${JSON.stringify(eol)})`, t => {
  const f = fixture(t); f.rounds(3);
  const oldSpec = `- Spec (P2): ${long.slice(0, 160)}`;
  f.commit("Close ticket", "ticket.md", followupTicket([oldSpec, "", "Kept note."]).replaceAll("\n", eol));
  f.saveReview(minorReview.replace("P2: Minor defect.", long).replace("Add coverage.", longGap));
  const before = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"),
    followupTicket([`- Spec (P2): ${long}`, "", "Kept note.", `- Validation gaps (gap): ${longGap}`]).replaceAll("\n", eol));
  assert.equal(f.git("rev-parse", "HEAD^"), before);
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
});

test("findings that share their first 160 characters each upgrade one old cut bullet", t => {
  const f = fixture(t); f.rounds(3);
  const first = `${longGap} First.`, second = `${longGap} Second.`, old = `- Validation gaps (gap): ${longGap.slice(0, 160)}`;
  f.commit("Close ticket", "ticket.md", followupTicket([old, old]));
  f.saveReview(minorReview.replace("Validation gaps: Add coverage.", `Validation gaps:\n- ${first}\n- ${second}`));
  const result = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"),
    followupTicket([`- Validation gaps (gap): ${first}`, `- Validation gaps (gap): ${second}`, "- Spec (P2): P2: Minor defect."]));
});

const minorLines = ["- Spec (P2): P2: Minor defect.", "- Validation gaps (gap): Add coverage."];

test("a CRLF ticket without a Follow-ups section gets the new section in CRLF", t => {
  const f = fixture(t); f.rounds(3);
  f.commit("Close ticket", "ticket.md", followupTicket([]).replaceAll("\n", "\r\n"));
  f.saveReview(minorReview);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.ok(ticket.startsWith(followupTicket(minorLines).replaceAll("\n", "\r\n")), JSON.stringify(ticket));
  assert.doesNotMatch(ticket, /(?<!\r)\n/);
});

test("a CRLF Follow-ups section whose last bullet has no final newline gets new bullets in CRLF", t => {
  const f = fixture(t); f.rounds(3);
  const original = followupTicket([minorLines[0]]).replaceAll("\n", "\r\n").replace(/\r\n$/, "");
  f.commit("Close ticket", "ticket.md", original);
  f.saveReview(minorReview);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), `${original}\r\n${minorLines[1]}`);
});

test("a ticket with any CRLF joins a new bullet with CRLF, even inside an LF Follow-ups section", t => {
  const f = fixture(t); f.rounds(3);
  const original = followupTicket([minorLines[0]]).replace('---\ntitle: "Ticket title"\n---\n', '---\r\ntitle: "Ticket title"\r\n---\r\n');
  f.commit("Close ticket", "ticket.md", original);
  f.saveReview(minorReview);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), original.replace(`${minorLines[0]}\n`, `${minorLines[0]}\r\n${minorLines[1]}\n`));
});

test("an old cut bullet beside its full line is left alone: file and HEAD unchanged, no third line", t => {
  const f = fixture(t); f.rounds(3);
  const original = followupTicket([`- Spec (P2): ${long.slice(0, 160)}`, `- Spec (P2): ${long}`, minorLines[1]]);
  f.commit("Close ticket", "ticket.md", original);
  f.saveReview(minorReview.replace("P2: Minor defect.", long));
  const before = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), original);
  assert.equal(f.git("rev-parse", "HEAD"), before);
});

for (const eol of ["\n", "\r\n"]) for (const commented of [true, false]) test(`an old cut that split an emoji, written as U+FFFD, is upgraded to one full bullet with ${commented ? "no second comment" : "one new comment"} (${JSON.stringify(eol)})`, t => {
  const f = fixture(t); f.rounds(3);
  const text = `P2: ${"x".repeat(155)}🙂🙂 tail`;
  // The old run cut 🙂 at unit 160 and wrote its lone surrogate as U+FFFD.
  assert.equal(text.slice(0, 160).at(-1), "\uD83D");
  const oldSpec = `- Spec (P2): ${text.slice(0, 159)}\uFFFD`;
  f.commit("Close ticket", "ticket.md", followupTicket([oldSpec, minorLines[1]]).replaceAll("\n", eol));
  const heading = "Follow-ups (non-blocking after 3 fix rounds):\n";
  const oldSummary = `${heading}${oldSpec}\n${minorLines[1]}`;
  // Without an old comment only the ticket side can match, so each side is pinned on its own.
  if (commented) appendFileSync(f.env.FAKE_CALLS!, JSON.stringify({ tool: "gh", args: ["pr", "comment", "73", "--body-file", "old.md"], body: oldSummary } satisfies Call) + "\n");
  f.saveReview(minorReview.replace("P2: Minor defect.", text));
  const result = f.run(["--ticket", "ticket.md"], { FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.equal(ticket, followupTicket([`- Spec (P2): ${text}`, minorLines[1]]).replaceAll("\n", eol));
  if (eol === "\r\n") assert.doesNotMatch(ticket, /(?<!\r)\n/);
  const summary = `${heading}- Spec (P2): P2: ${"x".repeat(155)}🙂…\n${minorLines[1]}`;
  assert.deepEqual(f.ghCalls("comment").filter(call => call.body?.startsWith("Follow-ups")).map(call => call.body), [commented ? oldSummary : summary]);
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


for (const eol of ["\n", "\r\n"]) test(`follow-ups create a dated Done section without changing Done when acceptance criteria (${JSON.stringify(eol)})`, t => {
  const f = fixture(t); f.rounds(3);
  const original = '---\ntitle: "Ticket title"\n---\n\n## Files\n\n- `file.txt`\n\n## Done when\n\n- Required behaviour is present.\n- Required coverage passes.\n'.replaceAll("\n", eol);
  f.commit("Write acceptance criteria", "ticket.md", original);
  f.saveReview(minorReview);
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.ok(ticket.startsWith(`${original.trimEnd()}${eol}${eol}## Done (`), ticket);
  const nl = eol === "\r\n" ? "\\r\\n" : "\\n";
  assert.match(ticket.slice(original.trimEnd().length), new RegExp(`^${nl}${nl}## Done \\(\\d{4}-\\d{2}-\\d{2}\\)${nl}${nl}### Follow-ups${nl}`));
  assert.equal(ticket.split("### Follow-ups").length, 2);
  assert.match(ticket, /- Spec \(P2\): P2: Minor defect./);
  assert.match(ticket, /- Validation gaps \(gap\): Add coverage./);
  if (eol === "\r\n") assert.doesNotMatch(ticket, /(?<!\r)\n/);
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

const table = JSON.parse(readFileSync("second-look.json", "utf8")).kinds;

test("dry-run names the second look's kind, its deciding path, its model and fallback, and its command", t => {
  // A visible change carries its feature-list line in a changed ticket: UX still comes before that DX path.
  const done = '---\ntitle: "Ticket title"\n---\n\n## Done\n\nFeature list: no change (test)\n';
  for (const [file, kind, extra] of [["docs/guide.md", "dx"], ["docs/agents/runner.md", "agent"], ["src/ui/panel.ts", "ux", { "ticket.md": done }], ["src/x.ts", "code"]] as const) {
    const f = fixture(t, { [file]: "x\n", ...extra }), result = f.run(["--dry-run", "--ticket", "ticket.md"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^second look: ${kind} \\(${file.replaceAll(".", "\\.")}\\) ${table[kind].model.replaceAll(".", "\\.")}, else ${table[kind].fallback.replaceAll(".", "\\.")}$`, "m"), file);
    assert.match(result.stdout, /^\S+ 'review' '--base' 'origin\/dev' '--pr' 'N' '--ticket' 'ticket\.md' '--second-look'$/m, file);
  }
});

test("a second-look P1 blocks the merge like Claude's, after Claude's clean review", t => {
  const f = fixture(t);
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(result.status, 1, result.stderr);
  const folder = join(f.main, ".scratch/reviews/ak-14/second-1");
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail pr #73 second look has 1 open findings (${join(folder, "result.md")})`);
  assert.match(result.stdout, /^review: ok$/m);
  assert.match(result.stdout, /^second look: code \(feature\.txt\) grok-4\.7$/m);
  assert.equal(f.ghCalls("merge").length, 0);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
});

test("when no model can take the second look the PR still lands and says why", t => {
  const f = fixture(t), result = f.run([], { FAKE_SECOND: "skip" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^second look: skipped \(grok-4\.7 out of credit; opencode\/deepseek-v4\.1-flash-free out of credit\)$/m);
  assert.match(result.stdout, /RESULT: ok merged #73/);
});

test("a saved second look is reused only as a second look that ran; it is never taken for Claude's review", t => {
  for (const ok of [true, false]) {
    const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261019T100000Z");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "refs.txt"), `${f.head}\n${f.git("merge-base", "origin/dev", "HEAD")}\n`);
    writeFileSync(join(folder, "result.md"), cleanReview);
    writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model: "grok-4.7", ok }));
    const result = f.run(["--no-merge"]);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(f.calls().some(claudeReview), String(ok));
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args.includes("--second-look")), !ok, String(ok));
    assert.equal(f.ghCalls("comment").some(call => call.body?.startsWith(`Reused second look: ${folder}`)), ok, String(ok));
    assert.equal(result.stdout.includes(`second look: reused (${folder})`), ok, result.stdout);
  }
});

test("a second look that fails (exit 1) stops kit pr before CI and merge", t => {
  const f = fixture(t), result = f.run([], { FAKE_SECOND: "fail" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: fail second-look: /);
  assert.equal(f.ghCalls("merge").length, 0);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), false);
});

test("dry-run leaves the ticket file out of the second look's kind when code changed beside it", t => {
  const ticket = "docs/wayfinder/m/build/tickets/01-x.md";
  const f = fixture(t, { "src/x.ts": "x\n", [ticket]: '---\ntitle: "Ticket title"\n---\n' }), result = f.run(["--dry-run", "--ticket", ticket]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: code \(src\/x\.ts\) /m);
});

test("after three rounds a second look's P2 and gap become follow-ups that say they came from the second look, and the PR merges", t => {
  const f = fixture(t);
  f.commit("Close ticket", "ticket.md", '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-19)\n\nImplemented.\n');
  f.rounds(3);
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SECOND_REVIEW: minorReview });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: 2 follow-ups after 3 fix rounds \(non-blocking\)$/m);
  assert.doesNotMatch(result.stdout, /^review: \d+ follow-ups/m);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  const summary = "Second-look follow-ups (non-blocking after 3 fix rounds):\n- Spec (P2, second look): P2: Minor defect.\n- Validation gaps (gap, second look): Add coverage.";
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1);
  assert.ok(f.apiCalls().some(call => call.body?.includes(summary)));
  assert.match(readFileSync(join(f.root, "ticket.md"), "utf8"), /### Follow-ups\n\n- Spec \(P2, second look\): P2: Minor defect\.\n- Validation gaps \(gap, second look\): Add coverage\.\n/);
  assert.ok(f.ghCalls("merge")[0].args.includes(f.git("rev-parse", "HEAD")));
});

test("a saved second look of the HEAD before Claude's follow-ups commit is reused after that ticket-only commit", t => {
  const f = fixture(t);
  f.commit("Close ticket", "ticket.md", '---\ntitle: "Ticket title"\n---\n\n## Done (2026-10-19)\n\nImplemented.\n');
  f.rounds(3);
  f.saveReview(minorReview);
  const reviewed = f.git("rev-parse", "HEAD"), folder = join(f.main, ".scratch/reviews/ak-14/20261019T110000Z");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "refs.txt"), `${reviewed}\n${f.git("merge-base", "origin/dev", "HEAD")}\n`);
  writeFileSync(join(folder, "result.md"), cleanReview);
  writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model: "grok-4.7", ok: true }));
  const result = f.run(["--ticket", "ticket.md"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("rev-parse", "HEAD^"), reviewed);
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), false);
  assert.ok(f.ghCalls("comment").some(call => call.body?.startsWith(`Reused second look: ${folder}\nHEAD: ${f.git("rev-parse", "HEAD")}`)));
  assert.match(result.stdout, /RESULT: ok merged #73/);
});

// Full browser runs on a busy machine (ticket ke-88).
const specsCalls = (f: ReturnType<typeof fixture>) => f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "specs");
const spec = (name: string) => `tests/native-save/${name}.spec.ts`;

test("a spec file that fails in the full run but passes alone lets the run pass, named flaky under load and logged", t => {
  const f = fixture(t), files = [spec("a"), spec("native-mcp-menu")];
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, full: [files[1]] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const specs = specsCalls(f);
  assert.deepEqual(specs.map(call => call.args), [["specs", "--affected", "--base", "origin/dev"], ["specs", files[1]]]);
  // The full run holds the machine's full-run lock; the lone rerun also holds the quiet lock, so no kit job starts.
  assert.deepEqual(specs.map(call => [call.full, call.quiet]), [[true, false], [true, true]]);
  assert.match(specs[1].holder!, /^\d+$/);
  assert.match(result.stdout, /^specs: flaky under load: tests\/native-save\/native-mcp-menu\.spec\.ts \(failed in the full run at load \d+(\.\d+)?, passed alone\)$/m);
  assert.match(result.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: ok merged #73 [a-f0-9]{7} \(flaky under load: tests\/native-save\/native-mcp-menu\.spec\.ts\)$/);
  const log = readFileSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(log.length, 1);
  const { time, load, ...rest } = log[0];
  assert.deepEqual(rest, { project: "native-site-editor", file: files[1], test: "a test", owner: "ak-14", branch: "feature/kit-pr" });
  assert.ok(Date.now() - Date.parse(time) < 60_000, time);
  assert.equal(typeof load, "number");
  assert.match(f.body(), /^- flaky under load: tests\/native-save\/native-mcp-menu\.spec\.ts \(failed in the full run, passed alone\)$/m);
  for (const lock of ["browser-run", "quiet"]) assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, `agent-kit/${lock}.lock`)), false, lock);
});

test("a spec file that fails alone too fails the run, and nothing is logged as flaky", t => {
  const f = fixture(t), files = [spec("a"), spec("b")];
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, always: [files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev"], ["specs", files[1]]]);
  assert.match(result.stdout, /RESULT: fail specs: 1 spec file failed: tests\/native-save\/b\.spec\.ts \(failed alone too\)$/);
  assert.equal(f.ghCalls("create").length, 0);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl")), false);
  for (const lock of ["browser-run", "quiet"]) assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, `agent-kit/${lock}.lock`)), false, lock);
});

test("a spec file the change touches is never forgiven: it must pass in the full run", t => {
  const f = fixture(t, { [spec("b")]: "// changed\n" }), files = [spec("a"), spec("b")];
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, full: [files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev"]]);
  assert.match(result.stdout, /RESULT: fail specs: 1 spec file failed: tests\/native-save\/b\.spec\.ts \(this change touches it\)$/);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl")), false);
});

test("timing spec files run after the rest, each alone, while no other kit job may start", t => {
  const f = fixture(t, undefined, { timing: ["native-edit-latency", "native-boot-memory.spec.ts"] });
  const files = [spec("a"), spec("native-boot-memory"), spec("c"), spec("native-edit-latency")];
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const specs = specsCalls(f);
  assert.deepEqual(specs.map(call => call.args), [["specs", "--affected", "--base", "origin/dev", "--list"],
    ["specs", spec("a"), spec("c")], ["specs", spec("native-boot-memory")], ["specs", spec("native-edit-latency")]]);
  assert.deepEqual(specs.map(call => [call.full, call.quiet]), [[true, false], [true, false], [true, true], [true, true]]);
  const body = f.body();
  for (const line of [`- kit specs ${spec("a")} ${spec("c")}: RESULT: ok specs 2/2 passed`,
    `- kit specs ${spec("native-boot-memory")} (timing, alone): RESULT: ok specs 1/1 passed`,
    `- kit specs ${spec("native-edit-latency")} (timing, alone): RESULT: ok specs 1/1 passed`]) assert.ok(body.includes(line), `${line}\n${body}`);
  // A selection without timing files runs as before.
  const plain = fixture(t, undefined, { timing: ["native-edit-latency"] });
  const again = plain.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files: [spec("a")] }) });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(specsCalls(plain).map(call => call.args), [["specs", "--affected", "--base", "origin/dev", "--list"], ["specs", "--affected", "--base", "origin/dev"]]);
  // A timing list that is no list stops at the specs step.
  const bad = fixture(t, undefined, { timing: "native-edit-latency" });
  const refused = bad.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files }) });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /RESULT: fail specs: "timing" in scripts\/agents\/kit\.json must be a list of spec files/);
});

test("two full browser runs at once: the second waits for the first, saying whose run it waits for", t => {
  const f = fixture(t), lock = join(f.env.XDG_STATE_HOME!, "agent-kit/browser-run.lock");
  const holder = spawn("sleep", ["2"]);
  t.after(() => { holder.kill(); });
  const stat = () => readFileSync(`/proc/${holder.pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), `${holder.pid} ${stat()[19]} ke-60\n`);
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { KIT_LOCK_POLL_MS: "50", FAKE_SPECS: JSON.stringify({ files: [spec("a")] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.match(/^specs: waiting for ke-60's full browser run$/gm)?.length, 1, result.stdout);
  // spawnSync holds this test, so the ended holder is still a zombie: the run went on only after it ended.
  assert.equal(stat()[0], "Z");
  assert.equal(specsCalls(f).length, 1);
  assert.equal(existsSync(lock), false);
});
