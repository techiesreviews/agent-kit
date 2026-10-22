import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterFixRounds, blockingFindings, completedFixRounds, openFindings } from "../scripts/agents/review-findings.mjs";

const review = (body: string) => `REVIEW_STATUS: complete\n\n${body}\n`;
const finding = (group: string, text: string, severity: string | null = null) => ({ group, text, severity });

// Inline fixtures adapted from dor-* reviews: separate groups (dor-01), em-dash groups
// and commit prefixes (dor-02, dor-14, dor-27), inline values (dor-13 and dor-27),
// and the validation-gap-only shape from ticket 06.
const variants = [
  {
    name: "Defects with separate Spec and Standards headings",
    open: "Defects:\nSpec:\n- Turn off can be undone.\nStandards:\n- Recheck the captured proof.\nValidation gaps:\n- Hold two consent responses.\nOptional nits: none.",
    none: "Defects:\nSpec:\n- none.\nStandards:\n- None found.\nValidation gaps:\n- none beyond existing coverage.\nOptional nits: none.",
    findings: [finding("Spec", "Turn off can be undone."), finding("Standards", "Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "em-dash headings without colons",
    open: "Defects — Spec\n- Turn off can be undone.\nDefects — Standards\n- Recheck the captured proof.\nValidation gaps\n- Hold two consent responses.\nOptional nits\n- Rename a variable.",
    none: "Defects — Spec\nnone.\nDefects — Standards\nNone.\nValidation gaps\nnone.\nOptional nits\nnone.",
    findings: [finding("Spec", "Turn off can be undone."), finding("Standards", "Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "bold em-dash headings with inline values",
    open: "**Defects — Spec:**\n- **8d5ac2b0:scripts/agents/durable-inventory.mjs:257 — P2:** The listing limit is too small.\n**Defects — Standards: none under CODING_STANDARDS.md.**\n**Validation gaps:** Add discovery tests.\n**Optional nits:** none.",
    none: "**Defects — Spec: None.**\n**Defects — Standards:**\n- **none.**\n**Validation gaps: none beyond existing coverage.**\n**Optional nits:** none.",
    findings: [finding("Spec", "8d5ac2b0:scripts/agents/durable-inventory.mjs:257 — P2: The listing limit is too small.", "P2"), finding("Validation gaps", "Add discovery tests.")],
  },
  {
    name: "one-line list groups",
    open: "Defects:\n- Spec: Turn off can be undone.\n- Standards: Recheck the captured proof.\nValidation gaps: Hold two consent responses.\nOptional nits: none.",
    none: "Defects:\n- Spec: none.\n- Standards: none. No applicable violations found.\nValidation gaps: none.\nOptional nits: none.",
    findings: [finding("Spec", "Turn off can be undone."), finding("Standards", "Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "one-line plain groups",
    open: "Defects:\nSpec: Turn off can be undone.\nStandards: Recheck the captured proof.\nValidation gaps: Hold two consent responses.\nOptional nits: none.",
    none: "Defects:\nSpec: none.\nStandards: None.\nValidation gaps: none beyond existing coverage.\nOptional nits: None.",
    findings: [finding("Spec", "Turn off can be undone."), finding("Standards", "Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "bold items and multiline commit prefixes",
    open: "Defects:\n**Spec:**\n- **340290b7:src/agent-transport.ts:173 — P1:** Live transport admits receiptless mutations.\n  A delayed mutation can apply after takeover.\n\n  Fix: route mutations through fenced commits.\n- `4d43ef1d:src/components/agent-menu.ts:529` — **P2**: The allowance accepts old grants.\n**Standards:**\n- **none.**\nValidation gaps: none.\nOptional nits: none.",
    none: "Defects:\n**Spec:**\n- **NONE found.**\n  The change satisfies the contract.\n**Standards:**\n- **none.**\nValidation gaps: **None beyond the existing tests.**\nOptional nits: none.",
    findings: [finding("Spec", "340290b7:src/agent-transport.ts:173 — P1: Live transport admits receiptless mutations. A delayed mutation can apply after takeover. Fix: route mutations through fenced commits.", "P1"), finding("Spec", "`4d43ef1d:src/components/agent-menu.ts:529` — P2: The allowance accepts old grants.", "P2")],
  },
];

for (const variant of variants) {
  test(`${variant.name}: open`, () => {
    assert.deepEqual(openFindings(review(variant.open)), { findings: variant.findings, readable: true });
  });
  test(`${variant.name}: none`, () => {
    assert.deepEqual(openFindings(review(variant.none)), { findings: [], readable: true });
  });
}

test("nits alone never count, including group-like labels inside the nits", () => {
  assert.deepEqual(openFindings(review("Defects:\n- Spec: none.\n- Standards: none.\nValidation gaps: none.\nOptional nits:\n- Rename a variable.\n- Spec: improve the wording.\n- Standards: prefer another name.")), { findings: [], readable: true });
});

test("validation-gap-only review counts as one finding (ticket 06)", () => {
  const text = "Add an intake test where the stream exceeds its declared Content-Length. Assert cancellation and immediate reservation reuse.";
  assert.deepEqual(openFindings(review(`Defects:\n- Spec: none found.\n- Standards: none.\nValidation gaps: ${text}\nOptional nits: none.`)), {
    findings: [finding("Validation gaps", text)], readable: true,
  });
});

test("Markdown headings and nested group lists keep multiline findings together", () => {
  assert.deepEqual(openFindings(review("## Defects:\n- **Spec:**\n  - First defect.\n    - Supporting evidence.\n  - Second defect.\n- **Standards:** none.\n## Validation gaps: none.\n## Optional nits: none.")), {
    findings: [finding("Spec", "First defect. Supporting evidence."), finding("Spec", "Second defect.")], readable: true,
  });
});

test("ungrouped defects still count", () => {
  assert.deepEqual(openFindings(review("Defects:\n- A defect.\nValidation gaps: none.\nOptional nits: none.")), {
    findings: [finding("Defects", "A defect.")], readable: true,
  });
});

test("missing completion marker or Defects heading fails closed with one finding", () => {
  for (const text of ["", "Defects:\nSpec: none.", "REVIEW_STATUS: incomplete\nDefects:\n- A defect.",
    "REVIEW_STATUS: complete\nValidation gaps: none.\nOptional nits: none.", "REVIEW_STATUS: complete\nThe Defects: section is missing."]) {
    assert.deepEqual(openFindings(text), { findings: [finding("Review", "review format unreadable")], readable: false });
  }
});

for (const severity of ["P0", "P1", "P2", "P3"]) {
  for (const token of [`${severity}:`, `${severity} —`, `**${severity}**`, `(${severity})`, `[${severity}]`, `Severity: ${severity}`, `severity ${severity.toLowerCase()}`]) {
    for (const prefix of ["", "abcd123:file.ts:3 — "]) test(`severity parses ${prefix}${token}`, () => {
      const { findings } = openFindings(review(`Defects: ${prefix}${token} defect\nValidation gaps: none.`));
      assert.equal(findings[0].severity, severity);
    });
  }
}

test("severity uses the first token within 80 characters; gaps never carry severity", () => {
  const { findings } = openFindings(review(`Defects:\n- P2: defect mentioning P1\n- ${"x".repeat(80)} P1 late severity\n- P4: unknown severity\nValidation gaps: P1 missing coverage`));
  assert.deepEqual(findings.map(item => item.severity), ["P2", null, null, null]);
});

test("blocking findings fail closed for defects and unreadable reviews, excluding minor defects and gaps", () => {
  for (const group of ["Spec", "Standards", "Defects"]) for (const severity of ["P0", "P1", "P2", "P3", null]) {
    const item = finding(group, "defect", severity);
    assert.deepEqual(blockingFindings([item]), ["P2", "P3"].includes(severity!) ? [] : [item]);
  }
  assert.deepEqual(blockingFindings(openFindings(review("Defects: none.\nValidation gaps: Add coverage.")).findings), []);
  assert.deepEqual(blockingFindings(openFindings("").findings), [finding("Review", "review format unreadable")]);
  assert.equal(afterFixRounds(2), false);
  assert.equal(afterFixRounds(3), true);
  assert.equal(afterFixRounds(4), true);
});

test("completed rounds count only round files and exclude the pending round", t => {
  const dir = mkdtempSync(join(tmpdir(), "review-rounds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(completedFixRounds(join(dir, "missing")), 0);
  for (const name of ["round-1.md", "round-2.md", "round-3.md", "round-4-review.log", "other.md"]) writeFileSync(join(dir, name), "round");
  mkdirSync(join(dir, "round-4.md"));
  assert.equal(completedFixRounds(dir), 3);
  writeFileSync(join(dir, "pending.json"), JSON.stringify({ round: 3 }));
  assert.equal(completedFixRounds(dir), 2);
  assert.equal(completedFixRounds(join(dir, "missing"), dir), 2);
});


test("round-2 top-level Spec/Standards review parses the P1 defect and validation gap", () => {
  const defect = 'cd95c9e0:scripts/agents/kit.d/pr:270 — P1: `commitBuilderWork` stages everything with `git add -A`. If another process edits a non-ticket file while staging is held, branch/HEAD checks still pass and that edit is committed. The coverage check at line 272 rejects it only after the branch advances. This violates CODING_STANDARDS.md, “Async writers”: preserve expected sources/files and recheck before writes. Use a ticket-only index and validate the commit’s paths before publishing the branch update.';
  const gap = 'Add a regression that holds staging, edits a non-ticket file without moving HEAD, then releases staging. Assert that the unrelated edit remains uncommitted and no commit containing it is published locally or remotely.';
  const body = `Spec: none.\n\nStandards:\n\n- ${defect}\n\nValidation gaps: ${gap}\n\nOptional nits: none.`;
  assert.deepEqual(openFindings(review(body)), { findings: [finding("Standards", defect, "P1"), finding("Validation gaps", gap)], readable: true });
  assert.deepEqual(openFindings(body), { findings: [finding("Review", "review format unreadable")], readable: false });
});

test("implicit defect groups keep optional nits separate and accept a lone top-level group", () => {
  for (const group of ["Spec", "Standards"]) {
    assert.deepEqual(openFindings(review(`${group}: P2: Minor defect.\nValidation gaps: none.`)), { findings: [finding(group, "P2: Minor defect.", "P2")], readable: true });
  }
  assert.deepEqual(openFindings(review("Spec: none.\nStandards: none.\nValidation gaps: none.\nOptional nits:\n- Spec: Style suggestion.\nStandards: Another nit.")), { findings: [], readable: true });
});

test("severity is read after a long ticket-path location", () => {
  const ticket = `${"segment/".repeat(20)}ticket.md`;
  assert.ok(ticket.length > 150);
  const { findings } = openFindings(review(`Defects:\nSpec:\n- abcd1234:${ticket}:42-44 — P2: The listing limit is too small.`));
  assert.deepEqual(findings, [finding("Spec", `abcd1234:${ticket}:42-44 — P2: The listing limit is too small.`, "P2")]);
});

test("parenthesised and bold severities after a location read", () => {
  const { findings } = openFindings(review("Defects:\nSpec:\n- abcd1234:src/thing.ts:10 — (P1) Wrapped severity.\n- abcd1234:src/thing.ts:20 — **P3** Bold severity."));
  assert.deepEqual(findings.map(item => item.severity), ["P1", "P3"]);
});

test("a severity token only inside far-off evidence is not the finding's severity", () => {
  const text = `abcd1234:src/thing.ts:10 — ${"evidence ".repeat(8)}mentions P2 late.`;
  const { findings } = openFindings(review(`Defects:\nSpec:\n- ${text}`));
  assert.deepEqual(findings, [finding("Spec", text, null)]);
});

test("Spec defects and Standards defects headings open their groups with location severities", () => {
  assert.deepEqual(openFindings(review("Spec defects:\n- abcd1234:src/thing.ts:10 — P1: First defect.\n- abcd1234:src/thing.ts:20 — P2: Second defect.\nValidation gaps: none.")), {
    findings: [finding("Spec", "abcd1234:src/thing.ts:10 — P1: First defect.", "P1"), finding("Spec", "abcd1234:src/thing.ts:20 — P2: Second defect.", "P2")], readable: true,
  });
  assert.deepEqual(openFindings(review("## Standards defects\n- abcd1234:src/thing.ts:10 — P3: Minor standards issue.\nValidation gaps: none.")), {
    findings: [finding("Standards", "abcd1234:src/thing.ts:10 — P3: Minor standards issue.", "P3")], readable: true,
  });
  assert.deepEqual(openFindings(review("**Standards defects:**\n- abcd1234:src/thing.ts:10 — P1: Standards defect.\n\n**Spec defects: none.**\n**Validation gaps:** none.")), {
    findings: [finding("Standards", "abcd1234:src/thing.ts:10 — P1: Standards defect.", "P1")], readable: true,
  });
});

test("Spec defects and Standards defects headings keep Validation gaps plain text", () => {
  assert.deepEqual(openFindings(review("Spec defects:\n- abcd1234:src/a.ts:1 — P2: The defect.\nValidation gaps:\nStandards: add a test.")), {
    findings: [finding("Spec", "abcd1234:src/a.ts:1 — P2: The defect.", "P2"), finding("Validation gaps", "Standards: add a test.")], readable: true,
  });
  assert.deepEqual(openFindings(review("Standards defects:\n- abcd1234:src/a.ts:1 — P1: The defect.\nValidation gaps:\nSpec: add a test.")), {
    findings: [finding("Standards", "abcd1234:src/a.ts:1 — P1: The defect.", "P1"), finding("Validation gaps", "Spec: add a test.")], readable: true,
  });
});

test("a bare Spec defects heading opens the Spec group", () => {
  assert.deepEqual(openFindings(review("Spec defects\n- abcd1234:src/thing.ts:10 — P1: First defect.\nValidation gaps: none.")), {
    findings: [finding("Spec", "abcd1234:src/thing.ts:10 — P1: First defect.", "P1")], readable: true,
  });
});

test("a sha-less long ticket-path location reads severity, with or without backticks", () => {
  const ticket = `${"segment/".repeat(20)}ticket.md`;
  assert.ok(ticket.length > 150);
  const text = `${ticket}:12 — P1: The listing limit is too small.`;
  assert.deepEqual(openFindings(review(`Spec defects:\n- ${text}`)).findings, [finding("Spec", text, "P1")]);
  const quoted = `\`${ticket}:12\` — P1: The listing limit is too small.`;
  assert.deepEqual(openFindings(review(`Spec defects:\n- ${quoted}`)).findings, [finding("Spec", quoted, "P1")]);
});

test("severity: the 40-character window after a location", () => {
  const read = (text: string) => openFindings(review(`Defects: ${text}\nValidation gaps: none.`)).findings[0].severity;
  assert.equal(read(`abcd123:a.ts:1 — ${"x".repeat(37)} P1`), "P1");
  // Past the 40-character window the first-80-characters rule still applies; beyond both, no severity.
  assert.equal(read(`abcd123:a.ts:1 — ${"x".repeat(41)} P1`), "P1");
  assert.equal(read(`abcd123:a.ts:1 — ${"x".repeat(70)} P1`), null);
  // A long location puts the 80-character fallback out of reach, so only the window decides.
  const path = `${"segment/".repeat(7)}ticket.md`;
  assert.ok(path.length >= 60);
  assert.equal(read(`abcd123:${path}:1 — ${"x".repeat(35)} P1`), "P1");
  assert.equal(read(`abcd123:${path}:1 — ${"x".repeat(45)} P1`), null);
});

test("severity: a P-token far after a long ticket-path location does not count", () => {
  const ticket = `${"segment/".repeat(20)}ticket.md`;
  assert.ok(ticket.length > 150);
  const text = `abcd1234:${ticket}:42 — evidence ${"words ".repeat(8)}mentions P2 late.`;
  assert.deepEqual(openFindings(review(`Defects:\nSpec:\n- ${text}`)).findings, [finding("Spec", text, null)]);
});

test("severity: a long-path location followed directly by the severity", () => {
  const ticket = `${"segment/".repeat(20)}ticket.md`;
  const read = (text: string) => openFindings(review(`Defects: ${text}\nValidation gaps: none.`)).findings[0].severity;
  assert.equal(read(`abcd1234:${ticket}:12 (P1) evidence`), "P1");
  assert.equal(read(`\`${ticket}:12\` **P2** evidence`), "P2");
});

test("severity: locations the pattern reads only in part still find a nearby severity", () => {
  const read = (text: string) => openFindings(review(`Defects: ${text}\nValidation gaps: none.`)).findings[0].severity;
  assert.equal(read("src/a.ts:10:5 — P1: evidence"), "P1");
  assert.equal(read("[src/a.ts:10](src/a.ts#L10) — P1: evidence"), "P1");
});

test("severity: a finding naming two locations keeps the 80-character rule", () => {
  const { findings } = openFindings(review("Defects: abcd123:src/a.ts:3, abcd123:src/controllers/save-controller.ts:88 — P1: evidence\nValidation gaps: none."));
  assert.equal(findings[0].severity, "P1");
});

test("Spec defects / Standards defects as bullets in nits or gaps stay plain text", () => {
  const nits = openFindings(review("Defects: none\nValidation gaps: none.\nOptional nits:\n- Spec defects: wording could be tighter"));
  assert.deepEqual(nits.findings, []);
  const gaps = openFindings(review("Defects: none\nValidation gaps:\n- Standards defects: add a race test"));
  assert.equal(gaps.findings.length, 1);
  assert.equal(gaps.findings[0].group, "Validation gaps");
  assert.equal(gaps.findings[0].severity, null);
});

test("implicit Spec/Standards groups stay readable beside a bulleted Spec defects line", () => {
  assert.deepEqual(openFindings(review("Spec:\n- abcd123:a.ts:1 — P1: evidence\nStandards: none\nValidation gaps:\n- Spec defects: wording could be tighter")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: evidence", "P1"), finding("Validation gaps", "Spec defects: wording could be tighter")], readable: true,
  });
});

test("unbulleted Spec defects / Standards defects in nits or gaps stay plain text", () => {
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps: none.\nOptional nits:\nSpec defects: tighter wording")), { findings: [], readable: true });
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps:\nStandards defects: add a race test")), {
    findings: [finding("Validation gaps", "Standards defects: add a race test")], readable: true,
  });
  assert.deepEqual(openFindings(review("Spec:\n- abcd123:a.ts:1 — P1: evidence\nStandards: none\nValidation gaps: none\nOptional nits:\nSpec defects: none")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: evidence", "P1")], readable: true,
  });
});

test("a top-level Spec group before a Standards defects heading keeps its defect", () => {
  assert.deepEqual(openFindings(review("Spec:\n- abcd123:a.ts:1 — P1: x\nStandards defects: none\nValidation gaps: none.")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: x", "P1")], readable: true,
  });
});

test("a Spec defects heading only after the notes opens its group and blocks", () => {
  const { findings } = openFindings(review("Validation gaps: none.\nSpec defects:\n- abcd123:a.ts:1 — P1: x"));
  assert.deepEqual(findings, [finding("Spec", "abcd123:a.ts:1 — P1: x", "P1")]);
  assert.deepEqual(blockingFindings(findings), findings);
});

test("a bulleted Defects heading still keeps Validation gaps plain text", () => {
  assert.deepEqual(openFindings(review("- Defects:\n  - abc1234:a.ts:1 — P2: x\nValidation gaps:\nStandards: add a test.")), {
    findings: [finding("Defects", "abc1234:a.ts:1 — P2: x", "P2"), finding("Validation gaps", "Standards: add a test.")], readable: true,
  });
});

test("bulleted Spec defects / Standards defects before any notes section open their groups", () => {
  assert.deepEqual(openFindings(review("- Spec defects:\n  - abcd123:a.ts:1 — P1: evidence\n- Standards defects: none\nValidation gaps:\nStandards: add a test.")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: evidence", "P1"), finding("Validation gaps", "Standards: add a test.")], readable: true,
  });
});

test("a P-token in evidence within 80 characters after a short location counts (lead decision)", () => {
  const { findings } = openFindings(review("Defects: abcd123:a.ts:1 — evidence mentions P2 here\nValidation gaps: none."));
  assert.equal(findings[0].severity, "P2");
});

// Trimmed from the four real reviews of 2026-10-22 that blocked kit pr (PRs #125, #127, #128, #126).
const sf11 = review([
  "Defects:", "Spec: none", "Standards: none", "",
  "How each \"Done when\" item and decided behaviour holds:",
  "- **`builderAuthor` mapping** (`scripts/agents/kit-lib.mjs:176-184`) matches the decided behaviour:",
  "  - `gpt-6.1-sol` becomes `GPT-6.1-Sol`.",
  "  - Any other id falls through unchanged to its old vendor rule.",
  "- **Build credit after a switch** (`scripts/agents/kit.d/slice:204,213`): `buildModel` is saved before the build agent runs.",
  "- **CODING_STANDARDS.md:** only \"Test fixtures\" applies.", "",
  "Validation gaps:",
  "- **Mixed-case aliases are untested.** Add `assert.equal(builderAuthor(\"OPUS\"), \"Claude Opus <noreply@anthropic.com>\")`.", "",
  "Optional nits:",
  "- **`opus[1m]` keeps its raw id.** The ticket only names bare aliases, so this is within spec.",
].join("\n"));

const sf12Defect = "9f63b8f0:scripts/agents/kit.d/review:112 — P2: `kit review` now gives the budget slot back when the first call is refused outright. The operator docs say the opposite.";
const sf12Stale = "e907d9ed:docs/wayfinder/software-factory/build/tickets/12-grok-and-agent-small-fixes.md:46 — P3: The Done section is stale after review rounds 1-3:";
const sf12 = review([
  "Defects", "", "Spec",
  `- ${sf12Defect}`,
  `- ${sf12Stale}`,
  "  - \"Commits\" names only 9f63b8f0, 5c84d8a9 and \"this branch's correction commit\", but there are four correction commits.",
  "  - The `50/50 (2 files)` count comes before tests added in later rounds.",
  "  ",
  "  Fix: list all six commits.", "",
  "Standards",
  "- none. The diff touches only agent runner scripts, node:test files and a ticket.", "",
  "Validation gaps",
  "- The `refusedOutright` Codex cases use a made-up header.",
  "- No test covers a refusal recorded in `status.json` and then resumed.", "",
  "Optional nits",
  "- `scripts/agents/agent-run.mjs:579`: the non-Grok branch could be a short guard.",
].join("\n"));

const lead92 = review([
  "Defects", "", "Spec",
  "- None. I checked the change against every \"Done when\" item in ticket 92:",
  "  - The Done section records the 1,000-tile measurement.",
  "  - There is no `main.ts` change.",
  "- Every way the byte cache lets go of a file is covered, so a kept tile never keeps an old picture:",
  "  - Replace (`media-library-replace.ts:129`) clears through the view's wrapper.", "",
  "Standards",
  "- None.",
  "  - Async writers (\"Proofs survive awaits\"): the new `cache.drop` loop re-checks the proof.",
  "  - Test fixtures: the new fakes use `satisfies`.", "",
  "Validation gaps",
  "- An online video tile in the picker repainting its choice in place is not tested.",
  "- Focus coming back to a rebuilt tile is not tested on the new keyed path.", "",
  "Optional nits",
  "- `src/page-builder/media-library-grid.ts:35`: the `stamp` comment overstates what changes it.",
].join("\n"));

const sf10Defect = "d8da9353:scripts/agents/review-findings.mjs:74 — P2: A defects label that comes after the notes now fails open where it used to fail closed.";
const sf10 = review([
  "Defects", "", "Spec:",
  `- ${sf10Defect}`, "",
  "Standards:",
  "- none. CODING_STANDARDS.md has rules for controllers, async writers, racing reads, test fixtures and browser specs.", "",
  "Validation gaps",
  "- Add a test that pins what happens to a defects heading after the notes.",
  "- Add a test for a bulleted bare group inside a defects-label section.", "",
  "Optional nits",
  "- scripts/agents/review-findings.mjs:81: the label check repeats `defectsLabel`.",
].join("\n"));

test("real reviews: notes under a none group never count as findings", () => {
  assert.deepEqual(openFindings(sf11), {
    findings: [finding("Validation gaps", "Mixed-case aliases are untested. Add `assert.equal(builderAuthor(\"OPUS\"), \"Claude Opus <noreply@anthropic.com>\")`.")], readable: true,
  });
  assert.deepEqual(openFindings(lead92), {
    findings: [finding("Validation gaps", "An online video tile in the picker repainting its choice in place is not tested."),
      finding("Validation gaps", "Focus coming back to a rebuilt tile is not tested on the new keyed path.")], readable: true,
  });
  for (const text of [sf11, lead92]) assert.deepEqual(blockingFindings(openFindings(text).findings), []);
});

test("real reviews: indented sub-bullets belong to the finding above them", () => {
  assert.deepEqual(openFindings(sf12), {
    findings: [
      finding("Spec", sf12Defect, "P2"),
      finding("Spec", `${sf12Stale} "Commits" names only 9f63b8f0, 5c84d8a9 and "this branch's correction commit", but there are four correction commits. The \`50/50 (2 files)\` count comes before tests added in later rounds. Fix: list all six commits.`, "P3"),
      finding("Validation gaps", "The `refusedOutright` Codex cases use a made-up header."),
      finding("Validation gaps", "No test covers a refusal recorded in `status.json` and then resumed."),
    ], readable: true,
  });
  assert.deepEqual(openFindings(sf10), {
    findings: [finding("Spec", sf10Defect, "P2"),
      finding("Validation gaps", "Add a test that pins what happens to a defects heading after the notes."),
      finding("Validation gaps", "Add a test for a bulleted bare group inside a defects-label section.")], readable: true,
  });
  for (const text of [sf12, sf10]) assert.deepEqual(blockingFindings(openFindings(text).findings), []);
});

test("a none group with a sentence holds notes in any case, plain or bulleted", () => {
  for (const body of ["Spec: None. I checked every item.\n- First note.\n  - Detail.\nStandards: NONE\nPlain note line.\n- Another note.",
    "Defects:\n- **Spec:**\n  - none found.\n    - A note.\n  - A second note.\n- **Standards:** None — the rules do not apply.\n  - A note."]) {
    assert.deepEqual(openFindings(review(`${body}\nValidation gaps: none.\nOptional nits: none.`)), { findings: [], readable: true });
  }
});

test("a real P1 after none notes in a later group still blocks", () => {
  for (const body of ["Spec: None. I checked every item.\n- A note.\n  - Detail.\nStandards:\n- abcd123:a.ts:1 — P1: Real fault.",
    "Defects\n\nSpec\n- None. I checked every item:\n  - A note.\n- Another note.\n\nStandards\n- abcd123:a.ts:1 — P1: Real fault."]) {
    const { findings } = openFindings(review(`${body}\nValidation gaps: none.`));
    assert.deepEqual(findings, [finding("Standards", "abcd123:a.ts:1 — P1: Real fault.", "P1")]);
    assert.deepEqual(blockingFindings(findings), findings);
  }
});

test("a defects heading after an earlier one and the notes reopens its group (slice 10 follow-up)", () => {
  for (const heading of ["Standards defects:", "Standards defects", "## Standards defects", "**Standards defects:**"]) {
    const { findings } = openFindings(review(`Spec defects: none\nValidation gaps: none\n${heading}\n- a.ts:1 — P1: real fault`));
    assert.deepEqual(findings, [finding("Standards", "a.ts:1 — P1: real fault", "P1")]);
    assert.deepEqual(blockingFindings(findings), findings);
  }
});

test("a bulleted bare group inside a defects-label section stays in that group (slice 10 follow-up)", () => {
  assert.deepEqual(openFindings(review("Spec defects:\n- Standards: a.ts:1 — P1: x\nValidation gaps: none.")), {
    findings: [finding("Spec", "Standards: a.ts:1 — P1: x", "P1")], readable: true,
  });
  // An unbulleted bare group still switches, as before.
  assert.deepEqual(openFindings(review("Spec defects:\n- a.ts:1 — P1: x\nStandards:\n- b.ts:2 — P2: y\nValidation gaps: none.")), {
    findings: [finding("Spec", "a.ts:1 — P1: x", "P1"), finding("Standards", "b.ts:2 — P2: y", "P2")], readable: true,
  });
});

test("a bulleted bare group after none notes in a defects-label section opens its group", () => {
  const { findings } = openFindings(review("Spec defects:\n- None.\n- Standards: a.ts:1 — P1: x\nValidation gaps: none."));
  assert.deepEqual(findings, [finding("Standards", "a.ts:1 — P1: x", "P1")]);
  assert.deepEqual(blockingFindings(findings), findings);
});

test("a late inline defects label opens its group when bold or carrying a severity; plain text stays a gap", () => {
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps:\n**Standards defects:** add a race test")).findings,
    [finding("Standards", "add a race test")]);
  for (const notes of ["Validation gaps: none.", "Validation gaps: none.\nOptional nits:"]) {
    const { findings } = openFindings(review(`Defects: none\n${notes}\nStandards defects: a.ts:1 — P1: x`));
    assert.deepEqual(findings, [finding("Standards", "a.ts:1 — P1: x", "P1")]);
    assert.deepEqual(blockingFindings(findings), findings);
  }
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps:\nStandards defects: add a race test")).findings,
    [finding("Validation gaps", "Standards defects: add a race test")]);
});

test("bullets under a none Validation gaps group are notes, not gaps", () => {
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps: none.\n- Add a race test.")), { findings: [], readable: true });
});
