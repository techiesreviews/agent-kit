// The release check (kit release-check, and kit pr --release in its own process): nothing unsaved, and HEAD exactly
// origin/<release> (or origin/<land> with `land`) after a fetch. It returns its outcome; kit.d/release-check prints it.
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { kitBranch, kitHideUserInfo, kitOwner, kitSettings, kitSettingsFile } = await import(
  pathToFileURL(process.env.KIT_LIB_MJS || resolve(import.meta.dirname, "kit-lib.mjs")).href
);

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The check's outcome for the checkout at `root`: { passed, summary, failure, problems, warnings }.
 * - passed: whether it passed (a lead's `waive` passes it whatever it found, and says what it let through).
 * - summary: the passed check's words after "release-check " ("<sha> is origin/<branch>, nothing unsaved", or "waived by …").
 * - failure: the failed check's words, every problem with its advice.
 * - problems: [{ what, advice }]; warnings: lines shown beside the outcome, never a failure.
 * `env` is the variables its git calls get (a fetch reads the network settings); `git` is the program, or
 * [program, arguments before git's own]. A git call that cannot run throws.
 */
export function releaseCheck({ root, land = false, waive, env = process.env, git = "git" }) {
  const { found, passed, warnings = [] } = problems(root, { land, env, git: [git].flat() });
  if (!found.length) return { passed: true, summary: waive ? `${passed} (waiver not needed: ${waive})` : passed, problems: [], warnings };
  if (waive) return { passed: true, summary: `waived by ${kitOwner()} (${waive}): ${found.map(item => item.what).join("; ")}`, problems: found, warnings };
  return { passed: false, failure: found.map(item => `${item.what}: ${item.advice}`).join("; "), problems: found, warnings };
}

/** What stops this checkout going live: a list of { what, advice }, and the words an ok result prints. */
function problems(root, { land, env: given, git: [program, ...before] }) {
  // git's own messages in English, so a missing branch is told apart from a failed fetch in any locale; no HTTPS
  // credential prompt (an SSH origin keeps the project's own ssh setup, prompts included).
  const env = { ...given, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  const run = { program, before };
  const git = (...args) => spawnSync(program, [...before, "-C", root, ...args], { encoding: "utf8", env });
  const found = [];
  const settings = kitSettings(root), release = kitBranch("release", settings);
  // Changed and untracked files, one path each; .scratch/ holds the kit's own logs and evidence.
  const status = git("-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames");
  if (status.status !== 0) throw new Error(`git status failed: ${status.error?.message ?? status.stderr.trim()}`);
  const files = status.stdout.split("\0").filter(Boolean).map(entry => entry.slice(3))
    .filter(path => !path.startsWith(".scratch/")).sort();
  if (files.length) {
    const named = files.length > 5 ? `${files.slice(0, 5).join(", ")} and ${files.length - 5} more` : files.join(", ");
    found.push({ what: `unsaved files (${named})`, advice: "commit them through kit pr or remove them before going live" });
  }
  if (!release) {
    found.push({ what: `no branches.release in ${kitSettingsFile}`, advice: "name the branch that goes live there" });
    return { found };
  }
  // Where land and release are one branch (a live site), kit pr alone puts a commit live; else kit pr --release does.
  const landing = kitBranch("land", settings), one = landing === release, branch = land ? landing : release;
  // Only git's "No such remote" (exit 2) means there is no origin; other failures surface at the fetch.
  if (git("remote", "get-url", "origin").status === 2) {
    found.push({ what: "no origin remote", advice: `the check compares HEAD with origin/${branch}` });
    return { found };
  }
  const fetch = fetchBranch(root, branch, env, run);
  if (fetch.status !== 0 && /couldn't find remote ref/i.test(fetch.stderr)) {
    found.push({ what: `origin has no branch ${branch}`, advice: land || one
      ? `land work on ${branch} through kit pr first` : "push nothing by hand; land the release with kit pr --release" });
    return { found };
  }
  if (fetch.status !== 0) {
    const reason = kitHideUserInfo(fetch.error?.code === "ETIMEDOUT" ? `no answer within ${fetch.seconds} seconds`
      : fetch.error ? fetch.error.message : fetch.stderr.trim().split(/\r?\n/).at(-1) || `git fetch exited ${fetch.status}`);
    found.push({ what: `could not fetch origin (${reason})`, advice: "try again once origin answers" });
    return { found };
  }
  const head = git("rev-parse", "--verify", "-q", "HEAD^{commit}").stdout.trim();
  if (!head) {
    found.push({ what: "no commit checked out", advice: `check out origin/${branch} before going live` });
    return { found };
  }
  const short = git("rev-parse", "--short", head).stdout.trim();
  const counts = git("rev-list", "--left-right", "--count", `HEAD...refs/remotes/origin/${branch}`);
  if (counts.status !== 0) throw new Error(`git rev-list failed: ${counts.stderr.trim()}`);
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  // Under --land, a cut whose own commits all landed already (an earlier kit pr --release merged
  // origin/<release> into it) is cut again; git cherry marks each commit past origin/<release> that origin/<land> has with "-".
  // A commit that never landed is landed first, so the advice never drops work.
  // A clone without origin/<release> (single-branch, CI) leaves the limit out: release-only commits then show "+",
  // and a failed git cherry counts as not landed, so both give the safe advice.
  const limit = release !== branch && git("rev-parse", "--verify", "-q", `refs/remotes/origin/${release}`).status === 0
    ? [`refs/remotes/origin/${release}`] : [];
  const cherry = land && ahead ? git("cherry", `refs/remotes/origin/${branch}`, "HEAD", ...limit) : undefined;
  const landed = !cherry || (cherry.status === 0 && cherry.stdout.split(/\r?\n/).filter(Boolean).every(line => line.startsWith("-")));
  const update = land
    ? landed ? `cut the release again from origin/${branch} (git reset --keep origin/${branch}) and rerun kit pr --release`
      : `a release carries only what landed on ${branch}; land it with kit pr first`
    : `update the checkout to origin/${branch} before going live`;
  const unlanded = land ? update : one ? `what goes live must be on ${branch}; land it with kit pr`
    : `what goes live must be on ${branch}; land it on ${landing} with kit pr, then kit pr --release`;
  // A split HEAD holds commits of its own: without --land it gets the ahead advice, which never drops them.
  if (ahead && behind) found.push({ what: `HEAD ${short} and origin/${branch} have split (${plural(ahead, "commit")} ahead, ${behind} behind)`, advice: land ? update : unlanded });
  else if (ahead) found.push({ what: `HEAD ${short} is ${plural(ahead, "commit")} ahead of origin/${branch}`, advice: unlanded });
  else if (behind) found.push({ what: `HEAD ${short} is ${plural(behind, "commit")} behind origin/${branch}`, advice: update });
  return { found, passed: `${short} is origin/${branch}, nothing unsaved`, warnings: one ? [] : outside(root, { landing, release, branch, env, git, run }) };
}

/**
 * The warning for commits origin/<release> holds outside origin/<land>'s history (TOOLS-325): a release that landed as copied
 * commits (a rebase or squash merge) splits the two, and the next release conflicts. Merges are left out: a release lands on
 * <release> as a merge commit, which is no split. The branch the check did not fetch is fetched too; a fetch or a git call that
 * fails leaves the warning out rather than failing the check.
 */
function outside(root, { landing, release, branch, env, git, run }) {
  const other = branch === landing ? release : landing;
  if (fetchBranch(root, other, env, run).status !== 0) return [];
  const listed = git("log", "--reverse", "--no-merges", "--format=%h %s", `refs/remotes/origin/${release}`, `^refs/remotes/origin/${landing}`);
  if (listed.status !== 0) return [];
  const commits = listed.stdout.split(/\r?\n/).filter(Boolean);
  if (!commits.length) return [];
  const named = commits.length > 5 ? `${commits.slice(0, 5).join(", ")} and ${commits.length - 5} more` : commits.join(", ");
  return [`warning: origin/${release} has ${plural(commits.length, "commit")} outside ${landing}'s history (${named}): copied by a rebase or squash merge, ` +
    `or made straight on ${release}; join them with kit pr --sync-main (where it cannot join them by itself, it names the merge to make by hand, then lands that merge)`];
}

/**
 * Fetch one branch by name (a single-branch or CI clone that does not track it still gets it), stopped after
 * KIT_RELEASE_CHECK_TIMEOUT seconds (default 120). Its stderr goes to a file, not a pipe, so an ssh or helper git
 * started cannot hold the check open after git is stopped.
 */
function fetchBranch(root, branch, env, { program, before }) {
  const seconds = Number(env.KIT_RELEASE_CHECK_TIMEOUT) > 0 ? Number(env.KIT_RELEASE_CHECK_TIMEOUT) : 120;
  const directory = mkdtempSync(join(tmpdir(), "kit-release-check-")), log = join(directory, "fetch.err");
  const fd = openSync(log, "w");
  try {
    const run = spawnSync(program, [...before, "-C", root, "fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { stdio: ["ignore", "ignore", fd], timeout: seconds * 1000, env });
    return { status: run.status, error: run.error, seconds, stderr: readFileSync(log, "utf8") };
  } finally {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
  }
}
