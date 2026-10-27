import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterFixRounds, blockingFindings, completedFixRounds, countsLine, findingsRecord, openFindings } from "../scripts/agents/review-findings.mjs";

const review = (body: string) => `REVIEW_STATUS: complete\n\n${body}\n`;
const finding = (group: string, text: string, severity: string | null = null, kind: string | null = group === "Validation gaps" ? null : "unsorted") =>
  ({ group, text, severity, kind });

// Inline fixtures adapted from dor-* reviews: separate groups (dor-01), em-dash groups
// and commit prefixes (dor-02, dor-14, dor-27), inline values (dor-13 and dor-27),
// and the validation-gap-only shape from ticket 06.
const variants = [
  {
    name: "Defects with separate Spec and Standards headings",
    open: "Defects:\nSpec:\n- a.ts:1 Turn off can be undone.\nStandards:\n- b.ts:2 Recheck the captured proof.\nValidation gaps:\n- Hold two consent responses.\nOptional nits: none.",
    none: "Defects:\nSpec:\n- none.\nStandards:\n- None found.\nValidation gaps:\n- none beyond existing coverage.\nOptional nits: none.",
    findings: [finding("Spec", "a.ts:1 Turn off can be undone."), finding("Standards", "b.ts:2 Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "em-dash headings without colons",
    open: "Defects — Spec\n- a.ts:1 Turn off can be undone.\nDefects — Standards\n- b.ts:2 Recheck the captured proof.\nValidation gaps\n- Hold two consent responses.\nOptional nits\n- Rename a variable.",
    none: "Defects — Spec\nnone.\nDefects — Standards\nNone.\nValidation gaps\nnone.\nOptional nits\nnone.",
    findings: [finding("Spec", "a.ts:1 Turn off can be undone."), finding("Standards", "b.ts:2 Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "bold em-dash headings with inline values",
    open: "**Defects — Spec:**\n- **8d5ac2b0:scripts/agents/durable-inventory.mjs:257 — P2:** The listing limit is too small.\n**Defects — Standards: none under CODING_STANDARDS.md.**\n**Validation gaps:** Add discovery tests.\n**Optional nits:** none.",
    none: "**Defects — Spec: None.**\n**Defects — Standards:**\n- **none.**\n**Validation gaps: none beyond existing coverage.**\n**Optional nits:** none.",
    findings: [finding("Spec", "8d5ac2b0:scripts/agents/durable-inventory.mjs:257 — P2: The listing limit is too small.", "P2"), finding("Validation gaps", "Add discovery tests.")],
  },
  {
    name: "one-line list groups",
    open: "Defects:\n- Spec: a.ts:1 Turn off can be undone.\n- Standards: b.ts:2 Recheck the captured proof.\nValidation gaps: Hold two consent responses.\nOptional nits: none.",
    none: "Defects:\n- Spec: none.\n- Standards: none. No applicable violations found.\nValidation gaps: none.\nOptional nits: none.",
    findings: [finding("Spec", "a.ts:1 Turn off can be undone."), finding("Standards", "b.ts:2 Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
  },
  {
    name: "one-line plain groups",
    open: "Defects:\nSpec: a.ts:1 Turn off can be undone.\nStandards: b.ts:2 Recheck the captured proof.\nValidation gaps: Hold two consent responses.\nOptional nits: none.",
    none: "Defects:\nSpec: none.\nStandards: None.\nValidation gaps: none beyond existing coverage.\nOptional nits: None.",
    findings: [finding("Spec", "a.ts:1 Turn off can be undone."), finding("Standards", "b.ts:2 Recheck the captured proof."), finding("Validation gaps", "Hold two consent responses.")],
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
    assert.deepEqual(openFindings(review(variant.open)), { findings: variant.findings, notes: [], readable: true });
  });
  test(`${variant.name}: none`, () => {
    assert.deepEqual(openFindings(review(variant.none)), { findings: [], notes: [], readable: true });
  });
}

test("nits alone never count, including group-like labels inside the nits", () => {
  assert.deepEqual(openFindings(review("Defects:\n- Spec: none.\n- Standards: none.\nValidation gaps: none.\nOptional nits:\n- Rename a variable.\n- Spec: improve the wording.\n- Standards: prefer another name.")), { findings: [], notes: [], readable: true });
});

test("validation-gap-only review counts as one finding (ticket 06)", () => {
  const text = "Add an intake test where the stream exceeds its declared Content-Length. Assert cancellation and immediate reservation reuse.";
  assert.deepEqual(openFindings(review(`Defects:\n- Spec: none found.\n- Standards: none.\nValidation gaps: ${text}\nOptional nits: none.`)), {
    findings: [finding("Validation gaps", text)], notes: [], readable: true,
  });
});

test("Markdown headings and nested group lists keep multiline findings together", () => {
  assert.deepEqual(openFindings(review("## Defects:\n- **Spec:**\n  - a.ts:1 First defect.\n    - Supporting evidence.\n  - a.ts:2 Second defect.\n- **Standards:** none.\n## Validation gaps: none.\n## Optional nits: none.")), {
    findings: [finding("Spec", "a.ts:1 First defect. Supporting evidence."), finding("Spec", "a.ts:2 Second defect.")], notes: [], readable: true,
  });
});

test("ungrouped defects still count", () => {
  assert.deepEqual(openFindings(review("Defects:\n- a.ts:1 A defect.\nValidation gaps: none.\nOptional nits: none.")), {
    findings: [finding("Defects", "a.ts:1 A defect.")], notes: [], readable: true,
  });
});

test("missing completion marker or Defects heading fails closed with one finding", () => {
  for (const text of ["", "Defects:\nSpec: none.", "REVIEW_STATUS: incomplete\nDefects:\n- A defect.",
    "REVIEW_STATUS: complete\nValidation gaps: none.\nOptional nits: none.", "REVIEW_STATUS: complete\nThe Defects: section is missing."]) {
    assert.deepEqual(openFindings(text), { findings: [finding("Review", "review format unreadable")], notes: [], readable: false });
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
  const { findings } = openFindings(review(`Defects:\n- P2: defect mentioning P1\n- a.ts:1 ${"x".repeat(80)} P1 late severity\n- a.ts:2 — P4: unknown severity\nValidation gaps: P1 missing coverage`));
  assert.deepEqual(findings.map(item => item.severity), ["P2", null, null, null]);
});

test("each kind parses after its severity in the bold, backtick and plain variants", () => {
  for (const kind of ["fault", "ticket", "race", "style"]) for (const severity of ["P1", "P3"]) {
    const variants = [
      `abcd1234:src/a.ts:1 — ${severity} ${kind}: evidence.`,
      `**abcd1234:src/a.ts:1 — ${severity} ${kind}:** evidence.`,
      `abcd1234:src/a.ts:1 — **${severity} ${kind}**: evidence.`,
      `\`abcd1234:src/a.ts:1\` — \`${severity} ${kind}\`: evidence.`,
      `abcd1234:src/a.ts:1 — \`${severity}\` \`${kind}\`: evidence.`,
      `abcd1234:src/a.ts:1 — ${severity} ${kind.toUpperCase()}: evidence.`,
      `abcd1234:src/a.ts:1 — ${severity} ${kind}. Evidence.`,
    ];
    for (const text of variants) {
      const [item] = openFindings(review(`Spec defects:\n- ${text}\nValidation gaps: none.`)).findings;
      assert.deepEqual([item.severity, item.kind], [severity, kind], text);
    }
  }
  // Only a whole label counts: hyphenated prose after the severity is not a kind.
  assert.equal(openFindings(review("Defects:\n- a.ts:1 — P2 fault-tolerance is missing.")).findings[0].kind, "unsorted");
});

test("a finding without a known kind is unsorted and blocks by severity exactly as before", () => {
  const body = "Defects:\n- a.ts:1 — P1: no kind.\n- b.ts:2 — P2 bogus: unknown kind.\n- c.ts:3 — P1 faulty wording.\n- d.ts:4 no severity fault.\n- e.ts:5 — P1 fault: kind.\nValidation gaps: add a test.";
  const { findings } = openFindings(review(body));
  assert.deepEqual(findings.map(item => item.kind), ["unsorted", "unsorted", "unsorted", "unsorted", "fault", null]);
  assert.deepEqual(blockingFindings(findings).map(item => item.text), ["a.ts:1 — P1: no kind.", "c.ts:3 — P1 faulty wording.", "d.ts:4 no severity fault.", "e.ts:5 — P1 fault: kind."]);
  const kindless = findings.map(item => ({ ...item, kind: "unsorted" }));
  assert.deepEqual(blockingFindings(kindless).map(item => item.text), blockingFindings(findings).map(item => item.text));
});

test("the findings record carries metadata, findings and counts by kind and severity", () => {
  const meta = { model: "claude-opus-5-5", effort: "medium", scope: "git diff a^..a", head: "a".repeat(40) };
  const record = findingsRecord(review("Spec defects:\n- a.ts:1 — P1 ticket: x.\n- b.ts:2 — P2 race: y.\nStandards defects:\n- c.ts:3 — P3 style: z.\n- d.ts:4 — P2: w.\n- A reviewer remark.\nValidation gaps: add a test.\nOptional nits: none."), meta);
  assert.deepEqual(record, { ...meta,
    findings: [
      { group: "Spec", severity: "P1", kind: "ticket", text: "a.ts:1 — P1 ticket: x." },
      { group: "Spec", severity: "P2", kind: "race", text: "b.ts:2 — P2 race: y." },
      { group: "Standards", severity: "P3", kind: "style", text: "c.ts:3 — P3 style: z." },
      { group: "Standards", severity: "P2", kind: "unsorted", text: "d.ts:4 — P2: w." },
      { group: "Validation gaps", severity: null, kind: null, text: "add a test." },
    ],
    counts: { kind: { fault: 0, ticket: 1, race: 1, style: 1, unsorted: 1, gap: 1 }, severity: { P0: 0, P1: 1, P2: 2, P3: 1, none: 0, gap: 1 } },
    notes: 1,
  });
  assert.equal(countsLine(record), "findings 5: ticket 1, race 1, style 1, unsorted 1, gap 1; P1 1, P2 2, P3 1, gap 1");
  // A defect without readable severity blocks; a gap never does, so the counts keep them apart.
  const unrated = findingsRecord(review("Defects:\n- a.ts:1 no severity.\nValidation gaps: add a test."), meta);
  assert.deepEqual(unrated.counts, { kind: { fault: 0, ticket: 0, race: 0, style: 0, unsorted: 1, gap: 1 }, severity: { P0: 0, P1: 0, P2: 0, P3: 0, none: 1, gap: 1 } });
  assert.equal(countsLine(unrated), "findings 2: unsorted 1, gap 1; none 1, gap 1");
  assert.deepEqual(blockingFindings(unrated.findings).map(item => item.text), ["a.ts:1 no severity."]);
  const clean = findingsRecord(review("Defects: none.\nValidation gaps: none."), meta);
  assert.deepEqual(clean.findings, []);
  assert.equal(countsLine(clean), "findings 0");
  for (const text of ["", "incomplete reply\n", "REVIEW_STATUS: complete\nNo groups."]) {
    assert.deepEqual(findingsRecord(text, meta), { ...meta, unreadable: true });
    assert.equal(countsLine(findingsRecord(text, meta)), "findings unreadable");
  }
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
  assert.deepEqual(openFindings(review(body)), { findings: [finding("Standards", defect, "P1"), finding("Validation gaps", gap)], notes: [], readable: true });
  assert.deepEqual(openFindings(body), { findings: [finding("Review", "review format unreadable")], notes: [], readable: false });
});

test("implicit defect groups keep optional nits separate and accept a lone top-level group", () => {
  for (const group of ["Spec", "Standards"]) {
    assert.deepEqual(openFindings(review(`${group}: P2: Minor defect.\nValidation gaps: none.`)), { findings: [finding(group, "P2: Minor defect.", "P2")], notes: [], readable: true });
  }
  assert.deepEqual(openFindings(review("Spec: none.\nStandards: none.\nValidation gaps: none.\nOptional nits:\n- Spec: Style suggestion.\nStandards: Another nit.")), { findings: [], notes: [], readable: true });
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
    findings: [finding("Spec", "abcd1234:src/thing.ts:10 — P1: First defect.", "P1"), finding("Spec", "abcd1234:src/thing.ts:20 — P2: Second defect.", "P2")], notes: [], readable: true,
  });
  assert.deepEqual(openFindings(review("## Standards defects\n- abcd1234:src/thing.ts:10 — P3: Minor standards issue.\nValidation gaps: none.")), {
    findings: [finding("Standards", "abcd1234:src/thing.ts:10 — P3: Minor standards issue.", "P3")], notes: [], readable: true,
  });
  assert.deepEqual(openFindings(review("**Standards defects:**\n- abcd1234:src/thing.ts:10 — P1: Standards defect.\n\n**Spec defects: none.**\n**Validation gaps:** none.")), {
    findings: [finding("Standards", "abcd1234:src/thing.ts:10 — P1: Standards defect.", "P1")], notes: [], readable: true,
  });
});

test("Spec defects and Standards defects headings keep Validation gaps plain text", () => {
  assert.deepEqual(openFindings(review("Spec defects:\n- abcd1234:src/a.ts:1 — P2: The defect.\nValidation gaps:\nStandards: add a test.")), {
    findings: [finding("Spec", "abcd1234:src/a.ts:1 — P2: The defect.", "P2"), finding("Validation gaps", "Standards: add a test.")], notes: [], readable: true,
  });
  assert.deepEqual(openFindings(review("Standards defects:\n- abcd1234:src/a.ts:1 — P1: The defect.\nValidation gaps:\nSpec: add a test.")), {
    findings: [finding("Standards", "abcd1234:src/a.ts:1 — P1: The defect.", "P1"), finding("Validation gaps", "Spec: add a test.")], notes: [], readable: true,
  });
});

test("a bare Spec defects heading opens the Spec group", () => {
  assert.deepEqual(openFindings(review("Spec defects\n- abcd1234:src/thing.ts:10 — P1: First defect.\nValidation gaps: none.")), {
    findings: [finding("Spec", "abcd1234:src/thing.ts:10 — P1: First defect.", "P1")], notes: [], readable: true,
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
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: evidence", "P1"), finding("Validation gaps", "Spec defects: wording could be tighter")], notes: [], readable: true,
  });
});

test("unbulleted Spec defects / Standards defects in nits or gaps stay plain text", () => {
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps: none.\nOptional nits:\nSpec defects: tighter wording")), { findings: [], notes: [], readable: true });
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps:\nStandards defects: add a race test")), {
    findings: [finding("Validation gaps", "Standards defects: add a race test")], notes: [], readable: true,
  });
  assert.deepEqual(openFindings(review("Spec:\n- abcd123:a.ts:1 — P1: evidence\nStandards: none\nValidation gaps: none\nOptional nits:\nSpec defects: none")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: evidence", "P1")], notes: [], readable: true,
  });
});

test("a top-level Spec group before a Standards defects heading keeps its defect", () => {
  assert.deepEqual(openFindings(review("Spec:\n- abcd123:a.ts:1 — P1: x\nStandards defects: none\nValidation gaps: none.")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: x", "P1")], notes: [], readable: true,
  });
});

test("a Spec defects heading only after the notes opens its group and blocks", () => {
  const { findings } = openFindings(review("Validation gaps: none.\nSpec defects:\n- abcd123:a.ts:1 — P1: x"));
  assert.deepEqual(findings, [finding("Spec", "abcd123:a.ts:1 — P1: x", "P1")]);
  assert.deepEqual(blockingFindings(findings), findings);
});

test("a bulleted Defects heading still keeps Validation gaps plain text", () => {
  assert.deepEqual(openFindings(review("- Defects:\n  - abc1234:a.ts:1 — P2: x\nValidation gaps:\nStandards: add a test.")), {
    findings: [finding("Defects", "abc1234:a.ts:1 — P2: x", "P2"), finding("Validation gaps", "Standards: add a test.")], notes: [], readable: true,
  });
});

test("bulleted Spec defects / Standards defects before any notes section open their groups", () => {
  assert.deepEqual(openFindings(review("- Spec defects:\n  - abcd123:a.ts:1 — P1: evidence\n- Standards defects: none\nValidation gaps:\nStandards: add a test.")), {
    findings: [finding("Spec", "abcd123:a.ts:1 — P1: evidence", "P1"), finding("Validation gaps", "Standards: add a test.")], notes: [], readable: true,
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
    findings: [finding("Validation gaps", "Mixed-case aliases are untested. Add `assert.equal(builderAuthor(\"OPUS\"), \"Claude Opus <noreply@anthropic.com>\")`.")], notes: [], readable: true,
  });
  assert.deepEqual(openFindings(lead92), {
    findings: [finding("Validation gaps", "An online video tile in the picker repainting its choice in place is not tested."),
      finding("Validation gaps", "Focus coming back to a rebuilt tile is not tested on the new keyed path.")], notes: [], readable: true,
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
    ], notes: [], readable: true,
  });
  assert.deepEqual(openFindings(sf10), {
    findings: [finding("Spec", sf10Defect, "P2"),
      finding("Validation gaps", "Add a test that pins what happens to a defects heading after the notes."),
      finding("Validation gaps", "Add a test for a bulleted bare group inside a defects-label section.")], notes: [], readable: true,
  });
  for (const text of [sf12, sf10]) assert.deepEqual(blockingFindings(openFindings(text).findings), []);
});

test("a none group with a sentence holds notes in any case, plain or bulleted", () => {
  for (const body of ["Spec: None. I checked every item.\n- First note.\n  - Detail.\nStandards: NONE\nPlain note line.\n- Another note.",
    "Defects:\n- **Spec:**\n  - none found.\n    - A note.\n  - A second note.\n- **Standards:** None — the rules do not apply.\n  - A note."]) {
    assert.deepEqual(openFindings(review(`${body}\nValidation gaps: none.\nOptional nits: none.`)), { findings: [], notes: [], readable: true });
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
    findings: [finding("Spec", "Standards: a.ts:1 — P1: x", "P1")], notes: [], readable: true,
  });
  // An unbulleted bare group still switches, as before.
  assert.deepEqual(openFindings(review("Spec defects:\n- a.ts:1 — P1: x\nStandards:\n- b.ts:2 — P2: y\nValidation gaps: none.")), {
    findings: [finding("Spec", "a.ts:1 — P1: x", "P1"), finding("Standards", "b.ts:2 — P2: y", "P2")], notes: [], readable: true,
  });
});

test("a bulleted bare group after none notes in a defects-label section opens its group", () => {
  const { findings } = openFindings(review("Spec defects:\n- None.\n- Standards: a.ts:1 — P1: x\nValidation gaps: none."));
  assert.deepEqual(findings, [finding("Standards", "a.ts:1 — P1: x", "P1")]);
  assert.deepEqual(blockingFindings(findings), findings);
});

test("a late inline defects label opens its group when bold or carrying a severity; plain text stays a gap", () => {
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps:\n**Standards defects:** a.ts:1 add a race test")).findings,
    [finding("Standards", "a.ts:1 add a race test")]);
  for (const notes of ["Validation gaps: none.", "Validation gaps: none.\nOptional nits:"]) {
    const { findings } = openFindings(review(`Defects: none\n${notes}\nStandards defects: a.ts:1 — P1: x`));
    assert.deepEqual(findings, [finding("Standards", "a.ts:1 — P1: x", "P1")]);
    assert.deepEqual(blockingFindings(findings), findings);
  }
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps:\nStandards defects: add a race test")).findings,
    [finding("Validation gaps", "Standards defects: add a race test")]);
});

test("bullets under a none Validation gaps group are notes, not gaps", () => {
  assert.deepEqual(openFindings(review("Defects: none\nValidation gaps: none.\n- Add a race test.")), { findings: [], notes: [], readable: true });
});

test("a bulleted bare none group after a finding in a defects-label section adds nothing", () => {
  const { findings } = openFindings(review("Spec defects:\n- a.ts:1 — P2: x\n- Standards: none\n  - A note.\nValidation gaps: none."));
  assert.deepEqual(findings, [finding("Spec", "a.ts:1 — P2: x", "P2")]);
  assert.deepEqual(blockingFindings(findings), []);
});

test("an unbulleted None. first line under a bare heading holds notes", () => {
  assert.deepEqual(openFindings(review("Defects\n\nSpec\nNone. I checked every item.\nPlain note.\n- Bulleted note.\nValidation gaps: none.")), { findings: [], notes: [], readable: true });
});

test("a combined Defects group opening with a none line holds notes, but a located P1 there still counts", () => {
  assert.deepEqual(openFindings(review("Defects:\n- None in Spec.\n- A note.\n- a.ts:1 — P1: x\nValidation gaps: none.")), {
    findings: [finding("Defects", "a.ts:1 — P1: x", "P1")], notes: [], readable: true,
  });
});

test("a located finding with a severity under none notes still counts and blocks", () => {
  const cases: [string, ReturnType<typeof finding>[]][] = [
    ["Defects:\nSpec: none\n### Standards (CODING_STANDARDS.md)\n- a.ts:1 — P1: x\n  - Evidence.\n- A note.\nValidation gaps: none.",
      [finding("Spec", "a.ts:1 — P1: x Evidence.", "P1")]],
    ["Spec defects:\n- a.ts:1 — P2: x\n- Standards: none\n- b.ts:2 — P1: y\nValidation gaps: none.",
      [finding("Spec", "a.ts:1 — P2: x", "P2"), finding("Standards", "b.ts:2 — P1: y", "P1")]],
    ["Spec:\n- None of the fixtures are trimmed copies: a.ts:1 — P1\n- b.ts:2 — P1: y\nValidation gaps: none.",
      [finding("Spec", "b.ts:2 — P1: y", "P1")]],
  ];
  for (const [body, expected] of cases) {
    const { findings } = openFindings(review(body));
    assert.deepEqual(findings, expected);
    assert.deepEqual(blockingFindings(findings), expected.filter(item => item.severity === "P1"));
  }
});

test("slice 48's review gives its P2 and P3, and the italic *Spec* heading and Standards prose are notes", () => {
  const { findings, notes, readable } = openFindings(readFileSync(join(import.meta.dirname, "fixtures/review-findings/ke-48-result.md"), "utf8"));
  assert.equal(readable, true);
  const defects = findings.filter(item => item.group !== "Validation gaps");
  assert.deepEqual(defects.map(item => [item.group, item.severity, item.kind, item.text.slice(0, 37)]), [
    ["Standards", "P2", "fault", "0297da793:scripts/agents/kit.d/ux:464"], ["Standards", "P3", "fault", "0297da793:scripts/agents/kit.d/ux:344"]]);
  assert.equal(findings.filter(item => item.group === "Validation gaps").length, 4);
  assert.ok(!findings.some(item => item.text.includes("*Spec*")));
  assert.deepEqual(notes.map(item => [item.group, item.text.slice(0, 51)]), [["Standards", "CODING_STANDARDS.md has no section for kit plumbing"]]);
  assert.deepEqual(blockingFindings(findings), []);
});

test("a Standards group holding only a no-section-applies sentence gives no finding", () => {
  const note = "No section of CODING_STANDARDS.md applies to this change.";
  for (const body of [`Defects:\nSpec: none.\nStandards:\n${note}`, `Defects:\nSpec: none.\nStandards:\n- ${note}`, `Defects:\nSpec: none.\nStandards: ${note}`]) {
    assert.deepEqual(openFindings(review(`${body}\nValidation gaps: none.`)), { findings: [], notes: [{ group: "Standards", text: note }], readable: true }, body);
  }
  const record = findingsRecord(review(`Defects:\nStandards:\n${note}\nValidation gaps: none.`), {});
  assert.deepEqual([record.findings, record.notes, countsLine(record)], [[], 1, "findings 0"]);
});

test("single * and _ emphasis headings open their group like bold and # forms", () => {
  for (const [spec, standards] of [["*Spec*", "*Standards*"], ["_Spec_", "_Standards_"], ["*Spec:*", "_Standards:_"]]) {
    const { findings } = openFindings(review(`**Defects**\n\n${spec}\n- None.\n\n${standards}\n- a.ts:1 — P1: x\nValidation gaps: none.`));
    assert.deepEqual(findings, [finding("Standards", "a.ts:1 — P1: x", "P1")], `${spec} ${standards}`);
  }
  assert.deepEqual(openFindings(review("Defects:\n_Standards_: none.\nValidation gaps: none.")), { findings: [], notes: [], readable: true });
});

test("a located line with no severity still blocks; a missing REVIEW_STATUS is still unreadable", () => {
  for (const text of ["a.ts:1 the guard is missing.", "`abcd123:src/a.ts:4-9` — the guard is missing."]) {
    const { findings, notes } = openFindings(review(`Defects:\nStandards:\n- ${text}\nValidation gaps: none.`));
    assert.deepEqual([findings, notes], [[finding("Standards", text)], []]);
    assert.deepEqual(blockingFindings(findings), findings);
  }
  const { findings } = openFindings("**Defects**\n\n*Standards*\n\nNo section of CODING_STANDARDS.md applies to this change.\n");
  assert.deepEqual(findings, [finding("Review", "review format unreadable")]);
  assert.deepEqual(blockingFindings(findings), findings);
});
