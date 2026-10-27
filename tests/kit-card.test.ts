import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  for (const folder of ["site", "site-build-x/src", "site-starter", "site-starter-wt", "other", "unmapped"]) mkdirSync(join(projects, folder), { recursive: true });
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
    `- ${ago(13)} · fault · first day of the window · repeats: first · [t](t3-thread://v1/x)`,
    `- ${ago(14)} · fault · day before the window · repeats: ${ago(30)} · [t](t3-thread://v1/x)`,
    `- ${ago(20)} · fault · outside the window · repeats: 2026-09-01 · [t](t3-thread://v1/x)`,
    "## Notes",
    `- ${ago(1)} · not a correction · repeats: ${ago(2)}`,
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
  symlinkSync(join(f.projects, "site-build-x"), join(f.home, "link"));
  assert.match(f.card(join(f.home, "link")), /^Context card: Site /);
  assert.match(f.card(join(f.projects, "site-starter")), /^Context card: Site starter\nCurrent thinking:\nStarter thinking\.\nMore: ask for the full note\.\n$/);
  // A worktree of the mapped sibling is a sibling of both rows; the longer workspace wins.
  assert.match(f.card(join(f.projects, "site-starter-wt")), /^Context card: Site starter\n/);
});

test("card keeps to 30 lines with the footer last", (t) => {
  const f = fixture(t);
  const questions = Array.from({ length: 40 }, (_, index) => `- 2026-10-2${index % 10} · question ${index}`);
  writeFileSync(join(f.memory, "project-notes/site.md"), ["# Site", "## Current thinking", "Now.", "## Open questions", ...questions].join("\n"));
  const lines = f.card(join(f.projects, "site")).trimEnd().split("\n");
  assert.equal(lines.length, 30);
  assert.equal(lines[27], "- 2026-10-23 · question 23");
  writeFileSync(join(f.memory, "project-notes/site.md"), ["# Site", "## Current thinking", ...Array.from({ length: 25 }, (_, index) => `Thought ${index}.`), "## Open questions", "- 2026-10-21 · cut"].join("\n"));
  assert.match(lines[28], /^corrections \(14 days\): /);
  assert.equal(lines[29], "More: ask for the full note.");
  // A heading left empty by the cut goes; a content line ending in a colon at the cut stays.
  const note = (count: number) => writeFileSync(join(f.memory, "project-notes/site.md"), [
    "# Site", "## Current thinking", ...Array.from({ length: count - 1 }, (_, index) => `Thought ${index}.`), "Two options:",
    "## Open questions", "- 2026-10-21 · cut",
  ].join("\n"));
  note(25);
  const empty = f.card(join(f.projects, "site")).trimEnd().split("\n");
  assert.equal(empty.length, 29);
  assert.equal(empty[26], "Two options:");
  assert.ok(!empty.includes("Open questions:"));
  note(26);
  const colon = f.card(join(f.projects, "site")).trimEnd().split("\n");
  assert.equal(colon.length, 30);
  assert.equal(colon[27], "Two options:");
});

test("a folder inside a workspace counts up to its own repository, so unmapped repos under a catch-all row get no card", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.memory, "project-notes/projects.md"), "# Projects\n\n## Current thinking\nEverything.\n");
  mkdirSync(join(f.projects, "unmapped/.git"));
  mkdirSync(join(f.projects, "unmapped/src"));
  assert.equal(f.card(join(f.projects, "unmapped/src")), noNotes);
  mkdirSync(join(f.projects, "site/.git"));
  mkdirSync(join(f.projects, "site/src"));
  assert.match(f.card(join(f.projects, "site/src")), /^Context card: Site /);
  assert.match(f.card(f.projects), /^Context card: Projects\n/);
  const usage = spawnSync(process.execPath, [script, "--cwd"], { env: f.env, encoding: "utf8" });
  assert.deepEqual([usage.status, usage.stdout, usage.stderr], [2, "", "Usage: context-card.mjs [--cwd DIR] [--hook]\n"]);
});

test("the documented user-level hook skips repos with their own copy and prints the card elsewhere", (t) => {
  const f = fixture(t);
  const block = /```json\n(.+)\n```/.exec(readFileSync("docs/agents/context-card.md", "utf8"))![1];
  const settings = JSON.parse(block) as { hooks: { SessionStart: { hooks: { command: string }[] }[] } };
  const command = settings.hooks.SessionStart[0].hooks[0].command
    .replace("/home/ubulex/Projects/native-site-editor-dev/scripts/agents/context-card.mjs", script);
  assert.ok(command.includes(script), command);
  const run = (cwd: string) => spawnSync("/bin/bash", ["-c", command], {
    cwd, env: f.env, input: JSON.stringify({ hook_event_name: "SessionStart", cwd: join(f.projects, "site") }), encoding: "utf8",
  });
  const own = join(f.home, "own");
  mkdirSync(join(own, "scripts/agents"), { recursive: true });
  writeFileSync(join(own, "scripts/agents/context-card.mjs"), "");
  spawnSync("git", ["init", "-q", own]);
  const skipped = run(own);
  assert.deepEqual([skipped.status, skipped.stdout, skipped.stderr], [0, "", ""]);
  spawnSync("git", ["init", "-q", join(f.projects, "other")]);
  const shown = run(join(f.projects, "other"));
  assert.equal(shown.status, 0, shown.stderr);
  const context = (JSON.parse(shown.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  assert.match(context, /^Context card: Site \(updated 2026-10-24\)\n/);
});

test("missing note, missing slug and missing folder each print one line and exit 0", (t) => {
  const f = fixture(t);
  assert.equal(f.card(join(f.projects, "other")), noNotes);
  assert.equal(f.card(tmpdir()), noNotes);
  assert.equal(f.card(join(f.projects, "site"), { CHAT_MEMORY_DIR: join(f.home, "missing") }), noNotes);
  writeFileSync(join(f.memory, "project-notes/README.md"), "# Project notes\n");
  assert.equal(f.card(join(f.projects, "site")), noNotes);
});

test("an error reading the note gives the no-notes line, plain and through the hook", (t) => {
  const f = fixture(t);
  rmSync(join(f.memory, "project-notes/site.md"));
  mkdirSync(join(f.memory, "project-notes/site.md"));
  assert.equal(f.card(join(f.projects, "site")), noNotes);
  const result = spawnSync("/bin/bash", [join(hooks, "run.sh"), "context-card"], {
    cwd: f.home, env: { ...f.env, CLAUDE_PROJECT_DIR: resolve(".") }, input: JSON.stringify({ cwd: join(f.projects, "site") }), encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal((JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext, noNotes.trimEnd());
});

test("hook mode reads the payload cwd and prints SessionStart context through run.sh", (t) => {
  const f = fixture(t);
  const hook = (input: string, cwd = f.home, root = resolve(".")) => spawnSync("/bin/bash", [join(hooks, "run.sh"), "context-card"], {
    cwd, env: { ...f.env, CLAUDE_PROJECT_DIR: root }, input, encoding: "utf8",
  });
  const context = (input: string, cwd = f.home) => {
    const result = hook(input, cwd);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    return (JSON.parse(result.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }).hookSpecificOutput;
  };
  const output = context(JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: join(f.projects, "site-build-x") }));
  assert.equal(output.hookEventName, "SessionStart");
  assert.match(output.additionalContext, /^Context card: Site \(updated 2026-10-24\)\n[\s\S]*More: ask for the full note\.$/);
  assert.equal(context(JSON.stringify({ hook_event_name: "SessionStart", cwd: f.home })).additionalContext, noNotes.trimEnd());
  // An empty or broken payload falls back to the process working directory.
  for (const input of ["", "not json"]) {
    assert.match(context(input, join(f.projects, "site")).additionalContext, /^Context card: Site \(updated 2026-10-24\)\n/);
  }
  // Branches without the script stay silent.
  const missing = hook("{}", f.home, join(f.projects, "unmapped"));
  assert.deepEqual([missing.status, missing.stdout, missing.stderr], [0, "", ""]);
  // A slow card is stopped after 1 second and prints nothing.
  const slow = join(f.home, "slow");
  mkdirSync(join(slow, "scripts/agents"), { recursive: true });
  writeFileSync(join(slow, "scripts/agents/context-card.mjs"), "setTimeout(() => console.log('late'), 3000);\n");
  const started = Date.now();
  const late = hook("{}", f.home, slow);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.deepEqual([late.status, late.stdout, late.stderr], [0, "", ""]);
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
  // The card script comes from the shared kit; a KIT_HOME without it fails with one line.
  const broken = spawnSync("/bin/bash", [resolve("scripts/agents/kit.d/card")], { cwd: f.home, env: { ...f.env, KIT_ROOT: resolve("."), KIT_HOME: f.home }, encoding: "utf8" });
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, "RESULT: fail card script failed\n");
});
