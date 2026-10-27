import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { reviewBrief, reviewComplete, reviewFormat } from "../scripts/agents/review-brief.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { unitSummary } from "../scripts/agents/unit-summary.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { agentInvocation, buildContract, claudeResult, codexModelMatches, grokResult, inferCli, isoWeek, opencodeResult, opencodeReviewAgent, opencodeReviewConfig, opencodeUsageLimit, parseAgentArgs, refusedOutright, releaseReviewBudget, reserveReviewBudget, reviewBase, usageLimitProblem } from "../scripts/agents/agent-run.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { durationMilliseconds } from "../scripts/agents/sol-run.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { kitStateDir } from "../scripts/agents/kit-lib.mjs";

test("agent options preserve defaults, infer Claude aliases, and respect explicit overrides", () => {
  for (const kind of ["build", "review"]) {
    assert.deepEqual(parseAgentArgs([kind, "/work tree", "brief.md"]), {
      kind, worktree: "/work tree", brief: "brief.md", model: "claude-opus-5-5", cli: "claude", effort: "medium",
    });
  }
  for (const [kind, variable] of [["review", "ASE_REVIEW_MODEL"], ["build", "ASE_BUILD_MODEL"]]) {
    const options = parseAgentArgs([kind, ".", "brief"], { [variable]: "gpt-6.1-sol" });
    assert.equal(options.model, "gpt-6.1-sol");
    assert.equal(options.cli, "codex");
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

test("Claude adapter allows build edits and Bash, denies spawning, and keeps review tools read-only", () => {
  for (const kind of ["build", "review"]) {
    const options = parseAgentArgs([kind, "/work tree", "brief", "--model", "claude-opus-5-5", "--effort", "low"]);
    const call = agentInvocation(options, "/shared git", "/out file.md");
    assert.equal(call.command, "claude");
    assert.equal(call.capture, true);
    assert.deepEqual(call.args, ["-p", "--model", "claude-opus-5-5", "--effort", "low", "--permission-mode", kind === "build" ? "acceptEdits" : "plan",
      ...(kind === "build" ? ["--allowedTools", "Bash", "--disallowedTools", "Task,Agent", "--add-dir", "/shared git"] : ["--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
      "--output-format", "json"]);
    assert.deepEqual(call.resume("session"), [...call.args, "--resume", "session"]);
    assert.equal(call.finish(JSON.stringify({ modelUsage: { "claude-opus-5-5": {} }, result: "report" })), "report");
  }
});

test("Claude results require the requested model and permit only Haiku helpers alongside it", () => {
  const json = (models: string[], extra = {}) => JSON.stringify({
    result: "report", modelUsage: Object.fromEntries(models.map(model => [model, {}])), ...extra,
  });
  for (const requested of ["claude-opus-5-5", "opus", "claude-opus-5-5[1m]", "opus[1m]"]) {
    for (const opus of ["claude-opus-5-5", "claude-opus-5-5-20261001"]) {
      assert.equal(claudeResult(json([opus, "claude-haiku-4-5-20251001"]), requested), "report");
      assert.equal(claudeResult(json(["claude-haiku-4-5-20251001"], { model: opus }), requested), "report");
    }
    for (const models of [[], ["claude-haiku-4-5-20251001"], ["claude-sonnet-5-5"],
      ["claude-opus-5-5", "claude-sonnet-5-5"], ["claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-sonnet-5-5"]]) {
      assert.throws(() => claudeResult(json(models), requested), /requested model/);
    }
    assert.throws(() => claudeResult(json(["claude-opus-5-5"], { model: "claude-sonnet-5-5" }), requested), /requested model/);
  }
});

test("Claude context variants retain CLI arguments while verifying the underlying model", () => {
  for (const model of ["claude-opus-4-6[1m]", "opus[1m]", "sonnet[1m]", "haiku[1m]", "fable[1m]"]) {
    const options = parseAgentArgs(["review", ".", "brief", "--model", model]);
    assert.equal(options.cli, "claude");
    const call = agentInvocation(options, "/git", "/out");
    assert.equal(call.args[call.args.indexOf("--model") + 1], model);
    const underlying = model.startsWith("claude-") ? model.slice(0, -4) : `claude-${model.slice(0, -4)}-4-6`;
    for (const actual of [underlying, `${underlying}-20261001`]) {
      assert.equal(call.finish(JSON.stringify({ modelUsage: { [actual]: {} }, result: "report" })), "report");
      assert.equal(call.finish(JSON.stringify({ model: actual, result: "report" })), "report");
    }
    const wrong = model.includes("opus") ? "claude-sonnet-4-5" : "claude-opus-4-5";
    for (const actual of model.startsWith("claude-") ? [wrong, "claude-opus-4-5"] : [wrong]) {
      assert.throws(() => call.finish(JSON.stringify({ model: actual, result: "report" })), /requested model/);
    }
  }
});

test("review bases resolve through git and missing scope is refused", (t) => {
  const wt = mkdtempSync(join(tmpdir(), "ase-review-base-"));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const git = reviewRepository(wt);
  assert.throws(() => reviewBase("tiny brief", undefined, wt), /brief has no review scope/);
  assert.equal(reviewBase("Scope: git diff origin/dev...HEAD", undefined, wt), git("rev-parse", "origin/dev").trim());
  assert.equal(reviewBase("git diff origin/dev...HEAD", "HEAD^", wt), git("rev-parse", "HEAD^").trim());
  for (const ref of ["--output=x", "dev; rm -rf /", "-bad"]) assert.throws(() => reviewBase("", ref, wt), /cannot resolve commit ref/);
  assert.equal(parseAgentArgs(["review", wt, "brief", "--base", "HEAD~1", "--out", "/out dir"]).out, "/out dir");
  assert.throws(() => parseAgentArgs(["review", wt, "brief", "--base", "HEAD", "--commit", "HEAD"]), /mutually exclusive/);
});

function reviewRepository(wt: string) {
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "base");
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  // The brief cites the standards file and the checks named in the reviewed checkout's settings, and its specs command.
  mkdirSync(join(wt, "scripts/agents/project.d"), { recursive: true });
  writeFileSync(join(wt, "scripts/agents/kit.json"), JSON.stringify({ project: "brief", branches: { land: "dev" }, standards: "CODING_STANDARDS.md",
    commands: "scripts/agents/project.d", checks: { check: "npm run check", test: "npm test", lint: "npm run lint" } }));
  writeFileSync(join(wt, "scripts/agents/project.d/specs"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(wt, "change.txt"), "reviewed change\n");
  git("add", "change.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "reviewed change");
  return git;
}

test("runner review, landing and waiting follow the kit and the per-CLI waiting guidance", () => {
  const runner = readFileSync("docs/agents/runner.md", "utf8");
  assert.ok(runner.split("\n").length <= 96);
  assert.match(runner, /Claude runs them with\s+`run_in_background: true`/);
  assert.match(runner, /Codex runs them in the foreground or its background terminal/);
  assert.match(runner, /scripts\/agents\/kit wait pid\|output\|ci/);
  for (const command of ["scripts/agents/kit review --ticket <ticket>", "scripts/agents/kit pr --ticket <ticket>"]) {
    const line = runner.split("\n").find(line => line.includes(command));
    assert.ok(line, command);
    assert.match(line, /in the background/);
  }
  assert.doesNotMatch(runner, /\b(?:review|ci-status|land)\.sh/);
});

test("model verification rejects missing metadata, fallback models and unsuccessful Claude results", () => {
  assert.equal(codexModelMatches("\tmodel: gpt-5.5\n", "gpt-5.5"), true);
  assert.equal(codexModelMatches("model: gpt-5.5\r\n", "gpt-5.5"), true);
  for (const log of ["", "model: gpt-5.5-extra\n", "model: gpt-5.5\nmodel: another\n"]) assert.equal(codexModelMatches(log, "gpt-5.5"), false);
  // Only Codex header blocks name the model; file contents echoed later in the log do not.
  const header = (model: string) => `OpenAI Codex v0.163.0\n--------\nworkdir: /w\nmodel: ${model}\nsession id: 1\n--------\nuser\n`;
  assert.equal(codexModelMatches(`${header("gpt-6.1-sol")}exec\n  model: monaco.editor.ITextModel;\n`, "gpt-6.1-sol"), true);
  assert.equal(codexModelMatches(`${header("gpt-6.1-sol")}work\n${header("gpt-6.1-sol")}more\n`, "gpt-6.1-sol"), true);
  assert.equal(codexModelMatches(`${header("gpt-6.1-sol")}work\n${header("gpt-5.5")}more\n`, "gpt-6.1-sol"), false);
  assert.equal(codexModelMatches(`${header("gpt-5.5")}\n  model: gpt-6.1-sol\n`, "gpt-6.1-sol"), false);
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

test("Grok adapter runs reviews only, read-only and headless, and resumes its own session", () => {
  for (const model of ["grok-4.7", "grok-4.6"]) assert.equal(inferCli(model), "grok");
  const options = parseAgentArgs(["review", "/work tree", "brief"], { ASE_REVIEW_MODEL: "grok-4.7" });
  assert.equal(options.cli, "grok");
  const call = agentInvocation({ ...options, sessionId: "id-1" }, "/shared git", "/out file.md");
  assert.equal(call.command, "grok");
  assert.equal(call.capture, true);
  const shared = ["--prompt-file", "/dev/stdin", "-m", "grok-4.7", "--reasoning-effort", "medium", "--output-format", "json",
    "--sandbox", "read-only", "--tools", "read_file,grep,list_dir", "--no-subagents", "--disable-web-search", "--cwd", "/work tree"];
  assert.deepEqual(call.args, [...shared, "-s", "id-1"]);
  assert.deepEqual(call.resume("id-1"), [...shared, "--resume", "id-1"]);
  assert.ok(!call.args.some((arg: string) => /always-approve|bypass|workspace|search_replace|run_terminal_cmd/.test(arg)));
  assert.equal(call.session(JSON.stringify({ sessionId: "id-1" })), "id-1");
  assert.throws(() => parseAgentArgs(["build", ".", "brief", "--model", "grok-4.7"]), /reviews only/);
  assert.throws(() => parseAgentArgs(["build", ".", "brief", "--cli", "grok"]), /reviews only/);
  assert.throws(() => agentInvocation({ ...options, kind: "build" }, "/git", "/out"), /reviews only/);
});

test("Grok results parse to their text and accept only the requested model with a variant suffix", () => {
  const sample = JSON.stringify({
    text: "REVIEW_STATUS: complete\nDefects: none", stopReason: "end_turn", sessionId: "01a16308-4fe2-7c13-9e28-c176565b915b",
    usage: { input_tokens: 8053, output_tokens: 69 }, num_turns: 1,
    modelUsage: { "grok-4.7-build": { inputTokens: 8053, outputTokens: 69, modelCalls: 1 } },
  });
  assert.equal(grokResult(sample, "grok-4.7"), "REVIEW_STATUS: complete\nDefects: none");
  const json = (models: string[], extra = {}) => JSON.stringify({ text: "report", modelUsage: Object.fromEntries(models.map(model => [model, {}])), ...extra });
  assert.equal(grokResult(json(["grok-4.7"]), "grok-4.7"), "report");
  assert.equal(grokResult(json(["grok-4.7-build"]), "GROK-4.7"), "report");
  assert.throws(() => grokResult(json(["grok-4.70"]), "GROK-4.7"), /requested model/);
  assert.equal(grokResult(json(["grok-4.7-build"], { text: "" }), "grok-4.7"), "");
  for (const models of [[], ["grok-4.6"], ["grok-4.70"], ["gpt-6.1-sol"], ["claude-opus-5-5"], ["grok-4.7-build", "grok-4.6-mini"]]) {
    assert.throws(() => grokResult(json(models), "grok-4.7"), /requested model/);
  }
  assert.throws(() => grokResult(JSON.stringify({ modelUsage: { "grok-4.7-build": {} } }), "grok-4.7"), /no final report/);
  assert.throws(() => grokResult("not JSON", "grok-4.7"));
});

test("OpenCode adapter runs reviews only, as a read-only agent, and resumes its own session", () => {
  const model = "opencode/deepseek-v4.1-flash-free";
  assert.equal(inferCli(model), "opencode");
  for (const other of ["opencode", "opencode/", "OpenCode/deepseek-v4.1-flash-free", "deepseek-v4.1-flash-free"]) assert.notEqual(inferCli(other), "opencode");
  const options = parseAgentArgs(["review", "/work tree", "brief"], { ASE_REVIEW_MODEL: model });
  assert.equal(options.cli, "opencode");
  const call = agentInvocation(options, "/shared git", "/out file.md");
  assert.equal(call.command, "opencode");
  assert.equal(call.capture, true);
  const args = ["run", "--pure", "--agent", opencodeReviewAgent, "--format", "json", "-m", model, "--dir", "/work tree"];
  assert.deepEqual(call.args, args);
  assert.deepEqual(call.resume("ses_1"), [...args, "--session", "ses_1"]);
  assert.ok(!call.args.some((arg: string) => /auto|yolo|skip-permissions/.test(arg)));
  // The agent denies every tool but reading, searching and listing; project config and Claude Code files stay out.
  assert.equal(call.env.OPENCODE_CONFIG_CONTENT, opencodeReviewConfig);
  assert.deepEqual(JSON.parse(opencodeReviewConfig).agent[opencodeReviewAgent].permission, { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow" });
  assert.equal(call.env.OPENCODE_DISABLE_PROJECT_CONFIG, "1");
  assert.equal(call.env.OPENCODE_DISABLE_CLAUDE_CODE, "1");
  assert.equal(call.session('partial\n{"type":"step_start","sessionID":"ses_1"}\n'), "ses_1");
  assert.equal(call.session(""), undefined);
  assert.throws(() => parseAgentArgs(["build", ".", "brief", "--model", model]), /OpenCode runs reviews only/);
  assert.throws(() => parseAgentArgs(["build", ".", "brief", "--cli", "opencode"]), /reviews only/);
  assert.throws(() => agentInvocation({ ...options, kind: "build" }, "/git", "/out"), /reviews only/);
});

test("OpenCode results take the last message's text and accept only the requested provider and model", () => {
  const model = "opencode/deepseek-v4.1-flash-free";
  const event = (type: string, extra = {}) => JSON.stringify({ type, timestamp: 1, sessionID: "ses_1", ...extra });
  const text = (messageID: string, value: string) => event("text", { part: { type: "text", messageID, text: value } });
  const stdout = [event("step_start"), text("m1", "Reading the diff."), event("tool_use"), text("m2", "REVIEW_STATUS: complete"), text("m2", "Defects: none"), event("step_finish")].join("\n");
  const exported = (...models: string[]) => () => "Exporting session: ses_1\n" + JSON.stringify({ messages: [{ info: { role: "user", model: { providerID: "x", modelID: "y" } } },
    ...models.map(name => ({ info: { role: "assistant", providerID: name.split("/")[0], modelID: name.split("/").slice(1).join("/") } }))] });
  assert.equal(opencodeResult(stdout, model, exported(model, model)), "REVIEW_STATUS: complete\nDefects: none");
  assert.equal(opencodeResult(event("step_finish"), model, exported(model)), "");
  for (const models of [[], ["opencode/deepseek-v4.1-flash"], ["openrouter/deepseek-v4.1-flash-free"], [model, "opencode/other-free"]]) {
    assert.throws(() => opencodeResult(stdout, model, exported(...models)), /requested model/);
  }
  const limit = event("error", { error: { name: "APIError", data: { message: "Rate limit exceeded. Please try again later.", statusCode: 429 } } });
  // A failed run never reaches the export.
  const unreachable = () => { throw new Error("exported"); };
  assert.throws(() => opencodeResult(`${stdout}\n${limit}`, model, unreachable), /OpenCode reported an error: Rate limit exceeded/);
  assert.throws(() => opencodeResult("not JSON", model, unreachable), /OpenCode printed no session/);
  assert.throws(() => opencodeResult(stdout, model, () => "Exporting session: ses_1\n"), /OpenCode export for ses_1 printed no JSON/);
  assert.throws(() => opencodeResult(stdout, model, () => "{ broken"), /OpenCode export for ses_1 is not JSON/);
  assert.equal(opencodeUsageLimit(limit), "problem: opencode usage limit: Rate limit exceeded. Please try again later.");
  assert.equal(opencodeUsageLimit(event("error", { error: { name: "FreeUsageLimitError", data: { message: "Free usage exceeded" } } })), "problem: opencode usage limit: Free usage exceeded");
  // Other errors, and limit phrases the model merely wrote, are not refusals.
  assert.equal(opencodeUsageLimit(event("error", { error: { name: "APIError", data: { message: "Bad gateway", statusCode: 502 } } })), null);
  assert.equal(opencodeUsageLimit(text("m1", "You've hit your usage limit")), null);
});

test("review budgets count outside families per ISO week, refuse at the limit and never count Claude", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-review-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "agent-kit/review-budget.json"), ledger = { path, project: "a" };
  const monday = new Date("2026-10-19T08:00:00Z"), sunday = new Date("2026-10-25T20:00:00Z"), next = new Date("2026-10-26T01:00:00Z");
  assert.equal(isoWeek(monday), "2026-W43");
  assert.equal(isoWeek(sunday), "2026-W43");
  assert.equal(isoWeek(next), "2026-W44");
  assert.equal(isoWeek(new Date("2027-01-01T12:00:00Z")), "2026-W53");
  const env = { ASE_REVIEW_BUDGET_GROK: "2" };
  assert.equal(reserveReviewBudget(ledger, "claude", env, monday), null);
  assert.ok(!existsSync(path));
  assert.deepEqual(reserveReviewBudget(ledger, "grok", env, monday), { family: "grok", week: "2026-W43", used: 1, limit: 2, project: "a" });
  assert.deepEqual(reserveReviewBudget(ledger, "codex", env, monday), { family: "gpt", week: "2026-W43", used: 1, limit: 12, project: "a" });
  assert.equal(reserveReviewBudget(ledger, "grok", env, sunday).used, 2);
  assert.throws(() => reserveReviewBudget(ledger, "grok", env, sunday), /grok review budget used up: 2\/2 in 2026-W43; raise ASE_REVIEW_BUDGET_GROK to override/);
  assert.equal(reserveReviewBudget(ledger, "grok", { ASE_REVIEW_BUDGET_GROK: "3" }, sunday).used, 3);
  assert.equal(reserveReviewBudget(ledger, "grok", env, next).used, 1);
  assert.equal(reserveReviewBudget(ledger, "claude", { ASE_REVIEW_BUDGET_GROK: "0" }, next), null);
  // A new week starts from zero; last week stays for the sweep.
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "2026-W43": { grok: { a: 3 }, gpt: { a: 1 } }, "2026-W44": { grok: { a: 1 } } });
  releaseReviewBudget(path, { family: "grok", week: "2026-W44", project: "a" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))["2026-W44"], { grok: { a: 0 } });
  // Two weeks on, the week before last goes.
  assert.equal(reserveReviewBudget(ledger, "grok", env, new Date("2026-11-02T09:00:00Z")).used, 1);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["2026-W44", "2026-W45"]);
  assert.throws(() => reserveReviewBudget(ledger, "grok", { ASE_REVIEW_BUDGET_GROK: "0" }, next), /0\/0/);
  assert.throws(() => reserveReviewBudget(ledger, "codex", { ASE_REVIEW_BUDGET_GPT: "many" }, next), /ASE_REVIEW_BUDGET_GPT must be a whole number/);
  assert.throws(() => reserveReviewBudget({ path }, "grok", env, next), /review budget needs the project name/);
  assert.ok(!existsSync(`${path}.lock`));
  // A held lock times out without touching the ledger.
  const before = readFileSync(path, "utf8");
  mkdirSync(`${path}.lock`);
  assert.throws(() => reserveReviewBudget(ledger, "grok", { ...env, ASE_REVIEW_BUDGET_LOCK_MS: "100" }, next), /review budget lock .* is held; remove it/);
  assert.equal(readFileSync(path, "utf8"), before);
  rmSync(`${path}.lock`, { recursive: true });
  for (const shape of ["[]", "null", "3"]) {
    writeFileSync(path, shape);
    assert.throws(() => reserveReviewBudget(ledger, "grok", env, next), /review budget ledger .* is not a JSON object; fix or delete it/);
    assert.equal(readFileSync(path, "utf8"), shape);
  }
  writeFileSync(path, "{ broken");
  assert.throws(() => reserveReviewBudget(ledger, "grok", env, next), /review budget ledger .* is not valid JSON: .*; fix or delete it/);
  // An old-shape count in the machine ledger is named, not silently ignored.
  writeFileSync(path, JSON.stringify({ "2026-W44": { grok: 4 } }));
  assert.throws(() => reserveReviewBudget(ledger, "grok", env, next), (error: Error) => error.message === `review budget ledger ${path} 2026-W44 grok is not { "<project>": <count> }; fix or delete it`);
  writeFileSync(path, JSON.stringify({ "2026-W44": 4 }));
  assert.throws(() => reserveReviewBudget(ledger, "grok", env, next), (error: Error) => error.message.startsWith(`review budget ledger ${path} 2026-W44 is not {`));
  assert.ok(!existsSync(`${path}.lock`));
});

test("two projects share one count, and a project's old ledger moves in once", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-review-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state/agent-kit/review-budget.json"), legacy = join(dir, "editor/.scratch/review-budget.json");
  const monday = new Date("2026-10-26T08:00:00Z"), env = { ASE_REVIEW_BUDGET_GROK: "8" };
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ "2026-W43": { grok: 2 }, "2026-W44": { grok: 5, gpt: 1 } }));
  const editor = { path, project: "editor", legacy }, other = { path, project: "other", legacy: join(dir, "other/.scratch/review-budget.json") };
  assert.equal(reserveReviewBudget(editor, "grok", env, monday).used, 6);
  assert.ok(!existsSync(legacy), "moved, not copied");
  assert.equal(reserveReviewBudget(other, "grok", env, monday).used, 7);
  assert.equal(reserveReviewBudget(editor, "grok", env, monday).used, 8);
  assert.throws(() => reserveReviewBudget(other, "grok", env, monday), /grok review budget used up: 8\/8 in 2026-W44/);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "2026-W43": { grok: { editor: 2 } }, "2026-W44": { grok: { editor: 7, other: 1 }, gpt: { editor: 1 } } });
  // An older kit that wrote the old file again after the move: only its new counts move in.
  writeFileSync(legacy, JSON.stringify({ "2026-W44": { grok: 1 } }));
  releaseReviewBudget(path, { family: "grok", week: "2026-W44", project: "other" });
  assert.throws(() => reserveReviewBudget(editor, "grok", env, monday), /used up: 8\/8/);
  assert.ok(!existsSync(legacy));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))["2026-W44"].grok, { editor: 8, other: 0 });
  // A held lock on the old file (an older kit, or a stale lock) is tried briefly, not for the machine
  // lock's full wait: the review counts as usual and the old file waits for the next review.
  writeFileSync(legacy, JSON.stringify({ "2026-W44": { gpt: 1 } }));
  mkdirSync(`${legacy}.lock`);
  const started = Date.now();
  assert.equal(reserveReviewBudget(editor, "codex", env, monday).used, 2);
  assert.ok(Date.now() - started < 5_000, "the old file's lock is not waited on for ASE_REVIEW_BUDGET_LOCK_MS");
  assert.equal(readFileSync(legacy, "utf8"), JSON.stringify({ "2026-W44": { gpt: 1 } }));
  assert.ok(existsSync(`${legacy}.lock`));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8"))["2026-W44"].gpt, { editor: 2 });
  rmSync(`${legacy}.lock`, { recursive: true });
  assert.equal(reserveReviewBudget(editor, "codex", env, monday).used, 4);
  assert.ok(!existsSync(legacy));
  // A broken old file stops the review, names the file and is kept; the machine ledger is untouched.
  writeFileSync(legacy, "{ broken");
  const before = readFileSync(path, "utf8");
  assert.throws(() => reserveReviewBudget(editor, "grok", env, monday),
    (error: Error) => error.message.includes(`review budget ledger ${legacy} is not valid JSON`));
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readFileSync(legacy, "utf8"), "{ broken");
  // So does a week or a count of the wrong shape: nothing merges and nothing is deleted.
  for (const [shape, problem] of [[{ "2026-W44": 5 }, `${legacy} 2026-W44 is not { "<family>": <count> }`], [{ "2026-W44": null }, `${legacy} 2026-W44 is not`],
    [{ "2026-W43": { grok: 1 }, "2026-W44": { grok: "3" } }, `${legacy} 2026-W44 grok is not a count`], [{ "2026-W44": { gpt: -1 } }, `${legacy} 2026-W44 gpt is not a count`]] as const) {
    writeFileSync(legacy, JSON.stringify(shape));
    assert.throws(() => reserveReviewBudget(editor, "grok", env, monday), (error: Error) => error.message.includes(`review budget ledger ${problem}`));
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(readFileSync(legacy, "utf8"), JSON.stringify(shape));
  }
  assert.ok(!existsSync(`${legacy}.lock`) && !existsSync(`${path}.lock`));
});

test("weeks moved in from an old ledger are pruned like any other", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-review-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state/review-budget.json"), legacy = join(dir, "old/review-budget.json");
  mkdirSync(dirname(legacy), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ "2026-W40": { grok: 3 }, "2026-W44": { grok: 1 } }));
  assert.equal(reserveReviewBudget({ path, project: "editor", legacy }, "grok", {}, new Date("2026-10-26T08:00:00Z")).used, 2);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { "2026-W44": { grok: { editor: 2 } } });
});

test("a machine ledger write that fails after the move puts the old counts back", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-review-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state/review-budget.json"), legacy = join(dir, "old/review-budget.json"), text = '{"2026-W44":{"grok":3}}';
  mkdirSync(dirname(legacy), { recursive: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{}");
  writeFileSync(legacy, text);
  // The ledger is written to a temporary file and renamed over the old one; fail that rename only.
  const rename = fs.renameSync;
  fs.renameSync = ((from: string, to: string) => {
    if (to === path) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  t.after(() => { fs.renameSync = rename; syncBuiltinESMExports(); });
  assert.throws(() => reserveReviewBudget({ path, project: "editor", legacy }, "grok", {}, new Date("2026-10-26T08:00:00Z")), /ENOSPC/);
  assert.equal(readFileSync(legacy, "utf8"), text);
  assert.equal(readFileSync(path, "utf8"), "{}");
  // An older kit that wrote the old file meanwhile keeps its count; the moved one is added back.
  fs.renameSync = ((from: string, to: string) => {
    if (to === path) { writeFileSync(legacy, '{"2026-W44":{"grok":1,"gpt":2}}'); throw new Error("EIO: i/o error"); }
    rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  assert.throws(() => reserveReviewBudget({ path, project: "editor", legacy }, "grok", {}, new Date("2026-10-26T08:00:00Z")), /EIO/);
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")), { "2026-W44": { grok: 4, gpt: 2 } });
  fs.renameSync = rename;
  syncBuiltinESMExports();
  assert.ok(!existsSync(`${legacy}.lock`) && !existsSync(`${path}.lock`));
});

test("the kit's state folder is XDG_STATE_HOME/agent-kit when absolute, else ~/.local/state/agent-kit, in Node and bash", () => {
  const lib = resolve("scripts/agents/kit-lib.sh");
  const bash = (env: NodeJS.ProcessEnv) => spawnSync("bash", ["-c", `source "${lib}"; kit_state_dir`], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } }).stdout.trim();
  for (const [env, expected] of [
    [{ HOME: "/home/x", XDG_STATE_HOME: "/var/state" }, "/var/state/agent-kit"],
    [{ HOME: "/home/x", XDG_STATE_HOME: "" }, "/home/x/.local/state/agent-kit"],
    [{ HOME: "/home/x", XDG_STATE_HOME: "relative/state" }, "/home/x/.local/state/agent-kit"],
    [{ HOME: "/home/x" }, "/home/x/.local/state/agent-kit"],
  ] as [NodeJS.ProcessEnv, string][]) {
    assert.equal(kitStateDir(env), expected);
    assert.equal(bash(env), expected);
  }
});

test("provider usage-limit messages become a family usage-limit problem", () => {
  const openai = "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at Oct 25th, 2026 3:14 PM.";
  assert.equal(usageLimitProblem(`model: gpt-6.1-sol\n${openai}\n`, "codex"), "problem: gpt usage limit until Oct 25th, 2026 3:14 PM");
  assert.equal(usageLimitProblem("You’ve hit your usage limit. Try again at 9:00 AM", "grok"), "problem: grok usage limit until 9:00 AM");
  for (const text of ["", "model: gpt-6.1-sol\nERROR: stream disconnected", "try again at 9:00 AM"]) assert.equal(usageLimitProblem(text, "codex"), null);
  // Quoted text the agent read earlier, or a phrase inside a line, is not the CLI's error.
  const quoted = `exec\n${openai}\n  const openai = "${openai}";\n${"read more\n".repeat(6)}ERROR: stream disconnected before completion\n`;
  assert.equal(usageLimitProblem(quoted, "codex"), null);
  assert.equal(usageLimitProblem(`{\n  "text": "${openai}"\n}`, "grok"), null);
});

test("only a usage limit that is all the call printed counts as an outright refusal", () => {
  const limit = "ERROR: You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at Oct 27th, 2026 8:26 PM.";
  const prompt = "Review this slice.\nexec\nThe very first line must be REVIEW_STATUS: complete.\n";
  const header = `OpenAI Codex v0.163.0\n--------\nmodel: gpt-6.1-sol\nsession id: 1\n--------\nuser\n${prompt}\n`;
  const warning = "warning: `--dangerously-bypass-hook-trust` is enabled.\n";
  // The prompt echo may hold work-like lines; only what follows it counts.
  assert.equal(refusedOutright("codex", `${header}${warning}${limit}\n${limit}\n`, prompt), true);
  assert.equal(refusedOutright("codex", `${header}${warning}exec\n/bin/bash -lc ls\ncodex\nReading.\n${limit}\ntokens used\n1,024\n`, prompt), false);
  assert.equal(refusedOutright("codex", `${header}${warning}`, prompt), false);
  // Without the echo there is no telling where work would start.
  assert.equal(refusedOutright("codex", `${limit}\n`, prompt), false);
  const grok = "You've hit your usage limit. Try again at 9:00 AM.";
  // The log holds Grok's stdout and stderr alike; either may carry the refusal.
  assert.equal(refusedOutright("grok", `${grok}\n`, ""), true);
  assert.equal(refusedOutright("grok", "", ""), false);
  // Work on stderr before a stdout refusal means quota was used.
  assert.equal(refusedOutright("grok", `read_file src/a.ts\n${grok}\n`, ""), false);
  assert.equal(refusedOutright("grok", `{"text":"partial"}\n${grok}\n`, ""), false);
});

test("Grok reviews and Codex usage limits run through the shared shell entry using fake CLIs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-agent-grok-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wt = join(dir, "work tree"), bin = join(dir, "bin"), brief = join(dir, "brief.md");
  mkdirSync(wt); mkdirSync(bin);
  reviewRepository(wt);
  const sourceHome = join(dir, "codex-home");
  mkdirSync(sourceHome); writeFileSync(join(sourceHome, "auth.json"), "{}");
  writeFileSync(brief, "tiny brief\n");
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(join(bin, "grok"), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.ASE_FAKE_CAPTURE, JSON.stringify({ args, input: readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8") }));
const session = args[args.indexOf(args.includes("-s") ? "-s" : "--resume") + 1];
if (process.env.ASE_FAKE_GROK === "broken") { console.log("internal error\\nstack trace"); process.exit(1); }
if (process.env.ASE_FAKE_GROK === "retry-limited") {
  if (args.includes("--resume")) { console.log("You've hit your usage limit. Try again at 9:00 AM."); process.exit(1); }
  console.log(JSON.stringify({ text: "incomplete reply", sessionId: session, modelUsage: { "grok-4.7-build": {} } }));
  process.exit(0);
}
if (process.env.ASE_FAKE_GROK === "limited") { console.log("You've hit your usage limit. Try again at 9:00 AM."); process.exit(1); }
if (process.env.ASE_FAKE_GROK === "resume-no-session") {
  appendFileSync(process.env.ASE_FAKE_CAPTURE + ".calls", JSON.stringify({ args, input: readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8") }) + "\\n");
  console.log(JSON.stringify({ text: "incomplete reply", modelUsage: { "grok-4.7-build": {} } }));
  process.exit(0);
}
if (process.env.ASE_FAKE_GROK === "retry-no-session") {
  if (args.includes("--resume")) { console.log("internal error"); process.exit(1); }
  writeFileSync(process.env.ASE_FAKE_CAPTURE + ".first", JSON.stringify({ args }));
  console.log(JSON.stringify({ text: "incomplete reply", modelUsage: { "grok-4.7-build": {} } }));
  process.exit(0);
}
console.log(JSON.stringify({ text: "REVIEW_STATUS: complete\\nDefects: none\\n", stopReason: "end_turn", sessionId: session, modelUsage: { [args[args.indexOf("-m") + 1] + "-build"]: {} } }));
`);
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
console.error("OpenAI Codex v0.163.0\\n--------\\nmodel: gpt-6.1-sol\\n--------");
console.error("ERROR: You've hit your usage limit. Upgrade to Pro, or try again at Oct 25th, 2026 3:14 PM.");
process.exitCode = 1;
`);
  for (const cli of ["grok", "codex"]) chmodSync(join(bin, cli), 0o755);
  const capture = join(dir, "capture.json");
  const invoke = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync("bash", [resolve("scripts/agents/agent.sh"), ...args], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: sourceHome, ASE_FAKE_CAPTURE: capture, ASE_AGENT_CLI: "", ASE_REVIEW_MODEL: "", ASE_AGENT_TIMEOUT: "10s", ...overrides },
  });
  const result = invoke(["review", wt, brief, "--base", "origin/dev"], { ASE_REVIEW_MODEL: "grok-4.7" });
  assert.equal(result.status, 0, result.stderr);
  const out = /^artifacts: (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(out);
  assert.match(readFileSync(join(out, "out.md"), "utf8"), /^REVIEW_STATUS: complete\nDefects: none/);
  const recorded: { args: string[]; input: string } = JSON.parse(readFileSync(capture, "utf8"));
  assert.ok(recorded.input.startsWith("tiny brief\n") && recorded.input.includes("Review scope: git diff"));
  assert.equal(recorded.args[recorded.args.indexOf("--sandbox") + 1], "read-only");
  const status = JSON.parse(readFileSync(join(out, "status.json"), "utf8"));
  assert.equal(status.cli, "grok");
  assert.equal(status.session, recorded.args[recorded.args.indexOf("-s") + 1]);
  // A failed Grok run reports the CLI failure last, not the unparseable stdout.
  for (const [mode, last] of [["broken", /^problem: grok failed \(1\); see .*run\.log$/], ["limited", /^problem: grok usage limit until 9:00 AM$/],
    ["retry-limited", /^problem: grok usage limit until 9:00 AM$/]] as const) {
    const failed = invoke(["review", wt, brief, "--base", "origin/dev"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_FAKE_GROK: mode });
    assert.equal(failed.status, 1, failed.stderr);
    const problems = failed.stderr.trimEnd().split("\n");
    assert.match(problems.at(-1)!, last);
    // The incomplete first answer is reported, then the retry's usage limit as the cause.
    if (mode === "retry-limited") assert.ok(problems.slice(0, -1).includes("problem: result lacks REVIEW_STATUS: complete"), failed.stderr);
    // Only a refused first call records the refund kit review reads.
    const run = /^artifacts: (.+)$/m.exec(failed.stdout)?.[1];
    assert.ok(run);
    assert.equal(JSON.parse(readFileSync(join(run, "status.json"), "utf8")).refused, mode === "limited" ? true : undefined);
    if (mode === "broken") {
      const stopped = /^artifacts: (.+)$/m.exec(failed.stdout)?.[1];
      assert.ok(stopped);
      const session = JSON.parse(readFileSync(join(stopped, "status.json"), "utf8")).session;
      // Resuming continues the recorded Grok session instead of naming a new one.
      const resumed = invoke(["--resume", stopped]);
      assert.equal(resumed.status, 0, resumed.stderr);
      const again: { args: string[] } = JSON.parse(readFileSync(capture, "utf8"));
      assert.equal(again.args[again.args.indexOf("--resume") + 1], session);
      assert.ok(!again.args.includes("-s"));
      assert.equal(again.args[again.args.indexOf("--sandbox") + 1], "read-only");
      assert.match(readFileSync(join(stopped, "out.md"), "utf8"), /REVIEW_STATUS: complete/);
    }
  }
  const limited = invoke(["review", wt, brief, "--base", "origin/dev"], { ASE_REVIEW_MODEL: "gpt-6.1-sol" });
  assert.equal(limited.status, 1);
  assert.equal(limited.stderr.trimEnd().split("\n").at(-1), "problem: gpt usage limit until Oct 25th, 2026 3:14 PM");
  assert.doesNotMatch(limited.stderr, /codex failed/);
  // A result with no sessionId keeps the runner's -s id for the retry and --resume.
  const noSession = invoke(["review", wt, brief, "--base", "origin/dev"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_FAKE_GROK: "retry-no-session" });
  assert.equal(noSession.status, 1, noSession.stderr);
  const stopped = /^artifacts: (.+)$/m.exec(noSession.stdout)?.[1];
  assert.ok(stopped);
  const first: { args: string[] } = JSON.parse(readFileSync(`${capture}.first`, "utf8"));
  const assigned = first.args[first.args.indexOf("-s") + 1];
  assert.ok(assigned);
  assert.equal(JSON.parse(readFileSync(join(stopped, "status.json"), "utf8")).session, assigned);
  const retried: { args: string[] } = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(retried.args[retried.args.indexOf("--resume") + 1], assigned);
  assert.ok(!retried.args.includes("-s"));
  const resumed = invoke(["--resume", stopped], { ASE_FAKE_GROK: "retry-no-session" });
  assert.equal(resumed.status, 1, resumed.stderr);
  const again: { args: string[] } = JSON.parse(readFileSync(capture, "utf8"));
  assert.equal(again.args[again.args.indexOf("--resume") + 1], assigned);
  // A resumed run whose resume call ends incomplete with no sessionId retries the recorded id.
  const incomplete = invoke(["--resume", stopped], { ASE_FAKE_GROK: "resume-no-session" });
  assert.equal(incomplete.status, 1, incomplete.stderr);
  assert.match(incomplete.stderr, /problem: result lacks REVIEW_STATUS: complete/);
  const calls: { args: string[]; input: string }[] = readFileSync(`${capture}.calls`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf("--resume") + 1], assigned);
    assert.ok(!call.args.includes("-s"));
  }
  assert.match(calls[1].input, /^Your reply must start with the line REVIEW_STATUS: complete\./);
  // A refused resume is not the review's first call, so it records no refund.
  const refusedResume = invoke(["--resume", stopped], { ASE_FAKE_GROK: "limited" });
  assert.equal(refusedResume.status, 1, refusedResume.stderr);
  assert.equal(refusedResume.stderr.trimEnd().split("\n").at(-1), "problem: grok usage limit until 9:00 AM");
  assert.equal(JSON.parse(readFileSync(join(stopped, "status.json"), "utf8")).refused, undefined);
});

test("both adapters run through the shared shell entry and compatibility wrappers using fake CLIs", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-agent-adapters-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wt = join(dir, "work tree"), bin = join(dir, "bin"), brief = join(dir, "brief.md");
  mkdirSync(wt); mkdirSync(bin);
  const git = reviewRepository(wt);
  const sourceHome = join(dir, "codex-home");
  mkdirSync(sourceHome); writeFileSync(join(sourceHome, "auth.json"), "{}");
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: sourceHome, ASE_FAKE_CAPTURE: capture, ASE_AGENT_CLI: "", ASE_BUILD_MODEL: "", ASE_REVIEW_MODEL: "", ASE_AGENT_TIMEOUT: "10s", ...overrides },
  });
  for (const model of ["gpt-5.5", "claude-haiku-5-5"]) for (const kind of ["build", "review"]) {
    const result = invoke("agent.sh", [kind, wt, brief, "--model", model, "--effort", "low", ...(kind === "review" ? ["--base", "origin/dev"] : [])]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REVIEW_STATUS: complete/);
    const recorded: { args: string[]; input: string; cwd: string } = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(recorded.cwd, wt);
    const out = /^artifacts: (.+)$/m.exec(result.stdout)?.[1];
    assert.ok(out);
    assert.ok(out.startsWith(join(wt, ".scratch/agent", `${kind}-`)));
    if (kind === "build") assert.equal(recorded.input, "tiny brief\n" + buildContract);
    else {
      assert.ok(recorded.input.includes(`Review scope: git diff ${git("rev-parse", "origin/dev").trim()}...HEAD`));
      for (const file of ["diff.patch", "commits.log", "refs.txt"]) assert.ok(recorded.input.includes(JSON.stringify(join(out, file))));
      assert.equal(readFileSync(join(out, "diff.patch"), "utf8"), git("diff", "origin/dev...HEAD"));
      assert.equal(readFileSync(join(out, "commits.log"), "utf8"), git("log", "--oneline", "origin/dev..HEAD"));
      assert.equal(readFileSync(join(out, "refs.txt"), "utf8"), git("rev-parse", "HEAD", "origin/dev"));
    }
    assert.match(readFileSync(join(out, "out.md"), "utf8"), /Defects: none/);
    assert.match(readFileSync(join(out, "run.log"), "utf8"), new RegExp(model));
    assert.deepEqual(readFileSync(brief, "utf8"), "tiny brief\n");
  }
  const defaultBuild = invoke("agent.sh", ["build", wt, brief]);
  assert.equal(defaultBuild.status, 0, defaultBuild.stderr);
  const defaultOut = /^artifacts: (.+)$/m.exec(defaultBuild.stdout)?.[1];
  assert.ok(defaultOut);
  assert.match(readFileSync(join(defaultOut, "run.log"), "utf8"), /claude-opus-5-5/);
  assert.equal(invoke("sol.sh", [wt, brief, "high"], { ASE_BUILD_MODEL: "claude-opus-5-5" }).status, 0);
  const reviewDir = join(dir, "review");
  assert.equal(invoke("review.sh", [wt, brief, reviewDir, "--base", "origin/dev"], { ASE_REVIEW_MODEL: "claude-haiku-5-5" }).status, 0);
  assert.match(readFileSync(join(reviewDir, "result.md"), "utf8"), /REVIEW_STATUS: complete/);
  assert.match(readFileSync(join(reviewDir, "run.log"), "utf8"), /claude-haiku-5-5/);
  const empty = invoke("review.sh", [wt, brief, reviewDir, "--base", "HEAD"]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /empty diff for/);
  writeFileSync(brief, "Scope: git diff HEAD...HEAD\n");
  const scopedOut = join(dir, "explicit artifacts");
  const scoped = invoke("agent.sh", ["review", wt, brief, "--out", scopedOut]);
  assert.equal(scoped.status, 1, scoped.stderr);
  assert.ok(scoped.stdout.startsWith(`artifacts: ${scopedOut}\n`));
  assert.equal(readFileSync(join(scopedOut, "diff.patch"), "utf8"), "");
  assert.equal(readFileSync(join(scopedOut, "commits.log"), "utf8"), "");
  writeFileSync(brief, "tiny brief\n");
  const incomplete = invoke("review.sh", [wt, brief, reviewDir, "--base", "origin/dev"], { ASE_FAKE_REPORT: "incomplete" });
  assert.equal(incomplete.status, 1);
  assert.match(incomplete.stderr, /lacks REVIEW_STATUS/);
  for (const model of ["gpt-5.5", "claude-haiku-5-5"]) {
    const mismatch = invoke("agent.sh", ["review", wt, brief, "--model", model, "--base", "origin/dev"], { ASE_FAKE_MODEL: "different-model" });
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /requested model/);
    assert.equal(invoke("agent.sh", ["review", wt, brief, "--model", model, "--base", "origin/dev"], { ASE_FAKE_EXIT: "7" }).status, 7);
  }
  const beforeInvalid = readdirSync(join(wt, ".scratch/agent")).sort();
  const invalid = invoke("agent.sh", ["build", wt, join(dir, "missing.md")]);
  assert.equal(invalid.status, 2);
  assert.doesNotMatch(invalid.stdout, /artifacts:/);
  assert.deepEqual(readdirSync(join(wt, ".scratch/agent")).sort(), beforeInvalid);
});

test("concurrent reviews copy and validate only their own invocation's report and log", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-concurrent-reviews-"));
  const wt = join(dir, "work"), bin = join(dir, "bin");
  mkdirSync(wt); mkdirSync(bin);
  reviewRepository(wt);
  const sourceHome = join(dir, "codex-home");
  mkdirSync(sourceHome); writeFileSync(join(sourceHome, "auth.json"), "{}");
  const children: ReturnType<typeof spawn>[] = [];
  t.after(() => {
    for (const child of children) child.kill("SIGKILL");
    for (const name of ["first", "second"]) {
      try { process.kill(-Number(readFileSync(join(dir, `${name}.ready`), "utf8")), "SIGKILL"); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const fake = `#!/usr/bin/env node
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const args = process.argv.slice(2);
const input = readFileSync(0, "utf8");
const name = args[1] === "resume" ? "first" : input.split("\\n")[0];
console.error("session id: fixture-session");
console.error("model: " + args[args.indexOf("-m") + 1]);
console.error("invocation: " + name);
writeFileSync(args[args.indexOf("-o") + 1], name === "first" ? "incomplete first report\\n" : "REVIEW_STATUS: complete\\nsecond report\\n");
writeFileSync(process.env.ASE_REVIEW_BARRIER + "/" + name + ".ready", String(process.pid));
if (name === "first") {
  const timer = setInterval(() => {
    if (existsSync(process.env.ASE_REVIEW_BARRIER + "/release")) clearInterval(timer);
  }, 10);
}
`;
  writeFileSync(join(bin, "codex"), fake); chmodSync(join(bin, "codex"), 0o755);
  function invoke(name: string) {
    const brief = join(dir, `${name}.md`), output = join(dir, name);
    writeFileSync(brief, `${name}\n`);
    const child = spawn("bash", [resolve("scripts/agents/review.sh"), wt, brief, output, "--base", "origin/dev"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASE_REVIEW_BARRIER: dir, CODEX_HOME: sourceHome,
        ASE_AGENT_CLI: "codex", ASE_REVIEW_MODEL: "gpt-5.5", ASE_AGENT_TIMEOUT: "10s" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout!.on("data", chunk => { stdout += chunk; });
    child.stderr!.on("data", chunk => { stderr += chunk; });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve({ status, stdout, stderr }));
    });
  }
  const first = invoke("first");
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(dir, "first.ready"))) {
    assert.ok(Date.now() < deadline, "first reviewer did not reach barrier");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // First report already exists; second finishes before first is allowed to exit.
  const second = await invoke("second");
  assert.equal(second.status, 0, second.stderr);
  writeFileSync(join(dir, "release"), "");
  const failed = await first;
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /lacks REVIEW_STATUS/);
  const firstArtifacts = /^artifacts: (.+)$/m.exec(failed.stdout)?.[1];
  const secondArtifacts = /^artifacts: (.+)$/m.exec(second.stdout)?.[1];
  assert.ok(firstArtifacts); assert.ok(secondArtifacts);
  assert.notEqual(firstArtifacts, secondArtifacts);
  for (const name of ["first", "second"]) {
    assert.match(readFileSync(join(dir, name, "result.md"), "utf8"), new RegExp(`${name} report|report.*${name}`));
    assert.match(readFileSync(join(dir, name, "run.log"), "utf8"), new RegExp(`invocation: ${name}`));
    assert.doesNotMatch(readFileSync(join(dir, name, "run.log"), "utf8"), new RegExp(`invocation: ${name === "first" ? "second" : "first"}`));
  }
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

test("slice brief resolves fixture ticket links and states both axes and validation contract", (t) => {
  const wt = mkdtempSync(join(tmpdir(), "ase-review-brief-"));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const git = reviewRepository(wt);
  const path = "tests/fixtures/agent-scripts/tickets/01-slice.md";
  const brief = reviewBrief(path, readFileSync(path, "utf8"), "origin/dev", wt);
  assert.ok(brief.includes(`git diff ${git("rev-parse", "origin/dev").trim()}...HEAD`));
  assert.ok(brief.includes(path));
  assert.match(brief, /tests\/fixtures\/agent-scripts\/spec\.md/);
  assert.match(brief, /tests\/fixtures\/agent-scripts\/02-decision\.md/);
  assert.match(brief, /docs\/work\/example\/spec\.md/);
  assert.match(brief, /docs\/work\/shared\/spec\.md/);
  assert.doesNotMatch(brief, /https:\/\/example.com/);
  assert.match(brief, /Standards axis: apply CODING_STANDARDS\.md/);
  assert.match(brief, /author already ran npm run check, npm test, npm run lint and the touched specs; do not report inability to run tests/);
  assert.match(reviewFormat, /commit:path:line, severity, evidence, and fix/);
  assert.match(reviewFormat, /very first line must be REVIEW_STATUS: complete/);
  assert.doesNotMatch(brief, /Required format:/);
  assert.ok(reviewBrief(path, "", "HEAD^", wt).includes(git("rev-parse", "HEAD^").trim()));
  assert.throws(() => reviewBrief(path, "", "dev; rm -rf /", wt), /cannot resolve commit ref/);
  assert.throws(() => reviewBrief(path, "", "--output=x", wt), /cannot resolve commit ref/);
  const result = spawnSync("bash", [resolve("scripts/agents/review-brief.sh"), resolve(path)], { encoding: "utf8", cwd: wt });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, reviewBrief(resolve(path), readFileSync(path, "utf8"), "origin/dev", wt));
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

test("unit summary reads real redirected TAP output and whitespace around spec counts", () => {
  const log = `TAP version 13
# Subtest: selected test runs
ok 1 - selected test runs
  ---
  duration_ms: 0.734
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 128.443
`;
  assert.equal(unitSummary(log), "pass 1, fail 0");
  assert.equal(unitSummary("  ℹ pass \u001b[32m4370\u001b[0m  \r\n  ℹ fail 0\r\n"), "pass 4370, fail 0");
});

test("build contract directs focused units and type checks and leaves the full tier to kit pr", () => {
  assert.match(buildContract, /scripts\/agents\/kit unit --affected/);
  assert.match(buildContract, /scripts\/agents\/unit.sh <files>/);
  assert.match(buildContract, /npm run check when types moved/);
  assert.match(buildContract, /kit pr runs the tier's full set/);
  assert.doesNotMatch(buildContract, /npm test/);
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

test("supervisor settles logging and stream failures, kills descendants and clears handlers", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ase-agent-io-failure-"));
  try {
    for (const failure of ["logging", "stream"]) for (const stream of ["stdout", "stderr"]) {
      const pidFile = join(scratch, `${failure}-${stream}.json`);
      const job = `
        const { spawn } = require("node:child_process");
        const { writeFileSync } = require("node:fs");
        const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
        writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
        process[process.argv[2]].write("trigger logging\\n");
        setInterval(() => {}, 1000);
      `;
      const harness = `
        import assert from "node:assert/strict";
        import childProcess from "node:child_process";
        import { openSync, closeSync } from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        let owned;
        const originalSpawn = childProcess.spawn;
        childProcess.spawn = (...args) => {
          owned = originalSpawn(...args);
          if (process.argv[2] === "stream") owned[process.argv[3]].once("data", () => {
            owned[process.argv[3]].destroy(new Error("forced stream failure"));
          });
          return owned;
        };
        syncBuiltinESMExports();
        const { supervise } = await import(${JSON.stringify(resolve("scripts/agents/sol-run.mjs"))});
        const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
        const log = openSync(process.argv[2] === "logging" ? "/dev/full" : "/dev/null", "w");
        try {
          const result = await supervise("60s", process.execPath, ["-e", ${JSON.stringify(job)}, process.argv[1], process.argv[3]], { log, capture: true });
          assert.equal(result.status, 1);
          assert.ok(owned.stdout.destroyed && owned.stderr.destroyed);
          assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
        } finally { closeSync(log); }
      `;
      try {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", harness, pidFile, failure, stream], { encoding: "utf8", timeout: 10_000 });
        assert.equal(result.status, 0, `${failure}/${stream}: ${result.stderr}`);
        assert.match(result.stderr, failure === "logging" ? /ENOSPC/ : /forced stream failure/);
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
        try {
          const [leader]: number[] = JSON.parse(readFileSync(pidFile, "utf8"));
          process.kill(-leader, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
        }
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
