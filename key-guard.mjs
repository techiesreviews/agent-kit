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
import { accessSync, chmodSync, constants, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
// A start-up file that sets a variable the secret list (secretName) drops: every NAME= on a line, commented or not,
// fish's `set … NAME value` and its universal SETUVAR NAME:value. Names that only point somewhere (SSH_AUTH_SOCK,
// PASSWORD_STORE_DIR, …_FILE, …_PATH) are no secret, so they do not lock the file.
const pointer = name => handleNames.includes(name) || keyFolderVariables.includes(name) || /_(SOCK|FILE|DIR|PATH|HOME)$/i.test(name);
const setsSecret = text => [
  ...[...text.matchAll(/(?:^|[\s;#])([A-Za-z_]\w*)=/gm)].map(match => match[1]),
  ...[...text.matchAll(/^\s*set\s+(?:-\S+\s+)*([A-Za-z_]\w*)\s+\S/gm)].map(match => match[1]),
  ...[...text.matchAll(/^SETUVAR\s+(?:--\S+\s+)*([A-Za-z_]\w*):/gm)].map(match => match[1]),
].some(name => secretName.test(name) && !pointer(name));
function holds(file, test) {
  try { return statSync(file).isFile() && test(readFileSync(file, "utf8")); } catch { return false; }
}
function text(file) {
  try { return statSync(file).isFile() ? readFileSync(file, "utf8") : ""; } catch { return ""; }
}
// A path as a config file writes it: ~ and $HOME are the home, a relative one counts from `from`.
const expand = (path, base, from) => resolve(from, path.replace(/^["']|["']$/g, "").replace(/^~(?=\/|$)/, base).replace(/^\$(HOME|\{HOME\})(?=\/|$)/, base));
// The files a set of config files pull in, however long the chain: `source`/`.` for shell files, include paths for
// git. Each file is read once, so a loop ends, and a chain ends where a file names nothing new that exists.
function pulledIn(files, pattern, base) {
  const all = [...new Set(files)];
  for (let next = 0; next < all.length; next++) {
    for (const match of text(all[next]).matchAll(pattern)) {
      const file = expand(match[1], base, dirname(all[next]));
      if (!all.includes(file)) all.push(file);
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
    .filter(name => !keep.has(name) && (secretName.test(name) || handleNames.includes(name) || (!proxyName.test(name) && urlPassword.test(String(env[name] ?? "")))))
    .map(name => [name, undefined]));
}

function home(env) {
  return env.HOME || homedir();
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
    ...named(env.ZDOTDIR).flatMap(folder => [".zshenv", ".zshrc", ".zprofile"].map(name => join(folder, name)))];
  // Files they pull in count the same: a git include (include.path, includeIf), a shell `source` or `.`.
  const allGit = pulledIn(gitConfigs, /^\s*path\s*=\s*(\S+)/gm, base);
  paths.push(...allGit.filter(file => holds(file, keyedUrl)), ...pulledIn(startups, /^\s*(?:source|\.)\s+(\S+)/gm, base).filter(file => holds(file, setsSecret)));
  // Private keys named by git's sshCommand -i or ssh's IdentityFile, wherever they sit.
  for (const file of allGit) for (const [, key] of text(file).matchAll(/sshCommand\s*=.*\s-i\s*(\S+)/gm)) paths.push(expand(key, base, base));
  for (const [, key] of text(join(base, ".ssh/config")).matchAll(/^\s*IdentityFile\s+(\S+)/gim)) paths.push(expand(key, base, base));
  for (const [other, list] of Object.entries(cliKeyPaths)) {
    // Codex's own login and config are hidden from its commands (its profile); the API route signs Claude in with a key.
    if (other !== cli || cli === "codex" || (cli === "claude" && apiRoute)) paths.push(...list.map(path => join(base, path)));
  }
  if (cli !== "claude") paths.push(join(base, ".claude", claudeSettings));
  if (env.CODEX_HOME) paths.push(join(env.CODEX_HOME, "auth.json"), join(env.CODEX_HOME, "config.toml"));
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

// A path and the ones inside it: a masked folder hides what is inside, so only the outermost is mounted.
function inside(path, folder) {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * bubblewrap's arguments before "--": the file system as it is (devices included), each existing key folder swapped
 * for an empty one and each existing key file (or socket) for /dev/null, which bwrap mounts without devices so opening
 * it is refused. A path inside an already masked folder is left out. With `writable` (a list), the file system is
 * read-only but for those folders.
 */
export function bwrapArgs(paths, { writable = null } = {}) {
  // Read-only: the whole file system read-only with devices as they are, and writes only to the folders named.
  const args = writable === null ? ["--dev-bind", "/", "/"] : ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev",
    ...existingPaths(writable).flatMap(path => ["--bind", path, path])];
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
export function codexProfile(kind, common, paths) {
  const name = kind === "build" ? "kit-build" : "kit-review";
  const entries = [`":root"="read"`];
  if (kind === "build") entries.push(`":project_roots"={"."="write"}`, `":tmpdir"="write"`, `":slash_tmp"="write"`, `${toml(common)}="write"`);
  for (const path of paths) entries.push(`${toml(path)}="none"`);
  return ["-c", `default_permissions=${toml(name)}`, "-c", `permissions.${name}.filesystem={${entries.join(",")}}`,
    "-c", `permissions.${name}.network={enabled=${kind === "build"}}`];
}

// The executable file command names, as the run will find it, or null: a path as it is, a bare name through PATH. The
// run starts in `cwd` (the worktree), so a path or PATH folder that is not a full path counts from there, an empty PATH
// entry is that folder itself, and no PATH at all means the system's own folders (as execvp reads it).
const executable = file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } };
const pathFolders = env => (env.PATH === undefined ? "/bin:/usr/bin" : String(env.PATH)).split(delimiter);
function executableFor(command, env, cwd = process.cwd()) {
  const folders = command.includes("/") ? [""] : pathFolders(env);
  return folders.map(folder => resolve(cwd, folder, command)).find(executable) ?? null;
}
// bubblewrap's own file, or null: only PATH folders that are full paths count. The run starts in the worktree, where a
// relative or empty PATH entry would mean a folder a build can write, and a bwrap left there must never be the lock.
const bwrapFor = env => pathFolders(env).filter(folder => isAbsolute(folder)).map(folder => join(folder, "bwrap")).find(executable) ?? null;

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
let probed, displayWarning = null, absent = false, bwrap = null;
/** Whether bubblewrap runs and holds here: null, or the problem in plain words. Checked once per process; bwrap is looked up in PATH's full-path folders. */
export function bwrapWorks(env = process.env) {
  if (probed === undefined) {
    displayWarning = null;
    bwrap = bwrapFor(env);
    absent = bwrap === null;
    // Linux installs it with one command; another system has none, and only ASE_KEY_GUARD=on makes that a problem.
    if (absent) probed = process.platform === "linux" ? "bubblewrap (bwrap) is not installed; install it (apt install bubblewrap)" : lockAsked;
    else {
      const result = spawnSync(bwrap, ["--dev-bind", "/", "/", "--", "true"], { env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 15_000 });
      const said = String(result.stderr ?? result.error?.message ?? "").trim().split("\n").at(-1) || `exit ${result.status}`;
      // The usual refusal: the system does not let ordinary users make the namespaces a sandbox needs.
      const blocked = /namespace|uid map|Operation not permitted|Permission denied/i.test(said);
      if (result.status === 0) ({ problem: probed, warning: displayWarning } = probeLock(env));
      else probed = blocked ? `the system blocks the sandboxes bubblewrap makes (${said}); give /usr/bin/bwrap an AppArmor profile that allows user namespaces (Ubuntu's bubblewrap package brings one), or on Ubuntu allow them until the next restart with sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`
        : `bubblewrap (bwrap) cannot start here (${said}); run bwrap --dev-bind / / -- true to see why`;
    }
  }
  return probed;
}

/** What the lock does not cover, in one sentence, or null: a display it cannot shut (see probeLock), KIT_KEY_PATHS entries it does not lock. */
export function keyGuardWarning(env = process.env) {
  bwrapWorks(env);
  return [displayWarning, keyPathsWarning(env)].filter(Boolean).join("; ") || null;
}

// A system that has no bubblewrap (macOS, Windows; on Linux it installs with one command, so a missing one stops the
// run), and no ASE_KEY_GUARD=on asking for the lock or no run: Claude, Grok and OpenCode run without the wrapper.
const unwrappedNote = "off on this machine (no bubblewrap); builders can read key files (token variables are still dropped, and Codex keeps its own profile)";
function runsUnwrapped(env) {
  bwrapWorks(env);
  return absent && process.platform !== "linux" && !lockRequired(env);
}

/**
 * The key paths for a run with what their links point at, or why they cannot be locked: {paths, problem, glue}, the
 * problem in plain words with its step (glue joins the "set ASE_KEY_GUARD=off" that follows it). `cli` "" stands for
 * every CLI at once (kit doctor's check).
 */
function searchedPaths(cli, env, { apiRoute = false, worktree, common } = {}) {
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const sockets = [env.XDG_RUNTIME_DIR || `/run/user/${uid}`, `/tmp/tmux-${uid}`, "/run/screen", "/tmp/.X11-unix"];
  const { paths, unsafe, unlisted, tooLarge } = linkTargets(lockedPaths(cli, env, { apiRoute, cwd: worktree }), { skip: sockets,
    // Compared with the links' real targets, so through any link on the way (~/Projects -> /data/Projects).
    keep: [home(env), worktree, common].filter(Boolean).map(path => { try { return realpathSync(path); } catch { return resolve(path); } }) });
  if (unsafe.length) return { paths, problem: `a key folder links to a folder the lock cannot hide (${unsafe.join(", ")}); move the keys into a folder of their own`, glue: ", or" };
  if (unlisted.length) return { paths, problem: unlisted.map(listingProblem).join("; "), glue: "; or" };
  if (tooLarge) return { paths, problem: `${tooLarge} holds too many files to search for links (over 200000 in the key folders); clear old files there`, glue: ", or" };
  return { paths, problem: null };
}

/**
 * The lock for one agent run, or {off: true} with ASE_KEY_GUARD=off and (with `missing`, the dropped variables and the
 * `warning` for the run's log) for Claude, Grok and OpenCode on a system without bubblewrap. Throws in plain words when
 * the lock is on and cannot be set up (a bubblewrap that cannot start or is missing on Linux, a key folder it cannot
 * search; no bubblewrap under ASE_KEY_GUARD=on). `close()` removes the run's private folder.
 *  - env: variables to drop for the call;
 *  - wrap(command, args): the command and arguments that run it inside the lock (Claude, Grok, OpenCode);
 *  - helper(command, args): the same for a program the runner itself starts on what the agent left (git status in the
 *    worktree, whose Git settings a build can change), for every CLI where bubblewrap runs; started with `env` dropped too;
 *  - codex: Codex's -c profile options;
 *  - claudeGuard: for the API route, a script the wrapper runs claude through once it has read its key;
 *  - bwrap: true when bubblewrap stands between the runner and the CLI (it reports a killed CLI as exit 128 + signal).
 */
export function keyGuard({ cli, kind, common, worktree, env = process.env, apiRoute = false, model = "" }) {
  const plain = (command, args) => [command, args];
  const unlocked = { off: true, env: {}, wrap: plain, helper: plain, close() {} };
  // Inside bubblewrap (by its own full path, see bwrapFor) with these arguments, by the program's full path as the run will find it. A program that is not
  // there is started as it is, so the run still fails as a missing CLI (spawn ENOENT), which kit review counts as an
  // unavailable reviewer; nothing runs, so there is nothing to lock.
  const inside = (outer, lock = bwrap) => (command, args) => {
    const file = executableFor(command, env, worktree);
    return file ? [lock, [...outer, "--", file, ...args]] : [command, args];
  };
  if (!keyGuardOn(env)) return unlocked;
  const scrub = scrubbedEnv(cli, env, { apiRoute, model });
  // A system without bubblewrap: Claude, Grok and OpenCode start as they are, with the token variables dropped, and the
  // run's log says so. Nothing is searched for them, so no key folder can stop the run. Codex goes on below: its own
  // profile needs no bubblewrap.
  if (cli !== "codex" && runsUnwrapped(env)) return { ...unlocked, env: scrub, missing: true, warning: unwrappedNote };
  const { paths, problem: refusal, glue } = searchedPaths(cli, env, { apiRoute, worktree, common });
  if (refusal) throw new Error(`cannot lock the key files for this ${kind}: ${refusal}${glue} set ASE_KEY_GUARD=off to run without the lock`);
  // Codex's own sandbox shares the network too, so the display warning (when bubblewrap can check it) applies to it.
  if (cli === "codex") {
    let display = Boolean(env.DISPLAY);
    try { display ||= readdirSync("/tmp/.X11-unix").some(name => /^X\d+$/.test(name)); } catch { /* No X display here. */ }
    const unchecked = display ? bwrapWorks(env) : null;
    const gap = !display ? null : unchecked ? `the X display could not be checked (${absent && process.platform !== "linux" ? "this system has no bubblewrap" : unchecked}), so it may let programs in without its cookie; do not copy or type keys while agents run` : displayWarning;
    const warning = [gap, keyPathsWarning(env)].filter(Boolean).join("; ") || null;
    // Codex locks its own commands; the runner's helpers go through bubblewrap where it runs.
    return { env: scrub, codex: codexProfile(kind, common, codexPaths(paths)), warning, wrap: plain, helper: bwrapWorks(env) === null ? inside(bwrapArgs(paths)) : plain, close() {} };
  }
  const problem = bwrapWorks(env);
  if (problem) throw new Error(`cannot lock the key files for this ${kind}: ${problem}; or set ASE_KEY_GUARD=off to run without the lock`);
  // With the API route the wrapper turns on Claude's own command sandbox (bubblewrap too), which cannot start inside
  // this one: a build would lose its shell. Reviews there use only Read, Grep and Glob, with that sandbox off.
  if (apiRoute && kind === "build") throw new Error("cannot lock the key files for a build on the API route: its Claude sandbox cannot start inside the lock; build on the subscription (unset KIT_API_KEY_FILE), or set ASE_KEY_GUARD=off to run without the lock");
  // Grok's own read-only sandbox cannot start inside this one (agent-run turns it off), so a Grok review gets a read-only
  // lock instead: it writes only its own state folder and the temp folders.
  const outer = bwrapArgs(paths, cli === "grok" && kind === "review"
    ? { writable: [join(home(env), ".grok"), env.GROK_HOME, tmpdir(), "/tmp", env.XDG_RUNTIME_DIR].filter(Boolean).map(path => resolve(path)) } : {});
  const warning = keyGuardWarning(env);
  if (!apiRoute) return { env: scrub, bwrap: true, warning, wrap: inside(outer), helper: inside(outer), close() {} };
  // The API route's wrapper reads its key file first, outside the lock, then runs claude through this script.
  const dir = mkdtempSync(join(tmpdir(), "ase-key-guard-"));
  const script = join(dir, "guard");
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  writeFileSync(script, `#!/bin/sh\nexec ${quote(bwrap)} ${outer.map(quote).join(" ")} -- "$@"\n`);
  chmodSync(script, 0o700);
  return { env: { ...scrub, KIT_CLAUDE_GUARD: script }, bwrap: true, warning, wrap: plain, helper: inside(outer), claudeGuard: script,
    close() { rmSync(dir, { recursive: true, force: true }); } };
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
  const unwrapped = runsUnwrapped(env), problem = bwrapWorks(env);
  if (problem && !unwrapped) return { state: "problem", text: problem };
  const refusal = searchedPaths(unwrapped ? "codex" : "", env, { worktree, common }).problem;
  if (refusal) return { state: "refused", text: refusal };
  if (unwrapped) return { state: "missing", text: unwrappedNote };
  const warning = keyGuardWarning(env);
  return warning ? { state: "warning", text: `on, but ${warning}` }
    : { state: "on", text: `on (bubblewrap runs; agents the kit starts cannot read the key files${env.KIT_API_KEY_FILE ? "; a Claude build on the API route is refused under the lock" : ""})` };
}

/** For tests: forget the bubblewrap probe. */
export function resetBwrapProbe() {
  probed = undefined;
  absent = false;
  bwrap = null;
}
