import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

// status-nudge: the opt-in UserPromptSubmit hook (a project turns it on in its own hook settings; kit init never
// writes it) and status-nudge-check.mjs, the transcript scan for the weekly learning review.
const hooks = resolve("hooks");
const check = resolve("status-nudge-check.mjs");

function hook(payload: unknown, name = "status-nudge") {
  return spawnSync("/bin/bash", [join(hooks, "run.sh"), name], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: kitEnv(),
  });
}
const prompt = (text: string) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: text });
const finished = (state: string, title = "Fix the login form", body = "All done.") =>
  `Delegated task node:delegated-task:provider-continuation%3Amessage%3Athread%3Aabc%3A1 (${title}) [${state}]:\n${body}`;

test("status-nudge adds the two-line status reminder for a finished, failed or interrupted helper", () => {
  for (const state of ["completed", "failed", "interrupted"]) {
    const output = hook(prompt(finished(state)));
    assert.equal(output.status, 0, output.stderr);
    const parsed = JSON.parse(output.stdout);
    assert.deepEqual(Object.keys(parsed), ["hookSpecificOutput"], "context only: no decision, no continue flag");
    assert.equal(parsed.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const context: string = parsed.hookSpecificOutput.additionalContext;
    assert.match(context, /two-line status/);
    assert.match(context, /Done:/);
    assert.match(context, /Running:/);
    assert.match(context, /Next:/);
    assert.match(context, /If Lex must answer or do something, say that first/);
    assert.doesNotMatch(output.stdout, /"decision"|"block"|"continue"|"stopReason"/);
  }
});

test("status-nudge nudges once for several helper results queued into one turn", () => {
  const output = hook(prompt(`${finished("completed", "One")}\n\n${finished("failed", "Two", "It broke.")}`));
  assert.equal(output.status, 0);
  assert.equal(JSON.parse(output.stdout).hookSpecificOutput.additionalContext.match(/two-line status/g)?.length, 1);
});

test("status-nudge stays silent for every other prompt and never blocks", () => {
  for (const payload of [
    prompt("Lex: how are things?"),
    prompt(""),
    prompt("Please read this:\n" + finished("completed")),
    prompt("delegated task x (y) [completed]:\nlowercase"),
    prompt("Delegated task x (y) is still running"),
    prompt("Delegated task x (y) [cancelled]:\nnot a finished state"),
    prompt("Delegated tasks done [completed]"),
    { hook_event_name: "UserPromptSubmit", session_id: "s1" },
    { hook_event_name: "UserPromptSubmit", prompt: { text: finished("completed") } },
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: finished("completed") } },
    { hook_event_name: "Stop", prompt: finished("completed") },
    "not json",
    "",
  ]) {
    const output = hook(payload);
    assert.equal(output.status, 0, `${JSON.stringify(payload)}: ${output.stderr}`);
    assert.equal(output.stdout, "", JSON.stringify(payload));
  }
});

test("status-nudge exits 0 even when jq is missing", () => {
  const output = spawnSync("/bin/bash", [join(hooks, "status-nudge.sh")], {
    input: JSON.stringify(prompt(finished("completed"))), encoding: "utf8", env: { ...kitEnv(), PATH: "/nonexistent" },
  });
  assert.equal(output.status, 0);
  assert.equal(output.stdout, "");
});

// A fixture transcript, one JSON line per entry, as Claude writes them.
function transcript(t: TestContext, entries: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "status-nudge-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}
let counter = 0;
const stamp = () => `2026-11-11T10:${String(counter++).padStart(2, "0")}:00.000Z`;
const user = (content: unknown, extra: object = {}) => ({ type: "user", timestamp: stamp(), message: { role: "user", content }, ...extra });
const reply = (...blocks: unknown[]) => ({ type: "assistant", timestamp: stamp(), message: { role: "assistant", content: blocks } });
const text = (value: string) => ({ type: "text", text: value });
const toolUse = { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } };
const toolResult = { type: "user", timestamp: stamp(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } };
function scan(path: string, ...args: string[]) {
  return spawnSync("node", [check, path, ...args], { encoding: "utf8", env: kitEnv() });
}
const goodStatus = "Done: login form fixed.\nRunning: nothing.\nNext: you test it.";

test("status-nudge-check lists a reply after a finished helper that has no status", (t) => {
  const path = transcript(t, [
    user("Start the fix"), reply(text("Sent a helper.")),
    user(finished("completed", "Fix the login form")), reply(text("The helper fixed the login form. Tests pass.")),
  ]);
  const output = scan(path);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /line 3\b/);
  assert.match(output.stdout, /Fix the login form/);
  assert.match(output.stdout, /\[completed\]/);
  assert.match(output.stdout, /The helper fixed the login form/);
  assert.match(output.stdout, /RESULT: ok status check: 1 reply after a finished helper, 1 without the two-line status\n$/);
});

test("status-nudge-check passes replies that end with done, running and next", (t) => {
  const path = transcript(t, [
    user(finished("completed")), reply(text(`Fixed.\n\n${goodStatus}`)),
    user(finished("failed", "Build the card")), reply(text("**Done:** nothing, helper failed.\n**Running:** none.\n**Next:** retry.")),
    user(finished("interrupted", "Review")), reply(text("- Done: x\n- running: y\n- next: z")),
  ]);
  const output = scan(path);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /RESULT: ok status check: 3 replies after a finished helper, 0 without the two-line status\n$/);
  assert.doesNotMatch(output.stdout, /line \d/);
});

test("status-nudge-check judges the last text of the turn, across tool calls", (t) => {
  const path = transcript(t, [
    user(finished("completed", "First")),
    reply(text("Checking the result."), toolUse), toolResult, reply(text(`Merged.\n${goodStatus}`)),
    user(finished("completed", "Second")),
    reply(text(`Done: a\nRunning: b\nNext: c`), toolUse), toolResult, reply(text("Merged it, all fine.")),
  ]);
  const output = scan(path);
  assert.match(output.stdout, /1 without/);
  assert.match(output.stdout, /Second/);
  assert.doesNotMatch(output.stdout, /First/);
});

test("status-nudge-check needs all three labels near the end of the reply", (t) => {
  const path = transcript(t, [
    user(finished("completed", "Only two")), reply(text("Done: x\nNext: y")),
    user(finished("completed", "Too early")), reply(text(`${goodStatus}\n\n${"A long closing note.\n".repeat(12)}`)),
    user(finished("completed", "Prose")), reply(text("I am done. The next step is yours, and nothing is running.")),
  ]);
  const output = scan(path);
  assert.match(output.stdout, /3 without/);
});

test("status-nudge-check reads string and block content, skips side chains, queue entries and plain turns", (t) => {
  const path = transcript(t, [
    { type: "queue-operation", operation: "enqueue", content: finished("completed", "Queued copy") },
    user([text(finished("completed", "Block form"))]), reply(text("No status here.")),
    user(finished("completed", "Side chain"), { isSidechain: true }), { ...reply(text("Sub work.")), isSidechain: true },
    user("Lex: thanks"), reply(text("You are welcome.")),
    user(finished("completed", "No reply at all")),
  ]);
  const output = scan(path);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /Block form/);
  assert.doesNotMatch(output.stdout, /Queued copy|Side chain|No reply at all|welcome/);
  assert.match(output.stdout, /RESULT: ok status check: 1 reply after a finished helper, 1 without/);
});

test("status-nudge-check ignores meta entries and keeps the turn open for the reply", (t) => {
  const path = transcript(t, [
    user(finished("completed", "Meta between")),
    user("<system-reminder>\nA reminder the harness added.\n</system-reminder>", { isMeta: true }),
    reply(text(goodStatus)),
  ]);
  const output = scan(path);
  assert.match(output.stdout, /RESULT: ok status check: 1 reply after a finished helper, 0 without the two-line status\n$/);
});

test("status-nudge-check does not take hyphenated words for labels", (t) => {
  const path = transcript(t, [
    user(finished("completed", "Words")), reply(text("The done-ness check, a next-step note and a running-total job.")),
    user(finished("completed", "Dashes")), reply(text("Done - fixed\nRunning - none\nNext \u2014 you test it")),
  ]);
  const output = scan(path);
  assert.match(output.stdout, /1 without/);
  assert.match(output.stdout, /Words/);
  assert.doesNotMatch(output.stdout, /Dashes/);
  const tight = transcript(t, [user(finished("completed", "Tight")), reply(text("Done\u2014fixed\nRunning\u2014none\nNext\u2014you test it"))]);
  assert.match(scan(tight).stdout, /1 without[\s\S]*Tight|Tight[\s\S]*1 without/);
});

test("status-nudge-check does not judge a reply the person interrupted", (t) => {
  const path = transcript(t, [
    user(finished("completed", "Cut")), reply(text("Working on it")),
    user([text("[Request interrupted by user]")]),
    user("carry on"), reply(text("Fine.")),
  ]);
  assert.match(scan(path).stdout, /RESULT: ok status check: 0 replies after a finished helper, 0 without the two-line status\n$/);
});

// The hook and the checker open a helper on the same first lines.
test("status-nudge and status-nudge-check agree on which prompts are a finished helper", (t) => {
  const cases: [string, boolean][] = [
    ["Delegated task node:x (Fix it) [completed]:\nok", true],
    ["Delegated task node:x [failed]:\nit broke", true],
    ["Delegated task node:x (Title (with parens)) [interrupted]:", true],
    ["\n  Delegated task node:x (Leading blank) [completed]:\nok", true],
    ["Delegated task node:x went fine [completed]", false],
    ["Delegated task node:x (Fix it) [cancelled]:", false],
    ["Delegated task node:x (Fix it) is running", false],
    ["Please see Delegated task node:x (Fix it) [completed]:", false],
  ];
  for (const [first, expected] of cases) {
    const nudged = hook(prompt(first)).stdout !== "";
    const path = transcript(t, [user(first), reply(text("Plain reply."))]);
    const counted = /RESULT: ok status check: 1 reply/.test(scan(path).stdout);
    assert.equal(nudged, expected, `hook: ${JSON.stringify(first)}`);
    assert.equal(counted, expected, `check: ${JSON.stringify(first)}`);
  }
});

test("status-nudge-check says so when no helper finished, tolerates a bad line, and fails on a missing file", (t) => {
  const path = transcript(t, [user("Hello"), reply(text("Hi."))]);
  const empty = scan(path);
  assert.equal(empty.status, 0);
  assert.match(empty.stdout, /RESULT: ok status check: 0 replies after a finished helper, 0 without the two-line status\n$/);

  const messy = join(mkdtempSync(join(tmpdir(), "status-nudge-")), "bad.jsonl");
  t.after(() => rmSync(join(messy, ".."), { recursive: true, force: true }));
  writeFileSync(messy, `not json\n${JSON.stringify(user(finished("completed")))}\n${JSON.stringify(reply(text("Plain.")))}\n`);
  const bad = scan(messy);
  assert.equal(bad.status, 0);
  assert.match(bad.stdout, /1 without/);
  assert.match(bad.stdout, /1 unreadable line skipped/);

  const missing = scan(join(tmpdir(), "no-such-transcript.jsonl"));
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /RESULT: fail status check: cannot read /);
  const none = spawnSync("node", [check], { encoding: "utf8", env: kitEnv() });
  assert.equal(none.status, 2);
  assert.match(none.stdout, /Usage: /);
  assert.match(none.stdout, /RESULT: fail /);
});
