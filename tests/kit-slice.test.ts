import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const kit = resolve("scripts/agents/kit");
const clean = "REVIEW_STATUS: complete\nDefects:\nSpec: none\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
const findings = "REVIEW_STATUS: complete\nDefects:\nSpec:\n- file.txt:1 P1 restore required text\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
interface Call { phase: string; args: string[] }
interface State { finished: string[]; build: string; review: string; reviewedHead: string; rounds: number; pr?: string; queued?: { head: string } }

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-slice-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const phase = args[0];
function call(name) {
  appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ phase: name, args }) + "\\n");
  if (process.env.FAIL_PHASE === name) {
    for (let n = 0; n < 40; n++) console.error("failure-detail-" + n);
    console.log("RESULT: fail " + name + " deliberate failure");
    process.exit(7);
  }
}
const counter = join(".scratch", "fake-round");
const round = () => existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
function evidence() {
  const folder = join(process.env.KIT_MAIN_ROOT, ".scratch/reviews/ke-04", String(round()).padStart(3, "0"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "refs.txt"), git("rev-parse", "HEAD") + "\\n");
  const open = round() < Number(process.env.CLEAN_AT || 0);
  writeFileSync(join(folder, "result.md"), process.env.UNREADABLE_REVIEW ? "partial" : open ? ${JSON.stringify(findings)} : ${JSON.stringify(clean)});
  return { folder, open };
}
`;
  const agent = join(bin, "agent.mjs");
  writeFileSync(agent, `#!/usr/bin/env node\n${shared}
call("build");
if (!process.env.NO_BUILD_CHANGES) writeFileSync("file.txt", "built\\n");
const out = args[args.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "status.json"), JSON.stringify({ kind: "build", model: args[args.indexOf("--model") + 1], worktree: process.cwd(), out }));
console.log("artifacts: " + out);
`);
  const fakeKit = join(bin, "kit.mjs");
  writeFileSync(fakeKit, `#!/usr/bin/env node\n${shared}
call(phase);
if (args.includes("--waive")) throw new Error("waive forbidden");
if (phase === "review") {
  const { folder } = evidence();
  console.log("RESULT: ok review git diff origin/dev...HEAD evidence " + folder);
} else if (phase === "fix") {
  writeFileSync(counter, String(round() + 1));
  writeFileSync("file.txt", "fix round " + round() + "\\n");
  git("add", "-A"); git("commit", "-m", "Review fixes round " + round());
  const { folder, open } = evidence();
  console.log(open ? "RESULT: fail fix 1 open findings (" + folder + "/result.md)" : "RESULT: ok fix clean");
  process.exitCode = open ? 1 : 0;
} else if (phase === "pr") {
  const { folder, open } = evidence();
  if (open) {
    console.log("RESULT: fail pr #42 review has 1 open findings (" + folder + "/result.md)");
    process.exitCode = 1;
  } else if (args.includes("--no-merge")) console.log("RESULT: ok opened #42 " + git("rev-parse", "--short", "HEAD"));
  else if (process.env.QUEUE_PR) console.log("RESULT: ok queued #42 " + git("rev-parse", "HEAD"));
  else {
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
  const env = { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: main, ASE_OWNER: "ke-04", ASE_SLICE_AGENT: agent,
    ASE_SLICE_KIT: fakeKit, ASE_SLICE_GH: gh, ASE_SLICE_MERGE_POLL_MS: "1", ASE_SLICE_MERGE_TIMEOUT_MS: "5000", FAKE_CALLS: callsFile };
  const args = ["--ticket", ticket, "--builder", "sol"];
  const run = (extra: string[] = [], overrides: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("bash", [kit, "slice", ...args, ...extra], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000 });
    const lines = result.stdout.trim().split("\n"), results = lines.filter(line => line.startsWith("RESULT:"));
    assert.equal(results.length, 1, result.stdout + result.stderr);
    assert.equal(lines.at(-1), results[0]);
    assert.ok(result.stderr.trim().split("\n").filter(Boolean).length <= 15, result.stderr);
    return result;
  };
  const calls = (): Call[] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const statePath = join(root, ".scratch/kit-slice/04-ticket/state.json");
  const state = (): State => JSON.parse(readFileSync(statePath, "utf8"));
  return { dir, root, main, hooks, ticket, git, head, run, calls, state, env };
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
  for (const text of [f.ticket, "## Files", "`file.txt`", "## Done when", "Required content", "## Done (YYYY-MM-DD)", "behaviour, commits, tests, review decisions", "status: closed", "assignee: ke-04", "scripts/agents/kit"]) assert.ok(brief.includes(text), text);
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
  f.git("commit", "--allow-empty", "-m", "later work");
  const result = f.run(["--no-pr"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().map(call => call.phase), ["build", "review", "review"]);
  assert.equal(f.state().reviewedHead, f.git("rev-parse", "HEAD"));
  f.git("switch", "-c", "other");
  assert.match(f.run().stdout, /saved slice belongs to a different/);
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
