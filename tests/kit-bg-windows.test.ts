// kit bg and kit go the Windows way (no setsid, process groups, /proc or systemd), run on Linux: KIT_BG_PLATFORM=win32
// picks that way, and a fake powershell.exe (the Get-CimInstance Win32_Process list, read from /proc) and a fake
// taskkill (/PID … /T /F, the process tree by parent pid) stand in for the two Windows tools it calls; a fake bash.exe
// (Linux's bash, so the kit's own handover script really runs) and a fake cmd.exe (cmd's reading of its line, below)
// stand in for the two a job's .cmd or shell script goes through.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { kitJob, kitJobExit, kitJobPlatform, kitJobSame, kitJobTree, kitWinBash, kitWinLaunch, kitWinProcessList } from "../kit-lib.mjs";
import { kitEnv } from "./support/kit-env.ts";

const kit = resolve("kit");

const fakePowershell = `#!${process.execPath}
const fs = require("fs");
const script = process.argv.at(-1);
fs.appendFileSync(process.env.FAKE_WIN_LOG, "powershell " + script + "\\n");
if (fs.existsSync(process.env.FAKE_WIN_LOG + ".broken")) { console.error("Get-CimInstance : The RPC server is unavailable."); process.exit(1); }
if (!script.startsWith("Get-CimInstance Win32_Process") || !script.includes("$_.CreationDate.ToFileTimeUtc(), $_.Name")) process.exit(2);
const only = /-Filter 'ProcessId=(\\d+)'/.exec(script)?.[1];
// A job's command (not kit bg's own processes) whose command line holds this marker cannot be looked up on its own.
try { const line = only ? fs.readFileSync("/proc/" + only + "/cmdline", "utf8") : "";
  if (line.includes("fail-pin-marker") && !line.includes("--wrapper") && !line.includes("--command")) { console.error("Get-CimInstance : Access denied."); process.exit(1); } } catch {}
const lines = [];
for (const pid of only ? [only] : fs.readdirSync("/proc").filter(name => /^\\d+$/.test(name))) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Windows lists no zombies.
    // The program's file name, as Win32_Process's Name (Node renames its main thread, so the stat name is no help).
    let name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
    try { name = require("path").basename(fs.readlinkSync("/proc/" + pid + "/exe")); } catch {}
    if (["Z", "X"].includes(fields[0])) continue;
    lines.push(pid + " " + fields[1] + " " + fields[19] + " " + name);
    // Windows starts a hidden console host as a child of each console process: a made-up one for each node.
    if (!only && process.env.FAKE_CONHOST && name === "node") {
      lines.push((Number(pid) + 4000000) + " " + pid + " " + fields[19] + " conhost.exe");
      fs.appendFileSync(process.env.FAKE_WIN_LOG, "conhost added under " + pid + "\\n");
    }
  } catch {}
}
process.stdout.write(lines.map(line => line + "\\r\\n").join(""));
`;
const fakeTaskkill = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WIN_LOG, "taskkill " + args.join(" ") + "\\n");
// One failed taskkill on request: it kills nothing.
if (fs.existsSync(process.env.FAKE_WIN_LOG + ".taskkill-fails")) { fs.rmSync(process.env.FAKE_WIN_LOG + ".taskkill-fails"); console.error("ERROR: Access is denied."); process.exit(1); }
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
// How cmd.exe /d /s /c "<line>" reads its line, and how the program it starts splits the rest into words: /s takes off
// the outer quotes; each pass expands %name% (an unknown name stays as it is) and takes off the carets, a quote starts
// or ends a quoted part, and an operator (& | < > ( )) outside one fails, as it would split the command there; the
// first word ends at a space no caret escaped, and the program splits the rest the Windows C runtime way. With
// `twice`, the rest passes through cmd once more, as an npm shim's %* does. Plain JavaScript: the fake cmd.exe runs it.
const cmdReading = String.raw`function cmdRun(line, env, twice) {
  if (line[0] !== '"' || line[line.length - 1] !== '"') throw new Error("the line is not in quotes: " + line);
  function percent(text) {
    var out = "", i = 0;
    while (i < text.length) {
      var j = text.indexOf("%", i), k = j < 0 ? -1 : text.indexOf("%", j + 1);
      if (k < 0) { out += text.slice(i); break; }
      var name = text.slice(j + 1, k);
      if (name && Object.prototype.hasOwnProperty.call(env, name)) { out += text.slice(i, j) + env[name]; i = k + 1; }
      else { out += text.slice(i, k); i = k; }
    }
    return out;
  }
  function pass(text) {
    var out = [], quoted = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (quoted) { out.push([c, true]); if (c === '"') quoted = false; }
      else if (c === "^") { i++; if (i < text.length) out.push([text[i], true]); }
      else if (c === '"') { quoted = true; out.push([c, false]); }
      else if ("&|<>()".indexOf(c) >= 0) throw new Error("an operator " + c + " reaches cmd: " + text);
      else out.push([c, false]);
    }
    return out;
  }
  function text(chars) { return chars.map(function (entry) { return entry[0]; }).join(""); }
  function words(s) {
    var out = [], word = null, quoted = false, i = 0;
    while (i < s.length) {
      var c = s[i];
      if (!quoted && (c === " " || c === "\t")) { if (word !== null) out.push(word); word = null; i++; continue; }
      if (word === null) word = "";
      if (c === "\\") {
        var n = 0;
        while (s[i] === "\\") { n++; i++; }
        if (s[i] === '"') { word += "\\".repeat(n >> 1); if (n % 2) { word += '"'; i++; } }
        else word += "\\".repeat(n);
      } else if (c === '"') {
        if (quoted && s[i + 1] === '"') { word += '"'; i += 2; } else { quoted = !quoted; i++; }
      } else { word += c; i++; }
    }
    if (word !== null) out.push(word);
    return out;
  }
  var chars = pass(percent(line.slice(1, -1)));
  var end = 0;
  while (end < chars.length && !(chars[end][0] === " " && !chars[end][1])) end++;
  var rest = text(chars.slice(end + 1));
  if (twice) rest = text(pass(percent(rest)));
  return [text(chars.slice(0, end))].concat(words(rest));
}`;
const cmdRun = new Function(`${cmdReading}; return cmdRun;`)() as (line: string, env: Record<string, string>, twice?: boolean) => string[];
// The fake cmd.exe writes the words its line gives into win.log.cmd (one JSON list per run) and ends like a job.
const fakeCmd = `#!${process.execPath}
const fs = require("fs");
${cmdReading}
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_WIN_LOG, "cmd.exe " + args.slice(0, 3).join(" ") + "\\n");
if (args.length !== 4 || args.slice(0, 3).join(" ") !== "/d /s /c") process.exit(2);
fs.appendFileSync(process.env.FAKE_WIN_LOG + ".cmd", JSON.stringify(cmdRun(args[3], process.env)) + "\\n");
console.log("RESULT: ok cmd job");
process.exit(Number(process.env.FAKE_CMD_EXIT ?? 0));
`;
const fakeBash = (log: string) => `#!/bin/sh\necho "bash.exe $1" >> "${log}"\nexec bash "$@"\n`;
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
  writeFileSync(join(bin, "bash.exe"), fakeBash(log));
  writeFileSync(join(bin, "cmd.exe"), fakeCmd);
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
  // A pinned process that has ended passes nothing on: its children cannot be told from those of a later holder of
  // its pid that has ended too, so only live pins hold the tree.
  assert.deepEqual(pids(kitJobTree(ended, [{ pid: 100, started: t(10) }])), []);
  const reused = [...ended, { pid: 100, ppid: 1, started: t(50) }, { pid: 600, ppid: 100, started: t(51) }];
  assert.deepEqual(pids(kitJobTree(reused, [{ pid: 100, started: t(10) }])), []);
  const gone = [...ended, { pid: 700, ppid: 100, started: t(60) }]; // a child of a later, ended holder of pid 100
  assert.deepEqual(pids(kitJobTree(gone, [{ pid: 100, started: t(10) }, { pid: 200, started: t(11) }])), [200, 300, 301]);
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

test("a Windows job ends on its own although each of its node processes has a console host child", async t => {
  const f = fixture(t);
  f.env.FAKE_CONHOST = "1";
  const release = join(f.root, "release");
  ok(f.bg("win-conhost", "--", process.execPath, "-e", holdUntil(release)));
  writeFileSync(release, "");
  await until(() => existsSync(join(f.directory("win-conhost"), "exit")));
  assert.equal(readFileSync(join(f.directory("win-conhost"), "exit"), "utf8").trim(), "4");
  const wrapper = readFileSync(join(f.directory("win-conhost"), "pid"), "utf8").trim();
  assert.match(f.log(), new RegExp(`^conhost added under ${wrapper}$`, "m"), "the fake list gave the job's wrapper a console host");
  assert.ok(existsSync(join(f.directory("win-conhost"), "ended")));
});

test("bg stop on Windows ends a job whose wrapper died while its command runs, and kills only the top of its tree", async t => {
  const f = fixture(t);
  const ready = join(f.root, "descendant");
  const leaf = 'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  const parent = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}, process.argv[1]], { stdio: "ignore" }); setInterval(() => {}, 1000);`;
  ok(f.bg("win-orphan", "--", process.execPath, "-e", parent, ready));
  await until(() => existsSync(ready));
  const descendant = Number(readFileSync(ready, "utf8"));
  t.after(() => { if (live(descendant)) process.kill(descendant, "SIGKILL"); });
  const directory = f.directory("win-orphan");
  const pid = Number(readFileSync(join(directory, "pid"), "utf8"));
  const command = JSON.parse(readFileSync(join(directory, "members"), "utf8")).members[0].pid;
  process.kill(pid, "SIGKILL");
  await until(() => !live(pid));
  assert.match(f.bg("--list").stdout, /^win-orphan\trunning\t/m);
  const output = f.bg("--stop", "win-orphan");
  ok(output);
  assert.match(f.log(), new RegExp(`^taskkill /PID ${command} /T /F$`, "m"), "only the top of the tree, the pinned command process, goes to taskkill");
  assert.ok(!live(command) && !live(descendant));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "143");
});

test("a Windows process list that cannot be read never makes a job look ended", async t => {
  const f = fixture(t);
  const never = join(f.root, "never");
  const ready = join(f.root, "ready");
  ok(f.bg("win-broken", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready)}, ""); ${holdUntil(never)}`));
  const directory = f.directory("win-broken");
  await until(() => existsSync(ready));
  writeFileSync(join(f.root, "win.log.broken"), "");
  const list = f.bg("--list");
  assert.match(list.stdout, /^win-broken\tunknown \(cannot read the process list .*The RPC server is unavailable\.\)\t/m);
  const go = f.go("win-broken");
  assert.equal(go.status, 1, go.stdout);
  assert.match(last(go), /^RESULT: fail go cannot read the process list /);
  const stop = f.bg("--stop", "win-broken");
  assert.equal(stop.status, 1, stop.stdout);
  assert.match(last(stop), /^RESULT: fail cannot read the process list /);
  assert.equal(existsSync(join(directory, "exit")), false);
  rmSync(join(f.root, "win.log.broken"));
  assert.match(f.bg("--list").stdout, /^win-broken\trunning\t/m);
});

test("a Windows job whose process list fails for a moment while it waits for leftovers still records its own status", async t => {
  const f = fixture(t);
  const broken = join(f.root, "win.log.broken");
  // The job breaks the list as it ends and a leftover child mends it a few seconds later.
  const leftover = `setTimeout(() => require("fs").rmSync(${JSON.stringify(broken)}, { force: true }), 2500);`;
  const code = `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leftover)}], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(broken)}, ""); process.exit(5);`;
  ok(f.bg("win-flaky", "--", process.execPath, "-e", code));
  const directory = f.directory("win-flaky");
  await until(() => existsSync(join(directory, "exit")), 20000);
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "5");
  const log = readFileSync(join(directory, "log"), "utf8");
  assert.match(log, /^kit bg: cannot read the process list .*; looking again$/m);
  assert.doesNotMatch(log, /gave up/);
});

test("a Windows job whose process list keeps failing while it waits for leftovers gives up after ten tries with its own status", async t => {
  const f = fixture(t);
  const broken = join(f.root, "win.log.broken");
  t.after(() => rmSync(broken, { force: true }));
  const leftover = join(f.root, "leftover");
  const code = `const child = require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" }); require("fs").writeFileSync(${JSON.stringify(leftover)}, String(child.pid)); require("fs").writeFileSync(${JSON.stringify(broken)}, String(Date.now())); process.exit(6);`;
  ok(f.bg("win-gives-up", "--", process.execPath, "-e", code));
  const directory = f.directory("win-gives-up");
  try { await until(() => existsSync(join(directory, "exit")), 40000); }
  finally { try { process.kill(Number(readFileSync(leftover, "utf8")), "SIGKILL"); } catch { /* It has ended. */ } }
  // Ten looks a second apart: the give-up comes at least nine seconds after the list broke.
  assert.ok(Date.now() - Number(readFileSync(broken, "utf8")) >= 9000, "the wrapper gave up before ten tries");
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "6");
  assert.ok(existsSync(join(directory, "ended")));
  assert.match(readFileSync(join(directory, "log"), "utf8"), /^kit bg: gave up waiting for the job's leftover processes after 10 failed process lists$/m);
});

test("a Windows job's exit record keeps a Windows exit status above 255; Linux still refuses one", t => {
  const directory = mkdtempSync(join(tmpdir(), "kit-bg-win-exit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const saved = process.env.KIT_BG_PLATFORM;
  t.after(() => { if (saved === undefined) delete process.env.KIT_BG_PLATFORM; else process.env.KIT_BG_PLATFORM = saved; });
  const job = { directory, pid: 4321, started: "1" };
  writeFileSync(join(directory, "exit"), "3221225477\n");
  process.env.KIT_BG_PLATFORM = "win32";
  assert.equal(kitJobExit(job), 3221225477);
  writeFileSync(join(directory, "exit"), "4294967296\n");
  assert.throws(() => kitJobExit(job), /invalid job exit status/);
  if (process.platform !== "win32") {
    delete process.env.KIT_BG_PLATFORM;
    writeFileSync(join(directory, "exit"), "300\n");
    assert.throws(() => kitJobExit(job), /invalid job exit status/);
  }
});

// On real Windows Node's job object ends the work with its command process; these cover a work that broke away.
test("a Windows job whose command process died alone is still waited for, and its time limit still ends the work", async t => {
  const f = fixture(t);
  const ready = join(f.root, "ready");
  const never = join(f.root, "never");
  ok(f.bg("win-lost", "--max", "8", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); ${holdUntil(never)}`));
  await until(() => existsSync(ready));
  const work = Number(readFileSync(ready, "utf8"));
  t.after(() => { if (live(work)) process.kill(work, "SIGKILL"); });
  const directory = f.directory("win-lost");
  await until(() => existsSync(join(directory, "work")));
  assert.equal(JSON.parse(readFileSync(join(directory, "work"), "utf8")).pid, work);
  const command = JSON.parse(readFileSync(join(directory, "members"), "utf8")).members[0].pid;
  process.kill(command, "SIGKILL");
  await until(() => !live(command));
  await delay(1500);
  assert.ok(live(work));
  assert.equal(existsSync(join(directory, "exit")), false, "the wrapper must not record an end while the work runs");
  assert.match(f.bg("--list").stdout, /^win-lost\trunning\t/m);
  await until(() => existsSync(join(directory, "exit")), 20000);
  assert.ok(!live(work));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "143");
  assert.match(readFileSync(join(directory, "log"), "utf8"), /^kit bg: the time limit \(8s\) ended this job$/m);
});

test("a Windows job whose command cannot be pinned keeps its own exit status and says so in its log", async t => {
  const f = fixture(t);
  ok(f.bg("win-pin-fail", "--", process.execPath, "-e", 'setTimeout(() => { console.log("RESULT: ok pinned or not"); process.exit(0); }, 1500)', "fail-pin-marker"));
  const directory = f.directory("win-pin-fail");
  await until(() => existsSync(join(directory, "exit")), 20000);
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "0");
  assert.equal(existsSync(join(directory, "work")), false);
  assert.match(readFileSync(join(directory, "log"), "utf8"), /^kit bg: could not pin the job's command: cannot read the process list .*Access denied\.$/m);
});

test("a Windows time limit that meets an unreadable process list looks again, never kills by a stale pid, and ends the work", async t => {
  const f = fixture(t);
  const ready = join(f.root, "ready");
  const never = join(f.root, "never");
  const broken = join(f.root, "win.log.broken");
  t.after(() => rmSync(broken, { force: true }));
  ok(f.bg("win-limit-broken", "--max", "6", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); ${holdUntil(never)}`));
  await until(() => existsSync(ready));
  const work = Number(readFileSync(ready, "utf8"));
  t.after(() => { if (live(work)) process.kill(work, "SIGKILL"); });
  const directory = f.directory("win-limit-broken");
  await until(() => existsSync(join(directory, "work")));
  const command = JSON.parse(readFileSync(join(directory, "members"), "utf8")).members[0].pid;
  process.kill(command, "SIGKILL");
  await until(() => !live(command));
  writeFileSync(broken, "");
  const since = Date.parse(readFileSync(join(directory, "started"), "utf8").trim());
  await delay(Math.max(0, since + 8000 - Date.now()));
  assert.ok(live(work), "the limit waits for a list it can read");
  assert.doesNotMatch(f.log(), new RegExp(`^taskkill /PID ${command} `, "m"));
  rmSync(broken);
  await until(() => existsSync(join(directory, "exit")), 15000);
  assert.ok(!live(work));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "143");
  assert.match(f.log(), new RegExp(`^taskkill /PID ${work} /T /F$`, "m"));
});

test("go on Windows gives 1 for a job's own exit code above 255, so a shell never reads it as 75 or 0", async t => {
  const f = fixture(t);
  let done = f.go("win-big", "--", process.execPath, "-e", "process.exit(0)");
  for (let i = 0; i < 40 && done.status === 75; i++) done = f.go("win-big");
  assert.equal(done.status, 0, done.stdout);
  writeFileSync(join(f.directory("win-big"), "exit"), "3221225477\n");
  const big = f.go("win-big");
  assert.equal(big.status, 1, big.stdout);
  assert.match(last(big), /^RESULT: fail go win-big exit 3221225477 \(the job's own code; kit go gives 1 for it\); see /);
});

test("a Windows wrapper whose command process died never gives up on the list while the work runs, so its time limit holds", async t => {
  const f = fixture(t);
  const ready = join(f.root, "ready");
  const never = join(f.root, "never");
  const broken = join(f.root, "win.log.broken");
  t.after(() => rmSync(broken, { force: true }));
  ok(f.bg("win-no-give-up", "--max", "16", "--", process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(ready)}, String(process.pid)); ${holdUntil(never)}`));
  await until(() => existsSync(ready));
  const work = Number(readFileSync(ready, "utf8"));
  t.after(() => { if (live(work)) process.kill(work, "SIGKILL"); });
  const directory = f.directory("win-no-give-up");
  await until(() => existsSync(join(directory, "work")));
  const command = JSON.parse(readFileSync(join(directory, "members"), "utf8")).members[0].pid;
  writeFileSync(broken, "");
  process.kill(command, "SIGKILL");
  await until(() => !live(command));
  await delay(13000);
  assert.ok(live(work));
  assert.equal(existsSync(join(directory, "exit")), false, "the wrapper gave up while the work runs");
  assert.doesNotMatch(readFileSync(join(directory, "log"), "utf8"), /gave up/);
  rmSync(broken);
  await until(() => existsSync(join(directory, "exit")), 20000);
  assert.ok(!live(work));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "143");
});

test("a Windows time limit whose taskkill fails tries again until the job's tree has ended", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "win.log.taskkill-fails"), "");
  const never = join(f.root, "never");
  ok(f.bg("win-kill-again", "--max", "3", "--", process.execPath, "-e", holdUntil(never)));
  const directory = f.directory("win-kill-again");
  await until(() => existsSync(join(directory, "exit")), 20000);
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "143");
  assert.equal(existsSync(join(f.root, "win.log.taskkill-fails")), false, "the first taskkill failed");
  assert.equal(f.log().split("\n").filter(line => line.startsWith("taskkill ")).length, 2);
});

// A made-up Windows layout: a program (MZ), a .cmd, a .bat and shell scripts, in a temporary folder.
function layout(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-win-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); return join(root, path); };
  return { root, file };
}

test("on Windows a job's first word picks how it starts: a program itself, a .cmd or .bat through cmd.exe, a shell script through Git Bash", t => {
  const { root, file } = layout(t);
  const bash = file("git/bin/bash.exe", "MZ");
  const env = { PATH: [join(root, "tools"), join(root, "git/bin")].join(":") };
  file("tools/tool.exe", "MZ\x90\x00");
  file("tools/npm", "#!/bin/sh\nexec node npm-cli.js \"$@\"\n");
  file("tools/npm.cmd", "@echo off\r\n");
  file("tools/noext", "MZ\x90\x00");
  const launch = (...command: string[]) => kitWinLaunch(command, { cwd: root, env });
  // Programs, and a word not found, start as given (Node finds them).
  for (const command of [["tool", "a"], ["tool.exe", "a"], ["noext", "a"], [process.execPath, "-e", "1"], ["missing-tool", "a"]])
    assert.deepEqual(launch(...command), { program: command[0], args: command.slice(1), options: {} });
  // In one PATH folder the .cmd comes before the bare script, as Windows looks.
  const npm = launch("npm", "install");
  assert.equal(npm.program, "cmd.exe");
  assert.deepEqual(npm.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.deepEqual(npm.options, { windowsVerbatimArguments: true });
  assert.deepEqual(cmdRun(npm.args[3], {}), [join(root, "tools/npm.cmd"), "install"]);
  file("run.bat", "@echo off\r\n");
  assert.deepEqual(cmdRun(launch("./run.bat", "x").args[3], {}), [join(root, "run.bat"), "x"]);
  assert.equal(kitWinLaunch(["./run.bat"], { cwd: root, env: { ...env, ComSpec: "C:\\Windows\\system32\\cmd.exe" } }).program, "C:\\Windows\\system32\\cmd.exe");
  // A script with a #! line runs by exec (Git Bash follows the line); one without, as a bash script; its words in the environment.
  file("scripts/agents/kit", "#!/usr/bin/env bash\necho hi\n");
  const kit = launch("scripts/agents/kit", "go", "two words");
  assert.equal(kit.program, bash);
  assert.equal(kit.args.length, 2);
  assert.equal(kit.args[0], "-c");
  assert.match(kit.args[1], / exec "\$\{kit_words\[@\]\}"$/);
  const handed = kit.options.env as NodeJS.ProcessEnv;
  assert.deepEqual([handed.KIT_BG_ARGC, handed.KIT_BG_ARG_0, handed.KIT_BG_ARG_1, handed.KIT_BG_ARG_2, handed.KIT_BG_ARG_3], ["3", join(root, "scripts/agents/kit"), "go", "two words", undefined]);
  assert.equal(handed.PATH, env.PATH);
  file("plain.sh", "echo hi\n");
  assert.match(launch(join(root, "plain.sh")).args[1], / exec "\$BASH" "\$\{kit_words\[@\]\}"$/);
  // A Windows path reaches Git Bash with forward slashes (on Linux a backslash is part of the file's name).
  file("sub\\job", "#!/bin/sh\n");
  assert.equal((launch("sub\\job").options.env as NodeJS.ProcessEnv).KIT_BG_ARG_0, `${root}/sub/job`);
});

test("Git Bash is found on PATH, beside git.exe or where Git for Windows installs it, never WSL's bash.exe", t => {
  const { root, file } = layout(t);
  const windowsFolder = join(root, "Windows");
  file("Windows/System32/bash.exe", "MZ");
  file("Users/lex/AppData/Local/Microsoft/WindowsApps/bash.exe", "MZ");
  const wslPath = [join(windowsFolder, "System32"), join(root, "Users/lex/AppData/Local/Microsoft/WindowsApps")].join(":");
  assert.equal(kitWinBash({ PATH: wslPath, SystemRoot: windowsFolder }), null);
  const git = file("Git/cmd/git.exe", "MZ");
  const besideGit = file("Git/bin/bash.exe", "MZ");
  assert.equal(kitWinBash({ PATH: `${wslPath}:${join(git, "..")}`, SystemRoot: windowsFolder }), besideGit);
  const programFiles = file("Program Files/Git/bin/bash.exe", "MZ");
  assert.equal(kitWinBash({ PATH: wslPath, SystemRoot: windowsFolder, ProgramFiles: join(root, "Program Files") }), programFiles);
  const local = file("Local/Programs/Git/bin/bash.exe", "MZ");
  assert.equal(kitWinBash({ PATH: "", LOCALAPPDATA: join(root, "Local") }), local);
  const onPath = file("msys/usr/bin/bash.exe", "MZ");
  assert.equal(kitWinBash({ PATH: `${join(onPath, "..")}:${join(git, "..")}`, ProgramFiles: join(root, "Program Files") }), onPath);
  // No bash: a shell script job says so plainly; a program still starts.
  file("job.sh", "#!/bin/sh\n");
  assert.throws(() => kitWinLaunch(["./job.sh"], { cwd: root, env: { PATH: wslPath, SystemRoot: windowsFolder } }),
    /job\.sh is a shell script, and Windows runs one only through Git Bash, but no bash\.exe was found .*install Git for Windows/);
  assert.equal(kitWinLaunch([process.execPath], { cwd: root, env: {} }).program, process.execPath);
});

test("a .cmd job's arguments reach its program unchanged, and none reaches cmd as an operator or a variable", t => {
  const { root, file } = layout(t);
  const job = file("my tools & more (x86)/job.cmd", "@echo off\r\n");
  const shim = file("node_modules/.bin/tsx.cmd", "@echo off\r\n");
  const env = { PATH: "", HOME: "C:\\Users\\lex", PATH_: "x" };
  const nasty = ["plain", "two words", 'say "hi"', "a&b|c>d<e", "%HOME%", "100%", "%%", "caret^", "!bang!", "trail\\", 'back\\"slash',
    "", "(x)", "semi;colon,comma=eq", "star*?", "back`tick", "C:\\Program Files\\x\\", "^&^|"];
  const words = (path: string, twice = false) => cmdRun(kitWinLaunch([path, ...nasty], { cwd: root, env }).args[3], env, twice);
  assert.deepEqual(words(job), [job, ...nasty]);
  // An npm shim hands %* to cmd once more: escaped twice, its words still arrive unchanged.
  assert.deepEqual(words(shim, true), [shim, ...nasty]);
  assert.throws(() => kitWinLaunch([job, "line\nbreak"], { cwd: root, env }), /cmd\.exe cannot take an argument with a line break/);
  assert.throws(() => kitWinLaunch([job, "line\rbreak"], { cwd: root, env }), /line break/);
});

test("bg on Windows runs a shell script through Git Bash, its words unchanged and not left in its environment", async t => {
  const f = fixture(t);
  const script = join(f.root, "scripts/job");
  mkdirSync(join(f.root, "scripts"));
  // Git Bash takes a file with a #! line as one it may run; Linux wants the mode bit.
  writeFileSync(script, `#!/bin/sh\nfor word in "$0" "$@"; do printf '[%s]\\n' "$word"; done\nenv | grep -c '^KIT_BG_ARG' || true\nexit 3\n`);
  chmodSync(script, 0o755);
  const words = ["two words", "it's", "*", "$HOME", 'say "hi"', "back\\slash", "", "line\nbreak", "-c", "a&b"];
  ok(f.bg("win-script", "--", "scripts/job", ...words));
  const directory = f.directory("win-script");
  await until(() => existsSync(join(directory, "exit")));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "3");
  assert.equal(readFileSync(join(directory, "log"), "utf8"), [script, ...words].map(word => `[${word}]\n`).join("") + "0\n");
  assert.match(f.log(), /^bash\.exe -c$/m);
  assert.deepEqual(linuxTools(f.log()), []);
});

test("go on Windows runs a shell script without a #! line through Git Bash and ends with its RESULT line", async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "plain"), `[ -n "$BASH_VERSION" ] || exit 9\necho "RESULT: ok plain script $1"\n`);
  let done = f.go("win-plain", "--", "./plain", "word");
  for (let i = 0; i < 40 && done.status === 75; i++) done = f.go("win-plain");
  assert.equal(done.status, 0, done.stdout + done.stderr);
  assert.equal(last(done), "RESULT: ok plain script word");
  assert.match(f.log(), /^bash\.exe -c$/m);
});

test("bg on Windows runs a .cmd job through cmd.exe /d /s /c, its words unchanged, and keeps its exit code", async t => {
  const f = fixture(t);
  const folder = join(f.root, "my tools & more");
  mkdirSync(folder);
  writeFileSync(join(folder, "job.cmd"), "@echo off\r\n");
  const words = ["two words", 'say "hi"', "a&b|c", "%PATH%", "trail\\", ""];
  f.env.FAKE_CMD_EXIT = "5";
  ok(f.bg("win-cmd", "--", join(folder, "job"), ...words));
  const directory = f.directory("win-cmd");
  await until(() => existsSync(join(directory, "exit")));
  assert.equal(readFileSync(join(directory, "exit"), "utf8").trim(), "5");
  assert.deepEqual(readFileSync(join(f.root, "win.log.cmd"), "utf8").trim().split("\n").map(line => JSON.parse(line)), [[join(folder, "job.cmd"), ...words]]);
  assert.match(readFileSync(join(directory, "log"), "utf8"), /RESULT: ok cmd job/);
  assert.match(f.log(), /^cmd\.exe \/d \/s \/c$/m);
});

test("bg and go on Windows refuse a shell script job plainly when Git Bash is missing, and start nothing", t => {
  const f = fixture(t);
  rmSync(join(f.root, ".bin/bash.exe"));
  writeFileSync(join(f.root, "job.sh"), "#!/bin/sh\nexit 0\n");
  const output = f.bg("win-nobash", "--", "./job.sh");
  assert.equal(output.status, 1);
  assert.match(output.stderr, /job\.sh is a shell script, and Windows runs one only through Git Bash, but no bash\.exe was found/);
  assert.match(last(output), /^RESULT: fail .*install Git for Windows or put its bin folder on PATH$/);
  assert.equal(existsSync(f.directory("win-nobash")), false);
  const go = f.go("win-nobash", "--", "./job.sh");
  assert.equal(go.status, 1);
  assert.match(go.stdout + go.stderr, /could not start win-nobash: .*no bash\.exe was found/);
  assert.doesNotMatch(f.log(), /^powershell /m);
});
