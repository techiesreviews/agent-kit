import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { kitFiles } from "./support/kit-files.ts";

const update = resolve("kit.d/update");

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
    XDG_CACHE_HOME: join(directory, "cache"), XDG_STATE_HOME: join(directory, "state"), XDG_CONFIG_HOME: join(directory, "config"),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", KIT_REPO: `file://${join(directory, "kit.git")}` };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_HOME", "KIT_HOME_DEFAULT", "KIT_COMMANDS_DIR"]) delete env[name];
  const git = (root: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const work = join(directory, "kit-work");
  cpSync(resolve("."), work, { recursive: true, filter: kitFiles });
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

// Publishes one and two, updates to each, then steps back to one.
function steppedBack(t: { after: (fn: () => void) => void }) {
  const k = kitRepo(t);
  const [one, two] = ["one", "two"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; });
  assert.equal(k.run(["--previous"]).status, 0);
  return { k, one, two };
}

// A PATH whose tar unpacks and then drops kit-lib.sh (the update calls tar -x -C <folder>).
function tarWithoutKitLib(k: { directory: string; env: NodeJS.ProcessEnv }) {
  const bin = join(k.directory, "tar-bin");
  mkdirSync(bin);
  const tar = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "tar"), `#!/bin/sh\n${tar} "$@" && rm -f -- "$3/kit-lib.sh"\n`, { mode: 0o755 });
  return `${bin}:${k.env.PATH}`;
}

test("kit update keeps a broken current folder when its fresh unpack is not a whole kit", (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  k.run();
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one, "kit-lib.sh"));
  const updated = readFileSync(join(k.data, "updated"), "utf8");
  const refill = k.run([], { PATH: tarWithoutKitLib(k) });
  assert.equal(refill.status, 1, refill.stdout + refill.stderr);
  assert.equal(refill.stdout, `RESULT: fail update main ${short(one)} has no kit front door and kit-lib.sh at its top\n`);
  assert.equal(readFileSync(join(k.data, one, "marker"), "utf8"), "one");
  assert.equal(k.link("current"), one);
  assert.equal(readFileSync(join(k.data, "updated"), "utf8"), updated);
  assert.deepEqual(readdirSync(k.data).filter((name) => name.startsWith(".unpack.")), []);
});

test("a second kit update --previous with the current folder gone changes nothing; kit update refills it", (t) => {
  const { k, one, two } = steppedBack(t);
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one), { recursive: true, force: true });
  const again = k.run(["--previous"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, `RESULT: ok update already back on ${short(one)}\n`);
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
  assert.equal(k.run().stdout.trimEnd().split("\n").at(-1), `RESULT: ok update refilled ${short(one)}`);
  assert.ok(existsSync(join(k.data, one, "kit-lib.sh")));
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
});

test("a held kit update fills a removed current folder again instead of going back to main", (t) => {
  const { k, one, two } = steppedBack(t);
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one), { recursive: true, force: true });
  const refill = k.run();
  assert.equal(refill.status, 0, refill.stdout + refill.stderr);
  assert.equal(refill.stdout, `unpacked ${short(one)} into ${k.data}/${one}\nRESULT: ok update refilled ${short(one)}\n`);
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
  assert.equal(readFileSync(join(k.data, one, "marker"), "utf8"), "one");
});

test("a held kit update whose kit is gone from repo.git fails and moves nothing", (t) => {
  const { k, one, two } = steppedBack(t);
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one), { recursive: true, force: true });
  // A fresh shallow fetch holds only main (two).
  rmSync(join(k.data, "repo.git"), { recursive: true, force: true });
  const updated = readFileSync(join(k.data, "updated"), "utf8");
  const refill = k.run();
  assert.equal(refill.status, 1, refill.stdout + refill.stderr);
  assert.equal(refill.stdout, `RESULT: fail update cannot refill held ${short(one)}\n`);
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
  assert.equal(readFileSync(join(k.data, "updated"), "utf8"), updated);
  assert.deepEqual(readdirSync(k.data).filter((name) => name.startsWith(".unpack.")), []);
});

test("a held kit update replaces a broken current folder with a whole read-only copy of the held kit", (t) => {
  const { k, one, two } = steppedBack(t);
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one, "kit-lib.sh"));
  const refill = k.run();
  assert.equal(refill.status, 0, refill.stdout + refill.stderr);
  assert.equal(refill.stdout, `unpacked ${short(one)} into ${k.data}/${one}\nRESULT: ok update refilled ${short(one)}\n`);
  assert.equal(statSync(join(k.data, one, "kit-lib.sh")).mode & 0o222, 0);
  assert.equal(k.link("current"), one);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
});

test("a held kit update that cannot unpack leaves the broken current folder and every link alone", (t) => {
  const { k, one, two } = steppedBack(t);
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one, "kit-lib.sh"));
  rmSync(join(k.data, "repo.git"), { recursive: true, force: true });
  const updated = readFileSync(join(k.data, "updated"), "utf8");
  const refill = k.run();
  assert.equal(refill.status, 1, refill.stdout + refill.stderr);
  assert.equal(refill.stdout, `RESULT: fail update cannot refill held ${short(one)}\n`);
  assert.equal(readFileSync(join(k.data, one, "marker"), "utf8"), "one");
  assert.ok(existsSync(join(k.data, one, "kit")));
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
  assert.equal(readFileSync(join(k.data, "updated"), "utf8"), updated);
  assert.deepEqual(readdirSync(k.data).filter((name) => name.startsWith(".unpack.")), []);
});

test("a held kit update whose unpack has no kit-lib.sh fails and leaves the broken folder and every link alone", (t) => {
  const { k, one, two } = steppedBack(t);
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one, "kit-lib.sh"));
  const updated = readFileSync(join(k.data, "updated"), "utf8");
  const refill = k.run([], { PATH: tarWithoutKitLib(k) });
  assert.equal(refill.status, 1, refill.stdout + refill.stderr);
  assert.equal(refill.stdout, `RESULT: fail update held ${short(one)} has no kit front door and kit-lib.sh at its top\n`);
  assert.equal(readFileSync(join(k.data, one, "marker"), "utf8"), "one");
  assert.equal(existsSync(join(k.data, one, "kit-lib.sh")), false);
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
  assert.equal(readFileSync(join(k.data, "updated"), "utf8"), updated);
  assert.deepEqual(readdirSync(k.data).filter((name) => name.startsWith(".unpack.")), []);
});

test("kit update --previous treats a previous link that names no folder as no previous kit", (t) => {
  const k = kitRepo(t);
  const two = ["one", "two"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; })[1];
  writeFileSync(join(k.data, "plain"), "not a kit\n");
  for (const target of ["0".repeat(40), "plain"]) {
    rmSync(join(k.data, "previous"));
    symlinkSync(target, join(k.data, "previous"));
    const back = k.run(["--previous"]);
    assert.equal(back.status, 1, back.stdout + back.stderr);
    assert.equal(back.stdout, "RESULT: fail update no previous kit to go back to\n");
    assert.equal(k.link("current"), two);
  }
});

test("kit update --previous refuses a previous folder that is not a whole kit", (t) => {
  const k = kitRepo(t);
  const [one, two] = ["one", "two"].map((marker) => { const sha = k.publish(marker); k.run(); return sha; });
  spawnSync("chmod", ["-R", "u+w", join(k.data, one)]);
  rmSync(join(k.data, one, "kit-lib.sh"));
  const back = k.run(["--previous"]);
  assert.equal(back.status, 1, back.stdout + back.stderr);
  assert.equal(back.stdout, `RESULT: fail update previous kit ${short(one)} is incomplete\n`);
  assert.equal(k.link("current"), two);
  assert.equal(k.link("previous"), one);
  assert.equal(existsSync(join(k.data, "held")), false);
});

test("a second kit update --previous stays on the old kit", (t) => {
  const { k, one, two } = steppedBack(t);
  const again = k.run(["--previous"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, `RESULT: ok update already back on ${short(one)}\n`);
  assert.equal(k.link("current"), one);
  assert.equal(k.link("previous"), two);
  assert.equal(readFileSync(join(k.data, "held"), "utf8"), `${two}\n`);
});

test("after --previous, kit version dates the old kit by the last update and warns past a day", (t) => {
  const { k, one } = steppedBack(t);
  const version = () => spawnSync(join(k.data, one, "kit.d/version"), [], { env: { ...k.env, KIT_HOME: join(k.data, one) }, encoding: "utf8" }).stdout;
  // --previous is not an update: the age still counts from the update that unpacked two.
  writeFileSync(join(k.data, "updated"), `${Math.floor(Date.now() / 1000) - 2 * 86400}\n`);
  assert.match(version(), new RegExp(`^commit ${short(one)}\nkit machine copy, updated 2 days ago\n`));
  assert.match(version(), /^warning kit not updated for 2 days; run scripts\/agents\/kit update$/m);
  // A held kit update leaves current on one and counts as an update.
  assert.equal(k.run().status, 0);
  assert.match(version(), new RegExp(`^commit ${short(one)}\nkit machine copy, updated 0 minutes ago\n`));
  assert.doesNotMatch(version(), /^warning /m);
});

// A PATH holding every command on the test's PATH except one.
function pathWithout(k: { directory: string; env: NodeJS.ProcessEnv }, left: string) {
  const bin = join(k.directory, `without-${left}`);
  mkdirSync(bin);
  const linked = new Set<string>();
  for (const directory of (k.env.PATH ?? "").split(":")) {
    if (!directory || !existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      // The first folder on PATH wins, as in a shell.
      if (name !== left && !linked.has(name)) { linked.add(name); symlinkSync(join(directory, name), join(bin, name)); }
    }
  }
  return bin;
}

test("kit update says when flock is missing and still updates", (t) => {
  const k = kitRepo(t);
  const one = k.publish("one");
  const result = k.run([], { PATH: pathWithout(k, "flock") });
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
  assert.match(unknown.stderr, /^Usage: kit update \[--previous \| --install-timer \| --remove-timer\]\n/);
  assert.equal(unknown.stdout, "RESULT: fail update unknown argument --sideways\n");
  const help = k.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Usage: kit update \[--previous \| --install-timer \| --remove-timer\]\n/);
});

// A fake systemctl that writes each call to a log, keeps whether the timer is enabled and running in two files,
// and fails the calls named in KIT_TEST_SYSTEMCTL_FAIL (KIT_TEST_SYSTEMCTL_HALF: enable --now enables, then fails
// to start); the real one never runs, so nothing reaches the real ~/.config/systemd.
function fakeSystemctl(k: { directory: string; env: NodeJS.ProcessEnv }) {
  const bin = join(k.directory, "systemctl-bin");
  const log = join(k.directory, "systemctl.log");
  const enabled = join(k.directory, "systemctl.enabled");
  const active = join(k.directory, "systemctl.active");
  mkdirSync(bin);
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in *"\${KIT_TEST_SYSTEMCTL_FAIL:-none}"*) exit 1 ;; esac
case "$*" in
  *is-enabled*) [ -e "${enabled}" ] ;;
  *is-active*) [ -e "${active}" ] ;;
  *"enable --now"*) : > "${enabled}"; [ -z "\${KIT_TEST_SYSTEMCTL_HALF:-}" ] || exit 1; : > "${active}" ;;
  *"disable --now"*) rm -f "${enabled}" "${active}" ;;
  *stop*) rm -f "${active}" ;;
esac
`, { mode: 0o755 });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
  return { PATH: `${bin}:${k.env.PATH}`, calls, enabled: () => existsSync(enabled), active: () => existsSync(active) };
}

// systemd's folder under the temporary HOME, not the test's XDG_CONFIG_HOME.
const units = (k: { directory: string }) => join(k.directory, ".config/systemd/user");
const startCalls = ["--user is-enabled --quiet agent-kit-update.timer", "--user daemon-reload", "--user enable --now agent-kit-update.timer"];
const restartCalls = ["--user is-enabled --quiet agent-kit-update.timer", "--user is-active --quiet agent-kit-update.timer", ...startCalls.slice(1)];
const installed = "RESULT: ok update timer installed: kit update runs every 15 minutes\n";
const already = "RESULT: ok update timer already installed: kit update runs every 15 minutes\n";

// Both unit files verified by systemd's own reader, where it is installed (it checks ExecStart exists too).
function verifyUnits(t: { diagnostic: (message: string) => void }, k: { directory: string; env: NodeJS.ProcessEnv }) {
  if (spawnSync("sh", ["-c", "command -v systemd-analyze"]).status !== 0) { t.diagnostic("no systemd-analyze: unit files not verified by systemd"); return; }
  const files = ["timer", "service"].map((kind) => join(units(k), `agent-kit-update.${kind}`));
  const verify = spawnSync("systemd-analyze", ["verify", ...files], { env: k.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
}

test("kit update --install-timer writes both unit files, starts the timer and is safe to run again", (t) => {
  const k = kitRepo(t);
  const systemctl = fakeSystemctl(k);
  k.publish("one");
  k.run();
  const timer = join(units(k), "agent-kit-update.timer");
  const service = join(units(k), "agent-kit-update.service");
  const install = k.run(["--install-timer"], { PATH: systemctl.PATH });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.equal(install.stdout, `wrote ${timer}\nwrote ${service}\n${installed}`);
  assert.deepEqual(systemctl.calls(), startCalls);
  assert.equal(existsSync(join(k.directory, "config")), false);
  // The timer goes in as the kit holds it: every quarter hour, catching up a run missed while off, from login.
  assert.equal(readFileSync(timer, "utf8"), readFileSync("systemd/agent-kit-update.timer", "utf8"));
  assert.match(readFileSync(timer, "utf8"), /^\[Timer\]\n(?:#.*\n)*OnCalendar=\*:0\/15\nPersistent=true\n\n\[Install\]\nWantedBy=timers\.target\n$/m);
  const written = readFileSync(service, "utf8");
  assert.equal(written, readFileSync("systemd/agent-kit-update.service", "utf8")
    .replace("@DATA_HOME@", join(k.directory, "data")).replace("@KIT_REPO@", k.env.KIT_REPO!)
    .replace("@KIT@", join(k.data, "current/kit")));
  assert.match(written, /^Type=oneshot$/m);
  assert.doesNotMatch(written, /@[A-Z_]+@/);
  verifyUnits(t, k);
  const again = k.run(["--install-timer"], { PATH: systemctl.PATH });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, already);
  assert.equal(readFileSync(service, "utf8"), written);
  assert.deepEqual(systemctl.calls().slice(3), restartCalls);
  // A changed unit file (an older kit's, or edited by hand) is written again.
  writeFileSync(service, "old\n");
  assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).stdout, `wrote ${service}\n${installed}`);
  assert.equal(readFileSync(service, "utf8"), written);
  writeFileSync(timer, "old\n");
  const calls = systemctl.calls().length;
  assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).stdout, `wrote ${timer}\n${installed}`);
  assert.equal(readFileSync(timer, "utf8"), readFileSync("systemd/agent-kit-update.timer", "utf8"));
  assert.ok(systemctl.calls().slice(calls).includes("--user daemon-reload"));
  assert.deepEqual(readdirSync(units(k)).sort(), ["agent-kit-update.service", "agent-kit-update.timer"]);
});

test("the installed service, run as systemd runs it, brings a new main into the machine copy", (t) => {
  const k = kitRepo(t);
  const systemctl = fakeSystemctl(k);
  k.publish("one");
  k.run();
  assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).status, 0);
  const written = readFileSync(join(units(k), "agent-kit-update.service"), "utf8");
  const environment = Object.fromEntries([...written.matchAll(/"([A-Z_]+)=([^"]*)"/g)].map((match) => [match[1], match[2]]));
  const exec = /^ExecStart="([^"]+)" update$/m.exec(written);
  assert.ok(exec, written);
  const two = k.publish("two");
  // systemd gives a user service HOME and a plain PATH, and nothing from the shell that installed the timer.
  const run = spawnSync(exec[1], ["update"], { cwd: k.directory, encoding: "utf8", timeout: 30_000,
    env: { HOME: k.directory, PATH: "/usr/local/bin:/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...environment } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.ok(run.stdout.endsWith(`RESULT: ok update ${short(two)} (was ${short(k.link("previous"))})\n`), run.stdout);
  assert.equal(k.link("current"), two);
});

test("kit update --install-timer writes %, $ and @ in its paths and repo the way systemd reads them back", (t) => {
  const k = kitRepo(t);
  const systemctl = fakeSystemctl(k);
  k.publish("one");
  for (const [folder, repo, escapedRepo] of [["da%ta$x", "file:///srv/kit%20repo.git", "file:///srv/kit%%20repo.git"],
    ["user@corp/data", "git@example.invalid:org/agent-kit.git", "git@example.invalid:org/agent-kit.git"]]) {
    const dataHome = join(k.directory, folder);
    assert.equal(k.run([], { XDG_DATA_HOME: dataHome }).status, 0);
    const install = k.run(["--install-timer"], { PATH: systemctl.PATH, XDG_DATA_HOME: dataHome, KIT_REPO: repo });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const written = readFileSync(join(units(k), "agent-kit-update.service"), "utf8");
    const escaped = join(k.directory, folder.replace("%", "%%"));
    assert.ok(written.includes(`"XDG_DATA_HOME=${escaped}" "KIT_REPO=${escapedRepo}"`), written);
    assert.ok(written.includes(`ExecStart="${escaped}/agent-kit/current/kit" update`), written);
    verifyUnits(t, k);
  }
});

test("kit update --remove-timer stops the timer, takes its files out and is safe to run again", (t) => {
  const k = kitRepo(t);
  const systemctl = fakeSystemctl(k);
  k.publish("one");
  k.run();
  assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).status, 0);
  const timer = join(units(k), "agent-kit-update.timer");
  const service = join(units(k), "agent-kit-update.service");
  // A failed stop leaves both files, so the timer can still be stopped by hand or by a second try.
  const stuck = k.run(["--remove-timer"], { PATH: systemctl.PATH, KIT_TEST_SYSTEMCTL_FAIL: "disable" });
  assert.equal(stuck.status, 1, stuck.stdout + stuck.stderr);
  assert.equal(stuck.stdout, "RESULT: fail update cannot stop agent-kit-update.timer; nothing removed\n");
  assert.ok(existsSync(timer) && existsSync(service));
  const remove = k.run(["--remove-timer"], { PATH: systemctl.PATH });
  assert.equal(remove.status, 0, remove.stdout + remove.stderr);
  assert.equal(remove.stdout, `removed ${timer}\nremoved ${service}\nRESULT: ok update timer removed\n`);
  assert.deepEqual(systemctl.calls().slice(3), ["--user disable --now agent-kit-update.timer", "--user disable --now agent-kit-update.timer", "--user daemon-reload"]);
  assert.equal(systemctl.active(), false);
  assert.equal(systemctl.enabled(), false);
  assert.deepEqual(readdirSync(units(k)), []);
  const again = k.run(["--remove-timer"], { PATH: systemctl.PATH });
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(again.stdout, "RESULT: ok update timer already removed\n");
  assert.equal(systemctl.calls().length, 6);
  // A timer file deleted by hand: the timer may still run, so it is stopped; the service file and the wants link
  // go without a disable (which needs the timer file).
  assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).status, 0);
  mkdirSync(join(units(k), "timers.target.wants"));
  symlinkSync(timer, join(units(k), "timers.target.wants/agent-kit-update.timer"));
  rmSync(timer);
  const before = systemctl.calls().length;
  assert.equal(k.run(["--remove-timer"], { PATH: systemctl.PATH }).stdout, `removed ${service}\nRESULT: ok update timer removed\n`);
  assert.deepEqual(systemctl.calls().slice(before), ["--user stop agent-kit-update.timer", "--user daemon-reload"]);
  assert.equal(systemctl.active(), false);
  assert.deepEqual(readdirSync(units(k), { recursive: true }), ["timers.target.wants"]);
  // Only the wants link left: it goes too, and stop failing on a timer that is not loaded says nothing.
  symlinkSync(timer, join(units(k), "timers.target.wants/agent-kit-update.timer"));
  const link = k.run(["--remove-timer"], { PATH: systemctl.PATH, KIT_TEST_SYSTEMCTL_FAIL: "stop" });
  assert.equal(link.status, 0, link.stdout + link.stderr);
  assert.equal(link.stdout, "RESULT: ok update timer removed\n");
  assert.ok(!systemctl.calls().slice(before).some((call) => call.includes("disable")));
  assert.deepEqual(readdirSync(units(k), { recursive: true }), ["timers.target.wants"]);
  // Neither touches the machine copy, and removing creates no data folder on a machine without a kit.
  assert.ok(existsSync(join(k.data, "current/kit")));
  const bare = kitRepo(t);
  assert.equal(bare.run(["--remove-timer"], { PATH: fakeSystemctl(bare).PATH }).stdout, "RESULT: ok update timer already removed\n");
  assert.equal(existsSync(bare.data), false);
});

test("kit update --install-timer fails plainly without a machine copy, without systemctl and when the timer cannot start", (t) => {
  const k = kitRepo(t);
  const systemctl = fakeSystemctl(k);
  const empty = k.run(["--install-timer"], { PATH: systemctl.PATH });
  assert.equal(empty.status, 1, empty.stdout + empty.stderr);
  assert.equal(empty.stdout, `RESULT: fail update no machine copy at ${k.data}/current to run; run kit update first\n`);
  assert.equal(existsSync(units(k)), false);
  assert.equal(existsSync(k.data), false);
  assert.deepEqual(systemctl.calls(), []);
  k.publish("one");
  k.run();
  for (const flag of ["--install-timer", "--remove-timer"]) {
    const missing = k.run([flag], { PATH: pathWithout(k, "systemctl") });
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.equal(missing.stdout, "RESULT: fail update no systemctl: the update timer needs systemd\n");
    rmSync(join(k.directory, "without-systemctl"), { recursive: true });
  }
  assert.equal(existsSync(units(k)), false);
  // A repo name systemd cannot hold in a quoted value (or one that looks like a placeholder) is refused before
  // anything is written.
  for (const repo of ['file:///tmp/a"b', "file:///tmp/a\\b", "file:///tmp/a\nb", "file:///tmp/@DATA_HOME@"]) {
    const refused = k.run(["--install-timer"], { PATH: systemctl.PATH, KIT_REPO: repo });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.equal(refused.stdout, `RESULT: fail update cannot write the timer's service, because ${repo.replace("\n", " ")} holds a quote, backslash, new line or @KIT@-style name\n`);
  }
  assert.equal(existsSync(units(k)), false);
  // A kit without its unit files fails before writing the one it lacks.
  const partial = join(k.directory, "partial");
  cpSync(resolve("."), partial, { recursive: true, filter: kitFiles });
  rmSync(join(partial, "systemd/agent-kit-update.service"));
  const lacking = spawnSync(join(partial, "kit.d/update"), ["--install-timer"], { env: { ...k.env, PATH: systemctl.PATH }, encoding: "utf8", timeout: 30_000 });
  assert.equal(lacking.status, 1, lacking.stdout + lacking.stderr);
  assert.ok(lacking.stdout.endsWith("RESULT: fail update this kit has no systemd/agent-kit-update.service\n"), lacking.stdout);
  assert.deepEqual(readdirSync(units(k)), ["agent-kit-update.timer"]);
  rmSync(units(k), { recursive: true });
  const start = "RESULT: fail update cannot start agent-kit-update.timer (systemctl --user status agent-kit-update.timer says why)\n";
  const reload = k.run(["--install-timer"], { PATH: systemctl.PATH, KIT_TEST_SYSTEMCTL_FAIL: "daemon-reload" });
  assert.equal(reload.status, 1, reload.stdout + reload.stderr);
  assert.ok(reload.stdout.endsWith(start), reload.stdout);
  assert.ok(!systemctl.calls().some((call) => call.includes("enable --now")), systemctl.calls().join("\n"));
  assert.deepEqual(readdirSync(units(k)).sort(), ["agent-kit-update.service", "agent-kit-update.timer"]);
  const failed = k.run(["--install-timer"], { PATH: systemctl.PATH, KIT_TEST_SYSTEMCTL_FAIL: "enable --now" });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(failed.stdout, start);
  // The files a failed start left are unchanged, yet this is the run that turns the timer on.
  assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).stdout, installed);
  assert.equal(systemctl.enabled(), true);
  // Also when enable got as far as enabling it, or when it was stopped by hand.
  for (const leave of [{ KIT_TEST_SYSTEMCTL_HALF: "1" }, {}]) {
    spawnSync("systemctl", ["--user", "stop", "agent-kit-update.timer"], { env: { ...k.env, PATH: systemctl.PATH } });
    if (Object.keys(leave).length) assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH, ...leave }).status, 1);
    assert.equal(systemctl.enabled() && !systemctl.active(), true);
    assert.equal(k.run(["--install-timer"], { PATH: systemctl.PATH }).stdout, installed);
    assert.equal(systemctl.active(), true);
  }
  for (const flags of [["--previous", "--install-timer"], ["--install-timer", "--remove-timer"]]) {
    const both = k.run(flags, { PATH: systemctl.PATH });
    assert.equal(both.status, 2, both.stdout + both.stderr);
    assert.equal(both.stdout, "RESULT: fail update takes one of --previous, --install-timer and --remove-timer\n");
  }
  // The same flag twice is one request.
  assert.equal(k.run(["--install-timer", "--install-timer"], { PATH: systemctl.PATH }).stdout, already);
});
