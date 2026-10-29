import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { checkSteps, classify } from "../pr-tier.mjs";
import { kitEnv } from "./support/kit-env.ts";

const repo = resolve(".");
const shell = join(repo, "agent.sh");

function entries(directory: string) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

// ASE_KIT_CLEAN_LIMIT_MS is a test-only seam: the cut-off test below forces a small limit.
const limit = Number(process.env.ASE_KIT_CLEAN_LIMIT_MS) || 480_000;
const guardName = "kit and agent unit tests leave no run folders or temporary files";

// Live members of a process group; a zombie is already gone and only waits for its parent.
// `members` and `strays` read /proc, so the guard's process checks need Linux (CI and the dev hosts).
function members(pgid: number) {
  return entries("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try {
      const [state, , group] = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
      return Number(group) === pgid && state !== "Z";
    } catch { return false; }
  });
}

// Processes that left the group (kit bg starts jobs in their own session, Playwright its browser) still carry
// the private TMPDIR or a folder inside it.
function strays(temporary: string) {
  const marker = `TMPDIR=${temporary}`;
  const matches = (line: string) => line === marker || line.startsWith(`${marker}/`);
  return entries("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").some(matches); } catch { return false; }
  });
}

function processLabel(pid: number) {
  try { return `${pid} ${readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim().slice(0, 160)}`; } catch { return `${pid}`; }
}

// Polls every 100 ms until `done` holds or `ms` has passed.
async function waitUntil(done: () => boolean, ms: number) {
  for (const deadline = Date.now() + ms; !done() && Date.now() < deadline;) await delay(100);
}

// Runs the suite as its own process group, so a run cut off at the limit takes every test process with it.
// Resolves once the group and any process using its TMPDIR have exited; only then may the caller remove that
// temp folder. A run that ends in time but leaves processes behind reports them in `leftRunning`; they are
// then killed so the folder can still go. `survivors` lists any process that outlived even SIGKILL.
async function runGroup(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, ms: number) {
  const child = spawn(process.execPath, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pgid = child.pid!, temporary = options.env.TMPDIR!;
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  // Handled at once: a spawn failure rejects both waits, and only the "exit" one should surface it.
  const closed = once(child, "close").catch(() => {});
  const started = Date.now();
  let cutOff = false, kill: NodeJS.Timeout | undefined;
  const signalGroup = (signal: NodeJS.Signals) => { try { process.kill(-pgid, signal); } catch { /* group gone */ } };
  const stop = setTimeout(() => {
    cutOff = true;
    signalGroup("SIGTERM");
    kill = setTimeout(() => signalGroup("SIGKILL"), 5_000);
  }, ms);
  let status: number | null, signal: NodeJS.Signals | null;
  try {
    [status, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  } finally {
    clearTimeout(stop);
    clearTimeout(kill);
  }
  // Linux keeps a PID out of reuse while a group still carries it as its ID; once a scan finds the group
  // empty, the ID may belong to someone else, so it is never scanned (or killed) again.
  let groupGone = false;
  const running = () => {
    const group = groupGone ? [] : members(pgid);
    if (group.length === 0) groupGone = true;
    return [...new Set([...group, ...strays(temporary)])];
  };
  const killRunning = () => { for (const pid of running()) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } };
  // A run that ended in time gets a short grace for its last processes to exit on their own.
  if (!cutOff) await waitUntil(() => running().length === 0, 2_000);
  const leftRunning = cutOff ? [] : running().map(processLabel);
  await waitUntil(() => { killRunning(); return running().length === 0; }, 10_000);
  const survivors = running().map(processLabel);
  // stdio can still hold the last chunk (the TAP summary) when "exit" fires; a holder outside the group and
  // the TMPDIR can keep the pipes open, so wait for "close" only briefly.
  let wait: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise(accept => { wait = setTimeout(accept, 5_000); })]);
  clearTimeout(wait);
  return { status, signal, stdout, stderr, cutOff, leftRunning, survivors, seconds: Math.round((Date.now() - started) / 1000) };
}

test(guardName, { timeout: limit + 60_000 }, async t => {
  // The standalone test:kit-clean script runs this guard. Select all kit tests,
  // runner callers and compatibility wrappers, including future test files.
  const files = globSync("tests/*.test.ts").filter(file =>
    resolve(file) !== import.meta.filename &&
    (/^tests\/kit.*\.test\.ts$/.test(file) ||
      /\bkit\b|\b(?:agent|sol|review)\.sh\b|agent-run\.mjs/.test(readFileSync(file, "utf8"))),
  ).sort();
  for (const file of ["kit-fix", "kit-slice", "agent-resume", "agent-scripts", "kit-doctor"]) {
    assert.ok(files.includes(`tests/${file}.test.ts`), `guard must run ${file}`);
  }
  const temporary = mkdtempSync(join(tmpdir(), "kit-tests-clean-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const artifacts = join(repo, ".scratch/agent");
  const before = new Set(entries(artifacts));
  // A private OS temp directory attributes every leftover to this child suite,
  // without racing unrelated tests or builders using the system temp directory.
  const env = { ...kitEnv(), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    TSX_DISABLE_CACHE: "1", NODE_DISABLE_COMPILE_CACHE: "1" };
  // Node otherwise treats this as an existing test worker and runs no files.
  delete env.NODE_TEST_CONTEXT;
  delete env.ASE_KIT_CLEAN_LIMIT_MS;
  // The kit suite grows with every slice; a run cut off at this limit fails as a time-out, and t.after
  // removes its temp folder (kit-pr-* included) once the whole process group has exited.
  const result = await runGroup(["--import", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=4", ...files],
    { cwd: repo, env }, limit);
  const folders = entries(artifacts).filter(name => !before.has(name));
  // The tsx CLI creates an empty IPC directory even with its cache disabled.
  // Permit only that empty runtime directory; all test-created paths must go.
  const runtime = `tsx-${process.getuid?.() ?? 0}`;
  const leftovers = entries(temporary).filter(name => name !== runtime || entries(join(temporary, name)).length > 0);
  if (result.status !== 0) {
    const failures = result.stdout.match(/^\s*not ok .*(?:\n[ \t]+.*)*/gm)?.join("\n");
    t.diagnostic(failures || (result.stdout + result.stderr).slice(-12_000));
  }
  assert.ok(!result.cutOff, `kit suite run was cut off after ${result.seconds} s (limit ${limit / 1000} s); ` +
    `removing the temp paths it left: ${leftovers.join(", ") || "none"}`);
  assert.deepEqual(result.survivors, [], `processes still running after SIGKILL: ${result.survivors.join("; ")}`);
  assert.deepEqual(result.leftRunning, [], `processes left running: ${result.leftRunning.join("; ")}`);
  assert.deepEqual(folders, [], `new folders in ${artifacts}: ${folders.join(", ")}`);
  assert.deepEqual(leftovers, [], `test temp paths left behind: ${leftovers.join(", ")}`);
  assert.equal(result.status, 0, `exit ${result.status} signal ${result.signal}\n${(result.stdout + result.stderr).slice(-12_000)}`);
  const count = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1]);
  assert.ok(count >= files.length, `child suite must execute tests from ${files.length} files: ${result.stdout.slice(-2000)}`);
  t.diagnostic(`guard ran ${count} tests from ${files.length} files`);
});

test("a guard run cut off at its limit names the time-out and leaves no temp folder", { timeout: 180_000 }, async t => {
  const outer = mkdtempSync(join(tmpdir(), "kit-tests-cutoff-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const env = { ...kitEnv(), TMPDIR: outer, TMP: outer, TEMP: outer,
    TSX_DISABLE_CACHE: "1", NODE_DISABLE_COMPILE_CACHE: "1", ASE_KIT_CLEAN_LIMIT_MS: "8000" };
  delete env.NODE_TEST_CONTEXT;
  const artifacts = join(repo, ".scratch/agent");
  const before = new Set(entries(artifacts));
  const result = await runGroup(["--import", "tsx", "--test", "--test-reporter=tap",
    `--test-name-pattern=^${guardName}$`, import.meta.filename], { cwd: repo, env }, 120_000);
  const output = result.stdout + result.stderr;
  assert.equal(result.cutOff, false, output.slice(-4000));
  assert.notEqual(result.status, 0, output.slice(-4000));
  assert.match(result.stdout, /kit suite run was cut off after \d+ s \(limit 8 s\)/, output.slice(-4000));
  assert.doesNotMatch(result.stdout, /test temp paths left behind/);
  // The outer run would kill what the inner guard left, so only its reports show the inner cleanup held.
  assert.deepEqual(result.leftRunning, [], "processes from the cut-off suite still running");
  assert.deepEqual(result.survivors, []);
  assert.deepEqual(entries(artifacts).filter(name => !before.has(name)), [], `new folders in ${artifacts}`);
  const runtime = `tsx-${process.getuid?.() ?? 0}`;
  assert.deepEqual(entries(outer).filter(name => name !== runtime || entries(join(outer, name)).length > 0), []);
});

// A tiny suite stand-in: `node -e <script>` run through runGroup with its own private TMPDIR.
function runScript(t: TestContext, script: string, ms = 30_000) {
  const temporary = mkdtempSync(join(tmpdir(), "kit-tests-group-"));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const env = { ...kitEnv(), TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  return { temporary, run: runGroup(["-e", script, temporary], { cwd: repo, env }, ms) };
}

const sleeper = (options: string) =>
  `require("child_process").spawn("sleep", ["60"], { stdio: "ignore", ${options} }).unref();`;

test("the guard reports a process that left the group and kills it before the folder goes", { timeout: 60_000 }, async t => {
  const { temporary, run } = runScript(t,
    sleeper(`detached: true, env: { ...process.env, TMPDIR: require("path").join(process.argv[1], "nested") }`));
  const result = await run;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.leftRunning.length, 1, result.leftRunning.join("; "));
  assert.match(result.leftRunning[0], /\bsleep 60\b/);
  assert.deepEqual(result.survivors, []);
  assert.deepEqual(strays(temporary), []);
});

test("a cut-off run kills a process that left the group without reporting it as a leak", { timeout: 60_000 }, async t => {
  const { temporary, run } = runScript(t,
    `${sleeper(`detached: true, env: { ...process.env, TMPDIR: require("path").join(process.argv[1], "nested") }`)}
    process.stdout.write("STARTED\\n"); setInterval(() => {}, 1000);`,
    1_000);
  const result = await run;
  assert.equal(result.cutOff, true);
  assert.ok(result.stdout.includes("STARTED"), "the escaped process started before the cut-off");
  assert.deepEqual(result.leftRunning, []);
  assert.deepEqual(result.survivors, []);
  assert.deepEqual(strays(temporary), []);
});

test("a cut-off run returns only after a process writing into a kit-pr temp folder has stopped", { timeout: 60_000 }, async t => {
  // The writer leaves the group and keeps recreating kit-pr-cutoff/file, as a kit-pr case cut off mid-run might.
  const writer = `const { mkdirSync, writeFileSync } = require("fs"), dir = process.env.TMPDIR;
    setInterval(() => { mkdirSync(dir, { recursive: true }); writeFileSync(dir + "/file", String(Date.now())); }, 50);`;
  const { temporary, run } = runScript(t, `const { spawn } = require("child_process"), { join } = require("path");
    spawn(process.execPath, ["-e", ${JSON.stringify(writer)}], { detached: true, stdio: "ignore",
      env: { ...process.env, TMPDIR: join(process.argv[1], "kit-pr-cutoff") } }).unref();
    const file = join(process.argv[1], "kit-pr-cutoff", "file");
    const ready = setInterval(() => { if (require("fs").existsSync(file)) { clearInterval(ready); process.stdout.write("STARTED\\n"); } }, 20);
    setInterval(() => {}, 1000);`, 2_000);
  const result = await run;
  assert.equal(result.cutOff, true);
  assert.ok(result.stdout.includes("STARTED"), "the writer wrote before the cut-off");
  const file = join(temporary, "kit-pr-cutoff", "file");
  const written = readFileSync(file, "utf8");
  await delay(500);
  assert.equal(readFileSync(file, "utf8"), written, "nothing writes into the temp folder after the run returns");
  assert.deepEqual(globSync(join(temporary, "kit-pr-*")), [join(temporary, "kit-pr-cutoff")]);
  // What the guard's t.after does once runGroup has returned.
  rmSync(temporary, { recursive: true, force: true });
  assert.equal(existsSync(temporary), false);
  await delay(300);
  assert.equal(existsSync(temporary), false, "nothing recreates the temp folder once it is removed");
  assert.deepEqual(globSync(join(temporary, "kit-pr-*")), []);
});

test("a cut-off suite that ignores SIGTERM is killed 5 s later", { timeout: 60_000 }, async t => {
  const { run } = runScript(t, `process.on("SIGTERM", () => {}); process.stdout.write("STARTED\\n"); setInterval(() => {}, 1000);`, 1_000);
  const result = await run;
  assert.ok(result.stdout.includes("STARTED"), "the SIGTERM handler was in place before the cut-off");
  assert.equal(result.cutOff, true);
  assert.equal(result.signal, "SIGKILL");
  assert.deepEqual(result.survivors, []);
  assert.ok(result.seconds <= 8, `took ${result.seconds} s`);
});

test("a run that ends in time reports a group member with another TMPDIR without waiting out the kill", { timeout: 60_000 }, async t => {
  const started = Date.now();
  const { run } = runScript(t, sleeper(`env: { ...process.env, TMPDIR: require("os").homedir() }`));
  const result = await run;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.leftRunning.length, 1, result.leftRunning.join("; "));
  assert.match(result.leftRunning[0], /\bsleep 60\b/);
  assert.deepEqual(result.survivors, []);
  assert.ok(Date.now() - started < 8_000, `took ${Date.now() - started} ms`);
});

test("the guard reads all of the suite's output before it returns", { timeout: 60_000 }, async t => {
  const { run } = runScript(t, `process.stdout.write("x".repeat(256 * 1024) + "\\nEND-MARKER\\n");`);
  const result = await run;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.length, 256 * 1024 + "\nEND-MARKER\n".length);
  assert.ok(result.stdout.endsWith("\nEND-MARKER\n"));
});

test("npm test excludes the clean guard and CI runs it separately", () => {
  const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const pattern = /--test '([^']+)'$/.exec(scripts.test)?.[1];
  assert.ok(pattern, "default test command must have a quoted test glob");
  const files = globSync(pattern).sort();
  assert.deepEqual(files, globSync("tests/*.test.ts").filter(file => file !== "tests/kit-tests-clean.test.ts").sort());
  assert.equal(scripts["test:kit-clean"], "tsx --test tests/kit-tests-clean.test.ts");
  const ci = readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8");
  assert.equal(ci.match(/run: npm run test:kit-clean\b/g)?.length, 1);
  assert.match(ci, /run: npm test\n/);
});

test("the PR full tier runs the clean guard only for agent scripts or kit tests", () => {
  // An editor-like project's settings (a copy of the Native Site Editor's): its kit plumbing is scripts/agents/ and kit tests.
  const settings = JSON.parse(readFileSync("tests/fixtures/editor-kit.json", "utf8"));
  const steps = (paths: string[], full = false) => checkSteps(classify(paths.map(path => ({ status: "M", path })), { full, settings })).steps;
  for (const path of ["scripts/agents/kit.d/slice", "scripts/agents/pr-tier.mjs", "tests/kit-wait.test.ts"]) {
    assert.deepEqual(steps([path, "package.json"]), ["check", "unit", "kit-clean", "lint", "specs"]);
    assert.ok(steps([path], true).includes("kit-clean"));
  }
  for (const paths of [[], ["src/main.ts"], ["package.json"], ["scripts/check-types.mjs"], ["tests/app.test.ts"], ["docs/a.md"]]) {
    assert.equal(steps(paths, true).includes("kit-clean"), false, paths.join(", "));
  }
  assert.equal(steps(["tests/kit-wait.test.ts"]).includes("kit-clean"), false, "standalone guard is a full-tier step");
});

for (const kind of ["missing", "directory", "dangling link", "unreadable"]) {
  test(`agent.sh rejects a ${kind} brief with exit 2 before creating artifacts`, t => {
    const directory = mkdtempSync(join(tmpdir(), "kit-tests-brief-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const worktree = join(directory, "worktree");
    mkdirSync(worktree);
    const init = spawnSync("git", ["init", worktree], { encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const brief = join(directory, "brief.md");
    if (kind === "directory") mkdirSync(brief);
    if (kind === "dangling link") symlinkSync(join(directory, "missing.md"), brief);
    if (kind === "unreadable") writeFileSync(brief, "unreadable brief", { mode: 0 });
    for (const flags of [[], ["--out", join(directory, "explicit-output")]]) {
      const result = spawnSync("bash", [shell, "build", worktree, brief, ...flags], {
        cwd: repo, encoding: "utf8", timeout: 10_000,
        env: { ...kitEnv(), ASE_SKIP_DOCTOR: "1" },
      });
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /problem:.*(?:ENOENT|EISDIR|EACCES)/);
      assert.doesNotMatch(result.stdout, /artifacts:/);
      assert.equal(existsSync(join(worktree, ".scratch/agent")), false);
      assert.equal(existsSync(join(directory, "explicit-output")), false);
    }
  });
}

test("agent.sh with explicit output never creates the worktree artifact directory", t => {
  const directory = mkdtempSync(join(tmpdir(), "kit-tests-output-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const worktree = join(directory, "worktree"), bin = join(directory, "bin");
  mkdirSync(worktree); mkdirSync(bin);
  const init = spawnSync("git", ["init", worktree], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const brief = join(directory, "brief.md"), out = join(directory, "output");
  writeFileSync(brief, "test brief\n");
  const cli = join(bin, "codex");
  writeFileSync(cli, `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
console.error("model: gpt-6.1-sol");
writeFileSync(args[args.indexOf("-o") + 1], "test report\\n");
`);
  chmodSync(cli, 0o755);
  const result = spawnSync("bash", [shell, "build", worktree, brief, "--out", out, "--cli", "codex", "--model", "gpt-6.1-sol"], {
    cwd: repo, encoding: "utf8", timeout: 10_000,
    env: { ...kitEnv(), PATH: `${bin}:${process.env.PATH}`, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "5s" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(out, "out.md"), "utf8"), "test report\n");
  assert.equal(existsSync(join(worktree, ".scratch/agent")), false);
});
