import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

const kit = resolve("kit");
// A fake systemd-run: records its options, then runs the command after them (as --scope does, in place).
const fakeSystemdRun = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_SYSTEMD_LOG"
[[ \${FAKE_SYSTEMD_FAIL:-} != 1 ]] || exit 1
while (( $# )); do
  case $1 in --description|-p) shift 2 ;; --*) shift ;; *) break ;; esac
done
exec "$@"
`;
function fixture(t: TestContext, extra: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "kit-go-"));
  const bin = join(root, ".bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemd-run"), fakeSystemdRun);
  chmodSync(join(bin, "systemd-run"), 0o755);
  const { KIT_BG_SCOPE: _scope, ...base } = kitEnv();
  const env = { ...base, KIT_ROOT: root, KIT_GO_WAIT_MS: "400", FAKE_SYSTEMD_LOG: join(root, "systemd.log"), PATH: `${bin}:${process.env.PATH}`, ...extra };
  const run = (...args: string[]) => spawnSync(kit, ["go", ...args], { cwd: root, env, encoding: "utf8" });
  t.after(() => {
    const jobs = join(root, ".scratch/kit-jobs");
    if (existsSync(jobs)) for (const name of readdirSync(jobs).filter(name => !name.startsWith("."))) spawnSync(kit, ["bg", "--stop", name], { env, encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  });
  return { root, env, run };
}
const last = (output: ReturnType<typeof spawnSync>) => String(output.stdout).trimEnd().split("\n").at(-1)!;
// A job that prints a step, holds until a file appears, then prints its RESULT line and exits 3.
const job = (release: string) => [process.execPath, "-e",
  `console.log("slice: build ok"); const fs = require("fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(t); console.log("RESULT: fail job done"); process.exit(3); } }, 10);`];

test("go: starts the job in a scope, says RUNNING with exit 75 while it runs, and ends with its RESULT line and code", t => {
  const f = fixture(t);
  const release = join(f.root, "release");
  const started = f.run("slice-07", "--", ...job(release));
  assert.equal(started.status, 75, started.stdout + started.stderr);
  assert.match(last(started), /^RUNNING: slice-07 \(\d+s, step slice: build ok\)\. Run again: scripts\/agents\/kit go slice-07$/);
  const options = readFileSync(join(f.root, "systemd.log"), "utf8");
  assert.match(options, /--user --scope --quiet --collect --description kit bg slice-07 \(.*\) -p RuntimeMaxSec=21600 setsid nohup/);
  assert.ok(existsSync(join(f.root, ".scratch/kit-jobs/slice-07/go")), "the job is marked as a kit go job");
  // A second call with no command waits on the same job; asking to start it again does not start a second one.
  const again = f.run("slice-07", "--", ...job(release));
  assert.equal(again.status, 75, again.stdout);
  assert.match(again.stdout, /already running/);
  writeFileSync(release, "");
  let done = f.run("slice-07");
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("slice-07");
  assert.equal(done.status, 3, done.stdout);
  assert.equal(last(done), "RESULT: fail job done");
  assert.match(done.stdout, /slice: build ok/);
  // The ended job keeps answering with its RESULT line and code.
  const after = f.run("slice-07");
  assert.equal(after.status, 3);
  assert.equal(last(after), "RESULT: fail job done");
});

test("go: a job with no RESULT line, --max, a missing job, bad usage and help", t => {
  const f = fixture(t);
  const quiet = f.run("quiet", "--max", "0", "--", "true");
  let done = quiet;
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("quiet");
  assert.equal(done.status, 0, done.stdout);
  assert.match(last(done), /^RESULT: ok go quiet exit 0/);
  assert.doesNotMatch(readFileSync(join(f.root, "systemd.log"), "utf8"), /RuntimeMaxSec/);
  const failing = f.run("failing", "--", "false");
  done = failing;
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("failing");
  assert.equal(done.status, 1);
  assert.match(last(done), /^RESULT: fail go failing exit 1 without a RESULT line/);
  const missing = f.run("nothing");
  assert.equal(missing.status, 1);
  assert.match(last(missing), /^RESULT: fail go nothing: no such job in .*\.scratch\/kit-jobs; start it with scripts\/agents\/kit go nothing -- <command>/);
  for (const args of [[], ["Bad"], ["x", "--max", "soon", "--", "true"], ["x", "--"]]) {
    const output = f.run(...args);
    assert.equal(output.status, 1, `${args}: ${output.stdout}`);
    assert.match(last(output), /^RESULT: fail go /);
  }
  const help = f.run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: kit go <job> \[--max D\] -- <command…>/);
  assert.match(help.stdout, /at most 9 minutes/);
});

test("go: a job that fails after printing an ok RESULT line still fails", t => {
  const f = fixture(t);
  let done = f.run("liar", "--", process.execPath, "-e", 'console.log("RESULT: ok all good"); process.exit(143)');
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("liar");
  assert.equal(done.status, 143, done.stdout);
  assert.match(done.stdout, /^job: RESULT: ok all good$/m);
  assert.equal(done.stdout.match(/^RESULT: /gm)!.length, 1);
  assert.match(last(done), /^RESULT: fail go liar exit 143 after its RESULT line said ok/);
});

test("go: a job its scope's time limit stops ends with exit 143 and a fail line", t => {
  const f = fixture(t);
  // This fake systemd-run honours RuntimeMaxSec: it sends TERM to the launched session once the limit passes.
  writeFileSync(join(f.root, ".bin/systemd-run"), `#!/usr/bin/env bash
limit=''
while (( $# )); do
  case $1 in -p) [[ $2 == RuntimeMaxSec=* ]] && limit=\${2#RuntimeMaxSec=}; shift 2 ;; --description) shift 2 ;; --*) shift ;; *) break ;; esac
done
[[ -z $limit ]] || ( sleep "$limit"; kill -TERM -- "-$$" ) > /dev/null 2>&1 &
exec "$@"
`);
  const release = join(f.root, "never");
  let done = f.run("limited", "--max", "1", "--", ...job(release));
  for (let i = 0; i < 30 && done.status === 75; i++) done = f.run("limited");
  assert.equal(done.status, 143, done.stdout);
  assert.match(last(done), /^RESULT: fail go limited exit 143: the time limit \(1s\) ended this job/);
});

test("go: a job that has ended starts afresh, marked again, when given its command", t => {
  const f = fixture(t);
  let done = f.run("again", "--", "true");
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("again");
  assert.equal(done.status, 0, done.stdout);
  const first = readFileSync(join(f.root, ".scratch/kit-jobs/again/pid"), "utf8");
  const release = join(f.root, "release");
  const restarted = f.run("again", "--", ...job(release));
  assert.equal(restarted.status, 75, restarted.stdout);
  assert.notEqual(readFileSync(join(f.root, ".scratch/kit-jobs/again/pid"), "utf8"), first);
  assert.ok(existsSync(join(f.root, ".scratch/kit-jobs/again/go")));
  writeFileSync(release, "");
});

test("go: a job kit bg started is marked when kit go waits for it; a job's own exit 75 comes out as 1", t => {
  const f = fixture(t);
  const release = join(f.root, "release");
  assert.equal(spawnSync(kit, ["bg", "plain-bg", "--", ...job(release)], { cwd: f.root, env: f.env, encoding: "utf8" }).status, 0);
  assert.ok(!existsSync(join(f.root, ".scratch/kit-jobs/plain-bg/go")));
  assert.equal(f.run("plain-bg", "--", ...job(release)).status, 75);
  assert.ok(existsSync(join(f.root, ".scratch/kit-jobs/plain-bg/go")));
  writeFileSync(release, "");
  let done = f.run("tempfail", "--", process.execPath, "-e", "process.exit(75)");
  for (let i = 0; i < 20 && /^RUNNING: /.test(last(done)); i++) done = f.run("tempfail");
  assert.equal(done.status, 1, done.stdout);
  assert.match(last(done), /^RESULT: fail go tempfail exit 75 \(the job's own code; kit go gives 1 for it\)/);
});

test("go: a job that says fail but exits 0 ends kit go with exit 1", t => {
  const f = fixture(t);
  let done = f.run("says-fail", "--", process.execPath, "-e", 'console.log("RESULT: fail it broke")');
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("says-fail");
  assert.equal(done.status, 1, done.stdout);
  assert.equal(last(done), "RESULT: fail it broke");
});

test("go: waited for from another folder, its Run again line keeps KIT_ROOT; a time limit after a failed step names the limit", t => {
  const f = fixture(t);
  const release = join(f.root, "release");
  assert.equal(f.run("far", "--", ...job(release)).status, 75);
  const elsewhere = mkdtempSync(join(tmpdir(), "kit-go-elsewhere-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const far = spawnSync(kit, ["go", "far"], { cwd: elsewhere, env: f.env, encoding: "utf8" });
  assert.equal(far.status, 75, far.stdout);
  assert.match(last(far), new RegExp(`Run again: KIT_ROOT=${f.root.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} scripts/agents/kit go far$`));
  writeFileSync(release, "");
  writeFileSync(join(f.root, ".bin/systemd-run"), `#!/usr/bin/env bash
limit=''
while (( $# )); do
  case $1 in -p) [[ $2 == RuntimeMaxSec=* ]] && limit=\${2#RuntimeMaxSec=}; shift 2 ;; --description) shift 2 ;; --*) shift ;; *) break ;; esac
done
[[ -z $limit ]] || ( sleep "$limit"; kill -TERM -- "-$$" ) > /dev/null 2>&1 &
exec "$@"
`);
  let done = f.run("step-failed", "--max", "1", "--", process.execPath, "-e", 'console.log("RESULT: fail step one"); setInterval(() => {}, 1000)');
  for (let i = 0; i < 30 && done.status === 75; i++) done = f.run("step-failed");
  assert.equal(done.status, 143, done.stdout);
  assert.match(done.stdout, /^job: RESULT: fail step one$/m);
  assert.match(last(done), /^RESULT: fail go step-failed exit 143: the time limit \(1s\) ended this job/);
});

test("go: without a user systemd the job starts the old way with a note", t => {
  const f = fixture(t, { FAKE_SYSTEMD_FAIL: "1" });
  const output = f.run("plain", "--", "true");
  assert.match(output.stdout, /note: no user systemd; this job ends with the session/);
  let done = output;
  for (let i = 0; i < 20 && done.status === 75; i++) done = f.run("plain");
  assert.equal(done.status, 0, done.stdout);
});

test("go: a call never waits past its limit, and the limit is capped at 9 minutes", t => {
  const f = fixture(t, { KIT_GO_WAIT_MS: "200" });
  const release = join(f.root, "release");
  const before = Date.now();
  const output = f.run("held", "--", ...job(release));
  assert.equal(output.status, 75);
  assert.ok(Date.now() - before < 5000, "returned soon after its 200ms limit");
  const capped = spawnSync(kit, ["go", "--help"], { env: { ...f.env, KIT_GO_WAIT_MS: "999999999" }, encoding: "utf8" });
  assert.match(capped.stdout, /waits 9m per call/);
  writeFileSync(release, "");
});
