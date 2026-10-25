// kit ux: the reviewer brief, and the parser for its per-feature answer.

/** Verdict words the reviewer writes, and the key each one counts under. */
export const verdicts = { "fine": "fine", "looks off": "off", "broken": "broken" };

/**
 * The read-only reviewer's brief. `bundle` is the folder holding bundle.md and its images; `rules`
 * maps each rulebook id to its first line; `mockups` are the bundle's mock-up lines.
 */
export function uxBrief({ bundle, features, images = [], rules = new Map(), mockups = [] }) {
  return `UX review in read-only mode. Make no changes and run nothing.
Judge only what is in the bundle: ${bundle}/bundle.md and its images${images.length ? ` (${images.map(name => `${bundle}/${name}`).join(", ")})` : " (none kept)"}.
${mockups.length ? `The approved mock-up: ${mockups.map(line => line.replace(/^- /, "")).join("; ")}. Read a mock-up file the bundle links, nothing else.\n` : "No mock-up is named; judge against the rulebook alone.\n"}Do not read source files, specs or other docs, and do not open the diff, commit log or refs files the runner
names below: they only satisfy the code-review runner. The bundle and this brief hold all you need.

Judge each feature against its Good line, the rulebook below and the mock-up, never against taste of your own.
- fine: what the images show matches the Good line, the rules and the mock-up.
- looks off: usable, but it breaks a rule (name its id) or differs from the mock-up (name the difference). Without a rule id or a mock-up difference, it is fine.
- broken: the feature cannot be used as tried: a failed try, a missing control, or content clipped, covered or unreadable so the task stops.
- An untried feature is judged from the screen images; when no image shows it, write fine, say "not shown" and name the image as none.
- Say what is wrong in plain words. Never suggest new text, hints, tips, counts or badges.

Features to judge: ${features.map(feature => feature.id).join(", ")}

Rulebook (first line of each rule):
${[...rules].map(([id, text]) => `- ${id} ${text}`).join("\n")}

Answer format. The runner appends a code-review scope and format after this brief; neither applies here,
except that the first line must be REVIEW_STATUS: complete.
REVIEW_STATUS: complete
One line per feature above, in that order:
F-<area>-<nn>: fine | looks off | broken — <one line on what the images show> — <image file name, or none>
Then one line listing the rules broken by id, or none:
Rules broken: S1, L5
Nothing else: no preamble, no headings, no markdown fence.
`;
}

const verdictLine = /^[-*\s]*\**(F-[a-z]+-\d{2})\**\s*:\s*\**(fine|looks off|broken)\**\s*(?:[—–:]|--?)?\s*(.*)$/i;
const imageName = /\.(?:webp|png|jpe?g)$/i;
/** Rulebook ids (S1, L5, B10, U4…) a text names, once each; kit ux uses it for the rules a bundle cites. */
export const citedRules = text => [...new Set([...text.matchAll(/\b[SLBU]\d+\b/g)].map(match => match[0]))];
const ruleIds = citedRules;

/**
 * Read the reviewer's answer: one verdict per expected feature and the rules it names as broken.
 * An answer missing a feature, or giving one feature two verdicts, is unreadable.
 */
export function parseUxResult(text, ids) {
  const found = new Map(), rules = new Set();
  let inRules = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const rulesLine = /^[-*\s]*\**Rules broken\**\s*:\s*(.*)$/i.exec(line);
    if (rulesLine) { inRules = true; for (const id of ruleIds(rulesLine[1])) rules.add(id); continue; }
    if (inRules && /^[-*]\s/.test(line) && !verdictLine.test(line)) { for (const id of ruleIds(line)) rules.add(id); continue; }
    inRules = false;
    const match = verdictLine.exec(line);
    if (!match || !ids.includes(match[1])) continue;
    const [id, word, rest] = [match[1], match[2].toLowerCase(), match[3]];
    // The last part names the image only when it looks like one (or says none); a dash inside the note stays in it.
    const dashes = rest.split(/\s+(?:[—–]|--)\s+/), hyphens = rest.split(/\s+-\s+/);
    const parts = (dashes.length > 1 || hyphens.length < 2 ? dashes : hyphens).map(part => part.trim()).filter(Boolean);
    const last = parts.length > 1 ? parts.at(-1).replace(/^`|`$/g, "") : "";
    let image = "";
    if (imageName.test(last)) { parts.pop(); image = last; }
    else if (/^none\.?$/i.test(last)) parts.pop();
    const entry = { id, verdict: verdicts[word], note: parts.join(" — "), image };
    const earlier = found.get(id);
    if (earlier && earlier.verdict !== entry.verdict) return { readable: false, problem: `two verdicts for ${id}` };
    if (!earlier) found.set(id, entry);
  }
  const missing = ids.filter(id => !found.has(id));
  if (missing.length) return { readable: false, problem: `no verdict for ${missing.join(", ")}` };
  const features = ids.map(id => found.get(id));
  // A rule cited on a looks off or broken line is broken even when the closing list forgets it.
  for (const feature of features) if (feature.verdict !== "fine") for (const id of ruleIds(feature.note)) rules.add(id);
  return { readable: true, features, rules: [...rules].sort() };
}

/** Counts for the scoreboard: features per verdict and the rule ids broken. */
export function uxCounts({ features, rules }) {
  const counts = { fine: 0, off: 0, broken: 0, rules };
  for (const feature of features) counts[feature.verdict]++;
  return counts;
}

/** ux.md: one line per feature with the image path, then the rules broken with their first lines. */
export function uxReport({ branch, model, effort, bundle, features, rules, ruleText = new Map() }) {
  const word = Object.fromEntries(Object.entries(verdicts).map(([text, key]) => [key, text]));
  return [
    `# UX review: ${branch}`,
    "",
    `Reviewer: ${model} (${effort}). Bundle: ${bundle}/bundle.md`,
    "",
    ...features.map(feature => `- ${feature.id}: ${word[feature.verdict]} — ${feature.note || "no note"} — ${!feature.image ? "none" : feature.image.startsWith("/") ? feature.image : `${bundle}/${feature.image}`}`),
    "",
    `Rules broken: ${rules.length ? rules.map(id => ruleText.has(id) ? `${id} (${ruleText.get(id)})` : id).join("; ") : "none"}`,
    "",
  ].join("\n");
}
