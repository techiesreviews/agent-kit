import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { bgLockKind, bgLock } from "../bg-lock.mjs";

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

test("a taker that finds a stale lock replaced by another taker's never removes the new lock", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  writeFileSync(path, `${deadPid()} dead-token\n`);
  // Between this taker judging the lock stale and removing it, another taker took the lock over.
  const between = () => { rmSync(path); writeFileSync(path, `${process.pid} the-new-holder\n`); };
  await assert.rejects(bgLock(path, "job", { platform: "win32", between }), /is busy/);
  assert.equal(readFileSync(path, "utf8"), `${process.pid} the-new-holder\n`);
  assert.equal(existsSync(`${path}.recover`), false, "the take-over guard is let go");
});

test("a take-over in progress refuses the other takers, and a guard left by a dead taker is cleared", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  writeFileSync(path, `${deadPid()} dead-token\n`);
  writeFileSync(`${path}.recover`, "1\n");
  await assert.rejects(bgLock(path, "job", { platform: "win32" }), /is busy/);
  assert.match(readFileSync(path, "utf8"), /dead-token/, "the stale lock is left to the taker that holds the guard");
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(`${path}.recover`, old, old);
  await assert.rejects(bgLock(path, "job", { platform: "win32" }), /is busy/);
  assert.equal(existsSync(`${path}.recover`), false);
  await (await bgLock(path, "job", { platform: "win32" })).release();
});

test("processes racing for a stale lock: one holds it, the others are refused", async t => {
  const root = folder(t);
  const path = join(root, ".job.lock");
  const code = `import { bgLock } from ${JSON.stringify(new URL("../bg-lock.mjs", import.meta.url).href)};
try { const lock = await bgLock(process.argv[2], "job", { platform: "win32" }); console.log("won"); await new Promise(r => setTimeout(r, 1500)); await lock.release(); }
catch (error) { console.log(/is busy/.test(error.message) ? "busy" : error.message); }`;
  const script = join(root, "taker.mjs");
  writeFileSync(script, code);
  for (let round = 0; round < 3; round++) {
    writeFileSync(path, `${deadPid()} dead-token\n`);
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((accept, reject) => {
      const child = spawn(process.execPath, [script, path], { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      child.stdout.on("data", chunk => { out += chunk; });
      child.on("error", reject).on("close", () => accept(out.trim()));
    })));
    assert.deepEqual(results.filter(result => result === "won").length, 1, results.join(","));
    assert.deepEqual(results.filter(result => result !== "won" && result !== "busy"), []);
    assert.equal(existsSync(path), false);
  }
});
