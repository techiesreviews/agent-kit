import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const update = resolve("scripts/agents/kit.d/update");

function temp(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "kit-update-"));
  // Machine copies are read-only.
  t.after(() => { spawnSync("chmod", ["-R", "u+w", directory]); rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

// A local bare kit repo whose main holds a copy of this kit; HOME and the XDG folders are temporary,
// so nothing reaches the real ~/.local or ~/.cache.
function kitRepo(t: { after: (fn: () => void) => void }) {
  const directory = temp(t);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", KIT_REPO: `file://${join(directory, "kit.git")}` };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_HOME", "KIT_HOME_DEFAULT", "KIT_COMMANDS_DIR"]) delete env[name];
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
  const data = join(directory, "data/agent-kit");
  const run = (args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(update, args, { env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
  const link = (name: string) => readlinkSync(join(data, name));
  return { directory, env, data, git, publish, run, link };
}

const short = (sha: string) => sha.slice(0, 7);

test("kit update unpacks main into a read-only folder named by its commit and swaps current", (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  const first = k.run();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(first.stdout, `unpacked ${short(one)} into ${k.data}/${one}\ncurrent ${short(one)} (was none)\nRESULT: ok update ${short(one)} (was none)\n`);
  assert.equal(k.link("current"), one);
  assert.equal(readFileSync(join(k.data, one, "marker"), "utf8"), "one");
  assert.equal(statSync(join(k.data, one, "kit")).mode & 0o222, 0);
  assert.equal(statSync(join(k.data, one, "kit")).mode & 0o111, 0o111);
  assert.match(readFileSync(join(k.data, "updated"), "utf8"), /^\d+\n$/);
  // The fetch is shallow and the link swap leaves no temporary names behind.
  assert.equal(k.git(join(k.data, "repo.git"), "rev-parse", "--is-shallow-repository"), "true");
  const again = k.run();
  assert.equal(again.stdout, `RESULT: ok update already on ${short(one)}\n`);
  const two = k.publish("two");
  const second = k.run();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.ok(second.stdout.endsWith(`RESULT: ok update ${short(two)} (was ${short(one)})\n`), second.stdout);
  assert.equal(k.link("current"), two);
  assert.equal(k.link("previous"), one);
  assert.deepEqual(readdirSync(k.data).sort(), [".lock", one, two, "current", "previous", "repo.git", "updated"].sort());
});

test("kit update --previous goes back one, and kit update stays there until main moves on", (t) => {
  const k = kitRepo(t);
  const none = k.run(["--previous"]);
  assert.equal(none.status, 1);
  assert.equal(none.stdout, "RESULT: fail update no previous kit to go back to\n");
  const one = k.publish("one");
  k.run();
  const two = k.publish("two");
  k.run();
  const back = k.run(["--previous"]);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(back.stdout, `current ${short(one)} (was ${short(two)})\nRESULT: ok update --previous ${short(one)} (was ${short(two)})\n`);
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  const held = k.run();
  assert.equal(held.status, 0, held.stdout + held.stderr);
  assert.equal(held.stdout, `RESULT: ok update held on ${short(one)}: main is still ${short(two)}, which kit update --previous stepped back from\n`);
  assert.equal(k.link("current"), one);
  // A revert in the kit repo is a new commit: kit update takes it.
  const three = k.publish("three");
  const forward = k.run();
  assert.ok(forward.stdout.endsWith(`RESULT: ok update ${short(three)} (was ${short(one)})\n`), forward.stdout);
  assert.equal(k.link("current"), three);
  assert.equal(existsSync(join(k.data, "held")), false);
});

test("kit update removes folders retired over a day ago, never the current or previous kit", (t) => {
  const k = kitRepo(t);
  const shas = ["one", "two", "three"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; });
  const old = new Date(Date.now() - 2 * 86400_000);
  for (const sha of shas) utimesSync(join(k.data, sha), old, old);
  mkdirSync(join(k.data, ".unpack.stale"));
  utimesSync(join(k.data, ".unpack.stale"), old, old);
  const result = k.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(join(k.data, shas[0])), false);
  assert.equal(existsSync(join(k.data, ".unpack.stale")), false);
  assert.ok(existsSync(join(k.data, shas[1], "kit")));
  assert.ok(existsSync(join(k.data, shas[2], "kit")));
});

test("a kit stepped back from by --previous gets a day before it goes, like any retired kit", (t) => {
  const k = kitRepo(t);
  const [one, two] = ["one", "two"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; });
  const old = new Date(Date.now() - 2 * 86400_000);
  for (const sha of [one, two]) utimesSync(join(k.data, sha), old, old);
  assert.equal(k.run(["--previous"]).status, 0);
  const three = k.publish("three");
  const forward = k.run();
  assert.equal(forward.status, 0, forward.stdout + forward.stderr);
  assert.equal(k.link("current"), three);
  assert.equal(k.link("previous"), one);
  // Two was current minutes ago: a long command may still run on it.
  assert.ok(existsSync(join(k.data, two, "kit")));
});

test("overlapping kit updates take turns: one new folder and consistent links", async (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  const start = () => new Promise<{ status: number | null; stdout: string }>((done) => {
    const child = spawn(update, [], { env: k.env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk; });
    child.on("close", (status) => done({ status, stdout }));
  });
  const results = await Promise.all([start(), start()]);
  assert.deepEqual(results.map((result) => result.status), [0, 0], results.map((result) => result.stdout).join(""));
  const last = results.map((result) => result.stdout.trimEnd().split("\n").at(-1)).sort();
  assert.deepEqual(last, [`RESULT: ok update ${short(one)} (was none)`, `RESULT: ok update already on ${short(one)}`].sort());
  assert.deepEqual(readdirSync(k.data).filter((name) => /^[0-9a-f]{40}$|^\.unpack\.|^\.(current|previous)\./.test(name)), [one]);
  assert.equal(k.link("current"), one);
  assert.equal(existsSync(join(k.data, "previous")), false);
});

test("a failed update leaves the update time alone, so a stale copy keeps warning", (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  k.run();
  const old = `${Math.floor(Date.now() / 1000) - 2 * 86400}\n`;
  writeFileSync(join(k.data, "updated"), old);
  const empty = join(k.directory, "empty");
  mkdirSync(empty);
  k.git(empty, "init", "-q", "--initial-branch=main");
  writeFileSync(join(empty, "README.md"), "not a kit\n");
  k.git(empty, "add", "-A");
  k.git(empty, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  for (const repo of [`file://${empty}`, `file://${join(k.directory, "nowhere.git")}`]) {
    assert.equal(k.run([], { KIT_REPO: repo }).status, 1);
    assert.equal(readFileSync(join(k.data, "updated"), "utf8"), old);
  }
  assert.equal(k.link("current"), one);
  const version = spawnSync(join(k.data, one, "kit.d/version"), [], { env: { ...k.env, KIT_HOME: join(k.data, one) }, encoding: "utf8" });
  assert.match(version.stdout, /^warning kit not updated for 2 days; run scripts\/agents\/kit update$/m);
});

test("kit update fills a removed or broken current folder again, even when main has not moved", (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  k.run();
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one), { recursive: true, force: true });
  const removed = k.run();
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(removed.stdout, `unpacked ${short(one)} into ${k.data}/${one}\nRESULT: ok update refilled ${short(one)}\n`);
  assert.equal(statSync(join(k.data, one, "kit")).mode & 0o111, 0o111);
  assert.equal(k.link("current"), one);
  assert.equal(existsSync(join(k.data, "previous")), false);
  // A folder that lost its front door counts as broken too.
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one, "kit"));
  assert.equal(k.run().stdout.trimEnd().split("\n").at(-1), `RESULT: ok update refilled ${short(one)}`);
  assert.ok(existsSync(join(k.data, one, "kit")));
});

test("kit update says when flock is missing and still updates", (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  // Every command on PATH except flock.
  const bin = join(k.directory, "bin");
  mkdirSync(bin);
  const linked = new Set<string>();
  for (const directory of (k.env.PATH ?? "").split(":")) {
    if (!directory || !existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      // The first folder on PATH wins, as in a shell.
      if (name !== "flock" && !linked.has(name)) { linked.add(name); symlinkSync(join(directory, name), join(bin, name)); }
    }
  }
  const result = k.run([], { PATH: bin });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /^kit update: no flock; updates are not serialised$/m);
  assert.equal(k.link("current"), one);
});

test("kit update --previous with only a previous kit goes back without holding an empty commit", (t) => {
  const k = kitRepo(t);
  const [one, two] = ["one", "two"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; });
  rmSync(join(k.data, "current"));
  const back = k.run(["--previous"]);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(back.stdout, `current ${short(one)} (was none)\nRESULT: ok update --previous ${short(one)} (was none)\n`);
  assert.equal(k.link("current"), one);
  assert.equal(existsSync(join(k.data, "held")), false);
  // Nothing is held, so the next update moves straight to main.
  assert.ok(k.run().stdout.endsWith(`RESULT: ok update ${short(two)} (was ${short(one)})\n`));
});

test("kit version dates only the current machine copy; an older folder says it is not current", (t) => {
  const k = kitRepo(t);
  const [one, two] = ["one", "two"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; });
  const version = (sha: string) => spawnSync(join(k.data, sha, "kit.d/version"), [], { env: { ...k.env, KIT_HOME: join(k.data, sha) }, encoding: "utf8" }).stdout;
  assert.match(version(two), new RegExp(`^commit ${short(two)}\nkit machine copy, updated 0 minutes ago\n`));
  assert.match(version(one), new RegExp(`^commit ${short(one)}\nkit machine copy, not current \\(current is ${short(two)}\\)\n`));
  assert.doesNotMatch(version(one), /^warning /m);
});

test("kit update fails plainly on an unreachable repo, a main without a kit, and an unknown argument", (t) => {
  const k = kitRepo(t);
  const missing = k.run([], { KIT_REPO: `file://${join(k.directory, "nowhere.git")}` });
  assert.equal(missing.status, 1);
  assert.ok(missing.stdout.endsWith(`RESULT: fail update cannot fetch main from file://${join(k.directory, "nowhere.git")}\n`), missing.stdout);
  assert.equal(existsSync(join(k.data, "current")), false);
  const empty = join(k.directory, "empty");
  mkdirSync(empty);
  k.git(empty, "init", "-q", "--initial-branch=main");
  writeFileSync(join(empty, "README.md"), "not a kit\n");
  k.git(empty, "add", "-A");
  k.git(empty, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x");
  const notKit = k.run([], { KIT_REPO: `file://${empty}` });
  assert.equal(notKit.status, 1);
  assert.match(notKit.stdout, /^RESULT: fail update main [0-9a-f]{7} has no kit front door and kit-lib\.sh at its top\n$/);
  assert.deepEqual(readdirSync(k.data).filter((name) => /^[0-9a-f]{40}$|^\.unpack\./.test(name)), []);
  const unknown = k.run(["--sideways"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^Usage: kit update \[--previous\]\n/);
  assert.equal(unknown.stdout, "RESULT: fail update unknown argument --sideways\n");
  const help = k.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: kit update \[--previous\]\n/);
});
