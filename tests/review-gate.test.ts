import assert from "node:assert/strict";
import test from "node:test";
import { findingsWord, reviewGate, shortText } from "../review-gate.mjs";

interface Finding { group: string; severity: string | null; text: string }
const blocker = (text: string): Finding => ({ group: "Correctness", severity: "P1", text });
const should = (text: string): Finding => ({ group: "Correctness", severity: "P2", text });
const nit = (text: string): Finding => ({ group: "Style", severity: "P3", text });
// One review record of Claude's: its ids R<round>-<n>, the model, and what the builder declined.
const record = (round: number, findings: Finding[], { declined = [] as { text: string; reason: string }[], model = "claude-opus-5-5" } = {}) =>
  ({ head: `head${round}`, model, marks: new Map(), declined, findings: findings.map((item, index) => ({ ...item, id: `R${round}-${index + 1}` })) });
const gate = (options: { waives?: string[]; risky?: boolean; seen?: string[]; reviewedHeads?: number } = {}) => {
  const made = reviewGate({ waives: options.waives ?? [], risky: options.risky ?? false, seen: new Set(options.seen ?? []), reviewedHeads: options.reviewedHeads ?? 0 });
  made.newHead();
  return made;
};

test("a clean review passes with nothing said, and the verdict is approved with the review's own ledger", () => {
  const g = gate();
  const chain = [record(1, [])];
  assert.deepEqual(g.weigh({ second: false, findings: [], chain, rounds: () => 0 }), { lines: [], refusal: null, rest: [], relaxed: false });
  const verdict = g.verdict({ review: true, tier: "full", base: "dev" });
  assert.match(verdict.line, /^Reviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: approved$/);
  assert.match(verdict.block, /^<!-- review-loop -->\nReviewed with review-loop: 1 round with claude-opus-5-5\. Verdict: approved\n\n/);
  assert.match(verdict.block, /<!-- \/review-loop -->$/);
});

test("a blocker with no waiver stops the landing; nits alone go to follow-ups", () => {
  const g = gate();
  const findings = [nit("tidy the name"), blocker("drops the lock")];
  const weighed = g.weigh({ second: false, findings, chain: [record(1, findings)], rounds: () => 1 });
  assert.deepEqual(weighed.lines, ["Correctness: drops the lock", "Style: tidy the name"]);
  assert.deepEqual(weighed.refusal, { why: "has 1 open findings" });
  const nits = gate().weigh({ second: false, findings: [nit("a")], chain: [record(1, [nit("a")])], rounds: () => 1 });
  assert.equal(nits.refusal, null);
  assert.deepEqual(nits.rest, [nit("a")]);
});

test("a waiver passes only the findings it names; one it leaves out is refused by id", () => {
  const findings = [blocker("drops the lock"), should("no test")];
  const chain = [record(1, findings)];
  const named = gate({ waives: ["R1-1, R1-2: known"] });
  assert.equal(named.weigh({ second: false, findings, chain, rounds: () => 1 }).refusal, null);
  assert.equal(named.waived, 2);
  const partial = gate({ waives: ["R1-1: known"] }).weigh({ second: false, findings, chain, rounds: () => 1 });
  assert.deepEqual(partial.refusal, { why: "has 1 open finding the waiver does not name" });
  assert.match(partial.lines.at(-1) ?? "", /^The --waive reason does not name 1 open finding above P3:\n- R1-2 \(P2\): no test\n/);
});

test("a finding carried into a later round is waived by the id it first had", () => {
  const findings = [blocker("R1-1 still open")];
  const chain = [record(1, [blocker("drops the lock")]), record(2, findings)];
  const g = gate({ waives: ["R1-1: known"] });
  assert.equal(g.weigh({ second: false, findings, chain, rounds: () => 1 }).refusal, null);
  assert.equal(g.waived, 1);
});

test("a count waiver is checked over both looks together, once they have run", () => {
  const findings = [blocker("drops the lock")];
  const g = gate({ waives: ["1 finding: known"] });
  assert.equal(g.weigh({ second: false, findings, chain: [record(1, findings)], rounds: () => 1 }).refusal, null);
  assert.equal(g.finalWaiver(), null);
  const second = [blocker("races the writer")];
  // The second look's finding makes two against a count of one: refused before anything lands.
  assert.deepEqual(g.weigh({ second: true, findings: second, chain: [], rounds: () => { throw new Error("rounds are worked out once"); } }).refusal,
    { why: "has more open findings than the waiver counts" });
  const short = gate({ waives: ["2 findings: known"] });
  short.weigh({ second: false, findings, chain: [record(1, findings)], rounds: () => 1 });
  const final = short.finalWaiver();
  assert.equal(final?.why, "the waiver does not match the 1 open finding it would let through");
  assert.match(final?.text ?? "", /^The --waive reason says 2 findings, but 1 open finding above P3 would be waived:/);
});

test("at a head a rebase brought, a finding the lead never saw is refused even when the waiver names it", () => {
  const findings = [blocker("drops the lock")];
  const chain = [record(1, findings)];
  const fresh = gate({ waives: ["R1-1: known"], reviewedHeads: 1 });
  assert.deepEqual(fresh.weigh({ second: false, findings, chain, rounds: () => 1 }).refusal, { why: "has 1 open finding that is new at the new head" });
  const seen = gate({ waives: ["R1-1: known"], reviewedHeads: 1, seen: ["R1-1\ndrops the lock"] });
  assert.equal(seen.weigh({ second: false, findings, chain, rounds: () => 1 }).refusal, null);
  // A review reused from before the run is what the lead saw.
  assert.equal(gate({ waives: ["R1-1: known"], reviewedHeads: 1 }).weigh({ second: false, findings, chain, rounds: () => 1, saved: true }).refusal, null);
});

test("out of budget, a should is a follow-up for Lex: reported, never approved", () => {
  const g = gate();
  const findings = [should("no test")];
  const chain = [record(1, findings, { declined: [{ text: "rename it", reason: "out of scope" }] })];
  const weighed = g.weigh({ second: false, findings, chain, rounds: () => 3 });
  assert.equal(weighed.refusal, null);
  assert.equal(weighed.relaxed, true);
  assert.match(weighed.lines[1], /^Review budget used: 3 of 3 fix rounds, 1 open finding\./);
  assert.match(weighed.lines[1], /Builder's side \(declined, with reasons\):\n- rename it — reason: out of scope/);
  assert.match(g.verdict({ review: true, tier: "full", base: "dev" }).line, /Verdict: not approved \(budget used, 1 open finding left for Lex\)$/);
});

test("the verdict says what the review did when there was none to make", () => {
  const nothing = gate();
  nothing.nothingToReview();
  assert.deepEqual(nothing.verdict({ review: true, tier: "full", base: "dev" }), {
    line: "Review: nothing to review (the diff against dev is empty).",
    block: "<!-- review-loop -->\nReview: nothing to review (the diff against dev is empty).\n<!-- /review-loop -->" });
  const docs = gate();
  docs.secondLookModel("gpt-6.1-sol");
  docs.weigh({ second: true, findings: [], chain: [], rounds: () => 0 });
  assert.match(docs.verdict({ review: false, tier: "docs", base: "dev" }).block,
    /^<!-- review-loop -->\nReview: Claude's review skipped \(docs tier\)\.\n\nSecond look by gpt-6\.1-sol \(.+\)\.\n<!-- \/review-loop -->$/);
  const skipped = gate();
  skipped.secondLookSkipped("second look: skipped (no model)");
  assert.match(skipped.verdict({ review: false, tier: "docs", base: "dev" }).line, /^Review: Claude's review skipped \(docs tier\)\.$/);
  assert.equal(gate().verdict({ review: false, tier: "docs", base: "dev" }), null);
});

test("a new head starts the weighing over but keeps what the lead has seen", () => {
  const findings = [blocker("drops the lock")];
  const g = gate({ waives: ["R1-1: known"] });
  g.weigh({ second: false, findings, chain: [record(1, findings)], rounds: () => 1 });
  g.newHead();
  assert.equal(g.waived, 0);
  assert.equal(g.weigh({ second: false, findings, chain: [record(1, findings)], rounds: () => 1 }).refusal, null);
});

test("the short finding text and the findings word", () => {
  assert.equal(findingsWord(1), "1 open finding");
  assert.equal(findingsWord(2), "2 open findings");
  assert.equal(shortText("short"), "short");
  assert.equal(shortText(`${"é".repeat(170)}`), `${"é".repeat(160)}…`);
});
