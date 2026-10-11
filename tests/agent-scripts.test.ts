import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { reviewBrief, reviewComplete } from "../scripts/agents/review-brief.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { unitSummary } from "../scripts/agents/unit-summary.mjs";

test("review completion accepts blank lines, BOM, CRLF and a leading markdown fence", () => {
  for (const prefix of ["", "\n\n", "\uFEFF", "\uFEFF\r\n \r\n", "\n```markdown\n\n", "~~~text\r\n"]) {
    assert.equal(reviewComplete(`${prefix}REVIEW_STATUS: complete\r\nDefects: none\n`), true, JSON.stringify(prefix));
  }
  for (const text of ["", "\n", "REVIEW_STATUS: incomplete", "REVIEW_STATUS: complete maybe", "Preamble\nREVIEW_STATUS: complete", "Defects: none\nREVIEW_STATUS: complete", "```\nREVIEW_STATUS: partial\n```", "```\n```\nREVIEW_STATUS: complete"]) {
    assert.equal(reviewComplete(text), false, text);
  }
});

test("review completion accepts longer fences and whitespace before info strings", () => {
  for (const fence of ["``` markdown", "````markdown", "~~~ text", "````", "~~~~", "~~~~ text", "```\tmarkdown", "```markdown extra", "~~~text `extra`", "```text/plain"]) {
    assert.equal(reviewComplete(`${fence}\nREVIEW_STATUS: complete\n`), true, fence);
  }
  for (const fence of ["``markdown", "~~ text", "```markdown `extra`"]) {
    assert.equal(reviewComplete(`${fence}\nREVIEW_STATUS: complete\n`), false, fence);
  }
});

test("slice brief resolves fixture ticket links and states both axes and validation contract", () => {
  const path = "tests/fixtures/agent-scripts/tickets/01-slice.md";
  const brief = reviewBrief(path, readFileSync(path, "utf8"));
  assert.match(brief, /git diff origin\/dev\.\.\.HEAD/);
  assert.ok(brief.includes(path));
  assert.match(brief, /tests\/fixtures\/agent-scripts\/spec\.md/);
  assert.match(brief, /tests\/fixtures\/agent-scripts\/02-decision\.md/);
  assert.match(brief, /docs\/work\/example\/spec\.md/);
  assert.match(brief, /docs\/work\/shared\/spec\.md/);
  assert.doesNotMatch(brief, /https:\/\/example.com/);
  assert.match(brief, /Standards axis: apply CODING_STANDARDS\.md/);
  assert.match(brief, /author already ran check\/test\/lint and the touched specs; do not report inability to run tests/);
  assert.match(brief, /commit:path:line, severity, evidence, and fix/);
  assert.match(brief, /very first line must be REVIEW_STATUS: complete/);
  assert.match(reviewBrief(path, "", "release/next"), /git diff release\/next\.\.\.HEAD/);
  assert.throws(() => reviewBrief(path, "", "dev; rm -rf /"), /Invalid base ref/);
  assert.throws(() => reviewBrief(path, "", "--output=x"), /Invalid base ref/);
  const result = spawnSync("bash", ["scripts/agents/review-brief.sh", path], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, brief);
  assert.equal(spawnSync("bash", ["scripts/agents/review-brief.sh"], { encoding: "utf8" }).status, 2);
});

test("unit summary prints counts and bounded error lines for each failure", () => {
  const log = `✔ passing (1ms)
✖ first failure (2ms)
ℹ pass 1
ℹ fail 2
ℹ cancelled 0
✖ failing tests:

test at tests/example.test.ts:1:1
✖ first failure (2ms)
  AssertionError: expected true
  actual: false
  expected: true
  operator: strictEqual
  extra line omitted

test at tests/example.test.ts:2:1
✖ second failure (3ms)
  Error: second reason
`;
  assert.equal(unitSummary(log), "pass 1, fail 2\n✖ first failure\n  AssertionError: expected true\n  actual: false\n  expected: true\n  operator: strictEqual\n✖ second failure\n  Error: second reason");
  assert.equal(unitSummary("\u001b[32mℹ pass 7\u001b[0m\nℹ fail 0\nℹ cancelled 0\n"), "pass 7, fail 0");
  assert.match(unitSummary("ℹ pass 0\nℹ fail 0\nℹ cancelled 2\n"), /cancelled 2/);
  assert.throws(() => unitSummary("Error: runner crashed"), /lacks pass\/fail counts/);
});

test("Sol expiry kills its process group including a child that ignores TERM", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ase-sol-timeout-"));
  const pidFile = join(scratch, "pids.json");
  try {
    const job = `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: "ignore" });
      writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `;
    const result = spawnSync(process.execPath, ["scripts/agents/sol-run.mjs", "1s", process.execPath, "-e", job, pidFile], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 124, result.stderr);
    const pids: number[] = JSON.parse(readFileSync(pidFile, "utf8"));
    for (const pid of pids) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        assert.equal(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0], "Z", `process ${pid} remains alive`);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
  } finally {
    // Bound even a broken supervisor; stop only the group this test created.
    try {
      const [leader]: number[] = JSON.parse(readFileSync(pidFile, "utf8"));
      process.kill(-leader, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && ["ENOENT", "ESRCH"].includes(String(error.code)))) throw error;
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
