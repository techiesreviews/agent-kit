import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { changedLines, failingSteps, summarizeRuns } from "../scripts/agents/ci-summary.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-ci-status.json", import.meta.url), "utf8"));
const head = "abcdef0123456789";

test("latest per workflow is selected by creation time, regardless of input order", () => {
  const summary = summarizeRuns([...fixture].reverse());
  assert.deepEqual(summary.lines, [
    "Browser tests: failure 1234567 https://github.com/example/editor/actions/runs/102",
    "Deploy the dev preview: in_progress abcdef0 https://github.com/example/editor/actions/runs/103",
  ]);
  assert.deepEqual(summary.failedRunIds, [102]);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.pending, true);
});

test("head waiting ignores failures and successes on other commits", () => {
  const summary = summarizeRuns(fixture, head);
  assert.equal(summary.lines.length, 1);
  assert.deepEqual(summary.failedRunIds, []);
  assert.equal(summary.exitCode, 0);
  assert.equal(summary.pending, true);
  assert.equal(summarizeRuns(fixture, "missing").pending, true);
});

test("empty runs cannot report a successful CI check", () => {
  const summary = summarizeRuns([]);
  assert.deepEqual(summary.lines, []);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.pending, true);
});

test("a completed head run ends the wait; a newer success replaces an older failure", () => {
  const success = { ...fixture[0], databaseId: 104, status: "completed", conclusion: "success" };
  const summary = summarizeRuns([success, ...fixture], head);
  assert.equal(summary.pending, false);
  assert.equal(summary.exitCode, 0);
  assert.deepEqual(summary.failedRunIds, []);
  assert.match(summary.lines[0], /: success abcdef0 /);
});

test("only unsuccessful completed conclusions fail", () => {
  for (const conclusion of ["success", "neutral", "skipped"]) {
    assert.equal(summarizeRuns([{ ...fixture[0], status: "completed", conclusion }]).exitCode, 0);
  }
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale", null]) {
    assert.equal(summarizeRuns([{ ...fixture[0], status: "completed", conclusion }]).exitCode, 1);
  }
  assert.equal(summarizeRuns([{ ...fixture[0], status: "queued", conclusion: "" }]).exitCode, 0);
});

test("polling prints new and changed lines only", () => {
  const previous = summarizeRuns(fixture).lines;
  assert.deepEqual(changedLines(previous, previous), []);
  const next = summarizeRuns([{ ...fixture[0], status: "completed", conclusion: "success" }, ...fixture.slice(1)]).lines;
  assert.deepEqual(changedLines(next, previous), [next[1]]);
});

test("failed job summaries name failed steps and ignore successful or skipped steps", () => {
  assert.deepEqual(failingSteps([
    { name: "deploy", status: "completed", conclusion: "failure", steps: [
      { name: "Check", status: "completed", conclusion: "success" },
      { name: "Byte budget", status: "completed", conclusion: "failure" },
      { name: "Deploy", status: "completed", conclusion: "skipped" },
    ] },
    { name: "smoke", status: "completed", conclusion: "success", steps: [] },
    { name: "build", status: "completed", conclusion: "timed_out", steps: [] },
  ]), ["deploy: Byte budget (failure)", "build: timed_out (no failed step recorded)"]);
});
