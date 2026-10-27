import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { screens } from "../scripts/agents/shots/core";

const script = resolve("scripts/agents/kit.d/ux"), kit = resolve("scripts/agents/kit");
// Node loads this extensionless executable as ESM; a URL keeps tsx from resolving it as TS.
// The plain-JavaScript module has no declarations; this shape types every fake handed to it.
type Feature = { id: string; name: string; try: string; good: string; files: string[]; phone: boolean; steps: string | null; matched?: string[] };
type Added = { file: string; line: number; text: string };
type Finding = { rule: string; file: string; line?: number; text: string };
type CssFile = { file: string; text: string; base: string };
type Section = { title: string; priority: number; lines: string[] };
type Image = { name: string; source: string; bytes: number; priority: number };
type LayoutTry = { dir: string; index: { screens: { screen: string; width: number; theme: string; files: { path: string; bytes: number }[] }[]; layoutFindings: { screen: string; width: number; theme: string; finding: { kind: string; selector: string; text: string; detail: string } }[] } };
type Layout = { tap: boolean; rule: string; screen: string; kind: string; selector: string; detail: string; sizes: string[]; shot: string };
type Ux = {
  bundleLimit: number;
  screenFiles: Record<string, string[]>;
  parseArgs(args: string[]): { base: string; features: string[]; all: boolean; noReview: boolean; ticket?: string };
  parseFeatures(markdown: string): Feature[];
  touchedFeatures(features: Feature[], changed: string[]): Feature[];
  selectFeatures(features: Feature[], changed: string[], flags: { all?: boolean; features?: string[] }): Feature[];
  screensFor(feature: Feature): string[];
  addedLines(diff: string): Added[];
  textFindings(added: Added[], bases?: Map<string, string>): Finding[];
  cssCounts(text: string): { px: number; timings: number };
  cssFindings(files: CssFile[], added: Added[]): Finding[];
  layoutFindings(tries: LayoutTry[]): Layout[];
  composeBundle(head: string[], sections: Section[], limit?: number): { markdown: string; trimmed: string[] };
  pickImages(images: Image[], limit?: number): { kept: Image[]; trimmed: (Image & { reason: string })[] };
  guessTicket(branch: string, files: string[]): string | undefined;
  mockupLinks(text: string, ticket: string): string[];
};
const ux: Ux = await import(pathToFileURL(script).href);

const entry = (id: string, files: string[], { phone = "yes", steps = "none yet", good = "Calm (S1)." } = {}) => [
  `### ${id} Feature ${id}`, "- Try: Open it.", `- Good: ${good}`, `- Files: ${files.map(file => `\`${file}\``).join(", ")}`,
  `- Phone: ${phone}`, "- Spec: none", `- Steps: ${steps === "none yet" ? steps : `\`${steps}\``}`, "",
].join("\n");
const featuresMarkdown = [
  "# Feature list", "", "```", "### F-bar-99 Inside a fence", "- Files: `src/a.ts`", "```", "", "## Media and the image popup", "",
  entry("F-media-01", ["src/page-builder/media-library-view.ts", "src/page-builder/media-picker.css"], { steps: "scripts/agents/shots/features/F-media-01.json", good: "Plain (S2, L2)." }),
  entry("F-media-02", ["src/page-builder/media-library-filter.ts"]),
  entry("F-media-03", ["src/page-builder/media-adding-*.ts"], { phone: "no", steps: "scripts/agents/shots/features/F-media-03.json" }),
].join("\n");

test("features parse outside fences, and a diff touches the features whose Files globs match", () => {
  const features = ux.parseFeatures(featuresMarkdown);
  assert.deepEqual(features.map(feature => feature.id), ["F-media-01", "F-media-02", "F-media-03"]);
  assert.deepEqual(features[0], {
    id: "F-media-01", name: "Feature F-media-01", try: "Open it.", good: "Plain (S2, L2).",
    files: ["src/page-builder/media-library-view.ts", "src/page-builder/media-picker.css"], phone: true, steps: "scripts/agents/shots/features/F-media-01.json",
  });
  assert.equal(features[1].steps, null);
  assert.equal(features[2].phone, false);
  const touched = ux.touchedFeatures(features, ["src/page-builder/media-picker.css", "src/page-builder/media-adding-rules.ts", "docs/x.md"]);
  assert.deepEqual(touched.map(feature => [feature.id, feature.matched]), [
    ["F-media-01", ["src/page-builder/media-picker.css"]], ["F-media-03", ["src/page-builder/media-adding-rules.ts"]],
  ]);
  assert.deepEqual(ux.touchedFeatures(features, ["scripts/agents/kit.d/ux"]), []);
  assert.deepEqual(ux.selectFeatures(features, [], { all: true }).length, 3);
  assert.deepEqual(ux.selectFeatures(features, ["src/page-builder/media-picker.css"], { features: ["F-media-02"] }).map(feature => feature.id), ["F-media-02"]);
  assert.throws(() => ux.selectFeatures(features, [], { features: ["F-media-09"] }), /unknown feature: F-media-09/);
  assert.deepEqual(ux.screensFor(features[0]), ["media-gallery"]);
  assert.deepEqual(ux.screensFor(features[2]), []);
  assert.deepEqual(Object.keys(ux.screenFiles).sort(), [...screens].sort(), "every kit shots screen maps to its files");
});

test("flags: --all and --features exclude each other, ids are checked and values required", () => {
  assert.deepEqual(ux.parseArgs([]), { base: "origin/dev", features: [], all: false, noReview: false, ticket: undefined });
  assert.deepEqual(ux.parseArgs(["--features", "F-media-01,F-pages-08,F-media-01", "--base", "dev", "--no-review"]).features, ["F-media-01", "F-pages-08"]);
  assert.equal(ux.parseArgs(["--all"]).all, true);
  for (const [args, message] of [
    [["--all", "--features", "F-media-01"], /--all and --features exclude each other/], [["--features", "media"], /--features takes F-<area>-<nn> ids/],
    [["--features"], /missing value for --features/], [["--base"], /missing value for --base/], [["--all", "--all"], /repeated flag: --all/], [["--nope"], /unknown argument: --nope/],
  ] satisfies [string[], RegExp][]) assert.throws(() => ux.parseArgs(args), message, args.join(" "));
});

const fixtureDiff = `diff --git a/src/components/panel.ts b/src/components/panel.ts
--- a/src/components/panel.ts
+++ b/src/components/panel.ts
@@ -10,0 +11,6 @@
+  note.textContent = "Drag a file here, or press the plus button to choose files from your computer.";
+  badge.className = "panel__count is-new";
+  tip.classList.add("media-tip");
+  // A comment that is long enough to look like prose for anybody reading it here.
+  label.textContent = "Short label";
+  item.innerHTML = \`<p class="row">Every picture you add is checked, resized and saved beside the page.</p>\`;
diff --git a/src/components/panel.css b/src/components/panel.css
--- a/src/components/panel.css
+++ b/src/components/panel.css
@@ -3,0 +4,2 @@
+.panel__badge, .panel__hint { gap: 6px; }
+.panel__row { transition: opacity 120ms; }
diff --git a/src/components/panel.test.ts b/src/components/panel.test.ts
--- a/src/components/panel.test.ts
+++ b/src/components/panel.test.ts
@@ -1,0 +1 @@
+const badge = "media-badge with a very long sentence that is not visible to anyone at all ever";
`;

test("text added and badge or hint classes are found on a fixture diff, with file and line", () => {
  const added = ux.addedLines(fixtureDiff);
  assert.deepEqual(added[0], { file: "src/components/panel.ts", line: 11, text: '  note.textContent = "Drag a file here, or press the plus button to choose files from your computer.";' });
  assert.deepEqual(ux.textFindings(added).map(finding => `${finding.rule} ${finding.file}:${finding.line} ${finding.text}`), [
    'S1 src/components/panel.ts:11 new visible text, 78 characters: "Drag a file here, or press the plus button to choose files f…"',
    'S2 src/components/panel.ts:12 new count or badge class "panel__count"',
    'S1 src/components/panel.ts:13 new hint or tip class "media-tip"',
    'S1 src/components/panel.ts:16 new visible text, 68 characters: "Every picture you add is checked, resized and saved beside t…"',
    'S2 src/components/panel.css:4 new count or badge class "panel__badge"',
    'S1 src/components/panel.css:4 new hint or tip class "panel__hint"',
  ]);
  // A lookup of an existing class, or a CSS selector the base already had, is not a new class.
  const lookups: Added[] = [{ file: "src/components/panel.ts", line: 3, text: 'const count = el.querySelector(".media-count");' }, { file: "src/a.css", line: 2, text: ".media-count, .new-badge { gap: 0; }" }];
  assert.deepEqual(ux.textFindings(lookups, new Map([["src/a.css", ".media-count { gap: 1px; }"]])), [{ rule: "S2", file: "src/a.css", line: 2, text: 'new count or badge class "new-badge"' }]);
  // A re-edited script line keeps its class and prose from the base: neither is new.
  const prose = "Drag a file here, or press the plus button to choose files from your computer.";
  const edited: Added[] = [{ file: "src/b.ts", line: 4, text: `pill.className = "panel__count"; pill.title = "${prose}";` }];
  assert.deepEqual(ux.textFindings(edited, new Map([["src/b.ts", `badge.className = "panel__count";\nbadge.title = "${prose}";`]])), []);
  assert.equal(ux.textFindings(edited).length, 2, "without the base both count as new");
});

test("layout findings merge across themes, keep tap targets at 390 apart and link the PNG", () => {
  const tap = { kind: "tap-target", selector: "button.tiny", text: "", detail: "20x20 px" };
  const screens = ["light", "dark"].flatMap(theme => [390, 768].map(width => ({ screen: "pages", width, theme,
    files: [{ path: `pages-${width}-${theme}-drop-strip.webp`, bytes: 1 }, { path: `pages-${width}-${theme}.png`, bytes: 1 }] })));
  const tries = [{ dir: "/t", index: { screens, layoutFindings: [
    { screen: "pages", width: 390, theme: "light", finding: tap }, { screen: "pages", width: 390, theme: "dark", finding: tap },
    { screen: "pages", width: 768, theme: "light", finding: tap },
  ] } }] satisfies LayoutTry[];
  assert.deepEqual(ux.layoutFindings(tries), [
    { tap: true, rule: "U6", screen: "pages", kind: "tap-target", selector: "button.tiny", detail: "20x20 px", sizes: ["390 light", "390 dark"], shot: "/t/pages-390-light.png" },
    { tap: false, rule: "U6", screen: "pages", kind: "tap-target", selector: "button.tiny", detail: "20x20 px", sizes: ["768 light"], shot: "/t/pages-768-light.png" },
  ]);
});

test("raw px spacing and timings count against the base and report only increases", () => {
  assert.deepEqual(ux.cssCounts(".a { gap: 6px; margin: 0 4px; width: 20px; transition: opacity 120ms, transform .2s; } /* padding: 9px */"), { px: 2, timings: 2 });
  const added = ux.addedLines(fixtureDiff);
  const findings = ux.cssFindings(([
    { file: "src/components/panel.css", text: ".a { gap: var(--space); }\n.b {}\n.c {}\n.panel__badge { gap: 6px; }\n.panel__row { transition: opacity 120ms; }", base: ".a { gap: var(--space); }" },
    { file: "src/components/same.css", text: ".a { gap: 4px; }", base: ".a { gap: 2px; }" },
  ] satisfies CssFile[]), added);
  assert.deepEqual(findings, [{ rule: "L2", file: "src/components/panel.css", line: 4, text: "raw px spacing 0 → 1, raw timings 0 → 1 (not blocking until tokens exist)" }]);
  // A value on a continuation line, in a file the added lines do not cover, still names its line.
  assert.deepEqual(ux.cssFindings([{ file: "fixtures/site.css", text: ".a {\n  /* gap: 1px */\n  padding:\n    4px 8px;\n}", base: "" }], added), [
    { rule: "L2", file: "fixtures/site.css", line: 4, text: "raw px spacing 0 → 2 (not blocking until tokens exist)" },
  ]);
});

test("the bundle stays under 60 KB and 12 images, trims the lowest-value items first and names the trims", () => {
  const many = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `- ${prefix} ${i} ${"x".repeat(200)}`);
  const { markdown, trimmed } = ux.composeBundle(["# UX bundle", "head"], ([
    { title: "Tries", priority: 9, lines: ["- F-media-01 passed"] },
    { title: "Scripted findings", priority: 6, lines: many("finding", 400) },
    { title: "Diff summary", priority: 1, lines: many("diff", 400) },
  ] satisfies Section[]));
  assert.ok(Buffer.byteLength(markdown) < ux.bundleLimit, String(Buffer.byteLength(markdown)));
  assert.equal(trimmed.length, 2);
  assert.match(trimmed[0], /^Scripted findings \d+ lines$/);
  assert.equal(trimmed[1], "Diff summary 400 lines", "the diff summary goes first and whole");
  assert.match(markdown, /Trimmed to stay under 60000 bytes: Scripted findings \d+ lines, Diff summary 400 lines\./);
  assert.match(markdown, /- F-media-01 passed/);
  assert.match(markdown, /- finding 0 /, "the first findings stay");
  const small = ux.composeBundle(["# UX bundle"], [{ title: "Tries", priority: 9, lines: ["- ok"] }, { title: "Empty", priority: 1, lines: [] }]);
  assert.deepEqual(small, { markdown: "# UX bundle\n\n## Tries\n\n- ok\n", trimmed: [] });
  const images = Array.from({ length: 20 }, (_, i) => ({ name: `image-${i}`, source: `/x/${i}`, bytes: i === 0 ? 300_001 : 1000, priority: i % 3 }) satisfies Image);
  const { kept, trimmed: dropped } = ux.pickImages(images);
  assert.equal(kept.length, 12);
  assert.ok(kept.every(image => image.bytes <= 300_000));
  assert.deepEqual(kept.slice(0, 6).map(image => image.priority), [0, 0, 0, 0, 0, 0]);
  assert.equal(dropped.length, 8);
  assert.deepEqual(dropped.find(image => image.name === "image-0")?.reason, "over 300 KB");
});

test("the ticket comes from the branch name, and its mock-up links resolve against it", () => {
  const files = ["docs/wayfinder/a/build/tickets/42-kit-ux-scripted.md", "docs/wayfinder/a/build/tickets/2-scripted.md", "docs/agents/kit-ux-scripted.md"];
  assert.equal(ux.guessTicket("build/sf-42-kit-ux-scripted", files), files[0]);
  assert.equal(ux.guessTicket("build/other", files), undefined);
  assert.deepEqual(ux.mockupLinks("Intro\nThe approved [mock-up](../mockups/panel.html) and https://example.test/mockup.png.\nOther [link](x.md)", "docs/wayfinder/a/build/tickets/42.md"), [
    "- mock-up: docs/wayfinder/a/build/mockups/panel.html", "- https://example.test/mockup.png.",
  ]);
});

function fixture(t: TestContext, gitConfig: [string, string][] = []) {
  const root = mkdtempSync(join(tmpdir(), "kit-ux-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: root, ASE_OWNER: "ux-test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => {
    const output = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr);
    return output.stdout.trim();
  };
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  git("init", "--quiet", "--initial-branch=build/sf-1-panel");
  git("config", "user.name", "Kit ux test");
  git("config", "user.email", "kit-ux@example.test");
  for (const [key, value] of gitConfig) git("config", key, value);
  put(".gitignore", ".scratch/\n");
  put("docs/agents/features.md", featuresMarkdown);
  put("docs/agents/ux-rulebook.md", "# UX rulebook\n- **S1** No explainer lines.\n- **S2** No counts or badges.\n- **L2** Only theme tokens.\n- **U6** Touch never sticks.\n");
  put("docs/w/build/tickets/1-panel.md", "Approved [mock-up](../mockups/panel.html).\n");
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n");
  put("src/page-builder/media-library-filter.ts", "export {};\n");
  git("add", "."); git("commit", "--quiet", "-m", "base");
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  // The fake kit shots writes one shot per width and theme, a contact sheet and a strip; FAIL_STEP fails every shot,
  // BIG_STRIP makes the strip 300,001 bytes, FAIL_EXIT_ONLY exits 1 from a screens run whose shots all passed, and SLEEP keeps it running.
  put(".scratch/shots.mjs", `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, ".scratch/calls.jsonl"))}, JSON.stringify(args) + "\\n");
if (process.env.SLEEP) await new Promise(resolve => setTimeout(resolve, 20_000));
const out = args[args.indexOf("--out") + 1], widths = args[args.indexOf("--width") + 1].split(",").map(Number);
const screens = args[0] === "--steps" ? ["media-gallery"] : args.slice(0, args.indexOf("--width"));
const fail = process.env.FAIL_STEP;
const shots = screens.flatMap(screen => widths.flatMap(width => ["light", "dark"].map(theme => ({ screen, width, theme, ok: !fail, attempts: 1,
  failures: fail ? [{ attempt: 1, step: fail, error: fail + " failed: nothing visible says \\"Nowhere\\"\\nCall log" }] : [],
  files: fail ? [] : [{ path: screen + "-" + width + "-" + theme + ".png", bytes: 9 }], layout: [] }))));
const files = [...shots.flatMap(shot => shot.files), { path: "contact.webp", bytes: 4 }, ...args[0] === "--steps" ? [{ path: "media-gallery-1280-light-search-strip.webp", bytes: process.env.BIG_STRIP ? 300_001 : 4 }] : []];
for (const file of files) writeFileSync(join(out, file.path), "webp");
const layoutFindings = fail ? [] : [{ screen: screens[0], width: widths[0], theme: "light", finding: { kind: "tap-target", selector: "button.tiny", text: "", detail: "20x20 px" } }];
writeFileSync(join(out, "index.json"), JSON.stringify({ version: 1, screens: shots, files, failures: [], outputFailures: [], layoutFindings }));
process.exit(fail || (process.env.FAIL_EXIT_ONLY && args[0] !== "--steps") ? 1 : 0);
`);
  chmodSync(join(root, ".scratch/shots.mjs"), 0o755);
  // The fake reviewer answers fine for every feature the brief lists; FAKE_VERDICTS maps an id to another verdict,
  // FAKE_ANSWER replaces the whole answer and FAKE_AGENT_FAIL fails like agent.sh. It keeps its brief and the bundle it read.
  put(".scratch/agent.mjs", `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, ".scratch/agent-calls.jsonl"))}, JSON.stringify(args) + "\\n");
const brief = readFileSync(args[2], "utf8"), out = args[args.indexOf("--out") + 1];
writeFileSync(${JSON.stringify(join(root, ".scratch/last-brief.md"))}, brief);
const bundle = /^Judge only what is in the bundle: (\\S+)\\/bundle\\.md/m.exec(brief)[1];
copyFileSync(join(bundle, "bundle.md"), ${JSON.stringify(join(root, ".scratch/last-bundle.md"))});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "run.log"), JSON.stringify({ type: "result", modelUsage: { [args[args.indexOf("--model") + 1]]: { inputTokens: 1000, outputTokens: 200 } } }) + "\\n");
if (process.env.FAKE_COMMIT) execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "moved"], { cwd: ${JSON.stringify(root)} });
if (process.env.FAKE_AGENT_FAIL) { console.error("problem: claude failed (1); see " + join(out, "run.log")); process.exit(1); }
const ids = /^Features to judge: (.+)$/m.exec(brief)[1].split(", "), verdicts = JSON.parse(process.env.FAKE_VERDICTS || "{}");
const note = verdict => verdict === "fine" ? "matches its Good line" : verdict === "broken" ? "the search field is covered by the bar" : "S1: a hint line sits under the search field";
const answer = process.env.FAKE_ANSWER ?? ["REVIEW_STATUS: complete", ...ids.map(id => id + ": " + (verdicts[id] ?? "fine") + " — " + note(verdicts[id] ?? "fine") + " — screens-contact.webp"),
  "Rules broken: " + (Object.values(verdicts).includes("looks off") ? "S1" : "none")].join("\\n");
writeFileSync(join(out, "out.md"), answer + "\\n");
console.log(answer);
`);
  chmodSync(join(root, ".scratch/agent.mjs"), 0o755);
  const tools = { KIT_UX_SHOTS: join(root, ".scratch/shots.mjs"), KIT_UX_AGENT: join(root, ".scratch/agent.mjs") };
  const run = (args: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
    const output = spawnSync(kit, ["ux", ...args], { cwd: root, env: { ...env, ...tools, ...extra }, encoding: "utf8", timeout: 30_000 });
    const lines = output.stdout.trimEnd().split("\n");
    assert.equal(lines.filter(line => line.startsWith("RESULT: ")).length, 1, output.stdout + output.stderr);
    return { ...output, result: lines.at(-1) ?? "" };
  };
  const lines = (file: string) => existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const calls = () => lines(".scratch/calls.jsonl"), agentCalls = (): string[][] => lines(".scratch/agent-calls.jsonl");
  return { root, env, git, put, run, calls, agentCalls, tools };
}

test("kit ux reports nothing visible touched without starting kit shots", t => {
  const { put, run, calls } = fixture(t);
  put("docs/notes.md", "changed\n");
  const output = run();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result, "RESULT: ok ux nothing visible touched");
  assert.deepEqual(calls(), []);
});

test("kit ux takes screenshots through the project's own shots and says when there is none", t => {
  const { root, put, run, calls } = fixture(t);
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n.b { gap: var(--space); }\n");
  const real = { KIT_UX_SHOTS: undefined, KIT_COMMANDS_DIR: undefined };
  const noFolder = run(["--no-review"], real);
  assert.equal(noFolder.status, 1, noFolder.stdout + noFolder.stderr);
  assert.equal(noFolder.result, 'RESULT: fail ux needs a project shots command (no "commands" folder in scripts/agents/kit.json)');
  put("scripts/agents/kit.json", JSON.stringify({ project: "x", branches: { land: "dev" }, commands: "own" }));
  put("own/specs", "#!/bin/sh\n");
  // A shots file that is not executable is no command, as at the kit front door.
  put("own/shots", "#!/bin/sh\n");
  chmodSync(join(root, "own/shots"), 0o644);
  const noShots = run(["--no-review"], real);
  assert.equal(noShots.status, 1, noShots.stdout + noShots.stderr);
  assert.equal(noShots.result, "RESULT: fail ux needs a project shots command (none in own)");
  assert.deepEqual(calls(), []);
  // It fails before making the bundle or tries folder.
  assert.equal(existsSync(join(root, ".scratch/ux/ux-test")), false);
  assert.equal(existsSync(join(root, ".scratch/ux-tries/ux-test")), false);
  put("own/shots.mjs", readFileSync(join(root, ".scratch/shots.mjs"), "utf8"));
  chmodSync(join(root, "own/shots.mjs"), 0o755);
  const shot = run(["--no-review"], real);
  assert.equal(shot.status, 0, shot.stdout + shot.stderr);
  assert.match(shot.result, /^RESULT: ok ux 1 features tried, /);
  assert.equal(calls().length, 1);
});

test("kit ux reads the commands folder from an incomplete settings file and names a broken one", t => {
  const { root, put, run, calls } = fixture(t);
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n.b { gap: var(--space); }\n");
  const real = { KIT_UX_SHOTS: undefined, KIT_COMMANDS_DIR: undefined };
  // No "project": the front door still finds the folder, so ux does too.
  put("scripts/agents/kit.json", JSON.stringify({ commands: "own" }));
  put("own/shots.mjs", readFileSync(join(root, ".scratch/shots.mjs"), "utf8"));
  chmodSync(join(root, "own/shots.mjs"), 0o755);
  const incomplete = run(["--no-review"], real);
  assert.equal(incomplete.status, 0, incomplete.stdout + incomplete.stderr);
  assert.match(incomplete.result, /^RESULT: ok ux 1 features tried, /);
  assert.equal(calls().length, 1);
  put("scripts/agents/kit.json", '{ "commands": ');
  const broken = run(["--no-review"], real);
  assert.equal(broken.status, 1, broken.stdout + broken.stderr);
  assert.match(broken.result, /^RESULT: fail ux scripts\/agents\/kit\.json is unreadable: /);
  assert.equal(calls().length, 1);
});

test("kit ux takes shots from KIT_COMMANDS_DIR over the settings folder, and from an absolute commands folder", t => {
  const { root, put, run, calls } = fixture(t);
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n.b { gap: var(--space); }\n");
  const fake = readFileSync(join(root, ".scratch/shots.mjs"), "utf8");
  const executable = (file: string, text: string) => { put(file, text); chmodSync(join(root, file), 0o755); };
  // The settings folder's shots fails, so a run that used it could not pass.
  put("scripts/agents/kit.json", JSON.stringify({ project: "x", branches: { land: "dev" }, commands: "own" }));
  executable("own/shots", "#!/bin/sh\nexit 7\n");
  executable(".scratch/override/shots.mjs", fake);
  // KIT_COMMANDS_DIR replaces the front door's folders too, so it holds ux as well (a wrapper: ux runs only as its own main).
  executable(".scratch/override/ux", `#!/bin/sh\nexec ${JSON.stringify(script)} "$@"\n`);
  const replaced = run(["--no-review"], { KIT_UX_SHOTS: undefined, KIT_COMMANDS_DIR: join(root, ".scratch/override") });
  assert.equal(replaced.status, 0, replaced.stdout + replaced.stderr);
  assert.match(replaced.result, /^RESULT: ok ux 1 features tried, /);
  assert.equal(calls().length, 1);
  executable(".scratch/far/shots", fake);
  put("scripts/agents/kit.json", JSON.stringify({ project: "x", branches: { land: "dev" }, commands: join(root, ".scratch/far") }));
  const absolute = run(["--no-review"], { KIT_UX_SHOTS: undefined, KIT_COMMANDS_DIR: undefined });
  assert.equal(absolute.status, 0, absolute.stdout + absolute.stderr);
  assert.match(absolute.result, /^RESULT: ok ux 1 features tried, /);
  assert.equal(calls().length, 2);
});

test("kit ux runs its checks without a project shots command when no touched feature needs a screenshot", t => {
  const { put, run, calls } = fixture(t);
  put("docs/agents/features.md", ["# Feature list", "", entry("F-plain-01", ["src/plain.ts"])].join("\n"));
  put("src/plain.ts", "export {};\n");
  const output = run(["--no-review"], { KIT_UX_SHOTS: undefined, KIT_COMMANDS_DIR: undefined });
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.match(output.result, /^RESULT: ok ux 0 features tried, \d+ scripted findings, bundle /);
  assert.doesNotMatch(output.stdout + output.stderr, /needs a project shots command/);
  assert.match(output.stdout, /^features: F-plain-01$/m);
  assert.deepEqual(calls(), []);
});

test("kit ux tries touched features, runs scripted checks and writes a bounded bundle", t => {
  const { root, put, run, calls } = fixture(t);
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n.media__badge { gap: 6px; color: #fff; }\n");
  put("src/page-builder/media-library-filter.ts", 'export const note = "Choose a filter to see only the pictures, videos or documents you need today.";\n');
  // Untracked: never added to git, still part of the diff.
  put("src/page-builder/media-library-view.ts", 'export const empty = "Your media library is empty until you add a picture, a video or a document.";\n');
  const output = run();
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  assert.match(output.result, /^RESULT: ok ux 1 features tried, 6 scripted findings, 2 fine, 0 looks off, 0 broken, bundle /);
  assert.ok(bundle.startsWith(join(root, ".scratch/ux/ux-test/")));
  assert.deepEqual(calls().map((args: string[]) => args.join(" ").replace(root, "<root>").replace(/--out \S+/, "--out <dir>")), [
    "--steps <root>/scripts/agents/shots/features/F-media-01.json --width 390,1280 --out <dir>",
    "media-gallery --width 390,1280 --out <dir>",
  ]);
  const markdown = readFileSync(join(bundle, "bundle.md"), "utf8");
  assert.ok(Buffer.byteLength(markdown) < 60_000);
  for (const line of [
    "- F-media-01 Feature F-media-01: passed (scripts/agents/shots/features/F-media-01.json)",
    "- F-media-02 Feature F-media-02: untried (screens media-gallery)",
    "- **F-media-01 Feature F-media-01** (src/page-builder/media-picker.css, src/page-builder/media-library-view.ts)",
    "- S1 src/page-builder/media-library-view.ts:1: new visible text",
    "  - Good: Plain (S2, L2).",
    "- **S2** No counts or badges.",
    "- mock-up: docs/w/build/mockups/panel.html",
    '- S2 src/page-builder/media-picker.css:2: new count or badge class "media__badge"',
    "- L2 src/page-builder/media-picker.css:2: raw colour #fff",
    "- L2 src/page-builder/media-picker.css:2: raw px spacing 0 → 1 (not blocking until tokens exist)",
  ]) assert.ok(markdown.includes(line), `${line}\n${markdown}`);
  assert.match(markdown, /- S1 src\/page-builder\/media-library-filter\.ts:1: new visible text, 77 characters/);
  assert.match(markdown, /- U6 tap target under 44 px at 390: button\.tiny — 20x20 px \(media-gallery; 390 light\) \S+media-gallery-390-light\.png/);
  const images = readdirSync(bundle).filter(name => name.endsWith(".webp"));
  assert.deepEqual(images.sort(), ["F-media-01-contact.webp", "F-media-01-media-gallery-1280-light-search-strip.webp", "screens-contact.webp"]);
  assert.ok(images.every(name => statSync(join(bundle, name)).size <= 300_000));
});

test("kit ux with --features tries only those, and a failed try names the feature and its line", t => {
  const { run, calls } = fixture(t);
  const output = run(["--features", "F-media-01"], { FAIL_STEP: 'expect visible "Nowhere"' });
  assert.equal(output.status, 1);
  assert.match(output.result, /^RESULT: fail ux 1 features tried, 0 scripted findings, 0 fine, 0 looks off, 1 broken, bundle \S+, broken: F-media-01$/);
  assert.match(output.stdout, /try F-media-01: failed: media-gallery 390 light: step expect visible "Nowhere" failed: expect visible "Nowhere" failed: nothing visible says "Nowhere"/);
  assert.equal(calls().length, 1);
  const all = run(["--all"]);
  assert.match(all.result, /^RESULT: ok ux 2 features tried, 2 scripted findings, 3 fine, /);
  assert.deepEqual(calls().slice(1).map((args: string[]) => args.slice(0, 2).join(" ").replace(/\S+features\//, "")), ["--steps F-media-01.json", "--steps F-media-03.json", "media-gallery --width"]);
  assert.deepEqual(calls()[2].slice(2, 4), ["--width", "1280"], "Phone: no tries 1280 only");
  const bad = run(["--features", "F-media-09"]);
  assert.equal(bad.status, 1);
  assert.equal(bad.result, "RESULT: fail ux unknown feature: F-media-09");
});

test("kit ux fails a screens run that exits non-zero even when every shot passed", t => {
  const { run, agentCalls } = fixture(t);
  const output = run(["--features", "F-media-02"], { FAIL_EXIT_ONLY: "1" });
  assert.equal(output.status, 1);
  assert.match(output.result, /^RESULT: fail ux 0 features tried, 1 scripted findings, bundle \S+, screens failed: media-gallery$/);
  assert.match(output.stdout, /^review: skipped, a screens run failed$/m);
  assert.deepEqual(agentCalls(), [], "no paid review when nothing a fix round answers broke");
  const bundle = /bundle (\S+),/.exec(output.result)![1];
  assert.match(readFileSync(join(bundle, "bundle.md"), "utf8"), /- F-media-02 Feature F-media-02: untried \(screens media-gallery; a screen failed\)/);
});

test("kit ux stops at a signal: no further try starts and one fail RESULT is printed", async t => {
  const { root, calls, tools } = fixture(t);
  const child = spawn(kit, ["ux", "--all"], { cwd: root, env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: root, ASE_OWNER: "ux-test", ...tools, SLEEP: "1" } });
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const closed = once(child, "close");
  const deadline = Date.now() + 15_000;
  while (!calls().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls().length, 1);
  child.kill("SIGTERM");
  const [status] = await closed;
  assert.equal(calls().length, 1, "the next try never starts");
  const results = stdout.trimEnd().split("\n").filter(line => line.startsWith("RESULT: "));
  assert.deepEqual(results, ["RESULT: fail ux interrupted by SIGTERM"]);
  assert.equal(status, 143);
});

test("kit ux reads added lines whatever the diff prefix settings", async t => {
  for (const setting of [["diff.mnemonicPrefix", "true"], ["diff.noprefix", "true"]] satisfies [string, string][]) {
    await t.test(setting[0], t => {
      const { put, run } = fixture(t, [setting]);
      put("src/page-builder/media-library-filter.ts", 'export const note = "Choose a filter to see only the pictures, videos or documents you need today.";\n');
      const output = run(["--features", "F-media-02"]);
      const bundle = /bundle (\S+)$/.exec(output.result)![1];
      assert.match(readFileSync(join(bundle, "bundle.md"), "utf8"), /- S1 src\/page-builder\/media-library-filter\.ts:1: new visible text, 77 characters/);
    });
  }
});

test("kit ux names an image it trimmed and leaves it out of the bundle", t => {
  const { run } = fixture(t);
  const output = run(["--features", "F-media-01"], { BIG_STRIP: "1" });
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /^trimmed images: 1 \(over 300 KB\)$/m);
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  assert.match(readFileSync(join(bundle, "bundle.md"), "utf8"), /^- trimmed F-media-01-media-gallery-1280-light-search-strip\.webp \(over 300 KB\): \S+$/m);
  assert.deepEqual(readdirSync(bundle).filter(name => name.endsWith(".webp")), ["F-media-01-contact.webp"]);
});

type Verdict = { id: string; verdict: "fine" | "off" | "broken"; note: string; image: string };
type Parsed = { readable: true; features: Verdict[]; rules: string[] } | { readable: false; problem: string };
const brief: {
  uxBrief(input: { bundle: string; features: { id: string }[]; images?: string[]; rules?: Map<string, string>; mockups?: string[] }): string;
  parseUxResult(text: string, ids: string[]): Parsed;
  uxCounts(input: { features: Verdict[]; rules: string[] }): { fine: number; off: number; broken: number; rules: string[] };
} = await import(pathToFileURL(resolve("scripts/agents/ux-brief.mjs")).href);

test("the reviewer's fine, looks off and broken lines parse, with their rules, notes and images", () => {
  const answer = [
    "REVIEW_STATUS: complete",
    "F-media-01: fine — the grid matches its Good line — F-media-01-contact.webp",
    "- **F-media-02**: looks off – L5: the filter label is clipped at 390 – screens-contact.webp",
    "F-media-03: broken — the add button is covered by the bar, so nothing can be added — none",
    "F-media-09: broken — not asked for — x.webp",
    "Rules broken:",
    "- S1 a hint line",
  ].join("\n");
  const parsed = brief.parseUxResult(answer, ["F-media-01", "F-media-02", "F-media-03"]);
  assert.ok(parsed.readable);
  assert.deepEqual(parsed.features, [
    { id: "F-media-01", verdict: "fine", note: "the grid matches its Good line", image: "F-media-01-contact.webp" },
    { id: "F-media-02", verdict: "off", note: "L5: the filter label is clipped at 390", image: "screens-contact.webp" },
    { id: "F-media-03", verdict: "broken", note: "the add button is covered by the bar, so nothing can be added", image: "" },
  ]);
  assert.deepEqual(parsed.rules, ["L5", "S1"], "rules from the closing list and from a looks off line");
  assert.deepEqual(brief.uxCounts(parsed), { fine: 1, off: 1, broken: 1, rules: ["L5", "S1"] });
  const dashed = brief.parseUxResult("F-media-01: looks off — L5 — gap too tight at 390\nF-media-02: fine - ok - a.webp", ["F-media-01", "F-media-02"]);
  assert.ok(dashed.readable);
  assert.deepEqual(dashed.features.map(feature => [feature.note, feature.image]), [["L5 — gap too tight at 390", ""], ["ok", "a.webp"]],
    "a dash inside the note is no image; plain hyphens still separate one");
  const late = brief.parseUxResult("Rules broken: L5\n- F-media-01: broken — covered — none", ["F-media-01"]);
  assert.ok(late.readable, "a verdict after the rules list is still read");
  assert.deepEqual([late.features[0].verdict, late.rules], ["broken", ["L5"]]);
  const none = brief.parseUxResult("REVIEW_STATUS: complete\nF-media-01: fine — ok\nRules broken: none", ["F-media-01"]);
  assert.ok(none.readable);
  assert.deepEqual(none.rules, []);
  assert.equal(none.features[0].image, "");
});

test("an answer missing a feature or giving one two verdicts is unreadable, naming which", () => {
  assert.deepEqual(brief.parseUxResult("REVIEW_STATUS: complete\nAll good.\n", ["F-media-01"]), { readable: false, problem: "no verdict for F-media-01" });
  assert.deepEqual(brief.parseUxResult("F-media-01: fine — a\nF-media-01: broken — b\n", ["F-media-01"]), { readable: false, problem: "two verdicts for F-media-01" });
  assert.deepEqual(brief.parseUxResult("F-media-01: great — a\n", ["F-media-01"]), { readable: false, problem: "no verdict for F-media-01" });
});

test("the brief keeps the reviewer on the bundle, the rulebook and the mock-up", () => {
  const text = brief.uxBrief({ bundle: "/b", features: [{ id: "F-media-01" }, { id: "F-pages-02" }], images: ["a.webp"],
    rules: new Map([["S1", "No explainer lines."]]), mockups: ["- mock-up: docs/m.html"] });
  for (const line of ["Judge only what is in the bundle: /b/bundle.md and its images (/b/a.webp).", "The approved mock-up: mock-up: docs/m.html.",
    "Features to judge: F-media-01, F-pages-02", "- S1 No explainer lines.", "never against taste of your own",
    "Without a rule id or a mock-up difference, it is fine.", "Never suggest new text, hints, tips, counts or badges.", "REVIEW_STATUS: complete"]) assert.ok(text.includes(line), line);
  assert.match(brief.uxBrief({ bundle: "/b", features: [{ id: "F-media-01" }] }), /No mock-up is named/);
});

const scoreboard = (root: string) => JSON.parse(readFileSync(join(root, ".scratch/scoreboard/_untracked/1-panel.json"), "utf8"));

test("kit ux sends the bundle to one read-only reviewer and saves ux.md, ux.json and the counts", t => {
  const { root, put, run, agentCalls } = fixture(t);
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n.b { gap: 0; }\n");
  put("src/page-builder/media-library-filter.ts", "export const filter = 1;\n");
  const output = run([], { FAKE_VERDICTS: JSON.stringify({ "F-media-02": "looks off" }) });
  assert.equal(output.status, 0, output.stderr + output.stdout);
  assert.match(output.result, /^RESULT: ok ux 1 features tried, \d+ scripted findings, 1 fine, 1 looks off, 0 broken, bundle /);
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  const [args] = agentCalls();
  // Nothing is committed past the base, so the head commit stands in as the diff scope.
  assert.deepEqual([args[0], args[1], ...args.slice(3, 9)], ["review", root, "--commit", "HEAD", "--model", "claude-opus-5-5", "--effort", "medium"]);
  const briefText = readFileSync(join(root, ".scratch/last-brief.md"), "utf8");
  const copy = /^Judge only what is in the bundle: (\S+)\/bundle\.md/m.exec(briefText)![1];
  assert.ok(copy.startsWith(join(root, ".scratch/agent/ux-review-")), "the reviewer reads a copy inside the worktree");
  assert.equal(existsSync(copy), false, "the copy is removed afterwards");
  assert.equal(readFileSync(join(root, ".scratch/last-bundle.md"), "utf8"), readFileSync(join(bundle, "bundle.md"), "utf8"));
  assert.match(briefText, /^Features to judge: F-media-01, F-media-02$/m);
  assert.match(output.stdout, /^model: claude-opus-5-5 \(medium\)$/m);
  assert.match(output.stdout, /^F-media-02: looks off — S1: a hint line sits under the search field — \S+\/screens-contact\.webp$/m);
  const report = readFileSync(join(bundle, "ux.md"), "utf8");
  assert.ok(report.includes(`- F-media-01: fine — matches its Good line — ${bundle}/screens-contact.webp`), report);
  assert.ok(report.includes("Rules broken: S1 (No explainer lines.)"), report);
  const json = JSON.parse(readFileSync(join(bundle, "ux.json"), "utf8"));
  assert.deepEqual([json.model, json.effort, json.off, json.broken], ["claude-opus-5-5", "medium", ["F-media-02"], []]);
  assert.ok(existsSync(join(bundle, "run.log")));
  const record = scoreboard(root);
  assert.deepEqual(record.ux, { fine: 1, off: 1, broken: 0, rules: ["S1"] });
  assert.deepEqual(record.cost.review, { usd: null, tokens: 1200 });
});

test("kit ux fails a broken verdict, an unreadable answer and a failed reviewer with one clear line", t => {
  const { root, run, agentCalls } = fixture(t);
  const broken = run(["--features", "F-media-02"], { FAKE_VERDICTS: JSON.stringify({ "F-media-02": "broken" }), ASE_UX_MODEL: "claude-sonnet-5-5" });
  assert.equal(broken.status, 1);
  assert.match(broken.result, /^RESULT: fail ux 0 features tried, \d+ scripted findings, 0 fine, 0 looks off, 1 broken, bundle \S+, broken: F-media-02$/);
  assert.equal(agentCalls()[0][agentCalls()[0].indexOf("--model") + 1], "claude-sonnet-5-5");
  assert.deepEqual(scoreboard(root).ux, { fine: 0, off: 0, broken: 1, rules: [] });
  const unreadable = run(["--features", "F-media-02"], { FAKE_ANSWER: "REVIEW_STATUS: complete\nLooks nice overall." });
  assert.equal(unreadable.status, 1);
  assert.match(unreadable.result, /, bundle (\S+), review unreadable: no verdict for F-media-02 \(\1\/ux\.md\)$/);
  const bundle = /bundle (\S+),/.exec(unreadable.result)![1];
  assert.match(readFileSync(join(bundle, "ux.md"), "utf8"), /Problem: no verdict for F-media-02[\s\S]*Looks nice overall\./);
  assert.equal(existsSync(join(bundle, "ux.json")), false);
  const failed = run(["--features", "F-media-02"], { FAKE_AGENT_FAIL: "1" });
  assert.equal(failed.status, 1);
  const named = /, review failed: claude failed \(1\); see (\S+run\.log)$/.exec(failed.result);
  assert.ok(named, failed.result);
  assert.ok(named[1].startsWith(`${/bundle (\S+),/.exec(failed.result)![1]}/`) && existsSync(named[1]), "the log the RESULT names sits beside the bundle");
});

test("kit ux --no-review packs the bundle without a reviewer", t => {
  const { run, agentCalls } = fixture(t);
  const output = run(["--features", "F-media-02", "--no-review"]);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.result, /^RESULT: ok ux 0 features tried, \d+ scripted findings, bundle \S+$/);
  assert.deepEqual(agentCalls(), []);
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  assert.equal(existsSync(join(bundle, "ux.json")), false);
  assert.match(readFileSync(join(bundle, "bundle.md"), "utf8"), /Model review: skipped \(--no-review\)\./);
});

test("kit ux scopes the reviewer to the merge-base once work is committed past it", t => {
  const { git, put, run, agentCalls } = fixture(t);
  put("src/page-builder/media-library-filter.ts", "export const filter = 2;\n");
  git("commit", "--quiet", "-am", "work");
  const base = git("rev-parse", "origin/dev");
  const output = run(["--features", "F-media-02"]);
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const [args] = agentCalls();
  assert.deepEqual(args.slice(3, 5), ["--base", base]);
});

test("the real agent.sh review path hands a read-only Claude the bundle copy and its answer parses", t => {
  const { root, env, git, put, run } = fixture(t);
  put("src/page-builder/media-library-filter.ts", "export const filter = 2;\n");
  git("commit", "--quiet", "-am", "work");
  // The fake claude answers only when it can read the bundle the brief names, and records its arguments and prompt.
  const bin = join(root, ".scratch/bin");
  put(".scratch/bin/claude", `#!${process.execPath}
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const prompt = readFileSync(0, "utf8"), args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(root, ".scratch/claude-call.json"))}, JSON.stringify({ args, prompt }));
const bundle = /^Judge only what is in the bundle: (\\S+)\\/bundle\\.md/m.exec(prompt)?.[1];
const seen = bundle && existsSync(bundle + "/bundle.md") && readFileSync(bundle + "/bundle.md", "utf8").includes("# UX bundle");
const result = seen ? "REVIEW_STATUS: complete\\nF-media-02: looks off — S1: a hint line under the filter — screens-contact.webp\\nRules broken: S1" : "REVIEW_STATUS: complete\\nno bundle";
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, session_id: "ux-session",
  modelUsage: { "claude-opus-5-5": { inputTokens: 300, outputTokens: 40 } } }));
`);
  chmodSync(join(bin, "claude"), 0o755);
  const output = run(["--features", "F-media-02"], { KIT_UX_AGENT: "", PATH: `${bin}:${env.PATH}`, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "20s" });
  assert.equal(output.status, 0, output.stderr + output.stdout);
  assert.match(output.result, /, 0 fine, 1 looks off, 0 broken, bundle /);
  const call = JSON.parse(readFileSync(join(root, ".scratch/claude-call.json"), "utf8"));
  assert.deepEqual(call.args.slice(0, 7), ["-p", "--model", "claude-opus-5-5", "--effort", "medium", "--permission-mode", "plan"]);
  assert.equal(call.args[call.args.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.match(call.prompt, /do not open the diff, commit log or refs files/);
  assert.match(call.prompt, /^Review scope: git diff \S+\.\.\.\S+\./m, "agent.sh still appends its scope after the brief");
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  assert.match(readFileSync(join(bundle, "run.log"), "utf8"), /"claude-opus-5-5"/);
  assert.equal(JSON.parse(readFileSync(join(bundle, "ux.json"), "utf8")).off[0], "F-media-02");
  assert.deepEqual(readdirSync(join(root, ".scratch/agent")), [], "the reviewer's copy and run folder are removed");
});

test("kit ux counts only rulebook ids as broken rules", t => {
  const { root, run } = fixture(t);
  const output = run(["--features", "F-media-02"], { FAKE_ANSWER: "REVIEW_STATUS: complete\nF-media-02: looks off — S9 and S1: a hint line — none\nRules broken: S9, S1" });
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  assert.deepEqual(JSON.parse(readFileSync(join(bundle, "ux.json"), "utf8")).rules, ["S1"]);
  assert.deepEqual(scoreboard(root).ux.rules, ["S1"]);
});

test("kit ux leaves the scoreboard alone when HEAD moved during its run", t => {
  const { root, run } = fixture(t);
  const output = run(["--features", "F-media-02"], { FAKE_COMMIT: "1" });
  assert.equal(output.status, 0, output.stderr + output.stdout);
  assert.match(output.stderr, /^problem: HEAD moved during kit ux; scoreboard not updated$/m);
  assert.equal(existsSync(join(root, ".scratch/scoreboard/_untracked/1-panel.json")), false);
});
