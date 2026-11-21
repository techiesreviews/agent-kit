// The weekly review budget (TOOLS-290: its own module, out of agent-run.mjs): one machine ledger counts the reviews each
// outside family (GPT, Grok) ran this ISO week, per project, under a lock folder, and refuses a review at the limit.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { reviewFamily } from "./model-names.mjs";

export const reviewBudgetDefaults = { gpt: 12, grok: 8 };

export function isoWeek(date = new Date()) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function reviewBudgetLimit(family, env = process.env) {
  const name = `ASE_REVIEW_BUDGET_${family.toUpperCase()}`, value = env[name];
  if (value === undefined || value === "") return reviewBudgetDefaults[family];
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number of reviews per week`);
  return Number(value);
}

// One writer at a time: a lock folder beside the file, waited for up to ASE_REVIEW_BUDGET_LOCK_MS
// (or waitMs). A lock still held at the deadline throws an error with code ELOCKED. A lock that
// cannot be removed afterwards is a warning: the action's own result or error stands, since a
// write it made is already saved, and the next writer names the leftover lock.
export function withReviewLock(path, action, env = process.env, waitMs = undefined) {
  mkdirSync(dirname(path), { recursive: true });
  const wait = waitMs ?? Number(env.ASE_REVIEW_BUDGET_LOCK_MS || 10_000);
  if (!Number.isSafeInteger(wait) || wait <= 0) throw new Error("ASE_REVIEW_BUDGET_LOCK_MS must be a positive integer");
  const lock = `${path}.lock`, deadline = Date.now() + wait;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw Object.assign(new Error(`review budget lock ${lock} is held; remove it if no review is starting`), { code: "ELOCKED" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return action(); } finally {
    try { rmSync(lock, { recursive: true, force: true }); }
    catch (error) { console.error(`warning: review budget lock ${lock} could not be removed: ${error.message}; remove it if no review is starting`); }
  }
}

export function readReviewLedger(path) {
  if (!existsSync(path)) return {};
  let ledger;
  try { ledger = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`review budget ledger ${path} is not valid JSON: ${error.message}; fix or delete it`); }
  if (typeof ledger !== "object" || ledger === null || Array.isArray(ledger)) {
    throw new Error(`review budget ledger ${path} is not a JSON object; fix or delete it`);
  }
  return ledger;
}

// Writes a ledger file whole: a temporary file renamed over it, so a crash never leaves it cut off.
// Returns only once the rename has saved it.
function writeLedgerFile(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let written = false;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
    written = true;
  } finally {
    // A leftover temporary file is harmless; the write's own error is the one to report.
    if (!written) try { rmSync(temporary, { force: true }); } catch { /* keep the write's error */ }
  }
}

// Reads, changes and saves the ledger under its lock. When anything fails before the save, unsaved(error)
// runs while the lock is still held; once the rename has saved the ledger it never runs.
function withLedger(path, change, env = process.env, unsaved = () => {}) {
  return withReviewLock(path, () => {
    let written = false;
    try {
      const ledger = readReviewLedger(path);
      checkReviewLedger(ledger, path);
      const result = change(ledger);
      writeLedgerFile(path, ledger);
      written = true;
      return result;
    } catch (error) {
      if (!written) unsaved(error);
      throw error;
    }
  }, env);
}

// The machine ledger keeps { week: { family: { project: count } } }; a family's use is the sum over projects.
export function familyUse(ledger, week, family) {
  return Object.values(ledger[week]?.[family] ?? {}).reduce((sum, count) => sum + count, 0);
}

const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;

// Every week, family and count in the machine ledger at path has the right shape, or the first wrong one is
// named and the review stops; nothing is changed, so a broken count is never read as 0 or written back joined.
export function checkReviewLedger(ledger, path) {
  for (const [week, families] of Object.entries(ledger)) {
    if (!isRecord(families)) throw new Error(`review budget ledger ${path} ${week} is not { "<family>": { "<project>": <count> } }; fix or delete it`);
    for (const [family, counts] of Object.entries(families)) {
      if (!isRecord(counts)) throw new Error(`review budget ledger ${path} ${week} ${family} is not { "<project>": <count> }; fix or delete it`);
      for (const [project, count] of Object.entries(counts)) {
        if (!isCount(count)) throw new Error(`review budget ledger ${path} ${week} ${family} ${project} is not a count; fix or delete it`);
      }
    }
  }
}

// The same for a project's old per-project ledger ({ week: { family: count } }).
export function checkOldReviewLedger(old, path) {
  for (const [week, families] of Object.entries(old)) {
    if (!isRecord(families)) throw new Error(`review budget ledger ${path} ${week} is not { "<family>": <count> }; fix or delete it`);
    for (const [family, count] of Object.entries(families)) {
      if (!isCount(count)) throw new Error(`review budget ledger ${path} ${week} ${family} is not a count; fix or delete it`);
    }
  }
}

// One week's counts for a family in a checked machine ledger, made empty when missing.
export function projectCounts(ledger, week, family) {
  return ((ledger[week] ??= {})[family] ??= {});
}

// Moves a project's old per-project ledger ({ week: { family: count } }) into the machine ledger once,
// returning what moved ({ week: { family: count } }) or null. The machine lock is held, so the old file's lock is
// only tried briefly: when it is held (an older kit writing, or a stale lock) this review skips the
// move and the next one tries again. The old file is removed before the machine ledger is written,
// so a crash between the two loses those counts rather than counting them twice; a write that fails
// puts them back (restoreLegacyLedger) before the machine lock is released.
function moveLegacyLedger(ledger, legacy, project, env) {
  if (!legacy || !existsSync(legacy)) return null;
  try {
    return withReviewLock(legacy, () => {
      const old = readReviewLedger(legacy);
      // Every count is checked before anything merges, so a broken file is named and kept.
      checkOldReviewLedger(old, legacy);
      for (const [week, families] of Object.entries(old)) {
        for (const [family, count] of Object.entries(families)) {
          if (!count) continue;
          const counts = projectCounts(ledger, week, family);
          counts[project] = (counts[project] ?? 0) + count;
        }
      }
      rmSync(legacy, { force: true });
      return old;
    }, env, 200);
  } catch (error) {
    if (error.code === "ELOCKED") return null;
    throw error;
  }
}

// Puts moved counts back in the old file when the machine ledger could not be written, added to what an
// older kit wrote there since (if anything); called with the machine lock held, so no review moves it meanwhile.
// An old file an older kit left broken meanwhile is named and kept as it is, never read as 0.
function restoreLegacyLedger(legacy, old, env) {
  withReviewLock(legacy, () => {
    const current = readReviewLedger(legacy);
    checkOldReviewLedger(current, legacy);
    for (const [week, families] of Object.entries(old)) {
      for (const [family, count] of Object.entries(families)) {
        const counts = (current[week] ??= {});
        counts[family] = (counts[family] ?? 0) + count;
      }
    }
    writeLedgerFile(legacy, current);
  }, env);
}

// Counts one review for an outside family in this ISO week, refusing at the limit. The ledger
// ({ path, project, legacy }) is the machine's; legacy names the project's old ledger to move in.
// The run is { cli, model }; returns null for Claude and OpenCode's free models, which are never counted.
export function reserveReviewBudget({ path, project, legacy }, { cli, model = "" }, env = process.env, date = new Date()) {
  const family = reviewFamily(cli, model);
  if (!family) return null;
  if (typeof project !== "string" || !project) throw new Error("review budget needs the project name");
  const limit = reviewBudgetLimit(family, env), week = isoWeek(date);
  // Last week stays for the Tuesday sweep; older weeks go so the ledger stays small.
  const lastWeek = isoWeek(new Date(date.getTime() - 7 * 86_400_000));
  let moved = null;
  const result = withLedger(path, ledger => {
    // withLedger has checked every count, so a broken one stops before the old file moves in.
    moved = moveLegacyLedger(ledger, legacy, project, env);
    // Weeks in date order: a moved-in old week may have landed after this one.
    for (const old of Object.keys(ledger).sort()) {
      const counts = ledger[old];
      delete ledger[old];
      if (old >= lastWeek) ledger[old] = counts;
    }
    const used = familyUse(ledger, week, family);
    // A refusal still saves the ledger, so counts just moved in are kept.
    if (used >= limit) return { refused: `${family} review budget used up: ${used}/${limit} in ${week}; raise ASE_REVIEW_BUDGET_${family.toUpperCase()} to override` };
    const counts = projectCounts(ledger, week, family);
    counts[project] = (counts[project] ?? 0) + 1;
    return { family, week, used: used + 1, limit, project };
  }, env, error => {
    // The ledger was not saved: the moved counts go back before another review can take the lock.
    if (!moved) return;
    try { restoreLegacyLedger(legacy, moved, env); }
    catch (restore) { error.message += `; the moved counts could not be put back in ${legacy}: ${restore.message}`; }
  });
  if (result.refused) throw new Error(result.refused);
  return result;
}

// Returns a reservation whose review never reached the model.
export function releaseReviewBudget(path, { family, week, project }, env = process.env) {
  withLedger(path, ledger => {
    const counts = ledger[week]?.[family];
    if (counts?.[project] > 0) counts[project] -= 1;
  }, env);
}
