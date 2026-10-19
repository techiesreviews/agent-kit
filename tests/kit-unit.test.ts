import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const kit = resolve("scripts/agents/kit");
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-unit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, KIT_ROOT: root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  delete env.NODE_TEST_CONTEXT;
  const put = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const git = (...args: string[]) => {
    const output = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    assert.equal(output.status, 0, output.stderr);
    return output.stdout.trim();
  };
  const body = `import test from "node:test";
import { appendFileSync, mkdirSync } from "node:fs";
test("selected test runs", () => { mkdirSync(".scratch", { recursive: true }); appendFileSync(".scratch/executed", "ran\\n"); });\n`;
  put("package.json", '{"type":"module"}');
  put(".gitignore", ".scratch/\nnode_modules/\n");
  put("src/leaf.ts", "export const value = 1;\n");
  put("src/middle.ts", 'export { value } from "./leaf.js";\n');
  put("tests/support/bridge.ts", 'import "../../src/middle.js";\n');
  put("scripts/helper.mjs", "export const helper = 1;\n");
  put("tests/hops.test.ts", 'import "./support/bridge.js";\n' + body);
  put("tests/helper.test.ts", 'import "../scripts/helper.mjs";\n' + body);
  put("tests/direct.test.ts", body);
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  git("init", "--quiet", "--initial-branch=feature");
  git("config", "user.name", "Kit unit test");
  git("config", "user.email", "kit-unit@example.test");
  git("add", "."); git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/dev", base);
  const run = (...args: string[]) => spawnSync(kit, ["unit", ...args], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  const executed = () => existsSync(join(root, ".scratch/executed")) ? readFileSync(join(root, ".scratch/executed"), "utf8").trim().split("\n").length : 0;
  return { root, put, git, run, executed, body, base };
}
type Output = ReturnType<ReturnType<typeof fixture>["run"]>;
function result(output: Output, status: number, pattern: RegExp) {
  assert.equal(output.error, undefined);
  assert.equal(output.status, status, output.stderr + output.stdout);
  const lines = output.stdout.trimEnd().split("\n");
  assert.equal(lines.filter(line => line.startsWith("RESULT:")).length, 1, output.stdout);
  assert.match(lines.at(-1)!, pattern);
}

test("affected unit selection includes changed, staged and untracked tests; list runs nothing", t => {
  const f = fixture(t);
  f.put("tests/direct.test.ts", f.body + "// changed\n");
  f.git("add", "tests/direct.test.ts");
  f.put("tests/new.test.ts", f.body);
  const output = f.run("--affected", "--list");
  result(output, 0, /ok unit 2 selected \(list only\)/);
  assert.match(output.stdout, /tests\/direct.test.ts — changed/);
  assert.match(output.stdout, /tests\/new.test.ts — changed/);
  assert.doesNotMatch(output.stdout, /hops.test.ts|helper.test.ts/);
  assert.equal(f.executed(), 0);
  result(f.run("--affected"), 0, /ok unit 2\/2 \(2 files\) log /);
  assert.equal(f.executed(), 2);
});

test("affected unit selection follows three import hops and prints the path", t => {
  const f = fixture(t);
  f.put("src/leaf.ts", "export const value = 2;\n");
  const output = f.run("--affected");
  result(output, 0, /ok unit 1\/1 \(1 files\) log /);
  assert.match(output.stdout, /tests\/hops.test.ts — via tests\/support\/bridge.ts \(via src\/middle.ts \(imports src\/leaf.ts\)\)/);
  assert.equal(f.executed(), 1);
});

test("affected unit selection reaches scripts helpers and their direct import reason", t => {
  const f = fixture(t);
  f.put("scripts/helper.mjs", "export const helper = 2;\n");
  const output = f.run("--affected");
  result(output, 0, /ok unit 1\/1 \(1 files\) log /);
  assert.match(output.stdout, /tests\/helper.test.ts — imports scripts\/helper.mjs/);
});

test("docs-only diffs run nothing; base chooses the merge-base plus local changes", t => {
  const f = fixture(t);
  f.put("docs/note.md", "only docs\n");
  result(f.run("--affected"), 0, /ok unit none affected/);
  assert.equal(f.executed(), 0);
  f.put("src/leaf.ts", "export const value = 2;\n");
  f.git("add", "."); f.git("commit", "--quiet", "-m", "leaf");
  const head = f.git("rev-parse", "HEAD");
  f.git("update-ref", "refs/remotes/origin/dev", head);
  result(f.run("--affected"), 0, /none affected/);
  const output = f.run("--affected", "--base", f.base, "--list");
  result(output, 0, /1 selected/);
  assert.match(output.stdout, /hops.test.ts/);
  f.put("scripts/helper.mjs", "export const helper = 3;\n");
  result(f.run("--affected", "--base", f.base), 0, /ok unit 2\/2 \(2 files\) log /);
});

test("removed modules still select surviving importers; deleted tests are not run", t => {
  const f = fixture(t);
  rmSync(join(f.root, "src/leaf.ts"));
  rmSync(join(f.root, "tests/direct.test.ts"));
  const output = f.run("--affected", "--list");
  result(output, 0, /1 selected/);
  assert.match(output.stdout, /hops.test.ts/);
  assert.doesNotMatch(output.stdout, /direct.test.ts/);
});

test("explicit files and default full suite execute through unit.sh; failure status follows tests", t => {
  const f = fixture(t);
  result(f.run("tests/direct.test.ts"), 0, /ok unit 1\/1 \(1 files\) log /);
  result(f.run(), 0, /ok unit 3\/3 \(3 files\) log /);
  assert.equal(f.executed(), 4);
  f.put("tests/direct.test.ts", 'import test from "node:test"; test("fails", () => { throw new Error("deliberate failure"); });\n');
  const output = f.run("--affected");
  result(output, 1, /fail unit 0\/1 \(1 files\) log /);
  assert.match(output.stdout, /deliberate failure/);
});

test("unit help, listing and invalid options use the kit front door", t => {
  const f = fixture(t);
  const listing = spawnSync(kit, [], { encoding: "utf8" });
  assert.match(listing.stdout, /unit\s+run focused unit tests/);
  const help = f.run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: kit unit/);
  assert.doesNotMatch(help.stdout, /RESULT:/);
  for (const args of [["--wat"], ["--base"], ["--base", "HEAD"], ["--affected", "tests/direct.test.ts"], ["--affected", "--affected"], ["--list", "--list"], ["--affected", "--base", "missing"], ["missing.test.ts"]]) {
    result(f.run(...args), 2, /fail unit /);
  }
  assert.equal(f.executed(), 0);
});
