#!/usr/bin/env node
// Adapters accept {kind, worktree, model, effort}, git common dir and output path.
// Return {command, args, capture, finish(stdout, runLog)}. Commands read the brief
// on stdin with cwd=worktree; finish verifies the actual model and returns final
// text (Claude), or null when the CLI already wrote out.md (Codex). The shared
// runner owns logs, the build contract, deadlines, process groups and Git status.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { durationMilliseconds, supervise } from "./sol-run.mjs";

const adapters = { codex: codexAdapter, claude: claudeAdapter };

export function inferCli(model) {
  return /^(claude-|(?:opus|sonnet|haiku|fable)$)/i.test(claudeModelName(model)) ? "claude" : "codex";
}

function claudeModelName(model) {
  return model.replace(/\[1m\]$/i, "");
}

export function reviewBase(brief, explicit) {
  const base = explicit ?? /\bgit diff ([\w./-]+)\.\.\.HEAD\b/.exec(brief)?.[1] ?? "origin/dev";
  if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new Error("Invalid base ref");
  return base;
}

export function parseAgentArgs(args, env = {}) {
  const [kind, worktree, brief, ...flags] = args;
  if (!["build", "review"].includes(kind) || !worktree || !brief) {
    throw new Error("Usage: agent.sh build|review <worktree> <brief> [--model M] [--cli codex|claude] [--effort E] [--base REF] [--out DIR]");
  }
  const options = { kind, worktree, brief, model: env[kind === "build" ? "ASE_BUILD_MODEL" : "ASE_REVIEW_MODEL"] || "gpt-6.1-sol", effort: "medium" };
  let cli = env.ASE_AGENT_CLI || "";
  const seen = new Set();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i], value = flags[i + 1];
    if (!["--model", "--cli", "--effort", "--base", "--out"].includes(flag) || !value || value.startsWith("--") || seen.has(flag)) {
      throw new Error(`Invalid option: ${flag}`);
    }
    seen.add(flag);
    if (flag === "--cli") cli = value;
    else options[flag.slice(2)] = value;
  }
  options.cli = cli || inferCli(options.model);
  if (!Object.hasOwn(adapters, options.cli)) throw new Error(`Unknown CLI: ${options.cli}; add an adapter first`);
  if (!options.model.trim() || options.model.startsWith("-") || /[\r\n]/.test(options.model)) throw new Error("Invalid model");
  // Effort levels belong to each CLI/model; pass new levels through unchanged.
  if (!/^[a-z][a-z0-9_-]*$/.test(options.effort)) throw new Error(`Invalid effort: ${options.effort}`);
  if (options.base !== undefined) reviewBase("", options.base);
  return options;
}

export function codexModelMatches(log, requested) {
  const models = [...log.matchAll(/^[\t ]*model:[\t ]*(\S+)[\t ]*\r?$/gm)].map(match => match[1]);
  return models.length > 0 && models.every(model => model === requested);
}

export function claudeModelMatches(actual, requested) {
  actual = claudeModelName(actual);
  requested = claudeModelName(requested);
  if (actual === requested) return true;
  // Aliases intentionally select the current member of a family. Full model
  // names allow only the provider's dated snapshot suffix, never another family.
  if (/^(opus|sonnet|haiku|fable)$/.test(requested)) return actual.startsWith(`claude-${requested}-`);
  return actual.startsWith(`${requested}-`) && /^\d{8}$/.test(actual.slice(requested.length + 1));
}

export function claudeResult(stdout, requested) {
  const result = JSON.parse(stdout);
  if (result.is_error || (result.subtype && result.subtype !== "success")) throw new Error("Claude reported an unsuccessful result");
  const models = [...Object.keys(result.modelUsage ?? {}), ...(typeof result.model === "string" ? [result.model] : [])];
  if (!models.length || !models.every(model => claudeModelMatches(model, requested))) {
    throw new Error(`Claude result does not name requested model ${requested} (actual: ${models.join(", ") || "missing"})`);
  }
  if (typeof result.result !== "string" || !result.result.trim()) throw new Error("Claude returned no final report");
  return result.result;
}

export function codexAdapter(options, common, output) {
  const { kind, worktree, model, effort } = options;
  return {
    command: "codex", capture: false,
    args: ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-s", kind === "build" ? "workspace-write" : "read-only",
      ...(kind === "build" ? ["-c", "sandbox_workspace_write.network_access=true", "--add-dir", common] : []),
      "--dangerously-bypass-hook-trust", "-C", worktree, "-o", output, "-"],
    finish: (_stdout, log) => {
      if (!codexModelMatches(log, model)) throw new Error(`run.log does not name requested model ${model}`);
      return null;
    },
  };
}

export function claudeAdapter(options, common) {
  const { kind, model, effort } = options;
  return {
    command: "claude", capture: true,
    args: ["-p", "--model", model, "--effort", effort, "--permission-mode", kind === "build" ? "acceptEdits" : "plan",
      ...(kind === "build" ? ["--add-dir", common] : ["--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
      "--output-format", "json"],
    finish: stdout => claudeResult(stdout, model),
  };
}

export function agentInvocation(options, common, output) {
  return adapters[options.cli](options, common, output);
}

export const buildContract = `
## Build contract
Leave changes unstaged. Do not commit, push, deploy, spawn agents or use git stash.
Run npm run check, npm test and npm run lint, plus the ticket's touched specs.
Final report: at most 15 lines; changed files, behavior, validation and unresolved risks.
`;

async function run(args) {
  const options = parseAgentArgs(args, process.env);
  const limit = process.env.ASE_AGENT_TIMEOUT || process.env.SOL_TIMEOUT || "90m";
  durationMilliseconds(limit);
  options.worktree = resolve(options.worktree);
  const brief = readFileSync(resolve(options.brief), "utf8");
  const common = execFileSync("git", ["-C", options.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const artifacts = join(options.worktree, ".scratch/agent");
  mkdirSync(artifacts, { recursive: true });
  const out = options.out ? resolve(options.out) : mkdtempSync(join(artifacts, `${options.kind}-${Date.now()}-${process.pid}-`));
  mkdirSync(out, { recursive: true });
  console.log(`artifacts: ${out}`);
  const output = join(out, "out.md"), logPath = join(out, "run.log"), inputPath = join(out, `brief-${process.pid}.md`);
  let prompt = brief;
  if (options.kind === "review") {
    const base = reviewBase(brief, options.base);
    const diff = join(out, "diff.patch"), commits = join(out, "commits.log"), refs = join(out, "refs.txt");
    writeFileSync(diff, execFileSync("git", ["-C", options.worktree, "diff", `${base}...HEAD`], { maxBuffer: 64 * 1024 * 1024 }));
    writeFileSync(commits, execFileSync("git", ["-C", options.worktree, "log", "--oneline", `${base}..HEAD`]));
    writeFileSync(refs, execFileSync("git", ["-C", options.worktree, "rev-parse", "HEAD", base]));
    prompt += `\nReview scope: git diff ${base}...HEAD. Read ${JSON.stringify(diff)} for the diff, ${JSON.stringify(commits)} for git log --oneline ${base}..HEAD, and ${JSON.stringify(refs)} for HEAD and base SHAs (in that order). These prepared files define the scope; do not run git.\n`;
  }
  writeFileSync(inputPath, prompt + (options.kind === "build" ? buildContract : ""));
  rmSync(output, { force: true });
  const adapter = agentInvocation(options, common, output);
  const input = openSync(inputPath, "r"), log = openSync(logPath, "w");
  let status = 1;
  try {
    const result = await supervise(limit, adapter.command, adapter.args, { cwd: options.worktree, input, log, capture: adapter.capture });
    status = result.status;
    if (status === 124) console.error(`problem: agent exceeded timeout=${limit}; process group killed; see ${logPath}`);
    else if (status) console.error(`problem: ${adapter.command} failed (${status}); see ${logPath}`);
    try {
      const report = adapter.finish(result.stdout, readFileSync(logPath, "utf8"));
      if (report !== null) writeFileSync(output, report + "\n");
    } catch (error) {
      console.error(`problem: ${error.message}; see ${logPath}`);
      status ||= 1;
    }
    try {
      const report = readFileSync(output, "utf8");
      if (!report.trim()) throw new Error("empty report");
      process.stdout.write(report);
    } catch {
      console.error(`problem: no final report; see ${logPath}`);
      status ||= 1;
    }
    process.stdout.write(execFileSync("git", ["-C", options.worktree, "status", "--short"], { encoding: "utf8" }));
    return status;
  } finally {
    closeSync(input);
    closeSync(log);
    rmSync(inputPath, { force: true });
  }
}

if (import.meta.main) {
  try { process.exitCode = await run(process.argv.slice(2)); }
  catch (error) { console.error(`problem: ${error.message}`); process.exitCode = 2; }
}
