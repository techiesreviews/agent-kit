import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

// kit slice in T3 mode (ticket ke-85): it starts no agent; it prints the next stage and its brief, and --next
// checks the stage's evidence before it moves on.
const kit = resolve("kit");
const clean = "REVIEW_STATUS: complete\nDefects:\nSpec: none\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
const p1 = "REVIEW_STATUS: complete\nDefects:\nSpec:\n- file.txt:1 P1 fault: restore required text\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
const p2 = p1.replace("P1", "P2");
const ticket = "docs/tickets/04-ticket.md";
interface T3State { mode: string; stage: string; rounds: number; stageStarted: string; review?: string; secondLook?: { evidence?: string; skipped?: string }; pr?: string; sha?: string }

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-slice-t3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git"), root = join(dir, "work"), main = join(dir, "main"), bin = join(dir, "bin");
  for (const path of [main, bin]) mkdirSync(path);
  const env: NodeJS.ProcessEnv = { ...kitEnv(), KIT_ROOT: root, KIT_MAIN_ROOT: main, ASE_OWNER: "ke-04", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", ASE_SLICE_GH: join(bin, "gh"), FAKE_PR: join(dir, "pr.json"), T3CODE_THREAD_ID: "" };
  const at = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  at(dir, "init", "-q", "--bare", "-b", "dev", origin);
  at(dir, "clone", "-q", origin, root);
  const git = (...args: string[]) => at(root, ...args);
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  mkdirSync(join(root, "docs/tickets"), { recursive: true }); mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, ticket), '---\ntitle: "Test slice title"\nstatus: open\nassignee: ke-04\n---\n\n## Files\n- `file.txt`\n\n## Done when\n- Required content is present.\n');
  writeFileSync(join(root, ".gitignore"), ".scratch/\n");
  writeFileSync(join(root, "file.txt"), "base\n");
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-slice", branches: { land: "dev" } }));
  git("checkout", "-q", "-b", "dev"); git("add", "-A"); git("commit", "-q", "-m", "base"); git("push", "-q", "origin", "dev");
  git("checkout", "-q", "-b", "build/ke-04-ticket");
  // gh pr list for the branch answers from pr.json ([] when missing), as merged or open PRs.
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { existsSync, readFileSync } = require("node:fs");
console.log(existsSync(process.env.FAKE_PR) ? readFileSync(process.env.FAKE_PR, "utf8") : "[]");
`);
  chmodSync(join(bin, "gh"), 0o755);
  const run = (...args: string[]) => {
    const result = spawnSync(kit, ["slice", ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
    assert.equal(result.error, undefined);
    const results = result.stdout.split("\n").filter(line => line.startsWith("RESULT: "));
    assert.equal(results.length, 1, result.stdout + result.stderr);
    return result;
  };
  const start = () => run("--runner", "t3", "--ticket", ticket, "--builder", "claude-opus-5-5");
  const next = (...args: string[]) => run("--next", ...args);
  const statePath = join(root, ".scratch/kit-slice/04-ticket/state.json");
  const state = (): T3State => JSON.parse(readFileSync(statePath, "utf8"));
  const edit = (change: (state: T3State) => void) => { const saved = state(); change(saved); writeFileSync(statePath, JSON.stringify(saved)); };
  const commit = (content: string, subject = "work") => { writeFileSync(join(root, "file.txt"), content); git("commit", "-q", "-am", subject); return git("rev-parse", "HEAD"); };
  const report = (text: string) => { const path = join(dir, `report-${Math.random().toString(36).slice(2)}.md`); writeFileSync(path, text); return path; };
  const reviews = () => existsSync(join(main, ".scratch/reviews/ke-04")) ? readdirSync(join(main, ".scratch/reviews/ke-04")).sort() : [];
  return { dir, root, main, env, git, run, start, next, state, edit, commit, report, reviews, prFile: join(dir, "pr.json") };
}

test("T3 mode prints the next stage and its brief for each state, and records the slice's state", t => {
  const f = fixture(t);
  let result = f.start();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: build$/m);
  assert.match(result.stdout, /^delegate: role implementation, isolation shared, model claude-opus-5-5, mode async$/m);
  assert.match(result.stdout, /You are the build child/);
  assert.match(result.stdout, /^kit-brief: \S+ docs\/tickets\/04-ticket\.md build$/m);
  assert.match(result.stdout, /^RESULT: ok slice docs\/tickets\/04-ticket\.md t3 next build/m);
  assert.equal(f.state().mode, "t3"); assert.equal(f.state().stage, "build");
  // Run again without --next: the same stage, its brief again; nothing moves.
  result = f.start();
  assert.match(result.stdout, /^NEXT: build$/m); assert.equal(f.state().stage, "build");
  const head = f.commit("built\n", "Build the slice");
  result = f.next();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: review$/m);
  assert.match(result.stdout, /^delegate: role review, isolation shared, model claude-opus-5-5, mode async$/m);
  assert.match(result.stdout, /REVIEW_STATUS: complete/);
  assert.match(result.stdout, /git diff origin\/dev\.\.\.HEAD/);
  assert.match(result.stdout, /^kit-brief: \S+ docs\/tickets\/04-ticket\.md review$/m);
  result = f.next("--report", f.report(clean));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: second-look$/m);
  assert.match(result.stdout, /^delegate: role review, isolation shared, model grok-4\.7 \(else opencode\/deepseek-v4\.1-flash-free\), mode wait, timeoutMs 1500000$/m);
  assert.match(result.stdout, /^kit-brief: \S+ docs\/tickets\/04-ticket\.md second-look$/m);
  // The review became evidence kit pr reads: the reviewed HEAD and its base, and the report.
  const [first] = f.reviews(), folder = join(f.main, ".scratch/reviews/ke-04", first);
  assert.equal(readFileSync(join(folder, "refs.txt"), "utf8").split("\n")[0], head);
  assert.equal(readFileSync(join(folder, "result.md"), "utf8"), clean);
  assert.equal(existsSync(join(folder, "second-look.json")), false);
  result = f.next("--report", f.report(clean), "--model", "grok-4.7");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: pr$/m);
  assert.match(result.stdout, /scripts\/agents\/kit pr --open --ticket docs\/tickets\/04-ticket\.md/);
  assert.match(result.stdout, /watch_pull_request/);
  assert.match(result.stdout, /scripts\/agents\/kit pr --merge --ticket docs\/tickets\/04-ticket\.md/);
  const second = join(f.main, ".scratch/reviews/ke-04", f.reviews()[1]);
  assert.deepEqual(JSON.parse(readFileSync(join(second, "second-look.json"), "utf8")), { kind: "code", model: "grok-4.7", ok: true, runner: "t3" });
  writeFileSync(f.prFile, JSON.stringify([{ number: 73, state: "MERGED", mergeCommit: { oid: "a".repeat(40) } }]));
  result = f.next();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: done$/m);
  assert.match(result.stdout, new RegExp(`^RESULT: ok slice docs/tickets/04-ticket\\.md PR #73 ${"a".repeat(40)}$`, "m"));
  assert.equal(f.state().stage, "done");
  // Every stage's start and end is kept for the comparison with headless slices.
  const history = (f.state() as unknown as { history: { stage: string; started: string; ended: string }[] }).history;
  assert.deepEqual(history.map(entry => entry.stage), ["build", "review", "second-look", "pr"]);
  assert.ok(history.every(entry => entry.started && entry.ended));
});

test("--next refuses a stage without its evidence and leaves the stage as it was", t => {
  const f = fixture(t);
  f.start();
  let result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice build: no commit on top of the slice's start/);
  writeFileSync(join(f.root, "file.txt"), "unsaved\n");
  result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice build: uncommitted changes/);
  f.git("checkout", "file.txt");
  assert.equal(f.state().stage, "build");
  f.commit("built\n");
  f.next();
  result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice review: needs --report FILE/);
  result = f.next("--report", f.report("Defects: none\n"));
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice review: the report has no REVIEW_STATUS: complete line/);
  result = f.next("--skipped", "busy");
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice review: only the second look may be skipped/);
  f.commit("changed during the review\n");
  result = f.next("--report", f.report(clean));
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice review: HEAD moved since the review started/);
  assert.equal(f.state().stage, "review");
  assert.deepEqual(f.reviews(), []);
});

test("--next without a T3-mode slice, and an unknown runner, fail", t => {
  const f = fixture(t);
  let result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice no T3-mode slice on build\/ke-04-ticket; start one with --runner t3/);
  result = f.run("--runner", "cloud", "--ticket", ticket, "--builder", "claude-opus-5-5");
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice brief: --runner must be t3, headless or auto/);
});

test("the fix-round limit holds: three rounds, then only P0/P1 stop the slice for the lead", t => {
  const f = fixture(t);
  f.start(); f.commit("built\n"); f.next();
  for (let round = 1; round <= 3; round++) {
    const result = f.next("--report", f.report(p1));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /^NEXT: fix$/m);
    assert.match(result.stdout, /You are the fix child/);
    assert.match(result.stdout, /file\.txt:1 P1 fault: restore required text/);
    assert.match(result.stdout, /^kit-brief: \S+ docs\/tickets\/04-ticket\.md fix$/m);
    // A fix round needs a new commit (or every finding declined in its report).
    let refused = f.next();
    assert.equal(refused.status, 1); assert.match(refused.stdout, /RESULT: fail slice fix: no commit on top of the reviewed HEAD/);
    f.commit(`fixed ${round}\n`);
    refused = f.next();
    assert.equal(refused.status, 0, refused.stdout); assert.match(refused.stdout, /^NEXT: review$/m);
    assert.equal(f.state().rounds, round);
  }
  // kit pr reads the same rounds (round-N.md files), so it relaxes to P0/P1 just as the slice does.
  assert.deepEqual(readdirSync(join(f.root, ".scratch/kit-fix", encodeURIComponent("build/ke-04-ticket"))).sort(), ["round-1.md", "round-2.md", "round-3.md"]);
  let result = f.next("--report", f.report(p1));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /^NEXT: lead$/m);
  assert.match(result.stdout, /RESULT: fail slice review: 1 blocking findings after 3 fix rounds/);
  assert.equal(f.state().stage, "stopped");
  // A P2 left after three rounds goes on as a follow-up.
  f.edit(state => { state.stage = "review"; });
  result = f.next("--report", f.report(p2));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: second-look$/m);
});

test("a fix round may decline every finding without a commit, its reasons going to the next review", t => {
  const f = fixture(t);
  f.start(); f.commit("built\n"); f.next(); f.next("--report", f.report(p1));
  const result = f.next("--report", f.report("Declined: file.txt:1 the text is required by the spec\nLast line: FIXED 0, DECLINED 1, head x\n"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: review$/m);
  assert.match(result.stdout, /Declined: file\.txt:1 the text is required by the spec/);
});

test("the second look's time limit holds, it may be skipped with a reason, and never by an OpenAI model", t => {
  const f = fixture(t);
  f.start(); f.commit("built\n"); f.next(); f.next("--report", f.report(clean));
  let result = f.next("--report", f.report(clean), "--model", "gpt-6.1-sol");
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice second-look: never an OpenAI model \(gpt-6\.1-sol\)/);
  result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice second-look: needs --report FILE, or --skipped "<reason>"/);
  // Past 25 minutes the look counts as skipped, even when its report comes in; the runner cancels the child.
  f.edit(state => { state.stageStarted = new Date(Date.now() - 26 * 60_000).toISOString(); });
  result = f.next("--report", f.report(p1), "--model", "grok-4.7");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: skipped \(no report within 25 minutes\)$/m);
  assert.match(result.stdout, /task_cancel/);
  assert.match(result.stdout, /^NEXT: pr$/m);
  assert.deepEqual(f.state().secondLook, { skipped: "no report within 25 minutes" });
  // Within the limit, --skipped records the reason.
  f.edit(state => { state.stage = "second-look"; state.stageStarted = new Date().toISOString(); delete state.secondLook; });
  result = f.next("--skipped", "grok-4.7 out of credit; opencode/deepseek-v4.1-flash-free out of credit");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^second look: skipped \(grok-4\.7 out of credit; opencode\/deepseek-v4\.1-flash-free out of credit\)$/m);
  // Second-look findings get a fix round, then Claude's review, then a fresh look.
  f.edit(state => { state.stage = "second-look"; state.stageStarted = new Date().toISOString(); delete state.secondLook; });
  result = f.next("--report", f.report(p1), "--model", "opencode/deepseek-v4.1-flash-free");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^NEXT: fix$/m);
});

test("the pr stage waits for the merge: an open PR or none is refused", t => {
  const f = fixture(t);
  f.start(); f.commit("built\n"); f.next(); f.next("--report", f.report(clean)); f.next("--skipped", "no model");
  let result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice pr: no PR for build\/ke-04-ticket yet; run scripts\/agents\/kit pr --open/);
  writeFileSync(f.prFile, JSON.stringify([{ number: 73, state: "OPEN", mergeCommit: null }]));
  result = f.next();
  assert.equal(result.status, 1); assert.match(result.stdout, /RESULT: fail slice pr: PR #73 is open, not merged/);
  assert.equal(f.state().stage, "pr");
});

test("the T3 runner is picked by --runner auto inside a T3 thread, headless outside", t => {
  const f = fixture(t);
  const auto = (thread: string) => spawnSync(kit, ["slice", "--runner", "auto", "--ticket", ticket, "--builder", "claude-opus-5-5"],
    { cwd: f.root, env: { ...f.env, T3CODE_THREAD_ID: thread, ASE_SLICE_AGENT: join(f.dir, "no-agent") }, encoding: "utf8", timeout: 30_000 });
  const inside = auto("thread:1");
  assert.equal(inside.status, 0, inside.stdout + inside.stderr);
  assert.match(inside.stdout, /^NEXT: build$/m);
  rmSync(join(f.root, ".scratch"), { recursive: true, force: true });
  // Outside T3 the headless slice runs: its builder is the (missing) agent.
  const outside = auto("");
  assert.doesNotMatch(outside.stdout, /^NEXT: /m);
  assert.match(outside.stdout, /RESULT: fail slice build/);
});
