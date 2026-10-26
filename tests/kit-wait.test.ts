import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { failingTests } from "../scripts/agents/ci-summary.mjs";

const script = resolve("scripts/agents/kit.d/wait");
const kit = resolve("scripts/agents/kit");
const baseEnv = { ...process.env, ASE_OWNER: "wait-test", KIT_WAIT_POLL_MS: "50", KIT_WAIT_STATUS_MS: "60000" };
function temp(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-wait-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function child(t: TestContext, command: string, args: string[], env = baseEnv, stdin: "ignore" | "pipe" = "ignore") {
  const process = spawn(command, args, { env, stdio: [stdin, "pipe", "pipe"] });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); });
  return process;
}
function collect(process: ChildProcess) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    process.stdout!.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    process.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    process.on("error", reject);
    process.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
function run(t: TestContext, args: string[], env = baseEnv) {
  return collect(child(t, process.execPath, [script, ...args], env));
}
// Resolve with the next complete stdout line matching pattern that arrives after this call.
function nextLine(process: ChildProcess, pattern: RegExp) {
  return new Promise<string>((resolve, reject) => {
    const stream = process.stdout!.setEncoding("utf8");
    let buffer = "";
    const stop = () => { stream.off("data", read); stream.off("end", ended); };
    const read = (text: string) => {
      const lines = (buffer + text).split("\n");
      buffer = lines.pop()!;
      const found = lines.find((line) => pattern.test(line));
      if (found !== undefined) { stop(); resolve(found); }
    };
    const ended = () => { stop(); reject(new Error(`output ended before a line matching ${pattern}`)); };
    stream.on("data", read).on("end", ended);
  });
}
// Status every poll: each "waiting " line is printed after a full scan of the file and /proc.
function watchOutput(t: TestContext, file: string, quiet: string) {
  const wait = child(t, process.execPath, [script, "output", file, "--quiet", quiet], { ...baseEnv, KIT_WAIT_STATUS_MS: "1" });
  return { wait, output: collect(wait), scanned: () => nextLine(wait, /^waiting /) };
}
function result(output: { status: number | null; stdout: string; stderr: string }, status: number, pattern: RegExp) {
  assert.equal(output.status, status, output.stderr + output.stdout);
  const lines = output.stdout.trimEnd().split("\n");
  const results = lines.filter((line) => line.startsWith("RESULT: "));
  assert.equal(results.length, 1, output.stdout);
  assert.equal(lines.at(-1), results[0]);
  assert.match(results[0], pattern);
  return output.stdout;
}
function last20(stdout: string, prefix: string) {
  const lines = stdout.split("\n").filter((line) => line.startsWith(prefix));
  assert.deepEqual(lines, Array.from({ length: 20 }, (_, i) => `${prefix}${i + 11}`));
}

test("wait help covers each subcommand and kit lists its summary", async (t) => {
  assert.equal(readFileSync(script, "utf8").split("\n")[1], "// kit: wait for a process, an output file or CI checks");
  for (const kind of [[], ["pid"], ["job"], ["output"], ["ci"]]) for (const flag of ["--help", "-h"]) {
    const output = await run(t, [...kind, flag]);
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, /Usage: kit wait pid/);
    assert.doesNotMatch(output.stdout, /RESULT:/);
  }
  const listing = spawnSync("/bin/bash", [kit], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /wait\s+wait for a process, an output file or CI checks/);
  const help = spawnSync("/bin/bash", [kit, "wait", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /RESULT:/);
});

function jobFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-wait-job-"));
  const env = { ...baseEnv, KIT_ROOT: root };
  const directory = (name: string) => join(root, ".scratch/kit-jobs", name);
  t.after(() => {
    const jobs = join(root, ".scratch/kit-jobs");
    if (existsSync(jobs)) for (const name of readdirSync(jobs).filter(name => !name.startsWith(".")))
      spawnSync(kit, ["bg", "--stop", name], { env, stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });
  const start = (name: string, code: string, ...args: string[]) => {
    const output = spawnSync(kit, ["bg", name, "--", process.execPath, "-e", code, ...args], { env, encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr + output.stdout);
    return Number(readFileSync(join(directory(name), "pid"), "utf8"));
  };
  return { root, env, start, directory };
}
async function jobCondition(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "job condition timed out");
    await delay(10);
  }
}

for (const status of [0, 3]) test(`wait job returns exit ${status}, prints at most 15 tail lines and the last job RESULT`, async t => {
  const f = jobFixture(t);
  const release = join(f.root, "release");
  f.start("finish", `const fs = require('fs'); console.log('RESULT: ok obsolete'); console.log('RESULT: ok job-owned'); for (let i = 1; i <= 30; i++) console.log('line-' + i); console.error('stderr-tail'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(${status}); } }, 10);`, release);
  const pending = child(t, kit, ["wait", "job", "finish", "--timeout", "5s"], f.env);
  const output = collect(pending);
  await nextLine(pending, /^kit wait job /);
  writeFileSync(release, "");
  const ended = await output;
  assert.equal(ended.status, status, ended.stderr + ended.stdout);
  assert.deepEqual(ended.stdout.split("\n").filter(line => /^line-/.test(line)), Array.from({ length: 14 }, (_, i) => `line-${i + 17}`));
  assert.ok(ended.stdout.includes("stderr-tail\n"));
  assert.equal(ended.stdout.split("\n").filter(line => line === "RESULT: ok job-owned").length, 1);
  assert.doesNotMatch(ended.stdout, /RESULT: ok obsolete/);
  assert.match(ended.stdout, new RegExp(`RESULT: ${status === 0 ? "ok" : "fail"} job finish exit ${status}\\n$`));
  assert.equal(readFileSync(join(f.directory("finish"), "exit"), "utf8"), `${status}\n`);
});

test("wait job deduplicates a RESULT already in the tail and works from a fresh process", async t => {
  const f = jobFixture(t);
  f.start("restart", "console.log('RESULT: ok original');");
  await jobCondition(() => existsSync(join(f.directory("restart"), "exit")));
  const output = await collect(child(t, kit, ["wait", "job", "restart", "--timeout", "5s"], f.env));
  assert.equal(output.status, 0, output.stderr + output.stdout);
  assert.equal(output.stdout.split("\n").filter(line => line === "RESULT: ok original").length, 1);
  assert.match(output.stdout, /RESULT: ok job restart exit 0\n$/);
});

for (const stage of ["open", "read"]) test(`wait job keeps output and status together when replaced before log ${stage}`, async t => {
  const f = jobFixture(t);
  f.start("reused", "console.log('original output'); console.log('RESULT: fail original'); process.exit(3);");
  await jobCondition(() => existsSync(join(f.directory("reused"), "exit")));
  const log = join(f.directory("reused"), "log");
  const paused = join(f.root, "paused");
  const release = join(f.root, "release");
  const preload = join(f.root, "pause-log.mjs");
  writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const log = ${JSON.stringify(log)};
const gate = () => {
  fs.writeFileSync(${JSON.stringify(paused)}, "");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(${JSON.stringify(release)})) {
    if (Date.now() >= deadline) throw new Error("log gate timed out");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
for (const name of ${JSON.stringify(stage === "open" ? ["open", "openSync"] : ["createReadStream"])}) {
  const original = fs[name];
  fs[name] = function (path, ...args) {
    if (String(path) === log || (name === "createReadStream" && typeof args[0]?.fd === "number")) gate();
    return original.call(this, path, ...args);
  };
}
syncBuiltinESMExports();
`);
  const pending = collect(child(t, process.execPath, ["--import", pathToFileURL(preload).href, script, "job", "reused", "--timeout", "10s"], f.env));
  await jobCondition(() => existsSync(paused));
  f.start("reused", "console.log('replacement output'); console.log('RESULT: ok replacement');");
  await jobCondition(() => existsSync(join(f.directory("reused"), "exit")));
  writeFileSync(release, "");
  const output = await pending;
  assert.doesNotMatch(output.stdout, /replacement/, output.stderr + output.stdout);
  result(output, 1, /job reused was replaced/);
  assert.doesNotMatch(output.stdout, /original output|RESULT: fail original|job reused exit 3/);
});

for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
  test(`wait job cancels its held final log stream on ${signal} and closes its descriptor`, async t => {
    const f = jobFixture(t);
    f.start("streaming", "console.log('RESULT: ok job-owned');");
    await jobCondition(() => existsSync(join(f.directory("streaming"), "exit")));
    const held = join(f.root, "held");
    const release = join(f.root, "release");
    const cleanup = join(f.root, "cleanup");
    const preload = join(f.root, "hold-stream.mjs");
    writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const original = fs.createReadStream;
fs.createReadStream = function (path, options) {
  const stream = original.call(this, path, options);
  const read = stream._read;
  let resume;
  stream._read = function (size) {
    resume = () => read.call(this, size);
    fs.writeFileSync(${JSON.stringify(held)}, "");
  };
  // Keep the read pending until explicitly released or cancelled by the waiter.
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(release)})) {
      stream._read = read;
      resume?.();
      clearInterval(timer);
    }
  }, 10);
  stream.once("close", () => clearInterval(timer));
  process.once("exit", () => {
    let open = true;
    try { fs.fstatSync(options.fd); } catch (error) { if (error.code === "EBADF") open = false; else throw error; }
    fs.writeFileSync(${JSON.stringify(cleanup)}, JSON.stringify({ open, destroyed: stream.destroyed, closed: stream.closed }));
  });
  return stream;
};
syncBuiltinESMExports();
`);
    const pending = child(t, kit, ["wait", "job", "streaming", "--timeout", "1h"],
      { ...f.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    const output = collect(pending);
    await jobCondition(() => existsSync(held));
    const started = Date.now();
    assert.ok(pending.kill(signal));
    try {
      await jobCondition(() => pending.exitCode !== null || pending.signalCode !== null);
      assert.ok(Date.now() - started < 2000, "interruption must not wait for the held log");
      const ended = await output;
      result(ended, signal === "SIGINT" ? 130 : 143, /fail wait interrupted/);
      assert.doesNotMatch(ended.stdout, /job-owned|RESULT: .* job streaming/);
      assert.deepEqual(JSON.parse(readFileSync(cleanup, "utf8")), { open: false, destroyed: true, closed: true });
    } finally { writeFileSync(release, ""); }
  });
}

test("wait job reports SIGKILL without an exit record", async t => {
  const f = jobFixture(t);
  const pid = f.start("killed", "setInterval(() => {}, 1000);");
  process.kill(-pid, "SIGKILL");
  const output = await run(t, ["job", "killed", "--timeout", "5s"], f.env);
  result(output, 1, /job killed died without exit status/);
  assert.equal(existsSync(join(f.directory("killed"), "exit")), false);
});

test("wait job timeout returns 124 while preserving the running job for a fresh wait", async t => {
  const f = jobFixture(t);
  const release = join(f.root, "release");
  f.start("pending", "const fs = require('fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 10);", release);
  result(await run(t, ["job", "pending", "--timeout", "0.05s"], f.env), 124, /job pending still running, timed out/);
  assert.equal(existsSync(join(f.directory("pending"), "exit")), false);
  writeFileSync(release, "");
  result(await run(t, ["job", "pending", "--timeout", "5s"], f.env), 0, /job pending exit 0/);
});

test("wait job rejects invalid, absent, or corrupt records", async t => {
  const f = jobFixture(t);
  result(await run(t, ["job", "../escape"], f.env), 2, /invalid job name/);
  result(await run(t, ["job", "absent"], f.env), 1, /missing or invalid job records/);
  f.start("corrupt", "process.exit(0);");
  await jobCondition(() => existsSync(join(f.directory("corrupt"), "exit")));
  writeFileSync(join(f.directory("corrupt"), "exit"), "not a status");
  result(await run(t, ["job", "corrupt"], f.env), 1, /invalid job exit status/);
});

test("pid waits for a child exit through the front door and reports owner and elapsed time", async (t) => {
  const sleeper = child(t, process.execPath, ["-e", "process.stdin.once('data', () => process.exit(0));"], baseEnv, "pipe");
  const waiting = child(t, "/bin/bash", [kit, "wait", "pid", String(sleeper.pid), "--timeout", "5"], { ...baseEnv, KIT_WAIT_STATUS_MS: "1" });
  const pending = collect(waiting);
  await nextLine(waiting, /^waiting /);
  const exited = once(sleeper, "close");
  sleeper.stdin!.end("finish");
  await exited;
  const output = await pending;
  result(output, 0, /ok pid \d+ exited after \d+(?:ms|s)/);
  assert.match(output.stdout, /^kit wait pid \d+ \(owner wait-test\)\n/);
});

test("pid timeout fails and idle status is rate limited", async (t) => {
  // Stay alive until teardown, however long starting the waiter takes under load.
  const sleeper = child(t, process.execPath, ["-e", "process.stdin.resume();"], baseEnv, "pipe");
  const output = await run(t, ["pid", String(sleeper.pid), "--timeout", "1"]);
  result(output, 1, /still running, timed out after 1/);
  assert.doesNotMatch(output.stdout, /waiting /);
});

test("pid already absent succeeds and invalid usage exits 2", async (t) => {
  result(await run(t, ["pid", "2147483647"]), 0, /ok pid 2147483647 not running/);
  for (const args of [[], ["other"], ["pid", "no"], ["pid"], ["pid", "1", "--timeout", "bad"],
    ["pid", "1", "--timeout", "0"], ["pid", "1", "--quiet", "1"], ["output", "x", "--until", "["],
    ["ci", "--pr", "x"], ["ci", "--sha", "abcd"], ["ci", "--branch", "dev", "--pr", "1"],
    ["ci", "--timeout"], ["ci", "--timeout", "1", "--timeout", "2"]]) {
    const output = await run(t, args);
    result(output, 2, /fail /);
    assert.notEqual(output.stderr, "");
  }
  for (const duration of ["90s", "30m", "1h", "90"]) {
    result(await run(t, ["pid", "2147483647", "--timeout", duration]), 0, /not running/);
  }
});

test("output regex waits for creation and an appended multiline match", async (t) => {
  const file = join(temp(t), "output");
  const pending = run(t, ["output", file, "--until", "^done$", "--timeout", "2s"]);
  child(t, process.execPath, ["-e", 'const fs = require("fs"); setTimeout(() => fs.appendFileSync(process.argv[1], "start\\ndone\\n"), 200)', file]);
  const output = await pending;
  result(output, 0, /matched \/\^done\$\/ after /);
  assert.equal(output.stdout.split("\n").filter((line) => line === "done").length, 1);
});

test("output quiet completion prints only the final 20 lines once", async (t) => {
  const file = join(temp(t), "output");
  writeFileSync(file, Array.from({ length: 30 }, (_, i) => `line-${i + 1}\n`).join(""));
  const output = await run(t, ["output", file, "--quiet", "0.1s", "--timeout", "2"]);
  result(output, 0, /finished after /);
  last20(output.stdout, "line-");
});

test("output stays pending while a live writer holds an unchanged file open", async (t) => {
  const file = join(temp(t), "output");
  const released = `${file}.released`;
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "held\\n"); console.log("ready"); setTimeout(() => { fs.writeFileSync(process.argv[2], "released"); fs.closeSync(fd); }, 500)', file, released]);
  await once(writer.stdout!, "data");
  const output = await run(t, ["output", file, "--quiet", "0.05s", "--timeout", "2"]);
  result(output, 0, /finished after /);
  assert.equal(readFileSync(released, "utf8"), "released", "wait must not finish before the writer releases its file");
});

test("output waits for a producer that closes the file and appends again before exiting", async (t) => {
  const file = join(temp(t), "output");
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "first\\n"); console.log("ready"); require("readline").createInterface({ input: process.stdin }).on("line", (step) => { if (step === "close") { fs.closeSync(fd); console.log("closed"); } else { fs.appendFileSync(process.argv[1], "second\\n"); process.exit(0); } })', file], baseEnv, "pipe");
  await nextLine(writer, /^ready$/);
  const { output, scanned } = watchOutput(t, file, "0.05s");
  await scanned(); // The wait has seen the writer holding the file.
  writer.stdin!.write("close\n");
  await nextLine(writer, /^closed$/);
  await scanned(); // Closed but alive: the wait keeps going well past its quiet period.
  const exited = once(writer, "exit");
  writer.stdin!.write("append\n");
  const finished = result(await output, 0, /finished after /);
  assert.match(finished, /first\nsecond\nRESULT:/, "wait must not finish before the producer appends and exits");
  assert.deepEqual(await exited, [0, null]);
});

// A process that exits while the scan reads its /proc files fails the read with ESRCH. The preload
// makes that happen on every scan for three processes the test owns: one loses its stat, one its
// fd list, and a reader holding the file its fdinfo. Every other process reads as usual.
const vanishing = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const vanishes = { [process.env.KIT_TEST_STAT_PID]: "stat", [process.env.KIT_TEST_FD_PID]: "fd", [process.env.KIT_TEST_READER_PID]: "fdinfo" };
const thrown = { stat: 0, fd: 0, fdinfo: 0 };
const vanish = (path) => {
  const match = /^\\/proc\\/(\\d+)\\/(stat|fd|fdinfo)(?:\\/\\d+)?$/.exec(String(path));
  if (!match || vanishes[match[1]] !== match[2]) return;
  const kind = match[2];
  thrown[kind]++;
  throw Object.assign(new Error("ESRCH: no such process, read"), { code: "ESRCH" });
};
for (const name of ["readFileSync", "readdirSync"]) {
  const original = fs[name];
  fs[name] = function (path, ...rest) { vanish(path); return original.call(this, path, ...rest); };
}
syncBuiltinESMExports();
process.on("exit", () => process.stderr.write("vanished " + JSON.stringify(thrown) + "\\n"));
`;

test("output keeps tracking its producer while other processes vanish mid-scan", async (t) => {
  const directory = temp(t);
  const file = join(directory, "output");
  const preload = join(directory, "vanishing.mjs");
  writeFileSync(preload, vanishing);
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "first\\n"); console.log("ready"); process.stdin.once("data", () => { fs.writeSync(fd, "second\\n"); process.exit(0); })', file], baseEnv, "pipe");
  await nextLine(writer, /^ready$/);
  const reader = child(t, process.execPath, ["-e", 'require("fs").openSync(process.argv[1], "r"); console.log("ready"); process.stdin.once("data", () => {})', file], baseEnv, "pipe");
  await nextLine(reader, /^ready$/);
  const [stat, fd] = [child(t, "/bin/sleep", ["600"]), child(t, "/bin/sleep", ["600"])];
  const wait = child(t, process.execPath, ["--import", pathToFileURL(preload).href, script, "output", file, "--quiet", "0.05s"],
    { ...baseEnv, KIT_WAIT_STATUS_MS: "1", KIT_TEST_STAT_PID: String(stat.pid), KIT_TEST_FD_PID: String(fd.pid), KIT_TEST_READER_PID: String(reader.pid) });
  const output = collect(wait);
  await nextLine(wait, /^waiting /); // A full scan met the vanishing processes and still saw the writer.
  const exited = once(writer, "exit");
  writer.stdin!.write("append\n");
  const finished = result(await output, 0, /finished after /);
  assert.match(finished, /first\nsecond\nRESULT:/);
  assert.deepEqual(await exited, [0, null]);
  const thrown = JSON.parse(/^vanished (.*)$/m.exec((await output).stderr)![1]);
  for (const kind of ["stat", "fd", "fdinfo"]) assert.ok(thrown[kind] > 0, `no ${kind} read vanished: ${JSON.stringify(thrown)}`);
});

test("output size changes restart the quiet period", async (t) => {
  const file = join(temp(t), "output");
  writeFileSync(file, "before\n");
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "a"); console.log("ready"); process.stdin.once("data", () => { const before = Date.now(); fs.writeSync(fd, "after\\n"); console.log(before); process.exit(0); })', file], baseEnv, "pipe");
  await nextLine(writer, /^ready$/);
  const { output, scanned } = watchOutput(t, file, "0.3s");
  await scanned(); // The wait has recorded the first size and seen the writer.
  const exited = once(writer, "exit");
  const appended = nextLine(writer, /^\d+$/);
  writer.stdin!.write("append\n");
  const appendedAt = Number(await appended);
  const finished = result(await output, 0, /finished after /);
  // The change is seen no earlier than appendedAt, and a full quiet period must follow it.
  assert.ok(Date.now() - appendedAt >= 300, `finished ${Date.now() - appendedAt}ms after the append`);
  assert.match(finished, /before\nafter\nRESULT:/);
  assert.deepEqual(await exited, [0, null]);
});

test("output timeout names missing files and prints existing content once", async (t) => {
  const file = join(temp(t), "output");
  const missing = await run(t, ["output", file, "--timeout", "0.15s"]);
  result(missing, 1, /output .* timed out after 0.15s/);
  writeFileSync(file, "unfinished\n");
  const output = await run(t, ["output", file, "--until", "done", "--timeout", "0.15s"]);
  result(output, 1, /timed out after 0.15s/);
  assert.equal(output.stdout.split("\n").filter((line) => line === "unfinished").length, 1);
});

const head = "abcdef0123456789abcdef0123456789abcdef01";
const newer = "123456789abcdef0123456789abcdef0123456789";
function fakeGh(t: TestContext, mode: string) {
  const directory = temp(t);
  const fake = join(directory, "gh");
  // Bash fixture dispatches only reads, recording every argv and moving its head via a counter.
  writeFileSync(fake, `#!/bin/bash
set -eu
[[ $GH_PAGER == cat && $NO_COLOR == 1 ]]
printf '%s\\n' "$*" >> "$WAIT_FIXTURE/calls"
count=0
[[ ! -f $WAIT_FIXTURE/count ]] || read -r count < "$WAIT_FIXTURE/count"
old=${head}
new=${newer}
case "$1 $2" in
  'api repos/{owner}/{repo}/commits/dev'|'api repos/{owner}/{repo}/commits/feature%2Fwork')
    count=$((count + 1)); printf '%s\\n' "$count" > "$WAIT_FIXTURE/count"
    if [[ $WAIT_MODE == error ]]; then printf 'fixture gh failure\\nsecond error line\\n' >&2; exit 1; fi
    if [[ $WAIT_MODE == pinned || ( ( $WAIT_MODE == superseded || $WAIT_MODE == moved ) && $count -gt 1 ) ]]; then echo "$new"; else echo "$old"; fi ;;
  'api repos/{owner}/{repo}/commits/abcdef0') echo "$old" ;;
  'pr view')
    [[ $3 == 42 && $4 == --json && $5 == headRefName,headRefOid ]]
    echo '{"headRefName":"feature/work","headRefOid":"${head}"}' ;;
  'workflow list') echo '[{"id":1,"name":"Checks","state":"active"}]' ;;
  'run list')
    if [[ $* == *'--json headBranch'* ]]; then
      count=$((count + 1)); printf '%s\\n' "$count" > "$WAIT_FIXTURE/count"
      if [[ $WAIT_MODE == no-runs || ( $WAIT_MODE == sha-empty && $count -eq 1 ) ]]; then echo '[]'; else echo '[{"headBranch":"dev"}]'; fi
      exit
    fi
    sha=$old
    [[ $* != *"--commit $new"* ]] || sha=$new
    status=completed; conclusion=success
    [[ $WAIT_MODE != failed ]] || conclusion=failure
    [[ $WAIT_MODE != cancelled ]] || conclusion=cancelled
    if [[ $WAIT_MODE == superseded && $sha == "$old" ]]; then conclusion=cancelled; fi
    if [[ $WAIT_MODE == pending ]]; then status=in_progress; conclusion=''; fi
    if [[ $WAIT_MODE == moved && ! -f $WAIT_FIXTURE/listed ]]; then : > "$WAIT_FIXTURE/listed"; status=in_progress; conclusion=''; fi
    echo "[{\\"databaseId\\":10,\\"workflowName\\":\\"Checks\\",\\"status\\":\\"$status\\",\\"conclusion\\":\\"$conclusion\\",\\"headSha\\":\\"$sha\\",\\"createdAt\\":\\"2026-10-16\\",\\"url\\":\\"https://example.test/run/10\\"}]" ;;
  'run view')
    if [[ $* == *--log-failed ]]; then
      echo '  not ok 7 - stopping group identity'
      echo '    location: tests/kit-bg.test.ts:170:1'
      echo '    error: |-'
      echo '      expected stopped group'
      printf 'log-%s\\n' {1..30}
    else
      echo '{"jobs":[{"name":"unit","status":"completed","conclusion":"failure","steps":[{"name":"Test suite","status":"completed","conclusion":"failure"}]}]}'
    fi ;;
  *) echo "unexpected gh: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(fake, 0o755);
  return { env: { ...baseEnv, PATH: `${directory}:${process.env.PATH}`, WAIT_FIXTURE: directory, WAIT_MODE: mode },
    calls: () => readFileSync(join(directory, "calls"), "utf8") };
}

test("ci green uses the default branch and pinned per-workflow reads", async (t) => {
  const fixture = fakeGh(t, "green");
  const output = await run(t, ["ci", "--timeout", "2s"], fixture.env);
  result(output, 0, /ok ci dev abcdef0 green \(1 workflows\) after /);
  assert.match(output.stdout, /Checks: success abcdef0/);
  assert.match(fixture.calls(), /api repos\/\{owner\}\/\{repo\}\/commits\/dev --jq .sha/);
  assert.match(fixture.calls(), new RegExp(`--branch dev --limit 1 .*--commit ${head}`));
});

test("ci failure prints test details before the last 20 failed log lines", async (t) => {
  const fixture = fakeGh(t, "failed");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 1, /ci dev abcdef0 failed: Checks/);
  assert.match(output.stdout, /unit: Test suite \(failure\)/);
  assert.match(output.stdout, /not ok 7 - stopping group identity — tests\/kit-bg.test.ts:170:1 — expected stopped group/);
  assert.ok(output.stdout.indexOf("not ok 7") < output.stdout.indexOf("log-11"));
  last20(output.stdout, "log-");
});

test("CI failure parser reads nested TAP, gh columns, ANSI and the first error line", () => {
  const fixture = [
    "ok 1 - good", "  # Subtest: stopping group identity", "  not ok 2 - stopping group identity",
    "    duration_ms: 12", "    location: 'tests/kit-bg.test.ts:170:1'", "    error: |-",
    "      expected stopped group", "      second error line", "    code: ERR_ASSERTION",
    "not ok 1 - outer suite", "  location: tests/kit-bg.test.ts:20:1", "  error: '1 subtest failed'",
  ].map(line => `checks\tUnit tests\t2026-10-19T12:30:01.123Z \u001b[31m${line}\u001b[0m`).join("\r\n");
  assert.deepEqual(failingTests(fixture), [
    "not ok 2 - stopping group identity — tests/kit-bg.test.ts:170:1 — expected stopped group",
    "not ok 1 - outer suite — tests/kit-bg.test.ts:20:1 — '1 subtest failed'",
  ]);
});

test("CI failure parser enriches repeated Node spec failures with file and first error", () => {
  assert.deepEqual(failingTests([
    "✖ identity (1.23ms)", "ℹ tests 1", "✖ failing tests:", "", "test at tests/kit-bg.test.ts:170:1",
    "✖ identity (1.23ms)", "  AssertionError [ERR_ASSERTION]: wrong group", "    at ignored-stack.ts:1:1",
  ].join("\n")), ["✖ identity — tests/kit-bg.test.ts:170:1 — AssertionError [ERR_ASSERTION]: wrong group"]);
});

test("CI failure parser identifies clean-guard child diagnostics outside the retained assertion tail", () => {
  const childFailure = [
    "  not ok 7 - stopping group identity", "    ---", "    duration_ms: 10",
    "    location: 'tests/kit-bg.test.ts:170:1'", "    error: |-",
    "      expected stopped group", "      second error line", "    code: ERR_ASSERTION", "    ...",
  ];
  const trailingOutput = Array.from({ length: 400 }, (_, i) => `ok ${i + 8} - subsequent successful test with enough output to fill the retained tail`);
  const childOutput = [...childFailure, ...trailingOutput].join("\n");
  const assertionTail = childOutput.slice(-12_000);
  assert.doesNotMatch(assertionTail, /stopping group identity|expected stopped group/);
  const fixture = [
    "TAP version 13", "# Subtest: kit and agent unit tests leave no run folders or temporary files",
    "not ok 1 - kit and agent unit tests leave no run folders or temporary files", "  ---",
    "  location: 'tests/kit-tests-clean.test.ts:15:1'", "  error: |-",
    ...assertionTail.split("\n").map(line => `    ${line}`), "  code: ERR_ASSERTION", "  ...",
    // node:test renders t.diagnostic(failures) with a '# ' prefix on every line.
    ...childFailure.map(line => `# ${line}`),
    ...trailingOutput.slice(-30).map(line => `# ${line}`), "1..1", "# fail 1",
  ].map(line => `checks\tKit tests leave no trace\t2026-10-19T12:30:01.123Z ${line}`).join("\n");
  assert.doesNotMatch(fixture.split("\n").slice(-20).join("\n"), /stopping group identity|expected stopped group/);
  assert.ok(failingTests(fixture).includes(
    "not ok 7 - stopping group identity — tests/kit-bg.test.ts:170:1 — expected stopped group",
  ));
});

test("CI failure parser reads Playwright progress or detailed failures with their first error", () => {
  const progress = "  ✘  1 [chromium] › tests/native-save/a.spec.ts:20:3 › save (1s)";
  assert.deepEqual(failingTests(progress), [progress.trim().replace(" (1s)", "")]);
  assert.deepEqual(failingTests([
    progress, "  ✘  2 [chromium] › tests/native-save/b.spec.ts:30:3 › load (2s)",
    "  1) [chromium] › tests/native-save/a.spec.ts:20:3 › save ─────",
    "    Error: save refused", "    ignored detail",
    "  2) [chromium] › tests/native-save/b.spec.ts:30:3 › load ─────",
    "    TimeoutError: load timed out", "    ignored detail",
  ].join("\n")), [
    "✘ [chromium] › tests/native-save/a.spec.ts:20:3 › save ───── — Error: save refused",
    "✘ [chromium] › tests/native-save/b.spec.ts:30:3 › load ───── — TimeoutError: load timed out",
  ]);
});

test("CI failure parser keeps same-named Node spec tests at different locations", () => {
  assert.deepEqual(failingTests([
    "✖ identity (1ms)", "✖ identity (2ms)", "✖ failing tests:",
    "test at tests/kit-bg.test.ts:170:1", "✖ identity (1ms)", "  Error: first failure",
    "test at tests/kit-wait.test.ts:50:1", "✖ identity (2ms)", "  Error: second failure",
  ].join("\n")), [
    "✖ identity — tests/kit-bg.test.ts:170:1 — Error: first failure",
    "✖ identity — tests/kit-wait.test.ts:50:1 — Error: second failure",
  ]);
});

test("CI failure parser caps the digest at ten lines and ignores successful or empty logs", () => {
  assert.deepEqual(failingTests(""), []);
  assert.deepEqual(failingTests("ok 1 - success\n✔ passed\nℹ tests 1"), []);
  const log = Array.from({ length: 15 }, (_, i) => `not ok ${i + 1} - failure ${i}\n  error: first error`).join("\n");
  const digest = failingTests(log);
  assert.equal(digest.length, 10);
  assert.equal(digest.at(-1), "not ok 10 - failure 9 — first error");
});

test("ci cancellation follows the fresh branch head without failing the cancelled run", async (t) => {
  const fixture = fakeGh(t, "superseded");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 0, /ci dev 1234567 green/);
  assert.match(output.stdout, /superseded by 1234567/);
  assert.doesNotMatch(fixture.calls(), /run view/);
});

test("ci SHA wait stays on its cancelled commit while the branch has a newer head", async (t) => {
  const fixture = fakeGh(t, "superseded");
  const output = await run(t, ["ci", "--sha", head, "--timeout", "2"], fixture.env);
  result(output, 1, new RegExp(`ci ${head} abcdef0 failed: Checks`));
  assert.match(output.stdout, /Checks: cancelled abcdef0/);
  assert.doesNotMatch(output.stdout, /superseded|green/);
  assert.doesNotMatch(fixture.calls(), new RegExp(`commits/dev|${newer}`));
});

test("ci keeps its starting head when the branch moves without a cancelled run", async (t) => {
  const fixture = fakeGh(t, "moved");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 0, /ci dev abcdef0 green/);
  assert.doesNotMatch(output.stdout, /superseded|1234567/);
});

test("status lines appear at most once per status interval", async (t) => {
  const sleeper = child(t, "/bin/sleep", ["10"]);
  const output = await run(t, ["pid", String(sleeper.pid), "--timeout", "0.7s"], { ...baseEnv, KIT_WAIT_STATUS_MS: "200" });
  result(output, 1, /timed out after 0.7s/);
  const waiting = output.stdout.split("\n").filter((line) => line.startsWith("waiting "));
  assert.ok(waiting.length >= 1 && waiting.length <= 3, output.stdout);
});

test("ci PR resolves the PR branch and head", async (t) => {
  const fixture = fakeGh(t, "green");
  const output = await run(t, ["ci", "--pr", "42", "--timeout", "2"], fixture.env);
  result(output, 0, /ci pr 42 abcdef0 green/);
  assert.match(fixture.calls(), /pr view 42 --json headRefName,headRefOid/);
  assert.match(fixture.calls(), /--branch feature\/work/);
});

test("ci SHA waits for a branch before reading workflows", async (t) => {
  const fixture = fakeGh(t, "sha-empty");
  const output = await run(t, ["ci", "--sha", head, "--timeout", "2"], fixture.env);
  result(output, 0, new RegExp(`ci ${head} abcdef0 green`));
  assert.equal(fixture.calls().split("\n").filter((line) => line.includes("--json headBranch")).length, 2);
});

test("ci abbreviated SHA expands and stays pinned when branch head differs", async (t) => {
  const fixture = fakeGh(t, "pinned");
  const output = await run(t, ["ci", "--sha", "abcdef0", "--timeout", "2"], fixture.env);
  result(output, 0, /ci abcdef0 abcdef0 green/);
  assert.match(fixture.calls(), /commits\/abcdef0 --jq .sha/);
  assert.doesNotMatch(output.stdout, /superseded/);
});

test("ci SHA with no runs waits until its deadline", async (t) => {
  const fixture = fakeGh(t, "no-runs");
  const output = await run(t, ["ci", "--sha", head, "--timeout", "0.2s"], fixture.env);
  result(output, 1, /abcdef0 timed out after 0.2s/);
  assert.doesNotMatch(fixture.calls(), /workflow list/);
});

test("ci cancellation on an unchanged head reports failure", async (t) => {
  const fixture = fakeGh(t, "cancelled");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 1, /ci dev abcdef0 failed: Checks/);
  assert.doesNotMatch(output.stdout, /superseded/);
});

test("ci pending timeout deduplicates workflow lines and rate limits status", async (t) => {
  const fixture = fakeGh(t, "pending");
  const output = await run(t, ["ci", "--timeout", "0.4s"], fixture.env);
  result(output, 1, /ci dev abcdef0 timed out after 0.4s/);
  assert.equal(output.stdout.split("\n").filter((line) => line.startsWith("Checks:")).length, 1);
  assert.doesNotMatch(output.stdout, /waiting /);
});

test("ci gh errors report only their first line", async (t) => {
  const fixture = fakeGh(t, "error");
  const output = await run(t, ["ci"], fixture.env);
  result(output, 1, /fail fixture gh failure$/);
  assert.doesNotMatch(output.stdout, /second error line/);
});

for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
  test(`wait stops promptly on ${signal} and leaves interrupted RESULT to kit`, async (t) => {
    const process = child(t, "/bin/bash", [kit, "wait", "pid", "1", "--timeout", "1h"]);
    const output = collect(process);
    await once(process.stdout!, "data");
    process.kill(signal);
    result(await output, signal === "SIGINT" ? 130 : 143, /fail wait interrupted/);
  });
}
