// The key lock (TOOLS-285): an agent the kit starts through agent-run.mjs (a kit go build, a kit review or kit ux
// reviewer, a second look) cannot read the machine's key files. Briefs carry card text, community ideas included, so a
// crafted card must not be able to steer such an agent into reading the Orbit, GitHub, Cloudflare or other keys and
// sending them out. Keyed steps (push, PR, merge, release, board reads and writes, deploys) run in the lead's own
// process. A helper thread T3 starts (delegate_task) is not started by the kit and is outside this lock.
//
// How each CLI is locked:
// - Claude, Grok and OpenCode run inside bubblewrap (bwrap): the whole file system as it is, with every key folder
//   swapped for an empty one and every key file for an unreadable stand-in. What they start (a shell, a test run)
//   inherits the lock.
// - Codex sandboxes its own shell commands with bubblewrap, and one sandbox cannot start inside another, so Codex runs
//   with a permissions profile of its own instead: the whole disk readable but the key paths, write access as before.
// - Every CLI gets an environment without tokens, passwords, agent sockets or the desktop bus.
//
// Inside bubblewrap an agent still sees the machine's process list, so the kit's own locks keep working with real
// process ids. The kernel refuses it another process's environment, open files and root folder (/proc/<pid>/environ,
// fd, root): unprivileged bwrap puts it in a user namespace of its own, and reading a process in another namespace takes
// a capability there (the kernel's ptrace access check). bwrapWorks tries exactly that read at start-up and refuses to
// lock where it works (a setuid bwrap, which makes no user namespace).
//
// Known limits, said plainly: an agent's own CLI must read its own login (Claude's ~/.claude/.credentials.json,
// Grok's ~/.grok/auth.json), so its tools can too; Codex hides its own login from its commands. Services on the
// machine's loopback network and abstract sockets stay reachable. The display's X socket is one of them: the hidden
// cookie keeps it shut where the display asks for one; where it lets the user in without one, the start-up probe says
// so as a warning (kit doctor, the run's log) and the lock stays on.
// ASE_KEY_GUARD=off runs without the lock and says so in the run's log. Bubblewrap exists on Linux only: on another
// system (macOS, Windows) Claude, Grok and OpenCode run without it and can read the key files, which the run's log and
// kit doctor say in one line; the token variables are still dropped and Codex keeps its own profile, neither of which
// needs bubblewrap. ASE_KEY_GUARD=on stops such a run instead. On Linux a missing bubblewrap stops the run, as a broken
// one does: it installs with one command.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, copyFileSync, fstatSync, globSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Key files and folders under HOME, whichever CLI runs.
export const homeKeyPaths = [
  ".config/fleet", ".config/orbit.env", ".config/gh", ".config/hub", ".config/glab-cli", ".config/.wrangler", ".wrangler",
  ".cloudflared", ".config/radaar", ".config/anthropic", ".config/gcloud", ".config/op", ".netrc", ".git-credentials",
  ".config/git/credentials", ".npmrc", ".pypirc", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker/config.json",
  ".password-store", ".local/share/keyrings", ".vault-token", ".terraform.d/credentials.tfrc.json",
  // More registry and cloud logins, each one token file: Podman's (Docker's twin), rclone, cargo, RubyGems, Kaggle,
  // DigitalOcean, Fly, Netlify, Vercel, Hugging Face. A store not listed here goes in KIT_KEY_PATHS.
  ".config/containers/auth.json", ".config/rclone/rclone.conf", ".cargo/credentials.toml", ".cargo/credentials", ".gem/credentials",
  ".kaggle/kaggle.json", ".config/doctl/config.yaml", ".fly/config.yml", ".config/netlify/config.json",
  ".local/share/com.vercel.cli/auth.json", ".cache/huggingface/token",
  // The display's cookie: with it a program could type into the lead's terminal, outside the lock.
  ".Xauthority",
  // Lex's Claude config holds MCP servers' Authorization headers (Orbit's among them); Claude runs fine without it.
  ".claude.json", ".claude/.claude.json",
];

// Each CLI's own login and config: hidden from the others' runs. A CLI's own entry stays readable to itself (it must
// sign in); Codex hides its own from its commands through its profile.
export const cliKeyPaths = {
  claude: [".claude/.credentials.json"],
  codex: [".codex/auth.json", ".codex/config.toml"],
  grok: [".grok/auth.json", ".grok/config.toml"],
  // OpenCode 2 keeps its keys in opencode.db (with its journals) beside the older auth.json: the whole data folder.
  opencode: [".local/share/opencode", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc"],
};
// Claude's own settings can hold a token too (an `env` value such as ANTHROPIC_AUTH_TOKEN, an apiKeyHelper): hidden
// from the other CLIs' runs, never from Claude's own (its hooks and permissions are there), on the API route as well.
const claudeSettings = "settings.json";

// Files a tool needs that may also hold a key: a git config with a token in a remote's URL, a shell start-up file that
// sets a token. Each is locked only when it holds one, since git and the shell read them on every run.
const keyedConfigs = [".gitconfig", ".config/git/config"];
const shellStartups = [".bashrc", ".bash_aliases", ".bash_profile", ".bash_login", ".profile", ".zshenv", ".zshrc", ".zprofile", ".config/fish/config.fish"];
// A git config that holds a key: a URL with a user part on http(s) (a token as the user) or a password on ssh and git
// (a user there is a login name: ssh://git@…, Gerrit's ssh://lex@…), an Authorization extra header, or a credential
// helper written inline with a password.
const keyedUrl = text => [...text.matchAll(/([a-z][a-z0-9+.-]*):\/\/([^/\s@]+)@/gi)]
  .some(([, scheme, user]) => !/^(ssh|git)$/i.test(scheme) || user.includes(":"))
  || /^\s*extraheader\s*=.*authorization/im.test(text) || /^\s*helper\s*=.*password=/im.test(text);
// A start-up file that sets a variable the secret list (secretName) drops: every NAME= in it, commented or not,
// fish's `set … NAME value` and its universal SETUVAR NAME:value. The name may stand in quotes (export "NAME=value",
// export "NAME"=value), the = may add or give a default (NAME+=value, ${NAME:=value}), and anything may stand before
// the name but a letter or a $ (which reads the variable): an option that carries a token (--token=…) counts too.
// fish's set may follow another command on its line. Names that only point somewhere (SSH_AUTH_SOCK,
// PASSWORD_STORE_DIR, …_FILE, …_PATH) are no secret, so they do not lock the file.
const pointer = name => handleNames.includes(name) || keyFolderVariables.includes(name) || /_(SOCK|FILE|DIR|PATH|HOME)$/i.test(name);
const setsSecret = text => [
  ...[...text.matchAll(/(?<![\w$])["']?([A-Za-z_]\w*)["']?(?:\[[^\]\n]*\])?[+:]?=/g)].map(match => match[1]),
  ...[...text.matchAll(/(?<![\w$-])set[ \t]+(?:-\S+[ \t]+)*["']?([A-Za-z_]\w*)["']?[ \t]+\S/g)].map(match => match[1]),
  ...[...text.matchAll(/^SETUVAR\s+(?:--\S+\s+)*([A-Za-z_]\w*):/gm)].map(match => match[1]),
].some(name => secretName.test(name) && !pointer(name));
function holds(file, test) {
  try { return statSync(file).isFile() && test(readFileSync(file, "utf8")); } catch { return false; }
}
function text(file) {
  try { return statSync(file).isFile() ? readFileSync(file, "utf8") : ""; } catch { return ""; }
}
// A shell file pulling in another: `source` or `.` as a command of its own, at the start of a line or after what can
// stand before a command (a test with && or ||, a ;, then, do, else, an opening brace or bracket). The path ends at a
// blank or at what ends a command; quotes are taken off by expand.
const sourced = /(?:^|&&|\|\||[;({]|\b(?:then|do|else))\s*(?:source|\.)\s+("[^"\n]*"|'[^'\n]*'|[^\s;&|)}]+)/gm;
// A path as a config file writes it: ~ and $HOME are the home, a relative one counts from `from`.
const expand = (path, base, from) => resolve(from, (/^"[\s\S]*"$/.test(path) ? path.slice(1, -1).replace(/\\(.)/g, "$1") : path.replace(/^["']|["']$/g, "")).replace(/^~(?=\/|$)/, base).replace(/^\$(HOME|\{HOME\})(?=\/|$)/, base));
// A git include (include.path, includeIf's path): the whole value as git reads it, so a path with a space counts in
// full (SL-1, TOOLS-303): a quoted value up to its closing quote, a bare one up to a comment or the line's end.
const gitIncludePath = /^[ \t]*path[ \t]*=[ \t]*("(?:[^"\\\n]|\\.)*"|[^\n#;]*[^\s#;])/gim;
// The files a set of config files pull in, however long the chain: `source`/`.` for shell files, include paths for
// git. Each file is read once, so a loop ends, and a chain ends where a file names nothing new that exists. A relative
// path counts from every folder `from` gives for the file that names it: that file's own folder for git; for a shell
// the folders it may run in (see lockedPaths), since a shell reads `source ./x.env` from where it runs.
function pulledIn(files, pattern, base, from = file => [dirname(file)]) {
  const all = [...new Set(files)];
  for (let next = 0; next < all.length; next++) {
    for (const match of text(all[next]).matchAll(pattern)) {
      for (const folder of from(all[next])) {
        const file = expand(match[1], base, folder);
        if (!all.includes(file)) all.push(file);
      }
    }
  }
  return all;
}

// Variables naming a tool's key file or folder.
const keyFolderVariables = ["GOOGLE_APPLICATION_CREDENTIALS", "GH_CONFIG_DIR", "GNUPGHOME", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "DOCKER_CONFIG", "KUBECONFIG",
  "CLOUDSDK_CONFIG", "NPM_CONFIG_USERCONFIG", "WRANGLER_HOME", "PASSWORD_STORE_DIR", "NETRC"];

// Under XDG_CONFIG_HOME when it is set somewhere else than ~/.config.
const configKeyNames = ["fleet", "orbit.env", "gh", "hub", "glab-cli", ".wrangler", "radaar", "anthropic", "gcloud", "op", "git/credentials",
  "containers/auth.json", "rclone/rclone.conf", "doctl/config.yaml", "netlify/config.json"];

// Names of variables that carry a secret: TOKEN, SECRET, PASSWORD, API_KEY … as a whole word between underscores.
// GIT_AUTHOR_NAME keeps (AUTHOR is not AUTH).
const secretName = /(^|_)(TOKENS?|SECRETS?|PASSWORDS?|PASSWD|PASSPHRASE|API_?KEYS?|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|AUTH|COOKIES?|PAT)($|_)/i;
// A value that carries a secret in a URL's user part (DATABASE_URL=postgres://app:password@db, or a token as the user:
// https://ghp_…@github.com). Proxy variables keep theirs: the CLI needs the proxy to reach its own service at all.
const urlPassword = /[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i;
const proxyName = /^(https?|all|ftp|no)_proxy$/i;
// Variables naming a start-up file a shell reads before its script: dropped for a run, as a file the lead's shell may
// have set a token in, or a build may have written (TOOLS-303); the file itself is locked like the others when it sets one.
const startupVariables = ["BASH_ENV", "ENV"];
// Sockets and handles that lead to keys or to programs outside the lock.
const handleNames = ["SSH_AUTH_SOCK", "GPG_AGENT_INFO", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "DISPLAY", "WAYLAND_DISPLAY",
  "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID"];
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

// ASE_KEY_GUARD=on asks for the lock or no run: a system without bubblewrap then stops the run instead of running it unwrapped.
const lockRequired = env => String(env.ASE_KEY_GUARD ?? "").toLowerCase() === "on";

// The entries of KIT_KEY_PATHS, separated by the system's path separator.
const extraKeyPaths = env => String(env.KIT_KEY_PATHS ?? "").split(delimiter).filter(Boolean);

/**
 * KIT_KEY_PATHS entries that are not full paths, in plain words, or null. Such an entry is not locked (a relative one
 * could mean several folders), so the lock says so (the run's log, kit doctor) where it used to skip it silently.
 */
export function keyPathsWarning(env = process.env) {
  const bad = extraKeyPaths(env).filter(path => !isAbsolute(path));
  if (!bad.length) return null;
  const names = bad.map(path => `'${path}'`).join(", ");
  return bad.length === 1 ? `KIT_KEY_PATHS entry ${names} is not a full path, so it is not locked; write it from / on`
    : `KIT_KEY_PATHS entries ${names} are not full paths, so they are not locked; write them from / on`;
}

/**
 * The variables an agent run must not get, as {name: undefined} (undefined removes a variable for the call). OpenCode
 * also keeps the key of the provider its model names (openrouter/… keeps OPENROUTER_API_KEY).
 */
export function scrubbedEnv(cli, env = process.env, { apiRoute = false, model = "" } = {}) {
  const keep = new Set(ownLogin[cli] ?? []);
  const provider = cli === "opencode" ? /^([a-z0-9][a-z0-9-]*)\//i.exec(model)?.[1] : null;
  if (provider) keep.add(`${provider.replaceAll("-", "_").toUpperCase()}_API_KEY`);
  // The API route's wrapper reads the key file itself and drops the variable before claude starts.
  if (cli === "claude" && apiRoute) keep.add("KIT_API_KEY_FILE");
  return Object.fromEntries(Object.keys(env)
    .filter(name => !keep.has(name) && (secretName.test(name) || handleNames.includes(name) || startupVariables.includes(name) || (!proxyName.test(name) && urlPassword.test(String(env[name] ?? "")))))
    .map(name => [name, undefined]));
}

function home(env) {
  return env.HOME || homedir();
}

// Saved build sessions live under the kit's state folder so resumes survive reboots while staying outside the worktree.
function fenceStateDir(env) {
  return join(isAbsolute(env.XDG_STATE_HOME ?? "") ? env.XDG_STATE_HOME : join(home(env), ".local/state"), "agent-kit", "fence");
}

const fenceFolderPattern = /^ase-write-fence-[A-Za-z0-9]{6}$/;
const sessionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function claudeProjectKey(folder) {
  return resolve(folder).replace(/[^A-Za-z0-9-]/g, "-");
}

function copyRegularTree(from, to, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = readdirSync(from, { withFileTypes: true }); } catch { return; }
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    const src = join(from, entry.name), dst = join(to, entry.name);
    let info;
    try { info = lstatSync(src); } catch { continue; }
    if (info.isSymbolicLink()) continue;
    if (info.isFile()) {
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      chmodSync(dst, 0o600);
    } else if (info.isDirectory()) copyRegularTree(src, dst, depth + 1);
  }
}

// On first resume of a Claude build started before the write fence (no cli-state yet), copy only the requested
// session's transcript (and its session subdirectory, e.g. tool-results) from the original Claude folder into the new
// private state. Never copy other sessions, other projects, symlinks or unrelated config files.
function migrateClaudeSession(source, target, worktree, session) {
  if (typeof session !== "string" || !sessionIdPattern.test(session) || session.includes("..")) return;
  const sourceProjects = join(source, "projects");
  try { if (!statSync(sourceProjects).isDirectory()) return; } catch { return; }
  const keys = [...new Set([resolve(worktree), real(worktree)].filter(Boolean).map(claudeProjectKey))];
  for (const key of keys) {
    const srcProject = join(sourceProjects, key);
    let projectInfo;
    try { projectInfo = lstatSync(srcProject); } catch { continue; }
    if (!projectInfo.isDirectory()) continue;
    const srcTranscript = join(srcProject, `${session}.jsonl`);
    const srcSessionDir = join(srcProject, session);
    let hasTranscript = false, hasSessionDir = false;
    try { hasTranscript = lstatSync(srcTranscript).isFile(); } catch { /* Missing. */ }
    try { hasSessionDir = lstatSync(srcSessionDir).isDirectory(); } catch { /* Missing. */ }
    if (!hasTranscript && !hasSessionDir) continue;
    const destProject = join(target, "projects", key);
    mkdirSync(destProject, { recursive: true, mode: 0o700 });
    if (hasTranscript) {
      const dstTranscript = join(destProject, `${session}.jsonl`);
      copyFileSync(srcTranscript, dstTranscript, constants.COPYFILE_EXCL);
      chmodSync(dstTranscript, 0o600);
    }
    if (hasSessionDir) copyRegularTree(srcSessionDir, join(destProject, session));
  }
}

function canonicalStatePointer(state) {
  return join(real(dirname(state)), basename(state));
}

function readFenceOwner(ownerFile) {
  try {
    const info = lstatSync(ownerFile);
    if (!info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid())) return null;
    const parsed = JSON.parse(readFileSync(ownerFile, "utf8"));
    return typeof parsed?.state === "string" && typeof parsed?.worktree === "string" ? parsed : null;
  } catch { return null; }
}

/**
 * Remove validated saved build sessions whose owner record belongs to a removed worktree.
 */
export function removeFenceSessions(worktree, env = process.env) {
  const target = real(worktree), parent = real(fenceStateDir(env));
  let names = [];
  try { names = readdirSync(parent); } catch { return; }
  for (const entry of names) {
    if (!entry.endsWith(".owner")) continue;
    const name = entry.slice(0, -".owner".length);
    if (!fenceFolderPattern.test(name)) continue;
    const ownerFile = join(parent, entry), dir = join(parent, name);
    const owner = readFenceOwner(ownerFile);
    if (!owner || owner.worktree !== target) continue;
    let removeOwner = false;
    try {
      const saved = lstatSync(dir);
      if (saved.isDirectory() && realpathSync(dir) === dir && (typeof process.getuid !== "function" || saved.uid === process.getuid())) {
        rmSync(dir, { recursive: true, force: true });
        removeOwner = true;
      }
    } catch (error) { if (error.code === "ENOENT") removeOwner = true; }
    if (removeOwner) rmSync(ownerFile, { force: true });
  }
}

/**
 * Every path the run must not read, absolute and without duplicates: the key list, the other CLIs' logins, extra
 * paths from KIT_KEY_PATHS (separated by the system's path separator, full paths only: keyPathsWarning names the rest), the desktop's runtime folder
 * (agent sockets, the keyring, the session bus, systemd's user manager) and terminal and X sockets in /tmp.
 * Missing paths are included; existingPaths keeps the ones there now.
 */
export function lockedPaths(cli, env = process.env, { apiRoute = false, cwd = process.cwd() } = {}) {
  const base = home(env);
  const paths = [];
  // Every reading of a path a variable names: a relative one is read both from the folder the agent runs in (the
  // worktree, as its own tools would) and from the lead's (as the lead's tools find it); none for an empty one.
  const named = value => value ? [...new Set([resolve(cwd, value), resolve(process.cwd(), value)])] : [];
  paths.push(...homeKeyPaths.map(path => join(base, path)));
  const gitConfigs = [...keyedConfigs.map(path => join(base, path)), ...named(env.GIT_CONFIG_GLOBAL),
    ...named(env.XDG_CONFIG_HOME).map(folder => join(folder, "git/config"))];
  const fishFolders = [join(base, ".config/fish"), ...named(env.XDG_CONFIG_HOME).map(folder => join(folder, "fish"))];
  const fishFiles = fishFolders.flatMap(folder => {
    let parts = [];
    try { parts = readdirSync(join(folder, "conf.d")).filter(name => name.endsWith(".fish")).map(name => join(folder, "conf.d", name)); } catch { /* None. */ }
    return [join(folder, "config.fish"), join(folder, "fish_variables"), ...parts];
  });
  const startups = [...shellStartups.map(path => join(base, path)), ...fishFiles,
    ...named(env.ZDOTDIR).flatMap(folder => [".zshenv", ".zshrc", ".zprofile"].map(name => join(folder, name))),
    // The file every non-interactive bash (BASH_ENV) or sh (ENV) reads first (TOOLS-303).
    ...startupVariables.flatMap(name => named(env[name]))];
  // Files they pull in count the same: a git include (include.path, includeIf), a shell `source` or `.`.
  const allGit = pulledIn(gitConfigs, gitIncludePath, base);
  // A shell reads a relative `source ./x.env` from the folder it runs in, whichever file names it: HOME for a login
  // shell, the worktree for a shell the agent starts there, the lead's own folder; the naming file's folder stays as
  // one more reading (a start-up file that changes into its own folder first).
  const shellFolders = file => [...new Set([base, resolve(cwd), process.cwd(), dirname(file)])];
  paths.push(...allGit.filter(file => holds(file, keyedUrl)), ...pulledIn(startups, sourced, base, shellFolders).filter(file => holds(file, setsSecret)));
  // Private keys named by git's sshCommand -i or ssh's IdentityFile, wherever they sit.
  for (const file of allGit) for (const [, key] of text(file).matchAll(/sshCommand\s*=.*\s-i\s*(\S+)/gm)) paths.push(expand(key, base, base));
  for (const [, key] of text(join(base, ".ssh/config")).matchAll(/^\s*IdentityFile\s+(\S+)/gim)) paths.push(expand(key, base, base));
  for (const [other, list] of Object.entries(cliKeyPaths)) {
    // Codex's own login and config are hidden from its commands (its profile); the API route signs Claude in with a key.
    if (other !== cli || cli === "codex" || (cli === "claude" && apiRoute)) paths.push(...list.map(path => join(base, path)));
  }
  if (cli !== "claude") paths.push(join(base, ".claude", claudeSettings));
  // A relative CODEX_HOME is read from both folders, as any variable's path (SL-2, TOOLS-303).
  for (const folder of named(env.CODEX_HOME)) paths.push(join(folder, "auth.json"), join(folder, "config.toml"));
  // Claude's moved config folder: its MCP config for every CLI, its login and settings for the others.
  for (const folder of named(env.CLAUDE_CONFIG_DIR)) {
    paths.push(join(folder, ".claude.json"));
    if (cli !== "claude" || apiRoute) paths.push(join(folder, ".credentials.json"));
    if (cli !== "claude") paths.push(join(folder, claudeSettings));
  }
  // OpenCode's data folder where XDG_DATA_HOME moves it, and a database OPENCODE_DB names (with its journals).
  if (cli !== "opencode") {
    paths.push(...named(env.XDG_DATA_HOME).map(folder => join(folder, "opencode")));
    paths.push(...named(env.OPENCODE_DB).flatMap(db => ["", "-wal", "-shm", "-journal"].map(end => db + end)));
  }
  // kit review's own Codex home (a temporary folder whose auth.json links the real login, which Codex may swap for a
  // refreshed file mid-run) is hidden whole from its commands: the link and whatever replaces it.
  if (cli === "codex" && env.CODEX_HOME && resolve(env.CODEX_HOME) !== join(base, ".codex") && inside(resolve(env.CODEX_HOME), resolve(tmpdir()))) paths.push(env.CODEX_HOME);
  // Tools that keep their keys where a variable says (gh's GH_CONFIG_DIR among them, which the kit itself sets).
  // KUBECONFIG holds a list of files.
  for (const name of keyFolderVariables) for (const path of String(env[name] ?? "").split(name === "KUBECONFIG" ? delimiter : "\0")) paths.push(...named(path));
  // Agent sockets wherever they are: dropping the variable hides the name, not the socket.
  paths.push(...named(env.SSH_AUTH_SOCK));
  for (const [, path] of String(env.DBUS_SESSION_BUS_ADDRESS ?? "").matchAll(/(?:^|[,;:])path=([^,;]+)/g)) paths.push(...named(path));
  if (env.XDG_CONFIG_HOME && resolve(env.XDG_CONFIG_HOME) !== join(base, ".config")) {
    paths.push(...configKeyNames.map(name => join(env.XDG_CONFIG_HOME, name)));
    // The CLIs' own settings there too (OpenCode's), but the run's own.
    for (const [other, list] of Object.entries(cliKeyPaths)) {
      if (other !== cli) paths.push(...list.filter(path => path.startsWith(".config/")).map(path => join(env.XDG_CONFIG_HOME, path.slice(".config/".length))));
    }
  }
  // The API key file, for every CLI: the API route's wrapper reads it before claude starts inside the lock.
  paths.push(...named(env.KIT_API_KEY_FILE));
  // The display's cookie wherever the session keeps it (older SDDM: /tmp/xauth_…).
  paths.push(...named(env.XAUTHORITY));
  paths.push(...extraKeyPaths(env).filter(path => isAbsolute(path)));
  paths.push(real(fenceStateDir(env)));
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

/**
 * The paths plus what their links point at, and what the lock cannot hide. A link inside a key folder (a dotfiles setup:
 * ~/.config/gh/hosts.yml -> ~/dotfiles/gh/hosts.yml, or .config/.wrangler/config -> a dotfiles folder) names a file or
 * folder the folder's mask does not cover, so its target is locked too, and a linked folder is searched the same way.
 * Each real folder is searched once, so a loop of links ends. A folder target that holds one of `keep` (HOME, the
 * worktree, its Git folder) or lies in a system folder cannot be hidden without breaking the run: it is returned in
 * `unsafe`; a folder that cannot be listed (it could hide a link) in `unlisted`. A search past `limit` entries in all stops and says so in `tooLarge` (the key path it was searching), since a
 * search cut short could miss a link. Folders in `skip` (the runtime folder, terminal and X sockets: sockets, not keys)
 * are not searched, nor is a link that leads into one (it is masked whole already).
 */
export function linkTargets(paths, { skip = [], keep = [], limit = 200_000 } = {}) {
  const found = [...paths], unsafe = [], unlisted = [];
  let tooLarge = null, count = 0, searching = null;
  const roots = ["/", "/var", "/home", "/tmp", "/run", "/proc", "/sys", "/dev", "/nix", "/snap"];
  const system = ["/usr", "/etc", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt", "/boot", "/proc", "/sys", "/dev"];
  const seen = new Set();
  const target = link => {
    let real, info;
    // A dangling link points nowhere; so does a target that went away, or that this user cannot reach, between the two reads.
    try { real = realpathSync(link); info = statSync(real); } catch { return; }
    if (skip.some(folder => inside(real, folder))) return;
    // A device (known_hosts -> /dev/null) holds no key, and masking it would break the run.
    if (info.isCharacterDevice() || info.isBlockDevice()) return;
    if (!info.isDirectory()) found.push(real);
    else if (roots.includes(real) || system.some(folder => inside(real, folder)) || keep.some(path => inside(path, real))) unsafe.push(`${link} -> ${real}`);
    else { found.push(real); walk(real); }
  };
  const walk = folder => {
    if (tooLarge) return;
    let entries, real;
    try { real = realpathSync(folder); } catch { return; /* Gone. */ }
    if (seen.has(real)) return;
    seen.add(real);
    // A folder that cannot be listed could hide a link: the search is not complete, so the run is refused.
    try { entries = readdirSync(folder, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") unlisted.push({ folder, code: error.code }); return; }
    count += entries.length;
    if (count > limit) { tooLarge = searching; return; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      // A disk that reports no entry types (some network homes) gets an lstat, so no link is missed.
      let link = entry.isSymbolicLink(), dir = entry.isDirectory();
      if (!link && !dir && !entry.isFile()) {
        try { const info = lstatSync(path); link = info.isSymbolicLink(); dir = info.isDirectory(); } catch { /* Gone. */ }
      }
      if (link) target(path);
      else if (dir) walk(path);
    }
  };
  for (const path of paths) {
    if (skip.some(folder => inside(path, folder))) continue;
    searching = path;
    try {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) target(path);
      else if (info.isDirectory()) walk(path);
    } catch { /* Not there. */ }
  }
  return { paths: [...new Set(found)], unsafe, unlisted, tooLarge };
}

/**
 * The paths for Codex's profile: those there now, each link replaced by the file it points at, none inside another. Codex's sandbox cannot
 * mask a link itself (kit review's Codex home links auth.json to the real login; masking the link stopped the review
 * before it started), and a dangling link points at nothing to hide.
 */
export function codexPaths(paths) {
  const found = [...new Set(existingPaths(paths).flatMap(path => {
    try { return lstatSync(path).isSymbolicLink() ? [realpathSync(path)] : [path]; } catch { return []; }
  }))];
  // A path inside another one on the list is hidden with it; Codex's sandbox fails on it (the display's cookie inside the
  // runtime folder stopped a review before it started).
  return found.filter(path => !found.some(other => other !== path && inside(path, other)));
}

// A path and the ones inside it: a masked folder hides what is inside, so only the outermost is mounted. Windows paths
// ignore case, so there c:\work\bin is inside C:\work (Claude review R6-2).
function inside(path, folder) {
  if (process.platform === "win32") { path = path.toLowerCase(); folder = folder.toLowerCase(); }
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * bubblewrap's arguments before "--": the file system as it is (devices included), each existing key folder swapped
 * for an empty one and each existing key file (or socket) for /dev/null, which bwrap mounts without devices so opening
 * it is refused. A path inside an already masked folder is left out. With `writable` (a list), the file system is
 * read-only but for those folders.
 */
export function bwrapArgs(paths, { writable = null, writableFds = [], writableAfter = [], readOnly = [], readOnlyAfter = [], fence = false } = {}) {
  // Read-only: the whole file system read-only with devices as they are, and writes only to the folders named. The
  // `readOnly` folders come next, before the masks, so a key path inside one stays hidden; `readOnlyAfter` and
  // `writableAfter` come after them, so a folder inside a masked one (kit pr's links in the runtime folder, or a
  // build's own session inside the masked fence-state root) is still there while siblings stay hidden.
  const args = [...(fence ? ["--die-with-parent"] : []), ...(writable === null ? ["--dev-bind", "/", "/"] : ["--ro-bind", "/", "/", ...(fence ? ["--dev", "/dev"] : ["--dev-bind", "/dev", "/dev"]),
    ...existingPaths(writable).flatMap(path => ["--bind", path, path]),
    ...writableFds.flatMap(({ childFd, path }) => ["--bind-fd", String(childFd), path])]), ...existingPaths(readOnly).flatMap(path => ["--ro-bind", path, path])];
  const masked = [];
  for (const path of [...paths].sort((a, b) => a.length - b.length)) {
    if (masked.some(folder => inside(path, folder))) continue;
    let kind;
    try { lstatSync(path); kind = statSync(path).isDirectory() ? "dir" : "file"; }
    catch { continue; }
    if (kind === "dir") { args.push("--tmpfs", path); masked.push(path); }
    else args.push("--ro-bind", "/dev/null", path);
  }
  args.push(...existingPaths(readOnlyAfter).flatMap(path => ["--ro-bind", path, path]));
  args.push(...existingPaths(writableAfter).flatMap(path => ["--bind", path, path]));
  if (fence) args.push(...masked.flatMap(path => ["--remount-ro", path]));
  return args;
}

/**
 * The machine's kit, which kit pr and the runner go on to run with the keys (TOOLS-320): the copy this file belongs to
 * (its folder) and the folder kit update keeps every copy in (`${XDG_DATA_HOME:-~/.local/share}/agent-kit`, its current
 * link and its clone with them), links followed, the outermost only. A locked build and kit pr's locked checks see them
 * read-only. One inside the worktree or its Git folder (a build of the kit itself, run with KIT_HOME at its worktree) is
 * the build's own code, and one that holds either would make them read-only too: both are left out.
 */
export function kitFolders(env = process.env, { worktree, common } = {}) {
  const shut = buildFolders(worktree, common);
  const data = isAbsolute(env.XDG_DATA_HOME ?? "") ? env.XDG_DATA_HOME : join(home(env), ".local/share");
  const folders = existingPaths([import.meta.dirname, join(data, "agent-kit")]).map(real)
    .filter(folder => !shut.some(root => inside(folder, root) || inside(root, folder)));
  return [...new Set(folders)].filter((folder, _, all) => !all.some(other => other !== folder && inside(folder, other)));
}

// A key folder that could not be listed, in words with a step that fits why: the user's own folder without read
// permission, another user's folder (an earlier sudo run), or anything else.
function listingProblem({ folder, code }) {
  const quoted = `'${folder.replaceAll("'", `'\\''`)}'`;
  let owner = null;
  try { owner = statSync(folder).uid; } catch { /* Gone since. */ }
  const own = typeof process.getuid === "function" && owner === process.getuid();
  const step = code === "EACCES" && own ? `allow reading it: chmod u+rx ${quoted}`
    : code === "EACCES" && owner !== null ? `give it back to your user: sudo chown -R "$USER" ${quoted}`
    : "check the folder, then try again";
  return `${folder} cannot be read to look for links (${code}); ${step}`;
}

// TOML strings for Codex's -c values: JSON strings are valid TOML basic strings.
const toml = JSON.stringify;

/**
 * Codex's permissions profile as -c options, in place of -s: reads anywhere but the locked paths; a build also writes
 * the worktree, the temp folders and the Git common folder, with network on (as before); a review writes nothing and
 * has no network.
 */
export function codexProfile(kind, common, paths, temporary) {
  const name = kind === "build" ? "kit-build" : "kit-review";
  const entries = [`":root"="read"`];
  if (kind === "build") entries.push(`":project_roots"={"."="write"}`, ...(temporary ? [`${toml(temporary)}="write"`] : []), `${toml(common)}="write"`);
  for (const path of paths) entries.push(`${toml(path)}="none"`);
  return ["-c", `default_permissions=${toml(name)}`, "-c", `permissions.${name}.filesystem={${entries.join(",")}}`,
    "-c", `permissions.${name}.network={enabled=${kind === "build"}}`];
}

// Where the kit takes the programs it starts itself from (bubblewrap, a CLI, git): PATH's folders, but never one
// inside the worktree or the repository's Git folder. A build writes both, so a program left there (a bwrap in
// <worktree>/node_modules/.bin, which npm puts on PATH as a full path) must never be the lock, nor start outside it.
// A PATH entry that is not a full path, or an empty one, is the folder the run starts in, the worktree again. Links
// are followed first, so a folder or a program elsewhere that links into either counts as inside. No PATH at all
// means the system's own folders (as execvp reads it), and so does a PATH with no folder left. A PATH folder elsewhere
// that a build can write (under HOME) is not covered: the lock does not confine a build's writes (README, "What the
// key lock does not do").
const systemPath = "/bin:/usr/bin";
const executable = file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
const pathFolders = env => (env.PATH === undefined ? systemPath : String(env.PATH)).split(delimiter);
// A path walked one part at a time as the kernel walks it (as magic does): a link, a folder link too, is swapped for
// its target before anything past it is read, and a .. climbs from where the walk has got to, so <out>/link/../x is x
// beside where link leads, not beside link (GPT second look on be0bc9b). `end` is where the path leads, every link in
// it followed; `passed` holds each entry the walk read on the way, where it sits (its folder's links followed, its own
// not), for a build can point one inside the worktree elsewhere after the check. A part that is not there yet ends the
// walk, and the rest counts as written from there, so making it later moves it nowhere else; past 40 links the kernel
// stops, and so does this.
// On Windows the walk reads a path's parts by / alone, so C:\ paths and their links and junctions would not be followed
// at all (TOOLS-390 SL-1): there `end` is every link followed by the system (realpathSync, as far as the path exists,
// as before the walk), and `passed` is the path as written, so a folder written inside the worktree still counts. A
// link or junction whose target is not there yet is followed to that target, as the walk does (Claude review R6-1).
function walkWindows(path) {
  const full = resolve(path), rest = [];
  let at = full, links = 0;
  for (;;) {
    try { return { end: join(realpathSync(at), ...rest), passed: [full] }; }
    catch {
      let target = null;
      try { if (lstatSync(at).isSymbolicLink()) target = readlinkSync(at); } catch { /* Not there. */ }
      if (target !== null && ++links <= 40) { at = resolve(dirname(at), target); continue; }
      if (dirname(at) === at) return { end: join(at, ...rest), passed: [full] };
      rest.unshift(basename(at));
      at = dirname(at);
    }
  }
}
function walk(path) {
  if (process.platform === "win32") return walkWindows(path);
  const passed = [];
  let at = "/", rest = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split("/"), links = 0;
  while (rest.length) {
    const part = rest.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") { at = dirname(at); continue; }
    const next = join(at, part);
    passed.push(next);
    let target;
    try { if (!lstatSync(next).isSymbolicLink()) { at = next; continue; } target = readlinkSync(next); }
    catch { return { end: resolve(next, ...rest), passed }; }
    if (++links > 40) return { end: resolve(next, ...rest), passed };
    if (isAbsolute(target)) at = "/";
    rest = [...target.split("/"), ...rest];
  }
  return { end: at, passed };
}
const real = path => walk(path).end;
// A PATH folder's entry by that name, as written: a .. in the folder stays for real and walk to read in kernel order.
const inFolder = (folder, name) => folder.split("/").includes("..") ? `${folder}/${name}` : join(folder, name);
// The full path the kit starts for one a line names: with a .. in it kept as written, so the kernel reads the same
// file that walk checked, never the one the path tidied as text names.
const toStart = path => { const full = isAbsolute(path) ? path : `${process.cwd()}/${path}`; return full.split("/").includes("..") ? full : resolve(full); };
// The two folders a build is meant to write, for the comparison: the worktree and the Git folder, links followed.
const buildFolders = (worktree, common) => [worktree, common].filter(Boolean).map(real);
// A folder counts as inside where its path leads there or passes through an entry there (shutIn), so a worktree link
// that leads out (<worktree>/tools-link -> /usr/bin), which a build can point elsewhere after the check, is not trusted
// (TOOLS-390 R1-2). A folder that leads into /proc is not trusted either: /proc/self/cwd is the folder of the process
// that opens it, the worktree for one started there, whatever the kit sees from its own folder (TOOLS-390 R1-1).
const trustedFolders = (env, shut) => pathFolders(env).filter(folder => isAbsolute(folder) && !leadsToProc(folder) && !shutIn(folder, shut));
// The folders of the run's own PATH (runPath): the trusted ones, or the system's own when none is left.
const runFolders = (env, shut) => { const folders = trustedFolders(env, shut); return folders.length ? folders : systemPath.split(delimiter); };
// What a bare name stands for in those folders: `file`, the first executable there that does not lead into the
// worktree or the Git folder, or null; and `refused`, the first one before it that does. Such a one sits in a folder
// that stays on the run's PATH (a link someone made from a folder of their own to a program in the worktree, which a
// build can swap), so the bare name would start it, outside the lock: with no `file` to start in its place, the name
// is not started at all (linkRefusal). With neither, no folder holds an executable by that name, and starting the
// bare name with the run's PATH finds none either. An entry that leads into /proc is refused the same way, whether or
// not the kit's folder holds what it names: /proc/self/cwd/x is x in git's folder, the worktree, when git opens it
// (landing review R1-2).
function lookup(name, env, shut) {
  let refused = null;
  for (const folder of runFolders(env, shut)) {
    const file = inFolder(folder, name);
    if (leadsToProc(file)) { refused ??= file; continue; }
    if (!executable(file)) continue;
    if (!shutIn(file, shut)) return { file, refused };
    refused ??= file;
  }
  return { file: null, refused };
}
// The executable file a bare name stands for, from those folders only, or null.
const programFor = (name, env, shut) => lookup(name, env, shut).file;
// Why a program found only through such a link is not started, with the step that fixes it.
const linkRefusal = (name, file) => leadsToProc(file)
  ? `${name} on PATH is ${file}, which leads into ${intoProcAt(file)}, another program for each process that opens it, so it is not started; put a ${name} from outside /proc on PATH, or set ASE_KEY_GUARD=off to run without the lock`
  : `${name} on PATH is ${file}, a link into the worktree or its Git folder (${real(file)}), where a build can change it, so it is not started; put a ${name} from outside them on PATH, or set ASE_KEY_GUARD=off to run without the lock`;
// The variable a word sets for an env that reads it, or undefined: PATH, or one that has a bash or sh it starts run code
// from elsewhere (TOOLS-329): BASH_ENV or ENV (a file it reads before anything else), a BASH_FUNC_<name>%% function, or
// SHELLOPTS, BASHOPTS or PS4 (a trace prompt it expands), or ZDOTDIR (the folder whose .zshenv every zsh reads), or
// SHELL (the shell ssh runs a ProxyJump's command through: Claude review, round 21). It
// counts at the word's start, after a character no variable name holds (a blank inside one quoted -S string, an option's
// =), or joined to an -S option (-SPATH=…, -iSPATH=…), so another env the line starts (busybox env, coreutils env)
// cannot hide one in its own words; XPATH= and MY_ENV= are other variables. It also counts the word as such an env
// would split it when the kit cannot tell it is env (GNU env installed as gnuenv): quotes and backslashes join
// ('PA''TH=…', BA""SH_ENV=…), and \_ and the blank escapes break (X=1\_PATH=…; inside quotes that refuses a bit more).
const ownSetting = word => [word, word.replace(/\\[_tnvfr]/g, " ").replace(/['"\\]/g, "")]
  .map(text => /(?:^|[^A-Za-z0-9_]|^-[A-Za-z]*S)(PATH|BASH_ENV|ENV|BASH_FUNC_[^=\s]*|SHELLOPTS|BASHOPTS|PS4|ZDOTDIR|SHELL)=/.exec(text)?.[1]).find(Boolean);
// What a line's words set (ownSetting), or FILLED where an -S string among them (after -S or --split-string, or joined
// to it) holds a ${…}: such an env fills it in before it reads a NAME=, so A=PATH B== gnuenv -S '${A}${B}…' sets
// PATH. An -S of another program (ssh's control path) with a ${…} in it is refused too; ssh -i '${HOME}/…' is not.
// INNER where a word holds a $ that a shell the line starts would fill in before an env it runs reads the name:
// sh -c 'gnuenv PA${EMPTY}TH=… ssh' (a piece of the word, cut at blanks and ; & | ( ), with only name characters before
// its $ and an = after it), or any $(…) or `…`, whose output can build a name: sh -c 'gnuenv $(printf PA)TH=… ssh'.
// ssh -i '${HOME}/…' has no = after its $, so it is not.
const FILLED = "${…}", INNER = "$";
// The -S string a word holds, given the word before it: the word after -S (-vS) or --split-string, which GNU env also
// takes by any unique start of it (--s, --split), or what follows when they are joined (-S'…', --split=…), from the
// first S, as env reads it (-SShell runs Shell: GPT second look on 47e3824).
const splitLong = text => text.length >= 3 && "--split-string".startsWith(text);
const splitString = (word, before = "") => {
  if (/^-[A-Za-z]*S$/.test(before) || splitLong(before)) return word;
  const [option, joined] = word.split(/=(.*)/s);
  return /^-[A-Za-z]*?S(.+)/s.exec(word)?.[1] ?? (joined !== undefined && option.startsWith("--") && splitLong(option) ? joined : undefined);
};
const innerFill = word => /`|\$\(/.test(word) || word.split(/[\s;&|()]+/).some(piece => /^[A-Za-z0-9_]*\$.*=/s.test(piece.replace(/['"\\]/g, "")));
const lineSetting = words => words.map(ownSetting).find(Boolean)
  ?? (words.some((word, i) => splitString(word, words[i - 1])?.includes("${")) ? FILLED : words.some(innerFill) ? INNER : undefined);
// Whether a word names env: by name or by a path to it (links followed), or as a multi-call binary's choice of it, a
// leading dash too, which busybox takes off the name it is started by (the loader's --argv0 -env: GPT second look on be0bc9b).
const namesEnv = word => /^-?env$/.test(basename(word)) || (word.includes("/") && basename(real(word)) === "env") || /^--coreutils-prog(?:-shebang)?=env$/.test(word);
// No shell starts from git's ssh command or from an env -S first line but the script's own interpreter (Lex's decision,
// 2026-11-20, TOOLS-329): a shell can build PATH= or BASH_ENV= out of pieces no word holds ("$1$2", "${1}${2}", IFS=
// with "$*"), which no check here could read. A shell counts by name (a version may follow: bash5, zsh-5.9), by a path
// or a PATH entry that leads to one (links followed: /usr/bin/sh is dash), as a word or as a piece of one (sh -c '…
// bash -c …', a value after an =); so do ssh's ProxyCommand and LocalCommand (but none), which ssh runs through the
// user's shell: anywhere in a word, so in a bundle of ssh's flags (-4oProxyCommand=…) and with quotes or \ in its name
// too, which ssh takes out (PermitLocalCommand is another option). ssh also writes a ProxyJump's (-J's) hosts into a
// command of its own that it runs through that shell, so one with more than user@host:port names in it counts, and so
// does one beside a word with a ' in it or an -F path with more than plain characters, which land in that command. rc,
// es and nu, too short to tell from other words, count only where PATH or a path leads to such a program, and take no
// version. A name with a leading dash counts too: a login shell is started by such a name, and busybox, handed one by
// the loader's --argv0 (ld-linux --argv0 -sh busybox), runs that shell (GPT second look on be0bc9b).
// A copy of a shell under a name of its own is not recognised. startedShell gives what starts the shell, in words, or
// null; shellAdvice what to do about it.
const shells = "sh|ash|bash|rbash|dash|ksh|ksh93|mksh|lksh|pdksh|oksh|loksh|zsh|yash|posh|hush|sash|csh|tcsh|fish|osh|ysh|pwsh|xonsh|elvish";
const shellNamed = (word, names = shells) => new RegExp(`^-?(?:${names})(?:-static)?(?:[-.]?\\d[\\d.]*)?$`).test(basename(word));
// sh and env take a relative path from the folder git runs in, which is not the kit's own folder: such a path counts
// from there too, the worktree or the Git folder (GPT second look, round 14); as written, never tidied, so a .. counts
// as the kernel reads it (walk).
const fromRoots = (path, shut) => isAbsolute(path) ? [path] : [path, ...shut.map(root => `${root}/${path}`)];
// Whether a path, relative ones from there too, leads into the worktree or the Git folder, or passes through an entry
// there on the way, in the order the kernel walks it (walk; a .. after a link climbs from where the link leads: Claude
// review R2-5): a build can point a link it placed there elsewhere after the check (Claude review, round 14), a folder
// link too (<worktree>/tools -> /usr/bin; landing review R1-3). The walk goes on through each link, so a worktree
// reached through a link of its own counts as well.
const shutIn = (path, shut) => fromRoots(path, shut).some(place => { const { end, passed } = walk(place); return [end, ...passed].some(at => shut.some(root => inside(at, root))); });
// /proc/self/exe and the like are whatever program opens them: the shell git starts, when it is that shell that runs
// them, while the kit sees its own node there (GPT second look, round 27). So a path that leads into /proc or /dev, by
// a link or a folder link too, counts as a shell: one in /proc whatever the kit sees there (/proc/self/cwd is the
// folder of the process that opens it, which for git is the worktree), one in /dev when it is a program file
// (/dev/null, an -F value, is none). A program or interpreter path there is refused outright (intoProc).
const systemFolder = /^\/(?:proc|dev)(?:\/|$)/;
// Where a path first leads into /proc or /dev ("/proc/…" or "/dev/…"), or "". It is walked one part at a time as the
// kernel walks it: a link, a folder link too, is swapped for its target as written, which is checked before anything
// past it is read (cwd-folder -> /proc/self/cwd leads into /proc, though from the kit's folder it is the kit's own
// folder: landing review R1-1), and a .. climbs from where the walk has got to, after a folder link from where that
// link leads (/usr/../proc counts). Past 40 links the kernel stops; so does this, counting it as /proc. `stop` names
// the folders the walk ends at; leadsToProc walks on through /dev.
const magic = (path, stop = systemFolder) => {
  let at = "/", rest = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split("/"), links = 0;
  while (rest.length) {
    const part = rest.shift();
    if (part === "" || part === ".") continue;
    if (part === "..") { at = dirname(at); continue; }
    const next = at === "/" ? `/${part}` : `${at}/${part}`;
    if (stop.test(next)) return [next, ...rest].join("/");
    let target;
    try { if (!lstatSync(next).isSymbolicLink()) { at = next; continue; } target = readlinkSync(next); } catch { return ""; }
    if (++links > 40) return "/proc";
    if (isAbsolute(target)) at = "/";
    rest = [...target.split("/"), ...rest];
  }
  return "";
};
// Whether a path leads into /proc, where what it names is another program, or another folder's file, for each process.
// The walk goes on through /dev, whose links lead there too: /dev/fd is /proc/self/fd, so /dev/fd/../cwd is
// /proc/self/cwd (GPT second look on 0868fa4), while /dev/null leads nowhere else (Claude review R5-1).
const procFolder = /^\/proc(?:\/|$)/;
const intoProcAt = path => magic(path, procFolder);
const leadsToProc = path => intoProcAt(path) !== "";
const intoProc = (path, shut) => path.includes("/") && fromRoots(path, shut).some(place => magic(place));
// A path's file is read as the kernel reads it (real walks a .. after a link from where the link leads), so
// <out>/link/../../shell-alias is the shell that link's folder holds (GPT second look on be0bc9b).
const namesShell = (word, env, shut) => {
  const found = word.includes("/") ? null : lookup(word, env, shut);
  const files = found ? [found.file].filter(Boolean) : fromRoots(word, shut).filter(executable);
  const leadsIn = place => { const where = magic(place); return where.startsWith("/proc") || (where !== "" && executable(place)); };
  // A bare name a PATH entry before it leads into /proc for counts too: the program that looks it up opens that one.
  return shellNamed(word) || Boolean(found?.refused && leadsToProc(found.refused)) || (found ? files : fromRoots(word, shut)).some(leadsIn)
    || files.some(file => shellNamed(real(file)) || [word, real(file)].some(name => /^(?:rc|es|nu)$/.test(basename(name))));
};
// ssh splits an option from its value at any blank, a line break and carriage return too, or an =.
const viaShell = /(?<!permit)(proxy|local)command(?:\s*=\s*|\s+|$)(.*)$/is;
const jumpOption = /proxyjump(?:\s*=\s*|\s+|$)(.*)$/is;
// Variables sh sets or changes itself as it starts or runs (bash's and dash's), whatever the run's environment holds:
// "$BASH" and "$_" are the shell itself there, and bash sets SHELL where the run has none (GPT second look, round 19).
const shellSets = /^(?:BASH\w*|SHELL\w*|_|PPID|PWD|OLDPWD|UID|EUID|GROUPS|HOSTNAME|HOSTTYPE|MACHTYPE|OSTYPE|RANDOM|SRANDOM|SECONDS|EPOCH\w*|LINENO|SHLVL|HIST\w*|FUNCNAME|DIRSTACK|PIPESTATUS|COMP_\w*|READLINE_\w*|REPLY|OPTIND|OPTERR|OPTARG|PS[0-4]|IFS|MAILCHECK|COLUMNS|LINES|TMOUT)$/;
// The value of ssh's flag `letter` in words[i], joined to it in a bundle (-4J host; -2J too, which ssh ignores, and -1J,
// which it refuses, so such a line fails anyway: GPT second look, round 19) or in the next word; null if none.
const flagValue = (words, i, letter) => {
  const flag = new RegExp(`^-[1246AaCfGgKkMNnqsTtVvXxYy]*${letter}(.*)$`, "s").exec(words[i]);
  return flag ? flag[1] || (words[i + 1] ?? "") : null;
};
// A word with quotes and \ taken out, as ssh reads an option's name; and with env -S's \_, blank escapes and \c as
// blanks first, as an -S string (gnuenv) splits: ProxyCommand\_nc is ProxyCommand nc (GPT second look, round 15).
const unquoted = word => word.replace(/["'\\]/g, "");
const unescaped = word => unquoted(word.replace(/\\[_tnvfrc]/g, " "));
const jumpOf = (words, i) => (jumpOption.exec(unquoted(words[i])) ?? jumpOption.exec(unescaped(words[i])))?.[1] ?? flagValue(words, i, "J");
const startedShell = (given, env, shut) => {
  // A word an env -S string (gnuenv) splits counts as the words it splits into too, so an -J or -F there is checked
  // beside the line's own (GPT second look, round 16): split by env's own rules (quotes keep a blank in a word), each
  // piece right after its word, so the line's next word follows the last piece (round 17, Claude review round 16).
  // A piece that is itself an -S string (env -S "ssh -J…" inside another -S string) splits again, and counts as a line
  // word where it holds a blank (GPT second look, round 18). Only a word with a blank, a quote or a \ splits, and env's
  // split takes out or shrinks each of those, so a piece is always shorter than its word and this ends. An -S string
  // joined to its option (-Ssh, -vSsh, --split=sh) counts as a piece too, without the option, so it is shorter as well
  // (GPT second look on 47e3824, G1).
  const split = word => [...(/[\s\\"']/.test(word) ? splitWords(word) ?? unescaped(word).split(/\s+/).filter(Boolean) : []), ...[splitString(word)].filter(Boolean)];
  const expand = (word, line) => [{ word, line }, ...split(word).filter(piece => piece !== word).flatMap(piece => expand(piece, /\s/.test(piece)))];
  const entries = given.flatMap(word => expand(word, true));
  const words = entries.map(entry => entry.word);
  // A ProxyJump option is read in the line's own words, which hold its value beside its name; in a piece, only -J.
  const jumpAt = i => entries[i].line ? jumpOf(words, i) : flagValue(words, i, "J");
  // A ProxyJump's command holds the -F path as it is and the host (%h, from HostName too) in single quotes: a host
  // written in these words is checked here, one git adds from the push address is not (the README says so).
  // ssh keeps quotes and \ in an option's value, so only a plain none turns the option off: "none" and n\one are
  // values like any other (GPT second look, round 9).
  const jumping = words.some((word, i) => { const jump = jumpAt(i)?.trim(); return jump !== undefined && (!/^(?:none)?$/i.test(jump) || /["'\\]/.test(word)); });
  for (const [i, word] of words.entries()) {
    // ProxyCommand and LocalCommand are read in the line's own words, which hold the value beside the name.
    const option = entries[i].line ? viaShell.exec(unquoted(word)) ?? viaShell.exec(unescaped(word)) : null;
    if (option && !(option[2].trim().toLowerCase() === "none" && /command["']*(?:\s*=\s*|\s+)none\s*$/i.test(word))) return `${option[1].toLowerCase() === "proxy" ? "ProxyCommand" : "LocalCommand"}, which ssh runs through the user's shell`;
    const jump = jumpAt(i);
    if (jump !== null && !jump.trim().split(",").every(name => /^[\w.@:[\]][\w.@:[\]-]*$/.test(name))) return "ProxyJump with more than host names in it, which ssh runs through the user's shell";
    if (jumping && (word.includes("'") || !/^[\w./@:,+~-]*$/.test(flagValue(words, i, "F") ?? ""))) return "ProxyJump beside a ' or an -F path with more than plain characters in it, which ssh writes into the command it runs through the user's shell";
    // Braces and commas split too: where /bin/sh is bash, {s,h} would be a shell's name by brace expansion.
    // The whole word first, so a quoted path with a blank or a ; in it still reaches the link it names; then its pieces,
    // also with quotes and \ taken out, as an env -S (gnuenv) or a shell joins them: ba's'h is bash; and with env -S's
    // \_ and blank escapes as blanks, where it splits: \_bash is bash; and its \c, where it stops: sh\c is sh (GPT
    // second look, round 14).
    const cut = text => text.split(/[\s;&|()<>=`'"{},]+/);
    const piece = [word, ...cut(word), ...cut(unquoted(word)), ...cut(unescaped(word))]
      .find(part => part && namesShell(part, env, shut));
    if (piece) return basename(piece);
  }
  return null;
};
const shellAdvice = (started, where) => started.startsWith("ProxyJump beside") ? `keep every word${where} free of ' and the -F path plain, or drop ProxyJump (-J)`
  : started.startsWith("ProxyJump") ? `give ProxyJump (-J)${where} plain user@host:port names`
  : /^(?:Proxy|Local)Command/.test(started) ? `drop ProxyCommand and LocalCommand${where}, or use ProxyJump (-J) with plain host names instead` : null;
// A shell told to run a string instead of the script: -c or +c alone or bundled (-ec, +ec), --command, --init-command, and fish's
// -C (bash's and sh's -C is noclobber), and nu's -e, --commands and --execute. pwsh takes any start of -Command, -CommandWithArgs or -EncodedCommand, of any
// case, with blanks around it and one or two dashes (an en dash, em dash or horizontal bar counts as one), and -cwa and -ec.
const runsString = (option, kind) => {
  if (kind === "pwsh") {
    const name = /^[-–—―]{1,2}([A-Za-z]+)(?::|$)/.exec(option.trim())?.[1]?.toLowerCase();
    return Boolean(name) && (["cwa", "ec"].includes(name) || ["command", "commandwithargs", "encodedcommand"].some(full => full.startsWith(name)));
  }
  // fish takes any start of a long option's name that tells it apart (--com, --init-com=…): GPT second look, round 20.
  const fishName = kind === "fish" ? /^--([A-Za-z-]+)(?:=|$)/.exec(option)?.[1] : undefined;
  return /^[-+][A-Za-z]*c/.test(option) || (kind === "fish" && /^-[A-Za-z]*C/.test(option)) || /^--(?:command|init-command)(?:=|$)/.test(option)
    || Boolean(fishName && ["command", "init-command"].some(full => full.startsWith(fishName)))
    || (kind === "nu" && /^(?:-[A-Za-z]*e|--(?:commands|execute)(?:=|$))/.test(option));
};

// The file that starts reads the options, so its name counts first: a link named pwsh that leads to bash reads bash's
// (Claude review, round 25).
const shRules = word => shellNamed(word, "zsh") ? "zsh" : shellNamed(word, "sh|ash|bash|rbash|dash|ksh|ksh93|mksh|lksh|pdksh|oksh|loksh|yash|posh") ? "sh" : null;
const kindOf = word => ["fish", "pwsh", "nu"].find(kindName => shellNamed(word, kindName));
const shellKind = (found, name) => shRules(real(found)) ? undefined : kindOf(real(found)) ?? kindOf(name);
// A shell runs its first word that is not an option, or what it reads with -s, in place of this script (bash
// <worktree>/payload; GPT second look, round 21), and every word after -- or a lone - is one (bash -- -e runs a file
// called -e; round 22). So a shell takes options only: with a value after -o or -O, and for pwsh after the options
// that take one (any of its switches, -NoProfile and the like, takes none; Claude review, round 21). An option is
// read by each shell's own rules: only pwsh takes the long dashes, and it runs any word it does not know as a script
// (-payload.ps1), as bash does a word with a long dash (—payload; GPT second look, round 23). So pwsh gets only the
// names and short forms it documents, written out (a second dash only when it is the first one again, as pwsh reads
// it), and the other shells only the options listed here. An option that takes a value takes the next word whatever
// it is, so the words are read in order, a value is skipped, and an option is known only if it takes no value or
// its value is harmless: bash's --rcfile, pwsh's -ConfigurationFile and -SettingsFile and the like load code from a
// file, and bash --rcfile -o payload runs payload (Claude review, round 23; GPT second look, round 24).
// Shells read the same letters differently: zsh's -O takes no value and its -b ends the options (so does tcsh's), and
// rc's -o takes none, so only the sh family and zsh get short options, and any other shell gets none (Claude review,
// round 24; GPT second look, round 25). An option that takes a value and ends the line would take the script itself.
// The name after -o or -O can switch a reading on as well as a letter can (zsh -o shinstdin is -s, and zsh reads
// names in any case, without _, and +o no_… as on), so only these names count there (round 26).
const pwshValued = ["executionpolicy", "ex", "ep", "workingdirectory", "wd", "outputformat", "o", "of", "inputformat", "inp", "if", "configurationname", "config", "custompipename", "windowstyle", "w"];
// pwsh -Login runs /etc/profile and ~/.profile through /bin/sh, as bash -l does, so it is none of them (landing review R1-4).
const pwshSwitches = ["interactive", "i", "mta", "sta", "noexit", "noe", "nologo", "nol", "noninteractive", "noni", "noprofile", "nop", "noprofileloadtime", "sshservermode", "sshs", "version", "v"];
const pwshName = word => /^([-–—―])\1?([A-Za-z]+)$/.exec(word)?.[2]?.toLowerCase();
const setNames = ["errexit", "nounset", "xtrace", "pipefail", "noclobber", "noglob", "allexport", "errtrace", "functrace", "posix", "verbose", "noexec", "braceexpand", "hashall", "monitor", "notify",
  "extglob", "globstar", "nullglob", "failglob", "dotglob", "nocaseglob", "inheriterrexit", "lastpipe", "expandaliases", "extendedglob", "shwordsplit", "ksharrays", "warncreateglobal"];
const setName = word => setNames.includes(word.toLowerCase().replace(/_/g, ""));
const handsScript = (found, name, options) => {
  const family = shellKind(found, name) ?? shRules(real(found)) ?? shRules(name);
  // A login or interactive shell reads start-up files (bash -l ~/.profile, bash -i ~/.bashrc, dash -i $ENV, zsh -l
  // .zprofile, nu --login login.nu), so -i, -l, --login and --interactive are none of them (kit pr review).
  const longKnown = { fish: ["no-config", "private", "no-execute"], nu: ["no-config-file", "no-std-lib", "no-history"],
    sh: ["norc", "noprofile", "posix", "noediting", "restricted", "verbose"], zsh: ["no-rcs", "no-globalrcs", "verbose"] }[family] ?? [];
  const shortKnown = { fish: /^-[nNPvh]+$/, nu: /^-[nvh]+$/, sh: /^[-+](?=[A-Za-z])[aefhkmnpruvxBCEHP]*[oO]?$/, zsh: /^[-+](?=[A-Za-z])[aefhkmnpruvxBCEHP]*o?$/ }[family];
  const valued = option => family === "pwsh" ? pwshValued.includes(pwshName(option)) : (family === "sh" || family === "zsh") && /[oO]$/.test(option) && shortKnown.test(option);
  const known = option => family === "pwsh"
    ? valued(option) || pwshSwitches.includes(pwshName(option))
    : Boolean(shortKnown?.test(option)) || (option.startsWith("--") && longKnown.includes(option.slice(2)));
  // What the shell gets from a word it does not take as a known option, in words a person can act on (landing review
  // R1-6): a Linux line's options passed as one word, -s, a login or interactive option, a file of code, an option the
  // kit does not know, or a script.
  const why = word => {
    const name = family === "pwsh" ? pwshName(word) : undefined;
    if (/\s/.test(word)) return `"${word}" as one word (Linux passes all that follows the interpreter as one), which is no option it knows`;
    if (word === "-" || ((family === "sh" || family === "zsh") && /^-[A-Za-z]*s/.test(word))) return `${word}, which has it read commands from its input in place of this script`;
    if (["login", "l"].includes(name) || (family !== "pwsh" && (/^-[A-Za-z]*[il]/.test(word) || /^--(?:login|interactive)$/.test(word)))) return `${word}, which makes it a login or interactive shell that reads start-up files`;
    if (["configurationfile", "settingsfile"].includes(name) || /^--(?:rcfile|init-file)(?:=|$)/.test(word)) return `${word}, which loads code from a file`;
    if (["file", "f"].includes(name)) return `${word}, which hands it a script of its own to run in place of this one`;
    if (family === "pwsh" ? Boolean(name) : /^[-+]./.test(word)) return `${word}, an option the kit does not know`;
    return `a script of its own (${word}), which it would run in place of this one`;
  };
  for (let i = 0; i < options.length; i++) {
    if (family && family !== "pwsh" && (options[i] === "--" || options[i] === "-")) return i + 1 < options.length ? `a script of its own after ${options[i]} (${options[i + 1]}), which it would run in place of this one` : null;
    if (!known(options[i])) return why(options[i]);
    if (valued(options[i])) {
      i++;
      if (i >= options.length) return `${options[i - 1]} with nothing after it, so it would take this script as its value`;
      if (family !== "pwsh" && !setName(options[i])) return `${options[i - 1]} ${options[i]}, a setting the kit does not know`;
    }
  }
  return null;
};
// What to do about what handsScript found, in words a person can act on (Claude review R2-6): options passed as one
// word are joined into one (-e -u as -eu), an option with nothing after it gets its setting, anything else goes.
const scriptAdvice = handed => handed.startsWith('"') ? "join those options into one word (-eu for -e -u)"
  : handed.includes(" with nothing after it,") ? "give that option its setting" : "keep only options on that line";

// A script's first line names its interpreter, and `#!/usr/bin/env node` has env look node up by its bare name on PATH,
// where a link a person made into the worktree or the Git folder stays (only the names the kit starts are looked up past
// it). So the kit reads that line itself and starts the interpreter by the full path it finds the way it finds its own
// programs (lookup), with the script as its argument (TOOLS-303): Codex and the API route's wrapper start outside
// bubblewrap. The interpreter may be a script too (an asdf or volta shim, or one a full path names), so this goes on
// for four levels, as the kernel does, and refuses past them. env -S (TOOLS-320) is read as env reads it (splitWords):
// NAME=value words before the program stay with env, which then gets the program by its full path. A first line that
// names a full path inside the worktree or the Git folder, an env option other than -S, -S words env would expand or
// that cannot be split, a PATH among those words or env as the program (TOOLS-326), one of ownSetting's shell variables
// among them, env among the program's words or a shell it starts (startedShell, TOOLS-329), or a name PATH holds only as such a
// link is refused through `refuse`; a name no PATH folder holds is left to start as it is (and fail). `names` is the
// env whose PATH the shell check looks names up in: for git's ssh command, the PATH that command runs with.
function interpreted(file, args, env, shut, refuse, depth = 0, names = env) {
  let head = "";
  try {
    const fd = openSync(file, "r");
    try { const buffer = Buffer.alloc(512); head = buffer.subarray(0, readSync(fd, buffer, 0, 512, 0)).toString("utf8"); } finally { closeSync(fd); }
  } catch { return [file, args]; }
  if (!head.startsWith("#!")) return [file, args];
  if (depth >= 4) refuse(`${file} is a script whose interpreter is a script four levels deep`);
  const line = head.slice(2).split("\n")[0].trim();
  const [interpreter] = line.split(/[ \t]+/, 1), rest = line.slice(interpreter.length).trim();
  if (!interpreter) return [file, args];
  if (intoProc(interpreter, shut)) refuse(`${file} starts with ${interpreter}, a path into /proc or /dev, which leads to another program for each process that opens it`);
  if (basename(interpreter) !== "env") {
    if (shutIn(interpreter, shut)) refuse(`${file} starts with ${interpreter}, inside the worktree or its Git folder, where a build can change it`);
    // The same holds for a shell the line names itself, which gets what follows it as one word (#!/bin/bash
    // <worktree>/payload, #!/bin/bash -s; GPT second look, round 27), or on macOS as words split at blanks (Claude
    // review, round 27).
    const given = process.platform === "darwin" ? rest.split(/[ \t]+/) : [rest];
    const handed = rest && namesShell(interpreter, names, shut) ? handsScript(interpreter, interpreter, given) : null;
    if (handed) refuse(`${file} starts with ${line}, which hands the shell (${basename(interpreter)}) ${handed}; ${scriptAdvice(handed)}, or set ASE_KEY_GUARD=off to run without the lock`);
    // A binary interpreter the kernel starts itself; one that is a script again is followed (the kernel passes what
    // follows the interpreter as one argument, before the script).
    const next = interpreted(interpreter, [...(rest ? [rest] : []), file, ...args], env, shut, refuse, depth + 1, names);
    return next[0] === interpreter ? [file, args] : next;
  }
  // The kernel passes everything after env as one argument: -S's string (joined to it or not) is split as env splits
  // it; without -S it is one word, a program name.
  const unknown = () => refuse(`${file} starts with env ${rest}, so which program it runs cannot be told`);
  const string = rest.startsWith("--split-string=") ? rest.slice("--split-string=".length) : rest.startsWith("-S") ? rest.slice(2) : null;
  const words = string === null ? [rest] : splitWords(string) ?? unknown();
  const assignments = [];
  // env sets every word with = in it before the program, whatever its name (1X=1 and =x too); a word that starts with -
  // is an option to it (--split-string=PATH=… among them), refused below.
  while (words.length && !words[0].startsWith("-") && words[0].includes("=")) assignments.push(words.shift());
  if (!words.length || words[0].startsWith("-")) unknown();
  // A PATH of its own would let the program start another by name from a folder that holds a link into the worktree
  // (TOOLS-326): the folders are the line's, not the run's, so none of them was checked. Any word counts, for an env
  // the program starts in turn (busybox env, a link to env by another name), in any of the forms ownSetting reads. A
  // BASH_ENV, ENV or another of ownSetting's shell variables would have a shell the line starts run code from a file a
  // build may have written (TOOLS-329).
  const setting = lineSetting([...assignments, ...words]);
  if (setting === FILLED) refuse(`${file} starts with env ${rest}, whose -S string holds ${FILLED}, which an env there could fill in as PATH or BASH_ENV; drop the ${FILLED} from that line, or set ASE_KEY_GUARD=off to run without the lock`);
  if (setting === INNER) refuse(`${file} starts with env ${rest}, where a $ or \` could be filled in as PATH= or BASH_ENV=; drop that $ or \` from the line, or set ASE_KEY_GUARD=off to run without the lock`);
  if (setting === "PATH") refuse(`${file} starts with env ${rest}, which sets PATH itself, so a program it starts by name could lead into the worktree or its Git folder; drop PATH= from that line, or set ASE_KEY_GUARD=off to run without the lock`);
  if (setting) refuse(`${file} starts with env ${rest}, which sets ${setting} itself, so a shell it starts could run code from a file a build wrote; drop ${setting}= from that line, or set ASE_KEY_GUARD=off to run without the lock`);
  const [name, ...options] = words;
  let found;
  if (name.includes("/")) {
    if (shutIn(name, shut)) refuse(`${file} starts with env ${name}, inside the worktree or its Git folder, where a build can change it`);
    if (intoProc(name, shut)) refuse(`${file} starts with env ${name}, a path into /proc or /dev, which leads to another program for each process that opens it`);
    found = toStart(name);
  } else {
    const { file: program, refused } = lookup(name, env, shut);
    if (!program && refused) refuse(linkRefusal(name, refused));
    if (!program) return [file, args];
    found = program;
  }
  // An env started by env would look its own program up by name, and could set PATH first (a link to it by another
  // name too, whose -S words this line holds as one), and so would one the program starts in turn: a multi-call binary
  // told to run env (busybox env, coreutils env) or a wrapper that starts it (timeout 30 env, TOOLS-329).
  if (namesEnv(found) || options.some(namesEnv)) refuse(`${file} starts with env ${rest}, which starts env again, and that env would look its program up by name; start the program from that line directly, or set ASE_KEY_GUARD=off to run without the lock`);
  // A shell the program starts, or the program as a shell told to run a string, could build PATH= from pieces.
  const kind = shellKind(found, name);
  const shell = startedShell(options, names, shut) ?? (namesShell(found, names, shut) && options.some(option => runsString(option, kind)) ? basename(name) : null);
  if (shell) refuse(`${file} starts with env ${rest}, which starts a shell (${shell}), and a shell can build PATH= or BASH_ENV= out of pieces; ${shellAdvice(shell, " from that line") ?? "start the program from that line directly"}, or set ASE_KEY_GUARD=off to run without the lock`);
  // A shell given anything but options would run something else in place of this script (handsScript).
  const handed = namesShell(found, names, shut) ? handsScript(found, name, options) : null;
  if (handed) refuse(`${file} starts with env ${rest}, which hands the shell (${basename(name)}) ${handed}; ${scriptAdvice(handed)}, or set ASE_KEY_GUARD=off to run without the lock`);
  const [command, commandArgs] = interpreted(found, [...options, file, ...args], env, shut, refuse, depth + 1, names);
  if (!assignments.length) return [command, commandArgs];
  // env sets them and starts the program by the full path it is given (one with = in it would read as one more).
  if (shutIn(interpreter, shut)) refuse(`${file} starts with ${interpreter}, inside the worktree or its Git folder, where a build can change it`);
  if (command.includes("=")) unknown();
  return [interpreter, [...assignments, command, ...commandArgs]];
}

// The words of an env -S string as env splits them (GNU coreutils' and uutils' rules): blanks between words (space, tab,
// and line feed, vertical tab, form feed and carriage return too, TOOLS-329), '…' taken
// as it is but for \\ and \', "…" and the bare text with the escapes \" \' \\ \# \$ \f \n \r \t \v and \_ (a space in
// quotes, a word break outside), and # at a word's start ending the line. Null for what env would expand (${NAME}) or
// stop on (\c), an escape it refuses, and a quote left open: the program cannot be told then.
function splitWords(string) {
  const words = [], escapes = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "#": "#", $: "$", "\\": "\\", '"': '"', "'": "'" };
  let word = null, quote = null;
  const end = () => { if (word !== null) words.push(word); word = null; };
  for (let at = 0; at < string.length; at++) {
    const char = string[at];
    if (quote === "'") {
      if (char === "'") quote = null;
      else if (char === "\\" && (string[at + 1] === "\\" || string[at + 1] === "'")) word += string[++at];
      else word += char;
      continue;
    }
    if (char === "$") return null;
    if (char === "\\") {
      const next = string[++at];
      if (next === "_") { if (quote) word += " "; else end(); continue; }
      if (!Object.hasOwn(escapes, next ?? "")) return null;
      word = (word ?? "") + escapes[next];
      continue;
    }
    if (quote === '"') { if (char === '"') quote = null; else word += char; continue; }
    if (" \t\n\v\f\r".includes(char)) { end(); continue; }
    if (char === "#" && word === null) break;
    if (char === "'" || char === '"') { quote = char; word ??= ""; continue; }
    word = (word ?? "") + char;
  }
  if (quote) return null;
  end();
  return words;
}

/**
 * The program the runner starts for a bare name (its own git) in a run in `worktree`: its full path from the run's
 * PATH folders, never one that leads into the worktree or the Git folder; the bare name where no folder holds one (the
 * start then fails as a missing program). Throws in plain words, as the lock's other refusals do for this `kind` of
 * run, where PATH holds only one that leads inside.
 */
export function runProgram(name, env = process.env, { worktree, common, kind = "run" } = {}) {
  const { file, refused } = lookup(name, env, buildFolders(worktree, common));
  if (!file && refused) throw new Error(`cannot lock the key files for this ${kind}: ${linkRefusal(name, refused)}`);
  return file ?? name;
}

/**
 * How the lead's own process starts a program on a worktree a build wrote (kit pr's gh and kit commands): [command,
 * args] with the program's full path from the run's PATH folders (never one that leads into the worktree or the Git
 * folder) and a script's interpreter found the same way (interpreted). Throws in plain words where PATH holds the
 * program or its interpreter only as such a link, or a script's first line points inside; a program no folder holds is
 * left as it is.
 */
export function startCommand(command, args, env = process.env, { worktree, common, kind = "run" } = {}) {
  const shut = buildFolders(worktree, common);
  const refuse = problem => { throw new Error(`cannot lock the key files for this ${kind}: ${problem}`); };
  let file = command;
  if (!command.includes("/")) {
    const found = lookup(command, env, shut);
    if (!found.file && found.refused) refuse(linkRefusal(command, found.refused));
    if (!found.file) return [command, args];
    file = found.file;
  }
  return interpreted(file, args, env, shut, refuse);
}

// A command line's words as sh reads them, for git's ssh command, which git starts through the shell: [{value, start,
// end, plain}], where start and end mark the word in the line and plain says its value holds nothing the shell would
// expand ($, a pattern, a leading ~ or #). Null for anything beyond words and quotes (; & | < > ( ) ` $( or a line
// break), which could start another program, and for a quote left open.
function shellWords(line) {
  const words = [];
  let at = 0;
  while (at < line.length) {
    if (line[at] === " " || line[at] === "\t") { at++; continue; }
    const start = at;
    let value = "";
    while (at < line.length && line[at] !== " " && line[at] !== "\t") {
      const char = line[at];
      if (char === "'") {
        const close = line.indexOf("'", at + 1);
        if (close < 0) return null;
        value += `\x04${line.slice(at + 1, close)}\x04`; at = close + 1;
      } else if (char === '"') {
        value += "\x04";
        for (at++; at < line.length && line[at] !== '"'; at++) {
          let inner = line[at], escaped = false;
          // sh takes out a \ and the line break after it inside double quotes too, so "s\<line break>h" is sh.
          if (inner === "\\" && line[at + 1] === "\n") return null;
          if (inner === "\\" && '"\\$`'.includes(line[at + 1] ?? "")) { inner = line[++at]; escaped = true; }
          else if (inner === "`" || (inner === "$" && line[at + 1] === "(")) return null;
          value += inner === "$" && !escaped ? "\x01" : inner;
        }
        if (at >= line.length) return null;
        value += "\x04"; at++;
      } else if (char === "\\") {
        if (at + 1 >= line.length || line[at + 1] === "\n") return null;
        value += `\x04${line[at + 1]}`; at += 2;
      } else if (";&|<>()`\n".includes(char) || (char === "$" && line[at + 1] === "(")) return null;
      // A { outside quotes, but for a ${…}, counts as a pattern: a bash run as sh expands ba{s..s}h and {a,b}.
      else { value += char === "$" ? "\x05\x01" : /[*?[]/.test(char) || (char === "{" && !value.endsWith("\x01")) ? "\x02" : char === "~" && at === start ? "\x03" : char === "#" && at === start ? "\0" : char; at++; }
    }
    // marked keeps \x01 where sh fills in a $, \x02 where it expands a pattern, \x03 for a ~ at the start (HOME) and \0
    // for a # there (the rest of the line is a comment); bounded keeps \x04 too, where a quote or a \ ends a $NAME
    // before sh takes them out ("$E"sh is sh with E empty), and \x05 before a $ outside quotes, whose value sh splits
    // and expands as a pattern.
    words.push({ value: value.replace(/[\0-\x05]/g, ""), marked: value.replace(/[\x04\x05]/g, ""), bounded: value, start, end: at, plain: !/[\0-\x03]/.test(value) });
  }
  return words;
}
const shellQuote = word => /^[A-Za-z0-9_/.,:+@%=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

// The run's PATH folders (runFolders) without any that holds a link into the worktree or the Git folder, or one that
// passes through an entry there (shutIn), by any name: git's ssh command gets these, so a program that starts another
// by its bare name (timeout, sshpass, a wrapper script) finds none there either. A folder that holds a link into /proc
// goes too: /proc/self/cwd is the folder of the process that opens it, which for git's ssh is the worktree, whatever
// the kit sees there (ssh -> /proc/self/cwd/ssh, TOOLS-390 R1-1); runFolders already leaves out a folder that leads
// there itself. The system's own folders stand in where none is left.
function cleanFolders(env, shut) {
  const folders = runFolders(env, shut).filter(folder => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return true; }
    return !entries.some(entry => entry.isSymbolicLink() && (leadsToProc(inFolder(folder, entry.name)) || shutIn(inFolder(folder, entry.name), shut)));
  });
  return folders.length ? folders : systemPath.split(delimiter);
}

/**
 * git's ssh for a fetch or push on `worktree` (TOOLS-320), as the GIT_SSH_COMMAND that call gets: {command, problem,
 * variant}. git takes GIT_SSH_COMMAND, else core.sshCommand (`configured`: its value from the lead's own config and
 * environment, never the repository's, which gitSafety sets empty), else GIT_SSH (one program, no shell), else ssh, and
 * starts a bare name from PATH, where a link someone made into the worktree or the Git folder stays. So the program is
 * found here as the kit finds its own (lookup, and a script's interpreter, interpreted), the command names it by its
 * full path with the line's other words as they were, and where a PATH folder holds such a link the command sets PATH
 * to the folders that hold none (cleanFolders), for any program it starts by name in turn. `problem` in plain words
 * where PATH holds the program only as such a link, the program is inside, or which program runs cannot be told (shell
 * syntax beyond words and quotes, an expansion, env by any name or started in turn, a shell started from it
 * (startedShell), a PATH or one of ownSetting's shell variables it sets, a name no PATH folder holds); `command` is then one that says so
 * and fails, so only a call that really starts ssh stops. `variant` is the kind of ssh git would have told from the
 * program's name, where the command no longer starts with it (GIT_SSH_VARIANT). With nothing set and no ssh on PATH,
 * command is null: no ssh can start.
 */
export function sshCommand(env = process.env, { worktree, common, configured } = {}) {
  const shut = buildFolders(worktree, common);
  const shell = env.GIT_SSH_COMMAND || configured || null;
  const given = shell ?? (env.GIT_SSH || null);
  // A command that prints why and fails, for git to start in place of ssh (the ssh kind spares it git's probe).
  const refused = problem => ({ command: `printf '%s\\n' ${shellQuote(`kit: ${problem}`)} >&2; false`, problem, variant: "ssh" });
  const unknown = why => refused(`git's ssh command (${given}) cannot be told: ${why}; set it to a plain command line (a program and its words), or set ASE_KEY_GUARD=off to run without the lock`);
  let program = given ?? "ssh", before = "", after = "";
  // The command runs with the run's PATH without the folders that hold a link into the worktree (cleanFolders), so
  // the names it starts are looked up there, as they will be found (GPT second look, round 7).
  const folders = cleanFolders(env, shut).join(delimiter);
  const ran = { ...env, PATH: folders };
  if (shell !== null) {
    const words = shellWords(shell);
    if (!words) return unknown("it uses shell syntax beyond words and quotes");
    // As sh reads them: an unquoted NAME=value before the program sets a variable.
    const word = words.find(({ start, end }) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(shell.slice(start, end)));
    if (!word || !word.plain) return unknown("its program is not a plain word");
    // A PATH of its own would bring back folders a link into the worktree sits in, for what the program starts by name,
    // and one of ownSetting's shell variables would have a shell run code from a file a build wrote (TOOLS-329): before
    // the program or after it, for an env it starts in turn (timeout 30 env PATH=…), in any form ownSetting reads (R1-1,
    // SL-2).
    const setting = lineSetting(words.map(({ value }) => value));
    if (setting === FILLED) return unknown(`an -S string in it holds ${FILLED}, which an env there could fill in as PATH or BASH_ENV`);
    if (setting === INNER) return unknown("a $ or ` in it could be filled in as PATH= or BASH_ENV=");
    if (setting) return unknown(`it sets ${setting} itself`);
    // sh fills in a $ before an env started in turn reads the word, so "PA${EMPTY}TH=…" and ${X:-PATH}=… are PATH= by
    // then: a word after the program whose $ could start a NAME= (only name characters before it, an = after it), or
    // an -S string with a $ in it, cannot be told (ssh -i $HOME/… and -o User=$USER still can).
    const fills = (other, i) => { const at = other.marked.indexOf("\x01");
      return at >= 0 && other.start > word.start && ((/^[A-Za-z0-9_]*$/.test(other.marked.slice(0, at)) && other.marked.includes("=", at)) || Boolean(splitString(other.marked, words[i - 1]?.value)?.includes("\x01"))); };
    if (words.some(fills)) return unknown("sh fills in a $ in it, which an env there could read as PATH= or BASH_ENV=");
    // env started in turn would look its program up by name and read settings of its own (a quoted -S string).
    if (words.some(other => other.start > word.start && namesEnv(other.value))) return unknown("env looks its program up on PATH");
    // A shell started from the line (startedShell), with the words as sh fills them in: a $NAME or ${NAME} from the
    // environment (a name ends at a quote or a \, bounded), a ~ at the start as HOME. A pattern, a $ in another form
    // ($1, ${X:-sh}), or a value outside quotes that sh would split or expand as a pattern (a blank, one of IFS's
    // characters, * ? [) could name one unseen.
    const later = words.filter(other => other.start >= word.start);
    if (later.some(other => other.marked.includes("\x02"))) return unknown("sh expands a pattern in it, which could name a shell");
    // sh may set IFS back to blanks at its start (dash does), so those count whatever IFS the run has.
    const splitters = [" ", "\t", "\n", ...String(env.IFS ?? ""), "*", "?", "["];
    let reshaped = false;
    // Only a ~ alone or before a / is HOME: ~user is that user's home, ~+ and ~- other folders, and ~"…" stays a ~.
    if (later.some(other => /^\x03(?!\/|$)/.test(other.bounded))) return unknown("sh fills in a ~ in it from somewhere other than HOME, which could name a shell");
    let ownSet = null;
    const filled = later.map(other => other.bounded.replace(/(\x05?)\x01(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g, (_, outside, braced, bare) => {
      const name = braced ?? bare;
      if (shellSets.test(name) && !(name === "SHELL" && env.SHELL !== undefined)) ownSet ??= name;
      const value = env[name] ?? "";
      if (outside && splitters.some(char => value.includes(char))) reshaped = true;
      return value;
    }).replace(/^\x03/, home(env)).replace(/[\0\x04\x05]/g, ""));
    if (ownSet) return unknown(`sh sets $${ownSet} itself, whatever the run holds, so what it fills in could name a shell`);
    if (reshaped) return unknown("sh splits or expands what a $ fills in, which could name a shell");
    // A word with no quotes in it that fills in empty is dropped, which moves the words after it (ssh -F $EMPTY '…').
    if (filled.some((other, i) => other === "" && !later[i].bounded.includes("\x04"))) return unknown("sh drops a word that fills in empty, which moves the words after it");
    if (filled.some(other => other.includes("\x01"))) return unknown("sh fills in a $ in it, which could name a shell");
    // What sh fills in gets the env and setting checks above too: "$E" "$X" with E=/usr/bin/env and X=PATH=… is
    // timeout 30 env PATH=… by then (GPT second look, round 4).
    const filledSetting = lineSetting(filled);
    if (filledSetting) return unknown(`sh fills in a $ in it as ${[FILLED, INNER].includes(filledSetting) ? "a word an env there could read as PATH= or BASH_ENV=" : `${filledSetting}=, which sets ${filledSetting} itself`}`);
    if (filled.slice(1).some(namesEnv)) return unknown("sh fills in a $ in it as env, which looks its program up on PATH");
    const started = startedShell(filled, ran, shut);
    if (started) return unknown(`it starts a shell (${started}), and a shell can build PATH= or BASH_ENV= out of pieces${shellAdvice(started, "") ? `; ${shellAdvice(started, "")}` : ""}`);
    program = word.value; before = shell.slice(0, word.start); after = shell.slice(word.end);
  }
  try {
    let file;
    if (program.includes("/")) {
      if (shutIn(program, shut)) return refused(`git's ssh (${program}) is inside the worktree or its Git folder, where a build can change it; set GIT_SSH_COMMAND to one outside them, or set ASE_KEY_GUARD=off to run without the lock`);
      if (intoProc(program, shut)) return refused(`git's ssh (${program}) is a path into /proc or /dev, which leads to another program for each process that opens it; set GIT_SSH_COMMAND to a plain path, or set ASE_KEY_GUARD=off to run without the lock`);
      file = toStart(program);
    } else {
      const found = lookup(program, env, shut);
      if (!found.file && found.refused) return refused(linkRefusal(program, found.refused));
      if (!found.file) return given === null ? { command: null, problem: null, variant: null } : unknown(`no PATH folder holds ${program}`);
      file = found.file;
    }
    // env would look its program up by name again, by a link of another name too (R1-1).
    if (namesEnv(file)) return unknown("env looks its program up on PATH");
    // GIT_SSH (or a link of another name) can name a shell too; by its own name as well, for a relative path out of the
    // worktree (../x), which git takes from there and the kit resolved from its own folder.
    if (namesShell(file, ran, shut) || namesShell(program, ran, shut)) return unknown(`it starts a shell (${basename(program)}), and a shell can build PATH= or BASH_ENV= out of pieces`);
    const start = interpreted(file, [], env, shut, problem => { throw new Error(problem); }, 0, ran).flat();
    const path = folders === String(env.PATH ?? systemPath) ? "" : `PATH=${shellQuote(folders)} `;
    const command = `${before}${path}${start.map(shellQuote).join(" ")}${after}`;
    const kind = ["ssh", "plink", "putty", "tortoiseplink"].find(name => basename(file).toLowerCase() === name);
    return { command, problem: null, variant: kind && !command.startsWith(shellQuote(file)) ? kind : null };
  } catch (error) { return refused(error.message); }
}

/**
 * PATH for a run in `worktree`, or undefined when PATH needs no change (or is not set): its folders in their order,
 * without the ones inside the worktree or the Git folder, reached through a link there, or leading into /proc
 * (trustedFolders). A program started by a bare name then (whatever the CLI
 * itself starts; the kit's own starts go by full path, see lookup) is not found there either. A PATH with nothing
 * left would mean the current folder to execvp, so the system's own folders stand in, as for no PATH at all. A folder
 * elsewhere that holds a link into the worktree stays: only the names the kit itself starts are looked up past it.
 */
export function runPath(env = process.env, { worktree, common } = {}) {
  if (env.PATH === undefined) return undefined;
  const path = runFolders(env, buildFolders(worktree, common)).join(delimiter);
  return path === String(env.PATH) ? undefined : path;
}

// The lock holds only if a process inside it cannot read through another process's root folder in /proc, where
// nothing is masked (a setuid bwrap makes no user namespace and lets that read through): the probe runs inside bubblewrap
// as an agent would and says "inside" first, and only a probe that ran and found /proc shut lets the lock on. It also
// asks the X display for a cookie-less connection: a display that lets the user in by name (xhost +si:localuser, which
// some desktops set at every start) would let an agent type into any window. That has no lasting fix on such desktops,
// and turning the lock off would hand back the keys, so it is a warning (kit doctor, the run's log), never a refusal.
const probeScript = `
const { readFileSync } = require("node:fs");
const { connect } = require("node:net");
const [pid, marker, ...displays] = process.argv.slice(1);
console.log("inside");
try { readFileSync("/proc/" + pid + "/root" + marker); console.log("proc-open"); } catch {}
// An X11 setup request with no cookie on the display's abstract socket: answer 1 means it let us in.
const ask = name => new Promise(done => {
  const socket = connect({ path: "\\0/tmp/.X11-unix/" + name });
  const end = open => { socket.destroy(); done(open); };
  socket.setTimeout(3000, () => end("unknown"));
  socket.on("error", () => end("shut"));
  socket.on("connect", () => socket.write(Buffer.from([0x6c, 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
  socket.on("data", data => end(data[0] === 1 ? "open" : "shut"));
});
(async () => {
  for (const name of displays) {
    const state = await ask(name);
    if (state !== "shut") console.log("display-" + state + " " + name);
  }
  console.log("done");
})();
`;
// {problem, warning}: problem stops the lock, warning is said beside it.
function probeLock(env) {
  const dir = mkdtempSync(join(tmpdir(), "ase-key-probe-"));
  try {
    const marker = join(dir, "marker");
    writeFileSync(marker, "reachable\n");
    let displays = [];
    try { displays = readdirSync("/tmp/.X11-unix").filter(name => /^X\d+$/.test(name)); } catch { /* No X display here. */ }
    const masks = displays.length ? ["--tmpfs", "/tmp/.X11-unix"] : [];
    const result = spawnSync(bwrap, ["--dev-bind", "/", "/", "--tmpfs", dir, ...masks, "--", process.execPath, "-e", probeScript, String(process.pid), marker, ...displays],
      { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 20_000 });
    const said = String(result.stdout ?? "");
    if (said.includes("proc-open")) return { problem: "a program inside bubblewrap can still read other programs' files through /proc here (a setuid bwrap makes no user namespace); install the distribution's plain bubblewrap" };
    if (!said.startsWith("inside") || !said.includes("done")) {
      const why = result.error ? result.error.message : String(result.stderr ?? "").trim().split("\n").at(-1) || "it printed nothing";
      return { problem: `the start-up check inside bubblewrap gave no answer (${why}); try again, and if it stays, check that Node runs there: bwrap --dev-bind / / -- node -e 1` };
    }
    const open = said.match(/^display-open (\S+)$/m)?.[1], unknown = said.match(/^display-unknown (\S+)$/m)?.[1];
    const warning = open ? `the X display ${open} lets programs in without its cookie, so a locked agent could read the clipboard, watch keys typed into X windows and type into them; do not copy or type keys while agents run, and where the desktop allows it remove the by-name entry (xhost -si:localuser:$USER)`
      : unknown ? `the X display ${unknown} did not answer the start-up check, so it may let programs in without its cookie (then a locked agent could read the clipboard); do not copy or type keys while agents run` : null;
    return { problem: null, warning };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const lockAsked = "this system has no bubblewrap (it is Linux only), and ASE_KEY_GUARD=on asks for the lock or no run; unset it to start Claude, Grok and OpenCode unwrapped";
let probed, displayWarning = null, absent = false, bwrap = null, bindFdSupported = false;
/**
 * Whether bubblewrap runs and holds here: null, or the problem in plain words. Checked once per process; bwrap is
 * looked up in PATH's full-path folders outside `shut` (the worktree and the Git folder, see buildFolders).
 */
export function bwrapWorks(env = process.env, shut = []) {
  if (probed === undefined) {
    displayWarning = null;
    bindFdSupported = false;
    bwrap = programFor("bwrap", env, shut);
    absent = bwrap === null;
    // Linux installs it with one command; another system has none, and only ASE_KEY_GUARD=on makes that a problem.
    if (absent) probed = process.platform === "linux" ? "bubblewrap (bwrap) is not installed; install it (apt install bubblewrap)" : lockAsked;
    else {
      // The kit's own Node by its full path, never a program PATH names: this runs where the keys are (GPT second look,
      // TOOLS-390 round 1).
      const result = spawnSync(bwrap, ["--dev-bind", "/", "/", "--", process.execPath, "-e", "0"], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15_000 });
      const said = String(result.stderr ?? result.error?.message ?? "").trim().split("\n").at(-1) || `exit ${result.status}`;
      // The usual refusal: the system does not let ordinary users make the namespaces a sandbox needs.
      const blocked = /namespace|uid map|Operation not permitted|Permission denied/i.test(said);
      if (result.status === 0) {
        ({ problem: probed, warning: displayWarning } = probeLock(env));
        if (probed === null) {
          const help = spawnSync(bwrap, ["--help"], { env, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 10_000 });
          bindFdSupported = String(help.stdout ?? "").includes("--bind-fd ");
        }
      } else probed = blocked ? `the system blocks the sandboxes bubblewrap makes (${said}); give /usr/bin/bwrap an AppArmor profile that allows user namespaces (Ubuntu's bubblewrap package brings one), or on Ubuntu allow them until the next restart with sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
        : `bubblewrap (bwrap) cannot start here (${said}); run bwrap --dev-bind / / -- true to see why`;
    }
  }
  return probed;
}

/** What the lock does not cover, in one sentence, or null: a display it cannot shut (see probeLock), KIT_KEY_PATHS entries it does not lock. */
export function keyGuardWarning(env = process.env, shut = []) {
  bwrapWorks(env, shut);
  return [displayWarning, keyPathsWarning(env)].filter(Boolean).join("; ") || null;
}

// A system that has no bubblewrap (macOS, Windows; on Linux it installs with one command, so a missing one stops the
// run), and no ASE_KEY_GUARD=on asking for the lock or no run: Claude, Grok and OpenCode run without the wrapper.
const unwrappedNote = "off on this machine (no bubblewrap); builders can read key files (token variables are still dropped, and Codex keeps its own profile)";
function runsUnwrapped(env, shut) {
  bwrapWorks(env, shut);
  return absent && process.platform !== "linux" && !lockRequired(env);
}

/**
 * The key paths for a run with what their links point at, or why they cannot be locked: {paths, problem, glue}, the
 * problem in plain words with its step (glue joins the "set ASE_KEY_GUARD=off" that follows it). `cli` "" stands for
 * every CLI at once (kit doctor's check).
 */
function searchedPaths(cli, env, { apiRoute = false, worktree, common } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const sockets = [env.XDG_RUNTIME_DIR || `/run/user/${uid}`, `/tmp/tmux-${uid}`, "/run/screen", "/tmp/.X11-unix", real(fenceStateDir(env))];
  const { paths, unsafe, unlisted, tooLarge } = linkTargets(lockedPaths(cli, env, { apiRoute, cwd: worktree }), { skip: sockets,
    // Compared with the links' real targets, so through any link on the way (~/Projects -> /data/Projects).
    keep: [home(env), worktree, common].filter(Boolean).map(path => { try { return realpathSync(path); } catch { return resolve(path); } }) });
  if (unsafe.length) return { paths, problem: `a key folder links to a folder the lock cannot hide (${unsafe.join(", ")}); move the keys into a folder of their own`, glue: ", or" };
  if (unlisted.length) return { paths, problem: unlisted.map(listingProblem).join("; "), glue: "; or" };
  if (tooLarge) return { paths, problem: `${tooLarge} holds too many files to search for links (over 200000 in the key folders); clear old files there`, glue: ", or" };
  return { paths, problem: null };
}

// On resume, refresh Claude's private login inside a write-fenced bubblewrap that can only write `dir`: even if a
// leftover build process swaps the staged file before fchmod or swaps `claude/` right after validation and before
// rename, the kernel refuses any write or permission change outside `dir`.
const refreshCredentialsScript = `
const { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [target, staged, sourceMtime] = process.argv.slice(1);
const fail = () => { process.stderr.write("changed\\n"); process.exit(2); };
const tampered = new Set(["EROFS", "EXDEV", "EISDIR", "ENOTDIR", "ELOOP", "EACCES", "EPERM", "ENOENT"]);
let fd;
try {
  let actual;
  try { actual = realpathSync(target); } catch { fail(); }
  if (actual !== target || !lstatSync(target).isDirectory()) fail();
  const to = join(target, ".credentials.json");
  let info;
  try { info = lstatSync(to); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (info?.isDirectory()) fail();
  if (info && info.isFile() && Number(sourceMtime) <= info.mtimeMs) {
    if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) fail();
    process.exit(0);
  }
  const data = readFileSync(0);
  fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  fchmodSync(fd, 0o600);
  writeFileSync(fd, data);
  const { dev, ino } = fstatSync(fd);
  if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) fail();
  renameSync(staged, to);
  if (!lstatSync(target).isDirectory() || realpathSync(target) !== target) fail();
  const placed = lstatSync(to);
  if (!placed.isFile() || placed.dev !== dev || placed.ino !== ino) fail();
} catch (error) {
  if (tampered.has(error.code)) fail();
  throw error;
} finally {
  if (fd !== undefined) closeSync(fd);
  try { unlinkSync(staged); } catch {}
}
`;

function refreshClaudeCredentials(dir, target, sourceMtime, sourceBytes, env) {
  if (!bwrap) throw new Error("bubblewrap is required to refresh saved credentials");
  const staged = join(dir, `.credentials-${randomUUID()}.tmp`);
  const cleanEnv = { ...env };
  for (const key of Object.keys(scrubbedEnv("", env))) delete cleanEnv[key];
  const result = spawnSync(bwrap, ["--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "--bind", dir, dir,
    "--", process.execPath, "-e", refreshCredentialsScript, target, staged, String(sourceMtime)],
  { env: cleanEnv, input: sourceBytes, stdio: ["pipe", "ignore", "pipe"], encoding: "utf8", timeout: 20_000 });
  if (result.status === 0) return;
  if (result.status === 2) throw new Error("this build's saved session has a changed folder; start a new build");
  const why = result.error ? result.error.message : String(result.stderr ?? "").trim().split("\n").at(-1) || `exit ${result.status}`;
  throw new Error(`this build's saved session could not refresh credentials (${why}); start a new build`);
}

// Home setup and system folders a local push destination may never resolve into.
const homeSetupNames = [...new Set([".local", ".config", ".cache", ".ssh", ".gnupg", ".claude", ".codex", ".grok", "bin",
  ...homeKeyPaths.map(entry => entry.split("/")[0])])];
const systemMountRoots = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/proc", "/run", "/sbin", "/sys", "/usr"];
const noFollowDirFlags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

function isHomeSetup(target, env, cwd = process.cwd()) {
  const base = real(home(env));
  const folders = [
    ...homeSetupNames.map(name => join(base, name)),
    ...[env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME]
      .filter(value => isAbsolute(value ?? "")),
    ...[env.CLAUDE_CONFIG_DIR, env.CODEX_HOME, env.GROK_HOME, env.ZDOTDIR, env.GNUPGHOME]
      .filter(Boolean).flatMap(value => [resolve(cwd, value), resolve(process.cwd(), value)]),
    fenceStateDir(env),
  ].map(real);
  if (folders.some(folder => inside(target, folder))) return true;
  if (inside(target, base) && target !== base) {
    const first = relative(base, target).split(sep)[0];
    const tempRoot = real(tmpdir());
    const inHostTemp = inside(tempRoot, base) && tempRoot !== base && inside(target, tempRoot);
    if (first.startsWith(".") && !inHostTemp) return true;
  }
  return false;
}

function isSystemFolder(target) {
  const checkouts = ["/usr/local/src", "/usr/src"].map(real);
  if (checkouts.some(root => target !== root && inside(target, root))) return false;
  return systemMountRoots.map(real).some(root => inside(target, root));
}

function isPinnedTarget(entry) {
  return Boolean(entry && typeof entry === "object" && typeof entry.path === "string" && typeof entry.dev === "number" && typeof entry.ino === "number");
}

function verifyPinnedTarget(target) {
  const { path, fd, dev, ino } = target;
  if (typeof fd !== "number") return false;
  try {
    const fdInfo = fstatSync(fd);
    if (!fdInfo.isDirectory() || fdInfo.dev !== dev || fdInfo.ino !== ino) return false;
    if (process.platform === "linux" && readlinkSync(`/proc/self/fd/${fd}`) !== path) return false;
    const now = lstatSync(path);
    if (now.isSymbolicLink() || !now.isDirectory() || now.dev !== dev || now.ino !== ino) return false;
    return realpathSync(path) === path;
  } catch { return false; }
}

/**
 * Validate and pin a local bare Git push target with an open directory handle so a concurrent process cannot swap it
 * for a link into HOME between validation and mounting. Call `close()` when done (or pass to `checkLock`, whose
 * `close()` also releases it).
 */
export function openLocalPushTarget(path, { env = process.env, remote = "origin", url = path, cwd = process.cwd() } = {}) {
  const full = resolve(path);
  let handle = null;
  const close = () => {
    if (handle !== null) {
      const toClose = handle;
      handle = null;
      try { closeSync(toClose); } catch { /* Already closed. */ }
    }
  };
  const badRepo = () => new Error(`${remote} pushes to ${url}, which is not a direct Git repository folder (links and non-repository paths are refused under the key lock); push to a bare repository folder directly, or set ASE_KEY_GUARD=off to run without the lock`);
  try {
    handle = openSync(full, noFollowDirFlags);
    const info = fstatSync(handle);
    if (!info.isDirectory()) throw badRepo();
    const pinned = { path: full, get fd() { return handle; }, dev: info.dev, ino: info.ino, close };
    if (!verifyPinnedTarget(pinned)) throw badRepo();
    // Validate bare repository entries directly through the pinned directory handle on Linux so a swap mid-check
    // cannot substitute another folder.
    const at = process.platform === "linux" ? `/proc/self/fd/${handle}` : full;
    const entry = (name, check) => { try { return check(lstatSync(join(at, name))); } catch { return false; } };
    const isGit = !entry(".git", () => true)
      && entry("HEAD", stat => stat.isFile())
      && entry("objects", stat => stat.isDirectory())
      && entry("refs", stat => stat.isDirectory());
    if (!isGit) throw badRepo();
    const base = real(home(env));
    if (inside(base, full)) throw new Error("this push goes to a folder that holds your home folder; push to a repository folder of its own");
    if (isHomeSetup(full, env, cwd) || isSystemFolder(full)) throw new Error("this push goes to a home setup or system folder; push to a repository folder of its own");
    return pinned;
  } catch (error) {
    close();
    if (error.message.includes("not a direct Git repository folder") || error.message.startsWith("this push goes to ")) throw error;
    throw badRepo();
  }
}

// Run state is writable, but never in a home setup folder. A runner supplies a pointer in its artifacts so resumed
// builds keep their session under the kit's state folder (surviving reboots). Direct callers get a private temporary
// folder, removed by close(). CLI resources remain readable through links; settings and the CLI's own login are private
// copies so an atomic refresh changes no home file.
function writeFence(cli, env, { worktree, common, state, writable = [], session } = {}) {
  const work = [worktree, common].filter(Boolean).map(real), base = real(home(env));
  if (work.some(root => inside(base, root))) throw new Error("the write fence cannot make HOME or one of its parents writable; use a worktree and Git folder of their own");
  const pinnedDestinations = [], stringDestinations = [];
  for (const entry of writable) {
    if (!entry) continue;
    if (isPinnedTarget(entry)) {
      if (!verifyPinnedTarget(entry)) throw new Error("this push destination changed after validation; push to a repository folder of its own");
      if (inside(base, entry.path)) throw new Error("this push goes to a folder that holds your home folder; push to a repository folder of its own");
      if (isHomeSetup(entry.path, env, worktree) || isSystemFolder(entry.path)) throw new Error("this push goes to a home setup or system folder; push to a repository folder of its own");
      pinnedDestinations.push(entry);
    } else {
      const raw = resolve(entry);
      let info = null;
      try { info = lstatSync(raw); } catch { /* Missing path is ignored by bwrapArgs. */ }
      if (info?.isSymbolicLink()) throw new Error("this push goes to a link, not a direct repository folder; push to a repository folder of its own");
      const resolved = real(raw);
      if (inside(base, resolved)) throw new Error("this push goes to a folder that holds your home folder; push to a repository folder of its own");
      if (isHomeSetup(resolved, env, worktree) || isSystemFolder(resolved)) throw new Error("this push goes to a home setup or system folder; push to a repository folder of its own");
      if (info && resolved !== raw) throw new Error("this push goes to a link, not a direct repository folder; push to a repository folder of its own");
      stringDestinations.push(resolved);
    }
  }
  const named = [...work, ...stringDestinations];
  const roots = named.filter((root, index) => named.indexOf(root) === index && !named.some(other => other !== root && inside(root, other)));
  // Pinned destinations already inside the worktree or Git common folder need no separate bind mount. External pinned
  // destinations bind through --bind-fd when bubblewrap supports it (which closes the host directory handle before
  // execing the child; passing /proc/self/fd/N with --bind would leak a host-namespace fd into the sandbox). On older
  // bubblewrap without --bind-fd, the handle stays open only in the parent for verification through wrap() and is never
  // inherited by the sandboxed child.
  const externalRaw = pinnedDestinations.filter(target => !roots.some(root => inside(target.path, root)));
  const externalPinned = externalRaw.filter((target, index) =>
    externalRaw.findIndex(other => other.path === target.path) === index
    && !externalRaw.some(other => other.path !== target.path && inside(target.path, other.path)));
  const allRoots = [...roots, ...externalPinned.map(target => target.path)];
  const useBindFd = process.platform === "linux" && bindFdSupported;
  const writableFds = useBindFd ? externalPinned.map((target, index) => ({ childFd: 3 + index, path: target.path })) : [];
  const fds = useBindFd ? externalPinned.map(target => target.fd) : [];
  const extraRoots = useBindFd ? [] : externalPinned.map(target => target.path);
  // A persistent artifact is only a pointer. Its writable mount lives directly under the kit's state folder
  // (`${XDG_STATE_HOME:-~/.local/state}/agent-kit/fence`): the locked run can write inside its own folder but cannot
  // rename its root (its parent is masked and read-only). A sibling `<name>.owner` record ties each session to the
  // exact state link and worktree that created it, so another build cannot repoint its link at it.
  let dir, fresh = true, parent = null, ownerFile = null;
  const expectedState = state ? canonicalStatePointer(state) : "", expectedWorktree = worktree ? real(worktree) : "";
  if (state) {
    const fenceRoot = fenceStateDir(env);
    let info;
    try { info = lstatSync(state); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (info) {
      const invalid = () => new Error("this build's saved session cannot be used; start a new build");
      if (!info.isSymbolicLink()) throw invalid();
      dir = readlinkSync(state);
      let saved;
      try { saved = statSync(dir); }
      catch { throw new Error("this build's saved session is gone because its state folder was removed; start a new build"); }
      parent = real(fenceRoot);
      const owner = readFenceOwner(`${dir}.owner`);
      if (!fenceFolderPattern.test(basename(dir)) || realpathSync(dir) !== dir || dirname(dir) !== parent
        || !saved.isDirectory() || (saved.mode & 0o777) !== 0o700 || (typeof process.getuid === "function" && saved.uid !== process.getuid())
        || inside(base, dir) || allRoots.some(root => inside(parent, root))
        || !owner || owner.state !== expectedState || owner.worktree !== expectedWorktree) throw invalid();
      fresh = false;
    } else {
      mkdirSync(fenceRoot, { recursive: true, mode: 0o700 });
      parent = real(fenceRoot);
      if (inside(base, parent) || allRoots.some(root => inside(parent, root))) throw new Error("the write fence state folder cannot hold HOME or sit inside the worktree or Git folder; set XDG_STATE_HOME to a folder of its own");
      dir = mkdtempSync(join(parent, "ase-write-fence-"));
      ownerFile = `${dir}.owner`;
    }
  } else dir = mkdtempSync(join(real(tmpdir()), "ase-write-fence-"));
  const close = () => {
    for (const target of pinnedDestinations) target.close?.();
    if (!state) rmSync(dir, { recursive: true, force: true });
  };
  try {
    const folderAt = path => {
      if (fresh) mkdirSync(path, { recursive: true });
      let actual;
      try { actual = realpathSync(path); } catch { throw new Error("this build's saved session is missing a folder; start a new build"); }
      if (actual !== path) throw new Error("this build's saved session has a changed folder; start a new build");
      return path;
    };
    const folders = Object.fromEntries(["tmp", "cache"].map(name => [name, folderAt(join(dir, name))]));
    const extra = { TMPDIR: folders.tmp, TMP: folders.tmp, TEMP: folders.tmp, XDG_CACHE_HOME: folders.cache,
      npm_config_cache: join(folders.cache, "npm"), ...(process.platform === "linux" && env.PLAYWRIGHT_BROWSERS_PATH === undefined
        ? { PLAYWRIGHT_BROWSERS_PATH: resolve(worktree || process.cwd(), env.XDG_CACHE_HOME || join(home(env), ".cache"), "ms-playwright") } : {}) };
    const sources = cli === "claude" ? [[env.CLAUDE_CONFIG_DIR || join(home(env), ".claude"), join(dir, "claude"), "CLAUDE_CONFIG_DIR"]]
      : [];
    for (const [source, target, variable] of sources) {
      folderAt(target);
      if (fresh && existingPaths([source]).length) {
        for (const name of readdirSync(source)) {
          const from = join(source, name), to = join(target, name);
          // Session logs and caches can be huge. Copy Claude settings and credentials; link instructions and resources
          // read-only so global instructions and skills keep working without exposing home files to writes.
          if (/^(?:settings(?:\.local)?\.json|\.credentials\.json)$/.test(name) && statSync(from).isFile()) copyFileSync(from, to, constants.COPYFILE_EXCL);
          else if (["CLAUDE.md", "output-styles", "skills", "plugins", "commands", "agents", "hooks"].includes(name)) symlinkSync(resolve(from), to);
        }
        if (session && worktree) migrateClaudeSession(source, target, worktree, session);
      } else if (!fresh) {
        // On resume, pull in a newer home login inside the write fence so no replaced link can touch HOME.
        const from = join(source, ".credentials.json");
        let sourceInfo, sourceBytes;
        try {
          sourceInfo = statSync(from);
          if (sourceInfo.isFile()) sourceBytes = readFileSync(from);
        } catch { /* No home credentials file. */ }
        if (sourceBytes !== undefined) refreshClaudeCredentials(dir, target, sourceInfo.mtimeMs, sourceBytes, env);
      }
      if (variable) extra[variable] = target;
    }
    if (state && fresh) {
      writeFileSync(ownerFile, JSON.stringify({ state: expectedState, worktree: expectedWorktree }), { mode: 0o600 });
      symlinkSync(dir, state);
    }
    return { env: extra, dir, writable: parent ? [...roots, ...extraRoots] : [...roots, ...extraRoots, dir], writableFds, fds, pinned: pinnedDestinations, writableAfter: parent ? [dir] : [], parent, close };
  } catch (error) {
    if (fresh) {
      rmSync(dir, { recursive: true, force: true });
      if (ownerFile) rmSync(ownerFile, { force: true });
    }
    throw error;
  }
}

/**
 * The lock for one agent run, or {off: true} with ASE_KEY_GUARD=off and (with `missing`, the dropped variables and the
 * `warning` for the run's log) for Claude, Grok and OpenCode on a system without bubblewrap. Throws in plain words when
 * the lock is on and cannot be set up (a bubblewrap that cannot start or is missing on Linux, a key folder it cannot
 * search; no bubblewrap under ASE_KEY_GUARD=on). `close()` removes the run's private folder.
 *  - env: variables to drop for the call, and PATH without the worktree's and the Git folder's folders where it names one (runPath);
 *  - wrap(command, args): the command and arguments that run it inside the lock (Claude, Grok, OpenCode), or by its
 *    full path (Codex, which locks its own commands);
 *  - helper(command, args): the same for a program the runner itself starts on what the agent left (git status in the
 *    worktree, whose Git settings a build can change), for every CLI where bubblewrap runs; started with `env` dropped too.
 *    Both throw, like the lock itself, for a program PATH holds only as a link into the worktree or the Git folder;
 *  - codex: Codex's -c profile options;
 *  - claudeGuard: for the API route, a script the wrapper runs claude through once it has read its key;
 *  - bwrap: true when bubblewrap stands between the runner and the CLI (it reports a killed CLI as exit 128 + signal).
 */
export function keyGuard({ cli, kind, common, worktree, env = process.env, apiRoute = false, model = "", state, session }) {
  const plain = (command, args) => [command, args];
  const unlocked = { off: true, env: {}, wrap: plain, helper: plain, close() {} };
  const shut = buildFolders(worktree, common);
  const refuse = problem => { throw new Error(`cannot lock the key files for this ${kind}: ${problem}`); };
  // The executable file a command names, or null: a path as it is (from the worktree, where the run starts); a bare
  // name from the run's PATH folders, never one that leads into the worktree or the Git folder (see lookup). Where
  // PATH holds the name only as such a link, the bare name would start it outside the lock, so the run is refused.
  const program = command => {
    if (command.includes("/")) return [resolve(worktree ?? process.cwd(), command)].find(executable) ?? null;
    const { file, refused } = lookup(command, env, shut);
    return file ?? (refused ? refuse(linkRefusal(command, refused)) : null);
  };
  // Inside bubblewrap (by its own full path) with these arguments, by the program's full path. A program no PATH
  // folder holds is started as it is, with the run's PATH (`env` below), so the run still fails as a missing CLI (spawn
  // ENOENT), which kit review counts as an unavailable reviewer; nothing runs, so there is nothing to lock.
  const inside = (outer, lock = bwrap) => (command, args) => {
    const file = program(command);
    return file ? [lock, [...outer, "--", ...interpreted(file, args, env, shut, refuse).flat()]] : [command, args];
  };
  // Without bubblewrap before it (Codex, which locks its own commands; its runner's helpers where bubblewrap cannot
  // run; the API route's wrapper): by the program's full path all the same, since the bare name would take a link
  // before it on PATH, and so is a script's interpreter.
  const direct = (command, args) => {
    const file = program(command);
    return file ? interpreted(file, args, env, shut, refuse) : [command, args];
  };
  if (!keyGuardOn(env)) return unlocked;
  const path = runPath(env, { worktree, common });
  const scrub = { ...scrubbedEnv(cli, env, { apiRoute, model }), ...(path === undefined ? {} : { PATH: path }) };
  // A system without bubblewrap: Claude, Grok and OpenCode start as they are, with the token variables dropped, and the
  // run's log says so. Nothing is searched for them, so no key folder can stop the run. Codex goes on below: its own
  // profile needs no bubblewrap.
  if (cli !== "codex" && runsUnwrapped(env, shut)) return { ...unlocked, env: scrub, missing: true, warning: unwrappedNote };
  if (cli !== "codex" && bwrapWorks(env, shut) && outerLock(env)) return { ...unlocked, env: scrub, missing: true, warning: outerNote };
  // The run's own two programs are looked up now, so a run that could only start one through a link stops here, with
  // the reason in its log, before anything starts.
  for (const name of [cli, "git"]) program(name);
  const { paths, problem: refusal, glue } = searchedPaths(cli, env, { apiRoute, worktree, common });
  if (refusal) throw new Error(`cannot lock the key files for this ${kind}: ${refusal}${glue} set ASE_KEY_GUARD=off to run without the lock`);
  // Codex's own sandbox shares the network too, so the display warning (when bubblewrap can check it) applies to it.
  if (cli === "codex") {
    let display = Boolean(env.DISPLAY);
    try { display ||= readdirSync("/tmp/.X11-unix").some(name => /^X\d+$/.test(name)); } catch { /* No X display here. */ }
    const unchecked = display ? bwrapWorks(env, shut) : null;
    const gap = !display ? null : unchecked ? `the X display could not be checked (${absent && process.platform !== "linux" ? "this system has no bubblewrap" : unchecked}), so it may let programs in without its cookie; do not copy or type keys while agents run` : displayWarning;
    const warning = [gap, keyPathsWarning(env)].filter(Boolean).join("; ") || null;
    // Codex locks its own commands; the runner's helpers go through bubblewrap where it runs.
    const fence = kind === "build" ? writeFence(cli, env, { worktree, common }) : null;
    return { env: { ...scrub, ...fence?.env }, codex: codexProfile(kind, common, codexPaths(paths), fence?.dir), warning, wrap: direct,
      helper: bwrapWorks(env, shut) === null ? inside(bwrapArgs(paths, fence ? { writable: fence.writable, fence: true } : {})) : direct,
      close() { fence?.close(); } };
  }
  const problem = bwrapWorks(env, shut);
  if (problem) throw new Error(`cannot lock the key files for this ${kind}: ${problem}; or set ASE_KEY_GUARD=off to run without the lock`);
  // With the API route the wrapper turns on Claude's own command sandbox (bubblewrap too), which cannot start inside
  // this one: a build would lose its shell. Reviews there use only Read, Grep and Glob, with that sandbox off.
  if (apiRoute && kind === "build") throw new Error("cannot lock the key files for a build on the API route: its Claude sandbox cannot start inside the lock; build on the subscription (unset KIT_API_KEY_FILE), or set ASE_KEY_GUARD=off to run without the lock");
  // Grok's own read-only sandbox cannot start inside this one (agent-run turns it off), so a Grok review gets a read-only
  // lock instead: it writes only its own state folder and the temp folders.
  // The machine's kit stays read-only to the run (kitFolders).
  const fence = kind === "build" ? writeFence(cli, env, { worktree, common, state, session }) : null;
  Object.assign(scrub, fence?.env);
  const maskedPaths = fence?.parent && !paths.includes(fence.parent) ? [...paths, fence.parent] : paths;
  const outer = bwrapArgs(maskedPaths, { readOnly: kitFolders(env, { worktree, common }), ...(fence ? { writable: fence.writable, writableAfter: fence.writableAfter, fence: true } : cli === "grok" && kind === "review"
    ? { writable: [join(home(env), ".grok"), env.GROK_HOME, tmpdir(), "/tmp", env.XDG_RUNTIME_DIR].filter(Boolean).map(path => resolve(path)) } : {}) });
  const warning = keyGuardWarning(env, shut);
  if (!apiRoute) return { env: scrub, bwrap: true, warning, wrap: inside(outer), helper: inside(outer), close() { fence?.close(); } };
  // The API route's wrapper reads its key file first, outside the lock, then runs claude through this script: `<script>
  // claude <arguments>`. Inside the lock the bare name would take a link before the real claude on PATH, so the script
  // starts claude by the full path found here (where PATH holds none, the wrapper has stopped before it gets this far).
  const dir = mkdtempSync(join(tmpdir(), "ase-key-guard-"));
  const script = join(dir, "guard");
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  // Its interpreter too (`#!/usr/bin/env node`), found the same way.
  const claude = program("claude"), start = claude ? interpreted(claude, [], env, shut, refuse).flat() : [];
  writeFileSync(script, `#!/bin/sh\n${claude ? `[ "$1" = claude ] && { shift; set -- ${start.map(quote).join(" ")} "$@"; }\n` : ""}exec ${quote(bwrap)} ${outer.map(quote).join(" ")} -- "$@"\n`);
  chmodSync(script, 0o700);
  return { env: { ...scrub, KIT_CLAUDE_GUARD: script }, bwrap: true, warning, wrap: direct, helper: inside(outer), claudeGuard: script,
    close() { rmSync(dir, { recursive: true, force: true }); } };
}

// The mark of kit pr's lock for its checks: a file holding a random token in the desktop's runtime folder, which the lock
// masks with an empty folder of its own, so only a process inside that lock sees it there, and the same token in
// KIT_OUTER_LOCK. Outside the lock the runtime folder is the real one, which no locked build can write.
const markName = "kit-outer-lock";
const runtimeFolder = env => env.XDG_RUNTIME_DIR || (typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : "");
function outerMark(env, outer) {
  const runtime = runtimeFolder(env);
  // Only where the lock masks an existing runtime folder; without one, a run inside starts its own sandbox as before.
  if (!runtime.startsWith("/") || !outer.some((arg, index) => arg === "--tmpfs" && outer[index + 1] === resolve(runtime))) return { env: {}, args: [], close() {} };
  const token = randomUUID(), dir = mkdtempSync(join(tmpdir(), "ase-outer-lock-")), file = join(dir, markName);
  writeFileSync(file, token);
  const remount = outer.findIndex((word, index) => word === "--remount-ro" && outer[index + 1] === resolve(runtime));
  if (remount >= 0) outer.splice(remount, 2);
  return { env: { KIT_OUTER_LOCK: token }, args: ["--ro-bind", file, join(resolve(runtime), markName), ...(remount < 0 ? [] : ["--remount-ro", resolve(runtime)])], close() { rmSync(dir, { recursive: true, force: true }); } };
}
/**
 * Whether this process runs inside kit pr's lock for its checks: KIT_OUTER_LOCK matches the mark that lock placed in the
 * runtime folder, and the process is in a user namespace of its own (bubblewrap's). Then the machine's key files are
 * hidden already, and a run here that cannot start a sandbox of its own (a system that blocks one inside another)
 * starts without it, saying so in its log.
 */
export function outerLock(env = process.env) {
  if (!env.KIT_OUTER_LOCK || process.platform !== "linux") return false;
  try {
    if (readFileSync(join(resolve(runtimeFolder(env)), markName), "utf8") !== env.KIT_OUTER_LOCK) return false;
    return !/^\s*0\s+0\s+4294967295\s*$/.test(readFileSync("/proc/self/uid_map", "utf8"));
  } catch { return false; }
}
const outerNote = "inside kit pr's key lock for its checks: that lock hides the key files, and this run starts no sandbox of its own (one cannot start inside another here)";

// The clean room for git's ssh (TOOLS-390): the mirror image of the key lock. ssh needs the keys, so it cannot run inside
// that lock; it runs instead where the build's folders do not exist. The file system is as it is (devices too), so ssh
// reads its keys, its agent and known_hosts; the room has a process list of its own and starts in /.
const roomArgs = ["--die-with-parent", "--dev-bind", "/", "/", "--unshare-pid", "--proc", "/proc", "--chdir", "/"];

// A user namespace shows the host's root-owned files as nobody's. OpenSSH refuses included config files with that
// owner, even when their permissions are safe. Give the room private, read-only copies of the system client config,
// owned by the caller in its namespace. Keep the bytes and paths (including links into /usr/lib) unchanged. Never
// copy a writable file, another user's file, or anything reached through a build folder into the room.
function roomSystemSsh(folders, env, named) {
  const files = new Set(), seen = new Set();
  const sshHome = home(env);
  const visit = (path, system, depth = 0) => {
    if (depth > 16 || shutIn(path, folders)) return;
    let real, info;
    try { real = realpathSync(path); info = statSync(real); } catch { return; }
    const key = `${system}:${real}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (info.isFile()) {
      let content;
      try { content = readFileSync(real, "utf8"); } catch { return; }
      if (info.uid === 0 && !(info.mode & 0o022)) files.add(real);
      // Collect includes without running Host/Match or any command. ssh still parses the original bytes itself.
      // Relative includes keep the system/user context even when the including file lives somewhere else.
      for (const line of content.split(/\r?\n/)) {
        const include = /^\s*Include(?:\s*=\s*|\s+)(.*)/i.exec(line);
        if (!include) continue;
        const words = include[1].match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? [];
        for (const word of words) {
          if (word.startsWith("#")) break;
          let pattern = word.replace(/\\(.)|["']/g, (_, escaped) => escaped ?? "");
          pattern = pattern.replace(/\$\{([^}]+)\}/g, (_, name) => env[name] ?? "");
          if (pattern.startsWith("~/")) pattern = join(sshHome, pattern.slice(2));
          pattern = resolve(system ? "/etc/ssh" : join(sshHome, ".ssh"), pattern);
          try { for (const match of globSync(pattern)) visit(match, system, depth + 1); } catch { /* ssh reports an unreadable pattern. */ }
        }
      }
    }
  };
  visit("/etc/ssh/ssh_config", true);
  visit(join(sshHome, ".ssh/config"), false);
  const words = named ? leadingWords(named)?.map(word => word.value) ?? [] : [];
  for (let at = 1; at < words.length; at++) {
    const path = words[at] === "-F" ? words[++at] : words[at].startsWith("-F") ? words[at].slice(2) : null;
    if (path) visit(resolve(path), false);
  }
  return [...files];
}

let roomProbed;
// Whether the room starts here: null, or the problem in plain words. Checked once per process, after bwrapWorks.
function roomWorks(env, shut) {
  const problem = bwrapWorks(env, shut);
  if (problem) return problem;
  if (roomProbed === undefined) {
    // The kit's own Node by its full path, as in bwrapWorks: this room starts with the keys readable.
    const result = spawnSync(bwrap, [...roomArgs, "--", process.execPath, "-e", "0"], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15_000 });
    const said = String(result.stderr ?? result.error?.message ?? "").trim().split("\n").at(-1) || `exit ${result.status}`;
    roomProbed = result.status === 0 ? null : `bubblewrap cannot start it here (${said}); run bwrap ${roomArgs.join(" ")} -- true to see why`;
  }
  return roomProbed;
}

// The main worktree's core.worktree as git takes it: {path} (null when it is not set) or {problem}. git itself reads it
// (reading starts nothing) from the Git folder's own config, config.worktree too when extensions.worktreeConfig is on,
// with their includes and every form git allows; the last value wins, relative to the Git folder. A value from
// elsewhere (the lead's global config, the environment) is not the repository's. Where git cannot read it, the room
// does not start, since the main worktree could stay visible.
function coreWorktree(env, git, common) {
  const [program, ...before] = [git].flat();
  if (!program) return { problem: "git is not on PATH outside the worktree and the Git folder, so the Git folder's core.worktree cannot be read; put git from outside them on PATH" };
  const clean = { ...env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined };
  const result = spawnSync(program, [...before, "--git-dir", common, "config", "--includes", "--show-scope", "-z", "--get-all", "core.worktree"],
    { env: clean, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  if (result.status === 1 && !result.stdout) return { path: null };
  if (result.status !== 0) {
    const said = String(result.stderr ?? result.error?.message ?? "").trim().split("\n").at(-1) || `exit ${result.status}`;
    const fix = typeof result.status === "number" ? "; fix the Git folder's config (git config --list shows the line)" : "";
    return { problem: `git cannot read the Git folder's core.worktree (${said})${fix}` };
  }
  const parts = result.stdout.split("\0");
  let value = null;
  for (let at = 0; at + 1 < parts.length; at += 2) if (parts[at] === "local" || parts[at] === "worktree") value = parts[at + 1];
  return { path: value ? onDisk(common, value) : null };
}

// A path a build may have written into the Git folder, joined as the file system walks it: `..` is left in place, so
// that realpathSync.native takes it after the link before it (git's way), not by cutting text as resolve() does.
function onDisk(base, value) {
  return isAbsolute(value) ? value : `${base}/${value}`;
}

// The folders the room swaps for empty ones: the worktree, the Git folder, the main worktree (the folder that holds the
// Git folder as .git, or the one its core.worktree names) and every linked worktree the Git folder lists, where the two
// agree as git checks them (worktrees/<name>/gitdir names a .git file whose gitdir line leads back to that entry).
// A build can write the Git folder, so a folder found there is skipped when it is /, holds the home folder, /opt, /tmp,
// /var or a system folder, or lies inside a system folder (the loader and libc, /etc/ssh, /proc/<pid>, the agent's
// socket and DNS settings in /run): hiding one would stop every
// fetch, or send the search for ssh on to the next PATH folder. Only a folder below /usr/local/src or /usr/src, where
// checkouts live (/usr/local/src/project), is hidden there, as any worktree is, PATH folders in it too. Real paths of folders
// that exist, so bubblewrap makes no folder on the real file system; one inside another is hidden with it.
// {folders, problem}: problem when core.worktree cannot be read (coreWorktree).
function roomFolders(env, worktree, common, git) {
  const real = path => { try { return realpathSync.native(path); } catch { return null; } };
  const system = ["/bin", "/dev", "/etc", "/lib", "/lib64", "/proc", "/run", "/sbin", "/sys", "/usr"].map(real).filter(Boolean);
  const kept = [...system, ...[home(env), "/opt", "/tmp", "/var"].map(real).filter(Boolean)];
  const checkouts = ["/usr/local/src", "/usr/src"].map(real).filter(Boolean);
  const found = [];
  const add = (folder, fromGit) => {
    const path = folder && real(folder);
    try { if (!path || !statSync(path).isDirectory() || found.includes(path)) return; } catch { return; }
    const checkout = checkouts.some(other => path !== other && inside(path, other));
    const systemOwned = system.some(other => inside(path, other)) && !checkout;
    if (fromGit && (path === "/" || kept.some(other => inside(other, path)) || systemOwned)) return;
    found.push(path);
  };
  add(worktree, false);
  add(common, false);
  let problem = null;
  if (common) {
    if (basename(common) === ".git") add(dirname(common), true);
    const main = coreWorktree(env, git, common);
    problem = main.problem ?? null;
    add(main.path, true);
    let names = [];
    try { names = readdirSync(join(common, "worktrees")); } catch { /* No linked worktrees. */ }
    for (const name of names) try {
      const entry = join(common, "worktrees", name);
      const gitFile = onDisk(entry, readFileSync(join(entry, "gitdir"), "utf8").trim());
      const back = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(gitFile, "utf8"))?.[1];
      if (back && real(onDisk(dirname(gitFile), back)) === real(entry)) add(dirname(gitFile), true);
    } catch { /* Not a worktree's entry. */ }
  }
  return { folders: found.filter(path => !found.some(other => other !== path && inside(path, other))).sort(), problem };
}

// What ssh needs that the room would hide, in words that follow "the clean room for git's ssh", or null: the home folder
// (its keys and known_hosts) or the agent's socket inside the worktree or the Git folder.
function roomHides(env, folders) {
  const realOr = path => { try { return realpathSync(path); } catch { return resolve(path); } };
  const needed = [["your home folder, and ssh's keys with it", home(env)], ["ssh's agent", env.SSH_AUTH_SOCK]]
    .filter(([, path]) => path && isAbsolute(path)).map(([what, path]) => [what, realOr(path)]);
  for (const [what, path] of needed) {
    const folder = folders.find(other => inside(path, other));
    if (folder) return `would hide ${what} (${path}), which is inside the worktree or the Git folder (${folder}); keep the repository out of it`;
  }
  return null;
}

// The room's folders for a fetch or push from `worktree`, and why the room cannot start there (words that follow "the
// clean room"), or null. bubblewrap is looked up outside every one of those folders, so a bwrap left in another worktree
// never starts; it is looked up once per process, so one found earlier (by the key lock, which shuts out only the
// worktree and the Git folder) is refused when it lies in one. `git` reads core.worktree: the caller's, or the one PATH
// holds outside the worktree and the Git folder, as the kit's own git calls take it.
function roomCheck(env, worktree, common, git) {
  const { folders, problem: unread } = roomFolders(env, worktree, common, git ?? programFor("git", env, buildFolders(worktree, common)));
  if (unread) return { folders, problem: `cannot start: ${unread}` };
  // Before the room's own start-up check, which starts bubblewrap.
  const lock = bwrapWorks(env, folders);
  // Every folder its path passes through counts, as for the programs the kit starts: a link folder in another worktree
  // (<main>/tools-link -> /usr/bin) can lead elsewhere once the room has started.
  if (bwrap && shutIn(bwrap, folders)) return { folders, problem: `cannot start: bubblewrap on PATH (${bwrap}) is inside a worktree or the Git folder, or reached through one, where a build can change it; put a bwrap from outside them first on PATH` };
  const problem = lock ?? roomWorks(env, folders);
  if (problem) return { folders, problem: `cannot start: ${problem}` };
  return { folders, problem: roomHides(env, folders) };
}

// The words of a command line before its first shell operator outside quotes (a redirection, ;, |, &, a subshell), as
// shellWords reads them: git tells its kind of ssh from the first word, whatever follows it.
// A $(…), `…` or a \ before a line break inside double quotes ends the words before the word that holds it, so the
// first word still counts (plink -pw "$(cat file)").
function leadingWords(line) {
  let quote = null, wordStart = 0;
  for (let at = 0; at < line.length; at++) {
    const char = line[at];
    if (quote === '"' && (char === "`" || (char === "$" && line[at + 1] === "(") || (char === "\\" && line[at + 1] === "\n"))) return shellWords(line.slice(0, wordStart));
    if (quote) { if (char === quote) quote = null; else if (quote === '"' && char === "\\") at++; }
    else if (char === "'" || char === '"') quote = char;
    else if (char === " " || char === "\t") wordStart = at + 1;
    else if (char === "\\") at++;
    else if (";&|<>()`\n".includes(char) || (char === "$" && line[at + 1] === "(")) return shellWords(line.slice(0, at));
  }
  return shellWords(line);
}

// git's kind of ssh for a program name, as git tells it (any letter case, .exe or not).
const sshKind = name => /^(ssh|plink|tortoiseplink)(\.exe)?$/i.exec(basename(name))?.[1].toLowerCase() ?? null;

/**
 * git's ssh for a fetch or push on `worktree` in the clean room, as sshCommand's {command, problem, variant}; or null
 * where the path filter (sshCommand) guards it instead: with ASE_KEY_GUARD=off, on a system that is not Linux (no
 * bubblewrap there), and inside kit pr's lock for its checks (outerLock: the key files are hidden there already, and one
 * sandbox cannot start inside another). The command starts bubblewrap by its full path, which runs the lead's own ssh
 * command (GIT_SSH_COMMAND, `configured`: core.sshCommand from the lead's own config, GIT_SSH, or ssh) as written,
 * where the worktrees and the Git folder are empty (roomFolders): whatever path leads there, a /proc/<pid>/cwd link, a
 * link folder, a link a build changes after this check and before the room starts, it ends in "not found". A build
 * process still running could move a hidden folder aside once the room is up and put another at its path; the room
 * does not close that (README, "What the room does not close"). The rules sshCommand asks of the line
 * are not needed there. Where the room cannot start on Linux, or would hide the home folder or ssh's agent, `command`
 * says why and fails, so only a call that really starts ssh stops. `variant` is the kind of ssh git would have told
 * from the lead's first word, since the command's own first word is bubblewrap now. `git` (gitSafety's program) reads
 * the Git folder's core.worktree.
 */
export function sshRoom(env = process.env, { worktree, common, configured, git } = {}) {
  if (!keyGuardOn(env) || process.platform !== "linux" || outerLock(env)) return null;
  const refused = problem => ({ command: `printf '%s\\n' ${shellQuote(`kit: ${problem}`)} >&2; false`, problem, variant: "ssh" });
  const { folders, problem } = roomCheck(env, worktree, common, git);
  if (problem) return refused(`the clean room for git's ssh ${problem}; or set ASE_KEY_GUARD=off to run without the lock`);
  const named = env.GIT_SSH_COMMAND || configured || null;
  const inner = named ?? (env.GIT_SSH ? shellQuote(env.GIT_SSH) : "ssh");
  // As sh reads the line: an unquoted NAME=value before the program sets a variable.
  const first = named === null ? (env.GIT_SSH || "ssh") : leadingWords(named)?.find(({ start, end }) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(named.slice(start, end)))?.value;
  // A program not found (exit 127), such as an ssh PATH holds only as a link into a hidden folder, gets one line in plain
  // words after the shell's own. ssh also ends with the server's exit status, so the line names both causes.
  const notFound = `kit: a program was not found (exit 127). If it was git's ssh or a program it starts, the clean room keeps these folders empty: ${folders.join(", ")}; start it from a folder outside them. If a "not found" line above came from the server, the server lacks that program`;
  const script = `${inner} "$@"\nstatus=$?\n[ "$status" -ne 127 ] || printf '%s\\n' ${shellQuote(notFound)} >&2\nexit "$status"`;
  const files = roomSystemSsh(folders, env, named);
  const args = [...roomArgs, ...folders.flatMap(folder => ["--tmpfs", folder]),
    ...files.flatMap((file, index) => ["--ro-bind-data", String(index + 3), file]), "--", "/bin/sh", "-c", script, "sh"];
  const redirections = files.map((file, index) => ` ${index + 3}<${shellQuote(file)}`).join("");
  const line = [bwrap, ...args].map(shellQuote).join(" ");
  // POSIX shells only promise descriptors 0..9; find bash outside the build folders for larger config sets.
  const bash = files.length > 7 ? programFor("bash", env, folders) : null;
  if (files.length > 7 && !bash) return refused("the clean room for git's ssh needs bash on PATH outside the worktrees and the Git folder to open more than 7 system config files");
  const command = files.length <= 7 ? line + redirections
    : `${shellQuote(bash)} -c ${shellQuote(`exec ${line} "$@"${redirections}`)} sh`;
  return { command, problem: null, variant: first ? sshKind(first) : null };
}

/**
 * kit doctor's keyed-steps note: {state, text}, whether git's ssh runs in the clean room here. States: on; off
 * (ASE_KEY_GUARD=off); missing (a system without bubblewrap: the path filter, as before); inside (kit pr's lock for its
 * checks: the path filter there); problem (on Linux the room cannot start, or it would hide the home folder or ssh's
 * agent: a fetch or push from an ssh remote stops).
 */
export function cleanRoomReport(env = process.env, { worktree = process.cwd(), common } = {}) {
  if (!keyGuardOn(env)) return { state: "off", text: "off (ASE_KEY_GUARD=off)" };
  if (process.platform !== "linux") return { state: "missing", text: "not on this machine (no bubblewrap): git's ssh is checked by its path, as before" };
  if (outerLock(env)) return { state: "inside", text: "inside kit pr's key lock for its checks: git's ssh is checked by its path there" };
  // The same refusal a fetch or push would meet (sshRoom), so "on" is said only where the room really starts.
  const { problem } = roomCheck(env, worktree, common);
  if (problem) return { state: "problem", text: `clean room ${problem}` };
  return { state: "on", text: "clean room on (git's ssh starts where the worktrees and the Git folder are empty)" };
}

/**
 * The lock for the checks kit pr runs on what a build left (TOOLS-303): the project's check, unit, lint and spec
 * commands come from the worktree's own settings and run the build's code, in the lead's process, where the keys are.
 * {env, wrap, note}: wrap(command, args) starts a command inside bubblewrap with every key path hidden (every CLI's login
 * too), and env drops the token variables and the start-up file variables and leaves the worktree's and the Git
 * folder's folders off PATH. With ASE_KEY_GUARD=off, or on a system without bubblewrap (macOS, Windows), the checks run
 * as before and `note` says so in one line. Throws in plain words where the lock is on and cannot be set up, as a run's
 * lock does. `readOnly` names folders the lead's process relies on after the checks (kit pr's own program links): the
 * checks see them but cannot change them, and the machine's kit (kitFolders) with them. A check may start the key lock itself (the kit's own tests do), and many
 * systems block a sandbox inside another (Ubuntu's kernel.apparmor_restrict_unprivileged_userns=1), so the lock leaves
 * a mark only it can place (outerLock): a run inside it starts no sandbox of its own, since this one already hides the
 * key files.
 */
export function checkLock({ worktree, common, env = process.env, readOnly = [], writable = [] }) {
  const plain = (command, args) => [command, args];
  if (!keyGuardOn(env)) return { env: {}, fds: [], wrap: plain, note: "not locked (ASE_KEY_GUARD=off)" };
  const shut = buildFolders(worktree, common);
  const path = runPath(env, { worktree, common });
  const scrub = { ...scrubbedEnv("", env), ...(path === undefined ? {} : { PATH: path }) };
  if (runsUnwrapped(env, shut)) return { env: scrub, fds: [], wrap: plain, note: "not locked (no bubblewrap on this machine; token variables are still dropped)" };
  // Inside kit pr's own lock for its checks the checks are locked already: no second sandbox, and nothing to note.
  if (bwrapWorks(env, shut) && outerLock(env)) {
    const pinned = writable.filter(isPinnedTarget);
    for (const target of pinned) if (!verifyPinnedTarget(target)) throw new Error("this push destination changed after validation; push to a repository folder of its own");
    return { env: scrub, fds: [], wrap: plain, note: null, close() { for (const target of pinned) target.close?.(); } };
  }
  const refuse = problem => { throw new Error(`cannot lock the key files for kit pr's checks: ${problem}`); };
  const problem = bwrapWorks(env, shut);
  if (problem) refuse(`${problem}; or set ASE_KEY_GUARD=off to run without the lock`);
  const { paths, problem: refusal, glue } = searchedPaths("", env, { worktree, common });
  if (refusal) refuse(`${refusal}${glue} set ASE_KEY_GUARD=off to run without the lock`);
  const fence = writeFence("", env, { worktree, common, writable });
  Object.assign(scrub, fence.env);
  const outer = bwrapArgs(paths, { writable: fence.writable, writableFds: fence.writableFds, fence: true, readOnly: kitFolders(env, { worktree, common }), readOnlyAfter: readOnly });
  const mark = outerMark(env, outer);
  // The command starts inside, found there on the run's PATH: whatever it is, it runs locked.
  const wrap = (command, args) => {
    for (const target of fence.pinned) {
      if (!verifyPinnedTarget(target)) throw new Error("this push destination changed after validation; push to a repository folder of its own");
    }
    return [bwrap, [...outer, ...mark.args, "--", command, ...args]];
  };
  return { env: { ...scrub, ...mark.env }, fds: fence.fds, wrap, note: null, warning: keyGuardWarning(env, shut),
    close() { mark.close(); fence.close(); } };
}

/**
 * kit doctor's note: {state, text}, the lock's state in plain words. States: on; warning (on, with a gap); off
 * (ASE_KEY_GUARD=off); missing (a system without bubblewrap: Claude, Grok and OpenCode run unwrapped); problem
 * (bubblewrap cannot start: their runs stop); refused (a key folder cannot be searched or hidden: the runs that lock it
 * stop). The key folders are searched as a run in `worktree` would search them (for every CLI at once; for Codex alone
 * where the others run unwrapped), so "on" or "missing" is said only where a run would really start.
 */
export function keyGuardReport(env = process.env, { worktree = process.cwd(), common } = {}) {
  if (!keyGuardOn(env)) return { state: "off", text: "off (ASE_KEY_GUARD=off): agents the kit starts can read the key files" };
  // Unwrapped runs search nothing; a Codex run there still does, for its profile.
  const shut = buildFolders(worktree, common);
  const unwrapped = runsUnwrapped(env, shut), problem = bwrapWorks(env, shut);
  if (problem && !unwrapped && outerLock(env)) return { state: "on", text: `on (${outerNote})` };
  if (problem && !unwrapped) return { state: "problem", text: problem };
  const refusal = searchedPaths(unwrapped ? "codex" : "", env, { worktree, common }).problem;
  if (refusal) return { state: "refused", text: refusal };
  if (unwrapped) return { state: "missing", text: unwrappedNote };
  const warning = keyGuardWarning(env, shut);
  return warning ? { state: "warning", text: `on, but ${warning}` }
    : { state: "on", text: `on (bubblewrap runs; agents the kit starts cannot read the key files${env.KIT_API_KEY_FILE ? "; a Claude build on the API route is refused under the lock" : ""})` };
}

/** For tests: forget the bubblewrap probe. */
export function resetBwrapProbe() {
  probed = undefined;
  roomProbed = undefined;
  absent = false;
  bwrap = null;
  bindFdSupported = false;
}
