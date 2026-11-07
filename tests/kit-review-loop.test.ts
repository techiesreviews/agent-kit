import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { NORMAL_ROUNDS, RISKY_ROUNDS, branchRisk, budgetReport, findPreviousReview, isNit, ledgerRows, loopBriefSection, loopStop, parseMarks, prLine, renderLedger, reviewChain, riskyChange, roundLimit, severityWord, stoppingFindings, unmarkedIds, withIds } from "../review-loop.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { findingsRecord, openFindings } from "../review-findings.mjs";

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
  assert.match(loopBriefSection({ round: 2, limit: 3, previousHead: "a", currentHead: "b", open: [{ id: "R1-2", group: "Validation gaps", severity: null, kind: null, text: "add a test" }] }), /- R1-2 \(validation gap\): add a test/);
  assert.match(section, /- R1-1 \(P1 fault\): P1 finding with its evidence/);
  assert.match(section, /`<id>: resolved` or `<id>: still open \(<its severity, or gap for a validation gap>\): <reason>`/);
  assert.match(section, /start no subagents/);
  assert.doesNotMatch(section, /and is run again|\. A review that leaves an id out is incomplete and is run again/);
  assert.match(section, /rejected as incomplete and is not reused; it has to be run again/);
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

test("a blocker with no reason still holds rounds 4 and 5; a should with no reason does not", () => {
  const mark = (severity: string) => openFindings(`REVIEW_STATUS: complete\nPrevious findings:\nR1-1: still open${severity}\nDefects: none\nValidation gaps: none.\n`).findings;
  assert.equal(stoppingFindings(mark(" (P1)"), 3, true).length, 1);
  assert.equal(stoppingFindings(mark(""), 4, true).length, 1, "an unread severity is a blocker");
  assert.deepEqual(stoppingFindings(mark(" (P2)"), 3, true), []);
});

test("a carried validation gap is one ledger row, not two", () => {
  const chain = [
    { round: 1, findings: [{ id: "R1-2", group: "Validation gaps", severity: null, kind: null, text: "add a test" }], marks: new Map() },
    { round: 2, findings: [{ id: "R2-1", group: "Validation gaps", severity: null, kind: null, text: "R1-2 still open: add a test" }], marks: new Map([["R1-2", { status: "open", severity: "GAP", reason: "add a test" }]]) },
    { round: 3, findings: [], marks: new Map([["R2-1", { status: "resolved", severity: null, reason: "" }]]) },
  ];
  assert.deepEqual(ledgerRows(chain), [{ id: "R1-2", severity: "nit", outcome: "resolved" }]);
});

test("a later round answers only its own branch's history: a branch cut from a reviewed head, or a rebased one, starts at round 1", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-prev-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "a"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  git("checkout", "-qb", "feature"); writeFileSync(join(dir, "a"), "2\n"); git("commit", "-qam", "work");
  const reviewed = git("rev-parse", "HEAD").stdout.trim();
  const parent = join(dir, "reviews"); mkdirSync(join(parent, "20261106T100000Z"), { recursive: true });
  writeFileSync(join(parent, "20261106T100000Z", "refs.txt"), `${reviewed}\n${base}\n`);
  writeFileSync(join(parent, "20261106T100000Z", "findings.json"), JSON.stringify({ round: 1, branch: "feature", model: "m", head: reviewed, findings: withIds([finding("P1")], 1) }));
  writeFileSync(join(dir, "a"), "3\n"); git("commit", "-qam", "fix");
  const head = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(findPreviousReview(parent, { head, base, root: dir, branch: "feature" })?.round, 1, "the same branch answers its review");
  assert.equal(findPreviousReview(parent, { head, base, root: dir, branch: "stacked-on-feature" }), null, "another branch starts at round 1");
  // A rebase leaves the old head out of the history: no earlier review to answer.
  git("checkout", "-q", "main"); writeFileSync(join(dir, "b"), "x\n"); git("add", "."); git("commit", "-qm", "main moved");
  git("checkout", "-qb", "rebuilt"); writeFileSync(join(dir, "a"), "2b\n"); git("commit", "-qam", "same work again");
  const rebuilt = git("rev-parse", "HEAD").stdout.trim(), newBase = git("rev-parse", "main").stdout.trim();
  assert.equal(findPreviousReview(parent, { head: rebuilt, base: newBase, root: dir, branch: "feature" }), null);
});

test("a ticket's risk is read from its title, goal and named files, not the follow-up notes written into it later", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-risk2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "a"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  writeFileSync(join(dir, "t.md"), '---\ntitle: "Change the button colour"\n---\n\n## Goal\nA bluer button.\n\n## Files\n- `src/ui/button.css`\n\n## Done (2026-11-06)\n\n### Follow-ups\n- Spec: a finding about authentication and src/auth/x.ts\n');
  assert.equal(branchRisk({ root: dir, base: "main", ticket: "t.md", settings: {} }).risky, false);
  writeFileSync(join(dir, "t2.md"), '---\ntitle: "Harden authentication"\n---\n\n## Goal\nx\n');
  assert.equal(branchRisk({ root: dir, base: "main", ticket: "t2.md", settings: {} }).risky, true);
});

// Follow-ups of the review loop (TOOLS-13): items 1, 2 and 10.
const marksReport = (marks: string) => `REVIEW_STATUS: complete\nPrevious findings:\n${marks}\nDefects: none\nValidation gaps: none.\n`;
const earlier = [{ id: "R1-2", group: "Spec", severity: "P2", kind: "fault", text: "file.txt:4 — P2 fault: the retry loses the second write when the first fails." }];

test("a \"still open\" mark keeps the original finding text, beside the reviewer's reason", () => {
  const [carried] = openFindings(marksReport("R1-2: still open (P2): the retry still loses it"), earlier).findings;
  assert.match(carried.text, /^R1-2 still open: the retry still loses it/);
  assert.ok(carried.text.includes("file.txt:4 — P2 fault: the retry loses the second write when the first fails."), carried.text);
  assert.equal(carried.severity, "P2");
  // It is still a carried finding (the ledger and the rounds find it by its start), and without the earlier text nothing is added.
  assert.match(carried.text, /^R\d+-\d+ still open/);
  assert.equal(openFindings(marksReport("R1-2: still open (P2): rare path")).findings[0].text, "R1-2 still open: rare path");
  assert.equal(openFindings(marksReport("R1-2: still open (P2): rare path"), [{ id: "R1-9", text: "other" }]).findings[0].text, "R1-2 still open: rare path");
  // A mark with no reason is still no evidence for rounds 4 and 5, with the original text beside it or not.
  const noReason = openFindings(marksReport("R1-2: still open (P2)"), earlier).findings;
  assert.ok(noReason[0].text.includes("the retry loses the second write"));
  assert.equal(stoppingFindings(noReason, 3, true).length, 0);
  assert.equal(stoppingFindings(openFindings(marksReport("R1-2: still open (P2): drops it"), earlier).findings, 3, true).length, 1);
});

test("a finding carried over twice keeps its first text once, not a copy inside a copy", () => {
  const first = openFindings(marksReport("R1-2: still open (P2): still drops"), earlier).findings[0];
  const second = openFindings(marksReport("R2-1: still open (P2): still drops"), [{ ...first, id: "R2-1" }]).findings[0];
  assert.ok(second.text.startsWith("R2-1 still open: still drops"), second.text);
  assert.equal(second.text.split("the retry loses the second write").length, 2, "the first text is there exactly once");
  assert.equal(second.text.includes("still open: still drops (original"), true);
  assert.ok(!second.text.includes("R1-2 still open"), second.text);
});

test("the saved record keeps a carried finding's original text, and the next round's brief shows it", () => {
  const record = findingsRecord(marksReport("R1-2: still open (P2): still drops"), { round: 2 }, earlier);
  assert.ok(record.findings[0].text.includes("the retry loses the second write"));
  assert.equal(record.findings[0].id, "R2-1");
  const section = loopBriefSection({ round: 3, limit: 3, previousHead: "a", currentHead: "b", open: record.findings });
  assert.ok(section.includes("the retry loses the second write when the first fails."), section);
});

test("the ledger shows a finding's current severity: a reviewer's later mark wins over the first rating", () => {
  const nit = { id: "R1-1", group: "Spec", severity: "P3", kind: "fault", text: "a.ts:1 — P3 fault: rare" };
  const chain = [
    { round: 1, findings: [nit], marks: new Map() },
    { round: 2, findings: [{ id: "R2-1", group: "Previous findings", severity: "P1", kind: "unsorted", text: "R1-1 still open: it drops data" }], marks: new Map([["R1-1", { status: "open", severity: "P1", reason: "it drops data" }]]) },
  ];
  assert.deepEqual(ledgerRows(chain), [{ id: "R1-1", severity: "blocker", outcome: "still open: it drops data" }]);
  // Resolved later: the row keeps the last severity a review gave it.
  assert.deepEqual(ledgerRows([...chain, { round: 3, findings: [], marks: new Map([["R2-1", { status: "resolved", severity: null, reason: "" }]]) }]), [{ id: "R1-1", severity: "blocker", outcome: "resolved" }]);
  // Downgraded: a blocker marked still open as P3 is a nit in the ledger.
  const down = [{ round: 1, findings: [{ ...nit, severity: "P1" }], marks: new Map() },
    { round: 2, findings: [{ id: "R2-1", group: "Previous findings", severity: "P3", kind: "unsorted", text: "R1-1 still open: rare path only" }], marks: new Map([["R1-1", { status: "open", severity: "P3", reason: "rare path only" }]]) },
    { round: 3, findings: [], marks: new Map([["R2-1", { status: "open", severity: "P2", reason: "slightly worse" }]]) }];
  assert.deepEqual(ledgerRows(down.slice(0, 2)), [{ id: "R1-1", severity: "nit", outcome: "still open: rare path only" }]);
  // A mark that ends the chain for lack of a carried finding still gives its severity.
  assert.deepEqual(ledgerRows(down), [{ id: "R1-1", severity: "should", outcome: "still open: slightly worse" }]);
});

test("a same-head rerun's brief lists the builder's declined findings itself, or says none were recorded", () => {
  const open = withIds([finding("P1")], 1);
  const declined = [{ text: "file.txt:1 — P2 style: rename it", reason: "the spec keeps the name", round: 1 }];
  const listed = loopBriefSection({ round: 2, limit: 3, previousHead: "same", currentHead: "same", open, declined });
  assert.match(listed, /Declined by the builder \(with reasons\):\n- file\.txt:1 — P2 style: rename it — reason: the spec keeps the name/);
  assert.match(listed, /its declined findings and their reasons are listed below/);
  assert.doesNotMatch(listed, /are in this brief/);
  // Declined findings that the brief already carries (kit fix hands them over) are pointed at, not repeated.
  const carried = loopBriefSection({ round: 2, limit: 3, previousHead: "same", currentHead: "same", open, declinedInBrief: true });
  assert.match(carried, /its declined findings and their reasons are in the "Declined by the author" part of this brief/);
  // None known: the brief never points at a list that is not there.
  const none = loopBriefSection({ round: 2, limit: 3, previousHead: "same", currentHead: "same", open });
  assert.match(none, /No commit came after the last review/);
  assert.match(none, /no declined finding was recorded/);
  assert.doesNotMatch(none, /their reasons are (?:in this brief|listed below)/);
  // A changed head never claims declined findings are there.
  assert.doesNotMatch(loopBriefSection({ round: 2, limit: 3, previousHead: "a", currentHead: "b", open }), /declined/);
});

test("the ledger keeps the severity known so far when a mark names none or the next review leaves the finding out", () => {
  const p1 = { id: "R1-1", group: "Spec", severity: "P1", kind: "fault", text: "a.ts:1 — P1 fault: drops data" };
  // A carried finding with no severity and a mark with no severity: the row stays a blocker, as its first rating was.
  const unnamed = [{ round: 1, findings: [p1], marks: new Map() },
    { round: 2, findings: [{ id: "R2-1", group: "Previous findings", severity: null, kind: "unsorted", text: "R1-1 still open: still drops" }], marks: new Map([["R1-1", { status: "open", severity: null, reason: "still drops" }]]) }];
  assert.deepEqual(ledgerRows(unnamed), [{ id: "R1-1", severity: "blocker", outcome: "still open: still drops" }]);
  // Same with a should: it stays a should, not a blocker (the severity known so far, not the gate's fail-closed reading).
  const should = [{ round: 1, findings: [{ ...p1, severity: "P2" }], marks: new Map() }, unnamed[1]];
  assert.deepEqual(ledgerRows(should), [{ id: "R1-1", severity: "should", outcome: "still open: still drops" }]);
  // The next review leaves the finding unmarked: its first severity and the outcome "not marked".
  assert.deepEqual(ledgerRows([unnamed[0], { round: 2, findings: [], marks: new Map() }]), [{ id: "R1-1", severity: "blocker", outcome: "not marked by the next review" }]);
});
