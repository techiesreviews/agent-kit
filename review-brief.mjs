#!/usr/bin/env node
// Usage: review-brief.mjs <ticket-file> [base=origin/dev]; print a slice review brief.
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";

export function reviewComplete(result) {
  const lines = result.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim());
  while (lines[0] === "") lines.shift();
  if (/^(```|~~~)[\w-]*$/.test(lines[0] ?? "")) {
    lines.shift();
    while (lines[0] === "") lines.shift();
  }
  return lines[0] === "REVIEW_STATUS: complete";
}

export function reviewBrief(ticketPath, ticket, base = "origin/dev") {
  if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new Error("Invalid base ref");
  // Markdown links are relative to the ticket; repo paths in backticks are
  // rooted at the worktree. The parent map's spec is included when present.
  const links = [...ticket.matchAll(/\[[^\]]*\]\(([^\s)]+\.md)(?:#[^\s)]*)?\)/g)]
    .map(match => match[1]).filter(path => !/^[a-z]+:/i.test(path))
    .map(path => path.startsWith("docs/") ? path : posix.normalize(posix.join(posix.dirname(ticketPath), path)));
  const refs = [...ticket.matchAll(/`([^`\n]*\bspec\.md)(?:#[^`\n]*)?`/g)].map(match => match[1]);
  const sources = [...new Set([ticketPath, ...links, ...refs])];
  return `Review this build slice in read-only mode. Make no changes.
Scope: git diff ${base}...HEAD (record HEAD and ${base} commit SHAs before reviewing).
Spec axis: read ${sources.join(", ")}, including the linked spec and deciding tickets.
Standards axis: apply CODING_STANDARDS.md; cite the applicable rule with each defect.
The author already ran check/test/lint and the touched specs; do not report inability to run tests.
Report validation gaps only for missing coverage or evidence in the change, with a concrete test to add.
Required format:
REVIEW_STATUS: complete
Defects: commit:path:line, severity, evidence, and fix; use separate Spec and Standards groups.
Validation gaps: concrete missing coverage, or none.
Optional nits: separate from defects, or none.
The very first line must be REVIEW_STATUS: complete. No preamble or markdown fence.
`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error("Usage: review-brief.mjs <ticket-file> [base=origin/dev]");
    process.exit(2);
  }
  try {
    const path = args[0];
    let ticket = readFileSync(path, "utf8");
    // Build-map tickets often omit a link to their sibling ../spec.md.
    const spec = resolve(dirname(path), "../spec.md");
    try { readFileSync(spec); ticket += "\n[Map spec](../spec.md)\n"; } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    process.stdout.write(reviewBrief(path, ticket, args[1]));
  } catch (error) {
    console.error(`problem: ${error.message}`);
    process.exitCode = 2;
  }
}
