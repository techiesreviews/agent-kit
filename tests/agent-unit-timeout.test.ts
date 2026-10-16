import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("unit.sh enforces a per-test timeout and rejects an invalid ASE_UNIT_TIMEOUT_MS", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-unit-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const hung = join(dir, "hung.test.ts");
  writeFileSync(hung, `
import test from "node:test";
test("hung test never settles", async () => {
  await new Promise(() => {});
});
`);
  const invoke = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const started = Date.now();
    // This suite runs under `tsx --test`, whose NODE_TEST_CONTEXT would otherwise leak into
    // unit.sh's own `tsx --test` run and make it skip the test files.
    const spawned = { ...process.env, ...env };
    delete spawned.NODE_TEST_CONTEXT;
    const result = spawnSync("bash", [resolve("scripts/agents/unit.sh"), ...args], {
      encoding: "utf8",
      timeout: 20_000,
      cwd: process.cwd(),
      env: spawned,
    });
    return { ...result, elapsed: Date.now() - started };
  };
  const timedOut = invoke([hung], { ASE_UNIT_TIMEOUT_MS: "500" });
  assert.equal(timedOut.error, undefined);
  assert.ok(timedOut.elapsed < 20_000, `unit.sh took ${timedOut.elapsed}ms to report the hung test`);
  assert.notEqual(timedOut.status, 0, timedOut.stdout + timedOut.stderr);
  assert.match(timedOut.stdout + timedOut.stderr, /hung test never settles/);
  for (const invalid of ["abc", "0", "-5", "1.5"]) {
    const result = invoke([], { ASE_UNIT_TIMEOUT_MS: invalid });
    assert.equal(result.status, 2, `ASE_UNIT_TIMEOUT_MS=${invalid}`);
    assert.match(result.stderr, /Usage/);
  }
});
