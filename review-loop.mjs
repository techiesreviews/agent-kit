// The review loop (Lex, 2026-11-06; after Theo's sol-loop): the budget as a function of risk, the early stop on nits,
// finding ids and the ledger, and the PR line. The rule text is the "Review loop" section of docs/kitchen.md.
// The pure parts live here so kit review, kit fix, kit slice and kit pr never read the rules differently.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { blockingFindings } from "./review-findings.mjs";

/** Rounds of fixing a normal change gets, and the most a risky change gets while a blocker or should stays open. */
export const NORMAL_ROUNDS = 3;
export const RISKY_ROUNDS = 5;

// Security, permissions, auth, data loss, state and concurrency: by path, or by the words of a ticket or title.
const riskyPaths = [/(?:^|\/)(?:auth|authn|authz|security|permissions?|acl|rbac|crypto|secrets?|credentials?|tokens?|sessions?|oauth|login|passwords?)(?:[./_-]|\/|$)/i,
  /(?:^|\/)\.env(?:\.|$)/i, /(?:^|\/)migrations?\//i, /(?:^|\/)(?:locks?|queues?|transactions?|concurrency)(?:[./_-]|\/|$)/i];
const riskyWords = /\b(?:security|permission|authenticat\w*|authoriz\w*|auth|credential|secret|data loss|lose data|delete data|deletion|destructive|concurren\w+|race condition|deadlock|transaction)\b/i;

/**
 * Whether a change is risky enough for the longer budget: any changed path, or the text (a ticket's title and goal), names
 * security, permissions, auth, data loss, state or concurrency. `paths.risky` in the settings adds project patterns.
 * Returns { risky, reasons } with plain reasons.
 */
export function riskyChange({ paths = [], text = "", settings = {} } = {}) {
  const extra = (settings.paths?.risky ?? []).flatMap(source => { try { return [new RegExp(source)]; } catch { return []; } });
  const reasons = [];
  for (const path of paths) {
    if ([...riskyPaths, ...extra].some(pattern => pattern.test(path))) reasons.push(`path ${path}`);
  }
  const word = riskyWords.exec(text)?.[0];
  if (word) reasons.push(`text mentions "${word}"`);
  return { risky: reasons.length > 0, reasons: reasons.slice(0, 5) };
}

/** The fix-round limit for a change: 3, or 5 for a risky one (rounds past 3 still need an open blocker or should). */
export const roundLimit = risky => (risky ? RISKY_ROUNDS : NORMAL_ROUNDS);

/** blocker (P0, P1), should (P2) or nit (P3, a validation gap); an unread severity counts as a blocker, never as a nit. */
export function severityWord(item) {
  if (item.group === "Validation gaps") return "nit";
  if (item.severity === "P0" || item.severity === "P1" || !item.severity) return "blocker";
  return item.severity === "P2" ? "should" : "nit";
}
export const isNit = item => severityWord(item) === "nit";

/**
 * The open findings that still call for a fix round, or that stop a landing, after `rounds` fix rounds:
 * nothing but nits never does (rule 2); within the limit every blocker and should does; once the limit is used
 * only blockers do, and the rest go to the lead (rule 6: running out of budget is never approval).
 * The 4th and 5th round of a risky change run only while a blocker or should is open with its evidence written.
 */
export function stoppingFindings(open, rounds, risky) {
  const real = open.filter(item => !isNit(item));
  if (!real.length) return [];
  if (rounds >= roundLimit(risky)) return blockingFindings(open);
  if (rounds >= NORMAL_ROUNDS && !real.some(item => String(item.text ?? "").trim())) return [];
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

const MARK = /^\s*(?:[-*+]\s+)?`?(R\d+-\d+)`?\s*:\s*(resolved|still open)\b[\s.:;,—–-]*(.*)$/i;
/**
 * The marks a later review gives the earlier ids: `R1-2: resolved` or `R1-2: still open: <reason>`, in the block
 * before its defects (the parser reads defects only after a Defects heading, so the marks never count as findings).
 * Returns a Map id -> { status: "resolved" | "open", reason }.
 */
export function parseMarks(resultMd) {
  const marks = new Map();
  for (const line of resultMd.split(/\r?\n/)) {
    const found = MARK.exec(line);
    if (found) marks.set(found[1].toUpperCase(), { status: found[2].toLowerCase() === "resolved" ? "resolved" : "open", reason: found[3].trim() });
  }
  return marks;
}

/** Ids from the earlier round that the later review did not mark: the review must say each one is resolved or still open. */
export const unmarkedIds = (ids, marks) => ids.filter(id => !marks.has(id));

/**
 * The brief section for round 2 and later (rule 3): review only what changed since the last reviewed head and the open ids,
 * and mark each old id. `open` is [{ id, severity, kind, text }].
 */
export function loopBriefSection({ round, limit, previousHead, open }) {
  const list = open.map(item => `- ${item.id} (${item.severity ?? "no severity"}${item.kind && item.kind !== "unsorted" ? ` ${item.kind}` : ""}): ${String(item.text).slice(0, 200)}`).join("\n");
  return [
    `## Review loop: round ${round} of at most ${limit}`,
    `Review only the code changed since ${previousHead} (\`git diff ${previousHead}..HEAD\`) and the findings still open below. Do not review unchanged code again.`,
    "Open findings from the last round:", list,
    "Before your Defects heading, write the block `Previous findings:` with one line for every id above, none left out: `<id>: resolved` or `<id>: still open: <reason>`.",
    "You are the only reviewer: start no subagents. New findings use the usual format; a nit is a rare path, a small cost, or a comment, doc or format-only point.",
  ].join("\n\n");
}

/** The PR line (rule 7): `Reviewed with review-loop: N rounds with <model>. Verdict: approved`. */
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
  chain.forEach((record, index) => {
    const next = chain[index + 1];
    for (const finding of record.findings ?? []) {
      let outcome = "open at the end";
      if (next) {
        const mark = next.marks?.get(finding.id);
        outcome = !mark ? "not marked by the next review" : mark.status === "resolved" ? "resolved" : `still open: ${mark.reason || "no reason given"}`;
      }
      rows.push({ id: finding.id, severity: severityWord(finding), outcome });
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

/** The report for a loop that ran out of budget or is stuck (rule 6): open findings for Lex, never an approval. */
export function budgetReport({ rounds, limit, open }) {
  const lines = open.slice(0, 5).map(item => `- ${item.id ?? "finding"} (${severityWord(item)}): ${String(item.text).replace(/\s+/g, " ").slice(0, 160)}`);
  return [`Review budget used: ${rounds} of ${limit} rounds, ${open.length} open finding${open.length === 1 ? "" : "s"}. Running out of budget is not approval; Lex decides.`, ...lines].join("\n");
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
    chain.unshift({ round: record.round ?? 1, model: record.model, head: record.head, findings: record.findings ?? [], marks });
    current = record.previous ? join(dirname(current), record.previous) : null;
  }
  return chain;
}

/**
 * The earlier review this one answers (rule 3): in `parent` (the owner's folder under .scratch/reviews) the newest review of the
 * same base that still had findings and whose reviewed head is an ancestor of the current head. A second look's folder is never one.
 * Returns { name, round, head, findings } or null (then this is round 1, a full review).
 */
export function findPreviousReview(parent, { head, base, root }) {
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
      if (record.unreadable || record.round === undefined || reviewedBase !== base || reviewedHead === head || !isAncestor(reviewedHead)) continue;
      // The newest review of this change decides: one that found nothing ended the loop, so the next review starts again at round 1.
      if (!record.findings?.length) return null;
      return { name, round: record.round ?? 1, head: reviewedHead, findings: record.findings.map((item, index) => ({ ...item, id: item.id ?? `R${record.round ?? 1}-${index + 1}` })) };
    } catch { /* An unreadable record is not a previous review. */ }
  }
  return null;
}
