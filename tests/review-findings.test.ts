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
