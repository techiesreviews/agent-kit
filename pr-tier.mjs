// Which local checks `kit pr` runs: the highest tier any changed path reaches. CI on GitHub is the backstop.
const order = ["docs", "css", "tests", "full"];

/** Unit test files that read the repo's own docs (code map, runner guide, MCP tool list); any test naming a changed docs path joins them. */
export const docsGuardTests = ["tests/agent-scripts.test.ts", "tests/code-map.test.ts", "tests/mcp-runtime.test.ts"];

const unitTest = path => /^tests\/[^/]+\.test\.ts$/.test(path);

/** Tier of one changed path; a deleted stylesheet may still be imported, so it counts as code. */
export function pathTier({ status, path }) {
  if (/^(tests|fixtures)\//.test(path)) return "tests";
  if (/^docs\//.test(path) || /\.md$/i.test(path)) return "docs";
  if (/\.css$/i.test(path) && status !== "D") return "css";
  return "full";
}

/** Paths a user can see; `kit pr` requires a feature-list update for them and `kit ux` reads the same list. */
export const visiblePaths = [/^src\/.+\.css$/i, /^src\/components\//, /^src\/ui\//, /^src\/page-builder\/(?!rules\/)/, /^src\/icons\.ts$/, /^index\.html$/];
export const featureList = "docs/agents/features.md";
export const visiblePath = path => visiblePaths.some(pattern => pattern.test(path));
/** A ticket's Done heading: `## Done` or `## Done (YYYY-MM-DD)`, never `## Done when`. */
export const doneHeading = () => /^## Done(?:[ \t]+\(\d{4}-\d{2}-\d{2}\))?[ \t]*\r?$/gm;
export const featureListProblem = `visible change without a feature-list update; edit ${featureList} or add "Feature list: no change (<reason>)" to the ticket's Done`;

/** Feature-list guard for a PR: { ok, line } where `line` is the PR body note, or undefined when nothing visible changed. */
export function featureListGuard(changes, { ticketText = "", waive } = {}) {
  const visible = changes.filter(({ path }) => visiblePath(path));
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
export function classify(changes, { full = false } = {}) {
  const count = `${changes.length} file${changes.length === 1 ? "" : "s"}`;
  const cleanGuard = changes.some(({ path }) => /^scripts\/agents\//.test(path) || /^tests\/kit-.*\.test\.ts$/.test(path))
    ? { cleanGuard: true } : {};
  if (full) return { tier: "full", reason: `${count}, --full`, docs: false, ...cleanGuard };
  if (!changes.length) return { tier: "full", reason: "no changed files", docs: false };
  const tiers = changes.map(pathTier);
  const tier = order[Math.max(...tiers.map(name => order.indexOf(name)))];
  const present = order.filter(name => tiers.includes(name));
  const why = tier === "full" ? `${changes[tiers.indexOf("full")].path} is code`
    : present.length === 1 ? `all ${tier}` : `${present.join(" + ")}, highest ${tier}`;
  return { tier, reason: `${count}, ${why}`, docs: tiers.includes("docs"), ...cleanGuard };
}

// A helper, fake or fixture is matched to unit tests by name: the fixture folder, else the file's stem.
function key(path) {
  const parts = path.split("/"), fixture = parts.lastIndexOf("fixtures");
  if (fixture >= 0 && parts.length > fixture + 2) return parts[fixture + 1];
  return parts.at(-1).replace(/\.[^.]*$/, "").replace(/\.(test|spec)$/, "");
}

/** Unit test files for a focused run: changed ones, ones naming a changed helper, fixture or docs path, and docs guards. */
export function focusedUnitFiles(changes, plan, sources) {
  const files = new Set();
  const tests = Object.keys(sources);
  if (plan.tier === "tests") for (const change of changes) {
    if (pathTier(change) !== "tests") continue;
    if (unitTest(change.path)) { if (change.status !== "D" && tests.includes(change.path)) files.add(change.path); continue; }
    const name = key(change.path);
    if (name.length >= 3) for (const test of tests) if (sources[test].includes(name)) files.add(test);
  }
  if (plan.docs) {
    for (const test of docsGuardTests) if (tests.includes(test)) files.add(test);
    for (const { path } of changes.filter(change => pathTier(change) === "docs"))
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
