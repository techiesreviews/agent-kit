import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { reviewBrief, reviewComplete } from "../scripts/agents/review-brief.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { unitSummary } from "../scripts/agents/unit-summary.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { agentInvocation, buildContract, claudeResult, codexModelMatches, inferCli, parseAgentArgs } from "../scripts/agents/agent-run.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { durationMilliseconds } from "../scripts/agents/sol-run.mjs";

test("agent options preserve defaults, infer Claude aliases, and respect explicit overrides", () => {
  for (const kind of ["build", "review"]) {
    assert.deepEqual(parseAgentArgs([kind, "/work tree", "brief.md"]), {
      kind, worktree: "/work tree", brief: "brief.md", model: "gpt-6.1-sol", cli: "codex", effort: "medium",
    });
  }
  for (const model of ["claude-opus-5-5", "opus", "sonnet", "haiku", "fable"]) assert.equal(inferCli(model), "claude");
  for (const model of ["gpt-5.5", "gpt-6.1-sol", "custom-model"]) assert.equal(inferCli(model), "codex");
  assert.equal(parseAgentArgs(["build", ".", "brief", "--model", "opus"]).cli, "claude");
  assert.equal(parseAgentArgs(["build", ".", "brief"], { ASE_BUILD_MODEL: "haiku", ASE_REVIEW_MODEL: "gpt-5.5" }).cli, "claude");
  assert.equal(parseAgentArgs(["review", ".", "brief"], { ASE_BUILD_MODEL: "haiku", ASE_REVIEW_MODEL: "gpt-5.5" }).model, "gpt-5.5");
  const options = parseAgentArgs(["review", ".", "brief", "--cli", "codex", "--model", "gpt-5.5", "--effort", "high"], {
    ASE_AGENT_CLI: "claude", ASE_REVIEW_MODEL: "haiku",
  });
  assert.equal(options.cli, "codex");
  assert.equal(options.model, "gpt-5.5");
  assert.equal(options.effort, "high");
  assert.equal(parseAgentArgs(["build", ".", "brief"], { ASE_AGENT_CLI: "claude" }).cli, "claude");
  assert.equal(parseAgentArgs(["build", ".", "brief", "--effort", "ultra"]).effort, "ultra");
  for (const flags of [["--model"], ["--cli", "gemini"], ["--effort", "bad level"], ["--unknown", "x"], ["--model", "a", "--model", "b"]]) {
    assert.throws(() => parseAgentArgs(["build", ".", "brief", ...flags]));
  }
  assert.throws(() => parseAgentArgs(["unknown", ".", "brief"]), /Usage/);
  assert.equal(durationMilliseconds("90m"), 5_400_000);
  for (const duration of ["0", "-1", "1.5h", "2147484s"]) assert.throws(() => durationMilliseconds(duration));
});

test("Codex adapter grants build workspace and Git access, keeps review read-only, and trusts vetted hooks", () => {
  for (const kind of ["build", "review"]) {
    const options = parseAgentArgs([kind, "/work tree", "brief", "--model", "gpt-5.5", "--effort", "low"]);
    const call = agentInvocation(options, "/shared git", "/out file.md");
    assert.equal(call.command, "codex");
    assert.deepEqual(call.args, ["exec", "-m", "gpt-5.5", "-c", "model_reasoning_effort=low", "-s", kind === "build" ? "workspace-write" : "read-only",
      ...(kind === "build" ? ["-c", "sandbox_workspace_write.network_access=true", "--add-dir", "/shared git"] : []),
      "--dangerously-bypass-hook-trust", "-C", "/work tree", "-o", "/out file.md", "-"]);
    assert.equal(call.finish("", "model: gpt-5.5\n"), null);
    assert.throws(() => call.finish("", "model: gpt-6.1-sol\n"), /requested model/);
  }
});

test("Claude adapter uses edit permissions for build, restricted review tools, JSON and requested effort", () => {
  for (const kind of ["build", "review"]) {
    const options = parseAgentArgs([kind, "/work tree", "brief", "--model", "claude-opus-5-5", "--effort", "low"]);
    const call = agentInvocation(options, "/shared git", "/out file.md");
    assert.equal(call.command, "claude");
    assert.equal(call.capture, true);
    assert.deepEqual(call.args, ["-p", "--model", "claude-opus-5-5", "--effort", "low", "--permission-mode", kind === "build" ? "acceptEdits" : "default",
      ...(kind === "build" ? ["--add-dir", "/shared git"] : ["--allowedTools", "Read Grep Glob Bash(git diff:*) Bash(git log:*) Bash(git show:*)", "--tools", "Read,Grep,Glob,Bash"]),
      "--output-format", "json"]);
    assert.equal(call.finish(JSON.stringify({ modelUsage: { "claude-opus-5-5": {} }, result: "report" })), "report");
  }
});

test("model verification rejects missing metadata, fallback models and unsuccessful Claude results", () => {
  assert.equal(codexModelMatches("\tmodel: gpt-5.5\n", "gpt-5.5"), true);
  assert.equal(codexModelMatches("model: gpt-5.5\r\n", "gpt-5.5"), true);
  for (const log of ["", "model: gpt-5.5-extra\n", "model: gpt-5.5\nmodel: another\n"]) assert.equal(codexModelMatches(log, "gpt-5.5"), false);
  const json = (models: string[], extra = {}) => JSON.stringify({ result: "report", modelUsage: Object.fromEntries(models.map(model => [model, {}])), ...extra });
  assert.equal(claudeResult(json(["claude-haiku-5-5"]), "claude-haiku-5-5"), "report");
  assert.equal(claudeResult(json(["claude-haiku-5-5-20261001"]), "claude-haiku-5-5"), "report");
  assert.equal(claudeResult(json(["claude-opus-5-5"]), "opus"), "report");
  assert.equal(claudeResult(JSON.stringify({ model: "claude-haiku-5-5", result: "report" }), "claude-haiku-5-5"), "report");
  for (const stdout of ["not JSON", json([]), json(["claude-sonnet-5-5"]), json(["claude-haiku-5-5", "claude-opus-5-5"]),
    json(["claude-haiku-5-5"], { is_error: true }), json(["claude-haiku-5-5"], { subtype: "error_max_turns" }), json(["claude-haiku-5-5"], { result: "" })]) {
    assert.throws(() => claudeResult(stdout, "claude-haiku-5-5"));
  }
});

test("both adapters run through the shared shell entry and compatibility wrappers using fake CLIs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-agent-adapters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wt = join(dir, "work tree"), bin = join(dir, "bin"), brief = join(dir, "brief.md");
  mkdirSync(wt); mkdirSync(bin);
  assert.equal(spawnSync("git", ["init", wt]).status, 0);
  writeFileSync(brief, "tiny brief\n");
  const fake = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
writeFileSync(process.env.ASE_FAKE_CAPTURE, JSON.stringify({ args, input, cwd: process.cwd() }));
const model = process.env.ASE_FAKE_MODEL || args[args.indexOf(basename(process.argv[1]) === "codex" ? "-m" : "--model") + 1];
const report = process.env.ASE_FAKE_REPORT || "REVIEW_STATUS: complete\\nDefects: none\\n";
if (basename(process.argv[1]) === "codex") {
  console.error("model: " + model);
  writeFileSync(args[args.indexOf("-o") + 1], report);
} else {
  console.error("a warning on stderr");
  console.log(JSON.stringify({ result: report, modelUsage: { [model]: {} }, subtype: "success" }));
}
process.exitCode = Number(process.env.ASE_FAKE_EXIT || 0);
`;
  // A local package type makes these extensionless fixtures ESM under Node 24.
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  for (const cli of ["codex", "claude"]) { writeFileSync(join(bin, cli), fake); chmodSync(join(bin, cli), 0o755); }
  const capture = join(dir, "capture.json");
  const invoke = (script: string, args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync("bash", [resolve(`scripts/agents/${script}`), ...args], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASE_FAKE_CAPTURE: capture, ASE_AGENT_CLI: "", ASE_BUILD_MODEL: "", ASE_REVIEW_MODEL: "", ASE_AGENT_TIMEOUT: "10s", ...overrides },
  });
  for (const model of ["gpt-5.5", "claude-haiku-5-5"]) for (const kind of ["build", "review"]) {
    const result = invoke("agent.sh", [kind, wt, brief, "--model", model, "--effort", "low"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REVIEW_STATUS: complete/);
    const recorded: { args: string[]; input: string; cwd: string } = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(recorded.cwd, wt);
    assert.equal(recorded.input, "tiny brief\n" + (kind === "build" ? buildContract : ""));
    const out = join(wt, ".scratch/agent", kind);
    assert.match(readFileSync(join(out, "out.md"), "utf8"), /Defects: none/);
    assert.match(readFileSync(join(out, "run.log"), "utf8"), new RegExp(model));
    assert.deepEqual(readFileSync(brief, "utf8"), "tiny brief\n");
  }
  assert.equal(invoke("sol.sh", [wt, brief, "high"], { ASE_BUILD_MODEL: "claude-opus-5-5" }).status, 0);
  const reviewDir = join(dir, "review");
  assert.equal(invoke("review.sh", [wt, brief, reviewDir], { ASE_REVIEW_MODEL: "claude-haiku-5-5" }).status, 0);
  assert.match(readFileSync(join(reviewDir, "result.md"), "utf8"), /REVIEW_STATUS: complete/);
  assert.match(readFileSync(join(reviewDir, "run.log"), "utf8"), /claude-haiku-5-5/);
  const incomplete = invoke("review.sh", [wt, brief, reviewDir], { ASE_FAKE_REPORT: "incomplete" });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /lacks REVIEW_STATUS/);
  for (const model of ["gpt-5.5", "claude-haiku-5-5"]) {
    const mismatch = invoke("agent.sh", ["review", wt, brief, "--model", model], { ASE_FAKE_MODEL: "different-model" });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /requested model/);
    assert.equal(invoke("agent.sh", ["review", wt, brief, "--model", model], { ASE_FAKE_EXIT: "7" }).status, 7);
  }
  const invalid = invoke("agent.sh", ["build", wt, join(dir, "missing.md")]);
  assert.equal(invalid.status, 2);
  assert.equal(existsSync(join(wt, ".scratch/agent/build/brief.md")), false);
});

test("review completion accepts blank lines, BOM, CRLF and a leading markdown fence", () => {
  for (const prefix of ["", "\n\n", "\uFEFF", "\uFEFF\r\n \r\n", "\n```markdown\n\n", "~~~text\r\n"]) {
    assert.equal(reviewComplete(`${prefix}REVIEW_STATUS: complete\r\nDefects: none\n`), true, JSON.stringify(prefix));
  }
  for (const text of ["", "\n", "REVIEW_STATUS: incomplete", "REVIEW_STATUS: complete maybe", "Preamble\nREVIEW_STATUS: complete", "Defects: none\nREVIEW_STATUS: complete", "```\nREVIEW_STATUS: partial\n```", "```\n```\nREVIEW_STATUS: complete"]) {
    assert.equal(reviewComplete(text), false, text);
  }
});

test("review completion accepts longer fences and whitespace before info strings", () => {
  for (const fence of ["``` markdown", "````markdown", "~~~ text", "````", "~~~~", "~~~~ text", "```\tmarkdown", "```markdown extra", "~~~text `extra`", "```text/plain"]) {
    assert.equal(reviewComplete(`${fence}\nREVIEW_STATUS: complete\n`), true, fence);
  }
  for (const fence of ["``markdown", "~~ text", "```markdown `extra`"]) {
    assert.equal(reviewComplete(`${fence}\nREVIEW_STATUS: complete\n`), false, fence);
  }
});

test("slice brief resolves fixture ticket links and states both axes and validation contract", () => {
  const path = "tests/fixtures/agent-scripts/tickets/01-slice.md";
  const brief = reviewBrief(path, readFileSync(path, "utf8"));
  assert.match(brief, /git diff origin\/dev\.\.\.HEAD/);
  assert.ok(brief.includes(path));
  assert.match(brief, /tests\/fixtures\/agent-scripts\/spec\.md/);
  assert.match(brief, /tests\/fixtures\/agent-scripts\/02-decision\.md/);
  assert.match(brief, /docs\/work\/example\/spec\.md/);
  assert.match(brief, /docs\/work\/shared\/spec\.md/);
  assert.doesNotMatch(brief, /https:\/\/example.com/);
  assert.match(brief, /Standards axis: apply CODING_STANDARDS\.md/);
  assert.match(brief, /author already ran check\/test\/lint and the touched specs; do not report inability to run tests/);
  assert.match(brief, /commit:path:line, severity, evidence, and fix/);
  assert.match(brief, /very first line must be REVIEW_STATUS: complete/);
  assert.match(reviewBrief(path, "", "release/next"), /git diff release\/next\.\.\.HEAD/);
  assert.throws(() => reviewBrief(path, "", "dev; rm -rf /"), /Invalid base ref/);
  assert.throws(() => reviewBrief(path, "", "--output=x"), /Invalid base ref/);
  const result = spawnSync("bash", ["scripts/agents/review-brief.sh", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, brief);
  assert.equal(spawnSync("bash", ["scripts/agents/review-brief.sh"], { encoding: "utf8" }).status, 2);
});

test("unit summary prints counts and bounded error lines for each failure", () => {
  const log = `✔ passing (1ms)
✖ first failure (2ms)
ℹ pass 1
ℹ fail 2
ℹ cancelled 0
✖ failing tests:

test at tests/example.test.ts:1:1
✖ first failure (2ms)
  AssertionError: expected true
  actual: false
  expected: true
  operator: strictEqual
  extra line omitted

test at tests/example.test.ts:2:1
✖ second failure (3ms)
  Error: second reason
`;
  assert.equal(unitSummary(log), "pass 1, fail 2\n✖ first failure\n  AssertionError: expected true\n  actual: false\n  expected: true\n  operator: strictEqual\n✖ second failure\n  Error: second reason");
  assert.equal(unitSummary("\u001b[32mℹ pass 7\u001b[0m\nℹ fail 0\nℹ cancelled 0\n"), "pass 7, fail 0");
  assert.match(unitSummary("ℹ pass 0\nℹ fail 0\nℹ cancelled 2\n"), /cancelled 2/);
  assert.throws(() => unitSummary("Error: runner crashed"), /lacks pass\/fail counts/);
});

test("Sol expiry kills its process group including a child that ignores TERM", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ase-sol-timeout-"));
  const pidFile = join(scratch, "pids.json");
  try {
    const job = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    const result = spawnSync(process.execPath, ["scripts/agents/sol-run.mjs", "1s", process.execPath, "-e", job, pidFile], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 124, result.stderr);
    const pids: number[] = JSON.parse(readFileSync(pidFile, "utf8"));
    for (const pid of pids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0], "Z", `process ${pid} remains alive`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  } finally {
    // Bound even a broken supervisor; stop only the group this test created.
    try {
      const [leader]: number[] = JSON.parse(readFileSync(pidFile, "utf8"));
      process.kill(-leader, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
