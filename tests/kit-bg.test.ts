import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";

const kit = resolve("scripts/agents/kit");
const script = resolve("scripts/agents/kit.d/bg");
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-bg-"));
  const env = { ...process.env, KIT_ROOT: root, KIT_WAIT_POLL_MS: "10" };
  const run = (...args: string[]) => spawnSync(kit, ["bg", ...args], { env, encoding: "utf8" });
  t.after(() => {
    const jobs = join(root, ".scratch/kit-jobs");
    if (existsSync(jobs)) for (const name of readdirSync(jobs).filter(name => !name.startsWith("."))) run("--stop", name);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, env, run, directory: (name: string) => join(root, ".scratch/kit-jobs", name) };
}
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition timed out");
    await delay(10);
  }
}
function live(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch { return false; }
}
function ok(output: ReturnType<typeof spawnSync>) {
  assert.equal(output.status, 0, String(output.stderr) + String(output.stdout));
  assert.match(String(output.stdout).trimEnd().split("\n").at(-1)!, /^RESULT: ok bg /);
}
const held = 'const fs = require("fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(0); } }, 10);';

test("bg help, discovery, invalid usage and empty list", t => {
  const f = fixture(t);
  assert.equal(readFileSync(script, "utf8").split("\n")[1], "// kit: start, list or stop detached jobs by name");
  const help = f.run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: kit bg/);
  assert.doesNotMatch(help.stdout, /RESULT:/);
  assert.match(spawnSync(kit, ["--help"], { encoding: "utf8" }).stdout, /bg\s+start, list or stop detached jobs by name/);
  ok(f.run("--list"));
  for (const args of [[], ["../escape", "--", "true"], ["Upper", "--", "true"], ["-bad", "--", "true"], ["ok", "--"], ["ok", "true"], ["--stop"], ["--list", "extra"], ["ok", "--cwd", "/missing/cwd", "--", "true"]]) {
    const output = f.run(...args);
    assert.equal(output.status, 1, output.stdout);
    assert.match(output.stdout, /RESULT: fail /);
  }
});

test("bg records metadata, isolates the process group, redirects stdin, and preserves argv and cwd", async t => {
  const f = fixture(t);
  const cwd = join(f.root, "cwd with 'quotes' and $dollar");
  mkdirSync(cwd);
  const ready = join(f.root, "ready");
  const release = join(f.root, "release");
  const argument = "spaces 'quotes' $dollar `tick`";
  const code = `const fs = require('fs'); console.log('stdout', process.argv[2]); console.error('stderr'); fs.writeFileSync(process.argv[1], JSON.stringify({pid:process.pid, cwd:process.cwd(), stdin:fs.readlinkSync('/proc/self/fd/0')})); const timer = setInterval(() => { if (fs.existsSync(process.argv[3])) clearInterval(timer); }, 10);`;
  const output = f.run("record-1", "--cwd", cwd, "--", process.execPath, "-e", code, ready, argument, release);
  ok(output);
  await until(() => existsSync(ready));
  const dir = f.directory("record-1");
  for (const name of ["pid", "pgid", "command", "cwd", "started", "log"]) assert.ok(existsSync(join(dir, name)), name);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
  assert.equal(readFileSync(join(dir, "pgid"), "utf8").trim(), String(pid));
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
  assert.equal(fields[2], String(pid));
  assert.equal(fields[3], String(pid));
  const info: { pid: number; cwd: string; stdin: string } = JSON.parse(readFileSync(ready, "utf8"));
  assert.equal(info.cwd, cwd);
  assert.equal(info.stdin, "/dev/null");
  assert.equal(readlinkSync(`/proc/${info.pid}/fd/0`), "/dev/null");
  assert.equal(readFileSync(join(dir, "cwd"), "utf8"), `${cwd}\n`);
  assert.match(readFileSync(join(dir, "started"), "utf8"), /^\d{4}-\d\d-\d\dT.*Z\n$/);
  assert.match(readFileSync(join(dir, "command"), "utf8"), /spaces/);
  const log = readFileSync(join(dir, "log"), "utf8");
  assert.ok(log.includes(`stdout ${argument}`));
  assert.ok(log.includes("stderr"));
  assert.match(output.stdout, new RegExp(`RESULT: ok bg record-1 pid ${pid}\\n$`));
  const duplicate = f.run("record-1", "--", "false");
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stdout, /already running/);
  assert.equal(readFileSync(join(dir, "log"), "utf8"), log);
  writeFileSync(release, "");
  await until(() => existsSync(join(dir, "exit")) && !live(pid));
  assert.equal(readFileSync(join(dir, "exit"), "utf8"), "0\n");
  assert.match(readFileSync(join(dir, "ended"), "utf8"), /Z\n$/);
  writeFileSync(join(dir, "obsolete"), "old record");
  ok(f.run("record-1", "--", "true"));
  assert.equal(existsSync(join(dir, "obsolete")), false);
});

test("bg list distinguishes running, exit N, and died", async t => {
  const f = fixture(t);
  ok(f.run("running", "--", process.execPath, "-e", held, join(f.root, "release")));
  ok(f.run("finished", "--", "/bin/sh", "-c", "exit 3"));
  ok(f.run("died", "--", process.execPath, "-e", held, join(f.root, "release")));
  const dead = Number(readFileSync(join(f.directory("died"), "pid"), "utf8"));
  process.kill(-dead, "SIGKILL");
  await until(() => !live(dead) && existsSync(join(f.directory("finished"), "exit")));
  const output = f.run("--list");
  ok(output);
  for (const [name, state] of [["running", "running"], ["finished", "exit 3"], ["died", "died"]])
    assert.ok(output.stdout.includes(`${name}\t${state}\t`), output.stdout);
  assert.match(output.stdout, /\t\d+s\t.*\/log/);
});

test("bg stop escalates for a TERM-resistant descendant and preserves a sibling", async t => {
  const f = fixture(t);
  const sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => sibling.kill("SIGKILL"));
  const ready = join(f.root, "descendant");
  const leaf = 'process.on("SIGTERM", () => {}); require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);';
  const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(leaf)}, process.argv[1]], {stdio:'ignore'}); setInterval(() => {}, 1000);`;
  ok(f.run("stop", "--", process.execPath, "-e", parent, ready));
  await until(() => existsSync(ready));
  const descendant = Number(readFileSync(ready, "utf8"));
  t.after(() => { if (live(descendant)) process.kill(descendant, "SIGKILL"); });
  const pid = Number(readFileSync(join(f.directory("stop"), "pid"), "utf8"));
  const output = f.run("--stop", "stop");
  ok(output);
  assert.match(output.stdout, /SIGTERM, SIGKILL/);
  await until(() => !live(pid) && !live(descendant));
  assert.ok(live(sibling.pid!));
  ok(f.run("--stop", "stop"));
});

test("bg survives its launching shell exiting and a simulated restart", async t => {
  const f = fixture(t);
  const output = spawnSync("/bin/bash", ["-c", '"$1" bg survivor -- "$2" -e "$3" "$4"; exit $?', "parent", kit, process.execPath, held, join(f.root, "release")], { env: f.env, encoding: "utf8" });
  ok(output);
  const pid = Number(readFileSync(join(f.directory("survivor"), "pid"), "utf8"));
  assert.ok(live(pid));
  assert.match(f.run("--list").stdout, /survivor\trunning/);
  writeFileSync(join(f.root, "release"), "");
  const waited = spawnSync(kit, ["wait", "job", "survivor", "--timeout", "5s"], { env: f.env, encoding: "utf8" });
  assert.equal(waited.status, 0, waited.stdout + waited.stderr);
});

test("bg concurrent starts reserve a name once", async t => {
  const f = fixture(t);
  const launch = () => new Promise<number | null>((resolve, reject) => {
    const child = spawn(kit, ["bg", "race", "--", process.execPath, "-e", held, join(f.root, "release")], { env: f.env, stdio: "ignore" });
    child.on("error", reject).on("close", resolve);
  });
  assert.deepEqual((await Promise.all([launch(), launch()])).sort(), [0, 1]);
});

test("bg stop refuses invalid process identities without signalling another group", async t => {
  const f = fixture(t);
  ok(f.run("identity", "--", process.execPath, "-e", held, join(f.root, "release")));
  const dir = f.directory("identity");
  const file = join(dir, "identity");
  const original = readFileSync(file, "utf8");
  const fields = original.trim().split(" ");
  fields[21] = "0"; // Linux starttime, preserving valid pgid/session records.
  writeFileSync(file, fields.join(" "));
  try {
    assert.match(f.run("--stop", "identity").stdout, /not running/);
    assert.ok(live(Number(readFileSync(join(dir, "pid"), "utf8"))));
  } finally { writeFileSync(file, original); }
});
