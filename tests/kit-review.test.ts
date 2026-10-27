import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { codexReviewConfig, isoWeek, makeCodexReviewHome } from "../scripts/agents/agent-run.mjs";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { builderChecks, reviewBrief, reviewFormat, ticketReviewBrief } from "../scripts/agents/review-brief.mjs";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { saveReviewEvidence } from "../scripts/agents/review-evidence.mjs";

const kit = resolve("scripts/agents/kit");
const review = resolve("scripts/agents/kit.d/review");
const agent = resolve("scripts/agents/agent.sh");
const briefScript = resolve("scripts/agents/review-brief.sh");
const session = "c9aee50d-ad79-499c-82ae-29138c2be80e";
const complete = "REVIEW_STATUS: complete\nDefects: none\n";

interface Call {
  cli: string; args: string[]; input: string; cwd: string; home: string;
  files: string[]; symlink: boolean; target: string | null; config: string;
}

const fake = `#!/usr/bin/env node
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
const cli = basename(process.argv[1]);
const args = process.argv.slice(2);
if (cli === "gh") {
  writeFileSync(process.env.FAKE_GH, JSON.stringify({ args, body: readFileSync(args[args.indexOf("--body-file") + 1], "utf8"), cwd: process.cwd() }));
  process.exit(Number(process.env.FAKE_GH_EXIT || 0));
}
const home = process.env.CODEX_HOME;
const auth = join(home, "auth.json");
const calls = existsSync(process.env.FAKE_CALLS) ? readFileSync(process.env.FAKE_CALLS, "utf8").trim().split("\\n").length : 0;
const symlink = existsSync(auth) && lstatSync(auth).isSymbolicLink();
const input = readFileSync(0, "utf8");
// An unreadable diff makes kit review's evidence copy fail after the review itself worked.
if (process.env.FAKE_LOCK_DIFF) chmodSync(/Read "([^"]+diff\\.patch)"/.exec(input)[1], 0);
// A read-only .scratch/agent lets the review folder empty out but not go away.
// A held ledger lock makes kit review's budget release fail after the call.
if (process.env.FAKE_LOCK_LEDGER) mkdirSync(process.env.FAKE_LOCK_LEDGER, { recursive: true });
if (process.env.FAKE_LOCK_ARTIFACTS) chmodSync(dirname(dirname(/Read "([^"]+diff\\.patch)"/.exec(input)[1])), 0o555);
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cli, args, input, cwd: process.cwd(), home,
  files: readdirSync(home), symlink, target: symlink ? readlinkSync(auth) : null,
  config: existsSync(join(home, "config.toml")) ? readFileSync(join(home, "config.toml"), "utf8") : "" }) + "\\n");
if (process.env.FAKE_ROTATE && symlink && cli === "codex") {
  unlinkSync(auth); writeFileSync(auth, '{"refresh_token":"rotated"}');
}
const resumed = args.includes("resume") || args.includes("--resume");
const mode = process.env.FAKE_MODE || "pass";
const report = mode === "empty-pass" && !resumed ? "" : mode === "retry-fail" || mode === "no-session" || (mode === "retry-pass" && !resumed) || mode === "retry-model" || (mode === "retry-usage-limit" && !resumed) || (mode === "retry-out-of-credit" && !resumed) ? "incomplete reply\\n" : process.env.FAKE_REPORT || ${JSON.stringify(complete)};
const model = mode === "retry-model" && resumed ? "wrong-model" : args[args.indexOf(cli === "claude" ? "--model" : "-m") + 1];
if (cli === "codex") {
  if (!(process.env.FAKE_NO_RETRY_MODEL && resumed)) console.error("model: " + model);
  if (mode !== "no-session") console.error("session id: ${session}");
  console.error("call: " + (calls + 1));
  // Codex echoes the prompt after its header, then logs any work before the limit.
  console.error("--------\\nuser\\n" + input);
  if (mode === "late-usage-limit") console.error("exec\\n/bin/bash -lc 'git diff HEAD~1' in /work\\n succeeded in 12ms:\\ncodex\\nReading the diff.");
  console.error("warning: \`--dangerously-bypass-hook-trust\` is enabled.");
  if (["usage-limit", "late-usage-limit"].includes(mode) || (mode === "retry-usage-limit" && resumed)) {
    console.error("ERROR: You've hit your usage limit. Upgrade to Pro, or try again at Oct 25th, 2026 3:14 PM.");
    process.exit(1);
  }
  if (!(mode === "missing-pass" && !resumed)) writeFileSync(args[args.indexOf("-o") + 1], report);
} else {
  // Grok prints its refusal on stdout, not stderr.
  if (mode === "late-usage-limit") console.error("read_file file.txt");
  if (["usage-limit", "late-usage-limit"].includes(mode)) {
    console.log("You've hit your usage limit. Try again at 9:00 AM.");
    process.exit(1);
  }
  // An empty account stops Grok after a turn of work.
  // The 402 line alone, as an outright refusal of the first call would be.
  if (mode === "out-of-credit-only") { console.log("402 Payment Required: Grok Build usage balance exhausted"); process.exit(1); }
  if (mode === "out-of-credit" || (mode === "retry-out-of-credit" && resumed)) {
    console.error("read_file file.txt");
    console.log("402 Payment Required: Grok Build usage balance exhausted");
    process.exit(1);
  }
  // A provider outage: a 503 closing line after a turn of work.
  if (mode === "outage") { console.error("read_file file.txt"); console.log("503 Service Unavailable"); process.exit(1); }
  // A tool trace and prose that name a 503 and ECONNRESET, then a failure that is not an outage.
  if (mode === "trace-503") { console.error("grep 503 file.txt"); console.error("The handler retries on ECONNRESET."); process.exit(1); }
  // A tool trace that names 402, then a failure that is not about credit.
  if (mode === "trace-402") { console.error("grep 402 file.txt"); process.exit(1); }
  const answer = cli === "grok" ? { text: report } : { result: report };
  const named = cli === "grok" ? { sessionId: "${session}" } : { session_id: "${session}" };
  console.log(JSON.stringify({ ...(mode === "missing-pass" && !resumed ? {} : answer), modelUsage: { [process.env.FAKE_RESULT_MODEL || model]: {} }, ...(mode === "no-session" ? {} : named) }));
}
process.exitCode = Number(process.env.FAKE_EXIT || 0);
`;

function fixture(t: { after: (fn: () => void) => void }, { project = "kit-review", state }: { project?: string; state?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ase-kit-review-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The machine-wide review budget lives under XDG_STATE_HOME; a temp one keeps tests off the real count.
  state ??= join(dir, "state");
  const root = join(dir, "work tree"), bin = join(dir, "bin"), main = join(dir, "main"), home = join(dir, "source-home");
  for (const path of [root, bin, main, home]) mkdirSync(path);
  writeFileSync(join(home, "auth.json"), '{"refresh_token":"original"}');
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  for (const cli of ["codex", "claude", "gh"]) {
    writeFileSync(join(bin, cli), fake); chmodSync(join(bin, cli), 0o755);
  }
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-b", "feature/review");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  const commits: string[] = [];
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project, branches: { land: "dev" }, standards: "CODING_STANDARDS.md" }));
  git("add", "scripts/agents/kit.json");
  for (const text of ["base", "first", "second"]) {
    writeFileSync(join(root, "file.txt"), `${text}\n`);
    git("add", "file.txt"); git("commit", "-m", text);
    commits.push(git("rev-parse", "HEAD").trim());
  }
  git("update-ref", "refs/remotes/origin/dev", commits[0]);
  const brief = join(dir, "brief.md"), out = join(dir, "out"), callsFile = join(dir, "calls.jsonl"), ghFile = join(dir, "gh.json");
  writeFileSync(brief, "Hand-written review brief\nScope: git diff HEAD~1...HEAD\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home, KIT_ROOT: root, KIT_MAIN_ROOT: main, XDG_STATE_HOME: state,
    ASE_OWNER: "review-owner", ASE_AGENT_CLI: "", ASE_REVIEW_MODEL: "", ASE_BUILD_MODEL: "",
    ASE_REVIEW_BUDGET_GPT: "", ASE_REVIEW_BUDGET_GROK: "", ASE_REVIEW_BUDGET_LOCK_MS: "", ASE_AGENT_TIMEOUT: "10s", FAKE_CALLS: callsFile, FAKE_GH: ghFile };
  const invoke = (file: string, args: string[], overrides: NodeJS.ProcessEnv = {}, bash = false) => spawnSync(bash ? "bash" : file, bash ? [file, ...args] : args, {
    cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 15_000,
  });
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}, front = false) => invoke(front ? kit : review, front ? ["review", ...args] : args, overrides, front);
  const runAgent = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => invoke(agent, ["review", root, brief, "--out", out, ...args], overrides, true);
  const calls = (): Call[] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const evidence = (stdout: string) => {
    const lines = stdout.trim().split("\n").filter(line => line.startsWith("RESULT: "));
    assert.equal(lines.length, 1, stdout);
    assert.equal(stdout.trim().split("\n").at(-1), lines[0]);
    const path = / evidence (.+)$/.exec(lines[0])?.[1];
    assert.ok(path, stdout);
    assert.ok(path.startsWith(join(main, ".scratch/reviews/review-owner/")), path);
    assert.match(path.slice(path.lastIndexOf("/") + 1), /^\d{8}T\d{6}Z(?:-\d+)?$/);
    return path;
  };
  const noEvidence = (stdout: string) => {
    const lines = stdout.trim().split("\n");
    assert.equal(lines.filter(line => line.startsWith("RESULT: ")).length, 1, stdout);
    assert.match(lines.at(-1)!, /^RESULT: fail .* evidence none$/);
    assert.equal(existsSync(join(main, ".scratch/reviews")), false);
  };
  const ledger = join(state, "agent-kit/review-budget.json"), legacy = join(main, ".scratch/review-budget.json");
  // This week's counts by family, each { project: count }.
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")) as Record<string, Record<string, Record<string, number>>>).at(-1);
  return { dir, root, main, home, brief, out, git, commits, invoke, run, runAgent, calls, evidence, noEvidence, ghFile, state, ledger, legacy, counts };
}

test("kit review help states default scope; invalid flags exit 2 with one RESULT", (t) => {
  const f = fixture(t);
  for (const front of [false, true]) {
    const help = f.run(["--help"], {}, front);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Default scope: --base origin\/<land> \(branches\.land in scripts\/agents\/kit\.json\)/);
    assert.match(help.stdout, /ASE_REVIEW_MODEL or claude-opus-5-5/);
    assert.doesNotMatch(help.stdout, /RESULT:/);
  }
  for (const args of [["--wat"], ["--base"], ["--base", "HEAD", "--commit", "HEAD"], ["--pr", "0"], ["--pr", "1.2"], ["--pr", "-1"], ["--base", "HEAD", "--base", "HEAD^"]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, result.stderr);
    f.noEvidence(result.stdout);
  }
  assert.equal(f.calls().length, 0);
});

test("kit review resolves HEAD~1, HEAD^ and short SHAs and saves five evidence files", (t) => {
  const f = fixture(t);
  for (const ref of ["HEAD~1", "HEAD^", f.commits[1].slice(0, 8)]) {
    const result = f.run(["--base", ref], {}, ref === "HEAD~1");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT: ok review git diff/);
    assert.ok(result.stdout.includes(complete), "the review text is shown");
    assert.doesNotMatch(result.stdout, /^artifacts: /m);
    const evidence = f.evidence(result.stdout);
    assert.deepEqual(readdirSync(evidence).sort(), ["diff.patch", "findings.json", "refs.txt", "result.md", "run.log"]);
    assert.equal(readFileSync(join(evidence, "diff.patch"), "utf8"), f.git("diff", `${f.commits[1]}...${f.commits[2]}`));
    assert.equal(readFileSync(join(evidence, "refs.txt"), "utf8"), `${f.commits[2]}\n${f.commits[1]}\n`);
    assert.equal(readFileSync(join(evidence, "result.md"), "utf8").trimEnd(), complete.trimEnd());
    assert.match(readFileSync(join(evidence, "run.log"), "utf8"), /claude-opus-5-5/);
    assert.equal(f.calls().at(-1)?.cwd, f.root);
  }
});

test("kit review writes findings.json with kinds and counts, or unreadable for a report that does not parse", (t) => {
  const f = fixture(t);
  const report = "REVIEW_STATUS: complete\nSpec defects:\n- file.txt:1 — P1 ticket: the ticket asks for counts.\nStandards defects:\n- file.txt:1 — **P3 style:** rename it.\n- file.txt:1 — P2: no kind.\nValidation gaps: add a test.\nOptional nits: none.\n";
  const result = f.run(["--commit", "HEAD^"], { FAKE_REPORT: report, ASE_REVIEW_MODEL: "claude-opus-5-5" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^findings 4: ticket 1, style 1, unsorted 1, gap 1; P1 1, P2 1, P3 1, gap 1$/m);
  const evidence = f.evidence(result.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "findings.json"), "utf8")), {
    model: "claude-opus-5-5", effort: "medium", scope: `git diff ${f.commits[1]}^..${f.commits[1]}`, head: f.commits[1],
    findings: [
      { group: "Spec", severity: "P1", kind: "ticket", text: "file.txt:1 — P1 ticket: the ticket asks for counts." },
      { group: "Standards", severity: "P3", kind: "style", text: "file.txt:1 — P3 style: rename it." },
      { group: "Standards", severity: "P2", kind: "unsorted", text: "file.txt:1 — P2: no kind." },
      { group: "Validation gaps", severity: null, kind: null, text: "add a test." },
    ],
    counts: { kind: { fault: 0, ticket: 1, race: 0, style: 1, unsorted: 1, gap: 1 }, severity: { P0: 0, P1: 1, P2: 1, P3: 1, none: 0, gap: 1 } },
  });
  const unreadable = f.run([], { FAKE_REPORT: "REVIEW_STATUS: complete\nLooks fine to me.\n" });
  assert.equal(unreadable.status, 0, unreadable.stderr);
  assert.match(unreadable.stdout, /^findings unreadable$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(f.evidence(unreadable.stdout), "findings.json"), "utf8")), {
    model: "claude-opus-5-5", effort: "medium", scope: `git diff ${f.commits[0]}...HEAD`, head: f.commits[2], unreadable: true,
  });
});

test("the review brief names the four kinds with an example each", () => {
  assert.match(reviewFormat, /P1 fault: evidence and fix/);
  for (const kind of ["fault", "ticket", "race", "style"]) assert.match(reviewFormat, new RegExp(`^${kind}: .+\\(.*P[0-3] ${kind}: .+\\)\\.?$`, "m"));
});

test("kit review defaults to origin/dev and omits ticket sources when no ticket is supplied", (t) => {
  const f = fixture(t);
  // A spent GPT budget must not stop the default review: it never touches the budget.
  const result = f.run([], { ASE_REVIEW_BUDGET_GPT: "0" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scope: --base origin\/dev/);
  assert.match(result.stdout, /^model: claude-opus-5-5$/m);
  assert.doesNotMatch(result.stdout, /^budget:/m);
  assert.ok(!existsSync(f.ledger) || !f.counts()?.gpt);
  assert.equal(f.calls()[0].cli, "claude");
  assert.ok(f.calls()[0].input.includes(`Scope: git diff ${f.commits[0]}...HEAD`));
  assert.match(f.calls()[0].input, /Spec axis: no ticket supplied/);
  assert.equal(readFileSync(join(f.evidence(result.stdout), "refs.txt"), "utf8"), `${f.commits[2]}\n${f.commits[0]}\n`);
});

test("the brief names only the checks and standards files the settings set", t => {
  const f = fixture(t);
  // techies-playground's minimal settings (research 04), with AGENTS.md standing in for a standards file.
  writeFileSync(join(f.root, "scripts/agents/kit.json"), JSON.stringify({ project: "techies-playground", branches: { land: "dev" },
    checks: { test: "npm test" }, standards: ["AGENTS.md", "docs/agents/agent-scripts.md"] }));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const brief = f.calls()[0].input;
  assert.match(brief, /^Standards axis: apply AGENTS\.md and docs\/agents\/agent-scripts\.md; cite the applicable rule with each defect\.$/m);
  assert.match(brief, /^The author already ran npm test; do not report inability to run tests\.$/m);
  assert.doesNotMatch(brief, /check\/test\/lint|npm run|touched specs/);
  writeFileSync(join(f.root, "scripts/agents/kit.json"), JSON.stringify({ project: "techies-playground", branches: { land: "dev" } }));
  assert.equal(f.run().status, 0);
  assert.match(f.calls()[1].input, /^The project sets no checks in scripts\/agents\/kit\.json; do not assume any ran, and do not report inability to run tests\.$/m);
});

test("builder briefs name kit unit, the type check, lint and specs only when the settings set them", t => {
  const root = mkdtempSync(join(tmpdir(), "kit-builder-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(builderChecks(root, { checks: { test: "npm test" } }), { unit: false, check: null, lint: null, specs: false });
  mkdirSync(join(root, "project.d"));
  writeFileSync(join(root, "project.d/specs.sh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(root, "project.d/notes"), "not a command\n");
  assert.deepEqual(builderChecks(root, { commands: "project.d", unit: { files: ["", "src/**/*.test.js"] }, checks: { check: " npm run check ", lint: "npm run lint" } }),
    { unit: true, check: "npm run check", lint: "npm run lint", specs: true });
  assert.equal(builderChecks(root, { commands: "project.d", unit: { files: "" } }).unit, false);
});

test("review briefs carry declined findings and reasons into kit review", t => {
  const f = fixture(t);
  const declined = ["file.txt:1 — reject deletion: the spec requires this line."];
  const ticket = "ticket.md"; writeFileSync(join(f.root, ticket), "Review this ticket.\n");
  for (const brief of [reviewBrief(ticket, "", "HEAD^", f.root, declined), ticketReviewBrief(ticket, "HEAD^", f.root, declined)]) {
    assert.ok(brief.includes(`Declined by the author (with reasons):\n- ${declined[0]}`));
    assert.match(brief, /Report a declined finding again only if the reason is wrong, and say why\./);
  }
  assert.doesNotMatch(reviewBrief(ticket, "", "HEAD^", f.root), /Declined by the author/);
  const result = f.run(["--ticket", ticket], { ASE_REVIEW_DECLINED: JSON.stringify(declined) });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls()[0].input.includes(declined[0]));
  assert.throws(() => reviewBrief(ticket, "", "HEAD^", f.root, "bad list"), /declined findings/);
});

test("single-commit scope reviews that commit even when it is not HEAD; brief scope parses without flags", (t) => {
  const f = fixture(t);
  const result = f.run(["--commit", f.commits[1].slice(0, 8)]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = f.evidence(result.stdout);
  assert.equal(readFileSync(join(evidence, "refs.txt"), "utf8"), `${f.commits[1]}\n${f.commits[0]}\n`);
  assert.equal(readFileSync(join(evidence, "diff.patch"), "utf8"), f.git("diff", f.commits[0], f.commits[1]));
  assert.ok(f.calls()[0].input.includes(`git diff ${f.commits[1]}^..${f.commits[1]}`));
  writeFileSync(f.brief, `Scope: git diff ${f.commits[1]}^..${f.commits[1]}\n`);
  const inferred = f.runAgent();
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.equal(readFileSync(join(f.out, "commits.log"), "utf8"), f.git("log", "--oneline", `${f.commits[0]}..${f.commits[1]}`));
  assert.equal(readFileSync(join(f.out, "refs.txt"), "utf8"), `${f.commits[1]}\n${f.commits[0]}\n`);
});

test("bad refs, empty diffs and absent scopes fail before a CLI is called", (t) => {
  const f = fixture(t);
  for (const ref of ["not-a-ref", "--output=x", "HEAD;echo bad"]) {
    const result = f.run(["--base", ref]);
    assert.ok(result.status !== 0);
    assert.ok(result.stderr.includes(ref));
    f.noEvidence(result.stdout);
  }
  const empty = f.run(["--base", "HEAD"]);
  assert.equal(empty.status, 1, empty.stderr);
  assert.ok(empty.stderr.includes(`problem: empty diff for git diff ${f.commits[2]}...HEAD`));
  const evidence = f.evidence(empty.stdout);
  assert.equal(readFileSync(join(evidence, "diff.patch"), "utf8"), "");
  assert.ok(existsSync(join(evidence, "refs.txt")));
  writeFileSync(f.brief, "No scope\n");
  const missing = f.runAgent();
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /problem: brief has no review scope; pass --base REF or --commit SHA/);
  assert.equal(f.calls().length, 0);
});

test("runner appends the footer exactly once to generated, handwritten and already formatted briefs", (t) => {
  const f = fixture(t);
  const generated = reviewBrief("ticket.md", "", "HEAD^", f.root);
  assert.ok(!generated.includes(reviewFormat));
  for (const severity of ["P0:", "P1:", "P2:", "P3:"]) assert.ok(reviewFormat.includes(severity));
  assert.match(reviewFormat, /Spec defect that breaks a "Done when" item/);
  assert.match(reviewFormat, /Validation gaps:.*no severity/);
  for (const brief of [generated, "Hand-written brief", `${generated}${reviewFormat}`]) {
    writeFileSync(f.brief, brief);
    const result = f.runAgent(["--base", "HEAD^"]);
    assert.equal(result.status, 0, result.stderr);
    const input = f.calls().at(-1)!.input;
    assert.equal(input.split(reviewFormat).length - 1, 1);
    assert.equal(input.split("Required format:").length - 1, 1);
  }
});

for (const model of ["gpt-6.1-sol", "claude-opus-5-5"]) for (const mode of ["retry-fail", "retry-pass"]) {
  test(`${model} ${mode} resumes exactly once in the same session and saves evidence`, (t) => {
    const f = fixture(t);
    const result = f.run(["--base", "HEAD^"], { ASE_REVIEW_MODEL: model, FAKE_MODE: mode });
    assert.equal(result.status, mode === "retry-pass" ? 0 : 1, result.stderr);
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].args.includes(session));
    assert.equal(calls[1].home, calls[0].home);
    assert.equal(calls[1].args[calls[1].args.indexOf(model.startsWith("claude") ? "--model" : "-m") + 1], model);
    assert.match(calls[1].input, /^Your reply must start with the line REVIEW_STATUS: complete/);
    assert.ok(calls[1].args.includes(model.startsWith("claude") ? "--resume" : "resume"));
    if (!model.startsWith("claude")) {
      assert.deepEqual(calls[1].args.slice(0, 2), ["exec", "resume"]);
      assert.ok(calls[1].args.includes('sandbox_mode="read-only"'));
      for (const flag of ["-C", "-s", "--ephemeral"]) assert.ok(!calls[1].args.includes(flag));
    }
    const evidence = f.evidence(result.stdout);
    assert.equal(readdirSync(evidence).length, 5);
    const log = readFileSync(join(evidence, "run.log"), "utf8");
    assert.ok(model.startsWith("claude") ? log.split("modelUsage").length === 3 : log.includes("call: 1") && log.includes("call: 2"));
    if (mode === "retry-fail") assert.match(result.stderr, /problem: result lacks REVIEW_STATUS: complete/);
    else assert.equal(readFileSync(join(evidence, "result.md"), "utf8").trimEnd(), complete.trimEnd());
    assert.equal(JSON.parse(readFileSync(join(evidence, "findings.json"), "utf8")).unreadable, mode === "retry-fail" ? true : undefined);
  });
}

test("missing session never opens a fresh session; nonzero exit never retries", (t) => {
  for (const model of ["gpt-6.1-sol", "claude-opus-5-5"]) for (const mode of ["no-session", "retry-fail"]) {
    const f = fixture(t);
    const result = f.run([], { ASE_REVIEW_MODEL: model, FAKE_MODE: mode, ...(mode === "retry-fail" ? { FAKE_EXIT: "7" } : {}) });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.calls().length, 1);
    if (mode === "no-session") assert.match(result.stderr, /lacks REVIEW_STATUS/);
  }
});

test("empty or absent reports retry once after a successful exit for either CLI", (t) => {
  for (const model of ["gpt-6.1-sol", "claude-opus-5-5"]) for (const mode of ["empty-pass", "missing-pass"]) {
    const f = fixture(t);
    const result = f.run([], { ASE_REVIEW_MODEL: model, FAKE_MODE: mode });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls().length, 2);
    assert.ok(f.calls()[1].args.includes(session));
    assert.equal(readFileSync(join(f.evidence(result.stdout), "result.md"), "utf8").trimEnd(), complete.trimEnd());
  }
});

test("resume must still report the requested model", (t) => {
  for (const overrides of [{ FAKE_MODE: "retry-model" }, { FAKE_MODE: "retry-pass", FAKE_NO_RETRY_MODEL: "1" }]) {
    const f = fixture(t);
    const result = f.run([], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ...overrides });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(f.calls().length, 2);
    assert.match(result.stderr, /requested model/);
  }
});

test("Codex reviews start with only a symlinked auth and isolated config, then remove the home", (t) => {
  const f = fixture(t);
  const result = f.run([], { ASE_REVIEW_MODEL: "gpt-6.1-sol" });
  assert.equal(result.status, 0, result.stderr);
  const call = f.calls()[0];
  assert.notEqual(call.home, f.home);
  assert.deepEqual(call.files.sort(), ["auth.json", "config.toml"]);
  assert.equal(call.symlink, true);
  assert.equal(call.target, join(f.home, "auth.json"));
  assert.equal(call.config, codexReviewConfig);
  assert.match(call.config, /\[skills\.bundled\]\nenabled = false/);
  assert.match(call.config, /include_instructions = false/);
  assert.match(call.config, /plugins = false\napps = false\nmemories = false/);
  assert.doesNotMatch(call.config, /\[mcp_servers/);
  assert.equal(existsSync(call.home), false);
  const created = makeCodexReviewHome(f.home);
  t.after(() => rmSync(created.home, { recursive: true, force: true }));
  assert.equal(created.sourceAuth, join(f.home, "auth.json"));
  assert.deepEqual(readdirSync(created.home).sort(), ["auth.json", "config.toml"]);
});

test("missing Codex auth names its source; builds keep normal CODEX_HOME", (t) => {
  const f = fixture(t);
  const build = f.invoke(agent, ["build", f.root, f.brief, "--out", f.out], { ASE_BUILD_MODEL: "gpt-6.1-sol" }, true);
  assert.equal(build.status, 0, build.stderr);
  assert.equal(f.calls()[0].home, f.home);
  assert.equal(existsSync(f.home), true);
  rmSync(join(f.home, "auth.json"));
  const result = f.run([], { ASE_REVIEW_MODEL: "gpt-6.1-sol" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(`problem: no Codex auth at ${join(f.home, "auth.json")}`));
  assert.equal(f.calls().length, 1);
});

test("replaced auth is copied back with mode 0600 even when review fails; home is removed", (t) => {
  const f = fixture(t);
  const result = f.run([], { ASE_REVIEW_MODEL: "gpt-6.1-sol", FAKE_ROTATE: "1", FAKE_MODE: "retry-fail" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(join(f.home, "auth.json"), "utf8"), '{"refresh_token":"rotated"}');
  assert.equal(statSync(join(f.home, "auth.json")).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(f.home), ["auth.json"]);
  assert.equal(existsSync(f.calls()[0].home), false);
});

test("ticket brief keeps ticket links and implicit ../spec.md, supports positional base and --commit", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "tickets"));
  const ticket = "tickets/05.md";
  writeFileSync(join(f.root, ticket), "[Decision](../decision.md)\n");
  writeFileSync(join(f.root, "spec.md"), "spec\n");
  for (const args of [[ticket, "HEAD^"], [ticket, "--commit", f.commits[1]]]) {
    const brief = f.invoke(briefScript, args, {}, true);
    assert.equal(brief.status, 0, brief.stderr);
    assert.match(brief.stdout, /Spec axis: read tickets\/05.md, decision.md, spec.md/);
    writeFileSync(f.brief, brief.stdout);
    const result = f.runAgent();
    assert.equal(result.status, 0, result.stderr);
  }
  const result = f.run(["--ticket", ticket]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.calls().at(-1)!.input, /Spec axis: read tickets\/05.md, decision.md, spec.md/);
});

test("--pr posts the review with model, scope and recorded SHAs; gh failure retains evidence", (t) => {
  const f = fixture(t);
  for (const fail of [false, true]) {
    const result = f.run(["--base", "HEAD^", "--pr", "123"], { FAKE_GH_EXIT: fail ? "1" : "0" });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const evidence = f.evidence(result.stdout);
    const posted: { args: string[]; body: string; cwd: string } = JSON.parse(readFileSync(f.ghFile, "utf8"));
    assert.deepEqual(posted.args.slice(0, 4), ["pr", "comment", "123", "--body-file"]);
    assert.equal(posted.cwd, f.root);
    assert.equal(posted.body, `Model: claude-opus-5-5\nScope: git diff ${f.commits[1]}...HEAD\nHEAD: ${f.commits[2]}\nBase: ${f.commits[1]}\n\n${complete}\n`);
    assert.equal(readFileSync(join(evidence, "result.md"), "utf8").trimEnd(), complete.trimEnd());
  }
});

test("kit review removes its temporary files after a good save and keeps them, named, when a copy fails", (t) => {
  const f = fixture(t);
  const artifacts = join(f.root, ".scratch/agent");
  const temporaries = () => readdirSync(artifacts).filter(name => name.startsWith("kit-review-"));
  const saved = f.run();
  assert.equal(saved.status, 0, saved.stderr);
  f.evidence(saved.stdout);
  assert.deepEqual(temporaries(), []);
  if (process.getuid?.() === 0) return t.skip("root reads unreadable files");
  const failed = f.run([], { FAKE_LOCK_DIFF: "1" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  const kept = temporaries();
  assert.equal(kept.length, 1);
  const path = join(artifacts, kept[0]);
  assert.ok(failed.stderr.includes(`problem: review files kept in ${path}\n`), failed.stderr);
  assert.equal(readFileSync(join(path, "out.md"), "utf8").trimEnd(), complete.trimEnd());
  assert.match(failed.stdout.trim().split("\n").at(-1)!, /^RESULT: fail saving evidence failed: EACCES.* evidence \//);
});

test("review evidence keeps the temporary folder when findings.json fails after every copy, and removes it after a good save", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-review-evidence-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const temporary = join(dir, "kit-review-x"), evidence = join(dir, "evidence");
  const sources = ["diff.patch", "out.md", "refs.txt", "run.log"];
  mkdirSync(temporary);
  for (const name of sources) writeFileSync(join(temporary, name), `${name}\n`);
  // A directory in the way of findings.json.tmp fails the write once all four copies are in.
  const blocked = () => { mkdirSync(join(evidence, "findings.json.tmp"), { recursive: true }); return evidence; };
  assert.throws(() => saveReviewEvidence(temporary, blocked, (text: string) => ({ text })), { code: "EISDIR" });
  assert.deepEqual(readdirSync(temporary).sort(), sources);
  assert.deepEqual(readdirSync(evidence).sort(), ["diff.patch", "findings.json.tmp", "refs.txt", "result.md", "run.log"]);
  rmSync(evidence, { recursive: true });
  const saved = saveReviewEvidence(temporary, () => { mkdirSync(evidence); return evidence; }, (text: string) => ({ text }));
  assert.deepEqual(saved, { evidence, record: { text: "out.md\n" }, cleanup: null });
  assert.equal(existsSync(temporary), false);
  assert.deepEqual(readdirSync(evidence).sort(), ["diff.patch", "findings.json", "refs.txt", "result.md", "run.log"]);
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "findings.json"), "utf8")), { text: "out.md\n" });
});

test("review evidence stays saved when only removing the temporary folder fails", (t) => {
  if (process.getuid?.() === 0) return t.skip("root removes from read-only folders");
  const dir = mkdtempSync(join(tmpdir(), "ase-review-evidence-test-"));
  const parent = join(dir, "agent"), temporary = join(parent, "kit-review-x"), evidence = join(dir, "evidence");
  const sources = ["diff.patch", "out.md", "refs.txt", "run.log"];
  mkdirSync(temporary, { recursive: true });
  for (const name of sources) writeFileSync(join(temporary, name), `${name}\n`);
  // A read-only parent lets the files go but not the folder itself.
  chmodSync(parent, 0o555);
  t.after(() => { chmodSync(parent, 0o755); rmSync(dir, { recursive: true, force: true }); });
  const saved = saveReviewEvidence(temporary, () => { mkdirSync(evidence); return evidence; }, (text: string) => ({ text }));
  assert.equal(saved.evidence, evidence);
  assert.match(saved.cleanup, /EACCES/);
  assert.deepEqual(readdirSync(evidence).sort(), ["diff.patch", "findings.json", "refs.txt", "result.md", "run.log"]);
  assert.equal(readFileSync(join(evidence, "result.md"), "utf8"), "out.md\n");
});

test("kit review keeps its result when only removing the temporary folder fails", (t) => {
  if (process.getuid?.() === 0) return t.skip("root removes from read-only folders");
  const f = fixture(t);
  const artifacts = join(f.root, ".scratch/agent");
  let result;
  try { result = f.run([], { FAKE_LOCK_ARTIFACTS: "1" }); }
  finally { chmodSync(artifacts, 0o755); }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const [kept] = readdirSync(artifacts).filter(name => name.startsWith("kit-review-"));
  assert.ok(kept, "the empty review folder is left behind");
  assert.ok(result.stderr.includes(`problem: removing ${join(artifacts, kept)} failed: EACCES`), result.stderr);
  assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: ok review /);
  const evidence = f.evidence(result.stdout);
  assert.deepEqual(readdirSync(evidence).sort(), ["diff.patch", "findings.json", "refs.txt", "result.md", "run.log"]);
});

test("evidence timestamp collisions add a suffix and leave existing evidence intact", (t) => {
  const f = fixture(t);
  const parent = join(f.main, ".scratch/reviews/review-owner");
  const occupied: string[] = [];
  for (let offset = -1; offset <= 4; offset++) {
    const time = new Date(Date.now() + offset * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const path = join(parent, time);
    mkdirSync(path, { recursive: true }); writeFileSync(join(path, "keep"), "old evidence");
    occupied.push(path);
  }
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(f.evidence(result.stdout), /Z-1$/);
  for (const path of occupied) assert.equal(readFileSync(join(path, "keep"), "utf8"), "old evidence");
});

test("an explicit ASE_REVIEW_MODEL=gpt-6.1-sol still selects Sol", (t) => {
  const f = fixture(t);
  const result = f.run([], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "1" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0].cli, "codex");
  assert.equal(f.calls()[0].args[f.calls()[0].args.indexOf("-m") + 1], "gpt-6.1-sol");
  assert.match(result.stdout, /^model: gpt-6.1-sol$/m);
  assert.match(result.stdout, /^budget: gpt 1\/1 in /m);
});

test("kit review counts outside reviews per week, refuses at the budget and never counts Claude", (t) => {
  const f = fixture(t);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "1" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^budget: gpt 1\/1 in \d{4}-W\d{2}$/m);
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "1" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: gpt review budget used up: 1\/1 in \d{4}-W\d{2}; raise ASE_REVIEW_BUDGET_GPT to override$/m);
  assert.match(refused.stdout.trim().split("\n").at(-1)!, /^RESULT: fail gpt review budget used up: .* evidence none$/);
  assert.equal(f.calls().length, 1);
  const claude = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "claude-haiku-5-5", ASE_REVIEW_BUDGET_GPT: "0" });
  assert.equal(claude.status, 0, claude.stderr);
  assert.doesNotMatch(claude.stdout, /^budget:/m);
  // An empty diff never reaches the model, so its reservation is returned.
  const empty = f.run(["--base", "HEAD"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /empty diff/);
  assert.deepEqual(f.counts(), { gpt: { "kit-review": 1 } });
  assert.equal(f.calls().length, 2);
});

test("kit review keeps the budget counted once the CLI has started, even when it times out silently", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, "#!/usr/bin/env node\nsetTimeout(() => {}, 30_000);\n");
  chmodSync(grok, 0o755);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_AGENT_TIMEOUT: "1s" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeded timeout=1s/);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("kit review gives the budget back when the provider refuses on a usage limit", (t) => {
  const f = fixture(t);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(first.status, 0, first.stderr);
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "usage-limit" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: gpt usage limit until Oct 25th, 2026 3:14 PM$/m);
  assert.deepEqual(f.counts(), { gpt: { "kit-review": 1 } });
});

test("kit review keeps the spent review when the first call works before the usage limit", (t) => {
  const f = fixture(t);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(first.status, 0, first.stderr);
  const late = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "late-usage-limit" });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /^problem: gpt usage limit until Oct 25th, 2026 3:14 PM$/m);
  assert.deepEqual(f.counts(), { gpt: { "kit-review": 2 } });
});

test("kit review keeps the budget counted when the first call fails for another reason", (t) => {
  const f = fixture(t);
  const failed = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "retry-fail", FAKE_EXIT: "7" });
  assert.equal(failed.status, 1);
  assert.deepEqual(f.counts(), { gpt: { "kit-review": 1 } });
});

test("kit review keeps the spent review when only the completeness retry is refused", (t) => {
  const f = fixture(t);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(f.counts(), { gpt: { "kit-review": 1 } });
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "retry-usage-limit" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: gpt usage limit until Oct 25th, 2026 3:14 PM$/m);
  assert.match(refused.stderr, /result lacks REVIEW_STATUS: complete/);
  assert.equal(f.calls().length, 3);
  assert.deepEqual(f.counts(), { gpt: { "kit-review": 2 } });
});

test("kit review gives the budget back when Grok prints its refusal on stdout", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "usage-limit" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: grok usage limit until 9:00 AM$/m);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("two projects share one Grok count for the computer", (t) => {
  const state = mkdtempSync(join(tmpdir(), "ase-kit-state-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const a = fixture(t, { project: "project-a", state }), b = fixture(t, { project: "project-b", state });
  for (const f of [a, b]) { writeFileSync(join(f.dir, "bin", "grok"), fake); chmodSync(join(f.dir, "bin", "grok"), 0o755); }
  const env = { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" };
  const first = a.run(["--base", "HEAD~1"], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^budget: grok 1\/2 in /m);
  const second = b.run(["--base", "HEAD~1"], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^budget: grok 2\/2 in /m);
  const refused = a.run(["--base", "HEAD~1"], env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: grok review budget used up: 2\/2 in \d{4}-W\d{2}; raise ASE_REVIEW_BUDGET_GROK to override$/m);
  assert.deepEqual(b.counts(), { grok: { "project-a": 1, "project-b": 1 } });
  // A usage-limit refusal in one project gives the slot back to the shared count.
  const limit = b.run(["--base", "HEAD~1"], { ...env, ASE_REVIEW_BUDGET_GROK: "3", FAKE_MODE: "usage-limit" });
  assert.equal(limit.status, 1);
  assert.match(limit.stderr, /^problem: grok usage limit until 9:00 AM$/m);
  assert.deepEqual(a.counts(), { grok: { "project-a": 1, "project-b": 1 } });
  for (const f of [a, b]) assert.ok(!existsSync(join(f.main, ".scratch/review-budget.json")), "no per-project ledger");
});

test("the first counted review moves the project's old count into the machine ledger once", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "bin", "grok"), fake); chmodSync(join(f.dir, "bin", "grok"), 0o755);
  const week = isoWeek(), env = { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "8" };
  mkdirSync(join(f.main, ".scratch"), { recursive: true });
  writeFileSync(f.legacy, JSON.stringify({ [week]: { grok: 5, gpt: 1 } }));
  // Claude is never counted, so it leaves the old file alone.
  assert.equal(f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "claude-opus-5-5" }).status, 0);
  assert.ok(existsSync(f.legacy));
  const first = f.run(["--base", "HEAD~1"], env);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^budget: grok 6\/8 in /m);
  assert.ok(!existsSync(f.legacy), "the old ledger is moved, not copied");
  const second = f.run(["--base", "HEAD~1"], env);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^budget: grok 7\/8 in /m);
  assert.deepEqual(JSON.parse(readFileSync(f.ledger, "utf8")), { [week]: { grok: { "kit-review": 7 }, gpt: { "kit-review": 1 } } });
});

test("a refusal right after the old count moves in keeps the moved count", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "bin", "grok"), fake); chmodSync(join(f.dir, "bin", "grok"), 0o755);
  mkdirSync(join(f.main, ".scratch"), { recursive: true });
  writeFileSync(f.legacy, JSON.stringify({ [isoWeek()]: { grok: 8 } }));
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: grok review budget used up: 8\/8 in /m);
  assert.equal(f.calls().length, 0);
  assert.ok(!existsSync(f.legacy), "the old ledger is moved even when the review is refused");
  assert.deepEqual(f.counts(), { grok: { "kit-review": 8 } });
});

test("kit review keeps the spent review when Grok works on stderr before its stdout refusal", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  const late = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "late-usage-limit" });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /^problem: grok usage limit until 9:00 AM$/m);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 2 } });
});

test("an empty Grok account after a turn skips the review with exit 3 and gives the count back", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
  const empty = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "out-of-credit" }, true);
  assert.equal(empty.status, 3, empty.stdout + empty.stderr);
  assert.match(empty.stdout, /^budget: grok 2\/2 in /m);
  const problems = empty.stderr.trimEnd().split("\n").filter(line => line.startsWith("problem: "));
  assert.equal(problems.at(-1), "problem: grok out of credit: 402 Payment Required: Grok Build usage balance exhausted");
  assert.equal(empty.stdout.trim().split("\n").at(-1), "RESULT: skip review out of credit (grok-4.7)");
  const evidence = /^evidence: (.+)$/m.exec(empty.stdout)?.[1];
  assert.ok(evidence && existsSync(join(evidence, "run.log")), empty.stdout);
  assert.match(readFileSync(join(evidence, "run.log"), "utf8"), /402 Payment Required/);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("a Grok first call that prints only the 402 line gives the count back once", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  const empty = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "out-of-credit-only" });
  assert.equal(empty.status, 3, empty.stdout + empty.stderr);
  assert.equal(empty.stdout.trim().split("\n").at(-1), "RESULT: skip review out of credit (grok-4.7)");
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("an empty Grok account on the completeness retry still skips the review and gives the count back", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "retry-out-of-credit" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(f.calls().length, 2);
  assert.ok(f.calls()[1].args.includes("--resume"));
  const problems = result.stderr.trimEnd().split("\n").filter(line => line.startsWith("problem: "));
  assert.equal(problems.at(-1), "problem: grok out of credit: 402 Payment Required: Grok Build usage balance exhausted");
  assert.equal(result.stdout.trim().split("\n").at(-1), "RESULT: skip review out of credit (grok-4.7)");
  assert.deepEqual(f.counts(), { grok: { "kit-review": 0 } });
});

test("a failed Grok run whose tool trace names 402 is a failed review, not out of credit", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  const failed = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "trace-402" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.doesNotMatch(failed.stderr, /out of credit/);
  assert.match(failed.stdout.trim().split("\n").at(-1)!, /^RESULT: fail /);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 2 } });
});

test("an out-of-credit run whose evidence cannot be saved fails with exit 1 and still gives the count back", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "out-of-credit", FAKE_LOCK_DIFF: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: fail saving evidence failed: /);
  assert.doesNotMatch(result.stdout, /RESULT: skip/);
  // No review came back, so the slot is free whatever happened to the evidence.
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("an out-of-credit run whose count cannot be given back says so on its skip line", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", FAKE_MODE: "out-of-credit",
    FAKE_LOCK_LEDGER: `${f.ledger}.lock`, ASE_REVIEW_BUDGET_LOCK_MS: "200" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /^problem: releasing review budget failed: review budget lock .* is held/m);
  assert.equal(result.stdout.trim().split("\n").at(-1), "RESULT: skip review out of credit (grok-4.7); count not given back");
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("uppercase GROK-4.7 selects Grok, its budget and the build variant end to end", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "GROK-4.7", FAKE_RESULT_MODEL: "grok-4.7-build", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^budget: grok 1\/2 in /m);
  assert.equal(f.calls()[0].cli, "grok");
  const args = f.calls()[0].args;
  assert.equal(args[args.indexOf("-m") + 1], "grok-4.7");
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
});

test("kit review gives the slot back right after the old count moves in", (t) => {
  const f = fixture(t);
  // Only node joins the fake bin: a grok installed beside node must not be found.
  const nodeBin = join(f.dir, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  mkdirSync(join(f.main, ".scratch"), { recursive: true });
  writeFileSync(f.legacy, JSON.stringify({ [isoWeek()]: { grok: 3 } }));
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", PATH: `${join(f.dir, "bin")}:${nodeBin}:/usr/bin:/bin` });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^budget: grok 4\/8 in /m);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 3 } });
  assert.ok(!existsSync(f.legacy));
});

test("kit review gives the budget back when the Grok CLI is missing", (t) => {
  const f = fixture(t);
  // Only node joins the fake bin: a grok installed beside node must not be found.
  const nodeBin = join(f.dir, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const path = `${join(f.dir, "bin")}:${nodeBin}:/usr/bin:/bin`;
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", PATH: path });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^budget: grok 1\/8 in /m);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 0 } });
  // No report at all: no result.md, so no findings record and no findings line.
  assert.doesNotMatch(result.stdout, /^findings /m);
  const evidence = / evidence (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(evidence, result.stdout);
  if (evidence !== "none") {
    assert.equal(existsSync(join(evidence, "result.md")), false);
    assert.equal(existsSync(join(evidence, "findings.json")), false);
  }
});

// A fake opencode: `run` reads the brief on stdin and prints JSON events; `export` names the model of each answer so far.
const fakeOpencode = `#!/usr/bin/env node
import { appendFileSync, existsSync, fstatSync, readFileSync, writeSync } from "node:fs";
const args = process.argv.slice(2);
const answers = process.env.FAKE_CALLS + ".answers";
if (args[0] === "export") {
  appendFileSync(process.env.FAKE_CALLS + ".exports", args.at(-1) + "\\n");
  if (process.env.FAKE_EXPORT === "fail") { console.error("Exporting session: " + args.at(-1) + "\\nError: session not found"); process.exit(1); }
  if (process.env.FAKE_EXPORT === "hang") await new Promise(done => setTimeout(done, 30_000));
  const models = existsSync(answers) ? readFileSync(answers, "utf8").trim().split("\\n") : [];
  console.error("Exporting session: " + args.at(-1));
  const exported = JSON.stringify({ info: { id: args.at(-1) }, messages: models.flatMap(model => [{ info: { role: "user" } },
    { info: { role: "assistant", providerID: model.split("/")[0], modelID: model.split("/").slice(1).join("/") } }]),
    ...(process.env.FAKE_EXPORT === "big" ? { padding: "x".repeat(400_000) } : {}) }) + "\\n";
  // Like the real CLI, which exits before a pipe drains: anything but a file gets only the first 192 KiB.
  writeSync(1, !fstatSync(1).isFile() ? exported.slice(0, 196_608) : exported);
  process.exit(0);
}
const input = readFileSync(0, "utf8");
const resumed = args.includes("--session");
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cli: "opencode", args, input, cwd: process.cwd(), config: process.env.OPENCODE_CONFIG_CONTENT,
  noProject: process.env.OPENCODE_DISABLE_PROJECT_CONFIG, noClaude: process.env.OPENCODE_DISABLE_CLAUDE_CODE }) + "\\n");
const emit = (type, extra = {}) => console.log(JSON.stringify({ type, timestamp: Date.now(), sessionID: "ses_fake", ...extra }));
const mode = process.env.FAKE_MODE || "pass";
emit("step_start", { part: { type: "step-start", messageID: "m0" } });
if (mode === "error-502" || mode === "error-502-exit1") {
  emit("error", { error: { name: "APIError", data: { message: "Bad gateway", statusCode: 502 } } });
  process.exit(mode === "error-502" ? 0 : 1);
}
// An empty account, said as an error event or as a bare 402 line on stderr.
if (mode === "out-of-credit" || mode === "out-of-credit-exit0") {
  emit("error", { error: { name: "APIError", data: { message: "balance exhausted", statusCode: 402 } } });
  process.exit(mode === "out-of-credit" ? 1 : 0);
}
if (mode === "stderr-402") { console.error("402"); process.exit(1); }
// A limit then an empty account; a gateway error that names 402; a passing error then the fatal one.
const fail = (...errors) => { for (const [message, statusCode] of errors) emit("error", { error: { name: "APIError", data: { message, statusCode } } }); process.exit(1); };
if (mode === "limit-then-402") fail(["Rate limit exceeded. Please try again later.", 429], ["balance exhausted", 402]);
if (mode === "error-502-names-402") fail(["Bad gateway (request 402)", 502]);
if (mode === "two-errors") fail(["Overloaded", 529], ["Bad gateway", 502]);
if (mode === "usage-limit" || mode === "usage-limit-exit0" || (mode === "retry-limit" && resumed)) {
  emit("error", { error: { name: "APIError", data: { message: "Rate limit exceeded. Please try again later.", statusCode: 429 } } });
  process.exit(mode === "usage-limit" ? 1 : 0);
}
// A limit said only as plain text on stderr, with no error event.
if (mode === "stderr-limit") { console.error("You've hit your usage limit for this model; try again at 5pm."); process.exit(1); }
// Stops after naming its session, as a crash would, or hangs there until the runner's limit kills it.
if (mode === "stopped") process.exit(1);
if (mode === "hang") await new Promise(done => setTimeout(done, 30_000));
appendFileSync(answers, args[args.indexOf("-m") + 1] + "\\n");
emit("text", { part: { type: "text", messageID: "m1", text: "Reading the diff first." } });
emit("tool_use", { part: { type: "tool", tool: "read", state: { status: "completed" } } });
const report = (mode === "retry-pass" || mode === "retry-fail" || mode === "retry-limit") && !resumed || mode === "retry-fail" ? "incomplete reply" : process.env.FAKE_REPORT || ${JSON.stringify(complete)};
emit("text", { part: { type: "text", messageID: "m2", text: report } });
emit("step_finish", { part: { type: "step-finish", reason: "stop", cost: 0 } });
`;

// What the fake opencode records for each run call.
interface OpencodeCall { cli: string; args: string[]; input: string; cwd: string; config: string; noProject: string; noClaude: string }

function opencodeCalls(f: ReturnType<typeof fixture>): OpencodeCall[] {
  const file = join(f.dir, "calls.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
}

function withOpencode(f: ReturnType<typeof fixture>) {
  writeFileSync(join(f.dir, "bin", "opencode"), fakeOpencode); chmodSync(join(f.dir, "bin", "opencode"), 0o755);
  // Grok too, to show an OpenCode review leaves its count alone.
  writeFileSync(join(f.dir, "bin", "grok"), fake); chmodSync(join(f.dir, "bin", "grok"), 0o755);
}

const opencodeModel = "opencode/deepseek-v4.1-flash-free";

test("kit review runs opencode/<model> read-only, saves findings with severities and leaves the Grok count alone", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const grok = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "1" });
  assert.equal(grok.status, 0, grok.stderr);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
  const report = "REVIEW_STATUS: complete\nSpec defects:\n- file.txt:1 — P1 ticket: the ticket asks for counts.\nStandards defects:\n- file.txt:1 — P3 style: rename it.\nValidation gaps: none.\nOptional nits: none.\n";
  // The Grok budget is used up; OpenCode is not counted, so it still runs.
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, ASE_REVIEW_BUDGET_GROK: "1", FAKE_REPORT: report }, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^model: ${opencodeModel}$`, "m"));
  assert.doesNotMatch(result.stdout, /^budget:/m);
  assert.match(result.stdout, /^findings 2: ticket 1, style 1; P1 1, P3 1$/m);
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
  const call = opencodeCalls(f).at(-1)!;
  assert.equal(call.cli, "opencode");
  assert.equal(call.cwd, f.root);
  assert.deepEqual(call.args.slice(0, 5), ["run", "--pure", "--agent", "ase-review", "--format"]);
  assert.equal(call.args[call.args.indexOf("-m") + 1], opencodeModel);
  assert.deepEqual(JSON.parse(call.config).agent["ase-review"].permission, { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow" });
  assert.equal(call.noProject, "1");
  assert.equal(call.noClaude, "1");
  assert.ok(call.input.includes("Review scope: git diff"));
  const evidence = f.evidence(result.stdout);
  assert.deepEqual(readdirSync(evidence).sort(), ["diff.patch", "findings.json", "refs.txt", "result.md", "run.log"]);
  // Only the last message is the report; earlier narration is dropped.
  assert.equal(readFileSync(join(evidence, "result.md"), "utf8").trimEnd(), report.trimEnd());
  const findings = JSON.parse(readFileSync(join(evidence, "findings.json"), "utf8"));
  assert.equal(findings.model, opencodeModel);
  // No effort reaches OpenCode, so none is recorded.
  assert.equal(findings.effort, null);
  assert.deepEqual(findings.findings.map((finding: { severity: string }) => finding.severity), ["P1", "P3"]);
});

test("an incomplete OpenCode answer is re-asked once in the same session", (t) => {
  for (const mode of ["retry-pass", "retry-fail"]) {
    const f = fixture(t);
    withOpencode(f);
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: mode });
    assert.equal(result.status, mode === "retry-pass" ? 0 : 1, result.stderr);
    const calls = opencodeCalls(f);
    assert.equal(calls.length, 2);
    assert.ok(!calls[0].args.includes("--session"));
    assert.equal(calls[1].args[calls[1].args.indexOf("--session") + 1], "ses_fake");
    assert.equal(calls[1].args[calls[1].args.indexOf("--agent") + 1], "ase-review");
    assert.match(calls[1].input, /^Your reply must start with the line REVIEW_STATUS: complete/);
    const evidence = f.evidence(result.stdout);
    if (mode === "retry-pass") assert.equal(readFileSync(join(evidence, "result.md"), "utf8").trimEnd(), complete.trimEnd());
    else assert.match(result.stderr, /problem: result lacks REVIEW_STATUS: complete/);
  }
});

test("an OpenCode answer from another model fails the model check", (t) => {
  const f = fixture(t);
  withOpencode(f);
  writeFileSync(`${join(f.dir, "calls.jsonl")}.answers`, "opencode/other-free\n");
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OpenCode session does not name requested model opencode\/deepseek-v4\.1-flash-free \(actual: opencode\/other-free, opencode\/deepseek-v4\.1-flash-free\)/);
});

test("an OpenCode rate-limit refusal prints the opencode usage-limit problem and counts nothing, whatever its exit", (t) => {
  for (const mode of ["usage-limit", "usage-limit-exit0"]) {
    const f = fixture(t);
    withOpencode(f);
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: mode });
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trimEnd().split("\n").at(-1), "problem: opencode usage limit: Rate limit exceeded. Please try again later.");
    assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: fail opencode usage limit: Rate limit exceeded\. Please try again later\. evidence /);
    // The failed run is never exported or retried.
    assert.equal(opencodeCalls(f).length, 1);
    assert.equal(existsSync(f.ledger), false);
  }
});

test("an OpenCode limit said only on stderr, with no error event, prints the opencode usage-limit problem", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: "stderr-limit" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trimEnd().split("\n").at(-1), "problem: opencode usage limit until 5pm");
  assert.equal(existsSync(join(f.dir, "calls.jsonl.exports")), false);
  assert.equal(opencodeCalls(f).length, 1);
  assert.equal(existsSync(f.ledger), false);
});

test("an OpenCode error that is not a limit fails once, unexported and unretried", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: "error-502" });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^problem: OpenCode reported an error: Bad gateway; see .*run\.log$/m);
  assert.doesNotMatch(result.stderr, /opencode usage limit/);
  assert.equal(existsSync(join(f.dir, "calls.jsonl.exports")), false);
  assert.equal(opencodeCalls(f).length, 1);
});

test("an OpenCode error that is not a limit, with a non-zero exit, is the last problem line", (t) => {
  for (const [mode, message] of [["error-502-exit1", "Bad gateway"], ["two-errors", "Bad gateway"], ["error-502-names-402", "Bad gateway (request 402)"]]) {
    const f = fixture(t);
    withOpencode(f);
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: mode });
    assert.equal(result.status, 1, result.stderr);
    const problems = result.stderr.trimEnd().split("\n").filter(line => line.startsWith("problem: "));
    assert.equal(problems.at(-1), `problem: OpenCode reported an error: ${message}`);
    assert.doesNotMatch(result.stderr, /opencode failed|out of credit/);
    assert.ok(result.stdout.trim().split("\n").at(-1)!.startsWith(`RESULT: fail OpenCode reported an error: ${message} evidence `), result.stdout);
  }
});

test("an empty OpenCode account, as an error event or a bare 402 line, skips the review with exit 3, even after a usage limit", (t) => {
  for (const [mode, problem] of [["out-of-credit", "problem: opencode out of credit: balance exhausted"], ["out-of-credit-exit0", "problem: opencode out of credit: balance exhausted"],
    ["stderr-402", "problem: opencode out of credit: 402"], ["limit-then-402", "problem: opencode out of credit: balance exhausted"]]) {
    const f = fixture(t);
    withOpencode(f);
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: mode }, true);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const problems = result.stderr.trimEnd().split("\n").filter(line => line.startsWith("problem: "));
    assert.equal(problems.at(-1), problem);
    assert.equal(result.stdout.trim().split("\n").at(-1), `RESULT: skip review out of credit (${opencodeModel})`);
    assert.equal(existsSync(join(f.dir, "calls.jsonl.exports")), false);
    assert.equal(existsSync(f.ledger), false);
  }
});

test("a bad ASE_OPENCODE_EXPORT_TIMEOUT_MS fails kit review before opencode runs", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, ASE_OPENCODE_EXPORT_TIMEOUT_MS: "abc" }, true);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^problem: ASE_OPENCODE_EXPORT_TIMEOUT_MS must be a positive integer$/m);
  assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: fail ASE_OPENCODE_EXPORT_TIMEOUT_MS must be a positive integer evidence /);
  assert.equal(opencodeCalls(f).length, 0);
});

test("a complete review that quotes 402 Payment Required from its diff stays a passing review", (t) => {
  const quote = "402 Payment Required: Grok Build usage balance exhausted";
  for (const model of ["grok-4.7", opencodeModel]) {
    const f = fixture(t);
    withOpencode(f);
    writeFileSync(join(f.root, "file.txt"), `${quote}\n`);
    f.git("commit", "-am", "quote the error");
    const report = `REVIEW_STATUS: complete\nDefects: none; file.txt quotes "${quote}".\n`;
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: model, FAKE_REPORT: report });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /out of credit/);
    assert.match(readFileSync(join(f.evidence(result.stdout), "result.md"), "utf8"), /402 Payment Required/);
  }
});

test("a usage limit on the completeness retry is the last problem line", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: "retry-limit" });
  assert.equal(result.status, 1, result.stderr);
  const calls = opencodeCalls(f);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args[calls[1].args.indexOf("--session") + 1], "ses_fake");
  const problems = result.stderr.trimEnd().split("\n").filter(line => line.startsWith("problem: "));
  assert.equal(problems.at(-1), "problem: opencode usage limit: Rate limit exceeded. Please try again later.");
  assert.ok(problems.includes("problem: result lacks REVIEW_STATUS: complete"), result.stderr);
});

test("a failed or hung OpenCode export fails the review with a named problem", (t) => {
  for (const [mode, problem] of [["fail", /^problem: OpenCode export for ses_fake failed: exit 1: Error: session not found; see .*run\.log$/m],
    ["hang", /^problem: OpenCode export for ses_fake failed: timed out after 500 ms; see .*run\.log$/m]] as const) {
    const f = fixture(t);
    withOpencode(f);
    const started = Date.now();
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_EXPORT: mode, ASE_OPENCODE_EXPORT_TIMEOUT_MS: "500" });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(Date.now() - started < 10_000, "the export limit stops a hung export");
    assert.match(result.stderr, problem);
  }
});

test("a large OpenCode export is read whole, not cut where a pipe would stop", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_EXPORT: "big" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^RESULT: ok /m);
});

test("a failed or timed-out OpenCode call is not exported and reports only its own cause", (t) => {
  for (const mode of ["stopped", "hang"]) {
    const f = fixture(t);
    withOpencode(f);
    const started = Date.now();
    const result = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: mode, ASE_AGENT_TIMEOUT: "1s" });
    assert.equal(result.status, 1, result.stderr);
    assert.ok(Date.now() - started < 10_000, "no export wait after the call failed");
    assert.equal(existsSync(join(f.dir, "calls.jsonl.exports")), false, "no export call");
    assert.doesNotMatch(result.stderr, /does not name requested model/);
    assert.match(result.stderr.trimEnd().split("\n").at(-1)!, mode === "hang" ? /^problem: agent exceeded timeout=1s; process group killed; see / : /^problem: opencode failed \(1\); see /);
  }
});

test("agent.sh --resume continues the OpenCode session recorded from its first event", (t) => {
  const f = fixture(t);
  withOpencode(f);
  const stopped = f.runAgent(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: opencodeModel, FAKE_MODE: "stopped" });
  assert.equal(stopped.status, 1, stopped.stderr);
  assert.match(stopped.stderr, /^problem: opencode failed \(1\); see /m);
  const status = JSON.parse(readFileSync(join(f.out, "status.json"), "utf8"));
  assert.equal(status.cli, "opencode");
  assert.equal(status.session, "ses_fake");
  const resumed = f.invoke(agent, ["--resume", f.out], {}, true);
  assert.equal(resumed.status, 0, resumed.stderr);
  const call = opencodeCalls(f).at(-1)!;
  assert.equal(call.args[call.args.indexOf("--session") + 1], "ses_fake");
  assert.equal(call.args[call.args.indexOf("--agent") + 1], "ase-review");
  assert.match(readFileSync(join(f.out, "out.md"), "utf8"), /^REVIEW_STATUS: complete/);
});

// A second-look table with a different model per kind, so each pick shows which row it came from.
function lookTable(f: ReturnType<typeof fixture>, kinds: Record<string, { model: string; fallback: string }> = {
  code: { model: "grok-4.7", fallback: opencodeModel }, ux: { model: "grok-4.6", fallback: opencodeModel },
  dx: { model: "grok-4.5", fallback: opencodeModel }, agent: { model: opencodeModel, fallback: "grok-4.7" },
}) {
  const path = join(f.dir, "second-look.json");
  writeFileSync(path, JSON.stringify({ kinds: Object.fromEntries(Object.entries(kinds).map(([kind, row]) => [kind, { ...row, checked: "2026-10-27" }])) }));
  // UX and DX come from the settings' paths.
  writeFileSync(join(f.root, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-review", branches: { land: "dev" }, standards: "CODING_STANDARDS.md",
    paths: { docs: ["^docs/"], visible: ["^src/ui/"] } }));
  return path;
}

function commitFiles(f: ReturnType<typeof fixture>, files: string[]) {
  for (const file of files) { mkdirSync(join(f.root, file, ".."), { recursive: true }); writeFileSync(join(f.root, file), `${file}\n`); }
  f.git("add", "--", ...files); f.git("commit", "-m", files.join(" "));
}

test("kit review --second-look picks each kind's table model, and a mixed change picks agent, then UX, then DX, else code", (t) => {
  for (const [files, kind, path, model] of [
    [["src/x.ts"], "code", "src/x.ts", "grok-4.7"],
    [["src/ui/panel.ts"], "ux", "src/ui/panel.ts", "grok-4.6"],
    [["docs/guide.md"], "dx", "docs/guide.md", "grok-4.5"],
    [["scripts/agents/x.mjs"], "agent", "scripts/agents/x.mjs", opencodeModel],
    [["docs/guide.md", "src/ui/panel.ts", "src/x.ts", "AGENTS.md"], "agent", "AGENTS.md", opencodeModel],
    [["docs/guide.md", "src/ui/panel.ts", "src/x.ts"], "ux", "src/ui/panel.ts", "grok-4.6"],
    [["docs/guide.md", "src/x.ts"], "dx", "docs/guide.md", "grok-4.5"],
  ] as const) {
    const f = fixture(t); withOpencode(f);
    const table = lookTable(f);
    commitFiles(f, [...files]);
    const result = f.run(["--commit", "HEAD", "--second-look"], { ASE_SECOND_LOOK: table }, true);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^second look: ${kind} \\(${path.replaceAll(".", "\\.")}\\) ${model.replaceAll(".", "\\.")}$`, "m"), files.join(" "));
    assert.match(result.stdout, new RegExp(`^model: ${model.replaceAll(".", "\\.")}$`, "m"));
    const call = f.calls().at(-1)!;
    assert.equal(call.cli, model.startsWith("opencode/") ? "opencode" : "grok");
    assert.equal(call.args[call.args.indexOf("-m") + 1], model);
    assert.deepEqual(JSON.parse(readFileSync(join(f.evidence(result.stdout), "second-look.json"), "utf8")), { kind, model, ok: true });
  }
});

test("a Grok count at its limit hands the second look to OpenCode; when OpenCode cannot run either, it is skipped with exit 3", (t) => {
  const f = fixture(t); withOpencode(f);
  const table = lookTable(f), budget = { ASE_REVIEW_BUDGET_GROK: "1", ASE_SECOND_LOOK: table };
  assert.equal(f.run(["--base", "HEAD~1"], { ...budget, ASE_REVIEW_MODEL: "grok-4.7" }).status, 0);
  const handed = f.run(["--base", "HEAD~1", "--second-look"], budget);
  assert.equal(handed.status, 0, handed.stdout + handed.stderr);
  assert.match(handed.stdout, /^second look: code \(file\.txt\) grok-4\.7$/m);
  assert.match(handed.stdout, /^second look: opencode\/deepseek-v4\.1-flash-free takes it \(grok-4\.7 grok review budget used up: 1\/1 in \S+; raise ASE_REVIEW_BUDGET_GROK to override\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(f.evidence(handed.stdout), "second-look.json"), "utf8")), { kind: "code", model: opencodeModel, ok: true });
  assert.deepEqual(f.counts(), { grok: { "kit-review": 1 } });
  const skipped = f.run(["--base", "HEAD~1", "--second-look"], { ...budget, FAKE_MODE: "out-of-credit" });
  assert.equal(skipped.status, 3, skipped.stdout + skipped.stderr);
  const reason = "grok-4.7 grok review budget used up: 1/1 in \\S+; raise ASE_REVIEW_BUDGET_GROK to override; opencode/deepseek-v4\\.1-flash-free out of credit";
  assert.match(skipped.stdout, new RegExp(`^second look: skipped \\(${reason}\\)$`, "m"));
  const lines = skipped.stdout.trim().split("\n");
  assert.equal(lines.filter(line => line.startsWith("RESULT: ")).length, 1);
  assert.match(lines.at(-1)!, new RegExp(`^RESULT: skip second look \\(${reason}\\)$`));
  // The failed OpenCode run's evidence is marked, so no lookup takes it for Claude's review or a second look that ran.
  const evidence = /^evidence: (.+)$/m.exec(skipped.stdout)?.[1];
  assert.ok(evidence, skipped.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "second-look.json"), "utf8")), { kind: "code", model: opencodeModel, ok: false });
});

test("the second look never reaches Codex: ASE_AGENT_CLI and ASE_REVIEW_MODEL cannot redirect it, and an OpenAI row is refused", (t) => {
  const f = fixture(t); withOpencode(f);
  const table = lookTable(f);
  const result = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: table, ASE_AGENT_CLI: "codex", ASE_REVIEW_MODEL: "gpt-6.1-sol" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.calls().map(call => call.cli), ["grok"]);
  // The agent kind's row is OpenCode: it runs OpenCode, never Codex.
  commitFiles(f, ["scripts/agents/x.mjs"]);
  const agent = f.run(["--commit", "HEAD", "--second-look"], { ASE_SECOND_LOOK: table, ASE_AGENT_CLI: "codex", ASE_REVIEW_MODEL: "gpt-6.1-sol" });
  assert.equal(agent.status, 0, agent.stdout + agent.stderr);
  assert.match(agent.stdout, /^second look: agent \(scripts\/agents\/x\.mjs\) opencode\/deepseek-v4\.1-flash-free$/m);
  assert.deepEqual(f.calls().map(call => call.cli), ["grok", "opencode"]);
  for (const kinds of [{ model: "gpt-6.1-sol", fallback: opencodeModel }, { model: "grok-4.7", fallback: "grok-4.6" }, { model: "opencode/x", fallback: "claude-opus-5-5" }]) {
    const bad = lookTable(f, { code: kinds, ux: kinds, dx: kinds, agent: kinds });
    const refused = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: bad });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stdout.trim().split("\n").at(-1)!, /^RESULT: fail second-look table .+ agent: (model and fallback must be grok-<model> or opencode\/<model>|the fallback must be the other family) evidence none$/);
  }
  assert.deepEqual(f.calls().map(call => call.cli), ["grok", "opencode"]);
});

test("the kit's own second-look table has every kind, a Grok or OpenCode model with the other family as fallback, and a checked date", async () => {
  // @ts-expect-error The agent helpers are plain JavaScript without declarations.
  const { reviewKinds, secondLookTable } = await import("../scripts/agents/pr-tier.mjs");
  const table = secondLookTable(resolve("scripts/agents/second-look.json"));
  assert.deepEqual(Object.keys(table).sort(), [...reviewKinds].sort());
  for (const kind of reviewKinds) {
    const { model, fallback, checked } = table[kind];
    assert.ok([model, fallback].every(name => /^grok-|^opencode\//.test(name)), kind);
    assert.notEqual(model.split(/[-/]/)[0], fallback.split(/[-/]/)[0], kind);
    assert.match(checked, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("a second look whose model runs but fails is a failed review, with no handover and no skip; a usage limit hands over", (t) => {
  const f = fixture(t); withOpencode(f);
  const table = lookTable(f);
  const failed = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: table, FAKE_MODE: "retry-fail" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.doesNotMatch(failed.stdout, / takes it |^RESULT: skip /m);
  assert.match(failed.stdout.trim().split("\n").at(-1)!, /^RESULT: fail .* evidence \//);
  assert.deepEqual([...new Set(f.calls().map(call => call.cli))], ["grok"]);
  // Both models at a usage limit: each could not run, so the second look is skipped.
  const limited = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: table, FAKE_MODE: "usage-limit" });
  assert.equal(limited.status, 3, limited.stdout + limited.stderr);
  assert.match(limited.stdout, /^second look: opencode\/deepseek-v4\.1-flash-free takes it \(grok-4\.7 grok usage limit/m);
  assert.match(limited.stdout.trim().split("\n").at(-1)!, /^RESULT: skip second look \(grok-4\.7 grok usage limit.*; opencode\/deepseek-v4\.1-flash-free opencode usage limit: /);
});

test("a second look's evidence folder is marked before its files land, so a failed save never leaves an unmarked review", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads unreadable files");
  const f = fixture(t); withOpencode(f);
  const result = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: lookTable(f), FAKE_LOCK_DIFF: "1" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, / takes it /);
  const evidence = / evidence (\/.+)$/.exec(result.stdout.trim().split("\n").at(-1)!)?.[1];
  assert.ok(evidence, result.stdout);
  // The answer was copied before the diff failed: the folder holds a complete report, marked as a second look that did not come back.
  assert.ok(existsSync(join(evidence, "result.md")));
  assert.deepEqual(JSON.parse(readFileSync(join(evidence, "second-look.json"), "utf8")), { kind: "code", model: "grok-4.7", ok: false });
});

test("a missing Grok CLI or a Grok outage hands the second look to OpenCode", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, "bin", "opencode"), fakeOpencode); chmodSync(join(f.dir, "bin", "opencode"), 0o755);
  const table = lookTable(f);
  // Only node joins the fake bin, so no grok is found.
  const nodeBin = join(f.dir, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  const missing = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: table, PATH: `${join(f.dir, "bin")}:${nodeBin}:/usr/bin:/bin` });
  assert.equal(missing.status, 0, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /^second look: opencode\/deepseek-v4\.1-flash-free takes it \(grok-4\.7 CLI missing: spawn grok ENOENT\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(f.evidence(missing.stdout), "second-look.json"), "utf8")), { kind: "code", model: opencodeModel, ok: true });
  writeFileSync(join(f.dir, "bin", "grok"), fake); chmodSync(join(f.dir, "bin", "grok"), 0o755);
  const down = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: table, FAKE_MODE: "outage" });
  assert.equal(down.status, 0, down.stdout + down.stderr);
  assert.match(down.stderr, /^problem: grok unavailable: 503 Service Unavailable$/m);
  assert.match(down.stdout, /^second look: opencode\/deepseek-v4\.1-flash-free takes it \(grok-4\.7 grok unavailable: 503 Service Unavailable\)$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(f.evidence(down.stdout), "second-look.json"), "utf8")), { kind: "code", model: opencodeModel, ok: true });
  // Neither Grok run came back with a review, so neither keeps its count.
  assert.deepEqual(f.counts(), { grok: { "kit-review": 0 } });
  const traced = f.run(["--base", "HEAD~1", "--second-look"], { ASE_SECOND_LOOK: table, FAKE_MODE: "trace-503" });
  assert.equal(traced.status, 1, traced.stdout + traced.stderr);
  assert.doesNotMatch(traced.stdout, / takes it /);
  assert.doesNotMatch(traced.stderr, /grok unavailable/);
  assert.match(traced.stdout.trim().split("\n").at(-1)!, /^RESULT: fail grok failed \(1\)/);
});

test("kit review --second-look --pr posts a comment that names the second look's kind and model", (t) => {
  const f = fixture(t); withOpencode(f);
  const result = f.run(["--base", "HEAD~1", "--second-look", "--pr", "7"], { ASE_SECOND_LOOK: lookTable(f) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const posted = JSON.parse(readFileSync(f.ghFile, "utf8"));
  assert.deepEqual(posted.args.slice(0, 3), ["pr", "comment", "7"]);
  assert.ok(posted.body.startsWith("Second look: code\nModel: grok-4.7\n"), posted.body);
});

test("a second look that fails before its CLI starts is a failed review, not a handover or a skip", (t) => {
  const f = fixture(t); withOpencode(f);
  const result = f.run(["--base", "HEAD~1", "--ticket", "docs/missing.md", "--second-look"], { ASE_SECOND_LOOK: lookTable(f) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, / takes it |^RESULT: skip /m);
  assert.match(result.stdout.trim().split("\n").at(-1)!, /^RESULT: fail .*missing\.md.* evidence none$/);
  assert.deepEqual(f.calls(), []);
});

test("ticket files leave the second look's kind alone unless nothing else changed", (t) => {
  for (const [files, ticket, kind, path] of [
    [["src/x.ts", "docs/wayfinder/m/build/tickets/01-x.md"], undefined, "code", "src/x.ts"],
    [["src/x.ts", "docs/notes/01-x.md"], "docs/notes/01-x.md", "code", "src/x.ts"],
    [["docs/wayfinder/m/build/tickets/01-x.md"], undefined, "dx", "docs/wayfinder/m/build/tickets/01-x.md"],
  ] as const) {
    const f = fixture(t); withOpencode(f);
    const table = lookTable(f);
    commitFiles(f, [...files]);
    const result = f.run(["--commit", "HEAD", ...(ticket ? ["--ticket", ticket] : []), "--second-look"], { ASE_SECOND_LOOK: table });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^second look: ${kind} \\(${path.replaceAll(".", "\\.")}\\) `, "m"), files.join(" "));
  }
});
