import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const nodeError = "kit: no Node >=24 found (system, npx cache or nvm)";
const oneLine = (text) => String(text).replace(/[\n\r]/g, " ");

function git(args) {
  try { return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n+$/, ""); }
  catch { return ""; }
}

/** Return the current worktree root, with KIT_ROOT taking precedence. */
export function kitRoot() {
  return process.env.KIT_ROOT || (git(["rev-parse", "--show-toplevel"]) || resolve(import.meta.dirname, "../.."));
}

/** Return the persistent main checkout root. */
export function kitMainRoot() {
  return process.env.KIT_MAIN_ROOT || "/home/ubulex/Projects/native-site-editor";
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

/** Print a single RESULT line; invalid statuses set exitCode to 2. */
export function kitResult(status = "", text = "") {
  if (status !== "ok" && status !== "fail") {
    console.log(`RESULT: fail kit_result: bad status ${oneLine(status)}`);
    process.exitCode = 2;
    return;
  }
  console.log(`RESULT: ${status} ${oneLine(text)}`);
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

/** Read Linux process identity, treating zombies and concurrently removed /proc files as dead. */
export function kitJobProcess(pid) {
  try {
    const identity = processIdentity(readFileSync(`/proc/${pid}/stat`, "utf8"));
    return ["Z", "X"].includes(identity.state) ? null : identity;
  } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return null; throw error; }
}

/** Pin a job to its original session leader, so stale records never target reused PIDs. */
export function kitJob(directory) {
  const pid = Number(kitJobRecord(directory, "pid"));
  const pgid = Number(kitJobRecord(directory, "pgid"));
  const identity = processIdentity(kitJobRecord(directory, "identity"));
  if (!Number.isSafeInteger(pid) || pid <= 1 || pgid !== pid || !identity ||
      identity.pgid !== pgid || identity.session !== pgid || !/^\d+$/.test(identity.started))
    throw new Error(`missing or invalid job records: ${directory}`);
  return { directory, pid, pgid, started: identity.started };
}

export function kitJobRunning(job) {
  return kitJobMembers(job).length > 0;
}

/** Read a session's live group members without ps or command-line matching. */
export function kitJobGroup(pgid) {
  return readdirSync("/proc").filter(pid => /^\d+$/.test(pid)).map(pid => ({ pid: Number(pid), ...kitJobProcess(pid) }))
    .filter(member => member.pgid === pgid && member.session === pgid);
}

/** Require an original, start-time-pinned member before trusting the group's current membership. */
export function kitJobMembers(job) {
  const leader = kitJobProcess(job.pid);
  if (leader && leader.started !== job.started) return [];
  let pins = [{ pid: job.pid, started: job.started }];
  const record = kitJobRecord(job.directory, "members");
  if (record !== null) {
    const saved = JSON.parse(record);
    if (saved.started === job.started) pins = pins.concat(saved.members);
  }
  const verified = pins.some(({ pid, started }) => {
    const current = kitJobProcess(pid);
    return current?.pgid === job.pgid && current.session === job.pgid && current.started === started;
  });
  return verified ? kitJobGroup(job.pgid) : [];
}

export function kitJobExit(job) {
  const value = kitJobRecord(job.directory, "exit");
  if (value === null) return null;
  if (!/^\d+$/.test(value) || Number(value) > 255) throw new Error(`invalid job exit status: ${value}`);
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
