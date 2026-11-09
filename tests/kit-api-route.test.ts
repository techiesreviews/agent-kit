import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { apiRoute, apiRouteProblem, apiRouteReport, apiSpendLog, apiSpendTotal, claudeCommand, recordApiSpend } from "../api-route.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { claudeAdapter } from "../agent-run.mjs";
import { kitEnv } from "./support/kit-env.ts";
// The opt-in API route is read from the environment: these tests run with it off, whatever the shell exports.
delete process.env.KIT_API_KEY_FILE; delete process.env.KIT_API_CONFIG_DIR;

// The opt-in API credit route (Lex, 2026-11-06): off by default; with KIT_API_KEY_FILE set the kit's headless Claude
// calls run through claude-api-run.sh with the key read inside the child; each run adds a line to a local spend log.
// Every key in these tests is a made-up string, and `claude` is a fake on PATH.
const wrapper = resolve("claude-api-run.sh");
const kit = resolve("kit");
const secret = "sk-ant-test-0123456789-not-a-real-key";

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-api-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), home = join(dir, "home"), state = join(dir, "state");
  for (const path of [bin, home, state]) mkdirSync(path);
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  // A fake claude that records what it saw (the key only as a yes/no match) and prints a result like `claude -p --output-format json`.
  const calls = join(dir, "calls.jsonl");
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, keyMatches: process.env.ANTHROPIC_API_KEY === ${JSON.stringify(secret)}, configDir: process.env.CLAUDE_CONFIG_DIR, keyFileVar: process.env.KIT_API_KEY_FILE ?? null, configDirVar: process.env.KIT_API_CONFIG_DIR ?? null, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }) + "\\n");
console.log(JSON.stringify({ result: "ok", modelUsage: { "claude-haiku-5-5": {} }, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, total_cost_usd: 0.0123, session_id: "s" }));
`);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  chmodSync(join(bin, "claude"), 0o755);
  // An empty folder names one more managed-settings folder; a machine with real managed settings still turns the flag on in the tests that expect it off.
  const managed = join(dir, "managed"); mkdirSync(managed);
  const env = { ...kitEnv(), HOME: home, XDG_STATE_HOME: state, KIT_CLAUDE_MANAGED_DIR: managed, PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv;
  delete env.KIT_API_KEY_FILE; delete env.KIT_API_CONFIG_DIR;
  const callList = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { dir, bin, home, state, keyFile, env, callList, managed };
}

test("the route is off unless KIT_API_KEY_FILE is set: claude runs as before", t => {
  const f = folder(t);
  assert.deepEqual(apiRoute(f.env), { on: false, keyFile: null, configDir: null, problem: null });
  assert.equal(claudeCommand(f.env), "claude");
  const adapter = claudeAdapter({ kind: "review", model: "claude-opus-5-5", effort: "medium", sessionId: "x" }, "/common");
  assert.equal(adapter.command, "claude");
  assert.match(apiRouteReport(f.env).text, /^off \(headless Claude calls use the subscription; KIT_API_KEY_FILE turns the API route on\)$/);
  assert.equal(recordApiSpend({ env: f.env, command: "review", model: "m", stdout: "{}", status: 0 }), null);
  assert.ok(!existsSync(apiSpendLog(f.env)), "no log while the route is off");
});

test("with the key file set, claude runs through the wrapper with the key and config folder in its own environment only", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  assert.equal(claudeCommand(env), wrapper);
  const result = spawnSync(wrapper, ["-p", "--model", "haiku", "say ok"], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [call] = f.callList();
  assert.deepEqual(call.args, ["-p", "--model", "haiku", "say ok"]);
  assert.equal(call.keyMatches, true);
  assert.equal(call.configDir, join(f.home, ".claude-api"));
  assert.equal(call.keyFileVar, null, "claude is not told where the key file is");
  assert.equal(call.configDirVar, null, "claude is not given the kit's own switch");
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), "the key is never printed");
  assert.ok(existsSync(join(f.home, ".claude-api")), "the config folder is made");
  // KIT_API_CONFIG_DIR picks another folder.
  const other = join(f.dir, "elsewhere");
  spawnSync(wrapper, ["-p"], { env: { ...env, KIT_API_CONFIG_DIR: other }, encoding: "utf8" });
  assert.equal(f.callList()[1].configDir, other);
});

test("the adapter uses the wrapper only while the route is on, and the key is not in the kit's own environment or arguments", t => {
  const f = folder(t);
  const saved = Object.assign({}, process.env);
  try {
    process.env.KIT_API_KEY_FILE = f.keyFile;
    const adapter = claudeAdapter({ kind: "review", model: "claude-opus-5-5", effort: "medium", sessionId: "x" }, "/common");
    assert.equal(adapter.command, wrapper);
    assert.ok(!JSON.stringify(adapter).includes(secret));
    assert.equal(process.env.ANTHROPIC_API_KEY, saved.ANTHROPIC_API_KEY);
  } finally {
    delete process.env.KIT_API_KEY_FILE;
    Object.assign(process.env, saved);
  }
});

test("a key file others can read, an empty one or a missing one stops the call in plain words, without running claude", t => {
  const f = folder(t);
  const open = join(f.dir, "open-key"); writeFileSync(open, `${secret}\n`); chmodSync(open, 0o644);
  const empty = join(f.dir, "empty-key"); writeFileSync(empty, "", { mode: 0o600 }); chmodSync(empty, 0o600);
  for (const [file, words] of [[open, /can be read by others \(mode 644\); run chmod 600/], [empty, /is empty/], [join(f.dir, "nope"), /cannot be read/]] as const) {
    const result = spawnSync(wrapper, ["-p"], { env: { ...f.env, KIT_API_KEY_FILE: file }, encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, words);
    assert.ok(!result.stderr.includes(secret) && !result.stdout.includes(secret));
    assert.equal(apiRoute({ ...f.env, KIT_API_KEY_FILE: file }).problem === null, false);
  }
  assert.deepEqual(f.callList(), [], "claude never ran");
});

test("each run adds one line to the spend log with the tokens and cost the CLI printed, and never a secret", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  const stdout = JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, total_cost_usd: 0.05, result: "done" });
  recordApiSpend({ env, command: "review", model: "claude-opus-5-5", stdout, status: 0 });
  recordApiSpend({ env, command: "build", model: "claude-opus-5-5", stdout: "not json", status: 1 });
  const log = readFileSync(apiSpendLog(env), "utf8");
  assert.equal(apiSpendLog(env), join(f.state, "agent-kit/api-spend.log"));
  const [first, second] = log.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(first.command, "review"); assert.equal(first.model, "claude-opus-5-5");
  assert.equal(first.input_tokens, 100); assert.equal(first.output_tokens, 20); assert.equal(first.cost_usd, 0.05); assert.equal(first.ok, true);
  assert.match(first.time, /^\d{4}-\d\d-\d\dT/);
  assert.equal(second.ok, false); assert.equal(second.input_tokens, undefined);
  assert.ok(!log.includes(secret) && !log.includes(f.keyFile), "no key and no key file path in the log");
  assert.deepEqual(apiSpendTotal(env), { runs: 2, failed: 1, unknownCost: 1, costUsd: 0.05, inputTokens: 110, outputTokens: 20 });
});

test("kit doctor says whether the route is off or on, the key file's mode and the spend total, never the key", t => {
  const f = folder(t);
  const doctor = (extra: NodeJS.ProcessEnv = {}, args: string[] = []) =>
    spawnSync("bash", [kit, "doctor", ...args], { cwd: resolve("."), env: { ...f.env, ...extra, KIT_ROOT: resolve("."), KIT_DOCTOR_SKIP: "help" }, encoding: "utf8", timeout: 60_000 });
  const off = doctor();
  assert.match(off.stdout, /^api route: off \(headless Claude calls use the subscription; KIT_API_KEY_FILE turns the API route on\)$/m, off.stdout);
  assert.doesNotMatch(doctor({}, ["--quiet"]).stdout, /api route/, "quiet doctor stays quiet while the route is off");
  recordApiSpend({ env: { ...f.env, KIT_API_KEY_FILE: f.keyFile }, command: "review", model: "claude-opus-5-5", stdout: JSON.stringify({ result: "done", usage: { input_tokens: 1000, output_tokens: 200 }, total_cost_usd: 1.5 }), status: 0 });
  const on = doctor({ KIT_API_KEY_FILE: f.keyFile });
  assert.match(on.stdout, new RegExp(`^✓ api route: on: key file ${f.keyFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(mode 600\\), config folder ${f.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.claude-api; 1 run logged, \\$1\\.50 spent, 1000 tokens in, 200 out$`, "m"), on.stdout);
  assert.ok(!on.stdout.includes(secret) && !on.stderr.includes(secret));
  chmodSync(f.keyFile, 0o644);
  const unsafe = doctor({ KIT_API_KEY_FILE: f.keyFile });
  assert.match(unsafe.stdout, /^✗ api route: on, but KIT_API_KEY_FILE .* can be read by others \(mode 644\); run chmod 600 on it/m, unsafe.stdout);
  assert.doesNotMatch(unsafe.stdout, /^RESULT: fail doctor .*api route/m, "a broken route is a warning: it must not stop builds that never use it");
  assert.match(unsafe.stdout, /\(optional; only runs on the API route fail\); fix: /);
  assert.ok(!unsafe.stdout.includes(secret));
});

test("a real kit run through agent-run.mjs sends the key to claude only inside the child and logs the spend", async t => {
  const f = folder(t);
  const root = join(f.dir, "work"), out = join(f.dir, "out"), brief = join(f.dir, "brief.md");
  mkdirSync(root); mkdirSync(out); writeFileSync(brief, "Review this.\n");
  const git = (...args: string[]) => { const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); };
  git("init", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "20s", ASE_BUILD_MODEL: "", KIT_TALK_STYLE: "plain" };
  const child = spawn(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-haiku-5-5"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const code = await new Promise<number | null>(done => child.once("close", done));
  assert.equal(code, 0, stdout + stderr);
  const [call] = f.callList();
  assert.equal(call.keyMatches, true);
  assert.equal(call.configDir, join(f.home, ".claude-api"));
  assert.ok(!(stdout + stderr).includes(secret));
  const log = readFileSync(apiSpendLog(env), "utf8");
  const line = JSON.parse(log.trim().split("\n").at(-1)!);
  assert.equal(line.model, "claude-haiku-5-5"); assert.equal(line.command, "build claude"); assert.equal(line.input_tokens, 120); assert.equal(line.cost_usd, 0.0123); assert.equal(line.ok, true);
  assert.ok(!log.includes(secret));
  for (const file of ["run.log", "out.md", "status.json"]) assert.ok(!readFileSync(join(out, file), "utf8").includes(secret), file);
});

test("claude is told to keep the key out of the shell commands a builder starts", t => {
  const f = folder(t);
  spawnSync(wrapper, ["-p"], { env: { ...f.env, KIT_API_KEY_FILE: f.keyFile }, encoding: "utf8" });
  assert.equal(f.callList()[0].scrub, "1");
});

// The review's own arguments: a plain-reader tool list and no settings (so no hooks) are what let the scrub flag go off.
const reviewArgs = ["-p", "--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config"];

test("the scrub flag goes off only for a call of plain readers whose hooks are off too (it leaves empty .env, .npmrc, yarn.lock files); anything else keeps it", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  const offs = [reviewArgs, ["-p", "--tools=Read,Grep", "--setting-sources=", "--bare", "--strict-mcp-config"], ["-p", "--tools", "Read", "--bare", "--strict-mcp-config"],
    ["-p", "--model", "m", "--tools", "Read,Grep,Glob", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--output-format", "json"], ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--mcp-config={ \"mcpServers\": {} }"]];
  for (const args of offs) spawnSync(wrapper, args, { env, encoding: "utf8" });
  const keeps = [["-p", "--allowedTools", "Bash"], ["-p", "--tools", "Read,Bash", "--setting-sources", ""], ["-p", "--tools=Bash(git *),Read", "--bare"], ["-p"],
    ["-p", "--tools", "default", "--bare"], ["-p", "--tools", "Read", "Bash", "--bare"], ["-p", "--tools", "Read Bash", "--bare"], ["-p", "--tools", "Read,Grep", "--tools", "Bash", "--bare"],
    ["-p", "--tools", "Read", "--tools=default", "--bare"], ["-p", "--tools", "Edit", "--bare"],
    // Plain readers alone are not enough: their hooks could still run (settings or plugins), so the flag stays on.
    ["-p", "--tools", "Read,Grep,Glob", "--strict-mcp-config"], ["-p", "--tools=Read", "--strict-mcp-config"], ["-p", "--tools", "Read", "--setting-sources", "user", "--strict-mcp-config"],
    // Anything that starts another program (MCP servers, plugins, extra settings or agents) keeps it on, and so does MCP left open.
    ["-p", "--tools", "Read", "--bare"], ["-p", "--tools", "Read", "--setting-sources", ""],
    ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--mcp-config", "x.json"], ["-p", "--tools", "Read", "--setting-sources", "", "--mcp-config", "x.json"],
    ["-p", "--tools", "Read", "--bare", "--mcp-config", "x.json"], ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "x.json"],
    ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{"a":{"command":"x"}}}'],
    ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--plugin-dir", "/tmp/p"], ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--plugin-url", "https://x/p.zip"],
    // --setting-sources twice: one empty value does not make the other one's settings go away.
    ["-p", "--tools", "Read", "--setting-sources", "", "--setting-sources", "user", "--strict-mcp-config"], ["-p", "--tools", "Read", "--setting-sources", "user", "--setting-sources", "", "--strict-mcp-config"],
    ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--settings", "s.json"], ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--agents", "{}"],
    // No tools at all (kit ask) is not a reader list either: the call runs in a throwaway folder, so the flag stays on.
    ["-p", "--tools", ""], ["-p", "--tools", "", "--bare"], ["-p", "--tools=", "--setting-sources", ""]];
  for (const args of keeps) spawnSync(wrapper, args, { env, encoding: "utf8" });
  assert.deepEqual(f.callList().map(call => call.scrub), [...offs.map(() => "0"), ...keeps.map(() => "1")]);
});

test("a tool list over several lines, or a --tools that is no option of this call, never turns the scrub flag off", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  const hooksOff = ["--setting-sources", "", "--strict-mcp-config"];
  const keeps = [
    // A list written over several lines: every line counts, not only the first.
    ["-p", "--tools", "Read\nBash", ...hooksOff], ["-p", "--tools", "Read,Grep\nBash", ...hooksOff], ["-p", "--tools=Read\nBash", ...hooksOff], ["-p", "--tools", "Read", "Grep\nEdit", ...hooksOff],
    ["-p", "--tools", "\nBash", ...hooksOff], ["-p", "--tools", "Read\r\nBash", ...hooksOff], ["-p", "--tools", "Read\tBash", ...hooksOff],
    // The word --tools as the value of another option, or after the end-of-options marker, is no tool list.
    ["-p", "--append-system-prompt", "--tools", "Read", ...hooksOff], ["-p", "--append-system-prompt", "--tools=Read", ...hooksOff],
    ["-p", ...hooksOff, "--", "--tools", "Read"], ["-p", ...hooksOff, "--", "--tools=Read"], ["-p", "--add-dir", "--tools=Read,Grep", ...hooksOff],
    // The same for the hooks-off switch: as a value or after the marker it switches nothing off.
    ["-p", "--tools", "Read", "--strict-mcp-config", "--append-system-prompt", "--bare"], ["-p", "--tools", "Read", "--strict-mcp-config", "--append-system-prompt", "--setting-sources", ""],
    ["-p", "--tools", "Read", "--strict-mcp-config", "--", "--bare"], ["-p", "--tools", "Read", "--strict-mcp-config", "--setting-sources"], ["-p", "--tools", "Read", "--setting-sources", "--strict-mcp-config"],
    // --mcp-config as the value of another option, or after the marker, is no option of the call (the flag stays on either way: a later edit must not drop the check).
    ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--append-system-prompt", "--mcp-config", "x.json"], ["-p", "--tools", "Read", "--bare", "--strict-mcp-config", "--", "--mcp-config", "x.json"],
    // --strict-mcp-config as the value of another option is no switch either.
    ["-p", "--tools", "Read", "--bare", "--append-system-prompt", "--strict-mcp-config"],
  ];
  for (const args of keeps) spawnSync(wrapper, args, { env, encoding: "utf8" });
  const seen = f.callList();
  assert.equal(seen.length, keeps.length);
  keeps.forEach((args, index) => assert.equal(seen[index].scrub, "1", `scrub stays on for ${JSON.stringify(args)}`));
});

// A fake claude that behaves as the documented flag says: it starts one "hook" (a child process) the way Claude Code does, unless
// the call switches hooks off, and CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 takes the key out of that child's environment.
function hookClaude(f: ReturnType<typeof folder>) {
  const seen = join(f.dir, "hook-saw.jsonl");
  writeFileSync(join(f.bin, "hook.mjs"), `import { appendFileSync } from "node:fs";
const leaks = Object.entries(process.env).filter(([, value]) => String(value).includes(${JSON.stringify(secret)})).map(([name]) => name);
appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ leaks, hasKeyVariable: "ANTHROPIC_API_KEY" in process.env, scrubVariable: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }) + "\\n");
`);
  writeFileSync(join(f.bin, "claude"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(f.dir, "calls.jsonl"))}, JSON.stringify({ args, keyMatches: process.env.ANTHROPIC_API_KEY === ${JSON.stringify(secret)}, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }) + "\\n");
const hooksOff = args.includes("--bare") || args.some((arg, i) => (arg === "--setting-sources" && args[i + 1] === "") || arg === "--setting-sources=");
if (!hooksOff) {
  const hookEnv = Object.assign({}, process.env);
  if (process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB === "1") delete hookEnv.ANTHROPIC_API_KEY;
  spawnSync(process.execPath, [${JSON.stringify(join(f.bin, "hook.mjs"))}], { env: hookEnv });
}
console.log(JSON.stringify({ result: "ok", usage: {}, total_cost_usd: 0.01 }));
`);
  chmodSync(join(f.bin, "claude"), 0o755);
  return () => existsSync(seen) ? readFileSync(seen, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
}

test("a hook Claude starts never sees the key, whatever the call's tools or settings are; only the one Claude call has it", t => {
  const f = folder(t);
  const hooks = hookClaude(f);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  // A call with no tools (kit ask), a build, a review's own arguments, and calls that name no tools or hide hooks nowhere.
  const calls = [["-p", "--model", "m", "--output-format", "json", "--tools", ""], ["-p", "--allowedTools", "Bash"], reviewArgs, ["-p", "--tools", "Read,Grep,Glob"], ["-p"]];
  for (const args of calls) assert.equal(spawnSync(wrapper, args, { env, encoding: "utf8" }).status, 0);
  const ran = hooks();
  // The review's call starts no hook at all (settings are off); every other call's hook ran and found no key anywhere in its environment.
  assert.equal(ran.length, calls.length - 1);
  for (const row of ran) assert.deepEqual({ leaks: row.leaks, hasKeyVariable: row.hasKeyVariable }, { leaks: [], hasKeyVariable: false });
  assert.ok(f.callList().every(call => call.keyMatches === true), "the Claude call itself still has the key");
});

test("doctor's view and the wrapper agree: a relative path, a newline-only file and an unreadable file are all refused in plain words", t => {
  const f = folder(t);
  const blank = join(f.dir, "blank-key"); writeFileSync(blank, "\n", { mode: 0o600 }); chmodSync(blank, 0o600);
  const spaces = join(f.dir, "spaces-key"); writeFileSync(spaces, "  \t \nsk-second-line\n", { mode: 0o600 }); chmodSync(spaces, 0o600);
  const closed = join(f.dir, "closed-key"); writeFileSync(closed, `${secret}\n`, { mode: 0o000 }); chmodSync(closed, 0o000);
  for (const [file, words] of [["relative-key", /must be an absolute path/], [blank, /is empty/], [spaces, /is empty/], [closed, /cannot be read|can be read by others/]] as const) {
    const env = { ...f.env, KIT_API_KEY_FILE: file };
    const route = apiRoute(env);
    assert.ok(route.problem, `doctor accepts ${file}`);
    const run = spawnSync(wrapper, ["-p"], { env, cwd: f.dir, encoding: "utf8" });
    assert.equal(run.status, 2, `wrapper accepts ${file}: ${run.stderr}`);
    assert.match(run.stderr, words);
    assert.match(route.problem, words);
  }
  chmodSync(closed, 0o600);
  assert.deepEqual(f.callList(), []);
});

test("a refused key file or an empty API account becomes one plain problem line, and only while the route is on", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  assert.equal(apiRouteProblem("", "claude-api-run: the API key file can be read by others (mode 644); run chmod 600 on it\n", env),
    "problem: API route: the API key file can be read by others (mode 644); run chmod 600 on it");
  assert.match(apiRouteProblem('{"is_error":true,"result":"Credit balance is too low"}', "", env), /^problem: Claude out of credit: API credit is used up \(Credit balance is too low\)/);
  assert.equal(apiRouteProblem("{}", "some other failure\n", env), null);
  assert.equal(apiRouteProblem('{"result":"Credit balance is too low"}', "", f.env), null);
  assert.equal(claudeAdapter({ kind: "review", model: "claude-opus-5-5", effort: "medium" }, "/common").outOfCredit("", "", 0), null);
});

test("the spend total says when runs printed no cost, and skips log rows that are not records", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  recordApiSpend({ env, command: "review", model: "m", stdout: JSON.stringify({ result: "done", total_cost_usd: 2, usage: { input_tokens: 5, output_tokens: 1 } }), status: 0 });
  recordApiSpend({ env, command: "build", model: "m", stdout: "", status: 124 });
  writeFileSync(apiSpendLog(env), `${readFileSync(apiSpendLog(env), "utf8")}null\n42\n`);
  assert.equal(apiSpendTotal(env).unknownCost, 1);
  assert.match(apiRouteReport(env).text, /2 runs logged \(1 failed\), at least \$2\.00 spent \(1 run with no cost printed\), 5 tokens in, 1 out$/);
});

test("a relative config folder is refused by both; a refused call adds no spend line", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile, KIT_API_CONFIG_DIR: "relative-config" };
  assert.match(apiRoute(env).problem, /KIT_API_CONFIG_DIR relative-config must be an absolute path/);
  const run = spawnSync(wrapper, ["-p"], { env, cwd: f.dir, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /KIT_API_CONFIG_DIR must be an absolute path/);
  assert.ok(!existsSync(join(f.dir, "relative-config")), "no folder is made in the working folder");
  assert.equal(recordApiSpend({ env, command: "review", model: "m", stdout: "", status: 2, refused: true }), null);
  assert.ok(!existsSync(apiSpendLog(env)));
});

test("a symlinked key file works for both; a missing claude, an unusable config folder and an unset HOME are plain refusals with no spend line", t => {
  const f = folder(t);
  const link = join(f.dir, "key-link");
  symlinkSync(f.keyFile, link);
  assert.equal(apiRoute({ ...f.env, KIT_API_KEY_FILE: link }).problem, null);
  assert.equal(spawnSync(wrapper, ["-p"], { env: { ...f.env, KIT_API_KEY_FILE: link }, encoding: "utf8" }).status, 0);
  // A PATH with the few tools the wrapper needs and no claude.
  const lean = join(f.dir, "lean"); mkdirSync(lean);
  for (const tool of ["bash", "env", "stat", "mkdir", "chmod"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim(), join(lean, tool));
  const noClaude = spawnSync(wrapper, ["-p"], { env: { ...f.env, KIT_API_KEY_FILE: f.keyFile, PATH: lean }, encoding: "utf8" });
  assert.equal(noClaude.status, 2, noClaude.stderr);
  assert.match(noClaude.stderr, /claude-api-run: the claude command is not installed or not on PATH/);
  const file = join(f.dir, "plain-file"); writeFileSync(file, "x");
  const inFile = { ...f.env, KIT_API_KEY_FILE: f.keyFile, KIT_API_CONFIG_DIR: join(file, "sub") };
  assert.match(apiRoute(inFile).problem, /cannot be made: .* is not a folder/);
  const run = spawnSync(wrapper, ["-p"], { env: inFile, encoding: "utf8" });
  assert.equal(run.status, 2); assert.match(run.stderr, /claude-api-run: the config folder .* cannot be made/);
  const noHome = { ...f.env, KIT_API_KEY_FILE: f.keyFile }; delete noHome.HOME;
  assert.match(apiRoute(noHome).problem, /HOME is not set/);
  assert.equal(recordApiSpend({ env: inFile, command: "build claude", model: "m", stdout: "", status: 2, refused: true }), null);
  assert.ok(!existsSync(apiSpendLog(inFile)));
  // The log follows the kit's state folder rule: a relative XDG_STATE_HOME is ignored.
  assert.equal(apiSpendLog({ ...f.env, XDG_STATE_HOME: "relative" }), join(f.home, ".local/state/agent-kit/api-spend.log"));
});

test("only the CLI's closing words make an empty account: a failure that merely quotes the phrase is not one", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  const quoting = Array.from({ length: 8 }, (_, index) => index === 0 ? "the test says Credit balance is too low" : `line ${index}`).join("\n");
  assert.equal(apiRouteProblem('{"is_error":true,"result":"build failed"}', quoting, env), null);
  assert.match(apiRouteProblem("", `${quoting}\nCredit balance is too low\n`, env), /out of credit/);
  assert.equal(claudeAdapter({ kind: "build", model: "claude-opus-5-5", effort: "low" }, "/c").label, "claude");
});

test("a whole line of the closing words is an empty account; a failure that quotes the phrase, even on its last line, is not", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  assert.match(apiRouteProblem("", "log\nCredit balance is too low\n", env), /out of credit/);
  assert.match(apiRouteProblem("", "Error: Credit balance is too low.\n", env), /out of credit/);
  assert.match(apiRouteProblem(JSON.stringify({ is_error: true, result: "Credit balance is too low" }), "", env), /out of credit/);
  assert.equal(apiRouteProblem("", "FAIL: the test says Credit balance is too low when empty\n", env), null);
  assert.equal(apiRouteProblem(JSON.stringify({ is_error: true, result: "build failed: see Credit balance is too low in the log" }), "", env), null);
});

test("doctor's view refuses a route whose claude is missing, as the wrapper does", t => {
  const f = folder(t);
  const noClaude = { ...f.env, KIT_API_KEY_FILE: f.keyFile, PATH: "/nonexistent-folder" };
  assert.match(apiRoute(noClaude).problem, /^the claude command is not installed or not on PATH$/);
  assert.match(apiRouteReport(noClaude).text, /^on, but the claude command is not installed or not on PATH$/);
  assert.equal(apiRoute({ ...f.env, KIT_API_KEY_FILE: f.keyFile }).problem, null);
});

test("a call the wrapper refuses is marked refused in the run's status, so kit review refunds it and moves on", async t => {
  const f = folder(t);
  const open = join(f.dir, "open-key"); writeFileSync(open, `${secret}\n`); chmodSync(open, 0o644);
  const root = join(f.dir, "work2"), out = join(f.dir, "out2"), brief = join(f.dir, "brief2.md");
  mkdirSync(root); mkdirSync(out); writeFileSync(brief, "Review this.\n");
  const git = (...args: string[]) => { const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); };
  git("init", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const env = { ...f.env, KIT_API_KEY_FILE: open, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "20s", ASE_BUILD_MODEL: "", KIT_TALK_STYLE: "plain" };
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-haiku-5-5"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /problem: API route: the API key file can be read by others \(mode 644\); run chmod 600 on it/);
  assert.equal(JSON.parse(readFileSync(join(out, "status.json"), "utf8")).refused, true);
  assert.deepEqual(f.callList(), []);
  assert.ok(!existsSync(apiSpendLog(env)), "a refused call adds no spend line");
});

test("only a failed claude call with the wrapper's refusal is marked refused: a working call is not", async t => {
  const f = folder(t);
  const root = join(f.dir, "work3"), out = join(f.dir, "out3"), brief = join(f.dir, "brief3.md");
  mkdirSync(root); mkdirSync(out); writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => { const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }); assert.equal(run.status, 0, run.stderr); };
  git("init", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "base");
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "20s", ASE_BUILD_MODEL: "", KIT_TALK_STYLE: "plain" };
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-haiku-5-5"], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.notEqual(JSON.parse(readFileSync(join(out, "status.json"), "utf8")).refused, true);
});

test("the spend line says worked only for a real success, and a non-refusal exit never reads as the wrapper's refusal", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  recordApiSpend({ env, command: "build claude", model: "m", stdout: "plain text", status: 0 });
  recordApiSpend({ env, command: "build claude", model: "m", stdout: JSON.stringify({ subtype: "error_max_turns", result: "x" }), status: 0 });
  recordApiSpend({ env, command: "ask", model: "m", stdout: JSON.stringify({ result: "  " }), status: 0 });
  recordApiSpend({ env, command: "review claude", model: "m", stdout: JSON.stringify({ result: "" }), status: 0, answerRequired: false });
  recordApiSpend({ env, command: "ask", model: "m", stdout: JSON.stringify({ result: "fine", subtype: "success" }), status: 0 });
  const rows = readFileSync(apiSpendLog(env), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => row.ok), [false, false, false, true, true]);
  const log = "claude-api-run: the API key file is empty\n";
  assert.match(apiRouteProblem("", log, env, 2), /^problem: API route: the API key file is empty$/);
  assert.equal(apiRouteProblem("", log, env, 1), null);
});

test("managed (admin-installed) settings can hold hooks that neither an empty --setting-sources nor --bare is known to switch off: with one on the machine the flag stays on", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  const run = () => { spawnSync(wrapper, reviewArgs, { env, encoding: "utf8" }); return f.callList().at(-1).scrub; };
  assert.equal(run(), "0", "no managed settings: a plain reader review has the flag off");
  writeFileSync(join(f.managed, "managed-settings.json"), "{}");
  assert.equal(run(), "1", "a managed-settings.json keeps it on");
  rmSync(join(f.managed, "managed-settings.json"));
  mkdirSync(join(f.managed, "managed-settings.d"));
  assert.equal(run(), "0", "an empty managed-settings.d is no settings");
  writeFileSync(join(f.managed, "managed-settings.d", "10-hooks.json"), "{}");
  assert.equal(run(), "1", "a file in managed-settings.d keeps it on");
  // Fail closed: --bare does not make the kit trust that managed settings stay out, so the flag stays on for it too.
  spawnSync(wrapper, ["-p", "--tools", "Read", "--bare", "--strict-mcp-config"], { env, encoding: "utf8" });
  assert.equal(f.callList().at(-1).scrub, "1");
  rmSync(join(f.managed, "managed-settings.d", "10-hooks.json"));
  spawnSync(wrapper, ["-p", "--tools", "Read", "--bare", "--strict-mcp-config"], { env, encoding: "utf8" });
  assert.equal(f.callList().at(-1).scrub, "0");
  // Admin-installed MCP servers are programs claude starts, and --strict-mcp-config is not known to keep them out.
  writeFileSync(join(f.managed, "managed-mcp.json"), "{}");
  assert.equal(run(), "1", "a managed-mcp.json keeps it on");
});

test("the arguments the kit really sends through the wrapper: a review call turns the flag off, a resumed one too, and a build keeps it on", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  const review = claudeAdapter({ kind: "review", model: "claude-opus-5-5", effort: "medium", sessionId: "11111111-2222-3333-4444-555555555555" }, f.dir);
  const build = claudeAdapter({ kind: "build", model: "claude-opus-5-5", effort: "high", sessionId: "11111111-2222-3333-4444-555555555555" }, f.dir);
  const calls = [review.args, review.resume("11111111-2222-3333-4444-555555555555"), build.args, build.resume("11111111-2222-3333-4444-555555555555")];
  for (const args of calls) spawnSync(wrapper, args, { env, encoding: "utf8" });
  assert.deepEqual(f.callList().map(call => call.scrub), ["0", "0", "1", "1"]);
});
