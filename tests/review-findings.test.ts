import assert from "node:assert/strict";
import test from "node:test";
import { openFindings } from "../scripts/agents/review-findings.mjs";

const review = (body: string) => `REVIEW_STATUS: complete\n\n${body}\n`;
const finding = (group: string, text: string) => ({ group, text });

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
    findings: [finding("Spec", "8d5ac2b0:scripts/agents/durable-inventory.mjs:257 — P2: The listing limit is too small."), finding("Validation gaps", "Add discovery tests.")],
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
    findings: [finding("Spec", "340290b7:src/agent-transport.ts:173 — P1: Live transport admits receiptless mutations. A delayed mutation can apply after takeover. Fix: route mutations through fenced commits."), finding("Spec", "`4d43ef1d:src/components/agent-menu.ts:529` — P2: The allowance accepts old grants.")],
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
