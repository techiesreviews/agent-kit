import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";
import { pickSkills, skillLine, talkStyleLine } from "../brief-lib.mjs";

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
    /never an OpenAI model/,
    /After three fix rounds only P0\/P1 findings block/,
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
    // The exact slice line, with the job name kit next gives the owner's slice.
    /`scripts\/agents\/kit go slice-ke99 -- scripts\/agents\/kit slice --ticket docs\/tickets\/07-panel\.md --builder claude-opus-5-5`/,
    /the project's runner guide \(`docs\/agents\/runner\.md`\)/,
  ]) assert.match(text, expected);
  // The same text is kept where the lead can read it.
  assert.equal(readFileSync(join(f.root, ".scratch/kit-briefs/07-panel-build.md"), "utf8"), `${text}\n`);
});

test("brief: the talk style alternates en and wenyan, KIT_TALK_STYLE forces one, plain turns it off", t => {
  const f = fixture(t);
  const first = f.run(["docs/tickets/07-panel.md"]), second = f.run(["docs/tickets/07-panel.md"]), third = f.run(["docs/tickets/07-panel.md"]);
  assert.match(first.stdout, /Talk style: very short English/);
  assert.match(second.stdout, /Talk style: Classical Chinese \(wenyan\)/);
  assert.match(third.stdout, /Talk style: very short English/);
  for (const output of [first, second]) assert.match(output.stdout, /plain full English/);
  const forced = f.run(["docs/tickets/07-panel.md"], { KIT_TALK_STYLE: "wenyan" });
  assert.match(forced.stdout, /Talk style: Classical Chinese/);
  assert.match(forced.stdout, /\(talk wenyan\)/);
  const plain = f.run(["docs/tickets/07-panel.md"], { KIT_TALK_STYLE: "plain" });
  assert.doesNotMatch(plain.stdout, /Talk style:/);
  assert.match(plain.stdout, /Write in plain English/);
  const bad = f.run(["docs/tickets/07-panel.md"], { KIT_TALK_STYLE: "loud" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /RESULT: fail .*KIT_TALK_STYLE/);
  // A forced style does not move the counter: the next start takes wenyan, after en, en (forced ones skipped).
  assert.match(f.run(["docs/tickets/07-panel.md"]).stdout, /Talk style: Classical Chinese/);
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
  assert.match(second.stdout, /never an OpenAI model/);
  const fix = f.run(["docs/tickets/07-panel.md", "--stage", "fix", "--note", "P1 fault: src/ui/panel.css:3 wrong token"]);
  assert.match(fix.stdout, /Fix round/);
  assert.match(fix.stdout, /P1 fault: src\/ui\/panel\.css:3 wrong token/);
  assert.match(fix.stdout, /declined/);
  assert.match(fix.stdout, /kit-brief: \S+ docs\/tickets\/07-panel\.md fix$/m);
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

test("brief: briefs started at the same moment still alternate, and leave no lock behind", async t => {
  const f = fixture(t);
  const { KIT_TALK_STYLE: _style, ...env } = { ...kitEnv(), KIT_ROOT: f.root, XDG_STATE_HOME: f.state };
  const once = () => new Promise<string>(accept => {
    const child = spawn(kit, ["brief", "docs/tickets/07-panel.md"], { cwd: f.root, env, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => accept(out));
  });
  const outputs = await Promise.all(Array.from({ length: 6 }, once));
  const styles = outputs.map(out => /\(talk (\w+)\)/.exec(out)?.[1]).sort();
  assert.deepEqual(styles, ["en", "en", "en", "wenyan", "wenyan", "wenyan"]);
  assert.equal(existsSync(join(f.state, "agent-kit/talk-style.json.lock")), false);
});

test("brief: a group ticket is refused (kit next runs a group as one job), and job names match kit next's", t => {
  const f = fixture(t);
  const path = join(f.root, "docs/tickets/07-panel.md");
  writeFileSync(path, readFileSync(path, "utf8").replace("builder: claude", "builder: claude\ngroup: fonts"));
  const refused = f.run(["docs/tickets/07-panel.md"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /RESULT: fail brief docs\/tickets\/07-panel\.md is in group fonts: kit next --start runs a group as one job/);
  writeFileSync(path, readFileSync(path, "utf8").replace("group: fonts\n", ""));
  // kit next's names: al-01 runs as slice-al01; a group owner al-g-fonts as slice-alg-fonts.
  assert.match(f.run(["docs/tickets/07-panel.md", "--owner", "al-01"]).stdout, /kit go slice-al01 -- /);
  assert.match(f.run(["docs/tickets/07-panel.md", "--owner", "site-fonts-01"]).stdout, /kit go slice-site-fonts01 -- /);
  assert.match(f.run(["docs/tickets/07-panel.md", "--owner", "al-m03"]).stdout, /kit go slice-alm03 -- /);
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
    if (stage === "fix") assert.match(staged.stdout, /The findings are in the newest `findings\.json` .* \(the note below holds the task\)/);
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
