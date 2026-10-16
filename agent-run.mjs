#!/usr/bin/env node
// Adapters accept {kind, worktree, model, effort}, git common dir and output path.
// Return {command, args, env, capture, finish(stdout, runLog)}. Commands read the brief
// on stdin with cwd=worktree; finish verifies the actual model and returns final
// text (Claude), or null when the CLI already wrote out.md (Codex). The shared
// runner owns logs, the build contract, deadlines, process groups and Git status.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { durationMilliseconds, supervise } from "./sol-run.mjs";
import { reviewComplete, reviewFormat, reviewScope } from "./review-brief.mjs";

const adapters = { codex: codexAdapter, claude: claudeAdapter };

export function inferCli(model) {
  return /^(claude-|(?:opus|sonnet|haiku|fable)$)/i.test(claudeModelName(model)) ? "claude" : "codex";
}

function claudeModelName(model) {
  return model.replace(/\[1m\]$/i, "");
}

export function reviewBase(brief, explicit, worktree = process.cwd()) {
  return reviewScope(brief, { base: explicit }, worktree).base;
}

export function parseAgentArgs(args, env = {}) {
  const [kind, worktree, brief, ...flags] = args;
  if (!["build", "review"].includes(kind) || !worktree || !brief) {
    throw new Error("Usage: agent.sh build|review <worktree> <brief> [--model M] [--cli codex|claude] [--effort E] [--base REF | --commit SHA] [--out DIR]");
  }
  const options = { kind, worktree, brief, model: env[kind === "build" ? "ASE_BUILD_MODEL" : "ASE_REVIEW_MODEL"] || "gpt-6.1-sol", effort: "medium" };
  let cli = env.ASE_AGENT_CLI || "";
  const seen = new Set();
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i], value = flags[i + 1];
    if (!["--model", "--cli", "--effort", "--base", "--commit", "--out"].includes(flag) || !value || (value.startsWith("--") && !["--base", "--commit"].includes(flag)) || seen.has(flag)) {
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
  if (options.base !== undefined && options.commit !== undefined) throw new Error("--base and --commit are mutually exclusive");
  return options;
}

// Review sessions disable personal skills, plugins, apps, memories and MCP
// configuration. Builds retain the user's usual Codex home and permissions.
export const codexReviewConfig = `[skills]
include_instructions = false

[skills.bundled]
enabled = false

[features]
plugins = false
apps = false
memories = false
`;

export function makeCodexReviewHome(sourceHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  const sourceAuth = resolve(sourceHome, "auth.json");
  if (!existsSync(sourceAuth)) throw new Error(`no Codex auth at ${sourceAuth}`);
  const home = mkdtempSync(join(tmpdir(), "ase-codex-home-"));
  try {
    symlinkSync(sourceAuth, join(home, "auth.json"));
    writeFileSync(join(home, "config.toml"), codexReviewConfig);
    return { home, sourceAuth };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}

function closeCodexReviewHome({ home, sourceAuth }) {
  try {
    const auth = join(home, "auth.json");
    if (existsSync(auth) && !lstatSync(auth).isSymbolicLink()) {
      // Codex may replace the symlink when rotating a refresh token. Preserve
      // that token atomically before deleting the isolated session directory.
      const temporary = `${sourceAuth}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, readFileSync(auth), { mode: 0o600, flag: "wx" });
        renameSync(temporary, sourceAuth);
      } finally { rmSync(temporary, { force: true }); }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
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

export function claudeResult(stdout, requested, allowEmpty = false) {
  const result = JSON.parse(stdout);
  if (result.is_error || (result.subtype && result.subtype !== "success")) throw new Error("Claude reported an unsuccessful result");
  const models = [...Object.keys(result.modelUsage ?? {}), ...(typeof result.model === "string" ? [result.model] : [])];
  if (!models.length || !models.every(model => claudeModelMatches(model, requested))) {
    throw new Error(`Claude result does not name requested model ${requested} (actual: ${models.join(", ") || "missing"})`);
  }
  if (allowEmpty && result.result == null) return "";
  if (typeof result.result !== "string" || (!allowEmpty && !result.result.trim())) throw new Error("Claude returned no final report");
  return result.result;
}

export function codexAdapter(options, common, output) {
  const { kind, worktree, model, effort } = options;
  return {
    command: "codex", capture: false,
    env: options.codexHome ? { CODEX_HOME: options.codexHome } : {},
    args: ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-s", kind === "build" ? "workspace-write" : "read-only",
      ...(kind === "build" ? ["-c", "sandbox_workspace_write.network_access=true", "--add-dir", common] : []),
      "--dangerously-bypass-hook-trust", "-C", worktree, "-o", output, "-"],
    resume: session => ["exec", "resume", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-c", 'sandbox_mode="read-only"',
      "--dangerously-bypass-hook-trust", "-o", output, session, "-"],
    session: (_stdout, log) => [...log.matchAll(/^session id: (\S+)\s*$/gm)].at(-1)?.[1],
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
    resume: session => [...claudeAdapter(options, common).args, "--resume", session],
    session: stdout => JSON.parse(stdout).session_id,
    finish: stdout => claudeResult(stdout, model, kind === "review"),
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
    const scope = reviewScope(brief, options, options.worktree);
    const { base, head, label, commit } = scope;
    const diff = join(out, "diff.patch"), commits = join(out, "commits.log"), refs = join(out, "refs.txt");
    const patch = execFileSync("git", ["-C", options.worktree, "diff", ...(commit ? [base, head] : [`${base}...${head}`])], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(diff, patch);
    writeFileSync(commits, execFileSync("git", ["-C", options.worktree, "log", "--oneline", `${base}..${head}`]));
    writeFileSync(refs, `${head}\n${base}\n`);
    if (!patch.length) { console.error(`problem: empty diff for ${label}`); return 1; }
    prompt = prompt.replaceAll(reviewFormat, "");
    prompt += `\nReview scope: ${label}. Read ${JSON.stringify(diff)} for the diff, ${JSON.stringify(commits)} for git log --oneline ${base}..${head}, and ${JSON.stringify(refs)} for ${commit ? "commit and parent" : "HEAD and base"} SHAs (in that order). These prepared files define the scope; do not run git.\n${reviewFormat}`;
  }
  writeFileSync(inputPath, prompt + (options.kind === "build" ? buildContract : ""));
  rmSync(output, { force: true });
  const input = openSync(inputPath, "r"), log = openSync(logPath, "w");
  let reviewHome;
  let status = 1;
  try {
    if (options.kind === "review" && options.cli === "codex") {
      reviewHome = makeCodexReviewHome();
      options.codexHome = reviewHome.home;
    }
    const adapter = agentInvocation(options, common, output);
    const invoke = async (args, descriptor) => {
      const previous = Object.fromEntries(Object.keys(adapter.env ?? {}).map(key => [key, process.env[key]]));
      try {
        Object.assign(process.env, adapter.env);
        const previousLog = readFileSync(logPath, "utf8").length;
        const result = await supervise(limit, adapter.command, args, { cwd: options.worktree, input: descriptor, log, capture: adapter.capture });
        status = result.status;
        if (status === 124) console.error(`problem: agent exceeded timeout=${limit}; process group killed; see ${logPath}`);
        else if (status) console.error(`problem: ${adapter.command} failed (${status}); see ${logPath}`);
        try {
          const report = adapter.finish(result.stdout, readFileSync(logPath, "utf8").slice(previousLog));
          if (report !== null) writeFileSync(output, report + "\n");
        } catch (error) {
          console.error(`problem: ${error.message}; see ${logPath}`);
          status ||= 1;
        }
        return result;
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    };
    const complete = () => existsSync(output) && reviewComplete(readFileSync(output, "utf8"));
    const result = await invoke(adapter.args, input);
    if (!status && options.kind === "review" && !complete()) {
      const session = adapter.session(result.stdout, readFileSync(logPath, "utf8"));
      if (session) {
        writeFileSync(inputPath, "Your reply must start with the line REVIEW_STATUS: complete. Send the full review again in the required format.\n");
        const retryInput = openSync(inputPath, "r");
        try {
          rmSync(output, { force: true });
          await invoke(adapter.resume(session), retryInput);
        } finally { closeSync(retryInput); }
      }
      if (!complete()) {
        console.error("problem: result lacks REVIEW_STATUS: complete");
        status ||= 1;
      }
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
    if (reviewHome) closeCodexReviewHome(reviewHome);
  }
}

if (import.meta.main) {
  try { process.exitCode = await run(process.argv.slice(2)); }
  catch (error) { console.error(`problem: ${error.message}`); process.exitCode = 2; }
}
