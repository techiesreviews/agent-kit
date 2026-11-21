import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { checkSteps, classify, docsOnly, featureListGuard, focusedUnitFiles, parseChanges, visiblePath } from "../pr-tier.mjs";
import { coverageHash, saveUxResult, uxGuard, visibleFiles } from "../ux-gate.mjs";
import { sameReviewPatch } from "../review-findings.mjs";
import { forEachAwait } from "./support/await-race.ts";
import { kitEnv } from "./support/kit-env.ts";
import { tempOutsideGit } from "./support/temp-outside-git.ts";
import { onMacos, pathWithout, pathWithoutBwrap } from "./support/no-bwrap.ts";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapWorks, cleanRoomReport, resetBwrapProbe } from "../key-guard.mjs";
import { orbitProject, orbitSecretsForTests, orbitSettings, runAsync, type Run } from "./support/orbit-project.ts";
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
// Whether one of the machine's locks (kitMachineLock: flock on <state>/agent-kit/<name>.lock) is held by someone.
const held = name => existsSync(join(env.XDG_STATE_HOME, "agent-kit", name + ".lock")) &&
  require("node:child_process").spawnSync("flock", ["-n", join(env.XDG_STATE_HOME, "agent-kit", name + ".lock"), "true"]).status !== 0;
const bodyIndex = args.indexOf("--body-file");
const bodyField = args.find(arg => arg.startsWith("body=@"));
const bodyPath = bodyIndex >= 0 ? args[bodyIndex + 1] : bodyField?.slice("body=@".length);
// FAKE_FAIL_PENDING: saving the PR block that says "Verdict: pending" fails, as a gh api call that cannot be made does; the call is
// logged as failed, so a test can tell what reached the PR from what was only tried.
const failPending = tool === "gh" && env.FAKE_FAIL_PENDING && bodyPath && readFileSync(bodyPath, "utf8").includes("Verdict: pending");
// repo: the GH_REPO a call was told, when it was told one.
appendFileSync(env.FAKE_CALLS, JSON.stringify({ tool, script: process.argv[1], args, ...(failPending ? { failed: true } : {}), ...(bodyPath ? { body: readFileSync(bodyPath, "utf8") } : {}),
  ...(env.GH_REPO ? { repo: env.GH_REPO } : {}), ...(env.GH_HOST ? { host: env.GH_HOST } : {}),
  ...(tool === "fake-kit" && args[0] === "specs" ? { full: held("browser-run"), quiet: held("quiet"), holder: env.KIT_QUIET_HOLDER || "" } : {}) }) + "\\n");
const scripts = { "unit.sh": "unit", "tickets.mjs": "tickets", "check-colours.mjs": "colours" };
const action = tool === "npm" ? (args[0] === "test" ? "unit" : args[1]) : scripts[tool] || (tool === "fake-kit" ? args[0] : args.slice(0, 2).join("-"));
// FAKE_GH_SWAP: gh (which kit pr starts outside the lock) swaps kit pr's own git link in TMPDIR for another program.
if (tool === "gh" && env.FAKE_GH_SWAP) for (const name of require("node:fs").readdirSync(env.TMPDIR).filter(name => name.startsWith("kit-pr-programs-"))) {
  const link = join(env.TMPDIR, name, "git");
  require("node:fs").rmSync(link, { force: true }); require("node:fs").symlinkSync("/bin/true", link);
}
if (failPending) { console.error("api unavailable"); process.exit(1); }
// FAKE_FAIL_BODY: a gh call whose body matches this pattern fails, as a comment GitHub refuses does.
if (tool === "gh" && env.FAKE_FAIL_BODY && bodyPath && new RegExp(env.FAKE_FAIL_BODY).test(readFileSync(bodyPath, "utf8"))) { console.error("comment refused"); process.exit(1); }
if (env.FAKE_FAIL === action) {
  for (let i = 1; i <= 35; i++) console.error("failure line " + i);
  if (env.FAKE_FAIL_TEXT) console.error(env.FAKE_FAIL_TEXT);
  if (tool === "fake-kit") console.log("RESULT: fail child failure");
  process.exit(1);
}
// FAKE_SPECS plans kit specs: its files are the --affected selection; a file in "full" fails only in a run with other
// files (as one does on a busy machine), one in "always" fails every time, one in "once" only the first time it runs.
// With "crash" the run reports only its failed "full" files and says every file failed, as a run that broke part way;
// with "listBlank" --list names no files though it selected some; a lone run of a file in "silent" prints only RESULT.
if (tool === "fake-kit" && action === "specs" && env.FAKE_SPECS) {
  const plan = JSON.parse(env.FAKE_SPECS), rest = args.slice(1);
  const files = rest[0] === "--affected" ? plan.files : rest.filter(arg => !arg.startsWith("-"));
  if (rest.includes("--list")) {
    if (plan.listBlank) { console.log("RESULT: ok specs " + files.length + " selected (list only)"); process.exit(0); }
    for (const file of files) console.log(file + " [default] — changed");
    console.log("RESULT: ok specs " + files.length + " selected (list only)");
    process.exit(0);
  }
  const runs = file => readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
    .filter(call => call.tool === "fake-kit" && call.args[0] === "specs" && call.args.includes(file)).length;
  const failed = files.filter(file => (plan.always || []).includes(file) || (files.length > 1 && (plan.full || []).includes(file)) ||
    ((plan.once || []).includes(file) && runs(file) === 1));
  if (files.length === 1 && (plan.silent || []).includes(files[0])) { console.log("RESULT: ok specs 1/1 passed"); process.exit(0); }
  if (plan.crash) {
    for (const file of failed) console.log("✗ " + file + ": a test — timed out");
    console.log("RESULT: fail specs " + files.length + " of " + files.length + " failed");
    process.exit(1);
  }
  for (const file of files) console.log(failed.includes(file) ? "✗ " + file + ": a test — timed out" : "✓ " + file + " (1 passed)");
  console.log(failed.length ? "RESULT: fail specs " + failed.length + " of " + files.length + " failed" : "RESULT: ok specs " + files.length + "/" + files.length + " passed");
  process.exit(failed.length ? 1 : 0);
}
if (tool === "fake-kit") console.log("RESULT: ok " + args[0] + " done");
else if (tool === "gh") {
  if (action === "pr-list") console.log(env.FAKE_EXISTING ? '[{"number":73}]' : "[]");
  else if (action === "pr-create") console.log(env.FAKE_BAD_URL ? "no URL" : "https://github.com/test/repo/pull/73");
  else if (action === "repo-view") {
    // FAKE_REPO_ERROR: gh cannot name the repo.
    if (env.FAKE_REPO_ERROR) { console.error("repo unavailable"); process.exit(1); }
    console.log("test/repo");
  }
  else if (action === "api-graphql") {
    if (env.FAKE_QUEUE_ERROR) { console.error("queue unavailable"); process.exit(1); }
    // FAKE_QUEUE_METHOD: how the queue lands (MERGE by default); "fail" fails the lookup.
    if (args.some(arg => arg.includes("mergeMethod"))) {
      if (env.FAKE_QUEUE_METHOD === "fail") { console.error("lookup failed"); process.exit(1); }
      console.log(env.FAKE_QUEUE_METHOD ?? "MERGE"); process.exit(0);
    }
    // FAKE_QUEUE_FROM, FAKE_QUEUE_ERROR_FROM: from that queue lookup of the fixture on (the first is 1) there is a queue, or
    // the lookup fails: a queue someone turns on, or GitHub going quiet, while kit pr runs.
    const path = env.FAKE_CALLS + ".queues";
    const count = (existsSync(path) ? Number(readFileSync(path, "utf8")) : 0) + 1;
    writeFileSync(path, String(count));
    if (env.FAKE_QUEUE_ERROR_FROM && count >= Number(env.FAKE_QUEUE_ERROR_FROM)) { console.error("queue unavailable"); process.exit(1); }
    console.log(env.FAKE_QUEUE || (env.FAKE_QUEUE_FROM && count >= Number(env.FAKE_QUEUE_FROM)) ? "queue-id" : "");
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
    // FAKE_LAND_MERGE is a clone that lands the PR as GitHub's merge commit does (gh pr merge --merge): the PR's head joined
    // to the base by one new commit, which pr view names.
    if (env.FAKE_LAND_MERGE) {
      const { execFileSync } = require("node:child_process");
      const git = (...argv) => execFileSync("git", ["-C", env.FAKE_LAND_MERGE, ...argv], { encoding: "utf8", timeout: 10_000 }).trim();
      const base = env.FAKE_BASE || "dev", branch = execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim();
      git("fetch", "-q", "origin"); git("checkout", "-q", "-B", base, "origin/" + base);
      git("merge", "-q", "--no-ff", "-m", "Merge pull request #73", "origin/" + branch);
      git("push", "-q", "origin", base);
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
// kit pr's in-process steps (KIT_PR_CALLS): the review, the second look and the release check. Each call is logged as the
// kit review or kit release-check command it stands for, so the tests read them beside the fake kit's own calls.
const fakeCalls = `import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { releaseCheck as realReleaseCheck } from ${JSON.stringify(pathToFileURL(resolve("release-check.mjs")).href)};
const env = process.env, clean = ${JSON.stringify(cleanReview)};
const record = args => appendFileSync(env.FAKE_CALLS, JSON.stringify({ tool: "fake-kit", args,
  ...(env.GH_REPO ? { repo: env.GH_REPO } : {}), ...(env.GH_HOST ? { host: env.GH_HOST } : {}) }) + "\\n");
const looks = second => readFileSync(env.FAKE_CALLS, "utf8").trim().split("\\n").map(line => JSON.parse(line))
  .filter(call => call.tool === "fake-kit" && call.args[0] === "review" && call.args.includes("--second-look") === second).length;
const git = (...argv) => execFileSync("git", argv, { encoding: "utf8" }).trim();
const refs = () => git("rev-parse", "HEAD") + "\\n" + git("merge-base", "origin/" + (env.FAKE_BASE || "dev"), "HEAD") + "\\n";
const reviewArgs = flags => ["review", "--base", flags.base, "--pr", flags.pr, ...(flags.ticket ? ["--ticket", flags.ticket] : []), ...(flags.secondLook ? ["--second-look"] : [])];
// FAKE_FAIL=review: the look fails with 35 lines on stderr (and FAKE_FAIL_TEXT last).
const failed = io => {
  for (let i = 1; i <= 35; i++) io.err("failure line " + i + "\\n");
  if (env.FAKE_FAIL_TEXT) io.err(env.FAKE_FAIL_TEXT + "\\n");
  return { exit: 1, status: "fail", text: "child failure" };
};
// FAKE_RELEASE_CHECK: the real check; FAKE_RELEASE_CHECK_STDERR: the check cannot run (it throws that message).
export function releaseCheck(options) {
  record(["release-check", ...(options.land ? ["--land"] : []), ...(options.waive ? ["--waive", options.waive] : [])]);
  if (env.FAKE_RELEASE_CHECK_STDERR) throw new Error(env.FAKE_RELEASE_CHECK_STDERR);
  if (env.FAKE_RELEASE_CHECK) return realReleaseCheck(options);
  if (env.FAKE_FAIL === "release-check") return { passed: false, failure: "child failure", problems: [], warnings: [] };
  return { passed: true, summary: "done", problems: [], warnings: [] };
}
// Claude's review. FAKE_EMPTY: the diff is empty, so there is nothing to review; FAKE_REVIEW_FAIL: it fails to run (a review
// that left an id out, say); FAKE_REVIEW (FAKE_REBASED_REVIEW from the second one on) is its report, FAKE_REVIEW_MISSING leaves it out.
export async function review(flags, io) {
  record(reviewArgs(flags));
  if (env.FAKE_FAIL === "review") return failed(io);
  if (env.FAKE_EMPTY) {
    io.out("nothing to review: git diff base...HEAD is empty\\n");
    return { exit: 3, status: "skip", text: "review nothing to review (git diff base...HEAD is empty)", nothing: "git diff base...HEAD is empty" };
  }
  if (env.FAKE_REVIEW_FAIL) return { exit: 1, status: "fail", text: "review incomplete evidence none" };
  const count = looks(false), folder = join(env.KIT_MAIN_ROOT, ".scratch/reviews", env.ASE_OWNER, count === 1 ? "fresh" : "fresh-" + count);
  mkdirSync(folder, { recursive: true });
  if (!env.FAKE_REVIEW_MISSING) writeFileSync(join(folder, "result.md"), (count > 1 && env.FAKE_REBASED_REVIEW) || env.FAKE_REVIEW || clean);
  writeFileSync(join(folder, "refs.txt"), refs());
  return { exit: 0, status: "ok", text: "review git diff base...HEAD evidence " + folder, evidence: folder };
}
// The second look: FAKE_SECOND=skip has no model to take it, =fail fails; FAKE_SECOND_REVIEW (FAKE_SECOND_REBASED_REVIEW from the
// second one on) is its report, clean by default, by FAKE_SECOND_MODEL (grok-4.7).
export async function secondLook(flags, io) {
  record(reviewArgs(flags));
  const notes = [], say = line => { notes.push(line); io.out(line + "\\n"); };
  const skip = why => { say("second look: skipped (" + why + ")"); return { exit: 3, status: "skip", text: "second look (" + why + ")", skipped: "second look: skipped (" + why + ")", notes }; };
  if (env.FAKE_FAIL === "review") return { ...failed(io), notes };
  if (env.FAKE_EMPTY) return skip("nothing to review: git diff base...HEAD is empty");
  if (env.FAKE_SECOND === "fail") return { exit: 1, status: "fail", text: "second-look table broken evidence none", notes };
  if (env.FAKE_SECOND === "skip") return skip("grok-4.7 out of credit; opencode/deepseek-v4.1-flash-free out of credit");
  const count = looks(true), model = env.FAKE_SECOND_MODEL || "grok-4.7";
  const folder = join(env.KIT_MAIN_ROOT, ".scratch/reviews", env.ASE_OWNER, "second-" + count);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "result.md"), (count > 1 && env.FAKE_SECOND_REBASED_REVIEW) || env.FAKE_SECOND_REVIEW || clean);
  writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model, ok: true }));
  writeFileSync(join(folder, "refs.txt"), refs());
  say("second look: code (feature.txt) " + model);
  return { exit: 0, status: "ok", text: "review git diff base...HEAD evidence " + folder, evidence: folder, notes };
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
  writeFileSync(join(bin, "fake-calls.mjs"), fakeCalls);
  const env: NodeJS.ProcessEnv = { ...kitEnv(), PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: root, KIT_MAIN_ROOT: main,
    ASE_OWNER: "ak-14", KIT_PR_KIT: join(bin, "fake-kit"), KIT_PR_CALLS: join(bin, "fake-calls.mjs"), FAKE_CALLS: join(dir, "calls.jsonl"), CLAUDECODE: "",
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

// kit pr runs git with hooks off (TOOLS-303), so a test that needs something to happen around one git call puts a git
// of its own first on PATH (outside the worktree, where kit pr takes it): `before` and `after` run as shell commands
// around the real git when the call's subcommand is `subcommand`; a non-zero `before` stops the call with its status.
function gitAround(bin: string, subcommand: string, { before = "", after = "" }: { before?: string; after?: string }) {
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2), sub = args.find((arg, i) => !arg.startsWith("-") && args[i - 1] !== "-C" && args[i - 1] !== "-c");
const shell = command => command ? spawnSync("sh", ["-c", command], { stdio: "inherit" }).status : 0;
if (sub === ${JSON.stringify(subcommand)}) { const status = shell(${JSON.stringify(before)}); if (status) process.exit(status); }
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: "inherit" });
if (sub === ${JSON.stringify(subcommand)} && result.status === 0) shell(${JSON.stringify(after)});
process.exit(result.status ?? 1);
`); chmodSync(join(bin, "git"), 0o755);
}

test("help and argument errors, including the kit front door", t => {
  const f = fixture(t);
  for (const arg of ["--help", "-h"]) {
    const result = f.run([arg]); assert.equal(result.status, 0); assert.match(result.stdout, /Usage: kit pr/); assert.match(result.stdout, /--waive/); assert.match(result.stdout, /--sync-main/); assert.doesNotMatch(result.stdout, /RESULT:/);
  }
  for (const args of [["--wat"], ["--base"], ["--title"], ["--ticket", "--no-merge"], ["--base", "dev", "--base", "main"],
    ["--waive"], ["--waive", " "], ["--waive", "reason", "--waive", " "]]) {
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

test("a failed review, run in kit pr's process, keeps its lines and RESULT line in review.log and prints only the log tail", t => {
  const f = fixture(t), result = f.run([], { FAKE_FAIL: "review" });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail review: /);
  assert.doesNotMatch(result.stderr, /failure line 1\n/); assert.match(result.stderr, /failure line 35/);
  assert.match(readFileSync(join(f.logDir(), "review.log"), "utf8"), /failure line 1\n[\s\S]*failure line 35\n[\s\S]*RESULT: fail child failure\n$/);
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

test("a direct project (branches.direct, land and release both main) lands ordinary PRs on main and has no release step", t => {
  const direct = { ...playground, branches: { land: "main", release: "main", ci: "main", direct: true } };
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: direct, workflows: false });
  for (const args of [["--dry-run"], ["--dry-run", "--base", "main"]]) {
    const run = f.run(args, { FAKE_BASE: "main" }, true);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /RESULT: ok dry-run [a-f0-9]{7} feature\/kit-pr -> main/);
  }
  // The other gates stay: kit pr will not run on main itself, and there is no release step to run.
  f.git("checkout", "main");
  const onMain = f.run(["--dry-run"], { FAKE_BASE: "main" }, true);
  assert.equal(onMain.status, 1, onMain.stdout + onMain.stderr);
  assert.match(onMain.stdout, /RESULT: fail guards: refusing branch main/);
  f.git("checkout", "feature/kit-pr");
  const release = f.run(["--dry-run", "--release", "--base", "main"], { FAKE_BASE: "main" }, true);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  assert.match(release.stdout, /RESULT: fail guards: --release has no step in a direct project/);
  // A direct project whose land branch is not its release branch is a settings problem, not a silent split.
  const split = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: { ...direct, branches: { land: "dev", release: "main", direct: true } } });
  const refused = split.run(["--dry-run", "--base", "main"], {}, true);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /RESULT: fail guards: direct landing needs the same branch as "land" and "release"/);
});

test("a direct project's full kit pr runs the review, lands the PR on main and needs no release step", t => {
  const direct = { ...playground, branches: { land: "main", release: "main", ci: "main", direct: true } };
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: direct, workflows: false });
  const run = f.run([], { FAKE_BASE: "main" }, true);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /RESULT: ok merged #\d+ [a-f0-9]{7}/);
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "review"), "the review ran");
  assert.ok(f.calls().some(call => call.tool === "gh" && call.args.includes("--base") && call.args.includes("main")), JSON.stringify(f.calls().map(call => call.tool)));
});

test("with the playground settings and a CI workflow, pr still waits for CI and records ci: pass", t => {
  const f = fixture(t, { "src/app.js": "export const app = 1;\n" }, {}, { settings: playground });
  const result = f.run([], { FAKE_BASE: "main" }, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^ci: waiting for PR #73 checks$/m);
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args.join(" ") === "wait ci --pr 73 --timeout 60m"));
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
  assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args.join(" ") === "wait ci --pr 73 --timeout 60m"));
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
    assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args.join(" ") === "wait ci --pr 73 --timeout 60m"), waits, workflow);
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

test("a release with --no-merge opens but never waits or merges", t => {
  const f = fixture(t), result = f.run(["--base", "main", "--release", "--no-merge"]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /RESULT: ok opened #73/);
  assert.equal(f.ghCalls("merge").length, 0); assert.equal(f.calls().some(call => call.args[0] === "wait"), false);
  assert.ok(f.ghCalls("create")[0].args.includes("main"));
});

// The steps every "kit cannot join main by itself" stop names (TOOLS-325, TOOLS-341): a merge made by hand, which kit pr
// --sync-main then weighs and lands as it was made, after which main is inside dev's history, so the stop cannot come back.
const byHand = (run: "release" | "sync") => "make the merge by hand: git switch -c <name> origin/dev, git merge --no-ff origin/main (keep each change of main's that dev lacks, and dev's side wherever dev changed or removed something since), "
  + "then run kit pr --sync-main on that branch: it lands the merge as you made it, through review, the second look and CI, once the merge drops no change of main's that dev does not already hold"
  + (run === "release" ? "; then cut the release again at the new origin/dev" : "");
// A stop opens and merges no PR.
const noPr = (f: ReturnType<typeof fixture>) => assert.equal(f.calls().some(call => call.tool === "gh" && call.args[0] === "pr"), false, "no PR is opened or merged");
const resultLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1)!.replace(/\b[a-f0-9]{7}\b/g, "<sha>");
// No stop sends its reader back to the command that just stopped (the sync's cherry-pick advice is the one rerun, and it is tested).
const noRerun = (stdout: string) => assert.doesNotMatch(resultLine(stdout), /run this again|run kit pr --sync-main again|run kit pr again/);

// TOOLS-325: a release once landed on main as copied commits (a rebase merge), so dev and main split and the next release conflicted.
test("a release lands into main by itself once CI passes, as a real merge commit that keeps main inside dev's history", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_BASE: "main" }, peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD");
  const result = f.run(["--base", "main", "--release"], { ...real, FAKE_LAND_MERGE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), true, "it waits for CI first");
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes("--merge"), merges[0].args.join(" "));
  for (const flag of ["--rebase", "--squash"]) assert.equal(merges[0].args.includes(flag), false, `never ${flag}`);
  assert.equal(merges[0].args[merges[0].args.indexOf("--match-head-commit") + 1], cut, "pinned to the reviewed head");
  f.git("fetch", "-q", "origin");
  const landed = f.git("rev-parse", "origin/main");
  assert.equal(f.git("rev-parse", "origin/main^2"), cut, "main's new commit is a merge whose second parent is the cut itself");
  f.git("merge-base", "--is-ancestor", "origin/dev", "origin/main"); // dev's commits keep their SHAs on main
  assert.match(result.stdout, new RegExp(`^landed: ${landed.slice(0, 7)} merges ${cut.slice(0, 7)} into main \\(a merge commit\\)$`, "m"));
  assert.match(result.stdout, new RegExp(`RESULT: ok merged #73 ${landed.slice(0, 7)}$`, "m"));
});

test("a release cut whose main holds copies of dev's commits keeps dev's files instead of a conflict", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  // An earlier release landed on main as a copy of dev's commit (a rebase merge), so main and dev split.
  f.git("checkout", "-q", "dev"); const first = f.commit("Dev edit", "file.txt", "dev one\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", first); f.gitAt(peer, "push", "-q", "origin", "main");
  // dev changes the same line again, so a plain merge of main conflicts.
  f.commit("Dev edit again", "file.txt", "dev two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /conflict in/);
  assert.match(result.stdout, /^warning: origin\/main has 1 commit outside dev's history \([a-f0-9]{7} Dev edit\)/m, "the release check's warning is shown");
  assert.match(result.stdout, new RegExp(`^merge: origin/main's files are dev's at ${first.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("rev-parse", "HEAD^1"), cut);
  assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"), "main joins the cut by a real merge");
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "", "the cut keeps dev's files");
  assert.equal(f.git("log", "-1", "--format=%s"), "Merge origin/main into the release cut");
});

test("a release cut stops when main holds changes dev's files lack beside commits dev already holds", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); const first = f.commit("Dev edit", "file.txt", "dev one\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", first);
  writeFileSync(join(peer, "hotfix.txt"), "hotfix\n"); f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main");
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail merge: origin/main holds changes dev's files lack (<sha> Hotfix on main) beside commits dev already holds: a merge cannot tell a rollback from a hotfix there; ${byHand("release")}`);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "nothing is merged");
  noPr(f);
});

test("a rollback of a copied release on main stops both the release and the sync, never kept out", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  // dev has A and B; main took copies of both (a rebase merge), then rolled B back; dev moves on with C.
  f.git("checkout", "-q", "dev"); const a = f.commit("Change A", "a.txt"), b = f.commit("Change B", "b.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", a, b);
  f.gitAt(peer, "revert", "--no-edit", "HEAD"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  const why = `origin/main holds changes dev's files lack (<sha> Revert "Change B") beside commits dev already holds: a merge cannot tell a rollback from a hotfix there; `;
  assert.equal(resultLine(release.stdout), `RESULT: fail merge: ${why}${byHand("release")}`);
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.equal(resultLine(sync.stdout), `RESULT: fail sync: ${why}${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev"));
  // Once dev rolls B back too, its files hold main's rollback: the next cut joins main by itself and keeps the rollback.
  f.git("checkout", "-q", "dev"); f.git("revert", "--no-edit", b); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-B", "release/cut", "origin/dev");
  const again = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^merge: ok$/m);
  f.git("merge-base", "--is-ancestor", "origin/main", "HEAD");
  assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD:b.txt"], { cwd: f.root }).status === 0, false, "the rollback is in the release");
  assert.equal(f.git("show", "HEAD:c.txt"), "Change C");
});

// R10-7: GitHub's squash button makes one commit on main that is no exact copy of any dev commit.
test("a squashed release on main that dev has since changed stops the release and the sync, and the merge by hand it names lands through kit pr --sync-main", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  // dev has A and B; main took both as one squashed commit; dev then removes what A added.
  f.git("checkout", "-q", "dev"); f.commit("Change A", "x.txt"); const b = f.commit("Change B", "y.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--squash", b);
  f.gitAt(peer, "commit", "-q", "-m", "Release (squashed)"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("rm", "-q", "x.txt"); f.git("commit", "-q", "-m", "Remove what A added"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  const why = "a merge of origin/main would change x.txt, which dev changed too since dev and main were last joined, so kit cannot tell a change of origin/main's own (<sha> Release (squashed)) from a copy of work dev has since changed; ";
  assert.equal(resultLine(release.stdout), `RESULT: fail merge: ${why}${byHand("release")}`);
  noRerun(release.stdout);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "kit's own merge is taken back");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD:x.txt"], { cwd: f.root }).status === 0, false, "what dev removed is not brought back");
  noPr(f);
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.equal(resultLine(sync.stdout), `RESULT: fail sync: ${why}${byHand("sync")}`);
  noRerun(sync.stdout);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev")); assert.equal(f.git("status", "--porcelain"), "");
  // The steps the stop names, as a person follows them: the merge, without what dev already undid, lands through kit pr
  // --sync-main as a merge commit, since the squashed commit takes main's files from dev's at one commit to dev's at a later one.
  // A plain merge brings back x.txt, which dev removed: main's side drops nothing, so it goes to review like any change,
  // where that file shows in its diff against dev.
  f.git("checkout", "-q", "-B", "join-plain", "origin/dev"); f.git("merge", "-q", "--no-ff", "-m", "Join main into dev", "origin/main");
  const plain = f.run(["--sync-main", "--no-merge"]);
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, /^sync: ok \(the merge [a-f0-9]{7} joins main at [a-f0-9]{7} into dev as it was made: it changes 1 file on dev, and drops no change of main's that dev does not hold\)$/m);
  assert.equal(f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "review" && !call.args.includes("--second-look")).length, 1, "the review sees x.txt come back");
  f.git("checkout", "-q", "-B", "join-main", "origin/dev");
  f.git("merge", "-q", "--no-ff", "--no-commit", "origin/main"); f.git("rm", "-q", "-f", "x.txt"); f.git("commit", "-q", "-m", "Join main into dev");
  const joined = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_LAND_MERGE: peer });
  assert.equal(joined.status, 0, joined.stdout + joined.stderr);
  assert.match(joined.stdout, /^sync: ok \(the merge [a-f0-9]{7} joins main at [a-f0-9]{7} into dev as it was made: it changes no file, and drops no change of main's that dev does not hold\)$/m);
  f.git("fetch", "-q", "origin"); f.git("checkout", "-q", "-B", "release/cut", "origin/dev");
  const again = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^merge: ok$/m);
  assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD:x.txt"], { cwd: f.root }).status === 0, false);
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  assert.match(f.run(["--sync-main"]).stdout, /RESULT: fail sync: nothing to sync: origin\/dev already holds origin\/main$/m);
});

test("a squashed release on main whose work dev's files still hold keeps dev's files, in the release and in the sync", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Change A", "x.txt"); const b = f.commit("Change B", "y.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--squash", b);
  f.gitAt(peer, "commit", "-q", "-m", "Release (squashed)"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, new RegExp(`^merge: origin/main's files are dev's at ${b.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("rev-parse", "HEAD^1"), cut); assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"));
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
  assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"));
});

// The same for an exact copy: main took only B, and dev has since rolled B back.
test("a copy on main of work dev has since rolled back stops the release, never brought back", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Change A", "a.txt"); const b = f.commit("Change B", "b.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", b); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("rm", "-q", "b.txt"); f.git("commit", "-q", "-m", "Roll B back on dev"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail merge: origin/main holds only work dev already has, yet a merge of it would change b.txt, bringing back what dev changed since; ${byHand("release")}`);
  assert.equal(f.git("rev-parse", "HEAD"), cut); assert.equal(f.git("status", "--porcelain"), "");
});

// Two hotfixes on main for the same line: the merge holds the last one, so kit does not vouch for the first.
test("hotfixes on main that change the same lines stop the release with the join by hand", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main");
  for (const fix of ["one", "two"]) { writeFileSync(join(peer, "hotfix.txt"), `${fix}\n`); f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", `Hotfix ${fix}`); }
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail merge: a merge of origin/main would not hold <sha> Hotfix one as made there (a later commit there, or dev's own work, changes the same lines), so kit cannot tell what to keep; ${byHand("release")}`);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "kit's own merge is taken back");
});

// R11-2: a hotfix main itself undid leaves nothing to weigh; the same revert of work dev holds still stops (the tests above).
test("a hotfix on main and its revert there join by themselves, in the release and in the sync", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "file.txt"), "base\nhotfix\n");
  f.gitAt(peer, "commit", "-q", "-am", "Hotfix on main"); f.gitAt(peer, "revert", "--no-edit", "HEAD"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, /^merge: ok$/m);
  f.git("merge-base", "--is-ancestor", "origin/main", "HEAD");
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
});

// R12-4: with the pair left out, what is left on main is a copy, so the cut keeps dev's files.
test("a hotfix and its revert on main beside a copied commit keep dev's files", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); const a = f.commit("Change A", "a.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", a);
  writeFileSync(join(peer, "file.txt"), "base\nhotfix\n"); f.gitAt(peer, "commit", "-q", "-am", "Hotfix on main"); f.gitAt(peer, "revert", "--no-edit", "HEAD");
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^merge: origin/main's files are dev's at ${a.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
});

// R12-2: only an exact revert pairs up. Here the later commit differs from the hotfix's reverse by its spaces alone.
test("a later commit on main that undoes a hotfix all but its spaces is no revert of it: the run stops", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "ws.txt"), "a b\n");
  f.gitAt(peer, "add", "ws.txt"); f.gitAt(peer, "commit", "-q", "-m", "Add ws.txt"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "dev");
  writeFileSync(join(peer, "ws.txt"), "a  b\n"); f.gitAt(peer, "commit", "-q", "-am", "Hotfix one");
  writeFileSync(join(peer, "ws.txt"), "ab\n"); f.gitAt(peer, "commit", "-q", "-am", "Hotfix two"); f.gitAt(peer, "push", "-q", "origin", "main");
  // dev's files hold the second commit's result (from a commit with more in it, so no copy of either), and lack the first.
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev");
  writeFileSync(join(f.root, "ws.txt"), "ab\n"); writeFileSync(join(f.root, "more.txt"), "more\n");
  f.git("add", "ws.txt", "more.txt"); f.git("commit", "-q", "-m", "Dev's own edit"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail merge: origin/main holds changes dev's files lack (<sha> Hotfix one) beside commits dev already holds: a merge cannot tell a rollback from a hotfix there; ${byHand("release")}`);
  assert.equal(f.git("rev-parse", "HEAD"), cut);
});

// The whole class (GPT's SL-1 of reviews 13 and 15, and the sweep the lead asked for): main copied a change from dev and then
// rolled it back. git marks commits as the same change with spaces left out, and git apply only warns about a file's
// mode, so such a rollback could look like one more copy, or like a change dev's files hold, and be kept out.
type Fixture = ReturnType<typeof fixture>;
const put = (f: Fixture, file: string, content: string | Buffer) => { writeFileSync(join(f.root, file), content); f.git("add", file); };
// A submodule whose settings tell git's diffs to pass over it (ignore = all), as a project may have them.
const pointer = (f: Fixture, commit: string, root = f.root) => {
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n');
  f.gitAt(root, "add", ".gitmodules"); f.gitAt(root, "update-index", "--add", "--cacheinfo", `160000,${commit},sub`);
};
// Each kind: the change dev makes first (A), and the change (M) that main copies and then rolls back.
const rollbackKinds: [string, (f: Fixture) => void, (f: Fixture) => void][] = [
  ["indentation", f => put(f, "a.py", "def f():\n  return 1\n"), f => put(f, "a.py", "def f():\n    return 1\n")],
  ["line endings", f => put(f, "a.txt", "one\ntwo\n"), f => put(f, "a.txt", "one\r\ntwo\r\n")],
  ["a rename", f => put(f, "a.txt", "one\n"), f => { f.git("mv", "a.txt", "b.txt"); }],
  ["the case of a file's name", f => put(f, "Note.txt", "note\n"), f => { f.git("mv", "Note.txt", "note.txt"); }],
  ["a binary file", f => put(f, "logo.bin", Buffer.from([0, 1, 2, 3, 255])), f => put(f, "logo.bin", Buffer.from([0, 1, 2, 4, 255]))],
  ["a submodule's commit", f => pointer(f, "1".repeat(40)), f => pointer(f, "2".repeat(40))],
  ["an executable bit", f => put(f, "tool.txt", "tool\n"), f => { chmodSync(join(f.root, "tool.txt"), 0o755); f.git("add", "tool.txt"); }],
  // The link's target is the file's old content, so only the kind of file changes.
  ["a file turned into a link", f => put(f, "tool.txt", "file.txt"), f => { rmSync(join(f.root, "tool.txt")); symlinkSync("file.txt", join(f.root, "tool.txt")); f.git("add", "tool.txt"); }],
];
test("a rollback on main of a change it copied from dev stops the release and the sync, whatever kind of change it is", async t => {
  for (const [kind, add, change] of rollbackKinds) await t.test(kind, s => {
    const f = fixture(s), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
    // dev makes A, then M; main took copies of both, then rolled M back; dev moves on with C.
    f.git("checkout", "-q", "dev"); add(f); f.git("commit", "-q", "-m", "Change A"); const a = f.git("rev-parse", "HEAD");
    change(f); f.git("commit", "-q", "-m", "Change M"); const m = f.git("rev-parse", "HEAD"); f.git("push", "-q", "origin", "dev");
    f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", a, m);
    f.gitAt(peer, "revert", "--no-edit", "HEAD"); f.gitAt(peer, "push", "-q", "origin", "main");
    f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev"); f.git("fetch", "-q", "origin");
    assert.equal(f.git("rev-parse", "origin/main^{tree}"), f.git("rev-parse", `${a}^{tree}`), "main's files are dev's from before M");
    const files = f.git("ls-files", "-s");
    // The repository's own settings may tell git apply to mend or pass over spaces, and git's diffs to pass over submodules:
    // the weighing counts them all the same.
    f.git("config", "apply.whitespace", "fix"); f.git("config", "apply.ignoreWhitespace", "change"); f.git("config", "diff.ignoreSubmodules", "all");
    f.git("checkout", "-q", "-b", "release/cut");
    const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
    assert.equal(release.status, 1, release.stdout + release.stderr);
    const why = `origin/main holds changes dev's files lack (<sha> Revert "Change M") beside commits dev already holds: a merge cannot tell a rollback from a hotfix there; `;
    assert.equal(resultLine(release.stdout), `RESULT: fail merge: ${why}${byHand("release")}`);
    assert.equal(f.git("rev-parse", "HEAD"), cut, "no merge that keeps M is made");
    f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
    const sync = f.run(["--sync-main"]);
    assert.equal(sync.status, 1, sync.stdout + sync.stderr);
    assert.equal(resultLine(sync.stdout), `RESULT: fail sync: ${why}${byHand("sync")}`);
    assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev")); assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(f.git("ls-files", "-s"), files, "the branch keeps its files, their modes and kinds");
    noPr(f);
  });
});

// Review 18 (GPT): a submodule set to ignore = all, or diff.ignoreSubmodules, hides its changes from git's diffs.
test("a submodule's new commit on main that dev lacks is a file change the sync refuses, though git's diffs are set to pass over submodules", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  // The submodule is released by a merge, then main moves it to another commit.
  f.gitAt(peer, "checkout", "-q", "dev"); pointer(f, "1".repeat(40), peer); f.gitAt(peer, "commit", "-q", "-m", "Add the submodule"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "dev");
  pointer(f, "2".repeat(40), peer); f.gitAt(peer, "commit", "-q", "-m", "Move the submodule on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  const moved = f.gitAt(peer, "rev-parse", "--short", "HEAD");
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("config", "diff.ignoreSubmodules", "all");
  f.git("checkout", "-q", "-b", "sync/main");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.equal(sync.stdout.trimEnd().split("\n").at(-1), `RESULT: fail sync: the sync would change sub on dev: main holds changes dev lacks; land them on dev first (git cherry-pick ${moved} on a new branch cut at origin/dev, then an ordinary kit pr), and run kit pr --sync-main again once dev holds them, or ${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev"));
  assert.match(f.git("ls-files", "-s", "sub"), /^160000 1{40} /, "dev's submodule stays where it was");
  noPr(f);
  // The release carries main's change, as it does a hotfix.
  f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "HEAD:dev"); f.git("checkout", "-q", "-B", "release/cut", "origin/dev");
  const release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(f.git("ls-files", "-s", "sub"), /^160000 2{40} /, "the submodule's commit from main is in the cut");
});

// A rollback made inside a merge commit: no commit of main's own shows it, yet main's files are dev's from before B.
test("a merge on main that rolls a copied commit back itself stops the release and the sync", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); const a = f.commit("Change A", "a.txt"), b = f.commit("Change B", "b.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", a, b);
  f.gitAt(peer, "merge", "-q", "--no-ff", "--no-commit", a); f.gitAt(peer, "rm", "-q", "b.txt"); f.gitAt(peer, "commit", "-q", "-m", "Merge with B rolled back");
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  const why = "origin/main holds a merge that changes files itself (<sha> Merge with B rolled back) beside commits dev already holds: kit cannot see what that merge rolled back; ";
  assert.equal(resultLine(release.stdout), `RESULT: fail merge: ${why}${byHand("release")}`);
  assert.equal(f.git("rev-parse", "HEAD"), cut);
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.equal(resultLine(sync.stdout), `RESULT: fail sync: ${why}${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev")); assert.equal(f.git("show", "HEAD:b.txt"), "Change B");
  noPr(f);
});

// The stricter copy rule still knows a copy: the same changes, copied as they are, whatever kind they are.
test("exact copies on main of a binary file, CRLF lines, a mode and a link still count as copies: the cut keeps dev's files", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev");
  const copied: string[] = [];
  const land = (subject: string, change: () => void) => { change(); f.git("commit", "-q", "-m", subject); copied.push(f.git("rev-parse", "HEAD")); };
  land("Add a binary file", () => put(f, "logo.bin", Buffer.from([0, 1, 2, 3, 255])));
  land("Change the binary file", () => put(f, "logo.bin", Buffer.from([0, 1, 2, 4, 255])));
  land("Add CRLF lines", () => put(f, "win.txt", "one\r\ntwo\r\n"));
  land("Make file.txt run", () => { chmodSync(join(f.root, "file.txt"), 0o755); f.git("add", "file.txt"); });
  land("Add a link", () => { symlinkSync("file.txt", join(f.root, "link.txt")); f.git("add", "link.txt"); });
  f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", ...copied); f.gitAt(peer, "push", "-q", "origin", "main");
  // dev changes each of them again, so none of the copies is in dev's files as it was made, and a plain merge would conflict.
  put(f, "logo.bin", Buffer.from([9, 9, 9])); put(f, "win.txt", "one\r\nthree\r\n");
  chmodSync(join(f.root, "file.txt"), 0o644); f.git("add", "file.txt");
  rmSync(join(f.root, "link.txt")); symlinkSync("ticket.md", join(f.root, "link.txt")); f.git("add", "link.txt");
  f.git("commit", "-q", "-m", "Dev moves on"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^merge: origin/main's files are dev's at ${copied.at(-1)!.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
});

// An empty commit rolls nothing back, and a copy that is one exactly still counts: the cut keeps dev's files.
test("an empty commit on main beside an exact copy keeps dev's files", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); const first = f.commit("Dev edit", "file.txt", "dev one\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", first);
  f.gitAt(peer, "commit", "-q", "--allow-empty", "-m", "Empty on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Dev edit again", "file.txt", "dev two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^merge: origin/main's files are dev's at ${first.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
});

// Only a mode the commit itself changes is compared: here main's squash of two dev commits (so no exact copy of either)
// edits file.txt, and dev makes that file executable later.
test("a squashed edit on main of a file dev later made executable keeps dev's files, in the release and in the sync", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Change A", "a.txt"); const edit = f.commit("Edit file.txt", "file.txt", "edited\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--squash", edit);
  f.gitAt(peer, "commit", "-q", "-m", "Release (squashed)"); f.gitAt(peer, "push", "-q", "origin", "main");
  chmodSync(join(f.root, "file.txt"), 0o755); f.git("add", "file.txt"); f.git("commit", "-q", "-m", "Make file.txt run");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, new RegExp(`^merge: origin/main's files are dev's at ${edit.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
  assert.equal(f.git("ls-files", "-s", "file.txt").split(" ")[0], "100755");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
});

// A copy of a mode change that dev still holds is held, so the cut keeps dev's files as for any copy.
test("a mode change main copied from dev, with nothing rolled back, keeps dev's files", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); chmodSync(join(f.root, "file.txt"), 0o755); f.git("add", "file.txt"); f.git("commit", "-q", "-m", "Make file.txt run");
  const m = f.git("rev-parse", "HEAD"); f.git("push", "-q", "origin", "dev");
  // main takes it by a squash, which is no exact copy: its change is weighed against dev's files, modes too.
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--squash", m);
  f.gitAt(peer, "commit", "-q", "-m", "Release (squashed)"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^merge: origin/main's files are dev's at ${m.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
});

// SL-1 of review 12 (GPT): a queue on dev that squashes or rebases would flatten the join made by hand.
test("the merge by hand reads no merge queue, and kit pr --sync-main stops before the push when dev's queue would flatten that merge", t => {
  for (const queue of [{}, { FAKE_QUEUE: "1", FAKE_QUEUE_METHOD: "SQUASH" }, { FAKE_QUEUE_ERROR: "1" }] as NodeJS.ProcessEnv[]) {
    const f = fixture(t), peer = f.peer();
    f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "file.txt"), "hotfix\n");
    f.gitAt(peer, "commit", "-q", "-am", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
    f.git("checkout", "-q", "dev"); f.commit("Dev edit of the same line", "file.txt", "dev\n"); f.git("push", "-q", "origin", "dev");
    f.git("checkout", "-q", "-b", "release/cut");
    const release = f.run(["--base", "main", "--release"], { ...queue, FAKE_RELEASE_CHECK: resolve("kit.d/release-check") });
    assert.equal(release.status, 1, release.stdout + release.stderr);
    assert.equal(resultLine(release.stdout), `RESULT: fail merge: conflict in file.txt: kit cannot join origin/main by itself; ${byHand("release")}`);
    f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
    const sync = f.run(["--sync-main"], queue);
    assert.equal(sync.status, 1, sync.stdout + sync.stderr);
    assert.equal(resultLine(sync.stdout), `RESULT: fail sync: conflict in file.txt: kit cannot join origin/main by itself; ${byHand("sync")}`);
    noPr(f);
    assert.equal(f.calls().some(call => call.tool === "gh" && call.args[0] === "api"), false, "the steps read no queue");
    // The merge by hand keeps main's hotfix; its sync reads dev's queue before anything is pushed, like any sync.
    assert.notEqual(spawnSync("git", ["merge", "-q", "--no-ff", "origin/main"], { cwd: f.root, env: f.env }).status, 0);
    f.git("checkout", "--theirs", "file.txt"); f.git("add", "file.txt"); f.git("commit", "-q", "-m", "Join main into dev");
    const made = f.run(["--sync-main"], queue);
    if (!queue.FAKE_QUEUE && !queue.FAKE_QUEUE_ERROR) { assert.equal(made.status, 0, made.stdout + made.stderr); continue; }
    assert.equal(made.status, 1, made.stdout + made.stderr);
    assert.equal(resultLine(made.stdout), queue.FAKE_QUEUE_ERROR
      ? "RESULT: fail merge: could not read whether dev has a merge queue, and a sync must land as a merge commit: run kit pr again once GitHub answers"
      : "RESULT: fail merge: the merge queue on dev lands by squash, and a sync must land as a merge commit: set the queue to merge commits, then run kit pr again");
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", "refs/heads/sync/main"], { cwd: f.origin }).status === 0, false, "nothing is pushed");
  }
});

// SL-1 for a squash: the squashed commit's work is in dev's files, the rollback beside it is not, and no merge keeps it.
test("a rollback beside a squashed release on main stops the release and the sync, never kept out", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Change A", "x.txt"); const b = f.commit("Change B", "y.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--squash", b);
  f.gitAt(peer, "commit", "-q", "-m", "Release (squashed)"); f.gitAt(peer, "rm", "-q", "y.txt"); f.gitAt(peer, "commit", "-q", "-m", "Roll B back");
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "c.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  const why = "origin/main holds changes dev's files lack (<sha> Roll B back) beside commits dev already holds: a merge cannot tell a rollback from a hotfix there; ";
  assert.equal(resultLine(release.stdout), `RESULT: fail merge: ${why}${byHand("release")}`);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "no merge that keeps y.txt is made");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.equal(resultLine(sync.stdout), `RESULT: fail sync: ${why}${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev"));
});

// R10-8: a hotfix made on main reaches dev as another patch (inside a larger commit, or with its conflicts fixed).
const lines = (changes: Record<number, string> = {}) => Array.from({ length: 12 }, (_, at) => changes[at + 1] ?? `line ${at + 1}`).join("\n") + "\n";
function hotfixed(f: ReturnType<typeof fixture>) {
  const peer = f.peer();
  // hot.txt is released by a merge, then main fixes its line 6.
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "hot.txt"), lines());
  f.gitAt(peer, "add", "hot.txt"); f.gitAt(peer, "commit", "-q", "-m", "Add hot.txt"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "dev");
  writeFileSync(join(peer, "hot.txt"), lines({ 6: "fixed" })); f.gitAt(peer, "commit", "-q", "-am", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev");
  return peer;
}

test("a hotfix on main that dev took inside another commit joins by itself: its change is in dev's files", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") };
  hotfixed(f);
  // dev's commit carries the fix beside other work, so it is no exact copy of main's commit.
  f.commit("Dev moves on", "hot.txt", lines({ 1: "dev" }));
  writeFileSync(join(f.root, "hot.txt"), lines({ 1: "dev", 6: "fixed" })); writeFileSync(join(f.root, "more.txt"), "more\n");
  f.git("add", "hot.txt", "more.txt"); f.git("commit", "-q", "-m", "Take the hotfix with more work"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 0, release.stdout + release.stderr);
  assert.match(release.stdout, /^merge: ok$/m);
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "", "main holds nothing dev lacks");
  f.git("merge-base", "--is-ancestor", "origin/main", "HEAD");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
});

test("a hotfix on main that dev took with other lines around it stops with the merge by hand, and a merge that keeps dev's lines is refused", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = hotfixed(f);
  // dev changed the line above before taking the fix, so main's commit no longer applies to dev's files either way.
  f.commit("Dev moves on", "hot.txt", lines({ 5: "dev" })); f.commit("Take the hotfix", "hot.txt", lines({ 5: "dev", 6: "fixed" })); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), release = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(release.status, 1, release.stdout + release.stderr);
  assert.equal(resultLine(release.stdout), `RESULT: fail merge: conflict in hot.txt: kit cannot join origin/main by itself; ${byHand("release")}`);
  noRerun(release.stdout);
  assert.equal(f.git("rev-parse", "HEAD"), cut); assert.equal(f.git("status", "--porcelain"), "");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.equal(resultLine(sync.stdout), `RESULT: fail sync: conflict in hot.txt: kit cannot join origin/main by itself; ${byHand("sync")}`);
  noRerun(sync.stdout);
  // A merge by hand that keeps dev's lines: main's hotfix no longer applies to its files with its context, so kit cannot
  // prove the merge holds it, and refuses it rather than vouch for it.
  assert.notEqual(spawnSync("git", ["merge", "-q", "--no-ff", "origin/main"], { cwd: f.root, env: f.env }).status, 0, "the merge conflicts, as kit said");
  f.git("checkout", "--ours", "hot.txt"); f.git("add", "hot.txt"); f.git("commit", "-q", "-m", "Join main into dev");
  const made = f.run(["--sync-main"]);
  assert.equal(made.status, 1, made.stdout + made.stderr);
  assert.equal(resultLine(made.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Hotfix on main), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
});

// R9-5: the cut-off "since the last join" from the side that keeps dev's files.
test("a copy main took after an earlier join keeps dev's files at the copied commit", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev");
  const b = f.commit("Change B", "file.txt", "b one\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", b); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Change C", "file.txt", "b two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^merge: origin/main's files are dev's at ${b.slice(0, 7)}, so the cut keeps dev's files$`, "m"));
  assert.equal(f.git("diff", "--name-only", cut, "HEAD"), "");
});

// A proper release in a peer clone: a change lands on dev, and main takes it by a merge commit dev does not hold.
function release(f: ReturnType<typeof fixture>) {
  const peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "released.txt"), "released\n");
  f.gitAt(peer, "add", "released.txt"); f.gitAt(peer, "commit", "-q", "-m", "Released change"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "dev"); f.gitAt(peer, "push", "-q", "origin", "main");
  return peer;
}

test("a rollback made on main reaches the release cut, and a sync refuses it, never kept out as dev's files", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  // A change is released by a merge, then rolled back on main (git revert -m 1), so main's files are dev's files from before it.
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "risky.txt"), "risky\n");
  f.gitAt(peer, "add", "risky.txt"); f.gitAt(peer, "commit", "-q", "-m", "Risky change"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "dev");
  f.gitAt(peer, "revert", "--no-edit", "-m", "1", "HEAD"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /keeps dev's files/);
  assert.equal(spawnSync("git", ["cat-file", "-e", "HEAD:risky.txt"], { cwd: f.root }).status === 0, false, "the rollback is in the release");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const sync = f.run(["--sync-main"]);
  assert.equal(sync.status, 1, sync.stdout + sync.stderr);
  assert.match(sync.stdout, /^RESULT: fail sync: the sync would change risky\.txt on dev: main holds changes dev lacks; /m);
  // A merge by hand that keeps risky.txt leaves the rollback out: main's files go back to dev's at an older commit, which is
  // no range copy of dev's history, so it is refused.
  f.git("fetch", "-q", "origin"); f.git("merge", "-q", "-s", "ours", "-m", "Hand-made sync", "origin/main");
  const made = f.run(["--sync-main"]);
  assert.equal(made.status, 1, made.stdout + made.stderr);
  assert.equal(resultLine(made.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Revert "Release"), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
});

test("kit pr --sync-main lands a merge of main into dev that changes nothing, as a real merge commit", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); const first = f.commit("Dev edit", "file.txt", "dev one\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", first); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Dev edit again", "file.txt", "dev two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  const dev = f.git("rev-parse", "origin/dev"), main = f.git("rev-parse", "origin/main");
  const result = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_LAND_MERGE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
  assert.doesNotMatch(result.stdout, /^rebase: ok$/m, "a sync is never rebased");
  const head = f.git("rev-parse", "HEAD");
  assert.equal(f.git("rev-parse", "HEAD^1"), dev); assert.equal(f.git("rev-parse", "HEAD^2"), main);
  assert.equal(f.git("diff", "--name-only", dev, head), "");
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes("--merge"), merges[0].args.join(" "));
  assert.equal(merges[0].args.includes("--rebase"), false);
  f.git("fetch", "-q", "origin");
  f.git("merge-base", "--is-ancestor", main, "origin/dev"); // main is in dev's history now
  f.git("merge-base", "--is-ancestor", head, "origin/dev");
  assert.match(result.stdout, /RESULT: ok merged #73 [a-f0-9]{7}$/m);
});

test("a kit pr --sync-main PR says it joins main into dev and changes no file, and lists no joined commit subject (TOOLS-380)", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); const first = f.commit("Dev edit", "file.txt", "dev one\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", first); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Dev edit again", "file.txt", "dev two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  const result = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1", FAKE_LAND_MERGE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const body = f.body();
  assert.match(body, /^## Summary\n\nThis joins origin\/main into dev and changes no file on dev\. It adds no new work: the 1 commit it joins is already in dev's files\.\n/m);
  // The joined old commit and kit's own merge are no new work: neither is listed as a Summary line.
  assert.doesNotMatch(body, /^- Dev edit$/m);
  assert.doesNotMatch(body, /Merge origin\/main into dev \(sync, no file changes\)/);
  assert.match(body, /## Tests/);
});

test("a kit pr --sync-main PR counts several joined commits in the plural (TOOLS-380)", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); const one = f.commit("Dev edit", "file.txt", "dev one\n"); const two = f.commit("Dev edit two", "file.txt", "dev two\n");
  f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main");
  f.gitAt(peer, "cherry-pick", one); f.gitAt(peer, "cherry-pick", two); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Dev edit three", "file.txt", "dev three\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  const result = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1", FAKE_LAND_MERGE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(f.body(), /^## Summary\n\nThis joins origin\/main into dev and changes no file on dev\. It adds no new work: the 2 commits it joins are already in dev's files\.\n/m);
  assert.doesNotMatch(f.body(), /^- Dev edit/m);
});

test("kit pr --sync-main refuses a sync that would change dev, and leaves the branch at origin/dev", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const hotfix = f.git("rev-parse", "--short", "origin/main");
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail sync: the sync would change hotfix.txt on dev: main holds changes dev lacks; land them on dev first (git cherry-pick ${hotfix} on a new branch cut at origin/dev, then an ordinary kit pr), and run kit pr --sync-main again once dev holds them, or ${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.calls().some(call => call.tool === "gh"), false, "nothing is pushed or opened");
  // The advice as followed: the cherry-pick lands on dev (an ordinary kit pr rebases it there), and the rerun joins main.
  f.git("checkout", "-q", "dev"); f.commit("Later on dev", "later.txt"); f.git("cherry-pick", hotfix); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-B", "sync/main", "origin/dev");
  const again = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
});

// R11-5: nothing to cherry-pick when the change sits in a merge commit on main, so the sync names the join by hand.
test("kit pr --sync-main names the merge by hand when a merge on main changes files itself, and weighs that merge's own change", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "--no-commit", "origin/dev");
  writeFileSync(join(peer, "hotfix.txt"), "hotfix\n"); f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Release with a hotfix inside");
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "-b", "sync/main");
  const result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail sync: the sync would change hotfix.txt on dev: main holds changes dev lacks; ${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev")); assert.equal(f.git("status", "--porcelain"), "");
  noPr(f);
  // A merge by hand that leaves the merge's own change out is refused; one that holds it opens its PR for review.
  f.git("fetch", "-q", "origin"); f.git("merge", "-q", "-s", "ours", "-m", "Hand-made sync", "origin/main");
  const dropping = f.run(["--sync-main"]);
  assert.equal(dropping.status, 1, dropping.stdout + dropping.stderr);
  assert.equal(resultLine(dropping.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Release with a hotfix inside (a merge that changes files itself)), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
  f.git("reset", "-q", "--hard", "origin/dev"); f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  const holding = f.run(["--sync-main", "--no-merge"]);
  assert.equal(holding.status, 0, holding.stdout + holding.stderr);
  assert.match(holding.stdout, /^sync: ok \(the merge [a-f0-9]{7} joins main at [a-f0-9]{7} into dev as it was made: it changes 1 file on dev, and drops no change of main's that dev does not hold\)$/m);
  assert.match(holding.stdout, /RESULT: ok opened #73 /);
});

// R9-3: a sync whose merge really conflicts.
test("kit pr --sync-main stops on a real conflict with the join by hand, and leaves the branch at origin/dev", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "file.txt"), "hotfix\n");
  f.gitAt(peer, "commit", "-q", "-am", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Dev edit of the same line", "file.txt", "dev\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main");
  const result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail sync: conflict in file.txt: kit cannot join origin/main by itself; ${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("status", "--porcelain"), "", "the merge was aborted");
  noPr(f);
});

// R9-1, R9-2: a sync through a merge queue that makes merge commits, and a sync's dry run.
test("kit pr --sync-main goes into a merge queue with --auto --merge, and its dry run names the merge commit", t => {
  const f = fixture(t);
  release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const plan = f.run(["--sync-main", "--dry-run"], { FAKE_EMPTY: "1" });
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /^merge: the real run lands it once CI passes, as a merge commit pinned to the pushed head \(never --rebase\)$/m);
  assert.doesNotMatch(plan.stdout, /^gh pr merge N --rebase/m);
  assert.equal(f.calls().some(call => call.tool === "gh" && call.args[0] === "pr"), false, "a dry run opens nothing");
  const queued = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_QUEUE: "1" });
  assert.equal(queued.status, 0, queued.stdout + queued.stderr);
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes("--auto") && merges[0].args.includes("--merge"), merges[0].args.join(" "));
  assert.equal(merges[0].args.includes("--rebase"), false);
  assert.match(queued.stdout, /RESULT: ok queued #73 [a-f0-9]{7}/m);
});

test("kit pr --sync-main guards: not with --release, not without a separate release branch, nothing to sync, a branch with work of its own", t => {
  const f = fixture(t);
  const both = f.run(["--sync-main", "--release"]);
  assert.equal(both.status, 2); assert.match(both.stdout, /RESULT: fail invalid arguments: --sync-main has no use with --release/);
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const nothing = f.run(["--sync-main"]);
  assert.equal(nothing.status, 1); assert.match(nothing.stdout, /RESULT: fail sync: nothing to sync: origin\/dev already holds origin\/main$/m);
  release(f);
  f.commit("Own work", "own.txt");
  const own = f.run(["--sync-main"]);
  assert.equal(own.status, 1);
  assert.match(own.stdout, /RESULT: fail sync: a sync branch holds only the merge of origin\/main, and this one has work of its own: cut a new branch at origin\/dev \(git switch -c <name> origin\/dev\) and run kit pr --sync-main there$/m);
  assert.equal(f.git("log", "-1", "--format=%s"), "Own work", "the builder's own commit stays");
  const base = f.run(["--sync-main", "--base", "main"]);
  assert.equal(base.status, 1); assert.match(base.stdout, /RESULT: fail guards: --sync-main lands on dev, not main$/m);
  const one = fixture(t, undefined, { branches: { land: "main", release: "main", ci: "main" } });
  const refused = one.run(["--sync-main"], { FAKE_BASE: "main" });
  assert.equal(refused.status, 1); assert.match(refused.stdout, /RESULT: fail guards: --sync-main needs a release branch apart from the land branch/);
});

test("kit pr --sync-main makes its merge again on a rerun: the same commit on the same dev and main, a new one after dev moved", t => {
  const f = fixture(t), peer = release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const first = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  // dev has not moved since the release, so main already holds it: the sync is still its own merge commit, never a fast-forward.
  assert.equal(f.git("rev-parse", "HEAD^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"));
  const head = f.git("rev-parse", "HEAD");
  const again = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1", FAKE_EXISTING: "1" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), head, "the same dev and main make the same sync commit");
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "later.txt"), "later\n");
  f.gitAt(peer, "add", "later.txt"); f.gitAt(peer, "commit", "-q", "-m", "Later on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const moved = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1", FAKE_EXISTING: "1" });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.equal(f.git("rev-parse", "HEAD^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"));
  assert.equal(f.gitAt(f.origin, "rev-parse", "sync/main"), f.git("rev-parse", "HEAD"), "the remade sync replaced kit's own earlier push");
});

test("kit pr --sync-main weighs a hand-made merge that keeps dev's files over a hotfix on main as it was made, and refuses it", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "-s", "ours", "-m", "Hand-made sync", "origin/main");
  const merge = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // Kit's own merge would change hotfix.txt, so the hand-made one is weighed, and it leaves the hotfix out.
  assert.equal(resultLine(result.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Hotfix on main), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
  assert.equal(f.git("rev-parse", "HEAD"), merge, "the hand-made merge stays");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("kit pr --sync-main takes a fresh branch at origin/dev when dev ends in a merge of its own that main already released", t => {
  const f = fixture(t), peer = f.peer();
  // dev lands a side branch by a merge commit (its files differ from its first parent's), and main releases it by a merge.
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "side"); f.commit("Side work", "side.txt");
  f.git("checkout", "-q", "dev"); f.commit("Dev work", "dev.txt");
  f.git("merge", "-q", "--no-ff", "-m", "Merge side into dev", "side"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main");
  f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "origin/dev"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  const result = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("rev-parse", "HEAD^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"));
  assert.equal(f.git("diff", "--name-only", "origin/dev", "HEAD"), "");
});

// TOOLS-341: the join kit cannot make lands through kit pr, as it was made, never by hand outside it.
test("kit pr --sync-main lands a hand-made merge that changes dev's files as it was made, through review, the second look and CI, as a merge commit", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "--no-ff", "--no-commit", "origin/main"); writeFileSync(join(f.root, "file.txt"), "fixed by hand\n"); f.git("add", "file.txt");
  f.git("commit", "-q", "-m", "Hand-made sync with a fix");
  const merge = f.git("rev-parse", "HEAD"), main = f.git("rev-parse", "origin/main"), result = f.run(["--sync-main"], { FAKE_LAND_MERGE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^sync: ok \\(the merge ${merge.slice(0, 7)} joins main at ${main.slice(0, 7)} into dev as it was made: it changes 2 files on dev, and drops no change of main's that dev does not hold\\)$`, "m"));
  assert.equal(f.git("rev-parse", "HEAD"), merge, "the merge is landed as it was made, never made again");
  const reviews = f.calls().filter(call => call.tool === "fake-kit" && call.args[0] === "review");
  assert.equal(reviews.filter(call => !call.args.includes("--second-look")).length, 1, "Claude's review");
  assert.equal(reviews.filter(call => call.args.includes("--second-look")).length, 1, "the second look");
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), true, "it waits for CI");
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes("--merge")); for (const flag of ["--rebase", "--squash"]) assert.equal(merges[0].args.includes(flag), false);
  assert.equal(merges[0].args[merges[0].args.indexOf("--match-head-commit") + 1], merge, "pinned to the reviewed merge");
  f.git("fetch", "-q", "origin");
  assert.equal(f.git("rev-parse", "origin/dev^2"), merge, "dev takes the merge by a merge commit");
  f.git("merge-base", "--is-ancestor", "origin/main", "origin/dev");
  assert.match(result.stdout, new RegExp(`^landed: [a-f0-9]{7} merges ${merge.slice(0, 7)} into dev \\(a merge commit\\)$`, "m"));
});

// TOOLS-352 (#129 SL-1): a sync opened with --ticket on a tracked ticket and --no-merge gets kit's own follow-ups commit on
// top of its merge; the rerun takes that commit as kit's, never as work of its own, and lands the join with it.
const gapReview = cleanReview.replace("Validation gaps: none.", "Validation gaps: Add coverage.");
const kitNote = ["-m", "docs: ticket follow-ups from review", "-m", "Co-Authored-By: Agent Kit <noreply@openai.com>"];
test("kit pr --sync-main lands a hand-made merge on a rerun with kit's own follow-ups commit from a --no-merge run on top (TOOLS-352)", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  const merge = f.git("rev-parse", "HEAD");
  const first = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const note = f.git("rev-parse", "HEAD");
  assert.equal(f.git("rev-parse", "HEAD^"), merge);
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.equal(f.git("diff", "--name-only", merge, note), "ticket.md");
  const again = f.run(["--sync-main", "--ticket", "ticket.md"], { FAKE_REVIEW: gapReview, FAKE_EXISTING: "1", FAKE_LAND_MERGE: peer });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.doesNotMatch(again.stdout, /work of its own/);
  assert.match(again.stdout, /^sync: ok \(the merge [a-f0-9]{7} joins main at [a-f0-9]{7} into dev as it was made: it changes 1 file on dev, and drops no change of main's that dev does not hold\)$/m);
  assert.match(again.stdout, new RegExp(`^sync: kit's own follow-ups commit ${note.slice(0, 7)} from an earlier run stays on the merge$`, "m"));
  assert.equal(f.git("rev-parse", "HEAD"), note, "kit's follow-ups commit stays as it was, on the merge as it was made");
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].args[merges[0].args.indexOf("--match-head-commit") + 1], note);
  f.git("fetch", "-q", "origin");
  assert.equal(f.git("rev-parse", "origin/dev^2"), note, "dev takes the join by a merge commit");
  f.git("merge-base", "--is-ancestor", "origin/main", "origin/dev");
  assert.match(again.stdout, /RESULT: ok merged #73 [a-f0-9]{7}$/m);
  // TOOLS-380: a merge that changes a file says so and counts what it joins; kit's follow-ups commit (ticket.md) is no part of the join.
  assert.match(f.body(), /^## Summary\n\nThis joins origin\/main into dev and changes 1 file on dev: hotfix\.txt\. It joins 1 commit of main\.\n/m);
  assert.doesNotMatch(f.body().split("## Tests")[0].split("## Summary")[1], /ticket\.md/);
  assert.doesNotMatch(f.body(), /^- Hotfix on main$/m);
});

test("kit pr --sync-main makes its merge again under kit's own follow-ups commit: the same commits on the same dev and main, the note put on a new merge after dev moved (TOOLS-352)", t => {
  const f = fixture(t), peer = release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const first = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const note = f.git("rev-parse", "HEAD"), merge = f.git("rev-parse", "HEAD^"), ticket = readFileSync(join(f.root, "ticket.md"), "utf8");
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.equal(f.git("rev-parse", "HEAD^^2"), f.git("rev-parse", "origin/main"));
  const again = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview, FAKE_EXISTING: "1" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^sync: ok \(origin\/main joins dev, no file changes\)$/m);
  assert.equal(f.git("rev-parse", "HEAD"), note, "the same dev and main make the same merge, and kit's note stays on it");
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "later.txt"), "later\n");
  f.gitAt(peer, "add", "later.txt"); f.gitAt(peer, "commit", "-q", "-m", "Later on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const moved = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview, FAKE_EXISTING: "1" });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout, /^sync: kit's own follow-ups commit [a-f0-9]{7} from an earlier run is put back on the merge made again$/m);
  assert.notEqual(f.git("rev-parse", "HEAD^"), merge);
  assert.equal(f.git("rev-parse", "HEAD^^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^^2"), f.git("rev-parse", "origin/main"));
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.equal(f.git("diff", "--name-only", "HEAD^", "HEAD"), "ticket.md");
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), ticket, "the note is the same, written once");
  assert.equal(f.gitAt(f.origin, "rev-parse", "sync/main"), f.git("rev-parse", "HEAD"));
});

test("kit pr --sync-main leaves out kit's own follow-ups commit that no longer applies on the merge made again, and writes the follow-ups again (TOOLS-352)", t => {
  const f = fixture(t), peer = release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const first = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const note = f.git("rev-parse", "HEAD");
  // dev rewrites the ticket's last line, so kit's note no longer applies on the newest dev.
  f.gitAt(peer, "checkout", "-q", "dev"); f.gitAt(peer, "pull", "-q", "--ff-only", "origin", "dev");
  writeFileSync(join(peer, "ticket.md"), '---\ntitle: "Ticket title"\n---\n\nTask, edited on dev\n');
  f.gitAt(peer, "commit", "-q", "-am", "Ticket edit on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const moved = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview, FAKE_EXISTING: "1" });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout, new RegExp(`^sync: kit's own follow-ups commit ${note.slice(0, 7)} from an earlier run no longer applies on the merge made again, so it is left out; the PR's comments hold its follow-ups$`, "m"));
  assert.equal(f.git("rev-parse", "HEAD^^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^^2"), f.git("rev-parse", "origin/main"));
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review", "this run's review writes its follow-ups again");
  assert.match(readFileSync(join(f.root, "ticket.md"), "utf8"), /Task, edited on dev\n[\s\S]*### Follow-ups\n\n- Validation gaps \(gap\): Add coverage\./);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("kit pr --sync-main puts kit's own follow-ups commit back on the merge when the sync stops, so the branch stays as it was (TOOLS-352)", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  const first = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const note = f.git("rev-parse", "HEAD");
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "later.txt"), "later\n");
  f.gitAt(peer, "add", "later.txt"); f.gitAt(peer, "commit", "-q", "-m", "Later on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const again = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview, FAKE_EXISTING: "1" });
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.equal(resultLine(again.stdout), "RESULT: fail sync: this branch's merge <sha> was made on an older dev: make it again on origin/dev (git switch -c <name> origin/dev, git merge --no-ff origin/main) and run kit pr --sync-main there");
  assert.equal(f.git("rev-parse", "HEAD"), note, "kit's note is back on the merge");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("kit pr --sync-main puts kit's own follow-ups commits back one by one on the merge made again, leaving out only one with nothing left to add (TOOLS-352)", t => {
  const f = fixture(t), peer = release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const first = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const base = readFileSync(join(f.root, "ticket.md"), "utf8");
  writeFileSync(join(f.root, "ticket.md"), `${base}One\n`); f.git("add", "ticket.md"); f.git("commit", "-q", ...kitNote);
  const one = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.root, "ticket.md"), `${base}One\nTwo\n`); f.git("add", "ticket.md"); f.git("commit", "-q", ...kitNote);
  const two = f.git("rev-parse", "HEAD");
  // dev takes the first note's line itself, so that note has nothing left to add on the newest dev.
  f.gitAt(peer, "checkout", "-q", "dev"); f.gitAt(peer, "pull", "-q", "--ff-only", "origin", "dev");
  writeFileSync(join(peer, "ticket.md"), `${base}One\n`); f.gitAt(peer, "commit", "-q", "-am", "Ticket line on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const moved = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_EXISTING: "1" });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  assert.match(moved.stdout, new RegExp(`^sync: kit's own follow-ups commit ${two.slice(0, 7)} from an earlier run is put back on the merge made again$`, "m"));
  assert.match(moved.stdout, new RegExp(`^sync: kit's own follow-ups commit ${one.slice(0, 7)} from an earlier run no longer applies on the merge made again, so it is left out; `, "m"));
  assert.equal(f.git("rev-parse", "HEAD^^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^^2"), f.git("rev-parse", "origin/main"));
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  assert.equal(readFileSync(join(f.root, "ticket.md"), "utf8"), `${base}One\nTwo\n`);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("kit pr --sync-main takes no commit as kit's note that also changes a submodule git's diffs are told to ignore (TOOLS-352)", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev");
  writeFileSync(join(f.root, ".gitmodules"), '[submodule "sub"]\n\tpath = sub\n\turl = ./sub\n\tignore = all\n'); f.git("add", ".gitmodules");
  f.git("update-index", "--add", "--cacheinfo", `160000,${f.git("rev-parse", "HEAD")},sub`); f.git("commit", "-q", "-m", "Submodule"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin"); f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  const merge = f.git("rev-parse", "HEAD");
  writeFileSync(join(f.root, "ticket.md"), "Note\n"); f.git("add", "ticket.md");
  f.git("update-index", "--cacheinfo", `160000,${f.git("rev-parse", "origin/main")},sub`); f.git("commit", "-q", ...kitNote);
  const top = f.git("rev-parse", "HEAD");
  assert.equal(f.git("diff", "--name-only", merge, top), "ticket.md", "git's own diff hides the submodule");
  const result = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail sync: a sync branch holds only the merge of origin\/main, and this one has work of its own: /);
  assert.equal(f.git("rev-parse", "HEAD"), top);
});

test("kit pr --sync-main takes only kit's own follow-ups commit on a merge as kit's: anything else on the branch is work of its own (TOOLS-352)", t => {
  const f = fixture(t);
  release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const own = /RESULT: fail sync: a sync branch holds only the merge of origin\/main, and this one has work of its own: /;
  const refused = (what: string) => {
    const top = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main", "--ticket", "ticket.md", "--no-merge"], { FAKE_REVIEW: gapReview });
    assert.equal(result.status, 1, `${what}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, own, what);
    assert.equal(f.git("rev-parse", "HEAD"), top, `${what}: the branch stays as it was`);
    assert.equal(f.git("status", "--porcelain"), "", what);
  };
  // kit's message on a commit with no merge under it (a fresh cut).
  writeFileSync(join(f.root, "ticket.md"), "Forged note\n"); f.git("add", "ticket.md"); f.git("commit", "-q", ...kitNote);
  refused("kit's message on the cut");
  // kit's message on a cut whose tip is a merge dev already holds (dev lands syncs and releases as merges).
  f.git("reset", "-q", "--hard", "origin/dev"); f.git("checkout", "-q", "-b", "side"); f.commit("Side work", "side.txt");
  f.git("checkout", "-q", "sync/main"); f.git("merge", "-q", "--no-ff", "-m", "Merge side into dev", "side"); f.git("push", "-q", "origin", "HEAD:dev");
  writeFileSync(join(f.root, "ticket.md"), "Forged note\n"); f.git("add", "ticket.md"); f.git("commit", "-q", ...kitNote);
  refused("kit's message on a merge dev holds");
  f.git("reset", "-q", "--hard", "origin/dev"); f.git("fetch", "-q", "origin"); f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  const merge = f.git("rev-parse", "HEAD");
  // kit's message on a commit that changes another file too.
  writeFileSync(join(f.root, "ticket.md"), "Note\n"); writeFileSync(join(f.root, "file.txt"), "changed\n");
  f.git("add", "ticket.md", "file.txt"); f.git("commit", "-q", ...kitNote);
  refused("kit's message with another file");
  // A ticket-only commit with another message, and kit's subject without kit's trailer.
  f.git("reset", "-q", "--hard", merge); f.commit("Builder's note", "ticket.md", "Note\n");
  refused("another message");
  f.git("reset", "-q", "--hard", merge); writeFileSync(join(f.root, "ticket.md"), "Note\n"); f.git("add", "ticket.md");
  f.git("commit", "-q", "-m", "docs: ticket follow-ups from review");
  refused("kit's subject without its trailer");
  // kit's note under a builder's commit: the commit on top is work of its own.
  f.git("reset", "-q", "--hard", merge); writeFileSync(join(f.root, "ticket.md"), "Note\n"); f.git("add", "ticket.md"); f.git("commit", "-q", ...kitNote);
  f.commit("Own work", "own.txt");
  refused("a builder's commit on kit's note");
  // Without --ticket no commit is kit's note, so kit's message alone takes nothing as kit's.
  f.git("reset", "-q", "--hard", merge); writeFileSync(join(f.root, "ticket.md"), "Note\n"); f.git("add", "ticket.md"); f.git("commit", "-q", ...kitNote);
  const top = f.git("rev-parse", "HEAD"), plain = f.run(["--sync-main", "--no-merge"], { FAKE_REVIEW: gapReview });
  assert.equal(plain.status, 1, plain.stdout + plain.stderr); assert.match(plain.stdout, own);
  assert.equal(f.git("rev-parse", "HEAD"), top);
});

test("kit pr --sync-main refuses a hand-made merge made on an older dev that changes files, and keeps it", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "later.txt"), "later\n");
  f.gitAt(peer, "add", "later.txt"); f.gitAt(peer, "commit", "-q", "-m", "Later on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const merge = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), "RESULT: fail sync: this branch's merge <sha> was made on an older dev: make it again on origin/dev (git switch -c <name> origin/dev, git merge --no-ff origin/main) and run kit pr --sync-main there");
  assert.equal(f.git("rev-parse", "HEAD"), merge, "the hand-made merge stays");
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a hand-made merge that changes files and goes behind while CI runs stops as made on an older dev, never merged", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.gitAt(peer, "checkout", "-q", "dev");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  const merge = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main"], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), "RESULT: fail sync: this branch's merge <sha> was made on an older dev: make it again on origin/dev (git switch -c <name> origin/dev, git merge --no-ff origin/main) and run kit pr --sync-main there");
  assert.equal(f.ghCalls("merge").length, 1, "the one merge GitHub refused as behind");
  assert.equal(f.git("rev-parse", "HEAD"), merge);
});

// SL-1 of the TOOLS-341 second look: a merge on main that fixed a conflict is weighed by its resolution, not refused outright.
test("a hand-made merge that takes main's files as they are lands when main holds a merge that fixed a conflict", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "file.txt"), "hotfix\n");
  f.gitAt(peer, "commit", "-q", "-am", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Dev edit of the same line", "file.txt", "dev\n"); f.git("push", "-q", "origin", "dev");
  // A release merges dev into main and fixes the conflict there by hand.
  f.gitAt(peer, "fetch", "-q", "origin");
  assert.notEqual(spawnSync("git", ["merge", "-q", "--no-ff", "origin/dev"], { cwd: peer, env: f.env }).status, 0, "the release conflicts");
  writeFileSync(join(peer, "file.txt"), "resolved\n"); f.gitAt(peer, "add", "file.txt"); f.gitAt(peer, "commit", "-q", "-m", "Release with a fixed conflict");
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  // One that keeps dev's line leaves the fix out, and is refused.
  f.git("merge", "-q", "-s", "ours", "-m", "Hand-made sync", "origin/main");
  const dropping = f.run(["--sync-main"]);
  assert.equal(dropping.status, 1, dropping.stdout + dropping.stderr);
  assert.match(resultLine(dropping.stdout), /^RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold \(<sha> Hotfix on main, <sha> Release with a fixed conflict \(a merge that changes files itself\)\), /);
  f.git("reset", "-q", "--hard", "origin/dev"); f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main");
  assert.equal(f.git("show", "HEAD:file.txt"), "resolved", "the merge takes main's file as it is");
  f.gitAt(peer, "checkout", "-q", "dev");
  const merge = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main"], { FAKE_LAND_MERGE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sync: ok \(the merge [a-f0-9]{7} joins main at [a-f0-9]{7} into dev as it was made: it changes 1 file on dev, and drops no change of main's that dev does not hold\)$/m);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"), true, "it waits for CI");
  f.git("fetch", "-q", "origin");
  assert.equal(f.git("rev-parse", "origin/dev^2"), merge, "the merge lands as it was made");
});

test("a hand-made merge of an older main lands, and its line names the main commit it joins", t => {
  const f = fixture(t), peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main");
  for (const fix of ["one", "two"]) { writeFileSync(join(peer, `${fix}.txt`), `${fix}\n`); f.gitAt(peer, "add", `${fix}.txt`); f.gitAt(peer, "commit", "-q", "-m", `Hotfix ${fix}`); }
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin");
  f.git("merge", "-q", "--no-ff", "-m", "Hand-made sync", "origin/main~1");
  const one = f.git("rev-parse", "--short", "origin/main~1"), result = f.run(["--sync-main", "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^sync: ok \\(the merge [a-f0-9]{7} joins main at ${one} into dev as it was made: it changes 1 file on dev, and drops no change of main's that dev does not hold\\)$`, "m"));
});

// The shape a repo has after releases that copied dev's commits onto main and later ones that joined main into the cut: each
// copy sits behind a release join that kept dev's files, so main holds nothing dev's history lacks.
test("kit pr --sync-main lands a hand-made merge when main's own commits sit behind a release join that kept dev's files", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); const a = f.commit("Change A", "file.txt", "a\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", a);
  f.gitAt(peer, "checkout", "-q", "-b", "cut", "origin/dev"); f.gitAt(peer, "merge", "-q", "-s", "ours", "-m", "Merge origin/main into the release cut", "main");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "cut"); f.gitAt(peer, "push", "-q", "origin", "main");
  // A later release joins main the same way; by then A is on main through the first join, so the copy is found at the first.
  f.commit("Change B", "b.txt"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "-B", "cut", "origin/dev");
  f.gitAt(peer, "merge", "-q", "-s", "ours", "-m", "Merge origin/main into the release cut", "main");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release 2", "cut"); f.gitAt(peer, "push", "-q", "origin", "main");
  // dev changes A's line again: main's copy is no copy of a commit main lacks, and dev's files do not hold it.
  f.commit("Change A again", "file.txt", "a two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main");
  const own = f.run(["--sync-main"]);
  assert.equal(own.status, 1, own.stdout + own.stderr);
  assert.equal(resultLine(own.stdout), `RESULT: fail sync: a merge of origin/main would not hold <sha> Change A as made there (a later commit there, or dev's own work, changes the same lines), so kit cannot tell what to keep; ${byHand("sync")}`);
  f.git("fetch", "-q", "origin"); f.git("merge", "-q", "--no-ff", "-m", "Merge origin/main into dev", "origin/main");
  // dev moves while CI runs: kit cannot make the merge on the moved dev either, so the merge made by hand stays on the branch.
  f.gitAt(peer, "checkout", "-q", "dev"); f.gitAt(peer, "pull", "-q", "--ff-only", "origin", "dev");
  const old = f.git("rev-parse", "HEAD"), behind = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_BEHIND: "1", FAKE_ADVANCE: peer });
  assert.equal(behind.status, 1, behind.stdout + behind.stderr);
  assert.equal(resultLine(behind.stdout), `RESULT: fail sync: this branch's merge <sha> was made on an older dev, and kit cannot make it again on origin/dev: a merge of origin/main would not hold <sha> Change A as made there (a later commit there, or dev's own work, changes the same lines), so kit cannot tell what to keep; ${byHand("sync")}`);
  assert.equal(f.git("rev-parse", "HEAD"), old, "the merge made by hand stays");
  assert.equal(f.ghCalls("merge").length, 1);
  // Made again on the moved dev, it lands.
  f.git("fetch", "-q", "origin"); f.git("reset", "-q", "--hard", "origin/dev"); f.git("merge", "-q", "--no-ff", "-m", "Merge origin/main into dev", "origin/main");
  const merge = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_LAND_MERGE: peer, FAKE_EXISTING: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^sync: ok \(the merge [a-f0-9]{7} joins main at [a-f0-9]{7} into dev as it was made: it changes no file, and drops no change of main's that dev does not hold; 3 commits were joined already, by a merge on main that kept dev's files\)$/m);
  assert.equal(f.git("rev-parse", "HEAD"), merge);
  f.git("fetch", "-q", "origin"); f.git("merge-base", "--is-ancestor", "origin/main", "origin/dev");
  assert.equal(f.git("show", "origin/dev:file.txt"), "a two");
});

test("a squash of dev's work and its rollback behind a release join on main are weighed: the hand-made merge that leaves the rollback out is refused", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "side"); f.commit("Side one", "side.txt", "one\n"); f.commit("Side two", "side2.txt", "two\n"); f.git("push", "-q", "origin", "side");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--squash", "origin/side");
  f.gitAt(peer, "commit", "-q", "-m", "Side (squashed)"); f.gitAt(peer, "revert", "--no-edit", "HEAD");
  f.gitAt(peer, "checkout", "-q", "-b", "cut", "origin/dev"); f.gitAt(peer, "merge", "-q", "-s", "ours", "-m", "Merge origin/main into the release cut", "main");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "cut"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("merge", "-q", "--no-ff", "-m", "Land side", "side"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin"); f.git("merge", "-q", "--no-ff", "-m", "Merge origin/main into dev", "origin/main");
  assert.equal(f.git("diff", "--name-only", "origin/dev", "HEAD"), "", "a plain merge keeps the side work");
  const result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Revert "Side (squashed)"), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
});

// A release join covers only exact copies: git marks a commit whose change differs from dev's only in its spaces as the same
// change, and exactId tells them apart, so such a commit is weighed.
test("a commit behind a release join that copies dev's change with other spaces is weighed, not joined, so a merge that leaves it out is refused", t => {
  const f = fixture(t), peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Add tool", "tool.sh", "echo tool\n"); f.git("push", "-q", "origin", "dev");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main");
  writeFileSync(join(peer, "tool.sh"), "  echo tool\n"); f.gitAt(peer, "add", "tool.sh"); f.gitAt(peer, "commit", "-q", "-m", "Add tool (indented)");
  f.gitAt(peer, "checkout", "-q", "-b", "cut", "origin/dev"); f.gitAt(peer, "merge", "-q", "-s", "ours", "-m", "Merge origin/main into the release cut", "main");
  assert.match(f.gitAt(peer, "log", "--cherry-mark", "--right-only", "--no-merges", "--format=%m %s", "origin/dev...main"), /^= Add tool \(indented\)$/m, "git takes it for the same change");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "cut"); f.gitAt(peer, "push", "-q", "origin", "main");
  // dev changes the tool afterwards, so the merge's file is no longer main's and main's commit is weighed against it.
  f.commit("Dev moves on", "tool.sh", "echo tool two\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin"); f.git("merge", "-q", "--no-ff", "-m", "Merge origin/main into dev", "origin/main");
  const result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Add tool (indented)), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
});

// SL-1 kept: a rollback on main of a change it copied from dev is never covered by a later release join.
test("a release join on main does not cover a copy of dev's work and its rollback behind it: the hand-made merge that leaves the rollback out is refused", t => {
  const f = fixture(t), peer = f.peer();
  // A change on a side branch is copied onto main and rolled back there; a release cut taken before dev took it keeps dev's files.
  f.git("checkout", "-q", "dev"); f.git("checkout", "-q", "-b", "side"); const d = f.commit("Side change", "side.txt"); f.git("push", "-q", "origin", "side");
  f.gitAt(peer, "fetch", "-q", "origin"); f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "cherry-pick", d); f.gitAt(peer, "revert", "--no-edit", "HEAD");
  f.gitAt(peer, "checkout", "-q", "-b", "cut", "origin/dev"); f.gitAt(peer, "merge", "-q", "-s", "ours", "-m", "Merge origin/main into the release cut", "main");
  f.gitAt(peer, "checkout", "-q", "main"); f.gitAt(peer, "merge", "-q", "--no-ff", "-m", "Release", "cut"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.git("merge", "-q", "--no-ff", "-m", "Land side", "side"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "sync/main"); f.git("fetch", "-q", "origin"); f.git("merge", "-q", "--no-ff", "-m", "Merge origin/main into dev", "origin/main");
  assert.equal(f.git("diff", "--name-only", "origin/dev", "HEAD"), "", "a plain merge keeps side.txt");
  const merge = f.git("rev-parse", "HEAD"), result = f.run(["--sync-main"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(resultLine(result.stdout), `RESULT: fail sync: the merge <sha> leaves out changes of main's that dev does not hold (<sha> Revert "Side change"), so kit cannot prove it drops nothing: keep each of them in the merge (git commit --amend once its files hold them), or land them on dev first with an ordinary kit pr and make the merge again, then run kit pr --sync-main again`);
  assert.equal(f.git("rev-parse", "HEAD"), merge);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a sync that is behind when it merges makes its merge again on the moved dev, and merges with --merge both times", t => {
  const f = fixture(t), peer = release(f);
  f.gitAt(peer, "checkout", "-q", "dev"); f.gitAt(peer, "pull", "-q", "--ff-only", "origin", "dev");
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const result = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_BEHIND: "1", FAKE_ADVANCE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 2);
  for (const merge of merges) { assert.ok(merge.args.includes("--merge")); assert.equal(merge.args.includes("--rebase"), false); }
  assert.equal(f.git("rev-parse", "HEAD^1"), f.git("rev-parse", "origin/dev"), "the second head is the merge made again on the moved dev");
  assert.equal(merges[1].args[merges[1].args.indexOf("--match-head-commit") + 1], f.git("rev-parse", "HEAD"));
});

test("a sync made again after a behind retry gets its Summary written again from the new merge (TOOLS-380)", t => {
  const f = fixture(t), peer = release(f);
  f.gitAt(peer, "checkout", "-q", "dev"); f.gitAt(peer, "pull", "-q", "--ff-only", "origin", "dev");
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  // While CI runs, dev gains a commit and main gains a copy of it: the merge made again joins one more commit.
  const script = join(f.dir, "main-copy.sh");
  writeFileSync(script, `#!/bin/sh\nset -e\ncd '${peer}'\ngit checkout -q main\ngit cherry-pick dev\ngit push -q origin main\ngit checkout -q dev\n`, { mode: 0o755 });
  const result = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_AFTER_PUSH: script });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const counted = (text: string) => Number(/the (\d+) commits? it joins/.exec(text)?.[1]);
  const patched = f.apiCalls().filter(call => call.args.includes("PATCH")).at(-1)!.body!;
  const first = counted(f.ghCalls("create")[0].body!), last = counted(patched);
  assert.ok(first >= 1, f.ghCalls("create")[0].body);
  assert.equal(last, first + 1, `the PR counts the commits of the merge made again\n${patched}`);
});

test("a release through a merge queue asks for --auto --merge, and a landed commit that is no merge of the head is said", t => {
  const queued = fixture(t), result = queued.run(["--base", "main", "--release"], { FAKE_QUEUE: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const merge = queued.ghCalls("merge")[0].args;
  assert.ok(merge.includes("--auto") && merge.includes("--merge"), merge.join(" ")); assert.equal(merge.includes("--rebase"), false);
  // A queue that squashes or rebases, or one whose method cannot be read, never takes a release or a sync.
  for (const [how, words] of [["SQUASH", "lands by squash"], ["REBASE", "lands by rebase"], ["fail", "did not say how it lands"]]) {
    const refused = fixture(t), stopped = refused.run(["--base", "main", "--release"], { FAKE_QUEUE: "1", FAKE_QUEUE_METHOD: how });
    assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
    assert.match(stopped.stdout, new RegExp(`^RESULT: fail merge: the merge queue on main ${words}, and a release must land as a merge commit: set the queue to merge commits, then run kit pr again$`, "m"));
    assert.equal(refused.ghCalls("merge").length, 0, "nothing goes into the queue");
    assert.equal(refused.ghCalls("create").length, 0, "the queue is read before the PR is opened");
    assert.notEqual(spawnSync("git", ["show-ref", "--verify", "-q", "refs/heads/feature/kit-pr"], { cwd: refused.origin }).status, 0, "and before the branch is pushed");
  }
  // --no-merge never advises a hand merge a squashing queue would take; with a queue that makes merge commits it does.
  const advice = fixture(t), opened = advice.run(["--base", "main", "--release", "--no-merge"], { FAKE_QUEUE: "1", FAKE_QUEUE_METHOD: "SQUASH" });
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.doesNotMatch(opened.stdout, /gh pr merge 73/);
  assert.match(opened.stdout, /^merge: kit pr will not land it here: the merge queue on main lands by squash, and a release must land as a merge commit: set the queue to merge commits, then run kit pr again$/m);
  // A queue lookup that fails stops a release or a sync, and gives no hand-merge advice; an ordinary PR still lands as before.
  for (const args of [["--base", "main", "--release"], ["--base", "main", "--release", "--no-merge"]]) {
    const unseen = fixture(t), run = unseen.run(args, { FAKE_QUEUE_ERROR: "1" });
    assert.equal(run.status, args.includes("--no-merge") ? 0 : 1, run.stdout + run.stderr);
    assert.equal(unseen.ghCalls("merge").length, 0);
    if (!args.includes("--no-merge")) {
      assert.equal(unseen.ghCalls("create").length, 0, "a queue that cannot be read stops the release before it is opened");
      assert.notEqual(spawnSync("git", ["show-ref", "--verify", "-q", "refs/heads/feature/kit-pr"], { cwd: unseen.origin }).status, 0, "and before the branch is pushed");
    }
    assert.doesNotMatch(run.stdout, /gh pr merge 73/);
    assert.match(run.stdout, /could not read whether main has a merge queue, and a release must land as a merge commit: run kit pr again once GitHub answers/);
  }
  // A queued release names the release check's waiver on its RESULT line, as a merged one does.
  const waived = fixture(t), queuedWaived = waived.run(["--base", "main", "--release", "--waive", "hotfix tonight"],
    { ASE_OWNER: "ke-lead", FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_QUEUE: "1" });
  assert.equal(queuedWaived.status, 0, queuedWaived.stdout + queuedWaived.stderr);
  assert.match(queuedWaived.stdout, /RESULT: ok queued #73 [a-f0-9]{7} \(release-check waived: hotfix tonight\)$/m);
  const fine = fixture(t), merged = fine.run(["--base", "main", "--release", "--no-merge"], { FAKE_QUEUE: "1" });
  assert.match(merged.stdout, /^merge: land it with kit pr --base main --release \(a merge commit, never merged by hand\)$/m);
  const sync = fixture(t);
  release(sync);
  sync.git("checkout", "-q", "dev"); sync.git("pull", "-q", "--ff-only", "origin", "dev"); sync.git("checkout", "-q", "-b", "sync/main");
  const squashed = sync.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_QUEUE: "1", FAKE_QUEUE_METHOD: "SQUASH" });
  assert.equal(squashed.status, 1, squashed.stdout + squashed.stderr);
  assert.match(squashed.stdout, /^RESULT: fail merge: the merge queue on dev lands by squash, and a sync must land as a merge commit: /m);
  assert.equal(sync.ghCalls("merge").length, 0);
  assert.equal(sync.ghCalls("create").length, 0, "the queue is read before the PR is opened");
  assert.notEqual(spawnSync("git", ["show-ref", "--verify", "-q", "refs/heads/sync/main"], { cwd: sync.origin }).status, 0, "and before the branch is pushed");
  const advised = sync.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1", FAKE_QUEUE: "1", FAKE_QUEUE_METHOD: "REBASE", FAKE_EXISTING: "1" });
  assert.equal(advised.status, 0, advised.stdout + advised.stderr);
  assert.match(advised.stdout, /^merge: kit pr will not land it here: the merge queue on dev lands by rebase, and a sync must land as a merge commit: /m);
  const unseenSync = sync.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_QUEUE_ERROR: "1", FAKE_EXISTING: "1" });
  assert.equal(unseenSync.status, 1, unseenSync.stdout + unseenSync.stderr);
  assert.match(unseenSync.stdout, /^RESULT: fail merge: could not read whether dev has a merge queue, and a sync must land as a merge commit: /m);
  assert.equal(sync.ghCalls("merge").length, 0);
  const blind = fixture(t);
  release(blind);
  blind.git("checkout", "-q", "dev"); blind.git("pull", "-q", "--ff-only", "origin", "dev"); blind.git("checkout", "-q", "-b", "sync/main");
  const blindSync = blind.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_QUEUE_ERROR: "1" });
  assert.equal(blindSync.status, 1, blindSync.stdout + blindSync.stderr);
  assert.match(blindSync.stdout, /^RESULT: fail merge: could not read whether dev has a merge queue, and a sync must land as a merge commit: /m);
  assert.equal(blind.ghCalls("create").length, 0, "a queue that cannot be read stops the sync before it is opened");
  assert.notEqual(spawnSync("git", ["show-ref", "--verify", "-q", "refs/heads/sync/main"], { cwd: blind.origin }).status, 0, "and before the branch is pushed");
  const f = fixture(t);
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const base = f.git("rev-parse", "origin/main"), plain = f.run(["--base", "main", "--release"], { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_MERGED: base });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.match(plain.stdout, new RegExp(`^landed: ${base.slice(0, 7)} is no merge commit of [a-f0-9]{7}; check main by hand$`, "m"));
});

// Review 15 (GPT): the queue is read before the push and before the checks; one turned on while the checks ran is seen too.
test("a release or a sync reads the merge queue again after its checks and before each merge: a new queue takes it only when it makes merge commits", t => {
  // A release makes three lookups up to its first merge: before the push, before the checks, after the checks.
  const waited = (f: ReturnType<typeof fixture>) => f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait");
  const squashing = fixture(t), squashed = squashing.run(["--base", "main", "--release"], { FAKE_QUEUE_FROM: "3", FAKE_QUEUE_METHOD: "SQUASH" });
  assert.equal(squashed.status, 1, squashed.stdout + squashed.stderr);
  assert.match(squashed.stdout, /^RESULT: fail merge: the merge queue on main lands by squash, and a release must land as a merge commit: set the queue to merge commits, then run kit pr again$/m);
  assert.equal(waited(squashing), true, "the queue appeared while the checks ran");
  assert.equal(squashing.ghCalls("merge").length, 0, "nothing goes into the queue");
  assert.doesNotMatch(squashed.stdout, /merged #73|queued #73/);
  const quiet = fixture(t), unread = quiet.run(["--base", "main", "--release"], { FAKE_QUEUE_ERROR_FROM: "3" });
  assert.equal(unread.status, 1, unread.stdout + unread.stderr);
  assert.match(unread.stdout, /^RESULT: fail merge: could not read whether main has a merge queue, and a release must land as a merge commit: run kit pr again once GitHub answers$/m);
  assert.equal(waited(quiet), true); assert.equal(quiet.ghCalls("merge").length, 0);
  // A new queue that makes merge commits takes the release as any such queue does.
  const merging = fixture(t), queued = merging.run(["--base", "main", "--release"], { FAKE_QUEUE_FROM: "3" });
  assert.equal(queued.status, 0, queued.stdout + queued.stderr);
  assert.equal(merging.ghCalls("merge").length, 1);
  assert.ok(merging.ghCalls("merge")[0].args.includes("--auto") && merging.ghCalls("merge")[0].args.includes("--merge"));
  assert.match(queued.stdout, /RESULT: ok queued #73 [a-f0-9]{7}$/m);
  // The same on a retry: the sync's first merge found dev moved, and the queue appeared before the second (the fourth lookup).
  const f = fixture(t), peer = release(f);
  f.gitAt(peer, "checkout", "-q", "dev"); f.gitAt(peer, "pull", "-q", "--ff-only", "origin", "dev");
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const retried = f.run(["--sync-main"], { FAKE_EMPTY: "1", FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_QUEUE_FROM: "4", FAKE_QUEUE_METHOD: "REBASE" });
  assert.equal(retried.status, 1, retried.stdout + retried.stderr);
  assert.match(retried.stdout, /^RESULT: fail merge: the merge queue on dev lands by rebase, and a sync must land as a merge commit: set the queue to merge commits, then run kit pr again$/m);
  assert.equal(f.ghCalls("merge").length, 1, "only the first merge, which found dev moved, was asked");
  assert.doesNotMatch(retried.stdout, /merged #73|queued #73/);
});

test("kit pr --sync-main makes the merge again on the newest dev when dev moved after the cut", t => {
  const f = fixture(t), peer = release(f);
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  f.gitAt(peer, "checkout", "-q", "dev"); writeFileSync(join(peer, "later.txt"), "later\n");
  f.gitAt(peer, "add", "later.txt"); f.gitAt(peer, "commit", "-q", "-m", "Later on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const result = f.run(["--sync-main", "--no-merge"], { FAKE_EMPTY: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("rev-parse", "HEAD^1"), f.git("rev-parse", "origin/dev"));
  assert.equal(f.git("rev-parse", "HEAD^2"), f.git("rev-parse", "origin/main"));
  assert.match(result.stdout, /^merge: land it with kit pr --sync-main \(a merge commit, never merged by hand\)$/m);
  assert.equal(f.git("log", "-1", "--format=%b"), "", "after an ordinary release main holds only merges, so the merge stays a plain one");
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
});

test("a release runs the plain ticket check: what it carries already passed when each PR landed on dev", t => {
  const f = fixture(t, { "docs/wayfinder/m/tickets/01-x.md": "---\nstatus: closed\n---\n" });
  const result = f.run(["--base", "main", "--release"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().filter(call => call.tool === "tickets.mjs").map(call => call.args), [["check"]]);
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

test("a release check that cannot run is named by its error, which its log ends with as kit release-check's RESULT line", t => {
  const f = fixture(t), result = f.run(["--base", "main", "--release"], { FAKE_RELEASE_CHECK_STDERR: "kit-lib: cannot read settings" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESULT: fail release-check: kit-lib: cannot read settings$/m);
  assert.match(readFileSync(join(f.logDir(), "release-check.log"), "utf8"), /RESULT: fail kit-lib: cannot read settings\n$/);
  assert.equal(existsSync(join(f.logDir(), "fetch.log")), false);
});

test("the real release check, in kit pr's process, runs git with the key lock's settings: a file system monitor the build set never starts", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") };
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  // Set last: the test's own git calls would start it. The release check's git status is the first git call to read it.
  const marker = join(f.dir, "monitor-ran.txt"), monitor = join(f.dir, "monitor.sh");
  writeFileSync(monitor, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n`); chmodSync(monitor, 0o755);
  writeFileSync(join(f.root, ".git/config"), `${readFileSync(join(f.root, ".git/config"), "utf8")}[core]\n\tfsmonitor = ${monitor}\n`);
  const result = f.run(["--base", "main", "--release", "--dry-run"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^logs: .+\nrelease-check: ok \([a-f0-9]{7} is origin\/dev, nothing unsaved\)\n/);
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
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

test("a release cut at origin/dev passes the check before kit pr joins it with a main that has a commit dev lacks, by one merge", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`release-check: ok \\(${cut.slice(0, 7)} is origin/dev, nothing unsaved\\)`));
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
  // The pushed release is the cut with origin/main merged in: the hotfix and the landed change are both there, and dev's commits keep their SHAs.
  assert.notEqual(f.git("rev-parse", "HEAD"), cut);
  assert.equal(f.git("log", "--format=%s", "-2", "--first-parent"), "Merge origin/main into the release cut\nLanded change");
  assert.equal(f.git("rev-parse", "HEAD^1"), cut, "the cut itself is the first parent");
  f.git("merge-base", "--is-ancestor", "origin/main", "HEAD");
  assert.equal(f.git("show", "HEAD:hotfix.txt"), "hotfix");
});

test("a release cut from a dev that holds a back-merge of main needs no change: no conflict, HEAD unchanged (TOOLS-38)", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  // main takes a hotfix on the same line dev edits, so replaying dev's own edit onto main conflicts.
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "file.txt"), "hotfix\n");
  f.gitAt(peer, "add", "file.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Dev edit of the same line", "file.txt", "dev\n");
  // Dev takes main's history in with a merge commit (its tree keeps dev's resolution), then lands more work.
  f.git("fetch", "-q", "origin"); f.git("merge", "-q", "-s", "ours", "origin/main", "-m", "Back-merge main into dev");
  f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const cut = f.git("rev-parse", "HEAD"), result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^merge: ok$/m);
  assert.doesNotMatch(result.stdout, /conflict in/);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "main is already inside the cut, so the rebase leaves it as it is");
  f.git("merge-base", "--is-ancestor", "origin/main", "HEAD"); // throws unless main is inside the release
  assert.match(result.stdout, /^merge: land it with kit pr --base main --release \(a merge commit, never merged by hand\)$/m, "the release says to land it through kit pr, never by hand");
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
});

test("a release's own merge of main is not its title or a line of its summary", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("log", "-1", "--format=%s"), "Merge origin/main into the release cut", "the merge is in the pushed release");
  const create = f.ghCalls("create")[0];
  assert.equal(create.args[create.args.indexOf("--title") + 1], "Landed change", "the title is the newest landed change");
  assert.doesNotMatch(f.body(), /Merge origin\/main into the release cut/);
  assert.match(f.body(), /^- Landed change$/m);
});

test("a release whose repo lookup fails after the PR is open still ends ok, and gives no merge command: the queue is unseen", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_FAIL: "repo-view" };
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /gh pr merge 73/);
  assert.match(result.stdout, /^merge: kit pr will not land it here: could not read whether main has a merge queue, and a release must land as a merge commit: run kit pr again once GitHub answers$/m);
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
});

test("a release with --no-merge under a host-prefixed GH_REPO opens and names kit pr to land it", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), GH_REPO: "git.example.com/acme/site" };
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^merge: land it with kit pr --base main --release \(a merge commit, never merged by hand\)$/m);
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7}$/m);
});

test("a release dry run names kit pr to land it, and a cut that main already holds is refused as nothing to release", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") };
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const plan = f.run(["--base", "main", "--release", "--dry-run"], real);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /^merge: the real run lands it once CI passes, as a merge commit pinned to the pushed head \(never --rebase\)$/m);
  // main takes the whole cut (a release already merged), so there is nothing left to release.
  f.git("push", "-q", "origin", "release/cut:main");
  const again = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stdout, /RESULT: fail merge: nothing to release: origin\/main already holds this cut$/m);
});

// TOOLS-360: nothing lands outside kit pr, so a release or a sync never prints a gh pr merge command to run by hand.
test("a release or a sync with --no-merge, and their dry runs, name kit pr to land them, never a gh pr merge command", t => {
  const cut = fixture(t);
  for (const args of [["--base", "main", "--release", "--no-merge"], ["--base", "main", "--release", "--dry-run"], ["--base", "main", "--release", "--dry-run", "--no-merge"]]) {
    const run = cut.run(args);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /gh pr merge/, args.join(" "));
    assert.match(run.stdout, args.includes("--no-merge") ? /^merge: land it with kit pr --base main --release \(a merge commit, never merged by hand\)$/m : /^merge: the real run lands it once CI passes, as a merge commit pinned to the pushed head \(never --rebase\)$/m, args.join(" "));
  }
  const sync = fixture(t);
  release(sync);
  sync.git("checkout", "-q", "dev"); sync.git("pull", "-q", "--ff-only", "origin", "dev"); sync.git("checkout", "-q", "-b", "sync/main");
  for (const args of [["--sync-main", "--dry-run"], ["--sync-main", "--no-merge"]]) {
    const run = sync.run(args, { FAKE_EMPTY: "1" });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.doesNotMatch(run.stdout, /gh pr merge/, args.join(" "));
    assert.match(run.stdout, args.includes("--no-merge") ? /^merge: land it with kit pr --sync-main \(a merge commit, never merged by hand\)$/m : /^merge: the real run lands it once CI passes, as a merge commit pinned to the pushed head \(never --rebase\)$/m, args.join(" "));
  }
});

// The words of the kit pr run a release's merge line names, unquoted as a shell would (the hint quotes with '…').
const rerunWords = (stdout: string) => {
  const line = stdout.match(/^merge: land it with (?:git reset --keep [a-f0-9]{40} && )?kit pr (.+) \(a merge commit, never merged by hand\)$/m);
  assert.ok(line, stdout);
  return [...line[1].matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(word => word[2] ?? word[1].replaceAll("'\\''", "'"));
};

test("the kit pr line a release with --no-merge prints, run as written, lands that same PR as a merge commit", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_BASE: "main" }, peer = f.peer();
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const opened = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  const words = rerunWords(opened.stdout), created = f.ghCalls("create").length;
  assert.deepEqual(words, ["--base", "main", "--release"]);
  const landed = f.run(words, { ...real, FAKE_EXISTING: "1", FAKE_LAND_MERGE: peer });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(f.ghCalls("create").length, created, "the open PR is reused, not opened again");
  const merges = f.ghCalls("merge");
  assert.equal(merges.length, 1);
  assert.ok(merges[0].args.includes("--merge"), merges[0].args.join(" "));
  assert.equal(merges[0].args[merges[0].args.indexOf("--match-head-commit") + 1], f.git("rev-parse", "HEAD"));
  assert.match(landed.stdout, /^landed: [a-f0-9]{7} merges [a-f0-9]{7} into main \(a merge commit\)$/m);
  assert.match(landed.stdout, /RESULT: ok merged #73 [a-f0-9]{7}$/m);
});

// TOOLS-360 second look: a release that merged a hotfixed main into its cut is ahead of origin/dev, so the line cuts it again first.
test("the line a release prints after merging a hotfixed main into its cut re-cuts it first, and run as written lands the same PR", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_BASE: "main" }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const dev = f.git("rev-parse", "origin/dev"), line = new RegExp(`^merge: land it with git reset --keep ${dev} && kit pr --base main --release \\(a merge commit, never merged by hand\\)$`, "m");
  const plan = f.run(["--base", "main", "--release", "--dry-run", "--no-merge"], real);
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, line, "a dry run that merged main into the cut names the re-cut too");
  f.git("reset", "-q", "--keep", dev);
  const opened = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  const cut = f.git("rev-parse", "HEAD");
  assert.notEqual(cut, dev, "the run merged main into the cut");
  assert.match(opened.stdout, line, "an ordinary cut is cut again at origin/dev");
  f.git("reset", "-q", "--keep", "origin/dev");
  const created = f.ghCalls("create").length, landed = f.run(rerunWords(opened.stdout), { ...real, FAKE_EXISTING: "1", FAKE_LAND_MERGE: peer });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "the re-cut is the same merge");
  assert.equal(f.ghCalls("create").length, created, "the open PR is reused, not opened again");
  assert.equal(f.ghCalls("merge").length, 1);
  assert.match(landed.stdout, /^landed: [a-f0-9]{7} merges [a-f0-9]{7} into main \(a merge commit\)$/m);
  assert.match(landed.stdout, /RESULT: ok merged #73 [a-f0-9]{7}$/m);
});

test("the re-cut a waived release names keeps the cut's own commits past origin/dev, and run as written lands the same PR", t => {
  const f = fixture(t), env = { ASE_OWNER: "ke-lead", FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_BASE: "main" }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit("Own commit on the cut", "own.txt");
  const own = f.git("rev-parse", "HEAD");
  assert.notEqual(own, f.git("rev-parse", "origin/dev"));
  const opened = f.run(["--base", "main", "--release", "--no-merge", "--waive", "hotfix tonight"], env);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.notEqual(f.git("rev-parse", "HEAD"), own, "the run merged main into the cut");
  assert.match(opened.stdout, new RegExp(`^merge: land it with git reset --keep ${own} && kit pr --base main --release --waive 'hotfix tonight' \\(`, "m"));
  // Run as written: the re-cut keeps the cut's own commit and makes the same merge, and kit pr lands the same PR.
  const head = f.git("rev-parse", "HEAD");
  f.git("reset", "-q", "--keep", own);
  const landed = f.run(rerunWords(opened.stdout), { ...env, FAKE_EXISTING: "1", FAKE_LAND_MERGE: peer });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), head, "the same merge");
  f.git("merge-base", "--is-ancestor", own, "HEAD"); // throws unless the cut's own commit is in the release
  assert.match(landed.stdout, /RESULT: ok merged #73 [a-f0-9]{7}/m);
});

test("the kit pr line a sync with --no-merge prints keeps its waiver and title, and run as written lands the same PR", t => {
  const f = fixture(t), peer = release(f), env = { ASE_OWNER: "ke-lead", FAKE_EMPTY: "1" };
  f.git("checkout", "-q", "dev"); f.git("pull", "-q", "--ff-only", "origin", "dev"); f.git("checkout", "-q", "-b", "sync/main");
  const args = ["--sync-main", "--no-merge", "--waive", "sync tonight", "--title", "Sync main"];
  const opened = f.run(args, env);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.match(opened.stdout, /^merge: land it with kit pr --sync-main --waive 'sync tonight' --title 'Sync main' \(a merge commit, never merged by hand\)$/m);
  const words = rerunWords(opened.stdout), created = f.ghCalls("create").length;
  assert.deepEqual(words, args.filter(arg => arg !== "--no-merge"));
  const landed = f.run(words, { ...env, FAKE_EXISTING: "1", FAKE_LAND_MERGE: peer });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(f.ghCalls("create").length, created, "the open PR is reused, not opened again");
  assert.match(landed.stdout, /RESULT: ok merged #73 [a-f0-9]{7}/m);
});

test("the kit pr line a release with --no-merge prints keeps its waiver, title and ticket, so copying it passes the release check", t => {
  const f = fixture(t), env = { ASE_OWNER: "ke-lead", FAKE_RELEASE_CHECK: resolve("kit.d/release-check") };
  mkdirSync(join(f.root, ".scratch/briefs"), { recursive: true });
  writeFileSync(join(f.root, ".scratch/briefs/TOOLS-1.md"), '---\ntitle: "Brief title"\n---\n\nImplemented.\n');
  const args = ["--base", "main", "--release", "--no-merge", "--waive", "hotfix tonight", "--title", "Release: tonight's fix", "--ticket", ".scratch/briefs/TOOLS-1.md"];
  const opened = f.run(args, env);
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.match(opened.stdout, /^merge: land it with kit pr --base main --release --waive 'hotfix tonight' --title 'Release: tonight'\\''s fix' --ticket \.scratch\/briefs\/TOOLS-1\.md \(/m);
  const words = rerunWords(opened.stdout);
  assert.deepEqual(words, args.filter(arg => arg !== "--no-merge"));
  // Without the waiver this branch fails the release check (HEAD is no origin/dev); the copied line still passes it.
  const bare = f.run(["--base", "main", "--release", "--no-merge"], env);
  assert.match(bare.stdout, /^RESULT: fail release-check/m);
  const copied = f.run([...words, "--no-merge"], { ...env, FAKE_EXISTING: "1" });
  assert.equal(copied.status, 0, copied.stdout + copied.stderr);
  assert.doesNotMatch(copied.stdout, /RESULT: fail/);
});

test("a release cut after main took another hotfix past dev's back-merge ends up on top of that hotfix", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  const hotfix = (file: string, text: string, subject: string) => {
    f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, file), text);
    f.gitAt(peer, "add", file); f.gitAt(peer, "commit", "-q", "-m", subject); f.gitAt(peer, "push", "-q", "origin", "main");
  };
  hotfix("file.txt", "hotfix\n", "Hotfix one on main");
  f.git("checkout", "-q", "dev"); f.commit("Dev edit of the same line", "file.txt", "dev\n");
  f.git("fetch", "-q", "origin"); f.git("merge", "-q", "-s", "ours", "origin/main", "-m", "Back-merge main into dev");
  f.commit("Landed change", "landed.txt");
  hotfix("second.txt", "second\n", "Hotfix two on main");
  f.git("push", "-q", "origin", "dev"); f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^merge: ok$/m);
  f.git("merge-base", "--is-ancestor", "origin/main", "HEAD"); // the second hotfix is inside the release too
  assert.equal(f.git("show", "HEAD:second.txt"), "second");
  assert.equal(f.git("show", "HEAD:landed.txt"), "Landed change");
});

test("a release merge that really conflicts still stops naming the file, and aborts the merge", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "file.txt"), "hotfix\n");
  f.gitAt(peer, "add", "file.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Dev edit of the same line", "file.txt", "dev\n"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1);
  assert.equal(resultLine(result.stdout), `RESULT: fail merge: conflict in file.txt: kit cannot join origin/main by itself; ${byHand("release")}`);
  assert.equal(f.git("status", "--porcelain"), "", "the merge was aborted");
});

test("a rerun after an earlier run merged a hotfixed main into the cut says to cut it again, and the new cut passes", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check") }, peer = f.peer();
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n");
  f.gitAt(peer, "add", "hotfix.txt"); f.gitAt(peer, "commit", "-q", "-m", "Hotfix on main"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  let result = f.run(["--base", "main", "--release", "--no-merge"], { ...real, FAKE_FAIL: "review" });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail review: /);
  result = f.run(["--base", "main", "--release", "--no-merge"], real);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^RESULT: fail release-check: HEAD [a-f0-9]{7} is 2 commits ahead of origin\/dev: cut the release again from origin\/dev \(git reset --keep origin\/dev\) and rerun kit pr --release$/m);
  // The check ran in kit pr's process: its log keeps the problem lines kit release-check prints, then its RESULT line.
  assert.match(readFileSync(join(f.logDir(), "release-check.log"), "utf8"), /problem: HEAD [a-f0-9]{7} is 2 commits ahead of origin\/dev: [^\n]+\nRESULT: fail HEAD /);
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
      : /RESULT: ok merged #73 [a-f0-9]{7} \(release-check waived: hotfix tonight\)$/m);
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
    assert.equal(result.stdout.trimEnd().split("\n").at(-1), `RESULT: fail pr #73 review has 16 open findings (${path})`);
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
    const reason = '1 finding accepted for follow-up: "ticket 02".';
    const result = f.run(["--waive", reason], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report, FAKE_EXISTING: "1" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT: ok merged #73/);
    assert.equal(f.ghCalls("merge").length, 1);
    assert.ok(f.calls().some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
    assert.equal(f.ghCalls("comment").at(-1)?.body, `Merged with 1 waived findings: ${reason}`);
    const patches = f.apiCalls().filter(call => call.args[1] === "--method");
    // The opening body, then (when the review left its evidence) the review loop's PR line and ledger, then the waiver.
    assert.ok(patches.length >= 2 && patches.length <= 3, String(patches.length));
    assert.deepEqual(patches.at(-1)!.args.slice(0, 5), ["api", "--method", "PATCH", "repos/{owner}/{repo}/pulls/73", "-F"]);
    assert.match(patches.at(-1)!.args[5], /^body=@/);
    assert.equal(patches.at(-1)!.body, `${patches.at(-2)!.body}\nmerged with 1 waived findings: ${reason}\n`);
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
  const result = f.run(["--waive", "1 finding: Follow up later"], { ASE_OWNER: "", FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 A defect.\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings: 1 finding: Follow up later");
});

test("waiver does not claim a merge for no-merge, an unmerged release, clean reviews or failed CI", t => {
  for (const mode of ["no-merge", "release", "clean", "ci-failure"]) {
    const f = fixture(t);
    const args = ["--waive", "1 finding: Follow up later", ...(mode === "no-merge" ? ["--no-merge"] : mode === "release" ? ["--release", "--base", "main", "--no-merge"] : [])];
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
    assert.deepEqual(calls[wait].args, ["wait", "ci", "--pr", "73", "--timeout", "60m"]);
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
  const lead = fixture(t), waived = lead.run(["--waive", "1 finding: accepted for ticket 02."], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report });
  assert.equal(waived.status, 0, waived.stderr);
  assert.equal(JSON.parse(readFileSync(join(lead.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8")).landed.waived, "1 finding: accepted for ticket 02.");
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
  gitAround(f.bin, "rebase", { after: `echo 'Edited during the rebase.' >> ${JSON.stringify(join(f.root, "ticket.md"))}` });
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
  gitAround(f.bin, "commit", { before: "echo 'message refused' >&2; exit 1" });
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
  // --full keeps whether docs changed, so a ticket the PR closes is still checked.
  assert.deepEqual(classify(rows("docs/a.md"), { full: true }), { tier: "full", reason: "1 file, --full", docs: true });
  assert.deepEqual(classify(rows("src/main.ts"), { full: true }), { tier: "full", reason: "1 file, --full", docs: false });
  assert.deepEqual(classify([], { full: true }), { tier: "full", reason: "0 files, --full", docs: false });
  assert.ok(checkSteps(classify(rows("docs/work/x/tickets/1-a.md", "src/main.ts"), { full: true })).steps.includes("tickets"));
  assert.deepEqual(parseChanges("M\tdocs/a.md\nD\tsrc/b.css\n"), [{ status: "M", path: "docs/a.md" }, { status: "D", path: "src/b.css" }]);
}));

test("tier steps: docs skips unit, specs and review; full keeps today's set and checks tickets when docs changed", () => {
  assert.deepEqual(checkSteps({ tier: "docs", docs: true }), { steps: ["tickets", "unit-files"], review: false });
  assert.deepEqual(checkSteps({ tier: "css", docs: false }), { steps: ["colours", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "css", docs: true }), { steps: ["colours", "tickets", "unit-files", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "tests", docs: false }), { steps: ["check", "unit-files", "lint", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "tests", docs: true }), { steps: ["check", "unit-files", "lint", "tickets", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "full", docs: false }), { steps: ["check", "unit", "lint", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "full", docs: true }), { steps: ["check", "unit", "lint", "tickets", "specs"], review: true });
  assert.deepEqual(checkSteps({ tier: "full", docs: true, cleanGuard: true }).steps, ["check", "unit", "kit-clean", "lint", "tickets", "specs"]);
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
  assert.deepEqual(calls.filter(call => call.tool === "tickets.mjs").map(call => call.args), [["check", "--closed-since", "origin/dev"]]);
  assert.deepEqual(calls.filter(call => call.tool === "unit.sh").map(call => call.args), [["tests/code-map.test.ts"]]);
  assert.equal(calls.some(call => call.tool === "npm"), false);
  assert.equal(calls.some(call => claudeReview(call) || (call.tool === "fake-kit" && call.args[0] === "specs")), false);
  assert.deepEqual(calls.filter(call => call.tool === "fake-kit" && call.args[0] === "review").map(call => call.args), [["review", "--base", "origin/dev", "--pr", "73", "--second-look"]]);
  assert.match(result.stdout, /^second look: code \(feature\.txt\) grok-4\.7$/m);
  assert.ok(calls.some(call => call.tool === "fake-kit" && call.args[0] === "wait"));
  assert.match(f.body(), /Tier: docs \(2 files, all docs\)/);
  assert.match(f.body(), /skipped for the docs tier \(CI still runs check, unit tests, lint and browser tests\): npm run check, npm test \(all unit tests\), npm run lint, kit specs --affected, kit review/);
  // The PR text names the second look's model, and says plainly that Claude's review did not run.
  const block = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").find(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /<!-- review-loop -->\nReview: Claude's review skipped \(docs tier\)\.\n\nSecond look by grok-4\.7 \(Grok\)\.\n<!-- \/review-loop -->/);
});

test("a docs-only PR whose second look no model can take says so in its review block", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n", "AGENTS.md": "# Agents\n" }), result = f.run([], { FAKE_SECOND: "skip" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const block = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").find(text => text.includes("<!-- review-loop -->"))!;
  assert.doesNotMatch(block, /Verdict:/);
  assert.match(block, /<!-- review-loop -->\nReview: Claude's review skipped \(docs tier\)\.\n\nsecond look: skipped \(grok-4\.7 out of credit; opencode\/deepseek-v4\.1-flash-free out of credit\)\n<!-- \/review-loop -->/);
});

test("a docs-only PR's review block carries the second look's ledger rows and the verdict when it found something", t => {
  const files = { "docs/guide.md": "# Guide\n", "AGENTS.md": "# Agents\n" };
  const nit = fixture(t, files), merged = nit.run([], { FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:2 P3 a second-look nit.\n" });
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  const block = nit.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").findLast(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /^Review: Claude's review skipped \(docs tier\)\./m);
  assert.match(block, /^Second look by grok-4\.7 \(Grok\)\.$/m);
  assert.match(block, /^Review: Claude's review skipped \(docs tier\)\. Verdict: approved\.$/m);
  assert.match(block, /^\| SL-1 \| nit \| .*a second-look nit\. \|$/m);
  assert.doesNotMatch(block, /Findings ledger: none/);
  const lead = fixture(t, files), waived = lead.run(["--waive", "SL-1: accepted for follow-up"], { ASE_OWNER: "ke-lead", FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(waived.status, 0, waived.stdout + waived.stderr);
  const waivedBlock = lead.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").findLast(text => text.includes("<!-- review-loop -->"))!;
  assert.match(waivedBlock, /Verdict: not approved \(1 open finding waived by the lead\)/);
  assert.match(waivedBlock, /^\| SL-1 \| blocker \| open, waived by the lead \(second look\): .*the second look found this\. \|$/m);
});

test("dry-run on a docs-only change leaves GPT out of the second look's order even with --full", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n" }), result = f.run(["--dry-run", "--full"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: dx \(docs\/guide\.md\) grok-4\.7, else opencode\/deepseek-v4\.1-flash-free$/m);
  assert.doesNotMatch(result.stdout, /^second look: .*gpt-/m);
});

test("dry-run on a docs-only change whose row lists only GPT says there is no model, never a bare line", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n" });
  const only = join(f.dir, "gpt-only.json");
  const row = { order: ["gpt-6.1-sol"], checked: "2026-11-10" };
  writeFileSync(only, JSON.stringify({ kinds: { code: row, ux: row, dx: row, agent: row } }));
  const result = f.run(["--dry-run"], { ASE_SECOND_LOOK: only });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: dx \(docs\/guide\.md\) no model \(GPT never looks at a docs-only change\)$/m);
});

test("dry-run on a prose-only change in a project with no paths.docs leaves GPT out; its checks stay those of code", t => {
  const settings = { project: "techies-playground", branches: { land: "dev" } };
  const f = fixture(t, { "docs/changes/2026-11-15-note.md": "# Note\n" }, {}, { settings }), result = f.run(["--dry-run"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^tier: full /m);
  assert.match(result.stdout, /^second look: code \(docs\/changes\/2026-11-15-note\.md\) grok-4\.7, else opencode\/deepseek-v4\.1-flash-free$/m);
  assert.doesNotMatch(result.stdout, /^second look: .*gpt-/m);
});

test("docs-only for GPT: paths.docs, else a prose file that paths.tests and paths.css leave as code, even beside a paths.docs", () => {
  const change = (...paths: string[]) => paths.map(path => ({ status: "M", path }));
  const tested = { paths: { tests: ["^tests/"] } };
  assert.equal(docsOnly(change("docs/a.md"), tested), true);
  assert.equal(docsOnly(change("tests/README.md"), tested), false);
  assert.equal(docsOnly(change("styles/notes.md"), { paths: { css: ["^styles/"] } }), false);
  assert.equal(docsOnly([{ status: "D", path: "styles/notes.md" }], { paths: { css: ["^styles/"] } }), false);
  assert.equal(docsOnly([], tested), false);
  assert.equal(docsOnly(change("NOTES.MD", "guide.rst", "spec.adoc", "README.markdown"), tested), true);
  // An .mdx file can import components and run code: no docs unless paths.docs says so.
  assert.equal(docsOnly(change("docs/page.mdx"), tested), false);
  // On top of the project's own paths.docs: a prose file outside it still counts.
  const own = { paths: { docs: ["^docs/"] } };
  assert.equal(docsOnly(change("docs/guide.txt", "notes/x.md"), own), true);
  assert.equal(docsOnly(change("notes/x.md", "src/x.ts"), own), false);
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

test("a code PR that also changes a ticket file runs the ticket check, and a code-only PR does not", t => {
  const docs = fixture(t, { "src/app.ts": "export {};\n", "docs/wayfinder/m/tickets/01-x.md": "---\nstatus: closed\n---\n" });
  const withTicket = docs.run(["--no-merge"]);
  assert.equal(withTicket.status, 0, withTicket.stderr); assert.match(withTicket.stdout, /^tier: full \(2 files, src\/app\.ts is code\)$/m);
  assert.deepEqual(docs.calls().filter(call => call.tool === "tickets.mjs").map(call => call.args), [["check", "--closed-since", "origin/dev"]]);
  assert.match(docs.body(), /- node \S*tickets\.mjs check --closed-since origin\/dev: ok/);
  const code = fixture(t, { "src/app.ts": "export {};\n" });
  assert.equal(code.run(["--no-merge"]).status, 0);
  assert.deepEqual(code.calls().filter(call => call.tool === "tickets.mjs"), []);
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
  assert.deepEqual(f.calls().filter(call => call.tool === "tickets.mjs").map(call => [call.script, call.args]), [[join(home, "tickets.mjs"), ["check", "--closed-since", "origin/dev"]]]);
  assert.ok(f.body().includes(`- node ${join(home, "tickets.mjs")} check --closed-since origin/dev: ok`), f.body());
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
    // With the feature list in the project kit ux can run, so this one says why it needs no UX check.
    [{ ...css, "docs/agents/features.md": "# Feature list\n" }, ["--not-visible", "same look"], {}, "Feature list: updated (docs/agents/features.md)"],
    [{ ...css, "ticket.md": done }, ["--ticket", "ticket.md"], {}, "Feature list: no change (token rename only)"],
    [css, ["--waive", "Lead accepts"], { ASE_OWNER: "ke-lead" }, "Feature list: waived (Lead accepts); src/styles/app.css is visible"],
  ] as const) {
    const f = fixture(t, changes), result = f.run(["--no-merge", ...args], overrides);
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /RESULT: ok opened #73/);
    assert.ok(result.stdout.includes(`${line}\n`), result.stdout);
    assert.match(f.body(), new RegExp(`## Tests\\n\\nTier: css \\([^)]*\\)\\n${line.replace(/[()]/g, "\\$&")}\\n`));
  }
});

test("the UX guard: a visible change needs a kit ux result for the files as they are now, or a reason it is not visible", () => {
  const files = { "src/ui/menu.ts": "aaa", "src/styles/app.css": "bbb" };
  const record = { branch: "feature/x", head: "0123456789abcdef", files, list: "fff", ok: true, summary: "2 features tried, 0 scripted findings, 2 fine, 0 looks off, 0 broken", partial: null };
  const guard = (extra: Record<string, unknown> = {}) => uxGuard({ branch: "feature/x", files, record, featureList: "fff", ...extra });
  assert.deepEqual(guard(), { ok: true, line: "UX check: ok (kit ux at 0123456: 2 features tried, 0 scripted findings, 2 fine, 0 looks off, 0 broken)" });
  // Nothing a person sees changed: no line, whatever else is given.
  assert.deepEqual(guard({ files: {}, record: null, notVisible: "reason" }), { ok: true });
  // No result, or another branch's: refused, naming the first visible path and what to do.
  for (const missing of [null, { ...record, branch: "feature/y" }]) {
    const refused = guard({ record: missing });
    assert.equal(refused.ok, false);
    assert.equal(refused.line, "UX check: missing; src/styles/app.css is visible");
    assert.equal(refused.problem, 'visible change without a kit ux result; run `scripts/agents/kit ux`, or pass --not-visible "<reason>" when the change shows a person nothing new');
  }
  // A visible file changed, added or dropped since kit ux ran: the result is out of date, naming the file.
  for (const [now, path] of [[{ ...files, "src/ui/menu.ts": "ccc" }, "src/ui/menu.ts"], [{ ...files, "src/icons.ts": "ddd" }, "src/icons.ts"], [{ "src/ui/menu.ts": "aaa" }, "src/styles/app.css"]] as const) {
    const stale = guard({ files: now });
    assert.deepEqual([stale.ok, stale.line], [false, `UX check: out of date; ${path} changed since kit ux ran at 0123456`]);
    assert.match(stale.problem, /^the visible change is not the one kit ux checked \(.* changed since it ran at 0123456\); run `scripts\/agents\/kit ux` again$/);
  }
  // The listed features that cover the change are not the ones kit ux tried (one added for the new screen, say): out
  // of date too, also for a result that had nothing to try, and for one saved without them.
  for (const old of [record, { ...record, summary: "no listed feature touched", nothing: true }, { ...record, list: undefined }]) {
    const relisted = guard({ record: old, featureList: "eee" });
    assert.deepEqual([relisted.ok, relisted.line], [false, "UX check: out of date; the features in docs/agents/features.md that cover the change are not the ones kit ux tried at 0123456"]);
    assert.equal(relisted.problem, "the features in docs/agents/features.md that cover the change are not the ones kit ux tried at 0123456; run `scripts/agents/kit ux` again");
  }
  // A result that did not pass, or that left the review or some features out, is no pass.
  const failed = guard({ record: { ...record, ok: false, summary: "1 features tried, 0 scripted findings, 0 fine, 0 looks off, 1 broken, broken: F-media-02" } });
  assert.deepEqual([failed.ok, failed.line], [false, "UX check: failed (kit ux at 0123456: 1 features tried, 0 scripted findings, 0 fine, 0 looks off, 1 broken, broken: F-media-02)"]);
  assert.match(failed.problem, /^kit ux did not pass for this change; fix what it found and run `scripts\/agents\/kit ux` again$/);
  for (const partial of ["--no-review", "--features"]) {
    const part = guard({ record: { ...record, partial } });
    assert.deepEqual([part.ok, part.line], [false, `UX check: partial; kit ux ran with ${partial}`]);
    assert.match(part.problem, new RegExp(`^kit ux ran with ${partial}, so it did not check the whole change; run \`scripts/agents/kit ux\` without it$`));
  }
  // Marked not visible with a reason: lands with the reason, with no result, an older one or a partial one.
  const marked = { ok: true, line: "UX check: not visible (token rename only); src/styles/app.css is a visible path" };
  assert.deepEqual(guard({ record: null, notVisible: "token rename\nonly" }), marked);
  assert.deepEqual(guard({ files: { ...files, "src/ui/menu.ts": "ccc" }, record: { ...record, ok: false }, notVisible: "token rename only" }), marked);
  assert.deepEqual(guard({ record: { ...record, partial: "--no-review" }, notVisible: "token rename only" }), marked);
  // But kit ux tried this very change and it did not pass: a person sees it, so no reason lands it.
  const seen = guard({ record: { ...record, ok: false, summary: "1 broken, broken: F-media-02" }, notVisible: "token rename only" });
  assert.deepEqual([seen.ok, seen.line], [false, "UX check: failed (kit ux at 0123456: 1 broken, broken: F-media-02)"]);
  assert.equal(seen.problem, "kit ux tried this change and it did not pass, so --not-visible does not fit it; fix what kit ux found and run `scripts/agents/kit ux` again");
  // A partial run that failed tried it too.
  const part = guard({ record: { ...record, ok: false, partial: "--no-review", summary: "1 broken, broken: F-media-02" }, notVisible: "token rename only" });
  assert.deepEqual([part.ok, part.problem], [false, seen.problem]);
  // A run that failed only because its reviewer did not finish is no verdict on the change: it is refused as it is,
  // but a change that shows a person nothing new may still say so.
  const down = { ...record, ok: false, unfinished: true, summary: "1 features tried, 0 scripted findings, the review did not finish" };
  assert.deepEqual(guard({ record: down }), { ok: false, line: "UX check: did not finish (kit ux at 0123456: 1 features tried, 0 scripted findings, the review did not finish)",
    problem: "kit ux did not finish for this change; run `scripts/agents/kit ux` again" });
  assert.deepEqual(guard({ record: down, notVisible: "token rename only" }), marked);
  // No listed feature covers the change, so kit ux tried nothing: it lands, and the line never says ok.
  assert.deepEqual(guard({ record: { ...record, summary: "no listed feature touched", nothing: true } }),
    { ok: true, line: "UX check: nothing to try (kit ux at 0123456: no feature in docs/agents/features.md covers src/styles/app.css)" });
  // A project with no feature list has nothing kit ux can try: said, never refused.
  assert.deepEqual(guard({ record: null, featureList: null }), { ok: true, line: "UX check: skipped (no docs/agents/features.md, so kit ux has nothing to try); src/styles/app.css is visible" });
});

const visibleChange = { "src/styles/app.css": "a { color: var(--ink); }\n", "docs/agents/features.md": "# Feature list\n" };
/** Saves a kit ux result for the fixture's branch as kit ux would, for the visible files as they are now. */
function uxResult(f: ReturnType<typeof fixture>, fields: Record<string, unknown> = {}) {
  const settings = JSON.parse(readFileSync(join(f.root, "scripts/agents/kit.json"), "utf8"));
  saveUxResult(f.main, { branch: "feature/kit-pr", head: f.git("rev-parse", "HEAD"), files: visibleFiles(f.root, "origin/dev", settings), list: coverageHash(f.root, "origin/dev"), ok: true,
    summary: "1 features tried, 0 scripted findings, 1 fine, 0 looks off, 0 broken", partial: null, ...fields });
}

test("a visible change without a fresh kit ux result stops before checks, push or CI, and says what to run", t => {
  const f = fixture(t, visibleChange);
  const none = f.run();
  assert.equal(none.status, 1);
  assert.ok(none.stdout.includes('RESULT: fail ux: visible change without a kit ux result; run `scripts/agents/kit ux`, or pass --not-visible "<reason>" when the change shows a person nothing new'), none.stdout);
  assert.match(none.stdout, /^UX check: missing; src\/styles\/app\.css is visible$/m);
  assert.equal(f.calls().some(call => call.tool !== "fake-kit" || call.args[0] !== "deps"), false);
  assert.equal(f.gitAt(f.origin, "branch", "--list", "feature/kit-pr"), "");
  // A result for the files as they were, a failed one and one without the review are refused too.
  uxResult(f);
  f.commit("Restyle", "src/styles/app.css", "a { color: var(--accent); }\n");
  const stale = f.run();
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /RESULT: fail ux: the visible change is not the one kit ux checked \(src\/styles\/app\.css changed since it ran at [0-9a-f]{7}\); run `scripts\/agents\/kit ux` again$/m);
  uxResult(f, { partial: "--no-review" });
  assert.match(f.run().stdout, /RESULT: fail ux: kit ux ran with --no-review, so it did not check the whole change; run `scripts\/agents\/kit ux` without it$/m);
  uxResult(f, { ok: false, summary: "1 features tried, 0 scripted findings, 0 fine, 0 looks off, 1 broken, broken: F-media-02" });
  assert.match(f.run().stdout, /RESULT: fail ux: kit ux did not pass for this change; fix what it found and run `scripts\/agents\/kit ux` again$/m);
  // A partial run after that leaves the whole run's failed result in place, so --not-visible cannot land it.
  uxResult(f, { partial: "--no-review" });
  assert.match(f.run().stdout, /RESULT: fail ux: kit ux did not pass for this change; fix what it found and run `scripts\/agents\/kit ux` again$/m);
  assert.match(f.run(["--not-visible", "nobody will notice"]).stdout, /RESULT: fail ux: kit ux tried this change and it did not pass, so --not-visible does not fit it; /);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
});

test("a visible change lands with a fresh kit ux result or a reason it is not visible, and the PR body says which", t => {
  const checked = fixture(t, visibleChange);
  uxResult(checked);
  const head = checked.head.slice(0, 7);
  const landed = checked.run(["--no-merge"]);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  const line = `UX check: ok (kit ux at ${head}: 1 features tried, 0 scripted findings, 1 fine, 0 looks off, 0 broken)`;
  assert.ok(landed.stdout.includes(`${line}\n`), landed.stdout);
  assert.ok(checked.body().includes(`Feature list: updated (docs/agents/features.md)\n${line}\n`), checked.body());
  // A commit that changes nothing a person sees keeps the result fresh.
  checked.commit("Notes", "docs/notes.md", "notes\n");
  assert.equal(checked.run(["--no-merge"]).status, 0);
  // A result with nothing to try goes out of date once the feature list gains a feature that covers the change.
  uxResult(checked, { summary: "no listed feature touched", nothing: true });
  const untried = checked.run(["--no-merge"]);
  assert.equal(untried.status, 0, untried.stdout + untried.stderr);
  assert.match(untried.stdout, /^UX check: nothing to try \(kit ux at [0-9a-f]{7}: no feature in docs\/agents\/features\.md covers src\/styles\/app\.css\)$/m);
  checked.commit("List the sheet", "docs/agents/features.md", "# Feature list\n\n### F-style-01 Sheet\n- Try: Open it.\n- Good: Calm.\n- Files: `src/styles/app.css`\n");
  const listed = checked.run(["--no-merge"]);
  assert.equal(listed.status, 1);
  assert.match(listed.stdout, /^UX check: out of date; the features in docs\/agents\/features\.md that cover the change are not the ones kit ux tried at [0-9a-f]{7}$/m);
  assert.match(listed.stdout, /RESULT: fail ux: the features in docs\/agents\/features\.md that cover the change are not the ones kit ux tried at [0-9a-f]{7}; run `scripts\/agents\/kit ux` again$/m);
  // Marked not visible: any owner may say so, with a reason; without one the option is refused.
  const marked = fixture(t, visibleChange);
  const reasoned = marked.run(["--no-merge", "--not-visible", "token rename only"]);
  assert.equal(reasoned.status, 0, reasoned.stdout + reasoned.stderr);
  assert.ok(marked.body().includes("UX check: not visible (token rename only); src/styles/app.css is a visible path\n"), marked.body());
  const bare = marked.run(["--not-visible"]);
  assert.equal(bare.status, 2); assert.match(bare.stdout, /RESULT: fail invalid arguments: --not-visible requires a value/);
  // A project with no feature list for kit ux says the check was skipped, and lands.
  const plain = fixture(t, { "src/styles/app.css": "a { color: var(--ink); }\n" }, { featureList: undefined });
  const skipped = plain.run(["--no-merge"]);
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.ok(plain.body().includes("UX check: skipped (no docs/agents/features.md, so kit ux has nothing to try); src/styles/app.css is visible\n"), plain.body());
  // A release carries what each PR already passed on its way into dev, so the option has no use there.
  const release = fixture(t, visibleChange);
  const cut = release.run(["--release", "--base", "main"]);
  assert.equal(cut.status, 0, cut.stdout + cut.stderr);
  assert.doesNotMatch(cut.stdout + release.body(), /UX check:/);
  const both = release.run(["--release", "--base", "main", "--not-visible", "same look"]);
  assert.equal(both.status, 2); assert.match(both.stdout, /RESULT: fail invalid arguments: --not-visible has no use with --release: a release carries what each PR already passed/);
});

test("a rebase that brings a feature-list edit about other features keeps the kit ux result; one to a feature that covers the change does not", t => {
  const entry = (id: string, file: string, how = "Open it.") => `### ${id} Name\n- Try: ${how}\n- Good: Calm.\n- Files: \`${file}\`\n\n`;
  // F-style-01 covers the stylesheet the branch changes, so the saved result holds one covering feature.
  const list = (top: string, end: string, how?: string) => `# Feature list\n\n${top}${entry("F-style-01", "src/styles/app.css", how)}\n\n\n\n\n## Notes\n\n${end}\n`;
  for (const [edited, covers] of [[list(entry("F-other-01", "src/other.ts"), "End."), false], [list("", "End.", "Open it twice."), true]] as const) {
    const f = fixture(t), peer = f.peer();
    // The base holds the feature list; the branch changes the stylesheet and a line at the list's end, and kit ux checks that.
    mkdirSync(join(peer, "docs/agents"), { recursive: true });
    writeFileSync(join(peer, "docs/agents/features.md"), list("", "End."));
    f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-qm", "base list"); f.gitAt(peer, "push", "-q", "origin", "dev");
    f.git("fetch", "-q", "origin"); f.git("rebase", "-q", "origin/dev");
    mkdirSync(join(f.root, "src/styles"), { recursive: true });
    f.commit("Sheet", "src/styles/app.css", "a { color: var(--ink); }\n");
    f.commit("List note", "docs/agents/features.md", list("", "End of the list."));
    uxResult(f);
    // Another visible PR lands first and edits the list near its top; kit pr's own rebase brings that edit in.
    writeFileSync(join(peer, "docs/agents/features.md"), edited);
    f.gitAt(peer, "commit", "-qam", "another PR's list edit"); f.gitAt(peer, "push", "-q", "origin", "dev");
    const result = f.run(["--no-merge"]);
    assert.equal(readFileSync(join(f.root, "docs/agents/features.md"), "utf8"), edited.replace("End.", "End of the list."));
    if (covers) {
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stdout, /^UX check: out of date; the features in docs\/agents\/features\.md that cover the change are not the ones kit ux tried at [0-9a-f]{7}$/m);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /^UX check: ok \(kit ux at [0-9a-f]{7}: /m);
    }
  }
});

test("a visible file the branch deletes counts as checked once kit ux saw it gone, and a failed result is not talked away", t => {
  const f = fixture(t), peer = f.peer();
  mkdirSync(join(peer, "src/styles"), { recursive: true });
  writeFileSync(join(peer, "src/styles/app.css"), "a { color: var(--ink); }\n");
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-qm", "base sheet"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.git("fetch", "-q", "origin"); f.git("rebase", "-q", "origin/dev");
  mkdirSync(join(f.root, "docs/agents"), { recursive: true });
  f.commit("Feature list", "docs/agents/features.md", "# Feature list\n");
  f.git("rm", "-q", "src/styles/app.css"); f.git("commit", "-qm", "Drop the sheet");
  uxResult(f);
  const gone = f.run(["--no-merge"]);
  assert.equal(gone.status, 0, gone.stdout + gone.stderr);
  assert.ok(f.body().includes("UX check: ok (kit ux at "), f.body());
  // kit ux tried this very change and called it broken: --not-visible is refused, before any check or push.
  uxResult(f, { ok: false, summary: "1 features tried, 0 scripted findings, 0 fine, 0 looks off, 1 broken, broken: F-media-02" });
  const calls = f.calls().length;
  const refused = f.run(["--no-merge", "--not-visible", "nobody will notice"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /RESULT: fail ux: kit ux tried this change and it did not pass, so --not-visible does not fit it; fix what kit ux found and run `scripts\/agents\/kit ux` again$/m);
  assert.equal(f.calls().slice(calls).some(call => call.tool === "gh" || call.tool === "npm"), false);
});

test("a behind retry whose rebase changes a visible file kit ux checked stops before the new head is pushed", t => {
  const f = fixture(t), peer = f.peer();
  // The base holds the stylesheet; the branch changes its first line and kit ux checks that.
  const sheet = (first: string, last: string) => `a { color: ${first}; }\n\n\n\n\n\n\nz { color: ${last}; }\n`;
  mkdirSync(join(peer, "src/styles"), { recursive: true });
  writeFileSync(join(peer, "src/styles/app.css"), sheet("var(--ink)", "var(--ink)"));
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-qm", "base sheet"); f.gitAt(peer, "push", "-q", "origin", "dev");
  f.git("fetch", "-q", "origin"); f.git("rebase", "-q", "origin/dev");
  mkdirSync(join(f.root, "docs/agents"), { recursive: true });
  f.commit("Feature list", "docs/agents/features.md", "# Feature list\n");
  f.commit("Restyle", "src/styles/app.css", sheet("var(--accent)", "var(--ink)"));
  uxResult(f);
  // While the PR waits, the base changes the same stylesheet on its last line: the rebase merges it in without a
  // conflict, so the file a person sees is no longer the one kit ux checked.
  const moved = join(f.dir, "moved.sh");
  writeFileSync(moved, `#!/bin/sh\nset -e\ncd "${peer}"\nprintf '${sheet("var(--ink)", "var(--muted)").replace(/\n/g, "\\n")}' > src/styles/app.css\ngit commit -qam "base restyle"\ngit push -q origin dev\n`);
  chmodSync(moved, 0o755);
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_AFTER_PUSH: moved });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail ux: the visible change is not the one kit ux checked \(src\/styles\/app\.css changed since it ran at [0-9a-f]{7}\); run `scripts\/agents\/kit ux` again$/m);
  assert.equal(readFileSync(join(f.root, "src/styles/app.css"), "utf8"), sheet("var(--accent)", "var(--muted)"));
  // The head pushed before the merge was refused stays on the PR branch.
  assert.notEqual(f.gitAt(f.origin, "rev-parse", "refs/heads/feature/kit-pr"), f.git("rev-parse", "HEAD"));
  assert.equal(f.ghCalls("merge").length, 1);
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
  const merged = both.run(["--waive", "1 finding: Lead accepts"], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report, FAKE_QUEUE: "1" });
  assert.equal(merged.status, 0, merged.stdout + merged.stderr); assert.match(merged.stdout, /RESULT: ok queued #73/);
  assert.equal(both.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings and without a feature-list update: 1 finding: Lead accepts");
  assert.equal(JSON.parse(readFileSync(join(both.main, ".scratch/scoreboard/_untracked/feature%2Fkit-pr.json"), "utf8")).landed.waived, "1 finding: Lead accepts");
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

for (const pending of [false, true]) test(`a should (P2) still blocks with only two completed rounds (pending=${pending})`, t => {
  const f = fixture(t);
  f.rounds(pending ? 3 : 2, pending ? 3 : undefined);
  const report = cleanReview.replace("Spec: none.", "Spec: P2: Real minor defect.");
  f.saveReview(report);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  assert.equal(f.ghCalls("merge").length, 0);
  assert.equal(f.calls().some(call => call.args[0] === "wait"), false);
});

// Review loop, nits: a review that returns only nits needs no fix round and does not block, whatever the round count.
for (const rounds of [0, 2]) test(`a review with only nits (a P3 and a validation gap) lands, with the nits as follow-ups (${rounds} rounds)`, t => {
  const f = fixture(t);
  if (rounds) f.rounds(rounds);
  const report = cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect.").replace("Validation gaps: none.", "Validation gaps: Add coverage.");
  f.saveReview(report);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /review: 2 follow-ups \(nits only\) \(non-blocking\)/);
  assert.equal(f.ghCalls("merge").length, 1);
});

// TOOLS-360 second look: a release's review that commits follow-ups to a tracked ticket moves the cut past origin/dev,
// so the line it prints cuts it again first, and run as written lands the same PR with the follow-ups written again.
test("a release whose review commits follow-ups to its tracked ticket names the re-cut, and the line run as written lands the same PR", t => {
  const f = fixture(t), real = { FAKE_RELEASE_CHECK: resolve("kit.d/release-check"), FAKE_BASE: "main" }, peer = f.peer();
  const nits = cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect.");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt");
  f.commit("Close ticket", "ticket.md", '---\ntitle: "Ticket title"\n---\n\n## Done (2026-11-19)\n\nImplemented.\n');
  f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  const start = f.git("rev-parse", "HEAD");
  const opened = f.run(["--base", "main", "--release", "--no-merge", "--ticket", "ticket.md"], { ...real, FAKE_REVIEW: nits });
  assert.equal(opened.status, 0, opened.stdout + opened.stderr);
  assert.notEqual(f.git("rev-parse", "HEAD"), start, "the follow-ups commit moved the cut");
  assert.match(f.git("show", "HEAD:ticket.md"), /### Follow-ups/);
  assert.match(opened.stdout, new RegExp(`^merge: land it with git reset --keep ${start} && kit pr --base main --release --ticket ticket\\.md \\(a merge commit, never merged by hand\\)$`, "m"));
  // The line as written, at once: its reset first (kit's follow-ups commit leaves the ticket's index entry fresh), then kit pr.
  const recut = opened.stdout.match(/^merge: land it with git reset --keep ([a-f0-9]{40}) && /m);
  assert.ok(recut, opened.stdout);
  f.git("reset", "-q", "--keep", recut[1]);
  const created = f.ghCalls("create").length;
  const landed = f.run(rerunWords(opened.stdout), { ...real, FAKE_REVIEW: nits, FAKE_EXISTING: "1", FAKE_LAND_MERGE: peer });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.doesNotMatch(landed.stdout, /RESULT: fail release-check/);
  assert.equal(f.ghCalls("create").length, created, "the open PR is reused, not opened again");
  assert.match(f.git("show", "HEAD:ticket.md"), /### Follow-ups/, "the rerun writes the follow-ups again");
  assert.match(landed.stdout, /RESULT: ok merged #73 [a-f0-9]{7}$/m);
});

// TOOLS-337: kit brief writes briefs into the ignored .scratch folder, and kit pr --ticket takes them; a ticket git ignores
// is no file of the repo, so its follow-ups note is written there and no commit is made for it.
test("follow-ups for a --ticket file in an ignored folder are written into it, with no commit, and the PR goes on", t => {
  const f = fixture(t);
  const brief = ".scratch/briefs/TOOLS-1.md", ticket = '---\ntitle: "Brief title"\n---\n\n## Done (2026-11-19)\n\nImplemented.\n';
  mkdirSync(join(f.root, ".scratch/briefs"), { recursive: true }); writeFileSync(join(f.root, brief), ticket);
  f.rounds(3);
  const reviewed = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", brief], { FAKE_REVIEW: minorReview });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /RESULT: fail/);
  assert.match(result.stdout, /review: 2 follow-ups after 3 fix rounds \(non-blocking\)/);
  assert.match(result.stdout, /^follow-ups: \.scratch\/briefs\/TOOLS-1\.md is ignored by git, so its follow-ups note is written there and not committed$/m);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.equal(f.git("rev-parse", "HEAD"), reviewed, "no commit is made for an ignored ticket");
  assert.match(readFileSync(join(f.root, brief), "utf8"), /### Follow-ups\n\n- Spec \(P2\): P2: Minor defect.\n- Validation gaps \(gap\): Add coverage./);
  const summary = "Follow-ups (non-blocking after 3 fix rounds):\n- Spec (P2): P2: Minor defect.\n- Validation gaps (gap): Add coverage.";
  assert.equal(f.ghCalls("comment").filter(call => call.body === summary).length, 1, "the PR holds the follow-ups");
  assert.equal(f.git("ls-files", "--", brief), "", "the brief stays out of the repo");
});

// A brief kit brief wrote in another checkout (the lead's main one) lies outside the repo kit pr runs in (TOOLS-337, producer #25).
test("follow-ups for a --ticket file outside the repo are written into it, with no commit, and the PR goes on", t => {
  const f = fixture(t);
  const brief = join(f.main, ".scratch/kit-briefs/TOOLS-1-build.md"), ticket = '---\ntitle: "Brief title"\n---\n\n## Done (2026-11-19)\n\nImplemented.\n';
  mkdirSync(dirname(brief), { recursive: true }); writeFileSync(brief, ticket);
  f.rounds(3);
  const reviewed = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", brief], { FAKE_REVIEW: minorReview });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^follow-ups: ${brief.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is outside the repo, so its follow-ups note is written there and not committed$`, "m"));
  assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.equal(f.git("rev-parse", "HEAD"), reviewed, "no commit is made for a ticket outside the repo");
  assert.match(readFileSync(brief, "utf8"), /### Follow-ups\n\n- Spec \(P2\): P2: Minor defect.\n- Validation gaps \(gap\): Add coverage./);
});

// git check-ignore itself fails (exit 128) for a path through a symlinked folder: kit pr cannot tell whether the ticket is
// a repo file, so it stops and names why instead of guessing, and makes no follow-ups commit.
test("a --ticket file through a symlinked folder, which git check-ignore cannot judge, stops the run with no commit", t => {
  const f = fixture(t);
  const outside = tempOutsideGit("kit-pr-linked-");
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "ticket.md"), '---\ntitle: "Linked title"\n---\n\n## Done (2026-11-19)\n\nImplemented.\n');
  symlinkSync(outside, join(f.root, "linked"));
  f.git("add", "linked"); f.git("commit", "-q", "-m", "Link a folder");
  f.rounds(3);
  const reviewed = f.git("rev-parse", "HEAD");
  const result = f.run(["--ticket", "linked/ticket.md"], { FAKE_REVIEW: minorReview });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail .*could not tell whether git ignores linked\/ticket\.md: .+$/m);
  assert.equal(f.git("rev-parse", "HEAD"), reviewed, "no follow-ups commit is made");
});

test("a --ticket file git ignores whose Done names its commits gets no commit for them, and the PR goes on", t => {
  const f = fixture(t);
  const brief = ".scratch/briefs/TOOLS-1.md", ticket = '---\ntitle: "Brief title"\n---\n\n## Done (2026-11-19)\n\nCommits: none.\n';
  mkdirSync(join(f.root, ".scratch/briefs"), { recursive: true }); writeFileSync(join(f.root, brief), ticket);
  const head = f.git("rev-parse", "HEAD"), result = f.run(["--ticket", brief, "--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^commits: \.scratch\/briefs\/TOOLS-1\.md is ignored by git, so no commit names its commits$/m);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(readFileSync(join(f.root, brief), "utf8"), ticket);
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
  const result = f.run(["--waive", "1 finding: Lead accepts risk"], { ASE_OWNER: "ke-lead", FAKE_REVIEW: report });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings: 1 finding: Lead accepts risk");
  const body = f.apiCalls().at(-1)?.body || "";
  assert.match(body, /Follow-ups \(non-blocking after 3 fix rounds\):/);
  assert.match(body, /merged with 1 waived findings: 1 finding: Lead accepts risk/);
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

for (const phase of ["stage-before", "stage-after", "commit-before"]) for (const change of ["branch", "HEAD", "unrelated edit"])
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
      {
        const wrapper = join(f.bin, "git");
        writeFileSync(wrapper, `#!/usr/bin/env node
${hold}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const staging = args.includes("add");
(async () => {
  if (staging && process.env.FAKE_HOLD_PHASE === "stage-before") await hold();
  if (args.includes("commit") && process.env.FAKE_HOLD_PHASE === "commit-before") await hold();
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


test("a concurrent git add cannot publish non-ticket paths from the private follow-up index", t => {
  const f = fixture(t); f.rounds(3); f.saveReview(minorReview);
  // Just before the follow-ups commit, something stages another file in the index that commit uses.
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  gitAround(f.bin, "commit", { before: `printf "hook's unrelated edit\\n" > file.txt && ${realGit} add -- file.txt` });
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

test("dry-run names the second look's kind, its deciding path, its models in order, and its command", t => {
  // A visible change carries its feature-list line in a changed ticket: UX still comes before that DX path.
  const done = '---\ntitle: "Ticket title"\n---\n\n## Done\n\nFeature list: no change (test)\n';
  for (const [file, kind, extra] of [["docs/guide.md", "dx"], ["docs/agents/runner.md", "agent"], ["src/ui/panel.ts", "ux", { "ticket.md": done }], ["src/x.ts", "code"]] as const) {
    const f = fixture(t, { [file]: "x\n", ...extra }), result = f.run(["--dry-run", "--ticket", "ticket.md"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    // GPT never looks at a docs-only change, so a docs-only plan leaves it out of the order it prints.
    const order = /^docs\//.test(file) ? table[kind].order.filter((model: string) => !model.startsWith("gpt-")) : table[kind].order;
    assert.match(result.stdout, new RegExp(`^second look: ${kind} \\(${file.replaceAll(".", "\\.")}\\) ${order.join(", else ").replaceAll(".", "\\.")}$`, "m"), file);
    if (/^docs\//.test(file)) assert.doesNotMatch(result.stdout, /^second look: .*gpt-/m, file);
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

test("a no-code PR whose diff is empty lands: kit review skips as nothing to review, and the PR says so", t => {
  const f = fixture(t), result = f.run([], { FAKE_EMPTY: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^review: skipped \(nothing to review: git diff base\.\.\.HEAD is empty\)$/m);
  assert.match(result.stdout, /^second look: skipped \(nothing to review: git diff base\.\.\.HEAD is empty\)$/m);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  const block = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").find(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /<!-- review-loop -->\nReview: nothing to review \(the diff against dev is empty\)\.\n\nsecond look: skipped \(nothing to review: git diff base\.\.\.HEAD is empty\)\n<!-- \/review-loop -->/);
});

test("review-run.mjs's own review and second look, called in kit pr's process, skip a no-code change and the PR lands", t => {
  const f = fixture(t);
  // No override: kit pr calls the real review and second look; the branch's commits add feature.txt and take it out again.
  writeFileSync(join(f.bin, "real-calls.mjs"), "export {};\n");
  f.git("rm", "-q", "feature.txt"); f.git("commit", "-q", "-m", "Take the change out");
  // Should the scope ever not be empty, no real reviewer runs: the CLIs fail at once, in a temporary HOME.
  for (const cli of ["claude", "codex", "opencode"]) { writeFileSync(join(f.bin, cli), "#!/bin/sh\necho 'a reviewer CLI ran' >&2\nexit 1\n"); chmodSync(join(f.bin, cli), 0o755); }
  const home = join(f.dir, "home");
  mkdirSync(home);
  // Set last, as in the release check's test: the review's and second look's git calls run with the key lock's settings.
  const marker = join(f.dir, "monitor-ran.txt"), monitor = join(f.dir, "monitor.sh");
  writeFileSync(monitor, `#!/bin/sh\necho ran >> ${JSON.stringify(marker)}\n`); chmodSync(monitor, 0o755);
  writeFileSync(join(f.root, ".git/config"), `${readFileSync(join(f.root, ".git/config"), "utf8")}[core]\n\tfsmonitor = ${monitor}\n`);
  const result = f.run([], { KIT_PR_CALLS: join(f.bin, "real-calls.mjs"), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), XDG_CACHE_HOME: join(home, ".cache") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const empty = `git diff ${f.git("merge-base", "origin/dev", "HEAD")}...HEAD is empty`;
  assert.ok(result.stdout.includes(`\nreview: skipped (nothing to review: ${empty})\n`), result.stdout);
  assert.ok(result.stdout.includes(`\nsecond look: skipped (nothing to review: ${empty})\n`), result.stdout);
  assert.match(result.stdout, /RESULT: ok merged #73/);
  assert.match(readFileSync(join(f.logDir(), "review.log"), "utf8"), /RESULT: skip review nothing to review/);
  assert.equal(existsSync(marker), false, existsSync(marker) ? readFileSync(marker, "utf8") : "");
});

test("a skipped second look is written into the PR's review block, so the PR never reads as double-checked", t => {
  const f = fixture(t);
  const path = f.saveReview(cleanReview);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  assert.equal(f.run([], { FAKE_SECOND: "skip" }).status, 0);
  const block = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").find(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /Verdict: approved\n\nsecond look: skipped \(grok-4\.7 out of credit; opencode\/deepseek-v4\.1-flash-free out of credit\)\n\nFindings ledger: none\./);
  // The second look ran in kit pr's process: its log keeps its notes and kit review's RESULT line.
  assert.match(readFileSync(join(f.logDir(), "second-look.log"), "utf8"), /second look: skipped \([^\n]+\)\nRESULT: skip second look \([^\n]+\)\n$/);
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
const lockHeld = (f: ReturnType<typeof fixture>, name: string) => {
  const lock = join(f.env.XDG_STATE_HOME!, `agent-kit/${name}.lock`);
  return existsSync(lock) && spawnSync("flock", ["-n", lock, "true"]).status !== 0;
};

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
  for (const lock of ["browser-run", "quiet"]) assert.equal(lockHeld(f, lock), false, lock);
});

test("a spec file that fails alone too fails the run, and nothing is logged as flaky", t => {
  const f = fixture(t), files = [spec("a"), spec("b")];
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, always: [files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev"], ["specs", files[1]]]);
  assert.match(result.stdout, /RESULT: fail specs: 1 spec file failed: tests\/native-save\/b\.spec\.ts \(failed alone too\)$/m);
  assert.equal(f.ghCalls("create").length, 0);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl")), false);
  for (const lock of ["browser-run", "quiet"]) assert.equal(lockHeld(f, lock), false, lock);
});

test("a spec file the change touches is never forgiven: it must pass in the full run", t => {
  const f = fixture(t, { [spec("b")]: "// changed\n" }), files = [spec("a"), spec("b")];
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, full: [files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev"]]);
  assert.match(result.stdout, /RESULT: fail specs: 1 spec file failed: tests\/native-save\/b\.spec\.ts \(this change touches it\)$/m);
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
  // The selection is listed before the full-run lock, so a change with nothing to run never waits.
  assert.deepEqual(specs.map(call => [call.full, call.quiet]), [[false, false], [true, false], [true, true], [true, true]]);
  const body = f.body();
  for (const line of ["- kit specs <2 affected files without the timing ones>: RESULT: ok specs 2/2 passed",
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

// A lock holder made the way kitMachineLock holds one: flock with the file saying "<pid> <owner>".
function lockHolder(t: TestContext, f: ReturnType<typeof fixture>, name: string, seconds: string) {
  const lock = join(f.env.XDG_STATE_HOME!, `agent-kit/${name}.lock`);
  mkdirSync(join(lock, ".."), { recursive: true });
  const holder = spawn("flock", ["-o", "-x", lock, "sleep", seconds]);
  t.after(() => { holder.kill(); });
  for (let i = 0; i < 200 && !lockHeld(f, name); i++) spawnSync("sleep", ["0.02"]);
  writeFileSync(lock, `${holder.pid} ke-60\n`);
  // A holder that ended is a zombie (Z) while spawnSync holds this test.
  return () => readFileSync(`/proc/${holder.pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[0];
}

test("two full browser runs at once: the second waits for the first, saying whose run it waits for", t => {
  const f = fixture(t), state = lockHolder(t, f, "browser-run", "2");
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files: [spec("a")] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.match(/^specs: waiting for ke-60's full browser run$/gm)?.length, 1, result.stdout);
  assert.equal(state(), "Z", "the run went on only after the first one ended");
  assert.equal(specsCalls(f).length, 1);
});

test("with a timing list, a change that selects no spec file takes no lock and waits for nobody", t => {
  const f = fixture(t, undefined, { timing: ["native-edit-latency"] }), state = lockHolder(t, f, "browser-run", "5");
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files: [] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /waiting for/);
  assert.notEqual(state(), "Z");
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev", "--list"]]);
  assert.ok(f.body().includes("- kit specs --affected --base origin/dev: RESULT: ok specs 0 selected (list only)"), f.body());
});

test("a run that broke part way is never forgiven, even when its one named failure passes alone", t => {
  for (const timing of [undefined, ["native-edit-latency"]]) {
    const f = fixture(t, undefined, timing ? { timing } : {}), files = [spec("a"), spec("b")];
    const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, full: [files[1]], crash: true }) });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /RESULT: fail specs: /);
    assert.equal(specsCalls(f).filter(call => call.args.length === 2).length, 0, "no lone rerun");
    assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl")), false);
    assert.equal(f.ghCalls("create").length, 0);
  }
});

test("a timing file that fails alone and passes its rerun is flaky; a touched one that fails is not rerun", t => {
  const files = [spec("a"), spec("native-edit-latency")];
  const f = fixture(t, undefined, { timing: ["native-edit-latency"] });
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files, once: [files[1]] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args).slice(1), [["specs", files[0]], ["specs", files[1]], ["specs", files[1]]]);
  assert.match(f.body(), /^- flaky under load: tests\/native-save\/native-edit-latency\.spec\.ts \(failed in its timing run, passed alone\)$/m);
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7} \(flaky under load: tests\/native-save\/native-edit-latency\.spec\.ts\)$/m);
  assert.equal(readFileSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl"), "utf8").trim().split("\n").length, 1);
  const touched = fixture(t, { [files[1]]: "// changed\n" }, { timing: ["native-edit-latency"] });
  const refused = touched.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files, once: [files[1]] }) });
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /RESULT: fail specs: 1 spec file failed: tests\/native-save\/native-edit-latency\.spec\.ts \(this change touches it\)$/m);
  assert.deepEqual(specsCalls(touched).map(call => call.args).slice(1), [["specs", files[0]], ["specs", files[1]]]);
});

test("a lone rerun waits for another run's quiet lock, saying whose lone run it waits for", t => {
  const f = fixture(t), files = [spec("a"), spec("b")], state = lockHolder(t, f, "quiet", "2");
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { FAKE_SPECS: JSON.stringify({ files, full: [files[1]] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.match(/^specs: waiting for ke-60's lone browser run$/gm)?.length, 1, result.stdout);
  assert.equal(state(), "Z");
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev"], ["specs", files[1]]]);
});

test("once a touched file failed, the untouched failures and the timing files are not run alone", t => {
  const files = [spec("a"), spec("b"), spec("native-edit-latency")];
  const f = fixture(t, { [files[1]]: "// changed\n" }, { timing: ["native-edit-latency"] });
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, full: [files[0], files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args).slice(1), [["specs", files[0], files[1]]]);
  assert.match(result.stdout, /RESULT: fail specs: 3 spec files failed: tests\/native-save\/b\.spec\.ts \(this change touches it\), tests\/native-save\/a\.spec\.ts \(not rerun\), tests\/native-save\/native-edit-latency\.spec\.ts \(timing, not run\)$/m);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl")), false);
});

test("a --list that names no files without saying none were selected fails the specs step", t => {
  const f = fixture(t, undefined, { timing: ["native-edit-latency"] });
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files: [spec("a"), spec("b")], listBlank: true }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail specs: kit specs --list named no spec files and did not say none were selected \(RESULT: ok specs 2 selected \(list only\)\)$/m);
  assert.equal(specsCalls(f).length, 1);
});

test("a lone rerun that passes without reporting its file counts as failed alone too", t => {
  const f = fixture(t), files = [spec("a"), spec("b")];
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, full: [files[1]], silent: [files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail specs: 1 spec file failed: tests\/native-save\/b\.spec\.ts \(failed alone too\)$/m);
  assert.equal(existsSync(join(f.env.XDG_STATE_HOME!, "agent-kit/flaky.jsonl")), false);
});

test("a touched timing file that fails stops the timing files after it from running alone", t => {
  const files = [spec("a"), spec("native-edit-latency"), spec("native-boot-memory")];
  const f = fixture(t, { [files[1]]: "// changed\n" }, { timing: ["native-edit-latency", "native-boot-memory"] });
  const result = f.run(["--ticket", "ticket.md"], { FAKE_SPECS: JSON.stringify({ files, once: [files[1]] }) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(specsCalls(f).map(call => call.args).slice(1), [["specs", files[0]], ["specs", files[1]]]);
  assert.match(result.stdout, /RESULT: fail specs: 2 spec files failed: tests\/native-save\/native-edit-latency\.spec\.ts \(this change touches it\), tests\/native-save\/native-boot-memory\.spec\.ts \(timing, not run\)$/m);
});

test("a machine without flock runs the browser specs unlocked and says so", t => {
  const f = fixture(t), files = [spec("a"), spec("b")];
  const result = f.run(["--ticket", "ticket.md", "--no-merge"], { KIT_FLOCK: join(f.dir, "no-flock"), FAKE_SPECS: JSON.stringify({ files, full: [files[1]] }) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout.match(/^specs: problem: flock is not installed, so browser runs are not kept one at a time \(install util-linux\)$/gm)?.length, 1, result.stdout);
  assert.deepEqual(specsCalls(f).map(call => call.args), [["specs", "--affected", "--base", "origin/dev"], ["specs", files[1]]]);
  assert.match(f.body(), /^- problem: flock is not installed, so browser runs are not kept one at a time \(install util-linux\)$/m);
  assert.match(result.stdout, /RESULT: ok opened #73 [a-f0-9]{7} \(flaky under load: tests\/native-save\/b\.spec\.ts\)$/m);
});

// The review loop: the budget follows the risk, running out is reported, and the PR says how it was reviewed.
test("a risky change (a path named auth) gets 5 fix rounds: a should still blocks after 3, and lands as a follow-up after 5", t => {
  const should = cleanReview.replace("Spec: none.", "Spec: P2: Real minor defect.");
  const three = fixture(t, { "src/auth/login.ts": "export const login = 1;\n" });
  three.rounds(3); three.saveReview(should);
  const blocked = three.run();
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /^review loop: risky change \(path src\/auth\/login\.ts\): up to 5 fix rounds$/m);
  assert.match(blocked.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  const five = fixture(t, { "src/auth/login.ts": "export const login = 1;\n" });
  five.rounds(5); five.saveReview(should);
  const landed = five.run();
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /review: 1 follow-ups after 5 fix rounds \(non-blocking\)/);
  // An ordinary change with the same finding after 3 rounds lands as a follow-up.
  const plain = fixture(t);
  plain.rounds(3); plain.saveReview(should);
  const ordinary = plain.run();
  assert.equal(ordinary.status, 0, ordinary.stdout + ordinary.stderr);
  assert.doesNotMatch(ordinary.stdout, /review loop: risky change/);
});

test("out of budget with a blocker left is reported for Lex and never approved", t => {
  const f = fixture(t);
  f.rounds(3); f.saveReview(cleanReview.replace("Spec: none.", "Spec: P1: Real wrong behaviour."));
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Review budget used: 3 of 3 fix rounds, 1 open finding\. Running out of budget is not approval; Lex decides\.$/m);
  assert.doesNotMatch(result.stdout, /Verdict: approved/);
});

test("the PR says how it was reviewed: the line and the findings ledger from the reviews' own evidence", t => {
  const f = fixture(t);
  const path = f.saveReview(cleanReview);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Reviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: approved$/m);
  const patch = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body).find(text => text?.includes("Reviewed with review-loop"));
  assert.ok(patch?.includes("Reviewed with review-loop: 1 round with claude-opus-5-5. Verdict: approved\n\nSecond look by grok-4.7 (Grok).\n\nFindings ledger: none."), patch);
});

test("the PR names the model that took the second look in plain words: GPT through Codex", t => {
  const f = fixture(t);
  const path = f.saveReview(cleanReview);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  const result = f.run([], { FAKE_SECOND_MODEL: "gpt-6.1-sol" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: code \(feature\.txt\) gpt-6\.1-sol$/m);
  const block = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").find(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /Verdict: approved\n\nSecond look by gpt-6\.1-sol \(GPT through Codex\)\.\n\nFindings ledger: none\./);
});

test("a reused second look names its own model in the PR", t => {
  const f = fixture(t), folder = join(f.main, ".scratch/reviews/ak-14/20261019T110000Z");
  const path = f.saveReview(cleanReview);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "refs.txt"), `${f.head}\n${f.git("merge-base", "origin/dev", "HEAD")}\n`);
  writeFileSync(join(folder, "result.md"), cleanReview);
  writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model: "gpt-6.1-sol", ok: true }));
  const result = f.run(["--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`second look: reused (${folder})`), result.stdout);
  const block = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "").find(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /Second look by gpt-6\.1-sol \(GPT through Codex\)\./);
});

test("a later review that marks an earlier id \"still open\" and finds nothing new does not land and is never approved", t => {
  const f = fixture(t);
  const path = f.saveReview("REVIEW_STATUS: complete\nPrevious findings:\nR1-1: still open (P1): the save still drops the second write\n\nDefects: none\nValidation gaps: none.\n");
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 2, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [{ id: "R2-1", group: "Previous findings", severity: "P1", kind: "unsorted", text: "R1-1 still open: x" }] }));
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /Previous findings: R1-1 still open: the save still drops the second write/);
  assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  assert.equal(f.ghCalls("merge").length, 0);
  assert.doesNotMatch(result.stdout, /Verdict: approved/);
});

test("out of budget with a should (P2) left lands as a follow-up for Lex but the PR says not approved, with the budget report and the saved ids", t => {
  const f = fixture(t);
  f.rounds(3);
  const path = f.saveReview(cleanReview.replace("Spec: none.", "Spec: P2: Real minor defect."));
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 4, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [{ id: "R4-1", group: "Spec", severity: "P2", kind: "unsorted", text: "P2: Real minor defect." }] }));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Review budget used: 3 of 3 fix rounds, 1 open finding\. Running out of budget is not approval; Lex decides\.$/m);
  assert.match(result.stdout, /^- R4-1 \(should\): /m);
  assert.match(result.stdout, /^Reviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: not approved \(budget used, 1 open finding left for Lex\)$/m);
  assert.doesNotMatch(result.stdout, /Verdict: approved/);
});

// TOOLS-287: kit pr counts the fix rounds from the review records themselves, since the cut kit fix no longer saves them:
// every earlier review that left a finding above a nit (Claude's rounds and the branch's second looks). 3 fix rounds (5 for a
// risky change), then only blockers block.
// The review being weighed is round `round`, linked by `previous` to rounds 1 … round - 1, each of which left a finding of
// severity `earlier` (none when null: a clean round).
const reviewAtRound = (f: ReturnType<typeof fixture>, round: number, severity?: string, owner = f.env.ASE_OWNER!, earlier: string | null = "P2") => {
  const record = (n: number, level?: string | null) => ({ round: n, model: "claude-opus-5-5", ...(n > 1 ? { previous: `20261019T0900${String(n - 1).padStart(2, "0")}Z` } : {}),
    findings: level ? [{ id: `R${n}-1`, group: "Spec", severity: level, kind: "unsorted", text: `${level}: Real finding.` }] : [] });
  for (let n = 1; n < round; n++) {
    const folder = join(f.main, ".scratch/reviews", owner, `20261019T0900${String(n).padStart(2, "0")}Z`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "findings.json"), JSON.stringify(record(n, earlier)));
  }
  const path = f.saveReview(severity ? cleanReview.replace("Spec: none.", `Spec: ${severity}: Real finding.`) : cleanReview, owner);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ ...record(round, severity), head: f.git("rev-parse", "HEAD") }));
};

test("3 fix rounds recorded by the reviews (review round 4): an open should lands as a follow-up, listed for Lex, never approved", t => {
  const f = fixture(t);
  reviewAtRound(f, 4, "P2");
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Review budget used: 3 of 3 fix rounds, 1 open finding\. Running out of budget is not approval; Lex decides\.$/m);
  assert.match(result.stdout, /^- R4-1 \(should\): P2: Real finding\.$/m);
  assert.match(result.stdout, /review: 1 follow-ups after 3 fix rounds \(non-blocking\)/);
  assert.match(result.stdout, /Verdict: not approved \(budget used, 1 open finding left for Lex\)$/m);
  assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: ok merged #73 /);
  // Before the budget is used (review round 3, 2 fix rounds) the same should still blocks.
  const early = fixture(t);
  reviewAtRound(early, 3, "P2");
  const blocked = early.run();
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  assert.doesNotMatch(blocked.stdout, /Review budget used/);
});

test("a clean or nits-only earlier review called for no fix: review round 4 after three clean rounds still blocks on a should", t => {
  for (const earlier of [null, "P3"]) {
    const f = fixture(t);
    reviewAtRound(f, 4, "P2", undefined, earlier);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
    assert.doesNotMatch(result.stdout, /Review budget used/);
  }
});

// Earlier second looks of this branch at `heads`, each marked as come back (`marks` changes a look's mark) with a should.
const earlierLooks = (f: ReturnType<typeof fixture>, heads: string[], marks: Record<string, unknown>[] = []) => heads.forEach((looked, index) => {
  const folder = join(f.main, ".scratch/reviews/ak-14", `20261019T08000${index}Z`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "refs.txt"), `${looked}\n${f.git("merge-base", "origin/dev", "HEAD")}\n`);
  writeFileSync(join(folder, "result.md"), `REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 an earlier second-look should ${index}.\n`);
  writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model: "grok-4.7", ok: true, branch: "feature/kit-pr", ...marks[index] }));
});
const secondShould = "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a new second-look should.\n";

test("the branch's earlier second looks count as fix rounds: Claude clean every time, three second looks with a should, then the fourth's should lands", t => {
  const f = fixture(t);
  // Three earlier heads, each with a second look that found a should, then the head kit pr lands.
  earlierLooks(f, [f.git("rev-parse", "HEAD~1"), f.git("rev-parse", "HEAD"), f.commit("Third change")]);
  f.commit("Fourth change");
  reviewAtRound(f, 1);
  const landed = f.run([], { FAKE_SECOND_REVIEW: secondShould });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /^Review budget used: 3 of 3 fix rounds, 1 open finding\./m);
  assert.match(landed.stdout, /^second look: 1 follow-ups after 3 fix rounds \(non-blocking\)$/m);
  // Another branch's second looks, or ones not marked as come back, count for nothing.
  const g = fixture(t);
  earlierLooks(g, [g.git("rev-parse", "HEAD~1"), g.git("rev-parse", "HEAD"), g.commit("Third change")], [{ ok: false }, { branch: "feature/other" }]);
  g.commit("Fourth change");
  reviewAtRound(g, 1);
  const held = g.run([], { FAKE_SECOND_REVIEW: secondShould });
  assert.equal(held.status, 1, held.stdout + held.stderr);
  assert.match(held.stdout, /RESULT: fail pr #73 second look has 1 open findings/);
});

test("second looks of an earlier branch of the same name, already in the base, count no round for new work", t => {
  const f = fixture(t);
  // The earlier branch's three looked-at heads landed in dev; the new work starts from there.
  const old = [f.git("rev-parse", "HEAD~1"), f.git("rev-parse", "HEAD"), f.commit("Third change")];
  f.git("push", "-q", "origin", "HEAD:dev");
  earlierLooks(f, old);
  f.commit("New work");
  reviewAtRound(f, 1);
  const held = f.run([], { FAKE_SECOND_REVIEW: secondShould });
  assert.equal(held.status, 1, held.stdout + held.stderr);
  assert.match(held.stdout, /RESULT: fail pr #73 second look has 1 open findings/);
  assert.doesNotMatch(held.stdout, /Review budget used/);
});

test("Claude's rounds of an earlier branch of the same name, already in the base, count no round for new work", t => {
  const f = fixture(t);
  // The earlier branch's three reviewed heads landed in dev, each with a should; the new work's round 4 links to them.
  const old = [f.git("rev-parse", "HEAD~1"), f.git("rev-parse", "HEAD"), f.commit("Third change")];
  f.git("push", "-q", "origin", "HEAD:dev");
  f.commit("New work");
  reviewAtRound(f, 4, "P2");
  old.forEach((looked, index) => {
    const path = join(f.main, ".scratch/reviews/ak-14", `20261019T0900${String(index + 1).padStart(2, "0")}Z`, "findings.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), head: looked }));
  });
  const held = f.run();
  assert.equal(held.status, 1, held.stdout + held.stderr);
  assert.match(held.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  assert.doesNotMatch(held.stdout, /Review budget used/);
});

test("the second looks' rounds survive the rebase kit pr starts with when the patch stays the same", t => {
  const f = fixture(t);
  earlierLooks(f, [f.git("rev-parse", "HEAD~1"), f.git("rev-parse", "HEAD"), f.commit("Third change")]);
  f.commit("Fourth change");
  reviewAtRound(f, 1);
  const peer = f.peer();
  writeFileSync(join(peer, "upstream.txt"), "moved base\n");
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "base moved"); f.gitAt(peer, "push", "origin", "dev");
  const landed = f.run([], { FAKE_SECOND_REVIEW: secondShould });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /review: reused \(same patch on new base\)/);
  assert.match(landed.stdout, /^second look: 1 follow-ups after 3 fix rounds \(non-blocking\)$/m);
});

test("the docs tier, with no Claude review, counts its earlier second looks alone", t => {
  const f = fixture(t, { "docs/guide.md": "# Guide\n" });
  const heads = [f.git("rev-parse", "HEAD")];
  for (const n of [2, 3]) heads.push(f.commit(`Docs ${n}`, "docs/guide.md", `# Guide ${n}\n`));
  earlierLooks(f, heads);
  f.commit("Docs 4", "docs/guide.md", "# Guide 4\n");
  const landed = f.run([], { FAKE_SECOND_REVIEW: secondShould });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /review: skipped \(docs tier\)/);
  assert.match(landed.stdout, /^second look: 1 follow-ups after 3 fix rounds \(non-blocking\)$/m);
});

test("after the 3 fix rounds the reviews recorded, a P0 or P1 still blocks", t => {
  for (const severity of ["P0", "P1"]) {
    const f = fixture(t);
    reviewAtRound(f, 4, severity);
    const result = f.run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^Review budget used: 3 of 3 fix rounds, 1 open finding\./m);
    assert.match(result.stdout, /RESULT: fail pr #73 review has 1 open findings/);
    assert.equal(f.ghCalls("merge").length, 0);
  }
});

test("a risky change gets 5 fix rounds from the review records: a should at review round 4 blocks, at round 6 it lands", t => {
  const four = fixture(t, { "src/auth/login.ts": "export const login = 1;\n" });
  reviewAtRound(four, 4, "P2");
  const blocked = four.run();
  assert.equal(blocked.status, 1, blocked.stdout + blocked.stderr);
  assert.match(blocked.stdout, /^review loop: risky change \(path src\/auth\/login\.ts\): up to 5 fix rounds$/m);
  assert.match(blocked.stdout, /RESULT: fail pr #73 review has 1 open findings/);
  const six = fixture(t, { "src/auth/login.ts": "export const login = 1;\n" });
  reviewAtRound(six, 6, "P2");
  const landed = six.run();
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /^Review budget used: 5 of 5 fix rounds, 1 open finding\./m);
  assert.match(landed.stdout, /review: 1 follow-ups after 5 fix rounds \(non-blocking\)/);
});

test("the second look follows the same budget: once the reviews recorded 3 fix rounds its should lands, its P1 still blocks", t => {
  const should = "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a second-look should.\n";
  const used = fixture(t);
  reviewAtRound(used, 4);
  const landed = used.run([], { FAKE_SECOND_REVIEW: should });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.match(landed.stdout, /^second look: 1 follow-ups after 3 fix rounds \(non-blocking\)$/m);
  assert.match(landed.stdout, /^- SL-1 \(should\): /m);
  assert.match(landed.stdout, /Verdict: not approved \(budget used, 1 open finding left for Lex\)$/m);
  const blocker = fixture(t);
  reviewAtRound(blocker, 4);
  const stopped = blocker.run([], { FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 a second-look blocker.\n" });
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, /RESULT: fail pr #73 second look has 1 open findings/);
  // Within the budget (review round 2) the second look's should still blocks.
  const early = fixture(t);
  reviewAtRound(early, 2);
  const held = early.run([], { FAKE_SECOND_REVIEW: should });
  assert.equal(held.status, 1, held.stdout + held.stderr);
  assert.match(held.stdout, /RESULT: fail pr #73 second look has 1 open findings/);
});

test("kit pr takes several --waive values: each may name its own findings, and together they cover both looks", t => {
  const f = fixture(t);
  reviewAtRound(f, 1, "P2", "ke-lead");
  const result = f.run(["--waive", "R1-1: Lex accepted the minor defect.", "--waive", "SL-1: accepted for follow-up"],
    { ASE_OWNER: "ke-lead", FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: ok merged #73 /);
  assert.match(result.stdout, /Verdict: not approved \(2 open findings waived by the lead\)$/m);
  // One --waive that names only one of the two still stops the landing.
  const g = fixture(t);
  reviewAtRound(g, 1, "P2", "ke-lead");
  const refused = g.run(["--waive", "R1-1: Lex accepted the minor defect."],
    { ASE_OWNER: "ke-lead", FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /the waiver does not name/);
  // Counts add up across the values.
  const h = fixture(t);
  reviewAtRound(h, 1, "P2", "ke-lead");
  const counted = h.run(["--waive", "1 finding: the review's", "--waive", "1 finding: the second look's"],
    { ASE_OWNER: "ke-lead", FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(counted.status, 0, counted.stdout + counted.stderr);
});

test("the PR's review block is replaced between markers on a later run, never added twice", t => {
  const f = fixture(t);
  const path = f.saveReview(cleanReview);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  assert.equal(f.run().status, 0);
  const bodies = f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "");
  const block = bodies.find(text => text.includes("<!-- review-loop -->"))!;
  assert.equal((block.match(/<!-- review-loop -->/g) ?? []).length, 1);
  assert.match(block, /<!-- review-loop -->\nReviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: approved\n\nSecond look by grok-4\.7 \(Grok\)\.\n\nFindings ledger: none\.\n<!-- \/review-loop -->/);
});

test("the PR's verdict counts the second look too: a second-look P2 after the budget is used, or a second-look P1 under --waive, is never approved", t => {
  const withEvidence = (f: ReturnType<typeof fixture>, owner?: string) => {
    const path = f.saveReview(cleanReview, owner);
    writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  };
  const budget = fixture(t); withEvidence(budget); budget.rounds(3);
  const used = budget.run([], { FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a second-look should.\n" });
  assert.equal(used.status, 0, used.stdout + used.stderr);
  assert.match(used.stdout, /^Reviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: not approved \(budget used, 1 open finding left for Lex\)$/m);
  const waiver = fixture(t); withEvidence(waiver, "ke-lead");
  const waived = waiver.run(["--waive", "SL-1: accepted for follow-up"], { ASE_OWNER: "ke-lead", FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(waived.status, 0, waived.stdout + waived.stderr);
  assert.match(waived.stdout, /^Reviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: not approved \(1 open finding waived by the lead\)$/m);
  assert.doesNotMatch(waived.stdout, /Verdict: approved/);
});

test("a saved review marked incomplete (a later round that left an id out) is never reused: a fresh review runs", t => {
  const f = fixture(t);
  const path = f.saveReview(cleanReview);
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ incomplete: true, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [] }));
  const result = f.run(["--no-merge"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(f.calls().some(claudeReview), "the incomplete review was not reused");
});

test("a should with no reason on a risky change at round 3 lands as a follow-up but the PR says nobody waived it and it is not approved", t => {
  const f = fixture(t, { "src/auth/login.ts": "export const login = 1;\n" });
  f.rounds(3);
  const path = f.saveReview("REVIEW_STATUS: complete\nPrevious findings:\nR1-1: still open (P2)\n\nDefects: none\nValidation gaps: none.\n");
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 4, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [{ id: "R4-1", group: "Previous findings", severity: "P2", kind: "unsorted", text: "R1-1 still open: no reason given" }] }));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^review: 1 follow-ups \(no reason given\) \(non-blocking\)$/m);
  assert.match(result.stdout, /Verdict: not approved \(1 open finding left for Lex: no reason was given for it\)$/m);
  assert.doesNotMatch(result.stdout, /waived by the lead/);
});

// Stage 2: on a project with "tickets": "orbit", kit pr closes the card when its PR lands.
async function orbitPr(t: TestContext) {
  const o = await orbitProject(t);
  const f = fixture(t, undefined, orbitSettings);
  const env = { ...f.env, ...o.env };
  const pr = (args: string[], extra: NodeJS.ProcessEnv = {}) => runAsync(prCommand, args, { cwd: f.root, env: { ...env, ...extra } });
  const brief = (key = "KIT-1") => {
    mkdirSync(join(f.root, ".scratch/kit-tickets"), { recursive: true });
    writeFileSync(join(f.root, `.scratch/kit-tickets/${key}.md`), `---\ntitle: Card title\norbit: ${key}\ntype: task (AFK)\nstatus: open\nassignee: ak-14\n---\n\nOrbit card ${key}\n\n## Files\n\n- \`feature.txt\`\n\n## Done when\n\n- done\n`);
    return `.scratch/kit-tickets/${key}.md`;
  };
  return { ...f, ...o, env, pr, brief };
}
const prCommand = pr;
const finalLine = (output: Run) => output.stdout.trim().split("\n").at(-1)!;
const landedNote = /Landed in https:\/\/github\.com\/test\/repo\/pull\/73 \(merge commit abcdef0123456789abcdef0123456789abcdef01\)/;

test("on Orbit, a landed PR closes its card: Done, a note with the PR link and merge SHA, no claim; the brief enters no commit", async t => {
  const { card, pr, brief, orbit, git, log, body } = await orbitPr(t);
  const task = card({ title: "Card title", description: "Claimed by: ak-14\n\n## Files\n\n- `feature.txt`\n\n## Done when\n\n- done" }, "In Progress");
  const output = await pr(["--ticket", brief()]);
  assert.equal(output.status, 0, output.all);
  assert.equal(finalLine(output), "RESULT: ok merged #73 abcdef0 (card KIT-1 Done)");
  assert.equal(orbit.statusOf(task), "Done");
  assert.match(orbit.comments[task.id][0].body, landedNote);
  assert.match(orbit.comments[task.id][0].body, /^\d{4}-\d{2}-\d{2} Landed in /);
  assert.ok(!task.description.includes("Claimed by"));
  assert.ok(!task.description.includes("## Notes"), "the landing is a comment, not a Notes section");
  assert.match(log(), /card=KIT-1 action=close fields=status_id,description who=ak-14 result=ok/);
  assert.match(body(), /^Ticket: Card title \(\.scratch\/kit-tickets\/KIT-1\.md\)$/m);
  assert.doesNotMatch(git("log", "--format=%s", "origin/dev..HEAD"), /docs: KIT-1/);
});

test("on Orbit, a landing comment Orbit refuses after the card is Done leaves the card Done and says only the comment is missing", async t => {
  const { card, pr, brief, orbit } = await orbitPr(t);
  const task = card({ title: "Card title", description: "Claimed by: ak-14\n\n## Files\n\n- `feature.txt`\n\n## Done when\n\n- done" }, "In Progress");
  // The Done write goes through; the landing comment does not.
  orbit.controls.writeAnswers.push("pass", { status: 500, code: "internal_error", detail: "down" });
  const output = await pr(["--ticket", brief()]);
  assert.equal(output.status, 0, output.all);
  assert.equal(orbit.statusOf(task), "Done");
  assert.match(output.stdout, /card: KIT-1 Done \(https:\/\/github\.com\/test\/repo\/pull\/73\); the landing comment was not added \(.*\): add it with kit ticket note KIT-1 "Landed in https:\/\/github\.com\/test\/repo\/pull\/73/);
  assert.doesNotMatch(output.all, /not closed|--status Done/);
  assert.match(finalLine(output), /^RESULT: ok merged #73 abcdef0/);
  assert.equal(orbit.comments[task.id], undefined);
});

test("on Orbit, kit pr --ticket KEY reads the card into its brief and closes it on landing", async t => {
  const { card, pr, orbit, root, body } = await orbitPr(t);
  const task = card({ title: "Straight from the card" }, "In Progress");
  const output = await pr(["--ticket", "KIT-1"]);
  assert.equal(output.status, 0, output.all);
  assert.equal(finalLine(output), "RESULT: ok merged #73 abcdef0 (card KIT-1 Done)");
  // The brief stays in kit pr's own run folder, never the worktree's saved briefs.
  assert.ok(!existsSync(join(root, ".scratch/kit-tickets/KIT-1.md")));
  assert.match(body(), /^Ticket: Straight from the card \(/m);
  assert.equal(orbit.statusOf(task), "Done");
});

test("on Orbit, kit pr --ticket KEY lands a card in the card standard's short shape: no Files section is asked for any more", async t => {
  // Only kit slice's builder needed "## Files" for its scope; it was cut (TOOLS-235), and a standard card has none.
  const { card, pr, orbit } = await orbitPr(t);
  const task = card({ title: "Short card", description: "Make the export button work.\n\nDone when: the export saves a file.\n\nLinks: none" }, "In Progress");
  const output = await pr(["--ticket", "KIT-1"]);
  assert.equal(output.status, 0, output.all);
  assert.equal(finalLine(output), "RESULT: ok merged #73 abcdef0 (card KIT-1 Done)");
  assert.equal(orbit.statusOf(task), "Done");
});

test("on Orbit, a card that cannot be closed after the merge says so in one plain line and the merge still counts", async t => {
  for (const [extra, words] of [
    [{}, /Orbit answered 502/],
    [{ ORBIT_ROLE: "" }, /only a lead may write to Orbit/],
  ] as const) {
    const { card, pr, brief, orbit } = await orbitPr(t);
    const task = card({}, "In Progress");
    if (!("ORBIT_ROLE" in extra)) orbit.controls.answers.push("gateway-page");
    const output = await pr(["--ticket", brief()], extra);
    assert.equal(output.status, 0, output.all);
    const last = finalLine(output);
    assert.match(last, /^RESULT: ok merged #73 abcdef0; card KIT-1 not closed: /);
    assert.match(last, words);
    assert.match(output.stdout, /^card: KIT-1 not closed: .*; close it with kit ticket update KIT-1 --status Done$/m);
    assert.equal(orbit.statusOf(task), "In Progress");
    for (const secret of orbitSecretsForTests) assert.ok(!output.all.includes(secret));
  }
});

test("on Orbit, an unmerged PR (--no-merge) leaves its card as it is", async t => {
  const { card, pr, brief, orbit } = await orbitPr(t);
  const task = card({}, "In Progress");
  const output = await pr(["--ticket", brief(), "--no-merge"]);
  assert.equal(output.status, 0, output.all);
  assert.match(finalLine(output), /^RESULT: ok opened #73 /);
  assert.equal(orbit.statusOf(task), "In Progress");
  assert.equal(orbit.writes().length, 0);
});

test("on Orbit, a queued PR leaves its card open and says to close it once it lands; review follow-ups go on the card as one comment", async t => {
  const queued = await orbitPr(t);
  const open = queued.card({}, "In Progress");
  const output = await queued.pr(["--ticket", queued.brief()], { FAKE_QUEUE: "1" });
  assert.equal(output.status, 0, output.all);
  // Nothing waits for the queue since kit slice was cut (TOOLS-235): the line says who closes the card.
  assert.match(finalLine(output), /^RESULT: ok queued #73 [0-9a-f]{7}; card KIT-1 stays open: close it once #73 lands$/);
  assert.match(output.stdout, /^card: KIT-1 stays open: nothing here waits for the queue; run kit ticket update KIT-1 --status Done once #73 lands$/m);
  assert.equal(queued.orbit.statusOf(open), "In Progress");
  assert.equal(queued.orbit.writes().length, 0);
  // A queued brief's review and UX follow-ups go on the card now, as one comment, since no later step reads the brief.
  const later = await orbitPr(t);
  const waiting = later.card({}, "In Progress");
  const laterBrief = later.brief();
  writeFileSync(join(later.root, laterBrief), `${readFileSync(join(later.root, laterBrief), "utf8")}\n## Done (2026-11-07)\n\n### UX follow-ups\n\n- UX (looks off): F-1 S1: a hint line\n`);
  later.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect."));
  const queuedLater = await later.pr(["--ticket", laterBrief], { FAKE_QUEUE: "1" });
  assert.equal(queuedLater.status, 0, queuedLater.all);
  assert.equal(later.orbit.statusOf(waiting), "In Progress");
  assert.deepEqual((later.orbit.comments[waiting.id] ?? []).map((comment: any) => comment.body),
    ["Follow-ups from https://github.com/test/repo/pull/73:\n- Spec (P3): P3: Cosmetic defect.\n- UX (looks off): F-1 S1: a hint line"]);

  const nits = await orbitPr(t);
  const task = nits.card({}, "In Progress");
  const brief = nits.brief();
  writeFileSync(join(nits.root, brief), `${readFileSync(join(nits.root, brief), "utf8")}\n## Done (2026-11-07)\n\n### UX follow-ups\n\n- UX (looks off): F-1 S1: a hint line\n`);
  nits.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect.").replace("Validation gaps: none.", "Validation gaps: Add coverage."));
  const landed = await nits.pr(["--ticket", brief]);
  assert.equal(landed.status, 0, landed.all);
  assert.equal(nits.orbit.statusOf(task), "Done");
  const bodies = (nits.orbit.comments[task.id] ?? []).map((comment: any) => comment.body);
  assert.match(bodies[0], landedNote, "the landing is the first comment");
  assert.deepEqual(bodies.slice(1), [
    "Follow-ups from https://github.com/test/repo/pull/73:\n- Spec (P3): P3: Cosmetic defect.\n- Validation gaps (gap): Add coverage.\n- UX (looks off): F-1 S1: a hint line",
  ]);
  assert.doesNotMatch(nits.git("log", "--format=%s", "origin/dev..HEAD"), /docs: KIT-1/);
});

test("on Orbit, a follow-ups comment that Orbit refuses leaves the card Done with the landing comment, and the line names the PR", async t => {
  const f = await orbitPr(t);
  const task = f.card({}, "In Progress");
  f.orbit.controls.refuseComments = /^Follow-ups from/;
  f.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect."));
  const output = await f.pr(["--ticket", f.brief()]);
  assert.equal(output.status, 0, output.all);
  assert.equal(f.orbit.statusOf(task), "Done");
  assert.match(output.stdout, /^card: KIT-1 Done \(https:\/\/github\.com\/test\/repo\/pull\/73\); its follow-ups were not added \(.*\): they are in https:\/\/github\.com\/test\/repo\/pull\/73$/m);
  assert.deepEqual((f.orbit.comments[task.id] ?? []).map((comment: any) => comment.body.replace(/^\d{4}-\d{2}-\d{2} /, "").slice(0, 9)), ["Landed in"]);
});

test("on Orbit, an absolute brief path closes its card; a dry run with a KEY writes no brief where a slice would read it", async t => {
  const f = await orbitPr(t);
  const task = f.card({}, "In Progress");
  const output = await f.pr(["--ticket", join(f.root, f.brief())]);
  assert.equal(output.status, 0, output.all);
  assert.equal(finalLine(output), "RESULT: ok merged #73 abcdef0 (card KIT-1 Done)");
  assert.equal(f.orbit.statusOf(task), "Done");

  const dry = await orbitPr(t);
  dry.card({}, "In Progress");
  const planned = await dry.pr(["--ticket", "KIT-1", "--dry-run"]);
  assert.equal(planned.status, 0, planned.all);
  assert.ok(!existsSync(join(dry.root, ".scratch/kit-tickets/KIT-1.md")), "the dry run left no brief");
  assert.equal(dry.orbit.writes().length, 0);
});

test("on Orbit, a queued PR whose follow-ups Orbit refuses posts them all, the brief's UX ones too, as a PR comment and says so", async t => {
  const f = await orbitPr(t);
  const task = f.card({}, "In Progress");
  const brief = f.brief();
  writeFileSync(join(f.root, brief), `${readFileSync(join(f.root, brief), "utf8")}\n## Done (2026-11-07)\n\n### UX follow-ups\n\n- UX (looks off): F-1 S1: a hint line\n`);
  f.orbit.controls.refuseComments = /^Follow-ups from/;
  f.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect."));
  const output = await f.pr(["--ticket", brief], { FAKE_QUEUE: "1" });
  assert.equal(output.status, 0, output.all);
  assert.equal(f.orbit.statusOf(task), "In Progress");
  const fallback = f.ghCalls("comment").map(call => call.body ?? "").find(body => body.includes("F-1 S1: a hint line"));
  assert.ok(fallback, "the UX follow-up reaches a PR comment");
  assert.match(fallback!, /^Follow-ups for card KIT-1 \(Orbit did not take them\):\n- Spec \(P3\): P3: Cosmetic defect\.\n- UX \(looks off\): F-1 S1: a hint line/);
  assert.match(output.stdout, /^card: KIT-1 stays open: .*; run kit ticket update KIT-1 --status Done once #73 lands \(its follow-ups were not added: .*; they are in a PR comment\)$/m);
});

test("on Orbit, a queued PR whose follow-ups neither Orbit nor GitHub takes keeps them in a file the line names", async t => {
  const f = await orbitPr(t);
  f.card({}, "In Progress");
  const brief = f.brief();
  writeFileSync(join(f.root, brief), `${readFileSync(join(f.root, brief), "utf8")}\n## Done (2026-11-07)\n\n### UX follow-ups\n\n- UX (looks off): F-1 S1: a hint line\n`);
  f.orbit.controls.refuseComments = /^Follow-ups from/;
  f.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect."));
  const output = await f.pr(["--ticket", brief], { FAKE_QUEUE: "1", FAKE_FAIL_BODY: "^Follow-ups for card" });
  assert.equal(output.status, 0, output.all);
  assert.match(finalLine(output), /^RESULT: ok queued #73 /);
  const kept = /they are only in (\S+\/card-followups\.md)\)$/m.exec(output.stdout)?.[1];
  assert.ok(kept, output.stdout);
  assert.match(readFileSync(kept!, "utf8"), /- Spec \(P3\): P3: Cosmetic defect\.\n- UX \(looks off\): F-1 S1: a hint line/);
});

test("on Orbit, a queued PR no longer writes its review follow-ups into the brief: no slice reads them there any more", async t => {
  const f = await orbitPr(t);
  f.card({}, "In Progress");
  const brief = f.brief();
  const before = readFileSync(join(f.root, brief), "utf8");
  f.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect."));
  const output = await f.pr(["--ticket", brief], { FAKE_QUEUE: "1" });
  assert.equal(output.status, 0, output.all);
  assert.equal(readFileSync(join(f.root, brief), "utf8"), before);
});

test("on Orbit, a lead's kit pr --ticket KEY on a merge queue says nobody waits to close the card and puts its follow-ups on it now", async t => {
  const f = await orbitPr(t);
  const task = f.card({}, "In Progress");
  f.saveReview(cleanReview.replace("Spec: none.", "Spec: P3: Cosmetic defect."));
  const output = await f.pr(["--ticket", "KIT-1"], { FAKE_QUEUE: "1" });
  assert.equal(output.status, 0, output.all);
  assert.match(finalLine(output), /^RESULT: ok queued #73 [0-9a-f]{7}; card KIT-1 stays open: close it once #73 lands$/);
  assert.match(output.stdout, /^card: KIT-1 stays open: nothing here waits for the queue; run kit ticket update KIT-1 --status Done once #73 lands$/m);
  assert.equal(f.orbit.statusOf(task), "In Progress");
  assert.deepEqual((f.orbit.comments[task.id] ?? []).map((comment: any) => comment.body), ["Follow-ups from https://github.com/test/repo/pull/73:\n- Spec (P3): P3: Cosmetic defect."]);
});

// TOOLS-100, TOOLS-102, TOOLS-103, TOOLS-104: the PR's review block and the saved reviews it comes from.
const reviewBodies = (f: ReturnType<typeof fixture>) => f.apiCalls().filter(call => call.args[1] === "--method").map(call => call.body ?? "");
const savedFindings = (f: ReturnType<typeof fixture>, path: string, record: Record<string, unknown>) =>
  writeFileSync(join(dirname(path), "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: f.git("rev-parse", "HEAD"), findings: [], ...record }));

test("a behind rebase never leaves the old 'approved' on the PR: it says pending while the new head is reviewed and not approved when that review finds a blocker", t => {
  const f = fixture(t), peer = f.peer();
  savedFindings(f, f.saveReview(cleanReview), {});
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P1 Rebased HEAD has a defect.\n";
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW: report });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const blocks = reviewBodies(f).filter(text => text.includes("<!-- review-loop -->"));
  assert.match(blocks[0], /Verdict: approved/, "the first head was approved");
  assert.match(blocks.at(-1)!, /Verdict: not approved \(open findings at the new head/);
  assert.doesNotMatch(blocks.at(-1)!, /Verdict: approved/);
  assert.ok(blocks.some(text => /Verdict: pending/.test(text)), "while the new head was reviewed the PR said pending");
  assert.equal((blocks.at(-1)!.match(/<!-- review-loop -->/g) ?? []).length, 1);
});

test("a nits-only review is reused after a rebase with the same patch (no new review, the PR block keeps its ledger); a review with a should is not", t => {
  const nits = "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P3 a small point.\nValidation gaps: none.\n";
  const f = fixture(t), peer = f.peer();
  savedFindings(f, f.saveReview(nits), { findings: [{ id: "R1-1", group: "Spec", severity: "P3", kind: "fault", text: "file.txt:1 P3 a small point." }] });
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: peer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.calls().filter(claudeReview).length, 0, "no review ran: the nits-only one was reused before and after the rebase");
  assert.match(result.stdout, /review: reused \(same patch on new base\)/);
  const block = reviewBodies(f).findLast(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /Verdict: approved/);
  assert.match(block, /^\| R1-1 \| nit \| open at the end \|$/m);
  // A saved review with a should is not reused after a rebase: the rebased head is reviewed again.
  const other = fixture(t), otherPeer = other.peer();
  other.saveReview("REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a real should.\nValidation gaps: none.\n", "ke-lead");
  const waived = other.run(["--waive", "review-1: accepted for follow-up"], { ASE_OWNER: "ke-lead", FAKE_BEHIND: "1", FAKE_ADVANCE: otherPeer, FAKE_REVIEW: cleanReview });
  assert.equal(waived.status, 0, waived.stdout + waived.stderr);
  assert.equal(other.calls().filter(claudeReview).length, 1, "the rebased head got a fresh review");
});

test("the ledger holds the second look's findings too, with ids that say they came from it", t => {
  const base = (waive: boolean) => {
    const f = fixture(t);
    savedFindings(f, f.saveReview(cleanReview, waive ? "ke-lead" : undefined), {});
    return f;
  };
  const budget = base(false); budget.rounds(3);
  const used = budget.run([], { FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a second-look should.\n- Spec: file.txt:2 P3 a second-look nit.\n" });
  assert.equal(used.status, 0, used.stdout + used.stderr);
  const block = reviewBodies(budget).findLast(text => text.includes("<!-- review-loop -->"))!;
  assert.match(block, /^\| SL-1 \| should \| .*second look.*a second-look should\. \|$/m);
  assert.match(block, /^\| SL-2 \| nit \| .*second look.*a second-look nit\. \|$/m);
  assert.match(block, /Verdict: not approved \(budget used, 1 open finding left for Lex\)/);
  assert.doesNotMatch(block, /Findings ledger: none/);
  const waiver = base(true);
  const waived = waiver.run(["--waive", "SL-1: accepted for follow-up"], { ASE_OWNER: "ke-lead", FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(waived.status, 0, waived.stdout + waived.stderr);
  const waivedBlock = reviewBodies(waiver).findLast(text => text.includes("<!-- review-loop -->"))!;
  assert.match(waivedBlock, /^\| SL-1 \| blocker \| open, waived by the lead \(second look\): .*the second look found this\. \|$/m);
  assert.match(waivedBlock, /Verdict: not approved \(1 open finding waived by the lead\)/);
});

test("out of budget with a blocker and a should left: the report counts both, lists both, and shows the builder's declined findings with their reasons", t => {
  const f = fixture(t);
  f.rounds(3);
  const path = f.saveReview("REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P1 Real wrong behaviour.\n- Spec: b.ts:2 P2 Real minor defect.\n");
  savedFindings(f, path, { round: 4, findings: [
    { id: "R4-1", group: "Spec", severity: "P1", kind: "fault", text: "a.ts:1 P1 Real wrong behaviour." },
    { id: "R4-2", group: "Spec", severity: "P2", kind: "fault", text: "b.ts:2 P2 Real minor defect." }],
  declined: [{ text: "the save drops a write", reason: "the spec keeps the last write", round: 2 }, { text: "rename the helper", reason: "", round: 3 }] });
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^Review budget used: 3 of 3 fix rounds, 2 open findings\. Running out of budget is not approval; Lex decides\.$/m);
  assert.match(result.stdout, /^- R4-1 \(blocker\): /m);
  assert.match(result.stdout, /^- R4-2 \(should\): /m);
  assert.match(result.stdout, /^Builder's side \(declined, with reasons\):$/m);
  assert.match(result.stdout, /^- the save drops a write — reason: the spec keeps the last write$/m);
  assert.match(result.stdout, /^- rename the helper — reason: none given$/m);
});

test("after a behind rebase a failed review, a second look that stops it, or a review with no record never leaves 'pending' or 'approved' on the PR", t => {
  const approved = () => { const f = fixture(t); savedFindings(f, f.saveReview(cleanReview), {}); return f; };
  const lastBlock = (f: ReturnType<typeof fixture>) => reviewBodies(f).findLast(text => text.includes("<!-- review-loop -->"));
  // The review of the rebased head fails to run: the PR says it did not finish.
  const failing = approved();
  const failed = failing.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: failing.peer(), FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW_FAIL: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(lastBlock(failing)!, /Verdict: not approved \(the review did not finish at the new head [0-9a-f]{7}; see the kit pr run for the error\)/);
  // Claude's review of the rebased head is clean but the second look finds a blocker.
  const second = approved();
  const stopped = second.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: second.peer(), FAKE_ADVANCE_PATCH: "1", FAKE_SECOND_REBASED_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P1 the second look found this.\n" });
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(lastBlock(second)!, /Verdict: not approved \(open findings at the new head [0-9a-f]{7}/);
  // The rebased head's review leaves no findings record: the block is taken away, so no stale text stays.
  const bare = approved();
  const merged = bare.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: bare.peer(), FAKE_ADVANCE_PATCH: "1" });
  assert.equal(merged.status, 0, merged.stdout + merged.stderr);
  assert.equal(reviewBodies(bare).at(-1)!.includes("<!-- review-loop -->"), false);
  assert.doesNotMatch(reviewBodies(bare).at(-1)!, /Verdict: (pending|approved)/);
});

test("a failed 'Verdict: pending' update stops the run and never leaves the old 'approved' on the PR", t => {
  const f = fixture(t);
  savedFindings(f, f.saveReview(cleanReview), {});
  const result = f.run([], { FAKE_BEHIND: "1", FAKE_ADVANCE: f.peer(), FAKE_ADVANCE_PATCH: "1", FAKE_FAIL_PENDING: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(f.apiCalls().some(call => call.failed), "the pending update was tried and failed");
  const blocks = f.apiCalls().filter(call => call.args[1] === "--method" && !call.failed).map(call => call.body ?? "").filter(text => text.includes("<!-- review-loop -->"));
  assert.match(blocks[0], /Verdict: approved/, "the first head was approved");
  assert.equal(blocks.some(text => /Verdict: pending/.test(text)), false, "the pending update never reached the PR");
  assert.match(blocks.at(-1)!, /Verdict: not approved \(the review did not finish at the new head [0-9a-f]{7}; see the kit pr run for the error\)/);
  assert.equal(f.calls().filter(claudeReview).length, 0, "the rebased head was not reviewed after the failed update");
});

test("a second look's out-of-budget report carries the builder's declined findings from Claude's review", t => {
  const f = fixture(t);
  f.rounds(3);
  savedFindings(f, f.saveReview(cleanReview), { round: 4, declined: [{ text: "the save drops a write", reason: "the spec keeps the last write", round: 2 }] });
  const result = f.run([], { FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a second-look should.\n" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^- SL-1 \(should\): /m);
  assert.match(result.stdout, /^- the save drops a write — reason: the spec keeps the last write$/m);
});

test("the PR line counts a chain of rounds that runs into the builder's folder, and names every model the rounds used", t => {
  const f = fixture(t);
  const earlierFolder = join(f.main, ".scratch/reviews/ak-9/20261019T090000Z");
  mkdirSync(earlierFolder, { recursive: true });
  writeFileSync(join(earlierFolder, "findings.json"), JSON.stringify({ round: 1, branch: "feature/kit-pr", model: "claude-opus-5-4", head: "0".repeat(40), findings: [] }));
  savedFindings(f, f.saveReview(cleanReview), { round: 2, model: "claude-opus-5-5", previous: "../ak-9/20261019T090000Z" });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^Reviewed with review-loop: 2 rounds with claude-opus-5-4 and claude-opus-5-5\. Verdict: approved$/m);
});

// A waiver names what it waives (TOOLS-225): on 2026-11-13 one bare --waive let five new P2s through after a rebase.
const twoFindings = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P2 The first defect.\n- Standards: b.ts:2 P1 The second defect.\n";
const lead = { ASE_OWNER: "ke-lead" };

test("a waiver that names every open finding above P3 by id lands, one that leaves out the second look's finding does not, and the text stays in the PR", t => {
  const f = fixture(t), reason = "review-1 and review-2: Lex accepted both for the old export.";
  const result = f.run(["--waive", reason], { ...lead, FAKE_REVIEW: twoFindings, FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 the second look found this.\n" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  // The second look's SL-1 is not named: the run stops there, and says which finding it is.
  assert.match(result.stdout, /^The --waive reason does not name 1 open finding above P3:$/m);
  assert.match(result.stdout, /^- SL-1 \(P2\): .*the second look found this\.$/m);
  assert.equal(f.ghCalls("merge").length, 0);
  const named = fixture(t), landed = named.run(["--waive", `${reason} SL-1 too.`], { ...lead, FAKE_REVIEW: twoFindings, FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 the second look found this.\n" });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(named.ghCalls("merge").length, 1);
  assert.equal(named.ghCalls("comment").at(-1)?.body, `Merged with 3 waived findings: ${reason} SL-1 too.`);
  assert.ok((named.apiCalls().at(-1)?.body ?? "").endsWith(`\nmerged with 3 waived findings: ${reason} SL-1 too.\n`));
});

test("a bare waiver, or one that names only some ids, refuses and lists the open findings it leaves out", t => {
  for (const [reason, left] of [["Lex accepted it.", ["review-1", "review-2"]], ["review-2: Lex accepted this one.", ["review-1"]]] as const) {
    const f = fixture(t), result = f.run(["--waive", reason], { ...lead, FAKE_REVIEW: twoFindings });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^The --waive reason does not name ${left.length} open finding${left.length === 1 ? "" : "s"} above P3:$`, "m"));
    for (const id of left) assert.match(result.stdout, new RegExp(`^- ${id} \\(P[12]\\): `, "m"));
    assert.match(result.stdout, /Name each id in --waive, or start it with the number of findings/);
    assert.match(result.stdout, new RegExp(`^RESULT: fail pr #73 review has ${left.length} open finding${left.length === 1 ? "" : "s"} the waiver does not name`, "m"));
    assert.equal(f.ghCalls("merge").length, 0);
    assert.equal(f.ghCalls("comment").length, 0);
  }
});

test("a waiver after a rebase cannot cover the new P2s the fresh review raises", t => {
  const f = fixture(t), peer = f.peer();
  savedFindings(f, f.saveReview("REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P1 The old defect.\n", "ke-lead"), { findings: [{ id: "R1-1", severity: "P1", text: "The old defect." }] });
  const rebased = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P2 New one.\n- Spec: b.ts:1 P2 New two.\n- Spec: c.ts:1 P2 New three.\n";
  const result = f.run(["--waive", "R1-1: Lex accepted the old defect."], { ...lead, FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW: rebased });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^A rebase brought a new head, so kit pr cannot tell that the --waive reason was meant for what is open now; 3 open findings above P3 are new at this head:$/m);
  assert.match(result.stdout, /^Run kit pr again with a --waive that names every open finding above P3 at this head /m);
  // The first merge attempt was the "behind" one that sent the PR back to review; nothing landed after it.
  assert.equal(f.ghCalls("merge").length, 1);
  assert.doesNotMatch(result.stdout, /RESULT: ok/);
});

test("a count waiver lands only when the count matches the open findings above P3", t => {
  // Two in Claude's review plus one in the second look: three in all.
  const second = "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 the second look found this.\n";
  for (const [count, says] of [["3 findings", 3], ["1 finding", 1], ["2 findings", 2], ["4 findings", 4]] as const) {
    const f = fixture(t), result = f.run(["--waive", `${count}: Lex accepted them.`], { ...lead, FAKE_REVIEW: twoFindings, FAKE_SECOND_REVIEW: second });
    if (says === 3) {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(f.ghCalls("merge").length, 1);
      continue;
    }
    assert.equal(result.status, 1, result.stdout + result.stderr);
    // A count too small for Claude's review alone is refused before the second look runs, so SL-1 is not in that list.
    const listed = says === 1 ? 2 : 3;
    if (says === 4) assert.match(result.stdout, /^RESULT: fail pr #73 the waiver does not match the 3 open findings it would let through/m);
    assert.match(result.stdout, new RegExp(`^The --waive reason says ${says} finding${says === 1 ? "" : "s"}, but ${listed} open findings above P3 would be waived:$`, "m"));
    assert.match(result.stdout, /^- review-1 \(P2\): /m);
    assert.equal(/^- SL-1 \(P2\): /m.test(result.stdout), listed === 3);
    assert.equal(f.ghCalls("merge").length, 0);
  }
});

test("a group waiver for P3 findings, validation gaps and nits needs no names", t => {
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P3 A small point.\n- Standards: none.\nValidation gaps: Add coverage.\nOptional nits: Rename a variable.\n";
  const f = fixture(t), result = f.run(["--waive", "Lex accepted the small points."], { ...lead, FAKE_REVIEW: report, FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P3 a second-look nit.\n" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.ghCalls("merge").length, 1);
});

test("a count waiver given for the old head never covers one different finding the fresh review raises after a rebase", t => {
  const f = fixture(t), peer = f.peer();
  savedFindings(f, f.saveReview("REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P1 The old defect.\n", "ke-lead"), { findings: [{ id: "R1-1", severity: "P1", text: "a.ts:1 P1 The old defect." }] });
  const result = f.run(["--waive", "1 finding: Lex accepted it."], { ...lead, FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: b.ts:1 P2 A different new defect.\n" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^A rebase brought a new head, so kit pr cannot tell that the --waive reason was meant for what is open now; 1 open finding above P3 is new at this head:$/m);
  assert.match(result.stdout, /^- review-1 \(P2\): .*A different new defect\.$/m);
  assert.equal(f.ghCalls("merge").length, 1);
  assert.doesNotMatch(result.stdout, /RESULT: ok/);
});

test("a waiver whose ids cover Claude's review but whose count matches the total still refuses the second look's finding", t => {
  const f = fixture(t), second = "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 the second look found this.\n";
  const result = f.run(["--waive", "3 findings: review-1 and review-2 accepted."], { ...lead, FAKE_REVIEW: twoFindings, FAKE_SECOND_REVIEW: second });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^The --waive reason does not name 1 open finding above P3:$/m);
  assert.match(result.stdout, /^- SL-1 \(P2\): /m);
  assert.equal(f.ghCalls("merge").length, 0);
});

test("a count waiver that is already too small stops before the second look starts", t => {
  const f = fixture(t), result = f.run(["--waive", "1 finding: Lex accepted it."], { ...lead, FAKE_REVIEW: twoFindings });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^The --waive reason says 1 finding, but 2 open findings above P3 would be waived:$/m);
  assert.match(result.stdout, /^RESULT: fail pr #73 review has more open findings than the waiver counts/m);
  assert.equal(f.calls().some(call => call.tool === "fake-kit" && call.args.includes("--second-look")), false);
});

test("once the fix rounds are used up only the P1 needs a name: the P2 goes to follow-ups and is not counted", t => {
  const f = fixture(t); f.rounds(3);
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P1 The serious defect.\n- Standards: b.ts:1 P2 The should.\n";
  const result = f.run(["--waive", "1 finding: Lex accepted the serious one."], { ...lead, FAKE_REVIEW: report });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.ghCalls("comment").some(call => /Follow-ups \(non-blocking after 3 fix rounds\):[\s\S]*The should\./.test(call.body ?? "")), true);
  assert.equal(f.ghCalls("comment").at(-1)?.body, "Merged with 1 waived findings: 1 finding: Lex accepted the serious one.");
});

test("a waived finding that a fresh review raises again unchanged after a rebase still lands under the same waiver", t => {
  const f = fixture(t), peer = f.peer();
  const result = f.run(["--waive", "review-1: Lex accepted it."], { ...lead, FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P2 Same defect.\n" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.ghCalls("merge").length, 2);
  assert.doesNotMatch(result.stdout, /new at the new head/);
});

test("the second look's new finding at a rebased head is refused as new, and a second look left unnamed after a named first look reads as unnamed, not as a count", t => {
  const f = fixture(t), peer = f.peer(), review = "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P2 The first defect.\n";
  const result = f.run(["--waive", "review-1: Lex accepted it."], { ...lead, FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW: review, FAKE_SECOND_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P3 a nit.\n", FAKE_SECOND_REBASED_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 a different second-look defect.\n" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^- SL-1 \(P2\): .*a different second-look defect\.$/m);
  assert.match(result.stdout, /^RESULT: fail pr #73 second look has 1 open finding that is new at the new head/m);
  assert.equal(f.ghCalls("merge").length, 1);
  const named = fixture(t), second = "REVIEW_STATUS: complete\nDefects:\n- Spec: file.txt:1 P2 one.\n- Spec: file.txt:2 P2 two.\n";
  const unnamed = named.run(["--waive", "review-1: Lex accepted it."], { ...lead, FAKE_REVIEW: review, FAKE_SECOND_REVIEW: second });
  assert.equal(unnamed.status, 1, unnamed.stdout + unnamed.stderr);
  assert.match(unnamed.stdout, /^The --waive reason does not name 2 open findings above P3:$/m);
});

test("a finding carried into a later round is waived by the id the ledger keeps for it, or by its newest id", t => {
  for (const named of ["R1-1", "R3-1"]) {
    const f = fixture(t);
    const path = f.saveReview("REVIEW_STATUS: complete\nPrevious findings:\nR2-1: still open (P1): the save still drops the second write\n\nDefects: none\nValidation gaps: none.\n", "ke-lead");
    const folder = dirname(path), earlier = join(dirname(folder), "20261019T090000Z"), middle = join(dirname(folder), "20261019T095000Z");
    mkdirSync(earlier, { recursive: true }); mkdirSync(middle, { recursive: true });
    writeFileSync(join(earlier, "findings.json"), JSON.stringify({ round: 1, model: "claude-opus-5-5", head: "0".repeat(40), findings: [{ id: "R1-1", group: "Spec", severity: "P1", kind: "fault", text: "a.ts:1 P1 the save drops the second write" }] }));
    writeFileSync(join(middle, "findings.json"), JSON.stringify({ round: 2, model: "claude-opus-5-5", previous: "20261019T090000Z", head: "0".repeat(40), findings: [{ id: "R2-1", group: "Previous findings", severity: "P1", kind: "unsorted", text: "R1-1 still open: x (original finding: a.ts:1 P1 the save drops the second write)" }] }));
    writeFileSync(join(folder, "findings.json"), JSON.stringify({ round: 3, model: "claude-opus-5-5", previous: "20261019T095000Z", head: f.git("rev-parse", "HEAD"), findings: [{ id: "R3-1", group: "Previous findings", severity: "P1", kind: "unsorted", text: "R2-1 still open: the save still drops the second write" }] }));
    f.rounds(3);
    const result = f.run(["--waive", `${named}: Lex accepted it.`], lead);
    assert.equal(result.status, 0, `${named}: ${result.stdout}${result.stderr}`);
    const refused = fixture(t);
    const refusedPath = refused.saveReview("REVIEW_STATUS: complete\nPrevious findings:\nR2-1: still open (P1): the save still drops the second write\n\nDefects: none\nValidation gaps: none.\n", "ke-lead");
    writeFileSync(join(dirname(refusedPath), "findings.json"), JSON.stringify({ round: 3, model: "claude-opus-5-5", head: refused.git("rev-parse", "HEAD"), findings: [{ id: "R3-1", group: "Previous findings", severity: "P1", kind: "unsorted", text: "R2-1 still open: the save still drops the second write" }] }));
    refused.rounds(3);
    const other = refused.run(["--waive", "R9-9: Lex accepted something else."], lead);
    assert.equal(other.status, 1, other.stdout + other.stderr);
    assert.match(other.stdout, /^- R3-1 \(the ledger's R2-1\) \(P1\): /m);
  }
});

test("a rebase at the start counts too: a waiver given for the old head never covers a different finding the fresh review raises", t => {
  for (const waive of ["review-1: Lex accepted it.", "1 finding: Lex accepted it."]) {
    const f = fixture(t), peer = f.peer();
    writeFileSync(join(peer, "upstream.txt"), "upstream\n");
    f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "advance upstream"); f.gitAt(peer, "push", "origin", "dev");
    const result = f.run(["--waive", waive], { ...lead, FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: b.ts:1 P2 A new defect at the rebased head.\n" });
    assert.equal(result.status, 1, `${waive}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^A rebase brought a new head, so kit pr cannot tell that the --waive reason was meant for what is open now; 1 open finding above P3 is new at this head:$/m);
    assert.equal(f.ghCalls("merge").length, 0);
  }
  // Without a rebase at the start, the same waiver lands.
  const plain = fixture(t), landed = plain.run(["--waive", "review-1: Lex accepted it."], { ...lead, FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: b.ts:1 P2 A defect.\n" });
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
});

test("a waiver refused after a rebase at the start lands on the next run: the fresh review is saved, so the same head is reused and its findings are the ones the lead saw", t => {
  const f = fixture(t), peer = f.peer();
  writeFileSync(join(peer, "upstream.txt"), "upstream\n");
  f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "advance upstream"); f.gitAt(peer, "push", "origin", "dev");
  const report = "REVIEW_STATUS: complete\nDefects:\n- Spec: b.ts:1 P2 The defect.\n", env = { ...lead, FAKE_REVIEW: report };
  const first = f.run(["--waive", "review-1: Lex accepted it."], env);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(first.stdout, /^- review-1 \(P2\): /m);
  const again = f.run(["--waive", "review-1: Lex accepted it."], { ...env, FAKE_EXISTING: "1" });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(f.ghCalls("merge").length, 1);
});

test("a rebase in the middle of the run that makes a fresh review word the same finding differently is refused as new", t => {
  const f = fixture(t), peer = f.peer();
  savedFindings(f, f.saveReview("REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:1 P2 The defect.\n", "ke-lead"), { findings: [{ id: "R1-1", group: "Spec", severity: "P2", kind: "fault", text: "a.ts:1 P2 The defect." }] });
  const result = f.run(["--waive", "R1-1: Lex accepted it."], { ...lead, FAKE_BEHIND: "1", FAKE_ADVANCE: peer, FAKE_ADVANCE_PATCH: "1", FAKE_REVIEW: "REVIEW_STATUS: complete\nDefects:\n- Spec: a.ts:2 P2 The defect.\n" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^- review-1 \(P2\): a\.ts:2 P2 The defect\.$/m);
  assert.equal(f.ghCalls("merge").length, 1);
});

test("a rebase at the start still lets the lead's waiver cover a finding of the review saved for the old head, when the fresh review raises it unchanged", t => {
  const text = "a.ts:1 P2 The defect Lex saw.", report = `REVIEW_STATUS: complete\nDefects:\n- Spec: ${text}\n`;
  for (const waive of ["review-1: Lex accepted it.", "1 finding: Lex accepted it."]) {
    const f = fixture(t), peer = f.peer();
    f.saveReview(report, "ke-lead");
    writeFileSync(join(peer, "upstream.txt"), "upstream\n");
    f.gitAt(peer, "add", "."); f.gitAt(peer, "commit", "-m", "advance upstream"); f.gitAt(peer, "push", "origin", "dev");
    const result = f.run(["--waive", waive], { ...lead, FAKE_REVIEW: report });
    assert.equal(result.status, 0, `${waive}: ${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /new at this head/);
    // A different finding at the rebased head is still refused.
    const other = fixture(t), otherPeer = other.peer();
    other.saveReview(report, "ke-lead");
    writeFileSync(join(otherPeer, "upstream.txt"), "upstream\n");
    other.gitAt(otherPeer, "add", "."); other.gitAt(otherPeer, "commit", "-m", "advance upstream"); other.gitAt(otherPeer, "push", "origin", "dev");
    const refused = other.run(["--waive", waive], { ...lead, FAKE_REVIEW: report.replace("The defect Lex saw.", "A new defect.") });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /new at this head:$/m);
  }
});

test("a release re-cut from an unchanged dev is the same cut: its saved review is reused and the lead's waiver lands it (TOOLS-310)", t => {
  const f = fixture(t), peer = f.peer(), owner = { ASE_OWNER: "ke-lead", FAKE_BASE: "main" };
  f.gitAt(peer, "checkout", "-q", "main"); writeFileSync(join(peer, "hotfix.txt"), "hotfix\n"); f.gitAt(peer, "add", "hotfix.txt");
  // main's hotfix is the newer parent of the cut (dated after dev's change, which the real clock dates).
  assert.equal(spawnSync("git", ["commit", "-q", "-m", "Hotfix on main"], { cwd: peer, env: { ...f.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" } }).status, 0);
  f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("checkout", "-q", "dev"); f.commit("Landed change", "landed.txt"); f.git("push", "-q", "origin", "dev");
  f.git("checkout", "-q", "-b", "release/cut");
  // A machine that shows signatures in git log still gets the parents' dates.
  f.git("config", "log.showSignature", "true");
  const review = "REVIEW_STATUS: complete\nDefects:\n- Spec: landed.txt:1 P1 The release defect.\n";
  // The first cut: the review finds a blocker, so the release stops for the lead.
  const first = f.run(["--base", "main", "--release"], { ...owner, FAKE_REVIEW: review, GIT_AUTHOR_DATE: "2026-11-16T10:00:00Z", GIT_COMMITTER_DATE: "2026-11-16T10:00:00Z" });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(first.stdout, /^RESULT: fail pr #73 review has 1 open findings/m);
  const cut = f.git("rev-parse", "HEAD");
  // The cut is dated by its newer parent, never by the clock of the run.
  assert.equal(f.git("show", "-s", "--format=%ct", cut), f.git("show", "-s", "--format=%ct", "origin/main"));
  assert.notEqual(f.git("show", "-s", "--format=%ct", cut), f.git("show", "-s", "--format=%ct", `${cut}^1`));
  // The re-cut, an hour later, from the same dev: the date of the run never changes the cut.
  f.git("reset", "-q", "--hard", "origin/dev");
  const second = f.run(["--base", "main", "--release", "--waive", "review-1: Lex accepted it for this release."],
    { ...owner, FAKE_REVIEW: review, GIT_AUTHOR_DATE: "2026-11-16T11:00:00Z", GIT_COMMITTER_DATE: "2026-11-16T11:00:00Z" });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(f.git("rev-parse", "HEAD"), cut, "the same dev and main make the same release cut");
  assert.equal(f.calls().filter(claudeReview).length, 1, "the saved review is reused, not run again");
  assert.doesNotMatch(second.stdout, /new at the new head/);
  assert.match(second.stdout, new RegExp(`RESULT: ok merged #73 [a-f0-9]{7}$`, "m"));
});

// TOOLS-303: a locked build may write the repository's Git settings and hooks, a program in a PATH folder inside the
// worktree, a BASH_ENV file and the project's own checks; kit pr runs in the lead's process, with the keys.
const noBwrap = bwrapWorks() === null ? false : `bubblewrap cannot run here: ${bwrapWorks()}`;
// Whether git's ssh runs in the clean room here (TOOLS-390): it needs more than bubblewrap, which a container can block.
const roomUsable = !noBwrap && (() => {
  const probe = mkdtempSync(join(tmpdir(), "kit-room-probe-"));
  try {
    for (const folder of ["work", "home"]) mkdirSync(join(probe, folder));
    return cleanRoomReport({ PATH: process.env.PATH, HOME: join(probe, "home") }, { worktree: join(probe, "work") }).state === "on";
  } finally { rmSync(probe, { recursive: true, force: true }); resetBwrapProbe(); }
})();
test("PROOF: kit pr runs no hook, Git filter, diff tool, merge driver, PATH tool or BASH_ENV file a build left with the keys, and runs the checks inside the key lock", { skip: noBwrap }, t => {
  const dummy = "dummy-key-0123456789-not-real";
  // The lint check is a git command whose alias runs the build's script: a check whatever program it names.
  const f = fixture(t, undefined, { checks: { check: "sh scripts/leak.sh", test: "npm test", lint: "git -c alias.leak=!scripts/leak-git.sh leak", extra: ["bash -c true"] } }), peer = f.peer();
  const home = join(f.dir, "home"), keyFile = join(home, ".config/fleet/orbit.json"), noted = join(f.dir, "noted.txt");
  mkdirSync(dirname(keyFile), { recursive: true }); writeFileSync(keyFile, `${dummy}\n`, { mode: 0o600 });
  // Each planted thing notes who it is, the key file as it reads it and the token variable, then does its job.
  const note = (who: string) => `{ echo ${JSON.stringify(who)}; cat ${JSON.stringify(keyFile)} 2>&1; printf 'token=%s.\\n' "$GH_TOKEN"; } >> ${JSON.stringify(noted)}`;
  const script = (file: string, who: string, then = "") => {
    mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, `#!/bin/sh\n${note(who)}\n${then}\n`); chmodSync(file, 0o755);
  };
  // The build's own change: a check that reads the keys, attributes that name a filter, a diff tool and a merge driver for
  // every file, and a ticket for kit pr to name commits in (a commit kit pr makes itself).
  // The check also tries to swap kit pr's own program links for scripts of its own.
  const swapped = `#!/bin/sh\n${note("a program the check swapped in")}\nexec ${spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()} "$@"\n`;
  writeFileSync(join(f.root, "scripts/leak.sh"), `${note("the project's check")}
for f in "$TMPDIR"/kit-pr-programs-*/git; do [ -L "$f" ] && echo "saw $f" >> ${JSON.stringify(noted)}; rm -f "$f" 2>/dev/null; printf '%s' ${JSON.stringify(swapped)} > "$f" 2>/dev/null && chmod +x "$f"; done
cat ${JSON.stringify(join(home, ".bash_env"))} ${JSON.stringify(join(home, ".shinit"))} >> ${JSON.stringify(noted)} 2>&1
exit 0
`);
  writeFileSync(join(f.root, ".gitattributes"), "* filter=leak diff=leak merge=leak\n");
  writeFileSync(join(f.root, "scripts/leak-git.sh"), `#!/bin/sh\n${note("a check through git")}\n`, { mode: 0o755 });
  f.git("add", "scripts/leak.sh", "scripts/leak-git.sh", ".gitattributes"); f.git("commit", "-qm", "Build change");
  f.commit("Close ticket", "ticket.md", shaTicket("1111111", "2222222"));
  // Upstream moved on, so kit pr rebases (a checkout, rewritten commits) before it pushes.
  writeFileSync(join(peer, "upstream.txt"), "upstream\n");
  f.gitAt(peer, "add", "upstream.txt"); f.gitAt(peer, "commit", "-qm", "advance upstream"); f.gitAt(peer, "push", "-q", "origin", "dev");
  // What the build left behind: hooks, Git settings that name programs, programs in node_modules/.bin, a BASH_ENV file,
  // and a hook in the folder the push goes to.
  const leak = join(f.dir, "leak.sh");
  script(leak, "a program the Git settings name", "cat");
  for (const name of ["pre-commit", "commit-msg", "post-commit", "post-checkout", "post-rewrite", "reference-transaction", "pre-rebase", "pre-push", "post-index-change", "pre-auto-gc"])
    script(join(f.root, ".git/hooks", name), `hook ${name}`, "cat > /dev/null; exit 0");
  script(join(f.origin, "hooks/pre-receive"), "the folder remote's pre-receive", "cat > /dev/null; exit 0");
  for (const [name, value] of [["filter.leak.clean", leak], ["filter.leak.smudge", leak], ["diff.leak.textconv", leak], ["diff.leak.command", leak], ["diff.external", leak],
    ["merge.leak.driver", `${leak} %A`], ["core.fsmonitor", leak], ["core.pager", leak], ["alias.st", `!${leak}`]]) f.git("config", name, value);
  const realOf = (name: string) => String(f.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, name)).find(file => existsSync(file))!;
  const tools = join(f.root, "node_modules/.bin"), links = join(f.dir, "links");
  mkdirSync(links);
  for (const name of ["git", "gh", "node", "npm", "bash", "sh"]) {
    script(join(tools, name), `PATH tool ${name}`, `exec ${realOf(name)} "$@"`);
    // And a link a person made to it from a folder of their own on PATH (an npm link, a dotfiles bin).
    symlinkSync(join(tools, name), join(links, name));
  }
  appendFileSync(join(f.root, ".git/info/exclude"), "node_modules/\n");
  // The start-up files BASH_ENV and ENV name, each setting a token: bash would run the first; the check reads both.
  const startup = join(home, ".bash_env"), shStartup = join(home, ".shinit");
  writeFileSync(startup, `export ORBIT_TOKEN=${dummy}\n${note("BASH_ENV")}\n`);
  writeFileSync(shStartup, `export GH_TOKEN=${dummy}\n`);
  // A temporary folder of this test's own (kit pr keeps its program links there), so the check reaches only this kit
  // pr's links, never another one's.
  const tmp = join(f.dir, "tmp"); mkdirSync(tmp);
  const env = { HOME: home, GH_TOKEN: dummy, BASH_ENV: startup, ENV: shStartup, PATH: `${tools}:${links}:${f.env.PATH}`, TMPDIR: tmp } as NodeJS.ProcessEnv;
  // Without kit pr's care they are live: a plain git status in the worktree starts the build's programs.
  spawnSync("git", ["-C", f.root, "status"], { env: { ...f.env, ...env }, encoding: "utf8" });
  assert.ok(readFileSync(noted, "utf8").includes(dummy), "the planted settings are live");
  rmSync(noted);
  // kit pr as the lead starts it: by this Node (the PATH tool node would otherwise start kit pr itself).
  const result = spawnSync(process.execPath, [resolve("kit.d/pr"), "--ticket", "ticket.md"], { cwd: f.root, env: { ...f.env, ...env }, encoding: "utf8", timeout: 60_000 });
  const left = existsSync(noted) ? readFileSync(noted, "utf8") : "";
  assert.ok(!left.includes(dummy), `kit pr ran what the build left with the keys:\n${left}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: ok merged #73/m);
  // The check found kit pr's program links and could not change them.
  assert.match(left, /^saw .*\/kit-pr-programs-[^/]+\/git$/m);
  // The check ran (inside the lock), and the folder remote's hook ran inside it too.
  assert.match(left, /^the project's check\n.*(No such file or directory|Permission denied)\ntoken=\.$/m);
  assert.match(left, /^a check through git\n.*(No such file or directory|Permission denied)\ntoken=\.$/m);
  assert.match(left, /^the folder remote's pre-receive\n.*(No such file or directory|Permission denied)\ntoken=\.$/m);
  for (const who of ["hook ", "a program the Git settings name", "PATH tool git", "PATH tool gh", "PATH tool node", "BASH_ENV", "a program the check swapped in"])
    assert.ok(!left.includes(who), `${who.trim()} ran: ${left}`);
  // The work landed: rebased on the new upstream, with kit pr's own commit naming the commits.
  assert.equal(f.gitAt(f.origin, "log", "-1", "--format=%s", "refs/heads/feature/kit-pr"), "docs: ticket commits by subject");
});

test("kit pr refuses a fetch while the repository's own Git config holds http or credential settings, stops on Git LFS, and says where its checks run unlocked", t => {
  const f = fixture(t);
  f.git("config", "http.proxy", "http://127.0.0.1:1");
  const steered = f.run();
  assert.equal(steered.status, 1, steered.stdout + steered.stderr);
  assert.match(steered.stdout, /^RESULT: fail fetch: the repository's own Git config holds http\.proxy, which could send the credentials of a fetch or push elsewhere/m);
  f.git("config", "--unset", "http.proxy");
  // Git LFS's filter would not run, so a rebase would leave pointer files: kit pr stops before it, for attributes in a
  // folder of the branch, and for the land branch's own once it took up LFS.
  mkdirSync(join(f.root, "assets"));
  writeFileSync(join(f.root, "assets/.gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  f.git("add", "assets/.gitattributes"); f.git("commit", "-qm", "Track binaries with LFS");
  const lfs = f.run();
  assert.equal(lfs.status, 1, lfs.stdout + lfs.stderr);
  assert.match(lfs.stdout, /^RESULT: fail lfs: this repository uses Git LFS \(filter=lfs in HEAD:assets\/\.gitattributes\); kit pr does not read your global Git config, where Git LFS is set up/m);
  assert.equal(f.calls().some(call => call.tool === "gh"), false);
  f.git("reset", "-q", "--hard", "HEAD~1");
  const peer = f.peer();
  writeFileSync(join(peer, ".gitattributes"), "*.psd filter=lfs -text\n");
  f.gitAt(peer, "add", ".gitattributes"); f.gitAt(peer, "commit", "-qm", "LFS on dev"); f.gitAt(peer, "push", "-q", "origin", "dev");
  const landLfs = f.run();
  assert.equal(landLfs.status, 1, landLfs.stdout + landLfs.stderr);
  assert.match(landLfs.stdout, /^RESULT: fail lfs: this repository uses Git LFS \(filter=lfs in origin\/dev:\.gitattributes\)/m);
  // With the lock off, LFS is the project's own business again, and the checks say they ran unlocked.
  const off = f.run([], { ASE_KEY_GUARD: "off" });
  assert.equal(off.status, 0, off.stdout + off.stderr);
  assert.match(off.stdout, /^checks: not locked \(ASE_KEY_GUARD=off\)$/m);
  assert.match(f.body(), /^- checks: not locked \(ASE_KEY_GUARD=off\)$/m);
});

test("on a system without bubblewrap kit pr's checks run unlocked and the PR says so; a check that changes kit pr's program links stops it", t => {
  const f = fixture(t);
  const unlocked = { PATH: `${f.bin}:${pathWithoutBwrap(f.dir)}`, ...onMacos };
  const result = f.run([], unlocked);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(f.body(), /^- checks: not locked \(no bubblewrap on this machine; token variables are still dropped\)$/m);
  // An unlocked check can write kit pr's own links: the next start stops kit pr instead of taking what it left.
  const g = fixture(t, undefined, { checks: { check: "sh scripts/swap.sh", test: "npm test", lint: "npm run lint" } });
  writeFileSync(join(g.root, "scripts/swap.sh"), 'for f in "$TMPDIR"/kit-pr-programs-*/git; do ln -sf /bin/true "$f"; done\n');
  g.git("add", "scripts/swap.sh"); g.git("commit", "-qm", "Swap");
  const tmp = join(g.dir, "tmp"); mkdirSync(tmp);
  const swapped = g.run([], { ...unlocked, PATH: `${g.bin}:${pathWithoutBwrap(g.dir)}`, TMPDIR: tmp });
  assert.equal(swapped.status, 1, swapped.stdout + swapped.stderr);
  assert.match(swapped.stdout, /^RESULT: fail check: kit pr's own link to git \(\S+\/kit-pr-programs-[^/]+\/git\) was changed while it ran; run kit pr again$/m);
  assert.deepEqual(readdirSync(tmp).filter(name => name.startsWith("kit-pr-programs-")), [], "the folder goes when kit pr ends");
});

// TOOLS-320: a program kit pr starts outside the lock (gh, after the checks) that changes kit pr's own program links stops
// the very next start (the check before every start, not only the one after each check).
test("a gh that changes kit pr's program links stops kit pr at its next start", t => {
  const f = fixture(t);
  const tmp = join(f.dir, "tmp"); mkdirSync(tmp);
  const result = f.run([], { TMPDIR: tmp, FAKE_GH_SWAP: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail open: kit pr's own link to git \(\S+\/kit-pr-programs-[^/]+\/git\) was changed while it ran; run kit pr again$/m);
  assert.equal(f.calls().filter(call => call.tool === "gh").length, 1, "nothing started after the gh that changed the link");
});

// TOOLS-320: git's ssh for kit pr's fetch and push is found as kit pr finds its own programs: an ssh PATH holds only as a
// link into the worktree (a person's link to a script a build can change) is never started; a push to an ssh remote
// stops and says why. On Linux git's ssh runs in the clean room (TOOLS-390), where that link leads nowhere.
test("kit pr's push to an ssh remote never starts an ssh PATH holds only as a link into the worktree", t => {
  const f = fixture(t);
  f.git("config", "remote.origin.pushurl", "ssh://example.invalid/repo.git");
  const links = join(f.dir, "links"), planted = join(f.root, "tools/ssh");
  mkdirSync(links); mkdirSync(dirname(planted));
  writeFileSync(planted, `#!/bin/sh\necho planted >> ${JSON.stringify(join(f.dir, "planted.txt"))}\n`, { mode: 0o755 });
  appendFileSync(join(f.root, ".git/info/exclude"), "tools/\n");
  symlinkSync(planted, join(links, "ssh"));
  const pushLog = (result: ReturnType<typeof f.run>) => {
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /^RESULT: fail push: /m);
    assert.ok(!existsSync(join(f.dir, "planted.txt")), "the planted ssh never started");
    return readFileSync(join(/^logs: (.+)$/m.exec(result.stdout)![1], "push.log"), "utf8");
  };
  const roomed = pushLog(f.run([], { PATH: `${f.bin}:${links}:${pathWithout(f.dir, ["ssh"], "no-ssh-bin")}` }));
  // In the room the worktree is empty, so the link finds no ssh, and the kit says where it looked in plain words.
  if (roomUsable) assert.match(roomed, /ssh: not found\nkit: a program was not found \(exit 127\)\. If it was git's ssh or a program it starts, the clean room keeps these folders empty: /);
  // Without bubblewrap (macOS) the path filter refuses that ssh and says why.
  const filtered = pushLog(f.run([], { PATH: `${f.bin}:${links}:${join(f.dir, "no-ssh-bin")}`, ...onMacos }));
  assert.match(filtered, /kit: ssh on PATH is \S+\/links\/ssh, a link into the worktree or its Git folder/);
  // A push that starts no ssh (the folder remote) goes through all the same.
  f.git("config", "--unset", "remote.origin.pushurl");
  const folder = f.run([], { PATH: `${f.bin}:${links}:${join(f.dir, "no-ssh-bin")}` });
  assert.equal(folder.status, 0, folder.stdout + folder.stderr);
  assert.ok(!existsSync(join(f.dir, "planted.txt")), "the planted ssh never started");
});

// TOOLS-320 (A3 release review): git pushes to every push address a remote lists, rewrites applied, so kit pr weighs them
// all: a folder among them (whose hooks git runs without kit pr's Git settings) is refused unless every one is a folder
// (then the push runs inside the key lock), and so is an address on this machine itself (localhost), whose hooks run
// outside any lock.
test("kit pr refuses a push whose remote lists a folder after another push address, or one on this machine", t => {
  const f = fixture(t);
  const noted = join(f.dir, "hook.txt");
  writeFileSync(join(f.origin, "hooks/pre-receive"), `#!/bin/sh\necho ran >> ${JSON.stringify(noted)}\ncat > /dev/null\n`, { mode: 0o755 });
  // A build lists an outside address first and the folder second. The outside one is an ssh remote whose ssh (the
  // lead's, outside the worktree) serves a bare repository here, so its push goes through and git goes on to the next.
  const mirror = join(f.dir, "mirror.git");
  f.gitAt(f.dir, "init", "-q", "--bare", mirror);
  writeFileSync(join(f.bin, "ssh"), '#!/bin/sh\nfor arg; do last=$arg; done\nexec /bin/sh -c "$last"\n', { mode: 0o755 });
  f.git("config", "--add", "remote.origin.pushurl", `ssh://example.invalid${mirror}`);
  f.git("config", "--add", "remote.origin.pushurl", f.origin);
  const mixed = f.run();
  assert.ok(!existsSync(noted), `the folder's hook ran outside the lock:\n${mixed.stdout}`);
  assert.equal(mixed.status, 1, mixed.stdout + mixed.stderr);
  assert.match(mixed.stdout, /^RESULT: fail push: origin pushes to a folder on this machine \(\S+origin\.git\) beside other addresses \(ssh:\/\/example\.invalid\S+mirror\.git\)/m);
  // The same through a rewrite: the second address only becomes the folder through url.<folder>.insteadOf.
  f.git("config", "--unset-all", "remote.origin.pushurl");
  f.git("config", "--add", "remote.origin.pushurl", `ssh://example.invalid${mirror}`);
  f.git("config", "--add", "remote.origin.pushurl", "https://mirror.invalid/origin.git");
  f.git("config", `url.${dirname(f.origin)}/.insteadOf`, "https://mirror.invalid/");
  const rewritten = f.run();
  assert.equal(rewritten.status, 1, rewritten.stdout + rewritten.stderr);
  assert.match(rewritten.stdout, /^RESULT: fail push: origin pushes to a folder on this machine/m);
  assert.ok(!existsSync(noted), "the folder's hook never ran");
  // The same from url entries alone (git pushes to each where no pushurl is set); the advice names both keys.
  f.git("config", "--unset-all", "remote.origin.pushurl");
  f.git("config", "--add", "remote.origin.url", `ssh://example.invalid${mirror}`);
  const urls = f.run();
  assert.equal(urls.status, 1, urls.stdout + urls.stderr);
  assert.match(urls.stdout, /^RESULT: fail push: origin pushes to a folder on this machine .* keep one push address in remote\.origin\.pushurl or remote\.origin\.url/m);
  assert.ok(!existsSync(noted), "the folder's hook never ran");
  f.git("config", "--unset", "remote.origin.url", "ssh://");
  // An address on this machine itself, by ssh or any other transport.
  f.git("config", "--add", "remote.origin.pushurl", "ssh://git@localhost/srv/repo.git");
  const loopback = f.run();
  assert.equal(loopback.status, 1, loopback.stdout + loopback.stderr);
  assert.match(loopback.stdout, /^RESULT: fail push: origin pushes to this machine itself \(ssh:\/\/(git@)?localhost\/srv\/repo\.git\)/m);
  // One only its address tells.
  f.git("config", "--unset-all", "remote.origin.pushurl");
  f.git("config", "--add", "remote.origin.pushurl", "ssh://127.1/srv/repo.git");
  const resolved = f.run();
  assert.equal(resolved.status, 1, resolved.stdout + resolved.stderr);
  assert.match(resolved.stdout, /^RESULT: fail push: origin pushes to this machine itself \(ssh:\/\/127\.1\/srv\/repo\.git\)/m);
  // A user name with @ in it: ssh takes the host after the last one.
  f.git("config", "--unset-all", "remote.origin.pushurl");
  f.git("config", "--add", "remote.origin.pushurl", "ssh://a@b@localhost/srv/repo.git");
  const user = f.run();
  assert.equal(user.status, 1, user.stdout + user.stderr);
  assert.match(user.stdout, /^RESULT: fail push: origin pushes to this machine itself \(ssh:\/\/(a@b@)?localhost\/srv\/repo\.git\)/m);
  // Every address a folder: the push runs inside the key lock, as before.
  f.git("config", "--unset-all", "remote.origin.pushurl");
  f.git("config", "--add", "remote.origin.pushurl", f.origin);
  const folders = f.run();
  assert.equal(folders.status, 0, folders.stdout + folders.stderr);
  assert.match(readFileSync(noted, "utf8"), /^ran$/m);
});

// TOOLS-329 (SL-3): the push reads the global and system Git config, so their URL rewrites count in kit pr's check of
// the push addresses too: one that takes an outside address to this machine stops the push before any ssh starts.
test("kit pr weighs push addresses with the global and system URL rewrites the push applies", t => {
  const f = fixture(t);
  const noted = join(f.dir, "ssh.txt");
  writeFileSync(join(f.bin, "ssh"), `#!/bin/sh\necho "ssh $*" >> ${JSON.stringify(noted)}\nexit 1\n`, { mode: 0o755 });
  f.git("config", "--add", "remote.origin.pushurl", "https://mirror.invalid/repo.git");
  const rewrite = join(f.dir, "rewrite.gitconfig");
  writeFileSync(rewrite, '[url "ssh://git@localhost/srv/"]\n\tinsteadOf = https://mirror.invalid/\n');
  for (const [where, overrides] of [["global", { GIT_CONFIG_GLOBAL: rewrite }], ["system", { GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_SYSTEM: rewrite }]] as const) {
    rmSync(noted, { force: true });
    const result = f.run([], overrides);
    assert.equal(result.status, 1, `${where}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^RESULT: fail push: origin pushes to this machine itself \(ssh:\/\/(git@)?localhost\/srv\/repo\.git\)/m, where);
    assert.ok(!existsSync(noted), `${where}: an ssh started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  }
});
