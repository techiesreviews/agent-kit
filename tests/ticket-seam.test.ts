import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { briefTicket, prTicket, withFollowups } from "../ticket.mjs";
import { openOrbitTickets } from "../ticket-cards.mjs";
import { orbitProject, orbitSettings } from "./support/orbit-project.ts";

// The ticket a kit run works on (TOOLS-292): one seam with an Orbit adapter for cards and a files adapter for ticket files.
// kit brief and kit pr ask it, never "Orbit or files" themselves; their own suites keep what a person sees the same.

const filesSettings = { project: "demo", branches: { land: "dev" } };

function project(t: TestContext, settings: Record<string, unknown> = filesSettings) {
  const root = mkdtempSync(join(tmpdir(), "kit-ticket-seam-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "demo", branches: { land: "dev" }, ...settings }));
  const file = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); return path; };
  return { root, file, settings: { ...filesSettings, ...settings } };
}

const ticketText = "---\ntitle: Toolbar\nassignee: demo-1\n---\n\n## Done when\n\n- done\n";

test("a ticket file goes through the files adapter: its text, no card, no claim, nothing closes on landing", async t => {
  const { root, file } = project(t);
  file("docs/build/tickets/01-toolbar.md", ticketText);
  const ticket = await briefTicket({ root, ticket: "docs/build/tickets/01-toolbar.md", who: "demo-lead" });
  assert.equal(ticket.ticket, "docs/build/tickets/01-toolbar.md");
  assert.equal(ticket.text, ticketText);
  assert.equal(ticket.card, undefined);
  assert.equal(ticket.closesOnLanding, false);
  assert.equal(await (await ticket.claim("demo-1"))(), "");
});

test("a missing ticket file says so and points at --task", async t => {
  const { root } = project(t);
  await assert.rejects(briefTicket({ root, ticket: "docs/none.md", who: "demo-lead" }),
    new RegExp(`^Error: no ticket at docs/none\\.md in ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(for a project without ticket files, use --task\\)$`));
});

test("a card key in a files project reads the card through the Orbit adapter but claims and closes nothing", async t => {
  const o = await orbitProject(t);
  const { root } = project(t);
  const task = o.card({ title: "From the board", description: "Do it.\n\nDone when: it works." }, "Todo");
  const printed: string[] = [];
  t.mock.method(console, "error", (line: string) => { printed.push(line); });
  const ticket = await briefTicket({ root, ticket: "KIT-1", who: "demo-lead", env: o.env });
  assert.equal(ticket.ticket, "KIT-1");
  assert.match(ticket.text, /^---\ntitle: "From the board"\norbit: KIT-1\n/);
  assert.equal(ticket.card?.title, "From the board");
  assert.equal(ticket.closesOnLanding, false);
  await ticket.claim("kit-1");
  assert.equal(o.orbit.statusOf(task), "Todo");
  assert.equal(o.orbit.writes().length, 0);
  assert.deepEqual(printed, [], "a files project's card gets no claim warning either");
});

test("a card key with a ticket file at that very path in a files project reads the file", async t => {
  const { root, file } = project(t);
  file("KIT-1", ticketText);
  const ticket = await briefTicket({ root, ticket: "KIT-1", who: "demo-lead" });
  assert.equal(ticket.card, undefined);
  assert.equal(ticket.text, ticketText);
});

test("on Orbit a build claim takes a free card, and a held card is left as it is with a warning", async t => {
  const o = await orbitProject(t);
  const { root } = project(t, orbitSettings);
  const free = o.card({ title: "Free" }, "Todo");
  const held = o.card({ title: "Held", description: "Claimed by: someone-else\n\nDone when: it works." }, "In Progress");
  const warnings: string[] = [];
  t.mock.method(console, "error", (line: string) => { warnings.push(line); });
  const first = await briefTicket({ root, ticket: "KIT-1", who: "demo-lead", env: o.env });
  assert.equal(first.closesOnLanding, true);
  await first.claim("kit-1");
  assert.equal(o.orbit.statusOf(free), "In Progress");
  assert.match(free.description, /Claimed by: kit-1/);
  const second = await briefTicket({ root, ticket: "KIT-2", who: "demo-lead", env: o.env });
  await second.claim("kit-2");
  assert.match(held.description, /Claimed by: someone-else/);
  assert.ok(warnings.some(line => /^warning: KIT-2 is left as it is, not claimed for kit-2: someone-else holds it/.test(line)), warnings.join("\n"));
});

test("kit pr with no ticket keeps no notes and closes nothing", async t => {
  const { root, settings } = project(t);
  const ticket = await prTicket({ root, settings, ticket: undefined, who: "demo-1", folder: root });
  assert.equal(ticket.path, undefined);
  assert.equal(ticket.cardKey, null);
  assert.equal(ticket.keepsNotes, false);
  ticket.noteFollowups(["- later"]);
  assert.equal(await ticket.land({ pr: "https://github.com/x/y/pull/1", sha: "abc" }), null);
  assert.equal(await ticket.queued({ pr: "https://github.com/x/y/pull/1", number: "1", folder: root, comment: async () => {} }), null);
});

test("kit pr with a ticket file keeps kit's notes in it and closes no card", async t => {
  const { root, file, settings } = project(t);
  file("docs/build/tickets/01-toolbar.md", ticketText);
  const ticket = await prTicket({ root, settings, ticket: "docs/build/tickets/01-toolbar.md", who: "demo-1", folder: root });
  assert.equal(ticket.path, "docs/build/tickets/01-toolbar.md");
  assert.equal(ticket.cardKey, null);
  assert.equal(ticket.keepsNotes, true);
  assert.equal(await ticket.land({ pr: "https://github.com/x/y/pull/1", sha: "abc" }), null);
});

test("kit pr in a files project takes a card's brief as a file, as before: no card closes", async t => {
  const { root, file, settings } = project(t);
  const brief = file(".scratch/kit-tickets/KIT-1.md", "---\ntitle: Card\norbit: KIT-1\n---\n\nOrbit card KIT-1\n");
  const ticket = await prTicket({ root, settings, ticket: brief, who: "demo-1", folder: root });
  assert.equal(ticket.cardKey, null);
  assert.equal(ticket.keepsNotes, true);
  assert.equal(ticket.path, brief);
});

test("on Orbit kit pr reads a KEY into its run folder's brief and closes the card on landing with its follow-ups", async t => {
  const o = await orbitProject(t);
  const { root, settings } = project(t, orbitSettings);
  const task = o.card({ title: "Straight from the card", description: "Claimed by: kit-1\n\nDone when: it works." }, "In Progress");
  const folder = mkdtempSync(join(tmpdir(), "kit-ticket-seam-run-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const ticket = await prTicket({ root, settings, ticket: "KIT-1", who: "kit-1", folder, env: o.env });
  assert.equal(ticket.cardKey, "KIT-1");
  assert.equal(ticket.keepsNotes, false);
  assert.ok(existsSync(join(folder, "KIT-1.md")));
  assert.ok(!existsSync(join(root, ".scratch/kit-tickets/KIT-1.md")), "kit pr never saves a worktree brief");
  assert.match(readFileSync(join(root, ticket.path!), "utf8"), /^---\ntitle: Straight from the card\norbit: KIT-1\n/);
  ticket.noteFollowups(["- R1-3 (P2): tidy the loop"]);
  const landed = await ticket.land({ pr: "https://github.com/x/y/pull/7", sha: "abcdef0" });
  assert.equal(landed?.line, "card: KIT-1 Done (https://github.com/x/y/pull/7)");
  assert.equal(landed?.suffix, " (card KIT-1 Done)");
  assert.equal(o.orbit.statusOf(task), "Done");
  const notes = o.orbit.comments[task.id].map((note: { body: string }) => note.body).join("\n");
  assert.match(notes, /Landed in https:\/\/github\.com\/x\/y\/pull\/7 \(merge commit abcdef0\)/);
  assert.match(notes, /Follow-ups from https:\/\/github\.com\/x\/y\/pull\/7:\n- R1-3 \(P2\): tidy the loop/);
});

test("on Orbit a queued PR leaves the card open and puts its follow-ups on the card, or in a PR comment when Orbit refuses them", async t => {
  const o = await orbitProject(t);
  const { root, file, settings } = project(t, orbitSettings);
  const task = o.card({ title: "Queued", description: "Claimed by: kit-1\n\nDone when: it works." }, "In Progress");
  const brief = file(".scratch/kit-tickets/KIT-1.md", "---\ntitle: Queued\norbit: KIT-1\n---\n\n### UX follow-ups\n\n- the button sits low\n");
  const ticket = await prTicket({ root, settings, ticket: brief, who: "kit-1", folder: root, env: o.env });
  ticket.noteFollowups(["- R1-1 (P2): name the step"]);
  const posted: string[] = [];
  const queued = await ticket.queued({ pr: "https://github.com/x/y/pull/8", number: "8", folder: root, comment: async (path: string) => { posted.push(path); } });
  assert.equal(queued?.line, "card: KIT-1 stays open: nothing here waits for the queue; run kit ticket update KIT-1 --status Done once #8 lands");
  assert.equal(queued?.words, "; card KIT-1 stays open: close it once #8 lands");
  assert.equal(o.orbit.statusOf(task), "In Progress");
  assert.equal(o.orbit.comments[task.id][0].body.replace(/^\d{4}-\d{2}-\d{2} /, ""), "Follow-ups from https://github.com/x/y/pull/8:\n- R1-1 (P2): name the step\n- the button sits low");
  assert.deepEqual(posted, []);

  o.orbit.controls.refuseComments = /Follow-ups/;
  const again = await prTicket({ root, settings, ticket: brief, who: "kit-1", folder: root, env: o.env });
  const refused = await again.queued({ pr: "https://github.com/x/y/pull/8", number: "8", folder: root, comment: async (path: string) => { posted.push(path); } });
  assert.match(refused!.line, /; run kit ticket update KIT-1 --status Done once #8 lands \(its follow-ups were not added: .*; they are in a PR comment\)$/);
  assert.deepEqual(posted, [join(root, "card-followups.md")]);
  assert.equal(readFileSync(posted[0], "utf8"), "Follow-ups for card KIT-1 (Orbit did not take them):\n- the button sits low\n");
});

test("on Orbit a queued PR from a KEY adds only its review follow-ups: the run folder's brief adds none of its own", async t => {
  const o = await orbitProject(t);
  const { root, settings } = project(t, orbitSettings);
  const task = o.card({ title: "From a key", description: "Claimed by: kit-1\n\n### UX follow-ups\n\n- the button sits low\n\nDone when: it works." }, "In Progress");
  const folder = mkdtempSync(join(tmpdir(), "kit-ticket-seam-run-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const ticket = await prTicket({ root, settings, ticket: "KIT-1", who: "kit-1", folder, env: o.env });
  assert.match(readFileSync(join(root, ticket.path!), "utf8"), /### UX follow-ups\n\n- the button sits low/, "the brief holds the card's own UX line");
  ticket.noteFollowups(["- R1-1 (P2): x"]);
  await ticket.queued({ pr: "https://github.com/x/y/pull/9", number: "9", folder, comment: async () => {} });
  assert.deepEqual(o.orbit.comments[task.id].map((note: { body: string }) => note.body.replace(/^\d{4}-\d{2}-\d{2} /, "")),
    ["Follow-ups from https://github.com/x/y/pull/9:\n- R1-1 (P2): x"]);
});

test("the files adapter writes follow-ups into the ticket's last Done section, once", () => {
  const plain = "---\ntitle: T\n---\n\nBody\n";
  const added = withFollowups(plain, { lines: ["- one", "- two"], today: "2026-11-21" });
  assert.equal(added, "---\ntitle: T\n---\n\nBody\n\n## Done (2026-11-21)\n\n### Follow-ups\n\n- one\n- two\n\n");
  assert.equal(withFollowups(added, { lines: ["- one", "- two"], today: "2026-11-22" }), added, "a rerun adds nothing");
  const extended = withFollowups(added, { lines: ["- one", "- three"], today: "2026-11-22" });
  assert.equal(extended, "---\ntitle: T\n---\n\nBody\n\n## Done (2026-11-21)\n\n### Follow-ups\n\n- one\n- two\n- three\n\n");
  // A bullet cut at 160 characters by an older run is swapped for its full text.
  const full = `- ${"x".repeat(200)}`, cut = `- ${"x".repeat(158)}…`;
  const old = withFollowups(plain, { lines: [cut], today: "2026-11-21" });
  assert.equal(withFollowups(old, { lines: [full], cut: [cut], today: "2026-11-21" }), old.replace(cut, full));
});

test("the Orbit store is opened in one place: kit ticket's dry run and board come through openOrbitTickets", async t => {
  const o = await orbitProject(t);
  const opened = openOrbitTickets({ settings: orbitSettings, who: "demo-lead", env: o.env, dryRun: true, project: "TOOLS", parent: null, problem: "" });
  assert.equal(opened.project, "TOOLS");
  assert.equal(opened.parent, null);
  assert.equal(typeof opened.redactCard, "function");
  o.card({ title: "Untouched" }, "Todo");
  const dry = await opened.store.comment("KIT-1", "a note");
  assert.equal(dry.dry.method, "POST");
  assert.equal(o.orbit.writes().length, 0);
  assert.equal(openOrbitTickets({ settings: orbitSettings, who: "demo-lead", env: o.env }).project, "KIT");
});
