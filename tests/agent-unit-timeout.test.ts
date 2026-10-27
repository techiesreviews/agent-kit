import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    return result;
  };
  const timedOut = invoke([hung], { ASE_UNIT_TIMEOUT_MS: "500" });
  assert.equal(timedOut.error, undefined);
  assert.notEqual(timedOut.status, 0, timedOut.stdout + timedOut.stderr);
  assert.match(timedOut.stdout + timedOut.stderr, /hung test never settles/);
  assert.match(timedOut.stdout + timedOut.stderr, /test timed out after 500ms/);
  for (const invalid of ["abc", "0", "-5", "1.5"]) {
    const result = invoke([], { ASE_UNIT_TIMEOUT_MS: invalid });
    assert.equal(result.status, 2, `ASE_UNIT_TIMEOUT_MS=${invalid}`);
    assert.match(result.stderr, /Usage/);
  }
});

test("unit.sh with no files passes the timeout and every tests/*.test.ts file to tsx", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ase-unit-all-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests/a.test.ts"), "");
  writeFileSync(join(dir, "tests/b.test.ts"), "");
  // The full suite is what kit unit lists: unit.files over git's files in a project with its own settings.
  mkdirSync(join(dir, "scripts/agents"), { recursive: true });
  writeFileSync(join(dir, "scripts/agents/kit.json"), JSON.stringify({ project: "unit-all", branches: { land: "dev" },
    unit: { run: "./node_modules/.bin/tsx --test --test-reporter=spec", files: "tests/*.test.ts" } }));
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n.scratch/\nargs.txt\n");
  spawnSync("git", ["init", "-q", dir]);
  // A fake tsx records its arguments and prints a passing report for unit-summary.
  const tsx = join(dir, "node_modules/.bin/tsx");
  writeFileSync(tsx, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > args.txt\nprintf 'ℹ tests 2\\nℹ pass 2\\nℹ fail 0\\nℹ cancelled 0\\n'\n`);
  chmodSync(tsx, 0o755);
  const env = { ...process.env, ASE_UNIT_TIMEOUT_MS: "500" };
  // A kit run exports its own project; this one is the temporary folder.
  for (const key of ["NODE_TEST_CONTEXT", "KIT_ROOT", "KIT_LIB", "KIT_LIB_MJS"]) delete env[key];
  const result = spawnSync("bash", [resolve("scripts/agents/unit.sh")], { encoding: "utf8", cwd: dir, env, timeout: 20_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(readFileSync(join(dir, "args.txt"), "utf8").trim().split("\n"), ["--test", "--test-reporter=spec", "--test-timeout=500", "tests/a.test.ts", "tests/b.test.ts"]);
});
