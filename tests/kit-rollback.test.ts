import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

const rollback = resolve("kit.d/rollback");
const kit = resolve("kit");
const direct = { land: "main", release: "main", direct: true };

// A stand-in for kit: it records the call, says a few lines and ends as FAKE_PR says ("fail" ends with exit 1).
const fakeKit = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FAKE_CALLS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(),
  branch: require("node:child_process").execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim() }) + "\\n");
console.log("guards: ok");
console.log("RESULT: ok an inner result that must not be the last");
if (process.env.FAKE_PR === "fail") { console.log("RESULT: fail ci: checks failed"); process.exit(1); }
console.log("landed: abc1234 something");
console.log("RESULT: ok merged #7 abcdef0");
`;

// A direct project: origin (a bare folder) holds main with a base commit and three landings, checked out at main.
function fixture(t: TestContext, branches: Record<string, unknown> = direct) {
  const dir = mkdtempSync(join(tmpdir(), "kit-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git"), root = join(dir, "work");
  const calls = join(dir, "calls.jsonl"), fake = join(dir, "fake-kit");
  writeFileSync(fake, fakeKit); chmodSync(fake, 0o755); writeFileSync(calls, "");
  const env: NodeJS.ProcessEnv = { ...kitEnv(), KIT_ROOT: root, ASE_OWNER: "ke-1", HOME: join(dir, "home"),
    XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", KIT_ROLLBACK_KIT: fake, FAKE_CALLS: calls };
  delete env.GIT_SSH_COMMAND; delete env.GIT_SSH; delete env.FAKE_PR;
  const gitAt = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  gitAt(dir, "init", "-q", "--bare", "--initial-branch=main", origin);
  gitAt(dir, "clone", "-q", origin, root);
  const git = (...args: string[]) => gitAt(root, ...args);
  git("config", "user.name", "Kit test"); git("config", "user.email", "kit@example.com");
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "site", branches }));
  writeFileSync(join(root, "page.html"), "<p>live</p>\n");
  git("add", "."); git("commit", "-q", "-m", "base"); git("push", "-q", "origin", "main");
  // One landing: a file of its own, pushed to origin.
  const land = (subject: string, file = `${subject.replaceAll(" ", "-")}.txt`, text = `${subject}\n`) => {
    writeFileSync(join(root, file), text);
    git("add", "."); git("commit", "-q", "-m", subject); git("push", "-q", "origin", "main");
    return git("rev-parse", "--short", "HEAD");
  };
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}, front = false) => {
    const result = spawnSync(front ? kit : rollback, front ? ["rollback", ...args] : args,
      { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  const calledWith = () => readFileSync(calls, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as { args: string[]; branch: string });
  return { dir, root, origin, git, gitAt, land, run, calledWith, env };
}

const results = (stdout: string) => stdout.split("\n").filter(line => line.startsWith("RESULT: "));
const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1) ?? "";

test("help says what it does and the front door lists it", t => {
  const f = fixture(t);
  const help = f.run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: kit rollback <first> \[<last>\]/);
  assert.match(help.stdout, /git revert --no-edit <first>\^\.\.<last>/);
  assert.match(help.stdout, /kit pr/);
  const bare = f.run([]);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /Usage: kit rollback/);
  assert.match(lastLine(bare.stdout), /^RESULT: fail rollback invalid arguments/);
  const front = spawnSync(kit, ["--help"], { cwd: f.root, env: f.env, encoding: "utf8" });
  assert.match(front.stdout, /^ {2}rollback {2}.+$/m);
});

test("rolls back a range: a branch cut at origin/main, one revert per commit, landed through kit pr", t => {
  const f = fixture(t);
  const first = f.land("first change"), middle = f.land("second change"), last = f.land("third change");
  f.land("later change");
  const before = f.git("rev-parse", "main");
  const result = f.run([first, last]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // A branch named for the range, cut at origin/main; main itself is untouched.
  const branch = `rollback/${first}-${last}`;
  assert.equal(f.git("branch", "--show-current"), branch);
  assert.equal(f.git("rev-parse", "main"), before);
  assert.equal(f.git("merge-base", "HEAD", "origin/main"), f.git("rev-parse", "origin/main"));
  // The three commits are undone, one revert each, newest landing first as git revert does it; the later one stays.
  const subjects = f.git("log", "--format=%s", "origin/main..HEAD").split("\n");
  assert.deepEqual(subjects, [`Revert "first change"`, `Revert "second change"`, `Revert "third change"`]);
  assert.ok(middle);
  for (const gone of ["first-change.txt", "second-change.txt", "third-change.txt"]) assert.equal(existsSync(join(f.root, gone)), false, gone);
  assert.equal(existsSync(join(f.root, "later-change.txt")), true);
  // kit pr runs from that branch, with a title that names the range.
  const [call, ...more] = f.calledWith();
  assert.equal(more.length, 0);
  assert.equal(call.branch, branch);
  assert.deepEqual(call.args.slice(0, 2), ["pr", "--title"]);
  assert.match(call.args[2], /^Roll back 3 commits \(/);
  // The run says what kit pr said, behind exactly one RESULT line, the last line.
  assert.match(result.stdout, /^guards: ok$/m);
  assert.match(result.stdout, /^landed: abc1234 something$/m);
  assert.equal(results(result.stdout).length, 1);
  assert.match(lastLine(result.stdout), /^RESULT: ok rollback merged #7 abcdef0/);
});

test("one commit: the last argument is optional, and the title says which commit", t => {
  const f = fixture(t);
  f.land("keep this");
  const bad = f.land("the bad change");
  f.land("keep this too");
  const result = f.run([bad]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(f.git("log", "--format=%s", "origin/main..HEAD").split("\n"), [`Revert "the bad change"`]);
  assert.equal(existsSync(join(f.root, "the-bad-change.txt")), false);
  assert.equal(existsSync(join(f.root, "keep-this.txt")), true);
  assert.equal(f.calledWith()[0].args[2], "Roll back: the bad change");
  assert.equal(f.git("branch", "--show-current"), `rollback/${bad}-${bad}`);
});

test("the front door runs it and passes the exit status on", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  const result = f.run([sha], {}, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(results(result.stdout).length, 1);
  const failed = fixture(t);
  const other = failed.land("a change");
  const bad = failed.run([other], { FAKE_PR: "fail" }, true);
  assert.equal(bad.status, 1);
  assert.equal(results(bad.stdout).length, 1);
});

test("a kit pr that fails leaves the branch with its reverts and says so", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  const result = f.run([sha], { FAKE_PR: "fail" });
  assert.equal(result.status, 1);
  assert.equal(results(result.stdout).length, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback ci: checks failed/);
  assert.match(lastLine(result.stdout), new RegExp(`rollback/${sha}-${sha}`));
  assert.equal(f.git("branch", "--show-current"), `rollback/${sha}-${sha}`);
  assert.equal(f.git("log", "--format=%s", "origin/main..HEAD"), `Revert "a change"`);
});

test("only a direct project: a project with a release step is refused before anything changes", t => {
  const f = fixture(t, { land: "dev", release: "main" });
  const sha = f.land("a change");
  const result = f.run([sha]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback .*direct project/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.calledWith().length, 0);
});

test("refuses unsaved files, and changes nothing", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  writeFileSync(join(f.root, "page.html"), "<p>edited</p>\n");
  const result = f.run([sha]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback unsaved files \(page\.html\)/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(readFileSync(join(f.root, "page.html"), "utf8"), "<p>edited</p>\n");
  assert.equal(f.calledWith().length, 0);
});

test("refuses a commit that is not on origin/main, an unknown one, and an option in its place", t => {
  const f = fixture(t);
  f.land("a change");
  writeFileSync(join(f.root, "local.txt"), "local\n");
  f.git("add", "."); f.git("commit", "-q", "-m", "only here");
  const local = f.git("rev-parse", "--short", "HEAD");
  const notLanded = f.run([local]);
  assert.equal(notLanded.status, 1);
  assert.match(lastLine(notLanded.stdout), /^RESULT: fail rollback .*is not on origin\/main/);
  const unknown = f.run(["deadbee"]);
  assert.equal(unknown.status, 1);
  assert.match(lastLine(unknown.stdout), /^RESULT: fail rollback .*deadbee.* is no commit/);
  const option = f.run(["--hard"]);
  assert.equal(option.status, 2);
  assert.match(lastLine(option.stdout), /^RESULT: fail rollback invalid arguments/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.calledWith().length, 0);
});

test("refuses a range given the wrong way round, a merge commit inside it, and the first commit of history", t => {
  const f = fixture(t);
  const one = f.land("one"), two = f.land("two");
  const reversed = f.run([two, one]);
  assert.equal(reversed.status, 1);
  assert.match(lastLine(reversed.stdout), /^RESULT: fail rollback .* is not before /);
  const root = f.git("rev-list", "--max-parents=0", "HEAD").slice(0, 7);
  const first = f.run([root]);
  assert.equal(first.status, 1);
  assert.match(lastLine(first.stdout), /^RESULT: fail rollback .*no parent/);

  // A merge commit on main: reverting it needs a choice of side, which the command does not make.
  f.git("switch", "-q", "-c", "side", one);
  writeFileSync(join(f.root, "side.txt"), "side\n");
  f.git("add", "."); f.git("commit", "-q", "-m", "side work");
  f.git("switch", "-q", "main");
  f.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  f.git("push", "-q", "origin", "main");
  const merged = f.run([f.git("rev-parse", "--short", "HEAD")]);
  assert.equal(merged.status, 1);
  assert.match(lastLine(merged.stdout), /^RESULT: fail rollback .*merge commit/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.calledWith().length, 0);
});

test("a revert that conflicts is undone: the checkout is back where it was and no branch is left", t => {
  const f = fixture(t);
  const first = f.land("first edit", "page.html", "<p>one</p>\n");
  f.land("second edit", "page.html", "<p>two</p>\n");
  const result = f.run([first]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback revert .*conflict in page\.html/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("branch", "--list", "rollback/*"), "");
  assert.equal(readFileSync(join(f.root, "page.html"), "utf8"), "<p>two</p>\n");
  assert.equal(f.calledWith().length, 0);
});

test("a second run for the same range is refused while its branch is still there", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  assert.equal(f.run([sha], { FAKE_PR: "fail" }).status, 1);
  f.git("switch", "-q", "main");
  const again = f.run([sha]);
  assert.equal(again.status, 1);
  assert.match(lastLine(again.stdout), /^RESULT: fail rollback branch rollback\/.* already exists/);
});

test("a conflict after some reverts went through undoes those too", t => {
  const f = fixture(t);
  // Newest first: the other file's revert goes through, then the page's conflicts with the edit that landed after the range.
  const first = f.land("first edit", "page.html", "<p>one</p>\n");
  const last = f.land("other file");
  f.land("later edit", "page.html", "<p>three</p>\n");
  const result = f.run([first, last]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback revert .*conflict in page\.html; nothing was changed/);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(f.git("branch", "--list", "rollback/*"), "");
  assert.equal(existsSync(join(f.root, "other-file.txt")), true);
  assert.equal(f.calledWith().length, 0);
});

test("a conflict from a detached HEAD goes back to that commit, with no branch left", t => {
  const f = fixture(t);
  const first = f.land("first edit", "page.html", "<p>one</p>\n");
  f.land("second edit", "page.html", "<p>two</p>\n");
  f.git("switch", "-q", "--detach", "origin/main");
  const head = f.git("rev-parse", "HEAD");
  const result = f.run([first]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback revert .*conflict in page\.html; nothing was changed/);
  assert.equal(f.git("branch", "--show-current"), "");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("branch", "--list", "rollback/*"), "");
  assert.equal(f.git("status", "--porcelain"), "");
});

test("a kit pr that cannot start fails in words and names the branch", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  const result = f.run([sha], { KIT_ROLLBACK_KIT: join(f.dir, "no-such-kit") });
  assert.equal(result.status, 1);
  assert.equal(results(result.stdout).length, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback kit pr could not start: .*no-such-kit/);
  assert.match(lastLine(result.stdout), new RegExp(`rollback/${sha}-${sha}`));
});

test("files under .scratch/ are not unsaved files", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  mkdirSync(join(f.root, ".scratch"), { recursive: true });
  writeFileSync(join(f.root, ".scratch/note.txt"), "kit log\n");
  const result = f.run([sha]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.calledWith().length, 1);
});

test("an origin that cannot be fetched stops it before anything changes", t => {
  const f = fixture(t);
  const sha = f.land("a change");
  f.git("remote", "set-url", "origin", join(f.dir, "nowhere.git"));
  const result = f.run([sha]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail rollback fetch: /);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("branch", "--list", "rollback/*"), "");
  assert.equal(f.calledWith().length, 0);
});
