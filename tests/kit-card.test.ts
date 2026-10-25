import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const script = resolve("scripts/agents/context-card.mjs");
const kit = resolve("scripts/agents/kit");
const hooks = resolve("scripts/agents/hooks");
const noNotes = "context card: no notes for this project yet\n";

function fixture(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "kit-card-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const memory = join(home, "memory");
  const projects = join(home, "Projects");
  for (const folder of ["site", "site-build-x/src", "site-starter", "other", "unmapped"]) mkdirSync(join(projects, folder), { recursive: true });
  mkdirSync(join(memory, "project-notes"), { recursive: true });
  mkdirSync(join(memory, "corrections"));
  writeFileSync(join(memory, "project-notes/README.md"), [
    "# Project notes", "", "| Slug | T3 project title | Project ID | Workspace |", "| --- | --- | --- | --- |",
    `| projects | Projects | \`p\` | \`${projects}\` |`,
    "| site | Site | `s` | `~/Projects/site` and its worktrees (github.com/x/site) |",
    "| site-starter | Site starter | `t` | `~/Projects/site-starter` |",
    "| other | Other | `o` | `~/Projects/other` |", "",
  ].join("\n"));
  const decisions = ["2026-10-20", "2026-10-24", "2026-10-21", "2026-10-23", "2026-10-22", "2026-10-19", "2026-10-24"]
    .map((date, index) => `- ${date} · decision ${index} · [thread](t3-thread://v1/x)`);
  writeFileSync(join(memory, "project-notes/site.md"), [
    "# Site", "", "Project ID `s` · corrections: `../corrections/site.md` · updated 2026-10-24", "",
    "## Current thinking", "x".repeat(200), "Second thought.", "",
    "## Recent decisions", ...decisions, "",
    "## Open questions", "- 2026-10-21 · question one", "",
  ].join("\n"));
  writeFileSync(join(memory, "project-notes/site-starter.md"), "# Site starter\n\n## Current thinking\nStarter thinking.\n");
  writeFileSync(join(memory, "corrections/site.md"), [
    "# Site", "", "## Corrections", "",
    "- 2026-10-24 · fault · new · repeats: 2026-10-01 · [t](t3-thread://v1/x)",
    "- 2026-10-20 · workflow · new · repeats: first · [t](t3-thread://v1/x)",
    "- 2026-10-12 · fault · old · repeats: first · [t](t3-thread://v1/x)",
    "- 2026-10-01 · fault · older · repeats: first · [t](t3-thread://v1/x)", "",
  ].join("\n"));
  const env = { ...process.env, HOME: home, CHAT_MEMORY_DIR: memory, TZ: "UTC" };
  const card = (cwd: string, extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(process.execPath, [script], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  return { home, memory, projects, env, card };
}

test("card finds the workspace slug, cuts long lines and keeps the newest five decisions", (t) => {
  const f = fixture(t);
  const lines = f.card(join(f.projects, "site")).trimEnd().split("\n");
  assert.equal(lines[0], "Context card: Site (updated 2026-10-24)");
  assert.equal(lines[1], "Current thinking:");
  assert.equal(lines[2], `${"x".repeat(159)}…`);
  assert.equal(lines[2].length, 160);
  assert.equal(lines[3], "Second thought.");
  assert.equal(lines[4], "Recent decisions:");
  assert.deepEqual(lines.slice(5, 10).map((line) => line.split(" · ")[1]), ["decision 1", "decision 6", "decision 3", "decision 4", "decision 2"]);
  assert.deepEqual(lines.slice(10, 12), ["Open questions:", "- 2026-10-21 · question one"]);
  assert.equal(lines.length, 14);
  assert.equal(lines.at(-1), "More: ask for the full note.");
});

test("card counts corrections from the last 14 days and the repeated ones", (t) => {
  const f = fixture(t);
  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(f.memory, "corrections/site.md"), [
    "## Corrections",
    `- ${ago(1)} · fault · new · repeats: ${ago(20)} · [t](t3-thread://v1/x)`,
    `- ${ago(5)} · workflow · new · repeats: first · [t](t3-thread://v1/x)`,
    `- ${ago(13)} · fault · inside the window · repeats: first · [t](t3-thread://v1/x)`,
    `- ${ago(20)} · fault · outside the window · repeats: 2026-09-01 · [t](t3-thread://v1/x)`,
  ].join("\n"));
  const lines = f.card(join(f.projects, "site")).trimEnd().split("\n");
  assert.equal(lines.at(-2), "corrections (14 days): 3, repeated: 1 — ~/memory/corrections/site.md");
  rmSync(join(f.memory, "corrections/site.md"));
  assert.ok(!f.card(join(f.projects, "site")).includes("corrections ("));
});

test("card treats sibling worktrees and their folders as the project, but a mapped sibling keeps its own slug", (t) => {
  const f = fixture(t);
  assert.match(f.card(join(f.projects, "site-build-x")), /^Context card: Site \(updated 2026-10-24\)\n/);
  assert.match(f.card(join(f.projects, "site-build-x/src")), /^Context card: Site /);
  assert.match(f.card(join(f.projects, "site-starter")), /^Context card: Site starter\nCurrent thinking:\nStarter thinking\.\nMore: ask for the full note\.\n$/);
});

test("card keeps to 30 lines with the footer last", (t) => {
  const f = fixture(t);
  const questions = Array.from({ length: 40 }, (_, index) => `- 2026-10-2${index % 10} · question ${index}`);
  writeFileSync(join(f.memory, "project-notes/site.md"), ["# Site", "## Current thinking", "Now.", "## Open questions", ...questions].join("\n"));
  const lines = f.card(join(f.projects, "site")).trimEnd().split("\n");
  assert.equal(lines.length, 30);
  assert.equal(lines[27], "- 2026-10-23 · question 23");
  assert.match(lines[28], /^corrections \(14 days\): /);
  assert.equal(lines[29], "More: ask for the full note.");
});

test("missing note, missing slug and missing folder each print one line and exit 0", (t) => {
  const f = fixture(t);
  assert.equal(f.card(join(f.projects, "other")), noNotes);
  assert.equal(f.card(tmpdir()), noNotes);
  assert.equal(f.card(join(f.projects, "site"), { CHAT_MEMORY_DIR: join(f.home, "missing") }), noNotes);
  writeFileSync(join(f.memory, "project-notes/README.md"), "# Project notes\n");
  assert.equal(f.card(join(f.projects, "site")), noNotes);
});

test("hook mode reads the payload cwd and prints SessionStart context through run.sh", (t) => {
  const f = fixture(t);
  const hook = (payload: unknown) => {
    const result = spawnSync("/bin/bash", [join(hooks, "run.sh"), "context-card"], {
      cwd: f.home, env: { ...f.env, CLAUDE_PROJECT_DIR: resolve(".") }, input: JSON.stringify(payload), encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  };
  const output = hook({ hook_event_name: "SessionStart", source: "startup", cwd: join(f.projects, "site-build-x") });
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /^Context card: Site \(updated 2026-10-24\)\n[\s\S]*More: ask for the full note\.$/);
  assert.equal(hook({ hook_event_name: "SessionStart", cwd: f.home }).hookSpecificOutput.additionalContext, noNotes.trimEnd());
});

test("kit card prints the card for the kit root with a RESULT line", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.memory, "project-notes/README.md"), `| Slug | Workspace |\n| --- | --- |\n| site | \`${resolve(".")}\` |\n`);
  const result = spawnSync("/bin/bash", [kit, "card"], { cwd: f.home, env: { ...f.env, KIT_ROOT: resolve(".") }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Context card: Site \(updated 2026-10-24\)\n[\s\S]*\nRESULT: ok card 14 lines\n$/);
  rmSync(join(f.memory, "project-notes/site.md"));
  const empty = spawnSync("/bin/bash", [kit, "card"], { cwd: f.home, env: { ...f.env, KIT_ROOT: resolve(".") }, encoding: "utf8" });
  assert.equal(empty.stdout, `${noNotes}RESULT: ok card no notes\n`);
});
