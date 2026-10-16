import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const status = resolve("scripts/agents/kit.d/status");
const kit = resolve("scripts/agents/kit");
const longSlug = "20-this-ticket-name-is-longer-than-thirty-two-characters";
interface Check { status?: string; conclusion?: string | null; state?: string }
interface Run extends Check { headSha: string; workflowName: string; event: string }
interface PR {
  number: number; state: string; title: string; body: string; headRefName: string;
  mergeCommit: { oid: string } | null; statusCheckRollup: Check[] | null;
}
const fakeGH = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2), kind = args[0];
appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + "\\n");
if (process.env.FAKE_GH_FAIL === "all" || process.env.FAKE_GH_FAIL === kind) {
  console.error("authentication required"); process.exit(1);
}
if (args[1] !== "list" || !["pr", "run"].includes(kind)) process.exit(2);
console.log(process.env[kind === "pr" ? "FAKE_PRS" : "FAKE_RUNS"]);
`;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-status-")), root = join(dir, "repo");
  mkdirSync(root);
  const requests: { url: string; cache?: string }[] = [];
  let html = '<script type="module" src="/assets/index-abc123.js"></script>', httpStatus = 200;
  const server = createServer((request, response) => {
    requests.push({ url: request.url || "", cache: request.headers["cache-control"] });
    response.writeHead(httpStatus, { "Content-Type": "text/html" });
    response.end(html);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const gh = join(dir, "gh");
  writeFileSync(gh, fakeGH); chmodSync(gh, 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(KIT_|FAKE_|GIT_)/.test(key)) delete env[key];
  Object.assign(env, {
    KIT_ROOT: root, KIT_STATUS_GH: gh, KIT_PREVIEW_URL: `http://127.0.0.1:${address.port}/?existing=1`,
    FAKE_CALLS: join(dir, "calls.jsonl"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Kit test", GIT_AUTHOR_EMAIL: "kit@example.com",
    GIT_COMMITTER_NAME: "Kit test", GIT_COMMITTER_EMAIL: "kit@example.com",
  });
  const git = (...args: string[]) => {
    const output = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 5_000 });
    assert.equal(output.status, 0, output.stderr);
    return output.stdout.trim();
  };
  git("init", "-q", "--initial-branch=dev");
  function ticket(map: string, slug: string, state = "open", assignee = "", builder = "sol") {
    const directory = join(root, "docs/wayfinder", map, "build/tickets");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${slug}.md`), `---\ntitle: ${slug}\nstatus: ${state}\nassignee: ${assignee}\nbuilder: ${builder}\n---\n`);
  }
  for (const slug of ["2-foo", "12-foo", "3-pending", "4-failed", "5-context", "6-cancel", "7-timeout", "8-neutral", "9-empty"]) ticket("alpha", slug);
  ticket("alpha", longSlug, "ready-for-agent", "LongAssigneeName Example");
  ticket("beta", "01-other", "open", "", "claude");
  git("add", "."); git("commit", "-qm", "initial tickets");
  ticket("alpha", "2-foo", "closed", "Lex Example");
  git("add", "."); git("commit", "-qm", "close ticket 2");
  const landed = git("rev-parse", "--short", "HEAD"), landedFull = git("rev-parse", "HEAD");
  writeFileSync(join(root, "other.txt"), "unrelated work\n");
  git("add", "."); git("commit", "-qm", "unrelated follow-up");
  const sha = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/dev", sha);
  // The working tree must not supply the status, owner, or ticket inventory.
  ticket("alpha", "2-foo", "open", "Local Person");
  ticket("local", "01-untracked");
  const pr = (number: number, slug: string, checks: Check[] = [], state = "OPEN"): PR => ({
    number, state, title: slug, body: "", headRefName: "feature/unrelated",
    mergeCommit: state === "MERGED" ? { oid: landedFull } : null, statusCheckRollup: checks,
  });
  const success = { status: "COMPLETED", conclusion: "SUCCESS" };
  const prs: PR[] = [
    pr(20, "2-foo", [], "MERGED"),
    { ...pr(21, "unrelated title", [{ conclusion: "FAILURE" }], "MERGED"), body: "Ticket: Some title (docs/wayfinder/alpha/build/tickets/2-foo.md)" },
    pr(5000, "2-foo", [], "CLOSED"),
    { ...pr(120, "unrelated title", [success]), headRefName: "build/ak-12-foo" },
    pr(121, "12-foo", [], "MERGED"), pr(999, "12-foo-extra"), pr(998, "x12-foo"),
    pr(30, "3-pending", [success, { status: "QUEUED", conclusion: null }]),
    pr(40, "4-failed", [{ status: "IN_PROGRESS" }, { conclusion: "FAILURE" }]),
    pr(50, "5-context", [{ state: "SUCCESS" }]), pr(60, "6-cancel", [{ conclusion: "CANCELLED" }]),
    pr(70, "7-timeout", [{ conclusion: "TIMED_OUT" }]),
    pr(80, "8-neutral", [success, { conclusion: "SKIPPED" }, { conclusion: "NEUTRAL" }]),
    { ...pr(90, "9-empty"), statusCheckRollup: null },
  ];
  const runCheck = (headSha: string, conclusion: string | null, state = "completed"): Run => ({
    headSha, status: state, conclusion, workflowName: "CI", event: "push",
  });
  const runs = [runCheck(sha, "success"), runCheck(sha, "skipped"), runCheck(landedFull, "success")];
  async function run(args: string[] = [], overrides: { prs?: PR[]; runs?: Run[]; env?: NodeJS.ProcessEnv; front?: boolean } = {}) {
    const child = spawn(overrides.front ? kit : status, overrides.front ? ["status", ...args] : args, {
      cwd: root, env: { ...env, FAKE_PRS: JSON.stringify(overrides.prs ?? prs), FAKE_RUNS: JSON.stringify(overrides.runs ?? runs), ...overrides.env },
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    let code, signal;
    try { [code, signal] = await once(child, "close"); }
    finally { clearTimeout(timer); }
    assert.equal(signal, null, stdout + stderr);
    for (const line of `${stdout}${stderr}`.split("\n")) assert.ok(Array.from(line).length <= 100, line);
    const results = stdout.split("\n").filter(line => line.startsWith("RESULT: "));
    if (!args.some(arg => ["--help", "-h"].includes(arg))) {
      assert.equal(results.length, 1, stdout);
      assert.equal(stdout.trimEnd().split("\n").at(-1), results[0]);
    }
    return { code, stdout, stderr, results };
  }
  const calls = (): string[][] => existsSync(env.FAKE_CALLS!) ? readFileSync(env.FAKE_CALLS!, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const row = (output: string, slug: string) => {
    const line = output.split("\n").find(line => line.startsWith(`${slug} `));
    assert.ok(line, output);
    return line.trim().split(/\s{2,}/);
  };
  return { root, dir, gh, git, sha, landed, landedFull, pr, prs, runs, runCheck, run, row, calls, requests,
    setPreview: (body: string, code = 200) => { html = body; httpStatus = code; } };
}

test("renders committed tickets, closing commit, bounded PR matches, CI and fresh preview", async t => {
  const f = await fixture(t);
  const output = await f.run(["alpha", "--no-fetch"]);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, new RegExp(`^ref origin/dev ${f.sha.slice(0, 7)}  dev CI: pass\npreview: index-abc123.js\n`));
  assert.match(output.stdout, /TICKET\s+STATUS\s+WHO\s+LANDED\s+CI/);
  assert.deepEqual(f.row(output.stdout, "2-foo"), ["2-foo", "closed", "Lex", `${f.landed} #21`, "pass"]);
  assert.deepEqual(f.row(output.stdout, "12-foo"), ["12-foo", "open", "sol", "#120 open", "pass"]);
  for (const [slug, ci] of [["3-pending", "run"], ["4-failed", "fail"], ["5-context", "pass"],
    ["6-cancel", "fail"], ["7-timeout", "fail"], ["8-neutral", "pass"], ["9-empty", "-"]]) {
    assert.equal(f.row(output.stdout, slug).at(-1), ci, slug);
  }
  assert.match(output.stdout, /20-this-ticket-name-is-longer-t…\s+ready-for-agent\s+LongAssig…\s+-\s+-/);
  assert.ok(output.stdout.indexOf("2-foo ") < output.stdout.indexOf("12-foo "));
  assert.doesNotMatch(output.stdout, /==|01-untracked|note:/);
  assert.deepEqual(output.results, ["RESULT: ok status alpha 10 tickets, 1 closed, 8 open PRs"]);
  assert.deepEqual(f.calls().sort((a, b) => a[0].localeCompare(b[0])), [
    ["pr", "list", "--state", "all", "--base", "dev", "--limit", "200", "--json", "number,state,title,body,headRefName,mergeCommit,statusCheckRollup"],
    ["run", "list", "--branch", "dev", "--limit", "100", "--json", "headSha,status,conclusion,workflowName,event"],
  ]);
  assert.equal(f.requests.length, 1);
  const request = new URL(f.requests[0].url, "http://localhost");
  assert.equal(request.searchParams.get("existing"), "1");
  assert.match(request.searchParams.get("kit") || "", /^\d+$/);
  assert.match(f.requests[0].cache || "", /no-cache/);
});

test("all maps group and sort, custom ref sets GitHub branch, kit front door discovers status", async t => {
  const f = await fixture(t);
  f.git("branch", "feature/status");
  const output = await f.run(["--ref", "feature/status", "--no-fetch"], { front: true });
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /feature\/status CI: pass/);
  assert.ok(output.stdout.indexOf("== alpha ==") < output.stdout.indexOf("== beta =="));
  assert.deepEqual(f.row(output.stdout, "01-other"), ["01-other", "open", "claude", "-", "-"]);
  assert.deepEqual(output.results, ["RESULT: ok status all 11 tickets, 1 closed, 8 open PRs"]);
  for (const call of f.calls()) assert.equal(call[call.indexOf(call[0] === "pr" ? "--base" : "--branch") + 1], "feature/status");
});

test("branch CI marks latest older run and prioritizes failures over pending checks", async t => {
  const f = await fixture(t);
  for (const [runs, expected] of [
    [[f.runCheck(f.landedFull, "neutral")], "pass (older sha)"],
    [[f.runCheck(f.sha, null, "in_progress")], "run"],
    [[f.runCheck(f.sha, null, "queued"), f.runCheck(f.sha, "cancelled")], "fail"],
    [[], "-"],
  ] satisfies [Run[], string][]) {
    const output = await f.run(["alpha", "--ref", "dev", "--no-fetch"], { runs });
    assert.equal(output.code, 0);
    assert.equal(output.stdout.split("\n")[0], `ref dev ${f.sha.slice(0, 7)}  dev CI: ${expected}`);
    assert.equal(f.row(output.stdout, "2-foo").at(-1), runs.some(run => run.headSha === f.landedFull) ? "pass" : "fail");
  }
});

test("closed unmerged PR is only a CI fallback; open PR wins over merged history", async t => {
  const f = await fixture(t);
  const prs = [f.pr(1, "9-empty", [{ state: "ERROR" }], "CLOSED"), f.pr(2, "12-foo", [{ state: "PENDING" }])];
  const output = await f.run(["alpha", "--no-fetch"], { prs });
  assert.equal(output.code, 0);
  assert.deepEqual(f.row(output.stdout, "9-empty"), ["9-empty", "open", "sol", "-", "fail"]);
  assert.deepEqual(f.row(output.stdout, "12-foo"), ["12-foo", "open", "sol", "#2 open", "run"]);
});

test("GitHub failure and unreachable preview retain full git table and successful offline result", async t => {
  const f = await fixture(t);
  const output = await f.run(["alpha", "--no-fetch"], { env: { FAKE_GH_FAIL: "all", KIT_PREVIEW_URL: "http://127.0.0.1:0/" } });
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /dev CI: \?/);
  assert.match(output.stdout, /preview: unknown \(.+\)/);
  assert.match(output.stdout, /note: gh unavailable \(authentication required\); PR and CI unknown/);
  assert.match(output.stdout, /note: preview unavailable/);
  assert.ok(output.stdout.indexOf("preview:") < output.stdout.indexOf("note:"));
  assert.ok(output.stdout.indexOf("note:") < output.stdout.indexOf("TICKET"));
  assert.deepEqual(f.row(output.stdout, "2-foo"), ["2-foo", "closed", "Lex", f.landed, "?"]);
  assert.deepEqual(f.row(output.stdout, "12-foo"), ["12-foo", "open", "sol", "-", "?"]);
  assert.deepEqual(output.results, ["RESULT: ok status alpha 10 tickets, 1 closed, 0 open PRs, offline"]);
});

test("missing gh, partial failure, malformed response and preview failures become notes", async t => {
  const f = await fixture(t);
  for (const env of [{ KIT_STATUS_GH: join(f.dir, "missing-gh") }, { FAKE_GH_FAIL: "run" }, { FAKE_PRS: "invalid JSON" }]) {
    const output = await f.run(["alpha", "--no-fetch"], { env });
    assert.equal(output.code, 0);
    assert.match(output.stdout, /note: gh unavailable/);
    assert.deepEqual(f.row(output.stdout, "2-foo"), ["2-foo", "closed", "Lex", f.landed, "?"]);
    assert.match(output.results[0], /, offline$/);
  }
  for (const [body, code, reason] of [["no bundle", 200, "bundle not found"], ["unavailable", 503, "HTTP 503"]] satisfies [string, number, string][]) {
    f.setPreview(body, code);
    const output = await f.run(["alpha", "--no-fetch"]);
    assert.equal(output.code, 0);
    assert.ok(output.stdout.includes(`preview: unknown (${reason})`));
    assert.match(output.results[0], /, offline$/);
  }
});

test("cached default ref and local ref work without a remote", async t => {
  const f = await fixture(t);
  const output = await f.run(["alpha", "--no-fetch"]);
  assert.equal(output.code, 0);
  assert.doesNotMatch(output.stdout, /fetch failed|offline/);
  const local = await f.run(["alpha", "--ref", "dev", "--no-fetch"]);
  assert.equal(local.code, 0);
  assert.doesNotMatch(local.stdout, /fetch failed|offline/);
});

test("help, usage errors, unknown maps and bad refs exit clearly without network calls", async t => {
  const f = await fixture(t);
  for (const flag of ["--help", "-h"]) {
    const output = await f.run([flag]);
    assert.equal(output.code, 0); assert.match(output.stdout, /Usage: kit status/);
    assert.deepEqual(output.results, []);
  }
  for (const args of [["--wat"], ["--ref"], ["alpha", "beta"], ["--no-fetch", "--no-fetch"], ["--ref", "dev", "--ref", "dev"]]) {
    const output = await f.run(args);
    assert.equal(output.code, 2); assert.match(output.stderr, /Usage: kit status/);
    assert.match(output.results[0], /^RESULT: fail status invalid argument:/);
  }
  for (const [map, ref, error] of [["missing", "dev", "Unknown map: missing"], ["alpha", "bad-ref", "Invalid ref: bad-ref"]]) {
    const output = await f.run([map, "--ref", ref, "--no-fetch"]);
    assert.equal(output.code, 1);
    assert.ok(output.stderr.includes(error));
    assert.ok(output.results[0].startsWith(`RESULT: fail status ${error}`));
  }
  assert.deepEqual(f.calls(), []); assert.deepEqual(f.requests, []);
});
