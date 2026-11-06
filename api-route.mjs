// The opt-in API credit route: the kit's headless Claude calls (kit review, kit fix, kit slice builders, kit ux) can
// run on an Anthropic API key instead of the subscription. It is off unless KIT_API_KEY_FILE names a file (mode 600,
// one line, the key). The key is read only inside the child process (claude-api-run.sh); it is never printed, logged,
// kept in this process's environment or put on a command line. Each run adds one line to a local spend log.
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = env => env.HOME || homedir();

/** The state of the route: { on, keyFile, configDir, problem } (problem is plain words, null when the route is usable). */
export function apiRoute(env = process.env) {
  const keyFile = env.KIT_API_KEY_FILE?.trim();
  if (!keyFile) return { on: false, keyFile: null, configDir: null, problem: null };
  const configDir = env.KIT_API_CONFIG_DIR?.trim() || join(home(env), ".claude-api");
  let problem = null;
  try {
    const info = statSync(keyFile);
    if (!info.isFile()) problem = `KIT_API_KEY_FILE ${keyFile} is not a file`;
    else if (info.mode & 0o077) problem = `KIT_API_KEY_FILE ${keyFile} can be read by others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`;
    else if (info.size === 0) problem = `KIT_API_KEY_FILE ${keyFile} is empty`;
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
  if (!apiRoute(env).on) return null;
  let result = {};
  try { result = JSON.parse(stdout ?? ""); } catch { /* No JSON (a failed call): the line still says it ran. */ }
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

/** Totals from the spend log: { runs, failed, costUsd, inputTokens, outputTokens }, or null when there is no log. */
export function apiSpendTotal(env = process.env) {
  let text;
  try { text = readFileSync(apiSpendLog(env), "utf8"); } catch { return null; }
  const total = { runs: 0, failed: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const row of text.split("\n")) {
    let line;
    try { line = JSON.parse(row); } catch { continue; }
    total.runs++;
    if (line.ok === false) total.failed++;
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
    ? `${total.runs} run${total.runs === 1 ? "" : "s"} logged${total.failed ? ` (${total.failed} failed)` : ""}, $${total.costUsd.toFixed(2)} spent, ${total.inputTokens} tokens in, ${total.outputTokens} out`
    : "no runs logged yet";
  return { state: "ok", text: `on: key file ${route.keyFile} (mode ${(statSync(route.keyFile).mode & 0o777).toString(8)}), config folder ${route.configDir}; ${spent}` };
}
