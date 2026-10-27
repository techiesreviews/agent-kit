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
  put("scripts/agents/kit.json", JSON.stringify({ project: "kit-unit", branches: { land: "dev" },
    unit: { run: "./node_modules/.bin/tsx --test --test-reporter=spec", files: "tests/*.test.ts" } }));
  symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  // --affected reads the project's own import scan.
  symlinkSync(resolve("scripts/agents/specs-affected.mjs"), join(root, "scripts/agents/specs-affected.mjs"));
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
  for (const args of [["--wat"], ["--base"], ["--base", "HEAD"], ["--affected", "tests/direct.test.ts"], ["--affected", "--affected"], ["--list", "--list"], ["missing.test.ts"]]) {
    result(f.run(...args), 2, /fail unit /);
  }
  // A base git cannot find is no usage error: the arguments parsed, and the problem line says which ref.
  const base = f.run("--affected", "--base", "missing");
  result(base, 1, /^RESULT: fail unit /);
  assert.match(base.stderr, /^problem: .*missing/m);
  assert.doesNotMatch(base.stderr, /Usage:/);
  assert.equal(f.executed(), 0);
});

test("without the project's import scan --affected follows plain imports itself; no unit.files is said plainly", t => {
  const f = fixture(t);
  rmSync(join(f.root, "scripts/agents/specs-affected.mjs"));
  f.put("src/leaf.ts", "export const value = 2;\n");
  const output = f.run("--affected", "--list");
  result(output, 0, /ok unit 1 selected \(list only\)/);
  assert.match(output.stdout, /tests\/hops.test.ts — via tests\/support\/bridge.ts \(via src\/middle.ts \(imports src\/leaf.ts\)\)/);
  f.put("scripts/agents/kit.json", JSON.stringify({ project: "kit-unit", branches: { land: "dev" }, unit: { run: "node --test" } }));
  for (const args of [["--affected"], []]) {
    const output = f.run(...args);
    result(output, 1, /^RESULT: fail unit kit unit needs unit\.files in scripts\/agents\/kit\.json$/);
    assert.doesNotMatch(output.stderr, /Usage:/);
  }
  const env = { ...process.env, KIT_ROOT: f.root };
  delete env.NODE_TEST_CONTEXT;
  const bare = spawnSync("bash", [resolve("scripts/agents/unit.sh")], { cwd: f.root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(bare.status, 1, bare.stdout + bare.stderr);
  assert.equal(bare.stderr, "unit.sh: kit unit needs unit.files in scripts/agents/kit.json\n");
  // No unit.run: a settings problem too, so status 1, for named files as for none.
  f.put("scripts/agents/kit.json", JSON.stringify({ project: "kit-unit", branches: { land: "dev" }, unit: { files: "tests/*.test.ts" } }));
  for (const args of [["tests/direct.test.ts"], []]) {
    const output = spawnSync("bash", [resolve("scripts/agents/unit.sh"), ...args], { cwd: f.root, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(output.status, 1, output.stdout + output.stderr);
    assert.equal(output.stderr, "unit.sh needs unit.run in scripts/agents/kit.json\n");
  }
  assert.equal(f.executed(), 0);
});

test("a unit.files pattern matching nothing and a broken import scan fail without usage", t => {
  const f = fixture(t);
  const env = { ...process.env, KIT_ROOT: f.root };
  delete env.NODE_TEST_CONTEXT;
  f.put("scripts/agents/kit.json", JSON.stringify({ project: "kit-unit", branches: { land: "dev" }, unit: { run: "node --test", files: "nomatch/*.test.ts" } }));
  const none = spawnSync("bash", [resolve("scripts/agents/unit.sh")], { cwd: f.root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(none.status, 1, none.stdout + none.stderr);
  assert.equal(none.stderr, "unit.sh: no files match unit.files in scripts/agents/kit.json\n");
  // The project's own scan is the repo's code, not an argument: a syntax error in it is a failure.
  rmSync(join(f.root, "scripts/agents/specs-affected.mjs"));
  f.put("scripts/agents/specs-affected.mjs", "export const graphFile = ;\n");
  const scan = f.run("--affected", "--list");
  result(scan, 1, /^RESULT: fail unit /);
  assert.match(scan.stderr, /^problem: /m);
  assert.doesNotMatch(scan.stderr, /Usage:/);
  assert.equal(f.executed(), 0);
});

test("unit.sh with no files runs only the tests its unit.files pattern matches", t => {
  const f = fixture(t);
  f.put("scripts/agents/kit.json", JSON.stringify({ project: "kit-unit", branches: { land: "dev" },
    unit: { run: "./node_modules/.bin/tsx --test --test-reporter=spec", files: "tests/d*.test.ts" } }));
  f.put("tests/direct.test.ts", f.body.replace("selected test runs", "direct test runs"));
  const env = { ...process.env, KIT_ROOT: f.root };
  delete env.NODE_TEST_CONTEXT;
  const output = spawnSync("bash", [resolve("scripts/agents/unit.sh")], { cwd: f.root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.match(output.stdout, /^pass 1, fail 0$/m);
  assert.equal(f.executed(), 1);
  // The one test that ran is tests/direct.test.ts's, the only file the pattern matches.
  const log = /^log: (.+)$/m.exec(output.stdout)![1];
  assert.match(readFileSync(join(f.root, log), "utf8"), /direct test runs/);
});

// techies-playground (research 04): lands on main, node --test, unit tests in several places and no import scan of its own.
test("unit.files patterns pick src/**/*.test.js for --affected and every pattern for the full suite under node --test", t => {
  const f = fixture(t);
  rmSync(join(f.root, "scripts/agents/specs-affected.mjs"));
  for (const file of ["tests/hops.test.ts", "tests/helper.test.ts", "tests/direct.test.ts"]) rmSync(join(f.root, file));
  const body = f.body.replace("selected test runs", "js test runs");
  f.put("scripts/agents/kit.json", JSON.stringify({ project: "techies-playground", branches: { land: "main", release: "main", ci: "main" },
    checks: { test: "npm test" }, unit: { run: "node --test", files: ["src/**/*.test.js", "scripts/*.test.mjs", "test/"] } }));
  f.put("src/blocks/math.js", "export const add = (a, b) => a + b;\n");
  f.put("src/blocks/math.test.js", 'import "./math.js";\n' + body);
  f.put("src/top.test.js", body);
  f.put("scripts/build.test.mjs", body);
  f.put("scripts/deep/skip.test.mjs", body);
  f.put("test/helpers/setup.js", body);
  // A folder pattern takes only the JavaScript node --test runs there, not a TypeScript helper beside it.
  f.put("test/helpers/setup.ts", "export const setup = 1;\n");
  f.put("test/notes.md", "not a test\n");
  f.git("add", "."); f.git("commit", "--quiet", "-m", "playground");
  f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
  f.put("src/blocks/math.js", "export const add = (a, b) => b + a;\n");
  const output = f.run("--affected");
  result(output, 0, /ok unit 1\/1 \(1 files\) log /);
  assert.match(output.stdout, /^src\/blocks\/math.test.js — imports src\/blocks\/math.js$/m);
  assert.equal(f.executed(), 1);
  const all = f.run("--list");
  result(all, 0, /ok unit 4 selected \(list only\)/);
  assert.deepEqual(all.stdout.split("\n").filter(line => line.endsWith(" — all")),
    ["scripts/build.test.mjs — all", "src/blocks/math.test.js — all", "src/top.test.js — all", "test/helpers/setup.js — all"]);
  // unit.sh alone expands the same patterns.
  const env = { ...process.env, KIT_ROOT: f.root };
  delete env.NODE_TEST_CONTEXT;
  const suite = spawnSync("bash", [resolve("scripts/agents/unit.sh")], { cwd: f.root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(suite.status, 0, suite.stderr + suite.stdout);
  assert.match(suite.stdout, /pass 4, fail 0/);
  // Ignored build output matching a pattern is left out by both: unit.sh runs what kit unit lists.
  f.put(".gitignore", ".scratch/\nnode_modules/\nsrc/dist/\n");
  f.put("src/dist/x.test.js", 'import test from "node:test"; test("ignored output", () => { throw new Error("ran an ignored file"); });\n');
  result(f.run("--list"), 0, /ok unit 4 selected \(list only\)/);
  const again = spawnSync("bash", [resolve("scripts/agents/unit.sh")], { cwd: f.root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(again.status, 0, again.stderr + again.stdout);
  assert.match(again.stdout, /pass 4, fail 0/);
});
