import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runSpecs } from "../spec-runner.mjs";

interface Ran { status: number; text: string; stderr: string; failure?: string }
type Answer = (argv: string[]) => Ran;

// kit pr's side of the spec runner, in memory: kit runs answer from `answer`, each call (with the quiet holder it
// carried) and each lock taken and released is recorded in `events`.
function harness(t: TestContext, answer: Answer, { missing = false, list = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spec-runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const events: string[] = [], said: string[] = [];
  const io = {
    list: async (argv: string[]) => { events.push(`list ${argv.join(" ")}`); return list; },
    exec: async (argv: string[], extraEnv?: Record<string, string>) => {
      events.push(`exec ${argv.join(" ")}${extraEnv?.KIT_QUIET_HOLDER ? " (quiet)" : ""}`);
      return answer(argv);
    },
    failure: (ran: Ran) => ran.stderr.trim() || `kit exited ${ran.status}`,
    machineLock: async (name: string) => { events.push(`lock ${name}`); return { missing, release: async () => { events.push(`release ${name}`); } }; },
    flakyLog: join(dir, "state/flaky.jsonl"),
    record: { owner: "fleet-lead", branch: "build/x" },
  };
  const run = (changes: string[], settings: Record<string, unknown> = {}) =>
    runSpecs({ changes: changes.map(path => ({ path })), settings: { project: "demo", ...settings }, base: "dev", io, log: (line: string) => said.push(line) });
  return { run, events, said, flakyLog: io.flakyLog };
}
const passed = (...files: string[]): Ran => ({ status: 0, text: `${files.map(file => `✓ ${file}`).join("\n")}\nRESULT: ok specs ${files.length} passed\n`, stderr: "" });
const failedRun = (pass: string[], fail: string[]): Ran => ({ status: 1, stderr: "",
  text: `${pass.map(file => `✓ ${file}`).join("\n")}\n${fail.map(file => `✗ ${file}: opens the menu — timeout`).join("\n")}\nRESULT: fail specs ${fail.length} of ${pass.length + fail.length} failed\n` });
const full = ["specs", "--affected", "--base", "origin/dev"];

test("a full run that passes is one PR line, under the full-run lock alone", async t => {
  const h = harness(t, () => passed("a.spec.ts", "b.spec.ts"));
  assert.deepEqual(await h.run(["src/a.ts"]), { lines: ["- kit specs --affected --base origin/dev: RESULT: ok specs 2 passed"], flaky: [] });
  assert.deepEqual(h.events, ["lock browser-run", `exec ${full.join(" ")}`, "release browser-run"]);
});

test("an untouched file that fails in the full run and passes alone is flaky: named, logged, forgiven", async t => {
  const h = harness(t, argv => argv.length === 2 ? passed(argv[1]) : failedRun(["a.spec.ts"], ["b.spec.ts"]));
  const specs = await h.run(["src/a.ts"]);
  assert.deepEqual(specs.flaky, ["b.spec.ts"]);
  assert.equal(specs.lines[1], "- flaky under load: b.spec.ts (failed in the full run, passed alone)");
  assert.match(h.said[0], /^specs: flaky under load: b\.spec\.ts \(failed in the full run at load \d+(\.\d+)?, passed alone\)$/);
  // The lone rerun holds the quiet lock and tells the kit jobs it starts so.
  assert.deepEqual(h.events, ["lock browser-run", `exec ${full.join(" ")}`, "lock quiet", "exec specs b.spec.ts (quiet)", "release quiet", "release browser-run"]);
  const [entry] = readFileSync(h.flakyLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(Object.keys(entry), ["time", "project", "file", "test", "load", "owner", "branch"]);
  assert.deepEqual({ ...entry, time: undefined, load: undefined },
    { time: undefined, project: "demo", file: "b.spec.ts", test: "opens the menu", load: undefined, owner: "fleet-lead", branch: "build/x" });
});

test("a file the change touches that fails is blamed, never rerun; the others are not rerun either", async t => {
  const h = harness(t, () => failedRun([], ["a.spec.ts", "b.spec.ts"]));
  await assert.rejects(h.run(["a.spec.ts"]), { message: "2 spec files failed: a.spec.ts (this change touches it), b.spec.ts (not rerun)" });
  assert.deepEqual(h.events, ["lock browser-run", `exec ${full.join(" ")}`, "release browser-run"]);
  assert.equal(existsSync(h.flakyLog), false);
});

test("a failed run that did not report every file is never forgiven: its own message, the locks released", async t => {
  const h = harness(t, () => ({ status: 1, text: "✗ b.spec.ts: opens the menu\n", stderr: "server never started\n" }));
  await assert.rejects(h.run([]), { message: "server never started" });
  assert.deepEqual(h.events.at(-1), "release browser-run");
});

test("timing files run after the rest, each alone under the quiet lock; nothing selected takes no lock", async t => {
  const list = "a.spec.ts [chromium]\nslow.spec.ts [chromium]\nRESULT: ok specs 2 selected\n";
  const h = harness(t, argv => passed(...argv.slice(1)), { list });
  const specs = await h.run([], { timing: ["slow"] });
  assert.deepEqual(specs.lines, ["- kit specs <1 affected files without the timing ones>: RESULT: ok specs 1 passed",
    "- kit specs slow.spec.ts (timing, alone): RESULT: ok specs 1 passed"]);
  assert.deepEqual(h.events, [`list ${full.join(" ")} --list`, "lock browser-run", "exec specs a.spec.ts", "lock quiet", "exec specs slow.spec.ts (quiet)",
    "release quiet", "release browser-run"]);
  const none = harness(t, () => { throw new Error("no run"); }, { list: "RESULT: ok specs none affected\n" });
  assert.deepEqual(await none.run([], { timing: ["slow"] }), { lines: ["- kit specs --affected --base origin/dev: RESULT: ok specs none affected"], flaky: [] });
  assert.deepEqual(none.events, [`list ${full.join(" ")} --list`]);
});

test("once a touched file fails, the timing files are named as not run and the quiet lock is never taken", async t => {
  const list = "a.spec.ts [chromium]\nslow.spec.ts [chromium]\nRESULT: ok specs 2 selected\n";
  const h = harness(t, argv => argv[1] === "a.spec.ts" ? failedRun([], ["a.spec.ts"]) : passed(...argv.slice(1)), { list });
  await assert.rejects(h.run(["a.spec.ts"], { timing: ["slow"] }),
    { message: "2 spec files failed: a.spec.ts (this change touches it), slow.spec.ts (timing, not run)" });
  assert.deepEqual(h.events, [`list ${full.join(" ")} --list`, "lock browser-run", "exec specs a.spec.ts", "release browser-run"]);
});

test("without flock the specs run unlocked and say so once, in the PR and on the console", async t => {
  const h = harness(t, argv => argv.length === 2 ? passed(argv[1]) : failedRun([], ["b.spec.ts"]), { missing: true });
  const specs = await h.run([]);
  const line = "problem: flock is not installed, so browser runs are not kept one at a time (install util-linux)";
  assert.equal(specs.lines.filter(entry => entry === `- ${line}`).length, 1);
  assert.equal(h.said.filter(entry => entry === `specs: ${line}`).length, 1);
});
