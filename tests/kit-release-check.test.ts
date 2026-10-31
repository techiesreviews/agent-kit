import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

const check = resolve("kit.d/release-check");
const kit = resolve("kit");

// A project whose origin (a bare folder) has dev and main at one commit, checked out at main.
// No .gitignore, so a file under .scratch/ shows as untracked: the check must still pass it.
function fixture(t: TestContext, branches: Record<string, string> = { land: "dev", release: "main" }) {
  const dir = mkdtempSync(join(tmpdir(), "kit-release-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, "origin.git"), root = join(dir, "work");
  // Temporary HOME and XDG folders: the front door's kit-lib.sh reads HOME.
  const env: NodeJS.ProcessEnv = { ...kitEnv(), KIT_ROOT: root, ASE_OWNER: "ke-72", HOME: join(dir, "home"),
    XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config"), XDG_CACHE_HOME: join(dir, "cache"), XDG_DATA_HOME: join(dir, "data"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
  delete env.GIT_SSH_COMMAND; delete env.GIT_SSH; delete env.KIT_RELEASE_CHECK_TIMEOUT;
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
  git("add", "."); git("commit", "-q", "-m", "base");
  git("branch", "dev"); git("push", "-q", "origin", "main", "dev");
  const commit = (cwd: string, subject: string) => {
    writeFileSync(join(cwd, `${subject.replaceAll(" ", "-")}.txt`), `${subject}\n`);
    gitAt(cwd, "add", "."); gitAt(cwd, "commit", "-q", "-m", subject);
  };
  // Another clone, standing in for a merge on GitHub.
  const peer = () => {
    const path = join(dir, "peer"); gitAt(dir, "clone", "-q", origin, path);
    gitAt(path, "config", "user.name", "Peer"); gitAt(path, "config", "user.email", "peer@example.com");
    return path;
  };
  const refs = () => gitAt(origin, "for-each-ref", "--format=%(refname) %(objectname)");
  const run = (args: string[] = [], overrides: NodeJS.ProcessEnv = {}, front = false) => {
    const result = spawnSync(front ? kit : check, front ? ["release-check", ...args] : args,
      { cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.error, undefined, result.error?.message);
    return result;
  };
  return { dir, root, origin, git, gitAt, commit, peer, refs, run, short: () => git("rev-parse", "--short", "HEAD") };
}

const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1) ?? "";
const results = (stdout: string) => stdout.split("\n").filter(line => line.startsWith("RESULT: "));

test("help names the command, its options and what it checks", t => {
  const f = fixture(t);
  for (const front of [false, true]) {
    const result = f.run(["--help"], {}, front);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: kit release-check \[--land\] \[--waive "<reason>"\]/);
    assert.match(result.stdout, /origin\/<release>/); assert.match(result.stdout, /\.scratch\//);
    assert.deepEqual(results(result.stdout), []);
  }
  for (const args of [["--wat"], ["--waive"], ["--waive", " "], ["--land", "--land"]]) {
    const result = f.run(args);
    assert.equal(result.status, 2); assert.match(result.stderr, /^Usage:/);
    assert.match(lastLine(result.stdout), /^RESULT: fail invalid arguments: /);
  }
});

test("a clean HEAD exactly on origin/<release> passes, and a file under .scratch/ does not count", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".scratch/pr"), { recursive: true });
  writeFileSync(join(f.root, ".scratch/pr/log.txt"), "a kit log\n");
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(results(result.stdout).length, 1);
  assert.equal(lastLine(result.stdout), `RESULT: ok release-check ${f.short()} is origin/main, nothing unsaved`);
});

test("the deploy form, the kit front door, passes a clean checkout and fails an unsaved file", t => {
  const f = fixture(t);
  let result = f.run([], {}, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lastLine(result.stdout), `RESULT: ok release-check ${f.short()} is origin/main, nothing unsaved`);
  writeFileSync(join(f.root, "draft.html"), "x\n");
  result = f.run([], {}, true);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail unsaved files \(draft\.html\): /);
});

test("a project whose landing branch is live checks that same branch", t => {
  const f = fixture(t, { land: "main", release: "main" });
  assert.equal(f.run().status, 0);
  assert.equal(f.run(["--land"]).status, 0);
  f.commit(f.root, "local fix");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), `RESULT: fail HEAD ${f.short()} is 1 commit ahead of origin/main: what goes live must be on main; land it with kit pr`);
});

test("a changed or untracked file fails with the files named", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "page.html"), "<p>edited</p>\n");
  writeFileSync(join(f.root, "draft.html"), "<p>new</p>\n");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail unsaved files \(draft\.html, page\.html\): commit them through kit pr or remove them before going live$/);
  assert.match(result.stderr, /problem: unsaved files/);
});

test("more than five unsaved files are named five and counted; a changed file under .scratch/ does not count", t => {
  const f = fixture(t);
  mkdirSync(join(f.root, ".scratch"), { recursive: true });
  writeFileSync(join(f.root, ".scratch/kept.txt"), "tracked\n");
  f.git("add", "-f", ".scratch/kept.txt"); f.git("commit", "-q", "-m", "tracked scratch"); f.git("push", "-q", "origin", "main");
  writeFileSync(join(f.root, ".scratch/kept.txt"), "edited\n");
  let result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (let i = 1; i <= 7; i++) writeFileSync(join(f.root, `draft-${i}.html`), "x\n");
  result = f.run();
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail unsaved files \(draft-1\.html, draft-2\.html, draft-3\.html, draft-4\.html, draft-5\.html and 2 more\): /);
});

test("a token in origin's URL stays off the lines a failed fetch prints", t => {
  const f = fixture(t);
  f.git("remote", "set-url", "origin", "https://user:s3cret@127.0.0.1:9/x.git");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail could not fetch origin \(/);
  assert.doesNotMatch(result.stdout + result.stderr, /s3cret/);
});

test("unsaved paths with spaces, accents and a deleted file are named as written", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "my draft.html"), "x\n"); writeFileSync(join(f.root, "café.html"), "x\n");
  rmSync(join(f.root, "page.html"));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail unsaved files \(café\.html, my draft\.html, page\.html\): /);
});

test("an origin that does not answer fails after KIT_RELEASE_CHECK_TIMEOUT seconds", t => {
  const f = fixture(t), stall = join(f.dir, "stall.sh");
  writeFileSync(stall, "#!/bin/sh\nsleep 4\n"); chmodSync(stall, 0o755);
  f.git("config", "protocol.ext.allow", "always"); f.git("remote", "set-url", "origin", `ext::${stall}`);
  const result = f.run([], { KIT_RELEASE_CHECK_TIMEOUT: "1" });
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), "RESULT: fail could not fetch origin (no answer within 1 seconds): try again once origin answers");
});

test("an SSH origin is fetched in batch mode, so ssh never asks for a passphrase or host key", t => {
  const f = fixture(t), bin = join(f.dir, "bin"), log = join(f.dir, "ssh.log");
  mkdirSync(bin); writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$@" >> ${log}\nexit 255\n`); chmodSync(join(bin, "ssh"), 0o755);
  f.git("remote", "set-url", "origin", "ssh://example.invalid/x.git");
  const result = f.run([], { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail could not fetch origin \(/);
  assert.match(readFileSync(log, "utf8"), /-o BatchMode=yes/);
});

test("no origin remote, and an origin that cannot be fetched, fail with their own lines", t => {
  const f = fixture(t);
  f.git("remote", "set-url", "origin", join(f.dir, "gone.git"));
  let result = f.run();
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail could not fetch origin \(.+\): try again once origin answers$/);
  f.git("remote", "remove", "origin");
  result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), "RESULT: fail no origin remote: the check compares HEAD with origin/main");
});

test("a single-branch clone that does not track the release branch still fetches it by name", t => {
  const f = fixture(t), only = join(f.dir, "only");
  f.gitAt(f.dir, "clone", "-q", "--single-branch", "--branch", "dev", f.origin, only);
  // dev and main are one commit, so the clone's HEAD is origin/main once main is fetched.
  const result = f.run([], { KIT_ROOT: only });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(lastLine(result.stdout), /^RESULT: ok release-check [a-f0-9]{7} is origin\/main, nothing unsaved$/);
});

test("a HEAD ahead of origin/<release> fails: its commit never reached the release branch", t => {
  const f = fixture(t);
  f.commit(f.root, "local fix");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), `RESULT: fail HEAD ${f.short()} is 1 commit ahead of origin/main: what goes live must be on main; land it on dev with kit pr, then kit pr --release`);
});

test("a HEAD behind origin/<release> fails after a fetch, though the local origin/<release> was stale", t => {
  const f = fixture(t), peer = f.peer();
  f.commit(peer, "merged one"); f.commit(peer, "merged two");
  f.gitAt(peer, "push", "-q", "origin", "main");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), `RESULT: fail HEAD ${f.short()} is 2 commits behind origin/main: update the checkout to origin/main before going live`);
});

test("an origin branch force-pushed back is fetched over the newer one the clone saw", t => {
  const f = fixture(t), peer = f.peer(), base = f.gitAt(peer, "rev-parse", "HEAD");
  f.commit(peer, "merged"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.git("pull", "-q", "--ff-only", "origin", "main");
  f.gitAt(peer, "push", "-q", "--force", "origin", `${base}:main`);
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), `RESULT: fail HEAD ${f.short()} is 1 commit ahead of origin/main: what goes live must be on main; land it on dev with kit pr, then kit pr --release`);
});

test("a checkout with no commit fails with its own line", t => {
  const f = fixture(t);
  f.git("checkout", "-q", "--orphan", "empty"); f.git("rm", "-rfq", "."); f.git("clean", "-fdq");
  // The settings come back as the one unsaved file.
  mkdirSync(join(f.root, "scripts/agents"), { recursive: true });
  writeFileSync(join(f.root, "scripts/agents/kit.json"), JSON.stringify({ project: "site", branches: { land: "dev", release: "main" } }));
  const result = f.run();
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /; no commit checked out: check out origin\/main before going live$/);
});

test("a HEAD that has split from origin/<release> names both counts", t => {
  const f = fixture(t), peer = f.peer();
  f.commit(peer, "merged"); f.gitAt(peer, "push", "-q", "origin", "main");
  f.commit(f.root, "local");
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), `RESULT: fail HEAD ${f.short()} and origin/main have split (1 commit ahead, 1 behind): update the checkout to origin/main before going live`);
});

test("a project without branches.release fails with the line saying so", t => {
  const f = fixture(t, { land: "main" });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), "RESULT: fail no branches.release in scripts/agents/kit.json: name the branch that goes live there");
});

test("a release branch missing on origin fails with its own line", t => {
  const f = fixture(t, { land: "dev", release: "live" });
  const result = f.run();
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), "RESULT: fail origin has no branch live: push nothing by hand; land the release with kit pr --release");
});

test("--land compares HEAD with origin/<land>, for kit pr --release", t => {
  const f = fixture(t), peer = f.peer();
  f.commit(peer, "landed"); f.gitAt(peer, "push", "-q", "origin", "HEAD:dev");
  let result = f.run(["--land"]);
  assert.equal(result.status, 1);
  assert.match(lastLine(result.stdout), /^RESULT: fail HEAD [a-f0-9]{7} is 1 commit behind origin\/dev: cut the release again from origin\/dev \(git reset --hard origin\/dev\) and rerun kit pr --release$/);
  f.git("fetch", "-q", "origin"); f.git("checkout", "-q", "--detach", "origin/dev");
  result = f.run(["--land"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(lastLine(result.stdout), `RESULT: ok release-check ${f.short()} is origin/dev, nothing unsaved`);
  // Under --land, a HEAD ahead and a missing branch get advice that does not send kit pr --release round in a circle.
  f.commit(f.root, "unlanded");
  result = f.run(["--land"]);
  assert.equal(lastLine(result.stdout), `RESULT: fail HEAD ${f.short()} is 1 commit ahead of origin/dev: a release carries only what landed on dev; land it with kit pr first`);
});

test("a live landing branch missing on origin says to land work there, not to run kit pr --release", t => {
  const f = fixture(t, { land: "live", release: "live" });
  const result = f.run();
  assert.equal(lastLine(result.stdout), "RESULT: fail origin has no branch live: land work on live through kit pr first");
});

test("--land with no landing branch on origin says to land work there first", t => {
  const f = fixture(t, { land: "trunk", release: "main" });
  const result = f.run(["--land"]);
  assert.equal(result.status, 1);
  assert.equal(lastLine(result.stdout), "RESULT: fail origin has no branch trunk: land work on trunk through kit pr first");
});

test("only a lead may --waive; a waiver passes, names the reason and what it let through", t => {
  const f = fixture(t);
  f.commit(f.root, "local fix");
  writeFileSync(join(f.root, "draft.html"), "<p>new</p>\n");
  let result = f.run(["--waive", "hotfix tonight"]);
  assert.equal(result.status, 2); assert.equal(lastLine(result.stdout), "RESULT: fail invalid arguments: --waive requires a *-lead owner");
  result = f.run(["--waive", "hotfix tonight"], { ASE_OWNER: "ke-lead" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(results(result.stdout).length, 1);
  assert.match(lastLine(result.stdout), /^RESULT: ok release-check waived by ke-lead \(hotfix tonight\): unsaved files \(draft\.html\); HEAD [a-f0-9]{7} is 1 commit ahead of origin\/main$/);
  // A waiver with nothing to waive still says the check passed on its own.
  f.git("reset", "-q", "--hard", "origin/main"); rmSync(join(f.root, "draft.html"), { force: true });
  result = f.run(["--waive", "hotfix tonight"], { ASE_OWNER: "ke-lead" });
  assert.equal(result.status, 0);
  assert.equal(lastLine(result.stdout), `RESULT: ok release-check ${f.short()} is origin/main, nothing unsaved (waiver not needed: hotfix tonight)`);
});

test("the check pushes nothing, whatever it finds", t => {
  const f = fixture(t), before = f.refs();
  f.run();
  f.commit(f.root, "local fix");
  writeFileSync(join(f.root, "draft.html"), "x\n");
  f.run(); f.run(["--land"]); f.run(["--waive", "go"], { ASE_OWNER: "ke-lead" });
  assert.equal(f.refs(), before);
});

test("the rulebook's Release station and the extras template show the check as the deploy's first step", () => {
  const station = /### 12\. Release\n([\s\S]*?)\n## /.exec(readFileSync("docs/kitchen.md", "utf8"))?.[1] ?? "";
  assert.match(station, /kit pr --release` first runs `kit release-check --land`/);
  assert.match(station, /`scripts\/agents\/kit release-check`/);
  const release = /## Release\n([\s\S]*?)\n## /.exec(readFileSync("docs/kitchen-extras-template.md", "utf8"))?.[1] ?? "";
  assert.match(release, /`scripts\/agents\/kit release-check &&` before the deploy/);
});
