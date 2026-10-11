import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { changedLines, failingSteps, latestWorkflowRuns, summarizeRuns } from "../scripts/agents/ci-summary.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/agent-ci-status.json", import.meta.url), "utf8"));
const head = "abcdef0123456789";

const busyFixture: {
  workflows: { id: number; name: string; state: string }[];
  runs: {
    databaseId: number; workflowName: string; status: string; conclusion: string;
    headSha: string; createdAt: string; url: string;
  }[];
} = JSON.parse(readFileSync(new URL("./fixtures/agent-ci-status-busy.json", import.meta.url), "utf8"));

function fixtureGh(calls: string[][]) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === "workflow") return JSON.stringify(busyFixture.workflows);
    assert.equal(args[0], "run");
    assert.equal(args[1], "list");
    assert.equal(args[args.indexOf("--branch") + 1], "dev");
    const workflow = busyFixture.workflows.find((item) => String(item.id) === args[args.indexOf("--workflow") + 1]);
    const commit = args.includes("--commit") ? args[args.indexOf("--commit") + 1] : undefined;
    const runs = busyFixture.runs.filter((run) =>
      (!workflow || run.workflowName === workflow.name) && (!commit || run.headSha === commit));
    return JSON.stringify(runs.slice(0, Number(args[args.indexOf("--limit") + 1])));
  };
}

test("100 newer preview runs cannot hide the latest failed browser workflow", async () => {
  assert.equal(busyFixture.runs.length, 101);
  assert.equal(summarizeRuns(busyFixture.runs.slice(0, 100)).exitCode, 0);
  const calls: string[][] = [];
  const summary = summarizeRuns(await latestWorkflowRuns(fixtureGh(calls), "dev"));
  assert.deepEqual(summary.lines, [
    "Browser tests: failure 1234567 https://github.com/example/editor/actions/runs/102",
    "Deploy the dev preview: success abcdef0 https://github.com/example/editor/actions/runs/399",
  ]);
  assert.deepEqual(summary.failedRunIds, [102]);
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.pending, false);
  assert.deepEqual(calls, [
    ["workflow", "list", "--json", "id,name,state"],
    ...["1", "2"].map((id) => ["run", "list", "--workflow", id, "--branch", "dev", "--limit", "1",
      "--json", "workflowName,status,conclusion,headSha,createdAt,url,databaseId"]),
  ]);
});

test("each workflow query keeps the head filter when waiting", async () => {
  const calls: string[][] = [];
  const summary = summarizeRuns(await latestWorkflowRuns(fixtureGh(calls), "dev", head), head);
  assert.equal(summary.lines.length, 1);
  assert.equal(summary.exitCode, 0);
  for (const args of calls.slice(1)) assert.deepEqual(args.slice(-2), ["--commit", head]);
});

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
