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
  if (full) return { tier: "full", reason: `${count}, --full`, docs: false };
  if (!changes.length) return { tier: "full", reason: "no changed files", docs: false };
  const tiers = changes.map(pathTier);
  const tier = order[Math.max(...tiers.map(name => order.indexOf(name)))];
  const present = order.filter(name => tiers.includes(name));
  const why = tier === "full" ? `${changes[tiers.indexOf("full")].path} is code`
    : present.length === 1 ? `all ${tier}` : `${present.join(" + ")}, highest ${tier}`;
  return { tier, reason: `${count}, ${why}`, docs: tiers.includes("docs") };
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
    full: ["check", "unit", "lint", "specs"],
    tests: ["check", "unit-files", "lint", "specs"],
    css: ["colours", ...(plan.docs ? ["tickets", "unit-files"] : []), "specs"],
    docs: ["tickets", "unit-files"],
  }[plan.tier];
  return { steps, review: plan.tier !== "docs" };
}
