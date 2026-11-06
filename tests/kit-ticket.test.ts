import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { orbitDate, orbitStore, showDate, ticketSettings, withBlockedBy, withNote, withPlannedDates, withoutNextLex } from "../ticket-store.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { orbitRedactor, orbitReport } from "../orbit-client.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { cloudflarePassFrom } from "../orbit-setup.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { kitSettingsProblems } from "../kit-lib.mjs";
import { kitEnv } from "./support/kit-env.ts";
import { fakeCfId, fakeCfSecret, fakeOrbit, fakeToken, fakeWorkspace } from "./support/fake-orbit.ts";

const ticket = resolve("kit.d/ticket");
const kit = resolve("kit");
const secrets = [fakeToken, fakeCfId, fakeCfSecret];

type Run = { status: number | null; stdout: string; stderr: string; all: string };

/** Runs a command with its own HOME, feeding `input` and never blocking the fake server in this process. */
function start(command: string, args: string[], env: NodeJS.ProcessEnv, input = ""): Promise<Run> {
  return new Promise(done => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => done({ status, stdout, stderr, all: stdout + stderr }));
    // A command may end without reading its input: that is its answer, not this suite's error.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function fixture(t: TestContext, settings: object = { tickets: "orbit", orbit: { project: "TOOLS" } }) {
  const home = mkdtempSync(join(tmpdir(), "kit-ticket-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(home, "project");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-ticket", branches: { land: "dev" }, ...settings }));
  const env: NodeJS.ProcessEnv = { ...kitEnv(), HOME: home, KIT_ROOT: root, ORBIT_ROLE: "lead", ASE_OWNER: "test-lead", XDG_STATE_HOME: join(home, "state") };
  for (const name of ["XDG_CONFIG_HOME", "KIT_LIB_MJS", "KIT_LIB", "NODE_TEST_CONTEXT"]) delete env[name];
  const orbit = await fakeOrbit(t);
  const configPath = join(home, ".config/fleet/orbit.json");
  const logPath = join(home, "state/fleet/orbit.log");
  const config = { origin: orbit.origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret };
  const save = (value: object | string = config, mode = 0o600) => {
    mkdirSync(join(home, ".config/fleet"), { recursive: true, mode: 0o700 });
    writeFileSync(configPath, typeof value === "string" ? value : JSON.stringify(value), { mode });
    chmodSync(configPath, mode);
  };
  save();
  const run = async (args: string[], extra: NodeJS.ProcessEnv = {}, input = "") => {
    const output = await start(process.execPath, [ticket, ...args], { ...env, ...extra }, input);
    for (const secret of secrets) assert.ok(!output.all.includes(secret), `a secret was printed by: ${args.join(" ")}`);
    if (!args.includes("--help")) assert.match(output.stdout.trimEnd().split("\n").at(-1)!, /^RESULT: (ok|fail) /, output.all);
    return output;
  };
  const log = () => existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  return { home, root, env, orbit, run, save, configPath, logPath, log, config };
}

const lines = (text: string) => text.trimEnd().split("\n");
const result = (output: Run) => lines(output.stdout).at(-1)!;
function ok(output: Run) { assert.equal(output.status, 0, output.all); assert.match(result(output), /^RESULT: ok /); return output; }
function refused(output: Run, pattern: RegExp) { assert.notEqual(output.status, 0, output.all); assert.match(result(output), /^RESULT: fail /); assert.match(output.all, pattern); return output; }

test("create makes a card in the project's board with the first open status, and in a named project with --project", async t => {
  const { orbit, run, log } = await fixture(t);
  const made = ok(await run(["create", "--title", "First", "--description", "Body", "--priority", "high"]));
  assert.match(made.stdout, /TOOLS-1/);
  assert.equal(orbit.tasks[0].title, "First");
  assert.equal(orbit.tasks[0].description, "Body");
  assert.equal(orbit.tasks[0].priority, "high");
  assert.equal(orbit.statusOf(orbit.tasks[0]), "Idea");
  assert.match(log(), /card=TOOLS-1 action=create fields=.*title.* who=test-lead result=ok/);

  ok(await run(["create", "--project", "VID", "--title", "Other", "--status", "script"]));
  assert.equal(orbit.tasks[1].identifier, "VID-1");
  assert.equal(orbit.statusOf(orbit.tasks[1]), "Script");
  ok(await run(["create", "--project", "video production", "--title", "By name"]));
  assert.equal(orbit.tasks[2].identifier, "VID-2");
});

test("create reads its description from a file or standard input, and names the choices for an unknown project or status", async t => {
  const { home, orbit, run } = await fixture(t);
  const file = join(home, "body.md");
  writeFileSync(file, "From a file\n");
  ok(await run(["create", "--title", "A", "--description-file", file]));
  assert.equal(orbit.tasks[0].description, "From a file\n");
  ok(await run(["create", "--title", "B", "--description-file", "-"], {}, "From stdin"));
  assert.equal(orbit.tasks[1].description, "From stdin");
  refused(await run(["create", "--title", "C", "--project", "NOPE"]), /TOOLS.*VID/);
  refused(await run(["create", "--title", "C", "--status", "Nope"]), /Idea, Script, Record, Edit, Publish/);
  refused(await run(["create", "--description", "No title"]), /--title/);
  assert.equal(orbit.tasks.length, 2);
});

test("a project with no Orbit setting needs --project, and kit ticket still works outside any kit project", async t => {
  const { home, orbit, run } = await fixture(t, {});
  refused(await run(["create", "--title", "A"]), /--project/);
  ok(await run(["create", "--title", "A", "--project", "TOOLS"]));
  assert.equal(orbit.tasks.length, 1);
  const outside = join(home, "elsewhere");
  mkdirSync(outside);
  ok(await run(["get", "TOOLS-1"], { KIT_ROOT: outside }));
  ok(await run(["list", "--project", "TOOLS"], { KIT_ROOT: outside }));
});

test("get shows status name, assignees, next step, blockers, dates and comments; --json gives the card", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { title: "Shown", description: "Next step (Lex): record it\n\nBlocked by: TOOLS-9, VID-2\n\nText", assignee_ids: ["user-a", "user-b"], priority: "urgent",
    due_start_at: "2026-11-05T23:00:00.000Z", due_at: "2026-11-07T22:59:00.000Z" });
  orbit.comments[task.id] = [{ id: "c1", body: "A comment", author_service_account: { name: "fleet" }, created_at: "2026-11-06T10:00:00.000Z" }];
  const shown = ok(await run(["get", "tools-1", "--comments"]));
  assert.match(shown.stdout, /TOOLS-1\s+Shown/);
  assert.match(shown.stdout, /Status: Idea/);
  assert.match(shown.stdout, /Priority: urgent/);
  assert.match(shown.stdout, /Assignees \(assignee_ids\): user-a, user-b/);
  assert.match(shown.stdout, /Next step \(Lex\): record it/);
  assert.match(shown.stdout, /Blocked by: TOOLS-9, VID-2/);
  assert.match(shown.stdout, /start 2026-11-06, due 2026-11-07/);
  assert.match(shown.stdout, /A comment/);
  const json = JSON.parse(ok(await run(["get", "TOOLS-1", "--json"])).stdout.split("\nRESULT:")[0]);
  assert.equal(json.identifier, "TOOLS-1");
  assert.equal(json.status_name, "Idea");
  assert.deepEqual(json.assignee_ids, ["user-a", "user-b"]);
  assert.deepEqual(json.blocked_by, ["TOOLS-9", "VID-2"]);
  assert.equal(json.next_lex, "record it");
  refused(await run(["get", "TOOLS-99"]), /does not exist/);
  refused(await run(["get", "../../me"]), /card key/i);
  assert.ok(!orbit.requests.some(item => item.path.endsWith("/me")), "a bad key never reaches Orbit");
});

test("list shows assignee ids, filters by status, parent, assignee and text, follows pages and says when more exist", async t => {
  const { orbit, run } = await fixture(t);
  const parent = orbit.addTask(orbit.tools, { title: "Parent" });
  orbit.addTask(orbit.tools, { title: "Child", parent_task_id: parent.id, assignee_ids: ["user-a"], status_id: orbit.statuses.get(orbit.tools.id)![2].id });
  orbit.addTask(orbit.video, { title: "Video card" });
  const all = ok(await run(["list"]));
  assert.match(all.stdout, /TOOLS-2.*Record.*user-a.*Child/);
  assert.ok(!all.stdout.includes("VID-1"), "the project's own board only");
  assert.match(ok(await run(["list", "--project", "VID"])).stdout, /VID-1.*Video card/);
  const byStatus = ok(await run(["list", "--status", "Record"]));
  assert.ok(byStatus.stdout.includes("TOOLS-2") && !byStatus.stdout.includes("TOOLS-1 "));
  assert.ok(ok(await run(["list", "--parent", "TOOLS-1"])).stdout.includes("Child"));
  const none = ok(await run(["list", "--assignee", "none"]));
  assert.ok(none.stdout.includes("TOOLS-1") && !none.stdout.includes("TOOLS-2"));
  assert.ok(ok(await run(["list", "--q", "child"])).stdout.includes("TOOLS-2"));

  for (let index = 0; index < 120; index++) orbit.addTask(orbit.tools, { title: `Many ${index}` });
  const before = orbit.requests.length;
  const many = ok(await run(["list", "--limit", "110"]));
  assert.equal(lines(many.stdout).filter(line => /^TOOLS-/.test(line)).length, 110);
  assert.match(result(many), /110 cards; more exist/);
  assert.equal(orbit.requests.slice(before).filter(item => item.path.endsWith("/tasks")).length, 2, "follows two pages and stops");
  const json = JSON.parse(ok(await run(["list", "--limit", "2", "--json"])).stdout.split("\nRESULT:")[0]);
  assert.equal(json.length, 2);
  assert.ok(Array.isArray(json[0].assignee_ids));
  refused(await run(["list", "--limit", "0"]), /--limit/);
});

test("update changes title, description, status by name and priority, and reads the latest version first", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  const version = task.version;
  ok(await run(["update", "TOOLS-1", "--title", "New", "--description", "Text", "--status", "edit", "--priority", "low"]));
  assert.equal(task.title, "New");
  assert.equal(task.description, "Text");
  assert.equal(orbit.statusOf(task), "Edit");
  assert.equal(task.priority, "low");
  const patch = orbit.writes()[0];
  assert.equal(patch.body.expected_version, version);
  const position = orbit.requests.indexOf(patch);
  assert.ok(orbit.requests.slice(0, position).some(item => item.method === "GET" && item.path.endsWith("/tasks/TOOLS-1")), "reads the card before the write");
  assert.match(log(), /card=TOOLS-1 action=update fields=title,description,status_id,priority who=test-lead result=ok/);
  refused(await run(["update", "TOOLS-1", "--priority", "huge"]), /none, low, medium, high, urgent/);
  refused(await run(["update", "TOOLS-1"]), /nothing to change/i);
  const noChange = ok(await run(["update", "TOOLS-1", "--title", "New"]));
  assert.match(result(noChange), /already/);
  assert.equal(orbit.writes().length, 1, "no write when nothing changes");
});

test("update sets blockers in a description line, because the public API has no relations, and clears them", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Next step (Lex): choose\n\nText" });
  ok(await run(["update", "TOOLS-1", "--blocked-by", "tools-2,VID-3"]));
  assert.equal(task.description, "Next step (Lex): choose\n\nBlocked by: TOOLS-2, VID-3\n\nText");
  ok(await run(["update", "TOOLS-1", "--blocked-by", "TOOLS-4"]));
  assert.equal(task.description, "Next step (Lex): choose\n\nBlocked by: TOOLS-4\n\nText");
  ok(await run(["update", "TOOLS-1", "--blocked-by", "none"]));
  assert.equal(task.description, "Next step (Lex): choose\n\nText");
  refused(await run(["update", "TOOLS-1", "--blocked-by", "nonsense"]), /card key/i);
});

test("dates sets real start and due, writes the Planned dates line with its source, and never a date without one", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  refused(await run(["dates", "TOOLS-1", "--due", "2026-11-30"]), /--source/);
  refused(await run(["dates", "TOOLS-1", "--due", "2026-11-30", "--source", "  "]), /--source/);
  assert.equal(orbit.writes().length, 0);
  ok(await run(["dates", "TOOLS-1", "--start", "2026-11-06", "--due", "2026-11-30", "--source", "plan.md"]));
  assert.equal(task.due_start_at, "2026-11-05T23:00:00.000Z");
  assert.equal(task.due_at, "2026-11-30T22:59:00.000Z");
  assert.equal(task.description, "Text\n\nPlanned dates: start 2026-11-06, due 2026-11-30 (source: plan.md)");
  assert.match(log(), /action=dates fields=description,due_start_at,due_at/);

  ok(await run(["dates", "TOOLS-1", "--due", "2026-12-01", "--source", "Lex in chat"]));
  assert.equal(task.due_start_at, "2026-11-05T23:00:00.000Z");
  assert.equal(task.description, "Text\n\nPlanned dates: start 2026-11-06, due 2026-12-01 (source: Lex in chat; before: plan.md)");

  ok(await run(["dates", "TOOLS-1", "--due", "2026-12-02T09:30:00+01:00", "--source", "calendar"]));
  assert.equal(task.due_at, "2026-12-02T08:30:00.000Z");
  assert.match(task.description, /due 2026-12-02T08:30:00.000Z \(source: calendar; before: Lex in chat\)/);

  ok(await run(["dates", "TOOLS-1", "--clear"]));
  assert.equal(task.due_at, null);
  assert.equal(task.due_start_at, null);
  assert.equal(task.description, "Text");

  refused(await run(["dates", "TOOLS-1", "--start", "2026-11-06", "--source", "x"]), /due date/);
  refused(await run(["dates", "TOOLS-1", "--start", "2026-12-06", "--due", "2026-12-05", "--source", "x"]), /after/);
  refused(await run(["dates", "TOOLS-1", "--due", "2026-02-30", "--source", "x"]), /2026-02-30/);
  refused(await run(["dates", "TOOLS-1", "--due", "next week", "--source", "x"]), /YYYY-MM-DD/);
  refused(await run(["dates", "TOOLS-1", "--clear", "--due", "2026-12-05", "--source", "x"]), /--clear/);
  refused(await run(["dates", "TOOLS-1"]), /--start|--due/);
});

test("a plain date is a day in Europe/Amsterdam on both sides of the March and October clock changes", () => {
  // Winter (+01:00) until 29 March 2026 02:00, summer (+02:00) until 25 October 2026 03:00.
  assert.equal(orbitDate("2026-03-28", "start"), "2026-03-27T23:00:00.000Z");
  assert.equal(orbitDate("2026-03-28", "due"), "2026-03-28T22:59:00.000Z");
  assert.equal(orbitDate("2026-03-29", "start"), "2026-03-28T23:00:00.000Z");
  assert.equal(orbitDate("2026-03-29", "due"), "2026-03-29T21:59:00.000Z");
  assert.equal(orbitDate("2026-03-30", "start"), "2026-03-29T22:00:00.000Z");
  assert.equal(orbitDate("2026-10-24", "due"), "2026-10-24T21:59:00.000Z");
  assert.equal(orbitDate("2026-10-25", "start"), "2026-10-24T22:00:00.000Z");
  assert.equal(orbitDate("2026-10-25", "due"), "2026-10-25T22:59:00.000Z");
  assert.equal(orbitDate("2026-10-26", "start"), "2026-10-25T23:00:00.000Z");
  for (const day of ["2026-03-29", "2026-10-25", "2026-07-01", "2026-01-01"]) {
    assert.equal(showDate(orbitDate(day, "start"), "start"), day);
    assert.equal(showDate(orbitDate(day, "due"), "due"), day);
  }
  assert.equal(showDate("2026-07-01T10:15:00.000Z", "due"), "2026-07-01T10:15:00.000Z");
  // An exact midnight is not the end of a due day, and an exact 23:59 is not the start of a day.
  assert.equal(showDate(orbitDate("2026-12-02T00:00:00+01:00", "due"), "due"), "2026-12-01T23:00:00.000Z");
  assert.equal(showDate(orbitDate("2026-12-02T23:59:00+01:00", "start"), "start"), "2026-12-02T22:59:00.000Z");
  assert.equal(orbitDate("2026-07-01T10:15:00Z", "due"), "2026-07-01T10:15:00.000Z");
  assert.equal(orbitDate("2026-07-01T10:15:00.5+02:00", "due"), "2026-07-01T08:15:00.500Z");
  for (const bad of ["2026-13-01", "2026-02-30", "2026-02-30T10:00:00Z", "2026-07-01T25:00:00Z", "2026-07-01T10:15:00", "tomorrow", ""]) {
    assert.throws(() => orbitDate(bad, "due"), /YYYY-MM-DD/, bad);
  }
});

test("note adds a dated line under Notes, and comment adds a real Orbit comment", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  ok(await run(["note", "TOOLS-1", "first\nnote"]));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
  assert.equal(task.description, `Text\n\n## Notes\n\n- ${today} (test-lead): first note`);
  ok(await run(["note", "TOOLS-1", "second"]));
  assert.equal(task.description, `Text\n\n## Notes\n\n- ${today} (test-lead): first note\n- ${today} (test-lead): second`);
  refused(await run(["note", "TOOLS-1", "  "]), /text/i);
  ok(await run(["comment", "TOOLS-1", "A real comment"]));
  assert.equal(orbit.comments[task.id][0].body, "A real comment");
  assert.match(log(), /action=comment fields=body/);
  refused(await run(["comment", "TOOLS-1", " "]), /text/i);
});

test("sub-tasks: create --parent, the project's default parent, update --parent and the sub-tasks list", async t => {
  const { orbit, run } = await fixture(t, { tickets: "orbit", orbit: { project: "TOOLS", parent: "TOOLS-1" } });
  const parent = orbit.addTask(orbit.tools, { title: "Parent" });
  orbit.addTask(orbit.tools, { title: "Other parent" });
  ok(await run(["create", "--title", "Uses the default"]));
  assert.equal(orbit.tasks[2].parent_task_id, parent.id);
  ok(await run(["create", "--title", "Own parent", "--parent", "TOOLS-2"]));
  assert.equal(orbit.tasks[3].parent_task_id, orbit.tasks[1].id);
  ok(await run(["create", "--title", "No parent", "--no-parent"]));
  assert.equal(orbit.tasks[4].parent_task_id, null);
  ok(await run(["create", "--project", "VID", "--title", "Another board"]));
  assert.equal(orbit.tasks[5].parent_task_id, null, "the default parent belongs to the project's own board only");
  refused(await run(["create", "--title", "x", "--parent", "TOOLS-99"]), /does not exist/);

  ok(await run(["update", "TOOLS-5", "--parent", "TOOLS-2"]));
  assert.equal(orbit.tasks[4].parent_task_id, orbit.tasks[1].id);
  ok(await run(["update", "TOOLS-5", "--parent", "none"]));
  assert.equal(orbit.tasks[4].parent_task_id, null);
  const subs = ok(await run(["sub-tasks", "TOOLS-1"]));
  assert.match(subs.stdout, /TOOLS-3.*Uses the default/);
  assert.ok(!subs.stdout.includes("Own parent"));
});

test("next-lex writes the first description line, replaces an old one, and clear-next-lex takes it out", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text", assignee_ids: ["lex"] });
  const set = ok(await run(["next-lex", "TOOLS-1", "record\nthe intro"]));
  assert.equal(task.description, "Next step (Lex): record the intro\n\nText");
  assert.match(set.all, /assign/i);
  ok(await run(["next-lex", "TOOLS-1", "approve it"]));
  assert.equal(task.description, "Next step (Lex): approve it\n\nText");
  refused(await run(["next-lex", "TOOLS-1", " "]), /reason/);
  const cleared = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.equal(task.description, "Text");
  assert.match(cleared.all, /unassign/i);
  const again = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.match(result(again), /already/);
  const empty = orbit.addTask(orbit.tools, { description: "" });
  ok(await run(["next-lex", "TOOLS-2", "go"]));
  assert.equal(empty.description, "Next step (Lex): go");
});

test("trash moves a card to Orbit's trash only with Lex's words, and a permanent delete cannot be asked for", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  orbit.addTask(orbit.tools, { parent_task_id: task.id });
  refused(await run(["trash", "TOOLS-1"]), /--lex-said/);
  refused(await run(["trash", "TOOLS-1", "--lex-said", "  "]), /--lex-said/);
  assert.equal(orbit.writes().length, 0);
  refused(await run(["trash", "TOOLS-1", "--lex-said", "yes", "--permanent"]), /--permanent/);
  refused(await run(["trash", "TOOLS-1", "--lex-said", "yes", "--force"]), /--force/);
  assert.equal(orbit.writes().length, 0);
  const version = task.version;
  const done = ok(await run(["trash", "TOOLS-1", "--lex-said", "bin that card"]));
  assert.match(done.all, /1 directly under it/);
  assert.match(done.all, /30 days/);
  assert.equal(task.trashed, true);
  const remove = orbit.writes()[0];
  assert.equal(remove.method, "DELETE");
  assert.equal(remove.query.get("expected_version"), String(version));
  assert.equal(remove.query.get("permanent"), null, "never permanent");
  assert.match(log(), /action=trash fields=trash who=test-lead result=ok lex_said="bin that card"/);
  const source = readFileSync(resolve("orbit-client.mjs"), "utf8") + readFileSync(resolve("ticket-store.mjs"), "utf8") + readFileSync(ticket, "utf8");
  assert.ok(!/permanent=|["']permanent["']|permanent:/.test(source), "no code path can send the permanent flag");
});

test("Publish and the Scheduled in Radaar tick need Lex's words, wherever they come from", async t => {
  const { orbit, run, log, home } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "- [ ] Scheduled in Radaar\n- [ ] X text" });
  refused(await run(["update", "TOOLS-1", "--status", "publish"]), /--lex-said/);
  refused(await run(["create", "--title", "x", "--status", "Publish"]), /--lex-said/);
  refused(await run(["update", "TOOLS-1", "--description", "- [x] Scheduled in Radaar\n- [ ] X text"]), /--lex-said/);
  refused(await run(["update", "TOOLS-1", "--description", "*  [X]  scheduled in radaar"]), /--lex-said/);
  const file = join(home, "ticked.md");
  writeFileSync(file, "- [x] Scheduled in Radaar\n");
  refused(await run(["update", "TOOLS-1", "--description-file", file]), /--lex-said/);
  refused(await run(["create", "--title", "x", "--description-file", file]), /--lex-said/);
  assert.equal(orbit.writes().length, 0);
  assert.equal(orbit.statusOf(task), "Idea");

  ok(await run(["update", "TOOLS-1", "--description", "- [ ] Scheduled in Radaar\n- [x] X text"]));
  ok(await run(["update", "TOOLS-1", "--description", "- [x] Scheduled in Radaar\n- [x] X text", "--lex-said", "tick it, I scheduled them"]));
  assert.match(task.description, /\[x\] Scheduled/);
  assert.match(log(), /lex_said="tick it, I scheduled them"/);
  ok(await run(["update", "TOOLS-1", "--title", "Ticked already"]));
  ok(await run(["update", "TOOLS-1", "--status", "Publish", "--lex-said", "publish it"]));
  assert.equal(orbit.statusOf(task), "Publish");
  ok(await run(["update", "TOOLS-1", "--status", "Publish"]));
  ok(await run(["update", "TOOLS-1", "--status", "Edit"]));
  assert.equal(orbit.statusOf(task), "Edit");
});

test("writes need ORBIT_ROLE=lead; reads work for anyone", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  for (const role of [{ ORBIT_ROLE: "" }, { ORBIT_ROLE: "helper" }]) {
    for (const args of [["create", "--title", "x"], ["update", "TOOLS-1", "--title", "x"], ["dates", "TOOLS-1", "--due", "2026-11-30", "--source", "s"], ["note", "TOOLS-1", "x"],
      ["comment", "TOOLS-1", "x"], ["next-lex", "TOOLS-1", "x"], ["clear-next-lex", "TOOLS-1"], ["trash", "TOOLS-1", "--lex-said", "x"]]) {
      refused(await run(args, role), /ORBIT_ROLE=lead/);
    }
    ok(await run(["get", "TOOLS-1"], role));
    ok(await run(["list"], role));
    ok(await run(["sub-tasks", "TOOLS-1"], role));
  }
  assert.equal(orbit.writes().length, 0);
  assert.equal(log(), "");
});

test("--dry-run on every write prints the exact change, sends nothing and logs nothing, also for a helper", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  const version = task.version;
  const update = ok(await run(["update", "TOOLS-1", "--title", "New", "--dry-run"], { ORBIT_ROLE: "" }));
  assert.match(update.stdout, /PATCH .*\/tasks\/TOOLS-1/);
  assert.equal(JSON.parse(update.stdout.slice(update.stdout.indexOf("{"), update.stdout.lastIndexOf("}") + 1)).expected_version, version);
  assert.match(update.stdout, /"title": "New"/);
  assert.match(update.stdout, /nothing was sent/i);
  assert.match(ok(await run(["create", "--title", "x", "--dry-run"])).stdout, /POST .*\/tasks[\s\S]*"title": "x"/);
  assert.match(ok(await run(["dates", "TOOLS-1", "--due", "2026-11-30", "--source", "s", "--dry-run"])).stdout, /"due_at": "2026-11-30T22:59:00.000Z"[\s\S]*Planned dates|Planned dates[\s\S]*"due_at"/);
  assert.match(ok(await run(["note", "TOOLS-1", "hello", "--dry-run"])).stdout, /hello/);
  assert.match(ok(await run(["comment", "TOOLS-1", "hello", "--dry-run"])).stdout, /POST .*comments[\s\S]*"body": "hello"/);
  assert.match(ok(await run(["next-lex", "TOOLS-1", "go", "--dry-run"])).stdout, /Next step \(Lex\): go/);
  ok(await run(["clear-next-lex", "TOOLS-1", "--dry-run"]));
  const trash = ok(await run(["trash", "TOOLS-1", "--lex-said", "x", "--dry-run"]));
  assert.match(trash.stdout, /DELETE .*\/tasks\/TOOLS-1\?expected_version=/);
  assert.equal(orbit.writes().length, 0);
  assert.equal(log(), "");
  assert.equal(task.description, "Text");
  // Its guards still answer: a dry run of a refused change is refused.
  refused(await run(["update", "TOOLS-1", "--status", "Publish", "--dry-run"]), /--lex-said/);
});

test("one version conflict re-reads and retries, keeping the other person's edit; a second one is reported", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.description += "\nTheir line"; };
  const noted = ok(await run(["note", "TOOLS-1", "mine"]));
  assert.match(noted.stdout, /TOOLS-1/);
  assert.match(task.description, /Their line/);
  assert.match(task.description, /mine/);
  assert.equal(orbit.writes().filter(item => item.method === "PATCH").length, 2);
  assert.equal((log().match(/action=note/g) ?? []).length, 1, "one log line for one change");

  orbit.controls.conflicts = 2;
  orbit.controls.concurrentEdit = undefined;
  const before = orbit.writes().length;
  refused(await run(["note", "TOOLS-1", "again"]), /changed again.*nothing.*saved|nothing.*saved.*changed/is);
  assert.equal(orbit.writes().length - before, 2, "one retry, no loop");
  assert.match(log(), /action=note fields=description who=test-lead result=fail:conflict/);
  assert.ok(!task.description.includes("again"));
});

test("a retry never overwrites a field someone else changed meanwhile, and only a version conflict retries", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Theirs" });
  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.description = "Their newer text"; };
  refused(await run(["update", "TOOLS-1", "--description", "Mine"]), /description.*changed|changed.*description/i);
  assert.equal(task.description, "Their newer text");

  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.description = "Newest"; };
  ok(await run(["update", "TOOLS-1", "--title", "Mine"]));
  assert.equal(task.title, "Mine");
  assert.equal(task.description, "Newest");

});

test("a retry that stops still leaves one log line for the write Orbit refused", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools, { description: "Theirs" });
  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.description = "Their newer text"; };
  refused(await run(["update", "TOOLS-1", "--description", "Mine"]), /changed/);
  assert.equal((log().match(/action=update fields=description who=test-lead result=fail:conflict/g) ?? []).length, 1);
});

test("a retry that finds the card already as asked still logs the write Orbit refused", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  // The change someone else already made: the retry has nothing to send, and the refused write is on the log.
  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.description = "Next step (Lex): go"; };
  assert.match(result(ok(await run(["next-lex", "TOOLS-1", "go"]))), /already/);
  assert.equal(lines(log()).length, 1);
  assert.match(lines(log()).at(-1)!, /action=next-lex fields=description who=test-lead result=fail:conflict/);
});

test("a create with no answer says to look for the card before trying again", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.controls.writeAnswers.push("drop");
  refused(await run(["create", "--title", "Maybe made"]), /may or may not have been made.*list --q/);
  assert.match(log(), /action=create .*result=fail:no-answer/);
  orbit.controls.writeAnswers.push("saved-then-502");
  refused(await run(["create", "--title", "Maybe made"]), /may or may not have been made/);
});

test("Ctrl-C at the workspace question says the used token file is gone", async t => {
  const script = await start("sh", ["-c", "command -v script"], kitEnv());
  if (script.status !== 0) return t.skip("no script command on this machine");
  const { home, root, orbit, configPath, env } = await fixture(t);
  rmSync(configPath);
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Fake" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }];
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const child = spawn("script", ["-qfec", `${kit} ticket setup --from-file ${secret} --from-mcp-config ${mcp}`, "/dev/null"], { env: { ...env, KIT_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let seen = "", copied = false, cancelled = false;
  const finished = new Promise<number | null>(done => child.on("close", done));
  child.stdout.on("data", chunk => {
    seen += chunk;
    if (!copied && /yes or no/.test(seen)) { copied = true; setTimeout(() => child.stdin.write("yes\r"), 150); }
    if (!cancelled && /several workspaces/.test(seen)) { cancelled = true; setTimeout(() => child.stdin.write("\u0003"), 150); }
  });
  assert.notEqual(await finished, 0);
  assert.match(seen, /RESULT: fail ticket Setup was cancelled\. Nothing was saved\. The token file is gone/);
  assert.ok(!existsSync(configPath));
});

test("Ctrl-C at a setup prompt ends with a plain RESULT line, the terminal back as it was and nothing saved", async t => {
  const script = await start("sh", ["-c", "command -v script"], kitEnv());
  if (script.status !== 0) return t.skip("no script command on this machine");
  const { root, configPath, env } = await fixture(t);
  rmSync(configPath);
  const child = spawn("script", ["-qfec", `${kit} ticket setup`, "/dev/null"], { env: { ...env, KIT_ROOT: root }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let seen = "", sent = false, addressed = false;
  const finished = new Promise<number | null>(done => child.on("close", done));
  child.stdout.on("data", chunk => {
    seen += chunk;
    if (!addressed && /web address/.test(seen)) { addressed = true; setTimeout(() => child.stdin.write("http://127.0.0.1:9\r"), 150); }
    if (!sent && /hidden/.test(seen)) { sent = true; setTimeout(() => child.stdin.write("\u0003"), 150); }
  });
  assert.notEqual(await finished, 0);
  assert.match(seen, /RESULT: fail ticket Setup was cancelled\. Nothing was saved\./);
  assert.ok(!existsSync(configPath));
});

test("a 429 on a write waits once and sends the same version again, with one log line", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.writeAnswers.push({ retryAfter: "1" });
  ok(await run(["update", "TOOLS-1", "--title", "New"]));
  const [first, second] = orbit.writes();
  assert.equal(orbit.writes().length, 2);
  assert.equal(first.body.expected_version, second.body.expected_version);
  assert.equal(lines(log()).length, 1);
  assert.match(log(), /action=update fields=title who=test-lead result=ok/);
});

test("moving the tick from one Scheduled in Radaar line to another still needs Lex's words", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "- [x] Scheduled in Radaar: clip\n- [ ] Scheduled in Radaar: post" });
  refused(await run(["update", "TOOLS-1", "--description", "- [ ] Scheduled in Radaar: clip\n- [x] Scheduled in Radaar: post"]), /--lex-said/);
  assert.equal(orbit.writes().length, 0);
  ok(await run(["update", "TOOLS-1", "--description", "- [ ] Scheduled in Radaar: clip\n- [ ] Scheduled in Radaar: post"]));
  assert.match(task.description, /\[ \] Scheduled in Radaar: clip/);
});

test("help is only asked for standing alone: a -h in text is text, a -h after a value option is refused", async t => {
  const { orbit, run, env } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  refused(await run(["update", "TOOLS-1", "--title", "-h"]), /--title needs a value/);
  ok(await run(["comment", "TOOLS-1", "-h"]));
  assert.equal(orbit.comments[task.id][0].body, "-h");
  ok(await run(["note", "TOOLS-1", "--", "--help"]));
  assert.match(task.description, /--help$/);
  for (const args of [["update", "TOOLS-1", "--help"], ["update", "-h"], ["-h"]]) {
    const help = await start(process.execPath, [ticket, ...args], env);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^Usage: kit ticket/);
  }
  ok(await run(["create", "--title", "From stdin", "--description-file", "-"], {}, "text"));
});

test("--json keeps a card's text exactly; only the screen form drops direction marks; text with leading dashes gets a hint", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { title: "Plain\u202Etext" });
  assert.equal(JSON.parse(ok(await run(["get", "TOOLS-1", "--json"])).stdout.split("\nRESULT:")[0]).title, "Plain\u202Etext");
  refused(await run(["note", "TOOLS-1", "--fix later"]), /put -- before/);
});

test("a write answered 2xx with a page that is not Orbit's may have saved; terminal tricks in card text never reach the screen", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { title: "Plain\u202Etext\u001b[31m" });
  const shown = ok(await run(["get", "TOOLS-1"]));
  assert.ok(!/[\u202E\u001b]/.test(shown.stdout));
  orbit.controls.writeAnswers.push("page-200");
  refused(await run(["update", "TOOLS-1", "--title", "x"]), /may or may not have gone through/);
  assert.equal(task.title, "Plain\u202Etext\u001b[31m");
});

test("a trash that meets a version conflict retries once with the fresh version", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  orbit.controls.conflicts = 1;
  ok(await run(["trash", "TOOLS-1", "--lex-said", "bin it"]));
  assert.equal(task.trashed, true);
  assert.equal(orbit.writes().length, 2);
});

test("Retry-After is honoured once and never looped; a long wait is reported without trying again", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.answers.push({ retryAfter: "1" });
  const started = Date.now();
  ok(await run(["get", "TOOLS-1"]));
  assert.ok(Date.now() - started >= 1000, "waited as Orbit said");
  assert.equal(orbit.requests.length, 3, "the 429, the retry and the status names");

  orbit.requests.length = 0;
  orbit.controls.answers.push({ retryAfter: "1" }, { retryAfter: "1" });
  refused(await run(["get", "TOOLS-1"]), /too many requests/i);
  assert.equal(orbit.requests.length, 2);

  orbit.requests.length = 0;
  orbit.controls.answers.push({ retryAfter: "3600" });
  refused(await run(["get", "TOOLS-1"]), /3600 seconds/);
  assert.equal(orbit.requests.length, 1);

  orbit.requests.length = 0;
  orbit.controls.answers.push({});
  refused(await run(["get", "TOOLS-1"]), /too many requests/i);
  assert.equal(orbit.requests.length, 1);

  orbit.requests.length = 0;
  orbit.controls.answers.push({ status: 503, code: "task_busy", detail: "Busy" });
  refused(await run(["get", "TOOLS-1"]), /Busy/);
  assert.equal(orbit.requests.length, 1, "other errors are not retried");

});

test("a state conflict (not a stale version) is reported at once, with the failure logged", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  orbit.controls.writeAnswers.push({ status: 409, code: "task_conflict", detail: "The change conflicts with the task's state" });
  refused(await run(["update", "TOOLS-1", "--title", "x"]), /conflicts with the task/);
  assert.equal(orbit.writes().length, 1, "no retry");
  assert.equal(task.title, "Card 1");
  assert.match(log(), /action=update fields=title who=test-lead result=fail:task_conflict/);
});

test("redaction hides the saved secrets and token shapes in errors, results and log lines", async t => {
  const redact = orbitRedactor(secrets);
  const text = redact(`token ${fakeToken} and ${fakeCfId} and ${fakeCfSecret} orb_someOtherToken1234 Authorization: Bearer abc.def CF-Access-Client-Secret: shh "token":"plain" https://user:pw@example.test/x`);
  for (const secret of [...secrets, "orb_someOtherToken1234", "abc.def", "shh", "plain", "user:pw"]) assert.ok(!text.includes(secret), secret);
  assert.match(text, /\[hidden\]/);
  assert.equal(orbitRedactor([])("Plain words stay, even the word token."), "Plain words stay, even the word token.");

  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  // Orbit's own error text repeats the token: it must not reach the screen. `run` checks every output for the secrets.
  orbit.controls.answers.push({ status: 422, code: "validation_failed", detail: `bad value ${fakeToken} and ${fakeCfSecret}` });
  refused(await run(["get", "TOOLS-1"]), /bad value \[hidden\]/);
  // A Cloudflare page is never echoed.
  orbit.controls.answers.push("cloudflare-page");
  refused(await run(["get", "TOOLS-1"]), /Cloudflare/);
  // A text holding a secret is refused rather than stored on a card.
  refused(await run(["note", "TOOLS-1", `the token is ${fakeToken}`]), /secret/i);
  refused(await run(["comment", "TOOLS-1", `the pass is ${fakeCfSecret}`]), /secret/i);
  refused(await run(["update", "TOOLS-1", "--title", "orb_abcdefghijklmnopqrstuvwx"]), /secret/i);
  // A log line with a secret in Lex's words stays clean.
  ok(await run(["update", "TOOLS-1", "--status", "Publish", "--lex-said", `publish ${fakeToken}`]));
  for (const secret of secrets) assert.ok(!log().includes(secret));
  assert.match(log(), /lex_said="publish \[hidden\]"/);
});

test("every write adds one log line (time, card, fields, who) in a private file", async t => {
  const { orbit, run, log, logPath } = await fixture(t);
  orbit.addTask(orbit.tools);
  ok(await run(["update", "TOOLS-1", "--title", "New\ntitle"]));
  ok(await run(["comment", "TOOLS-1", "x"]));
  const entries = lines(log());
  assert.equal(entries.length, 2);
  assert.match(entries[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z card=TOOLS-1 action=update fields=title who=test-lead result=ok$/);
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
  // A log someone opened up goes back to private on the next write.
  chmodSync(logPath, 0o644);
  ok(await run(["comment", "TOOLS-1", "z"]));
  assert.equal(statSync(logPath).mode & 0o777, 0o600);
  // No log, no write: a log that cannot be written stops the change before it is sent.
  rmSync(logPath);
  mkdirSync(logPath);
  const before = orbit.writes().length;
  refused(await run(["comment", "TOOLS-1", "y"]), /log/i);
  assert.equal(orbit.writes().length, before);
});

test("a Cloudflare redirect is never followed, so the pass and token never reach another site", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.answers.push("redirect");
  refused(await run(["get", "TOOLS-1"]), /Cloudflare/);
  assert.equal(orbit.requests.length, 1);
  orbit.controls.answers.push("login-page-200");
  refused(await run(["get", "TOOLS-1"]), /Cloudflare|not Orbit/);
  const sent = orbit.requests[0].headers;
  assert.equal(sent.authorization, `Bearer ${fakeToken}`);
  assert.equal(sent["cf-access-client-id"], fakeCfId);
  assert.equal(sent["cf-access-client-secret"], fakeCfSecret);
});

test("no answer to a read is plain; no answer to a write says it may have gone through, is logged and not retried", async t => {
  const { orbit, run, save, config, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.writeAnswers.push("drop");
  refused(await run(["update", "TOOLS-1", "--title", "x"]), /may or may not have gone through/);
  assert.equal(orbit.writes().length, 1, "no retry");
  assert.match(log(), /action=update fields=title who=test-lead result=fail:no-answer/);
  save({ ...config, origin: "http://127.0.0.1:9" });
  refused(await run(["get", "TOOLS-1"]), /could not reach/i);
});

test("the secrets file is refused when missing, too open, a link, broken, inside a git work tree or plain http", async t => {
  const { home, run, save, configPath, config, orbit } = await fixture(t);
  orbit.addTask(orbit.tools);
  rmSync(configPath);
  refused(await run(["get", "TOOLS-1"]), /kit ticket setup/);
  save(config, 0o644);
  refused(await run(["get", "TOOLS-1"]), /644.*chmod 600/);
  save(config, 0o640);
  refused(await run(["get", "TOOLS-1"]), /chmod 600/);
  save(`{"token":"${fakeToken}", broken`);
  const broken = refused(await run(["get", "TOOLS-1"]), /cannot be read|not valid/i);
  assert.ok(!broken.all.includes(fakeToken));
  save({ ...config, token: "" });
  refused(await run(["get", "TOOLS-1"]), /token/);
  save({ ...config, origin: "http://orbit.example.test" });
  refused(await run(["get", "TOOLS-1"]), /https/);
  save({ ...config, origin: "https://user:pw@orbit.example.test" });
  refused(await run(["get", "TOOLS-1"]), /address/);
  save({ ...config, cf_access_client_secret: "" });
  refused(await run(["get", "TOOLS-1"]), /Cloudflare/);

  // A link to a file elsewhere is refused as well.
  save(config);
  const other = join(home, "other.json");
  writeFileSync(other, JSON.stringify(config), { mode: 0o600 });
  rmSync(configPath);
  symlinkSync(other, configPath);
  refused(await run(["get", "TOOLS-1"]), /plain file/);
  rmSync(configPath);

  // A config folder inside a git work tree.
  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "config/fleet"), { recursive: true });
  writeFileSync(join(repo, "config/fleet/orbit.json"), JSON.stringify(config), { mode: 0o600 });
  refused(await run(["get", "TOOLS-1"], { XDG_CONFIG_HOME: join(repo, "config") }), /git work tree/);
  // A link in the path into a work tree counts too.
  symlinkSync(join(repo, "config"), join(home, "linked-config"));
  refused(await run(["get", "TOOLS-1"], { XDG_CONFIG_HOME: join(home, "linked-config") }), /git work tree/);
});

function fakeMcpSettings(home: string, origin: string, extra: object = {}) {
  const path = join(home, "fake-mcp.json");
  writeFileSync(path, JSON.stringify({ mcpServers: { other: { url: "https://other.test", headers: { "CF-Access-Client-Id": "not-this" } }, orbit: { type: "http", url: `${origin}/mcp`, headers: { "CF-Access-Client-Id": fakeCfId, "cf-access-client-secret": fakeCfSecret }, ...extra } } }));
  return path;
}

test("setup --from-file reads then deletes the token file, finds the workspace and saves a private file", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const mcp = fakeMcpSettings(home, orbit.origin);
  const before = readFileSync(mcp, "utf8");
  const output = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], { ORBIT_ROLE: "" }, "yes\n"));
  assert.ok(!existsSync(secret), "the token file is gone");
  assert.equal(readFileSync(mcp, "utf8"), before, "the MCP settings stay as they were");
  assert.equal(statSync(configPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, ".config/fleet")).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { origin: orbit.origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret, token_expires_at: "2027-02-04T00:00:00.000Z" });
  assert.equal(readdirSync(join(home, ".config/fleet")).length, 1, "no temporary file left");
  assert.match(output.all, /fleet/);
  assert.match(output.all, /2027-02-04/);
  ok(await run(["list"]));
});

test("setup copies the Cloudflare pass only after a yes, and without one asks for it hidden", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  // "no", then the two pasted values and the address.
  const said = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, `no\n${orbit.origin}\n${fakeCfId}\n${fakeCfSecret}\n`));
  assert.match(said.stderr, /Cloudflare/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).cf_access_client_secret, fakeCfSecret);

  // A "no" never opens the settings: an unreadable path gives no error.
  rmSync(configPath);
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", join(home, "missing.json")], {}, `no\n${orbit.origin}\n${fakeCfId}\n${fakeCfSecret}\n`));
});

test("setup: a pass held as a reference, or missing, is said plainly and asked for", async t => {
  const refs = cloudflarePassFrom(JSON.stringify({ mcpServers: { orbit: { url: "https://orbit.test/mcp", headers: { "CF-Access-Client-Id": "${CF_ID}", "CF-Access-Client-Secret": "${CF_SECRET}" } } } }));
  assert.match(refs.problem, /reference/);
  assert.match(cloudflarePassFrom(JSON.stringify({ mcpServers: {} })).problem, /no Orbit/i);
  assert.match(cloudflarePassFrom("not json at all orb_secret").problem, /cannot be read/);
  assert.ok(!cloudflarePassFrom("not json at all orb_secret").problem.includes("orb_secret"));
  const args = cloudflarePassFrom(JSON.stringify({ projects: { "/x": { mcpServers: { Orbit: { command: "npx", args: ["mcp-remote", "https://orbit.test/mcp", "--header", `CF-Access-Client-Id:${fakeCfId}`, "--header", `CF-Access-Client-Secret: ${fakeCfSecret}`] } } } } }));
  assert.deepEqual(args, { origin: "https://orbit.test", id: fakeCfId, secret: fakeCfSecret });
  const viaEnv = cloudflarePassFrom(JSON.stringify({ mcpServers: { orbit: { url: "https://orbit.test/mcp", headers: { "CF-Access-Client-Id": "${A}", "CF-Access-Client-Secret": "$B" }, env: { A: fakeCfId, B: fakeCfSecret } } } }));
  assert.deepEqual(viaEnv, { origin: "https://orbit.test", id: fakeCfId, secret: fakeCfSecret });
  const twice = cloudflarePassFrom(JSON.stringify({ mcpServers: { orbit: { url: "https://a.test/mcp", headers: { "CF-Access-Client-Id": "a", "CF-Access-Client-Secret": "b" } }, "orbit-2": { url: "https://b.test/mcp", headers: { "CF-Access-Client-Id": "c", "CF-Access-Client-Secret": "d" } } } }));
  assert.match(twice.problem, /more than one/);

  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = join(home, "fake-mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const said = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, `yes\n${orbit.origin}\n${fakeCfId}\n${fakeCfSecret}\n`));
  assert.match(said.all, /no Orbit/i);
});

test("setup refuses a wrong token, a wrong-looking token, a git work tree and saves nothing", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  writeFileSync(secret, "orb_wrongtokenthatorbitwillrefuse\n", { mode: 0o600 });
  const wrong = refused(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n"), /refused|Nothing was saved/);
  assert.ok(!wrong.all.includes("orb_wrongtoken"));
  assert.ok(!existsSync(configPath));
  assert.ok(!existsSync(secret), "the file goes even when the token is wrong");
  writeFileSync(secret, "hello there\n", { mode: 0o600 });
  refused(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n"), /orb_/);
  assert.ok(!existsSync(configPath));
  refused(await run(["setup", "--from-file", join(home, "nothing"), "--from-mcp-config", mcp], {}, "yes\n"), /cannot be read|no file/i);
  // A bad address stops before the token file is read.
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  refused(await run(["setup", "--from-file", secret], {}, "http://orbit.example.test\n"), /https/);
  assert.ok(existsSync(secret));
  // A folder is not a token file, and is left alone.
  mkdirSync(join(home, "folder"));
  refused(await run(["setup", "--from-file", join(home, "folder"), "--from-mcp-config", mcp], {}, "yes\n"), /plain file/);
  assert.ok(existsSync(join(home, "folder")));

  const repo = join(home, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  refused(await run(["setup", "--from-file", secret], { XDG_CONFIG_HOME: join(repo, "config") }), /git work tree/);
  assert.ok(existsSync(secret), "refused before the token file is touched");
  assert.ok(!existsSync(join(repo, "config")));
});

test("setup again asks before replacing, keeps the address and pass for a new token, and its dry run does nothing", async t => {
  const { home, run, orbit, configPath, config, save } = await fixture(t);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const before = readFileSync(configPath, "utf8");
  const dry = ok(await run(["setup", "--from-file", secret, "--dry-run"]));
  assert.match(dry.stdout, /nothing was/i);
  assert.ok(existsSync(secret));
  assert.equal(readFileSync(configPath, "utf8"), before);

  refused(await run(["setup", "--from-file", secret], {}, "no\n"), /kept/i);
  assert.ok(existsSync(secret), "a no leaves the token file too");
  ok(await run(["setup", "--from-file", secret], {}, "yes\n"));
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), { ...config, token_expires_at: "2027-02-04T00:00:00.000Z" });
  assert.equal(orbit.requests.at(-1)!.headers["cf-access-client-secret"], fakeCfSecret);

  save(config, 0o644);
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  refused(await run(["setup", "--from-file", secret], {}, "yes\n"), /chmod 600/);
});

test("setup --new-pass asks for a new Cloudflare pass, before it touches the token file", async t => {
  const { home, run, orbit, configPath, config, save } = await fixture(t);
  save({ ...config, cf_access_client_id: "old-id", cf_access_client_secret: "old-secret" });
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const kept = refused(await run(["get", "TOOLS-1"]), /Cloudflare.*--new-pass/);
  assert.ok(!kept.all.includes("old-secret"));
  ok(await run(["setup", "--new-pass", "--from-file", secret], {}, `yes\n${fakeCfId}\n${fakeCfSecret}\n`));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).cf_access_client_secret, fakeCfSecret);
  assert.equal(orbit.requests.at(-1)!.headers["cf-access-client-id"], fakeCfId);

  // A half pass stops before the token file is read, so the token is not lost to a typing slip.
  rmSync(configPath);
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  refused(await run(["setup", "--from-file", secret], {}, `${orbit.origin}\n${fakeCfId}\n\n`), /two parts/);
  assert.ok(existsSync(secret));
});

test("a setup that cannot save says so plainly, with what to do about the used token file", async t => {
  if (process.getuid?.() === 0) return t.skip("a root user can write anywhere");
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const folder = join(home, ".config/fleet");
  chmodSync(folder, 0o500);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const output = await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n");
  chmodSync(folder, 0o700);
  refused(output, /could not be saved.*token file is gone/i);
});

test("setup again says it keeps the saved pass when it cannot copy one, and keeps the saved workspace for a new token", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  const empty = join(home, "empty-mcp.json");
  writeFileSync(empty, JSON.stringify({ mcpServers: {} }));
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  orbit.controls.me.workspaces = [{ id: "22222222-2222-4222-8222-222222222222", name: "Other" }, { id: fakeWorkspace, name: "Fake" }];
  const said = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", empty], {}, "yes\nyes\n"));
  assert.match(said.all, /Keeping the saved pass/);
  assert.ok(!said.all.includes("I will ask for it"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).workspace_id, fakeWorkspace);
});

test("setup with no file reads the pass from the Claude settings in the home folder", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  fakeMcpSettings(home, orbit.origin);
  writeFileSync(join(home, ".claude.json"), readFileSync(join(home, "fake-mcp.json")));
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const said = ok(await run(["setup", "--from-file", secret, "--from-mcp-config"], {}, "yes\n"));
  assert.match(said.stderr, /\.claude\.json/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).cf_access_client_secret, fakeCfSecret);
});

test("setup asks before moving a saved setup to a different address found in the settings", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  const mcp = fakeMcpSettings(home, "https://elsewhere.example.test");
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const kept = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\nyes\nno\n"));
  assert.match(kept.stderr, /elsewhere\.example\.test/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).origin, orbit.origin);
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  // A yes moves it: the check then goes to the new address, which does not answer here, and nothing changes.
  const moved = join(home, "moved.json");
  writeFileSync(moved, readFileSync(mcp, "utf8").replace("https://elsewhere.example.test", "http://127.0.0.1:9"));
  refused(await run(["setup", "--from-file", secret, "--from-mcp-config", moved], {}, "yes\nyes\nyes\n"), /could not reach/i);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).origin, orbit.origin);
});

test("setup --new-pass keeps a working saved token when Enter is pressed at its prompt", async t => {
  const { run, orbit, configPath, config, save } = await fixture(t);
  save({ ...config, cf_access_client_id: "old-id", cf_access_client_secret: "old-secret" });
  ok(await run(["setup", "--new-pass"], {}, `yes\n${fakeCfId}\n${fakeCfSecret}\n\n`));
  const saved = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(saved.token, fakeToken);
  assert.equal(saved.cf_access_client_id, fakeCfId);
  assert.equal(orbit.requests.at(-1)!.headers.authorization, `Bearer ${fakeToken}`);
});

test("setup says when the settings cannot be read after a yes, then asks for the pass", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const said = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", join(home, "missing.json")], {}, `yes\n${orbit.origin}\n${fakeCfId}\n${fakeCfSecret}\n`));
  assert.match(said.all, /Could not read/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).cf_access_client_secret, fakeCfSecret);
});

test("a no to a different address keeps the saved pass too, so nothing of that other connection is used", async t => {
  const { home, run, configPath, orbit } = await fixture(t);
  const mcp = join(home, "other-mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { orbit: { url: "https://elsewhere.example.test/mcp", headers: { "CF-Access-Client-Id": "other-id", "CF-Access-Client-Secret": "other-secret" } } } }));
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\nyes\nno\n"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).cf_access_client_id, fakeCfId);
  assert.equal(orbit.requests.at(-1)!.headers["cf-access-client-id"], fakeCfId);
});

test("setup --new-pass with a declined address says only what it keeps", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  const mcp = fakeMcpSettings(home, "https://elsewhere.example.test");
  const said = ok(await run(["setup", "--new-pass", "--from-mcp-config", mcp], {}, `yes\nyes\nno\n${fakeCfId}\n${fakeCfSecret}\n\n`));
  assert.match(said.all, /Keeping the saved address\./);
  assert.ok(!said.all.includes("Keeping the saved address and pass"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).origin, orbit.origin);
});

test("a saved token and pass never go to a new address", async t => {
  const { home, run, orbit, configPath, config } = await fixture(t);
  const other = await fakeOrbit(t);
  const before = readFileSync(configPath, "utf8");
  // A new address from the settings: its own pass goes along, the saved token does not.
  const mcp = fakeMcpSettings(home, other.origin);
  const moved = refused(await run(["setup", "--from-mcp-config", mcp], {}, "yes\nyes\nyes\n\n"), /Orbit token/);
  assert.ok(!moved.all.includes("press Enter to keep"));
  assert.equal(other.requests.length, 0);
  assert.equal(readFileSync(configPath, "utf8"), before);
  // The same address still keeps them.
  const same = fakeMcpSettings(home, orbit.origin);
  ok(await run(["setup", "--from-mcp-config", same], {}, "yes\nyes\n\n"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).token, config.token);
});

test("setup warns about a read-only token and asks which workspace when there are several", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  orbit.controls.me.token.scopes = ["tasks:read"];
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  assert.match(ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n")).all, /only read/i);
  rmSync(configPath);
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Fake" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }];
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, `yes\n${fakeWorkspace}\n`));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).workspace_id, fakeWorkspace);
});

test("setup's hidden prompt shows nothing typed, through the real front door on a real terminal", async t => {
  const script = await start("sh", ["-c", "command -v script"], kitEnv());
  if (script.status !== 0) return t.skip("no script command on this machine");
  const { home, root, orbit, configPath, env } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const child = spawn("script", ["-qfec", `${kit} ticket setup --from-mcp-config ${mcp}`, "/dev/null"], { env: { ...env, KIT_ROOT: root, ORBIT_ROLE: "" }, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  let seen = "";
  // Each answer goes in only after its question shows: typed earlier, the terminal itself would still echo it.
  const answers: [RegExp, string][] = [[/yes or no/i, "yes\r"], [/hidden/i, `${fakeToken}\r`]];
  let unread = "";
  const finished = new Promise<number | null>(done => child.on("close", done));
  child.stderr.on("data", chunk => { seen += chunk; });
  child.stdout.on("data", chunk => {
    seen += chunk;
    unread += chunk;
    if (answers.length && answers[0][0].test(unread)) {
      unread = "";
      const [, answer] = answers.shift()!;
      setTimeout(() => child.stdin.write(answer), 150);
    }
  });
  const status = await finished;
  assert.equal(status, 0, seen);
  assert.ok(!seen.includes(fakeToken), "the token never shows on the screen");
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).token, fakeToken);
});

test("an option never swallows the next option as its value, and only the space form exists", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  refused(await run(["trash", "TOOLS-1", "--lex-said", "--dry-run"]), /--lex-said needs a value/);
  refused(await run(["update", "TOOLS-1", "--title", "--dry-run"]), /--title needs a value/);
  assert.equal(task.trashed, false);
  for (const word of ["--dry-run=yes", "--wat=1"]) refused(await run(["update", "TOOLS-1", word]), /does not take/);
  // The form that is gone says what to write instead, also with a value holding spaces.
  for (const word of ["--title=x", "--title=my new title"]) refused(await run(["update", "TOOLS-1", word]), /write it as --title <value>/);
  // A one-word value that starts with a dash cannot be given, and the refusal says so.
  refused(await run(["update", "TOOLS-1", "--lex-said", "-ok"]), /cannot start with a dash/);
  assert.equal(orbit.writes().length, 0);
  ok(await run(["update", "TOOLS-1", "--title", "a=b"]));
  assert.equal(task.title, "a=b");
});

test("setup takes no --origin or --workspace: it asks for the address and the workspace when it cannot find them", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  refused(await run(["setup", "--origin", orbit.origin]), /does not take --origin/);
  refused(await run(["setup", "--workspace", fakeWorkspace]), /does not take --workspace/);
  assert.equal(orbit.requests.length, 0);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const asked = ok(await run(["setup", "--from-file", secret], {}, `${orbit.origin}\n${fakeCfId}\n${fakeCfSecret}\n`));
  assert.match(asked.stderr, /web address/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).origin, orbit.origin);
});

test("a write answered by a gateway page may have saved, so it says so, and is not retried", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.controls.writeAnswers.push("saved-then-502");
  const said = refused(await run(["create", "--title", "Maybe"]), /may or may not have been made/);
  assert.equal(orbit.writes().length, 1);
  assert.ok(!said.all.includes("Bad gateway"), "the page itself is never shown");
  assert.match(log(), /action=create .* result=fail:502/);
  const card = orbit.addTask(orbit.tools);
  orbit.controls.writeAnswers.push("saved-then-502");
  refused(await run(["update", card.identifier, "--title", "x"]), /may or may not have gone through/);
  // A read has nothing to lose: it only says to try later.
  orbit.controls.answers.push("gateway-page");
  refused(await run(["get", card.identifier]), /try again later/);
});

test("get names the parent by its key, and a parent it cannot read does not hide the card", async t => {
  const { orbit, run } = await fixture(t);
  const parent = orbit.addTask(orbit.tools);
  orbit.addTask(orbit.tools, { parent_task_id: parent.id });
  assert.match(ok(await run(["get", "TOOLS-2"])).stdout, /Parent: TOOLS-1/);
  assert.equal(JSON.parse(ok(await run(["get", "TOOLS-2", "--json"])).stdout.split("\nRESULT:")[0]).parent_key, "TOOLS-1");
  const unseen = "33333333-3333-4333-8333-333333333333";
  orbit.addTask(orbit.tools, { parent_task_id: unseen });
  assert.match(ok(await run(["get", "TOOLS-3"])).stdout, new RegExp(`Parent: ${unseen} \\(this token cannot read it\\)`));
  assert.equal(JSON.parse(ok(await run(["get", "TOOLS-3", "--json"])).stdout.split("\nRESULT:")[0]).parent_key, null);
});

test("a card that already holds a token-shaped text can still be edited; adding one is refused", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Old text orb_abcdefghijklmnopqrstuvwx" });
  ok(await run(["note", "TOOLS-1", "fine"]));
  assert.match(task.description, /fine/);
  const clean = orbit.addTask(orbit.tools, { description: "Clean" });
  refused(await run(["note", "TOOLS-2", "orb_abcdefghijklmnopqrstuvwx"]), /secret/i);
  assert.equal(clean.description, "Clean");
  // The old text excuses only itself: the real saved secrets, and any other token shape, stay out.
  const before = task.description, writes = orbit.writes().length;
  refused(await run(["note", "TOOLS-1", `token ${fakeToken}`]), /secret/i);
  refused(await run(["note", "TOOLS-1", `pass ${fakeCfSecret}`]), /secret/i);
  refused(await run(["next-lex", "TOOLS-1", `pass ${fakeCfId}`]), /secret/i);
  refused(await run(["dates", "TOOLS-1", "--due", "2026-11-30", "--source", `orb_anothertokenshape0000`]), /secret/i);
  assert.equal(task.description, before);
  assert.equal(orbit.writes().length, writes);
});

test("setup asks which workspace when the token reaches several, and refuses an answer it does not reach", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Fake" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }];
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const said = refused(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, `yes\n${"99999999-9999-4999-8999-999999999999\n".repeat(3)}`), /No workspace 99999999-9999-4999-8999-999999999999/);
  assert.match(said.stderr, /several workspaces/);
  assert.ok(!existsSync(configPath));
  // A slip gets two more tries, and the name counts as well as the id, so a used token file is not lost to a typo.
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\nnope\nother\n"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).workspace_id, "22222222-2222-4222-8222-222222222222");
  // Names from Orbit reach the screen without terminal tricks.
  rmSync(configPath);
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Fake\u001b[31m" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }];
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const clean = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, `yes\n${fakeWorkspace}\n`));
  assert.ok(!clean.stderr.includes("\u001b"));
});

test("setup's help is numbered plain steps with no jargon; kit ticket help names every command", async t => {
  const { run } = await fixture(t);
  const help = await run(["setup", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^1\. /m);
  assert.match(help.stdout, /^2\. /m);
  assert.match(help.stdout, /kit ticket setup --from-mcp-config/);
  assert.ok(!/\b(stdin|TTY|JSON|env|chmod|OAuth|CLI|header)\b/i.test(help.stdout), help.stdout);
  const main = await run(["--help"]);
  assert.equal(main.status, 0);
  for (const name of ["create", "get", "list", "update", "dates", "note", "comment", "sub-tasks", "next-lex", "clear-next-lex", "trash", "setup"]) assert.match(main.stdout, new RegExp(`\\b${name}\\b`));
  refused(await run([]), /Usage/);
  refused(await run(["nonsense"]), /nonsense/);
  refused(await run(["get"]), /card key/i);
  refused(await run(["get", "TOOLS-1", "--wat"]), /--wat/);
  refused(await run(["get", "TOOLS-1", "--constructor"]), /does not take --constructor/);
  refused(await run(["update", "TOOLS-1", "--title"]), /--title/);
  refused(await run(["update", "TOOLS-1", "--title", "a", "--title", "b"]), /--title/);
  refused(await run(["update", "TOOLS-1", "--description", "a", "--description-file", "b"]), /description/);
});

test("the ticket setting defaults to files and names the Orbit board", async () => {
  assert.deepEqual(ticketSettings({}), { backend: "files", project: null, parent: null });
  assert.deepEqual(ticketSettings({ tickets: "orbit", orbit: { project: "TOOLS", parent: "TOOLS-10" } }), { backend: "orbit", project: "TOOLS", parent: "TOOLS-10" });
  assert.deepEqual(ticketSettings({ orbit: { project: "TOOLS" } }), { backend: "files", project: "TOOLS", parent: null });
});

test("list --project all covers every board the token reaches; a status name then needs one board", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.addTask(orbit.video);
  const all = ok(await run(["list", "--project", "all"]));
  assert.ok(all.stdout.includes("TOOLS-1") && all.stdout.includes("VID-1"));
  refused(await run(["list", "--project", "all", "--status", "Idea"]), /one --project/);
});

test("the store's line edits leave the rest of a description exactly as it was", () => {
  const body = "Intro\n\n\n\n```\ncode\n\n\nmore\n```\n";
  assert.equal(withoutNextLex(`Next step (Lex): go\n\n${body}`), body);
  assert.equal(withBlockedBy(withBlockedBy(body, ["A-1"]), []), body);
  assert.equal(withBlockedBy("a\n\nBlocked by: A-1\n\nb\n\n\nc", ["B-2"]), "a\n\nBlocked by: B-2\n\nb\n\n\nc");
  assert.equal(withBlockedBy("a\n\nBlocked by: A-1\n\nb\n\n\nc", []), "a\n\nb\n\n\nc");
  const planned = "Top\n\nPlanned dates: due 2026-01-01 (source: x)\n\nBelow\n\n\nEnd";
  assert.equal(withPlannedDates(planned, "Planned dates: due 2026-02-02 (source: y)"), "Top\n\nPlanned dates: due 2026-02-02 (source: y)\n\nBelow\n\n\nEnd");
  assert.equal(withPlannedDates(planned, null), "Top\n\nBelow\n\n\nEnd");
  assert.equal(withPlannedDates("A\n\nPlanned dates: x\n\nB\nPlanned dates: y", "Planned dates: z"), "A\n\nPlanned dates: z\n\nB");
  assert.equal(withPlannedDates("Text\n\n## Notes\n\n- a", "Planned dates: z"), "Text\n\nPlanned dates: z\n\n## Notes\n\n- a");
  assert.equal(withPlannedDates("", "Planned dates: z"), "Planned dates: z");
  assert.equal(withPlannedDates("Text\n## Notes\n\n- a", "Planned dates: z"), "Text\n\nPlanned dates: z\n\n## Notes\n\n- a");
  assert.equal(withNote("## Notes\n\n- a\n\n## After\n\ntext", "2026-01-01", "me", "b"), "## Notes\n\n- a\n- 2026-01-01 (me): b\n\n## After\n\ntext");
});

test("a list asks for each board's status names once, however many cards it shows", async t => {
  const { orbit, run } = await fixture(t);
  const parent = orbit.addTask(orbit.tools);
  for (let index = 0; index < 120; index++) orbit.addTask(orbit.tools, { parent_task_id: parent.id });
  const statusCalls = () => orbit.requests.filter(item => item.path.endsWith("/statuses")).length;
  ok(await run(["list", "--limit", "110"]));
  assert.equal(statusCalls(), 1);
  orbit.requests.length = 0;
  const subs = ok(await run(["sub-tasks", "TOOLS-1"]));
  assert.equal(statusCalls(), 1);
  assert.ok(!result(subs).includes("--limit"), "sub-tasks takes no --limit, so it never advises one");
});

test("the screen and --json keep ordinary card text whole; only real secrets and token shapes are hidden", async t => {
  const { orbit, run } = await fixture(t);
  const words = "the bearer of news, ssh://git@host/x, token: yes";
  orbit.addTask(orbit.tools, { description: words });
  assert.equal(JSON.parse(ok(await run(["get", "TOOLS-1", "--json"])).stdout.split("\nRESULT:")[0]).description, words);
  assert.ok(ok(await run(["get", "TOOLS-1"])).stdout.includes(words));
  assert.ok(ok(await run(["note", "TOOLS-1", "the bearer of news", "--dry-run"])).stdout.includes("the bearer of news"));
  orbit.addTask(orbit.tools, { description: `leak orb_abcdefghijklmnopqrstuvwx and ${fakeToken}` });
  const leak = ok(await run(["get", "TOOLS-2", "--json"]));
  assert.ok(!leak.stdout.includes("orb_abcdefghijklmnopqrstuvwx"));
});

test("every way of writing the Radaar tick counts: spacing, emphasis, quote marks and links", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { description: "- [ ] Scheduled in Radaar" });
  for (const text of ["- [x] Scheduled  in Radaar", "- [x] **Scheduled** in Radaar", "> - [x] Scheduled in Radaar", "- [x] [Scheduled in Radaar](https://example.test)", "  * [X] _scheduled in radaar_", "[x] Scheduled in Radaar", "- [x] Scheduled in [Radaar](https://example.test)", "- - [x] Scheduled in Radaar", "- [x] Scheduled in [Radaar][r]", "- [x] <b>Scheduled</b> in Radaar", "- [x] Scheduled in\n  Radaar", "- [x] Scheduled&nbsp;in Radaar", "- [x] Scheduled in\nRadaar", "> - [x] Scheduled in\n>   Radaar", "- [x] &#83;cheduled in Radaar", "- [x] Schedu&#x6C;ed in Radaar", "- [x]\n  Scheduled in Radaar"]) {
    refused(await run(["update", "TOOLS-1", "--description", text]), /--lex-said/);
  }
  assert.equal(orbit.writes().length, 0);
});

test("broken settings never silently drop the default parent on a new card", async t => {
  const { orbit, run } = await fixture(t, { branches: { land: "dev", direct: "nope" }, orbit: { project: "TOOLS", parent: "TOOLS-1" } });
  orbit.addTask(orbit.tools);
  refused(await run(["create", "--project", "TOOLS", "--title", "x"]), /direct/);
  assert.equal(orbit.writes().length, 0);
  ok(await run(["create", "--project", "TOOLS", "--title", "x", "--no-parent"]));
  ok(await run(["create", "--project", "TOOLS", "--title", "y", "--parent", "TOOLS-1"]));
  assert.equal(orbit.tasks[1].parent_task_id, null);
  assert.equal(orbit.tasks[2].parent_task_id, orbit.tasks[0].id);
});

test("an empty value never clears blockers or blanks a title", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Blocked by: TOOLS-9", title: "Kept" });
  refused(await run(["update", "TOOLS-1", "--blocked-by", ""]), /none/);
  refused(await run(["update", "TOOLS-1", "--blocked-by", " , "]), /none/);
  refused(await run(["update", "TOOLS-1", "--title", "  "]), /title/);
  assert.equal(task.description, "Blocked by: TOOLS-9");
  assert.equal(task.title, "Kept");
  assert.equal(orbit.writes().length, 0);
});

test("setup leaves a file that holds no token, and after a used token file says plainly what to do next", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const notes = join(home, "notes.txt");
  writeFileSync(notes, "hello there\n", { mode: 0o600 });
  refused(await run(["setup", "--from-file", notes, "--from-mcp-config", mcp], {}, "yes\n"), /orb_/);
  assert.equal(readFileSync(notes, "utf8"), "hello there\n");

  const secret = join(home, "secret-box");
  const box = () => writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  box();
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Fake" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }];
  refused(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\nnot-one-of-them\n"), /No workspace.*token file is gone.*new token/);
  orbit.controls.me.workspaces = undefined;
  box();
  orbit.controls.answers.push("gateway-page");
  const reached = refused(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n"), /token file is gone.*new token/);
  assert.ok(!/Orbit refused/.test(reached.all), "a page that is not Orbit's is not Orbit's refusal");
  box();
  const offline = join(home, "offline.json");
  writeFileSync(offline, JSON.stringify({ mcpServers: { orbit: { url: "http://127.0.0.1:9/mcp", headers: { "CF-Access-Client-Id": fakeCfId, "CF-Access-Client-Secret": fakeCfSecret } } } }));
  const noReach = refused(await run(["setup", "--from-file", secret, "--from-mcp-config", offline], {}, "yes\n"), /could not reach.*token file is gone.*new token/i);
  assert.ok(!/Orbit refused/.test(noReach.all));
});

test("a tick counts through any line ending, and a second identical ticked line counts too", async t => {
  const { home, orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { description: "- [ ] Scheduled in Radaar" });
  const file = join(home, "windows.md");
  writeFileSync(file, "- [x] Scheduled in Radaar\r\n- [ ] Other\r\n");
  refused(await run(["update", "TOOLS-1", "--description-file", file]), /--lex-said/);
  refused(await run(["update", "TOOLS-1", "--description", "Top\u2028- [x] Scheduled in Radaar"]), /--lex-said/);
  orbit.addTask(orbit.tools, { description: "- [x] Scheduled in Radaar\n- [ ] Scheduled in Radaar" });
  refused(await run(["update", "TOOLS-2", "--description", "- [x] Scheduled in Radaar\n- [x] Scheduled in Radaar"]), /--lex-said/);
  assert.equal(orbit.writes().length, 0);
  ok(await run(["update", "TOOLS-2", "--description", "- [x] Scheduled in Radaar\n- [ ] Scheduled in Radaar\n\nMore"]));
});

test("a short word that starts orb_ is ordinary text: shown whole, in a dry run and in --json", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { description: "see orb_notes" });
  assert.ok(ok(await run(["note", "TOOLS-1", "orb_notes", "--dry-run"])).stdout.includes("orb_notes"));
  assert.equal(JSON.parse(ok(await run(["get", "TOOLS-1", "--json"])).stdout.split("\nRESULT:")[0]).description, "see orb_notes");
});

test("list --parent finds a card's sub-tasks on any board, also with no board set", async t => {
  const { orbit, run } = await fixture(t);
  const parent = orbit.addTask(orbit.video);
  orbit.addTask(orbit.video, { title: "Under video", parent_task_id: parent.id });
  assert.ok(ok(await run(["list", "--parent", "VID-1"])).stdout.includes("Under video"));
  const bare = await fixture(t, {});
  const other = bare.orbit.addTask(bare.orbit.video);
  bare.orbit.addTask(bare.orbit.video, { title: "Under video", parent_task_id: other.id });
  assert.ok(ok(await bare.run(["list", "--parent", "VID-1"])).stdout.includes("Under video"));
});

test("a card with Windows line endings keeps one Notes section", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text\r\n\r\n## Notes\r\n\r\n- a" });
  ok(await run(["note", "TOOLS-1", "b"]));
  assert.equal(task.description.match(/## Notes/g)!.length, 1);
  ok(await run(["dates", "TOOLS-1", "--due", "2026-11-30", "--source", "s"]));
  assert.ok(task.description.indexOf("Planned dates") < task.description.indexOf("## Notes"));
});

test("no answer to a comment or a trash says it may have gone through, is logged and not retried", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.writeAnswers.push("drop");
  refused(await run(["comment", "TOOLS-1", "x"]), /may or may not have gone through/);
  assert.match(log(), /action=comment .*result=fail:no-answer/);
  assert.equal(orbit.writes().length, 1);
  orbit.controls.writeAnswers.push("drop");
  refused(await run(["trash", "TOOLS-1", "--lex-said", "bin it"]), /may or may not have gone through/);
  assert.match(log(), /action=trash .*result=fail:no-answer/);
  assert.equal(orbit.writes().length, 2);
});

test("replacing a dated card's description keeps its Planned dates line, so no date loses its source", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Old" });
  ok(await run(["dates", "TOOLS-1", "--due", "2026-11-30", "--source", "plan.md"]));
  ok(await run(["update", "TOOLS-1", "--description", "New"]));
  assert.equal(task.description, "New\n\nPlanned dates: due 2026-11-30 (source: plan.md)");
  ok(await run(["update", "TOOLS-1", "--clear-description"]));
  assert.equal(task.description, "Planned dates: due 2026-11-30 (source: plan.md)");
  ok(await run(["update", "TOOLS-1", "--description", "Mine\n\nPlanned dates: due 2026-11-30 (source: Lex)"]));
  assert.equal(task.description, "Mine\n\nPlanned dates: due 2026-11-30 (source: Lex)");
  // A dates line without a source is not a way round the rule.
  const writes = orbit.writes().length;
  refused(await run(["update", "TOOLS-1", "--description", "Mine\n\nPlanned dates: due 2026-11-30"]), /source/);
  orbit.addTask(orbit.tools, { description: "No dates" });
  refused(await run(["update", "TOOLS-2", "--description", "Planned dates: due 2026-11-30"]), /source/);
  refused(await run(["create", "--title", "x", "--description", "Planned dates: due 2026-11-30"]), /source/);
  assert.equal(orbit.writes().length, writes);
  // A line that was already on the card is not stopped by this rule.
  const old = orbit.addTask(orbit.tools, { description: "Planned dates: spring" });
  ok(await run(["note", old.identifier, "fine"]));
});

test("replacing a description keeps the next step and blockers; their own commands take them out", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Next step (Lex): choose\n\nBlocked by: TOOLS-9\n\nOld" });
  ok(await run(["update", "TOOLS-1", "--description", "New"]));
  assert.equal(task.description, "Next step (Lex): choose\n\nBlocked by: TOOLS-9\n\nNew");
  ok(await run(["update", "TOOLS-1", "--clear-description"]));
  assert.equal(task.description, "Next step (Lex): choose\n\nBlocked by: TOOLS-9");
  ok(await run(["update", "TOOLS-1", "--description", "Next step (Lex): other\n\nBlocked by: VID-1\n\nText"]));
  assert.equal(task.description, "Next step (Lex): other\n\nBlocked by: VID-1\n\nText");
  ok(await run(["update", "TOOLS-1", "--blocked-by", "none"]));
  ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.equal(task.description, "Text");
  // Its own next step stays first when blockers are carried over.
  const own = orbit.addTask(orbit.tools, { description: "Next step (Lex): old\n\nBlocked by: TOOLS-9\n\nOld" });
  ok(await run(["update", own.identifier, "--description", "Next step (Lex): new\n\nBody"]));
  assert.equal(own.description, "Next step (Lex): new\n\nBlocked by: TOOLS-9\n\nBody");
  // A Blocked by line in ordinary words comes over exactly as it was written.
  const worded = orbit.addTask(orbit.tools, { description: "Blocked by: legal team, tools-3\n\nOld" });
  ok(await run(["update", worded.identifier, "--description", "New"]));
  assert.equal(worded.description, "Blocked by: legal team, tools-3\n\nNew");
  // Emptying such a card leaves those lines, and the refusal of a blank text says so.
  refused(await run(["update", worded.identifier, "--description", ""]), /next step, blockers and dates line stay/);
});

test("create --blocked-by never drops other words on a Blocked by line in its text", async t => {
  const { orbit, run } = await fixture(t);
  refused(await run(["create", "--title", "x", "--description", "Blocked by: legal team", "--blocked-by", "TOOLS-1"]), /legal, team/);
  assert.equal(orbit.writes().length, 0);
});

test("a worded Blocked by line can be removed with a new text and --blocked-by none, and the refusal says so", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Blocked by: legal team\n\nOld" });
  refused(await run(["update", "TOOLS-1", "--blocked-by", "none"]), /--description.*--blocked-by none/);
  ok(await run(["update", "TOOLS-1", "--description", "New", "--blocked-by", "none"]));
  assert.equal(task.description, "New");
});

test("get shows a title with a line break on one line, so it cannot pass as another field", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { title: "Made\nStatus: Publish" });
  assert.ok(!lines(ok(await run(["get", "TOOLS-1"])).stdout).includes("Status: Publish"));
});

test("list --parent with a status name reads the status on the parent's own board", async t => {
  const { orbit, run } = await fixture(t);
  const parent = orbit.addTask(orbit.video);
  orbit.addTask(orbit.video, { title: "Under video", parent_task_id: parent.id });
  assert.ok(ok(await run(["list", "--parent", "VID-1", "--status", "Idea"])).stdout.includes("Under video"));
});

test("changing blockers never drops other words on the Blocked by line without saying so", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Blocked by: legal team, tools-3" });
  refused(await run(["update", "TOOLS-1", "--blocked-by", "TOOLS-4"]), /legal, team/);
  refused(await run(["update", "TOOLS-1", "--blocked-by", "none"]), /legal, team/);
  assert.equal(task.description, "Blocked by: legal team, tools-3");
  // A second such line counts too, and is read as blockers as well.
  const twice = orbit.addTask(orbit.tools, { description: "Blocked by: TOOLS-1\nBlocked by: legal team, VID-2" });
  refused(await run(["update", "TOOLS-2", "--blocked-by", "TOOLS-4"]), /legal, team/);
  assert.match(twice.description, /legal team/);
  assert.deepEqual(JSON.parse(ok(await run(["get", "TOOLS-2", "--json"])).stdout.split("\nRESULT:")[0]).blocked_by, ["TOOLS-1", "VID-2"]);
  // A blocker is written by its key, which is what the kit reads back.
  refused(await run(["update", "TOOLS-2", "--blocked-by", "33333333-3333-4333-8333-333333333333"]), /card key/i);
  assert.equal(orbit.writes().length, 0);
});

test("Retry-After as a date is honoured too: a near one waits once, a far one is reported", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.answers.push({ retryAfter: new Date(Date.now() + 2000).toUTCString() });
  ok(await run(["get", "TOOLS-1"]));
  assert.equal(orbit.requests.length, 3);
  orbit.requests.length = 0;
  orbit.controls.answers.push({ retryAfter: new Date(Date.now() + 3_600_000).toUTCString() });
  refused(await run(["get", "TOOLS-1"]), /wait \d+ seconds/);
  assert.equal(orbit.requests.length, 1);
});

test("kit lines under a ticked line stay outside the tick, so dates and blockers can still change", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "- [x] Scheduled in Radaar\nPlanned dates: due 2026-12-01 (source: a)" });
  ok(await run(["dates", "TOOLS-1", "--due", "2026-12-02", "--source", "b"]));
  assert.match(task.description, /due 2026-12-02/);
});

test("a blank --parent never drops the board's default parent", async t => {
  const { orbit, run } = await fixture(t, { tickets: "orbit", orbit: { project: "TOOLS", parent: "TOOLS-1" } });
  orbit.addTask(orbit.tools);
  refused(await run(["create", "--title", "x", "--parent", ""]), /card key/i);
  assert.equal(orbit.writes().length, 0);
});

test("a create or comment Orbit refuses as a conflict still leaves its log line", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools);
  orbit.controls.writeAnswers.push({ status: 409, code: "conflict", detail: "Changed" });
  refused(await run(["comment", "TOOLS-1", "x"]), /Changed/);
  assert.match(log(), /action=comment fields=body who=test-lead result=fail:conflict/);
  orbit.controls.writeAnswers.push({ status: 409, code: "conflict", detail: "Changed" });
  refused(await run(["create", "--title", "x"]), /Changed/);
  assert.match(log(), /card=new action=create .*result=fail:conflict/);
  assert.equal(lines(log()).length, 2);
});

test("a blank description never wipes a card by accident; --clear-description does it on purpose", async t => {
  const { home, orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Keep me" });
  const empty = join(home, "empty.md");
  writeFileSync(empty, "");
  refused(await run(["update", "TOOLS-1", "--description", ""]), /--clear-description/);
  refused(await run(["update", "TOOLS-1", "--description-file", empty]), /--clear-description/);
  refused(await run(["update", "TOOLS-1", "--description-file", "-"], {}, " \n"), /--clear-description/);
  assert.equal(orbit.writes().length, 0);
  refused(await run(["update", "TOOLS-1", "--clear-description", "--description", "x"]), /--clear-description/);
  ok(await run(["update", "TOOLS-1", "--clear-description"]));
  assert.equal(task.description, "");
});

test("--json and a dry run print no raw terminal tricks, and the text parses back the same; titles stay one line", async t => {
  const { orbit, run } = await fixture(t);
  const trick = "A\u202Eb\u009bc\u007fd\u200Fe\u061Cf";
  orbit.addTask(orbit.tools, { title: trick });
  const output = ok(await run(["get", "TOOLS-1", "--json"]));
  assert.ok(!/[\u202E\u009b\u007f\u200F\u061C]/.test(output.stdout));
  assert.equal(JSON.parse(output.stdout.split("\nRESULT:")[0]).title, trick);
  assert.ok(!/[\u202E\u009b\u007f\u200F\u061C]/.test(ok(await run(["get", "TOOLS-1"])).stdout));
  assert.ok(!/[\u202E\u009b]/.test(ok(await run(["note", "TOOLS-1", trick, "--dry-run"])).stdout));

  ok(await run(["create", "--title", "Two\nlines"]));
  assert.equal(orbit.tasks[1].title, "Two lines");
  ok(await run(["update", "TOOLS-2", "--title", "Again\ntwo"]));
  assert.equal(orbit.tasks[1].title, "Again two");
  orbit.addTask(orbit.tools, { title: "Made\nelsewhere" });
  assert.equal(lines(ok(await run(["list"])).stdout).length, 4, "one line per card, then the RESULT line");
});

test("only card keys count as blockers", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { description: "Blocked by: legal team, tools-3" });
  assert.deepEqual(JSON.parse(ok(await run(["get", "TOOLS-1", "--json"])).stdout.split("\nRESULT:")[0]).blocked_by, ["TOOLS-3"]);
});

test("an agent the kit starts never inherits a lead's ORBIT_ROLE", async t => {
  const home = mkdtempSync(join(tmpdir(), "kit-ticket-role-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, "bin"), seen = join(home, "seen"), root = join(home, "work");
  mkdirSync(bin);
  mkdirSync(root);
  spawnSync("git", ["init", "-q", root]);
  const fake = (name: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s' "\${ORBIT_ROLE-none}" > "${seen}"\ncat > /dev/null\necho "{}"\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("claude");
  const brief = join(home, "brief.md");
  writeFileSync(brief, "brief");
  const env = { ...kitEnv(), HOME: home, PATH: `${bin}:${kitEnv().PATH}`, ASE_SKIP_DOCTOR: "1", ORBIT_ROLE: "lead" };
  await start(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--cli", "claude", "--model", "claude-opus-5-5", "--out", join(home, "out")], env);
  assert.equal(readFileSync(seen, "utf8"), "none");
});

test("a saved change whose log line cannot be written says the change went through", async t => {
  const home = mkdtempSync(join(tmpdir(), "kit-ticket-log-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const logPath = join(home, "orbit.log");
  const task = { id: "1", identifier: "TOOLS-1", project_id: "p", status_id: "s", title: "Old", description: "", version: 1 };
  const client = {
    task: async () => task,
    patchTask: async () => { rmSync(logPath); mkdirSync(logPath); return { ...task, title: "New" }; },
    pathOf: { task: () => "/tasks/TOOLS-1" },
  };
  const store = orbitStore({ client, role: "lead", who: "me", logPath, redact: (text: string) => text });
  await assert.rejects(() => store.update("TOOLS-1", { title: "New" }), /saved the change to TOOLS-1.*log/);
});

test("the ticket settings are checked the same by the kit's JavaScript and by kit doctor, which names the board", async t => {
  const { root, run, env } = await fixture(t, { tickets: "orbit", orbit: { project: "TOOLS", parent: "TOOLS-10" } });
  const write = (value: object) => writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-ticket", branches: { land: "dev" }, ...value }));
  const doctor = () => start(resolve("kit.d/doctor"), [], { ...env, KIT_DOCTOR_SKIP: "" });
  assert.match((await doctor()).stdout, /tickets: Orbit board TOOLS: connected/);
  write({});
  assert.ok(!(await doctor()).stdout.includes("tickets:"), "files is the default and says nothing");
  const wrong: [object, RegExp][] = [
    [{ tickets: "jira" }, /"tickets" must be "files" or "orbit"/],
    [{ tickets: "orbit" }, /"tickets": "orbit" needs "orbit"/],
    [{ orbit: "TOOLS" }, /"orbit" must be an object/],
    [{ orbit: null }, /"orbit" must be an object/],
    [{ orbit: { project: "no spaces" } }, /"orbit.project" must be an Orbit project key/],
    [{ orbit: { project: "TOOLS", parent: "TOOLS" } }, /"orbit.parent" must be a card key/],
    [{ orbit: { parent: "TOOLS-10" } }, /"orbit.parent" needs "orbit.project"/],
  ];
  for (const [settings, pattern] of wrong) {
    assert.ok(kitSettingsProblems({ project: "x", branches: { land: "dev" }, ...settings }).some((item: string) => pattern.test(item)), String(pattern));
    write(settings);
    const output = await doctor();
    assert.notEqual(output.status, 0);
    assert.match(output.all, pattern);
  }
  // Broken settings do not stop a card read named outright: the board comes from the flag.
  ok(await run(["list", "--project", "TOOLS"]));
  refused(await run(["list"]), /"orbit.parent"/);
  assert.deepEqual(kitSettingsProblems({ project: "x", branches: { land: "dev" }, tickets: "files" }), []);
});

test("kit doctor's Orbit line says what Orbit really answers, asking once, never failing and never printing a secret", async t => {
  const { env, orbit, configPath, config, save } = await fixture(t);
  const doctor = (args: string[] = []) => start(resolve("kit.d/doctor"), args, { ...env, KIT_DOCTOR_SKIP: "" });
  const line = async () => {
    orbit.requests.length = 0;
    const output = await doctor();
    for (const secret of secrets) assert.ok(!output.all.includes(secret), "a secret was printed");
    assert.equal(orbit.requests.length <= 1, true, "asks Orbit at most once");
    return { status: output.status, line: lines(output.stdout).find(item => item.startsWith("tickets:")) ?? "", result: lines(output.stdout).at(-1)! };
  };
  const connected = await line();
  assert.equal(connected.line, "tickets: Orbit board TOOLS: connected");
  assert.equal(orbit.requests[0].method, "GET");
  assert.ok(orbit.requests[0].path.endsWith("/me"), "a read-only call");

  const states: [() => void, RegExp][] = [
    [() => orbit.controls.answers.push({ status: 401, code: "unauthorized", detail: `bad ${fakeToken}` }), /token refused or expired$/],
    [() => orbit.controls.answers.push({ status: 403, code: "insufficient_scope", detail: "no" }), /token refused or expired$/],
    [() => orbit.controls.answers.push("redirect"), /Cloudflare blocked it$/],
    [() => orbit.controls.answers.push("cloudflare-page"), /Cloudflare blocked it$/],
    [() => orbit.controls.answers.push("login-page-200"), /Cloudflare blocked it$/],
    [() => orbit.controls.answers.push("gateway-page"), /Orbit not answering \(502\)$/],
    [() => orbit.controls.answers.push({ status: 500, code: "internal_error", detail: "down" }), /Orbit not answering \(500\)$/],
    [() => orbit.controls.answers.push({ retryAfter: "1" }), /Orbit not answering \(too many requests\)$/],
  ];
  for (const [arrange, pattern] of states) {
    arrange();
    const answer = await line();
    assert.match(answer.line, new RegExp(`^tickets: Orbit board TOOLS: ${pattern.source}`), String(pattern));
    assert.equal(answer.status, connected.status, "the Orbit line never changes how doctor ends");
    assert.equal(answer.result, connected.result);
    assert.equal(orbit.requests.length, 1, "a 429 or an error is not retried");
  }

  // The real refusals, not queued answers: a wrong token, a wrong pass, nothing listening.
  save({ ...config, token: "orb_wrongtokenforthedoctorcheck000" });
  assert.match((await line()).line, /token refused or expired$/);
  save({ ...config, cf_access_client_secret: "wrong-pass-secret" });
  assert.match((await line()).line, /Cloudflare blocked it$/);
  save({ ...config, origin: "http://127.0.0.1:9" });
  assert.match((await line()).line, /Orbit not answering$/);

  // Days left only when the saved file records an expiry.
  const inDays = (days: number) => new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString();
  save({ ...config, token_expires_at: inDays(42) });
  assert.equal((await line()).line, "tickets: Orbit board TOOLS: connected; token runs out in 42 days");
  save({ ...config, token_expires_at: new Date(Date.now() - 2.5 * 86_400_000).toISOString() });
  orbit.controls.answers.push({ status: 401, code: "unauthorized", detail: "expired" });
  assert.equal((await line()).line, "tickets: Orbit board TOOLS: token refused or expired; token ran out 2 days ago");
  save({ ...config, token_expires_at: "whenever" });
  assert.equal((await line()).line, "tickets: Orbit board TOOLS: connected");

  // No setup file: no call at all. A file that cannot be used says why, without its contents.
  rmSync(configPath);
  orbit.requests.length = 0;
  const none = await line();
  assert.equal(none.line, "tickets: Orbit board TOOLS: not set up");
  assert.equal(none.status, connected.status);
  assert.equal(orbit.requests.length, 0);
  save(`{"token":"${fakeToken}", broken`);
  assert.match((await line()).line, /setup file needs attention/);
  save(config, 0o644);
  assert.match((await line()).line, /chmod 600/);
  save(config);

  // kit doctor --quiet, the gate before builds and reviews, stays off the network.
  orbit.requests.length = 0;
  assert.ok(!(await doctor(["--quiet"])).stdout.includes("tickets:"));
  assert.equal(orbit.requests.length, 0);
});

test("the expiry reads right at its edges, and a check that cannot run is said plainly", async t => {
  const { env, save, config } = await fixture(t);
  const hour = 3_600_000, inHours = (hours: number) => new Date(Date.now() + hours * hour).toISOString();
  save({ ...config, token_expires_at: inHours(25) });
  assert.equal(await orbitReport({ ...env }), "connected; token runs out in 1 day");
  save({ ...config, token_expires_at: inHours(2) });
  assert.equal(await orbitReport({ ...env }), "connected; token runs out in 0 days");
  const elsewhere = join(env.HOME!, "no-library");
  mkdirSync(elsewhere);
  const output = await start(resolve("kit.d/doctor"), [], { ...env, KIT_LIB_MJS: join(elsewhere, "kit-lib.mjs"), KIT_DOCTOR_SKIP: "" });
  assert.match(output.stdout, /tickets: Orbit board TOOLS: not checked \(the check could not run\)/);
});

test("a silent Orbit is reported after the short limit, and the check gives up by itself", async t => {
  const { env, orbit } = await fixture(t);
  orbit.controls.answers.push("hang");
  const started = Date.now();
  assert.equal(await orbitReport({ ...env }, { timeoutMs: 300 }), "Orbit not answering");
  assert.ok(Date.now() - started < 5000);
  assert.equal(orbit.requests.length, 1);
});

test("setup saves the token's expiry when Orbit names one, and nothing when it does not", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).token_expires_at, "2027-02-04T00:00:00.000Z");
  rmSync(configPath);
  orbit.controls.me.token.expires_at = null;
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n"));
  assert.ok(!("token_expires_at" in JSON.parse(readFileSync(configPath, "utf8"))));
});

test("a project on files keeps its other commands; kit ticket still reaches Orbit there", async t => {
  const { orbit, run } = await fixture(t, { tickets: "files", orbit: { project: "TOOLS" } });
  ok(await run(["create", "--title", "On the board"]));
  assert.equal(orbit.tasks.length, 1);
});
