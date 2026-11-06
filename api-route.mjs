// The opt-in API credit route: the kit's headless Claude calls (kit review, kit fix, kit slice builders, kit ux) can
// run on an Anthropic API key instead of the subscription. It is off unless KIT_API_KEY_FILE names a file (absolute
// path, mode 600, one line, the key). Only the child process (claude-api-run.sh) passes the key on to claude; this file
// reads the key file's first line only to see that it is not blank, and never keeps, returns, prints or logs it, nor puts it
// in an environment or on a command line. Each run adds one line to a local
// spend log.
import { accessSync, appendFileSync, constants, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const home = env => env.HOME || homedir();

/**
 * The state of the route: { on, keyFile, configDir, problem } (problem is plain words, null when the route is usable).
 * The tests are those of claude-api-run.sh, so doctor and the runner never read the switch differently; the key file's
 * first line is read only to see that it is not blank and is never returned.
 */
export function apiRoute(env = process.env) {
  const keyFile = env.KIT_API_KEY_FILE;
  if (!keyFile) return { on: false, keyFile: null, configDir: null, problem: null };
  const configDir = env.KIT_API_CONFIG_DIR || join(home(env), ".claude-api");
  let problem = null;
  try {
    if (!isAbsolute(configDir)) problem = `KIT_API_CONFIG_DIR ${configDir} must be an absolute path`;
    else if (!isAbsolute(keyFile)) problem = `KIT_API_KEY_FILE ${keyFile} must be an absolute path`;
    else {
      const info = statSync(keyFile);
      if (!info.isFile()) problem = `KIT_API_KEY_FILE ${keyFile} is not a file`;
      else if (info.mode & 0o077) problem = `KIT_API_KEY_FILE ${keyFile} can be read by others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`;
      else {
        accessSync(keyFile, constants.R_OK);
        if (!readFileSync(keyFile, "utf8").split("\n")[0].replace(/[ \t\r]/g, "")) problem = `KIT_API_KEY_FILE ${keyFile} is empty`;
      }
    }
  } catch (error) {
    problem = `KIT_API_KEY_FILE ${keyFile} cannot be read (${error.code ?? "error"})`;
  }
  return { on: true, keyFile, configDir, problem };
}

/** The command a headless Claude call runs: the wrapper that reads the key inside the child when the route is on, else claude. */
export function claudeCommand(env = process.env) {
  return apiRoute(env).on ? join(import.meta.dirname, "claude-api-run.sh") : "claude";
}

/** Where the spend log lives: <state home>/agent-kit/api-spend.log. */
export function apiSpendLog(env = process.env) {
  return join(env.XDG_STATE_HOME || join(home(env), ".local/state"), "agent-kit/api-spend.log");
}

/**
 * Adds one line to the spend log for a finished headless Claude call when the route is on: time, what ran, model, the
 * tokens and cost the CLI printed (claude -p --output-format json), whether it worked. Never throws, never holds a secret.
 */
export function recordApiSpend({ env = process.env, command, model, stdout, status }) {
  // A call the wrapper refused never reached the API: no line.
  const route = apiRoute(env);
  if (!route.on || route.problem) return null;
  let result = {};
  try { result = JSON.parse(stdout ?? "") ?? {}; } catch { /* No JSON (a failed call): the line still says it ran. */ }
  if (typeof result !== "object") result = {};
  const usage = result.usage ?? {};
  const number = value => (Number.isFinite(value) ? value : undefined);
  const line = {
    time: new Date().toISOString(), command, model,
    input_tokens: number(usage.input_tokens), output_tokens: number(usage.output_tokens),
    cache_read_tokens: number(usage.cache_read_input_tokens), cache_write_tokens: number(usage.cache_creation_input_tokens),
    cost_usd: number(result.total_cost_usd), ok: status === 0 && !result.is_error,
  };
  try {
    const file = apiSpendLog(env);
    mkdirSync(join(file, ".."), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch { /* A log that cannot be written never stops a run. */ }
  return line;
}

/** Totals from the spend log: { runs, failed, unknownCost, costUsd, inputTokens, outputTokens }, or null when there is no log. */
export function apiSpendTotal(env = process.env) {
  let text;
  try { text = readFileSync(apiSpendLog(env), "utf8"); } catch { return null; }
  const total = { runs: 0, failed: 0, unknownCost: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const row of text.split("\n")) {
    let line;
    try { line = JSON.parse(row); } catch { continue; }
    if (!line || typeof line !== "object") continue;
    total.runs++;
    if (line.ok === false) total.failed++;
    if (line.cost_usd === undefined) total.unknownCost++;
    total.costUsd += line.cost_usd ?? 0;
    total.inputTokens += (line.input_tokens ?? 0) + (line.cache_read_tokens ?? 0) + (line.cache_write_tokens ?? 0);
    total.outputTokens += line.output_tokens ?? 0;
  }
  return total;
}

/** The doctor's report: { state: "off" | "ok" | "problem", text } in plain words; the key is never shown. */
export function apiRouteReport(env = process.env) {
  const route = apiRoute(env);
  if (!route.on) return { state: "off", text: "off (headless Claude calls use the subscription; KIT_API_KEY_FILE turns the API route on)" };
  if (route.problem) return { state: "problem", text: `on, but ${route.problem}` };
  const total = apiSpendTotal(env);
  const spent = total
    ? `${total.runs} run${total.runs === 1 ? "" : "s"} logged${total.failed ? ` (${total.failed} failed)` : ""}, ${total.unknownCost ? "at least " : ""}$${total.costUsd.toFixed(2)} spent${total.unknownCost ? ` (${total.unknownCost} run${total.unknownCost === 1 ? "" : "s"} with no cost printed)` : ""}, ${total.inputTokens} tokens in, ${total.outputTokens} out`
    : "no runs logged yet";
  return { state: "ok", text: `on: key file ${route.keyFile} (mode ${(statSync(route.keyFile).mode & 0o777).toString(8)}), config folder ${route.configDir}; ${spent}` };
}

/**
 * A plain problem line for a failed headless Claude call on the API route: the wrapper's own refusal, or an empty API
 * account ("Credit balance is too low"); null otherwise, or while the route is off.
 */
export function apiRouteProblem(stdout, log, env = process.env) {
  if (!apiRoute(env).on) return null;
  const refusal = /^claude-api-run: (.+)$/m.exec(log ?? "")?.[1];
  if (refusal) return `problem: API route: ${refusal}`;
  if (/credit balance is too low/i.test(`${stdout ?? ""}\n${log ?? ""}`)) return "problem: Claude out of credit: API credit is used up (Credit balance is too low); unset KIT_API_KEY_FILE to go back to the subscription";
  return null;
}
