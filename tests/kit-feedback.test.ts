import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { feedbackLegend, parseFeedback } from "../scripts/agents/tickets.mjs";

const feedback = resolve("scripts/agents/kit.d/feedback");
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
  const env: NodeJS.ProcessEnv = { ...process.env, KIT_ROOT: root };
  delete env.KIT_LIB_MJS;
  const run = (...args: string[]) => spawnSync(process.execPath, [feedback, ...args], { env, encoding: "utf8", timeout: 5_000 });
  const read = () => readFileSync(join(root, log), "utf8");
  return { root, run, read };
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
    ["alpha", "--kind", "fault", "--fix", "PR x", "x"], ["alpha", "--kind", "fault", "--bogus", "x"], ["alpha", "--fix-for", "7", "24"]]) {
    const output = run(...args);
    assert.equal(output.status, 2, JSON.stringify(args));
    assert.match(output.stdout, /^RESULT: fail feedback /);
  }
  assert.equal(existsSync(join(root, log)), false);
  assert.equal(run("alpha", "--kind", "fault", "real").status, 0);
  const before = read();
  for (const args of [["alpha", "--fix-for", "1", "24"], ["alpha", "--fix-for", "x", "24"], ["alpha", "--fix-for", "7"], ["alpha", "--fix-for", "7", "24", "--kind", "fault"]]) {
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
});
