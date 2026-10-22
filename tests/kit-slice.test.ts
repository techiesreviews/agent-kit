import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { forEachAwait } from "./support/await-race.ts";

const kit = resolve("scripts/agents/kit");
const clean = "REVIEW_STATUS: complete\nDefects:\nSpec: none\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
const findings = "REVIEW_STATUS: complete\nDefects:\nSpec:\n- file.txt:1 P1 restore required text\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
interface Call { phase: string; args: string[] }
interface State { finished: string[]; build: string; buildModel?: string; review: string; reviewedHead: string; rounds: number; pendingFix?: boolean; pr?: string; queued?: { head: string }; model: string; effort: string; previousModels?: string[] }

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-slice-"));
  const children: ChildProcess[] = [], releases: string[] = [];
  t.after(async () => {
    for (const path of releases) writeFileSync(path, "cleanup");
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      child.kill("SIGTERM");
      return new Promise<void>(accept => child.once("close", () => accept()));
    }));
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, "work tree"), main = join(dir, "main"), bin = join(dir, "bin");
  for (const path of [root, main, bin]) mkdirSync(path);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "build/ke-04"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  const hooks = join(root, ".git/test-hooks"); mkdirSync(hooks);
  git("config", "core.hooksPath", hooks);
  const ticket = "docs/tickets/04-ticket.md";
  mkdirSync(join(root, "docs/tickets"), { recursive: true });
  writeFileSync(join(root, ticket), '---\ntitle: "Test slice title"\nstatus: ready-for-agent\n---\n\n## Files\n- `file.txt`\n\n## Done when\n- Required content is present.\n');
  writeFileSync(join(root, ".gitignore"), ".scratch/\n");
  writeFileSync(join(root, "file.txt"), "base\n");
  git("add", "-A"); git("commit", "-m", "base");
  const head = git("rev-parse", "HEAD"), callsFile = join(dir, "calls.jsonl");
  const shared = `
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const phase = args[0];
function call(name) {
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ phase: name, args }) + "\\n");
  if (process.env.FAIL_PHASE === name || (process.env.FAIL_FIX_REVIEW && name === "review" && round() > 0)) {
    for (let n = 0; n < 40; n++) console.error("failure-detail-" + n);
    console.log("RESULT: fail " + name + " deliberate failure");
    process.exit(7);
  }
}
async function hold(name) {
  if (process.env.HOLD_PHASE !== name) return;
  writeFileSync(process.env.HOLD_READY, "ready");
  await new Promise(accept => {
    const timer = setInterval(() => { if (existsSync(process.env.HOLD_RELEASE)) { clearInterval(timer); accept(); } }, 10);
  });
}
const counter = join(".scratch", "fake-round");
const round = () => existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
function evidence() {
  const folder = join(process.env.KIT_MAIN_ROOT, ".scratch/reviews/ke-04", String(round()).padStart(3, "0"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "refs.txt"), git("rev-parse", "HEAD") + "\\n");
  const open = round() < Number(process.env.CLEAN_AT || 0);
  const report = process.env.MINOR_REVIEW && round() >= 3 ? ${JSON.stringify(findings)}.replace("P1", "P2").replace("Standards: none", "Standards: P3: Cosmetic issue") : ${JSON.stringify(findings)};
  writeFileSync(join(folder, "result.md"), process.env.UNREADABLE_REVIEW ? "partial" : open ? report : ${JSON.stringify(clean)});
  return { folder, open };
}
`;
  const agent = join(bin, "agent.mjs");
  writeFileSync(agent, `#!/usr/bin/env node\n${shared}
call("build");
await hold("build");
if (!process.env.NO_BUILD_CHANGES) writeFileSync("file.txt", "built\\n");
const out = args[args.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "status.json"), JSON.stringify({ kind: "build", model: args[args.indexOf("--model") + 1], worktree: process.cwd(), out,
  pid: 2147483647, cli: "codex", effort: "high", state: "done", exitCode: 0, brief: join(process.cwd(), ".scratch/agent-brief.md"),
  resumes: 0, session: "builder-session", started: "2026-10-19T00:00:00Z" }));
writeFileSync(join(out, "out.md"), "Initial builder report.\\n"); writeFileSync(join(out, "run.log"), "initial log\\n");
console.log("artifacts: " + out);
`);
  const fakeKit = join(bin, "kit.mjs");
  writeFileSync(fakeKit, `#!/usr/bin/env node\n${shared}
call(phase);
await hold(phase);
if (phase === "fix" && process.env.REAL_FIX) {
  const result = spawnSync("bash", [${JSON.stringify(kit)}, ...args], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
if (args.includes("--waive")) throw new Error("waive forbidden");
if (phase === "review") {
  const { folder } = evidence();
  console.log("RESULT: ok review git diff origin/dev...HEAD evidence " + folder);
} else if (phase === "fix") {
  const fixes = join(process.cwd(), ".scratch/kit-fix", encodeURIComponent(git("branch", "--show-current")));
  const pending = join(fixes, "pending.json");
  if (process.env.FAIL_FIX_BUILDER && !existsSync(pending)) {
    mkdirSync(fixes, { recursive: true });
    writeFileSync(pending, JSON.stringify({ phase: "builder", model: process.env.FAIL_FIX_BUILDER, round: 1 }));
    console.log("RESULT: fail fix builder failed");
    process.exit(7);
  }
  writeFileSync(counter, String(round() + 1));
  mkdirSync(fixes, { recursive: true });
  writeFileSync(join(fixes, "round-" + round() + ".md"), "Completed fix brief");
  writeFileSync("file.txt", "fix round " + round() + "\\n");
  git("add", "-A"); git("commit", "-m", "Review fixes round " + round());
  rmSync(pending, { force: true });
  const { folder, open } = evidence();
  console.log(open ? "RESULT: fail fix 1 open findings (" + folder + "/result.md)" : "RESULT: ok fix clean");
  process.exitCode = open ? 1 : 0;
} else if (phase === "pr") {
  const { folder, open } = evidence();
  if (open && !(process.env.MINOR_REVIEW && round() >= 3)) {
    console.log("RESULT: fail pr #42 review has 1 open findings (" + folder + "/result.md)");
    process.exitCode = 1;
  } else if (args.includes("--no-merge")) console.log("RESULT: ok opened #42 " + git("rev-parse", "--short", "HEAD"));
  else if (process.env.QUEUE_PR) console.log("RESULT: ok queued #42 " + git("rev-parse", "HEAD"));
  else {
    if (process.env.ADD_FOLLOWUPS) {
      const ticket = args[args.indexOf("--ticket") + 1];
      if (!readFileSync(ticket, "utf8").includes("### Follow-ups")) {
        appendFileSync(ticket, "\\n## Done (2026-10-19)\\n\\n### Follow-ups\\n\\n- Spec (P2): Minor issue\\n");
        git("add", "--", ticket); git("commit", "-m", "docs: ticket follow-ups from review");
      }
      if (process.env.FAIL_AFTER_FOLLOWUPS) { console.log("RESULT: fail ci: deliberate failure"); process.exit(1); }
    }
    writeFileSync(".scratch/merged", "yes");
    console.log("RESULT: ok merged #42 " + git("rev-parse", "HEAD"));
  }
}
`);
  const gh = join(bin, "gh.mjs");
  writeFileSync(gh, `#!/usr/bin/env node\n${shared}
call("merge");
if (process.env.MERGE_FAILURE) { console.error("merge lookup failed"); process.exit(7); }
const queries = join(".scratch", "merge-queries");
const count = existsSync(queries) ? Number(readFileSync(queries, "utf8")) + 1 : 1;
writeFileSync(queries, String(count));
const merged = !process.env.MERGE_PENDING && count >= Number(process.env.MERGE_AFTER || 1);
console.log(JSON.stringify({ state: merged ? "MERGED" : "OPEN", mergeCommit: merged ? { oid: "a".repeat(40) } : null,
  headRefOid: process.env.MERGE_CHANGED_HEAD ? "b".repeat(40) : git("rev-parse", "HEAD") }));
`);
  chmodSync(gh, 0o755); chmodSync(agent, 0o755); chmodSync(fakeKit, 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: root, KIT_MAIN_ROOT: main, ASE_OWNER: "ke-04", ASE_SLICE_AGENT: agent,
    ASE_SLICE_KIT: fakeKit, ASE_SLICE_GH: gh, ASE_SLICE_MERGE_POLL_MS: "1", ASE_SLICE_MERGE_TIMEOUT_MS: "5000", FAKE_CALLS: callsFile };
  const args = ["--ticket", ticket, "--builder", "sol"];
  const run = (extra: string[] = [], overrides: NodeJS.ProcessEnv = {}, commandArgs: string[] = args) => {
    const result = spawnSync("bash", [kit, "slice", ...commandArgs, ...extra], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000 });
    const lines = result.stdout.trim().split("\n"), results = lines.filter(line => line.startsWith("RESULT:"));
    assert.equal(results.length, 1, result.stdout + result.stderr);
    assert.equal(lines.at(-1), results[0]);
    assert.ok(result.stderr.trim().split("\n").filter(Boolean).length <= 15, result.stderr);
    return result;
  };
  const calls = (): Call[] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const statePath = join(root, ".scratch/kit-slice/04-ticket/state.json");
  const state = (): State => JSON.parse(readFileSync(statePath, "utf8"));
  const start = (overrides: NodeJS.ProcessEnv) => {
    if (overrides.HOLD_RELEASE) releases.push(overrides.HOLD_RELEASE);
    const child = spawn("bash", [kit, "slice", ...args], { cwd: root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((accept, reject) => {
      child.once("error", reject); child.once("close", status => accept({ status, stdout, stderr }));
    });
  };
  const realFix = (): NodeJS.ProcessEnv => {
    const commands = join(dir, "commands"); mkdirSync(commands);
    symlinkSync(resolve("scripts/agents/kit.d/slice"), join(commands, "slice"));
    symlinkSync(resolve("scripts/agents/kit.d/fix"), join(commands, "fix"));
    const review = join(commands, "review");
    writeFileSync(review, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const result = spawnSync(${JSON.stringify(fakeKit)}, ["review", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
`);
    chmodSync(review, 0o755);
    const codex = join(bin, "codex");
    writeFileSync(codex, `#!/usr/bin/env node\n${shared}
readFileSync(0, "utf8"); call("resume");
writeFileSync(counter, String(round() + 1));
writeFileSync("file.txt", "preserved real fix\\n");
writeFileSync(args[args.indexOf("-o") + 1], "Fixed the defect.\\n");
console.error("model: " + args[args.indexOf("-m") + 1]); console.error("session id: builder-session");
`);
    chmodSync(codex, 0o755);
    return { REAL_FIX: "1", KIT_COMMANDS_DIR: commands, ASE_SKIP_DOCTOR: "1", ASE_RESUME_POLL_MS: "10", ASE_AGENT_TIMEOUT: "10s" };
  };
  return { dir, root, main, hooks, ticket, git, head, run, calls, state, env, start, realFix };
}

test("kit slice help and invalid options never launch commands", t => {
  const f = fixture(t);
  const help = spawnSync("bash", [kit, "slice", "--help"], { env: f.env, encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /Usage: kit slice/);
  for (const extra of [["--waive", "reason"], ["--rounds", "0"], ["--rounds", "wat"], ["--rounds", "1.5"], ["--effort"], ["--builder", "sol"]]) {
    assert.equal(f.run(extra).status, 1);
  }
  assert.deepEqual(f.calls(), []);
});

test("kit slice writes the ticket brief, runs phases in order, credits and commits the builder, and lands", t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const brief = readFileSync(join(f.root, ".scratch/agent-brief.md"), "utf8");
  for (const text of [f.ticket, "## Files", "`file.txt`", "## Done when", "Required content", "## Done (YYYY-MM-DD)", "describing only behaviour, tests and commits", "status: closed", "assignee: ke-04", "scripts/agents/kit"]) assert.ok(brief.includes(text), text);
  assert.match(brief, /Do not run kit review, kit fix, kit slice, kit pr, kit bg or agent\.sh/);
  assert.match(brief, /the slice runs those commands/);
  assert.match(brief, /Validate with scripts\/agents\/kit unit --affected/);
  assert.match(brief, /run npm run check when types moved/);
  assert.match(brief, /the slice records review decisions and landing/);
  assert.match(brief, /Leave changes unstaged; the runner commits/);
  assert.deepEqual(result.stdout.split("\n").filter(line => line.startsWith("slice:")).map(line => line.split(" ").slice(0, 3).join(" ")), ["slice: brief ok", "slice: build ok", "slice: commit ok", "slice: review ok", "slice: fix ok", "slice: pr ok"]);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "pr"]);
  const build = f.calls()[0].args;
  assert.deepEqual(build.slice(0, 7), ["build", f.root, ".scratch/agent-brief.md", "--model", "gpt-6.1-sol", "--effort", "high"]);
  const head = f.git("rev-parse", "HEAD");
  assert.ok(result.stdout.endsWith(`RESULT: ok slice ${f.ticket} PR #42 ${head}\n`));
  assert.equal(f.git("rev-parse", "HEAD^"), f.head);
  assert.equal(f.git("log", "-1", "--format=%B"), "Test slice title\n\nCo-Authored-By: GPT-6.1-Sol <noreply@openai.com>");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.state().pr, "42"); assert.ok(existsSync(join(f.state().build, "status.json")));
  for (const phase of ["brief", "build", "commit", "review", "fix", "pr"]) assert.ok(existsSync(join(f.root, ".scratch/kit-slice/04-ticket", phase + ".log")));
});

test("kit slice fixes findings in round two and never passes waive", t => {
  const f = fixture(t), result = f.run([], { CLEAN_AT: "2" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "fix", "fix", "pr"]);
  assert.equal(f.state().rounds, 2);
  assert.equal(f.git("rev-list", "--count", `${f.head}..HEAD`), "3");
  for (const call of f.calls()) assert.equal(call.args.includes("--waive"), false);
});

test("kit slice leaves exhausted findings unmerged, lists them, saves the PR and resumes fix when rounds increase", t => {
  const f = fixture(t), result = f.run(["--rounds", "2"], { CLEAN_AT: "3" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /RESULT: fail slice fix: 1 open findings after 2 rounds \(.+result\.md\)/);
  assert.match(result.stderr, /Spec: file\.txt:1 P1 restore required text/);
  assert.equal(existsSync(join(f.root, ".scratch/merged")), false);
  assert.equal(f.state().pr, "42");
  assert.ok(f.calls().at(-1)?.args.includes("--no-merge"));
  const retry = f.run(["--rounds", "3"], { CLEAN_AT: "3" });
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "fix", "fix", "pr", "fix", "pr"]);
});

test("kit slice --no-pr finishes reviewed clean, then can land without rebuilding", t => {
  const f = fixture(t), result = f.run(["--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /slice: pr ok skipped \(--no-pr\)/);
  assert.ok(result.stdout.endsWith(`RESULT: ok slice ${f.ticket} reviewed clean ${f.git("rev-parse", "HEAD")}\n`));
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review"]);
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "pr"]);
});

test("kit slice --no-pr also leaves exhausted findings without opening a PR", t => {
  const f = fixture(t), result = f.run(["--no-pr", "--rounds", "1"], { CLEAN_AT: "9" });
  assert.equal(result.status, 1); assert.match(result.stdout, /fail slice fix/);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "fix"]);
});

for (const phase of ["brief", "build", "commit", "review", "fix", "pr"]) test(`kit slice resumes a failed ${phase} phase without repeating finished phases`, t => {
  const f = fixture(t);
  if (phase === "brief") mkdirSync(join(f.root, ".scratch/agent-brief.md"), { recursive: true });
  if (phase === "commit") {
    const hook = join(f.hooks, "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho rejected >&2\nexit 1\n"); chmodSync(hook, 0o755);
  }
  const options = phase === "fix" ? { CLEAN_AT: "1" } : {};
  const failed = f.run([], { ...options, FAIL_PHASE: phase });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, new RegExp(`slice: ${phase} fail`));
  assert.match(failed.stdout, new RegExp(`RESULT: fail slice ${phase}:`));
  const before = f.calls().map(call => call.phase);
  if (phase === "brief") rmSync(join(f.root, ".scratch/agent-brief.md"), { recursive: true });
  if (phase === "commit") rmSync(join(f.hooks, "pre-commit"));
  const retry = f.run([], options);
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  const after = f.calls().map(call => call.phase);
  assert.equal(after.filter(name => name === "build").length, phase === "build" ? 2 : 1);
  if (["commit", "review", "fix", "pr"].includes(phase)) assert.equal(retry.stdout.includes("slice: build ok"), false);
  if (["fix", "pr"].includes(phase)) assert.equal(after.filter(name => name === "review").length, before.filter(name => name === "review").length);
});

test("kit slice bounds failure output to 15 lines and retains the full phase log", t => {
  const f = fixture(t), result = f.run([], { FAIL_PHASE: "review" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim().split("\n").length, 15);
  assert.equal(result.stderr.includes("failure-detail-0\n"), false);
  const log = readFileSync(join(f.root, ".scratch/kit-slice/04-ticket/review.log"), "utf8");
  assert.match(log, /failure-detail-0\n/); assert.match(log, /failure-detail-39/);
});

test("kit slice fails clearly when the builder changes nothing", t => {
  const f = fixture(t), result = f.run([], { NO_BUILD_CHANGES: "1" });
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice commit: nothing to commit/);
  assert.deepEqual(f.calls().map(call => call.phase), ["build"]);
});

test("kit slice re-reviews moved HEAD without rebuilding and rejects switching branches", t => {
  const f = fixture(t);
  assert.equal(f.run(["--no-pr"]).status, 0);
  writeFileSync(join(f.root, "file.txt"), "later implementation work\n");
  f.git("add", "file.txt"); f.git("commit", "-m", "later work");
  const result = f.run(["--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "review"]);
  assert.equal(f.state().reviewedHead, f.git("rev-parse", "HEAD"));
  f.git("switch", "-c", "other");
  assert.match(f.run().stdout, /saved slice belongs to a different/);
});

test("kit slice resumes with another builder, keeps finished phases and records the switch", t => {
  const f = fixture(t), original = ["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--no-pr"];
  const failed = f.run([], { CLEAN_AT: "1", FAIL_PHASE: "fix" }, original);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const finished = f.state().finished.slice();
  assert.deepEqual(finished, ["brief", "build", "commit", "review"]);
  const result = f.run([], {}, ["--ticket", f.ticket, "--builder", "claude-opus-5-5", "--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> claude-opus-5-5/);
  assert.deepEqual(f.state().finished, [...finished, "fix"]);
  assert.equal(f.state().model, "claude-opus-5-5");
  assert.deepEqual(f.state().previousModels, ["gpt-6.1-sol"]);
  assert.equal(f.calls().filter(call => call.phase === "build").length, 1);
  const fix = f.calls().filter(call => call.phase === "fix").at(-1)!;
  assert.equal(fix.args[fix.args.indexOf("--builder") + 1], "claude-opus-5-5");
  assert.equal(fix.args.includes("--run"), false);
});

test("kit slice switches builder during a half-done fix round and keeps its pending edits", t => {
  const f = fixture(t), original = ["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--no-pr"];
  const failed = f.run([], { CLEAN_AT: "1", FAIL_FIX_BUILDER: "gpt-6.1-sol" }, original);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const pending = join(f.root, ".scratch/kit-fix/build%2Fke-04/pending.json");
  assert.equal(JSON.parse(readFileSync(pending, "utf8")).phase, "builder");
  assert.equal(f.state().pendingFix, true);
  const result = f.run([], { CLEAN_AT: "1" }, ["--ticket", f.ticket, "--builder", "claude-opus-5-5", "--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> claude-opus-5-5/);
  assert.equal(f.state().model, "claude-opus-5-5");
  assert.equal(f.state().pendingFix, undefined);
  assert.equal(existsSync(pending), false, "the resumed round clears its pending state");
  assert.equal(f.calls().filter(call => call.phase === "build").length, 1);
  const fix = f.calls().filter(call => call.phase === "fix").at(-1)!;
  assert.equal(fix.args[fix.args.indexOf("--builder") + 1], "claude-opus-5-5");
  assert.equal(fix.args.includes("--run"), false);
});

test("kit slice switches builder after its initial build fails", t => {
  const f = fixture(t), original = ["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--no-pr"];
  const failed = f.run([], { FAIL_PHASE: "build" }, original);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.deepEqual(f.state().finished, ["brief"]);
  const result = f.run([], {}, ["--ticket", f.ticket, "--builder", "claude-opus-5-5", "--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> claude-opus-5-5/);
  assert.deepEqual(f.state().previousModels, ["gpt-6.1-sol"]);
  const builds = f.calls().filter(call => call.phase === "build");
  assert.equal(builds.length, 2);
  assert.equal(builds[1].args[builds[1].args.indexOf("--model") + 1], "claude-opus-5-5");
  assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: Claude Opus 5\.5 <noreply@anthropic\.com>/);
});

test("kit slice credits its build to the model that finished the build, then fix rounds to the resumed builder", t => {
  const f = fixture(t), real = f.realFix();
  const hook = join(f.hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  const original = ["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--no-pr"];
  const failed = f.run([], { ...real, CLEAN_AT: "1" }, original);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /RESULT: fail slice commit:/);
  assert.deepEqual(f.state().finished, ["brief", "build"]);
  assert.equal(f.state().buildModel, "gpt-6.1-sol");
  rmSync(hook);
  const result = f.run([], { ...real, CLEAN_AT: "1" }, ["--ticket", f.ticket, "--builder", "gpt-6-luna", "--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> gpt-6-luna/);
  assert.equal(f.calls().filter(call => call.phase === "build").length, 1);
  assert.equal(f.state().buildModel, "gpt-6.1-sol");
  assert.equal(f.state().model, "gpt-6-luna");
  assert.match(f.git("log", "-1", "--skip=1", "--format=%B"), /^Test slice title\n\nCo-Authored-By: GPT-6\.1-Sol <noreply@openai\.com>$/);
  assert.match(f.git("log", "-1", "--format=%B"), /^Review fixes round 1\n\nCo-Authored-By: GPT-6-Luna <noreply@openai\.com>$/);
});

test("slice switched while real kit fix's builder step failed retargets that round", t => {
  const f = fixture(t), real = f.realFix();
  // The fake codex routes any non-Claude model name, so the real agent.sh never starts a real CLI.
  const failed = f.run([], { ...real, CLEAN_AT: "1", FAIL_PHASE: "resume" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const directory = join(f.root, ".scratch/kit-fix/build%2Fke-04");
  const pending: { phase: string; run: string } = JSON.parse(readFileSync(join(directory, "pending.json"), "utf8"));
  assert.equal(pending.phase, "builder");
  const result = f.run([], { ...real, CLEAN_AT: "1" }, ["--ticket", f.ticket, "--builder", "other-model"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> other-model/);
  assert.match(readFileSync(join(f.root, ".scratch/kit-slice/04-ticket/fix.log"), "utf8"), /builder switched: gpt-6\.1-sol -> other-model/);
  const [first, retry] = f.calls().filter(call => call.phase === "resume");
  assert.ok(first.args.includes("resume"));
  assert.equal(retry.args.includes("resume"), false, "the switched round starts a fresh build");
  assert.equal(retry.args[retry.args.indexOf("-m") + 1], "other-model");
  const run = dirname(retry.args[retry.args.indexOf("-o") + 1]);
  assert.notEqual(run, pending.run);
  assert.match(run, /\/\.scratch\/agent\/build-[^/]+$/);
  assert.equal(f.state().rounds, 1);
  assert.deepEqual(readdirSync(directory).filter(name => /^round-\d+\.md$/.test(name)), ["round-1.md"]);
  assert.equal(f.git("log", "-1", "--format=%s"), "Review fixes round 1");
  assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: other-model <noreply@openai\.com>/);
});

test("kit slice resumes with another effort and keeps refusing a different ticket", t => {
  const f = fixture(t), original = ["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--effort", "high", "--no-pr"];
  assert.equal(f.run([], { CLEAN_AT: "1", FAIL_PHASE: "fix" }, original).status, 1);
  const result = f.run([], {}, ["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--effort", "low", "--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> gpt-6\.1-sol \(low\)/);
  assert.equal(f.state().effort, "low");
  const fix = f.calls().filter(call => call.phase === "fix").at(-1)!;
  assert.equal(fix.args[fix.args.indexOf("--effort") + 1], "low");
  const other = "docs/tickets/05-ticket.md", statePath = join(f.root, ".scratch/kit-slice/04-ticket/state.json");
  writeFileSync(join(f.root, other), '---\ntitle: "Other ticket"\nstatus: ready-for-agent\n---\n\n## Files\n- `file.txt`\n\n## Done when\n- Required content is present.\n');
  writeFileSync(statePath, JSON.stringify({ ...f.state(), ticket: other }, null, 2) + "\n");
  const refused = f.run([], {}, ["--ticket", f.ticket, "--builder", "claude-opus-5-5", "--no-pr"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /saved slice belongs to a different ticket or branch/);
});

test("kit slice treats unreadable review evidence as open findings", t => {
  const f = fixture(t), result = f.run(["--rounds", "1", "--no-pr"], { UNREADABLE_REVIEW: "1" });
  assert.equal(result.status, 1); assert.match(result.stdout, /fail slice fix: 1 open findings/);
  assert.match(result.stderr, /review format unreadable/);
});


test("kit slice defaults to three fix rounds and keeps their complete logs", t => {
  const f = fixture(t), result = f.run([], { CLEAN_AT: "9" });
  assert.equal(result.status, 1); assert.match(result.stdout, /after 3 rounds/);
  assert.equal(f.state().rounds, 3);
  assert.equal(f.calls().filter(call => call.phase === "fix").length, 3);
  assert.equal(f.calls().some(call => call.args.includes("--waive")), false);
  const log = readFileSync(join(f.root, ".scratch/kit-slice/04-ticket/fix.log"), "utf8");
  assert.match(log, /001\/result\.md/); assert.match(log, /003\/result\.md/);
  assert.equal(log.split("\n").filter(line => line.startsWith("RESULT: fail fix")).length, 3);
  assert.equal(existsSync(join(f.root, ".scratch/merged")), false);
});

test("kit slice fails closed when a saved clean review becomes unreadable", t => {
  const f = fixture(t);
  assert.equal(f.run(["--no-pr"]).status, 0);
  writeFileSync(join(f.state().review, "result.md"), "partial");
  const result = f.run(["--no-pr", "--rounds", "1"], { UNREADABLE_REVIEW: "1" });
  assert.equal(result.status, 1); assert.match(result.stdout, /fail slice fix: 1 open findings/);
  assert.equal(f.calls().filter(call => call.phase === "build").length, 1);
});


test("exhausted slice surfaces PR creation failure and its bounded PR digest", t => {
  const f = fixture(t), result = f.run(["--rounds", "1"], { CLEAN_AT: "9", FAIL_PHASE: "pr" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /slice: pr fail/);
  assert.match(result.stdout, /RESULT: fail slice pr: command exited 7: pr deliberate failure/);
  assert.doesNotMatch(result.stdout, /open findings after/);
  assert.match(result.stderr, /failure-detail-39/);
  assert.equal(result.stderr.trim().split("\n").length, 15);
  assert.equal(f.state().pr, undefined);
  assert.equal(existsSync(join(f.root, ".scratch/merged")), false);
  assert.match(readFileSync(join(f.root, ".scratch/kit-slice/04-ticket/pr.log"), "utf8"), /failure-detail-0/);
});

test("queued slice waits for the actual merged SHA without reopening the PR", t => {
  const f = fixture(t), result = f.run([], { QUEUE_PR: "1", MERGE_AFTER: "2" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith(`RESULT: ok slice ${f.ticket} PR #42 ${"a".repeat(40)}\n`));
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "pr", "merge", "merge"]);
  assert.equal(f.state().queued, undefined);
  assert.ok(f.state().finished.includes("pr"));
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "pr", "merge", "merge"]);
});

for (const failure of ["lookup", "timeout"]) test(`queued slice resumes its merge wait after ${failure} without reopening the PR`, t => {
  const f = fixture(t);
  const failed = f.run([], { QUEUE_PR: "1", ...(failure === "lookup" ? { MERGE_FAILURE: "1" } : { MERGE_PENDING: "1", ASE_SLICE_MERGE_TIMEOUT_MS: "1" }) });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /RESULT: fail slice pr:/);
  if (failure === "timeout") assert.match(failed.stdout, /merge wait timed out/);
  assert.equal(f.state().pr, "42");
  assert.equal(f.state().queued?.head, f.git("rev-parse", "HEAD"));
  assert.equal(f.state().finished.includes("pr"), false);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith(`RESULT: ok slice ${f.ticket} PR #42 ${"a".repeat(40)}\n`));
  for (const phase of ["build", "review", "pr"]) assert.equal(f.calls().filter(call => call.phase === phase).length, 1);
});

test("queued slice refuses a replacement PR head instead of reporting it merged", t => {
  const f = fixture(t), result = f.run([], { QUEUE_PR: "1", MERGE_CHANGED_HEAD: "1" });
  assert.equal(result.status, 1); assert.match(result.stdout, /queued PR #42 head changed/);
  assert.equal(f.state().finished.includes("pr"), false);
});

for (const kind of ["staged", "unstaged", "untracked"]) test(`fresh slice refuses unrelated ${kind} work without changing it`, t => {
  const f = fixture(t), path = join(f.root, "unrelated.txt");
  if (kind !== "untracked") {
    writeFileSync(path, "unrelated baseline\n");
    f.git("add", "unrelated.txt"); f.git("commit", "-m", "unrelated baseline");
  }
  writeFileSync(path, "user work to preserve\n");
  if (kind === "staged") f.git("add", "unrelated.txt");
  const head = f.git("rev-parse", "HEAD"), status = f.git("status", "--porcelain", "--untracked-files=all");
  const index = f.git("ls-files", "--stage");
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail slice brief: new slice requires a clean worktree/);
  assert.deepEqual(f.calls(), [], "must not launch the builder or other phases");
  assert.equal(existsSync(join(f.root, ".scratch/kit-slice/04-ticket")), false, "must not initialize slice state");
  assert.equal(existsSync(join(f.root, ".scratch/agent-brief.md")), false);
  assert.equal(readFileSync(path, "utf8"), "user work to preserve\n");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("status", "--porcelain", "--untracked-files=all"), status);
  assert.equal(f.git("ls-files", "--stage"), index);
});

test("queued slice refuses --no-pr after local HEAD moves without altering its saved queue", t => {
  const f = fixture(t);
  const failed = f.run([], { QUEUE_PR: "1", MERGE_PENDING: "1", ASE_SLICE_MERGE_TIMEOUT_MS: "1" });
  assert.equal(failed.status, 1); assert.match(failed.stdout, /merge wait timed out/);
  const queued = f.state(), calls = f.calls();
  f.git("commit", "--allow-empty", "-m", "new local work after queue timeout");
  const head = f.git("rev-parse", "HEAD");
  assert.notEqual(head, queued.reviewedHead);
  const result = f.run(["--no-pr"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /queued slice HEAD changed; --no-pr cannot reuse the review/);
  assert.doesNotMatch(result.stdout, /RESULT: ok slice|reviewed clean/);
  assert.deepEqual(f.calls(), calls, "incompatible resume must not launch any phase");
  assert.deepEqual(f.state(), queued, "keep the queued PR available for a normal wait retry");
  assert.equal(f.git("rev-parse", "HEAD"), head);
});


async function until(condition: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `deadline waiting for ${description}`);
    await new Promise(accept => setTimeout(accept, 10));
  }
}

for (const phase of ["build", "review"]) for (const change of ["branch", "HEAD"])
  test(`slice refuses ${change} changes while its ${phase} command is held`, async t => {
    const count = await forEachAwait(race => {
      const f = fixture(t), ready = join(f.dir, "ready"), release = join(f.dir, "release");
      const result = f.start({ HOLD_PHASE: phase, HOLD_READY: ready, HOLD_RELEASE: release });
      return { f, done: (async () => {
        await race.port(`held ${phase}`, () => until(() => existsSync(ready), `held ${phase}`))();
        writeFileSync(release, "go");
        return result;
      })(), ready };
    }, async ({ f, ready }) => {
      await until(() => existsSync(ready), `held ${phase}`);
      if (change === "branch") f.git("switch", "-c", "other-branch");
      else f.git("commit", "--allow-empty", "-m", "concurrent change");
    }, async ({ f, done }) => {
      const result = await done;
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout, new RegExp(`RESULT: fail slice ${phase}: worktree (branch|HEAD) changed`));
      assert.equal(f.calls().some(call => ["fix", "pr"].includes(call.phase)), false);
      assert.equal(f.git("log", "-1", "--format=%s"), change === "HEAD" ? "concurrent change" : phase === "build" ? "base" : "Test slice title");
      if (phase === "build") {
        assert.equal(f.calls().some(call => call.phase === "review"), false);
        assert.equal(f.git("diff", "--cached", "--name-only"), "");
      }
      assert.equal(existsSync(join(f.root, ".scratch/merged")), false);
    });
    assert.equal(count, 1);
  });

for (const phase of ["commit", "review"]) test(`slice resumes real kit fix's failed ${phase} without repeating its builder`, t => {
  const f = fixture(t), real = f.realFix();
  mkdirSync(join(f.root, ".scratch"), { recursive: true });
  const reject = join(f.root, ".scratch/reject-fix"), hook = join(f.hooks, "pre-commit");
  writeFileSync(hook, `#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
if (existsSync(".scratch/reject-fix") && readFileSync("file.txt", "utf8").startsWith("preserved real fix")) {
  console.error("fix hook rejected"); process.exit(1);
}
`); chmodSync(hook, 0o755);
  if (phase === "commit") writeFileSync(reject, "reject");
  const failed = f.run([], { ...real, CLEAN_AT: "1", ...(phase === "review" ? { FAIL_FIX_REVIEW: "1" } : {}) });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /RESULT: fail slice fix:/);
  const pendingPath = join(f.root, ".scratch/kit-fix/build%2Fke-04/pending.json");
  const pending: { phase: string } = JSON.parse(readFileSync(pendingPath, "utf8"));
  assert.equal(pending.phase, phase);
  assert.equal(readFileSync(join(f.root, "file.txt"), "utf8"), "preserved real fix\n");
  assert.equal(f.state().pendingFix, true);
  if (phase === "commit") {
    assert.equal(f.git("diff", "--cached", "--name-only"), "file.txt");
    rmSync(reject);
  }
  const result = f.run([], { ...real, CLEAN_AT: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: ok slice .* PR #42/);
  for (const name of ["build", "resume", "pr"]) assert.equal(f.calls().filter(call => call.phase === name).length, 1);
  assert.equal(f.state().rounds, 1);
  assert.equal(f.state().pendingFix, undefined);
  assert.equal(existsSync(pendingPath), false);
  assert.equal(existsSync(join(f.root, ".scratch/kit-fix/build%2Fke-04/round-2.md")), false);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("log", "-1", "--format=%s"), "Review fixes round 1");
  assert.equal(f.git("show", "HEAD:file.txt"), "preserved real fix");
});

for (const phase of ["commit", "review"]) test(`slice switched during real kit fix's paused ${phase} finishes that round under its saved model`, t => {
  const f = fixture(t), real = f.realFix();
  mkdirSync(join(f.root, ".scratch"), { recursive: true });
  const reject = join(f.root, ".scratch/reject-fix"), hook = join(f.hooks, "pre-commit");
  writeFileSync(hook, `#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
if (existsSync(".scratch/reject-fix") && readFileSync("file.txt", "utf8").startsWith("preserved real fix")) process.exit(1);
`); chmodSync(hook, 0o755);
  if (phase === "commit") writeFileSync(reject, "reject");
  const failed = f.run([], { ...real, CLEAN_AT: "1", ...(phase === "review" ? { FAIL_FIX_REVIEW: "1" } : {}) });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const pendingPath = join(f.root, ".scratch/kit-fix/build%2Fke-04/pending.json");
  const pending: { phase: string } = JSON.parse(readFileSync(pendingPath, "utf8"));
  assert.equal(pending.phase, phase);
  if (phase === "commit") rmSync(reject);
  const result = f.run([], { ...real, CLEAN_AT: "1" }, ["--ticket", f.ticket, "--builder", "claude-opus-5-5"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> claude-opus-5-5/);
  assert.deepEqual(f.state().previousModels, ["gpt-6.1-sol"]);
  assert.equal(f.state().model, "claude-opus-5-5");
  const fix = f.calls().filter(call => call.phase === "fix").at(-1)!;
  assert.equal(fix.args.includes("--builder"), false, "the paused round keeps its saved model");
  assert.equal(fix.args.includes("--effort"), false);
  for (const name of ["build", "resume", "pr"]) assert.equal(f.calls().filter(call => call.phase === name).length, 1);
  assert.equal(f.state().rounds, 1);
  assert.equal(existsSync(pendingPath), false);
  assert.match(f.git("log", "-1", "--format=%B"), /^Review fixes round 1\n\nCo-Authored-By: GPT-6\.1-Sol/);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("kit slice resumes unswitched with its saved run, builder and effort", t => {
  const f = fixture(t);
  assert.equal(f.run(["--effort", "high", "--no-pr"], { CLEAN_AT: "1", FAIL_PHASE: "fix" }).status, 1);
  const build = f.state().build;
  assert.ok(build);
  const result = f.run(["--effort", "high", "--no-pr"], { CLEAN_AT: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /builder switched/);
  assert.equal(f.state().previousModels, undefined);
  assert.equal(f.state().build, build);
  const fix = f.calls().filter(call => call.phase === "fix").at(-1)!;
  for (const [flag, value] of [["--run", build], ["--builder", "gpt-6.1-sol"], ["--effort", "high"]])
    assert.equal(fix.args[fix.args.indexOf(flag) + 1], value, flag);
});

test("slice refuses a changed HEAD when resuming a pending real fix commit", t => {
  const f = fixture(t), real = f.realFix();
  const hook = join(f.hooks, "pre-commit");
  writeFileSync(hook, `#!/usr/bin/env node
const { readFileSync } = require("node:fs");
if (readFileSync("file.txt", "utf8").startsWith("preserved real fix")) process.exit(1);
`); chmodSync(hook, 0o755);
  assert.equal(f.run([], { ...real, CLEAN_AT: "1" }).status, 1);
  const calls = f.calls();
  rmSync(hook);
  f.git("commit", "-m", "concurrent work");
  const head = f.git("rev-parse", "HEAD");
  const result = f.run([], { ...real, CLEAN_AT: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail slice fix:.*branch or HEAD changed/);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  for (const name of ["build", "resume", "review", "pr"]) {
    assert.equal(f.calls().filter(call => call.phase === name).length, calls.filter(call => call.phase === name).length);
  }
  assert.equal(f.state().rounds, 0);
  assert.equal(f.state().pendingFix, true);
});


test("three rounds with P2/P3 findings finish fix and run the PR phase", t => {
  const f = fixture(t), result = f.run([], { CLEAN_AT: "99", MINOR_REVIEW: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /slice: fix ok 3 rounds, 2 follow-ups/);
  assert.match(result.stdout, /RESULT: ok slice .* PR #42/);
  assert.equal(f.state().rounds, 3);
  assert.equal(f.calls().filter(call => call.phase === "fix").length, 3);
  const prs = f.calls().filter(call => call.phase === "pr");
  assert.equal(prs.length, 1);
  assert.equal(prs[0].args.includes("--no-merge"), false);
});

test("three rounds with a P1 leave the PR unmerged and fail", t => {
  const f = fixture(t), result = f.run([], { CLEAN_AT: "99" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: fail slice fix: 1 open findings after 3 rounds/);
  assert.ok(f.calls().find(call => call.phase === "pr")?.args.includes("--no-merge"));
  assert.equal(existsSync(join(f.root, ".scratch/merged")), false);
});

for (const failedCi of [false, true]) test(`resume after ticket follow-ups keeps review coverage (failed CI=${failedCi})`, t => {
  const f = fixture(t);
  const options = { CLEAN_AT: "99", MINOR_REVIEW: "1", ADD_FOLLOWUPS: "1" };
  const result = f.run([], { ...options, ...(failedCi ? { FAIL_AFTER_FOLLOWUPS: "1" } : {}) });
  assert.equal(result.status, failedCi ? 1 : 0, result.stdout + result.stderr);
  assert.equal(f.git("log", "-1", "--format=%s"), "docs: ticket follow-ups from review");
  const calls = f.calls(), head = f.git("rev-parse", "HEAD");
  assert.notEqual(readFileSync(join(f.state().review, "refs.txt"), "utf8").trim(), head);
  const resumed = f.run([], options);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  for (const phase of ["build", "review", "fix"]) assert.equal(f.calls().filter(call => call.phase === phase).length, calls.filter(call => call.phase === phase).length);
  assert.equal(f.calls().filter(call => call.phase === "pr").length, failedCi ? 2 : 1);
  assert.equal(f.git("rev-parse", "HEAD"), head);
});


test("no-pr after three rounds reports its non-blocking follow-ups", t => {
  const f = fixture(t), result = f.run(["--no-pr"], { CLEAN_AT: "99", MINOR_REVIEW: "1" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /RESULT: ok slice .* reviewed with follow-ups/);
  assert.equal(f.calls().some(call => call.phase === "pr"), false);
});

test("ticket-only work after landing reuses review but lands the new HEAD", t => {
  const f = fixture(t);
  const options = { CLEAN_AT: "99", MINOR_REVIEW: "1", ADD_FOLLOWUPS: "1" };
  const landed = f.run([], options);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.ok(f.state().finished.includes("pr"));
  const calls = f.calls(), reviewed = f.state().review;
  writeFileSync(join(f.root, f.ticket), readFileSync(join(f.root, f.ticket), "utf8") + "\nAdditional ticket evidence.\n");
  f.git("add", "--", f.ticket); f.git("commit", "-m", "Document additional evidence");
  const head = f.git("rev-parse", "HEAD");
  const resumed = f.run([], options);
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  assert.equal(f.state().review, reviewed);
  for (const phase of ["build", "review", "fix"]) assert.equal(f.calls().filter(call => call.phase === phase).length, calls.filter(call => call.phase === phase).length);
  assert.equal(f.calls().filter(call => call.phase === "pr").length, 2);
  assert.ok(resumed.stdout.endsWith(`RESULT: ok slice ${f.ticket} PR #42 ${head}\n`));
});


for (const mainRoot of [false, true]) for (const pending of [false, true]) test(`slice resume gates on completed branch rounds (main=${mainRoot}, pending=${pending})`, t => {
  const f = fixture(t);
  const options = { CLEAN_AT: "99", MINOR_REVIEW: "1" };
  const first = f.run(["--rounds", "1", "--no-pr"], options);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.equal(f.state().rounds, 1);
  const calls = f.calls();
  // Two manual rounds can decline findings without creating a new commit.
  const folder = join(mainRoot ? f.main : f.root, ".scratch/kit-fix", encodeURIComponent("build/ke-04"));
  mkdirSync(folder, { recursive: true });
  for (let n = 1; n <= 3; n++) writeFileSync(join(folder, `round-${n}.md`), "Completed branch fix brief");
  if (pending) writeFileSync(join(folder, "pending.json"), JSON.stringify({ round: 3 }));
  writeFileSync(join(f.root, ".scratch/fake-round"), "3");
  writeFileSync(join(f.state().review, "result.md"), findings.replace("P1", "P2").replace("Standards: none", "Standards: P3: Cosmetic issue"));
  const resumed = f.run(["--rounds", pending ? "1" : "3"], options);
  assert.equal(resumed.status, pending ? 1 : 0, resumed.stdout + resumed.stderr);
  if (pending) assert.match(resumed.stdout, /RESULT: fail slice fix: 2 open findings after 1 rounds/);
  else assert.match(resumed.stdout, /RESULT: ok slice .* PR #42/);
  assert.equal(f.state().rounds, 1, "branch history must not consume the slice's invocation budget");
  for (const phase of ["build", "review", "fix"]) assert.equal(f.calls().filter(call => call.phase === phase).length, calls.filter(call => call.phase === phase).length);
  assert.equal(f.calls().at(-1)?.args.includes("--no-merge"), pending);
  assert.equal(existsSync(join(f.root, ".scratch/merged")), !pending);
});
