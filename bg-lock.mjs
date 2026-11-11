// The per-name lock of kit bg (and so of kit go): one start or stop of a job name at a time.
// Linux and macOS keep flock(1); Windows has no flock, so it takes a lock file made in one step with the
// "create, fail if it exists" flag, which Node does the same way on every platform.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

// A lock file older than this is taken over even when its pid is alive: a pid can be reused. A start or stop holds
// the lock for a few seconds at most (a start waits 5s for its job's records, a stop 2s for its group to end), so
// this is a wide margin: a live holder is never taken over.
const STALE_MS = 5 * 60 * 1000;
// A taking-over holds its guard file for a moment; one older than this was left by a taker that died.
const RECOVER_STALE_MS = 30 * 1000;

/**
 * "flock" or "file". Windows gets the file lock, every other platform flock. KIT_BG_LOCK=file or flock picks one by
 * hand (tests, a machine whose flock is broken); any other value is ignored.
 */
export function bgLockKind(platform = process.platform, env = process.env) {
  const chosen = env.KIT_BG_LOCK;
  if (chosen === "file" || chosen === "flock") return chosen;
  return platform === "win32" ? "file" : "flock";
}

async function flockLock(path, name) {
  // flock releases on pipe EOF even if the launcher is killed during startup.
  // Keep the lock in a separate process so detached jobs cannot inherit it.
  const child = spawn("flock", ["--nonblock", path, "/bin/sh", "-c", "printf 'locked\\n'; read -r release || :"], { stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  child.stdin.on("error", () => {});
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.stdout.once("data", resolve);
    child.once("close", () => reject(new Error(`bg ${name} is busy; retry after its current operation`)));
  });
  return async () => { child.stdin.end(); await closed; };
}

/** Whether a process with this pid exists: signal 0 sends nothing; EPERM means it exists but is another user's. */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

/** The file's text and age; null when it is gone. */
function look(path) {
  try { return { text: readFileSync(path, "utf8"), age: Date.now() - statSync(path).mtimeMs }; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** A held lock file is stale when its process is gone (the only time its holder cannot release it) or it is older than STALE_MS. */
function isStale({ text, age }) {
  const pid = Number(/^(\d+) /.exec(text)?.[1]);
  return (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid)) || age > STALE_MS;
}

/**
 * Take over the stale lock file `found` describes, exclusively: the removal runs under a second lock file,
 * `<lock>.recover`, so two takers never both remove a lock and then each make their own. The lock is read again
 * under it, and removed only if it is still the stale one. false when another taker is recovering it right now.
 */
function recover(path, found, between) {
  const guard = `${path}.recover`, mine = `${process.pid} ${randomUUID()}\n`;
  // Removes the guard only while it still holds the given text, never one another taker made since.
  const drop = text => { try { if (readFileSync(guard, "utf8") === text) rmSync(guard, { force: true }); } catch (error) { if (error.code !== "ENOENT") throw error; } };
  try { writeFileSync(guard, mine, { flag: "wx" }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A taker that died mid-recovery leaves its guard: an old one is cleared, and the next attempt recovers.
    const held = look(guard);
    if (held && held.age > RECOVER_STALE_MS) drop(held.text);
    return false;
  }
  try {
    between?.();
    const now = look(path);
    if (now && now.text === found.text) rmSync(path, { force: true });
    return true;
  } finally { drop(mine); }
}

async function fileLock(path, name, { between } = {}) {
  const token = `${process.pid} ${randomUUID()}\n`;
  // The lock is never waited for, like flock --nonblock: it is made, or refused as busy. A few tries cover a lock
  // released or taken over while this one looks at it.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { writeFileSync(path, token, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const found = look(path);
      if (found && (!isStale(found) || !recover(path, found, between))) break;
      continue;
    }
    // Only a lock still holding this token is removed, never one another process took over.
    return async () => {
      try { if (readFileSync(path, "utf8") === token) rmSync(path, { force: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    };
  }
  throw new Error(`bg ${name} is busy; retry after its current operation`);
}

/**
 * Take the lock of one job name, without waiting: { kind, release }. A held lock throws "bg <name> is busy; retry
 * after its current operation". The flock lock is released when release() resolves or the launcher ends, however it
 * ends. The file lock is a file holding `<pid> <token>`, released by removing it; the file of a process that died
 * is taken over, so a killed launcher never blocks the name. `between` is a test seam: it runs once a taker has
 * judged a lock stale and holds the take-over guard, before the lock is read again.
 */
export async function bgLock(path, name, { platform = process.platform, env = process.env, between } = {}) {
  const kind = bgLockKind(platform, env);
  return { kind, release: kind === "file" ? await fileLock(path, name, { between }) : await flockLock(path, name) };
}
