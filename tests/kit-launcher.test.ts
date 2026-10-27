import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const launchers = resolve("scripts/agents/launcher");
const warning = "Agent Kit not found: guards are off; run `scripts/agents/kit doctor`";

function temp(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "kit-launcher-"));
  // Machine copies are read-only.
  t.after(() => { spawnSync("chmod", ["-R", "u+w", directory]); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

// A local bare kit repo holding a copy of this kit, and a project with only the two launchers, its settings
// and one own command; HOME and the XDG folders are temporary, so nothing reaches the real ~/.local or ~/.cache.
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = temp(t);
  const cache = join(directory, "cache"), data = join(directory, "data/agent-kit");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: cache,
    XDG_STATE_HOME: join(directory, "state"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    KIT_REPO: `file://${join(directory, "kit.git")}`, CLAUDE_PROJECT_DIR: "" };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_HOME", "KIT_HOME_DEFAULT", "KIT_COMMANDS_DIR", "NODE_TEST_CONTEXT"]) delete env[name];
  const git = (root: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const work = join(directory, "kit-work");
  cpSync(resolve("scripts/agents"), work, { recursive: true, filter: (source) => source !== resolve("scripts/agents/project.d") });
  git(directory, "init", "-q", "--bare", "--initial-branch=main", "kit.git");
  git(work, "init", "-q", "--initial-branch=main");
  git(work, "remote", "add", "origin", join(directory, "kit.git"));
  const publish = (marker: string) => {
    writeFileSync(join(work, "marker"), marker);
    git(work, "add", "-A");
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", marker);
    git(work, "push", "-q", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  };
  const project = join(directory, "project"), agents = join(project, "scripts/agents");
  mkdirSync(join(agents, "hooks"), { recursive: true });
  mkdirSync(join(project, "own"));
  copyFileSync(join(launchers, "kit"), join(agents, "kit"));
  copyFileSync(join(launchers, "hooks-run.sh"), join(agents, "hooks/run.sh"));
  chmodSync(join(agents, "kit"), 0o755);
  writeFileSync(join(agents, "kit.json"), JSON.stringify({ project: "p", branches: { land: "main" }, commands: "own" }));
  // where prints the kit in use; with WAIT_FILE it prints once, waits for the file, then prints again.
  writeFileSync(join(project, "own/where"), '#!/usr/bin/env bash\n# kit: print the kit in use\n' +
    'printf "%s %s\\n" "$KIT_HOME" "$(cat "$KIT_HOME/marker")"\n' +
    'if [[ -n ${WAIT_FILE:-} ]]; then while [[ ! -e $WAIT_FILE ]]; do sleep 0.05; done; printf "%s %s\\n" "$KIT_HOME" "$(cat "$KIT_HOME/marker")"; fi\n');
  chmodSync(join(project, "own/where"), 0o755);
  // pinned prints the kit marker the launcher hands to every child.
  writeFileSync(join(project, "own/pinned"), '#!/usr/bin/env bash\n# kit: print the pinned kit\nprintf "%s\\n" "${KIT_HOME_PINNED-unset}"\n');
  chmodSync(join(project, "own/pinned"), 0o755);
  git(project, "init", "-q", "--initial-branch=main");
  git(project, "add", "-A");
  git(project, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "project");
  const kit = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(join(agents, "kit"), args, { cwd: project, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
  const hook = (name: string, payload: object, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync("/bin/bash", [join(agents, "hooks/run.sh"), name], { cwd: project, env: { ...env, ...extra }, input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000 });
  return { directory, env, cache, data, project, agents, git, publish, kit, hook };
}

const lines = (result: { stdout: string }) => result.stdout.split("\n").filter((line) => line && !line.startsWith("RESULT: "));
const stashPop = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git stash pop" } };

test("with no machine copy the launcher clones the newest kit once, shallow, into the cache and none inside the project", (t) => {
  const f = fixture(t);
  const one = f.publish("one");
  const first = f.kit(["where"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(lines(first), [`${join(f.cache, "agent-kit")} one`]);
  assert.deepEqual(readdirSync(f.cache), ["agent-kit"]);
  assert.equal(f.git(join(f.cache, "agent-kit"), "rev-parse", "--is-shallow-repository"), "true");
  assert.equal(f.git(join(f.cache, "agent-kit"), "rev-parse", "HEAD"), one);
  assert.equal(f.git(f.project, "status", "--porcelain", "--ignored"), "");
  // The clone is reused: an unreachable repo no longer matters.
  const again = f.kit(["where"], { KIT_REPO: `file://${join(f.directory, "nowhere.git")}` });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(lines(again), [`${join(f.cache, "agent-kit")} one`]);
  assert.deepEqual(readdirSync(f.cache), ["agent-kit"]);
  const version = f.kit(["version"]);
  assert.match(version.stdout, new RegExp(`^commit ${one.slice(0, 7)}\nkit cache clone ${join(f.cache, "agent-kit")}, cloned 0 minutes ago\nproject [0-9a-f]{7,}\nowner `));
});

test("a cache clone over a day old is kept (one kit per command) but warns until kit update fills the machine copy", (t) => {
  const f = fixture(t);
  const one = f.publish("one");
  f.kit(["where"]);
  const stamp = join(f.cache, "agent-kit/.git/kit-cloned");
  writeFileSync(stamp, `${Math.floor(Date.now() / 1000) - 2 * 86400 - 60}\n`);
  const two = f.publish("two");
  assert.deepEqual(lines(f.kit(["where"])), [`${join(f.cache, "agent-kit")} one`]);
  const stale = f.kit(["version"]);
  assert.equal(stale.status, 0, stale.stdout + stale.stderr);
  assert.match(stale.stdout, new RegExp(`^commit ${one.slice(0, 7)}\nkit cache clone ${join(f.cache, "agent-kit")}, cloned 2 days ago\nproject [0-9a-f]{7,}\n` +
    "warning kit not updated for 2 days; run scripts/agents/kit update\nowner "));
  // The fix the warning names: the machine copy takes over and the warning goes.
  assert.equal(f.kit(["update"]).status, 0);
  assert.deepEqual(lines(f.kit(["where"])), [`${join(f.data, two)} two`]);
  assert.doesNotMatch(f.kit(["version"]).stdout, /^warning /m);
});

test("the launcher fails with a RESULT line when there is no kit and none can be cloned", (t) => {
  const f = fixture(t);
  const result = f.kit(["where"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, `RESULT: fail no Agent Kit at ${join(f.cache, "agent-kit")} (no machine copy; cannot clone ${f.env.KIT_REPO})\n`);
  const chosen = f.kit(["where"], { KIT_HOME: join(f.directory, "nowhere") });
  assert.equal(chosen.status, 2);
  assert.equal(chosen.stdout, `RESULT: fail no Agent Kit at ${join(f.directory, "nowhere")} (KIT_HOME)\n`);
  assert.deepEqual(readdirSync(f.cache), []);
});

test("kit update through the launcher fills the machine copy; a command started before an update finishes on its old folder", async (t) => {
  const f = fixture(t);
  const one = f.publish("one");
  const filled = f.kit(["update"]);
  assert.equal(filled.status, 0, filled.stdout + filled.stderr);
  assert.equal(readlinkSync(join(f.data, "current")), one);
  assert.deepEqual(lines(f.kit(["where"])), [`${join(f.data, one)} one`]);
  const version = f.kit(["version"]);
  assert.match(version.stdout, new RegExp(`^commit ${one.slice(0, 7)}\nkit machine copy, updated 0 minutes ago\nproject `));
  const go = join(f.directory, "go");
  const running = spawn(join(f.agents, "kit"), ["where"], { cwd: f.project, env: { ...f.env, WAIT_FILE: go } });
  let output = "";
  const finished = new Promise<number | null>((done) => running.on("close", done));
  await new Promise<void>((started) => running.stdout.on("data", (chunk: Buffer) => { output += chunk; if (output.includes("\n")) started(); }));
  const two = f.publish("two");
  const swapped = f.kit(["update"]);
  assert.equal(swapped.status, 0, swapped.stdout + swapped.stderr);
  assert.equal(readlinkSync(join(f.data, "current")), two);
  writeFileSync(go, "");
  assert.equal(await finished, 0, output);
  assert.deepEqual(lines({ stdout: output }), [`${join(f.data, one)} one`, `${join(f.data, one)} one`]);
  assert.deepEqual(lines(f.kit(["where"])), [`${join(f.data, two)} two`]);
});

test("a KIT_HOME a person set wins over the machine copy; one a front door filled in does not", (t) => {
  const f = fixture(t);
  const one = f.publish("one");
  f.kit(["update"]);
  const branch = join(f.directory, "agent-kit-branch");
  cpSync(resolve("scripts/agents"), branch, { recursive: true, filter: (source) => source !== resolve("scripts/agents/project.d") });
  writeFileSync(join(branch, "marker"), "branch");
  assert.deepEqual(lines(f.kit(["where"], { KIT_HOME: branch })), [`${branch} branch`]);
  assert.deepEqual(lines(f.kit(["where"], { KIT_HOME: branch, KIT_HOME_DEFAULT: branch })), [`${join(f.data, one)} one`]);
});

test("two launchers at once with no cache clone leave one clone and no temporary folders", async (t) => {
  const f = fixture(t);
  f.publish("one");
  const start = () => new Promise<{ status: number | null; stdout: string }>((done) => {
    const child = spawn(join(f.agents, "kit"), ["where"], { cwd: f.project, env: f.env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.on("close", (status) => done({ status, stdout }));
  });
  const results = await Promise.all([start(), start()]);
  assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stdout).join(""));
  for (const result of results) assert.deepEqual(lines(result), [`${join(f.cache, "agent-kit")} one`]);
  assert.deepEqual(readdirSync(f.cache), ["agent-kit"]);
});

test("an interrupted clone leaves no temporary folder, and a cache folder without a kit is named", async (t) => {
  const f = fixture(t);
  f.publish("one");
  // A git whose clone hangs until the launcher is stopped.
  const bin = join(f.directory, "bin"), started = join(f.directory, "clone-started");
  mkdirSync(bin);
  const real = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/bash\nif [[ $1 == clone ]]; then touch ${JSON.stringify(started)}; exec sleep 30; fi\nexec ${JSON.stringify(real)} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const child = spawn(join(f.agents, "kit"), ["where"], { cwd: f.project, env: { ...f.env, PATH: `${bin}:${f.env.PATH}` }, detached: true });
  const closed = new Promise<void>((done) => child.on("close", () => done()));
  while (!existsSync(started)) await new Promise((wait) => setTimeout(wait, 20));
  assert.equal(readdirSync(f.cache).filter((name) => name.startsWith("agent-kit.")).length, 1);
  process.kill(-child.pid!, "SIGTERM");
  await closed;
  assert.deepEqual(readdirSync(f.cache), []);
  mkdirSync(join(f.cache, "agent-kit"));
  writeFileSync(join(f.cache, "agent-kit/notes"), "mine\n");
  const blocked = f.kit(["where"]);
  assert.equal(blocked.status, 2);
  assert.equal(blocked.stdout, `RESULT: fail no Agent Kit at ${join(f.cache, "agent-kit")} (${join(f.cache, "agent-kit")} exists but holds no kit; remove it)\n`);
  assert.deepEqual(readdirSync(f.cache), ["agent-kit"]);
});

test("the hook launcher falls back to the cache clone, or warns, when current points at a removed folder", (t) => {
  const f = fixture(t);
  const one = f.publish("one");
  assert.equal(f.kit(["update"]).status, 0);
  rmSync(join(f.cache, "agent-kit"), { recursive: true, force: true });
  spawnSync("chmod", ["-R", "u+w", join(f.data, one)]);
  rmSync(join(f.data, one), { recursive: true, force: true });
  assert.equal(readlinkSync(join(f.data, "current")), one);
  const warned = f.hook("bash-guard", stashPop);
  assert.deepEqual([warned.status, warned.stdout], [0, `{"systemMessage":"${warning}"}\n`]);
  // The kit launcher, finding no machine copy, clones into the cache; the hooks then use that clone.
  assert.deepEqual(lines(f.kit(["where"])), [`${join(f.cache, "agent-kit")} one`]);
  const cached = f.hook("bash-guard", stashPop);
  assert.equal(cached.status, 2, cached.stdout + cached.stderr);
  assert.equal(cached.stderr, "commit work in progress on your own branch\n");
});

test("the hook launcher runs the kit's guards, and without a kit warns on every hook and never blocks", (t) => {
  const f = fixture(t);
  for (const name of ["bash-guard", "agent-cap"]) {
    const result = f.hook(name, stashPop);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `{"systemMessage":"${warning}"}\n`);
    assert.equal(JSON.parse(result.stdout).systemMessage, warning);
    assert.equal(result.stderr, "");
  }
  const session = f.hook("session-env", { hook_event_name: "SessionStart" });
  assert.equal(session.status, 0);
  assert.equal(session.stdout, `${warning}\n`);
  assert.equal(f.hook("context-card", { hook_event_name: "SessionStart" }).stdout, "");
  // The cache clone the kit launcher made is enough; the hook itself never clones.
  f.publish("one");
  assert.equal(existsSync(f.cache), false);
  assert.equal(f.hook("bash-guard", stashPop).status, 0);
  assert.equal(existsSync(join(f.cache, "agent-kit")), false);
  f.kit(["where"]);
  const cached = f.hook("bash-guard", stashPop);
  assert.equal(cached.status, 2, cached.stdout + cached.stderr);
  assert.equal(cached.stderr, "commit work in progress on your own branch\n");
  // With a machine copy it runs that kit's hooks/run.sh, never the front door (no RESULT line in session context).
  f.kit(["update"]);
  rmSync(join(f.cache, "agent-kit"), { recursive: true, force: true });
  const guarded = f.hook("bash-guard", stashPop);
  assert.equal(guarded.status, 2, guarded.stdout + guarded.stderr);
  assert.equal(guarded.stdout, "");
  assert.equal(f.hook("bash-guard", { ...stashPop, tool_input: { command: "git status" } }).status, 0);
  assert.doesNotMatch(f.hook("session-env", { hook_event_name: "SessionStart" }).stdout, /RESULT:|Agent Kit not found/);
  // A person's KIT_HOME (a kit branch) reaches the hooks too, over the machine copy; one a front door filled in does not.
  const branch = join(f.directory, "agent-kit-branch");
  cpSync(resolve("scripts/agents"), branch, { recursive: true, filter: (source) => source !== resolve("scripts/agents/project.d") });
  writeFileSync(join(branch, "hooks/bash-guard.sh"), 'printf "branch guard\\n" >&2; exit 2\n');
  const tried = f.hook("bash-guard", { ...stashPop, tool_input: { command: "git status" } }, { KIT_HOME: branch });
  assert.deepEqual([tried.status, tried.stderr], [2, "branch guard\n"]);
  const filled = f.hook("bash-guard", { ...stashPop, tool_input: { command: "git status" } }, { KIT_HOME: branch, KIT_HOME_DEFAULT: branch });
  assert.deepEqual([filled.status, filled.stderr], [0, ""]);
  // A person's KIT_HOME that is not a kit warns rather than falling back quietly.
  const wrong = f.hook("bash-guard", stashPop, { KIT_HOME: join(f.directory, "nowhere") });
  assert.deepEqual([wrong.status, wrong.stdout], [0, `{"systemMessage":"${warning}"}\n`]);
});

test("a child of a launcher whose kit folder was retired and removed falls back to current; a person's missing KIT_HOME still fails", (t) => {
  const f = fixture(t);
  const one = f.publish("one");
  assert.equal(f.kit(["update"]).status, 0);
  // What a builder session or kit bg job inherits from a launcher: KIT_HOME and its marker.
  assert.deepEqual(lines(f.kit(["pinned"])), [join(f.data, one)]);
  const two = f.publish("two");
  assert.equal(f.kit(["update"]).status, 0);
  spawnSync("chmod", ["-R", "u+w", join(f.data, one)]);
  rmSync(join(f.data, one), { recursive: true, force: true });
  const inherited = { KIT_HOME: join(f.data, one), KIT_HOME_PINNED: join(f.data, one) };
  const guarded = f.hook("bash-guard", stashPop, inherited);
  assert.deepEqual([guarded.status, guarded.stdout, guarded.stderr], [2, "", "commit work in progress on your own branch\n"]);
  assert.deepEqual(lines(f.kit(["where"], inherited)), [`${join(f.data, two)} two`]);
  assert.deepEqual(lines(f.kit(["pinned"], inherited)), [join(f.data, two)]);
  // A pinned folder that still holds a kit is kept (one kit per command, children included).
  const kept = f.kit(["where"], { KIT_HOME: join(f.data, two), KIT_HOME_PINNED: join(f.data, two) });
  assert.deepEqual(lines(kept), [`${join(f.data, two)} two`]);
  const chosen = { KIT_HOME: join(f.data, one) };
  const warned = f.hook("bash-guard", stashPop, chosen);
  assert.deepEqual([warned.status, warned.stdout], [0, `{"systemMessage":"${warning}"}\n`]);
  const failed = f.kit(["where"], chosen);
  assert.equal(failed.status, 2);
  assert.equal(failed.stdout, `RESULT: fail no Agent Kit at ${join(f.data, one)} (KIT_HOME)\n`);
});

test("a cache folder with kit but no kit-lib.sh is rejected by both launchers, not used", (t) => {
  const f = fixture(t);
  const half = join(f.cache, "agent-kit");
  mkdirSync(join(half, "hooks"), { recursive: true });
  writeFileSync(join(half, "kit"), "#!/bin/bash\necho used\n");
  chmodSync(join(half, "kit"), 0o755);
  writeFileSync(join(half, "hooks/run.sh"), "echo used; exit 2\n");
  const result = f.kit(["where"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, `RESULT: fail no Agent Kit at ${half} (${half} exists but holds no kit; remove it)\n`);
  const hooked = f.hook("bash-guard", stashPop);
  assert.deepEqual([hooked.status, hooked.stdout], [0, `{"systemMessage":"${warning}"}\n`]);
  assert.deepEqual(readdirSync(f.cache), ["agent-kit"]);
});
