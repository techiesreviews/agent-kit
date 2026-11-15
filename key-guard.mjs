// The key lock (TOOLS-285): an agent the kit starts (a builder or a reviewer) cannot read the machine's key files.
// Briefs carry card text, community ideas included, so a crafted card must not be able to steer a helper into reading
// the Orbit, GitHub, Cloudflare or other keys and sending them out. Keyed steps (push, PR, merge, release, board writes)
// run in the lead's own process: kit pr, kit release and kit ticket, never inside an agent run.
//
// How each CLI is locked:
// - Claude, Grok and OpenCode run inside bubblewrap (bwrap): the whole file system as it is, with every key folder
//   swapped for an empty one and every key file for an unreadable stand-in. What they start (a shell, a test run)
//   inherits the lock.
// - Codex sandboxes its own shell commands with bubblewrap, and one sandbox cannot start inside another, so Codex runs
//   with a permissions profile of its own instead: the whole disk readable but the key paths, write access as before.
// - Every CLI gets an environment without tokens, passwords, agent sockets or the desktop bus.
//
// Known limits, said plainly: an agent's own CLI must read its own login (Claude's ~/.claude/.credentials.json,
// Grok's ~/.grok/auth.json), so its tools can too; Codex hides its own login from its commands. Services on the
// machine's loopback network stay reachable. ASE_KEY_GUARD=off runs without the lock and says so in the run's log.
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, lstatSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

// Key files and folders under HOME, whichever CLI runs.
export const homeKeyPaths = [
  ".config/fleet", ".config/orbit.env", ".config/gh", ".config/hub", ".config/glab-cli", ".config/.wrangler", ".wrangler",
  ".cloudflared", ".config/radaar", ".config/anthropic", ".config/gcloud", ".config/op", ".netrc", ".git-credentials",
  ".config/git/credentials", ".npmrc", ".pypirc", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker/config.json",
  ".password-store", ".local/share/keyrings", ".vault-token", ".terraform.d/credentials.tfrc.json",
  // Lex's Claude config holds MCP servers' Authorization headers (Orbit's among them); Claude runs fine without it.
  ".claude.json", ".claude/.claude.json",
];

// Each CLI's own login and config: hidden from the others' runs. A CLI's own entry stays readable to itself (it must
// sign in); Codex hides its own from its commands through its profile.
export const cliKeyPaths = {
  claude: [".claude/.credentials.json"],
  codex: [".codex/auth.json", ".codex/config.toml"],
  grok: [".grok/auth.json", ".grok/config.toml"],
  opencode: [".local/share/opencode/auth.json", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc"],
};

// Under XDG_CONFIG_HOME when it is set somewhere else than ~/.config.
const configKeyNames = ["fleet", "orbit.env", "gh", "hub", "glab-cli", ".wrangler", "radaar", "anthropic", "gcloud", "op", "git/credentials"];

// Names of variables that carry a secret: TOKEN, SECRET, PASSWORD, API_KEY … as a whole word between underscores.
// GIT_AUTHOR_NAME keeps (AUTHOR is not AUTH).
const secretName = /(^|_)(TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASE|API_?KEYS?|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|COOKIES?)($|_)/i;
// Sockets and handles that lead to keys or to programs outside the lock.
const handleNames = ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID"];
// The CLI's own sign-in, kept for that CLI only.
const ownLogin = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  grok: ["XAI_API_KEY", "GROK_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
};

/** Whether the lock is on: anything but ASE_KEY_GUARD=off. */
export function keyGuardOn(env = process.env) {
  return String(env.ASE_KEY_GUARD ?? "").toLowerCase() !== "off";
}

/** The variables an agent run must not get, as {name: undefined} (undefined removes a variable for the call). */
export function scrubbedEnv(cli, env = process.env, { apiRoute = false } = {}) {
  const keep = new Set(ownLogin[cli] ?? []);
  // The API route's wrapper reads the key file itself and drops the variable before claude starts.
  if (cli === "claude" && apiRoute) keep.add("KIT_API_KEY_FILE");
  return Object.fromEntries(Object.keys(env)
    .filter(name => !keep.has(name) && (secretName.test(name) || handleNames.includes(name)))
    .map(name => [name, undefined]));
}

function home(env) {
  return env.HOME || homedir();
}

/**
 * Every path the run must not read, absolute and without duplicates: the key list, the other CLIs' logins, extra
 * paths from KIT_KEY_PATHS (separated by the system's path separator, absolute only), the desktop's runtime folder
 * (agent sockets, the keyring, the session bus, systemd's user manager) and terminal and X sockets in /tmp.
 * Missing paths are included; existingPaths keeps the ones there now.
 */
export function lockedPaths(cli, env = process.env, { apiRoute = false } = {}) {
  const base = home(env);
  const paths = homeKeyPaths.map(path => join(base, path));
  for (const [other, list] of Object.entries(cliKeyPaths)) {
    // Codex's own login and config are hidden from its commands (its profile); the API route signs Claude in with a key.
    if (other !== cli || cli === "codex" || (cli === "claude" && apiRoute)) paths.push(...list.map(path => join(base, path)));
  }
  if (env.CODEX_HOME) paths.push(join(env.CODEX_HOME, "auth.json"), join(env.CODEX_HOME, "config.toml"));
  if (env.XDG_CONFIG_HOME && resolve(env.XDG_CONFIG_HOME) !== join(base, ".config")) paths.push(...configKeyNames.map(name => join(env.XDG_CONFIG_HOME, name)));
  if (cli === "claude" && apiRoute && env.KIT_API_KEY_FILE?.startsWith("/")) paths.push(env.KIT_API_KEY_FILE);
  for (const extra of String(env.KIT_KEY_PATHS ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (extra.startsWith("/")) paths.push(extra);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const runtime = env.XDG_RUNTIME_DIR || (uid === null ? "" : `/run/user/${uid}`);
  if (runtime.startsWith("/")) paths.push(runtime);
  if (uid !== null) paths.push(`/tmp/tmux-${uid}`, "/run/screen", "/tmp/.X11-unix");
  return [...new Set(paths.map(path => resolve(path)))];
}

/** The paths that exist now (a dangling link counts). Codex's sandbox refuses to start on a missing one whose folder is missing too. */
export function existingPaths(paths) {
  return paths.filter(path => { try { lstatSync(path); return true; } catch { return false; } });
}

// A path and the ones inside it: a masked folder hides what is inside, so only the outermost is mounted.
function inside(path, folder) {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * bubblewrap's arguments before "--": the file system as it is (devices included), each existing key folder swapped
 * for an empty one and each existing key file (or socket) for /dev/null, which bwrap mounts without devices so opening
 * it is refused. A path inside an already masked folder is left out.
 */
export function bwrapArgs(paths) {
  const args = ["--dev-bind", "/", "/"];
  const masked = [];
  for (const path of [...paths].sort((a, b) => a.length - b.length)) {
    if (masked.some(folder => inside(path, folder))) continue;
    let kind;
    try { lstatSync(path); kind = statSync(path).isDirectory() ? "dir" : "file"; }
    catch { continue; }
    if (kind === "dir") { args.push("--tmpfs", path); masked.push(path); }
    else args.push("--ro-bind", "/dev/null", path);
  }
  return args;
}

// TOML strings for Codex's -c values: JSON strings are valid TOML basic strings.
const toml = JSON.stringify;

/**
 * Codex's permissions profile as -c options, in place of -s: reads anywhere but the locked paths; a build also writes
 * the worktree, the temp folders and the Git common folder, with network on (as before); a review writes nothing and
 * has no network.
 */
export function codexProfile(kind, common, paths) {
  const name = kind === "build" ? "kit-build" : "kit-review";
  const entries = [`":root"="read"`];
  if (kind === "build") entries.push(`":project_roots"={"."="write"}`, `":tmpdir"="write"`, `":slash_tmp"="write"`, `${toml(common)}="write"`);
  for (const path of paths) entries.push(`${toml(path)}="none"`);
  return ["-c", `default_permissions=${toml(name)}`, "-c", `permissions.${name}.filesystem={${entries.join(",")}}`,
    "-c", `permissions.${name}.network={enabled=${kind === "build"}}`];
}

// Whether command names an executable file: a path as it is, a bare name in a folder of PATH.
function onPath(command, env) {
  const executable = file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
  if (command.includes("/")) return executable(command);
  return String(env.PATH ?? "").split(":").some(folder => folder && executable(join(folder, command)));
}

let probed;
/** Whether bubblewrap runs here; checked once per process. bwrap is looked up on PATH. */
export function bwrapWorks(env = process.env) {
  if (probed === undefined) {
    const result = spawnSync("bwrap", ["--dev-bind", "/", "/", "--", "true"], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15_000 });
    probed = result.status === 0 ? null : result.error?.code === "ENOENT" ? "bubblewrap (bwrap) is not installed"
      : `bubblewrap (bwrap) cannot start here: ${String(result.stderr ?? result.error?.message ?? "").trim().split("\n").at(-1) || `exit ${result.status}`}`;
  }
  return probed;
}

/**
 * The lock for one agent run, or {off: true} with ASE_KEY_GUARD=off. Throws in plain words when the lock is on and
 * cannot be set up (no bubblewrap for a CLI that needs it). `close()` removes the run's private folder.
 *  - env: variables to drop for the call;
 *  - wrap(command, args): the command and arguments that run it inside the lock (Claude, Grok, OpenCode);
 *  - codex: Codex's -c profile options;
 *  - claudeGuard: for the API route, a script the wrapper runs claude through once it has read its key.
 */
export function keyGuard({ cli, kind, common, env = process.env, apiRoute = false }) {
  if (!keyGuardOn(env)) return { off: true, env: {}, wrap: (command, args) => [command, args], close() {} };
  const paths = lockedPaths(cli, env, { apiRoute });
  const scrub = scrubbedEnv(cli, env, { apiRoute });
  if (cli === "codex") return { env: scrub, codex: codexProfile(kind, common, existingPaths(paths)), wrap: (command, args) => [command, args], close() {} };
  const problem = bwrapWorks(env);
  if (problem) throw new Error(`cannot lock the key files for this ${kind}: ${problem}; install bubblewrap, or set ASE_KEY_GUARD=off to run without the lock`);
  // With the API route the wrapper turns on Claude's own command sandbox (bubblewrap too), which cannot start inside
  // this one: a build would lose its shell. Reviews there use only Read, Grep and Glob, with that sandbox off.
  if (apiRoute && kind === "build") throw new Error("cannot lock the key files for a build on the API route: its Claude sandbox cannot start inside the lock; build on the subscription (unset KIT_API_KEY_FILE), or set ASE_KEY_GUARD=off to run without the lock");
  const outer = bwrapArgs(paths);
  // A CLI that is not installed is started as it is, so the run still fails as a missing CLI (spawn ENOENT), which kit
  // review counts as an unavailable reviewer; nothing runs, so there is nothing to lock.
  if (!apiRoute) return { env: scrub, wrap: (command, args) => onPath(command, env) ? ["bwrap", [...outer, "--", command, ...args]] : [command, args], close() {} };
  // The API route's wrapper reads its key file first, outside the lock, then runs claude through this script.
  const dir = mkdtempSync(join(tmpdir(), "ase-key-guard-"));
  const script = join(dir, "guard");
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  writeFileSync(script, `#!/bin/sh\nexec bwrap ${outer.map(quote).join(" ")} -- "$@"\n`);
  chmodSync(script, 0o700);
  return { env: { ...scrub, KIT_CLAUDE_GUARD: script }, wrap: (command, args) => [command, args], claudeGuard: script,
    close() { rmSync(dir, { recursive: true, force: true }); } };
}

/** For tests: forget the bubblewrap probe. */
export function resetBwrapProbe() {
  probed = undefined;
}
