import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const runner = resolve("scripts/agents/agent-run.mjs");
const shell = resolve("scripts/agents/agent.sh");
const session = "resume-session-123";
const prompt = "Continue where you stopped; the brief is unchanged.";
const report = "continued report\n";

interface Status {
  pid: number; pgid: number | null; kind: string; model: string; cli: string; effort: string;
  worktree: string; brief: string; out: string; base?: string; commit?: string;
  started: string; updated: string; state: string; exitCode: number | null; session: string | null; resumes: number;
}
interface Call { cli: string; args: string[]; input: string; cwd: string }

const fake = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const cli = basename(process.argv[1]), args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cli, args, input: readFileSync(0, "utf8"), cwd: process.cwd() }) + "\\n");
if (process.env.FAKE_EVENTS) appendFileSync(process.env.FAKE_EVENTS, JSON.stringify({ phase: "start", pid: process.pid }) + "\\n");
const model = process.env.FAKE_WRONG_MODEL ? "wrong-model" : args[args.indexOf(cli === "codex" ? "-m" : "--model") + 1];
if (cli === "codex") {
  if (!process.env.FAKE_NO_MODEL) console.error("model: " + model);
  process.stderr.write("session id: resume-");
  await new Promise(resolve => setImmediate(resolve));
  console.error("session-123");
}
if (process.env.FAKE_DESCENDANT) {
  const descendant = spawn(process.execPath, ["-e", 'setInterval(() => {}, 1000)'], { stdio: "ignore" });
  writeFileSync(process.env.FAKE_DESCENDANT, JSON.stringify([process.pid, descendant.pid]));
}
if (process.env.FAKE_HOLD) {
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (existsSync(process.env.FAKE_HOLD)) { clearInterval(timer); resolve(); }
    }, 10);
  });
}
if (cli === "codex") writeFileSync(args[args.indexOf("-o") + 1], ${JSON.stringify(report)});
else {
  // Like the real CLI, Claude prints its single JSON result (with session_id) only at the end.
  const flag = ["--session-id", "--resume"].find(name => args.includes(name));
  const id = flag ? args[args.indexOf(flag) + 1] : ${JSON.stringify(session)};
  process.stdout.write(JSON.stringify({ result: ${JSON.stringify(report.trimEnd())}, session_id: id, modelUsage: { [model]: {} } }));
}
if (process.env.FAKE_EVENTS) appendFileSync(process.env.FAKE_EVENTS, JSON.stringify({ phase: "end", pid: process.pid }) + "\\n");
process.exit(Number(process.env.FAKE_EXIT || 0));
`;

async function until(condition: () => boolean, description: string) {
  const deadline = Date.now() + 15_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `deadline waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
    }
    return true;
  } catch { return false; }
}

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ase-agent-resume-"));
  const root = join(dir, "work tree"), bin = join(dir, "bin"), out = join(dir, "out");
  const brief = join(dir, "brief.md"), callsFile = join(dir, "calls.jsonl"), hold = join(dir, "release");
  const statusPath = join(out, "status.json");
  for (const path of [root, bin, out]) mkdirSync(path);
  writeFileSync(brief, "Build this brief.\n");
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  for (const cli of ["codex", "claude"]) {
    writeFileSync(join(bin, cli), fake); chmodSync(join(bin, cli), 0o755);
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "test");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "20s",
    ASE_RESUME_POLL_MS: "10", ASE_AGENT_CLI: "", ASE_BUILD_MODEL: "", FAKE_CALLS: callsFile };
  const children: ChildProcess[] = [];
  const groups = new Set<number>();
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (existsSync(statusPath)) {
      const status: Status = JSON.parse(readFileSync(statusPath, "utf8"));
      if (status.pgid) groups.add(status.pgid);
    }
    for (const group of groups) {
      try { process.kill(-group, "SIGKILL"); } catch { /* Already reaped. */ }
    }
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
      : new Promise<void>(resolve => child.once("close", () => resolve()))));
    rmSync(dir, { recursive: true, force: true });
  });
  const start = (args: string[], overrides: NodeJS.ProcessEnv = {}, viaShell = false) => {
    const child = spawn(viaShell ? "bash" : process.execPath, [viaShell ? shell : runner, ...args], {
      cwd: root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
    });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    return { child, done, stdout: () => stdout };
  };
  const status = (): Status => JSON.parse(readFileSync(statusPath, "utf8"));
  const save = (value: Status) => {
    const temporary = join(out, "test-status.tmp");
    writeFileSync(temporary, JSON.stringify(value)); renameSync(temporary, statusPath);
  };
  const seed = (changes: Partial<Status> = {}) => {
    const value: Status = { pid: 2_147_483_647, pgid: null, kind: "build", model: "gpt-6.1-sol", cli: "codex", effort: "high",
      worktree: root, brief, out, started: "2026-10-01T00:00:00.000Z", updated: "2026-10-01T00:00:00.000Z",
      state: "interrupted", exitCode: 129, session, resumes: 0, ...changes };
    save(value);
    writeFileSync(join(out, "run.log"), "old log\n");
    writeFileSync(join(out, "out.md"), "old report\n");
    return value;
  };
  const calls = (): Call[] => {
    if (!existsSync(callsFile)) return [];
    const text = readFileSync(callsFile, "utf8");
    // The file can exist before appendFileSync writes its record. Only complete
    // JSONL records prove that the CLI reached the call barrier.
    return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
  };
  const fresh = (cli = "codex", overrides: NodeJS.ProcessEnv = {}) => start(["build", root, brief, "--out", out,
    "--cli", cli, "--model", cli === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"], overrides);
  const running = async () => {
    await until(() => existsSync(statusPath) && status().state === "running" && status().session !== null && status().pgid !== null, "running status and session");
    const value = status();
    groups.add(value.pgid!);
    return value;
  };
  return { dir, root, out, brief, hold, statusPath, git, start, fresh, running, status, save, seed, calls, children };
}

for (const cli of ["codex", "claude"]) test(`${cli} writes running status with a session, then done`, async t => {
  const f = fixture(t);
  const run = f.fresh(cli, { FAKE_HOLD: f.hold });
  const status = await f.running();
  assert.equal(status.pid, run.child.pid);
  assert.ok(status.pgid && alive(status.pgid));
  if (process.platform === "linux") {
    const stat = readFileSync(`/proc/${status.pgid}/stat`, "utf8");
    assert.equal(Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]), status.pgid);
  }
  assert.equal(status.kind, "build"); assert.equal(status.cli, cli); assert.equal(status.effort, "medium");
  assert.equal(status.model, cli === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5");
  assert.equal(status.worktree, f.root); assert.equal(status.brief, f.brief); assert.equal(status.out, f.out);
  assert.equal(status.exitCode, null); assert.equal(status.resumes, 0);
  const assigned = cli === "codex" ? session : status.session!;
  if (cli === "claude") {
    assert.match(assigned, /^[0-9a-f-]{36}$/);
    await until(() => f.calls().length === 1, "fake CLI call");
    const [call] = f.calls();
    assert.deepEqual(call.args.slice(-2), ["--session-id", assigned]);
  } else assert.equal(status.session, session);
  assert.ok(Number.isFinite(Date.parse(status.started)) && Date.parse(status.updated) >= Date.parse(status.started));
  writeFileSync(f.hold, "go");
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.status().state, "done"); assert.equal(f.status().exitCode, 0);
  assert.equal(f.status().session, assigned); assert.equal(f.status().pid, status.pid);
  assert.match(result.stdout, /^artifacts: /); assert.ok(result.stdout.includes(report));
  assert.deepEqual(readdirSync(f.out).sort(), ["out.md", "run.log", "status.json"]);
});

test("nonzero CLI exit records failed and retains the exit code", async t => {
  const f = fixture(t);
  const result = await f.fresh("codex", { FAKE_EXIT: "7" }).done;
  assert.equal(result.code, 7, result.stderr);
  assert.equal(f.status().state, "failed"); assert.equal(f.status().exitCode, 7);
});

for (const cli of ["codex", "claude"]) test(`dead ${cli} build resumes with saved options and appends artifacts`, async t => {
  const f = fixture(t);
  f.seed({ cli, model: cli === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5", state: "running", exitCode: null });
  const run = f.start(["--resume", f.out], { FAKE_HOLD: f.hold, ASE_BUILD_MODEL: "ignored-model", ASE_AGENT_CLI: "ignored-cli" }, true);
  const status = await f.running();
  assert.equal(status.pid, run.child.pid); assert.equal(status.resumes, 1); assert.equal(status.effort, "high");
  writeFileSync(f.hold, "go");
  const result = await run.done;
  assert.equal(result.code, 0, result.stderr);
  const [call] = f.calls();
  assert.equal(f.calls().length, 1); assert.equal(call.cli, cli); assert.equal(call.input, prompt); assert.equal(call.cwd, f.root);
  if (cli === "codex") {
    const common = f.git("rev-parse", "--path-format=absolute", "--git-common-dir");
    const temporary = call.args[call.args.indexOf("-o") + 1];
    assert.ok(temporary.startsWith(f.out + "/")); assert.notEqual(temporary, join(f.out, "out.md"));
    assert.deepEqual(call.args, ["exec", "resume", "-m", "gpt-6.1-sol", "-c", "model_reasoning_effort=high",
      "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true",
      "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(common)}]`,
      "--dangerously-bypass-hook-trust", "-o", temporary, session, "-"]);
    assert.equal(existsSync(temporary), false);
  } else {
    assert.deepEqual(call.args, ["-p", "--model", "claude-opus-5-5", "--effort", "high", "--permission-mode", "acceptEdits",
      "--allowedTools", "Bash", "--disallowedTools", "Task,Agent",
      "--add-dir", f.git("rev-parse", "--path-format=absolute", "--git-common-dir"), "--output-format", "json", "--resume", session]);
  }
  assert.equal(readFileSync(join(f.out, "out.md"), "utf8"), "old report\n" + report);
  const log = readFileSync(join(f.out, "run.log"), "utf8");
  assert.match(log, /^old log\n\n--- resume \d{4}-\d\d-\d\dT.+Z ---\n/);
  assert.ok(log.includes(cli === "codex" ? "model: gpt-6.1-sol" : "modelUsage"));
  assert.equal(f.status().state, "done"); assert.equal(f.status().exitCode, 0); assert.equal(f.status().resumes, 1);
  assert.ok(result.stdout.includes(report));
});

for (const cli of ["codex", "claude"]) for (const state of ["done", "failed"]) {
  test(`${cli} ${state} run resumes with a new brief and recorded options`, async t => {
    const f = fixture(t);
    const model = cli === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5";
    f.seed({ cli, model, state, exitCode: state === "done" ? 0 : 7 });
    const brief = join(f.dir, "fix brief.md"), input = "Fix the review defect.\nDecline false findings with reasons.\n";
    writeFileSync(brief, input);
    const result = await f.start(["--resume", f.out, "--brief", brief], {
      ASE_BUILD_MODEL: "ignored-model", ASE_AGENT_CLI: "ignored-cli",
    }, true).done;
    assert.equal(result.code, 0, result.stderr);
    const [call] = f.calls();
    assert.equal(f.calls().length, 1); assert.equal(call.input, input); assert.equal(call.cli, cli);
    assert.equal(call.cwd, f.root);
    assert.ok(call.args.includes(session));
    assert.equal(call.args[call.args.indexOf(cli === "codex" ? "-m" : "--model") + 1], model);
    assert.ok(cli === "codex" ? call.args.includes("model_reasoning_effort=high") : call.args[call.args.indexOf("--effort") + 1] === "high");
    assert.equal(readFileSync(join(f.out, "out.md"), "utf8"), "old report\n" + report);
    assert.match(readFileSync(join(f.out, "run.log"), "utf8"), /^old log\n\n--- resume /);
    assert.equal(f.status().resumes, 1); assert.equal(f.status().state, "done");
    assert.equal(f.status().model, model); assert.equal(f.status().effort, "high"); assert.equal(f.status().brief, brief);
  });
}

test("resume with a brief waits for the live run before starting its continuation", async t => {
  const f = fixture(t);
  const original = f.fresh("codex", { FAKE_HOLD: f.hold });
  const running = await f.running();
  const brief = join(f.dir, "fix.md"); writeFileSync(brief, "Fix after the live build.\n");
  const resumed = f.start(["--resume", f.out, "--brief", brief]);
  await until(() => resumed.stdout().includes(`waiting: pid ${running.pid}`), "brief resume waiting");
  assert.equal(f.calls().length, 1);
  writeFileSync(f.hold, "go");
  assert.equal((await original.done).code, 0);
  const result = await resumed.done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls().length, 2); assert.equal(f.calls()[1].input, "Fix after the live build.\n");
  assert.equal(f.status().resumes, 1);
  assert.equal(readFileSync(join(f.out, "out.md"), "utf8"), report + report);
});

test("resume accepts exactly the two documented argument forms", async t => {
  const f = fixture(t); f.seed();
  for (const args of [["extra"], ["--brief"], ["--brief", "--model"], ["--brief", f.brief, "extra"],
    ["--brief", f.brief, "--brief", f.brief], ["--model", "other"]]) {
    const result = await f.start(["--resume", f.out, ...args]).done;
    assert.equal(result.code, 2, result.stderr);
  }
  const missing = await f.start(["--resume", f.out, "--brief", join(f.dir, "missing.md")]).done;
  assert.equal(missing.code, 2); assert.equal(f.status().resumes, 0); assert.equal(f.calls().length, 0);
});

test("resume checks the model using only new log output", async t => {
  const f = fixture(t);
  f.seed();
  writeFileSync(join(f.out, "run.log"), "model: gpt-6.1-sol\n");
  const result = await f.start(["--resume", f.out], { FAKE_NO_MODEL: "1" }).done;
  assert.equal(result.code, 1); assert.match(result.stderr, /requested model/);
  assert.equal(f.status().state, "failed"); assert.equal(f.status().resumes, 1);
  writeFileSync(join(f.out, "run.log"), "model: old-model\n");
  const success = await f.start(["--resume", f.out]).done;
  assert.equal(success.code, 0, success.stderr); assert.equal(f.status().resumes, 2);
});

test("resume waits for a live runner and returns its recorded result without another CLI", async t => {
  const f = fixture(t);
  const original = f.fresh("codex", { FAKE_HOLD: f.hold, FAKE_EXIT: "7" });
  const running = await f.running();
  const resumed = f.start(["--resume", f.out]);
  await until(() => resumed.stdout().includes(`waiting: pid ${running.pid}`), "resume waiting line");
  assert.equal(resumed.child.exitCode, null); assert.equal(f.calls().length, 1);
  writeFileSync(f.hold, "go");
  assert.equal((await original.done).code, 7);
  const result = await resumed.done;
  assert.equal(result.code, 7, result.stderr); assert.ok(result.stdout.includes(report));
  assert.equal(f.calls().length, 1); assert.equal(f.status().resumes, 0);
});

test("resume continues when a live runner dies without finalizing its running status", async t => {
  const f = fixture(t);
  const original = f.fresh("codex", { FAKE_HOLD: f.hold });
  const running = await f.running();
  const resumed = f.start(["--resume", f.out]);
  await until(() => resumed.stdout().includes("waiting: pid"), "waiting for original runner");
  // Simulate an app hard kill of both runner and its CLI group.
  process.kill(-running.pgid!, "SIGKILL"); original.child.kill("SIGKILL");
  await original.done;
  writeFileSync(f.hold, "go");
  const result = await resumed.done;
  assert.equal(result.code, 0, result.stderr); assert.equal(f.calls().length, 2);
  assert.equal(f.status().state, "done"); assert.equal(f.status().resumes, 1);
});

test("two waiting resume callers start exactly one replacement and both report its result", async t => {
  const f = fixture(t);
  const original = f.fresh("codex", { FAKE_HOLD: f.hold });
  const running = await f.running();
  const callers = [f.start(["--resume", f.out]), f.start(["--resume", f.out])];
  for (const caller of callers) await until(() => caller.stdout().includes(`waiting: pid ${running.pid}`), "both callers waiting");
  // App hard kill: runner and CLI group die without finalising the status.
  process.kill(-running.pgid!, "SIGKILL"); original.child.kill("SIGKILL");
  await original.done;
  await until(() => f.status().resumes === 1 && f.calls().length === 2, "one replacement CLI");
  writeFileSync(f.hold, "go");
  const results = await Promise.all(callers.map(caller => caller.done));
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr); assert.ok(result.stdout.includes(report));
  }
  assert.equal(f.calls().length, 2); assert.equal(f.status().state, "done"); assert.equal(f.status().resumes, 1);
});

for (const cli of ["codex", "claude"]) test(`concurrent ${cli} resumes with distinct briefs both reach the session serially`, async t => {
  const f = fixture(t);
  f.seed({ cli, model: cli === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5", state: "failed", exitCode: 7 });
  const briefs = [join(f.dir, "first.md"), join(f.dir, "second.md")];
  const prompts = ["Fix the first finding.\n", "Fix the second finding.\n"];
  briefs.forEach((brief, index) => writeFileSync(brief, prompts[index]));
  const barrier = join(f.dir, "barrier"), claims = join(f.dir, "claims.jsonl"), events = join(f.dir, "events.jsonl");
  const loader = join(f.dir, "claim-barrier.mjs"); mkdirSync(barrier);
  // Intercept only the initial claim's atomic link. Both runners must select
  // generation 1 before either can publish it, so one necessarily loses.
  writeFileSync(loader, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    if (process.argv[1] === ${JSON.stringify(runner)}) {
      const link = fs.linkSync;
      fs.linkSync = function (source, target) {
        if (target !== ${JSON.stringify(join(f.out, "resume-claim-1.0"))}) return link(source, target);
        fs.writeFileSync(${JSON.stringify(barrier)} + "/" + process.pid, "ready");
        const deadline = Date.now() + 15000;
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (fs.readdirSync(${JSON.stringify(barrier)}).length < 2) {
          if (Date.now() > deadline) throw new Error("claim barrier timed out");
          Atomics.wait(wait, 0, 0, 10);
        }
        try {
          link(source, target);
          fs.appendFileSync(${JSON.stringify(claims)}, "won\\n");
        } catch (error) {
          fs.appendFileSync(${JSON.stringify(claims)}, error.code + "\\n");
          throw error;
        }
      };
      syncBuiltinESMExports();
    }
  `);
  const callers = briefs.map(brief => f.start(["--resume", f.out, "--brief", brief], {
    NODE_OPTIONS: `--import=${loader}`, FAKE_HOLD: f.hold, FAKE_EVENTS: events,
  }));
  await until(() => existsSync(claims) && readFileSync(claims, "utf8").trim().split("\n").length === 2, "both generation-1 claim attempts");
  assert.deepEqual(readFileSync(claims, "utf8").trim().split("\n").sort(), ["EEXIST", "won"]);
  await f.running();
  await until(() => f.calls().length === 1, "winning CLI call");
  assert.equal(f.status().resumes, 1);
  writeFileSync(f.hold, "go");
  const results = await Promise.all(callers.map(caller => caller.done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(f.calls().map(call => call.input).sort(), [...prompts].sort());
  assert.ok(f.calls().every(call => call.cli === cli && call.args.includes(session)));
  const activity: { phase: string; pid: number }[] = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(activity.map(event => event.phase), ["start", "end", "start", "end"]);
  assert.equal(activity[0].pid, activity[1].pid); assert.equal(activity[2].pid, activity[3].pid);
  assert.equal(f.status().resumes, 2); assert.equal(f.status().state, "done");
  assert.equal(readFileSync(join(f.out, "out.md"), "utf8"), "old report\n" + report + report);
});

test("callers waiting on a failing replacement return its exit code and start nothing more", async t => {
  const f = fixture(t);
  const original = f.fresh("codex", { FAKE_HOLD: f.hold });
  const running = await f.running();
  const callers = [0, 1].map(() => f.start(["--resume", f.out], { FAKE_HOLD: f.hold, FAKE_EXIT: "7" }));
  for (const caller of callers) await until(() => caller.stdout().includes(`waiting: pid ${running.pid}`), "both callers waiting");
  process.kill(-running.pgid!, "SIGKILL"); original.child.kill("SIGKILL");
  await original.done;
  await until(() => f.status().resumes === 1 && f.calls().length === 2, "one replacement CLI");
  writeFileSync(f.hold, "go");
  for (const result of await Promise.all(callers.map(caller => caller.done))) assert.equal(result.code, 7, result.stderr);
  assert.equal(f.calls().length, 2); assert.equal(f.status().state, "failed"); assert.equal(f.status().resumes, 1);
});

test("a claim left by a runner that died before starting is superseded once", async t => {
  const f = fixture(t);
  f.seed();
  writeFileSync(join(f.out, "resume-claim-1.0"), "2147483647\n");
  const result = await f.start(["--resume", f.out]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls().length, 1); assert.equal(f.status().resumes, 1); assert.equal(f.status().state, "done");
  assert.ok(existsSync(join(f.out, "resume-claim-1.1")));
});

test("a Claude run killed before its final JSON resumes its pre-assigned session", async t => {
  const f = fixture(t);
  const run = f.fresh("claude", { FAKE_HOLD: f.hold });
  const { session: assigned } = await f.running();
  await until(() => f.calls().length === 1, "fake CLI call");
  run.child.stdout?.destroy(); run.child.stderr?.destroy();
  run.child.kill("SIGHUP");
  assert.equal((await run.done).code, 129);
  assert.equal(f.status().state, "interrupted"); assert.equal(f.status().session, assigned);
  writeFileSync(f.hold, "go");
  const result = await f.start(["--resume", f.out]).done;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(f.calls().length, 2);
  const resumed = f.calls()[1].args;
  assert.deepEqual(resumed.slice(-2), ["--resume", assigned]); assert.ok(!resumed.includes("--session-id"));
  assert.equal(f.status().state, "done"); assert.equal(f.status().session, assigned);
});

test("a live unrelated pid is treated as dead", async t => {
  const f = fixture(t);
  // The test process is alive, but its cmdline does not contain agent-run.mjs.
  f.seed({ pid: process.pid });
  const result = await f.start(["--resume", f.out]).done;
  assert.equal(result.code, 0, result.stderr); assert.doesNotMatch(result.stdout, /waiting:/);
  assert.equal(f.calls().length, 1);
});

for (const [signal, code] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] satisfies [NodeJS.Signals, number][]) {
  test(`${signal} records interrupted and kills the CLI process group`, async t => {
    const f = fixture(t);
    const descendants = join(f.dir, "descendants.json");
    const run = f.fresh("codex", { FAKE_HOLD: f.hold, FAKE_DESCENDANT: descendants });
    await f.running();
    await until(() => existsSync(descendants), "CLI descendant pid");
    const pids: number[] = JSON.parse(readFileSync(descendants, "utf8"));
    // App shutdown may close both output pipes before delivering the signal.
    run.child.stdout?.destroy(); run.child.stderr?.destroy();
    run.child.kill(signal);
    const result = await run.done;
    assert.equal(result.code, code);
    assert.equal(f.status().state, "interrupted"); assert.equal(f.status().exitCode, code);
    await until(() => pids.every(pid => !alive(pid)), "dead CLI process group");
  });
}

test("timeout writes timeout status", async t => {
  const f = fixture(t);
  const result = await f.fresh("codex", { FAKE_HOLD: f.hold, ASE_AGENT_TIMEOUT: "1s" }).done;
  assert.equal(result.code, 124, result.stderr);
  assert.equal(f.status().state, "timeout"); assert.equal(f.status().exitCode, 124);
});

test("done run prints saved report and never calls a CLI", async t => {
  const f = fixture(t);
  f.seed({ state: "done", exitCode: 0, session: null });
  const before = readFileSync(f.statusPath, "utf8");
  const result = await f.start(["--resume", f.out]).done;
  assert.equal(result.code, 0, result.stderr); assert.equal(result.stdout, "old report\n");
  assert.equal(f.calls().length, 0); assert.equal(readFileSync(f.statusPath, "utf8"), before);
});

test("missing session and Codex review resume fail clearly without a CLI", async t => {
  const f = fixture(t);
  f.seed({ session: null });
  const missing = await f.start(["--resume", f.out]).done;
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes(`problem: no session id recorded in ${f.statusPath}; rerun instead`));
  f.seed({ kind: "review", base: "HEAD" });
  const review = await f.start(["--resume", f.out]).done;
  assert.equal(review.code, 1); assert.match(review.stderr, /problem: cannot resume a Codex review.*temporary CODEX_HOME/);
  assert.equal(f.calls().length, 0);
});

test("resume accepts no option overrides; usage mentions resume", async t => {
  const f = fixture(t);
  f.seed();
  const result = await f.start(["--resume", f.out, "--model", "other-model"]).done;
  assert.equal(result.code, 2); assert.match(result.stderr, /Usage:.*--resume <out-dir>/);
  assert.equal(f.calls().length, 0);
});

for (const code of ["EPIPE", "EIO"]) test(`${code} output failures happen after final status and cannot change the result`, async t => {
  const f = fixture(t);
  const loader = join(f.dir, "closed-output.mjs"), observations = join(f.dir, "output-status.jsonl");
  // Emulate both asynchronous pipe errors and synchronous terminal write errors.
  // Only instrument the runner; fake CLIs must keep their ordinary output streams.
  writeFileSync(loader, `
    import { appendFileSync, readFileSync } from "node:fs";
    if (process.argv[1] === ${JSON.stringify(runner)}) {
      for (const stream of [process.stdout, process.stderr]) {
        const original = stream.write;
        stream.write = function (chunk, ...args) {
          if (String(chunk).startsWith("artifacts: ")) return original.call(this, chunk, ...args);
          const status = JSON.parse(readFileSync(${JSON.stringify(f.statusPath)}, "utf8"));
          appendFileSync(${JSON.stringify(observations)}, JSON.stringify(status) + "\\n");
          const error = Object.assign(new Error("app closed output"), { code: ${JSON.stringify(code)} });
          if (error.code === "EIO") throw error;
          queueMicrotask(() => this.emit("error", error));
          return false;
        };
      }
    }
  `);
  const result = await f.fresh("codex", { FAKE_EXIT: "7", NODE_OPTIONS: `--import=${loader}` }).done;
  assert.equal(result.code, 7, result.stderr);
  const recorded: Status[] = readFileSync(observations, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.ok(recorded.length >= 2, "both problem and report writes were attempted");
  assert.ok(recorded.every(status => status.state === "failed" && status.exitCode === 7));
  assert.equal(f.status().state, "failed"); assert.equal(f.status().exitCode, 7);
});
