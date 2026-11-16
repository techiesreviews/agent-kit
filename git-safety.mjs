// Git with the keys, on a worktree a build wrote (TOOLS-303). The key lock (key-guard.mjs) keeps a locked build from
// reading the key files while it runs, but not from writing: the repository's Git settings and hooks are a build's to
// change, and the git commands the runner and kit pr run afterwards, in the lead's own process with the keys, would
// start whatever those name. So every such git call gets an environment that switches them off:
// - no hooks (core.hooksPath=/dev/null), no file system monitor, no signing or signature checks, no automatic
//   maintenance and no submodule recursion;
// - every setting in the repository's own config (local and worktree scope, includes followed) that names a program
//   (a filter's clean, smudge or process, a diff tool or text converter, a merge driver, an editor, a pager, an ssh
//   command, a credential helper, an alias...) is set empty on top of it, which runs nothing;
// - a call that needs no network reads neither the global nor the system Git config (a build can write ~/.gitconfig
//   too); a few harmless settings from them are carried over: the user's name and e-mail, the excludes file and the
//   line-ending settings;
// - safe.directory names only the worktree and its Git folder.
// A call that reaches the network (fetch, push) needs the user's own credential helper, so it keeps the global and
// system config; one whose repository config holds http or credential settings is refused instead, since those could
// send the credentials elsewhere (a proxy, a certificate, a helper). A URL rewrite (url.*.insteadOf) leads only to
// another host, which gets no credentials meant for this one, or to a folder on this machine: git clears these
// settings for the receive-pack of a folder remote, which runs that folder's own hooks, so kit pr pushes to a folder
// remote inside the key lock (it needs no credentials). A remote helper the repository's config picks
// (remote.<name>.vcs, a URL of the form <helper>::<address>, as a remote's URL or a rewrite's) is git-remote-<helper>
// found on PATH, so a fetch or push refuses it too; and every call allows only the transports git has itself (file,
// git, http, https, ssh), so a URL with a scheme of its own (leak://…) starts no helper either.
// The settings ride in GIT_CONFIG_COUNT/KEY/VALUE, so the git programs a call starts itself (gh's own git calls) get
// them too.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sshCommand } from "./key-guard.mjs";

/** The worktree's top folder, the nearest one from `start` up that holds .git, found without running git; or null. */
export function gitTop(start) {
  for (let at = resolve(start); ; at = dirname(at)) {
    try { statSync(join(at, ".git")); return at; } catch { /* Not here. */ }
    if (dirname(at) === at) return null;
  }
}

/**
 * The repository's common Git folder for a worktree, read from its files without running git: the .git folder, or for a
 * linked worktree the folder its .git file names and that folder's commondir. Null where none is found (a bare
 * repository, a .git file that names nothing), so the caller asks git as before.
 */
export function gitCommonDir(worktree) {
  const top = gitTop(worktree);
  if (!top) return null;
  const dotGit = join(top, ".git");
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const named = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(readFileSync(dotGit, "utf8"))?.[1];
      if (!named) return null;
      gitDir = resolve(top, named);
    }
  } catch { return null; }
  try { return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()); } catch { return gitDir; }
}

// The ending of a setting's last name part that names a program git starts (core.alternateRefsCommand, gpg.program,
// interactive.diffFilter, remote.<name>.receivepack, uploadpack.packObjectsHook, core.gitProxy...): matched by its
// ending, so a longer name with the same ending is caught too.
const programName = /(command|cmd|program|helper|driver|textconv|editor|pager|askpass|proxy|pack|hook|filter|clean|smudge|process|external)$/;
// Sections whose every entry names something git runs or writes to: aliases (a ! alias is a shell command), per-command
// pagers, and trace targets (a file or socket that would get what a call does).
const programSection = /^(alias|pager|trace2)$/;
// Sections a fetch or push with the user's credentials must not take from the repository's own config.
const networkSection = /^(http|credential)$/;
// Settings from the global and system config that a call without the network keeps: who commits, and how files look.
const carried = new Set(["user.name", "user.email", "core.excludesfile", "core.autocrlf", "core.eol", "core.safecrlf", "core.precomposeunicode", "core.longpaths", "core.symlinks"]);
// The transports git has itself; the file transport keeps git's own default (only a person's own command, not a
// submodule's).
const ownTransports = ["file", "git", "http", "https", "ssh"];
// Switched off for every call, whatever any config says.
const fixed = [["core.hooksPath", "/dev/null"], ["core.fsmonitor", "false"], ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["push.gpgSign", "false"],
  ["log.showSignature", "false"], ["merge.verifySignatures", "false"], ["gc.auto", "0"], ["maintenance.auto", "false"],
  ["fetch.recurseSubmodules", "false"], ["submodule.recurse", "false"], ["push.recurseSubmodules", "no"], ["protocol.ext.allow", "never"],
  ["protocol.allow", "never"], ["protocol.file.allow", "user"], ...ownTransports.filter(name => name !== "file").map(name => [`protocol.${name}.allow`, "always"])];
const ownScope = scope => scope === "local" || scope === "worktree";
const realOr = path => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * Whether a remote URL (as git remote get-url prints it, rewrites applied) is a folder on this machine: a path or file://,
 * not scheme://host/… nor the scp form host:path.
 */
export function folderRemote(url) {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  // host:path, with the colon before any slash; a Windows drive letter (C:\…) is a folder.
  const colon = url.indexOf(":"), slash = url.search(/[\\/]/);
  return colon < 0 || (slash >= 0 && slash < colon) || /^[a-z]:[\\/]/i.test(url);
}

/** Whether a git command line reaches the network with the user's credentials: its subcommand, past git's own options. */
export function gitNetworkCall(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-C" || args[i] === "-c") { i++; continue; }
    if (args[i].startsWith("-")) continue;
    return ["fetch", "push", "pull", "ls-remote", "clone"].includes(args[i]);
  }
  return false;
}

/**
 * The variables for one git call (or a program that runs git, such as gh) on `worktree`: {env, problem}. `env` holds the
 * settings above as GIT_CONFIG_COUNT/KEY/VALUE (after any the environment already has), and for a call without the
 * network GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1. `problem` (network calls only) names repository
 * settings that would steer the credentials or pick a remote helper, in plain words with the step that fixes it. `git`
 * is the program that reads the config (a full path; reading starts nothing).
 */
export function gitSafety({ worktree, env = process.env, network = false, git = "git", common = gitCommonDir(worktree) }) {
  // `git` may also be [program, ...arguments before git's own] (a git script started by its interpreter's full path).
  const [program, ...before] = [git].flat();
  // The caller's own settings from the environment stay in the read (command scope: the lead's core.sshCommand).
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10) || 0;
  const list = execFileSync(program, [...before, "-C", worktree, "config", "--list", "--show-scope", "-z"], {
    env: { ...env, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath", [`GIT_CONFIG_VALUE_${count}`]: "/dev/null" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 }).split("\0");
  const settings = [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    const [key, ...value] = list[i + 1].split("\n");
    settings.push({ scope: list[i], key, value: value.join("\n") });
  }
  const pairs = [];
  const emptied = new Set(), steering = new Set();
  const helper = /^[A-Za-z0-9][A-Za-z0-9+.-]*::/;
  // Only the repository's own settings are the build's: without the network the global and system config are not read
  // at all, and those from the environment (command scope) are the lead's.
  for (const { scope, key, value } of settings) {
    if (!ownScope(scope)) continue;
    const section = key.split(".")[0].toLowerCase(), name = key.split(".").at(-1).toLowerCase();
    const subsection = key.slice(key.indexOf(".") + 1, key.lastIndexOf("."));
    if (network && (networkSection.test(section) || (section === "remote" && (name === "vcs" || ((name === "url" || name === "pushurl") && helper.test(value))))
      || (section === "url" && helper.test(subsection)))) steering.add(key);
    if ((programName.test(name) || programSection.test(section)) && !emptied.has(key)) { emptied.add(key); pairs.push([key, ""]); }
    // A transport the repository's config allows by name (protocol.<name>.allow) wins over protocol.allow=never: any
    // but git's own is set to never again, after it.
    const transport = /^protocol\.(.+)\.allow$/i.exec(key)?.[1];
    if (transport && !ownTransports.includes(transport.toLowerCase()) && !emptied.has(key)) { emptied.add(key); pairs.push([key, "never"]); }
    const required = `${key.slice(0, key.lastIndexOf("."))}.required`;
    if (section === "filter" && !emptied.has(required)) { emptied.add(required); pairs.push([required, "false"]); }
  }
  const extra = {};
  if (!network) {
    Object.assign(extra, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
    // These ride in the command scope, which wins over the repository's own, so a setting the repository makes itself
    // (its own user.email) is not carried over it; of several global or system values the last wins, as git reads them.
    const own = new Set(settings.filter(entry => ownScope(entry.scope)).map(entry => entry.key.toLowerCase()));
    const kept = new Map();
    for (const { scope, key, value } of settings) if ((scope === "global" || scope === "system") && carried.has(key.toLowerCase()) && !own.has(key.toLowerCase())) kept.set(key.toLowerCase(), value);
    pairs.push(...kept);
  }
  for (const folder of [worktree, common].filter(Boolean)) pairs.push(["safe.directory", realOr(folder)]);
  // Last, so a repository's own core.hooksPath or core.fsmonitor (named in any letter case) never comes after them.
  pairs.push(...fixed);
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10) || 0;
  pairs.forEach(([key, value], index) => { extra[`GIT_CONFIG_KEY_${start + index}`] = key; extra[`GIT_CONFIG_VALUE_${start + index}`] = value; });
  extra.GIT_CONFIG_COUNT = String(start + pairs.length);
  // git's ssh, by its full path (sshCommand): never a bare name a link on PATH leads into the worktree for. Where it
  // cannot be found that way, the command git gets says why and fails, so only a call to an ssh remote stops.
  if (network) {
    const lead = name => settings.filter(entry => !ownScope(entry.scope) && entry.key.toLowerCase() === name).at(-1)?.value;
    const ssh = sshCommand(env, { worktree, common, configured: lead("core.sshcommand") });
    if (ssh.command) extra.GIT_SSH_COMMAND = ssh.command;
    // The lead's own choice of ssh kind (the variable, or ssh.variant in their config) stays.
    if (ssh.variant && !env.GIT_SSH_VARIANT && lead("ssh.variant") === undefined) extra.GIT_SSH_VARIANT = ssh.variant;
  }
  const problem = steering.size ? `the repository's own Git config holds ${[...steering].join(", ")}, which could send the credentials of a fetch or push elsewhere or start a remote helper (a build may have written ${steering.size === 1 ? "it" : "them"}); remove ${steering.size === 1 ? "it" : "them"} with git config --unset-all <name> and run it again` : null;
  return { env: extra, problem };
}
