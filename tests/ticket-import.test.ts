import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { amsterdamDay, importedFrom, rewriteTicketLinks, splitComments, wantedStatus } from "../ticket-import.mjs";
import { kitEnv } from "./support/kit-env.ts";
import { orbitProject, orbitSecretsForTests, runAsync, type Run } from "./support/orbit-project.ts";

// kit ticket import, parity and migrate, against the fake Orbit and a git project whose origin is a bare repository on
// disk. kit pr is a fake that records how it was called; no real Orbit, GitHub or remote is ever reached.
const ticketCommand = resolve("kit.d/ticket");
const ticketsHelper = resolve("tickets.mjs");

const files: Record<string, string> = {
  "docs/wayfinder/alpha/tickets/01-first.md": `---
title: First thing
type: task (AFK)
status: closed
assignee: claude
builder: sol
blocked_by: []
---

## Goal

Build the first thing. See [the next one](02-second.md).

## Comments

- 2026-10-01, Lex: "make it small"
  - agreed
- 2026-10-02: the second comment

## Done (2026-10-03)

Landed in PR #4.
`,
  "docs/wayfinder/alpha/tickets/02-second.md": `---
title: "Second: the follow-up"
type: task (AFK)
status: open
assignee:
blocked_by: [01-first]
---

## Goal

After [the first](01-first.md#done) and the [research](../research/r1.md). Also \`docs/wayfinder/alpha/tickets/01-first.md\`.

## Files

- \`src/a.ts\`

## Done when

- it works
`,
  "docs/wayfinder/alpha/build/tickets/03-grill.md": `---
title: Decide the shape
type: grilling (HITL)
status: needs-info
assignee: Lex + claude (grilling)
blocked_by:
  - 02-second
---

## Question

Which shape? Read [the second](../../tickets/02-second.md).
`,
  "docs/wayfinder/alpha/tickets/04-dropped.md": `---
title: Dropped idea
type: task (AFK)
status: wontfix
blocked_by: []
---

Not doing this.
`,
  "docs/wayfinder/alpha/map.md": "# Alpha\n\n- [01](tickets/01-first.md) first\n- `docs/wayfinder/alpha/tickets/02-second.md` second\n- [research](research/r1.md)\n",
  "docs/wayfinder/alpha/research/r1.md": "# Research\n\nNo ticket links here.\n",
  "docs/wayfinder/alpha/build/feedback.md": "# Feedback\n\n## Feedback\n\n- 2026-10-04 · fault · broke · after release: no · fix: [03](tickets/03-grill.md)\n",
  "docs/adr/0001-shape.md": "# ADR 1\n\nDecided in [the grilling](../wayfinder/alpha/build/tickets/03-grill.md).\n",
  "README.md": "# Demo\n\nNothing about tickets.\n",
};
const paths = ["docs/wayfinder/alpha/tickets/01-first.md", "docs/wayfinder/alpha/tickets/02-second.md", "docs/wayfinder/alpha/tickets/04-dropped.md", "docs/wayfinder/alpha/build/tickets/03-grill.md"];

async function project(t: TestContext, { settings = {}, extra = {} }: { settings?: object; extra?: Record<string, string> } = {}) {
  const o = await orbitProject(t);
  const dir = mkdtempSync(join(tmpdir(), "kit-ticket-import-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const origin = join(dir, "origin.git"), root = join(dir, "project");
  const gitEnv = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, ...gitEnv } });
  execFileSync("git", ["init", "-q", "--bare", origin]);
  mkdirSync(root);
  git(root, "init", "-q", "-b", "dev");
  const all = { ...files, ...extra, "scripts/agents/kit.json": JSON.stringify({ project: "demo", maps: "docs/wayfinder", branches: { land: "dev" }, orbit: { project: "KIT" }, ...settings }, null, 2) + "\n" };
  for (const [path, text] of Object.entries(all)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "start");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "dev");
  git(root, "fetch", "-q", "origin");
  git(root, "switch", "-q", "-c", "tickets-to-orbit", "origin/dev");
  const bin = join(dir, "bin"), prLog = join(dir, "pr.log");
  mkdirSync(bin);
  const fakeKit = join(bin, "fake-kit");
  writeFileSync(fakeKit, `#!/bin/sh\necho "$*" >> "${prLog}"\ngit status --porcelain >> "${prLog}"\necho "RESULT: \${FAKE_PR_RESULT:-ok} pr fake"\n[ "\${FAKE_PR_RESULT:-ok}" = ok ]\n`);
  chmodSync(fakeKit, 0o755);
  const env: NodeJS.ProcessEnv = { ...kitEnv(), ...o.env, ...gitEnv, KIT_ROOT: root, ASE_OWNER: "fleet-lead", KIT_TICKET_KIT: fakeKit };
  for (const name of ["KIT_LIB_MJS", "KIT_LIB", "NODE_TEST_CONTEXT"]) delete env[name];
  const run = async (args: string[], more: NodeJS.ProcessEnv = {}) => {
    const output = await runAsync(process.execPath, [ticketCommand, ...args], { cwd: root, env: { ...env, ...more } });
    for (const secret of orbitSecretsForTests) assert.ok(!output.all.includes(secret), "a secret was printed");
    assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: (ok|fail) /, output.all);
    return output;
  };
  const cardFor = (path: string) => o.orbit.tasks.find(task => !task.trashed && importedFrom(task.description)?.path === path);
  const prCalls = () => existsSync(prLog) ? readFileSync(prLog, "utf8") : "";
  return { ...o, root, origin, git: (...args: string[]) => git(root, ...args), run, cardFor, prCalls, env };
}

const ok = (output: Run) => { assert.equal(output.status, 0, output.all); assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: ok /); return output; };
const refused = (output: Run, pattern: RegExp) => { assert.notEqual(output.status, 0, output.all); assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: fail /); assert.match(output.all, pattern); return output; };

test("splitComments takes each top-level entry of a Comments section out of the body, and every line stays on one side", () => {
  const { body, comments } = splitComments("## Goal\n\nText\n\n## Comments\n\nA note before the list\n\n- one\n  - under one\n\n- two\n\n## Done\n\nYes\n\n```\n## Comments\n- not a comment\n```");
  assert.equal(body, "## Goal\n\nText\n\n## Done\n\nYes\n\n```\n## Comments\n- not a comment\n```");
  assert.deepEqual(comments, ["A note before the list", "- one\n  - under one", "- two"]);
  assert.deepEqual(splitComments("No comments here").comments, []);
});

test("rewriteTicketLinks points ticket links at their cards, notes backticked ticket paths, and rebases other links only when asked", () => {
  const card = (path: string) => path === "docs/m/tickets/01-a.md" ? { key: "KIT-7", url: "http://orbit.test/tasks/7" } : null;
  const text = "[a](01-a.md#x) [b](../research/r.md) [c](https://example.test) `docs/m/tickets/01-a.md` [d]: 01-a.md\n```\n[e](01-a.md)\n```";
  const asDoc = rewriteTicketLinks(text, "docs/m/tickets/02-b.md", card);
  assert.equal(asDoc.text, "[a](http://orbit.test/tasks/7) [b](../research/r.md) [c](https://example.test) `docs/m/tickets/01-a.md` (Orbit KIT-7) [d]: 01-a.md\n```\n[e](01-a.md)\n```");
  assert.equal(asDoc.count, 2);
  const asCard = rewriteTicketLinks("[d]: 01-a.md\n[b](../research/r.md)", "docs/m/tickets/02-b.md", card, { rebase: true });
  assert.equal(asCard.text, "[d]: http://orbit.test/tasks/7\n[b](docs/m/research/r.md)");
  assert.equal(rewriteTicketLinks(asDoc.text, "docs/m/tickets/02-b.md", card).count, 0, "a second pass changes nothing");
});

test("file statuses map to the board's statuses: closed Done, wontfix Cancelled, open AFK Todo, the rest Backlog", () => {
  assert.equal(wantedStatus({ status: "closed", type: "grilling (HITL)" }).name, "done");
  assert.equal(wantedStatus({ status: "wontfix", type: "task (AFK)" }).name, "cancelled");
  assert.equal(wantedStatus({ status: "open", type: "task (AFK)" }).name, "todo");
  assert.equal(wantedStatus({ status: "open", type: "grilling (HITL)" }).name, "backlog");
  assert.equal(wantedStatus({ status: "needs-info", type: "task (AFK)" }).name, "backlog");
  assert.equal(amsterdamDay(new Date("2026-11-07T23:30:00Z")), "20261108", "the tag date is Amsterdam's");
});

test("import --dry-run prints every card and comment it would make and sends nothing", async t => {
  const p = await project(t);
  const output = ok(await p.run(["import", "--dry-run"]));
  assert.deepEqual(p.orbit.writes(), []);
  for (const path of paths) assert.match(output.stdout, new RegExp(`would create a card from ${path.replace(/[.]/g, "\\.")}`));
  assert.match(output.stdout, /\| Imported from: docs\/wayfinder\/alpha\/tickets\/02-second\.md \(project demo\)/);
  assert.match(output.stdout, /\| Blocked by: <new card for docs\/wayfinder\/alpha\/tickets\/01-first\.md>/);
  assert.match(output.stdout, /would add comment 2\/2 to the new card from docs\/wayfinder\/alpha\/tickets\/01-first\.md/);
  assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /import 4 tickets into KIT \(dry run\): 4 to create, 0 to update, 0 unchanged, 2 comments to add/);
});

test("import makes one card per ticket file with its status, header lines, blockers, links and comments, under the parent; a rerun makes none", async t => {
  const p = await project(t, { settings: { orbit: { project: "KIT", parent: "KIT-1" } } });
  const parent = p.card({ title: "Tickets of the demo project" }, "Backlog");
  const output = ok(await p.run(["import"]));
  assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /import 4 tickets into KIT: 4 created, 0 updated, 0 unchanged, 2 comments added/);
  const [first, second, dropped, grill] = paths.map(p.cardFor);
  for (const card of [first, second, dropped, grill]) { assert.ok(card); assert.equal(card.parent_task_id, parent.id); }
  assert.deepEqual([first, second, dropped, grill].map(card => p.orbit.statusOf(card)), ["Done", "Todo", "Cancelled", "Backlog"]);
  assert.equal(second.title, "Second: the follow-up");
  // The forward link in the first ticket is fixed once the second card exists.
  assert.equal(first.description, `Imported from: docs/wayfinder/alpha/tickets/01-first.md (project demo)\nType: task (AFK)\nAssignee: claude\nBuilder: sol\n\n## Goal\n\nBuild the first thing. See [the next one](${second.url}).\n\n## Done (2026-10-03)\n\nLanded in PR #4.`);
  assert.equal(second.description, `Imported from: docs/wayfinder/alpha/tickets/02-second.md (project demo)\nType: task (AFK)\nBlocked by: ${first.identifier}\n\n## Goal\n\nAfter [the first](${first.url}) and the [research](docs/wayfinder/alpha/research/r1.md). Also \`docs/wayfinder/alpha/tickets/01-first.md\` (Orbit ${first.identifier}).\n\n## Files\n\n- \`src/a.ts\`\n\n## Done when\n\n- it works`);
  assert.equal(grill.description, `Imported from: docs/wayfinder/alpha/build/tickets/03-grill.md (project demo)\nType: grilling (HITL)\nAssignee: Lex + claude (grilling)\nFile status: needs-info\nBlocked by: ${second.identifier}\n\n## Question\n\nWhich shape? Read [the second](${second.url}).`);
  assert.deepEqual((p.orbit.comments[first.id] ?? []).map(comment => comment.body), ['- 2026-10-01, Lex: "make it small"\n  - agreed', "- 2026-10-02: the second comment"]);
  assert.match(p.log(), /action=create .*result=ok/);

  const writes = p.orbit.writes().length;
  const again = ok(await p.run(["import"]));
  assert.match(again.stdout.trimEnd().split("\n").at(-1)!, /0 created, 0 updated, 4 unchanged, 0 comments added/);
  assert.equal(p.orbit.writes().length, writes, "a rerun sends nothing");
  assert.equal(p.orbit.tasks.length, 5);
});

test("a rerun after a half-done import finishes it: the missing card and comment are added, a changed card is put back", async t => {
  const p = await project(t);
  ok(await p.run(["import"]));
  const first = p.cardFor(paths[0]), second = p.cardFor(paths[1]);
  p.orbit.comments[first.id].pop();
  second.trashed = true;
  first.title = "Edited on the board";
  ok(await p.run(["import"]));
  assert.equal(p.cardFor(paths[0]).title, "First thing");
  assert.equal(p.orbit.comments[first.id].length, 2);
  const remade = p.cardFor(paths[1]);
  assert.ok(remade && remade.id !== second.id);
  assert.match(p.cardFor(paths[3]).description, new RegExp(`Blocked by: ${remade.identifier}`), "blockers name the new card");
  // A card before the remade one in the order links to it too, in the same run.
  assert.match(p.cardFor(paths[0]).description, new RegExp(`\\[the next one\\]\\(${remade.url.replace(/[.]/g, "\\.")}\\)`));
  assert.ok(!p.orbit.writes().some(write => JSON.stringify(write.body ?? "").includes("<new card for")), "no placeholder ever reaches Orbit");
  ok(await p.run(["parity"]));
});

test("import refuses broken ticket files, a project without maps, and two cards made from one file; helpers may not write", async t => {
  const broken = await project(t, { extra: { "docs/wayfinder/alpha/tickets/05-bad.md": "---\ntitle: Bad\nstatus: maybe\n---\n" } });
  refused(await broken.run(["import"]), /fix the ticket files first: .*05-bad\.md:3: Invalid status: maybe/);
  assert.deepEqual(broken.orbit.writes(), []);
  const plain = await project(t, { settings: { maps: undefined } });
  refused(await plain.run(["import"]), /no "maps" folder/);
  const helper = await project(t);
  refused(await helper.run(["import"], { ORBIT_ROLE: "" }), /only a lead may write/);
  ok(await helper.run(["import"]));
  helper.orbit.addTask(helper.orbit.kit, { title: "Copy", description: `Imported from: ${paths[0]} (project demo)` });
  refused(await helper.run(["import"]), /two cards were imported from the same file/);
  refused(await helper.run(["import"], { KIT_ROOT: join(helper.root, "nowhere") }), /import runs in a kit project/);
});

test("parity passes on a clean import and lists every difference: no card, status, title, text, blockers, comments, extra card", async t => {
  const p = await project(t);
  ok(await p.run(["import"]));
  ok(await p.run(["parity"]));
  const [first, second, dropped, grill] = paths.map(p.cardFor);
  first.status_id = p.orbit.statusId(p.orbit.kit, "Todo");
  second.title = "Renamed";
  grill.description = grill.description.replace("Which shape?", "Which form?").replace(/Blocked by: .*/, "Blocked by: KIT-99");
  p.orbit.comments[first.id].pop();
  p.orbit.comments[grill.id] = [{ id: "x", body: "A comment added on the board" }];
  dropped.trashed = true;
  p.orbit.addTask(p.orbit.kit, { title: "Gone", description: "Imported from: docs/wayfinder/alpha/tickets/09-gone.md (project demo)" });
  const writes = p.orbit.writes().length;
  const output = refused(await p.run(["parity"]), /parity KIT: 8 differences/);
  for (const line of [
    /^docs\/wayfinder\/alpha\/tickets\/04-dropped\.md: no card$/m,
    new RegExp(`^${first.identifier} \\(docs/wayfinder/alpha/tickets/01-first\\.md\\): status is Todo, file says Done \\(closed\\)$`, "m"),
    new RegExp(`^${second.identifier} .*: title is "Renamed", file says "Second: the follow-up"$`, "m"),
    new RegExp(`^${grill.identifier} .*: blocked by KIT-99, file says ${second.identifier}$`, "m"),
    new RegExp(`^${grill.identifier} .*: description differs at line 5: file has "Blocked by: ${second.identifier}", card has "Blocked by: KIT-99"$`, "m"),
    new RegExp(`^${first.identifier} .*: 1 comment from the file missing on the card \\(first: "- 2026-10-02: the second comment"\\)$`, "m"),
    new RegExp(`^${grill.identifier} .*: 1 comment on the card that the file does not have \\(first: "A comment added on the board"\\)$`, "m"),
    /^KIT-\d+: imported from docs\/wayfinder\/alpha\/tickets\/09-gone\.md, which is not a ticket file now$/m,
  ]) assert.match(output.stdout, line);
  assert.equal(p.orbit.writes().length, writes, "parity only reads");
});

test("migrate --dry-run checks, shows each step and changes nothing", async t => {
  const p = await project(t);
  const head = p.git("rev-parse", "HEAD");
  const output = ok(await p.run(["migrate", "--dry-run"]));
  assert.deepEqual(p.orbit.writes(), []);
  assert.equal(p.git("rev-parse", "HEAD"), head);
  assert.equal(p.git("tag", "--list").trim(), "");
  assert.equal(p.git("status", "--porcelain").trim(), "");
  assert.equal(p.prCalls(), "");
  assert.match(output.stdout, /3\. would tag [0-9a-f]{7} as tickets-in-files-\d{8} and push the tag to origin/);
  assert.match(output.stdout, /4\. would commit on tickets-to-orbit: remove 4 ticket files, set "tickets": "orbit" with board KIT/);
  assert.match(output.stdout, /docs\/wayfinder\/alpha\/map\.md: 2 links/);
  assert.match(output.stdout, /5\. would run: kit pr --title "Move the tickets to Orbit board KIT"/);
});

test("migrate imports, checks parity, tags and pushes, then sends one commit through kit pr that removes only the ticket files", async t => {
  const p = await project(t, { settings: { orbit: { project: "KIT" } } });
  const parent = p.card({ title: "Demo tickets" }, "Backlog");
  const start = p.git("rev-parse", "HEAD").trim();
  const output = ok(await p.run(["migrate", "--parent", parent.identifier]));
  const tag = `tickets-in-files-${amsterdamDay()}`;
  assert.match(output.stdout, /2\. parity: clean \(4 files, 4 cards\)/);
  assert.equal(p.git("rev-parse", `${tag}^{commit}`).trim(), start, "the tag holds the files");
  assert.match(execFileSync("git", ["-C", p.origin, "tag", "--list"], { encoding: "utf8" }), new RegExp(tag), "the tag is on origin");
  assert.equal(p.git("show", `${tag}:${paths[3]}`), files[paths[3]], "a ticket file reads back from the tag");
  assert.equal(p.git("rev-parse", "HEAD~1").trim(), start, "one commit");
  const changed = p.git("show", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
  assert.deepEqual(changed, [
    "D\tdocs/wayfinder/alpha/build/tickets/03-grill.md", "D\tdocs/wayfinder/alpha/tickets/01-first.md", "D\tdocs/wayfinder/alpha/tickets/02-second.md", "D\tdocs/wayfinder/alpha/tickets/04-dropped.md",
    "M\tdocs/adr/0001-shape.md", "M\tdocs/wayfinder/alpha/build/feedback.md", "M\tdocs/wayfinder/alpha/map.md", "M\tscripts/agents/kit.json",
  ]);
  const [first, second, , grill] = paths.map(p.cardFor);
  assert.equal(first.parent_task_id, parent.id);
  assert.equal(readFileSync(join(p.root, "docs/wayfinder/alpha/map.md"), "utf8"), `# Alpha\n\n- [01](${first.url}) first\n- \`docs/wayfinder/alpha/tickets/02-second.md\` (Orbit ${second.identifier}) second\n- [research](research/r1.md)\n`);
  assert.equal(readFileSync(join(p.root, "docs/adr/0001-shape.md"), "utf8"), `# ADR 1\n\nDecided in [the grilling](${grill.url}).\n`);
  assert.equal(readFileSync(join(p.root, "docs/wayfinder/alpha/research/r1.md"), "utf8"), files["docs/wayfinder/alpha/research/r1.md"]);
  const settings = JSON.parse(readFileSync(join(p.root, "scripts/agents/kit.json"), "utf8"));
  assert.equal(settings.tickets, "orbit");
  assert.deepEqual(settings.orbit, { project: "KIT", parent: parent.identifier });
  assert.equal(settings.maps, "docs/wayfinder", "maps stay");
  assert.equal(p.prCalls(), "pr --title Move the tickets to Orbit board KIT\n", "kit pr ran on a clean tree with the commit");
  const check = spawnSync(process.execPath, [ticketsHelper, "check"], { cwd: p.root, encoding: "utf8", env: p.env });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(output.stdout.trimEnd().split("\n").at(-1)!, new RegExp(`RESULT: ok ticket migrate 4 tickets to KIT, tag ${tag}, landed through kit pr`));
  refused(await p.run(["migrate"]), /already on Orbit/);
});

test("migrate stops at a parity difference before anything is tagged or removed, and says when kit pr did not land", async t => {
  const p = await project(t);
  p.orbit.addTask(p.orbit.kit, { title: "Gone", description: "Imported from: docs/wayfinder/alpha/tickets/09-gone.md (project demo)" });
  const head = p.git("rev-parse", "HEAD");
  const output = refused(await p.run(["migrate"]), /migrate stopped: parity found 1 difference/);
  assert.match(output.stdout, /09-gone\.md, which is not a ticket file now/);
  assert.equal(p.git("tag", "--list").trim(), "");
  assert.equal(p.git("rev-parse", "HEAD"), head);
  assert.equal(p.prCalls(), "");

  const q = await project(t);
  const failed = refused(await q.run(["migrate"], { FAKE_PR_RESULT: "fail" }), /kit pr did not land the move/);
  assert.match(failed.stdout, /^   RESULT: fail pr fake$/m, "kit pr's own lines are indented under step 5");
  assert.match(q.git("tag", "--list"), /tickets-in-files-/);
});

test("migrate waits while a build runs and refuses a checkout that is not a fresh branch", async t => {
  const claimed = await project(t, { extra: { "docs/wayfinder/alpha/tickets/05-busy.md": "---\ntitle: Busy\ntype: task (AFK)\nstatus: open\nassignee: al-05\nblocked_by: []\n---\n" } });
  refused(await claimed.run(["migrate"]), /a build is running, so the move waits: docs\/wayfinder\/alpha\/tickets\/05-busy\.md \(claimed by al-05\)/);
  assert.deepEqual(claimed.orbit.writes(), []);

  const working = await project(t);
  ok(await working.run(["import"]));
  const card = working.cardFor(paths[1]);
  card.status_id = working.orbit.statusId(working.orbit.kit, "In Progress");
  card.description = `Claimed by: kit-9\n${card.description}`;
  const writes = working.orbit.writes().length;
  refused(await working.run(["migrate"]), new RegExp(`a build is running, so the move waits: ${card.identifier} \\(In Progress, claimed by kit-9\\)`));
  assert.equal(working.orbit.writes().length, writes);

  const p = await project(t);
  p.git("switch", "-q", "dev");
  refused(await p.run(["migrate"]), /start from a branch of its own, not dev: git switch -c tickets-to-orbit origin\/dev/);
  p.git("switch", "-q", "tickets-to-orbit");
  writeFileSync(join(p.root, "README.md"), "changed\n");
  refused(await p.run(["migrate"]), /uncommitted changes/);
  p.git("checkout", "--", "README.md");
  writeFileSync(join(p.root, "extra.md"), "x\n");
  p.git("add", "extra.md");
  p.git("commit", "-q", "-m", "extra");
  refused(await p.run(["migrate"]), /must be exactly origin\/dev/);
  assert.deepEqual(p.orbit.writes(), []);
});

test("migrate picks the next free tag name, and stops before removing anything when the tag cannot be pushed", async t => {
  const p = await project(t);
  const day = amsterdamDay();
  // Another commit already holds today's tag on origin.
  p.git("commit", "-q", "--allow-empty", "-m", "elsewhere");
  p.git("tag", `tickets-in-files-${day}`);
  p.git("push", "-q", "origin", `refs/tags/tickets-in-files-${day}`);
  p.git("reset", "-q", "--hard", "origin/dev");
  p.git("tag", "-d", `tickets-in-files-${day}`);
  const start = p.git("rev-parse", "HEAD").trim();
  const output = ok(await p.run(["migrate"]));
  assert.match(output.stdout, new RegExp(`tagged [0-9a-f]{7} as tickets-in-files-${day}-2 \\(pushed\\)`));
  assert.equal(execFileSync("git", ["-C", p.origin, "rev-parse", `tickets-in-files-${day}-2^{commit}`], { encoding: "utf8" }).trim(), start);

  const q = await project(t);
  writeFileSync(join(q.origin, "hooks/pre-receive"), "#!/bin/sh\nwhile read old new ref; do case $ref in refs/tags/*) echo no tags >&2; exit 1;; esac; done\n");
  chmodSync(join(q.origin, "hooks/pre-receive"), 0o755);
  const head = q.git("rev-parse", "HEAD");
  refused(await q.run(["migrate"]), /the tag tickets-in-files-\d{8} could not be pushed to origin, so the ticket files were not removed/);
  assert.equal(q.git("rev-parse", "HEAD"), head);
  assert.equal(q.git("status", "--porcelain").trim(), "");
  assert.equal(q.prCalls(), "");
});

test("a run cut off after making the cards is finished by the next one: the bare cards get their text and no card is made twice", async t => {
  const p = await project(t);
  // The four creates go through; the first text write after them fails.
  p.orbit.controls.writeAnswers.push(...([undefined, undefined, undefined, undefined, { status: 500, code: "server_error", detail: "Down" }] as any[]));
  refused(await p.run(["import"]), /Orbit refused: Down/);
  assert.equal(p.orbit.tasks.length, 4);
  const again = ok(await p.run(["import"]));
  assert.match(again.stdout.trimEnd().split("\n").at(-1)!, /0 created, 4 updated, 0 unchanged, 2 comments added/);
  assert.equal(p.orbit.tasks.length, 4);
  ok(await p.run(["parity"]));
});

test("a board other than kit.json's gets no default parent from kit.json, and migrate drops that old parent from kit.json", async t => {
  const p = await project(t, { settings: { orbit: { project: "TOOLS", parent: "TOOLS-1" } } });
  p.orbit.addTask(p.orbit.tools, { title: "Old parent on another board" });
  ok(await p.run(["import", "--project", "KIT"]));
  assert.ok(p.orbit.writes().filter(write => write.method === "POST").every(write => !write.body.parent_task_id), "no create names a parent");
  const output = ok(await p.run(["migrate", "--project", "KIT"]));
  assert.match(output.stdout, /4\. committed/);
  assert.deepEqual(JSON.parse(readFileSync(join(p.root, "scripts/agents/kit.json"), "utf8")).orbit, { project: "KIT" });
});
