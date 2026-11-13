import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { NORMAL_ROUNDS, modelsLine, RISKY_ROUNDS, branchRisk, budgetReport, findPreviousReview, isNit, ledgerRows, loopBriefSection, loopStop, parseMarks, prLine, renderLedger, reviewChain, riskyChange, roundLimit, secondLookRows, severityWord, stoppingFindings, unmarkedIds, waiverCheck, waiverRefusal, withIds } from "../review-loop.mjs";
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

test("budget report: every open item is counted and listed (blockers first), the builder's declined findings come with their reasons, and long lists are cut with a count", () => {
  const open = withIds([finding("P1"), finding("P2")], 4);
  const report = budgetReport({ rounds: 3, limit: 3, open, declined: [{ text: "the save drops a write", reason: "the spec keeps the last write" }, { text: "rename it" }, { text: "  " }] });
  assert.match(report, /^Review budget used: 3 of 3 fix rounds, 2 open findings\./);
  assert.deepEqual(report.split("\n").slice(1), ["- R4-1 (blocker): P1 finding with its evidence", "- R4-2 (should): P2 finding with its evidence",
    "Builder's side (declined, with reasons):", "- the save drops a write — reason: the spec keeps the last write", "- rename it — reason: none given"]);
  const many = budgetReport({ rounds: 3, limit: 3, open: Array.from({ length: 7 }, () => finding("P2")), declined: Array.from({ length: 6 }, (_, index) => ({ text: `d${index}`, reason: "r" })) });
  assert.match(many, /^- … and 2 more$/m);
  assert.match(many, /^- … and 1 more$/m);
  assert.doesNotMatch(budgetReport({ rounds: 3, limit: 3, open }), /Builder's side/, "no declined finding, no builder's side");
});

test("second-look rows: ids say second look; the outcome says what the landing did with each finding", () => {
  const should = finding("P2", { text: "a.ts:1 P2 a should" }), nit = finding("P3", { text: "b.ts:2 P3 a nit" }), blocker = finding("P1", { text: "c.ts:3 P1 a blocker" });
  assert.deepEqual(secondLookRows([should, nit, blocker], { waived: [blocker] }), [
    { id: "SL-1", severity: "should", outcome: "open, follow-up for Lex (second look): a.ts:1 P2 a should" },
    { id: "SL-2", severity: "nit", outcome: "follow-up, nit (second look): b.ts:2 P3 a nit" },
    { id: "SL-3", severity: "blocker", outcome: "open, waived by the lead (second look): c.ts:3 P1 a blocker" }]);
  assert.deepEqual(secondLookRows([]), []);
});

// TOOLS-105, TOOLS-106 and the carried-reason gap of TOOLS-107.
test("a ticket's risk is read from its whole text (title, goal, Done when, an Orbit card's description), but not its Files list or the follow-ups kit pr adds later", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-risk3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "a"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  const risky = (name: string, text: string) => { writeFileSync(join(dir, name), text); return branchRisk({ root: dir, base: "main", ticket: name, settings: {} }); };
  // A card brief: no Goal heading, the risk sits in the description and its Done when line.
  const card = (body: string, title = "Tidy the saver") => `---\ntitle: ${title}\norbit: TOOLS-1\n---\n\nOrbit card TOOLS-1\n\n${body}`;
  assert.equal(risky("card1.md", card("Make the saver tidier.\nDone when:\n- no data loss under concurrent saves\n\n## Files\n- `src/ui/saver.ts`\n")).risky, true, "Done when");
  assert.equal(risky("card2.md", card("Next step (fleet): the saver can lose data when two saves race.\n\n## Files\n- `src/ui/saver.ts`\nDone when: it is tidy\n")).risky, true, "the description");
  assert.equal(risky("file.md", "---\ntitle: Tidy the saver\n---\n\n## Files\n- `src/ui/saver.ts`\n\n## Done when\n- the saver survives a race condition\n").risky, true, "a ticket file's Done when");
  assert.match(risky("card1.md", card("Done when:\n- no data loss\n")).reasons.join(), /text mentions "data loss"/);
  assert.equal(risky("calm.md", card("Make the saver tidier.\nDone when:\n- the button is blue\n\n## Files\n- `src/ui/saver.ts`\n")).risky, false);
  // The Files list is names, not words; and what kit pr writes under "## Done (date)" never counts.
  assert.equal(risky("files.md", card("Make it blue.\nDone when: blue\n\n## Files\n- the authentication note in docs\n")).risky, false);
  assert.equal(risky("plain.md", card("Make it blue.\nDone when: blue\n\n## Done\n\n### Follow-ups\n- a finding about authentication\n")).risky, false, "the builder's plain ## Done holds follow-ups too");
  assert.equal(risky("order.md", card("Make it tidy.\n\n## Files\n- `src/ui/saver.ts`\nDone when: no data loss\n")).risky, true, "a Done when line after the Files list still counts");
  assert.equal(risky("done.md", card("Make it blue.\nDone when: blue\n\n## Done (2026-11-09)\n\n### Follow-ups\n- a finding about authentication\n")).risky, false);
});

test("a lead's review answers the builder's rounds of the same branch (another owner's folder), and only that branch's", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-prev-owner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "a"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").stdout.trim();
  git("checkout", "-qb", "feature"); writeFileSync(join(dir, "a"), "2\n"); git("commit", "-qam", "work");
  const reviewed = git("rev-parse", "HEAD").stdout.trim();
  const reviews = join(dir, "reviews"), builder = join(reviews, "builder"), lead = join(reviews, "lead");
  mkdirSync(join(builder, "20261106T100000Z"), { recursive: true }); mkdirSync(lead, { recursive: true });
  const save = (branch: string | undefined) => {
    writeFileSync(join(builder, "20261106T100000Z", "refs.txt"), `${reviewed}\n${base}\n`);
    writeFileSync(join(builder, "20261106T100000Z", "findings.json"), JSON.stringify({ round: 2, ...(branch ? { branch } : {}), model: "m", head: reviewed, findings: withIds([finding("P1")], 2) }));
  };
  const options = (branch: string, others: string[]) => ({ head: reviewed, base, root: dir, branch, otherOwners: others });
  save("feature");
  const found = findPreviousReview(lead, options("feature", [builder]));
  assert.equal(found?.round, 2);
  assert.equal(found?.name, "../builder/20261106T100000Z", "named by a path that reviewChain can follow from the lead's folder");
  assert.equal(findPreviousReview(lead, options("feature", [])), null, "without other owners nothing changes");
  assert.equal(findPreviousReview(lead, options("another", [builder])), null, "another branch is never answered");
  save(undefined);
  assert.equal(findPreviousReview(lead, options("feature", [builder])), null, "another owner's review must name the branch");
  // The newest review of the branch answers, whichever owner saved it; on the same timestamp the owner's own wins.
  const saveAt = (folder: string, name: string, round: number) => {
    mkdirSync(join(folder, name), { recursive: true });
    writeFileSync(join(folder, name, "refs.txt"), `${reviewed}\n${base}\n`);
    writeFileSync(join(folder, name, "findings.json"), JSON.stringify({ round, branch: "feature", model: "m", head: reviewed, findings: withIds([finding("P1")], round) }));
  };
  save("feature");
  saveAt(lead, "20261105T100000Z", 1);
  assert.equal(findPreviousReview(lead, options("feature", [builder]))?.name, "../builder/20261106T100000Z", "the builder's is newer");
  saveAt(lead, "20261106T110000Z", 3);
  assert.equal(findPreviousReview(lead, options("feature", [builder]))?.name, "20261106T110000Z", "the lead's own is newer");
  saveAt(lead, "20261106T100000Z", 2);
  assert.equal(findPreviousReview(lead, options("feature", [builder]))?.name, "20261106T110000Z");
  rmSync(join(lead, "20261106T110000Z"), { recursive: true });
  assert.equal(findPreviousReview(lead, options("feature", [builder]))?.name, "20261106T100000Z", "on the same timestamp the owner's own wins");
  for (const name of ["20261105T100000Z", "20261106T100000Z"]) rmSync(join(lead, name), { recursive: true });
  // The chain follows the link out of the lead's own folder.
  save("feature");
  mkdirSync(join(lead, "20261107T100000Z"));
  writeFileSync(join(lead, "20261107T100000Z", "findings.json"), JSON.stringify({ round: 3, previous: found?.name, model: "m2", head: reviewed, findings: [] }));
  assert.deepEqual(reviewChain(join(lead, "20261107T100000Z")).map((record: { round: number }) => record.round), [2, 3]);
});

test("the PR line names every model the rounds used, in order, and says so when none is known", () => {
  const round = (model?: string) => ({ model, findings: [], marks: new Map() });
  assert.equal(modelsLine([round("a"), round("a")]), "a");
  assert.equal(modelsLine([round("a"), round("b"), round("a")]), "a and b");
  assert.equal(modelsLine([round("a"), round("b"), round("c")]), "a, b and c");
  assert.equal(modelsLine([round(), round()]), "unknown model");
  assert.equal(modelsLine([round(), round("b")]), "b");
  assert.equal(prLine({ rounds: 2, model: modelsLine([round("a"), round("b")]) }), "Reviewed with review-loop: 2 rounds with a and b. Verdict: approved");
});

test("a long reason on a \"still open\" mark is cut, so the brief line still holds the start of the original finding", () => {
  const [carried] = openFindings(marksReport(`R1-2: still open (P2): ${"because ".repeat(100)}`), earlier).findings;
  const section = loopBriefSection({ round: 2, limit: 3, previousHead: "a", currentHead: "b", open: [{ id: "R2-1", ...carried }] });
  assert.ok(section.includes("file.txt:4 — P2 fault: the retry loses the second write when the first fails."), "the original finding survives a long reason");
  assert.match(carried.text, /^R1-2 still open: (?:because ){10,}/, "the reason is still there, cut");
});

test("a card brief's risk stops at its \"### Review follow-ups\": review notes added later never raise the limit from 3 to 5", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-risk4-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main"); writeFileSync(join(dir, "a"), "1\n"); git("add", "."); git("commit", "-qm", "base");
  const risky = (name: string, text: string) => { writeFileSync(join(dir, name), text); return branchRisk({ root: dir, base: "main", ticket: name, settings: {} }); };
  const card = (body: string) => `---\ntitle: Tidy the saver\norbit: TOOLS-1\n---\n\nOrbit card TOOLS-1\n\nMake the saver tidier.\nDone when:\n- the button is blue\n${body}`;
  const notes = "\n### Review follow-ups\n\n- Spec (P3): P3: a cosmetic point about authentication, data loss and a race condition.\n";
  assert.equal(risky("calm.md", card(notes)).risky, false, "review notes under the brief never count");
  assert.equal(risky("both.md", card(`${notes}\n### UX follow-ups\n\n- UX (looks off): F-1 S1: a hint about security\n`)).risky, false);
  // What comes before the notes still counts, and so does a card with no notes.
  assert.equal(risky("before.md", `${card("")}- no data loss under concurrent saves\n${notes}`).risky, true, "the card's own Done when, above the notes");
  assert.equal(risky("none.md", card("- no data loss\n")).risky, true);
});

test("waiver: names by id anywhere in the text, or by a leading count; ids win; a bare reason names nothing", () => {
  const open = [{ id: "R1-1" }, { id: "R1-10" }, { id: "SL-1" }];
  assert.deepEqual(waiverCheck("R1-1 and SL-1: accepted", open), { mode: "ids", unnamed: [{ id: "R1-10" }] });
  assert.deepEqual(waiverCheck("accepted (r1-10, R1-1, SL-1)", open), { mode: "ids", unnamed: [] });
  // An id is a whole token: R1-1 is not named by R1-10, and SL-1 is not named by XSL-1.
  assert.deepEqual(waiverCheck("R1-10: accepted", [{ id: "R1-1" }, { id: "R1-10" }]), { mode: "ids", unnamed: [{ id: "R1-1" }] });
  assert.deepEqual(waiverCheck("XSL-1: accepted", [{ id: "SL-1" }]), { mode: "none", unnamed: [{ id: "SL-1" }] });
  assert.deepEqual(waiverCheck("3 findings: accepted", open), { mode: "count", count: 3, unnamed: [] });
  assert.deepEqual(waiverCheck("1 open finding: accepted", open), { mode: "count", count: 1, unnamed: [] });
  assert.deepEqual(waiverCheck("3 findings: R1-1 is the one", open), { mode: "ids", unnamed: [{ id: "R1-10" }, { id: "SL-1" }] });
  assert.equal(waiverCheck("accepted, there were 3 findings", open).mode, "none");
  assert.deepEqual(waiverCheck("Lex accepted it", open).unnamed, open);
  assert.deepEqual(waiverCheck(undefined, open).unnamed, open);
});

test("waiver: the refusal lists each finding with its id and severity, and says how to name them", () => {
  const open = [{ id: "R1-1", severity: "P2", text: "a.ts:1   P2 the first\ndefect" }, { id: "SL-1", severity: "", text: "b.ts:2 no severity" }];
  const text = waiverRefusal({ mode: "none", open });
  assert.match(text, /^The --waive reason does not name 2 open findings above P3:$/m);
  assert.match(text, /^- R1-1 \(P2\): a\.ts:1 P2 the first defect$/m);
  assert.match(text, /^- SL-1 \(no severity\): b\.ts:2 no severity$/m);
  assert.match(text, /Name each id in --waive, or start it with the number of findings/);
  assert.match(waiverRefusal({ mode: "ids", open: [open[0]] }), /^The --waive reason does not name 1 open finding above P3:$/m);
  assert.match(waiverRefusal({ mode: "count", count: 1, open }), /^The --waive reason says 1 finding, but 2 open findings above P3 would be waived:$/m);
  const many = Array.from({ length: 20 }, (_, index) => ({ id: `R1-${index + 1}`, severity: "P2", text: "x" }));
  assert.match(waiverRefusal({ mode: "none", open: many }), /^- … and 5 more$/m);
});
