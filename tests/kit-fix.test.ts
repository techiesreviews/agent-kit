import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const kit = resolve("scripts/agents/kit"), fix = resolve("scripts/agents/kit.d/fix");
const briefHelper = resolve("scripts/agents/review-brief.mjs");
const defect = "abc:file.txt:1, P1, preserve the required text; restore it.";
const clean = "REVIEW_STATUS: complete\nDefects:\nSpec: none\nStandards: none\nValidation gaps: none\nOptional nits: none\n";
const findings = `REVIEW_STATUS: complete\nDefects:\nSpec:\n- ${defect}\n  Evidence: the ticket requires this exact text.\nStandards: none\nValidation gaps: none\nOptional nits: none\n`;
interface Call { args: string[]; input: string; cwd: string }

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ase-kit-fix-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2), input = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args, input, cwd: process.cwd() }) + "\\n");
console.error("model: " + args[args.indexOf("-m") + 1]);
console.error("session id: builder-session");
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
  const reviewInput = (): { args: string[]; brief: string } => JSON.parse(readFileSync(reviewCall, "utf8"));
  return { dir, root, main, ticket, head, base, git, review, builder, run, calls, reviewInput, reviewCall };
}

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

test("kit fix reports missing reviews and builder runs clearly and fails closed on unreadable evidence", t => {
  const f = fixture(t);
  f.review("20261018T000000Z", clean, f.base);
  assert.equal(f.run().stdout.trim(), "RESULT: fail fix no review covers HEAD");
  const path = f.review();
  const missing = f.run(); assert.equal(missing.status, 1); assert.match(missing.stdout, /no builder run found/);
  rmSync(join(path, "result.md"));
  assert.match(f.run().stdout, /1 open findings .*review format unreadable/);
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
