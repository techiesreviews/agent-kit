import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { runOutcome } from "../agent-run.mjs";
import "./support/kit-env.ts";

// The runner names its own outcome (TOOLS-290): ran, unavailable (why) or failed (why), and whether the run reached
// the model (spent), so kit review reads it from status.json instead of guessing from the runner's text.
const log = "/out/run.log";

test("run outcome: a run that ended with status 0 ran and spent its review", () => {
  assert.deepEqual(runOutcome({ cli: "codex", code: 0, problems: [], record: { pgid: 7 } }),
    { kind: "ran", why: null, spent: true, outOfCredit: false });
});

test("run outcome: a CLI that is missing, out of credit, refused, at a usage limit, silent, crashed or not logged in is unavailable", () => {
  const cases: [string, object, object][] = [
    // [what, input, expected]
    ["missing CLI", { cli: "grok", code: 1, problems: [`problem: grok failed (1); see ${log}`], record: { pgid: null, missing: "grok" } },
      { kind: "unavailable", why: "CLI missing: grok not found (ENOENT)", spent: false, outOfCredit: false }],
    ["out of credit", { cli: "codex", code: 1, problems: [`problem: no final report; see ${log}`, "problem: gpt out of credit: 402 Payment Required"], record: { pgid: 7 } },
      { kind: "unavailable", why: "gpt out of credit: 402 Payment Required", spent: false, outOfCredit: true }],
    ["usage limit refused outright", { cli: "codex", code: 1, problems: ["problem: gpt usage limit until 9:00 AM"], record: { pgid: 7, refused: true } },
      { kind: "unavailable", why: "gpt usage limit until 9:00 AM", spent: false, outOfCredit: false }],
    ["usage limit after some work", { cli: "codex", code: 1, problems: ["problem: gpt usage limit until 9:00 AM"], record: { pgid: 7 } },
      { kind: "unavailable", why: "gpt usage limit until 9:00 AM", spent: true, outOfCredit: false }],
    ["OpenCode with no session", { cli: "opencode", code: 1, problems: ["problem: opencode unavailable: no session within 0.5s"], record: { pgid: 7, silent: true } },
      { kind: "unavailable", why: "opencode unavailable: no session within 0.5s", spent: false, outOfCredit: false }],
    ["OpenCode error event", { cli: "opencode", code: 1, problems: ["problem: OpenCode reported an error: overloaded"], record: { pgid: 7 } },
      { kind: "unavailable", why: "OpenCode reported an error: overloaded", spent: true, outOfCredit: false }],
    ["crashed", { cli: "claude", code: 1, problems: [`problem: claude crashed (killed by signal SIGSEGV); see ${log}`], record: { pgid: 7, crashed: true } },
      { kind: "unavailable", why: `claude crashed (killed by signal SIGSEGV); see ${log}`, spent: false, outOfCredit: false }],
    ["no Codex auth", { cli: "codex", code: 2, problems: ["problem: no Codex auth at /home/x/.codex/auth.json"], record: { pgid: null } },
      { kind: "unavailable", why: "no Codex auth at /home/x/.codex/auth.json", spent: false, outOfCredit: false }],
  ];
  for (const [what, input, expected] of cases) assert.deepEqual(runOutcome(input), expected, what);
});

test("run outcome: Grok is unavailable when its closing lines are an outage or it never answered before the limit", () => {
  const failed = [`problem: no final report; see ${log}`, `problem: grok failed (1); see ${log}`];
  assert.deepEqual(runOutcome({ cli: "grok", code: 1, problems: failed, record: { pgid: 7 }, log: "starting\n503 Service Unavailable\n" }),
    { kind: "unavailable", why: "grok unavailable: 503 Service Unavailable", spent: false, outOfCredit: false });
  assert.deepEqual(runOutcome({ cli: "grok", code: 1, problems: failed, record: { pgid: 7 }, log: "error: connect ECONNREFUSED 127.0.0.1:443\n" }).why,
    "grok unavailable: error: connect ECONNREFUSED 127.0.0.1:443");
  // A 503 a tool trace printed earlier is not the run's ending.
  assert.deepEqual(runOutcome({ cli: "grok", code: 1, problems: failed, record: { pgid: 7 }, log: "503 Service Unavailable\n1\n2\n3\n4\n5\n" }),
    { kind: "failed", why: `grok failed (1); see ${log}`, spent: true, outOfCredit: false });
  assert.deepEqual(runOutcome({ cli: "grok", code: 124, problems: [`problem: agent exceeded timeout=3s; process group killed; see ${log}`], record: { pgid: 7 } }),
    { kind: "unavailable", why: "grok unavailable: no answer within 3s", spent: true, outOfCredit: false });
});

test("run outcome: any other failure, a run stopped from outside included, failed and keeps its count once the CLI started", () => {
  assert.deepEqual(runOutcome({ cli: "codex", code: 124, problems: [`problem: agent exceeded timeout=3s; process group killed; see ${log}`], record: { pgid: 7 } }),
    { kind: "failed", why: `agent exceeded timeout=3s; process group killed; see ${log}`, spent: true, outOfCredit: false });
  assert.deepEqual(runOutcome({ cli: "codex", code: 1, problems: ["problem: result lacks REVIEW_STATUS: complete"], record: { pgid: 7 } }),
    { kind: "failed", why: "result lacks REVIEW_STATUS: complete", spent: true, outOfCredit: false });
  // Stopped (SIGTERM at kit review's limit): the closing outage lines no longer decide, and the count stays.
  assert.deepEqual(runOutcome({ cli: "grok", code: 143, problems: [`problem: grok failed (143); see ${log}`], record: { pgid: 7 }, log: "503 Service Unavailable\n" }),
    { kind: "failed", why: `grok failed (143); see ${log}`, spent: true, outOfCredit: false });
  // Stopped, but the runner's own marks still decide: a refused run is unavailable and a silent one gives its count back.
  assert.deepEqual(runOutcome({ cli: "codex", code: 130, problems: ["problem: gpt usage limit until 9:00 AM"], record: { pgid: 7, refused: true } }),
    { kind: "unavailable", why: "gpt usage limit until 9:00 AM", spent: false, outOfCredit: false });
  assert.deepEqual(runOutcome({ cli: "opencode", code: 143, problems: ["problem: opencode unavailable: no session within 0.5s"], record: { pgid: 7, silent: true } }),
    { kind: "failed", why: "opencode unavailable: no session within 0.5s", spent: false, outOfCredit: false });
  // A run that failed before its CLI started spent nothing.
  assert.deepEqual(runOutcome({ cli: "claude", code: 1, problems: ["problem: empty diff for HEAD"], record: { pgid: null } }),
    { kind: "failed", why: "empty diff for HEAD", spent: false, outOfCredit: false });
  assert.deepEqual(runOutcome({ cli: "claude", code: 1, problems: [], record: { pgid: 7 } }),
    { kind: "failed", why: null, spent: true, outOfCredit: false });
});
