import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(".");
const kit = join(repo, "scripts/agents/kit");
const doctor = join(repo, "scripts/agents/kit.d/doctor");
const library = join(repo, "scripts/agents/kit-lib.sh");

function temp(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "kit-doctor-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function git(root: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root: string, ...files: string[]) {
  git(root, "add", ...files);
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "fixture");
}

function executable(file: string, body: string) {
  writeFileSync(file, `#!/bin/bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = temp(t);
  const main = join(directory, "native-site-editor");
  const dev = `${main}-dev`;
  const build = `${main}-build-x`;
  git(directory, "init", "--bare", "--initial-branch=dev", "origin.git");
  git(directory, "clone", join(directory, "origin.git"), main);
  git(main, "checkout", "-b", "main");
  mkdirSync(join(main, "scripts/agents/hooks"), { recursive: true });
  for (const name of ["run.sh", "bash-guard.sh"]) {
    copyFileSync(join(repo, "scripts/agents/hooks", name), join(main, "scripts/agents/hooks", name));
  }
  mkdirSync(join(main, ".claude"));
  mkdirSync(join(main, ".codex"));
  writeFileSync(join(main, ".claude/settings.json"), "{}\n");
  writeFileSync(join(main, ".codex/hooks.json"), "{}\n");
  commit(main, "scripts", ".claude", ".codex");
  git(main, "push", "origin", "HEAD:dev");
  git(main, "fetch", "origin");
  git(main, "worktree", "add", "-b", "dev", dev, "origin/dev");
  git(main, "worktree", "add", "-b", "build/x", build, "origin/dev");
  mkdirSync(join(dev, "node_modules"));
  symlinkSync(join(dev, "node_modules"), join(build, "node_modules"));
  symlinkSync(join(dev, "node_modules"), join(main, "node_modules"));
  const run = (args: string[] = [], root = build, env: NodeJS.ProcessEnv = {}, direct = false) => spawnSync(
    "/bin/bash", direct ? [doctor, ...args] : [kit, "doctor", ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: main, KIT_LIB: library,
        KIT_COMMANDS_DIR: join(repo, "scripts/agents/kit.d"), ...env },
    },
  );
  return { directory, main, dev, build, run };
}

function failure(result: ReturnType<typeof spawnSync<string>>, name: string) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.filter(line => line.startsWith("RESULT: ")).length, 1);
  assert.equal(lines.length, 8, result.stdout);
  assert.ok(lines.some(line => line.startsWith(`✗ ${name}: `) && line.includes("; fix: ")), result.stdout);
  assert.equal(lines.at(-1), `RESULT: fail doctor 1 failed: ${name}`);
  assert.equal(result.stderr, "");
}

test("doctor checks all seven conditions quickly and quiet success prints only RESULT", (t) => {
  const f = fixture(t);
  // Git tracks only the executable bit; the rest of the mode follows the umask.
  assert.equal(statSync(doctor).mode & 0o111, 0o111);
  const start = performance.now();
  const result = f.run();
  const elapsed = performance.now() - start;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(elapsed < 2000, `doctor took ${elapsed}ms`);
  const lines = result.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 7).map(line => line.split(":")[0]), [
    "✓ place", "✓ base", "✓ hook config", "✓ hooks live", "✓ node", "✓ node_modules", "✓ conflicts",
  ]);
  assert.equal(lines.length, 8);
  assert.equal(lines[7], "RESULT: ok doctor 7/7 checks passed");
  assert.equal(result.stderr, "");
  const quiet = f.run(["--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "RESULT: ok doctor 7/7 checks passed\n");
  assert.equal(quiet.stderr, "");
});

test("doctor rejects the main checkout even through an alias", (t) => {
  const f = fixture(t);
  const alias = join(f.directory, "main-alias");
  symlinkSync(f.main, alias);
  failure(f.run([], alias), "place");
});

test("doctor rejects the dev worktree but notes its allowed base and real dependencies", (t) => {
  const f = fixture(t);
  const result = f.run([], f.dev);
  failure(result, "place");
  assert.match(result.stdout, /✓ base: dev in the dev worktree/);
  assert.match(result.stdout, /✓ node_modules: .*\(dev worktree\)/);
});

test("doctor rejects an unrelated branch", (t) => {
  const f = fixture(t);
  // Keep the tracked hook files while creating a commit with no parent.
  git(f.build, "checkout", "--orphan", "unrelated");
  git(f.build, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "unrelated");
  const result = f.run();
  failure(result, "base");
  assert.match(result.stdout, /not based on origin\/dev \(merge-base none\)/);
});

test("doctor reports missing origin/dev", (t) => {
  const f = fixture(t);
  git(f.build, "update-ref", "-d", "refs/remotes/origin/dev");
  const result = f.run();
  failure(result, "base");
  assert.match(result.stdout, /missing origin\/dev; fix: git fetch origin/);
});

test("doctor accepts a branch cut from an earlier fetched dev tip", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.build, "branch.txt"), "independent branch work\n");
  commit(f.build, "branch.txt");
  writeFileSync(join(f.dev, "advance.txt"), "new dev work\n");
  commit(f.dev, "advance.txt");
  git(f.dev, "push", "origin", "dev");
  git(f.build, "fetch", "origin");
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /✓ base: 1 commits behind origin\/dev; rebase before landing/);
});

test("doctor rejects a base that stopped being the dev tip over a day ago, across later fetches", (t) => {
  const f = fixture(t);
  const old = git(f.build, "rev-parse", "HEAD");
  const advance = (name: string, env: NodeJS.ProcessEnv = {}) => {
    writeFileSync(join(f.dev, name), "new dev work\n");
    commit(f.dev, name);
    // Pushing updates the shared origin/dev ref; the reflog records the committer date.
    const pushed = spawnSync("git", ["-C", f.dev, "push", "origin", "dev"], { encoding: "utf8", env: { ...process.env, ...env } });
    assert.equal(pushed.status, 0, pushed.stderr);
    git(f.build, "fetch", "origin");
  };
  const twoDaysAgo = `${Math.floor(Date.now() / 1000) - 2 * 86400} +0000`;
  advance("first.txt", { GIT_COMMITTER_DATE: twoDaysAgo });
  advance("second.txt");
  const result = f.run();
  failure(result, "base");
  assert.ok(result.stdout.includes(`stale: origin/dev moved on from merge-base ${old.slice(0, 7)} over a day ago`), result.stdout);
});

test("doctor rejects a common ancestor that was never a fetched dev tip", (t) => {
  const f = fixture(t);
  const old = git(f.build, "rev-parse", "HEAD");
  writeFileSync(join(f.dev, "advance.txt"), "new dev work\n");
  commit(f.dev, "advance.txt");
  git(f.dev, "push", "origin", "dev");
  git(f.build, "fetch", "origin");
  git(f.build, "reflog", "expire", "--expire=all", "refs/remotes/origin/dev");
  const result = f.run();
  failure(result, "base");
  assert.ok(result.stdout.includes(`merge-base ${old.slice(0, 7)}`));
});

test("doctor names missing hook configuration", (t) => {
  const f = fixture(t);
  rmSync(join(f.build, ".codex/hooks.json"));
  const result = f.run();
  failure(result, "hook config");
  assert.match(result.stdout, /✗ hook config: missing \.codex\/hooks.json;/);
});

test("doctor requires a live rejection from the real hook runner", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.build, "scripts/agents/hooks/bash-guard.sh"), "exit 0\n");
  const result = f.run();
  failure(result, "hooks live");
  assert.match(result.stdout, /returned status 0 \(expected 2\)/);
});

test("doctor reports Node below 24 without searching the user's installations", (t) => {
  const f = fixture(t);
  const bin = join(f.directory, "bin");
  const empty = join(f.directory, "empty");
  mkdirSync(bin); mkdirSync(empty);
  executable(join(bin, "node"), "printf 'v22.0.0\\n'");
  failure(f.run([], f.build, { PATH: `${bin}:/usr/bin:/bin`, CLAUDE_NODE_SEARCH_ROOT: empty }, true), "node");
});

for (const kind of ["missing", "real directory", "dangling link", "different shared directory", "shared missing", "shared dangling"]) {
  test(`doctor rejects node_modules: ${kind}`, (t) => {
    const f = fixture(t);
    const modules = join(f.build, "node_modules");
    rmSync(modules);
    if (kind === "real directory") mkdirSync(modules);
    if (kind === "dangling link") symlinkSync(join(f.directory, "missing"), modules);
    if (kind === "shared missing" || kind === "shared dangling") {
      rmSync(join(f.dev, "node_modules"), { recursive: true });
      if (kind === "shared dangling") symlinkSync(join(f.directory, "gone"), join(f.dev, "node_modules"));
    }
    if (kind === "different shared directory" || kind.startsWith("shared ")) {
      const other = join(f.directory, "other_modules");
      mkdirSync(other);
      symlinkSync(other, modules);
    }
    failure(f.run(), "node_modules");
  });
}

test("doctor reports only the first three conflict locations", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.build, "conflict.txt"), `${"<".repeat(7)} ours\n${">".repeat(7)} theirs\n`.repeat(2));
  commit(f.build, "conflict.txt");
  const result = f.run();
  failure(result, "conflicts");
  assert.match(result.stdout, /✗ conflicts: conflict.txt:1 conflict.txt:2 conflict.txt:3; fix:/);
  assert.doesNotMatch(result.stdout, /conflict.txt:4/);
});

test("doctor runs every check after failures and quiet prints only failures and RESULT", (t) => {
  const f = fixture(t);
  rmSync(join(f.build, ".claude/settings.json"));
  rmSync(join(f.build, ".codex/hooks.json"));
  rmSync(join(f.build, "node_modules"));
  const result = f.run(["--quiet"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /missing \.claude\/settings.json \.codex\/hooks.json/);
  assert.deepEqual(result.stdout.trimEnd().split("\n").map(line => line.split(":")[0]), [
    "✗ hook config", "✗ node_modules", "RESULT",
  ]);
  assert.ok(result.stdout.endsWith("RESULT: fail doctor 2 failed: hook config,node_modules\n"));
  assert.equal(result.stderr, "");
});

test("doctor provides help and rejects unknown arguments", (t) => {
  const f = fixture(t);
  for (const flag of ["--help", "-h"]) {
    const result = f.run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: kit doctor \[--quiet\]/);
    assert.doesNotMatch(result.stdout, /RESULT:/);
  }
  const result = f.run(["--unknown"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^Usage: kit doctor/);
  assert.equal(result.stdout, "RESULT: fail doctor unknown argument --unknown\n");
});

function gateFixture(t: { after: (fn: () => void) => void }) {
  const directory = temp(t);
  const bin = join(directory, "bin");
  const commands = join(directory, "commands");
  const capture = join(directory, "capture");
  mkdirSync(bin); mkdirSync(commands);
  for (const cli of ["codex", "claude"]) executable(join(bin, cli), "exit 9");
  executable(join(commands, "doctor"), 'printf "%s\\n%s\\n" "$PWD" "$KIT_ROOT" > "$DOCTOR_CAPTURE"\nprintf "✗ x\\nRESULT: fail doctor 1 failed: x\\n"\nexit 1');
  const brief = join(directory, "brief.md");
  writeFileSync(brief, "test brief\n");
  const run = (root: string, input = brief, env: NodeJS.ProcessEnv = {}) => spawnSync(
    "/bin/bash", [join(repo, "scripts/agents/agent.sh"), "build", root, input, "--out", join(directory, "out")], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIT_COMMANDS_DIR: commands,
        DOCTOR_CAPTURE: capture, ASE_SKIP_DOCTOR: "", ...env },
    },
  );
  return { directory, commands, capture, run };
}

test("agent.sh refuses this kit's worktree and forwards doctor diagnostics", (t) => {
  const f = gateFixture(t);
  // A nested directory still gates at the worktree toplevel.
  const result = f.run(join(repo, "scripts"));
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /✗ x\nRESULT: fail doctor 1 failed: x\nagent.sh: kit doctor failed in /);
  assert.match(result.stderr, /ASE_SKIP_DOCTOR=1 is for tests only/);
  assert.equal(readFileSync(f.capture, "utf8"), `${repo}\n${repo}\n`);
});

test("agent.sh test bypass reaches runner validation without a doctor failure", (t) => {
  const f = gateFixture(t);
  const result = f.run(repo, join(f.directory, "missing.md"), { ASE_SKIP_DOCTOR: "1" });
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /kit doctor/);
});

test("agent.sh silently consumes successful doctor output", (t) => {
  const f = gateFixture(t);
  executable(join(f.commands, "doctor"), 'printf "RESULT: ok doctor 7/7 checks passed\\n"');
  const result = f.run(repo, join(f.directory, "missing.md"));
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /RESULT:|kit doctor/);
});

test("agent.sh skips other repositories and invalid worktree paths", (t) => {
  const f = gateFixture(t);
  const other = join(f.directory, "other");
  mkdirSync(other);
  git(other, "init");
  for (const root of [other, join(f.directory, "missing"), f.directory]) {
    const result = f.run(root, join(f.directory, "missing.md"));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /kit doctor/);
  }
});

test("agent.sh gates a separate checkout of the kit", (t) => {
  const f = gateFixture(t);
  const clone = join(f.directory, "clone");
  mkdirSync(join(clone, "scripts/agents"), { recursive: true });
  git(clone, "init");
  writeFileSync(join(clone, "scripts/agents/kit"), "#!/bin/bash\n");
  const result = f.run(clone, join(f.directory, "missing.md"));
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.match(result.stderr, /agent.sh: kit doctor failed in /);
});
