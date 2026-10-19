#!/usr/bin/env node
// Usage: ci-summary.mjs <branch> [head-sha]; read-only CI status for ci-status.sh.
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { pathToFileURL } from "node:url";

const successful = new Set(["success", "neutral", "skipped"]);
const failed = (run) => run.status === "completed" && !successful.has(run.conclusion);

export function summarizeRuns(runs, head) {
  const latest = new Map();
  for (const run of runs) {
    if (head && run.headSha !== head) continue;
    const previous = latest.get(run.workflowName);
    if (!previous || run.createdAt > previous.createdAt ||
        (run.createdAt === previous.createdAt && run.databaseId > previous.databaseId)) {
      latest.set(run.workflowName, run);
    }
  }
  const selected = [...latest.values()].sort((a, b) => a.workflowName.localeCompare(b.workflowName));
  const failedRunIds = selected.filter(failed).map((run) => run.databaseId);
  return {
    lines: selected.map((run) => `${run.workflowName}: ${run.conclusion || run.status} ${run.headSha.slice(0, 7)} ${run.url}`),
    failedRunIds,
    exitCode: failedRunIds.length || !selected.length ? 1 : 0,
    pending: !selected.length || selected.some((run) => run.status !== "completed"),
  };
}

export function changedLines(lines, previous) {
  return lines.filter((line) => !previous.includes(line));
}

export function failingSteps(jobs) {
  return jobs.filter(failed).flatMap((job) => {
    const steps = job.steps.filter(failed);
    return steps.length ? steps.map((step) => `${job.name}: ${step.name} (${step.conclusion})`) :
      [`${job.name}: ${job.conclusion} (no failed step recorded)`];
  });
}

/** Up to ten failure lines with source and first error, before the ordinary log tail. */
export function failingTests(log) {
  // Remove gh columns and node:test's t.diagnostic() wrapper around child TAP.
  const lines = stripVTControlCharacters(log).split(/\r?\n/)
    .map(line => line.replace(/^.*?\b\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "").replace(/^\s*#(?: |$)/, ""));
  const playwright = /^\s*\d+\)\s+.*\.spec\.[cm]?[jt]sx?:\d+/;
  const detailedPlaywright = lines.some(line => playwright.test(line));
  const detailedSpec = lines.some(line => /^\s*test at /.test(line));
  const marker = line => /^\s*(?:not ok\s+\d+\b|✖\s+(?!failing tests:))/.test(line) ||
    (detailedPlaywright ? playwright.test(line) : /^\s*✘\s+/.test(line));
  const failures = new Map();
  let source;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*test at /.test(lines[i])) source = lines[i].trim().slice("test at ".length);
    if (!marker(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !marker(lines[end]) && !/^\s*test at /.test(lines[end])) end++;
    const block = lines.slice(i + 1, end);
    const title = lines[i].trim().replace(/ \([\d.]+m?s\)$/, "")
      .replace(/^\d+\)\s+/, "✘ ");
    // The Node spec summary supplies source locations missing from progress lines.
    if (/^✖/.test(title) && detailedSpec && !source) { i = end - 1; continue; }
    const location = block.find(line => /^\s*location:/.test(line))?.trim().replace(/^location:\s*['"]?|['"]$/g, "") ||
      (/^✖/.test(title) ? source : undefined);
    let error = block.findIndex(line => /^\s*(?:error:|\w*Error(?:\s*\[.*?\])?:)/.test(line));
    let message = "";
    if (error >= 0) {
      message = block[error].trim().replace(/^error:\s*/, "");
      if (/^[|>][-+]?\s*$/.test(message)) {
        while (++error < block.length && !block[error].trim()) { /* First error line. */ }
        message = block[error]?.trim() || "";
      }
    }
    const detail = [title, location, message].filter(Boolean).join(" — ");
    const key = `${title}\0${location || ""}`;
    const previous = failures.get(key);
    if (!previous || detail.length > previous.length) failures.set(key, detail);
    i = end - 1;
  }
  return [...failures.values()].slice(0, 10);
}

export async function latestWorkflowRuns(gh, branch, head) {
  const workflows = JSON.parse(await gh(["workflow", "list", "--json", "id,name,state"]));
  const runs = [];
  for (const workflow of workflows) {
    if (workflow.state !== "active") continue;
    const args = ["run", "list", "--workflow", String(workflow.id), "--branch", branch, "--limit", "1",
      "--json", "workflowName,status,conclusion,headSha,createdAt,url,databaseId"];
    if (head) args.push("--commit", head);
    runs.push(...JSON.parse(await gh(args)));
  }
  return runs;
}

const execute = promisify(execFile);
async function main(branch, head) {
  const deadline = Date.now() + 20 * 60 * 1000;
  const gh = async (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("CI wait timed out after 20 min");
    const { stdout } = await execute("gh", args, {
      timeout: Math.min(60_000, remaining), maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GH_PAGER: "cat", NO_COLOR: "1" },
    });
    return stdout;
  };
  let previous = [];
  const reported = new Set();
  while (Date.now() < deadline) {
    const summary = summarizeRuns(await latestWorkflowRuns(gh, branch, head), head);
    for (const line of changedLines(summary.lines, previous)) console.log(line);
    previous = summary.lines;
    for (const id of summary.failedRunIds) {
      if (reported.has(id)) continue;
      reported.add(id);
      const { jobs } = JSON.parse(await gh(["run", "view", String(id), "--json", "jobs"]));
      for (const line of failingSteps(jobs)) console.log(line);
      const log = await gh(["run", "view", String(id), "--log-failed"]);
      for (const line of failingTests(log)) console.log(line);
      console.log(log.trimEnd().split(/\r?\n/).slice(-20).join("\n"));
    }
    if (!head || !summary.pending) {
      if (!summary.lines.length) console.log(`problem: no CI runs on ${branch}`);
      return summary.exitCode;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Math.max(0, deadline - Date.now()))));
  }
  console.log(`problem: CI wait timed out after 20 min on ${branch} ${head.slice(0, 7)}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length < 1 || args.length > 2) {
    console.error("Usage: ci-summary.mjs <branch> [head-sha]");
    process.exitCode = 2;
  } else {
    try { process.exitCode = await main(...args); }
    catch (error) { console.error(`problem: CI status\n${error.message}`); process.exitCode = 1; }
  }
}
