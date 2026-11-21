// review-run.mjs: the review and the second look that kit review prints and kit pr calls in its own process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { resultLine, review, secondLook } from "../review-run.mjs";

// A project with two commits, which process.env.KIT_ROOT names while the test runs, and an io that keeps what is written.
// HOME and the XDG folders point into the temporary folder too, so no run can touch the real budget or a CLI's login.
function project(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const temporary = mkdtempSync(join(tmpdir(), "review-run-")), root = join(temporary, "project"), home = join(temporary, "home");
  mkdirSync(root); mkdirSync(home);
  const own = { KIT_ROOT: root, HOME: home, XDG_STATE_HOME: join(home, ".local/state"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share") };
  const saved = Object.fromEntries([...Object.keys(own), ...Object.keys(env)].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    rmSync(temporary, { recursive: true, force: true });
  });
  Object.assign(process.env, own, env);
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Kit test"); git("config", "user.email", "kit@example.com");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "review-run", branches: { land: "main" } }));
  git("add", "."); git("commit", "-q", "-m", "base");
  writeFileSync(join(root, "a.txt"), "a\n"); git("add", "."); git("commit", "-q", "-m", "change");
  const io = { stdout: "", stderr: "", out(text: string) { io.stdout += text; }, err(text: string) { io.stderr += text; } };
  return { root, io, head: git("rev-parse", "HEAD") };
}

test("resultLine prints an outcome as kit review's RESULT line: one line, user info hidden, a skip's words as they are", () => {
  assert.equal(resultLine({ status: "ok", text: "review git diff a...b evidence /x" }), "RESULT: ok review git diff a...b evidence /x");
  assert.equal(resultLine({ status: "fail", text: "push to https://user:token@example.com/r.git\nfailed" }), "RESULT: fail push to https://example.com/r.git failed");
  assert.equal(resultLine({ status: "skip", text: "second look (grok-4.7 out of credit)" }), "RESULT: skip second look (grok-4.7 out of credit)");
});

test("review on an empty scope returns the skip kit pr reads, with no evidence, and writes its line through io", async t => {
  const f = project(t);
  const outcome = await review({ base: "HEAD" }, f.io);
  assert.deepEqual(outcome, { exit: 3, status: "skip", text: `review nothing to review (git diff ${f.head}...HEAD is empty)`, nothing: `git diff ${f.head}...HEAD is empty` });
  assert.equal(f.io.stdout, `nothing to review: git diff ${f.head}...HEAD is empty\n`);
  assert.equal(f.io.stderr, "");
});

test("secondLook returns its skip and its notes as fields, and a broken setting as a failure with its problem line", async t => {
  const f = project(t, { ASE_SECOND_LOOK_TIMEOUT: "25m" });
  const skipped = await secondLook({ base: "HEAD", secondLook: true }, f.io);
  const why = `nothing to review: git diff ${f.head}...HEAD is empty`;
  assert.deepEqual(skipped, { exit: 3, status: "skip", text: `second look (${why})`, skipped: `second look: skipped (${why})`, notes: [`second look: skipped (${why})`] });
  assert.equal(f.io.stdout, `second look: skipped (${why})\n`);
  process.env.ASE_SECOND_LOOK_TIMEOUT = "soon";
  const failed = await secondLook({ base: "HEAD~1", secondLook: true }, f.io);
  const message = "ASE_SECOND_LOOK_TIMEOUT must be a duration such as 25m (got soon)";
  assert.deepEqual(failed, { exit: 1, status: "fail", text: `${message} evidence none`, notes: [] });
  assert.equal(f.io.stderr, `problem: ${message}\n`);
});
