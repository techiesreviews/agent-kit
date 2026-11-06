import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { apiRoute, apiRouteProblem, apiRouteReport, apiSpendLog, apiSpendTotal, claudeCommand, recordApiSpend } from "../api-route.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { claudeAdapter } from "../agent-run.mjs";
import { kitEnv } from "./support/kit-env.ts";

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
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, keyMatches: process.env.ANTHROPIC_API_KEY === ${JSON.stringify(secret)}, configDir: process.env.CLAUDE_CONFIG_DIR, keyFileVar: process.env.KIT_API_KEY_FILE ?? null, scrub: process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB ?? null }) + "\\n");
console.log(JSON.stringify({ result: "ok", modelUsage: { "claude-haiku-5-5": {} }, usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 }, total_cost_usd: 0.0123, session_id: "s" }));
`);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  chmodSync(join(bin, "claude"), 0o755);
  const env = { ...kitEnv(), HOME: home, XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv;
  delete env.KIT_API_KEY_FILE; delete env.KIT_API_CONFIG_DIR;
  const callList = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { dir, bin, home, state, keyFile, env, callList };
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
  const stdout = JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 7, cache_creation_input_tokens: 3 }, total_cost_usd: 0.05 });
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
  recordApiSpend({ env: { ...f.env, KIT_API_KEY_FILE: f.keyFile }, command: "review", model: "claude-opus-5-5", stdout: JSON.stringify({ usage: { input_tokens: 1000, output_tokens: 200 }, total_cost_usd: 1.5 }), status: 0 });
  const on = doctor({ KIT_API_KEY_FILE: f.keyFile });
  assert.match(on.stdout, new RegExp(`^✓ api route: on: key file ${f.keyFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(mode 600\\), config folder ${f.home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.claude-api; 1 run logged, \\$1\\.50 spent, 1000 tokens in, 200 out$`, "m"), on.stdout);
  assert.ok(!on.stdout.includes(secret) && !on.stderr.includes(secret));
  chmodSync(f.keyFile, 0o644);
  const unsafe = doctor({ KIT_API_KEY_FILE: f.keyFile });
  assert.match(unsafe.stdout, /^✗ api route: on, but KIT_API_KEY_FILE .* can be read by others \(mode 644\); run chmod 600 on it/m, unsafe.stdout);
  assert.notEqual(unsafe.status, 0, "an unusable route fails doctor");
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
  assert.match(apiRouteProblem('{"is_error":true,"result":"Credit balance is too low"}', "", env), /^problem: API route: the API credit is used up \(Credit balance is too low\)/);
  assert.equal(apiRouteProblem("{}", "some other failure\n", env), null);
  assert.equal(apiRouteProblem('{"result":"Credit balance is too low"}', "", f.env), null);
  assert.equal(claudeAdapter({ kind: "review", model: "claude-opus-5-5", effort: "medium" }, "/common").outOfCredit("", "", 0), null);
});

test("the spend total says when runs printed no cost, and skips log rows that are not records", t => {
  const f = folder(t);
  const env = { ...f.env, KIT_API_KEY_FILE: f.keyFile };
  recordApiSpend({ env, command: "review", model: "m", stdout: JSON.stringify({ total_cost_usd: 2, usage: { input_tokens: 5, output_tokens: 1 } }), status: 0 });
  recordApiSpend({ env, command: "build", model: "m", stdout: "", status: 124 });
  writeFileSync(apiSpendLog(env), `${readFileSync(apiSpendLog(env), "utf8")}null\n42\n`);
  assert.equal(apiSpendTotal(env).unknownCost, 1);
  assert.match(apiRouteReport(env).text, /2 runs logged \(1 failed\), at least \$2\.00 spent \(1 run with no cost printed\), 5 tokens in, 1 out$/);
});
