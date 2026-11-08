import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { cardStage, cardStandardProblems, orbitDate, orbitStore, showDate, ticketSettings, withBlockedBy, withNote, withPlannedDates, withoutNextLex } from "../ticket-store.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { orbitClient, orbitRedactor, orbitReport } from "../orbit-client.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { cloudflarePassFrom } from "../orbit-setup.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { kitSettingsProblems } from "../kit-lib.mjs";
import { kitEnv } from "./support/kit-env.ts";
import { fakeCfId, fakeCfSecret, fakeOrbit, fakeToken, fakeWorkspace } from "./support/fake-orbit.ts";

// kit ticket import, parity and migrate have their own file: tests/ticket-import.test.ts.
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

async function fixture(t: TestContext, settings: object = { tickets: "orbit", orbit: { project: "TOOLS" } }, { kitBoard = false }: { kitBoard?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kit-ticket-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = join(home, "project");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-ticket", branches: { land: "dev" }, ...settings }));
  const env: NodeJS.ProcessEnv = { ...kitEnv(), HOME: home, KIT_ROOT: root, ORBIT_ROLE: "lead", ASE_OWNER: "test-lead", XDG_STATE_HOME: join(home, "state") };
  for (const name of ["XDG_CONFIG_HOME", "KIT_LIB_MJS", "KIT_LIB", "NODE_TEST_CONTEXT"]) delete env[name];
  const orbit = await fakeOrbit(t, { kitBoard });
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
  assert.match(shown.stdout, /^Assignees: user-a, user-b$/m);
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

test("list shows assignees, filters by status, parent, assignee and text, follows pages and says when more exist", async t => {
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

test("note posts a dated comment and leaves the description alone, and comment adds a real Orbit comment", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  const version = task.version;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
  ok(await run(["note", "TOOLS-1", "first PR https://example.test/pull/1"]));
  assert.equal(orbit.comments[task.id][0].body, `${today} first PR https://example.test/pull/1`);
  ok(await run(["note", "TOOLS-1", "second"]));
  assert.equal(orbit.comments[task.id][1].body, `${today} second`);
  assert.equal(task.description, "Text", "the description is never touched");
  assert.equal(task.version, version);
  assert.match(log(), /card=TOOLS-1 action=comment fields=body who=test-lead result=ok/);
  const dry = ok(await run(["note", "TOOLS-1", "hello", "--dry-run"]));
  assert.match(dry.stdout, new RegExp(`POST .*comments[\\s\\S]*"body": "${today} hello"`));
  assert.equal(orbit.comments[task.id].length, 2);
  refused(await run(["note", "TOOLS-1", "  "]), /text/i);
  refused(await run(["note", "TOOLS-1", "late"], { ORBIT_ROLE: "" }), /only a lead/);
  assert.equal(orbit.comments[task.id].length, 2);
  ok(await run(["comment", "TOOLS-1", "A real comment"]));
  assert.equal(orbit.comments[task.id][2].body, "A real comment");
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
  const task = orbit.addTask(orbit.tools, { description: "Text", assignee_ids: [member(orbit, "Lex")] });
  const set = ok(await run(["next-lex", "TOOLS-1", "record\nthe intro"]));
  assert.equal(task.description, "Next step (Lex): record the intro\n\nText");
  assert.match(set.all, /assign/i);
  ok(await run(["next-lex", "TOOLS-1", "approve it"]));
  assert.equal(task.description, "Next step (Lex): approve it\n\nText");
  refused(await run(["next-lex", "TOOLS-1", " "]), /reason/);
  const cleared = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.equal(task.description, "Text");
  assert.match(cleared.all, /no longer assigned to Lex/);
  const again = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.match(result(again), /already/);
  const empty = orbit.addTask(orbit.tools, { description: "" });
  ok(await run(["next-lex", "TOOLS-2", "go"]));
  assert.equal(empty.description, "Next step (Lex): go");
});

// Assignees: members by name, --assignee on create and update, and next-lex / clear-next-lex that assign and unassign Lex.
const member = (orbit: Awaited<ReturnType<typeof fakeOrbit>>, name: string) => orbit.members.find(item => item.display_name === name)!.user_id;

test("members lists the workspace members by display name and id, and writes nothing", async t => {
  const { orbit, run } = await fixture(t);
  const listed = ok(await run(["members"]));
  assert.match(listed.stdout, new RegExp(`^Lex  ${member(orbit, "Lex")}$`, "m"));
  assert.match(listed.stdout, new RegExp(`^Sam Helper  ${member(orbit, "Sam Helper")}$`, "m"));
  assert.match(result(listed), /^RESULT: ok ticket members: 2 members$/);
  assert.equal(orbit.writes().length, 0);
});

test("create and update take --assignee NAME|ID|none: a name matches one member exactly, ignoring case; none clears", async t => {
  const { orbit, run } = await fixture(t);
  ok(await run(["create", "--title", "By name", "--assignee", "lEx"]));
  assert.deepEqual(orbit.tasks[0].assignee_ids, [member(orbit, "Lex")]);
  ok(await run(["create", "--title", "By id", "--assignee", member(orbit, "Sam Helper")]));
  assert.deepEqual(orbit.tasks[1].assignee_ids, [member(orbit, "Sam Helper")]);
  ok(await run(["create", "--title", "None", "--assignee", "none"]));
  assert.deepEqual(orbit.tasks[2].assignee_ids, []);
  ok(await run(["update", "TOOLS-3", "--assignee", "sam helper"]));
  assert.deepEqual(orbit.tasks[2].assignee_ids, [member(orbit, "Sam Helper")]);
  ok(await run(["update", "TOOLS-3", "--assignee", "NONE"]));
  assert.deepEqual(orbit.tasks[2].assignee_ids, []);
  const before = orbit.writes().length;
  const dry = ok(await run(["update", "TOOLS-1", "--assignee", "Sam Helper", "--dry-run"]));
  assert.match(dry.stdout, new RegExp(`"assignee_ids": \\[\\s*"${member(orbit, "Sam Helper")}"\\s*\\]`));
  assert.equal(orbit.writes().length, before, "a dry run sends nothing");
});

test("an assignee that is no member, or a name that fits no or several members, is refused with the members listed, and nothing is sent", async t => {
  const { orbit, run } = await fixture(t);
  const none = orbit.writes().length;
  refused(await run(["create", "--title", "x", "--assignee", "Nobody"]), /no member called Nobody; the members are: Lex, Sam Helper/);
  refused(await run(["create", "--title", "x", "--assignee", "Sam"]), /no member called Sam/);
  refused(await run(["create", "--title", "x", "--assignee", "00000000-0000-4000-8000-000000000000"]), /no member/);
  orbit.members.push({ user_id: "22222222-2222-4222-8222-222222222222", display_name: "LEX" });
  const several = refused(await run(["create", "--title", "x", "--assignee", "lex"]), /more than one member called lex: Lex, LEX/);
  assert.match(several.all, /use the id/);
  assert.equal(orbit.writes().length, none);
  ok(await run(["create", "--title", "by id", "--assignee", "22222222-2222-4222-8222-222222222222"]));
  assert.deepEqual(orbit.tasks[0].assignee_ids, ["22222222-2222-4222-8222-222222222222"]);
  refused(await run(["update", "TOOLS-1"]), /--assignee/);
});

test("get and list show assignees by name; an id that is no member shows as it is", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { title: "Mine", assignee_ids: [member(orbit, "Lex"), member(orbit, "Sam Helper")] });
  orbit.addTask(orbit.tools, { title: "Gone", assignee_ids: ["33333333-3333-4333-8333-333333333333"] });
  orbit.addTask(orbit.tools, { title: "Free" });
  const got = ok(await run(["get", "TOOLS-1"]));
  assert.match(got.stdout, /^Assignees: Lex, Sam Helper$/m);
  const json = JSON.parse(ok(await run(["get", "TOOLS-1", "--json"])).stdout.replace(/\nRESULT:.*$/s, ""));
  assert.deepEqual(json.assignee_names, ["Lex", "Sam Helper"]);
  const listed = ok(await run(["list"]));
  assert.match(listed.stdout, /TOOLS-1 .*assignees: Lex, Sam Helper/);
  assert.match(listed.stdout, /TOOLS-2 .*assignees: 33333333-3333-4333-8333-333333333333/);
  assert.match(listed.stdout, /TOOLS-3 .*assignees: none/);
});

test("next-lex also assigns the one member called exactly Lex, keeping the others; clear-next-lex removes only that member", async t => {
  const { orbit, run } = await fixture(t);
  orbit.members.push({ user_id: "44444444-4444-4444-8444-444444444444", display_name: "Lex Luthor" });
  const task = orbit.addTask(orbit.tools, { description: "Text", assignee_ids: [member(orbit, "Sam Helper")] });
  const set = ok(await run(["next-lex", "TOOLS-1", "record the intro"]));
  assert.equal(task.description, "Next step (Lex): record the intro\n\nText");
  assert.deepEqual(task.assignee_ids, [member(orbit, "Sam Helper"), member(orbit, "Lex")]);
  assert.match(set.stdout, /waits for Lex and is assigned to Lex/);
  const again = ok(await run(["next-lex", "TOOLS-1", "record the intro"]));
  assert.match(result(again), /already/);
  const cleared = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.equal(task.description, "Text");
  assert.deepEqual(task.assignee_ids, [member(orbit, "Sam Helper")], "only Lex is taken off");
  assert.match(cleared.stdout, /no longer waits for Lex and is no longer assigned to Lex/);
  const dry = ok(await run(["next-lex", "TOOLS-1", "again", "--dry-run"]));
  assert.match(dry.stdout, new RegExp(member(orbit, "Lex")));
  assert.deepEqual(task.assignee_ids, [member(orbit, "Sam Helper")], "a dry run changes nothing");
});

test("next-lex still writes the first line when no single member is called Lex, and says plainly it could not assign", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text", assignee_ids: [member(orbit, "Sam Helper")] });
  orbit.members.splice(orbit.members.findIndex(item => item.display_name === "Lex"), 1);
  const none = ok(await run(["next-lex", "TOOLS-1", "approve it"]));
  assert.equal(task.description, "Next step (Lex): approve it\n\nText");
  assert.match(none.stdout, /could not assign: no member is called Lex; assign in Orbit/);
  assert.deepEqual(task.assignee_ids, [member(orbit, "Sam Helper")]);
  orbit.members.push({ user_id: "55555555-5555-4555-8555-555555555555", display_name: "Lex" }, { user_id: "66666666-6666-4666-8666-666666666666", display_name: "lex" });
  const two = ok(await run(["next-lex", "TOOLS-1", "approve it now"]));
  assert.match(two.stdout, /could not assign: more than one member is called Lex; assign in Orbit/);
  assert.equal(task.description, "Next step (Lex): approve it now\n\nText");
  const quiet = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.equal(task.description, "Text");
  assert.doesNotMatch(quiet.stdout, /could not/, "no note when none of the members called Lex is on the card");
  task.assignee_ids = [member(orbit, "Sam Helper"), "66666666-6666-4666-8666-666666666666"];
  ok(await run(["next-lex", "TOOLS-1", "approve it again"]));
  const cleared = ok(await run(["clear-next-lex", "TOOLS-1"]));
  assert.match(cleared.stdout, /could not unassign: more than one member is called Lex; unassign in Orbit/);
});

test("a next-lex that is already on the card still says when Lex could not be assigned", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Next step (Lex): go" });
  orbit.comments[task.id] = [{ id: "c1", body: "@Lex go", author_service_account: { name: "fleet" }, created_at: "2026-11-06T10:00:00.000Z" }];
  orbit.members.splice(orbit.members.findIndex(item => item.display_name === "Lex"), 1);
  const out = ok(await run(["next-lex", "TOOLS-1", "go"]));
  assert.match(out.stdout, /TOOLS-1: could not assign: no member is called Lex; assign in Orbit/);
  assert.match(result(out), /already as asked/);
});

test("a members list that cannot be read: get shows the ids, an assignee by name is refused, next-lex still writes its line and says so", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text", assignee_ids: [member(orbit, "Sam Helper")] });
  orbit.controls.membersFail = 1;
  const got = ok(await run(["get", "TOOLS-1"]));
  assert.match(got.stdout, new RegExp(`^Assignees: ${member(orbit, "Sam Helper")}$`, "m"));
  orbit.controls.membersFail = 1;
  refused(await run(["update", "TOOLS-1", "--assignee", "Lex"]), /500|members list|boom|Orbit/);
  assert.equal(orbit.writes().length, 0);
  orbit.controls.membersFail = 1;
  const set = ok(await run(["next-lex", "TOOLS-1", "go"]));
  assert.equal(task.description, "Next step (Lex): go\n\nText");
  assert.match(set.stdout, /could not assign: Orbit would not list the members/);
  assert.match(set.stdout, /assign in Orbit/);
  assert.deepEqual(task.assignee_ids, [member(orbit, "Sam Helper")]);
  orbit.controls.membersFail = 0;
  assert.match(ok(await run(["get", "TOOLS-1"])).stdout, /^Assignees: Sam Helper$/m, "the next run asks again and shows names");
});

test("assigning keeps the lead-only guard for create too", async t => {
  const { orbit, run } = await fixture(t);
  refused(await run(["create", "--title", "x", "--assignee", "Lex"], { ORBIT_ROLE: "helper" }), /only a lead may write/);
  assert.equal(orbit.writes().length, 0);
});

test("list --assignee takes a name, an id or none, like create and update", async t => {
  const { orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { title: "Lex's", assignee_ids: [member(orbit, "Lex")] });
  orbit.addTask(orbit.tools, { title: "Sam's", assignee_ids: [member(orbit, "Sam Helper")] });
  orbit.addTask(orbit.tools, { title: "Nobody's" });
  const named = ok(await run(["list", "--assignee", "lex"]));
  assert.match(named.stdout, /TOOLS-1 /);
  assert.equal(orbit.requests.filter(item => item.path.endsWith("/tasks")).at(-1)!.query.get("assignee_id"), member(orbit, "Lex"));
  ok(await run(["list", "--assignee", member(orbit, "Sam Helper")]));
  assert.equal(orbit.requests.filter(item => item.path.endsWith("/tasks")).at(-1)!.query.get("assignee_id"), member(orbit, "Sam Helper"));
  ok(await run(["list", "--assignee", "none"]));
  assert.equal(orbit.requests.filter(item => item.path.endsWith("/tasks")).at(-1)!.query.get("assignee_id"), "none");
  ok(await run(["list", "--assignee", "99999999-9999-4999-8999-999999999999"]));
  refused(await run(["list", "--assignee", "Nobody"]), /no member called Nobody/);
});

test("assigning keeps the lead-only guard: a helper cannot assign by --assignee or next-lex", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  refused(await run(["update", "TOOLS-1", "--assignee", "Lex"], { ORBIT_ROLE: "helper" }), /only a lead may write/);
  refused(await run(["next-lex", "TOOLS-1", "go"], { ORBIT_ROLE: "helper" }), /only a lead may write/);
  assert.equal(orbit.writes().length, 0);
  assert.deepEqual(task.assignee_ids, []);
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
  const noted = ok(await run(["next-lex", "TOOLS-1", "mine"]));
  assert.match(noted.stdout, /TOOLS-1/);
  assert.match(task.description, /Their line/);
  assert.match(task.description, /mine/);
  assert.equal(orbit.writes().filter(item => item.method === "PATCH").length, 2);
  assert.equal((log().match(/action=next-lex/g) ?? []).length, 1, "one log line for one change");

  orbit.controls.conflicts = 2;
  orbit.controls.concurrentEdit = undefined;
  const before = orbit.writes().length;
  refused(await run(["next-lex", "TOOLS-1", "again"]), /changed again.*nothing.*saved|nothing.*saved.*changed/is);
  assert.equal(orbit.writes().length - before, 2, "one retry, no loop");
  assert.match(log(), /action=next-lex fields=description who=test-lead result=fail:conflict/);
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
  const task = orbit.addTask(orbit.tools);
  orbit.comments[task.id] = [{ id: "c1", body: "@Lex go", author_service_account: { name: "fleet" }, created_at: "2026-11-06T10:00:00.000Z" }];
  // The change someone else already made: the retry has nothing to send, and the refused write is on the log.
  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.description = "Next step (Lex): go"; card.assignee_ids = [member(orbit, "Lex")]; };
  assert.match(result(ok(await run(["next-lex", "TOOLS-1", "go"]))), /already/);
  assert.equal(lines(log()).length, 1);
  assert.match(lines(log()).at(-1)!, /action=next-lex fields=description,assignee_ids who=test-lead result=fail:conflict/);
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
  assert.match(orbit.comments[task.id][1].body, /^\d{4}-\d{2}-\d{2} --help$/);
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
  refused(await run(["setup", "--from-mcp-config=/some/file"]), /write it as --from-mcp-config <value>/);
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
  ok(await run(["next-lex", "TOOLS-1", "fine"]));
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
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Fake\u001b[31m\u202E" }, { id: "22222222-2222-4222-8222-222222222222", name: "Other" }];
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  const clean = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, `yes\n${fakeWorkspace}\n`));
  assert.ok(!/[\u001b\u202E]/.test(clean.stderr));
  // A name two workspaces share picks neither: it counts as a slip, and the id still works.
  rmSync(configPath);
  orbit.controls.me.workspaces = [{ id: fakeWorkspace, name: "Same" }, { id: "22222222-2222-4222-8222-222222222222", name: "Same" }];
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\nSame\n22222222-2222-4222-8222-222222222222\n"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).workspace_id, "22222222-2222-4222-8222-222222222222");
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
  for (const name of ["labels", "create", "get", "list", "update", "dates", "note", "comment", "sub-tasks", "members", "next-lex", "clear-next-lex", "trash", "setup", "check", "tidy"]) assert.match(main.stdout, new RegExp(`\\b${name}\\b`));
  assert.match(main.stdout, /orbit-card-standard/);
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

test("a card with Windows line endings and an old Notes section keeps it as it was when dates change", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text\r\n\r\n## Notes\r\n\r\n- a" });
  ok(await run(["dates", "TOOLS-1", "--due", "2026-11-30", "--source", "s"]));
  assert.equal(task.description.match(/## Notes/g)!.length, 1);
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

test("setup saves the token's expiry when Orbit names one, and asks when it does not", async t => {
  const { home, run, orbit, configPath } = await fixture(t);
  rmSync(configPath);
  const mcp = fakeMcpSettings(home, orbit.origin);
  const secret = join(home, "secret-box");
  writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n"));
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).token_expires_at, "2027-02-04T00:00:00.000Z");
  // Orbit named the date, so nothing was asked.
  const box = () => writeFileSync(secret, `${fakeToken}\n`, { mode: 0o600 });
  rmSync(configPath);
  box();
  assert.ok(!ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n")).stderr.includes("When does this token expire?"));

  // Orbit names none: setup asks; a date is read as the end of that day in Amsterdam, Enter saves none, and a slip saves none and says so.
  orbit.controls.me.token.expires_at = null;
  rmSync(configPath);
  box();
  const asked = ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n2027-11-06\n"));
  assert.match(asked.stderr, /When does this token expire\? \(YYYY-MM-DD, Enter if unknown\)/);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).token_expires_at, "2027-11-06T22:59:00.000Z");
  rmSync(configPath);
  box();
  ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\n\n"));
  assert.ok(!("token_expires_at" in JSON.parse(readFileSync(configPath, "utf8"))));
  rmSync(configPath);
  box();
  assert.match(ok(await run(["setup", "--from-file", secret, "--from-mcp-config", mcp], {}, "yes\nsoon\n")).all, /not a date.*no expiry/i);
  assert.ok(!("token_expires_at" in JSON.parse(readFileSync(configPath, "utf8"))));
});

test("labels lists the names Orbit has for a board, for anyone, and needs a board", async t => {
  const { orbit, run } = await fixture(t);
  const listed = ok(await run(["labels"], { ORBIT_ROLE: "" }));
  assert.deepEqual(lines(listed.stdout).slice(0, -1), ["Script", "Record", "Short video"]);
  assert.match(result(listed), /labels TOOLS: 3 labels/);
  orbit.labels.get(orbit.video.id)!.splice(1);
  assert.deepEqual(lines(ok(await run(["labels", "--project", "VID"])).stdout).slice(0, -1), ["Script"]);
  refused(await run(["labels", "--project", "NOPE"]), /TOOLS.*VID/);
  const bare = await fixture(t, {});
  refused(await bare.run(["labels"]), /--project/);
  refused(await run(["labels", "extra"]), /does not take extra/);
});

test("create and update set labels by name, an unknown name is refused with the known names, and none is ever made", async t => {
  const { orbit, run, log } = await fixture(t);
  const ids = (project: typeof orbit.tools, ...names: string[]) => names.map(name => orbit.labels.get(project.id)!.find(label => label.name === name)!.id);
  ok(await run(["create", "--title", "Video", "--label", "Script,short video"]));
  assert.deepEqual(orbit.tasks[0].label_ids, ids(orbit.tools, "Script", "Short video"));
  assert.match(log(), /action=create fields=.*label_ids/);
  ok(await run(["update", "TOOLS-1", "--label", " Record , Record "]));
  assert.deepEqual(orbit.tasks[0].label_ids, ids(orbit.tools, "Record"), "a list replaces the old list");
  assert.match(lines(log()).at(-1)!, /action=update fields=label_ids/);

  const writes = orbit.writes().length;
  for (const args of [["update", "TOOLS-1", "--label", "Script,Nope"], ["create", "--title", "x", "--label", "Nope"]]) {
    refused(await run(args), /Nope.*Script, Record, Short video/);
  }
  refused(await run(["update", "TOOLS-1", "--label", " , "]), /--clear-labels/);
  refused(await run(["update", "TOOLS-1", "--label", "Record", "--clear-labels"]), /--clear-labels/);
  assert.equal(orbit.writes().length, writes, "a refused name sends nothing");
  assert.equal(orbit.labels.get(orbit.tools.id)!.length, 3);
  assert.ok(!orbit.requests.some(item => item.method !== "GET" && item.path.endsWith("/labels")), "never creates a label");

  // Each board has its own labels: a name resolves on the card's own board.
  ok(await run(["create", "--project", "VID", "--title", "Other", "--label", "Script"]));
  assert.deepEqual(orbit.tasks[1].label_ids, ids(orbit.video, "Script"));

  ok(await run(["update", "TOOLS-1", "--label", "Script,Record"]));
  const same = ok(await run(["update", "TOOLS-1", "--label", "Record,Script"]));
  assert.match(result(same), /already/, "the same labels in another order are no change");
  ok(await run(["update", "TOOLS-1", "--clear-labels"]));
  assert.deepEqual(orbit.tasks[0].label_ids, []);
  assert.match(result(ok(await run(["update", "TOOLS-1", "--clear-labels"]))), /already/);
});

test("label writes are lead-only and take --dry-run, and a retry never overwrites labels someone else changed", async t => {
  const { orbit, run, log } = await fixture(t);
  const task = orbit.addTask(orbit.tools);
  const [script, record] = orbit.labels.get(orbit.tools.id)!.map(label => label.id);
  refused(await run(["update", "TOOLS-1", "--label", "Script"], { ORBIT_ROLE: "" }), /ORBIT_ROLE=lead/);
  refused(await run(["update", "TOOLS-1", "--clear-labels"], { ORBIT_ROLE: "" }), /ORBIT_ROLE=lead/);
  refused(await run(["create", "--title", "x", "--label", "Script"], { ORBIT_ROLE: "" }), /ORBIT_ROLE=lead/);
  const dry = ok(await run(["update", "TOOLS-1", "--label", "Script", "--dry-run"], { ORBIT_ROLE: "" }));
  assert.ok(dry.stdout.includes(script));
  assert.match(dry.stdout, /"label_ids"/);
  assert.match(ok(await run(["create", "--title", "x", "--label", "Script", "--dry-run"])).stdout, /"label_ids"/);
  assert.equal(orbit.writes().length, 0);
  assert.equal(log(), "");

  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = card => { card.label_ids = [record]; };
  refused(await run(["update", "TOOLS-1", "--label", "Script"]), /label_ids|labels/);
  assert.deepEqual(task.label_ids, [record]);
});

test("adding a Publish label needs Lex's words, in any letter case, like the Publish status", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.labels.get(orbit.tools.id)!.push({ id: "label-publish", project_id: orbit.tools.id, name: "Publish", color: "gray", version: 1 });
  const task = orbit.addTask(orbit.tools);
  for (const args of [["update", "TOOLS-1", "--label", "Publish"], ["update", "TOOLS-1", "--label", "publish"], ["update", "TOOLS-1", "--label", "Script,PUBLISH"], ["create", "--title", "x", "--label", "Publish"]]) {
    refused(await run(args), /--lex-said/);
    refused(await run([...args, "--dry-run"]), /--lex-said/);
  }
  assert.equal(orbit.writes().length, 0);

  ok(await run(["update", "TOOLS-1", "--label", "Publish", "--lex-said", "publish it"]));
  assert.deepEqual(task.label_ids, ["label-publish"]);
  assert.match(log(), /fields=label_ids .*lex_said="publish it"/);
  ok(await run(["create", "--title", "y", "--label", "Publish", "--lex-said", "publish that one"]));
  assert.deepEqual(orbit.tasks[1].label_ids, ["label-publish"]);

  // Already on the card, or taken off: no new move, so no words are needed.
  const script = orbit.labels.get(orbit.tools.id)![0].id;
  ok(await run(["update", "TOOLS-1", "--label", "Publish,Script"]));
  assert.deepEqual(task.label_ids, ["label-publish", script]);
  ok(await run(["update", "TOOLS-1", "--label", "Script"]));
  assert.deepEqual(task.label_ids, [script]);
  ok(await run(["update", "TOOLS-2", "--clear-labels"]));
  // Back on after it came off is a new move again; other labels never ask.
  refused(await run(["update", "TOOLS-1", "--label", "Publish"]), /--lex-said/);
  ok(await run(["update", "TOOLS-1", "--label", "Record"]));
});

test("any label with the word publish in its name needs Lex's words, the same test as the status guard", async t => {
  const { orbit, run } = await fixture(t);
  for (const [id, name] of [["label-ready", "Ready to publish"], ["label-done", "Published"]]) orbit.labels.get(orbit.tools.id)!.push({ id, project_id: orbit.tools.id, name, color: "gray", version: 1 });
  const task = orbit.addTask(orbit.tools);
  refused(await run(["update", "TOOLS-1", "--label", "Ready to publish"]), /adding the Ready to publish label.*--lex-said/);
  refused(await run(["update", "TOOLS-1", "--label", "Published"]), /--lex-said/);
  refused(await run(["create", "--title", "x", "--label", "ready to PUBLISH"]), /--lex-said/);
  assert.equal(orbit.writes().length, 0);
  ok(await run(["update", "TOOLS-1", "--label", "Ready to publish", "--lex-said", "ready to publish it"]));
  assert.deepEqual(task.label_ids, ["label-ready"]);
});

test("get and list show label names; a card without labels asks Orbit for none", async t => {
  const { orbit, run } = await fixture(t);
  const [script, record] = orbit.labels.get(orbit.tools.id)!.map(label => label.id);
  orbit.addTask(orbit.tools, { title: "Plain" });
  orbit.addTask(orbit.tools, { title: "Tagged", label_ids: [script, record, "gone-label-id"] });
  ok(await run(["get", "TOOLS-1"]));
  assert.ok(!orbit.requests.some(item => item.path.endsWith("/labels")));
  const shown = ok(await run(["get", "TOOLS-2"]));
  assert.match(shown.stdout, /^Labels: Script, Record, gone-label-id$/m);
  const json = JSON.parse(ok(await run(["get", "TOOLS-2", "--json"])).stdout.split("\nRESULT:")[0]);
  assert.deepEqual(json.label_names, ["Script", "Record", "gone-label-id"]);
  assert.deepEqual(json.label_ids, [script, record, "gone-label-id"]);
  const list = ok(await run(["list"]));
  assert.match(list.stdout, /TOOLS-2 .*labels: Script, Record, gone-label-id .*Tagged/);
  assert.ok(!/TOOLS-1 .*labels:/.test(list.stdout));
  orbit.requests.length = 0;
  ok(await run(["list"]));
  assert.equal(orbit.requests.filter(item => item.path.endsWith("/labels")).length, 1, "one request per board");
  assert.deepEqual(JSON.parse(ok(await run(["list", "--json"])).stdout.split("\nRESULT:")[0]).find((item: { title: string }) => item.title === "Tagged").label_names, ["Script", "Record", "gone-label-id"]);
  assert.match(ok(await run(["sub-tasks", "TOOLS-1"])).stdout, /RESULT: ok/);
});

test("a project on files keeps its other commands; kit ticket still reaches Orbit there", async t => {
  const { orbit, run } = await fixture(t, { tickets: "files", orbit: { project: "TOOLS" } });
  ok(await run(["create", "--title", "On the board"]));
  assert.equal(orbit.tasks.length, 1);
});

// Writes carry the saved Orbit origin as their Origin header; the running Orbit refuses a write without it.
test("the fake Orbit refuses a write with no Origin or another one, as the running Orbit does, and lets reads through", async t => {
  const orbit = await fakeOrbit(t);
  const call = (method: string, origin?: string) => fetch(`${orbit.origin}/api/public/v1/workspaces/${fakeWorkspace}/tasks${method === "GET" ? "" : "/x"}`, {
    method, headers: { Authorization: `Bearer ${fakeToken}`, "CF-Access-Client-Id": fakeCfId, "CF-Access-Client-Secret": fakeCfSecret, "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    ...(method === "PATCH" ? { body: "{}" } : {}) });
  for (const method of ["PATCH", "DELETE"]) {
    for (const origin of [undefined, "https://elsewhere.example.test", `${orbit.origin}/`]) {
      const answer = await call(method, origin);
      assert.equal(answer.status, 403, `${method} with Origin ${origin}`);
      const problem = await answer.json();
      assert.equal(problem.code, "origin_forbidden");
      assert.equal(problem.detail, "The request origin is not allowed.");
    }
    assert.notEqual((await call(method, orbit.origin)).status, 403);
  }
  assert.equal((await call("GET")).status, 200);
});

test("every write the client makes sends the saved Orbit origin as Origin, and no read does", async t => {
  const orbit = await fakeOrbit(t, { kitBoard: true });
  const client = orbitClient({ origin: orbit.origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret }, { timeoutMs: 5_000 });
  const made = await client.createTask({ project_id: orbit.kit.id, title: "Origin", status_id: orbit.statusId(orbit.kit, "Todo") });
  await client.patchTask(made.id, { title: "Origin 2", expected_version: made.version });
  await client.addComment(made.id, "hello");
  await client.tasks({}, 5);
  await client.comments(made.id);
  const fresh = await client.task(made.id);
  await client.trashTask(made.id, fresh.version);
  const writes = orbit.requests.filter(item => item.method !== "GET");
  assert.deepEqual(writes.map(item => item.method), ["POST", "PATCH", "POST", "DELETE"]);
  for (const item of writes) assert.equal(item.headers.origin, orbit.origin, `${item.method} ${item.path}`);
  for (const item of orbit.requests.filter(item => item.method === "GET")) assert.equal(item.headers.origin, undefined, `GET ${item.path}`);
});

test("a write never sends an Origin that is not the saved Orbit origin: an address with a path or a slash is refused before anything is sent", async t => {
  const orbit = await fakeOrbit(t);
  for (const origin of [`${orbit.origin}/`, `${orbit.origin}/api`, "https://user:pw@board.example.test", "ftp://board.example.test"]) {
    const client = orbitClient({ origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret }, { timeoutMs: 2_000 });
    await assert.rejects(() => client.patchTask("TOOLS-1", { title: "x" }), (error: Error) => /saved Orbit address/.test(error.message) && !error.message.includes(fakeToken) && (error as any).code === "bad-origin" && (error as any).noAnswer === false && /--from-mcp-config/.test(error.message));
    await assert.rejects(() => client.createTask({ project_id: "x", title: "x" }), (error: Error) => (error as any).code === "bad-origin" && !/may or may not/.test(error.message));
  }
  assert.equal(orbit.requests.length, 0, "nothing reached the server");
});

test("origin_forbidden is told in plain words: what Orbit refused and what the kit sent", async t => {
  const orbit = await fakeOrbit(t, { kitBoard: true });
  orbit.controls.writeAnswers.push({ status: 403, code: "origin_forbidden", detail: "The request origin is not allowed." });
  const card = orbit.addTask(orbit.kit, { title: "Plain", status_id: orbit.statusId(orbit.kit, "Todo") });
  const client = orbitClient({ origin: orbit.origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret }, { timeoutMs: 5_000 });
  await assert.rejects(() => client.patchTask(card.id, { title: "x", expected_version: card.version }), (error: Error & { code?: string }) => {
    assert.equal(error.code, "origin_forbidden");
    assert.ok(error.message.startsWith(`Orbit refused the change because the saved Orbit address (${orbit.origin}) is not the one Orbit expects: it must be exactly the address you open Orbit at [origin_forbidden].`), error.message);
    assert.match(error.message, /ticket setup --from-mcp-config/);
    assert.doesNotMatch(error.message, /request origin|Origin header/);
    return true;
  });
});

// Stage 2: the store calls kit next, slice, pr and status make on a project that keeps its tickets on Orbit.
async function boardStore(t: TestContext, role = "lead", who = "kit-1") {
  const orbit = await fakeOrbit(t, { kitBoard: true });
  const home = mkdtempSync(join(tmpdir(), "kit-board-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const client = orbitClient({ origin: orbit.origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret }, { timeoutMs: 5_000 });
  const make = (asRole = role, asWho = who) => orbitStore({ client, role: asRole, who: asWho, logPath: join(home, "orbit.log"), redact: orbitRedactor(secrets), secrets, defaults: { project: "KIT" } });
  const card = (fields: Record<string, any> = {}, status = "Todo") => orbit.addTask(orbit.kit, { status_id: orbit.statusId(orbit.kit, status), ...fields });
  return { orbit, store: make(), make, card, log: () => existsSync(join(home, "orbit.log")) ? readFileSync(join(home, "orbit.log"), "utf8") : "" };
}

test("cardStage reads the status by name: Done, In Progress, Todo, Backlog; a board without Todo starts on any unstarted status", () => {
  const kitBoard = ["Backlog", "Todo", "In Progress", "Done"].map(name => ({ name, category: name === "Done" ? "completed" : name === "In Progress" ? "started" : "unstarted" }));
  assert.deepEqual(kitBoard.map(status => cardStage(status, kitBoard)), ["waiting", "ready", "working", "done"]);
  const video = [{ name: "Idea", category: "unstarted" }, { name: "Script", category: "started" }, { name: "Publish", category: "completed" }];
  assert.deepEqual(video.map(status => cardStage(status, video)), ["ready", "working", "done"]);
  assert.equal(cardStage({ name: "Won't do", category: "cancelled" }, kitBoard), "done");
});

test("board lists the cards under the project's parent with their stage, claim, next step and open blockers, in number order", async t => {
  const { orbit, store, card } = await boardStore(t);
  const parent = card({ title: "Parent" }, "In Progress");
  card({ title: "Done one", parent_task_id: parent.id }, "Done");
  card({ title: "Needs done one", parent_task_id: parent.id, description: "Blocked by: KIT-2" });
  card({ title: "Needs three", parent_task_id: parent.id, description: "Blocked by: KIT-3, VID-9" });
  card({ title: "Elsewhere" });
  const { board, cards } = await store.board({ parent: "KIT-1" });
  assert.equal(board, "KIT");
  assert.deepEqual(cards.map((item: any) => [item.identifier, item.stage, item.open_blockers]), [
    ["KIT-2", "done", []], ["KIT-3", "ready", []], ["KIT-4", "ready", ["KIT-3 (Todo)", "VID-9 (not found)"]],
  ]);
  assert.equal(orbit.writes().length, 0, "reading the board writes nothing");
});

test("claim moves a card to In Progress with a Claimed by line in one write; the same owner again is no change and needs no lead", async t => {
  const { orbit, store, make, card, log } = await boardStore(t);
  const task = card({ description: "Next text" });
  const claimed = await store.claim("KIT-1", "kit-1");
  assert.equal(orbit.statusOf(task), "In Progress");
  assert.equal(task.description, "Claimed by: kit-1\n\nNext text");
  assert.equal(claimed.previous, orbit.statusId(orbit.kit, "Todo"));
  assert.equal(orbit.writes().length, 1);
  assert.match(log(), /card=KIT-1 action=claim fields=status_id,description who=kit-1 result=ok/);
  const again = await make("helper").claim("KIT-1", "kit-1");
  assert.ok(again.unchanged);
  assert.equal(orbit.writes().length, 1);
  // A note or a new description from the lead keeps the claim line.
  await store.update("KIT-1", { description: "Rewritten" });
  assert.equal(task.description, "Claimed by: kit-1\n\nRewritten");
});

test("a second helper claiming the same card is refused, also when both read it before either wrote", async t => {
  const { orbit, store, make, card } = await boardStore(t);
  const task = card();
  await store.claim("KIT-1", "kit-1");
  await assert.rejects(() => make("lead", "other").claim("KIT-1", "other"), /KIT-1 is already taken by kit-1 \(In Progress\), so it was not claimed/);
  const raced = card();
  // The other helper's claim lands between this read and this write: Orbit answers 409, and the fresh read shows it taken.
  orbit.controls.conflicts = 1;
  orbit.controls.concurrentEdit = edited => { edited.status_id = orbit.statusId(orbit.kit, "In Progress"); edited.description = "Claimed by: other"; };
  await assert.rejects(() => store.claim("KIT-2", "kit-2"), /KIT-2 is already taken by other/);
  assert.equal(raced.description, "Claimed by: other");
  assert.equal(task.description, "Claimed by: kit-1");
});

test("claim refuses a done card, one waiting for Lex, one still blocked and a helper without the lead role", async t => {
  const { orbit, store, make, card } = await boardStore(t);
  card({}, "Done");
  card({ description: "Next step (Lex): choose a name" });
  card({ description: "Blocked by: KIT-4" });
  card();
  await assert.rejects(() => store.claim("KIT-1", "kit-1"), /KIT-1 is already Done/);
  await assert.rejects(() => store.claim("KIT-2", "kit-2"), /KIT-2 waits for Lex/);
  await assert.rejects(() => store.claim("KIT-3", "kit-3"), /KIT-3 is blocked by KIT-4 \(Todo\)/);
  await assert.rejects(() => make("helper").claim("KIT-4", "kit-4"), /only a lead may write/);
  assert.equal(orbit.writes().length, 0);
});

test("unclaim gives the status and the claim back; close sets Done with a dated note and drops the claim, once", async t => {
  const { orbit, store, card } = await boardStore(t);
  const task = card({ description: "Text" });
  const { previous } = await store.claim("KIT-1", "kit-1");
  await store.unclaim("KIT-1", "kit-1", previous);
  assert.equal(orbit.statusOf(task), "Todo");
  assert.equal(task.description, "Text");
  await store.claim("KIT-1", "kit-1");
  const unchanged = await store.unclaim("KIT-1", "someone-else", previous);
  assert.ok(unchanged.unchanged, "a claim someone else holds is left alone");
  await store.close("KIT-1", "Landed: PR https://github.com/acme/tools/pull/7, merge abc1234");
  assert.equal(orbit.statusOf(task), "Done");
  assert.match(task.description, /^Text\n\n## Notes\n\n- \d{4}-\d{2}-\d{2} \(kit-1\): Landed: PR https:\/\/github\.com\/acme\/tools\/pull\/7, merge abc1234$/);
  const writes = orbit.writes().length;
  assert.ok((await store.close("KIT-1", "Landed: PR https://github.com/acme/tools/pull/7, merge abc1234")).unchanged);
  assert.equal(orbit.writes().length, writes);
});

test("close never moves a card to a Publish status in place of a missing Done: it says the board has no Done status", async t => {
  const { orbit, store } = await boardStore(t);
  const task = orbit.addTask(orbit.tools, { status_id: orbit.statusId(orbit.tools, "Edit") });
  await assert.rejects(() => store.close(task.identifier, "Landed in PR #1 (merge commit abc)"), /this board has no done status \(it has: Idea, Script, Record, Edit, Publish\)/);
  assert.equal(orbit.statusOf(task), "Edit");
  assert.equal(orbit.writes().length, 0);
});

// The Orbit card standard (docs/orbit-card-standard.md): note as a dated comment, warnings and `check`, next-lex with an @Lex comment, and tidy.
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam" }).format(new Date());
const goodCard = "Goal: make it.\n\nDone when:\n- it works\n\nLinks: none";
const kitBoardSettings = { tickets: "orbit", orbit: { project: "KIT" } };
const warnings = (output: Run) => lines(output.stdout).filter(line => line.startsWith("Warning: "));

test("cardStandardProblems names each broken rule, ignores the lines the kit keeps, and counts only lines with text", () => {
  const rules = (text: string) => cardStandardProblems(text).map((item: { rule: string }) => item.rule);
  assert.deepEqual(rules(goodCard), []);
  assert.deepEqual(rules("Goal\nDone when:\n- x\n\n## Notes\n\n- 2026-11-08 a"), ["notes"]);
  assert.deepEqual(rules("Goal\nDone when:\n- x\n- [ ] part\n  - [x] other"), ["checklist"]);
  assert.deepEqual(rules("Goal only"), ["no-done-when"]);
  assert.deepEqual(rules(""), ["no-done-when"]);
  assert.deepEqual(rules(undefined), ["no-done-when"]);
  assert.deepEqual(rules("Goal\nDone when: it works\nLinks: none"), []);
  assert.deepEqual(rules("Goal\ndone when: lower case"), []);
  const filler = (count: number) => Array.from({ length: count }, (_, index) => `Line ${index + 1}`).join("\n");
  // 12 lines with text, one of them the Done when line: fine; blank lines and the kit's own lines never count.
  const twelve = `Done when:\n${filler(11)}`.split("\n").join("\n\n");
  const kept = "Next step (Lex): go\nPlanned dates: due 2026-11-30 (source: plan)\nBlocked by: TOOLS-9\nClaimed by: kit-1";
  assert.deepEqual(rules(`${kept}\n\n${twelve}`), []);
  assert.deepEqual(rules(`${kept}\n\n${twelve}\nOne more`), ["too-long"]);
  const all = cardStandardProblems(`${filler(13)}\n## Notes\n- [ ] a`).map((item: { rule: string }) => item.rule);
  assert.deepEqual(all, ["too-long", "notes", "checklist", "no-done-when"]);
  for (const item of cardStandardProblems("## Notes")) assert.match(item.message, /^[A-Z].*\.$/);
});

test("create and update warn about a description that breaks the card standard, exit 0 and still write it", async t => {
  const { orbit, run } = await fixture(t);
  const clean = ok(await run(["create", "--title", "Clean", "--description", goodCard]));
  assert.deepEqual(warnings(clean), []);
  const long = Array.from({ length: 13 }, (_, index) => `Line ${index + 1}`).join("\n");
  const messy = ok(await run(["create", "--title", "Messy", "--description", `${long}\n\n## Notes\n\n- a\n- [ ] part\n- [x] done part`]));
  assert.equal(warnings(messy).length, 4, messy.stdout);
  assert.match(messy.stdout, /Warning: .*17 lines/);
  assert.match(messy.stdout, /Warning: .*## Notes/);
  assert.match(messy.stdout, /Warning: .*checklist/);
  assert.match(messy.stdout, /Warning: .*Done when:/);
  assert.match(messy.stdout, /docs\/orbit-card-standard\.md/);
  assert.equal(messy.status, 0);
  assert.match(result(messy), /^RESULT: ok /);
  assert.ok(orbit.tasks[1].description.includes("## Notes"), "the card is written as asked");
  // No description at all has no Done when line either.
  assert.equal(warnings(ok(await run(["create", "--title", "Bare"]))).length, 1);

  const plain = orbit.addTask(orbit.tools, { description: "Old text" });
  const updated = ok(await run(["update", plain.identifier, "--description", "New text without the line"]));
  assert.match(warnings(updated).join("\n"), /Done when:/);
  assert.equal(plain.description, "New text without the line");
  assert.deepEqual(warnings(ok(await run(["update", plain.identifier, "--description", goodCard]))), []);
  // A change that leaves the description alone says nothing about it.
  assert.deepEqual(warnings(ok(await run(["update", plain.identifier, "--title", "Renamed"]))), []);
  // The kit's own lines are not counted and a carried-over one never makes a warning.
  const planned = orbit.addTask(orbit.tools, { description: "Next step (Lex): go\n\nBlocked by: TOOLS-1\n\nOld" });
  assert.deepEqual(warnings(ok(await run(["update", planned.identifier, "--description", goodCard]))), []);
  // A dry run shows the same warnings and still sends nothing.
  const writes = orbit.writes().length;
  assert.equal(warnings(ok(await run(["update", plain.identifier, "--description", "x", "--dry-run"]))).length, 1);
  assert.equal(orbit.writes().length, writes);
});

test("check lists the cards that break the standard and the rule, for one card, a board or all boards, and writes nothing", async t => {
  const { orbit, run, log } = await fixture(t);
  orbit.addTask(orbit.tools, { title: "Fine", description: goodCard });
  orbit.addTask(orbit.tools, { title: "Has notes", description: `${goodCard}\n\n## Notes\n\n- 2026-11-08 old` });
  orbit.addTask(orbit.tools, { title: "Open tasks", description: "Goal\n- [ ] part one" });
  orbit.addTask(orbit.video, { title: "Long", description: `${Array.from({ length: 13 }, (_, index) => `Line ${index + 1}`).join("\n")}\nDone when: x` });
  const one = ok(await run(["check", "TOOLS-2"], { ORBIT_ROLE: "" }));
  assert.match(one.stdout, /TOOLS-2.*Has notes/);
  assert.match(one.stdout, /## Notes/);
  assert.match(result(one), /1 of 1 card breaks the standard/);
  const fine = ok(await run(["check", "TOOLS-1"]));
  assert.match(fine.stdout, /TOOLS-1 follows the standard/);
  assert.match(result(fine), /0 of 1 card breaks/);
  const board = ok(await run(["check", "--project", "TOOLS"]));
  assert.match(board.stdout, /TOOLS-2/);
  assert.match(board.stdout, /TOOLS-3[\s\S]*checklist[\s\S]*Done when:|TOOLS-3[\s\S]*Done when:[\s\S]*checklist/);
  assert.ok(!board.stdout.includes("TOOLS-1 "), "a card that follows the standard is not listed");
  assert.ok(!board.stdout.includes("VID-1"));
  assert.match(result(board), /2 of 3 cards break the standard/);
  const everything = ok(await run(["check", "--all"]));
  assert.match(everything.stdout, /VID-1[\s\S]*14 lines/);
  assert.match(result(everything), /3 of 4 cards break the standard/);
  const json = JSON.parse(ok(await run(["check", "--all", "--json"])).stdout.split("\nRESULT:")[0]);
  assert.deepEqual(json.map((card: any) => card.identifier).sort(), ["TOOLS-2", "TOOLS-3", "VID-1"]);
  const notes = json.find((card: any) => card.identifier === "TOOLS-2");
  assert.deepEqual(notes.rules, ["notes"]);
  assert.equal(notes.title, "Has notes");
  assert.equal(notes.status, "Idea");
  assert.match(notes.problems[0], /## Notes/);
  assert.equal(orbit.writes().length, 0);
  assert.equal(log(), "");
  // Exactly one of a key, --project or --all.
  for (const args of [["check"], ["check", "TOOLS-1", "--all"], ["check", "--all", "--project", "TOOLS"], ["check", "TOOLS-1", "--project", "TOOLS"]]) {
    const bad = await run(args);
    assert.equal(bad.status, 2, bad.all);
    assert.match(bad.all, /exactly one of/);
  }
  refused(await run(["check", "TOOLS-99"]), /does not exist/);
  refused(await run(["check", "../../me"]), /card key/i);
});

test("check says when a board holds more cards than it read", async t => {
  const { orbit, run } = await fixture(t);
  for (let index = 0; index < 3; index++) orbit.addTask(orbit.tools, { description: "x" });
  assert.match(result(ok(await run(["check", "--project", "TOOLS"]))), /3 of 3 cards/);
});

test("next-lex also posts an @Lex comment and moves a Backlog or Todo card to In Progress, and Done or In Progress cards keep their status", async t => {
  const { orbit, run, log } = await fixture(t, kitBoardSettings, { kitBoard: true });
  const card = (status: string, description = "Text") => orbit.addTask(orbit.kit, { description, status_id: orbit.statusId(orbit.kit, status) });
  const backlog = card("Backlog"), todo = card("Todo"), working = card("In Progress"), done = card("Done");
  const set = ok(await run(["next-lex", "KIT-1", "choose the name"]));
  assert.equal(backlog.description, "Next step (Lex): choose the name\n\nText");
  assert.equal(orbit.statusOf(backlog), "In Progress");
  assert.deepEqual(backlog.assignee_ids, [member(orbit, "Lex")]);
  assert.deepEqual(orbit.comments[backlog.id].map((item: any) => item.body), ["@Lex choose the name"]);
  assert.match(set.stdout, /In Progress/);
  assert.match(log(), /card=KIT-1 action=next-lex fields=.*status_id/);
  assert.match(log(), /card=KIT-1 action=comment fields=body/);
  ok(await run(["next-lex", "KIT-2", "try it", "--comment", "Open the page.\nTell me if the button works.\nDesk thread: https://example.test/t/1"]));
  assert.equal(orbit.statusOf(todo), "In Progress");
  assert.equal(orbit.comments[todo.id][0].body, "@Lex Open the page.\nTell me if the button works.\nDesk thread: https://example.test/t/1");
  assert.match(todo.description, /^Next step \(Lex\): try it/);
  ok(await run(["next-lex", "KIT-3", "approve"]));
  assert.equal(orbit.statusOf(working), "In Progress");
  ok(await run(["next-lex", "KIT-4", "look again"]));
  assert.equal(orbit.statusOf(done), "Done", "a finished card is never reopened by a next step");
  assert.equal(orbit.comments[done.id][0].body, "@Lex look again");
  // A blank --comment falls back to the reason.
  const blank = card("Todo");
  ok(await run(["next-lex", "KIT-5", "decide", "--comment", " "]));
  assert.equal(orbit.comments[blank.id][0].body, "@Lex decide");
});

test("next-lex on a board without Backlog or Todo keeps the status and still posts the @Lex comment", async t => {
  const { orbit, run } = await fixture(t);
  const task = orbit.addTask(orbit.tools, { description: "Text" });
  ok(await run(["next-lex", "TOOLS-1", "record it"]));
  assert.equal(orbit.statusOf(task), "Idea");
  assert.deepEqual(orbit.comments[task.id].map((item: any) => item.body), ["@Lex record it"]);
});

test("a repeated next-lex posts no second identical @Lex comment, a new --comment posts a new one, and a half-done run is finished", async t => {
  const { orbit, run } = await fixture(t, kitBoardSettings, { kitBoard: true });
  const task = orbit.addTask(orbit.kit, { description: "Text", status_id: orbit.statusId(orbit.kit, "Todo") });
  ok(await run(["next-lex", "KIT-1", "decide", "--comment", "Pick A or B."]));
  const writes = orbit.writes().length;
  const again = ok(await run(["next-lex", "KIT-1", "decide", "--comment", "Pick A or B."]));
  assert.match(result(again), /already/);
  assert.equal(orbit.writes().length, writes, "nothing is sent twice");
  ok(await run(["next-lex", "KIT-1", "decide", "--comment", "Pick A, B or C."]));
  assert.deepEqual(orbit.comments[task.id].map((item: any) => item.body), ["@Lex Pick A or B.", "@Lex Pick A, B or C."]);
  // The card change went through but the comment did not: the run again adds only the comment.
  const half = orbit.addTask(orbit.kit, { description: "Text", status_id: orbit.statusId(orbit.kit, "Todo") });
  orbit.controls.writeAnswers.push("pass", { status: 500, code: "internal_error", detail: "down" });
  refused(await run(["next-lex", "KIT-2", "choose"]), /internal_error|refused/);
  assert.equal(half.description, "Next step (Lex): choose\n\nText");
  assert.equal(orbit.comments[half.id], undefined);
  ok(await run(["next-lex", "KIT-2", "choose"]));
  assert.deepEqual(orbit.comments[half.id].map((item: any) => item.body), ["@Lex choose"]);
});

test("next-lex --dry-run prints the card change and the comment and sends nothing; a helper cannot write one", async t => {
  const { orbit, run } = await fixture(t, kitBoardSettings, { kitBoard: true });
  const task = orbit.addTask(orbit.kit, { description: "Text", status_id: orbit.statusId(orbit.kit, "Backlog") });
  const dry = ok(await run(["next-lex", "KIT-1", "choose", "--comment", "Details here", "--dry-run"], { ORBIT_ROLE: "" }));
  assert.match(dry.stdout, /PATCH .*\/tasks\/KIT-1/);
  assert.match(dry.stdout, /Next step \(Lex\): choose/);
  assert.match(dry.stdout, new RegExp(orbit.statusId(orbit.kit, "In Progress")));
  assert.match(dry.stdout, /POST .*comments[\s\S]*"body": "@Lex Details here"/);
  assert.equal(orbit.writes().length, 0);
  assert.equal(orbit.statusOf(task), "Backlog");
  refused(await run(["next-lex", "KIT-1", "choose"], { ORBIT_ROLE: "" }), /only a lead/);
  assert.equal(orbit.writes().length, 0);
  // clear-next-lex stays as it was: no comment, no status change.
  ok(await run(["next-lex", "KIT-1", "choose"]));
  const before = orbit.comments[task.id].length;
  ok(await run(["clear-next-lex", "KIT-1"]));
  assert.equal(orbit.comments[task.id].length, before);
  assert.equal(orbit.statusOf(task), "In Progress");
});

// kit ticket tidy: a folder of description.txt, comments.txt and subtasks.json, applied to one card.
function tidyFolder(home: string, files: { description?: string; comments?: string; subtasks?: unknown }, name = "tidy") {
  const dir = join(home, name);
  mkdirSync(dir, { recursive: true });
  if (files.description !== undefined) writeFileSync(join(dir, "description.txt"), files.description);
  if (files.comments !== undefined) writeFileSync(join(dir, "comments.txt"), files.comments);
  if (files.subtasks !== undefined) writeFileSync(join(dir, "subtasks.json"), typeof files.subtasks === "string" ? files.subtasks : JSON.stringify(files.subtasks));
  return dir;
}
const partA = { title: "Part A", description: "Do A.\n\nDone when:\n- A works", assignee: "Lex" };
const partB = { title: "Part B", description: "Do B.\n\nDone when:\n- B works", assignee: null };

test("tidy posts the comments, then sets the description keeping the kit's lines, then creates the sub-tasks under the card", async t => {
  const { home, orbit, run, log } = await fixture(t);
  const card = orbit.addTask(orbit.tools, { title: "Big card", description: "Next step (Lex): choose\n\nBlocked by: TOOLS-9\n\nPlanned dates: start 2026-11-06, due 2026-11-07 (source: plan)\n\nA very long old text\n\n## Notes\n\n- old", due_start_at: "2026-11-05T23:00:00.000Z", due_at: "2026-11-07T22:59:00.000Z" });
  const dir = tidyFolder(home, {
    description: `${goodCard}\n`,
    comments: "2026-11-08 Moved from the description (2026-11-08): the long old text\n-----\n\n2026-11-08 Second event\nwith two lines\n-----\n",
    subtasks: [partA, partB],
  });
  const done = ok(await run(["tidy", "TOOLS-1", "--dir", dir]));
  assert.deepEqual(orbit.comments[card.id].map((item: any) => item.body), ["2026-11-08 Moved from the description (2026-11-08): the long old text", "2026-11-08 Second event\nwith two lines"]);
  assert.equal(card.description, `Next step (Lex): choose\n\nBlocked by: TOOLS-9\n\n${goodCard}\n\nPlanned dates: start 2026-11-06, due 2026-11-07 (source: plan)`);
  const subs = orbit.tasks.filter((task: any) => task.parent_task_id === card.id);
  assert.deepEqual(subs.map((task: any) => task.title), ["Part A", "Part B"]);
  assert.equal(subs[0].description, partA.description);
  assert.deepEqual(subs[0].assignee_ids, [member(orbit, "Lex")]);
  assert.deepEqual(subs[1].assignee_ids, []);
  assert.ok(subs.every((task: any) => task.project_id === orbit.tools.id));
  assert.match(done.stdout, /comment/i);
  assert.match(done.stdout, /description/i);
  assert.match(done.stdout, /sub-task/i);
  assert.deepEqual(warnings(done), [], "a clean description and clean sub-tasks make no warning");
  assert.match(result(done), /^RESULT: ok ticket tidy TOOLS-1: 2 comments, description set, 2 sub-tasks/);
  const order = lines(log()).map(line => /action=(\w[\w-]*)/.exec(line)![1]);
  assert.deepEqual(order, ["comment", "comment", "update", "create", "create"]);
});

test("tidy again does nothing and sends nothing; a rerun after a failure finishes the rest and never doubles anything", async t => {
  const { home, orbit, run } = await fixture(t);
  const card = orbit.addTask(orbit.tools, { description: "Old long text" });
  const dir = tidyFolder(home, { description: goodCard, comments: "2026-11-08 one\n-----\n2026-11-08 two", subtasks: [partA, partB] });
  // The first comment and the second one go through; the description write fails.
  orbit.controls.writeAnswers.push("pass", "pass", { status: 500, code: "internal_error", detail: "down" });
  refused(await run(["tidy", "TOOLS-1", "--dir", dir]), /internal_error|refused/);
  assert.equal(orbit.comments[card.id].length, 2);
  assert.equal(card.description, "Old long text");
  assert.equal(orbit.tasks.length, 1);
  // The description goes through and the first sub-task too; the second one fails.
  orbit.controls.writeAnswers.push("pass", "pass", { status: 500, code: "internal_error", detail: "down" });
  refused(await run(["tidy", "TOOLS-1", "--dir", dir]), /internal_error|refused/);
  assert.equal(orbit.comments[card.id].length, 2, "no comment is posted twice");
  assert.equal(card.description, goodCard);
  assert.deepEqual(orbit.tasks.filter((task: any) => task.parent_task_id === card.id).map((task: any) => task.title), ["Part A"]);
  const finished = ok(await run(["tidy", "TOOLS-1", "--dir", dir]));
  assert.equal(orbit.comments[card.id].length, 2);
  assert.deepEqual(orbit.tasks.filter((task: any) => task.parent_task_id === card.id).map((task: any) => task.title), ["Part A", "Part B"]);
  assert.match(result(finished), /^RESULT: ok ticket tidy TOOLS-1: 0 comments, description already set, 1 sub-task/);
  const writes = orbit.writes().length;
  const again = ok(await run(["tidy", "TOOLS-1", "--dir", dir]));
  assert.equal(orbit.writes().length, writes, "a third run sends nothing");
  assert.match(result(again), /nothing to do/);
});

test("tidy skips a comment whose exact text is already on the card and a sub-task whose title is already under it", async t => {
  const { home, orbit, run } = await fixture(t);
  const card = orbit.addTask(orbit.tools, { description: "Old" });
  orbit.addTask(orbit.tools, { title: "Part A", description: "Mine", parent_task_id: card.id });
  orbit.comments[card.id] = [{ id: "c1", body: "2026-11-08 one", author_service_account: { name: "fleet" }, created_at: "2026-11-08T10:00:00.000Z" }];
  const dir = tidyFolder(home, { comments: "2026-11-08 one\n-----\n2026-11-08 two\n-----\n2026-11-08 two", subtasks: [partA, partB] });
  const done = ok(await run(["tidy", "TOOLS-1", "--dir", dir]));
  assert.deepEqual(orbit.comments[card.id].map((item: any) => item.body), ["2026-11-08 one", "2026-11-08 two"]);
  assert.equal(card.description, "Old", "no description.txt leaves the description alone");
  assert.deepEqual(orbit.tasks.filter((task: any) => task.parent_task_id === card.id).map((task: any) => task.title), ["Part A", "Part B"]);
  assert.equal(orbit.tasks.find((task: any) => task.title === "Part A")!.description, "Mine", "the sub-task that was there is not rewritten");
  assert.match(result(done), /1 comment, description not in the folder, 1 sub-task/);
});

test("tidy --dry-run prints each step and sends nothing, also for a helper; a real run needs the lead role", async t => {
  const { home, orbit, run, log } = await fixture(t);
  const card = orbit.addTask(orbit.tools, { description: "Old long text" });
  const dir = tidyFolder(home, { description: goodCard, comments: "2026-11-08 one\n-----\n2026-11-08 two", subtasks: [partA, partB] });
  const dry = ok(await run(["tidy", "TOOLS-1", "--dir", dir, "--dry-run"], { ORBIT_ROLE: "" }));
  assert.match(dry.stdout, /Would post comment 1 of 2[\s\S]*2026-11-08 one/);
  assert.match(dry.stdout, /Would post comment 2 of 2/);
  assert.match(dry.stdout, /Would set the description[\s\S]*PATCH .*\/tasks\/TOOLS-1/);
  assert.match(dry.stdout, /Would create sub-task "Part A"[\s\S]*POST .*\/tasks/);
  assert.match(dry.stdout, /Would create sub-task "Part B"/);
  assert.match(dry.stdout, /Dry run: nothing was sent/);
  assert.match(result(dry), /dry run/);
  assert.equal(orbit.writes().length, 0);
  assert.equal(log(), "");
  assert.equal(card.description, "Old long text");
  const helper = refused(await run(["tidy", "TOOLS-1", "--dir", dir], { ORBIT_ROLE: "" }), /only a lead/);
  assert.equal(orbit.writes().length, 0);
  assert.ok(helper);
});

test("tidy checks the whole folder before it sends anything", async t => {
  const { home, orbit, run } = await fixture(t);
  orbit.addTask(orbit.tools, { description: "Old" });
  const noFolder = await run(["tidy", "TOOLS-1"]);
  assert.equal(noFolder.status, 2);
  assert.match(noFolder.all, /--dir/);
  refused(await run(["tidy", "TOOLS-1", "--dir", join(home, "missing")]), /folder/);
  refused(await run(["tidy", "TOOLS-1", "--dir", tidyFolder(home, {}, "empty")]), /description\.txt|comments\.txt|subtasks\.json/);
  const bad = async (name: string, files: Parameters<typeof tidyFolder>[1], pattern: RegExp) => refused(await run(["tidy", "TOOLS-1", "--dir", tidyFolder(home, files, name)]), pattern);
  await bad("json", { comments: "2026-11-08 one", subtasks: "{ not json" }, /subtasks\.json/);
  await bad("object", { comments: "2026-11-08 one", subtasks: { title: "x" } }, /subtasks\.json.*list/);
  await bad("title", { comments: "2026-11-08 one", subtasks: [{ description: "x" }] }, /title/);
  await bad("type", { comments: "2026-11-08 one", subtasks: [{ title: "x", assignee: 5 }] }, /assignee/);
  await bad("member", { comments: "2026-11-08 one", subtasks: [{ title: "x", assignee: "Nobody" }] }, /no member called Nobody/);
  await bad("blank", { description: "  \n" }, /blank/);
  await bad("twice", { comments: "2026-11-08 one", subtasks: [{ title: "x" }, { title: " x " }] }, /twice|same title/);
  assert.equal(orbit.writes().length, 0, "a folder with a problem leaves the card as it was");
  assert.equal(orbit.comments[orbit.tasks[0].id], undefined);
});

test("the card standard is in the kit docs in plain words, and the help, README and rulebook point to it", async t => {
  const standard = readFileSync(resolve("docs/orbit-card-standard.md"), "utf8");
  for (const heading of ["## Description", "## Comments", "## Sub-tasks", "## Fields", "## Never"]) assert.ok(standard.includes(heading), heading);
  for (const line of ["Done when:", "Next step (Lex):", "@Lex", "Moved from the description"]) assert.ok(standard.includes(line), line);
  assert.ok(!/SKILL\.md|~\/\.(claude|codex|agents)/.test(standard), "no skill text and no private path");
  assert.ok(!standard.includes("/home/"), "no machine path");
  for (const file of ["README.md", "docs/kitchen.md"]) assert.ok(readFileSync(resolve(file), "utf8").includes("docs/orbit-card-standard.md"), file);
  const { run } = await fixture(t);
  assert.match((await run(["--help"])).stdout, /docs\/orbit-card-standard\.md/);
});
