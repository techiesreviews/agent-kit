import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";
import { kitFiles } from "./support/kit-files.ts";
import { pickSkills, skillLine, talkStyleLine } from "../brief-lib.mjs";
import { kitMessagesToLex } from "../kit-lib.mjs";
import { orbitProject, orbitSecretsForTests, orbitSettings, runAsync } from "./support/orbit-project.ts";

const kit = resolve("kit");
const ticketText = (files: string, extra = "") => `---
title: "A settings panel with a colour field"
type: task (AFK)
status: open
assignee: ke-99
builder: claude
---

## Goal

Build it.${extra}

## Files

${files}

## Done when

- It works.
`;

function fixture(t: TestContext, settings: Record<string, unknown> = {}, files = "- `src/ui/panel.css`\n- `src/components/form-input.ts`") {
  const root = mkdtempSync(join(tmpdir(), "kit-brief-"));
  const state = mkdtempSync(join(tmpdir(), "kit-brief-state-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(state, { recursive: true, force: true }); });
  spawnSync("git", ["init", "-q", "-b", "dev", root]);
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({
    project: "demo", branches: { land: "dev" }, checks: { check: "npm run check", test: "npm test", lint: "npm run lint" },
    unit: { files: "tests/*.test.ts" }, ...settings,
  }));
  mkdirSync(join(root, "docs/tickets"), { recursive: true });
  writeFileSync(join(root, "docs/tickets/07-panel.md"), ticketText(files));
  const { KIT_TALK_STYLE: _style, ASE_REVIEW_MODEL: _review, ASE_OWNER: _owner, ...base } = kitEnv();
  const env = { ...base, KIT_ROOT: root, XDG_STATE_HOME: state };
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(kit, ["brief", ...args], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });
  return { root, state, run };
}
const body = (stdout: string) => stdout.trimEnd().split("\n").slice(0, -1).join("\n");

test("brief: the build brief holds the owner, setup, pins, commands, every house rule, the wait rule, the report line and the marker", t => {
  const f = fixture(t);
  const output = f.run(["docs/tickets/07-panel.md"]);
  assert.equal(output.status, 0, output.stderr + output.stdout);
  const lines = output.stdout.trimEnd().split("\n");
  assert.match(lines.at(-1)!, /^RESULT: ok brief docs\/tickets\/07-panel\.md build \(talk en\) \.scratch\/kit-briefs\/07-panel-build\.md$/);
  // The marker is the brief's own last line, just above the RESULT line.
  assert.match(lines.at(-2)!, /^kit-brief: \S+ docs\/tickets\/07-panel\.md build$/);
  const text = body(output.stdout);
  for (const expected of [
    /owner `ke-99`/,
    // The branch kit next gives the same slice (kitSliceBranch): the owner, then the slug without its number.
    /git fetch -q origin && git switch -c build\/ke-99-panel origin\/dev/,
    /ASE_OWNER=ke-99 scripts\/agents\/worktree\.sh build\/ke-99-panel origin\/dev/,
    /builder `claude-opus-5-5`/,
    /ASE_REVIEW_MODEL=claude-opus-5-5/,
    /scripts\/agents\/kit doctor/,
    /scripts\/agents\/kit unit --affected/,
    /npm run check/,
    /scripts\/agents\/kit review --ticket docs\/tickets\/07-panel\.md/,
    /scripts\/agents\/kit pr --ticket docs\/tickets\/07-panel\.md/,
    /Paid skills never go in a repo/,
    /Second look: `gpt-6\.1-sol` \(GPT through Codex\), else `grok-4\.7`, else the free `opencode\/deepseek-v4\.1-flash-free`/,
    /GPT may review since 2026-11-09; Claude Opus stays the main reviewer/,
    /Once the review loop's budget is used \(3 fix rounds, 5 for a risky change\) only P0\/P1 findings block/,
    /--waive "<reason>"/,
    /No toasts or explainers/,
    /theme tokens/,
    /House rules beat skill advice/,
    /never borrow another person's name/,
    /Finish the whole job in this turn/,
    /scripts\/agents\/kit go <job> -- <command>/,
    /RUNNING: /,
    /Never wait in the background/,
    /`timeout: 600000`/,
    /fix every ✗ that is not marked optional/,
    /Last line: PR <full URL>, head <SHA>, checks and reviews <state>/,
    /the project's runner guide \(`docs\/agents\/runner\.md`\)/,
    // TOOLS-235: the grill comes before any build, and anything Lex sees follows the prototype he tried.
    /^## Grill and prototype$/m,
    /Grill first: the question round with Lex in its own thread comes before any build/,
    /never guess an answer for Lex/,
    /Anything Lex sees or clicks follows the prototype he tried/,
    /a bug fix or work behind the scenes has no prototype, but still has its grill/,
    /Lex tries the result next to the prototype/,
    // The proof lines: one per Done when item, what was really tried on the real thing, also in the PR text.
    /^Proof: for each "Done when" item, one line: `Done when <n>: met — <what you really tried on the real thing>`/m,
    /checks passing is not proof on its own/,
    /A bug fix shows its failing test first/,
    /Put the same lines in the PR text\./,
  ]) assert.match(text, expected);
  // TOOLS-235: the brief no longer points at kit slice; the builder builds and lands with kit review and kit pr.
  assert.doesNotMatch(text, /kit slice|Manual fallback|kit go slice-/);
  // The same text is kept where the lead can read it.
  assert.equal(readFileSync(join(f.root, ".scratch/kit-briefs/07-panel-build.md"), "utf8"), `${text}\n`);
});

test("brief: the talk style is short English (the trial is over), KIT_TALK_STYLE=plain turns it off", t => {
  const f = fixture(t);
  const first = f.run(["docs/tickets/07-panel.md"]), second = f.run(["docs/tickets/07-panel.md"]);
  for (const output of [first, second]) {
    assert.match(output.stdout, /Talk style: very short English/);
    assert.match(output.stdout, /plain full English/);
    assert.doesNotMatch(output.stdout, /wenyan|Classical Chinese/);
    assert.match(output.stdout, /\(talk en\)/);
  }
  // No counter is kept any more.
  assert.equal(existsSync(join(f.state, "agent-kit/talk-style.json")), false);
  const plain = f.run(["docs/tickets/07-panel.md"], { KIT_TALK_STYLE: "plain" });
  assert.doesNotMatch(plain.stdout, /Talk style:/);
  assert.match(plain.stdout, /Write in plain English/);
  for (const style of ["wenyan", "loud"]) {
    const bad = f.run(["docs/tickets/07-panel.md"], { KIT_TALK_STYLE: style });
    assert.equal(bad.status, 1, style);
    assert.match(bad.stdout, /RESULT: fail brief KIT_TALK_STYLE must be en or plain/);
  }
});

test("brief: --note, --owner and --repo; a missing ticket, a bad stage and a bad option fail", t => {
  const f = fixture(t);
  const other = mkdtempSync(join(tmpdir(), "kit-brief-cwd-"));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const output = spawnSync(kit, ["brief", "docs/tickets/07-panel.md", "--owner", "ke-1", "--repo", f.root, "--note", "Start with the colour field."],
    { cwd: other, env: { ...kitEnv(), KIT_ROOT: other, XDG_STATE_HOME: f.state, KIT_TALK_STYLE: "plain" }, encoding: "utf8" });
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.match(output.stdout, /owner `ke-1`/);
  assert.match(output.stdout, /Note from the lead: Start with the colour field\./);
  assert.match(output.stdout, new RegExp(`in \`demo\` \\(${f.root.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\)`));
  for (const args of [["docs/tickets/missing.md"], ["docs/tickets/07-panel.md", "--stage", "ship"], ["docs/tickets/07-panel.md", "--bogus"], [], ["docs/tickets/07-panel.md", "--note"]]) {
    const failed = f.run(args);
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: fail brief /);
  }
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: kit brief <ticket> \[--stage build\|review\|second-look\|fix\]/);
});

test("brief: each stage has its own brief", t => {
  const f = fixture(t);
  const review = f.run(["docs/tickets/07-panel.md", "--stage", "review"], { KIT_TALK_STYLE: "en" });
  assert.equal(review.status, 0, review.stdout);
  assert.match(review.stdout, /read-only/i);
  assert.match(review.stdout, /Make no changes/);
  assert.match(review.stdout, /REVIEW_STATUS: complete/);
  assert.match(review.stdout, /kit-brief: \S+ docs\/tickets\/07-panel\.md review$/m);
  // A review's findings go to GitHub, so they are people text whatever the talk style.
  assert.match(review.stdout, /Write in plain English/);
  const second = f.run(["docs/tickets/07-panel.md", "--stage", "second-look"]);
  assert.match(second.stdout, /grok-4\.7/);
  assert.match(second.stdout, /opencode\/deepseek-v4\.1-flash-free/);
  assert.match(second.stdout, /second look: skipped \(<reason>\)/);
  assert.match(second.stdout, /gpt-6\.1-sol/);
  assert.match(second.stdout, /GPT may review since 2026-11-09; Claude Opus stays the main reviewer/);
  assert.doesNotMatch(second.stdout, /never an OpenAI model/);
  const fix = f.run(["docs/tickets/07-panel.md", "--stage", "fix", "--note", "P1 fault: src/ui/panel.css:3 wrong token"]);
  assert.match(fix.stdout, /Fix round/);
  assert.match(fix.stdout, /P1 fault: src\/ui\/panel\.css:3 wrong token/);
  assert.match(fix.stdout, /declined/);
  assert.match(fix.stdout, /kit-brief: \S+ docs\/tickets\/07-panel\.md fix$/m);
  // Builders may push back on a review point (Lex, 2026-11-13); reviewers get no such line.
  const pushBack = "If a review point is not worth fixing, say so with the reason instead of changing the code.";
  for (const brief of [fix.stdout, f.run(["docs/tickets/07-panel.md"]).stdout]) assert.ok(brief.includes(pushBack), brief);
  for (const brief of [review.stdout, second.stdout]) assert.ok(!brief.includes(pushBack), brief);
});

test("brief: the skills map picks the UI set from the ticket's files, names skills per model and honours kit.json skills", t => {
  const f = fixture(t, { skills: { add: ["write-swift"], remove: ["emil-ui-polish"] } });
  const claude = f.run(["docs/tickets/07-panel.md"]);
  assert.match(claude.stdout, /^- \/good-css\b/m);
  assert.match(claude.stdout, /^- \/emil-design-foundations\b/m);
  assert.match(claude.stdout, /^- \/emil-forms-and-inputs\b/m);
  assert.match(claude.stdout, /^- \/emil-color\b/m);
  assert.match(claude.stdout, /^- \/write-swift\b/m);
  assert.doesNotMatch(claude.stdout, /emil-ui-polish/);
  assert.doesNotMatch(claude.stdout, /emil-ui-review/);
  const codex = f.run(["docs/tickets/07-panel.md", "--model", "gpt-6.1-sol"]);
  assert.match(codex.stdout, /^- \$good-css \(the good-css skill\)/m);
  const free = f.run(["docs/tickets/07-panel.md", "--model", "opencode/deepseek-v4.1-flash-free"]);
  assert.doesNotMatch(free.stdout, /\/good-css|\$good-css/);
  assert.match(free.stdout, /^- CSS: /m);
  const review = f.run(["docs/tickets/07-panel.md", "--stage", "review"]);
  for (const name of ["emil-ui-review", "emil-unslop-design", "break-ui"]) assert.match(review.stdout, new RegExp(`^- /${name}\\b`, "m"));
});

test("brief: a ticket touching no UI names no front-end skill", t => {
  const f = fixture(t, {}, "- `kit.d/go`\n- `tests/kit-go.test.ts`");
  const output = f.run(["docs/tickets/07-panel.md"]);
  assert.equal(output.status, 0, output.stdout);
  assert.doesNotMatch(output.stdout, /good-css|emil-/);
});

test("skills map helpers: a skills setting that is not a list adds and removes nothing", () => {
  const base = pickSkills({ files: ["src/ui/a.css"], stage: "build" }).map(entry => entry.name);
  assert.deepEqual(pickSkills({ files: ["src/ui/a.css"], stage: "build", settings: { skills: { add: "foo", remove: "emil-ui-polish" } } }).map(entry => entry.name), base);
});

test("skills map helpers: picks by files and words, lines per family", () => {
  const ui = pickSkills({ files: ["src/ui/menu.css"], words: "A dropdown menu with motion", stage: "build" });
  assert.deepEqual(ui.map(entry => entry.name).slice(0, 3), ["good-css", "emil-design-foundations", "emil-ui-polish"]);
  assert.ok(ui.some(entry => entry.name === "emil-surfaces"));
  assert.ok(ui.some(entry => entry.name === "emil-animations"));
  assert.ok(ui.some(entry => entry.name === "animate"));
  assert.deepEqual(pickSkills({ files: ["kit.d/brief"], words: "a dropdown", stage: "build" }), []);
  const entry = ui[0];
  assert.match(skillLine(entry, "claude"), /^\/good-css — /);
  assert.match(skillLine(entry, "codex"), /^\$good-css \(the good-css skill\) — /);
  assert.match(skillLine(entry, "none"), /^CSS: /);
  assert.match(talkStyleLine("en"), /caveman/);
  assert.match(talkStyleLine("plain"), /^Write in plain English/);
});

test("brief: a broken second-look table stops no brief; the line then points at the table", t => {
  const f = fixture(t);
  const missing = join(f.root, "no-such-second-look.json");
  for (const stage of ["build", "second-look"]) {
    const output = f.run(["docs/tickets/07-panel.md", "--stage", stage], { ASE_SECOND_LOOK: missing });
    assert.equal(output.status, 0, output.stderr + output.stdout);
    assert.match(output.stdout, /Second look: the models in the kit's `second-look\.json`, first choice first; GPT may review since 2026-11-09/, stage);
  }
});

test("brief: a second look with no readable table names its skills for no one model, never in the Claude reviewer's form", t => {
  const f = fixture(t);
  const second = f.run(["docs/tickets/07-panel.md", "--stage", "second-look"], { ASE_SECOND_LOOK: join(f.root, "no-such-second-look.json") });
  assert.equal(second.status, 0, second.stderr + second.stdout);
  // The neutral line (an invocation for Claude, a mention for Codex, the kit's words for the rest), not `/emil-ui-review — …`.
  assert.match(second.stdout, /^- \/emil-ui-review \(Codex: \$emil-ui-review; without skills: /m);
  assert.doesNotMatch(second.stdout, /^- \/emil-ui-review — /m);
  // The brief points at the table, and never names the main reviewer's pin as the second look's model.
  assert.match(second.stdout, /^- Model: the models in the kit's `second-look\.json`, first choice first/m);
  assert.doesNotMatch(second.stdout, /ASE_REVIEW_MODEL|claude-opus/);
});

test("brief: pins come from the rulebook (a superseded builder: sol builds on the builder pin; the extras' review pin wins)", t => {
  const f = fixture(t, { rulebookExtras: "docs/extras.md" });
  writeFileSync(join(f.root, "docs/extras.md"), "# Extras\n\n| Role | Model | How |\n| --- | --- | --- |\n| Review, every change | `claude-sonnet-5-5`, medium | here |\n");
  const path = join(f.root, "docs/tickets/07-panel.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("builder: claude", "builder: sol"));
  const output = f.run(["docs/tickets/07-panel.md"]);
  assert.equal(output.status, 0, output.stdout);
  assert.match(output.stdout, /builder `claude-opus-5-5`/);
  assert.match(output.stdout, /ASE_REVIEW_MODEL=claude-sonnet-5-5/);
  assert.match(output.stdout, /^- \/good-css — /m);
  const own = f.run(["docs/tickets/07-panel.md", "--stage", "fix"], { ASE_REVIEW_MODEL: "grok-4.7" });
  assert.match(own.stdout, /ASE_REVIEW_MODEL=grok-4\.7/);
});

test("brief: a review brief's scope is the slice branch, not the lead's checkout", t => {
  const f = fixture(t);
  const review = f.run(["docs/tickets/07-panel.md", "--stage", "review"]);
  assert.match(review.stdout, /^Scope: git diff origin\/dev\.\.\.origin\/build\/ke-99-panel /m);
  assert.equal(review.stdout.match(/^Scope: /gm)!.length, 1);
});

test("brief: a group ticket is refused (kit next runs a group as one job)", t => {
  const f = fixture(t);
  const path = join(f.root, "docs/tickets/07-panel.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("builder: claude", "builder: claude\ngroup: fonts"));
  const refused = f.run(["docs/tickets/07-panel.md"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /RESULT: fail brief docs\/tickets\/07-panel\.md is in group fonts: kit next --start runs a group as one job/);
});

test("brief: a fix brief switches to the pushed slice branch; a ticket with no assignee and no --owner is refused", t => {
  const f = fixture(t);
  const fix = f.run(["docs/tickets/07-panel.md", "--stage", "fix"]);
  assert.match(fix.stdout, /`git fetch -q origin && git switch build\/ke-99-panel` \(it tracks `origin\/build\/ke-99-panel`\)/);
  assert.doesNotMatch(fix.stdout, /switch -c/);
  const path = join(f.root, "docs/tickets/07-panel.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("assignee: ke-99\n", ""));
  const unclaimed = f.run(["docs/tickets/07-panel.md"], { ASE_OWNER: "ke-lead" });
  assert.equal(unclaimed.status, 1);
  assert.match(unclaimed.stdout, /RESULT: fail brief docs\/tickets\/07-panel\.md has no assignee; claim it first or pass --owner/);
  assert.match(f.run(["docs/tickets/07-panel.md", "--owner", "ke-7"]).stdout, /owner `ke-7`/);
});

test("brief --task: a project without ticket files gets a brief for a named task, with the note as its content", t => {
  const f = fixture(t);
  const output = f.run(["--task", "Fix the login form", "--owner", "cf-12", "--note", "Issue #12: the login button stays busy."]);
  assert.equal(output.status, 0, output.stdout + output.stderr);
  const text = body(output.stdout);
  assert.match(text, /^Kit brief: build the task "Fix the login form" in `demo`/m);
  assert.match(text, /Note from the lead: Issue #12: the login button stays busy\./);
  assert.match(text, /`git fetch -q origin && git switch -c build\/cf-12-fix-the-login-form origin\/dev`/);
  assert.match(text, /`scripts\/agents\/kit pr --title 'Fix the login form'`/);
  assert.doesNotMatch(text, /--ticket|kit slice/);
  // A form task brings the UI set from its words.
  assert.match(text, /^- \/emil-forms-and-inputs — /m);
  assert.match(output.stdout.trimEnd().split("\n").at(-2)!, /^kit-brief: \S+ task:fix-the-login-form build$/);
  // A title with a quote, $ and a backtick stays one shell word in the kit pr line.
  const odd = f.run(["--task", "Fix `kit pr` and $HOME's path", "--owner", "cf-1", "--note", "x"]);
  const line = /`scripts\/agents\/kit pr --title (.+?)` into/.exec(odd.stdout)![1];
  assert.equal(spawnSync("bash", ["-c", `printf %s ${line}`], { encoding: "utf8" }).stdout, "Fix `kit pr` and $HOME's path");
  for (const stage of ["review", "second-look", "fix"]) {
    const staged = f.run(["--task", "Fix the login form", "--owner", "cf-12", "--note", "the task", "--stage", stage]);
    assert.equal(staged.status, 0, staged.stdout);
    assert.doesNotMatch(staged.stdout, /--ticket|ticket's Done/, stage);
    if (stage === "fix") assert.match(staged.stdout, /The findings are in the newest complete review.s `findings\.json` .* \(the note below holds the task\)/);
    assert.match(staged.stdout, new RegExp(`kit-brief: \\S+ task:fix-the-login-form ${stage}$`, "m"));
  }
  // A long title's slug is cut at 60 characters and never ends on a dash.
  const long = f.run(["--task", `${"a".repeat(59)} b and more words`, "--owner", "cf-1", "--note", "x"]);
  assert.match(long.stdout, new RegExp(`^kit-brief: \\S+ task:${"a".repeat(59)} build$`, "m"));
  // A task whose title names a form, with no files at all, still names the UI set: the words count too.
  assert.match(f.run(["--task", "Fix the login form", "--owner", "cf-12", "--note", "x"]).stdout, /good-css/);
  for (const args of [["--task", "Fix it"], ["--task", "Fix it", "--owner", "cf-1"], ["docs/tickets/07-panel.md", "--task", "Fix it", "--owner", "cf-1", "--note", "x"],
    ["--task", "Fix it", "--owner", "cf-1", "--note", "x", "--stage", "bild"]]) {
    const failed = f.run(args);
    assert.equal(failed.status, 1, `${args}: ${failed.stdout}`);
  }
});

test("brief KEY: on an Orbit project the brief is built from the card (title, text, comments); a files project reads the card too", async t => {
  const o = await orbitProject(t);
  const f = fixture(t, orbitSettings);
  const card = o.card({ title: "A settings panel with a colour field", description: "Claimed by: kit-1\n\nBuilder: claude\n\n## Goal\n\nBuild the panel.\n\n## Files\n\n- `src/ui/panel.css`\n\n## Done when\n\n- It works.\n" }, "In Progress");
  o.orbit.comments[card.id] = [{ id: "c1", body: "Lex: keep it small", author_service_account: { name: "fleet" }, created_at: "2026-11-06T10:00:00.000Z" }];
  const { KIT_TALK_STYLE: _style, ASE_REVIEW_MODEL: _review, ASE_OWNER: _owner, ...base } = kitEnv();
  const env = { ...base, ...o.env, KIT_ROOT: f.root, XDG_STATE_HOME: f.state, ORBIT_ROLE: "", KIT_TALK_STYLE: "plain" };
  const run = (...args: string[]) => runAsync(kit, ["brief", ...args], { cwd: f.root, env });
  const output = await run("kit-1");
  assert.equal(output.status, 0, output.all);
  for (const secret of orbitSecretsForTests) assert.ok(!output.all.includes(secret));
  const text = body(output.stdout);
  assert.match(text, /^Kit brief: build the Orbit card KIT-1 in `demo` .*owner `kit-1`\. Build the whole card \(its text and comments are below\)/m);
  assert.match(text, /Read first: the card below with all its comments \(`scripts\/agents\/kit ticket get KIT-1 --comments` reads it fresh\)/);
  assert.match(text, /Orbit card standard \(`docs\/orbit-card-standard\.md` in the kit; `scripts\/agents\/kit --home` prints the kit's folder\)/);
  assert.match(text, /^## Card KIT-1\nTitle: A settings panel with a colour field\nLink: http:\/\/orbit\.test\/tasks\/1\n\nClaimed by: kit-1\n\nBuilder: claude\n\n## Goal\n\nBuild the panel\./m);
  assert.match(text, /^### Comments\n\n- fleet, 2026-11-06T10:00:00\.000Z:\nLex: keep it small$/m);
  assert.match(text, /git switch -c build\/kit-1-a-settings-panel-with-a-colour origin\/dev/);
  assert.doesNotMatch(text, /ticket's (Done|focused)|parts of the ticket/);
  assert.match(text, /`scripts\/agents\/kit review` and `scripts\/agents\/kit pr --ticket KIT-1`/);
  assert.match(text, /its answers are in the card's comments\./);
  // The card's Files pick the skills, as a ticket file's do.
  assert.match(text, /good-css/);
  assert.match(output.stdout.trimEnd().split("\n").at(-2)!, /^kit-brief: \S+ KIT-1 build$/);
  assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: ok brief KIT-1 build \(talk plain\) \.scratch\/kit-briefs\/KIT-1-build\.md$/);
  assert.ok(existsSync(join(f.root, ".scratch/kit-briefs/KIT-1-build.md")));
  const review = await run("KIT-1", "--stage", "review");
  assert.match(review.stdout, /Spec axis: the card KIT-1 below, with its comments\./);
  assert.doesNotMatch(review.stdout, /--ticket KIT-1/);
  // No claim and no Assignee line: an owner is needed, as for a ticket without one.
  o.card({ title: "Free", description: "## Goal\n\nx" });
  const free = await run("KIT-2");
  assert.equal(free.status, 1);
  assert.match(free.stdout, /RESULT: fail brief KIT-2 has no assignee; claim it first or pass --owner/);
  assert.equal((await run("KIT-2", "--owner", "kit-2")).status, 0);
  // An imported card nobody claimed: its "Assignee:" line is the owner, and the branch and job stay kit next's.
  o.card({ title: "!!!", description: "Imported from: docs/t/01-x.md (project demo)\nAssignee: claude\n\n## Goal\n\nx" });
  const unclaimed = await run("KIT-3", "--stage", "review");
  assert.equal(unclaimed.status, 0, unclaimed.all);
  assert.match(unclaimed.stdout, /git diff origin\/dev\.\.\.origin\/build\/kit-3 /);
  assert.match((await run("KIT-1", "--owner", "someone-else")).stdout, /git switch -c build\/kit-1-a-settings-panel-with-a-colour origin\/dev/);
  const missing = await run("KIT-99");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /RESULT: fail brief card KIT-99 could not be read: .*does not exist/);

  // TOOLS-235: a project that keeps ticket files reads a card key from Orbit too, so the lead never copies a card by hand.
  const files = fixture(t);
  const plain = await runAsync(kit, ["brief", "KIT-1"], { cwd: files.root, env: { ...env, KIT_ROOT: files.root } });
  assert.equal(plain.status, 0, plain.all);
  assert.match(plain.stdout, /^Kit brief: build the Orbit card KIT-1 in `demo`/m);
  // kit pr reads a card key as a card only on an Orbit project, so here the card lands by its title.
  assert.match(plain.stdout, /`scripts\/agents\/kit review` and `scripts\/agents\/kit pr --title 'A settings panel with a colour field \(KIT-1\)'` into `dev`/);
  assert.doesNotMatch(plain.stdout, /--ticket KIT-1/);
  // So nothing closes the card when the PR lands: the brief has the builder hand that to the lead, who writes the board.
  assert.match(plain.stdout, /^- `kit pr` does not close the card in this project \(it keeps ticket files\): put this line in your report: "Lead: close KIT-1 \(Done, with a dated note naming the PR and its merge SHA\)"\.$/m);
  assert.doesNotMatch(text, /does not close the card/);
  // A ticket file at that very path still wins.
  writeFileSync(join(files.root, "KIT-1"), ticketText("- `src/x.ts`"));
  const file = await runAsync(kit, ["brief", "KIT-1"], { cwd: files.root, env: { ...env, KIT_ROOT: files.root } });
  assert.match(file.stdout, /^Kit brief: build `KIT-1` in `demo`/m);
  // A missing card in a files project says the card could not be read.
  const absent = await runAsync(kit, ["brief", "KIT-98"], { cwd: files.root, env: { ...env, KIT_ROOT: files.root } });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /RESULT: fail brief card KIT-98 could not be read/);
});

test("brief KEY: on an Orbit project a lead's build brief claims a Todo or Backlog card, as kit slice did, and refuses a card it may not take", async t => {
  const o = await orbitProject(t);
  const f = fixture(t, orbitSettings);
  const { KIT_TALK_STYLE: _style, ASE_REVIEW_MODEL: _review, ASE_OWNER: _owner, ...base } = kitEnv();
  const env = { ...base, ...o.env, KIT_ROOT: f.root, XDG_STATE_HOME: f.state, KIT_TALK_STYLE: "plain" };
  const run = (extra: NodeJS.ProcessEnv, ...args: string[]) => runAsync(kit, ["brief", ...args], { cwd: f.root, env: { ...env, ...extra } });
  const todo = o.card({ title: "Todo card" });
  const built = await run({}, "KIT-1", "--owner", "kit-1");
  assert.equal(built.status, 0, built.all);
  assert.equal(o.orbit.statusOf(todo), "In Progress");
  assert.match(todo.description, /^Claimed by: kit-1\n\n## Goal/);
  assert.match(built.stderr, /^claimed KIT-1 for kit-1: In Progress with "Claimed by: kit-1"$/m);
  // The same owner again (a brief written twice) changes nothing.
  const again = await run({}, "KIT-1", "--owner", "kit-1");
  assert.equal(again.status, 0, again.all);
  assert.doesNotMatch(again.stderr, /claimed KIT-1|warning: KIT-1/);
  // An In Progress card is someone's already (a claim, or the lead's own move): the brief leaves it alone, and says so
  // when it is written for another owner, as kit slice's claim refused such a card.
  const other = await run({}, "KIT-1", "--owner", "kit-9");
  assert.equal(other.status, 0, other.all);
  assert.match(todo.description, /^Claimed by: kit-1\n/);
  assert.match(other.stderr, /^warning: KIT-1 is left as it is, not claimed for kit-9: kit-1 holds it \(In Progress\); make sure no second builder starts on it$/m);
  // Review, second-look and fix briefs are for a card somebody builds, so they never warn.
  assert.doesNotMatch((await run({}, "KIT-1", "--owner", "kit-9", "--stage", "review")).stderr, /warning: KIT-1/);
  // A Backlog card is claimed too; review, second-look and fix briefs never claim.
  const backlog = o.card({ title: "Backlog card" }, "Backlog");
  for (const stage of ["review", "second-look", "fix"]) assert.equal((await run({}, "KIT-2", "--owner", "kit-2", "--stage", stage)).status, 0);
  assert.equal(o.orbit.statusOf(backlog), "Backlog");
  assert.doesNotMatch(backlog.description, /Claimed by/);
  assert.equal((await run({}, "KIT-2", "--owner", "kit-2")).status, 0);
  assert.equal(o.orbit.statusOf(backlog), "In Progress");
  // A blocked card is refused, as kit slice refuses it, and no brief file is written.
  const blocked = o.card({ title: "Blocked", description: "Blocked by: KIT-1\n\n## Goal\n\nx\n\n## Done when\n\n- done\n" });
  const refused = await run({}, "KIT-3", "--owner", "kit-3");
  assert.equal(refused.status, 1, refused.all);
  assert.match(refused.stdout, /RESULT: fail brief KIT-3 is blocked by KIT-1 \(In Progress\), so it was not claimed/);
  assert.equal(o.orbit.statusOf(blocked), "Todo");
  assert.ok(!existsSync(join(f.root, ".scratch/kit-briefs/KIT-3-build.md")));
  // A card waiting for Lex is refused too.
  const lex = o.card({ title: "Waits", description: "Next step (Lex): try it\n\n## Goal\n\nx\n\n## Done when\n\n- done\n" });
  const waiting = await run({}, "KIT-4", "--owner", "kit-4");
  assert.equal(waiting.status, 1, waiting.all);
  assert.match(waiting.stdout, /RESULT: fail brief KIT-4 waits for Lex \(Next step \(Lex\): try it\), so it was not claimed/);
  assert.equal(o.orbit.statusOf(lex), "Todo");
  // An In Progress card given back after Lex (no claim, no assignee, no next step) is free, so it is claimed.
  const back = o.card({ title: "Back from Lex" }, "In Progress");
  assert.equal((await run({}, "KIT-5", "--owner", "kit-5")).status, 0);
  assert.match(back.description, /^Claimed by: kit-5\n/);
  // A step that fails before the claim leaves the card as it was.
  const early = o.card({ title: "Early failure" });
  const bogus = await run({ KIT_TALK_STYLE: "bogus" }, "KIT-6", "--owner", "kit-6");
  assert.equal(bogus.status, 1, bogus.all);
  assert.equal(o.orbit.statusOf(early), "Todo");
  assert.doesNotMatch(early.description, /Claimed by/);
  // A files project hands out ticket files, so a card key read there is never claimed.
  const files = fixture(t);
  assert.equal((await runAsync(kit, ["brief", "KIT-6", "--owner", "kit-6"], { cwd: files.root, env: { ...env, KIT_ROOT: files.root } })).status, 0);
  assert.equal(o.orbit.statusOf(early), "Todo");
  // A card next-lex marked sits In Progress with Lex assigned: the brief leaves it as it is.
  const asked = o.card({ title: "Asked Lex", description: "Next step (Lex): try it\n\n## Done when\n\n- done\n", assignee_ids: ["lex"] }, "In Progress");
  const waits = await run({}, "KIT-7", "--owner", "kit-7");
  assert.equal(waits.status, 0, waits.all);
  assert.equal(o.orbit.statusOf(asked), "In Progress");
  assert.doesNotMatch(asked.description, /Claimed by/);
  assert.match(waits.stderr, /^warning: KIT-7 is left as it is, not claimed for kit-7: it waits for Lex \(Next step \(Lex\): try it\); make sure no second builder starts on it$/m);
  // The same card once Lex answered, with someone still assigned and no claim line: left as it is too.
  asked.description = "## Done when\n\n- done\n";
  const assigned = await run({}, "KIT-7", "--owner", "kit-7");
  assert.equal(assigned.status, 0, assigned.all);
  assert.equal(o.orbit.statusOf(asked), "In Progress");
  assert.doesNotMatch(asked.description, /Claimed by/);
  assert.match(assigned.stderr, /^warning: KIT-7 is left as it is, not claimed for kit-7: someone is assigned to it \(In Progress\); make sure no second builder starts on it$/m);
  // Two briefs at once for one card: the one whose claim loses fails and leaves the winner's saved brief alone.
  const race = o.card({ title: "Race" });
  const winner = join(f.root, ".scratch/kit-briefs/KIT-8-build.md");
  writeFileSync(winner, "the winner's brief\n");
  o.orbit.controls.conflicts = 1;
  o.orbit.controls.concurrentEdit = task => { task.status_id = o.orbit.statusId(o.orbit.kit, "In Progress"); task.description = `Claimed by: kit-won\n\n${task.description}`; };
  const lost = await run({}, "KIT-8", "--owner", "kit-lost");
  o.orbit.controls.concurrentEdit = undefined;
  assert.equal(lost.status, 1, lost.all);
  assert.match(lost.stdout, /RESULT: fail brief KIT-8 is already taken by kit-won/);
  assert.match(race.description, /^Claimed by: kit-won\n/);
  assert.equal(readFileSync(winner, "utf8"), "the winner's brief\n");
  // A brief that cannot be saved after its claim gives the claim back and leaves no file of its own behind.
  const stuck = o.card({ title: "Stuck" });
  mkdirSync(join(f.root, ".scratch/kit-briefs/KIT-9-build.md/x"), { recursive: true });
  const unsaved = await run({}, "KIT-9", "--owner", "kit-9");
  assert.equal(unsaved.status, 1, unsaved.all);
  assert.match(unsaved.stdout, /RESULT: fail brief the brief could not be saved as \.scratch\/kit-briefs\/KIT-9-build\.md \(.*\); the claim was given back/);
  assert.equal(o.orbit.statusOf(stuck), "Todo");
  assert.doesNotMatch(stuck.description, /Claimed by/);
  assert.deepEqual(readdirSync(join(f.root, ".scratch/kit-briefs")).filter(name => name.endsWith(".tmp")), []);
  // A claim whose outcome is unknown (Orbit saved it and only its answer was lost) says so, and running the brief again
  // writes the brief for the card that now shows the claim, without claiming it a second time.
  const unknown = o.card({ title: "Unknown" });
  o.orbit.controls.writeAnswers.push("saved-then-502");
  const failed = await run({}, "KIT-10", "--owner", "kit-10");
  assert.equal(failed.status, 1, failed.all);
  assert.match(failed.stdout, /RESULT: fail brief card KIT-10 could not be claimed: .*may or may not have gone through.*; it may be claimed anyway, so run kit brief again: a card that shows "Claimed by: kit-10" then gets its brief/);
  assert.equal(o.orbit.statusOf(unknown), "In Progress");
  assert.match(unknown.description, /^Claimed by: kit-10\n/);
  assert.deepEqual(readdirSync(join(f.root, ".scratch/kit-briefs")).filter(name => name.startsWith("KIT-10-build.md")), []);
  const settled = await run({}, "KIT-10", "--owner", "kit-10");
  assert.equal(settled.status, 0, settled.all);
  assert.ok(existsSync(join(f.root, ".scratch/kit-briefs/KIT-10-build.md")));
  assert.doesNotMatch(settled.stderr, /claimed KIT-10 for/);
  // A claim Orbit refused saved nothing, so its message never says the card may be claimed anyway: a card that keeps
  // changing while saving, a change the token may not make, and a read that failed.
  const busy = o.card({ title: "Busy" });
  o.orbit.controls.conflicts = 50;
  const stale = await run({}, "KIT-11", "--owner", "kit-11");
  o.orbit.controls.conflicts = 0;
  assert.equal(stale.status, 1, stale.all);
  assert.match(stale.stdout, /RESULT: fail brief card KIT-11 could not be claimed: KIT-11 changed again while saving, so nothing was saved; read the card and try again$/m);
  o.orbit.controls.writeAnswers.push({ status: 403, code: "forbidden", detail: "This token cannot change the card" });
  const forbidden = await run({}, "KIT-11", "--owner", "kit-11");
  assert.equal(forbidden.status, 1, forbidden.all);
  assert.match(forbidden.stdout, /RESULT: fail brief card KIT-11 could not be claimed: Orbit refused: This token cannot change the card \[forbidden\]\.$/m);
  // A read that got no answer sent no claim either: here the card changed while saving, and reading it again failed.
  o.orbit.controls.conflicts = 1;
  o.orbit.controls.concurrentEdit = () => { o.orbit.controls.answers.push("drop"); };
  const unread = await run({}, "KIT-11", "--owner", "kit-11");
  o.orbit.controls.concurrentEdit = undefined;
  assert.equal(unread.status, 1, unread.all);
  assert.match(unread.stdout, /RESULT: fail brief card KIT-11 could not be claimed: could not reach Orbit\.$/m);
  for (const refusal of [stale, forbidden, unread]) assert.doesNotMatch(refusal.all, /may be claimed anyway|run kit brief again/);
  assert.equal(o.orbit.statusOf(busy), "Todo");
  assert.doesNotMatch(busy.description, /Claimed by/);
  // A brief that cannot be saved whose claim cannot be given back either says what is left on the card and how to undo it:
  // the claim line and the status the card had.
  const held = o.card({ title: "Held" });
  mkdirSync(join(f.root, ".scratch/kit-briefs/KIT-12-build.md/x"), { recursive: true });
  o.orbit.controls.writeAnswers.push("pass", { status: 500, code: "internal_error", detail: "down" });
  const kept = await run({}, "KIT-12", "--owner", "kit-12");
  assert.equal(kept.status, 1, kept.all);
  assert.match(kept.stdout, /RESULT: fail brief the brief could not be saved as \.scratch\/kit-briefs\/KIT-12-build\.md \(.*\); giving the claim back failed \(Orbit refused: down \[internal_error\]\.\): KIT-12 is still In Progress with "Claimed by: kit-12", so take that line off the card and set its status back to Todo$/m);
  assert.equal(o.orbit.statusOf(held), "In Progress");
  assert.match(held.description, /^Claimed by: kit-12\n/);
  // A card that was In Progress before its claim has no status to set back: only the line comes off.
  const free = o.card({ title: "Free" }, "In Progress");
  mkdirSync(join(f.root, ".scratch/kit-briefs/KIT-13-build.md/x"), { recursive: true });
  o.orbit.controls.writeAnswers.push("pass", { status: 500, code: "internal_error", detail: "down" });
  const lineOnly = await run({}, "KIT-13", "--owner", "kit-13");
  assert.equal(lineOnly.status, 1, lineOnly.all);
  assert.match(lineOnly.stdout, /giving the claim back failed \(.*\): KIT-13 is still In Progress with "Claimed by: kit-13", so take that line off the card$/m);
  assert.match(free.description, /^Claimed by: kit-13\n/);
  assert.deepEqual(readdirSync(join(f.root, ".scratch/kit-briefs")).filter(name => name.endsWith(".tmp")), []);
  // Someone who is not a lead gets the brief and a warning; the card stays as it was.
  const helper = o.card({ title: "Helper" });
  const warned = await run({ ORBIT_ROLE: "" }, "KIT-14", "--owner", "kit-14");
  assert.equal(warned.status, 0, warned.all);
  assert.match(warned.stderr, /^warning: KIT-14 is not claimed \(only a lead writes to Orbit: ORBIT_ROLE=lead\); until it is, kit next may start it too$/m);
  assert.equal(o.orbit.statusOf(helper), "Todo");
  assert.doesNotMatch(helper.description, /Claimed by/);
  // Only Todo, Backlog and a free In Progress card are claimed: a card in any other status the board keeps (Ideas, say)
  // gets its brief and stays as it is.
  const board = o.orbit.statuses.get(o.orbit.kit.id)!;
  board.push({ ...board[0], id: "ideas-status", name: "Ideas", position: board.length });
  const idea = o.card({ title: "Idea" }, "Ideas");
  const left = await run({}, "KIT-15", "--owner", "kit-15");
  assert.equal(left.status, 0, left.all);
  assert.ok(existsSync(join(f.root, ".scratch/kit-briefs/KIT-15-build.md")));
  assert.equal(o.orbit.statusOf(idea), "Ideas");
  assert.doesNotMatch(idea.description, /Claimed by/);
  assert.doesNotMatch(left.stderr, /claimed KIT-15/);
  assert.match(left.stderr, /^warning: KIT-15 is left as it is, not claimed for kit-15: it is in Ideas; make sure no second builder starts on it$/m);
  // A card that is already Done has nothing to build, which the brief says too.
  const done = o.card({ title: "Landed" }, "Done");
  const landed = await run({}, "KIT-16", "--owner", "kit-16");
  assert.equal(landed.status, 0, landed.all);
  assert.equal(o.orbit.statusOf(done), "Done");
  assert.match(landed.stderr, /^warning: KIT-16 is left as it is, not claimed for kit-16: it is already Done, so there is nothing to build$/m);
});

test("brief KEY: on a board with no Todo status a lead's build brief claims every card not yet started, since kit next hands those out", async t => {
  const o = await orbitProject(t);
  const f = fixture(t, orbitSettings);
  const { KIT_TALK_STYLE: _style, ASE_REVIEW_MODEL: _review, ASE_OWNER: _owner, ...base } = kitEnv();
  const env = { ...base, ...o.env, KIT_ROOT: f.root, XDG_STATE_HOME: f.state, KIT_TALK_STYLE: "plain" };
  const board = o.orbit.statuses.get(o.orbit.kit.id)!;
  const todo = board.find(status => status.name === "Todo")!;
  Object.assign(todo, { name: "Ideas" });
  const idea = o.card({ title: "Idea" }, "Ideas");
  // kit next hands the card out, so a brief that left it unclaimed would let kit next start a second builder on it.
  const next = await runAsync(kit, ["next"], { cwd: f.root, env });
  assert.match(next.stdout, /^next: KIT-1 /m, next.all);
  const built = await runAsync(kit, ["brief", "KIT-1", "--owner", "kit-1"], { cwd: f.root, env });
  assert.equal(built.status, 0, built.all);
  assert.equal(o.orbit.statusOf(idea), "In Progress");
  assert.match(idea.description, /^Claimed by: kit-1\n/);
  assert.match(built.stderr, /^claimed KIT-1 for kit-1: In Progress with "Claimed by: kit-1"$/m);
});

test("brief: a card or ticket with no Done when list gets a warning, since its proof lines need one", async t => {
  const f = fixture(t);
  const path = join(f.root, "docs/tickets/07-panel.md");
  assert.doesNotMatch(f.run(["docs/tickets/07-panel.md"]).stderr, /Done when/);
  writeFileSync(path, readFileSync(path, "utf8").replace(/## Done when[\s\S]*$/, ""));
  const none = f.run(["docs/tickets/07-panel.md"]);
  assert.equal(none.status, 0, none.stdout);
  assert.match(none.stderr, /^warning: docs\/tickets\/07-panel\.md has no "Done when" list; the proof lines need one \(the card standard's "Done when:" line\)$/m);
  // An empty heading has no items, so it warns too; the card standard's line, bold or plain, counts.
  const bare = readFileSync(path, "utf8");
  writeFileSync(path, `${bare}\n## Done when\n\n## Notes\n\nx\n`);
  assert.match(f.run(["docs/tickets/07-panel.md"]).stderr, /has no "Done when" list/);
  writeFileSync(path, `${bare}\n**Done when:** it works; Lex tried it.\n`);
  assert.doesNotMatch(f.run(["docs/tickets/07-panel.md"]).stderr, /Done when/);
  writeFileSync(path, `${bare}\nDone when: it works; Lex tried it.\n`);
  assert.doesNotMatch(f.run(["docs/tickets/07-panel.md"]).stderr, /Done when/);
  // A task has no list to check: its proof lines follow the note.
  const task = f.run(["--task", "Fix it", "--owner", "cf-1", "--note", "Make the login button work."]);
  assert.doesNotMatch(task.stderr, /Done when/);
  assert.match(task.stdout, /^Proof: for each thing the note asks for, one line: `<what>: met — <what you really tried on the real thing>`/m);
  // The grill's answers are where each source keeps them.
  assert.match(task.stdout, /its answers are in the note below\./);
  assert.match(f.run(["docs/tickets/07-panel.md"]).stdout, /its answers are in the ticket's `## Resolution` sections\./);
});

test("brief: every stage carries the Messages to Lex rule from the rulebook, the one source, with its example", t => {
  const rule = kitMessagesToLex(resolve("."));
  assert.ok(readFileSync(resolve("docs/kitchen.md"), "utf8").includes(rule), "the rule is the rulebook's own text");
  assert.match(rule, /Start with the question, or what he must do/);
  assert.match(rule, /Example/);
  const f = fixture(t);
  for (const stage of ["build", "review", "second-look", "fix"]) {
    const output = f.run(["docs/tickets/07-panel.md", "--stage", stage]);
    assert.equal(output.status, 0, output.stderr + output.stdout);
    const text = body(output.stdout);
    assert.ok(text.includes(`## Messages to Lex\nThis covers messages meant for Lex. The Report section's format still applies in full`), `${stage}: no Messages to Lex note`);
    assert.ok(text.includes(`\n${rule}\n`), `${stage}: no Messages to Lex rule`);
    assert.match(text, /This copy is v\d+; a project's own or newer "Messages to Lex" section in AGENTS\.md wins over it/, stage);
  }
});

test("brief: a rulebook without the Messages to Lex rule fails with a RESULT line naming it, and prints no brief", t => {
  const f = fixture(t);
  const home = mkdtempSync(join(tmpdir(), "kit-brief-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  cpSync(resolve("."), home, { recursive: true, filter: kitFiles });
  const rulebook = join(home, "docs/kitchen.md");
  writeFileSync(rulebook, readFileSync(rulebook, "utf8").replace(/<!-- messages-to-lex:(start v\d+|end) -->\n?/g, ""));
  const output = f.run(["docs/tickets/07-panel.md"], { KIT_HOME: home });
  assert.equal(output.status, 1, output.stdout + output.stderr);
  assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: fail brief .*has no Messages to Lex rule$/);
  assert.doesNotMatch(output.stdout, /kit-brief: /);
});

test("brief: the talk-style line tells a headless builder where the Messages to Lex rule is", () => {
  for (const style of ["en", "plain"]) assert.match(talkStyleLine(style), /Messages for Lex follow the Messages to Lex rule \(`scripts\/agents\/kit rulebook`, section "Messages to Lex"\): short bullets in plain English/, style);
});

test("brief: every stage carries the Review loop rule from the rulebook, the one source", t => {
  // @ts-expect-error The kit's helpers are plain JavaScript without declarations.
  return import("../kit-lib.mjs").then(({ kitReviewLoopRule }: { kitReviewLoopRule: (home: string) => { rule: string; version: number } }) => {
    const { rule, version } = kitReviewLoopRule(resolve("."));
    assert.ok(readFileSync(resolve("docs/kitchen.md"), "utf8").includes(rule), "the rule is the rulebook's own text");
    assert.equal(version, 3);
    const f = fixture(t);
    for (const stage of ["build", "review", "second-look", "fix"]) {
      const output = f.run(["docs/tickets/07-panel.md", "--stage", stage]);
      assert.equal(output.status, 0, output.stderr + output.stdout);
      assert.ok(body(output.stdout).includes(`## Review loop\n${rule}\n`), `${stage}: no Review loop rule`);
    }
    assert.match(rule, /Budget: 3 fix rounds; 5 only for security, permissions, auth, data loss/);
    assert.match(rule, /Reviewed with review-loop: N rounds with <model>\. Verdict: approved/);
  });
});
