import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

// kit rulebook (kitchen-everywhere 20): the shared rulebook with the kit, then the project's extras;
// docs/agents/kitchen.md is the pointer that keeps every old heading's link working.
const kit = resolve("scripts/agents/kit");
const shared = "scripts/agents/docs/kitchen.md";
const extras = "docs/agents/kitchen-extras.md";
const template = "scripts/agents/docs/kitchen-extras-template.md";
const pointer = "docs/agents/kitchen.md";
const read = (path: string) => readFileSync(resolve(path), "utf8");

function rulebook(t: TestContext, settings: Record<string, unknown> | null, files: Record<string, string> = {}, ...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "kit-rulebook-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({ ...(settings ? { "scripts/agents/kit.json": JSON.stringify(settings) } : {}), ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, KIT_ROOT: root };
  delete env.KIT_HOME;
  delete env.KIT_HOME_DEFAULT;
  return { root, ...spawnSync(kit, ["rulebook", ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 }) };
}

const project = { project: "p", branches: { land: "main" } };

test("kit rulebook prints the shared rulebook, then this editor's extras", () => {
  const result = spawnSync(kit, ["rulebook"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, `${read(shared)}\n${read(extras)}RESULT: ok rulebook shared and ${extras}\n`);
  assert.equal(JSON.parse(read("scripts/agents/kit.json")).rulebookExtras, extras);
});

test("an extras path may be absolute; without rulebookExtras only the shared part prints, saying so", t => {
  const own = rulebook(t, { ...project, rulebookExtras: "notes/extras.md" }, { "notes/extras.md": "# Own extras\n" });
  assert.equal(own.status, 0, own.stderr);
  assert.ok(own.stdout.endsWith(`\n# Own extras\nRESULT: ok rulebook shared and notes/extras.md\n`), own.stdout);
  assert.ok(own.stdout.startsWith(read(shared)));
  const absolute = join(own.root, "notes/extras.md");
  const elsewhere = rulebook(t, { ...project, rulebookExtras: absolute });
  assert.equal(elsewhere.status, 0, elsewhere.stdout);
  assert.ok(elsewhere.stdout.endsWith(`\n# Own extras\nRESULT: ok rulebook shared and ${absolute}\n`), elsewhere.stdout);
  const none = rulebook(t, project);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, `${read(shared)}\nNo project extras: add "rulebookExtras" to scripts/agents/kit.json.\nRESULT: ok rulebook shared only\n`);
});

test("a named extras file that is missing, or a folder, fails after the shared part", t => {
  for (const [path, files] of [["docs/gone.md", {}], ["docs", { "docs/x.md": "x\n" }]] as const) {
    const result = rulebook(t, { ...project, rulebookExtras: path }, files);
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stdout.startsWith(read(shared)));
    assert.ok(result.stdout.endsWith(`RESULT: fail rulebook extras ${path} cannot be read\n`), result.stdout);
  }
});

test("kit rulebook takes no arguments and answers --help", t => {
  const extra = rulebook(t, project, {}, "more");
  assert.equal(extra.status, 2);
  assert.equal(extra.stderr, "Usage: kit rulebook\n");
  assert.equal(extra.stdout, "RESULT: fail rulebook unknown argument more\n");
  const help = rulebook(t, project, {}, "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: kit rulebook\n.*rulebookExtras/s);
});

/** GitHub's heading anchors: punctuation dropped, spaces to dashes, a repeat numbered. */
function anchors(markdown: string): string[] {
  const seen = new Map<string, number>();
  return markdown.split("\n").filter(line => /^#+ /.test(line)).map(line => {
    const base = line.replace(/^#+ /, "").toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  });
}

test("every relative link and anchor in the rulebook's files resolves", () => {
  for (const path of [shared, extras, template, pointer]) {
    for (const [, target] of read(path).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^https?:/.test(target)) continue;
      const [file, anchor] = target.split("#");
      const full = file ? resolve(dirname(path), file) : resolve(path);
      assert.ok(existsSync(full), `${path}: missing ${target}`);
      if (anchor) assert.ok(anchors(readFileSync(full, "utf8")).includes(anchor), `${path}: no heading for ${target}`);
    }
  }
});

test("the pointer keeps every heading the old kitchen.md had, each linking to the shared part", () => {
  const old = ["house-rules", "who-cooks-pins-from-2026-10-22", "stations", "1-idea", "2-map-and-questions",
    "3-mock-up-before-any-visible-build", "4-tickets", "5-hand-out", "6-build", "7-checks", "8-review", "9-land",
    "10-preview-note-scoreboard", "11-lexs-end-check", "12-release", "ux-confidence-ladder", "weekly-routines",
    "tuesday-review", "small-chores-on-free-models"];
  assert.deepEqual(anchors(read(pointer)).slice(1), old);
  for (const block of read(pointer).split(/^#+ .*$/m).slice(2)) assert.match(block, /\[Shared\]\(\.\.\/\.\.\/scripts\/agents\/docs\/kitchen\.md#/);
  assert.match(read("AGENTS.md"), /`docs\/agents\/kitchen\.md` \(the kitchen rulebook\)/);
});

test("the shared rulebook names no editor-only fact and links only inside the kit", () => {
  const text = read(shared);
  for (const fact of ["src/main.ts", "npm run", "kit preview", "kit shots", "kit specs", "kit size", "features.md", "deploy:techies",
    "NATIVE-PROJECT", "native-site-editor", "iPhone", "`dev`", "origin/dev", "software-factory"])
    assert.ok(!text.includes(fact), `the shared rulebook names ${fact}; move it to the extras`);
  for (const [, target] of text.matchAll(/\]\(([^)\s#]+)[^)]*\)/g)) {
    if (/^https?:/.test(target)) continue;
    assert.ok(resolve(dirname(shared), target).startsWith(`${resolve("scripts/agents")}/`), `${target} leaves the kit`);
  }
  // kit next reads these two rows; their first backticked word is the model.
  assert.match(text, /^\| Builder, every slice \| `claude-[^`]+`/m);
  assert.match(text, /^\| Review, every change \| `claude-[^`]+`/m);
});
