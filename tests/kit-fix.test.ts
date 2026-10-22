import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { forEachAwait } from "./support/await-race.ts";

const kit = resolve("scripts/agents/kit"), fix = resolve("scripts/agents/kit.d/fix");
const briefHelper = resolve("scripts/agents/review-brief.mjs");
const defect = "abc:file.txt:1, P1, preserve the required text; restore it.";
const clean = "REVIEW_STATUS: complete\nDefects:\nSpec: none\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
const findings = `REVIEW_STATUS: complete\nDefects:\nSpec:\n- ${defect}\n  Evidence: the ticket requires this exact text.\nStandards: none\nValidation gaps: none\nOptional nits: none\n`;
interface Call { args: string[]; input: string; cwd: string }

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ase-kit-fix-"));
  const children: ChildProcess[] = [];
  const releases: string[] = [];
  t.after(async () => {
    for (const path of releases) writeFileSync(path, "cleanup");
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      child.kill("SIGTERM");
      return new Promise<void>(resolve => child.once("close", () => resolve()));
    }));
    rmSync(dir, { recursive: true, force: true });
  });
  const root = join(dir, "work tree"), main = join(dir, "main"), bin = join(dir, "bin"), commands = join(dir, "commands");
  for (const path of [root, main, bin, commands]) mkdirSync(path);
  const callsFile = join(dir, "calls.jsonl"), reviewCall = join(dir, "review.json");
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-b", "build/ke-03");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  git("config", "core.hooksPath", "/dev/null");
  writeFileSync(join(root, ".gitignore"), ".scratch/\n");
  writeFileSync(join(root, "file.txt"), "original\n");
  const ticket = "docs/tickets/03.md";
  mkdirSync(join(root, "docs/tickets"), { recursive: true });
  writeFileSync(join(root, ticket), "## Files\n- `file.txt`\n");
  git("add", "."); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "file.txt"), "broken\n");
  git("add", "."); git("commit", "-m", "build");
  const head = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/dev", base);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), input = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args, input, cwd: process.cwd() }) + "\\n");
console.error("model: " + args[args.indexOf("-m") + 1]);
console.error("session id: builder-session");
if (process.env.FAKE_HOLD) await new Promise(resolve => {
  const timer = setInterval(() => {
    if (existsSync(process.env.FAKE_HOLD)) { clearInterval(timer); resolve(); }
  }, 10);
});
if (process.env.FAKE_MODE !== "no-change" && process.env.FAKE_MODE !== "decline-only") writeFileSync("file.txt", process.env.FAKE_TEXT || "fixed\\n");
writeFileSync(args[args.indexOf("-o") + 1], process.env.FAKE_REPORT || "Fixed the real defect.\\n");
process.exitCode = Number(process.env.FAKE_EXIT || 0);
`);
  chmodSync(join(bin, "codex"), 0o755);
  symlinkSync(fix, join(commands, "fix"));
  writeFileSync(join(commands, "review"), `#!/usr/bin/env node
// kit: fake review confined to the temporary repository
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ticketReviewBrief } from ${JSON.stringify(briefHelper)};
const args = process.argv.slice(2), ticket = args[args.indexOf("--ticket") + 1];
writeFileSync(process.env.FAKE_REVIEW_CALL, JSON.stringify({ args, brief: ticketReviewBrief(ticket, "origin/dev", process.cwd()) }));
const directory = join(process.env.KIT_MAIN_ROOT, ".scratch/reviews/ke-03/20990101T000000Z");
mkdirSync(directory, { recursive: true });
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
writeFileSync(join(directory, "refs.txt"), head + "\\n");
if (!process.env.FAKE_MISSING_RESULT) writeFileSync(join(directory, "result.md"), process.env.FAKE_REVIEW_RESULT || ${JSON.stringify(clean)});
console.log("RESULT: ok review git diff origin/dev...HEAD evidence " + directory);
`);
  chmodSync(join(commands, "review"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: root, KIT_MAIN_ROOT: main,
    KIT_COMMANDS_DIR: commands, ASE_OWNER: "ke-03", ASE_SKIP_DOCTOR: "1", ASE_RESUME_POLL_MS: "10", ASE_AGENT_TIMEOUT: "10s",
    FAKE_CALLS: callsFile, FAKE_REVIEW_CALL: reviewCall, ASE_REVIEW_DECLINED: "" };
  const review = (name = "20261019T000000Z", result = findings, reviewedHead = head) => {
    const path = join(main, ".scratch/reviews/ke-03", name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "refs.txt"), `${reviewedHead}\n${base}\n`);
    writeFileSync(join(path, "result.md"), result); return path;
  };
  const builder = (name = "build-100", overrides: Record<string, unknown> = {}) => {
    const path = join(root, ".scratch/agent", name); mkdirSync(path, { recursive: true });
    const brief = join(path, "brief.md"); writeFileSync(brief, `Ticket: \`${ticket}\`\n`);
    writeFileSync(join(path, "status.json"), JSON.stringify({ pid: 2147483647, kind: "build", worktree: root,
      model: "gpt-6.1-sol", cli: "codex", effort: "high", state: "done", exitCode: 0,
      brief, out: path, started: "2026-10-19T00:00:00Z", resumes: 0, session: "builder-session", ...overrides }));
    writeFileSync(join(path, "out.md"), "Old report.\n"); writeFileSync(join(path, "run.log"), "old log\n");
    return path;
  };
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync("bash", [kit, "fix", ...args], { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000 });
    const lines = result.stdout.trim().split("\n").filter(line => line.startsWith("RESULT:"));
    if (!args.includes("--help")) {
      assert.equal(lines.length, 1, result.stdout); assert.equal(result.stdout.trim().split("\n").at(-1), lines[0]);
    }
    return result;
  };
  const calls = (): Call[] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const start = (overrides: NodeJS.ProcessEnv) => {
    for (const path of [overrides.FAKE_HOLD, overrides.FAKE_HOOK_RELEASE]) if (path) releases.push(path);
    const child = spawn("bash", [kit, "fix"], { cwd: root, env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject); child.once("close", status => resolve({ status, stdout, stderr }));
    });
  };
  const reviewInput = (): { args: string[]; brief: string } => JSON.parse(readFileSync(reviewCall, "utf8"));
  return { dir, root, main, ticket, head, base, git, review, builder, run, start, calls, reviewInput, reviewCall };
}

async function until(condition: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `deadline waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const disturbance of ["branch", "HEAD"]) test(`kit fix refuses a ${disturbance} change while its builder is held`, async t => {
  const count = await forEachAwait(race => {
    const f = fixture(t); f.review(); f.builder();
    const release = join(f.dir, "release");
    const result = f.start({ FAKE_HOLD: release });
    return { f, done: (async () => {
      await race.port("held builder", () => until(() => f.calls().length > 0, "held builder"))();
      writeFileSync(release, "go");
      return result;
    })() };
  }, async ({ f }) => {
    await until(() => f.calls().length > 0, "held builder");
    if (disturbance === "branch") f.git("switch", "-c", "other-branch");
    else f.git("commit", "--allow-empty", "-m", "concurrent change");
  }, async ({ f, done }) => {
    const result = await done;
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /branch or HEAD changed/);
    assert.equal(f.git("diff", "--cached", "--name-only"), "", "fix must not stage anything");
    assert.equal(f.git("rev-parse", "build/ke-03"), disturbance === "branch" ? f.head : f.git("rev-parse", "HEAD"));
    assert.equal(f.git("log", "-1", "--format=%s"), disturbance === "branch" ? "build" : "concurrent change");
    assert.equal(existsSync(f.reviewCall), false, "fix must not start another review");
    assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
    assert.equal(readFileSync(join(f.root, "file.txt"), "utf8"), "fixed\n");
  });
  assert.equal(count, 1);
});

test("kit fix stages in the normal index and runs the validation hook", async t => {
  const f = fixture(t); f.review(); f.builder();
  const hooks = join(f.dir, "hooks"); mkdirSync(hooks);
  const hook = join(hooks, "pre-commit"), ready = join(f.dir, "hook-ready"), release = join(f.dir, "hook-release");
  writeFileSync(hook, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.FAKE_HOOK_READY, "ready");
const timer = setInterval(() => {
  if (existsSync(process.env.FAKE_HOOK_RELEASE)) clearInterval(timer);
}, 10);
`);
  chmodSync(hook, 0o755); f.git("config", "core.hooksPath", hooks);
  const done = f.start({ FAKE_HOOK_READY: ready, FAKE_HOOK_RELEASE: release });
  await until(() => existsSync(ready), "pre-commit hook");
  assert.equal(f.git("diff", "--cached", "--name-only"), "file.txt", "hook sees the normal staged files");
  assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
  assert.equal(existsSync(join(f.root, ".git/HEAD.lock")), false);
  assert.equal(f.git("branch", "--show-current"), "build/ke-03");
  writeFileSync(release, "go");
  const result = await done;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.git("rev-parse", "HEAD^"), f.head);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
  assert.equal(existsSync(join(f.root, ".git/HEAD.lock")), false);
});

test("kit fix fails clearly and skips review when the validation hook moves HEAD", t => {
  const f = fixture(t); f.review(); f.builder();
  const hooks = join(f.dir, "hooks"); mkdirSync(hooks);
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, `#!/bin/sh\ngit update-ref refs/heads/build/ke-03 ${f.base} ${f.head}\n`);
  chmodSync(hook, 0o755); f.git("config", "core.hooksPath", hooks);
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /branch or HEAD changed/);
  assert.equal(f.git("rev-parse", "HEAD"), f.base);
  assert.equal(f.git("diff", "--cached", "--name-only"), "file.txt", "staged changes remain available after failure");
  assert.equal(existsSync(f.reviewCall), false);
  assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
  assert.equal(existsSync(join(f.root, ".git/HEAD.lock")), false);
});

test("kit fix help and argument errors do not start a builder", t => {
  const f = fixture(t);
  assert.match(f.run(["--help"]).stdout, /Usage: kit fix/);
  for (const args of [["--wat"], ["--run"], ["--review", "--ticket"], ["--ticket", "a", "--ticket", "b"]]) {
    assert.equal(f.run(args).status, 2);
  }
  assert.equal(f.calls().length, 0);
});

test("kit fix ignores reviews for other HEADs, picks the newest covering review, and skips a clean review", t => {
  const f = fixture(t);
  f.review("20261017T000000Z", findings, f.base);
  f.review("20261018T000000Z", findings);
  f.review("20261019T000000Z", clean);
  f.review("20261020T000000Z", findings, f.base);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "RESULT: ok fix clean");
  assert.equal(f.calls().length, 0); assert.equal(existsSync(f.reviewCall), false);
  assert.equal(existsSync(join(f.root, ".scratch/kit-fix")), false);
});

test("kit fix reports missing reviews and tickets clearly and fails closed on unreadable evidence", t => {
  const f = fixture(t);
  f.review("20261018T000000Z", clean, f.base);
  assert.equal(f.run().stdout.trim(), "RESULT: fail fix no review covers HEAD");
  const path = f.review();
  const missing = f.run(); assert.equal(missing.status, 1); assert.match(missing.stdout, /no ticket found/);
  rmSync(join(path, "result.md"));
  assert.match(f.run().stdout, /1 open findings .*review format unreadable/);
  assert.equal(f.calls().length, 0);
});

test("kit fix starts a fresh builder without a slice state, with default or explicit model", t => {
  for (const model of [undefined, "gpt-6.1-sol", "sol"]) {
    const f = fixture(t); f.review();
    // An incomplete builder record cannot be resumed.
    f.builder("build-100", { session: null });
    const result = f.run(["--ticket", f.ticket, ...(model ? ["--builder", model] : [])]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /no resumable builder run; starting fresh agent.sh build \(gpt-6.1-sol\)/);
    const [call] = f.calls(); assert.equal(f.calls().length, 1);
    assert.equal(call.args.includes("resume"), false);
    assert.equal(call.args[call.args.indexOf("-m") + 1], "gpt-6.1-sol");
    assert.ok(call.input.includes(findings)); assert.ok(call.input.includes("scripts/agents/kit"));
    assert.equal(f.git("status", "--porcelain"), "");
    assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: GPT-6.1-Sol/);
    assert.deepEqual(f.reviewInput().args, ["--ticket", f.ticket]);
  }
});

test("fresh fallback uses the latest matching slice model and ticket, unless --builder overrides it", t => {
  for (const override of [false, true]) {
    const f = fixture(t); f.review();
    const parent = join(f.root, ".scratch/kit-slice");
    for (const [name, model, branch] of [["01-old", "unused-old-model", "build/ke-03"],
      ["02-latest", "slice-model", "build/ke-03"], ["03-foreign", "foreign-model", "other-branch"]]) {
      const folder = join(parent, name); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "state.json"), JSON.stringify({ model, branch, ticket: f.ticket }));
    }
    const result = f.run(override ? ["--builder", "gpt-6.1-sol"] : []);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [call] = f.calls();
    assert.equal(call.args[call.args.indexOf("-m") + 1], override ? "gpt-6.1-sol" : "slice-model");
    assert.equal(call.args.includes("resume"), false);
    assert.deepEqual(f.reviewInput().args, ["--ticket", f.ticket]);
  }
});

test("kit fix --builder resumes only a saved session of that model", t => {
  const f = fixture(t); f.review();
  const wanted = f.builder("build-10", { model: "wanted-model", started: "2026-10-18T00:00:00Z" });
  const newer = f.builder("build-20", { model: "other-model", started: "2026-10-19T00:00:00Z" });
  const result = f.run(["--builder", "wanted-model"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [call] = f.calls(); assert.equal(f.calls().length, 1);
  assert.deepEqual(call.args.slice(0, 2), ["exec", "resume"]);
  assert.ok(call.args.includes("builder-session"));
  assert.equal(call.args[call.args.indexOf("-m") + 1], "wanted-model");
  assert.equal(JSON.parse(readFileSync(join(wanted, "status.json"), "utf8")).resumes, 1);
  assert.equal(JSON.parse(readFileSync(join(newer, "status.json"), "utf8")).resumes, 0);
  assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: wanted-model/);
});

test("kit fix --builder starts a fresh builder when only another model is saved", t => {
  const f = fixture(t); f.review();
  const other = f.builder("build-10", { model: "other-model" });
  const result = f.run(["--builder", "wanted-model", "--ticket", f.ticket]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no resumable builder run; starting fresh agent\.sh build \(wanted-model\)/);
  const [call] = f.calls(); assert.equal(f.calls().length, 1);
  assert.equal(call.args.includes("resume"), false);
  assert.equal(call.args[call.args.indexOf("-m") + 1], "wanted-model");
  assert.equal(JSON.parse(readFileSync(join(other, "status.json"), "utf8")).resumes, 0);
  assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: wanted-model/);
});

test("kit fix --builder retargets a pending builder round to the new model and keeps its edits", t => {
  const f = fixture(t); f.review();
  const first = f.run(["--ticket", f.ticket, "--builder", "gpt-6.1-sol"], { FAKE_EXIT: "7" });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  const pendingPath = join(f.root, ".scratch/kit-fix/build%2Fke-03/pending.json");
  const pending: { phase: string; model: string; effort: string; run: string } = JSON.parse(readFileSync(pendingPath, "utf8"));
  assert.equal(pending.phase, "builder"); assert.equal(pending.model, "gpt-6.1-sol");
  const result = f.run(["--builder", "other-model"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> other-model/);
  assert.equal(existsSync(pendingPath), false);
  const [build, retry] = f.calls();
  assert.equal(build.args.includes("resume"), false);
  assert.equal(build.args[build.args.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.equal(retry.args.includes("resume"), false);
  assert.equal(retry.args[retry.args.indexOf("-m") + 1], "other-model");
  const run = dirname(retry.args[retry.args.indexOf("-o") + 1]);
  assert.notEqual(run, pending.run, "the switched round gets a fresh run folder");
  assert.equal(JSON.parse(readFileSync(join(run, "status.json"), "utf8")).model, "other-model");
  assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: other-model/);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("a pending commit or review round still refuses another model or effort", t => {
  for (const phase of ["commit", "review"]) {
    const f = fixture(t);
    const pendingPath = join(f.root, ".scratch/kit-fix/build%2Fke-03/pending.json");
    mkdirSync(join(f.root, ".scratch/kit-fix/build%2Fke-03"), { recursive: true });
    writeFileSync(pendingPath, JSON.stringify({ root: f.root, branch: "build/ke-03", model: "gpt-6.1-sol",
      effort: "high", phase, review: join(f.main, ".scratch/reviews/ke-03/20261019T000000Z") }));
    const model = f.run(["--builder", "other-model"]);
    assert.equal(model.status, 1, model.stdout + model.stderr);
    assert.match(model.stdout, /pending fix belongs/);
    const effort = f.run(["--effort", "low"]);
    assert.equal(effort.status, 1, effort.stdout + effort.stderr);
    assert.match(effort.stdout, /pending fix belongs/);
    assert.equal(f.calls().length, 0);
  }
});

interface Pending { phase: string; model: string; effort?: string; run: string; previousEfforts?: string[] }

test("a pending round saved without an effort resumes at the high default", t => {
  for (const phase of ["commit", "builder"]) {
    const f = fixture(t); f.review();
    const first = f.run(["--ticket", f.ticket], { FAKE_EXIT: "7" });
    assert.equal(first.status, 1, first.stdout + first.stderr);
    const pendingPath = join(f.root, ".scratch/kit-fix/build%2Fke-03/pending.json");
    const { effort: _, ...legacy }: Pending = JSON.parse(readFileSync(pendingPath, "utf8"));
    writeFileSync(pendingPath, JSON.stringify({ ...legacy, phase }));
    const result = f.run(["--builder", "gpt-6.1-sol", "--effort", "high"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /pending fix belongs|builder switched/);
    assert.equal(f.calls().length, phase === "commit" ? 1 : 2);
    if (phase === "builder") assert.deepEqual(f.calls()[1].args.slice(0, 2), ["exec", "resume"]);
    assert.equal(f.git("status", "--porcelain"), "");
  }
});

test("a fresh fallback without --effort uses the latest slice effort", t => {
  const f = fixture(t); f.review();
  const folder = join(f.root, ".scratch/kit-slice/current"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "state.json"), JSON.stringify({ model: "gpt-6.1-sol", effort: "low", branch: "build/ke-03", ticket: f.ticket }));
  const result = f.run(["--ticket", f.ticket]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [call] = f.calls(); assert.equal(f.calls().length, 1);
  assert.equal(call.args.includes("resume"), false);
  assert.ok(call.args.includes("model_reasoning_effort=low"));
});

test("kit fix --effort alone retargets a pending builder round to the new effort", t => {
  const f = fixture(t); f.review();
  const first = f.run(["--ticket", f.ticket], { FAKE_EXIT: "7" });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  const result = f.run(["--effort", "low"], { FAKE_EXIT: "7" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /builder switched: gpt-6\.1-sol -> gpt-6\.1-sol \(low\)/);
  const pending: Pending = JSON.parse(readFileSync(join(f.root, ".scratch/kit-fix/build%2Fke-03/pending.json"), "utf8"));
  assert.deepEqual(pending.previousEfforts, ["high"]); assert.equal(pending.effort, "low");
  const [, retry] = f.calls();
  assert.equal(retry.args.includes("resume"), false);
  assert.ok(retry.args.includes("model_reasoning_effort=low"));
});

test("a failed retargeted round reruns with the same --run and --builder", t => {
  const f = fixture(t); f.review();
  const saved = f.builder("build-10");
  const args = ["--run", saved, "--builder", "other-model", "--ticket", f.ticket];
  const first = f.run(["--run", saved, "--ticket", f.ticket], { FAKE_EXIT: "7" });
  assert.equal(first.status, 1, first.stdout + first.stderr);
  const switched = f.run(args, { FAKE_EXIT: "7" });
  assert.equal(switched.status, 1, switched.stdout + switched.stderr);
  assert.match(switched.stdout, /builder switched: gpt-6\.1-sol -> other-model/);
  const result = f.run(args);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /pending fix belongs|builder switched/);
  const [, retarget, rerun] = f.calls(); assert.equal(f.calls().length, 3);
  assert.equal(retarget.args.includes("resume"), false);
  assert.deepEqual(rerun.args.slice(0, 2), ["exec", "resume"]);
  assert.equal(rerun.args[rerun.args.indexOf("-m") + 1], "other-model");
  assert.match(f.git("log", "-1", "--format=%B"), /Co-Authored-By: other-model/);
});

test("kit fix --builder --effort resumes the matching effort over a newer session of another effort", t => {
  const f = fixture(t); f.review();
  const high = f.builder("build-10", { effort: "high", started: "2026-10-18T00:00:00Z" });
  const medium = f.builder("build-20", { effort: "medium", started: "2026-10-19T00:00:00Z" });
  const result = f.run(["--builder", "gpt-6.1-sol", "--effort", "high"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [call] = f.calls(); assert.equal(f.calls().length, 1);
  assert.deepEqual(call.args.slice(0, 2), ["exec", "resume"]);
  assert.ok(call.args.includes("model_reasoning_effort=high"));
  assert.equal(JSON.parse(readFileSync(join(high, "status.json"), "utf8")).resumes, 1);
  assert.equal(JSON.parse(readFileSync(join(medium, "status.json"), "utf8")).resumes, 0);
});

test("kit fix --builder errors on an unreadable or foreign --run and ignores another model with a line", t => {
  const missing = fixture(t); missing.review();
  const unreadable = missing.run(["--run", "missing", "--builder", "wanted-model", "--ticket", missing.ticket]);
  assert.equal(unreadable.status, 1, unreadable.stdout + unreadable.stderr);
  assert.match(unreadable.stdout, /RESULT: fail fix invalid builder run for this worktree/);
  assert.equal(missing.calls().length, 0);

  const foreign = fixture(t); foreign.review();
  const stranger = foreign.builder("build-10", { worktree: foreign.main });
  const refused = foreign.run(["--run", stranger, "--builder", "wanted-model", "--ticket", foreign.ticket]);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /RESULT: fail fix invalid builder run for this worktree/);
  assert.equal(foreign.calls().length, 0);

  const other = fixture(t); other.review();
  const saved = other.builder("build-10", { model: "other-model" });
  const result = other.run(["--run", saved, "--builder", "wanted-model", "--ticket", other.ticket]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`--run ${saved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is other-model; starting fresh with wanted-model`));
  const [call] = other.calls();
  assert.equal(call.args.includes("resume"), false);
  assert.equal(call.args[call.args.indexOf("-m") + 1], "wanted-model");
  assert.equal(JSON.parse(readFileSync(join(saved, "status.json"), "utf8")).resumes, 0);
});

test("kit fix --run X --effort keeps X's model for the fresh builder it names", t => {
  const f = fixture(t); f.review();
  const folder = join(f.root, ".scratch/kit-slice/current"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "state.json"), JSON.stringify({ model: "gpt-6.1-sol", effort: "high", branch: "build/ke-03", ticket: f.ticket }));
  const saved = f.builder("build-10", { model: "other-model", effort: "high" });
  const result = f.run(["--run", saved, "--effort", "low", "--ticket", f.ticket]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const line = /^--run .+ is (.+); starting fresh with (.+)$/m.exec(result.stdout);
  assert.deepEqual(line?.slice(1), ["other-model", "other-model (low)"], result.stdout);
  const [call] = f.calls(); assert.equal(f.calls().length, 1);
  assert.equal(call.args.includes("resume"), false);
  assert.equal(call.args[call.args.indexOf("-m") + 1], "other-model");
  assert.ok(call.args.includes("model_reasoning_effort=low"));
  assert.equal(JSON.parse(readFileSync(join(saved, "status.json"), "utf8")).resumes, 0);
});

test("kit fix passes an explicit effort to a fresh builder instead of resuming another effort", t => {
  const f = fixture(t); f.review();
  const saved = f.builder("build-10", { model: "gpt-6.1-sol", effort: "high" });
  const result = f.run(["--ticket", f.ticket, "--builder", "gpt-6.1-sol", "--effort", "low"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [call] = f.calls(); assert.equal(f.calls().length, 1);
  assert.equal(call.args.includes("resume"), false);
  assert.ok(call.args.includes("model_reasoning_effort=low"));
  assert.equal(JSON.parse(readFileSync(join(saved, "status.json"), "utf8")).resumes, 0);
  const run = dirname(call.args[call.args.indexOf("-o") + 1]);
  assert.equal(JSON.parse(readFileSync(join(run, "status.json"), "utf8")).effort, "low");
});

test("subsequent fix rounds resume the fresh builder with its explicit model, ahead of older slice builders", t => {
  for (const withSlice of [false, true]) {
    const f = fixture(t); f.review();
    let older: string | undefined;
    if (withSlice) {
      older = f.builder("build-100", { session: null, model: "older-model" });
      const folder = join(f.root, ".scratch/kit-slice/current"); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "state.json"), JSON.stringify({
        model: "older-model", branch: "build/ke-03", ticket: f.ticket, build: older,
      }));
    }
    const first = f.run(["--ticket", f.ticket, "--builder", "explicit-model"], { FAKE_REVIEW_RESULT: findings });
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.match(first.stdout, /starting fresh agent.sh build \(explicit-model\)/);
    assert.match(first.stdout, /1 open findings/);
    const directory = join(f.root, ".scratch/kit-fix/build%2Fke-03");
    assert.equal(existsSync(join(directory, "pending.json")), false, "completed round clears its pending state");
    const runs = join(f.root, ".scratch/agent");
    const fresh = readdirSync(runs).filter(name => name.startsWith("build-") && name !== "build-100");
    assert.equal(fresh.length, 1, "fresh run remains in normal builder discovery");
    const statusPath = join(runs, fresh[0], "status.json");
    const original: { session: string; model: string; resumes: number } = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(original.model, "explicit-model"); assert.equal(original.resumes, 0);
    if (older) f.builder("build-100", { model: "older-model", session: "older-session" });

    const second = f.run([], { FAKE_TEXT: "second round fixed\n" });
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.doesNotMatch(second.stdout, /starting fresh/);
    assert.equal(f.calls().length, 2);
    const [build, resume] = f.calls();
    assert.equal(build.args.includes("resume"), false);
    assert.deepEqual(resume.args.slice(0, 2), ["exec", "resume"]);
    assert.ok(resume.args.includes(original.session));
    assert.equal(resume.args[resume.args.indexOf("-m") + 1], original.model);
    const updated: { model: string; resumes: number; brief: string } = JSON.parse(readFileSync(statusPath, "utf8"));
    assert.equal(updated.model, original.model); assert.equal(updated.resumes, 1);
    assert.equal(updated.brief, join(directory, "round-2.md"));
    assert.equal(f.git("status", "--porcelain"), "");
  }
});

test("kit fix resumes a builder stored in slice state", t => {
  const f = fixture(t); f.review();
  const folder = join(f.root, ".scratch/kit-slice/current"); mkdirSync(folder, { recursive: true });
  const builder = f.builder("build-original");
  // kit slice keeps its builder below kit-slice, outside default .scratch/agent discovery.
  const nested = join(folder, "builder"); symlinkSync(builder, nested);
  writeFileSync(join(folder, "state.json"), JSON.stringify({ model: "gpt-6.1-sol", branch: "build/ke-03", ticket: f.ticket, build: nested }));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const status: { resumes: number } = JSON.parse(readFileSync(join(builder, "status.json"), "utf8"));
  assert.equal(status.resumes, 1);
});

test("--note sends a failure verbatim instead of review findings, then commits and reviews", t => {
  for (const fresh of [false, true]) {
    const f = fixture(t);
    if (!fresh) f.builder();
    f.review("20261019T000000Z", clean);
    const note = join(f.dir, "ci digest.md"), text = "CI / checks failed\nfile.txt:1 expected required text\n";
    writeFileSync(note, text);
    const result = f.run(["--note", note, "--ticket", f.ticket]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const [call] = f.calls(); assert.equal(f.calls().length, 1);
    assert.ok(call.input.includes(`Failure note (verbatim):\n${text}`));
    assert.equal(call.input.includes("Review evidence"), false);
    assert.equal(call.args.includes("resume"), !fresh);
    assert.equal(f.git("status", "--porcelain"), "");
    assert.equal(f.git("rev-parse", "HEAD^"), f.head);
    assert.deepEqual(f.reviewInput().args, ["--ticket", f.ticket]);
  }
});

test("a failed fresh note round resumes its saved session and note without discarding edits", t => {
  const f = fixture(t), note = join(f.dir, "ci.md"); writeFileSync(note, "Original CI failure\n");
  const first = f.run(["--note", note, "--ticket", f.ticket], { FAKE_EXIT: "7" });
  assert.equal(first.status, 1); assert.match(first.stdout, /builder failed \(7\)/);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
  const otherNote = join(f.dir, "other.md"); writeFileSync(otherNote, "Other failure\n");
  const mismatched = f.run(["--note", otherNote]);
  assert.equal(mismatched.status, 1); assert.match(mismatched.stdout, /pending fix belongs/);
  rmSync(note);
  const retry = f.run();
  assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(f.calls().length, 2);
  assert.equal(f.calls()[1].args.includes("resume"), true);
  assert.ok(f.calls()[1].input.includes("Original CI failure\n"));
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("rev-parse", "HEAD^"), f.head);
});

test("invalid --note input and explicit non-resumable runs fail before starting a builder", t => {
  const f = fixture(t); f.review();
  const note = join(f.dir, "empty.md"); writeFileSync(note, " \n");
  for (const args of [["--note", note], ["--note", join(f.dir, "missing.md")], ["--run", "missing", "--ticket", f.ticket]]) {
    const result = f.run(args); assert.equal(result.status, 1, result.stdout + result.stderr);
  }
  for (const args of [["--note"], ["--builder"], ["--note", note, "--review", "elsewhere"]]) assert.equal(f.run(args).status, 2);
  assert.equal(f.calls().length, 0);
});

test("kit fix resumes the newest matching builder, preserves evidence verbatim, commits and re-reviews declined reasons", t => {
  const f = fixture(t); const review = f.review();
  f.builder("build-10"); const builder = f.builder("build-20");
  f.builder("build-30", { worktree: f.main }); f.builder("build-40", { kind: "review" });
  const reason = "file.txt:2 — declined: the ticket explicitly requires this line.";
  const result = f.run([], { FAKE_REPORT: `Fixed text.\nDeclined:\n- ${reason}\n` });
  assert.equal(result.status, 0, result.stderr + result.stdout); assert.equal(result.stdout.trim(), "RESULT: ok fix clean");
  const [call] = f.calls(); assert.equal(f.calls().length, 1); assert.equal(call.cwd, f.root);
  assert.deepEqual(call.args.slice(0, 2), ["exec", "resume"]);
  assert.ok(call.args.includes("builder-session")); assert.ok(call.args.includes("model_reasoning_effort=high"));
  assert.ok(call.input.includes(`Ticket: ${f.ticket}`)); assert.ok(call.input.includes(findings));
  assert.ok(call.input.includes("Fix real defects within the ticket's Files."));
  assert.equal(readFileSync(join(review, "result.md"), "utf8"), findings);
  assert.match(f.git("log", "-1", "--format=%B"), /^Review fixes round 1\n\nCo-Authored-By: GPT-6.1-Sol <noreply@openai.com>$/);
  assert.equal(f.git("status", "--porcelain"), "");
  const status: { resumes: number; brief: string } = JSON.parse(readFileSync(join(builder, "status.json"), "utf8"));
  assert.equal(status.resumes, 1); assert.match(status.brief, /\.scratch\/kit-fix\/.+\/round-1\.md$/);
  assert.deepEqual(f.reviewInput().args, ["--ticket", f.ticket]); assert.ok(f.reviewInput().brief.includes(reason));
  assert.match(f.reviewInput().brief, /Report a declined finding again only if the reason is wrong/);
});

test("explicit review and run override discovery; outstanding findings report the saved result path", t => {
  const f = fixture(t), explicit = f.review("20261001T000000Z");
  f.review("20261019T000000Z", clean); const builder = f.builder("build-10"); f.builder("build-20");
  const result = f.run(["--review", explicit, "--run", builder, "--ticket", f.ticket], { FAKE_REVIEW_RESULT: findings });
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(result.stdout.trim(), `RESULT: fail fix 1 open findings (${join(f.main, ".scratch/reviews/ke-03/20990101T000000Z/result.md")})`);
  const status: { resumes: number } = JSON.parse(readFileSync(join(builder, "status.json"), "utf8"));
  assert.equal(status.resumes, 1);
});

test("no changes without a fresh declined list fails; old declined reports do not count", t => {
  const f = fixture(t); f.review(); const builder = f.builder();
  writeFileSync(join(builder, "out.md"), "Declined:\n- Old finding — old reason.\n");
  const result = f.run([], { FAKE_MODE: "no-change" });
  assert.equal(result.status, 1); assert.equal(result.stdout.trim(), "RESULT: fail fix builder made no changes");
  assert.equal(f.git("rev-parse", "HEAD"), f.head); assert.equal(existsSync(f.reviewCall), false);
});

test("declined-only rounds review without an empty commit, and round numbers advance per branch", t => {
  const f = fixture(t); f.review(); f.builder();
  for (let round = 1; round <= 2; round++) {
    const result = f.run([], { FAKE_MODE: "decline-only", FAKE_REPORT: "Declined:\n- file.txt:1 — already follows the ticket.\n", FAKE_REVIEW_RESULT: findings });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /1 open findings/);
    assert.equal(f.git("rev-parse", "HEAD"), f.head);
    assert.ok(existsSync(join(f.root, ".scratch/kit-fix/build%2Fke-03", `round-${round}.md`)));
  }
  f.git("switch", "-c", "another-branch");
  const result = f.run([], { FAKE_MODE: "decline-only", FAKE_REPORT: "Declined: file.txt:1 — already correct.\n" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readdirSync(join(f.root, ".scratch/kit-fix/another-branch")).filter(name => name.endsWith(".md")), ["round-1.md"]);
});

test("builder failure, missing review result and dirty input never report success", t => {
  const f = fixture(t); f.review(); f.builder();
  writeFileSync(join(f.root, "file.txt"), "uncommitted\n");
  assert.match(f.run().stdout, /uncommitted changes before builder resume/); assert.equal(f.calls().length, 0);
  writeFileSync(join(f.root, "file.txt"), "broken\n");
  const failed = f.run([], { FAKE_EXIT: "7", FAKE_MODE: "no-change" });
  assert.equal(failed.status, 1); assert.match(failed.stdout, /builder failed \(7\)/);
  const missing = f.run([], { FAKE_MISSING_RESULT: "1" });
  assert.equal(missing.status, 1); assert.match(missing.stdout, /1 open findings/);
});

test("kit fix never publishes to another branch switched during a held pre-commit hook", async t => {
  const f = fixture(t); f.review(); f.builder();
  f.git("branch", "other-branch", f.head);
  const hooks = join(f.dir, "hooks"); mkdirSync(hooks);
  const hook = join(hooks, "pre-commit"), ready = join(f.dir, "ready"), release = join(f.dir, "release");
  writeFileSync(hook, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
writeFileSync(process.env.FAKE_HOOK_READY, "ready");
const timer = setInterval(() => { if (existsSync(process.env.FAKE_HOOK_RELEASE)) clearInterval(timer); }, 10);
`);
  chmodSync(hook, 0o755); f.git("config", "core.hooksPath", hooks);
  const done = f.start({ FAKE_HOOK_READY: ready, FAKE_HOOK_RELEASE: release });
  try {
    await until(() => existsSync(ready), "held pre-commit hook");
    f.git("switch", "other-branch");
  } finally { writeFileSync(release, "go"); }
  const result = await done;
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /branch or HEAD changed/);
  assert.equal(f.git("branch", "--show-current"), "other-branch");
  assert.equal(f.git("rev-parse", "other-branch"), f.head, "foreign branch must remain untouched");
  assert.equal(f.git("rev-parse", "build/ke-03"), f.head, "captured branch must not publish after a switch");
  assert.equal(existsSync(f.reviewCall), false, "no review may start after scope changes");
  assert.equal(existsSync(join(f.root, ".git/index.lock")), false);
  assert.equal(existsSync(join(f.root, ".git/HEAD.lock")), false);
});
