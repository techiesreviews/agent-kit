import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { findingsRecord } from "./review-findings.mjs";

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

/** The project settings file, relative to the project's top folder. */
export const kitSettingsFile = "scripts/agents/kit.json";
const settingsCache = new Map();

/** Problems with parsed settings: only `project` and `branches.land` are required. */
export function kitSettingsProblems(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return [`${kitSettingsFile} must hold one JSON object`];
  const text = value => typeof value === "string" && value.trim() !== "";
  return [
    ...(text(settings.project) ? [] : [`add "project": "<name>" to ${kitSettingsFile}`]),
    ...(text(settings.branches?.land) ? [] : [`add "branches": { "land": "<branch>" } to ${kitSettingsFile}`]),
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
