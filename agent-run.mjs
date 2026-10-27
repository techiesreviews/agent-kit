#!/usr/bin/env node
// Adapters accept {kind, worktree, model, effort}, git common dir and output path.
// Return {command, args, env, capture, finish(stdout, runLog, status)}. Commands read the brief
// on stdin with cwd=worktree; finish verifies the actual model and returns final
// text (Claude, Grok, OpenCode), or null when the CLI already wrote out.md (Codex) or
// left no report to verify (a failed OpenCode call). An adapter may add usageLimit(stdout)
// for a refusal its CLI prints as JSON, and lines: true when a captured CLI prints one JSON
// event per line, so the runner reads its session from new lines only. The shared
// runner owns logs, the build contract, deadlines, process groups and Git status.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { durationMilliseconds, supervise } from "./sol-run.mjs";
import { reviewComplete, reviewFormat, reviewScope } from "./review-brief.mjs";

const adapters = { codex: codexAdapter, claude: claudeAdapter, grok: grokAdapter, opencode: opencodeAdapter };
const reviewOnly = { grok: "Grok", opencode: "OpenCode" };

export function inferCli(model) {
  if (/^grok-/i.test(model)) return "grok";
  // Case matters: the model check compares OpenCode's provider/model exactly.
  if (/^opencode\/./.test(model)) return "opencode";
  return /^(claude-|(?:opus|sonnet|haiku|fable)$)/i.test(claudeModelName(model)) ? "claude" : "codex";
}

// Model families on outside plans. Claude and OpenCode (free models) have no family here: they are never budgeted.
const families = { codex: "gpt", grok: "grok" };

export function reviewFamily(cli) {
  return families[cli] ?? null;
}

function claudeModelName(model) {
  return model.replace(/\[1m\]$/i, "");
}

export function reviewBase(brief, explicit, worktree = process.cwd()) {
  return reviewScope(brief, { base: explicit }, worktree).base;
}

export function parseAgentArgs(args, env = {}) {
  if (args[0] === "--resume" && args[1] && !args[1].startsWith("--") &&
      (args.length === 2 || (args.length === 4 && args[2] === "--brief" && args[3] && !args[3].startsWith("--")))) {
    return { resume: resolve(args[1]), ...(args.length === 4 ? { resumeBrief: resolve(args[3]) } : {}) };
  }
  const [kind, worktree, brief, ...flags] = args;
  if (!["build", "review"].includes(kind) || !worktree || !brief) {
    throw new Error("Usage: agent.sh build|review <worktree> <brief> [--model M] [--cli codex|claude|grok|opencode] [--effort E] [--base REF | --commit SHA] [--out DIR]; agent.sh --resume <out-dir> [--brief FILE]");
  }
  const options = { kind, worktree, brief, model: env[kind === "build" ? "ASE_BUILD_MODEL" : "ASE_REVIEW_MODEL"] || "claude-opus-5-5", effort: "medium" };
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
  if (reviewOnly[options.cli] && kind !== "review") throw new Error(`${reviewOnly[options.cli]} runs reviews only; pick a Codex or Claude builder`);
  if (!options.model.trim() || options.model.startsWith("-") || /[\r\n]/.test(options.model)) throw new Error("Invalid model");
  if (options.cli === "opencode") {
    // The model check compares OpenCode's provider/model, so a bare name could never pass.
    if (!/^[^/\s]+\/\S+$/.test(options.model)) throw new Error(`OpenCode needs a provider/model such as opencode/deepseek-v4.1-flash-free, not ${options.model}`);
    // OpenCode's --variant names differ by provider, so a given effort (kit ux always
    // passes one) is ignored and none is recorded.
    options.effort = null;
  }
  // Effort levels belong to each CLI/model; pass new levels through unchanged.
  if (options.effort !== null && !/^[a-z][a-z0-9_-]*$/.test(options.effort)) throw new Error(`Invalid effort: ${options.effort}`);
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

// Codex prints a header block ("OpenAI Codex v…", "--------", settings, "--------") at the
// start of each run and each resume. Only those blocks name the model: file contents the
// agent reads later can contain lines such as "  model: monaco.editor.ITextModel;".
function codexHeaders(log) {
  const lines = log.split(/\r?\n/), headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^OpenAI Codex v/.test(lines[i]) || lines[i + 1]?.trim() !== "--------") continue;
    for (let j = i + 2; j < lines.length && lines[j].trim() !== "--------"; j++) headers.push(lines[j]);
  }
  return headers.length ? headers.join("\n") : log;
}

export function codexModelMatches(log, requested) {
  const models = [...codexHeaders(log).matchAll(/^[\t ]*model:[\t ]*(\S+)[\t ]*\r?$/gm)].map(match => match[1]);
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
  if (!models.some(model => claudeModelMatches(model, requested)) ||
      !models.every(model => claudeModelMatches(model, requested) || model.startsWith("claude-haiku-"))) {
    throw new Error(`Claude result does not name requested model ${requested} (actual: ${models.join(", ") || "missing"})`);
  }
  if (allowEmpty && result.result == null) return "";
  if (typeof result.result !== "string" || (!allowEmpty && !result.result.trim())) throw new Error("Claude returned no final report");
  return result.result;
}

// Grok reports the variant it serves (grok-4.7-build for grok-4.7): accept the
// requested name, alone or followed by any -suffix, never a different version or family.
export function grokModelMatches(actual, requested) {
  const name = actual.toLowerCase(), wanted = requested.toLowerCase();
  return name === wanted || name.startsWith(`${wanted}-`);
}

export function grokResult(stdout, requested) {
  const result = JSON.parse(stdout);
  const models = Object.keys(result.modelUsage ?? {});
  if (!models.length || !models.every(model => grokModelMatches(model, requested))) {
    throw new Error(`Grok result does not name requested model ${requested} (actual: ${models.join(", ") || "missing"})`);
  }
  // An empty review falls through to the runner's one completeness retry.
  if (typeof result.text !== "string") throw new Error("Grok returned no final report");
  return result.text;
}

// opencode run --format json prints one event per line, each naming its session; other lines are skipped.
function opencodeEvents(stdout) {
  return stdout.split(/\r?\n/).flatMap(line => {
    try { const event = JSON.parse(line); return isRecord(event) ? [event] : []; } catch { return []; }
  });
}

function opencodeSession(stdout) {
  return opencodeEvents(stdout).find(event => typeof event.sessionID === "string")?.sessionID;
}

function opencodeError(error) {
  return String(error?.data?.message ?? error?.message ?? error?.name ?? "unknown error");
}

const opencodeLimitPattern = /usage limit|rate.?limit|too many requests|quota|insufficient (?:credit|balance)|FreeUsageLimit/i;

// OpenCode reports a refused request as an error event (HTTP 429 or a limit message), not a closing line.
export function opencodeUsageLimit(stdout) {
  const error = opencodeEvents(stdout).filter(event => event.type === "error").map(event => event.error)
    .find(error => error?.data?.statusCode === 429 || opencodeLimitPattern.test(`${error?.name ?? ""} ${opencodeError(error)}`));
  return error ? `problem: opencode usage limit: ${opencodeError(error)}` : null;
}

// The events never name the model; the session export does, per assistant message, as
// provider and model ID. Every answer in the session, retries included, must be the
// requested provider/model. The report is the text of the last message that has text.
// exportSession(id) returns the export's output. A run that printed an error event, or whose
// call failed (non-zero exit or timeout), is not exported and gives no report (null).
export function opencodeResult(stdout, requested, exportSession, failed = false) {
  const events = opencodeEvents(stdout);
  const error = events.find(event => event.type === "error");
  if (error) throw new Error(`OpenCode reported an error: ${opencodeError(error.error)}`);
  if (failed) return null;
  const id = opencodeSession(stdout);
  if (!id) throw new Error("OpenCode printed no session");
  const exported = exportSession(id), start = exported.indexOf("{");
  if (start < 0) throw new Error(`OpenCode export for ${id} printed no JSON`);
  let session;
  try { session = JSON.parse(exported.slice(start)); }
  catch (cause) { throw new Error(`OpenCode export for ${id} is not JSON: ${cause.message}`); }
  const models = (session.messages ?? []).filter(message => message.info?.role === "assistant")
    .map(({ info }) => `${info.providerID}/${info.modelID}`);
  if (!models.length || !models.every(model => model === requested)) {
    throw new Error(`OpenCode session does not name requested model ${requested} (actual: ${[...new Set(models)].join(", ") || "missing"})`);
  }
  const texts = events.filter(event => event.type === "text" && typeof event.part?.text === "string").map(event => event.part);
  const last = texts.at(-1)?.messageID;
  // An empty review falls through to the runner's one completeness retry.
  return texts.filter(part => part.messageID === last).map(part => part.text).join("\n");
}

const usageLimitPattern = /^(?:ERROR:[\t ]*|■[\t ]*)?you['’]ve hit your usage limit\b.*?\btry again at ([^\n]+?)\.?[\t ]*$/i;

// Providers stop plan users with a usage-limit error line; report when it lifts.
// Only the CLI's own closing lines count: earlier output may quote the phrase.
export function usageLimitProblem(text, cli) {
  const time = text.split(/\r?\n/).filter(line => line.trim()).slice(-5).reverse()
    .map(line => line.match(usageLimitPattern)?.[1]).find(Boolean);
  return time ? `problem: ${reviewFamily(cli) ?? cli} usage limit until ${time}` : null;
}

// A refusal spent no review only when it is all the call printed. The log holds both
// streams: Codex logs nothing after its echo of the prompt but its own warnings and the
// limit line, Grok logs the limit line alone. Any work before the limit means quota was used.
export function refusedOutright(cli, log, prompt) {
  let output = log;
  if (cli === "codex") {
    const echo = `\nuser\n${prompt.trimEnd()}`, start = log.indexOf(echo);
    if (start < 0) return false;
    output = log.slice(start + echo.length);
  }
  const lines = output.split(/\r?\n/).filter(line => line.trim());
  return lines.some(line => usageLimitPattern.test(line)) &&
    lines.every(line => usageLimitPattern.test(line) || /^warning: `/.test(line));
}

export const reviewBudgetDefaults = { gpt: 12, grok: 8 };

export function isoWeek(date = new Date()) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() + 4 - (day.getUTCDay() || 7));
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function reviewBudgetLimit(family, env = process.env) {
  const name = `ASE_REVIEW_BUDGET_${family.toUpperCase()}`, value = env[name];
  if (value === undefined || value === "") return reviewBudgetDefaults[family];
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a whole number of reviews per week`);
  return Number(value);
}

// One writer at a time: a lock folder beside the file, waited for up to ASE_REVIEW_BUDGET_LOCK_MS
// (or waitMs). A lock still held at the deadline throws an error with code ELOCKED.
export function withReviewLock(path, action, env = process.env, waitMs = undefined) {
  mkdirSync(dirname(path), { recursive: true });
  const wait = waitMs ?? Number(env.ASE_REVIEW_BUDGET_LOCK_MS || 10_000);
  if (!Number.isSafeInteger(wait) || wait <= 0) throw new Error("ASE_REVIEW_BUDGET_LOCK_MS must be a positive integer");
  const lock = `${path}.lock`, deadline = Date.now() + wait;
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) throw Object.assign(new Error(`review budget lock ${lock} is held; remove it if no review is starting`), { code: "ELOCKED" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try { return action(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

export function readReviewLedger(path) {
  if (!existsSync(path)) return {};
  let ledger;
  try { ledger = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`review budget ledger ${path} is not valid JSON: ${error.message}; fix or delete it`); }
  if (typeof ledger !== "object" || ledger === null || Array.isArray(ledger)) {
    throw new Error(`review budget ledger ${path} is not a JSON object; fix or delete it`);
  }
  return ledger;
}

function withLedger(path, change, env = process.env) {
  return withReviewLock(path, () => {
    const ledger = readReviewLedger(path);
    const result = change(ledger);
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(ledger, null, 2) + "\n", { flag: "wx" });
      renameSync(temporary, path);
    } finally { rmSync(temporary, { force: true }); }
    return result;
  }, env);
}

// The machine ledger keeps { week: { family: { project: count } } }; a family's use is the sum over projects.
export function familyUse(ledger, week, family) {
  return Object.values(ledger[week]?.[family] ?? {}).reduce((sum, count) => sum + (Number.isSafeInteger(count) ? count : 0), 0);
}

const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);

// One week's counts for a family in the machine ledger at path, made empty when missing; a wrong shape is named.
export function projectCounts(ledger, week, family, path) {
  const families = (ledger[week] ??= {});
  if (!isRecord(families)) throw new Error(`review budget ledger ${path} ${week} is not { "<family>": { "<project>": <count> } }; fix or delete it`);
  const counts = (families[family] ??= {});
  if (!isRecord(counts)) throw new Error(`review budget ledger ${path} ${week} ${family} is not { "<project>": <count> }; fix or delete it`);
  return counts;
}

// Moves a project's old per-project ledger ({ week: { family: count } }) into the machine ledger once,
// returning what moved ({ old, text }) or null. The machine lock is held, so the old file's lock is
// only tried briefly: when it is held (an older kit writing, or a stale lock) this review skips the
// move and the next one tries again. The old file is removed before the machine ledger is written,
// so a crash between the two loses those counts rather than counting them twice; a write that fails
// puts them back (restoreLegacyLedger).
function moveLegacyLedger(ledger, path, legacy, project, env) {
  if (!legacy || !existsSync(legacy)) return null;
  try {
    return withReviewLock(legacy, () => {
      const text = readFileSync(legacy, "utf8"), old = readReviewLedger(legacy);
      // Every count is checked before anything merges, so a broken file is named and kept.
      for (const [week, families] of Object.entries(old)) {
        if (!isRecord(families)) throw new Error(`review budget ledger ${legacy} ${week} is not { "<family>": <count> }; fix or delete it`);
        for (const [family, count] of Object.entries(families)) {
          if (!Number.isSafeInteger(count) || count < 0) throw new Error(`review budget ledger ${legacy} ${week} ${family} is not a count; fix or delete it`);
        }
      }
      for (const [week, families] of Object.entries(old)) {
        for (const [family, count] of Object.entries(families)) {
          if (!count) continue;
          const counts = projectCounts(ledger, week, family, path);
          counts[project] = (counts[project] ?? 0) + count;
        }
      }
      rmSync(legacy, { force: true });
      return { old, text };
    }, env, 200);
  } catch (error) {
    if (error.code === "ELOCKED") return null;
    throw error;
  }
}

// Puts moved counts back in the old file when the machine ledger could not be written: as they were
// when the file is still gone, else added to what an older kit wrote there since.
function restoreLegacyLedger(legacy, { old, text }, env) {
  withReviewLock(legacy, () => {
    if (!existsSync(legacy)) return writeFileSync(legacy, text);
    const current = readReviewLedger(legacy);
    for (const [week, families] of Object.entries(old)) {
      for (const [family, count] of Object.entries(families)) {
        const now = current[week]?.[family];
        (current[week] = isRecord(current[week]) ? current[week] : {})[family] = (Number.isSafeInteger(now) ? now : 0) + count;
      }
    }
    writeFileSync(legacy, JSON.stringify(current, null, 2) + "\n");
  }, env);
}

// Counts one review for an outside family in this ISO week, refusing at the limit. The ledger
// ({ path, project, legacy }) is the machine's; legacy names the project's old ledger to move in.
// Returns null for Claude, which is never counted.
export function reserveReviewBudget({ path, project, legacy }, cli, env = process.env, date = new Date()) {
  const family = reviewFamily(cli);
  if (!family) return null;
  if (typeof project !== "string" || !project) throw new Error("review budget needs the project name");
  const limit = reviewBudgetLimit(family, env), week = isoWeek(date);
  // Last week stays for the Tuesday sweep; older weeks go so the ledger stays small.
  const lastWeek = isoWeek(new Date(date.getTime() - 7 * 86_400_000));
  let moved = null, result;
  try {
    result = withLedger(path, ledger => {
      // A broken count stops here, before the old file moves in.
      projectCounts(ledger, week, family, path);
      moved = moveLegacyLedger(ledger, path, legacy, project, env);
      // Weeks in date order: a moved-in old week may have landed after this one.
      for (const old of Object.keys(ledger).sort()) {
        const counts = ledger[old];
        delete ledger[old];
        if (old >= lastWeek) ledger[old] = counts;
      }
      const used = familyUse(ledger, week, family);
      // A refusal still saves the ledger, so counts just moved in are kept.
      if (used >= limit) return { refused: `${family} review budget used up: ${used}/${limit} in ${week}; raise ASE_REVIEW_BUDGET_${family.toUpperCase()} to override` };
      const counts = projectCounts(ledger, week, family, path);
      counts[project] = (counts[project] ?? 0) + 1;
      return { family, week, used: used + 1, limit, project };
    }, env);
  } catch (error) {
    if (moved) {
      try { restoreLegacyLedger(legacy, moved, env); }
      catch (restore) { error.message += `; the moved counts could not be put back in ${legacy}: ${restore.message}`; }
    }
    throw error;
  }
  if (result.refused) throw new Error(result.refused);
  return result;
}

// Returns a reservation whose review never reached the model.
export function releaseReviewBudget(path, { family, week, project }, env = process.env) {
  withLedger(path, ledger => {
    const counts = ledger[week]?.[family];
    if (counts?.[project] > 0) counts[project] -= 1;
  }, env);
}

export function codexAdapter(options, common, output) {
  const { kind, worktree, model, effort } = options;
  return {
    command: "codex", capture: false,
    env: options.codexHome ? { CODEX_HOME: options.codexHome } : {},
    args: ["exec", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-s", kind === "build" ? "workspace-write" : "read-only",
      ...(kind === "build" ? ["-c", "sandbox_workspace_write.network_access=true", "--add-dir", common] : []),
      "--dangerously-bypass-hook-trust", "-C", worktree, "-o", output, "-"],
    resume: session => ["exec", "resume", "-m", model, "-c", `model_reasoning_effort=${effort}`, "-c", `sandbox_mode="${kind === "build" ? "workspace-write" : "read-only"}"`,
      ...(kind === "build" ? ["-c", "sandbox_workspace_write.network_access=true", "-c", `sandbox_workspace_write.writable_roots=[${JSON.stringify(common)}]`] : []),
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
      ...(kind === "build" ? ["--allowedTools", "Bash", "--disallowedTools", "Task,Agent", "--add-dir", common] : ["--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
      "--output-format", "json", ...(options.sessionId ? ["--session-id", options.sessionId] : [])],
    // A resumed session keeps its id; --session-id would demand --fork-session.
    resume: session => [...claudeAdapter({ ...options, sessionId: undefined }, common).args, "--resume", session],
    session: stdout => JSON.parse(stdout).session_id,
    finish: stdout => claudeResult(stdout, model, kind === "review"),
  };
}

export function grokAdapter(options) {
  const { kind, worktree, model, effort } = options;
  if (kind !== "review") throw new Error("Grok runs reviews only");
  // The read-only sandbox and a read-only tool list keep the reviewer from editing.
  const args = ["--prompt-file", "/dev/stdin", "-m", model.toLowerCase(), "--reasoning-effort", effort, "--output-format", "json",
    "--sandbox", "read-only", "--tools", "read_file,grep,list_dir", "--no-subagents", "--disable-web-search", "--cwd", worktree];
  return {
    command: "grok", capture: true,
    args: [...args, ...(options.sessionId ? ["-s", options.sessionId] : [])],
    resume: session => [...args, "--resume", session],
    session: stdout => JSON.parse(stdout).sessionId,
    finish: stdout => grokResult(stdout, model),
  };
}

// OpenCode reviews run as a custom agent allowed only to read, search and list; every
// other tool (edit, write, bash, web, tasks, skills) is denied and so never offered.
export const opencodeReviewAgent = "ase-review";
export const opencodeReviewConfig = JSON.stringify({ agent: { [opencodeReviewAgent]: { mode: "primary", description: "Read-only kit review",
  permission: { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow" } } } });

export function opencodeAdapter(options) {
  const { kind, worktree, model } = options;
  if (kind !== "review") throw new Error("OpenCode runs reviews only");
  const timeout = opencodeExportTimeout();
  // --pure drops plugins; the project's own OpenCode config and Claude Code files are not read.
  // Effort is not passed: OpenCode's --variant names differ by provider.
  const args = ["run", "--pure", "--agent", opencodeReviewAgent, "--format", "json", "-m", model, "--dir", worktree];
  return {
    // Each event is one line and the first names the session, so the runner reads it line by line.
    command: "opencode", capture: true, lines: true,
    env: { OPENCODE_CONFIG_CONTENT: opencodeReviewConfig, OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1" },
    args,
    resume: session => [...args, "--session", session],
    session: stdout => opencodeSession(stdout),
    usageLimit: stdout => opencodeUsageLimit(stdout),
    finish: (stdout, _log, status) => opencodeResult(stdout, model, session => opencodeExport(session, worktree, timeout), Boolean(status)),
  };
}

// The export runs after the supervised call, so it has its own limit: ASE_OPENCODE_EXPORT_TIMEOUT_MS (60000),
// checked when the adapter is made, before the review starts. It runs synchronously: the
// supervised call has ended, so the runner has nothing else to do while it waits.
export function opencodeExportTimeout(env = process.env) {
  const timeout = Number(env.ASE_OPENCODE_EXPORT_TIMEOUT_MS || 60_000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("ASE_OPENCODE_EXPORT_TIMEOUT_MS must be a positive integer");
  return timeout;
}

// OpenCode exits before a pipe drains, cutting a large export at 192 KiB, so it writes to a file.
function opencodeExport(session, worktree, timeout) {
  const dir = mkdtempSync(join(tmpdir(), "ase-opencode-export-")), file = join(dir, "export.json");
  const out = openSync(file, "w");
  try {
    execFileSync("opencode", ["export", "--pure", session], { cwd: worktree, encoding: "utf8", stdio: ["ignore", out, "pipe"],
      timeout, killSignal: "SIGKILL" });
    return readFileSync(file, "utf8");
  } catch (error) {
    const last = String(error.stderr || "").trim().split("\n").at(-1);
    const why = error.code === "ETIMEDOUT" || error.signal === "SIGKILL" ? `timed out after ${timeout} ms`
      : error.status ? `exit ${error.status}${last ? `: ${last}` : ""}` : error.message;
    throw new Error(`OpenCode export for ${session} failed: ${why}`);
  } finally {
    closeSync(out);
    rmSync(dir, { recursive: true, force: true });
  }
}

export function agentInvocation(options, common, output) {
  return adapters[options.cli](options, common, output);
}

export const buildContract = `
## Build contract
Leave changes unstaged. Do not commit, push, deploy, spawn agents or use git stash.
Run focused unit files for the change (scripts/agents/kit unit --affected; if unavailable, scripts/agents/unit.sh <files>), npm run check when types moved, npm run lint and the ticket's touched specs. kit pr runs the tier's full set.
Final report: at most 15 lines; changed files, behavior, validation and unresolved risks.
`;

function writeStatus(path, status, changes = {}) {
  Object.assign(status, changes, { updated: new Date().toISOString() });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(status, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function finalState(code) {
  if (code === 0) return "done";
  if (code === 124) return "timeout";
  if ([129, 130, 143].includes(code)) return "interrupted";
  return "failed";
}

function disconnected(error) {
  return error.code === "EPIPE" || error.code === "EIO";
}

function print(stream, text) {
  try { stream.write(text); } catch (error) { if (!disconnected(error)) throw error; }
}

function printReport(out) {
  const output = join(out, "out.md");
  if (existsSync(output)) print(process.stdout, readFileSync(output, "utf8"));
}

function liveRunner(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    const command = process.platform === "linux" ? readFileSync(`/proc/${pid}/cmdline`, "utf8")
      : execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" });
    return command.includes("agent-run.mjs");
  } catch { return false; }
}

function readStatus(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// Claims are resume-claim-<generation>.<attempt>, linked into place complete, so
// exactly one caller restarts a dead run and none is ever half-written. A claim
// whose holder died before publishing its status is superseded by the next attempt.
function tryClaim(claim) {
  const temporary = `${claim}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${process.pid}\n`, { flag: "wx" });
    linkSync(temporary, claim);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally { rmSync(temporary, { force: true }); }
}

function claimResume(out, path, generation) {
  for (let attempt = 0; ; attempt++) {
    const claim = join(out, `resume-claim-${generation}.${attempt}`);
    if (tryClaim(claim)) return { won: true };
    const holder = Number(readFileSync(claim, "utf8"));
    if (liveRunner(holder) || readStatus(path).resumes >= generation) return { won: false, holder };
  }
}

// Follow the claimed generation to its end; null means its runner died first.
async function followGeneration(out, path, generation, holder, interval) {
  for (;;) {
    const current = readStatus(path);
    if (current.resumes > generation) return null;
    if (current.resumes === generation) {
      if (current.state !== "running") {
        printReport(out);
        return { code: current.exitCode ?? 1 };
      }
      if (!liveRunner(current.pid)) return null;
    } else if (!liveRunner(holder)) return null;
    await pause(interval);
  }
}

async function resumeRun(out, brief) {
  // Validate before claiming a generation or changing the saved run's status.
  const resumePrompt = brief === undefined ? undefined : readFileSync(brief, "utf8");
  const path = join(out, "status.json");
  const interval = Number(process.env.ASE_RESUME_POLL_MS || 2000);
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("ASE_RESUME_POLL_MS must be a positive integer");
  for (;;) {
    let previous = readStatus(path);
    if (liveRunner(previous.pid)) {
      const pid = previous.pid;
      print(process.stdout, `waiting: pid ${pid}\n`);
      while (liveRunner(pid)) await pause(interval);
      previous = readStatus(path);
      if (previous.pid !== pid) continue;
      if (previous.state !== "running" && brief === undefined) {
        printReport(out);
        return previous.exitCode ?? 1;
      }
    }
    if (previous.state === "done" && brief === undefined) { printReport(out); return 0; }
    if (!previous.session) {
      print(process.stderr, `problem: no session id recorded in ${path}; rerun instead\n`);
      return 1;
    }
    if (previous.cli === "codex" && previous.kind === "review") {
      print(process.stderr, "problem: cannot resume a Codex review; its temporary CODEX_HOME was removed; rerun instead\n");
      return 1;
    }
    const generation = previous.resumes + 1;
    const claim = claimResume(out, path, generation);
    if (!claim.won) {
      const followed = await followGeneration(out, path, generation, claim.holder, interval);
      // A competing generation satisfies a plain resume, but cannot account
      // for this caller's new prompt. Queue that request in the next generation.
      if (followed && brief === undefined) return followed.code;
      continue;
    }
    const options = parseAgentArgs([previous.kind, previous.worktree, previous.brief,
      "--model", previous.model, "--cli", previous.cli, ...(previous.effort == null ? [] : ["--effort", previous.effort]),
      ...(previous.base === undefined ? [] : ["--base", previous.base]),
      ...(previous.commit === undefined ? [] : ["--commit", previous.commit]), "--out", out]);
    if (brief !== undefined) {
      options.brief = brief;
      options.resumePrompt = resumePrompt;
    }
    return startRun(options, previous);
  }
}

function preparePrompt(options, brief, out) {
  let prompt = brief;
  if (options.kind === "review") {
    const scope = reviewScope(brief, options, options.worktree);
    const { base, head, label, commit } = scope;
    const diff = join(out, "diff.patch"), commits = join(out, "commits.log"), refs = join(out, "refs.txt");
    const patch = execFileSync("git", ["-C", options.worktree, "diff", ...(commit ? [base, head] : [`${base}...${head}`])], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(diff, patch);
    writeFileSync(commits, execFileSync("git", ["-C", options.worktree, "log", "--oneline", `${base}..${head}`]));
    writeFileSync(refs, `${head}\n${base}\n`);
    if (!patch.length) return { problem: `problem: empty diff for ${label}` };
    prompt = prompt.replaceAll(reviewFormat, "");
    prompt += `\nReview scope: ${label}. Read ${JSON.stringify(diff)} for the diff, ${JSON.stringify(commits)} for git log --oneline ${base}..${head}, and ${JSON.stringify(refs)} for ${commit ? "commit and parent" : "HEAD and base"} SHAs (in that order). These prepared files define the scope; do not run git.\n${reviewFormat}`;
  }
  return { prompt };
}

function recordedSession(adapter, stdout, log) {
  try { return adapter.session(stdout, log); } catch { return null; }
}

export function sessionObserver(adapter, update) {
  const pending = ["", ""];
  let stdout = "", known = null;
  // Only a new session id rewrites status.json.
  const record = session => { if (session && session !== known) update(known = session); };
  return (chunk, isStdout) => {
    if (adapter.capture && !isStdout) return;
    if (adapter.capture && !adapter.lines) {
      stdout += chunk;
      // Claude emits one JSON result. It may span multiple pipe chunks.
      record(recordedSession(adapter, stdout, ""));
      return;
    }
    // A line-by-line capture (OpenCode) names its session once; later lines are not read for it.
    if (adapter.lines && known) return;
    const index = isStdout ? 0 : 1;
    pending[index] += chunk;
    const end = pending[index].lastIndexOf("\n");
    if (end < 0) return;
    const lines = pending[index].slice(0, end + 1);
    pending[index] = pending[index].slice(end + 1);
    record(adapter.capture ? recordedSession(adapter, lines, "") : adapter.session("", lines));
  };
}

async function invokeAgent(adapter, args, descriptor, context) {
  const { options, limit, logPath, log, output, messages, update } = context;
  const previousCalls = context.calls;
  context.calls = previousCalls + 1;
  const previous = Object.fromEntries(Object.keys(adapter.env ?? {}).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, adapter.env);
    const previousLog = readFileSync(logPath, "utf8").length;
    const result = await supervise(limit, adapter.command, args, {
      cwd: options.worktree, input: descriptor, log, capture: adapter.capture,
      onSpawn: pgid => update({ pgid }),
      onOutput: sessionObserver(adapter, session => update({ session })),
    });
    let status = result.status;
    const slice = readFileSync(logPath, "utf8").slice(previousLog);
    const session = recordedSession(adapter, result.stdout, slice);
    if (session) update({ session });
    // The CLI's own failure is the cause; executeRun reports it after its consequences.
    if (status === 124) context.cause = `problem: agent exceeded timeout=${limit}; process group killed; see ${logPath}`;
    else {
      // A refusal OpenCode prints as an error event counts even when the CLI exits 0.
      const limitProblem = adapter.usageLimit?.(result.stdout ?? "") ??
        (status ? usageLimitProblem(slice, options.cli) ?? usageLimitProblem(result.stdout ?? "", options.cli) : null);
      if (status || limitProblem) context.cause = limitProblem ?? `problem: ${adapter.command} failed (${status}); see ${logPath}`;
      // A refusal of the first call refunds the review; a completed first call, or one
      // that worked before the limit, already spent it.
      if (limitProblem && !previousCalls && refusedOutright(options.cli, slice, context.prompt)) update({ refused: true });
    }
    try {
      const report = adapter.finish(result.stdout, slice, status);
      if (report !== null) writeFileSync(output, report + "\n");
    } catch (error) {
      messages.push(`problem: ${error.message}; see ${logPath}`);
      status ||= 1;
    }
    return { ...result, status };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function executeRun(options, out, previous, update, brief) {
  const messages = [];
  const limit = process.env.ASE_AGENT_TIMEOUT || process.env.SOL_TIMEOUT || "90m";
  durationMilliseconds(limit);
  const common = execFileSync("git", ["-C", options.worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
  const prepared = previous ? { prompt: options.resumePrompt ?? "Continue where you stopped; the brief is unchanged." }
    : preparePrompt(options, brief, out);
  if (prepared.problem) return { status: 1, messages: [prepared.problem] };
  const reportPath = join(out, "out.md"), logPath = join(out, "run.log"), inputPath = join(out, `brief-${process.pid}.md`);
  // A resumed Codex report must not truncate the earlier final report.
  const output = previous ? join(out, `resume-${process.pid}-${randomUUID()}.md`) : reportPath;
  const prompt = prepared.prompt + (!previous && options.kind === "build" ? buildContract : "");
  let input, log, reviewHome;
  try {
    writeFileSync(inputPath, prompt);
    rmSync(output, { force: true });
    input = openSync(inputPath, "r");
    log = openSync(logPath, previous ? "a" : "w");
    if (previous) appendFileSync(log, `\n--- resume ${new Date().toISOString()} ---\n`);
    if (options.kind === "review" && options.cli === "codex") {
      reviewHome = makeCodexReviewHome();
      options.codexHome = reviewHome.home;
    }
    const adapter = agentInvocation(options, common, output);
    // A resumed run's first call is not the review's first call, so it never refunds.
    const context = { options, limit, logPath, log, output, messages, update, prompt, calls: previous ? 1 : 0 };
    const invoke = (args, descriptor) => invokeAgent(adapter, args, descriptor, context);
    const complete = () => existsSync(output) && reviewComplete(readFileSync(output, "utf8"));
    const result = await invoke(previous ? adapter.resume(previous.session) : adapter.args, input);
    let status = result.status;
    if (!status && options.kind === "review" && !complete()) {
      // Grok reports no sessionId in some results; fall back to the id passed with -s.
      // Claude still retries only when its result names the session it started.
      const session = recordedSession(adapter, result.stdout, readFileSync(logPath, "utf8")) ??
        (options.cli === "grok" ? previous?.session ?? options.sessionId : undefined);
      if (session) {
        writeFileSync(inputPath, "Your reply must start with the line REVIEW_STATUS: complete. Send the full review again in the required format.\n");
        const retryInput = openSync(inputPath, "r");
        try {
          rmSync(output, { force: true });
          status = (await invoke(adapter.resume(session), retryInput)).status;
        } finally { closeSync(retryInput); }
      }
      if (!complete()) {
        messages.push("problem: result lacks REVIEW_STATUS: complete");
        status ||= 1;
      }
    }
    let report;
    try {
      report = readFileSync(output, "utf8");
      if (!report.trim()) throw new Error("empty report");
      if (previous) appendFileSync(reportPath, report);
    } catch {
      messages.push(`problem: no final report; see ${logPath}`);
      status ||= 1;
    }
    const gitStatus = execFileSync("git", ["-C", options.worktree, "status", "--short"], { encoding: "utf8" });
    // Callers read the last problem line; the CLI's failure explains the rest.
    if (context.cause) messages.push(context.cause);
    return { status, messages, report, gitStatus };
  } finally {
    if (input !== undefined) closeSync(input);
    if (log !== undefined) closeSync(log);
    rmSync(inputPath, { force: true });
    if (previous) rmSync(output, { force: true });
    if (reviewHome) closeCodexReviewHome(reviewHome);
  }
}

async function startRun(options, previous) {
  options.worktree = resolve(options.worktree);
  options.brief = resolve(options.brief);
  // Read a fresh brief before creating any artifacts. Resumes use their saved
  // session (and an optional prompt already read by resumeRun).
  const brief = previous ? undefined : readFileSync(options.brief, "utf8");
  let out;
  if (options.out) out = resolve(options.out);
  else {
    const artifacts = join(options.worktree, ".scratch/agent");
    mkdirSync(artifacts, { recursive: true });
    out = mkdtempSync(join(artifacts, `${options.kind}-${Date.now()}-${process.pid}-`));
  }
  mkdirSync(out, { recursive: true });
  // Claude and Grok report their session id only in the final JSON; assign it up front so
  // a run killed mid-way can still be resumed.
  if (!previous && ["claude", "grok"].includes(options.cli)) options.sessionId = randomUUID();
  const status = {
    pid: process.pid, pgid: null, kind: options.kind, model: options.model, cli: options.cli, effort: options.effort,
    worktree: options.worktree, brief: options.brief, out,
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    started: previous?.started || new Date().toISOString(), state: "running", exitCode: null,
    session: previous?.session ?? options.sessionId ?? null, resumes: previous ? previous.resumes + 1 : 0,
  };
  const update = changes => writeStatus(join(out, "status.json"), status, changes);
  update();
  print(process.stdout, `artifacts: ${out}\n`);
  let code = 2, result;
  try {
    result = await executeRun(options, out, previous, update, brief);
    code = result.status;
  } finally {
    // Persist the result before touching stdout/stderr: the app may be gone.
    update({ state: finalState(code), exitCode: code });
  }
  for (const message of result.messages) print(process.stderr, message + "\n");
  if (result.report) print(process.stdout, result.report);
  if (result.gitStatus) print(process.stdout, result.gitStatus);
  return code;
}

async function run(args) {
  const options = parseAgentArgs(args, process.env);
  return options.resume ? resumeRun(options.resume, options.resumeBrief) : startRun(options);
}

if (import.meta.main) {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", error => { if (!disconnected(error)) throw error; });
  }
  try { process.exitCode = await run(process.argv.slice(2)); }
  catch (error) { print(process.stderr, `problem: ${error.message}\n`); process.exitCode = 2; }
}
