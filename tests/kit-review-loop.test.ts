import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { NORMAL_ROUNDS, RISKY_ROUNDS, budgetReport, isNit, ledgerRows, loopBriefSection, loopStop, parseMarks, prLine, renderLedger, reviewChain, riskyChange, roundLimit, severityWord, stoppingFindings, unmarkedIds, withIds } from "../review-loop.mjs";

// The review loop (Lex, 2026-11-06, after Theo's sol-loop): budget by risk, stop on nits, ids, ledger, PR line.
const finding = (severity: string | null, extra: Record<string, unknown> = {}) => ({ group: "Spec", severity, kind: "fault", text: `${severity ?? "unread"} finding with its evidence`, ...extra });
const gap = { group: "Validation gaps", severity: null, kind: null, text: "add a test" };

test("rule 1: the limit is 3 rounds, 5 only for a risky change", () => {
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

test("rule 2: a round that returns only nits needs no fix round, and neither do declined nits", () => {
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

test("rule 1 and 6: normal changes stop at 3 rounds, risky ones at 5 while a blocker or should stays open; out of budget is reported, never approved", () => {
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
  assert.match(report, /^Review budget used: 5 of 5 rounds, 2 open findings\. Running out of budget is not approval; Lex decides\.$/m);
  assert.match(report, /- R5-1 \(blocker\): /);
});

test("rule 3: ids, marks and the brief section of a later round", () => {
  const ids = withIds([finding("P1"), finding("P3")], 2);
  assert.deepEqual(ids.map(item => item.id), ["R2-1", "R2-2"]);
  const marks = parseMarks("REVIEW_STATUS: complete\nPrevious findings:\n- R1-1: resolved\nR1-2: still open: the retry still loses the second write\n`R1-3`: still open\n\nDefects: none\n");
  assert.deepEqual([...marks.entries()], [["R1-1", { status: "resolved", reason: "" }], ["R1-2", { status: "open", reason: "the retry still loses the second write" }], ["R1-3", { status: "open", reason: "" }]]);
  assert.deepEqual(unmarkedIds(["R1-1", "R1-2", "R1-4"], marks), ["R1-4"]);
  const section = loopBriefSection({ round: 2, limit: 3, previousHead: "abc1234", open: withIds([finding("P1")], 1) });
  assert.match(section, /^## Review loop: round 2 of at most 3$/m);
  assert.match(section, /git diff abc1234\.\.HEAD/);
  assert.match(section, /- R1-1 \(P1 fault\): P1 finding with its evidence/);
  assert.match(section, /`<id>: resolved` or `<id>: still open: <reason>`/);
  assert.match(section, /start no subagents/);
});

test("rule 5 and 7: the ledger holds only what a review wrote, and the PR line is exact", () => {
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
