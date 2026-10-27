// Which local checks `kit pr` runs: the highest tier any changed path reaches. CI on GitHub is the backstop.
// The path patterns, the feature list and the docs-guard tests come from scripts/agents/kit.json
// (`paths`, `featureList`, `unit.docsGuards`); a missing key means no path reaches that tier or guard.
// `paths.kit` marks kit plumbing (it runs `checks.extra`); `paths.unitTests` marks the unit test files.
// It also names the second look's review kind and its model from second-look.json beside it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kitSettings } from "./kit-lib.mjs";

const order = ["docs", "css", "tests", "full"];
const compiled = new WeakMap();
// Second-look kinds when the settings set no `paths.agent` or `paths.dx`: agent setup, and build files and scripts.
const agentPaths = ["^scripts/agents/", "^\\.claude/", "^\\.codex/", "(?:^|/)(?:AGENTS|CLAUDE)\\.md$", "^docs/agents/"];
const developerPaths = ["^scripts/", "^\\.github/", "^package(?:-lock)?\\.json$", "^tsconfig[^/]*\\.json$", "(?:^|/)[^/]+\\.config\\.[cm]?[jt]s$", "^wrangler\\.jsonc?$"];

/** The settings' path rules as regular expressions, compiled once per settings object. */
function rules(settings = kitSettings()) {
  if (!compiled.has(settings)) {
    const patterns = (name, fallback = []) => (settings.paths?.[name] ?? fallback).map(source => {
      try { return new RegExp(source); }
      catch (error) { throw new Error(`paths.${name} in scripts/agents/kit.json: ${error.message}`); }
    });
    const docs = patterns("docs"), kit = patterns("kit");
    compiled.set(settings, { docs, tests: patterns("tests"), css: patterns("css"), visible: patterns("visible"), kit,
      agent: [...patterns("agent", agentPaths), ...kit], dx: [...patterns("dx", developerPaths), ...docs],
      unitTests: patterns("unitTests"), featureList: settings.featureList || null, docsGuards: settings.unit?.docsGuards ?? [] });
  }
  return compiled.get(settings);
}
const matches = (patterns, path) => patterns.some(pattern => pattern.test(path));

/** A unit test file (`paths.unitTests`); with no patterns, no file is one. */
export const unitTestFile = (path, settings) => matches(rules(settings).unitTests, path);

/** Tier of one changed path; a deleted stylesheet may still be imported, so it counts as code. */
export function pathTier({ status, path }, settings) {
  const { docs, tests, css } = rules(settings);
  if (matches(tests, path)) return "tests";
  if (matches(docs, path)) return "docs";
  if (matches(css, path) && status !== "D") return "css";
  return "full";
}

/** Paths a user can see (`paths.visible`); `kit pr` requires a feature-list update for them. */
export const visiblePath = (path, settings) => matches(rules(settings).visible, path);
/** A ticket's Done heading: `## Done` or `## Done (YYYY-MM-DD)`, never `## Done when`. */
export const doneHeading = () => /^## Done(?:[ \t]+\(\d{4}-\d{2}-\d{2}\))?[ \t]*\r?$/gm;
export const featureListProblem = settings =>
  `visible change without a feature-list update; edit ${rules(settings).featureList} or add "Feature list: no change (<reason>)" to the ticket's Done`;

/** Feature-list guard for a PR: { ok, line } where `line` is the PR body note, or undefined when nothing visible changed or the project keeps no feature list. */
export function featureListGuard(changes, { ticketText = "", waive, settings } = {}) {
  const { featureList } = rules(settings);
  const visible = featureList ? changes.filter(({ path }) => visiblePath(path, settings)) : [];
  if (!visible.length) return { ok: true };
  if (changes.some(({ status, path }) => path === featureList && status !== "D")) return { ok: true, line: `Feature list: updated (${featureList})` };
  const done = [...ticketText.matchAll(doneHeading())].at(-1);
  const rest = done ? ticketText.slice(done.index + done[0].length) : "";
  const reason = /^\s*(?:[-*]\s+)?Feature list: no change \((.*\S.*)\)[ \t]*\r?$/m.exec(rest.split(/^## /m)[0])?.[1].trim();
  if (reason) return { ok: true, line: `Feature list: no change (${reason})` };
  if (waive) return { ok: true, line: `Feature list: waived (${waive.replace(/[\r\n]+/g, " ")}); ${visible[0].path} is visible` };
  return { ok: false, line: `Feature list: missing; ${visible[0].path} is visible` };
}

/** Parse `git diff --name-status --no-renames` output into { status, path } rows. */
export function parseChanges(text) {
  return text.split(/\r?\n/).filter(Boolean).map(line => {
    const [status, ...rest] = line.split("\t");
    return { status: status[0], path: rest.join("\t") };
  });
}

/** Pick the tier and a one-line reason, e.g. `docs (12 files, all docs)`. */
export function classify(changes, { full = false, settings } = {}) {
  const count = `${changes.length} file${changes.length === 1 ? "" : "s"}`;
  const { kit } = rules(settings);
  const cleanGuard = changes.some(({ path }) => matches(kit, path)) ? { cleanGuard: true } : {};
  if (full) return { tier: "full", reason: `${count}, --full`, docs: false, ...cleanGuard };
  if (!changes.length) return { tier: "full", reason: "no changed files", docs: false };
  const tiers = changes.map(change => pathTier(change, settings));
  const tier = order[Math.max(...tiers.map(name => order.indexOf(name)))];
  const present = order.filter(name => tiers.includes(name));
  const why = tier === "full" ? `${changes[tiers.indexOf("full")].path} is code`
    : present.length === 1 ? `all ${tier}` : `${present.join(" + ")}, highest ${tier}`;
  return { tier, reason: `${count}, ${why}`, docs: tiers.includes("docs"), ...cleanGuard };
}

export const reviewKinds = ["agent", "ux", "dx", "code"];

// A ticket file (the `--ticket` one or any `tickets/<name>.md`) rides along with every slice, so it says nothing about the change.
const ticketFile = /(?:^|\/)tickets\/[^/]+\.md$/;

/** The second look's kind and the path that decided it: agent setup (`paths.agent`, `paths.kit`) first, then what a user
 * sees (`paths.visible`), then developer files (`paths.dx`, `paths.docs`); a change that reaches none is code. Ticket
 * files (`ticket` is the repo path of the `--ticket` one) and the feature list, which every visible change updates,
 * count only when nothing else changed. */
export function reviewKind(changes, settings, { ticket } = {}) {
  const { agent, visible, dx, featureList } = rules(settings);
  const work = changes.filter(({ path }) => path !== ticket && path !== featureList && !ticketFile.test(path));
  const looked = work.length ? work : changes;
  for (const [kind, patterns] of [["agent", agent], ["ux", visible], ["dx", dx]]) {
    const hit = looked.find(({ path }) => matches(patterns, path));
    if (hit) return { kind, path: hit.path };
  }
  return { kind: "code", path: looked[0]?.path ?? null };
}

// A second look is Grok or a free OpenCode model, never Codex or another OpenAI model.
const lookFamily = model => typeof model !== "string" ? null : /^grok-\S+$/i.test(model) ? "grok" : /^opencode\/\S+$/.test(model) ? "opencode" : null;

/** The second-look table (ASE_SECOND_LOOK, else second-look.json beside this file): per kind { model, fallback, checked }. */
export function secondLookTable(path = process.env.ASE_SECOND_LOOK || join(import.meta.dirname, "second-look.json")) {
  let table;
  try { table = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`second-look table ${path}: ${error.message}`); }
  for (const kind of reviewKinds) {
    const row = table?.kinds?.[kind], problem = text => new Error(`second-look table ${path} ${kind}: ${text}`);
    if (!row || typeof row !== "object") throw problem("missing");
    const [first, second] = [lookFamily(row.model), lookFamily(row.fallback)];
    if (!first || !second) throw problem("model and fallback must be grok-<model> or opencode/<model>");
    if (first === second) throw problem("the fallback must be the other family");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.checked ?? "")) throw problem("checked must be a YYYY-MM-DD date");
  }
  return table.kinds;
}

/** The second look for a change: its kind, the deciding path, and the table's model and fallback for that kind. */
export function secondLookPick(changes, settings, { ticket, table } = {}) {
  const { kind, path: decided } = reviewKind(changes, settings, { ticket });
  const { model, fallback } = secondLookTable(table)[kind];
  return { kind, path: decided, model, fallback };
}

// A helper, fake or fixture is matched to unit tests by name: the fixture folder, else the file's stem.
function key(path) {
  const parts = path.split("/"), fixture = parts.lastIndexOf("fixtures");
  if (fixture >= 0 && parts.length > fixture + 2) return parts[fixture + 1];
  return parts.at(-1).replace(/\.[^.]*$/, "").replace(/\.(test|spec)$/, "");
}

/** Unit test files for a focused run: changed ones, ones naming a changed helper, fixture or docs path, and docs guards. */
export function focusedUnitFiles(changes, plan, sources, settings) {
  const files = new Set(), { docsGuards } = rules(settings);
  const tests = Object.keys(sources);
  if (plan.tier === "tests") for (const change of changes) {
    if (pathTier(change, settings) !== "tests") continue;
    if (unitTestFile(change.path, settings)) { if (change.status !== "D" && tests.includes(change.path)) files.add(change.path); continue; }
    const name = key(change.path);
    if (name.length >= 3) for (const test of tests) if (sources[test].includes(name)) files.add(test);
  }
  if (plan.docs) {
    for (const test of docsGuards) if (tests.includes(test)) files.add(test);
    for (const { path } of changes.filter(change => pathTier(change, settings) === "docs"))
      for (const test of tests) if (sources[test].includes(path)) files.add(test);
  }
  return [...files].sort();
}

/** Ordered local steps for a tier; `review` says whether the Sol review runs. */
export function checkSteps(plan) {
  const steps = {
    full: ["check", "unit", ...(plan.cleanGuard ? ["kit-clean"] : []), "lint", "specs"],
    tests: ["check", "unit-files", "lint", "specs"],
    css: ["colours", ...(plan.docs ? ["tickets", "unit-files"] : []), "specs"],
    docs: ["tickets", "unit-files"],
  }[plan.tier];
  return { steps, review: plan.tier !== "docs" };
}
