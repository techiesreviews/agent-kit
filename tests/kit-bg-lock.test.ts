import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { bgLockKind, bgLock } from "../bg-lock.mjs";
import { kitEnv } from "./support/kit-env.ts";

const kit = resolve("kit");
const held = 'const fs = require("fs"); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(timer); process.exit(0); } }, 10);';

function folder(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-bg-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
// process.platform is read when a lock is taken, so a test can be another platform for one block.
async function onPlatform<T>(platform: string, run: () => T | Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  try { return await run(); }
  finally { Object.defineProperty(process, "platform", original); }
}
// A pid no process has: a short-lived child's, after it ended.
function deadPid() {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(child.pid);
  return child.pid;
}

test("the lock is a file lock on Windows and flock on Linux and macOS", async () => {
  for (const [platform, kind] of [["win32", "file"], ["linux", "flock"], ["darwin", "flock"]] as const) {
    assert.equal(bgLockKind(platform, {}), kind, platform);
    assert.equal(await onPlatform(platform, () => bgLockKind()), kind, `${platform} through process.platform`);
  }
  // KIT_BG_LOCK picks the lock by hand (tests, a machine whose flock is broken); anything else is ignored.
  assert.equal(bgLockKind("linux", { KIT_BG_LOCK: "file" }), "file");
  assert.equal(bgLockKind("win32", { KIT_BG_LOCK: "flock" }), "flock");
  assert.equal(bgLockKind("win32", { KIT_BG_LOCK: "nonsense" }), "file");
  assert.equal(bgLockKind("linux", { KIT_BG_LOCK: "" }), "flock");
});

test("on Windows the lock never starts flock, so a machine without it still locks", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  const nowhere = join(root, "empty-path");
  mkdirSync(nowhere);
  const before = process.env.PATH;
  process.env.PATH = nowhere;
  try {
    const lock = await onPlatform("win32", () => bgLock(path, "job"));
    assert.equal(lock.kind, "file");
    await lock.release();
    // The same machine on a flock platform fails the way LexTop did: spawn flock ENOENT.
    await assert.rejects(onPlatform("linux", () => bgLock(path, "job")), /ENOENT/);
  } finally { process.env.PATH = before; }
});

test("the file lock is exclusive, names the holder, and lets go on release", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  const first = await bgLock(path, "job", { platform: "win32" });
  assert.equal(first.kind, "file");
  assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid} `));
  await assert.rejects(bgLock(path, "job", { platform: "win32" }), /bg job is busy; retry after its current operation/);
  // A refused taker leaves the holder's lock alone.
  assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid} `));
  await first.release();
  assert.equal(existsSync(path), false);
  const second = await bgLock(path, "job", { platform: "win32" });
  await second.release();
  // Releasing twice is harmless.
  await second.release();
});

test("the file lock of a process that is gone is taken over", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  writeFileSync(path, `${deadPid()} dead-token\n`);
  const lock = await bgLock(path, "job", { platform: "win32" });
  assert.match(readFileSync(path, "utf8"), new RegExp(`^${process.pid} `));
  await lock.release();
  assert.equal(existsSync(path), false);
});

test("a fresh file lock of a live process is kept, an old one is taken over even when its pid is alive", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  writeFileSync(path, `${process.pid} other-token\n`);
  await assert.rejects(bgLock(path, "job", { platform: "win32" }), /is busy/);
  assert.equal(readFileSync(path, "utf8"), `${process.pid} other-token\n`);
  // A recycled pid must not hold the lock forever.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(path, old, old);
  const lock = await bgLock(path, "job", { platform: "win32" });
  assert.notEqual(readFileSync(path, "utf8"), `${process.pid} other-token\n`);
  await lock.release();
});

test("a file lock with no readable holder is busy while fresh and stale once old", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  writeFileSync(path, "");
  await assert.rejects(bgLock(path, "job", { platform: "win32" }), /is busy/);
  writeFileSync(path, "garbage");
  await assert.rejects(bgLock(path, "job", { platform: "win32" }), /is busy/);
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(path, old, old);
  await (await bgLock(path, "job", { platform: "win32" })).release();
});

test("a release never removes a lock another process took over", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  const mine = await bgLock(path, "job", { platform: "win32" });
  // Mine went stale and another kit process took it over.
  writeFileSync(path, `${process.pid} the-new-holder\n`);
  await mine.release();
  assert.equal(readFileSync(path, "utf8"), `${process.pid} the-new-holder\n`);
});

test("the file lock reports an unwritable lock folder, not a busy job", async t => {
  const root = folder(t);
  await assert.rejects(bgLock(join(root, "missing", ".job.lock"), "job", { platform: "win32" }), /ENOENT/);
});

test("kit bg starts and stops a job under the file lock with no flock on the machine", async t => {
  const root = folder(t);
  const bin = join(root, "bin");
  mkdirSync(bin);
  // A flock that always says busy and leaves a trace: the file lock must never run it.
  writeFileSync(join(bin, "flock"), `#!/bin/sh\necho used >> "${join(root, "flock-used")}"\nexit 1\n`);
  chmodSync(join(bin, "flock"), 0o755);
  const env: NodeJS.ProcessEnv = { ...kitEnv(), KIT_ROOT: root, KIT_BG_SCOPE: "off", PATH: `${bin}:${process.env.PATH}` };
  const run = (extra: NodeJS.ProcessEnv, ...args: string[]) => spawnSync(kit, ["bg", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
  t.after(() => { run({ KIT_BG_LOCK: "file" }, "--stop", "win"); });
  const release = join(root, "release");
  const started = run({ KIT_BG_LOCK: "file" }, "win", "--", process.execPath, "-e", held, release);
  assert.equal(started.status, 0, started.stderr + started.stdout);
  assert.match(started.stdout, /RESULT: ok bg win pid \d+/);
  assert.equal(existsSync(join(root, "flock-used")), false, "the file lock must not run flock");
  // Nothing is left held between runs.
  assert.deepEqual(readdirSync(join(root, ".scratch/kit-jobs")).filter(name => name.endsWith(".lock")), []);
  const again = run({ KIT_BG_LOCK: "file" }, "win", "--", process.execPath, "-e", held, release);
  assert.equal(again.status, 1);
  assert.match(again.stdout, /bg win already running/);
  const stopped = run({ KIT_BG_LOCK: "file" }, "--stop", "win");
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  assert.match(stopped.stdout, /RESULT: ok bg stop win/);
  assert.deepEqual(readdirSync(join(root, ".scratch/kit-jobs")).filter(name => name.endsWith(".lock")), []);
  // The flock path is unchanged: the same fake, as flock, makes the start fail as busy.
  const busy = run({ KIT_BG_LOCK: "flock" }, "other", "--", "true");
  assert.equal(busy.status, 1);
  assert.match(busy.stdout, /bg other is busy/);
  assert.ok(existsSync(join(root, "flock-used")));
});

test("kit bg concurrent starts reserve a name once under the file lock", async t => {
  const root = folder(t);
  const env: NodeJS.ProcessEnv = { ...kitEnv(), KIT_ROOT: root, KIT_BG_SCOPE: "off", KIT_BG_LOCK: "file" };
  t.after(() => { spawnSync(kit, ["bg", "--stop", "race"], { env }); });
  const launch = () => new Promise<number | null>((accept, reject) => {
    const child = spawn(kit, ["bg", "race", "--", process.execPath, "-e", held, join(root, "release")], { env, stdio: "ignore" });
    child.on("error", reject).on("close", accept);
  });
  // The loser is refused either as busy (the other holds the lock) or as already running: one start wins.
  const codes = (await Promise.all([launch(), launch()])).sort();
  assert.deepEqual(codes, [0, 1]);
});
