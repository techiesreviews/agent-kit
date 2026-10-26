import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { codexReviewConfig, makeCodexReviewHome } from "../scripts/agents/agent-run.mjs";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { reviewBrief, reviewFormat, ticketReviewBrief } from "../scripts/agents/review-brief.mjs";

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
import { appendFileSync, chmodSync, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ cli, args, input, cwd: process.cwd(), home,
  files: readdirSync(home), symlink, target: symlink ? readlinkSync(auth) : null,
  config: existsSync(join(home, "config.toml")) ? readFileSync(join(home, "config.toml"), "utf8") : "" }) + "\\n");
if (process.env.FAKE_ROTATE && symlink && cli === "codex") {
  unlinkSync(auth); writeFileSync(auth, '{"refresh_token":"rotated"}');
}
const resumed = args.includes("resume") || args.includes("--resume");
const mode = process.env.FAKE_MODE || "pass";
const report = mode === "empty-pass" && !resumed ? "" : mode === "retry-fail" || mode === "no-session" || (mode === "retry-pass" && !resumed) || mode === "retry-model" || (mode === "retry-usage-limit" && !resumed) ? "incomplete reply\\n" : process.env.FAKE_REPORT || ${JSON.stringify(complete)};
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
  const answer = cli === "grok" ? { text: report } : { result: report };
  const named = cli === "grok" ? { sessionId: "${session}" } : { session_id: "${session}" };
  console.log(JSON.stringify({ ...(mode === "missing-pass" && !resumed ? {} : answer), modelUsage: { [process.env.FAKE_RESULT_MODEL || model]: {} }, ...(mode === "no-session" ? {} : named) }));
}
process.exitCode = Number(process.env.FAKE_EXIT || 0);
`;

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "ase-kit-review-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  for (const text of ["base", "first", "second"]) {
    writeFileSync(join(root, "file.txt"), `${text}\n`);
    git("add", "file.txt"); git("commit", "-m", text);
    commits.push(git("rev-parse", "HEAD").trim());
  }
  git("update-ref", "refs/remotes/origin/dev", commits[0]);
  const brief = join(dir, "brief.md"), out = join(dir, "out"), callsFile = join(dir, "calls.jsonl"), ghFile = join(dir, "gh.json");
  writeFileSync(brief, "Hand-written review brief\nScope: git diff HEAD~1...HEAD\n");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CODEX_HOME: home, KIT_ROOT: root, KIT_MAIN_ROOT: main,
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
  return { dir, root, main, home, brief, out, git, commits, invoke, run, runAgent, calls, evidence, noEvidence, ghFile };
}

test("kit review help states default scope; invalid flags exit 2 with one RESULT", (t) => {
  const f = fixture(t);
  for (const front of [false, true]) {
    const help = f.run(["--help"], {}, front);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Default scope: --base origin\/dev/);
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
  const ledger = join(f.main, ".scratch/review-budget.json");
  assert.ok(!existsSync(ledger) || Object.values(JSON.parse(readFileSync(ledger, "utf8")) as Record<string, { gpt?: number; grok?: number }>).every(week => !week.gpt));
  assert.equal(f.calls()[0].cli, "claude");
  assert.ok(f.calls()[0].input.includes(`Scope: git diff ${f.commits[0]}...HEAD`));
  assert.match(f.calls()[0].input, /Spec axis: no ticket supplied/);
  assert.equal(readFileSync(join(f.evidence(result.stdout), "refs.txt"), "utf8"), `${f.commits[2]}\n${f.commits[0]}\n`);
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
  const ledger = join(f.main, ".scratch/review-budget.json");
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")))[0];
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
  assert.deepEqual(counts(), { gpt: 1 });
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
  assert.deepEqual(Object.values(JSON.parse(readFileSync(join(f.main, ".scratch/review-budget.json"), "utf8")))[0], { grok: 1 });
});

test("kit review gives the budget back when the provider refuses on a usage limit", (t) => {
  const f = fixture(t);
  const ledger = join(f.main, ".scratch/review-budget.json");
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")))[0];
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(first.status, 0, first.stderr);
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "usage-limit" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: gpt usage limit until Oct 25th, 2026 3:14 PM$/m);
  assert.deepEqual(counts(), { gpt: 1 });
});

test("kit review keeps the spent review when the first call works before the usage limit", (t) => {
  const f = fixture(t);
  const ledger = join(f.main, ".scratch/review-budget.json");
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")))[0];
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(first.status, 0, first.stderr);
  const late = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "late-usage-limit" });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /^problem: gpt usage limit until Oct 25th, 2026 3:14 PM$/m);
  assert.deepEqual(counts(), { gpt: 2 });
});

test("kit review keeps the budget counted when the first call fails for another reason", (t) => {
  const f = fixture(t);
  const failed = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "retry-fail", FAKE_EXIT: "7" });
  assert.equal(failed.status, 1);
  assert.deepEqual(Object.values(JSON.parse(readFileSync(join(f.main, ".scratch/review-budget.json"), "utf8")))[0], { gpt: 1 });
});

test("kit review keeps the spent review when only the completeness retry is refused", (t) => {
  const f = fixture(t);
  const ledger = join(f.main, ".scratch/review-budget.json");
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")))[0];
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(counts(), { gpt: 1 });
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "gpt-6.1-sol", ASE_REVIEW_BUDGET_GPT: "2", FAKE_MODE: "retry-usage-limit" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: gpt usage limit until Oct 25th, 2026 3:14 PM$/m);
  assert.match(refused.stderr, /result lacks REVIEW_STATUS: complete/);
  assert.equal(f.calls().length, 3);
  assert.deepEqual(counts(), { gpt: 2 });
});

test("kit review gives the budget back when Grok prints its refusal on stdout", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const ledger = join(f.main, ".scratch/review-budget.json");
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")))[0];
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(counts(), { grok: 1 });
  const refused = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "usage-limit" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^problem: grok usage limit until 9:00 AM$/m);
  assert.deepEqual(counts(), { grok: 1 });
});

test("kit review keeps the spent review when Grok works on stderr before its stdout refusal", (t) => {
  const f = fixture(t);
  const grok = join(f.dir, "bin", "grok");
  writeFileSync(grok, fake); chmodSync(grok, 0o755);
  const ledger = join(f.main, ".scratch/review-budget.json");
  const counts = () => Object.values(JSON.parse(readFileSync(ledger, "utf8")))[0];
  const first = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2" });
  assert.equal(first.status, 0, first.stderr);
  const late = f.run(["--base", "HEAD~1"], { ASE_REVIEW_MODEL: "grok-4.7", ASE_REVIEW_BUDGET_GROK: "2", FAKE_MODE: "late-usage-limit" });
  assert.equal(late.status, 1);
  assert.match(late.stderr, /^problem: grok usage limit until 9:00 AM$/m);
  assert.deepEqual(counts(), { grok: 2 });
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
  const ledger = JSON.parse(readFileSync(join(f.main, ".scratch/review-budget.json"), "utf8"));
  assert.deepEqual(Object.values(ledger)[0], { grok: 1 });
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
  assert.deepEqual(Object.values(JSON.parse(readFileSync(join(f.main, ".scratch/review-budget.json"), "utf8")))[0], { grok: 0 });
  // No report at all: no result.md, so no findings record and no findings line.
  assert.doesNotMatch(result.stdout, /^findings /m);
  const evidence = / evidence (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(evidence, result.stdout);
  if (evidence !== "none") {
    assert.equal(existsSync(join(evidence, "result.md")), false);
    assert.equal(existsSync(join(evidence, "findings.json")), false);
  }
});
