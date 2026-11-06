// The review loop (Lex, 2026-11-06; after Theo's sol-loop): the budget as a function of risk, the early stop on nits,
// finding ids and the ledger, and the PR line. The rule text is the "Review loop" section of docs/kitchen.md.
// The pure parts live here so kit review, kit fix, kit slice and kit pr never read the rules differently.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { blockingFindings, parseMarks } from "./review-findings.mjs";
export { parseMarks };

/** Rounds of fixing a normal change gets, and the most a risky change gets while a blocker or should stays open. */
export const NORMAL_ROUNDS = 3;
export const RISKY_ROUNDS = 5;

// Security, permissions, auth, data loss, state and concurrency: by path, or by the words of a ticket or title.
const named = names => new RegExp(`(?:^|/)(?:${names})(?:\\.[^/]+)?(?:/|$)`, "i");
const riskyPaths = [named("auth|authn|authz|security|permissions?|acl|rbac|crypto|secrets?|credentials?|sessions?|oauth|login|passwords?"),
  /(?:^|\/)\.env(?:\.|$)/i, /(?:^|\/)migrations?\//i, named("locks?|queues?|transactions?|concurrency"), /(?:^|\/)(?:state|states|stores?)\//i];
const riskyWords = /\b(?:security|permissions?|authenticat\w*|authoriz\w*|auth|credentials?|secrets?|data loss|lose data|delete data|deletion|destructive|concurren\w+|race conditions?|deadlocks?|transactions?|shared state|global state|stale state|persisted state|state machine|state sync\w*)\b/i;

/**
 * Whether a change is risky enough for the longer budget: any changed path, or the text (a ticket's title and goal), names
 * security, permissions, auth, data loss, state or concurrency. `paths.risky` in the settings adds project patterns.
 * Returns { risky, reasons } with plain reasons.
 */
export function riskyChange({ paths = [], text = "", settings = {} } = {}) {
  // `paths.risky` is a list of regular expressions; a bad one is named, as the other path settings do.
  const listed = settings.paths?.risky ?? [];
  if (!Array.isArray(listed)) throw new Error("paths.risky in scripts/agents/kit.json must be a list of regular expressions");
  const extra = listed.map(source => {
    try { return new RegExp(source); }
    catch (error) { throw new Error(`paths.risky in scripts/agents/kit.json: ${error.message}`); }
  });
  const reasons = [];
  for (const path of paths) {
    if ([...riskyPaths, ...extra].some(pattern => pattern.test(path))) reasons.push(`path ${path}`);
  }
  const word = riskyWords.exec(text)?.[0];
  if (word) reasons.push(`text mentions "${word}"`);
  return { risky: reasons.length > 0, reasons: reasons.slice(0, 5) };
}

/**
 * One risk function for every command (kit review, kit pr, kit slice): the paths changed against `base` (a ref), the files a
 * ticket names in backticks, and the ticket's words. `ticket` is the ticket file's path or null.
 */
export function branchRisk({ root, base, ticket, settings }) {
  let paths = [];
  try { paths = execFileSync("git", ["-C", root, "diff", "--name-only", `${base}...HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); } catch { /* No base to compare: the ticket decides. */ }
  // The ticket's title and goal and the files it names: what it is about, not the follow-up notes kit pr writes into it later.
  let text = "", raw = "";
  try { raw = ticket ? readFileSync(resolve(root, ticket), "utf8") : ""; } catch { /* No ticket text. */ }
  const title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(raw)?.[1] ?? "";
  const goal = /^##\s+Goal\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(raw)?.[1] ?? "";
  const files = /^##\s+Files\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(raw)?.[1] ?? "";
  text = `${title}\n${goal.slice(0, 1500)}`;
  const named = [...files.matchAll(/`([^`\s]*[./][^`\s]*)`/g)].map(match => match[1]);
  return riskyChange({ paths: [...paths, ...named], text, settings });
}

/** The fix-round limit for a change: 3, or 5 for a risky one (rounds past 3 still need an open blocker or should). */
export const roundLimit = risky => (risky ? RISKY_ROUNDS : NORMAL_ROUNDS);

/** blocker (P0, P1), should (P2) or nit (P3, a validation gap); an unread severity counts as a blocker, never as a nit. */
export function severityWord(item) {
  if (item.group === "Validation gaps") return "nit";
  if (item.severity === "P0" || item.severity === "P1" || !item.severity) return "blocker";
  return item.severity === "P2" ? "should" : "nit";
}
/** A finding a "still open" mark carried into a round (its text starts `R1-2 still open`). */
export const isCarried = item => /^R\d+-\d+ still open/.test(String(item.text ?? ""));
export const isNit = item => severityWord(item) === "nit";
const hasEvidence = item => String(item.text ?? "").trim() !== "" && !/still open: no reason given$/.test(String(item.text));

/**
 * The open findings that still call for a fix round, or that stop a landing, after `rounds` fix rounds:
 * nothing but nits never does (nits); within the limit every blocker and should does; once the limit is used
 * only blockers do, and the rest go to the lead (running out of budget is never approval).
 * The 4th and 5th round of a risky change run only while a blocker or should is open with its evidence written.
 */
export function stoppingFindings(open, rounds, risky) {
  const real = open.filter(item => !isNit(item));
  if (!real.length) return [];
  if (rounds >= roundLimit(risky)) return blockingFindings(open);
  // Rounds past the third need a finding that is open with its evidence: a mark that gave no reason is none.
  // A blocker always counts; a should with no reason given is no evidence.
  if (rounds >= NORMAL_ROUNDS && !real.some(item => severityWord(item) === "blocker" || hasEvidence(item))) return [];
  return real;
}

/** What ended the loop: "clean", "nits" (only nits left), "budget" (limit used, findings left) or null (a round is due). */
export function loopStop(open, rounds, risky) {
  if (!open.length) return "clean";
  if (open.every(isNit)) return "nits";
  return rounds >= roundLimit(risky) ? "budget" : stoppingFindings(open, rounds, risky).length ? null : "nits";
}

/** Ids for one review's findings: R<round>-<n>, in the order the reviewer wrote them. */
export const withIds = (findings, round) => findings.map((item, index) => ({ ...item, id: `R${round}-${index + 1}` }));

/** Ids from the earlier round that the later review did not mark: the review must say each one is resolved or still open. */
export const unmarkedIds = (ids, marks) => ids.filter(id => !marks.has(id));

/**
 * The brief section for round 2 and later (later rounds): review only what changed since the last reviewed head and the open ids,
 * and mark each old id. `open` is [{ id, severity, kind, text }].
 */
export function loopBriefSection({ round, limit, previousHead, currentHead, open }) {
  const label = item => item.group === "Validation gaps" ? "validation gap" : `${item.severity ?? "no severity"}${item.kind && item.kind !== "unsorted" ? ` ${item.kind}` : ""}`;
  const list = open.map(item => `- ${item.id} (${label(item)}): ${String(item.text).slice(0, 200)}`).join("\n");
  const scope = previousHead === currentHead
    ? "No commit came after the last review (the builder answered or declined: its declined findings and their reasons are in this brief): check each finding below against that answer; there is no new code to read."
    : `Review only the code changed since ${previousHead} (the \`Changes since the last review\` file named in the scope note) and the findings still open below. Do not review unchanged code again.`;
  return [
    `## Review loop: review round ${round}, after ${round - 1} fix round${round === 2 ? "" : "s"} (at most ${limit} fix rounds)`,
    scope,
    "Open findings from the last round:", list,
    "Before your Defects heading, write the block `Previous findings:` with one line for every id above, none left out: `<id>: resolved` or `<id>: still open (<its severity, or gap for a validation gap>): <reason>`. A review that leaves an id out is incomplete and is run again.",
    "You are the only reviewer: start no subagents. New findings use the usual format; a nit is a rare path, a small cost, a comment, doc or format-only point, or a missing test.",
  ].join("\n\n");
}

/** The PR line : `Reviewed with review-loop: N rounds with <model>. Verdict: approved`. */
export function prLine({ rounds, model, verdict = "approved" }) {
  return `Reviewed with review-loop: ${rounds} round${rounds === 1 ? "" : "s"} with ${model}. Verdict: ${verdict}`;
}

/**
 * The ledger rows from the chain of review records, oldest first: [{ round, findings: [{ id, severity }], marks: Map }], where `marks` are
 * the marks that round's review gave the earlier ids. Outcomes are only what a review wrote: resolved, still open (reason),
 * or "not marked" for an id the next review left out; the last round's findings are "open at the end". Never guessed.
 */
export function ledgerRows(chain) {
  const rows = [];
  // The outcome of one id: the next review's mark; "still open" follows the finding the mark carried into that round, so a problem
  // fixed in round 3 never stays "still open" in the ledger.
  const outcome = (id, index) => {
    const next = chain[index + 1];
    if (!next) return "open at the end";
    const mark = next.marks?.get(id);
    if (!mark) return "not marked by the next review";
    if (mark.status === "resolved") return "resolved";
    const carried = (next.findings ?? []).find(item => isCarried(item) && String(item.text).startsWith(`${id} still open`));
    const reason = mark.reason || "no reason given";
    if (!carried) return `still open: ${reason}`;
    const later = outcome(carried.id, index + 1);
    return later === "open at the end" ? `still open: ${reason}` : later;
  };
  chain.forEach((record, index) => {
    for (const finding of record.findings ?? []) {
      // A finding carried over by a "still open" mark is the same finding: one row, under its first id.
      if (isCarried(finding)) continue;
      rows.push({ id: finding.id, severity: severityWord(finding), outcome: outcome(finding.id, index) });
    }
  });
  return rows;
}

/** The ledger as a Markdown table for the PR; an empty ledger says there were no findings. */
export function renderLedger(rows) {
  if (!rows.length) return "Findings ledger: none.";
  const cell = text => String(text).replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  return ["Findings ledger:", "", "| id | severity | outcome |", "| --- | --- | --- |", ...rows.map(row => `| ${row.id} | ${row.severity} | ${cell(row.outcome)} |`)].join("\n");
}

/** The report for a loop that ran out of budget or is stuck: open findings for Lex, never an approval. */
export function budgetReport({ rounds, limit, open }) {
  const lines = open.slice(0, 5).map(item => `- ${item.id ? `${item.id} ` : ""}(${severityWord(item)}): ${String(item.text).replace(/\s+/g, " ").slice(0, 160)}`);
  return [`Review budget used: ${rounds} of ${limit} fix rounds, ${open.length} open finding${open.length === 1 ? "" : "s"}. Running out of budget is not approval; Lex decides.`, ...lines].join("\n");
}

/**
 * The chain of review records ending at a review's evidence folder, oldest first, from the findings.json each review saved
 * (`round`, `previous` = the earlier folder's name, `findings` with ids) and each result.md's marks.
 */
export function reviewChain(folder) {
  const chain = [];
  for (let current = resolve(folder), guard = 0; current && guard < 20; guard++) {
    const recordPath = join(current, "findings.json");
    if (!existsSync(recordPath)) break;
    let record;
    try { record = JSON.parse(readFileSync(recordPath, "utf8")); } catch { break; }
    let marks = new Map();
    try { marks = parseMarks(readFileSync(join(current, "result.md"), "utf8")); } catch { /* No report text: no marks. */ }
    const round = record.round ?? 1;
    // A review saved before ids existed gets the ids a new one would have been given.
    chain.unshift({ round, model: record.model, head: record.head, findings: (record.findings ?? []).map((item, index) => ({ ...item, id: item.id ?? `R${round}-${index + 1}` })), marks });
    current = record.previous ? join(dirname(current), record.previous) : null;
  }
  return chain;
}

/**
 * The earlier review this one answers (later rounds): in `parent` (the owner's folder under .scratch/reviews) the newest review of the
 * same base that still had findings and whose reviewed head is an ancestor of the current head. A second look's folder is never one.
 * Returns { name, round, head, findings } or null (then this is round 1, a full review).
 */
/** The rules every review round gets, round 1 included (the later-round section adds the open ids). */
export const loopReviewerNote = [
  "## Review loop rules for the reviewer",
  "You are the only reviewer: start no subagents. Rate each finding blocker (P0, P1), should (P2) or nit (P3, or a missing test): a nit is a rare path with a small cost, a comment, doc or format-only point, or a missing test. A review that returns only nits ends the loop.",
].join("\n\n");

export function findPreviousReview(parent, { head, base, root, branch }) {
  if (!existsSync(parent) || !head || !base) return null;
  const isAncestor = other => {
    try { execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", other, head], { stdio: "ignore" }); return true; }
    catch { return false; }
  };
  for (const name of readdirSync(parent).sort().reverse()) {
    const folder = join(parent, name);
    if (existsSync(join(folder, "second-look.json")) || !existsSync(join(folder, "findings.json")) || !existsSync(join(folder, "refs.txt"))) continue;
    try {
      const [reviewedHead, reviewedBase] = readFileSync(join(folder, "refs.txt"), "utf8").trim().split("\n");
      const record = JSON.parse(readFileSync(join(folder, "findings.json"), "utf8"));
      // The base may have moved on (another PR landed): the earlier base only has to be part of this branch's history.
      // The same branch's own history only: a branch cut from a reviewed head starts at round 1, and so does a rebased one
      // (its old head is gone from the history), which gets the full first review its new code needs.
      const connected = (reviewedBase === base || isAncestor(reviewedBase)) && (reviewedHead === head || isAncestor(reviewedHead));
      if (record.unreadable || record.incomplete || record.round === undefined || !connected || (record.branch && branch && record.branch !== branch)) continue;
      // The newest review of this change decides: when it found nothing, the loop had ended, so no open ids carry over, but the rounds still link.
      return { name, clean: !record.findings?.length, round: record.round ?? 1, head: reviewedHead, findings: record.findings.map((item, index) => ({ ...item, id: item.id ?? `R${record.round ?? 1}-${index + 1}` })) };
    } catch { /* An unreadable record is not a previous review. */ }
  }
  return null;
}
