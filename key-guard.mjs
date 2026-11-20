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
import { accessSync, chmodSync, closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
export function bwrapArgs(paths, { writable = null, readOnly = [], readOnlyAfter = [] } = {}) {
  // Read-only: the whole file system read-only with devices as they are, and writes only to the folders named. The
  // `readOnly` folders come next, before the masks, so a key path inside one stays hidden; `readOnlyAfter` after them,
  // so a folder inside a masked one (kit pr's links in a temp folder under the runtime folder) is still there.
  const args = [...(writable === null ? ["--dev-bind", "/", "/"] : ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev",
    ...existingPaths(writable).flatMap(path => ["--bind", path, path])]), ...existingPaths(readOnly).flatMap(path => ["--ro-bind", path, path])];
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
export function codexProfile(kind, common, paths) {
  const name = kind === "build" ? "kit-build" : "kit-review";
  const entries = [`":root"="read"`];
  if (kind === "build") entries.push(`":project_roots"={"."="write"}`, `":tmpdir"="write"`, `":slash_tmp"="write"`, `${toml(common)}="write"`);
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
// A path with every link in it followed, as far as it exists: a folder that is not there yet is read through the
// links of the folders above it, so making it later moves it nowhere else.
function real(path) {
  const rest = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try { return join(realpathSync(at), ...rest); }
    catch { if (dirname(at) === at) return resolve(path); rest.unshift(basename(at)); }
  }
}
// The two folders a build is meant to write, for the comparison: the worktree and the Git folder, links followed.
const buildFolders = (worktree, common) => [worktree, common].filter(Boolean).map(real);
const trustedFolders = (env, shut) => pathFolders(env).filter(folder => isAbsolute(folder) && !shut.some(root => inside(real(folder), root)));
// The folders of the run's own PATH (runPath): the trusted ones, or the system's own when none is left.
const runFolders = (env, shut) => { const folders = trustedFolders(env, shut); return folders.length ? folders : systemPath.split(delimiter); };
// What a bare name stands for in those folders: `file`, the first executable there that does not lead into the
// worktree or the Git folder, or null; and `refused`, the first one before it that does. Such a one sits in a folder
// that stays on the run's PATH (a link someone made from a folder of their own to a program in the worktree, which a
// build can swap), so the bare name would start it, outside the lock: with no `file` to start in its place, the name
// is not started at all (linkRefusal). With neither, no folder holds an executable by that name, and starting the
// bare name with the run's PATH finds none either.
function lookup(name, env, shut) {
  let refused = null;
  for (const folder of runFolders(env, shut)) {
    const file = join(folder, name);
    if (!executable(file)) continue;
    if (!shut.some(root => inside(real(file), root))) return { file, refused };
    refused ??= file;
  }
  return { file: null, refused };
}
// The executable file a bare name stands for, from those folders only, or null.
const programFor = (name, env, shut) => lookup(name, env, shut).file;
// Why a program found only through such a link is not started, with the step that fixes it.
const linkRefusal = (name, file) => `${name} on PATH is ${file}, a link into the worktree or its Git folder (${real(file)}), where a build can change it, so it is not started; put a ${name} from outside them on PATH, or set ASE_KEY_GUARD=off to run without the lock`;
// The variable a word sets for an env that reads it, or undefined: PATH, or BASH_ENV or ENV (the file a bash or sh it
// starts reads before anything else, TOOLS-329). It counts at the word's start, after a character no variable name holds
// (a blank inside one quoted -S string, an option's =), or joined to an -S option (-SPATH=…, -iSPATH=…), so another env
// the line starts (busybox env, coreutils env) cannot hide one in its own words; XPATH= and MY_ENV= are other variables.
const ownSetting = word => /(?:^|[^A-Za-z0-9_]|^-[A-Za-z]*S)(PATH|BASH_ENV|ENV)=/.exec(word)?.[1];
// Whether a word names env: by name or by a path to it (links followed), or as a multi-call binary's choice of it.
const namesEnv = word => basename(word) === "env" || (word.includes("/") && basename(real(word)) === "env") || /^--coreutils-prog(?:-shebang)?=env$/.test(word);

// A script's first line names its interpreter, and `#!/usr/bin/env node` has env look node up by its bare name on PATH,
// where a link a person made into the worktree or the Git folder stays (only the names the kit starts are looked up past
// it). So the kit reads that line itself and starts the interpreter by the full path it finds the way it finds its own
// programs (lookup), with the script as its argument (TOOLS-303): Codex and the API route's wrapper start outside
// bubblewrap. The interpreter may be a script too (an asdf or volta shim, or one a full path names), so this goes on
// for four levels, as the kernel does, and refuses past them. env -S (TOOLS-320) is read as env reads it (splitWords):
// NAME=value words before the program stay with env, which then gets the program by its full path. A first line that
// names a full path inside the worktree or the Git folder, an env option other than -S, -S words env would expand or
// that cannot be split, a PATH among those words or env as the program (TOOLS-326), a BASH_ENV or ENV among them or env
// among the program's words (TOOLS-329), or a name PATH holds only as such a
// link is refused through `refuse`; a name no PATH folder holds is left to start as it is (and fail).
function interpreted(file, args, env, shut, refuse, depth = 0) {
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
  if (basename(interpreter) !== "env") {
    if (shut.some(root => inside(real(interpreter), root))) refuse(`${file} starts with ${interpreter}, inside the worktree or its Git folder, where a build can change it`);
    // A binary interpreter the kernel starts itself; one that is a script again is followed (the kernel passes what
    // follows the interpreter as one argument, before the script).
    const next = interpreted(interpreter, [...(rest ? [rest] : []), file, ...args], env, shut, refuse, depth + 1);
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
  // BASH_ENV or ENV would have a shell the line starts read a file first, one a build may have written (TOOLS-329).
  const setting = [...assignments, ...words].map(ownSetting).find(Boolean);
  if (setting === "PATH") refuse(`${file} starts with env ${rest}, which sets PATH itself, so a program it starts by name could lead into the worktree or its Git folder; drop PATH= from that line, or set ASE_KEY_GUARD=off to run without the lock`);
  if (setting) refuse(`${file} starts with env ${rest}, which sets ${setting} itself, a file a shell it starts reads first and a build could have written; drop ${setting}= from that line, or set ASE_KEY_GUARD=off to run without the lock`);
  const [name, ...options] = words;
  let found;
  if (name.includes("/")) {
    if (shut.some(root => inside(real(name), root))) refuse(`${file} starts with env ${name}, inside the worktree or its Git folder, where a build can change it`);
    found = resolve(name);
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
  const [command, commandArgs] = interpreted(found, [...options, file, ...args], env, shut, refuse, depth + 1);
  if (!assignments.length) return [command, commandArgs];
  // env sets them and starts the program by the full path it is given (one with = in it would read as one more).
  if (shut.some(root => inside(real(interpreter), root))) refuse(`${file} starts with ${interpreter}, inside the worktree or its Git folder, where a build can change it`);
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
        value += line.slice(at + 1, close); at = close + 1;
      } else if (char === '"') {
        for (at++; at < line.length && line[at] !== '"'; at++) {
          let inner = line[at], escaped = false;
          if (inner === "\\" && '"\\$`'.includes(line[at + 1] ?? "")) { inner = line[++at]; escaped = true; }
          else if (inner === "`" || (inner === "$" && line[at + 1] === "(")) return null;
          value += inner === "$" && !escaped ? "\0" : inner;
        }
        if (at >= line.length) return null;
        at++;
      } else if (char === "\\") {
        if (at + 1 >= line.length || line[at + 1] === "\n") return null;
        value += line[at + 1]; at += 2;
      } else if (";&|<>()`\n".includes(char) || (char === "$" && line[at + 1] === "(")) return null;
      else { value += /[$*?[]/.test(char) || ((char === "~" || char === "#") && at === start) ? "\0" : char; at++; }
    }
    words.push({ value: value.replaceAll("\0", ""), start, end: at, plain: !value.includes("\0") });
  }
  return words;
}
const shellQuote = word => /^[A-Za-z0-9_/.,:+@%=-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

// The run's PATH folders (runFolders) without any that holds a link into the worktree or the Git folder, by any name:
// git's ssh command gets these, so a program that starts another by its bare name (timeout, sshpass, a wrapper script)
// finds none there either. The system's own folders stand in where none is left.
function cleanFolders(env, shut) {
  const folders = runFolders(env, shut).filter(folder => {
    let entries = [];
    try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return true; }
    return !entries.some(entry => entry.isSymbolicLink() && shut.some(root => inside(real(join(folder, entry.name)), root)));
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
 * syntax beyond words and quotes, an expansion, env by any name or started in turn, a PATH, BASH_ENV or ENV it sets, a
 * name no PATH folder holds); `command` is then one that says so
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
  if (shell !== null) {
    const words = shellWords(shell);
    if (!words) return unknown("it uses shell syntax beyond words and quotes");
    // As sh reads them: an unquoted NAME=value before the program sets a variable.
    const word = words.find(({ start, end }) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(shell.slice(start, end)));
    if (!word || !word.plain) return unknown("its program is not a plain word");
    // A PATH of its own would bring back folders a link into the worktree sits in, for what the program starts by name,
    // and a BASH_ENV or ENV would have a shell read a file a build may have written first (TOOLS-329): before the program
    // or after it, for an env it starts in turn (timeout 30 env PATH=…), in any form ownSetting reads (R1-1, SL-2).
    const setting = words.map(({ value }) => ownSetting(value)).find(Boolean);
    if (setting) return unknown(`it sets ${setting} itself`);
    // env started in turn would look its program up by name and read settings of its own (a quoted -S string).
    if (words.some(other => other.start > word.start && namesEnv(other.value))) return unknown("env looks its program up on PATH");
    program = word.value; before = shell.slice(0, word.start); after = shell.slice(word.end);
  }
  try {
    let file;
    if (program.includes("/")) {
      if (shut.some(root => inside(real(program), root))) return refused(`git's ssh (${program}) is inside the worktree or its Git folder, where a build can change it; set GIT_SSH_COMMAND to one outside them, or set ASE_KEY_GUARD=off to run without the lock`);
      file = resolve(program);
    } else {
      const found = lookup(program, env, shut);
      if (!found.file && found.refused) return refused(linkRefusal(program, found.refused));
      if (!found.file) return given === null ? { command: null, problem: null, variant: null } : unknown(`no PATH folder holds ${program}`);
      file = found.file;
    }
    // env would look its program up by name again, by a link of another name too (R1-1).
    if (namesEnv(file)) return unknown("env looks its program up on PATH");
    const start = interpreted(file, [], env, shut, problem => { throw new Error(problem); }).flat();
    const folders = cleanFolders(env, shut).join(delimiter);
    const path = folders === String(env.PATH ?? systemPath) ? "" : `PATH=${shellQuote(folders)} `;
    const command = `${before}${path}${start.map(shellQuote).join(" ")}${after}`;
    const kind = ["ssh", "plink", "putty", "tortoiseplink"].find(name => basename(file).toLowerCase() === name);
    return { command, problem: null, variant: kind && !command.startsWith(shellQuote(file)) ? kind : null };
  } catch (error) { return refused(error.message); }
}

/**
 * PATH for a run in `worktree`, or undefined when PATH needs no change (or is not set): its folders in their order,
 * without the ones inside the worktree or the Git folder. A program started by a bare name then (whatever the CLI
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
let probed, displayWarning = null, absent = false, bwrap = null;
/**
 * Whether bubblewrap runs and holds here: null, or the problem in plain words. Checked once per process; bwrap is
 * looked up in PATH's full-path folders outside `shut` (the worktree and the Git folder, see buildFolders).
 */
export function bwrapWorks(env = process.env, shut = []) {
  if (probed === undefined) {
    displayWarning = null;
    bwrap = programFor("bwrap", env, shut);
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
export function keyGuard({ cli, kind, common, worktree, env = process.env, apiRoute = false, model = "" }) {
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
    return { env: scrub, codex: codexProfile(kind, common, codexPaths(paths)), warning, wrap: direct, helper: bwrapWorks(env, shut) === null ? inside(bwrapArgs(paths)) : direct, close() {} };
  }
  const problem = bwrapWorks(env, shut);
  if (problem) throw new Error(`cannot lock the key files for this ${kind}: ${problem}; or set ASE_KEY_GUARD=off to run without the lock`);
  // With the API route the wrapper turns on Claude's own command sandbox (bubblewrap too), which cannot start inside
  // this one: a build would lose its shell. Reviews there use only Read, Grep and Glob, with that sandbox off.
  if (apiRoute && kind === "build") throw new Error("cannot lock the key files for a build on the API route: its Claude sandbox cannot start inside the lock; build on the subscription (unset KIT_API_KEY_FILE), or set ASE_KEY_GUARD=off to run without the lock");
  // Grok's own read-only sandbox cannot start inside this one (agent-run turns it off), so a Grok review gets a read-only
  // lock instead: it writes only its own state folder and the temp folders.
  // The machine's kit stays read-only to the run (kitFolders).
  const outer = bwrapArgs(paths, { readOnly: kitFolders(env, { worktree, common }), ...(cli === "grok" && kind === "review"
    ? { writable: [join(home(env), ".grok"), env.GROK_HOME, tmpdir(), "/tmp", env.XDG_RUNTIME_DIR].filter(Boolean).map(path => resolve(path)) } : {}) });
  const warning = keyGuardWarning(env, shut);
  if (!apiRoute) return { env: scrub, bwrap: true, warning, wrap: inside(outer), helper: inside(outer), close() {} };
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
  return { env: { KIT_OUTER_LOCK: token }, args: ["--ro-bind", file, join(resolve(runtime), markName)], close() { rmSync(dir, { recursive: true, force: true }); } };
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
export function checkLock({ worktree, common, env = process.env, readOnly = [] }) {
  const plain = (command, args) => [command, args];
  if (!keyGuardOn(env)) return { env: {}, wrap: plain, note: "not locked (ASE_KEY_GUARD=off)" };
  const shut = buildFolders(worktree, common);
  const path = runPath(env, { worktree, common });
  const scrub = { ...scrubbedEnv("", env), ...(path === undefined ? {} : { PATH: path }) };
  if (runsUnwrapped(env, shut)) return { env: scrub, wrap: plain, note: "not locked (no bubblewrap on this machine; token variables are still dropped)" };
  // Inside kit pr's own lock for its checks the checks are locked already: no second sandbox, and nothing to note.
  if (bwrapWorks(env, shut) && outerLock(env)) return { env: scrub, wrap: plain, note: null };
  const refuse = problem => { throw new Error(`cannot lock the key files for kit pr's checks: ${problem}`); };
  const problem = bwrapWorks(env, shut);
  if (problem) refuse(`${problem}; or set ASE_KEY_GUARD=off to run without the lock`);
  const { paths, problem: refusal, glue } = searchedPaths("", env, { worktree, common });
  if (refusal) refuse(`${refusal}${glue} set ASE_KEY_GUARD=off to run without the lock`);
  const outer = bwrapArgs(paths, { readOnly: kitFolders(env, { worktree, common }), readOnlyAfter: readOnly });
  const mark = outerMark(env, outer);
  // The command starts inside, found there on the run's PATH: whatever it is, it runs locked.
  return { env: { ...scrub, ...mark.env }, wrap: (command, args) => [bwrap, [...outer, ...mark.args, "--", command, ...args]], note: null, warning: keyGuardWarning(env, shut),
    close: mark.close };
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
  absent = false;
  bwrap = null;
}
