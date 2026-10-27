import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { findNode, kitMainRoot, kitOwner, kitResult, kitRoot, nodeEnv } from "../scripts/agents/kit-lib.mjs";

const kit = resolve("scripts/agents/kit");
const library = resolve("scripts/agents/kit-lib.sh");
const nodeError = "kit: no Node >=24 found (system, npx cache or nvm)";

function temp(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "agent-kit-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function environment(t: { after: (fn: () => void) => void }, values: NodeJS.ProcessEnv) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function command(directory: string, name: string, body: string, executable = true) {
  const file = join(directory, name);
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, executable ? 0o755 : 0o644);
  return file;
}

function run(args: string[] = [], env: NodeJS.ProcessEnv = {}, input = "") {
  return spawnSync("/bin/bash", ["scripts/agents/kit", ...args], {
    encoding: "utf8", env: { ...process.env, ...env }, input, timeout: 5000,
  });
}

function bash(body: string, env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail; source "$KIT_TEST_LIB"; ${body}`], {
    encoding: "utf8", env: { ...process.env, ...env, KIT_TEST_LIB: library }, cwd, timeout: 5000,
  });
}

function results(stdout: string) {
  return stdout.split("\n").filter((line) => line.startsWith("RESULT: "));
}

function fakeNode(file: string, version: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  chmodSync(file, 0o755);
}

function fixtureEnv(directory: string) {
  const current = join(directory, "current/node");
  fakeNode(current, "v22.15.0");
  return { PATH: `${dirname(current)}:/usr/bin:/bin`, CLAUDE_NODE_SEARCH_ROOT: directory };
}

test("kit lists executable commands by name and reads only the first 15 summary lines", (t) => {
  const directory = temp(t);
  command(directory, "zebra", "# kit: last command\nexit 0");
  const module = command(directory, "alpha.mjs", "// kit: first command # kit: later marker\n");
  writeFileSync(module, "#!/usr/bin/env node\n// kit: first command # kit: later marker\n");
  command(directory, "alpha-beta", "# kit: middle command\nexit 0");
  command(directory, "ignored", "# kit: no executable", false);
  command(directory, "_helper", "# kit: internal");
  command(directory, ".hidden", "# kit: hidden");
  mkdirSync(join(directory, "directory"));
  command(directory, "bare", `${"# padding\n".repeat(14)}# kit: too late`);
  const expected = "Usage: kit <command> [args]\n\nCommands:\n"
    + "  alpha       first command # kit: later marker\n"
    + "  alpha-beta  middle command\n"
    + "  bare        \n"
    + "  zebra       last command\n"
    + "Run 'kit <command> --help' for a command's usage.\n";
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = run(args, { KIT_COMMANDS_DIR: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
    assert.deepEqual(results(result.stdout), []);
  }
});

test("kit reads the shared folder and the project's own, lists them in two groups and keeps shared names", (t) => {
  const root = temp(t);
  const own = join(root, "own");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  mkdirSync(own);
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "x", branches: { land: "dev" }, commands: "own" }));
  command(own, "hello", '# kit: a project command\nprintf "hello from the project %s\\n" "$1"');
  command(own, "version", "# kit: a project version\nprintf 'project version\\n'");
  const env = { KIT_ROOT: root, KIT_COMMANDS_DIR: undefined };
  const list = run([], env);
  assert.equal(list.status, 0, list.stderr);
  const shared = list.stdout.indexOf("\nShared commands:\n"), project = list.stdout.indexOf("\nProject commands:\n");
  assert.ok(shared > 0 && project > shared, list.stdout);
  assert.match(list.stdout.slice(shared, project), /\n  doctor +check this worktree is safe to build in\n/);
  assert.match(list.stdout.slice(project), /^\nProject commands:\n  hello +a project command\n  version +\(hidden by the shared version; kit doctor names the clash\) a project version\nRun 'kit/);
  const hello = run(["hello", "there"], env);
  assert.equal(hello.status, 0, hello.stderr);
  assert.equal(hello.stdout, "hello from the project there\nRESULT: ok hello finished\n");
  // A project command never hides the shared one of the same name.
  const version = run(["version", "--help"], env);
  assert.match(version.stdout, /^Usage: kit version\n/);
  // KIT_COMMANDS_DIR replaces both folders: one plain group, neither real folder.
  const override = temp(t);
  command(override, "only", "# kit: the only command");
  const replaced = run([], { ...env, KIT_COMMANDS_DIR: override });
  assert.equal(replaced.stdout, "Usage: kit <command> [args]\n\nCommands:\n  only  the only command\nRun 'kit <command> --help' for a command's usage.\n");
  assert.equal(run(["hello"], { ...env, KIT_COMMANDS_DIR: override }).status, 2);
});

test("kit takes an absolute commands folder, and without one lists only shared commands", (t) => {
  const root = temp(t), own = temp(t);
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  const settings = (extra: object) => writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "x", branches: { land: "dev" }, ...extra }));
  command(own, "far", '# kit: from an absolute folder\nprintf "far away\\n"');
  const env = { KIT_ROOT: root, KIT_COMMANDS_DIR: undefined };
  settings({ commands: own });
  const list = run([], env);
  assert.match(list.stdout, /\nProject commands:\n  far +from an absolute folder\n/);
  const far = run(["far"], env);
  assert.equal(far.status, 0, far.stderr);
  assert.equal(far.stdout, "far away\nRESULT: ok far finished\n");
  settings({});
  const shared = run([], env);
  assert.equal(shared.status, 0, shared.stderr);
  assert.match(shared.stdout, /^Usage: kit <command> \[args\]\n\nShared commands:\n/);
  assert.doesNotMatch(shared.stdout, /Project commands|far/);
  const missing = run(["far"], env);
  assert.equal(missing.status, 2);
  assert.equal(missing.stdout, "RESULT: fail unknown command far\n");
  // A "commands" folder that does not exist adds no group; kit doctor names it.
  settings({ commands: "missing" });
  const absent = run([], env);
  assert.equal(absent.status, 0, absent.stderr);
  assert.match(absent.stdout, /\nShared commands:\n/);
  assert.doesNotMatch(absent.stdout, /Project commands/);
  const doctorHelp = run(["doctor", "--help"], env);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr);
  assert.match(doctorHelp.stdout, /^Usage: kit doctor/);
});

test("kit forwards command help and its exit status without RESULT enforcement", (t) => {
  const directory = temp(t);
  command(directory, "usage", 'printf "Usage: kit usage [%s]\\n" "$1"; exit "${HELP_STATUS:-0}"');
  for (const flag of ["--help", "-h"]) {
    const result = run(["usage", flag], { KIT_COMMANDS_DIR: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `Usage: kit usage [${flag}]\n`);
  }
  const result = run(["usage", "--help"], { KIT_COMMANDS_DIR: directory, HELP_STATUS: "4" });
  assert.equal(result.status, 4);
  assert.deepEqual(results(result.stdout), []);
});

test("kit treats --help after a subcommand as help, without RESULT enforcement", (t) => {
  const directory = temp(t);
  command(directory, "wait", 'printf "Usage: kit wait %s\\n" "$1"');
  const result = run(["wait", "pid", "--help"], { KIT_COMMANDS_DIR: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Usage: kit wait pid\n");
  assert.deepEqual(results(result.stdout), []);
});

test("kit reports unknown commands on stdout and lists commands on stderr", (t) => {
  const directory = temp(t);
  command(directory, "known", "# kit: a known command");
  const result = run(["x"], { KIT_COMMANDS_DIR: directory });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "RESULT: fail unknown command x\n");
  assert.match(result.stderr, /^kit: unknown command 'x'\nUsage: kit/);
  assert.match(result.stderr, /  known  a known command/);
});

test("kit guarantees a final RESULT while preserving child stdout, stderr and status", (t) => {
  const directory = temp(t);
  const cases: [string, string, number, string][] = [
    ["own", 'printf "log\\nRESULT: ok own done\\n"', 0, "log\nRESULT: ok own done\n"],
    ["fail", "exit 3", 3, "RESULT: fail fail exited 3 without a RESULT line\n"],
    ["silent", "exit 0", 0, "RESULT: ok silent finished\n"],
    ["killed", "kill -TERM $$", 143, "RESULT: fail killed exited 143 without a RESULT line\n"],
    ["crash", "set -e; false; echo unreachable", 1, "RESULT: fail crash exited 1 without a RESULT line\n"],
    ["partial", "printf 'intact \\ backslash'; printf error >&2", 0, "intact \\ backslash\nRESULT: ok partial finished\n"],
    ["partial-result", "printf 'RESULT: ok partial-result'", 0, "RESULT: ok partial-result"],
    ["blank", "printf '\\n'", 0, "\nRESULT: ok blank finished\n"],
  ];
  for (const [name, body, status, stdout] of cases) {
    command(directory, name, body);
    const result = run([name], { KIT_COMMANDS_DIR: directory });
    assert.equal(result.status, status, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, stdout, name);
    assert.equal(results(result.stdout).length, 1, name);
    if (name === "partial") assert.equal(result.stderr, "error");
  }
  const startup = join(directory, "startup");
  writeFileSync(startup, "readonly KIT_MAIN_ROOT=/persistent\n");
  const ownError = run(["silent"], { KIT_COMMANDS_DIR: directory, BASH_ENV: startup });
  assert.equal(ownError.status, 1);
  assert.match(ownError.stderr, /readonly variable/);
  assert.equal(ownError.stdout, "RESULT: fail silent exited 1 without a RESULT line\n");
});

test("kit preserves stdin and exports resolved roots and library paths from any cwd", (t) => {
  const directory = temp(t);
  command(directory, "inspect", 'read -r input; printf "%s\\n" "$input" "$KIT_ROOT" "$KIT_MAIN_ROOT" "$KIT_LIB" "$KIT_LIB_MJS"');
  const result = spawnSync("/bin/bash", [kit, "inspect"], {
    cwd: directory, input: "hello\n", encoding: "utf8", timeout: 5000,
    env: { ...process.env, KIT_COMMANDS_DIR: directory, KIT_ROOT: directory, KIT_MAIN_ROOT: "/persistent" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `hello\n${directory}\n/persistent\n${library}\n${resolve("scripts/agents/kit-lib.mjs")}\nRESULT: ok inspect finished\n`);
});

const signals: [NodeJS.Signals, number][] = [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]];
for (const [signal, expectedStatus] of signals) for (const ownResult of [false, true]) test(`kit forwards ${signal}, child RESULT ${ownResult}`, async (t) => {
  const directory = temp(t);
  const ready = ownResult ? "ready\nRESULT: ok child done\n" : "ready\n";
  command(directory, "waiting", `trap 'kill "$sleeper" 2>/dev/null || :; wait "$sleeper" 2>/dev/null || :; exit 0' TERM INT HUP\nsleep 4 &\nsleeper=$!\nprintf '${ready}'\nwait "$sleeper"`);
  const child = spawn("/bin/bash", [kit, "waiting"], { env: { ...process.env, KIT_COMMANDS_DIR: directory } });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "";
  let stderr = "";
  let sent = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!sent && stdout.includes(ready)) { sent = true; child.kill(signal); }
  });
  const status = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`signal test timed out: ${stderr}`)); }, 5000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(sent, true);
  assert.equal(status, expectedStatus, stderr);
  assert.equal(stdout, ownResult ? ready : "ready\nRESULT: fail waiting interrupted\n");
  assert.equal(results(stdout).length, 1);
});

test("bash and mjs select the same highest numeric Node and prefer a supported system node", (t) => {
  const directory = join(temp(t), "space $dollar `tick` quote");
  const env = fixtureEnv(directory);
  const npm = join(directory, ".npm/_npx/install/node_modules/node/bin/node");
  const nvm = join(directory, ".nvm/versions/node/v25.2.10/bin/node");
  fakeNode(npm, "v24.99.100");
  fakeNode(nvm, "v25.2.10");
  for (const version of ["v25.2.9", "v25.1.100", "v23.99.99", "bad", "v99.0.0-extra", "v99.0.0\njunk"]) {
    fakeNode(join(directory, `.nvm/versions/node/${version.replace(/\n/g, "-")}/bin/node`), version);
  }
  const broken = join(directory, ".nvm/versions/node/broken/bin/node");
  fakeNode(broken, "v99.0.0");
  writeFileSync(broken, "#!/bin/sh\nexit 1\n");
  const nonExecutable = join(directory, ".nvm/versions/node/no-execute/bin/node");
  fakeNode(nonExecutable, "v99.0.0");
  chmodSync(nonExecutable, 0o644);
  const assertLookup = (expected: string) => {
    const result = bash("kit_node_find", env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${expected}\n`);
    assert.equal(findNode({ path: env.PATH, searchRoot: directory }), expected);
    const selected = bash('kit_node; kit_node; printf "%s\\n%s\\n" "$KIT_NODE" "$PATH"', env);
    const expectedEnv = nodeEnv(env);
    assert.equal(selected.status, 0, selected.stderr);
    assert.equal(selected.stdout, `${expectedEnv.KIT_NODE}\n${expectedEnv.PATH}\n`);
    assert.equal(nodeEnv(expectedEnv).PATH, expectedEnv.PATH);
    assert.equal(env.PATH.startsWith(dirname(expected)), expected === join(directory, "current/node"));
  };
  assertLookup(nvm);
  command(directory, "which-node", "command -v node");
  const result = run(["which-node"], { ...env, KIT_COMMANDS_DIR: directory });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${nvm}\nRESULT: ok which-node finished\n`);
  fakeNode(join(directory, "current/node"), "v24.0.0");
  assertLookup(join(directory, "current/node"));
});

test("Node lookup handles npm alone, absent system node, and unsupported installations", (t) => {
  const directory = temp(t);
  const env = fixtureEnv(directory);
  const npm = join(directory, ".npm/_npx/install/node_modules/node/bin/node");
  fakeNode(npm, "v24.0.1");
  assert.equal(bash("kit_node_find", env).stdout, `${npm}\n`);
  assert.equal(findNode({ path: env.PATH, searchRoot: directory }), npm);
  const noSystem = { ...env, PATH: "/missing" };
  assert.equal(bash("kit_node_find", noSystem).stdout, `${npm}\n`);
  assert.equal(findNode({ path: noSystem.PATH, searchRoot: directory }), npm);
  fakeNode(npm, "v23.9.9");
  const found = bash("kit_node_find", env);
  assert.equal(found.status, 1);
  assert.equal(found.stdout + found.stderr, "");
  const result = bash("kit_node", env);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, `${nodeError}\n`);
  assert.equal(findNode({ path: env.PATH, searchRoot: directory }), null);
  assert.throws(() => nodeEnv(env), { message: nodeError });
  command(directory, "still-runs", "exit 0");
  const child = run(["still-runs"], { ...env, KIT_COMMANDS_DIR: directory });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, `${nodeError}\n`);
  assert.equal(child.stdout, "RESULT: ok still-runs finished\n");
});

test("bash and mjs roots and owner follow overrides, owner file and branch fallbacks", (t) => {
  const directory = temp(t);
  const initialized = spawnSync("git", ["init", "-b", "feature/x", directory], { encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  environment(t, { KIT_ROOT: directory, ASE_OWNER: "explicit", KIT_MAIN_ROOT: undefined });
  const env = { KIT_ROOT: directory, ASE_OWNER: "explicit" };
  assert.equal(kitRoot(), directory);
  assert.equal(bash("kit_root", env).stdout, `${directory}\n`);
  assert.equal(kitOwner(), "explicit");
  assert.equal(bash("kit_owner", env).stdout, "explicit\n");
  delete process.env.ASE_OWNER;
  env.ASE_OWNER = "";
  mkdirSync(join(directory, ".scratch"));
  writeFileSync(join(directory, ".scratch/owner"), "2026-10-16T00:00:00Z file-owner feature/x dev\n");
  assert.equal(kitOwner(), "file-owner");
  assert.equal(bash("kit_owner", env).stdout, "file-owner\n");
  writeFileSync(join(directory, ".scratch/owner"), "2026-10-16T00:00:00Z unknown feature/x dev\n");
  assert.equal(kitOwner(), "feature/x");
  assert.equal(bash("kit_owner", env).stdout, "feature/x\n");
  rmSync(join(directory, ".scratch/owner"));
  assert.equal(kitOwner(), "feature/x");
  assert.equal(bash("kit_owner", env).stdout, "feature/x\n");
  delete process.env.KIT_MAIN_ROOT;
  // No settings file: the main worktree; then the settings file's mainRoot.
  assert.equal(kitMainRoot(), realpathSync(directory));
  assert.equal(bash("unset KIT_MAIN_ROOT; kit_main_root").stdout, `${kitMainRoot()}\n`);
  mkdirSync(join(directory, "scripts/agents"), { recursive: true });
  writeFileSync(join(directory, "scripts/agents/kit.json"), JSON.stringify({ project: "x", mainRoot: "/settings/main", branches: { land: "main" } }));
  assert.equal(kitMainRoot(), "/settings/main");
  assert.equal(bash("unset KIT_MAIN_ROOT; kit_main_root").stdout, "/settings/main\n");
  process.env.KIT_MAIN_ROOT = "/persistent/main";
  assert.equal(kitMainRoot(), "/persistent/main");
  assert.equal(bash("kit_main_root", { KIT_MAIN_ROOT: "/persistent/main" }).stdout, "/persistent/main\n");
  delete process.env.KIT_ROOT;
  assert.equal(bash("unset KIT_ROOT; kit_root", {}, directory).stdout, `${directory}\n`);
  const outside = temp(t);
  assert.equal(bash("unset KIT_ROOT; kit_root", {}, outside).stdout, `${resolve(".")}\n`);
  const cwd = process.cwd();
  try {
    process.chdir(directory);
    assert.equal(kitRoot(), directory);
    process.chdir(outside);
    assert.equal(kitRoot(), cwd);
  } finally { process.chdir(cwd); }
  process.env.KIT_ROOT = outside;
  assert.equal(kitOwner(), "unknown");
  assert.equal(bash("kit_owner", { ...env, KIT_ROOT: outside }).stdout, "unknown\n");
});

test("bash and mjs RESULT helpers collapse line breaks and reject bad statuses", (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  for (const status of ["ok", "fail"]) {
    kitResult(status, "one\ntwo\rthree");
    const result = bash(`kit_result ${status} $'one\\ntwo\\rthree'`);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${lines.at(-1)}\n`);
  }
  assert.equal(bash('kit_result ok one two').stdout, "RESULT: ok one two\n");
  assert.equal(bash("IFS=,; kit_result ok one two").stdout, "RESULT: ok one two\n");
  assert.equal(bash("kit_result fail").stdout, "RESULT: fail \n");
  kitResult("fail");
  assert.equal(lines.at(-1), "RESULT: fail ");
  kitResult("bad\nstatus", "ignored");
  const bad = bash("kit_result $'bad\\nstatus' ignored");
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, "RESULT: fail kit_result: bad status bad status\n");
  assert.equal(bad.stdout, `${lines.at(-1)}\n`);
  assert.equal(process.exitCode, 2);
});

test("the real kit exposes an executable version stub and emits its final RESULT", () => {
  assert.equal(statSync(kit).mode & 0o111, 0o111);
  assert.equal(statSync(resolve("scripts/agents/kit.d/version")).mode & 0o111, 0o111);
  assert.equal(statSync(library).mode & 0o111, 0);
  const list = run();
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /  version +show the kit's commit, owner and Node version/);
  const help = run(["version", "--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: kit version\n/);
  assert.deepEqual(results(help.stdout), []);
  const version = run(["version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /^commit [a-f0-9]+\nowner .+\nnode v\d+\.\d+\.\d+\nRESULT: ok version [a-f0-9]+ node v\d+\.\d+\.\d+\n$/);
  assert.equal(results(version.stdout).length, 1);
});
