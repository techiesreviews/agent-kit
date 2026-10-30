import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { changedLines, failingSteps, latestWorkflowRuns, summarizeRuns } from "../ci-summary.mjs";

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

test("ci-summary asks gh about origin's GitHub repo, not the upstream a site made from the starter also has", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ci-summary-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  // Each call records GH_REPO, GH_PAGER and NO_COLOR; one green workflow run.
  writeFileSync(join(directory, "gh"), `#!/bin/bash
printf '%s %s %s\\n' "\${GH_REPO:--}" "\${GH_PAGER:--}" "\${NO_COLOR:--}" >> "${join(directory, "calls")}"
case "$1 $2" in
  'workflow list') echo '[{"id":1,"name":"Checks","state":"active"}]' ;;
  'run list') echo '[{"databaseId":10,"workflowName":"Checks","status":"completed","conclusion":"success","headSha":"${sha}","createdAt":"2026-10-30","url":"https://example.test/run/10"}]' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(join(directory, "gh"), 0o755);
  const project = join(directory, "project");
  for (const args of [["init", "-q", project], ["-C", project, "remote", "add", "origin", "git@github.com:acme/site.git"],
    ["-C", project, "remote", "add", "upstream", "https://github.com/acme/starter.git"]]) assert.equal(spawnSync("git", args).status, 0);
  const { KIT_ROOT: _root, ...inherited } = process.env;
  const result = spawnSync(process.execPath, [resolve("ci-summary.mjs"), "dev", sha], { cwd: project, encoding: "utf8", timeout: 10_000,
    env: { ...inherited, PATH: `${directory}:${process.env.PATH}`, GH_REPO: "acme/starter" } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Checks: success abcdef0/);
  const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n");
  assert.equal(calls.length, 2);
  assert.deepEqual(new Set(calls), new Set(["acme/site cat 1"]));
});
