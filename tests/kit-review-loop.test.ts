import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { NORMAL_ROUNDS, RISKY_ROUNDS, branchRisk, budgetReport, isNit, ledgerRows, loopBriefSection, loopStop, parseMarks, prLine, renderLedger, reviewChain, riskyChange, roundLimit, severityWord, stoppingFindings, unmarkedIds, withIds } from "../review-loop.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { openFindings } from "../review-findings.mjs";

// The review loop (Lex, 2026-11-06, after Theo's sol-loop): budget by risk, stop on nits, ids, ledger, PR line.
const finding = (severity: string | null, extra: Record<string, unknown> = {}) => ({ group: "Spec", severity, kind: "fault", text: `${severity ?? "unread"} finding with its evidence`, ...extra });
const gap = { group: "Validation gaps", severity: null, kind: null, text: "add a test" };

test("budget: the limit is 3 rounds, 5 only for a risky change", () => {
  assert.equal(NORMAL_ROUNDS, 3); assert.equal(RISKY_ROUNDS, 5);
  assert.equal(roundLimit(false), 3); assert.equal(roundLimit(true), 5);
  // Security, permissions, auth, data loss, state and concurrency: by path or by the words of the ticket.
  for (const path of ["src/auth/login.ts", "server/permissions.js", "lib/crypto.py", "db/migrations/001.sql", "config/.env.production", "src/session.ts", "src/lock.ts"])
    assert.equal(riskyChange({ paths: [path] }).risky, true, path);
  for (const text of ["Fix a race condition in the saver", "No more data loss on crash", "Harden authentication", "Add a permission check"])
    assert.equal(riskyChange({ text }).risky, true, text);
  for (const path of ["src/ui/button.css", "docs/readme.md", "src/author-card.ts", "tests/unit.test.ts"]) assert.equal(riskyChange({ paths: [path] }).risky, false, path);
  assert.equal(riskyChange({ text: "Change the button colour" }).risky, false);
  assert.deepEqual(riskyChange({ paths: ["src/auth/x.ts"] }).reasons, ["path src/auth/x.ts"]);
  // A project adds its own risky paths.
  assert.equal(riskyChange({ paths: ["billing/charge.ts"], settings: { paths: { risky: ["^billing/"] } } }).risky, true);
  assert.equal(riskyChange({ paths: ["billing/charge.ts"] }).risky, false);
});

test("severity words: P0 and P1 are blockers, P2 a should, P3 and validation gaps nits; an unread severity is never a nit", () => {
  assert.deepEqual(["P0", "P1", "P2", "P3", null].map(severity => severityWord(finding(severity))), ["blocker", "blocker", "should", "nit", "blocker"]);
  assert.equal(severityWord(gap), "nit");
  assert.equal(isNit(finding("P3")), true); assert.equal(isNit(finding("P2")), false);
});

test("nits: a round that returns only nits needs no fix round, and neither do declined nits", () => {
  for (const rounds of [0, 1, 2, 3, 4]) {
    assert.deepEqual(stoppingFindings([finding("P3"), gap], rounds, false), [], `rounds ${rounds}`);
    assert.deepEqual(stoppingFindings([], rounds, true), []);
  }
  assert.equal(loopStop([finding("P3"), gap], 0, false), "nits");
  assert.equal(loopStop([], 0, false), "clean");
  // A blocker or a should still calls for a round while the budget lasts.
  const open = [finding("P2"), finding("P3")];
  assert.equal(stoppingFindings(open, 1, false).length, 1);
  assert.equal(loopStop(open, 1, false), null);
});

test("budget and out-of-budget: normal changes stop at 3 rounds, risky ones at 5 while a blocker or should stays open; out of budget is reported, never approved", () => {
  const should = [finding("P2")], blocker = [finding("P1"), finding("P2")];
  // Normal: after 3 rounds only blockers hold the landing; a should goes to the lead.
  assert.deepEqual(stoppingFindings(should, 3, false), []);
  assert.equal(stoppingFindings(blocker, 3, false).length, 1);
  assert.equal(loopStop(should, 3, false), "budget");
  // Risky: rounds 4 and 5 still run for a should or a blocker; after 5 only blockers hold.
  assert.equal(stoppingFindings(should, 3, true).length, 1);
  assert.equal(stoppingFindings(should, 4, true).length, 1);
  assert.deepEqual(stoppingFindings(should, 5, true), []);
  assert.equal(stoppingFindings(blocker, 5, true).length, 1);
  assert.equal(loopStop(blocker, 5, true), "budget");
  assert.equal(loopStop(should, 4, true), null);
  // Nits alone never extend a risky change either.
  assert.deepEqual(stoppingFindings([finding("P3")], 3, true), []);
  const report = budgetReport({ rounds: 5, limit: 5, open: withIds(blocker, 5) });
  assert.match(report, /^Review budget used: 5 of 5 fix rounds, 2 open findings\. Running out of budget is not approval; Lex decides\.$/m);
  assert.match(report, /- R5-1 \(blocker\): /);
  assert.doesNotMatch(budgetReport({ rounds: 3, limit: 3, open: [finding("P2")] }), /undefined|finding \(/, "no id is made up when there is none");
});

test("later rounds: ids, marks and the brief section of a later round", () => {
  const ids = withIds([finding("P1"), finding("P3")], 2);
  assert.deepEqual(ids.map(item => item.id), ["R2-1", "R2-2"]);
  const marks = parseMarks("REVIEW_STATUS: complete\nPrevious findings:\n- R1-1: resolved\nR1-2: still open (P2): the retry still loses the second write\n`R1-3`: still open\n\nDefects: none\n");
  assert.deepEqual([...marks.entries()], [["R1-1", { status: "resolved", severity: null, reason: "" }], ["R1-2", { status: "open", severity: "P2", reason: "the retry still loses the second write" }], ["R1-3", { status: "open", severity: null, reason: "" }]]);
  assert.deepEqual(unmarkedIds(["R1-1", "R1-2", "R1-4"], marks), ["R1-4"]);
  const section = loopBriefSection({ round: 2, limit: 3, previousHead: "abc1234", currentHead: "def5678", open: withIds([finding("P1")], 1) });
  assert.match(section, /^## Review loop: review round 2, after 1 fix round \(at most 3 fix rounds\)$/m);
  assert.match(loopBriefSection({ round: 4, limit: 3, previousHead: "a", currentHead: "b", open: [] }), /review round 4, after 3 fix rounds \(at most 3 fix rounds\)/);
  assert.match(loopBriefSection({ round: 2, limit: 3, previousHead: "same", currentHead: "same", open: withIds([finding("P1")], 1) }), /No commit came after the last review/);
  assert.match(section, /Review only the code changed since abc1234 \(the `Changes since the last review` file named in the scope note\)/);
  assert.match(loopBriefSection({ round: 2, limit: 3, previousHead: null, currentHead: "x", open: [] }), /rebuilt since the last review \(a rebase\)/);
  assert.match(loopBriefSection({ round: 2, limit: 3, previousHead: "a", currentHead: "b", open: withIds([finding("P1")], 1), answer: "Declined R1-1: rare path" }), /The builder's written answer to them[^]*Declined R1-1: rare path/);
  assert.match(loopBriefSection({ round: 2, limit: 3, previousHead: "a", currentHead: "b", open: [{ id: "R1-2", group: "Validation gaps", severity: null, kind: null, text: "add a test" }] }), /- R1-2 \(validation gap\): add a test/);
  assert.match(section, /- R1-1 \(P1 fault\): P1 finding with its evidence/);
  assert.match(section, /`<id>: resolved` or `<id>: still open \(<its severity, or gap for a validation gap>\): <reason>`/);
  assert.match(section, /start no subagents/);
});

test("ledger and PR line: the ledger holds only what a review wrote, and the PR line is exact", () => {
  const chain = [
    { round: 1, findings: withIds([finding("P1"), finding("P2"), finding("P3")], 1), marks: new Map() },
    { round: 2, findings: withIds([finding("P2")], 2), marks: new Map([["R1-1", { status: "resolved", reason: "" }], ["R1-2", { status: "open", reason: "still drops on retry" }]]) },
  ];
  const rows = ledgerRows(chain);
  assert.deepEqual(rows, [
    { id: "R1-1", severity: "blocker", outcome: "resolved" },
    { id: "R1-2", severity: "should", outcome: "still open: still drops on retry" },
    { id: "R1-3", severity: "nit", outcome: "not marked by the next review" },
    { id: "R2-1", severity: "should", outcome: "open at the end" },
  ]);
  const table = renderLedger(rows);
  assert.match(table, /^\| id \| severity \| outcome \|$/m);
  assert.match(table, /^\| R1-3 \| nit \| not marked by the next review \|$/m);
  assert.equal(renderLedger([]), "Findings ledger: none.");
  assert.equal(prLine({ rounds: 2, model: "claude-opus-5-5" }), "Reviewed with review-loop: 2 rounds with claude-opus-5-5. Verdict: approved");
  assert.equal(prLine({ rounds: 1, model: "m" }), "Reviewed with review-loop: 1 round with m. Verdict: approved");
  assert.equal(prLine({ rounds: 3, model: "m", verdict: "not approved (budget used, 1 finding waived by the lead)" }), "Reviewed with review-loop: 3 rounds with m. Verdict: not approved (budget used, 1 finding waived by the lead)");
});

test("the chain of reviews is read from the evidence folders: findings.json and each result.md", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-loop-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const save = (name: string, record: object, result: string) => {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "findings.json"), JSON.stringify(record));
    writeFileSync(join(dir, name, "result.md"), result);
  };
  save("20261106T100000Z", { round: 1, model: "claude-opus-5-5", head: "a1", findings: withIds([finding("P1")], 1) }, "REVIEW_STATUS: complete\nDefects: x\n");
  save("20261106T101000Z", { round: 2, model: "claude-opus-5-5", head: "b2", previous: "20261106T100000Z", findings: [] }, "REVIEW_STATUS: complete\nPrevious findings:\nR1-1: resolved\nDefects: none\n");
  const chain = reviewChain(join(dir, "20261106T101000Z"));
  assert.deepEqual(chain.map(record => record.round), [1, 2]);
  assert.deepEqual(ledgerRows(chain), [{ id: "R1-1", severity: "blocker", outcome: "resolved" }]);
  assert.deepEqual(reviewChain(join(dir, "nowhere")), []);
});

test("a \"still open\" mark is an open finding (it blocks), a resolved one is not, and a mark's severity is kept", () => {
  const report = (marks: string) => `REVIEW_STATUS: complete\nPrevious findings:\n${marks}\nDefects: none\nValidation gaps: none.\n`;
  const stillOpen = openFindings(report("R1-1: still open: the save still drops data")).findings;
  assert.deepEqual(stillOpen.map((item: { group: string; severity: string | null; text: string }) => [item.group, item.severity, item.text]), [["Previous findings", null, "R1-1 still open: the save still drops data"]]);
  assert.equal(severityWord(stillOpen[0]), "blocker", "an unread severity fails closed");
  const should = openFindings(report("R1-2: still open (P2): rare path")).findings;
  assert.equal(severityWord(should[0]), "should");
  assert.deepEqual(openFindings(report("R1-1: resolved\nR1-2: resolved")).findings, []);
  assert.deepEqual(stoppingFindings(stillOpen, 1, false).length, 1);
});

test("risk: plurals, state words and paths count; a bad paths.risky is named, never dropped", () => {
  for (const text of ["Fix permissions on the admin page", "rotate secrets", "move the credentials", "wrap it in transactions", "make the state machine safe", "no more stale state"]) assert.equal(riskyChange({ text }).risky, true, text);
  for (const path of ["src/state/store.ts", "src/stores/cart.ts"]) assert.equal(riskyChange({ paths: [path] }).risky, true, path);
  assert.equal(riskyChange({ text: "Rename the empty state label" }).risky, false);
  assert.throws(() => riskyChange({ settings: { paths: { risky: ["(unclosed"] } } }), /^Error: paths\.risky in scripts\/agents\/kit\.json: /);
  assert.throws(() => riskyChange({ settings: { paths: { risky: "^billing/" } } }), /paths\.risky in scripts\/agents\/kit\.json must be a list of regular expressions/);
});

test("one risk function for every command: the diff, the files a ticket names and its words", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-risk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "a.txt"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  mkdirSync(join(dir, "docs")); writeFileSync(join(dir, "docs/ticket.md"), "# T\n\n## Files\n- `src/auth/x.ts`\n");
  assert.equal(branchRisk({ root: dir, base: "main", ticket: "docs/ticket.md", settings: {} }).risky, true, "the ticket names an auth file");
  assert.equal(branchRisk({ root: dir, base: "main", ticket: null, settings: {} }).risky, false);
  git("checkout", "-qb", "feature"); mkdirSync(join(dir, "src/session"), { recursive: true }); writeFileSync(join(dir, "src/session/s.ts"), "x\n"); git("add", "."); git("commit", "-qm", "change");
  assert.equal(branchRisk({ root: dir, base: "main", ticket: null, settings: {} }).risky, true, "the diff changes a session file");
});

test("old saved reviews without ids get the ids a new one would have", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-loop-old-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "r1"));
  writeFileSync(join(dir, "r1", "findings.json"), JSON.stringify({ model: "m", head: "h", findings: [{ group: "Spec", severity: "P2", kind: "fault", text: "x" }] }));
  writeFileSync(join(dir, "r1", "result.md"), "REVIEW_STATUS: complete\nDefects: x\n");
  assert.deepEqual(ledgerRows(reviewChain(join(dir, "r1"))), [{ id: "R1-1", severity: "should", outcome: "open at the end" }]);
});

test("a validation gap marked still open stays a gap (a nit); a mark with no reason is no evidence for rounds 4 and 5", () => {
  const gapMark = openFindings("REVIEW_STATUS: complete\nPrevious findings:\nR1-2: still open (gap): add a test\nDefects: none\nValidation gaps: none.\n").findings;
  assert.deepEqual(gapMark.map((item: { group: string; severity: string | null }) => [item.group, item.severity]), [["Validation gaps", null]]);
  assert.equal(severityWord(gapMark[0]), "nit");
  assert.deepEqual(stoppingFindings(gapMark, 0, false), []);
  const noReason = openFindings("REVIEW_STATUS: complete\nPrevious findings:\nR1-1: still open (P2)\nDefects: none\nValidation gaps: none.\n").findings;
  assert.equal(stoppingFindings(noReason, 2, true).length, 1, "within the 3 rounds it still counts");
  assert.deepEqual(stoppingFindings(noReason, 3, true), [], "round 4 needs evidence");
  assert.equal(stoppingFindings(openFindings("REVIEW_STATUS: complete\nPrevious findings:\nR1-1: still open (P2): the retry drops a write\nDefects: none\nValidation gaps: none.\n").findings, 3, true).length, 1);
});

test("the ledger links a carried finding to its first id: one row, the latest outcome", () => {
  const chain = [
    { round: 1, findings: withIds([finding("P1")], 1), marks: new Map() },
    { round: 2, findings: [{ id: "R2-1", group: "Previous findings", severity: "P1", text: "R1-1 still open: drops" }], marks: new Map([["R1-1", { status: "open", severity: "P1", reason: "drops" }]]) },
    { round: 3, findings: [], marks: new Map([["R2-1", { status: "resolved", severity: null, reason: "" }]]) },
  ];
  assert.deepEqual(ledgerRows(chain), [{ id: "R1-1", severity: "blocker", outcome: "resolved" }]);
  // Still open at the last round: one row with the reason.
  assert.deepEqual(ledgerRows(chain.slice(0, 2)), [{ id: "R1-1", severity: "blocker", outcome: "still open: drops" }]);
});

test("risk by path needs the name itself: auth/, auth.ts, session.ts, but not auth-card.ts, tokens.css or state-label.tsx", () => {
  for (const path of ["src/auth/login.ts", "src/auth.ts", "lib/session.ts", "src/permissions/rules.ts", "src/state/store.ts"]) assert.equal(riskyChange({ paths: [path] }).risky, true, path);
  for (const path of ["src/auth-card.tsx", "src/tokens.css", "src/state-label.tsx", "src/store-card.tsx", "src/session-card.tsx", "src/author.ts"]) assert.equal(riskyChange({ paths: [path] }).risky, false, path);
});
