// The per-name lock of kit bg (and so of kit go): one start or stop of a job name at a time.
// Linux and macOS keep flock(1); Windows has no flock, so it takes a lock file made in one step with the
// "create, fail if it exists" flag, which Node does the same way on every platform.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

// A lock file older than this is taken over even when its pid is alive: a pid can be reused. A start or stop holds
// the lock for a few seconds at most (a start waits 5s for its job's records, a stop 2s for its group to end).
const STALE_MS = 60 * 1000;

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

/** A held lock file is stale when its process is gone or it is older than STALE_MS; an empty or unreadable one only by age. */
function stale(path) {
  let text, age;
  try { text = readFileSync(path, "utf8"); age = Date.now() - statSync(path).mtimeMs; }
  catch (error) { if (error.code === "ENOENT") return { text: null, stale: true }; throw error; }
  const pid = Number(/^(\d+) /.exec(text)?.[1]);
  const gone = Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid);
  return { text, stale: gone || age > STALE_MS };
}

async function fileLock(path, name) {
  const token = `${process.pid} ${randomUUID()}\n`;
  // Two tries: the second one follows taking over a stale lock. The lock is never waited for, like flock --nonblock.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, token, { flag: "wx" }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const found = stale(path);
      if (!found.stale) break;
      // Only the content that was judged stale is removed (the window between this read and the removal is a few
      // instructions; the job's own records still refuse a second start of a running name).
      try { if (found.text === null || readFileSync(path, "utf8") === found.text) rmSync(path, { force: true }); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
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
 * is taken over, so a killed launcher never blocks the name.
 */
export async function bgLock(path, name, { platform = process.platform, env = process.env } = {}) {
  const kind = bgLockKind(platform, env);
  return { kind, release: kind === "file" ? await fileLock(path, name) : await flockLock(path, name) };
}
