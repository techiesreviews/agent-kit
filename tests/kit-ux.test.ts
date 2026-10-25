import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

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
  entry("F-media-03", ["src/page-builder/media-adding-*.ts"], { phone: "no" }),
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
});

test("flags: --all and --features exclude each other, ids are checked and values required", () => {
  assert.deepEqual(ux.parseArgs([]), { base: "origin/dev", features: [], all: false, noReview: false, ticket: undefined });
  assert.deepEqual(ux.parseArgs(["--features", "F-media-01,F-pages-08,F-media-01", "--base", "dev", "--no-review"]).features, ["F-media-01", "F-pages-08"]);
  assert.equal(ux.parseArgs(["--all"]).all, true);
  for (const args of [["--all", "--features", "F-media-01"], ["--features", "media"], ["--features"], ["--base"], ["--all", "--all"], ["--nope"]]) assert.throws(() => ux.parseArgs(args), args.join(" "));
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
  // FAIL_EXIT_ONLY exits 1 from a screens run whose shots all passed, and SLEEP keeps it running.
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
const files = [...shots.flatMap(shot => shot.files), { path: "contact.webp", bytes: 4 }, ...args[0] === "--steps" ? [{ path: "media-gallery-1280-light-search-strip.webp", bytes: 4 }] : []];
for (const file of files) writeFileSync(join(out, file.path), "webp");
const layoutFindings = fail ? [] : [{ screen: screens[0], width: widths[0], theme: "light", finding: { kind: "tap-target", selector: "button.tiny", text: "", detail: "20x20 px" } }];
writeFileSync(join(out, "index.json"), JSON.stringify({ version: 1, screens: shots, files, failures: [], outputFailures: [], layoutFindings }));
process.exit(fail || (process.env.FAIL_EXIT_ONLY && args[0] !== "--steps") ? 1 : 0);
`);
  chmodSync(join(root, ".scratch/shots.mjs"), 0o755);
  const run = (args: string[] = [], extra: NodeJS.ProcessEnv = {}) => {
    const output = spawnSync(kit, ["ux", ...args], { cwd: root, env: { ...env, KIT_UX_SHOTS: join(root, ".scratch/shots.mjs"), ...extra }, encoding: "utf8", timeout: 30_000 });
    const lines = output.stdout.trimEnd().split("\n");
    assert.equal(lines.filter(line => line.startsWith("RESULT: ")).length, 1, output.stdout + output.stderr);
    return { ...output, result: lines.at(-1) ?? "" };
  };
  const calls = () => existsSync(join(root, ".scratch/calls.jsonl")) ? readFileSync(join(root, ".scratch/calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { root, put, run, calls };
}

test("kit ux reports nothing visible touched without starting kit shots", t => {
  const { put, run, calls } = fixture(t);
  put("docs/notes.md", "changed\n");
  const output = run();
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.result, "RESULT: ok ux nothing visible touched");
  assert.deepEqual(calls(), []);
});

test("kit ux tries touched features, runs scripted checks and writes a bounded bundle", t => {
  const { root, put, run, calls } = fixture(t);
  put("src/page-builder/media-picker.css", ".a { gap: var(--space); }\n.media__badge { gap: 6px; color: #fff; }\n");
  put("src/page-builder/media-library-filter.ts", 'export const note = "Choose a filter to see only the pictures, videos or documents you need today.";\n');
  const output = run();
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const bundle = /bundle (\S+)$/.exec(output.result)![1];
  assert.match(output.result, /^RESULT: ok ux 1 features tried, 5 scripted findings, bundle /);
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
  assert.match(output.result, /^RESULT: fail ux 1 features tried, 0 scripted findings, bundle \S+, broken: F-media-01$/);
  assert.match(output.stdout, /try F-media-01: failed: media-gallery 390 light: step expect visible "Nowhere" failed: expect visible "Nowhere" failed: nothing visible says "Nowhere"/);
  assert.equal(calls().length, 1);
  const all = run(["--all"]);
  assert.match(all.result, /^RESULT: ok ux 1 features tried, 1 scripted findings, /);
  assert.deepEqual(calls().slice(1).map((args: string[]) => args[0]), ["--steps", "media-gallery"], "F-media-03 maps to no screen");
  const bad = run(["--features", "F-media-09"]);
  assert.equal(bad.status, 1);
  assert.equal(bad.result, "RESULT: fail ux unknown feature: F-media-09");
});

test("kit ux fails a screens run that exits non-zero even when every shot passed", t => {
  const { run } = fixture(t);
  const output = run(["--features", "F-media-02"], { FAIL_EXIT_ONLY: "1" });
  assert.equal(output.status, 1);
  assert.match(output.result, /^RESULT: fail ux 0 features tried, 1 scripted findings, bundle \S+, screens failed: media-gallery$/);
  const bundle = /bundle (\S+),/.exec(output.result)![1];
  assert.match(readFileSync(join(bundle, "bundle.md"), "utf8"), /- F-media-02 Feature F-media-02: untried \(screens media-gallery; a screen failed\)/);
});

test("kit ux stops at a signal: no further try starts and one fail RESULT is printed", async t => {
  const { root, calls } = fixture(t);
  const child = spawn(kit, ["ux", "--all"], { cwd: root, env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: root, ASE_OWNER: "ux-test", KIT_UX_SHOTS: join(root, ".scratch/shots.mjs"), SLEEP: "1" } });
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
