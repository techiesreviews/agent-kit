import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { reviewBrief, reviewComplete, reviewFormat } from "../scripts/agents/review-brief.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { unitSummary } from "../scripts/agents/unit-summary.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { agentInvocation, buildContract, claudeResult, codexModelMatches, inferCli, parseAgentArgs, reviewBase } from "../scripts/agents/agent-run.mjs";
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
    assert.deepEqual(call.args, ["-p", "--model", "claude-opus-5-5", "--effort", "low", "--permission-mode", kind === "build" ? "acceptEdits" : "plan",
      ...(kind === "build" ? ["--add-dir", "/shared git"] : ["--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
      "--output-format", "json"]);
    assert.equal(call.finish(JSON.stringify({ modelUsage: { "claude-opus-5-5": {} }, result: "report" })), "report");
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
  const invalid = invoke("agent.sh", ["build", wt, join(dir, "missing.md")]);
  assert.equal(invalid.status, 2);
  assert.equal(existsSync(join(wt, ".scratch/agent/build/brief.md")), false);
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
  assert.match(brief, /author already ran check\/test\/lint and the touched specs; do not report inability to run tests/);
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
