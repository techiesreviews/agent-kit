import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { failedSpecs, flakyFiles, isTiming, listedSpecs, timingList } from "../browser-runs.mjs";
// @ts-expect-error The script is plain JavaScript without declarations.
import { kitMachineLock } from "../kit-lib.mjs";

function state(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-browser-runs-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, env: { ...process.env, XDG_STATE_HOME: directory }, lock: join(directory, "agent-kit/browser-run.lock") };
}

// A process's start time as /proc names it (field 22), which the lock keeps beside the pid.
const started = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19];

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

test("a machine lock makes the second taker wait, saying whose run it waits for, until the first lets go", async t => {
  const s = state(t), waits: string[] = [];
  const first = await kitMachineLock("browser-run", { owner: "ke-60", env: s.env });
  assert.match(readFileSync(join(s.lock, "owner"), "utf8"), new RegExp(`^${process.pid} ${started(process.pid)} ke-60\n$`));
  let taken = false;
  const second = kitMachineLock("browser-run", { owner: "ke-88", env: s.env, pollMs: 20, onWait: (owner: string) => waits.push(owner) })
    .then((lock: { release: () => void }) => { taken = true; return lock; });
  await delay(150);
  assert.equal(taken, false);
  assert.deepEqual(waits, ["ke-60"]);
  first.release();
  const lock = await second;
  assert.deepEqual(waits, ["ke-60"]);
  assert.match(readFileSync(join(s.lock, "owner"), "utf8"), / ke-88\n$/);
  // A release after the lock changed hands leaves the new owner's lock alone.
  first.release();
  assert.equal(existsSync(s.lock), true);
  lock.release();
  assert.equal(existsSync(s.lock), false);
});

test("a machine lock whose process is gone, or whose pid now belongs to another process, is taken over at once", async t => {
  const s = state(t), waits: string[] = [];
  const child = spawn("true");
  await new Promise(accept => child.once("close", accept));
  for (const owner of [`${child.pid} 1 ghost\n`, `${process.pid} 1 reused\n`]) {
    mkdirSync(s.lock, { recursive: true });
    writeFileSync(join(s.lock, "owner"), owner);
    const lock = await kitMachineLock("browser-run", { owner: "ke-88", env: s.env, pollMs: 20, onWait: (who: string) => waits.push(who) });
    assert.match(readFileSync(join(s.lock, "owner"), "utf8"), / ke-88\n$/);
    lock.release();
  }
  assert.deepEqual(waits, []);
});
