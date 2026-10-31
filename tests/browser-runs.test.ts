import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { failedSpecs, flakyFiles, isTiming, listedSpecs, timingList, wholeReport } from "../browser-runs.mjs";
// @ts-expect-error The script is plain JavaScript without declarations.
import { kitMachineLock } from "../kit-lib.mjs";

function state(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-browser-runs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, env: { ...process.env, XDG_STATE_HOME: directory }, lock: join(directory, "agent-kit/browser-run.lock") };
}

test("the specs command's output is read: its --list selection, and each failed file with its first failed test", () => {
  assert.deepEqual(listedSpecs([
    "builder run: 2 specs (named, changed or importing a changed file)",
    "tests/native-save/a.spec.ts [default] — changed; imports src/x.ts [import 1]",
    "tests/native-preview/b.spec.ts [default, preview] — named spec",
    "RESULT: ok specs 2 selected (list only)",
  ].join("\n")), ["tests/native-save/a.spec.ts", "tests/native-preview/b.spec.ts"]);
  assert.deepEqual(listedSpecs("RESULT: ok specs none affected\n"), []);
  assert.deepEqual(failedSpecs([
    "log: .scratch/kit-specs/run-1/0-default.log",
    "✓ tests/native-save/a.spec.ts (4 passed)",
    "✗ tests/native-save/native-edit-latency.spec.ts: typing stays fast — next keystroke 81 ms against 100",
    "✗ tests/native-save/c.spec.ts: opens the menu",
    "RESULT: fail specs 2 of 3 failed: native-edit-latency.spec.ts, c.spec.ts",
  ].join("\n")), [
    { file: "tests/native-save/native-edit-latency.spec.ts", test: "typing stays fast" },
    { file: "tests/native-save/c.spec.ts", test: "opens the menu" },
  ]);
});

test("timing files come from the settings, by path, file name or name without .spec", () => {
  assert.deepEqual(timingList({}), []);
  assert.deepEqual(timingList({ timing: ["native-edit-latency", "tests/native-save/native-boot-memory.spec.ts"] }),
    ["native-edit-latency", "tests/native-save/native-boot-memory.spec.ts"]);
  for (const bad of ["native-edit-latency", [""], [3], {}]) assert.throws(() => timingList({ timing: bad }), /"timing" in scripts\/agents\/kit\.json must be a list of spec files/);
  const timing = ["native-edit-latency", "native-boot-memory.spec.ts", "tests/native-save/exact.spec.ts"];
  for (const file of ["tests/native-save/native-edit-latency.spec.ts", "tests/native-save/native-boot-memory.spec.ts", "tests/native-save/exact.spec.ts"])
    assert.equal(isTiming(file, timing), true, file);
  for (const file of ["tests/native-save/native-edit-latency-more.spec.ts", "tests/other/exact.spec.ts", "tests/native-save/native-edit.spec.ts"])
    assert.equal(isTiming(file, timing), false, file);
});

test("files flaky three or more times in seven days are named, this project's only, most first", () => {
  const now = Date.parse("2026-10-31T12:00:00Z"), day = 86_400_000;
  const line = (file: string, ago: number, project = "editor") => JSON.stringify({ time: new Date(now - ago).toISOString(), project, file, test: "t", load: 12.5 });
  const text = [
    ...[0, 1, 2, 3].map(n => line("tests/a.spec.ts", n * day)),
    ...[0, 1, 2].map(n => line("tests/b.spec.ts", n * day)),
    line("tests/c.spec.ts", 0), line("tests/c.spec.ts", day),
    line("tests/old.spec.ts", 0), line("tests/old.spec.ts", 8 * day), line("tests/old.spec.ts", 9 * day),
    ...[0, 1, 2].map(n => line("tests/other.spec.ts", n * day, "other")),
    "not json", "",
  ].join("\n");
  assert.deepEqual(flakyFiles(text, { project: "editor", now }), [{ file: "tests/a.spec.ts", count: 4 }, { file: "tests/b.spec.ts", count: 3 }]);
  assert.deepEqual(flakyFiles("", { project: "editor", now }), []);
});

test("a failed run counts as whole only when it reported every file it ran", () => {
  const run = ["✓ tests/a.spec.ts (4 passed)", "✗ tests/b.spec.ts: opens — timed out", "RESULT: fail specs 1 of 2 failed: b.spec.ts"].join("\n");
  assert.equal(wholeReport(run, ["tests/a.spec.ts", "tests/b.spec.ts"]), true);
  assert.equal(wholeReport(run, ["tests/a.spec.ts", "tests/b.spec.ts", "tests/c.spec.ts"]), false);
  assert.equal(wholeReport(run), true);
  // A crash part way: one file named, the count says more failed than were named.
  assert.equal(wholeReport("✗ tests/b.spec.ts: opens\nRESULT: fail specs 2 of 2 failed: a.spec.ts, b.spec.ts\n"), false);
  assert.equal(wholeReport("✗ tests/b.spec.ts: opens\nRESULT: fail child failure\n"), false);
});

// A lock holder made the way kitMachineLock holds one: flock with the file saying "<pid> <owner>".
async function holder(t: TestContext, lock: string, owner: string, seconds = "30") {
  mkdirSync(join(lock, ".."), { recursive: true });
  const child = spawn("flock", ["-o", "-x", lock, "sleep", seconds]);
  t.after(() => { child.kill(); });
  for (let i = 0; i < 100 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i++) await delay(20);
  writeFileSync(lock, `${child.pid} ${owner}\n`);
  return child;
}
const held = (lock: string) => spawnSync("flock", ["-n", lock, "true"]).status !== 0;

test("a machine lock makes the second taker wait, saying whose run it waits for, until the first lets go", async t => {
  const s = state(t), waits: string[] = [];
  const first = await kitMachineLock("browser-run", { owner: "ke-60", env: s.env });
  assert.equal(readFileSync(s.lock, "utf8"), `${process.pid} ke-60\n`);
  assert.equal(held(s.lock), true);
  let taken = false;
  const second = kitMachineLock("browser-run", { owner: "ke-88", env: s.env, onWait: (owner: string) => waits.push(owner) })
    .then((lock: { release: () => void }) => { taken = true; return lock; });
  await delay(300);
  assert.equal(taken, false);
  assert.deepEqual(waits, ["ke-60"]);
  first.release();
  const lock = await second;
  assert.deepEqual(waits, ["ke-60"]);
  assert.equal(readFileSync(s.lock, "utf8"), `${process.pid} ke-88\n`);
  // A second release of the first lock leaves the new owner's alone.
  first.release();
  assert.equal(readFileSync(s.lock, "utf8"), `${process.pid} ke-88\n`);
  lock.release();
  await delay(100);
  assert.equal(readFileSync(s.lock, "utf8"), "");
  assert.equal(held(s.lock), false);
});

test("a machine lock is free the moment its holder ends, however it ends; a file left behind holds nothing", async t => {
  const s = state(t), waits: string[] = [];
  const child = await holder(t, s.lock, "ke-60");
  const taking = kitMachineLock("browser-run", { owner: "ke-88", env: s.env, onWait: (who: string) => waits.push(who) });
  await delay(200);
  child.kill("SIGKILL");
  (await taking).release();
  assert.deepEqual(waits, ["ke-60"]);
  // A release lets go as its flock ends, a moment later.
  for (let i = 0; i < 100 && held(s.lock); i++) await delay(20);
  // The killed holder's line is still in the file, but nothing holds the lock.
  writeFileSync(s.lock, "1 ghost\n");
  (await kitMachineLock("browser-run", { owner: "ke-88", env: s.env, onWait: (who: string) => waits.push(who) })).release();
  assert.deepEqual(waits, ["ke-60"]);
});
