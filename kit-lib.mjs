import { execFileSync, spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { findingsRecord } from "./review-findings.mjs";

const nodeError = "kit: no Node >=24 found (system, npx cache or nvm)";
const oneLine = (text) => String(text).replace(/[\n\r]/g, " ");

function git(args, env = process.env) {
  try { return execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n+$/, ""); }
  catch { return ""; }
}

/** Return the current worktree root, with KIT_ROOT taking precedence. */
export function kitRoot() {
  // Outside git: the project around a kit kept in its scripts/agents/, else the kit's own folder (kit_root in kit-lib.sh).
  const outside = /[\\/]scripts[\\/]agents$/.test(import.meta.dirname) ? resolve(import.meta.dirname, "../..") : import.meta.dirname;
  return process.env.KIT_ROOT || (git(["rev-parse", "--show-toplevel"]) || outside);
}

/**
 * The shared kit's folder: KIT_HOME, else the folder holding this file. A KIT_HOME some front door
 * filled in (equal to KIT_HOME_DEFAULT) may belong to another worktree, so it counts as unset.
 */
export function kitHome() {
  const { KIT_HOME: home, KIT_HOME_DEFAULT: filled } = process.env;
  return home && home !== filled ? home : import.meta.dirname;
}

/** The project settings file, relative to the project's top folder. */
export const kitSettingsFile = "scripts/agents/kit.json";
const settingsCache = new Map();

/**
 * Problems with branches.direct (a private repo whose PRs land straight on main, with no dev branch or release step):
 * it is true or false, and true needs one branch as land and release, so every reader and the push guard see the same one.
 */
function kitDirectProblems(branches) {
  if (!branches || branches.direct === undefined) return [];
  if (typeof branches.direct !== "boolean") return [`"branches.direct" must be true or false in ${kitSettingsFile}`];
  const named = value => typeof value === "string" && value.trim() !== "";
  return branches.direct && !(named(branches.land) && branches.land === branches.release)
    ? [`direct landing needs the same branch as "land" and "release" in ${kitSettingsFile} (for example both "main")`] : [];
}

/**
 * Problems with the ticket store settings: "tickets" is files or orbit (default files), and "orbit" names the project's
 * Orbit board and, if it has one, the card new tickets go under; "tickets": "orbit" needs the board.
 */
function kitTicketProblems(settings) {
  const problems = [];
  if (settings.tickets !== undefined && settings.tickets !== "files" && settings.tickets !== "orbit") problems.push(`"tickets" must be "files" or "orbit" in ${kitSettingsFile}`);
  const orbit = settings.orbit;
  if (orbit !== undefined && (!orbit || typeof orbit !== "object" || Array.isArray(orbit))) return [...problems, `"orbit" must be an object in ${kitSettingsFile}, like { "project": "TOOLS" }`];
  if (orbit?.project !== undefined && !(typeof orbit.project === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(orbit.project))) problems.push(`"orbit.project" must be an Orbit project key in ${kitSettingsFile}, like "TOOLS"`);
  if (orbit?.parent !== undefined && !(typeof orbit.parent === "string" && /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/.test(orbit.parent))) problems.push(`"orbit.parent" must be a card key in ${kitSettingsFile}, like "TOOLS-10"`);
  if (orbit?.parent !== undefined && orbit?.project === undefined) problems.push(`"orbit.parent" needs "orbit.project" in ${kitSettingsFile}`);
  if (settings.tickets === "orbit" && orbit?.project === undefined) problems.push(`"tickets": "orbit" needs "orbit": { "project": "<KEY>" } in ${kitSettingsFile}`);
  return problems;
}

/** Problems with parsed settings: only `project` and `branches.land` are required. */
export function kitSettingsProblems(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [`${kitSettingsFile} must hold one JSON object`];
  const text = value => typeof value === "string" && value.trim() !== "";
  return [
    ...(text(settings.project) ? [] : [`add "project": "<name>" to ${kitSettingsFile}`]),
    ...(text(settings.branches?.land) ? [] : [`add "branches": { "land": "<branch>" } to ${kitSettingsFile}`]),
    ...kitDirectProblems(settings.branches),
    ...kitTicketProblems(settings),
  ];
}

/** Read the project's settings file once per root; throws one plain line when it is missing, broken or lacks a required key. */
export function kitSettings(root = kitRoot()) {
  if (settingsCache.has(root)) return settingsCache.get(root);
  let settings;
  try { settings = JSON.parse(readFileSync(join(root, kitSettingsFile), "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error(`no ${kitSettingsFile}; add one with "project" and "branches": { "land": "<branch>" }`);
    throw new Error(`${kitSettingsFile} is unreadable: ${oneLine(error.message)}`);
  }
  const problems = kitSettingsProblems(settings);
  if (problems.length) throw new Error(problems.join("; "));
  // One spelling for every reader: "docs/wayfinder/" is "docs/wayfinder".
  if (typeof settings.maps === "string") settings.maps = settings.maps.replace(/\/+$/, "");
  settingsCache.set(root, settings);
  return settings;
}

/** A settings branch: `land`, `release`, or `ci` (which falls back to land); undefined when unset. */
export function kitBranch(name = "land", settings = kitSettings()) {
  const branches = settings.branches;
  return (typeof branches[name] === "string" && branches[name]) || (name === "ci" ? branches.land : undefined);
}

/**
 * Whether origin's GitHub repo is private, as gh says: { private: true|false } when it answers PRIVATE or PUBLIC, else
 * { reason } (no GitHub origin, gh missing or failing, INTERNAL). Nothing here ever guesses: only a plain answer counts.
 */
export function kitRepoPrivate(root = kitRoot(), env = process.env) {
  const repo = kitGhRepo(root, env);
  if (!repo) return { reason: "no GitHub origin" };
  const asked = spawnSync("gh", ["repo", "view", repo, "--json", "visibility"], { env: kitGhEnv(env, root), encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  if (asked.status !== 0) return { repo, reason: oneLine(asked.stderr || (asked.error?.code === "ENOENT" ? "gh is not installed" : asked.error?.code === "ETIMEDOUT" ? "gh did not answer in time" : asked.error?.message) || `gh exited ${asked.status}`).trim().slice(0, 120) };
  let visibility;
  try { visibility = JSON.parse(asked.stdout).visibility; } catch { /* Not JSON: unknown. */ }
  return visibility === "PRIVATE" ? { repo, private: true } : visibility === "PUBLIC" ? { repo, private: false } : { repo, reason: `gh says ${visibility ?? "nothing"}` };
}

/** The persistent dev worktree: KIT_DEV_ROOT, else the settings' devRoot, else null. */
export function kitDevRoot(settings = kitSettings()) {
  return process.env.KIT_DEV_ROOT || settings.devRoot || null;
}

/** The maps folder (settings `maps`) for features that need one; throws a plain line when it is unset. */
export function kitMaps(settings = kitSettings()) {
  if (typeof settings.maps === "string" && settings.maps) return settings.maps;
  throw new Error(`no "maps" folder in ${kitSettingsFile}; this command needs one`);
}

/** Return the persistent main checkout root: KIT_MAIN_ROOT, the settings' mainRoot, else the main worktree. */
export function kitMainRoot() {
  if (process.env.KIT_MAIN_ROOT) return process.env.KIT_MAIN_ROOT;
  const root = kitRoot();
  let settings = {};
  try { settings = kitSettings(root); } catch { /* No usable settings: use the main worktree. */ }
  if (settings.mainRoot) return settings.mainRoot;
  const common = git(["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common ? dirname(common) : root;
}

/** Return the explicit owner, worktree owner, branch, or unknown. */
export function kitOwner() {
  if (process.env.ASE_OWNER) return oneLine(process.env.ASE_OWNER);
  const root = kitRoot();
  let owner = "";
  try { owner = readFileSync(join(root, ".scratch/owner"), "utf8").split(/\r?\n/, 1)[0].trim().split(/\s+/)[1] ?? ""; }
  catch { /* No owner file: use the branch. */ }
  return oneLine((owner && owner !== "unknown" ? owner : git(["-C", root, "branch", "--show-current"])) || "unknown");
}

/**
 * Machine-wide kit state, shared by every project on this computer: $XDG_STATE_HOME/agent-kit
 * (an absolute XDG_STATE_HOME only, as the XDG spec says), else ~/.local/state/agent-kit.
 */
export function kitStateDir(env = process.env) {
  const state = env.XDG_STATE_HOME;
  return join(state && isAbsolute(state) ? state : join(env.HOME || homedir(), ".local/state"), "agent-kit");
}

/**
 * The machine's project list, projects.json in the state folder: { "<project>": { "root": "<main folder>" } }.
 * Empty when there is none yet; throws one plain line when it is broken.
 */
export function kitProjects(env = process.env) {
  const path = join(kitStateDir(env), "projects.json");
  let projects;
  try { projects = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`${path} is unreadable: ${oneLine(error.message)}`);
  }
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) throw new Error(`${path} must hold one JSON object`);
  return projects;
}

/**
 * Take a machine-wide lock in the kit's state folder (ticket ke-88): `<state>/<name>.lock`, held with flock(1) by a
 * small child process for as long as this process lives, so the system frees it when the holder ends however it
 * ends. While held the file reads `<pid> <owner>` (the front door's kit_quiet_wait reads the quiet lock's).
 * A held lock is waited for; onWait(owner) is told once. release() empties the file and lets the lock go,
 * resolving once flock has ended, so the next taker never finds it still held. Without flock (KIT_FLOCK names
 * another program) nothing is locked: the lock says `missing`, so the caller can say so.
 */
export async function kitMachineLock(name, { owner = kitOwner(), onWait, env = process.env } = {}) {
  const lock = join(kitStateDir(env), `${name}.lock`), mine = `${process.pid} ${oneLine(owner)}\n`;
  mkdirSync(dirname(lock), { recursive: true });
  // flock prints "held" once it has the lock, then keeps it until its stdin closes (release, or this process ends).
  const hold = wait => new Promise((accept, reject) => {
    const child = spawn(env.KIT_FLOCK || "flock", [...(wait ? [] : ["-n"]), "-o", "-x", lock, "sh", "-c", "echo held; exec cat > /dev/null"],
      { stdio: ["pipe", "pipe", "ignore"] });
    let held = false;
    child.once("error", error => error.code === "ENOENT" ? accept("missing") : reject(new Error(`cannot lock ${lock}: ${error.message}`)));
    child.stdout.setEncoding("utf8").on("data", text => {
      if (held || !text.includes("held")) return;
      held = true; child.unref(); child.stdout.unref?.(); accept(child);
    });
    child.once("close", () => { if (!held) accept(null); });
  });
  let child = await hold(false);
  if (child === "missing") return { path: lock, missing: true, release: () => Promise.resolve() };
  if (!child) {
    let text = "";
    try { text = readFileSync(lock, "utf8"); } catch { /* Not written yet. */ }
    onWait?.(text.trim().split(" ").slice(1).join(" ") || "unknown");
    child = await hold(true);
    if (!child) throw new Error(`cannot lock ${lock}`);
  }
  writeFileSync(lock, mine);
  return {
    path: lock,
    release() {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      // Referenced again, so a caller awaiting this release is not left behind by an emptied event loop.
      child.ref(); child.stdout.ref?.();
      const ended = new Promise(accept => child.once("close", () => accept()));
      if (!child.stdin.destroyed) {
        try { if (readFileSync(lock, "utf8") === mine) writeFileSync(lock, ""); } catch { /* Already gone. */ }
        child.stdin.end();
      }
      return ended;
    },
  };
}

/**
 * List a project in projects.json (kit init), under its lock and written atomically: "added", or "listed" when
 * it is already there with the same root. Throws one plain line when the list is broken or the name is taken
 * by another root, so two projects never share a name. during() runs under the lock once the name is checked
 * (kit init writes its files there); when it throws, nothing is listed.
 */
export function kitRegisterProject(name, root, env = process.env, during = () => {}) {
  const path = join(kitStateDir(env), "projects.json");
  mkdirSync(dirname(path), { recursive: true });
  const lock = `${path}.lock`;
  takeLock(lock);
  try {
    const projects = kitProjects(env), listed = projects[name]?.root;
    if (listed && listed !== root) throw new Error(`${path} already lists ${name} at ${listed}; give this project another "project" name in ${kitSettingsFile}`);
    during();
    if (listed === root) return "listed";
    projects[name] = { root };
    const temporary = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(projects, null, 2)}\n`);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw new Error(`cannot write ${path}: ${oneLine(error.message)}`);
    }
    return "added";
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

function version(candidate) {
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    const output = execFileSync(candidate, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n+$/, "");
    return /^v([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(output)?.slice(1).map(Number) ?? null;
  } catch { return null; }
}

function children(directory) {
  try { return readdirSync(directory).filter((name) => !name.startsWith(".")).sort(); }
  catch { return []; }
}

function absoluteNode(candidate) {
  return join(realpathSync(dirname(candidate)), "node");
}

/** Find system Node >=24 first, then the highest installed npx/nvm version. */
export function findNode({ path = process.env.PATH, searchRoot } = {}) {
  for (const directory of (path ?? "").split(":")) {
    const candidate = resolve(directory, "node");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
    } catch { continue; }
    const found = version(candidate);
    if (found?.[0] >= 24) return absoluteNode(candidate);
    break; // Only the first executable node is the system node on PATH.
  }
  const root = searchRoot ?? (process.env.CLAUDE_NODE_SEARCH_ROOT || process.env.HOME);
  if (!root) return null;
  const npm = join(root, ".npm/_npx");
  const nvm = join(root, ".nvm/versions/node");
  const candidates = [
    ...children(npm).map((name) => join(npm, name, "node_modules/node/bin/node")),
    ...children(nvm).map((name) => join(nvm, name, "bin/node")),
  ];
  let best = null;
  let highest = [0, 0, 0];
  for (const candidate of candidates) {
    const found = version(candidate);
    if (!found || found[0] < 24) continue;
    const difference = found.map((part, index) => part - highest[index]).find((part) => part !== 0) ?? 0;
    if (difference > 0) { best = candidate; highest = found; }
  }
  return best ? absoluteNode(best) : null;
}

/** Copy env with a supported Node first on PATH, or throw when unavailable. */
export function nodeEnv(env = process.env) {
  const node = findNode({ path: env.PATH ?? "", searchRoot: env.CLAUDE_NODE_SEARCH_ROOT || env.HOME || "" });
  if (!node) throw new Error(nodeError);
  const directory = dirname(node);
  const path = env.PATH ?? "";
  return { ...env, PATH: path.split(":")[0] === directory ? path : `${directory}${path ? `:${path}` : ""}`, KIT_NODE: node };
}

/**
 * A GitHub-style remote URL's host, OWNER/NAME and whether it goes over ssh (ssh:// or scp form), or null for any
 * other URL or path. The host may be anyone's (GitLab too) or an ssh alias: kitGhRepo decides whether it is GitHub.
 */
export function kitGitHubRemote(url = "") {
  const web = /^(https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  const scp = web ? null : /^(?:[^@/]+@)?([^/:]+):(?!\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
  const [host, name] = web ? [web[2], web[3]] : scp ? [scp[1], scp[2]] : [];
  const lower = host?.toLowerCase();
  return name ? { host: lower === "ssh.github.com" ? "github.com" : lower, name, ssh: Boolean(scp) || web[1] === "ssh" } : null;
}

// The hosts gh can talk to: github.com, the ones in its hosts.yml (gh auth login) and a GH_HOST already set.
function ghHosts(env) {
  const folder = env.GH_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "gh");
  let text = "";
  try { text = readFileSync(join(folder, "hosts.yml"), "utf8"); } catch {}
  const listed = [...text.matchAll(/^([^\s#:][^:]*):\s*$/gm)].map(match => match[1].trim().toLowerCase());
  return new Set(["github.com", ...listed, ...(env.GH_HOST ? [env.GH_HOST.toLowerCase()] : [])]);
}

/**
 * The GitHub repo kit's PRs go to: origin's, as gh names it (OWNER/NAME, or HOST/OWNER/NAME off github.com), or ""
 * when origin is missing or no GitHub repo gh knows. Read from origin's own url, before any insteadOf rewrite; an ssh
 * host alias (Host github-work in ~/.ssh/config) counts by the host name ssh -G gives it, as gh resolves it.
 */
export function kitGhRepo(root = kitRoot(), env = process.env) {
  const remote = kitGitHubRemote(git(["-C", root, "config", "--get", "remote.origin.url"], env));
  if (!remote) return "";
  const known = ghHosts(env);
  let host = remote.host;
  if (!known.has(host) && remote.ssh) {
    const resolved = spawnSync("ssh", ["-G", "--", host], { env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    host = /^hostname (\S+)$/m.exec(resolved.stdout ?? "")?.[1].toLowerCase() ?? "";
    if (host === "ssh.github.com") host = "github.com";
  }
  return !known.has(host) ? "" : host === "github.com" ? remote.name : `${host}/${remote.name}`;
}

/**
 * Copy env for gh with GH_REPO set to origin's repo: with more than one remote gh picks its own default, and a site
 * made from the starter has an upstream it would pick. GH_HOST is origin's host too, for gh api, which takes its
 * host from GH_HOST, not GH_REPO. Without a GitHub origin, a GH_REPO already set stays, and a host it names goes
 * to GH_HOST the same way.
 */
export function kitGhEnv(env = process.env, root = kitRoot()) {
  const repo = kitGhRepo(root, env);
  if (repo) return { ...env, GH_REPO: repo, GH_HOST: repo.split("/").length === 3 ? repo.split("/")[0] : "github.com" };
  const parts = env.GH_REPO?.split("/") ?? [];
  return parts.length === 3 ? { ...env, GH_HOST: parts[0] } : { ...env };
}

/**
 * Text with each scheme url's user-info part taken out (https://user:token@host/… becomes https://host/…), so no
 * message, log or report the kit writes shows a remote's token. A bare user name goes too (ssh://git@host/… shows as
 * ssh://host/…): a token can be all the user-info there is. scp-style git@host:path carries no token and stays.
 */
export function kitHideUserInfo(text = "") {
  return String(text).replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1");
}

/**
 * A log writer for a child's streams that hides user-info as kitHideUserInfo does. A url holds no whitespace, so only
 * the text after a stream's last whitespace waits for its next chunk; end() writes what is left. Each stream keeps
 * its own order, but a held-back piece can land in the log after the other stream's later text.
 */
export function kitHidingLog(append) {
  const unwritten = new Map();
  return {
    write(stream, chunk) {
      const text = (unwritten.get(stream) ?? "") + chunk, end = text.search(/\s\S*$/) + 1;
      // Set anew, so end() writes the leftovers in the order their streams last wrote.
      unwritten.delete(stream); unwritten.set(stream, text.slice(end));
      if (end) append(kitHideUserInfo(text.slice(0, end)));
    },
    end() { for (const rest of unwritten.values()) if (rest) append(kitHideUserInfo(rest)); unwritten.clear(); },
  };
}

/** Print a single RESULT line, user-info hidden; invalid statuses set exitCode to 2. */
export function kitResult(status = "", text = "") {
  if (status !== "ok" && status !== "fail") {
    console.log(`RESULT: fail kit_result: bad status ${kitHideUserInfo(oneLine(status))}`);
    process.exitCode = 2;
    return;
  }
  console.log(`RESULT: ${status} ${kitHideUserInfo(oneLine(text))}`);
}

/** Resolve a named job without allowing paths outside the worktree's job folder. */
export function kitJobDirectory(name) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name ?? "")) throw new Error(`invalid job name: ${name}`);
  return join(resolve(kitRoot()), ".scratch/kit-jobs", name);
}

/** Read a small job record; a missing record is distinct from an unreadable one. */
export function kitJobRecord(directory, name) {
  try { return readFileSync(join(directory, name), "utf8").trimEnd(); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function processIdentity(text) {
  if (!text) return null;
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { state: fields[0], pgid: Number(fields[2]), session: Number(fields[3]), started: fields[19] };
}

/**
 * "win32" on Windows, else this machine's platform. Windows has no setsid, process groups, /proc or systemd, so its
 * jobs are a process tree read with Get-CimInstance and ended with taskkill. KIT_BG_PLATFORM=win32 picks that way
 * by hand (tests, with fake powershell.exe and taskkill); any other value is ignored.
 */
export function kitJobPlatform(env = process.env) {
  return env.KIT_BG_PLATFORM === "win32" ? "win32" : process.platform;
}

/**
 * Get-CimInstance's "<pid> <parent pid> <start as file time> <name>" lines, one per process; any other line is
 * skipped, and so is conhost.exe: the hidden console host Windows starts as a child of each console process (the
 * job's node processes too) is never a job's work, and a wait for a process's children would never end with it.
 */
export function kitWinProcessList(text) {
  return text.split(/\r?\n/).flatMap(line => {
    const found = /^(\d+) (\d+) (\d+) (.+)$/.exec(line.replace(/^﻿/, "").trim());
    return found && found[4].toLowerCase() !== "conhost.exe" ? [{ pid: Number(found[1]), ppid: Number(found[2]), started: found[3] }] : [];
  });
}

/**
 * Windows processes in ONE Get-CimInstance Win32_Process call (pid, parent pid, CreationDate as a file time, name), all of
 * them or the one pid. Its start time is never mixed with Get-Process's, which reads it another way. A list that
 * cannot be read throws: a job is never taken for ended because PowerShell failed.
 */
export function kitWinProcesses(pid) {
  const query = pid === undefined ? "Get-CimInstance Win32_Process" : `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}'`;
  const script = `${query} | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc(), $_.Name } }`;
  // A list takes about 0.4s; a hung WMI must not keep kit go past one tool call's 10 minutes.
  const read = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  if (read.error || read.status !== 0)
    throw new Error(`cannot read the process list (powershell.exe Get-CimInstance Win32_Process): ${read.error?.message ?? (oneLine(read.stderr ?? "").trim() || `exit ${read.status}`)}`);
  // The powershell.exe reading the list is in it, as a child of the caller: it is never a job's process.
  return kitWinProcessList(read.stdout).filter(entry => entry.pid !== read.pid);
}

/**
 * How a Windows job's command starts. Windows starts only a program file itself (an .exe or .com; Node refuses a .cmd
 * or .bat without a shell), so the command's first word is looked up as Windows does (a word with a folder in the
 * job's folder; a bare name in the job's folder, then on PATH, as Node looks), first as name.com, .exe, .bat or .cmd
 * in each of those folders, then as the name itself: a .cmd or .bat runs through cmd.exe /d /s /c with each argument
 * escaped for cmd, and any other file that is not a program (a shell script, with or without a #! line) runs through
 * Git Bash's bash.exe, its words handed over in the environment, never on a command line. A program, or a word not
 * found, starts as given, as before. Gives { program, args, options } for spawn; throws a plain message for a job it
 * cannot start safely (a shell script with no Git Bash, a cmd.exe argument it cannot carry, a program with no extension).
 */
export function kitWinLaunch(command, { cwd = process.cwd(), env = process.env } = {}) {
  const direct = { program: command[0], args: command.slice(1), options: {} };
  const file = winFind(command[0], cwd, env);
  const extension = file ? extname(file).toLowerCase() : "";
  if (!file || [".exe", ".com"].includes(extension)) return direct;
  if ([".cmd", ".bat"].includes(extension)) return winCmd(file, command.slice(1), env);
  const head = winHead(file);
  // ELF: a Linux program, for a stubbed Windows run on Linux (KIT_BG_PLATFORM=win32).
  if (head.startsWith("\x7fELF")) return direct;
  // A Windows program: Node starts it by a name with an extension, but adds .com or .exe to a name without one, so it
  // never starts this file, even by its full path.
  if (head.startsWith("MZ") && extension) return direct;
  if (head.startsWith("MZ")) throw new Error(`${file} is a Windows program without .exe, which Node cannot start; give it the .exe extension`);
  return winBash(file, command.slice(1), head.startsWith("#!"), env);
}

const winExtensions = [".com", ".exe", ".bat", ".cmd"];
const winPath = env => (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
function winFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}
function winFind(word, cwd, env) {
  if (!word) return null;
  const folders = /[\\/]/.test(word) || isAbsolute(word) ? [cwd] : [cwd, ...winPath(env)];
  // A bare name: programs and .cmd files first, in every folder, as Windows looks, and a file by that name (a script)
  // only after. A name with an extension: that file first, as Node looks, then with a program's or .cmd's extension.
  const extension = extname(word).toLowerCase(), named = winExtensions.map(each => word + each);
  const rounds = winExtensions.includes(extension) ? [[word]] : extension ? [[word], named] : [named, [word]];
  for (const names of rounds) for (const folder of folders) for (const name of names) if (winFile(resolve(folder, name))) return resolve(folder, name);
  return null;
}
function winHead(file) {
  const fd = openSync(file, "r");
  try {
    const bytes = Buffer.alloc(4);
    return bytes.toString("latin1", 0, readSync(fd, bytes, 0, 4, 0));
  } finally { closeSync(fd); }
}

/**
 * Git Bash's bash.exe: on PATH, else beside the git.exe on PATH (Git for Windows puts <Git>\cmd there), else where Git
 * for Windows installs it. WSL's bash.exe (in the Windows folder, or the Store's WindowsApps alias) runs Linux, not Git
 * Bash, and is passed over. Null when there is none.
 */
export function kitWinBash(env = process.env) {
  const windowsFolders = [env.SystemRoot, env.windir].filter(Boolean).map(folder => `${resolve(folder).toLowerCase()}${sep}`);
  const wsl = file => windowsFolders.some(folder => file.toLowerCase().startsWith(folder)) || /[\\/]windowsapps[\\/]/i.test(file);
  const nextToGit = winPath(env).map(folder => join(folder, "git.exe")).filter(winFile).map(git => resolve(dirname(git), "..", "bin", "bash.exe"));
  const installed = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]].filter(Boolean).map(folder => join(folder, "Git", "bin", "bash.exe"));
  if (env.LOCALAPPDATA) installed.push(join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  return [...winPath(env).map(folder => join(folder, "bash.exe")), ...nextToGit, ...installed].find(file => !wsl(file) && winFile(file)) ?? null;
}

// Git Bash reads a Windows command line its own way (it globs bare words and takes ' as a quote), so a job's words
// reach it in KIT_BG_ARG_<n> (KIT_BG_ARGC of them), which this fixed script reads into its words and clears before it
// runs them: a file with a #! line by exec (Git Bash follows the #! line), one without as a bash script.
const winBashWords = 'kit_words=(); for ((kit_i = 0; kit_i < KIT_BG_ARGC; kit_i++)); do kit_name=KIT_BG_ARG_$kit_i; kit_words+=("${!kit_name}"); unset "$kit_name"; done; unset KIT_BG_ARGC;';
function winBash(file, args, shebang, env) {
  const bash = kitWinBash(env);
  if (!bash) throw new Error(`${file} is a shell script, and Windows runs one only through Git Bash, but no bash.exe was found (not on PATH, not beside git.exe, not where Git for Windows installs it); install Git for Windows or put its bin folder on PATH`);
  const words = [file.replaceAll("\\", "/"), ...args];
  const handed = Object.fromEntries(words.map((word, index) => [`KIT_BG_ARG_${index}`, word]));
  const run = `${winBashWords} exec ${shebang ? "" : '"$BASH" '}"\${kit_words[@]}"`;
  return { program: bash, args: ["-c", run], options: { env: { ...env, KIT_BG_ARGC: String(words.length), ...handed } } };
}

// cmd.exe's special characters, each escaped with ^ (the way cross-spawn runs a .cmd: every argument quoted for the
// program's own reading, then every special character escaped, quotes too, so cmd sees no quoted part and no operator).
const cmdSpecial = /([()\][%!^"`<>&|;, *?])/g;
function winCmd(file, args, env) {
  if (args.some(arg => /[\r\n]/.test(arg))) throw new Error(`${file} is a .cmd or .bat job, and cmd.exe cannot take an argument with a line break (it ends the command there)`);
  // The batch file reads each argument in its quotes again (%1, or %* handed on): a " of the argument's own would end
  // that quoted part early and let what follows run as a command, so it is refused; without one, each stays quoted.
  if (args.some(arg => arg.includes('"'))) throw new Error(`${file} is a .cmd or .bat job, and cmd.exe cannot hand it an argument with a double quote safely (the batch file reads its arguments again)`);
  const quoted = args.map(arg => `"${arg.replace(/(\\*)$/, "$1$1")}"`.replace(cmdSpecial, "^$1"));
  const line = [file.replace(cmdSpecial, "^$1"), ...quoted].join(" ");
  return { program: env.ComSpec ?? env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], options: { windowsVerbatimArguments: true } };
}

/**
 * A Windows job's live processes in one snapshot: each root pinned by { pid, started } while it runs, and every
 * descendant of a live one, walked by parent pid. Windows never re-parents a process, and pids are reused, so a child
 * counts only when it started at or after its parent. A process whose parent has ended (and is not a root) is no
 * longer followed, as with taskkill /T: its parent pid may since have been another process's, so it cannot be told
 * apart from that process's child.
 */
export function kitJobTree(processes, roots) {
  const found = new Map();
  const queue = [...roots];
  const byPid = new Map(processes.map(entry => [entry.pid, entry]));
  for (let node; (node = queue.shift());) {
    const holder = byPid.get(node.pid);
    if (holder?.started !== node.started || found.has(node.pid)) continue;
    found.set(node.pid, holder);
    for (const entry of processes)
      if (entry.ppid === node.pid && entry.pid !== node.pid && BigInt(entry.started) >= BigInt(node.started)) queue.push(entry);
  }
  return [...found.values()];
}

/** Whether a process read now is the job's pinned process still: its start time, and on Linux its group and session. */
export function kitJobSame(current, job, started, platform = kitJobPlatform()) {
  if (!current || current.started !== started) return false;
  return platform === "win32" || (current.pgid === job.pgid && current.session === job.pgid);
}

/**
 * Read a process's identity: on Linux { state, pgid, session, started } from /proc, treating zombies and concurrently
 * removed /proc files as dead; on Windows { ppid, started }, alive by process.kill(pid, 0), its start from CIM.
 */
export function kitJobProcess(pid) {
  if (kitJobPlatform() === "win32") {
    if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return null;
    try { process.kill(Number(pid), 0); }
    catch (error) { if (error.code === "ESRCH") return null; if (error.code !== "EPERM") throw error; }
    const found = kitWinProcesses(pid).find(entry => entry.pid === Number(pid));
    return found ? { ppid: found.ppid, started: found.started } : null;
  }
  try {
    const identity = processIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return ["Z", "X"].includes(identity.state) ? null : identity;
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}

/**
 * Pin a job to its original session leader (on Windows, its wrapper process and start time, kept as JSON in the
 * identity record), so stale records never target reused PIDs.
 */
export function kitJob(directory) {
  const pid = Number(kitJobRecord(directory, "pid"));
  if (kitJobPlatform() === "win32") {
    let identity = null;
    try { identity = JSON.parse(kitJobRecord(directory, "identity") ?? "null"); } catch { /* Not a Windows identity. */ }
    if (!Number.isSafeInteger(pid) || pid <= 1 || identity?.pid !== pid || !/^\d+$/.test(identity?.started ?? ""))
      throw new Error(`missing or invalid job records: ${directory}`);
    return { directory, pid, started: identity.started };
  }
  const pgid = Number(kitJobRecord(directory, "pgid"));
  const identity = processIdentity(kitJobRecord(directory, "identity"));
  if (!Number.isSafeInteger(pid) || pid <= 1 || pgid !== pid || !identity ||
      identity.pgid !== pgid || identity.session !== pgid || !/^\d+$/.test(identity.started))
    throw new Error(`missing or invalid job records: ${directory}`);
  return { directory, pid, pgid, started: identity.started };
}

/**
 * The pins from the rulebook's "Who cooks" table: the shared rulebook (docs/kitchen.md in the kit), where a row
 * with the same role in the project's extras (rulebookExtras) wins. Returns { builder, reviewer }; a missing file
 * or row throws one plain line.
 */
export function kitRulebookPins(root = kitRoot(), settings = kitSettings(root)) {
  const rows = new Map();
  const read = (file, label) => {
    let text;
    try { text = readFileSync(file, "utf8"); }
    catch (error) { throw new Error(`cannot read the ${label} ${file}: ${error.code ?? error.message}`); }
    // "Builder, every slice" is the row's name from before the factory cut (TOOLS-235); an extras row may still use it.
    for (const [, role, model] of text.matchAll(/^\| (Builder, every (?:build|slice)|Review, every change) \| `([^`]+)`/gm))
      rows.set(role.startsWith("Builder") ? "builder" : "reviewer", model);
  };
  read(join(kitHome(), "docs/kitchen.md"), "shared rulebook");
  if (settings?.rulebookExtras) read(resolve(root, settings.rulebookExtras), "rulebook extras");
  const builder = rows.get("builder"), reviewer = rows.get("reviewer");
  if (!builder || !reviewer) throw new Error(`the rulebook has no ${builder ? "Review, every change" : "Builder, every build"} pin`);
  return { builder, reviewer };
}

/**
 * The Messages to Lex rule: the lines between the markers of the "Messages to Lex" section of the shared rulebook
 * (docs/kitchen.md), the one source `kit rulebook` prints, `kit brief` carries and `kit init` copies into AGENTS.md.
 * The start marker's "vN" is the rule's version: `kit init` updates a project's copy only to a higher one.
 */
export function kitMessagesToLexRule(home = kitHome()) {
  const file = join(home, "docs/kitchen.md");
  const found = /<!-- messages-to-lex:start v(\d+) -->\n([\s\S]+?)\n<!-- messages-to-lex:end -->/.exec(readFileSync(file, "utf8"));
  if (!found) throw new Error(`the shared rulebook ${file} has no Messages to Lex rule`);
  return { version: Number(found[1]), rule: found[2] };
}

/**
 * The review loop rule: the lines between the markers of the "Review loop" section of the shared rulebook, with the
 * version in its start marker (the brief carries the text; `kit init` points projects at the section).
 */
export function kitReviewLoopRule(home = kitHome()) {
  const file = join(home, "docs/kitchen.md");
  const found = /<!-- review-loop:start v(\d+) -->\n([\s\S]+?)\n<!-- review-loop:end -->/.exec(readFileSync(file, "utf8"));
  if (!found) throw new Error(`the shared rulebook ${file} has no Review loop rule`);
  return { version: Number(found[1]), rule: found[2] };
}

/** Just the rule's text (see kitMessagesToLexRule). */
export function kitMessagesToLex(home = kitHome()) {
  return kitMessagesToLexRule(home).rule;
}

/** A slice's branch: build/<owner>-<ticket slug without its number> (kit brief names it so). */
export function kitSliceBranch(owner, slug) {
  return `build/${owner}-${slug.replace(/\.md$/i, "").replace(/^\d+-/, "")}`;
}

/** Mark a job as a kit go job, the kind the Stop hook (hooks/stop-guard.mjs) holds a turn for. */
export function kitJobMarkGo(directory) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "go"), `${new Date().toISOString()}\n`);
}

export function kitJobRunning(job) {
  return kitJobMembers(job).length > 0;
}

/** Read a session's live group members without ps or command-line matching. */
export function kitJobGroup(pgid) {
  return readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).map(pid => ({ pid: Number(pid), ...kitJobProcess(pid) }))
    .filter(member => member.pgid === pgid && member.session === pgid);
}

/**
 * The start-time pins of a job: its leader, and the members it recorded while its leader was that same process; on
 * Windows also the job's command (the work record its command process writes), so the work is still the job's after
 * the process that started it has ended.
 */
export function kitJobPins(job) {
  let pins = [{ pid: job.pid, started: job.started }];
  const record = kitJobRecord(job.directory, "members");
  if (record !== null) {
    const saved = JSON.parse(record);
    if (saved.started === job.started) pins = pins.concat(saved.members);
  }
  const work = kitJobPlatform() === "win32" ? kitJobRecord(job.directory, "work") : null;
  return work === null ? pins : pins.concat(JSON.parse(work));
}

/**
 * Require an original, start-time-pinned member before trusting the group's current membership. On Windows the job
 * is the process tree below its pins, in one CIM snapshot.
 */
export function kitJobMembers(job) {
  if (kitJobPlatform() === "win32") return kitJobTree(kitWinProcesses(), kitJobPins(job));
  const leader = kitJobProcess(job.pid);
  if (leader && leader.started !== job.started) return [];
  const verified = kitJobPins(job).some(({ pid, started }) => kitJobSame(kitJobProcess(pid), job, started));
  return verified ? kitJobGroup(job.pgid) : [];
}

/** A job's exit status: 0 to 255, or on Windows any 32-bit exit code (exception codes such as 3221225477 too). */
export function kitJobExit(job) {
  const value = kitJobRecord(job.directory, "exit");
  if (value === null) return null;
  const most = kitJobPlatform() === "win32" ? 4294967295 : 255;
  if (!/^\d+$/.test(value) || Number(value) > most) throw new Error(`invalid job exit status: ${value}`);
  return Number(value);
}

const titleWord = word => word.charAt(0).toUpperCase() + word.slice(1);

/** Credit the builder consistently across slice and fix commits. */
export function builderAuthor(model) {
  const alias = /^(opus|sonnet|haiku|fable)$/i.exec(model);
  if (alias) return `Claude ${titleWord(alias[1].toLowerCase())} <noreply@anthropic.com>`;
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d{1,2})(?:-\d{6,8})?(?:\[1m\])?$/i.exec(model);
  if (claude) return `Claude ${titleWord(claude[1].toLowerCase())} ${claude[2]}.${claude[3]} <noreply@anthropic.com>`;
  const gpt = /^gpt-(.+)$/i.exec(model);
  if (gpt) return `GPT-${gpt[1].split("-").map(word => titleWord(word.toLowerCase())).join("-")} <noreply@openai.com>`;
  return `${model} <noreply@${/^(claude-|opus|sonnet|haiku|fable)/i.test(model) ? "anthropic" : "openai"}.com>`;
}

/** Run normal commit hooks on a detached HEAD; atomically publish only the captured branch. */
export function commitBuilderWork({ root, branch, head, message, author, env = process.env }) {
  const run = (args, overrides = {}) => execFileSync("git", ["-C", root, ...args], {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...overrides,
  }).trim();
  const ref = `refs/heads/${branch}`;
  const assertScope = (expected = head) => {
    if (run(["branch", "--show-current"]) !== branch || run(["rev-parse", "HEAD"]) !== expected)
      throw new Error("worktree branch or HEAD changed during commit; refusing stale work");
  };
  assertScope();
  run(["add", "-A"]);
  assertScope();
  // Only HEAD is isolated. Staging and hooks use the worktree's normal index.
  // Git owns all reference locks; no index.lock or HEAD.lock is hand-created.
  const common = run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  const index = resolve(root, run(["rev-parse", "--git-path", "index"]));
  const directory = mkdtempSync(join(tmpdir(), "kit-commit-head-"));
  try {
    writeFileSync(join(directory, "HEAD"), `${head}\n`);
    writeFileSync(join(directory, "commondir"), `${common}\n`);
    const detachedEnv = { ...env, GIT_DIR: directory, GIT_WORK_TREE: root, GIT_INDEX_FILE: index };
    const detached = args => run(args, { env: detachedEnv });
    let failure;
    try { detached(["commit", "-m", message, "-m", `Co-Authored-By: ${author}`]); }
    catch (error) { failure = error; }
    assertScope();
    if (failure) {
      const details = `${failure.stdout || ""}\n${failure.stderr || ""}`.trim();
      throw new Error(/nothing to commit|no changes added/i.test(details) ? "nothing to commit" : `git commit failed: ${details || failure.message}`);
    }
    const next = detached(["rev-parse", "HEAD"]);
    const parents = detached(["rev-list", "--parents", "-n", "1", "HEAD"]).split(/\s+/).slice(1);
    if (detached(["branch", "--show-current"]) || next === head || parents.length !== 1 || parents[0] !== head)
      throw new Error("worktree branch or HEAD changed during commit; expected exactly one detached commit from the captured HEAD");
    // The expected old SHA protects this named ref. Even a switch after the
    // scope check cannot redirect the commit to whichever branch HEAD now names.
    assertScope();
    detached(["update-ref", "--no-deref", "-m", `commit: ${message}`, ref, next, head]);
    assertScope(next);
    return next;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const TOKEN_FIELDS = ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens",
  "inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"];
const tokenSum = usage => TOKEN_FIELDS.reduce((total, field) => total + (Number.isFinite(usage?.[field]) ? usage[field] : 0), 0);

/** Read what a CLI run log reports it cost: Claude/Grok JSON results and Codex "tokens used" lines, summed; else null. */
export function runCost(log) {
  let usd = null, tokens = null;
  const add = (total, value) => (total ?? 0) + value;
  for (const line of String(log).split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let result;
    try { result = JSON.parse(line); } catch { continue; }
    if (!result || typeof result !== "object") continue;
    if (Number.isFinite(result.total_cost_usd)) usd = add(usd, result.total_cost_usd);
    // modelUsage also counts helper models; usage covers the main model only.
    const models = result.modelUsage && typeof result.modelUsage === "object" ? Object.values(result.modelUsage) : [];
    if (models.length) tokens = add(tokens, models.reduce((total, usage) => total + tokenSum(usage), 0));
    else if (result.usage && typeof result.usage === "object") tokens = add(tokens, tokenSum(result.usage));
  }
  for (const match of String(log).matchAll(/^tokens used\b[:\s]*([\d,]+)[ \t]*$/gim)) tokens = add(tokens, Number(match[1].replaceAll(",", "")));
  return usd === null && tokens === null ? null : { usd, tokens };
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The scoreboard map of a ticket: its <maps>/<map>/ folder, else _untracked (also when the project keeps no maps). */
export function scoreMap(ticket, maps) {
  if (maps === undefined) try { maps = kitMaps(); } catch { maps = null; }
  if (!ticket || !maps) return "_untracked";
  return new RegExp(`(?:^|/)${escape(maps)}/([^/]+)/`).exec(ticket)?.[1] || "_untracked";
}

function ticketFacts(file, root) {
  const text = readFileSync(file, "utf8"), front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = name => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(front)?.[1].trim().replace(/^(["'])(.*)\1$/, "$2") ?? null;
  // The build README's table row for this ticket names its size in the column headed Size.
  // A table's header is the row just above its separator row; it holds until the next table.
  let size = null, header = [], previous = [];
  try {
    for (const line of readFileSync(join(dirname(dirname(file)), "README.md"), "utf8").split(/\r?\n/)) {
      if (!line.startsWith("|")) { previous = []; continue; }
      if (/^\|[\s|:-]+\|$/.test(line)) { header = previous; continue; }
      const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
      if (!line.includes(`tickets/${basename(file)})`)) { previous = cells; continue; }
      size = cells[header.indexOf("Size")] || null;
      break;
    }
  } catch { /* No build README: no size. */ }
  return { ticket: relative(root, file), title: field("title"), kind: [field("type"), size].filter(Boolean).join(" ") || null };
}

let scoreFailed = false; // One problem line per command, however many writes fail.

/**
 * Sum reported costs: usd over the runs that priced themselves, with partial: true when some runs
 * reported tokens only (their dollars are unknown, so usd is a floor); null for no runs.
 */
export function costTotal(costs) {
  const known = costs.filter(Boolean);
  if (!known.length) return null;
  const sum = key => known.some(cost => Number.isFinite(cost[key])) ? known.reduce((total, cost) => total + (Number.isFinite(cost[key]) ? cost[key] : 0), 0) : null;
  const usd = sum("usd"), partial = usd !== null && known.some(cost => !Number.isFinite(cost.usd) || cost.partial);
  return { usd, tokens: sum("tokens"), ...(partial ? { partial: true } : {}) };
}

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

// The lock folder names its owner; one whose owner died, or older than ten waits, is taken over.
function takeLock(lock) {
  const wait = Number(process.env.ASE_SCORE_LOCK_MS || 5_000), bound = Number.isFinite(wait) && wait >= 0 ? wait : 5_000;
  const deadline = Date.now() + bound;
  for (;;) {
    let made = false;
    try {
      mkdirSync(lock); made = true;
      writeFileSync(join(lock, "owner"), `${process.pid} ${Date.now()}\n`);
      return;
    } catch (error) {
      // An owner that cannot be written must not leave an ownerless lock behind.
      if (made) { rmSync(lock, { recursive: true, force: true }); throw error; }
      if (error.code !== "EEXIST") throw error;
    }
    let owner = null, seen;
    try { owner = readFileSync(join(lock, "owner"), "utf8"); } catch { /* Not written yet, or just released. */ }
    try { seen = statSync(lock); } catch { continue; }
    const pid = Number(owner?.split(" ")[0]);
    if ((owner !== null && Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) || Date.now() - seen.mtimeMs > 10 * Math.max(bound, 1_000)) {
      // Move the stale lock aside, then remove it only if it is the folder judged stale (same inode);
      // a fresh lock taken meanwhile is put back when its place is still free.
      const aside = `${lock}.stale.${process.pid}.${Date.now()}`;
      try { renameSync(lock, aside); } catch { continue; }
      let moved;
      try { moved = statSync(aside); } catch { continue; }
      if (moved.ino !== seen.ino) {
        try { if (!existsSync(lock)) { renameSync(aside, lock); continue; } } catch { /* Its place was taken. */ }
      }
      rmSync(aside, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`lock ${lock} is held; remove it if no kit command is running`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/**
 * Update one piece's scoreboard record in the main root .scratch/scoreboard/<map>/<ticket-slug>.json
 * (no ticket: _untracked/<branch>.json) with change(record), written atomically. Never throws: a
 * failure prints one `problem: scoreboard …` line per command, so recording cannot fail the command it rides on.
 */
export function kitScore({ ticket, branch, root = kitRoot() }, change) {
  try {
    const file = ticket && resolve(root, ticket);
    const name = file ? basename(file, ".md") : encodeURIComponent(branch || git(["-C", root, "branch", "--show-current"]) || "unknown");
    let maps = null;
    try { maps = kitMaps(kitSettings(root)); } catch { /* No maps: the record is _untracked. */ }
    const path = join(kitMainRoot(), ".scratch/scoreboard", scoreMap(file && relative(root, file), maps), `${name}.json`);
    mkdirSync(dirname(path), { recursive: true });
    // Another worktree (a lead's second-opinion review) may write the same record: lock read to rename.
    const lock = `${path}.lock`;
    takeLock(lock);
    try {
      let saved = {};
      try { saved = JSON.parse(readFileSync(path, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      const record = { ticket: null, title: null, kind: null, builder: null, phases: [], rounds: 0, reviews: [], cost: null, costs: {}, landed: null,
        ...saved, ...(file ? ticketFacts(file, root) : {}) };
      change(record);
      // cost totals what each run reported (costs, keyed by run folder), builder and review apart; never guessed.
      const runs = Object.values(record.costs).filter(Boolean);
      const part = role => costTotal(runs.filter(cost => (cost.role ?? "build") === role));
      record.cost = runs.length ? { build: part("build"), review: part("review") } : null;
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n");
        renameSync(temporary, path);
      } finally { rmSync(temporary, { force: true }); }
    } finally { rmSync(lock, { recursive: true, force: true }); }
  } catch (error) {
    if (!scoreFailed) console.error(`problem: scoreboard ${oneLine(error.message)}`);
    scoreFailed = true;
  }
}

/** Record the cost a run folder's run.log reports, as role build or review, replacing that folder's earlier reading. */
export function scoreCost(record, folder, role = "build") {
  let log;
  try { log = readFileSync(join(folder, "run.log"), "utf8"); } catch { return; }
  const cost = runCost(log);
  if (cost) record.costs[folder] = { role, ...cost };
}

/** Record or refresh one review from its evidence folder: findings.json, else counts read from result.md. */
export function scoreReview(record, folder) {
  let found;
  try { found = JSON.parse(readFileSync(join(folder, "findings.json"), "utf8")); }
  catch {
    let report = "";
    try { report = readFileSync(join(folder, "result.md"), "utf8"); } catch { /* Missing evidence reads as unreadable. */ }
    found = findingsRecord(report, {});
  }
  const entry = { dir: folder, model: found.model ?? null, effort: found.effort ?? null,
    counts: found.unreadable ? null : found.counts, ...(found.unreadable ? { unreadable: true } : {}),
    declined: Array.isArray(found.declined) ? found.declined : [] };
  const index = record.reviews.findIndex(review => review.dir === folder);
  if (index < 0) record.reviews.push(entry); else record.reviews[index] = entry;
  scoreCost(record, folder, "review");
}
