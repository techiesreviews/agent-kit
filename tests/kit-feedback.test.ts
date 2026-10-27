import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { feedbackLegend, parseFeedback } from "../scripts/agents/tickets.mjs";

const feedback = resolve("scripts/agents/kit.d/feedback");
const kit = resolve("scripts/agents/kit");
const log = "docs/wayfinder/alpha/build/feedback.md";

function today() {
  const now = new Date(), pad = (number: number) => String(number).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-feedback-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "docs/wayfinder/alpha/build/tickets"), { recursive: true });
  mkdirSync(join(root, "docs/wayfinder/alpha/tickets"), { recursive: true });
  writeFileSync(join(root, "docs/wayfinder/alpha/build/tickets/24-fix-buttons.md"), "---\nstatus: open\n---\n");
  writeFileSync(join(root, "docs/wayfinder/alpha/tickets/03-grill.md"), "---\nstatus: closed\n---\n");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-feedback", branches: { land: "dev" }, maps: "docs/wayfinder" }));
  const env: NodeJS.ProcessEnv = { ...process.env, KIT_ROOT: root };
  delete env.KIT_LIB_MJS;
  const run = (...args: string[]) => spawnSync(process.execPath, [feedback, ...args], { env, encoding: "utf8", timeout: 5_000 });
  const read = () => readFileSync(join(root, log), "utf8");
  return { root, env, run, read };
}

test("the first call creates the log with heading and legend; later lines go newest first", t => {
  const { root, run, read } = fixture(t);
  const first = run("alpha", "--kind", "felt-wrong", '"too many buttons"');
  assert.equal(first.status, 0, first.stderr);
  const line = `- ${today()} · felt-wrong · "too many buttons" · after release: no · fix: open`;
  assert.equal(first.stdout, `${log}:7: ${line}\nRESULT: ok feedback alpha line 7 felt-wrong\n`);
  assert.equal(read(), `# Feedback: alpha\n\n${feedbackLegend}\n\n## Feedback\n\n${line}\n`);

  const second = run("alpha", "--kind", "fault", "--after-release", "--fix", "24", "save lost my text");
  assert.equal(second.status, 0, second.stderr);
  const newer = `- ${today()} · fault · save lost my text · after release: yes · fix: [24](tickets/24-fix-buttons.md)`;
  assert.match(second.stdout, new RegExp(`^${log}:7: `));
  assert.deepEqual(read().split("\n").slice(6, 8), [newer, line]);
  assert.deepEqual(parseFeedback(read(), join(root, log)).problems, []);
});

test("--fix accepts PRs and the map's own tickets; --fix-for fills the fix field", t => {
  const { root, run, read } = fixture(t);
  for (const [fix, expected] of [["#12", "PR #12"], ["PR 13", "PR #13"], ["03", "[03](../tickets/03-grill.md)"], ["24-fix-buttons.md", "[24](tickets/24-fix-buttons.md)"]]) {
    const output = run("alpha", "--kind", "workflow", "--fix", fix, "note");
    assert.equal(output.status, 0, output.stderr);
    assert.match(read().split("\n")[6], new RegExp(`fix: ${expected.replace(/[[\]().#]/g, "\\$&")}$`));
  }
  assert.equal(run("alpha", "--kind", "too-much", "an explainer line").status, 0);
  const filled = run("alpha", "--fix-for", "7", "24");
  assert.equal(filled.status, 0, filled.stderr);
  const line = `- ${today()} · too-much · an explainer line · after release: no · fix: [24](tickets/24-fix-buttons.md)`;
  assert.equal(filled.stdout, `${log}:7: ${line}\nRESULT: ok feedback alpha fix filled on line 7\n`);
  assert.equal(read().split("\n")[6], line);
  assert.equal(run("alpha", "--fix-for", "8", "PR #99").status, 0);
  assert.match(read().split("\n")[7], /· fix: PR #99$/);
  assert.deepEqual(parseFeedback(read(), join(root, log)).problems, []);
});

test("bad input exits 2 with usage and leaves the log alone", t => {
  const { root, run, read } = fixture(t);
  const bad = run("alpha", "--kind", "ugly", "text");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /^Usage: kit feedback/);
  assert.equal(bad.stdout, "RESULT: fail feedback invalid kind: ugly\n");
  assert.equal(existsSync(join(root, log)), false);
  for (const args of [[], ["alpha", "text"], ["missing", "--kind", "fault", "x"], ["alpha", "--kind", "fault"],
    ["alpha", "--kind", "fault", "a · b"], ["alpha", "--kind", "fault", "two\nlines"], ["alpha", "--kind", "fault", "--fix", "99", "x"],
    ["alpha", "--kind", "fault", "--fix", "PR x", "x"], ["alpha", "--kind", "fault", "--bogus", "x"], ["alpha", "--fix-for", "7", "24"],
    ["alpha", "--kind", "fault", "--kind", "fault", "x"], ["alpha", "--after-release", "--after-release", "--kind", "fault", "x"]]) {
    const output = run(...args);
    assert.equal(output.status, 2, JSON.stringify(args));
    assert.match(output.stdout, /^RESULT: fail feedback /);
  }
  assert.equal(existsSync(join(root, log)), false);
  assert.equal(run("alpha", "--kind", "fault", "real").status, 0);
  const before = read();
  for (const args of [["alpha", "--fix-for", "1", "24"], ["alpha", "--fix-for", "x", "24"], ["alpha", "--fix-for", "7"], ["alpha", "--fix-for", "7", "24", "--kind", "fault"],
    ["alpha", "--fix-for", "7", "99"], ["alpha", "--fix-for", "7", "build/tickets/24-fix-buttons"]]) {
    assert.equal(run(...args).status, 2, JSON.stringify(args));
  }
  assert.equal(read(), before);
  const help = run("--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--fix-for <line-number>/);
});

test("a log without the Feedback heading fails without writing", t => {
  const { root, run } = fixture(t);
  writeFileSync(join(root, log), "# Feedback\n");
  const output = run("alpha", "--kind", "fault", "x");
  assert.equal(output.status, 1);
  assert.match(output.stderr, /missing ## Feedback heading/);
  assert.equal(readFileSync(join(root, log), "utf8"), "# Feedback\n");
  const entry = "# Feedback\n- 2026-10-23 · fault · x · after release: no · fix: open\n";
  writeFileSync(join(root, log), entry);
  const fix = run("alpha", "--fix-for", "2", "PR #3");
  assert.equal(fix.status, 1);
  assert.match(fix.stderr, /missing ## Feedback heading/);
  assert.equal(readFileSync(join(root, log), "utf8"), entry);
});

test("--fix-for refuses an entry-shaped line under a later heading", t => {
  const { root, run, read } = fixture(t);
  const source = `# Feedback: alpha\n\n## Feedback\n\n- 2026-10-24 · fault · real · after release: no · fix: open\n\n## Notes\n\n- 2026-10-23 · fault · a note · after release: no · fix: open\n`;
  writeFileSync(join(root, log), source);
  const output = run("alpha", "--fix-for", "9", "PR #3");
  assert.equal(output.status, 2);
  assert.match(output.stdout, /^RESULT: fail feedback .*:9 is not a feedback line\n$/);
  assert.equal(read(), source);
});

test("a ticket number in both folders is refused; the slug or a folder prefix picks one", t => {
  const { root, run, read } = fixture(t);
  writeFileSync(join(root, "docs/wayfinder/alpha/tickets/24-other.md"), "---\nstatus: closed\n---\n");
  const ambiguous = run("alpha", "--kind", "fault", "--fix", "24", "x");
  assert.equal(ambiguous.status, 2);
  assert.match(ambiguous.stdout, /ambiguous ticket 24: tickets\/24-fix-buttons.md, \.\.\/tickets\/24-other.md/);
  assert.equal(existsSync(join(root, log)), false);
  for (const [fix, expected] of [["24-other", "[24](../tickets/24-other.md)"], ["../tickets/24", "[24](../tickets/24-other.md)"],
    ["tickets/24-fix-buttons.md", "[24](tickets/24-fix-buttons.md)"], ["3", "[03](../tickets/03-grill.md)"]]) {
    const output = run("alpha", "--kind", "fault", "--fix", fix, "x");
    assert.equal(output.status, 0, output.stderr);
    assert.ok(read().split("\n")[6].endsWith(`fix: ${expected}`), fix);
  }
  assert.equal(run("alpha", "--kind", "fault", "--fix", "tickets/03", "x").status, 2, "tickets/ is the build folder only");
  const dashed = run("alpha", "--kind", "too-much", "--", "-- too much chrome");
  assert.equal(dashed.status, 0, dashed.stderr);
  assert.match(read().split("\n")[6], / · too-much · -- too much chrome · /);
});

test("edits keep a log's BOM and CRLF line endings", t => {
  const { root, run, read } = fixture(t);
  const lines = ["\uFEFF# Feedback: alpha", "", feedbackLegend, "", "## Feedback", "",
    "- 2026-10-23 · fault · save broke · after release: no · fix: open", ""];
  writeFileSync(join(root, log), lines.join("\r\n"));
  assert.equal(run("alpha", "--fix-for", "7", "PR #3").status, 0);
  lines[6] = lines[6].replace("fix: open", "fix: PR #3");
  assert.equal(read(), lines.join("\r\n"));
  assert.equal(run("alpha", "--kind", "workflow", "asked twice").status, 0);
  lines.splice(6, 0, `- ${today()} · workflow · asked twice · after release: no · fix: open`);
  assert.equal(read(), lines.join("\r\n"));
  assert.deepEqual(parseFeedback(read(), join(root, log)).problems, []);
});

test("a log starting with a BOM on its heading line accepts both edits and keeps the BOM", t => {
  const { root, run, read } = fixture(t);
  writeFileSync(join(root, log), "\uFEFF## Feedback\n\n- 2026-10-23 · fault · x · after release: no · fix: open\n");
  assert.equal(run("alpha", "--fix-for", "3", "PR #3").status, 0);
  assert.equal(read(), "\uFEFF## Feedback\n\n- 2026-10-23 · fault · x · after release: no · fix: PR #3\n");
  const added = run("alpha", "--kind", "fault", "y");
  assert.equal(added.status, 0, added.stderr);
  assert.equal(read(), `\uFEFF## Feedback\n\n- ${today()} · fault · y · after release: no · fix: open\n- 2026-10-23 · fault · x · after release: no · fix: PR #3\n`);
});

test("a new line keeps a blank line before a following heading", t => {
  const { root, run, read } = fixture(t);
  writeFileSync(join(root, log), "## Feedback\n\n## Notes\n");
  assert.equal(run("alpha", "--kind", "fault", "y").status, 0);
  assert.equal(read(), `## Feedback\n\n- ${today()} · fault · y · after release: no · fix: open\n\n## Notes\n`);
  assert.deepEqual(parseFeedback(read(), join(root, log)).problems, []);
});

test("the kit dispatcher lists feedback and passes its single RESULT line through", t => {
  const { env } = fixture(t);
  const output = spawnSync(kit, ["feedback", "alpha", "--kind", "fault", "x"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(output.status, 0, output.stderr);
  const results = output.stdout.split("\n").filter(line => line.startsWith("RESULT: "));
  assert.deepEqual(results, ["RESULT: ok feedback alpha line 7 fault"]);
  assert.ok(output.stdout.endsWith("RESULT: ok feedback alpha line 7 fault\n"));
  const help = spawnSync(kit, ["help"], { env, encoding: "utf8", timeout: 10_000 });
  assert.match(help.stdout, /^ {2}feedback +add one line to a build's feedback log/m);
});
