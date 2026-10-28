import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { checkSteps, classify } from "../scripts/agents/pr-tier.mjs";

const repo = resolve(".");
const shell = join(repo, "scripts/agents/agent.sh");

function entries(directory: string) {
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

// ASE_KIT_CLEAN_LIMIT_MS is a test-only seam: the cut-off test below forces a small limit.
const limit = Number(process.env.ASE_KIT_CLEAN_LIMIT_MS) || 480_000;
const guardName = "kit and agent unit tests leave no run folders or temporary files";

function groupAlive(pid: number) {
  try { process.kill(-pid, 0); return true; } catch { return false; }
}

// Processes that left the group (kit bg starts jobs in their own session) still carry the private TMPDIR.
// `within` also matches processes whose TMPDIR is a folder inside it.
function strays(temporary: string, within = false) {
  const marker = `TMPDIR=${temporary}`;
  const matches = (line: string) => line === marker || (within && line.startsWith(`${marker}/`));
  return entries("/proc").filter(name => /^\d+$/.test(name)).map(Number).filter(pid => {
    try { return readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").some(matches); } catch { return false; }
  });
}

// Runs the suite as its own process group, so a run cut off at the limit takes every test process with it.
// Resolves once the group and any process still using its TMPDIR have exited; only then may the caller
// remove that temp folder.
async function runGroup(args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }, ms: number) {
  const child = spawn(process.execPath, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const started = Date.now();
  let cutOff = false;
  const signalGroup = (signal: NodeJS.Signals) => { try { process.kill(-child.pid!, signal); } catch { /* group gone */ } };
  const stop = setTimeout(() => {
    cutOff = true;
    signalGroup("SIGTERM");
    setTimeout(() => signalGroup("SIGKILL"), 5_000).unref();
  }, ms);
  const [status, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  clearTimeout(stop);
  if (cutOff) signalGroup("SIGKILL");
  const temporary = options.env.TMPDIR!;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline; await delay(100)) {
    const left = strays(temporary);
    if (!groupAlive(child.pid!) && left.length === 0) break;
    for (const pid of left) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  return { status, signal, stdout, stderr, cutOff, seconds: Math.round((Date.now() - started) / 1000) };
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
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
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
  assert.deepEqual(folders, [], `new folders in ${artifacts}: ${folders.join(", ")}`);
  assert.deepEqual(leftovers, [], `test temp paths left behind: ${leftovers.join(", ")}`);
  assert.equal(result.status, 0, (result.stdout + result.stderr).slice(-12_000));
  const count = Number(/^# tests (\d+)$/m.exec(result.stdout)?.[1]);
  assert.ok(count >= files.length, `child suite must execute tests from ${files.length} files: ${result.stdout.slice(-2000)}`);
  t.diagnostic(`guard ran ${count} tests from ${files.length} files`);
});

test("a guard run cut off at its limit names the time-out and leaves no temp folder", async t => {
  const outer = mkdtempSync(join(tmpdir(), "kit-tests-cutoff-"));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: outer, TMP: outer, TEMP: outer,
    TSX_DISABLE_CACHE: "1", NODE_DISABLE_COMPILE_CACHE: "1", ASE_KIT_CLEAN_LIMIT_MS: "8000" };
  delete env.NODE_TEST_CONTEXT;
  const result = await runGroup(["--import", "tsx", "--test", "--test-reporter=tap",
    `--test-name-pattern=^${guardName}$`, import.meta.filename], { cwd: repo, env }, 120_000);
  const output = result.stdout + result.stderr;
  assert.equal(result.cutOff, false, output.slice(-4000));
  assert.notEqual(result.status, 0, output.slice(-4000));
  assert.match(result.stdout, /kit suite run was cut off after \d+ s \(limit 8 s\)/, output.slice(-4000));
  assert.doesNotMatch(result.stdout, /test temp paths left behind/);
  assert.deepEqual(strays(outer, true), [], "processes from the cut-off suite still running");
  const runtime = `tsx-${process.getuid?.() ?? 0}`;
  assert.deepEqual(entries(outer).filter(name => name !== runtime || entries(join(outer, name)).length > 0), []);
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
  const steps = (paths: string[], full = false) => checkSteps(classify(paths.map(path => ({ status: "M", path })), { full })).steps;
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
        env: { ...process.env, ASE_SKIP_DOCTOR: "1" },
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
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "5s" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(join(out, "out.md"), "utf8"), "test report\n");
  assert.equal(existsSync(join(worktree, ".scratch/agent")), false);
});
