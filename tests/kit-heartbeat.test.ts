import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const heartbeat = resolve("scripts/agents/kit.d/heartbeat");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

// A dev repo with fake job records in its worktrees, a fake kit (bg --list reads each
// worktree's records and fails for FAKE_BG_FAIL_ROOT; next logs its arguments, writes FAKE_NEXT_ERR to
// stderr, sleeps FAKE_NEXT_SLEEP seconds, kills the heartbeat with FAKE_NEXT_KILL_PARENT and prints
// FAKE_NEXT_OUT) and a main root for state.
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-heartbeat-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: "1", KIT_DEV_ROOT: join(root, "dev"), KIT_MAIN_ROOT: join(root, "main"), KIT_HEARTBEAT_KIT: join(root, "fake-kit"), FAKE_KIT_LOG: join(root, "kit.log"), FAKE_NEXT_OUT: join(root, "next.out") };
  delete env.KIT_ROOT;
  delete env.KIT_HEARTBEAT_LOCKED;
  const dev = join(root, "dev");
  const git = (...args: string[]) => execFileSync("git", ["-C", dev, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(dev);
  git("init", "-q", "-b", "dev");
  git("commit", "-q", "--allow-empty", "-m", "fixture");
  writeFileSync(join(root, "fake-kit"), `#!/usr/bin/env bash
if [[ $1 == bg && $2 == --list ]]; then
  [[ $KIT_ROOT != "\${FAKE_BG_FAIL_ROOT:-}" ]] || { echo 'RESULT: fail bg list'; exit 1; }
  for d in "$KIT_ROOT"/.scratch/kit-jobs/*/; do [[ -d $d ]] && { age=unknown; [[ -f $d/started ]] && age="$(cat "$d/age")s"; printf '%s\\t%s\\t%s\\t%slog\\n' "$(basename "$d")" "$(cat "$d/state")" "$age" "$d"; }; done
  echo 'RESULT: ok bg list'; exit 0
fi
printf '%s\\n' "$*" >> "$FAKE_KIT_LOG"
[[ -z \${FAKE_NEXT_KILL_PARENT:-} ]] || kill -9 "$PPID"
[[ -z \${FAKE_NEXT_ERR:-} ]] || printf '%s\\n' "$FAKE_NEXT_ERR" >&2
sleep "\${FAKE_NEXT_SLEEP:-0}"
cat "$FAKE_NEXT_OUT"
exit "\${FAKE_NEXT_STATUS:-0}"
`);
  chmodSync(join(root, "fake-kit"), 0o755);
  writeFileSync(env.FAKE_NEXT_OUT!, "RESULT: ok next 0 ready, 0 waiting\n");
  // A slice job record as kit bg writes it, in its own worktree; state is "running", "exit N" or "died".
  const job = (name: string, { map = "alpha", state = "running", log = "", quietMinutes = 0, ageSeconds = 600, started = "2026-10-25T10:00:00.000Z" as string | null, subcommand = "slice", ticketRoot = "", pid = true } = {}) => {
    const worktree = join(root, `wt-${name}`);
    if (!existsSync(worktree)) git("worktree", "add", "-q", "--detach", worktree);
    const directory = join(worktree, ".scratch/kit-jobs", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state"), `${state}\n`);
    writeFileSync(join(directory, "age"), `${ageSeconds}\n`);
    if (started !== null) writeFileSync(join(directory, "started"), `${started}\n`);
    writeFileSync(join(directory, "command"), `'scripts/agents/kit' '${subcommand}' '--ticket' '${ticketRoot}docs/wayfinder/${map}/build/tickets/01-x.md' '--builder' 'claude-opus-5-5'\n`);
    writeFileSync(join(directory, "log"), log);
    if (pid) writeFileSync(join(directory, "pid"), "1\n");
    const at = new Date(Date.now() - quietMinutes * 60_000);
    utimesSync(join(directory, "log"), at, at);
    return directory;
  };
  const nextSays = (...lines: string[]) => writeFileSync(env.FAKE_NEXT_OUT!, `${lines.join("\n")}\n`);
  const run = (...args: string[]) => {
    const result = spawnSync(process.execPath, [heartbeat, ...args], { env, encoding: "utf8", timeout: 30_000 });
    return { ...result, lines: result.stdout.trim().split("\n") };
  };
  const nextCalls = () => existsSync(env.FAKE_KIT_LOG!) ? readFileSync(env.FAKE_KIT_LOG!, "utf8").trim().split("\n") : [];
  // Two heartbeats at once, as the schedule and a hand run after a restart.
  const both = (...args: string[]) => Promise.all([0, 1].map(() => new Promise<string>((done, fail) => {
    const child = spawn(process.execPath, [heartbeat, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.once("error", fail);
    child.once("close", () => done(stdout));
  })));
  return { root, env, job, nextSays, run, nextCalls, both };
}

test("finished jobs are listed once; merged slices get a preview line; a rerun of the same name is new", t => {
  const { job, run, root } = fixture(t);
  job("slice-al1", { state: "exit 0", log: "work\nRESULT: ok pr #12 merged\nRESULT: ok slice docs/wayfinder/alpha/build/tickets/01-x.md PR #12 abcdef1234\n" });
  job("slice-al2", { state: "exit 1", log: "RESULT: fail slice review: broke\n" });
  job("slice-be1", { map: "beta", state: "exit 0", log: "RESULT: ok slice x PR #9 1234567\n" });
  const first = run("alpha");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(first.lines, [
    "finished: slice-al1 exit 0 RESULT: ok slice docs/wayfinder/alpha/build/tickets/01-x.md PR #12 abcdef1234",
    "finished: slice-al2 exit 1 RESULT: fail slice review: broke",
    "merged: slice-al1 PR #12 abcdef1",
    "preview: scripts/agents/kit preview (lead step; the heartbeat never deploys)",
    "next RESULT: ok next 0 ready, 0 waiting",
    "done: 2 slices since tracking started: slice-al1 merged (PR #12), slice-al2 failed (exit 1)",
    "running/next: nothing left to build; the build is finished",
    "RESULT: ok heartbeat stop (frontier empty)",
  ]);
  assert.ok(existsSync(join(root, "main/.scratch/heartbeat/alpha.json")));
  const second = run("alpha");
  assert.equal(second.lines.filter(line => line.startsWith("finished: ")).length, 0, second.stdout);
  assert.ok(!second.lines.some(line => line.startsWith("merged: ") || line.startsWith("preview: ")), second.stdout);
  assert.ok(second.lines.includes("done: nothing new since the last check"), second.stdout);
  // kit bg reuses a name for a rerun; a new start time makes it a new job.
  job("slice-al2", { state: "died", started: "2026-10-25T11:00:00.000Z" });
  assert.deepEqual(run("alpha").lines.filter(line => line.startsWith("finished: ")), ["finished: slice-al2 died (no exit record) (no RESULT line)"]);
});

test("running jobs show age and log growth; a log quiet for 45 minutes is stuck", t => {
  const { job, run } = fixture(t);
  const busy = job("slice-al1", { log: "x".repeat(2048), ageSeconds: 4320, quietMinutes: 2 });
  job("slice-al2", { log: "quiet\n", ageSeconds: 3600, quietMinutes: 47 });
  job("slice-al3", { log: "almost\n", quietMinutes: 44 });
  const first = run("alpha");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(first.lines.filter(line => /^(running|stuck): /.test(line)), [
    "running: slice-al1 age 1h12m log 2.0 KB (first check)",
    "running: slice-al2 age 1h00m log 6 B (first check)",
    "running: slice-al3 age 10m log 7 B (first check)",
    "stuck: slice-al2 log quiet 47m",
  ]);
  assert.equal(first.lines.at(-2), "running/next: 3 building (slice-al1, slice-al2, slice-al3), 1 stuck (slice-al2)");
  assert.equal(first.lines.at(-1), "RESULT: ok heartbeat continue");
  writeFileSync(join(busy, "log"), "x".repeat(5120));
  assert.equal(run("alpha").lines.find(line => line.startsWith("running: slice-al1 ")), "running: slice-al1 age 1h12m log +3.0 KB");
});

test("stops when only Lex-waits are left, continues while other waits or ready tickets remain", t => {
  const { nextSays, run } = fixture(t);
  nextSays("waits: docs/wayfinder/alpha/build/tickets/02-grill.md needs Lex (type: grilling (HITL))",
    "waits: docs/wayfinder/alpha/tickets/03-r.md needs Lex (type: research (AFK))", "RESULT: ok next 0 ready, 2 waiting");
  const lex = run("alpha");
  assert.equal(lex.status, 0, lex.stdout + lex.stderr);
  assert.deepEqual(lex.lines.slice(-2), ["running/next: nothing running; 2 tickets waiting on you", "RESULT: ok heartbeat stop (only Lex-waits left)"]);
  nextSays("waits: docs/wayfinder/alpha/build/tickets/02-grill.md needs Lex (type: grilling (HITL))",
    "waits: docs/wayfinder/alpha/build/tickets/04-x.md shares a/x.ts with slice-be1", "RESULT: ok next 0 ready, 2 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 ticket waiting on you, 1 waiting on other work", "RESULT: ok heartbeat continue"]);
  // A ticket left claimed by a failed slice (the lead reruns it) or a delegated one (the free worker
  // builds it) waits on the lead, not Lex: it is named and the heartbeat keeps going.
  nextSays("waits: docs/wayfinder/alpha/build/tickets/02-grill.md needs Lex (type: grilling (HITL))",
    "waits: docs/wayfinder/alpha/build/tickets/21-records.md claimed by al-21, no running job found", "RESULT: ok next 0 ready, 2 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 ticket waiting on you, 1 claimed with no job (21-records); the lead looks at it", "RESULT: ok heartbeat continue"]);
  nextSays("waits: docs/wayfinder/alpha/build/tickets/21-r.md claimed by al-21 (this session), no running job found", "RESULT: ok next 0 ready, 1 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 claimed with no job (21-r); the lead looks at it", "RESULT: ok heartbeat continue"]);
  nextSays("waits: docs/wayfinder/alpha/build/tickets/21-records.md claimed by al-21, no running job found", "RESULT: ok next 0 ready, 1 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 claimed with no job (21-records); the lead looks at it", "RESULT: ok heartbeat continue"]);
  // A bare waits: line is counted, not a crash.
  nextSays("waits: ", "RESULT: ok next 0 ready, 1 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 waiting on other work", "RESULT: ok heartbeat continue"]);
  nextSays("waits: docs/wayfinder/alpha/build/tickets/21-records.md claimed by al-21, no running job found",
    "waits: docs/wayfinder/alpha/build/tickets/04-x.md shares a/x.ts with slice-be1", "RESULT: ok next 0 ready, 2 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 claimed with no job (21-records); the lead looks at it, 1 waiting on other work", "RESULT: ok heartbeat continue"]);
  nextSays("waits: docs/wayfinder/alpha/build/tickets/01-x.md build not started (README **Not started:**)", "RESULT: ok next 0 ready, 1 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: nothing running; 1 ticket waiting on you", "RESULT: ok heartbeat stop (only Lex-waits left)"]);
  nextSays("next: docs/wayfinder/alpha/build/tickets/05-y.md builder=claude-opus-5-5 owner=al-05 why=slot 1/5", "RESULT: ok next 1 ready, 0 waiting");
  assert.deepEqual(run("alpha").lines.slice(-2), ["running/next: 1 ready to start", "RESULT: ok heartbeat continue"]);
});

test("only slice-* jobs count: a hand-started kit bg job with a --ticket in the map is ignored", t => {
  const { job, run } = fixture(t);
  job("pr-al1", { subcommand: "pr" });
  job("rev-al1", { subcommand: "review", state: "exit 0", log: "RESULT: ok review x\n" });
  const result = run("alpha");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.lines.some(line => /^(running|finished|stuck): /.test(line)), result.stdout);
  assert.equal(result.lines.at(-1), "RESULT: ok heartbeat stop (frontier empty)");
});

test("an absolute --ticket path in the map counts", t => {
  const { job, run } = fixture(t);
  job("slice-al1", { ticketRoot: "/abs/wt/" });
  assert.ok(run("alpha").lines.includes("running: slice-al1 age 10m log 0 B (first check)"));
});

test("a job caught mid-launch (died, no pid yet) is running for a minute, then reported once", t => {
  const { job, run } = fixture(t);
  const directory = job("slice-al1", { state: "died", pid: false, ageSeconds: 2 });
  const launching = run("alpha");
  assert.ok(launching.lines.includes("running: slice-al1 age 0m log 0 B (first check)"), launching.stdout);
  assert.ok(!launching.lines.some(line => line.startsWith("finished: ")), launching.stdout);
  job("slice-al1", { state: "exit 0", log: "RESULT: ok slice x PR #4 abc1234\n" });
  assert.deepEqual(run("alpha").lines.filter(line => line.startsWith("finished: ")), ["finished: slice-al1 exit 0 RESULT: ok slice x PR #4 abc1234"]);
  // A launch that never wrote its pid is a died job after the grace minute.
  rmSync(join(directory, "pid"));
  job("slice-al1", { state: "died", pid: false, ageSeconds: 61, started: "2026-10-25T12:00:00.000Z" });
  assert.deepEqual(run("alpha").lines.filter(line => line.startsWith("finished: ")), ["finished: slice-al1 died (no exit record) (no RESULT line)"]);
});

test("a job caught before kit bg wrote started (age unknown, no pid) is running, not finished", t => {
  const { job, run } = fixture(t);
  job("slice-al1", { state: "died", pid: false, started: null });
  const result = run("alpha");
  assert.ok(result.lines.includes("running: slice-al1 age unknown log 0 B (first check)"), result.stdout);
  assert.ok(!result.lines.some(line => line.startsWith("finished: ")), result.stdout);
});

test("a slice that ends without a PR is finished, not merged", t => {
  const { job, run } = fixture(t);
  job("slice-al1", { state: "exit 0", log: "RESULT: ok slice x reviewed clean abc1234\n" });
  const result = run("alpha");
  assert.ok(!result.lines.some(line => /^(merged|preview): /.test(line)), result.stdout);
  assert.ok(result.lines.includes("done: 1 slice since tracking started: slice-al1 finished"), result.stdout);
});

test("a held lock times out; a bad lock wait is refused", async t => {
  const { env, root, run } = fixture(t);
  const lock = join(root, "main/.scratch/heartbeat/alpha.json.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const holder = spawn("flock", [lock, "-c", "echo held; sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => holder.kill("SIGKILL"));
  await new Promise(done => holder.stdout.once("data", done));
  env.KIT_HEARTBEAT_LOCK_WAIT = "0";
  const held = run("alpha");
  assert.equal(held.status, 1, held.stdout + held.stderr);
  assert.deepEqual(held.lines.slice(-3), ["done: unknown (heartbeat failed)",
    `running/next: the heartbeat failed (another heartbeat holds ${lock} after 0s); the lead looks at it`,
    `RESULT: fail heartbeat another heartbeat holds ${lock} after 0s`]);
  env.KIT_HEARTBEAT_LOCK_WAIT = "abc";
  const bad = run("alpha");
  assert.equal(bad.status, 1);
  assert.equal(bad.lines.at(-1), "RESULT: fail heartbeat KIT_HEARTBEAT_LOCK_WAIT must be whole seconds");
});

test("a slice's phase logs count: a quiet job log with a fresh phase log is not stuck, and growth comes from it", t => {
  const { job, run, root } = fixture(t);
  job("slice-al1", { log: "slice: brief ok\n", ageSeconds: 3600, quietMinutes: 50 });
  const slice = join(root, "wt-slice-al1/.scratch/kit-slice/01-x");
  mkdirSync(join(slice, "builder"), { recursive: true });
  writeFileSync(join(slice, "build.log"), "b".repeat(1000));
  writeFileSync(join(slice, "builder/run.log"), "r".repeat(1032));
  const at = new Date(Date.now() - 60_000);
  utimesSync(join(slice, "build.log"), at, at);
  utimesSync(join(slice, "builder/run.log"), at, at);
  const first = run("alpha");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(first.lines.filter(line => /^(running|stuck): /.test(line)), ["running: slice-al1 age 1h00m log 2.0 KB (first check)"]);
  writeFileSync(join(slice, "builder/run.log"), "r".repeat(1032 + 2048));
  assert.deepEqual(run("alpha").lines.filter(line => /^(running|stuck): /.test(line)), ["running: slice-al1 age 1h00m log +2.0 KB"]);
  // All of them quiet for 45 minutes is stuck.
  const old = new Date(Date.now() - 46 * 60_000);
  utimesSync(join(slice, "build.log"), old, old);
  utimesSync(join(slice, "builder/run.log"), old, old);
  assert.ok(run("alpha").lines.includes("stuck: slice-al1 log quiet 46m"));
});

test("a running job without a log file is empty and quiet since it started", t => {
  const { job, run } = fixture(t);
  unlinkSync(join(job("slice-al1", { ageSeconds: 3000 }), "log"));
  const result = run("alpha");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.lines.filter(line => /^(running|stuck): /.test(line)), ["running: slice-al1 age 50m log 0 B (first check)", "stuck: slice-al1 log quiet 50m"]);
});

test("a kit bg --list failure in one worktree fails the heartbeat", t => {
  const { env, job, run, root } = fixture(t);
  job("slice-al1");
  job("slice-al2");
  env.FAKE_BG_FAIL_ROOT = join(root, "wt-slice-al2");
  const result = run("alpha");
  assert.equal(result.status, 1);
  assert.deepEqual(result.lines.slice(-3), ["done: unknown (heartbeat failed)",
    `running/next: the heartbeat failed (kit bg --list failed in ${env.FAKE_BG_FAIL_ROOT}); the lead looks at it`,
    `RESULT: fail heartbeat kit bg --list failed in ${env.FAKE_BG_FAIL_ROOT}`]);
});

test("a git worktree list failure fails the heartbeat with both Lex lines", t => {
  const { env, root, run } = fixture(t);
  env.KIT_DEV_ROOT = join(root, "not-a-repo");
  mkdirSync(env.KIT_DEV_ROOT);
  const result = run("alpha");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(result.lines.slice(-3), ["done: unknown (heartbeat failed)",
    `running/next: the heartbeat failed (git worktree list failed in ${env.KIT_DEV_ROOT}); the lead looks at it`,
    `RESULT: fail heartbeat git worktree list failed in ${env.KIT_DEV_ROOT}`]);
});

test("a kit next that runs too long or kills the heartbeat still ends with both Lex lines", t => {
  const { env, run } = fixture(t);
  env.KIT_HEARTBEAT_NEXT_TIMEOUT = "1";
  env.FAKE_NEXT_SLEEP = "3";
  const slow = run("alpha");
  assert.equal(slow.status, 1, slow.stdout + slow.stderr);
  assert.deepEqual(slow.lines.slice(-2), ["running/next: the heartbeat failed (next timed out after 1s); the lead looks at it", "RESULT: fail heartbeat next timed out after 1s"]);
  delete env.FAKE_NEXT_SLEEP;
  env.FAKE_NEXT_KILL_PARENT = "1";
  const killed = run("alpha");
  assert.equal(killed.status, 1, killed.stdout + killed.stderr);
  assert.deepEqual(killed.lines.slice(-3), ["done: unknown (heartbeat failed)",
    "running/next: the heartbeat failed (the locked run was killed (signal 9)); the lead looks at it", "RESULT: fail heartbeat the locked run was killed (signal 9)"]);
});

test("two heartbeats at once report a finished job once", async t => {
  const { env, job, both } = fixture(t);
  job("slice-al1", { state: "exit 0", log: "RESULT: ok slice x PR #3 abc1234\n" });
  env.FAKE_NEXT_SLEEP = "1";
  const outputs = await both("alpha");
  assert.equal(outputs.filter(output => /^finished: slice-al1 /m.test(output)).length, 1, outputs.join("\n---\n"));
  for (const output of outputs) assert.match(output, /^RESULT: ok heartbeat stop \(frontier empty\)$/m);
});

test("--start passes through to kit next; its started jobs keep the heartbeat going; other maps' running lines are dropped", t => {
  const { nextSays, run, nextCalls } = fixture(t);
  nextSays("running: slice-be1 docs/wayfinder/beta/build/tickets/01-b.md",
    "next: docs/wayfinder/alpha/build/tickets/05-y.md builder=claude-opus-5-5 owner=al-05 why=slot 2/5",
    "claimed: docs/wayfinder/alpha/build/tickets/05-y.md owner=al-05 abc1234 (pushed)", "worktree: /w/al-05", "started: slice-al05",
    "wait: KIT_ROOT=/w/al-05 scripts/agents/kit wait job slice-al05 --timeout 2h", "RESULT: ok next 1 ready, 0 waiting, 1 started");
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(nextCalls(), ["next alpha --start"]);
  assert.ok(!result.lines.some(line => line.startsWith("running: slice-be1")), result.stdout);
  assert.ok(result.lines.includes("wait: KIT_ROOT=/w/al-05 scripts/agents/kit wait job slice-al05 --timeout 2h"), result.stdout);
  assert.deepEqual(result.lines.slice(-2), ["running/next: 1 started now", "RESULT: ok heartbeat continue"]);
  run("alpha");
  assert.deepEqual(nextCalls(), ["next alpha --start", "next alpha"]);
});

test("--start: delegated tickets keep it going; a ticket claimed meanwhile is not ready to start", t => {
  const { nextSays, run } = fixture(t);
  nextSays("next: docs/wayfinder/alpha/build/tickets/05-y.md builder=delegate opencode/x owner=al-05 why=delegated, no slot",
    "claimed: docs/wayfinder/alpha/build/tickets/05-y.md owner=al-05 abc1234 (pushed)", "delegate: docs/wayfinder/alpha/build/tickets/05-y.md opencode/x owner=al-05",
    "RESULT: ok next 1 ready, 0 waiting, 0 started");
  assert.deepEqual(run("alpha", "--start").lines.slice(-2), ["running/next: 1 to send to the free worker", "RESULT: ok heartbeat continue"]);
  nextSays("next: docs/wayfinder/alpha/build/tickets/05-y.md builder=claude-opus-5-5 owner=al-05 why=slot 1/5",
    "next: docs/wayfinder/alpha/build/tickets/06-z.md builder=claude-opus-5-5 owner=al-06 why=slot 2/5",
    "claimed: docs/wayfinder/alpha/build/tickets/05-y.md owner=al-05 abc1234 (pushed)", "started: slice-al05",
    "waits: docs/wayfinder/alpha/build/tickets/06-z.md claimed meanwhile (al-06)", "RESULT: ok next 1 ready, 1 waiting, 1 started");
  assert.deepEqual(run("alpha", "--start").lines.slice(-2), ["running/next: 1 started now, 1 waiting on other work", "RESULT: ok heartbeat continue"]);
});

test("a failed hand-out fails the heartbeat; usage errors exit 2", t => {
  const { env, nextSays, run } = fixture(t);
  nextSays("RESULT: fail next 1 ticket problems");
  env.FAKE_NEXT_ERR = "x.md:1: bad ticket";
  env.FAKE_NEXT_STATUS = "1";
  const failed = run("alpha");
  assert.equal(failed.status, 1);
  // The stderr problem line stays before the RESULT line it explains.
  assert.deepEqual(failed.lines.slice(0, 2), ["x.md:1: bad ticket", "next RESULT: fail next 1 ticket problems"]);
  assert.deepEqual(failed.lines.slice(-2), ["running/next: the hand-out failed (fail next 1 ticket problems); the lead looks at it", "RESULT: fail heartbeat next fail next 1 ticket problems"]);
  const none = run();
  assert.equal(none.status, 2);
  assert.match(none.stdout, /^RESULT: fail heartbeat needs a map$/m);
  assert.equal(run("alpha", "beta").status, 2);
});
