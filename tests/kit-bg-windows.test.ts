// kit bg and kit go the Windows way (no setsid, process groups, /proc or systemd), run on Linux: KIT_BG_PLATFORM=win32
// picks that way, and a fake powershell.exe (the Get-CimInstance Win32_Process list, read from /proc) and a fake
// taskkill (/PID … /T /F, the process tree by parent pid) stand in for the two Windows tools it calls.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { kitJob, kitJobPlatform, kitJobSame, kitJobTree, kitWinProcessList } from "../kit-lib.mjs";
import { kitEnv } from "./support/kit-env.ts";

const kit = resolve("kit");

const fakePowershell = `#!${process.execPath}
const fs = require("fs");
const script = process.argv.at(-1);
fs.appendFileSync(process.env.FAKE_WIN_LOG, "powershell " + script + "\\n");
if (!script.startsWith("Get-CimInstance Win32_Process") || !script.includes("$_.CreationDate.ToFileTimeUtc(), $_.Name")) process.exit(2);
const only = /-Filter 'ProcessId=(\\d+)'/.exec(script)?.[1];
const lines = [];
for (const pid of only ? [only] : fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Windows lists no zombies.
    if (!["Z", "X"].includes(fields[0])) lines.push(pid + " " + fields[1] + " " + fields[19] + " " + stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")));
  } catch {}
}
process.stdout.write(lines.map(line => line + "\\r\\n").join(""));
`;
const fakeTaskkill = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WIN_LOG, "taskkill " + args.join(" ") + "\\n");
const table = fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name)).flatMap(pid => {
  try { const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return [[Number(pid), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])]]; }
  catch { return []; }
});
let status = 0;
for (let i = 0; i < args.length; i++) if (args[i] === "/PID") {
  const tree = [Number(args[++i])];
  if (args.includes("/T")) for (let j = 0; j < tree.length; j++) for (const [pid, ppid] of table) if (ppid === tree[j]) tree.push(pid);
  for (const pid of tree) try { process.kill(pid, "SIGKILL"); } catch { if (pid === tree[0]) status = 128; }
}
process.exit(status);
`;
// Linux tools the Windows way must never run: each leaves a trace and fails.
const forbidden = ["setsid", "nohup", "systemd-run", "flock"];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-bg-win-"));
  const bin = join(root, ".bin");
  mkdirSync(bin);
  const log = join(root, "win.log");
  writeFileSync(log, "");
  writeFileSync(join(bin, "powershell.exe"), fakePowershell);
  writeFileSync(join(bin, "taskkill"), fakeTaskkill);
  for (const name of forbidden) writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 1\n`);
  for (const name of readdirSync(bin)) chmodSync(join(bin, name), 0o755);
  const { KIT_BG_SCOPE: _scope, KIT_BG_LOCK: _lock, ...base } = kitEnv();
  const env: NodeJS.ProcessEnv = { ...base, KIT_ROOT: root, KIT_BG_PLATFORM: "win32", KIT_GO_WAIT_MS: "300", FAKE_WIN_LOG: log, PATH: `${bin}:${process.env.PATH}` };
  const bg = (...args: string[]) => spawnSync(kit, ["bg", ...args], { cwd: root, env, encoding: "utf8" });
  const go = (...args: string[]) => spawnSync(kit, ["go", ...args], { cwd: root, env, encoding: "utf8" });
  t.after(() => {
    const jobs = join(root, ".scratch/kit-jobs");
    if (existsSync(jobs)) for (const name of readdirSync(jobs).filter(name => !name.startsWith("."))) bg("--stop", name);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, env, bg, go, log: () => readFileSync(log, "utf8"), directory: (name: string) => join(root, ".scratch/kit-jobs", name) };
}
async function until(condition: () => boolean, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await delay(20);
  }
}
function live(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch { return false; }
}
const last = (output: ReturnType<typeof spawnSync>) => String(output.stdout).trimEnd().split("\n").at(-1)!;
function ok(output: ReturnType<typeof spawnSync>) {
  assert.equal(output.status, 0, String(output.stderr) + String(output.stdout));
  assert.match(last(output), /^RESULT: ok bg /);
}
const linuxTools = (log: string) => log.split("\n").filter(line => forbidden.some(name => line.startsWith(`${name} `)));
const holdUntil = (file: string) => `const fs = require("fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) { clearInterval(t); console.log("RESULT: ok held job done"); process.exit(4); } }, 20);`;

test("the job platform is this machine's, and KIT_BG_PLATFORM=win32 picks the Windows way by hand", () => {
  assert.equal(kitJobPlatform({}), process.platform);
  assert.equal(kitJobPlatform({ KIT_BG_PLATFORM: "win32" }), "win32");
  assert.equal(kitJobPlatform({ KIT_BG_PLATFORM: "nonsense" }), process.platform);
});

test("the Windows process list reads one Get-CimInstance line per process and skips conhost.exe and anything else", () => {
  assert.deepEqual(kitWinProcessList("﻿4 0 133761234567890123 System\r\n\r\n812 4 133761234567890999 node.exe\r\nWARNING: something\r\n" +
    "813 812 133761234567891000 conhost.exe\r\n814 812 133761234567891000 ConHost.exe\r\n7 4 133761234567890124\r\n 9 812 133761234567891000 Code Helper.exe \r\n"), [
    { pid: 4, ppid: 0, started: "133761234567890123" },
    { pid: 812, ppid: 4, started: "133761234567890999" },
    { pid: 9, ppid: 812, started: "133761234567891000" },
  ]);
  assert.deepEqual(kitWinProcessList(""), []);
});

test("a Windows job's tree walks children by parent pid, never adopting a process older than its parent", () => {
  // File times past 2^53: the start times are compared exactly, as whole numbers.
  const t = (n: number) => String(133761234567890000n + BigInt(n));
  const list = [
    { pid: 100, ppid: 1, started: t(10) },  // the wrapper
    { pid: 200, ppid: 100, started: t(11) }, // its --command process
    { pid: 300, ppid: 200, started: t(12) }, // the job's command
    { pid: 301, ppid: 300, started: t(13) }, // a grandchild
    { pid: 400, ppid: 100, started: t(5) },  // older than the wrapper: a reused parent pid, not the job's
    { pid: 500, ppid: 7, started: t(1) },    // another process
  ];
  const pids = (found: { pid: number }[]) => found.map(entry => entry.pid);
  assert.deepEqual(pids(kitJobTree(list, [{ pid: 100, started: t(10) }])), [100, 200, 300, 301]);
  // The wrapper has ended: its pinned --command process still holds the job's tree.
  const ended = list.filter(entry => entry.pid !== 100);
  assert.deepEqual(pids(kitJobTree(ended, [{ pid: 100, started: t(10) }, { pid: 200, started: t(11) }])), [200, 300, 301]);
  // The wrapper's pid now belongs to a newer process: its children are not the job's, the old wrapper's are.
  const reused = [...ended, { pid: 100, ppid: 1, started: t(50) }, { pid: 600, ppid: 100, started: t(51) }];
  assert.deepEqual(pids(kitJobTree(reused, [{ pid: 100, started: t(10) }])), [200, 300, 301]);
  // A pinned process whose pid was reused is not the job's.
  assert.deepEqual(pids(kitJobTree([{ pid: 200, ppid: 9, started: t(99) }], [{ pid: 200, started: t(11) }])), []);
  assert.deepEqual(kitJobTree([], [{ pid: 100, started: t(10) }]), []);
});

test("the same-job check pins the start time, and on Linux also the job's group and session", () => {
  const job = { pgid: 42 };
  assert.equal(kitJobSame({ started: "7", pgid: 42, session: 42 }, job, "7", "linux"), true);
  assert.equal(kitJobSame({ started: "7", pgid: 43, session: 42 }, job, "7", "linux"), false);
  assert.equal(kitJobSame({ started: "7", pgid: 42, session: 43 }, job, "7", "linux"), false);
  assert.equal(kitJobSame({ started: "8", pgid: 42, session: 42 }, job, "7", "linux"), false);
  assert.equal(kitJobSame({ started: "7", ppid: 1 }, { pgid: undefined }, "7", "win32"), true);
  assert.equal(kitJobSame({ started: "8", ppid: 1 }, { pgid: undefined }, "7", "win32"), false);
  assert.equal(kitJobSame(null, job, "7", "linux"), false);
});

test("a Windows job's records are its pid and a JSON identity with its start time, and nothing else passes", t => {
  const directory = mkdtempSync(join(tmpdir(), "kit-bg-win-records-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const saved = process.env.KIT_BG_PLATFORM;
  process.env.KIT_BG_PLATFORM = "win32";
  t.after(() => { if (saved === undefined) delete process.env.KIT_BG_PLATFORM; else process.env.KIT_BG_PLATFORM = saved; });
  writeFileSync(join(directory, "pid"), "4321\n");
  writeFileSync(join(directory, "identity"), JSON.stringify({ pid: 4321, started: "133761234567890123" }));
  assert.deepEqual(kitJob(directory), { directory, pid: 4321, started: "133761234567890123" });
  for (const identity of [JSON.stringify({ pid: 99, started: "1" }), JSON.stringify({ pid: 4321, started: "soon" }), "4321 (node) S 1 4321 4321", ""]) {
    writeFileSync(join(directory, "identity"), identity);
    assert.throws(() => kitJob(directory), /missing or invalid job records/);
  }
});

test("bg on Windows starts the job detached without setsid, systemd or flock, records it, lists it, and keeps its exit code", async t => {
  const f = fixture(t);
  const release = join(f.root, "release");
  const output = f.bg("win-a", "--", process.execPath, "-e", `console.log("hello from the job"); ${holdUntil(release)}`);
  ok(output);
  assert.match(output.stdout, /^note: no user systemd; this job ends with the session$/m);
  const directory = f.directory("win-a");
  const pid = Number(readFileSync(join(directory, "pid"), "utf8"));
  assert.ok(live(pid));
  const identity = JSON.parse(readFileSync(join(directory, "identity"), "utf8"));
  assert.equal(identity.pid, pid);
  assert.match(identity.started, /^\d+$/);
  assert.equal(existsSync(join(directory, "pgid")), false);
  assert.match(f.bg("--list").stdout, /^win-a\trunning\t/m);
  writeFileSync(release, "");
  await until(() => existsSync(join(directory, "exit")));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "4");
  assert.ok(existsSync(join(directory, "ended")));
  assert.match(readFileSync(join(directory, "log"), "utf8"), /hello from the job/);
  assert.match(f.bg("--list").stdout, /^win-a\texit 4\t/m);
  assert.deepEqual(linuxTools(f.log()), []);
  assert.match(f.log(), /^powershell Get-CimInstance Win32_Process/m);
  assert.deepEqual(readdirSync(join(f.root, ".scratch/kit-jobs")).filter(name => name.endsWith(".lock")), [], "the file lock is the lock on Windows");
});

test("bg stop on Windows ends the whole process tree at once with taskkill and records exit 143", async t => {
  const f = fixture(t);
  const ready = join(f.root, "descendant");
  const leaf = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}, process.argv[1]], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  ok(f.bg("win-stop", "--", process.execPath, "-e", parent, ready));
  await until(() => existsSync(ready));
  const descendant = Number(readFileSync(ready, "utf8"));
  t.after(() => { if (live(descendant)) process.kill(descendant, "SIGKILL"); });
  const directory = f.directory("win-stop");
  const pid = Number(readFileSync(join(directory, "pid"), "utf8"));
  const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => sibling.kill("SIGKILL"));
  const output = f.bg("--stop", "win-stop");
  ok(output);
  assert.match(output.stdout, new RegExp(`^win-stop: stopped pid ${pid} \\(taskkill /T /F\\)$`, "m"));
  assert.match(f.log(), new RegExp(`^taskkill /PID ${pid} .*/T /F$`, "m"));
  assert.ok(!live(pid) && !live(descendant));
  assert.ok(live(sibling.pid!));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "143");
  assert.ok(existsSync(join(directory, "ended")));
  assert.match(f.bg("--list").stdout, /^win-stop\texit 143\t/m);
  const again = f.bg("--stop", "win-stop");
  ok(again);
  assert.match(again.stdout, /win-stop: not running/);
  assert.deepEqual(linuxTools(f.log()), []);
});

test("go on Windows says RUNNING while the job runs, then ends with its RESULT line and code", async t => {
  const f = fixture(t);
  const release = join(f.root, "release");
  const started = f.go("win-go", "--", process.execPath, "-e", `console.log("step: building"); ${holdUntil(release)}`);
  assert.equal(started.status, 75, started.stdout + started.stderr);
  assert.match(last(started), /^RUNNING: win-go \(\d+s, step step: building\)\. Run again: scripts\/agents\/kit go win-go$/);
  writeFileSync(release, "");
  let done = f.go("win-go");
  for (let i = 0; i < 40 && done.status === 75; i++) done = f.go("win-go");
  assert.equal(done.status, 4, done.stdout);
  assert.equal(last(done), "RESULT: fail go win-go exit 4 after its RESULT line said ok; see " + join(f.directory("win-go"), "log"));
  assert.deepEqual(linuxTools(f.log()), []);
});

test("go on Windows: --max is a timer in the job's wrapper that ends its tree and names the time limit", async t => {
  const f = fixture(t);
  const never = join(f.root, "never");
  const started = f.go("win-max", "--max", "1", "--", process.execPath, "-e", holdUntil(never));
  assert.equal(started.status, 75, started.stdout + started.stderr);
  let done = f.go("win-max");
  for (let i = 0; i < 40 && done.status === 75; i++) done = f.go("win-max");
  assert.equal(done.status, 143, done.stdout);
  assert.match(last(done), /^RESULT: fail go win-max exit 143: the time limit \(1s\) ended this job; see /);
  assert.equal(readFileSync(join(f.directory("win-max"), "exit"), "utf8").trim(), "143");
  assert.match(f.log(), /^taskkill \/PID \d+ \/T \/F$/m);
  assert.deepEqual(linuxTools(f.log()), []);
});
