import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
// @ts-expect-error The script is plain JavaScript without declarations.
import { findNode, kitGhEnv, kitGhRepo, kitMainRoot, kitOwner, kitResult, kitRoot, nodeEnv } from "../kit-lib.mjs";
import { kitEnv } from "./support/kit-env.ts";
import { kitFiles } from "./support/kit-files.ts";

const kit = resolve("kit");
const library = resolve("kit-lib.sh");
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
  return spawnSync("/bin/bash", ["kit", ...args], {
    encoding: "utf8", env: { ...kitEnv(), ...env }, input, timeout: 5000,
  });
}

function bash(body: string, env: NodeJS.ProcessEnv = {}, cwd?: string) {
  return spawnSync("/bin/bash", ["-c", `set -euo pipefail; source "$KIT_TEST_LIB"; ${body}`], {
    encoding: "utf8", env: { ...kitEnv(), ...env, KIT_TEST_LIB: library }, cwd, timeout: 5000,
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
  const help = run(["--help"], env);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /\nShared commands:\n/);
  assert.match(help.stdout, /\nProject commands:\n/);
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
  // A "commands" naming the shared folder adds no group and hides nothing.
  settings({ commands: resolve("kit.d") });
  const same = run([], env);
  assert.equal(same.status, 0, same.stderr);
  assert.doesNotMatch(same.stdout, /Project commands:|\(hidden by the shared/);
});

test("the shared kit runs from a copy named by KIT_HOME for a project with only settings, front door and own commands", (t) => {
  const home = join(temp(t), "kit"), root = temp(t);
  cpSync(resolve("."), home, { recursive: true, filter: kitFiles });
  const agents = join(root, "scripts/agents");
  mkdirSync(join(agents, "project.d"), { recursive: true });
  copyFileSync(kit, join(agents, "kit"));
  chmodSync(join(agents, "kit"), 0o755);
  writeFileSync(join(agents, "kit.json"), JSON.stringify({ project: "x", branches: { land: "dev" }, commands: "scripts/agents/project.d" }));
  command(join(agents, "project.d"), "where", '# kit: print the shared kit\nprintf "%s\\n" "$KIT_HOME" "$KIT_LIB"');
  const env: NodeJS.ProcessEnv = { ...kitEnv(), KIT_HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_COMMANDS_DIR", "NODE_TEST_CONTEXT"]) delete env[name];
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8" }).status, 0);
  git("init", "-q", "--initial-branch=dev");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git("update-ref", "refs/remotes/origin/dev", "HEAD");
  const front = (...args: string[]) => spawnSync(join(agents, "kit"), args, { cwd: root, env, encoding: "utf8", timeout: 15_000 });
  // The copy is outside git, so it has no commit of its own.
  const version = front("version");
  assert.equal(version.status, 0, version.stdout + version.stderr);
  assert.match(version.stdout, /^commit none\nkit copy outside git\nproject [0-9a-f]{7,}\nowner .+\nnode v\d+\.\d+\.\d+\nRESULT: ok version none node v\d+/);
  const status = front("status");
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /\nRESULT: ok status /);
  // kit card runs the copy's context-card.mjs for this project's notes.
  assert.ok(existsSync(join(home, "context-card.mjs")), "the copy has context-card.mjs");
  const memory = join(temp(t), "memory");
  mkdirSync(join(memory, "project-notes"), { recursive: true });
  writeFileSync(join(memory, "project-notes/README.md"), `| Slug | Workspace |\n| --- | --- |\n| x | \`${realpathSync(root)}\` |\n`);
  writeFileSync(join(memory, "project-notes/x.md"), "# X\n\n## Current thinking\nKit home thinking.\n");
  env.CHAT_MEMORY_DIR = memory;
  const card = front("card");
  assert.equal(card.status, 0, card.stdout + card.stderr);
  assert.equal(card.stdout, "Context card: X\nCurrent thinking:\nKit home thinking.\nMore: ask for the full note.\nRESULT: ok card 4 lines\n");
  // Every shared command loads from the copy: a helper reached by its place in this repo would fail here.
  const shared = readdirSync(join(home, "kit.d")).filter((name) => !/^[._]/.test(name) && statSync(join(home, "kit.d", name)).mode & 0o111);
  for (const name of ["unit", "review", "next"]) assert.ok(shared.includes(name), name);
  for (const name of shared) {
    const help = front(name, "--help");
    assert.equal(help.status, 0, `${name}: ${help.stdout}${help.stderr}`);
    assert.match(help.stdout, new RegExp(`^Usage: kit ${name}\\b`));
  }
  // A kit home in its own git checkout shows its own commit, not the project's.
  const at = (directory: string, ...args: string[]) => spawnSync("git", ["-C", directory, ...args], { env, encoding: "utf8" }).stdout.trim();
  at(home, "init", "-q");
  at(home, "add", "-A");
  at(home, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "kit");
  const homeSha = at(home, "rev-parse", "--short", "HEAD");
  assert.notEqual(homeSha, at(root, "rev-parse", "--short", "HEAD"));
  assert.match(front("version").stdout, new RegExp(`^commit ${homeSha}\n`));
  const where = front("where");
  assert.equal(where.status, 0, where.stderr);
  assert.equal(where.stdout, `${realpathSync(home)}\n${realpathSync(home)}/kit-lib.sh\nRESULT: ok where finished\n`);
  const wrong = spawnSync(join(agents, "kit"), ["version"], { cwd: root, env: { ...env, KIT_HOME: join(root, "nowhere") }, encoding: "utf8" });
  assert.equal(wrong.status, 2);
  assert.equal(wrong.stdout, `RESULT: fail no kit at KIT_HOME ${join(root, "nowhere")}\n`);
  assert.equal(wrong.stderr, `kit: KIT_HOME ${join(root, "nowhere")} is not a kit folder (no kit-lib.sh)\n`);
});

test("a nested kit in another checkout keeps its own kit unless a person set KIT_HOME; outside git the project is around the front door", (t) => {
  // Three checkouts outside git, each with the shared kit, settings and a project command that prints the kit in use
  // and, like a kit next --start job, runs another checkout's front door without KIT_ROOT.
  const checkout = () => {
    const root = realpathSync(temp(t)), agents = join(root, "scripts/agents");
    cpSync(resolve("."), agents, { recursive: true, filter: kitFiles });
    writeFileSync(join(agents, "kit.json"), JSON.stringify({ project: "x", branches: { land: "dev" }, commands: "own" }));
    mkdirSync(join(root, "own"));
    command(join(root, "own"), "where", '# kit: print the kit in use\nprintf "%s %s %s\\n" "$KIT_ROOT" "$KIT_HOME" "$KIT_LIB"\n' +
      'if [[ -n ${NEXT_KIT:-} ]]; then next=$NEXT_KIT; NEXT_KIT= env -u KIT_ROOT "$next" where; fi');
    return { root, agents };
  };
  const [a, b, chosen] = [checkout(), checkout(), checkout()];
  const env: NodeJS.ProcessEnv = { ...kitEnv(), NEXT_KIT: join(b.agents, "kit") };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_COMMANDS_DIR"]) delete env[name];
  const where = (extra: NodeJS.ProcessEnv = {}) => {
    const result = spawnSync(join(a.agents, "kit"), ["where"], { cwd: a.root, env: { ...env, ...extra }, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.split("\n").filter((line) => !line.startsWith("RESULT: ") && line);
  };
  const line = (root: string, agents: string) => `${root} ${agents} ${agents}/kit-lib.sh`;
  // The KIT_HOME a front door fills in stays with it: the nested checkout runs its own kit.d and library.
  assert.deepEqual(where(), [line(a.root, a.agents), line(b.root, b.agents)]);
  // A person's KIT_HOME reaches every nested kit, while each project stays the folder around its front door.
  assert.deepEqual(where({ KIT_HOME: chosen.agents }), [line(a.root, chosen.agents), line(b.root, chosen.agents)]);
});

test("kit_home and kitHome() skip a KIT_HOME a front door filled in, and keep one a person set", (t) => {
  const other = temp(t), own = dirname(library);
  const env: NodeJS.ProcessEnv = { ...kitEnv(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of ["KIT_ROOT", "KIT_LIB", "KIT_LIB_MJS"]) delete env[name];
  const sha = (directory: string) => spawnSync("git", ["-C", directory, "rev-parse", "--short", "HEAD"], { env, encoding: "utf8" }).stdout.trim();
  spawnSync("git", ["-C", other, "init", "-q"], { env });
  spawnSync("git", ["-C", other, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "other"], { env });
  assert.notEqual(sha(other), sha(own));
  // kit version run directly (no front door) reports the commit of the kit home kit_home picks.
  const version = (extra: NodeJS.ProcessEnv) => spawnSync(join(own, "kit.d/version"), [], { env: { ...env, ...extra }, encoding: "utf8" }).stdout;
  assert.match(version({ KIT_HOME: other, KIT_HOME_DEFAULT: other }), new RegExp(`^commit ${sha(own)}\n`));
  assert.match(version({ KIT_HOME: other }), new RegExp(`^commit ${sha(other)}\n`));
  const kitHome = (extra: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `const { kitHome } = await import(${JSON.stringify(pathToFileURL(join(own, "kit-lib.mjs")).href)}); console.log(kitHome());`],
  { env: { ...env, ...extra }, encoding: "utf8" }).stdout;
  assert.equal(kitHome({ KIT_HOME: other, KIT_HOME_DEFAULT: other }), `${own}\n`);
  assert.equal(kitHome({ KIT_HOME: other }), `${other}\n`);
  assert.equal(kitHome({}), `${own}\n`);
});

test("kit still lists shared commands with a broken settings file and names it on an unknown command", (t) => {
  const root = temp(t);
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), '{ "commands": ');
  const env = { KIT_ROOT: root, KIT_COMMANDS_DIR: undefined };
  const list = run([], env);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^Usage: kit <command> \[args\]\n\nShared commands:\n/);
  const doctorHelp = run(["doctor", "--help"], env);
  assert.equal(doctorHelp.status, 0, doctorHelp.stderr);
  const unknown = run(["specs"], env);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^kit: unknown command 'specs' \(scripts\/agents\/kit\.json unreadable; run kit doctor\)\n/);
  assert.equal(unknown.stdout, "RESULT: fail unknown command specs (scripts/agents/kit.json unreadable; run kit doctor)\n");
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
    env: { ...kitEnv(), KIT_COMMANDS_DIR: directory, KIT_ROOT: directory, KIT_MAIN_ROOT: "/persistent" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `hello\n${directory}\n/persistent\n${library}\n${resolve("kit-lib.mjs")}\nRESULT: ok inspect finished\n`);
});

const signals: [NodeJS.Signals, number][] = [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]];
for (const [signal, expectedStatus] of signals) for (const ownResult of [false, true]) test(`kit forwards ${signal}, child RESULT ${ownResult}`, async (t) => {
  const directory = temp(t);
  const ready = ownResult ? "ready\nRESULT: ok child done\n" : "ready\n";
  command(directory, "waiting", `trap 'kill "$sleeper" 2>/dev/null || :; wait "$sleeper" 2>/dev/null || :; exit 0' TERM INT HUP\nsleep 4 &\nsleeper=$!\nprintf '${ready}'\nwait "$sleeper"`);
  const child = spawn("/bin/bash", [kit, "waiting"], { env: { ...kitEnv(), KIT_COMMANDS_DIR: directory } });
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
  // Outside git and without KIT_ROOT, a kit on its own (this repo) is its own project.
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

test("bash and mjs read origin's GitHub repo alike, whatever other remotes there are, and nothing from a path", (t) => {
  const directory = temp(t);
  assert.equal(spawnSync("git", ["init", "-q", directory]).status, 0);
  const gitAt = (...args: string[]) => assert.equal(spawnSync("git", ["-C", directory, ...args]).status, 0);
  const both = () => {
    const shell = bash(`kit_gh_repo ${JSON.stringify(directory)}`);
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(shell.stdout, kitGhRepo(directory) ? `${kitGhRepo(directory)}\n` : "");
    return kitGhRepo(directory);
  };
  assert.equal(both(), "");
  gitAt("remote", "add", "upstream", "https://github.com/acme/starter.git");
  assert.equal(both(), "");
  gitAt("remote", "add", "origin", "x");
  for (const [url, repo] of [
    ["https://github.com/acme/site.git", "acme/site"], ["https://github.com/acme/site", "acme/site"],
    ["https://token@github.com/acme/site.git/", "acme/site"], ["git@github.com:acme/site.git", "acme/site"],
    ["github.com:acme/site", "acme/site"], ["ssh://git@ssh.github.com:443/acme/site.git", "acme/site"],
    ["ssh://git@git.example.com/acme/site.git", "git.example.com/acme/site"], ["git://github.com/acme/my.site.git", "acme/my.site"],
    ["https://GitHub.com/acme/site.git", "acme/site"], ["ssh://git@Git.Example.com/acme/site", "git.example.com/acme/site"],
    ["/srv/git/site.git", ""], ["file:///srv/git/site.git", ""], ["https://github.com/acme", ""], ["https://github.com/a/b/c.git", ""],
  ]) {
    gitAt("remote", "set-url", "origin", url);
    assert.equal(both(), repo, url);
  }
  // gh is told origin's repo, over any GH_REPO already set; without a GitHub origin env is left as it is.
  gitAt("remote", "set-url", "origin", "git@github.com:acme/site.git");
  assert.deepEqual(kitGhEnv({ GH_REPO: "acme/starter", A: "1" }, directory), { GH_REPO: "acme/site", A: "1" });
  gitAt("remote", "set-url", "origin", "/srv/git/site.git");
  assert.deepEqual(kitGhEnv({ GH_REPO: "acme/other" }, directory), { GH_REPO: "acme/other" });
  assert.deepEqual(kitGhEnv({}, directory), {});
});

test("outside git, a kit kept in a project's scripts/agents/ takes the project as its root in every library and the front door", (t) => {
  const project = realpathSync(temp(t)), agents = join(project, "scripts/agents"), commands = join(project, "commands");
  mkdirSync(agents, { recursive: true });
  mkdirSync(commands);
  for (const file of ["kit", "kit-lib.sh", "kit-lib.mjs", "review-findings.mjs"]) copyFileSync(file, join(agents, file));
  const env = { ...kitEnv(), KIT_ROOT: undefined };
  const shell = spawnSync("/bin/bash", ["-c", `source "${agents}/kit-lib.sh"; kit_root`], { cwd: agents, env, encoding: "utf8" });
  assert.equal(shell.stdout, `${project}\n`, shell.stderr);
  const module = spawnSync(process.execPath, ["--input-type=module", "-e",
    "const { kitRoot } = await import(process.argv[1]); console.log(kitRoot());", pathToFileURL(join(agents, "kit-lib.mjs")).href],
  { cwd: agents, env, encoding: "utf8" });
  assert.equal(module.stdout, `${project}\n`, module.stderr);
  command(commands, "where", 'echo "root=$KIT_ROOT"; echo "RESULT: ok where"');
  const frontDoor = spawnSync("/bin/bash", [join(agents, "kit"), "where"], { cwd: project, env: { ...env, KIT_COMMANDS_DIR: commands }, encoding: "utf8" });
  assert.equal(frontDoor.stdout, `root=${project}\nRESULT: ok where\n`, frontDoor.stderr);
  // The front door's folder decides, not the KIT_HOME library it sources.
  const chosen = spawnSync("/bin/bash", [join(agents, "kit"), "where"], { cwd: project, env: { ...env, KIT_COMMANDS_DIR: commands, KIT_HOME: resolve(".") }, encoding: "utf8" });
  assert.equal(chosen.stdout, `root=${project}\nRESULT: ok where\n`, chosen.stderr);
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
  assert.equal(statSync(resolve("kit.d/version")).mode & 0o111, 0o111);
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
  assert.match(version.stdout, /^commit [a-f0-9]+\nkit in this project, commit \d+ \w+ old\nproject [a-f0-9]+\nowner .+\nnode v\d+\.\d+\.\d+\nRESULT: ok version [a-f0-9]+ node v\d+\.\d+\.\d+\n$/);
  assert.equal(results(version.stdout).length, 1);
});

// Fixture lines that hand a front door the KIT_HOME and KIT_HOME_DEFAULT of the kit run that started the tests:
// a spread of process.env, or a spawn of a front door, kit.d or project.d command with no env option.
// kitEnv() drops both. Allowed: an env whose next lines delete both names (or every KIT_ name), and spreads
// that only reach git, Chromium or a generated child script, which inherits an env already cleaned.
const envAllowed: [string, RegExp][] = [
  ["tests/kit-commit.test.ts", /commitBuilderWork\(|const rootEnv = /],
  ["tests/kit-doctor.test.ts", /spawnSync\("git"/],
  ["tests/kit-specs.test.ts", /spawnSync\("git"|spawnSync\(process\.argv\[2\]/],
  ["tests/kit-sweep.test.ts", /GIT_AUTHOR_DATE/],
  ["tests/kit-shots.test.ts", /chromium\.launch\(/],
  ["tests/kit-shots-layout.test.ts", /chromium\.launch\(/],
  ["tests/kit-size.test.ts", /stdio: "inherit", env: \{ \.\.\.process\.env, ASE_TEST_PORT/],
  // The stand-in suites runScript starts under kitEnv(): their detached children only run sleep or a writer.
  ["tests/kit-tests-clean.test.ts", /env: \{ \.\.\.process\.env, TMPDIR: (require\(|join\(process\.argv\[1\])/],
];

function kitEnvLeaks(file: string, source: string) {
  const lines = source.split("\n"), found: string[] = [];
  const left = (text: string) => !envAllowed.some(([name, pattern]) => name === file && pattern.test(text));
  // Both names go in delete statements, by name or with every KIT_ name.
  const strips = (text: string) => {
    const deletes = text.split(";").filter(statement => /\bdelete\b/.test(statement));
    if (deletes.some(statement => /startsWith\("KIT_"\)|\/\^\(KIT_/.test(statement))) return true;
    return ["KIT_HOME", "KIT_HOME_DEFAULT"].every(name => deletes.some(statement => new RegExp(`"${name}"|\\.${name}\\b`).test(statement)));
  };
  // Split, so this line is not a spread itself.
  const spread = "..." + "process.env";
  lines.forEach((line, index) => {
    if (line.includes(spread) && left(line) && !strips(lines.slice(index, index + 4).join("\n"))) found.push(`${file}:${index + 1}`);
  });
  // Names bound to a front door or command path, such as const next = resolve("kit.d/next").
  const names = [...source.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*(?:resolve|join)\([^;\n]*(?:scripts\/agents\/kit"|kit\.d\/|project\.d\/)/g)].map(match => match[1]);
  // A name counts as code, not inside a string ("doctor" is an argument); the literal "kit" is a front door's file name.
  const command = new RegExp(`(^|[^\\w.$"'\`-])(${["kit", ...names].join("|")})([^\\w"'\`-]|$)|"kit"|kit\\.d\\/|project\\.d\\/`);
  // Only child_process's own functions: a file's local spawn helper sets its env itself.
  const imported = source.match(/import \{([^}]*)\} from "node:child_process"/)?.[1].split(",").map(name => name.trim()) ?? [];
  const spawners = imported.filter(name => ["spawnSync", "spawn", "execFileSync"].includes(name));
  for (const call of spawners.length ? source.matchAll(new RegExp(`\\b(?:${spawners.join("|")})\\(`, "g")) : []) {
    let depth = 0, end = call.index + call[0].length - 1;
    for (; end < source.length && end < call.index + 1000; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    // The head is the command and its arguments; the env option is a key of the options object after it.
    const text = source.slice(call.index, end + 1), head = text.split("{")[0];
    if (!command.test(head) || /\benv\s*[:,}]/.test(text.slice(head.length))) continue;
    const index = source.slice(0, call.index).split("\n").length - 1;
    if (left(lines[index])) found.push(`${file}:${index + 1}`);
  }
  return found;
}

test("kit test fixtures start without the kit's home names, so a person's KIT_HOME never reaches them", () => {
  const found = globSync("tests/kit*.test.ts").sort().flatMap(file => kitEnvLeaks(file, readFileSync(file, "utf8")));
  assert.deepEqual(found, [], "use kitEnv() for these fixtures");
});

test("the KIT_HOME guard finds commands under any name, a half-cleaned env and an env word that is not the option", () => {
  // Split, so these samples are not spreads or spawns in this file.
  const call = "spawn" + "Sync", spread = "..." + "process.env";
  const leaks = (source: string) => kitEnvLeaks("tests/kit-x.test.ts", `import { ${call} } from "node:child_process";\n${source}`);
  const next = 'const next = resolve("kit.d/next");\n';
  assert.deepEqual(leaks(`${next}${call}(process.execPath, [next, "--help"], { encoding: "utf8" });\n`), ["tests/kit-x.test.ts:3"]);
  assert.deepEqual(leaks(`${next}${call}(process.execPath, [next, "--help"], { env: kitEnv(), encoding: "utf8" });\n`), []);
  assert.deepEqual(leaks(`${next}${call}(process.execPath, [next], { cwd, env });\n`), []);
  assert.deepEqual(leaks(`${call}(kit, [], { input: process.env.X });\n`), ["tests/kit-x.test.ts:2"]);
  assert.deepEqual(leaks(`${call}(join(agents, "kit"), ["card"], { cwd: root });\n`), ["tests/kit-x.test.ts:2"]);
  // Not commands: a git call beside a kit folder name, and a subcommand that shares a command's name.
  assert.deepEqual(leaks(`const home = join(root, "kit");\n${call}("git", ["-C", home, "init"]);\n`), []);
  assert.deepEqual(leaks(`const doctor = resolve("kit.d/doctor");\n${call}("npm", ["doctor"]);\n`), []);
  assert.deepEqual(leaks(`const env = { ${spread} }; delete env.KIT_HOME_DEFAULT;\n`), ["tests/kit-x.test.ts:2"]);
  assert.deepEqual(leaks(`const env = { ${spread} };\nconst names = ["KIT_HOME_DEFAULT"]; delete env.OTHER;\n`), ["tests/kit-x.test.ts:2"]);
  assert.deepEqual(leaks(`const env = { ${spread} }; delete env.KIT_HOME; delete env.KIT_HOME_DEFAULT;\n`), []);
  assert.deepEqual(leaks(`const env = { ${spread} };\nfor (const name of ["KIT_ROOT", "KIT_HOME",\n  "KIT_HOME_DEFAULT"]) delete env[name];\n`), []);
  assert.deepEqual(leaks(`const env = { ${spread} };\nfor (const key of Object.keys(env)) if (key.startsWith("KIT_")) delete env[key];\n`), []);
});
