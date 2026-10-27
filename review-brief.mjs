#!/usr/bin/env node
// Usage: review-brief.mjs <ticket-file> [base | --commit SHA]; print a slice review brief.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { kitBranch, kitSettings } from "./kit-lib.mjs";

// The settings file sits at the top of the reviewed checkout, which may be given as any folder in it.
const topFolder = worktree => {
  try { return execFileSync("git", ["-C", worktree, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return worktree; }
};
// Scope and standards both come from the reviewed checkout's settings.
const landRef = worktree => `origin/${kitBranch("land", kitSettings(topFolder(worktree)))}`;

/** "a", "a and b", "a, b and c". */
export const spoken = items => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items.join("");

/** Whether the project's own commands folder (settings `commands`) holds an executable `name`, as the kit front door finds it. */
export function projectCommand(name, root, settings = kitSettings(root)) {
  if (typeof settings.commands !== "string" || !settings.commands) return false;
  const folder = resolve(root, settings.commands);
  try {
    return readdirSync(folder).some(file => {
      if (/^[._]/.test(file) || file.replace(/\.[^.]*$/, "") !== name) return false;
      const stat = statSync(resolve(folder, file));
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    });
  } catch { return false; }
}

/**
 * The checks an author runs before review, from the settings: the `checks.check`, `checks.test` and `checks.lint`
 * commands that are set, then "the touched specs" when the project has a `specs` command.
 */
export function projectChecks(root, settings = kitSettings(root)) {
  const checks = settings.checks ?? {};
  return [checks.check, checks.test, checks.lint].filter(command => typeof command === "string" && command.trim())
    .map(command => command.trim()).concat(projectCommand("specs", root, settings) ? ["the touched specs"] : []);
}

export const reviewFormat = `Required format:
REVIEW_STATUS: complete
Defects: commit:path:line, severity, evidence, and fix; use separate Spec and Standards groups.
Write each Defect as commit:path:line — P1 fault: evidence and fix.
Every Defect must carry P0, P1, P2 or P3 right after its location, then one kind:
fault: the code is wrong (abc1234:src/save.ts:40 — P1 fault: a failed write is reported as saved).
ticket: the change does not match the ticket or spec (P1 ticket: "Done when" asks for counts; none are written).
race: timing, ordering or stale state (P2 race: two saves can interleave and drop the first).
style: a standards or readability breach with no behaviour change (P3 style: name the helper after what it returns).
P0: data loss, security hole, broken build/tests, or the change does not work at all.
P1: wrong behaviour a user or runner would hit, or a Spec defect that breaks a "Done when" item.
P2: real but minor defect (edge case, misleading message, standards breach with low impact).
P3: cosmetic or style.
Validation gaps: concrete missing coverage, or none; no severity.
Optional nits: separate from defects, or none.
The very first line must be REVIEW_STATUS: complete. No preamble or markdown fence.
`;

export function resolveCommit(ref, worktree = process.cwd()) {
  try {
    return execFileSync("git", ["-C", worktree, "rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { throw new Error(`cannot resolve commit ref ${ref}`); }
}

export function reviewScope(brief, { base, commit } = {}, worktree = process.cwd()) {
  if (base !== undefined && commit !== undefined) throw new Error("--base and --commit are mutually exclusive");
  if (base === undefined && commit === undefined) {
    const single = /\bgit diff (\S+)\^\.\.\1(?=[\s).,;]|$)/.exec(brief);
    if (single) commit = single[1];
    else base = /\bgit diff (\S+)\.\.\.HEAD\b/.exec(brief)?.[1];
  }
  if (base === undefined && commit === undefined) throw new Error("brief has no review scope; pass --base REF or --commit SHA");
  if (commit !== undefined) {
    const head = resolveCommit(commit, worktree);
    const parent = resolveCommit(`${head}^`, worktree);
    return { head, base: parent, commit: head, label: `git diff ${head}^..${head}` };
  }
  const resolved = resolveCommit(base, worktree);
  return { head: resolveCommit("HEAD", worktree), base: resolved, label: `git diff ${resolved}...HEAD` };
}

export function reviewComplete(result) {
  const lines = result.replace(/^\uFEFF/, "").split(/\r?\n/).map(line => line.trim());
  while (lines[0] === "") lines.shift();
  if (/^(`{3,}[^`]*|~{3,}.*)$/.test(lines[0] ?? "")) {
    lines.shift();
    while (lines[0] === "") lines.shift();
  }
  return lines[0] === "REVIEW_STATUS: complete";
}

export function reviewBrief(ticketPath, ticket, scope, worktree = process.cwd(), declined = []) {
  scope ??= landRef(worktree);
  if (!Array.isArray(declined) || declined.some(item => typeof item !== "string" || !item.trim())) {
    throw new Error("declined findings must be a list of non-empty strings");
  }
  const { label } = reviewScope("", typeof scope === "string" ? { base: scope } : scope, worktree);
  // Markdown links are relative to the ticket; repo paths in backticks are
  // rooted at the worktree. The parent map's spec is included when present.
  const links = [...ticket.matchAll(/\[[^\]]*\]\(([^\s)]+\.md)(?:#[^\s)]*)?\)/g)]
    .map(match => match[1]).filter(path => !/^[a-z]+:/i.test(path))
    .map(path => path.startsWith("docs/") ? path : posix.normalize(posix.join(posix.dirname(ticketPath), path)));
  const refs = [...ticket.matchAll(/`([^`\n]*\bspec\.md)(?:#[^`\n]*)?`/g)].map(match => match[1]);
  const sources = [...new Set([ticketPath, ...links, ...refs].filter(Boolean))];
  const top = topFolder(worktree), settings = kitSettings(top);
  // standards: one file or a list (AGENTS.md where a project has no standards file).
  const standards = spoken([settings.standards].flat().filter(file => typeof file === "string" && file.trim()));
  const checks = projectChecks(top, settings);
  return `Review this build slice in read-only mode. Make no changes.
Scope: ${label}.
${sources.length ? `Spec axis: read ${sources.join(", ")}, including the linked spec and deciding tickets.` : "Spec axis: no ticket supplied; assess the change against the stated intent and repo documentation."}
${standards ? `Standards axis: apply ${standards}; cite the applicable rule with each defect.` : "Standards axis: no standards file in scripts/agents/kit.json; judge against the repository's own conventions."}
${checks.length ? `The author already ran ${spoken(checks)}; do not report inability to run tests.` : "The project sets no checks in scripts/agents/kit.json; do not assume any ran, and do not report inability to run tests."}
Report validation gaps only for missing coverage or evidence in the change, with a concrete test to add.
${declined.length ? `\nDeclined by the author (with reasons):\n${declined.map(item => `- ${item}`).join("\n")}\nReport a declined finding again only if the reason is wrong, and say why.\n` : ""}`;
}

// kit fix passes the list through the child environment so kit review needs no
// additional flags and its ordinary evidence/permission handling stays shared.
export function ticketReviewBrief(path, scope, worktree = process.cwd(), declined = JSON.parse(process.env.ASE_REVIEW_DECLINED || "[]")) {
  const absolute = resolve(worktree, path);
  let ticket = readFileSync(absolute, "utf8");
  // Build-map tickets often omit a link to their sibling ../spec.md.
  const spec = resolve(dirname(absolute), "../spec.md");
  try { readFileSync(spec); ticket += "\n[Map spec](../spec.md)\n"; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return reviewBrief(path, ticket, scope, worktree, declined);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!(args.length === 1 || (args.length === 2 && !args[1].startsWith("--")) || (args.length === 3 && args[1] === "--commit"))) {
    console.error("Usage: review-brief.mjs <ticket-file> [base=origin/<land> | --commit SHA]");
    process.exit(2);
  }
  try {
    process.stdout.write(ticketReviewBrief(args[0], args[1] === "--commit" ? { commit: args[2] } : args[1]));
  } catch (error) {
    console.error(`problem: ${error.message}`);
    process.exitCode = 2;
  }
}
