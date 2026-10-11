// Worktree inventory and conservative pruning; invoked by worktrees.sh.
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const day = 86400000;
const git = async (args) => (await exec("git", ["--no-optional-locks", ...args], { maxBuffer: 16 * 1024 * 1024 })).stdout;
const canonical = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };

export function pruneDecision(info, olderThan = 3) {
  if (info.protected) return "protected";
  if (info.locked) return "locked";
  if (info.dirty !== false) return info.dirty ? "dirty" : "cleanliness unknown";
  if (info.merged !== true) return "not merged or merge unknown";
  if (!Number.isFinite(info.commitAge) || !Number.isFinite(info.createdAge)) return "age unknown";
  if (info.commitAge <= olderThan || info.createdAge <= olderThan) return "too recent";
  if (info.live !== false) return info.live ? "live process" : "process scan incomplete";
  return "eligible";
}

export function parseWorktrees(output) {
  const worktrees = [];
  let current;
  for (const field of output.split("\0")) {
    if (field.startsWith("worktree ")) {
      current = { path: field.slice(9), branch: "(detached)", locked: false };
      worktrees.push(current);
    } else if (current && field.startsWith("branch ")) current.branch = field.slice(7).replace(/^refs\/heads\//, "");
    else if (current && field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (current && /^locked(?: |$)/.test(field)) current.locked = true;
    else if (current && field === "bare") current.locked = true;
  }
  return worktrees;
}

export function pathInside(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function processes() {
  const paths = [];
  let complete = true;
  try {
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try { paths.push(canonical(readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, ""))); }
      catch (error) { if (!["ENOENT", "ESRCH"].includes(error.code)) complete = false; }
    }
  } catch { complete = false; }
  return { paths, complete };
}

async function inspect(worktree, protectedPaths, targets, scan) {
  const path = canonical(worktree.path);
  const info = { ...worktree, protected: protectedPaths.has(path) || basename(path) === "native-site-editor-dev" || worktree.branch === "dev", owner: "", live: scan.paths.some((cwd) => pathInside(cwd, path)) ? true : scan.complete ? false : null };
  try { info.owner = readFileSync(join(path, ".scratch/owner"), "utf8").split(/\r?\n/)[0]; }
  catch (error) { if (error.code !== "ENOENT") info.error = `owner: ${error.message}`; }
  try {
    const [status, head] = await Promise.all([
      git(["-C", path, "status", "--porcelain=v1", "--untracked-files=all"]),
      git(["-C", path, "rev-parse", "HEAD"]),
    ]);
    info.dirty = status.length > 0;
    info.head = head.trim();
    const registered = statSync(join(path, ".git")).mtimeMs;
    const owned = Date.parse(info.owner.split(/\s+/)[0]);
    info.createdAge = (Date.now() - (Number.isFinite(owned) ? Math.max(registered, owned) : registered)) / day;
  } catch (error) { info.error = error.message.split(/\r?\n/)[0]; }
  // Registered HEADs remain readable in the shared repository even when their
  // checkout is missing; missing cleanliness/creation data still prevents removal.
  try {
    const timestamp = await git(["log", "-1", "--format=%ct", info.head]);
    info.commitAge = (Date.now() - Number(timestamp.trim()) * 1000) / day;
    info.merged = targets.length ? false : null;
    for (const target of targets) {
      try {
        await git(["merge-base", "--is-ancestor", info.head, target]);
        info.merged = true;
        break;
      } catch (error) { if (error.code !== 1) { info.merged = null; break; } }
    }
  } catch (error) { info.error = error.message.split(/\r?\n/)[0]; }
  return info;
}

export function options(args) {
  let prune = false;
  let olderThan = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prune" && !prune) prune = true;
    else if (args[i] === "--older-than" && /^\d+(?:\.\d+)?$/.test(args[i + 1] ?? "")) olderThan = Number(args[++i]);
    else throw new Error("Usage: worktrees.sh [--prune] [--older-than DAYS=3]");
  }
  if (!Number.isFinite(olderThan)) throw new Error("Usage: worktrees.sh [--prune] [--older-than DAYS=3]");
  return { prune, olderThan };
}

async function main(args) {
  let settings;
  try { settings = options(args); }
  catch (error) { console.error(error.message); process.exitCode = 2; return; }
  try {
    const worktrees = parseWorktrees(await git(["worktree", "list", "--porcelain", "-z"]));
    const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const protectedPaths = new Set([canonical(worktrees[0].path), canonical(dirname(common)), canonical("/home/ubulex/Projects/native-site-editor-dev")]);
    // Pin the local remote-tracking refs for this inventory. No fetch or branch deletion.
    const targets = [];
    for (const ref of ["refs/remotes/origin/dev", "refs/remotes/origin/main"]) {
      try { targets.push((await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim()); } catch { /* No target means no removal. */ }
    }
    const scan = processes();
    const inventories = new Array(worktrees.length);
    let next = 0;
    // Bound git concurrency on machines with hundreds of registered worktrees.
    await Promise.all(Array.from({ length: Math.min(8, worktrees.length) }, async () => {
      while (next < worktrees.length) {
        const index = next++;
        inventories[index] = await inspect(worktrees[index], protectedPaths, targets, scan);
      }
    }));
    const yesNo = (value) => value === true ? "yes" : value === false ? "no" : "unknown";
    for (let i = 0; i < inventories.length; i++) {
      const info = inventories[i];
      const decision = pruneDecision(info, settings.olderThan);
      console.log(`${JSON.stringify(info.path)}\tbranch=${JSON.stringify(info.branch)}\towner=${JSON.stringify(info.owner || "unknown")}\tdirty=${yesNo(info.dirty)}\tcommit-age=${Number.isFinite(info.commitAge) ? `${info.commitAge.toFixed(1)}d` : "unknown"}\tmerged=${yesNo(info.merged)}\tlive=${yesNo(info.live)}\t${decision}`);
      if (!settings.prune || decision !== "eligible") continue;
      // Recheck cleanliness, HEAD, age and live cwd immediately before removal.
      const fresh = await inspect(worktrees[i], protectedPaths, targets, processes());
      const reason = pruneDecision(fresh, settings.olderThan);
      if (reason !== "eligible" || fresh.head !== info.head) {
        console.log(`Kept ${JSON.stringify(info.path)}: ${fresh.head !== info.head ? "HEAD changed" : reason}`);
        continue;
      }
      try {
        await git(["worktree", "remove", "--", info.path]);
        console.log(`Removed ${JSON.stringify(info.path)}`);
      } catch (error) { console.error(error.message.trim()); process.exitCode = 1; }
    }
    if (settings.prune) await git(["worktree", "prune"]);
    console.log("Branches kept. Review git branch --merged origin/dev (or origin/main), then git branch -d <branch>.");
  } catch (error) { console.error(error.message.trim()); process.exitCode = 1; }
}

if (import.meta.main) await main(process.argv.slice(2));
