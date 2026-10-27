import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repo = resolve(".");
const kit = join(repo, "scripts/agents/kit");
const doctor = join(repo, "scripts/agents/kit.d/doctor");
const library = join(repo, "scripts/agents/kit-lib.sh");

function temp(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "kit-doctor-"));
  // A machine-copy fixture is read-only, as kit update leaves it.
  t.after(() => { spawnSync("chmod", ["-R", "u+w", directory]); rmSync(directory, { recursive: true, force: true }); });
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
  writeFileSync(join(main, "scripts/agents/kit.json"), JSON.stringify({ project: "native-site-editor", branches: { land: "dev" },
    devRoot: dev, sharedNodeModules: join(dev, "node_modules") }));
  commit(main, "scripts", ".claude", ".codex");
  git(main, "push", "origin", "HEAD:dev");
  git(main, "fetch", "origin");
  git(main, "worktree", "add", "-b", "dev", dev, "origin/dev");
  git(main, "worktree", "add", "-b", "build/x", build, "origin/dev");
  mkdirSync(join(dev, "node_modules"));
  symlinkSync(join(dev, "node_modules"), join(build, "node_modules"));
  symlinkSync(join(dev, "node_modules"), join(main, "node_modules"));
  // A small command set keeps doctor's help check quick; one test covers the real commands.
  const commands = join(directory, "commands");
  mkdirSync(commands);
  symlinkSync(doctor, join(commands, "doctor"));
  executable(join(commands, "ok"), 'printf "Usage: kit ok\\n"');
  const run = (args: string[] = [], root = build, env: NodeJS.ProcessEnv = {}, direct = false) => spawnSync(
    "/bin/bash", direct ? [doctor, ...args] : [kit, "doctor", ...args], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: main, KIT_LIB: library,
        KIT_COMMANDS_DIR: commands, KIT_GROK: join(directory, "no-grok"), ...env },
    },
  );
  return { directory, main, dev, build, commands, run };
}

function failure(result: ReturnType<typeof spawnSync<string>>, name: string) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.filter(line => line.startsWith("RESULT: ")).length, 1);
  // The kit note shows whenever the kit's own version runs.
  assert.equal(lines.filter(line => !line.startsWith("✓ kit: ")).length, 13, result.stdout);
  assert.ok(lines.some(line => line.startsWith(`✗ ${name}: `) && line.includes("; fix: ")), result.stdout);
  assert.equal(lines.at(-1), `RESULT: fail doctor 1 failed: ${name}`);
  assert.equal(result.stderr, "");
}

test("doctor checks all eleven conditions quickly, notes Grok, and quiet success prints only RESULT", (t) => {
  const f = fixture(t);
  // Git tracks only the executable bit; the rest of the mode follows the umask.
  assert.equal(statSync(doctor).mode & 0o111, 0o111);
  const start = performance.now();
  const result = f.run();
  const elapsed = performance.now() - start;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(elapsed < 2000, `doctor took ${elapsed}ms`);
  const lines = result.stdout.trimEnd().split("\n");
  assert.deepEqual(lines.slice(0, 13).map(line => line.split(":")[0]), [
    "✓ settings", "✓ place", "✓ base", "✓ hook config", "✓ hooks live", "✓ node", "✓ node_modules", "✓ conflicts", "✓ commands", "✓ help", "✓ kit home", "✓ kit", "✗ grok",
  ]);
  assert.equal(lines[0], "✓ settings: scripts/agents/kit.json (native-site-editor, lands on dev)");
  assert.equal(lines[8], `✓ commands: 2 in ${f.commands} (KIT_COMMANDS_DIR)`);
  assert.equal(lines[9], "✓ help: 2 commands answer --help");
  assert.equal(lines[10], `✓ kit home: a copy of ${join(repo, "scripts/agents")} runs kit version for a project with only its settings and front door`);
  // The kit's commit and age beside the project's is a note, not a counted check.
  assert.match(lines[11], new RegExp(`^✓ kit: commit [0-9a-f]{7,} \\(checkout ${repo}, commit \\d+ \\w+ old\\); project [0-9a-f]{7,}$`));
  assert.equal(lines[12], "✗ grok: not installed (optional reviewer); fix: install the grok CLI for Grok reviews");
  assert.equal(lines.length, 14);
  assert.equal(lines[13], "RESULT: ok doctor 11/11 checks passed");
  assert.equal(result.stderr, "");
  const quiet = f.run(["--quiet"]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stdout, "RESULT: ok doctor 11/11 checks passed\n");
  assert.equal(quiet.stderr, "");
});

test("doctor reports a logged-in or logged-out Grok CLI without failing", (t) => {
  const f = fixture(t);
  const grok = join(f.directory, "grok");
  executable(grok, 'printf "You are logged in with grok.com.\\n\\nDefault model: grok-4.7\\n"');
  const ready = f.run([], f.build, { KIT_GROK: grok });
  assert.equal(ready.status, 0, ready.stdout + ready.stderr);
  assert.ok(ready.stdout.includes("✓ grok: installed and logged in (optional reviewer)\n"), ready.stdout);
  executable(grok, 'printf "You are not logged in.\\n"; exit 1');
  const signedOut = f.run([], f.build, { KIT_GROK: grok });
  assert.equal(signedOut.status, 0, signedOut.stdout + signedOut.stderr);
  assert.ok(signedOut.stdout.includes("✗ grok: not logged in (optional reviewer); fix: grok login\n"), signedOut.stdout);
  assert.equal(f.run(["--quiet"], f.build, { KIT_GROK: grok }).stdout, "RESULT: ok doctor 11/11 checks passed\n");
  // A hung, failing or reworded CLI is not mistaken for a logged-out one.
  executable(grok, 'printf "Logged in as lex\\n"');
  const reworded = f.run([], f.build, { KIT_GROK: grok });
  assert.equal(reworded.status, 0, reworded.stdout + reworded.stderr);
  assert.ok(reworded.stdout.includes("✗ grok: unrecognised 'grok models' output (optional reviewer); fix: run grok models and check its login line\n"), reworded.stdout);
  executable(grok, "sleep 5");
  const hung = f.run([], f.build, { KIT_GROK: grok, KIT_GROK_TIMEOUT: "0.2" });
  assert.equal(hung.status, 0, hung.stdout + hung.stderr);
  assert.ok(hung.stdout.includes("✗ grok: 'grok models' timed out (optional reviewer); fix: check the network or the grok CLI\n"), hung.stdout);
  executable(grok, 'printf "error: connection refused\\n" >&2; exit 3');
  const offline = f.run([], f.build, { KIT_GROK: grok });
  assert.equal(offline.status, 0, offline.stdout + offline.stderr);
  assert.ok(offline.stdout.includes("✗ grok: 'grok models' failed with status 3 (optional reviewer); fix: check the network or the grok CLI\n"), offline.stdout);
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
  // GitHub no longer has dev either, so doctor's own fetch cannot bring it back.
  git(join(f.directory, "origin.git"), "branch", "-m", "dev", "old-dev");
  git(f.build, "update-ref", "-d", "refs/remotes/origin/dev");
  const result = f.run();
  failure(result, "base");
  assert.match(result.stdout, /missing origin\/dev \(fetch failed; judged the last fetched origin\/dev\); fix: git fetch origin/);
});

test("doctor fetches the land branch before judging the base", (t) => {
  const f = fixture(t);
  // Another clone lands a commit on GitHub; this clone has not fetched it.
  const other = join(f.directory, "other");
  git(f.directory, "clone", "-q", "--branch", "dev", join(f.directory, "origin.git"), other);
  writeFileSync(join(other, "landed.txt"), "landed elsewhere\n");
  commit(other, "landed.txt");
  git(other, "push", "-q", "origin", "dev");
  const result = f.run();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /✓ base: 1 commits behind origin\/dev; rebase before landing\n/);
  assert.equal(git(f.build, "rev-parse", "origin/dev"), git(other, "rev-parse", "HEAD"));
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

// techies-playground's settings (research 04): lands on main, its own node_modules or none, work in the main checkout.
function playground(t: { after: (fn: () => void) => void }, extra: Record<string, unknown> = {}, remote = true) {
  const directory = temp(t), root = join(directory, "techies-playground");
  if (remote) {
    git(directory, "init", "-q", "--bare", "--initial-branch=main", "origin.git");
    git(directory, "clone", "-q", join(directory, "origin.git"), root);
  } else git(directory, "init", "-q", "--initial-branch=main", root);
  mkdirSync(join(root, "scripts/agents/hooks"), { recursive: true });
  for (const name of ["run.sh", "bash-guard.sh"]) copyFileSync(join(repo, "scripts/agents/hooks", name), join(root, "scripts/agents/hooks", name));
  mkdirSync(join(root, ".claude")); mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".claude/settings.json"), "{}\n");
  writeFileSync(join(root, ".codex/hooks.json"), "{}\n");
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "techies-playground", mainRoot: root,
    branches: { land: "main", release: "main", ci: "main" }, checks: { test: "npm test" }, ...extra }));
  commit(root, "scripts", ".claude", ".codex");
  if (remote) git(root, "push", "-q", "origin", "main");
  const commands = join(directory, "commands");
  mkdirSync(commands);
  symlinkSync(doctor, join(commands, "doctor"));
  const run = (env: NodeJS.ProcessEnv = {}) => spawnSync("/bin/bash", [kit, "doctor"], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: "", KIT_LIB: library, KIT_COMMANDS_DIR: commands, KIT_GROK: join(directory, "no-grok"), ...env },
  });
  return { directory, root, run };
}

test("doctor passes in the main checkout with allowMainCheckout and skips node_modules without sharedNodeModules", (t) => {
  const refused = playground(t).run();
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /✗ place: main or dev worktree/);
  const f = playground(t, { allowMainCheckout: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`✓ settings: scripts/agents/kit.json (techies-playground, lands on main)\n`), result.stdout);
  assert.ok(result.stdout.includes(`✓ place: ${f.root} (main checkout; allowMainCheckout)\n`), result.stdout);
  assert.match(result.stdout, /✓ base: main in the main checkout, 0 commits behind origin\/main\n/);
  assert.match(result.stdout, /✓ node_modules: skipped \(no sharedNodeModules in scripts\/agents\/kit\.json\)\n/);
  assert.match(result.stdout, /RESULT: ok doctor 11\/11 checks passed\n$/);
});

test("in an allowMainCheckout main checkout doctor counts commits behind on the land branch and judges other branches by merge-base", (t) => {
  const f = playground(t, { allowMainCheckout: true });
  const other = join(f.directory, "other");
  git(f.directory, "clone", "-q", join(f.directory, "origin.git"), other);
  for (const name of ["a.txt", "b.txt"]) { writeFileSync(join(other, name), `${name}\n`); commit(other, name); }
  git(other, "push", "-q", "origin", "main");
  const behind = f.run();
  assert.equal(behind.status, 0, behind.stdout);
  assert.match(behind.stdout, /^✓ base: main in the main checkout, 2 commits behind origin\/main$/m);
  git(f.root, "merge", "-q", "--ff-only", "origin/main");
  git(f.root, "checkout", "-q", "-b", "feature");
  const feature = f.run();
  assert.equal(feature.status, 0, feature.stdout);
  assert.match(feature.stdout, /^✓ base: contains origin\/main [0-9a-f]{7}$/m);
  git(f.root, "checkout", "-q", "--orphan", "unrelated");
  commit(f.root, "scripts");
  const unrelated = f.run();
  assert.match(unrelated.stdout, /^✗ base: not based on origin\/main \(merge-base none\)/m);
});

test("doctor adds the project's checks.doctor lines and the playwright module, each counted", (t) => {
  const f = playground(t, { allowMainCheckout: true, playwright: "vendor/playwright/index.mjs",
    checks: { test: "npm test", doctor: ["printf 'Python 3.12.3\\n'", "printf 'no browser\\n' >&2; exit 3"] } });
  const result = f.run();
  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stdout.includes(`✗ playwright: ${f.root}/vendor/playwright/index.mjs is missing; fix: install Playwright there`), result.stdout);
  assert.ok(result.stdout.includes("✓ printf 'Python 3.12.3\\n': Python 3.12.3\n"), result.stdout);
  assert.ok(result.stdout.includes(`✗ printf 'no browser\\n' >&2; exit 3: exit 3: no browser; fix: see "checks.doctor" in scripts/agents/kit.json\n`), result.stdout);
  assert.match(result.stdout, /RESULT: fail doctor 2 failed: playwright,printf 'no browser\\n' >&2; exit 3\n$/);
  mkdirSync(join(f.root, "vendor/playwright"), { recursive: true });
  writeFileSync(join(f.root, "vendor/playwright/index.mjs"), "export {};\n");
  const found = f.run();
  assert.ok(found.stdout.includes(`✓ playwright: ${f.root}/vendor/playwright/index.mjs\n`), found.stdout);
  // The module env override wins over the setting.
  const moved = f.run({ KIT_PLAYWRIGHT_MODULE: join(f.directory, "missing.mjs") });
  assert.ok(moved.stdout.includes(`✗ playwright: ${join(f.directory, "missing.mjs")} is missing`), moved.stdout);
  const passing = playground(t, { allowMainCheckout: true, checks: { test: "npm test", doctor: "node --version" } }).run();
  assert.equal(passing.status, 0, passing.stdout);
  assert.match(passing.stdout, /✓ node --version: v\d+/);
  assert.match(passing.stdout, /RESULT: ok doctor 12\/12 checks passed\n$/);
});

test("the doctor RESULT counts every line it checked, but not the optional grok and kit notes", (t) => {
  const f = playground(t, { allowMainCheckout: true, playwright: "vendor/playwright", checks: { doctor: "true" } });
  mkdirSync(join(f.root, "vendor/playwright"), { recursive: true });
  const grok = join(f.directory, "grok");
  executable(grok, 'printf "You are logged in with grok.com.\\n"');
  const result = f.run({ KIT_GROK: grok });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^✓ grok: installed and logged in \(optional reviewer\)$/m);
  assert.match(result.stdout, /^✓ kit: commit /m);
  assert.equal(result.stdout.split("\n").filter(line => line.startsWith("✓ ")).length, 15);
  assert.match(result.stdout, /RESULT: ok doctor 13\/13 checks passed\n$/);
});

test("a checks.doctor command that hangs fails as timed out", (t) => {
  const result = playground(t, { allowMainCheckout: true, checks: { doctor: "sleep 5" } }).run({ KIT_DOCTOR_CHECK_TIMEOUT: "0.3" });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /^✗ sleep 5: timed out; fix: see "checks\.doctor" in scripts\/agents\/kit\.json$/m);
});

test("doctor notes a failed fetch on a passing base and judges the last fetched tip", (t) => {
  const f = fixture(t);
  git(f.build, "remote", "set-url", "origin", join(f.directory, "unreachable.git"));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /^✓ base: contains origin\/dev [0-9a-f]{7} \(fetch failed; judged the last fetched origin\/dev\)$/m);
});

test("doctor says no GitHub repo for a repo without a remote and still passes", (t) => {
  const result = playground(t, { allowMainCheckout: true }, false).run();
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /✓ base: no GitHub repo \(no origin remote\); nothing to fetch\n/);
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

test("doctor names each command whose --help fails, prints no usage or hangs", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "broken"), 'printf "SyntaxError: missing import\\n" >&2; exit 1');
  executable(join(f.commands, "silent"), "exit 0");
  executable(join(f.commands, "stuck"), "sleep 5");
  const result = f.run([], f.build, { KIT_HELP_TIMEOUT: "0.3" });
  failure(result, "help");
  assert.ok(result.stdout.includes("✗ help: broken (exit 1), silent (no usage), stuck (timed out); fix: run scripts/agents/kit <command> --help and repair it\n"), result.stdout);
});

test("doctor kills a help that ignores SIGTERM and names it as timed out", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "deaf"), 'trap "" TERM; while :; do sleep 0.1; done');
  const start = performance.now();
  const result = f.run([], f.build, { KIT_HELP_TIMEOUT: "0.3" });
  const elapsed = performance.now() - start;
  failure(result, "help");
  assert.ok(elapsed < 4000, `doctor took ${elapsed}ms`);
  assert.ok(result.stdout.includes("✗ help: deaf (timed out); fix:"), result.stdout);
});

test("doctor --quiet, the mode agent.sh gates on, still fails and names a broken --help", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "broken"), 'printf "SyntaxError: missing import\\n" >&2; exit 1');
  const result = f.run(["--quiet"], f.build, { KIT_HELP_TIMEOUT: "0.3" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "✗ help: broken (exit 1); fix: run scripts/agents/kit <command> --help and repair it\nRESULT: fail doctor 1 failed: help\n");
  assert.equal(result.stderr, "");
});

test("KIT_DOCTOR_SKIP=help turns a broken --help into a problem line and skips only that check", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "broken"), 'printf "SyntaxError: missing import\\n" >&2; exit 1');
  const problem = "problem: help: broken (exit 1); fix: run scripts/agents/kit <command> --help and repair it\n";
  const quiet = f.run(["--quiet"], f.build, { KIT_HELP_TIMEOUT: "0.3", KIT_DOCTOR_SKIP: "help" });
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.equal(quiet.stdout, `${problem}RESULT: ok doctor 10/10 checks passed; skipped help (KIT_DOCTOR_SKIP)\n`);
  assert.equal(quiet.stderr, "");
  // Other checks still run and fail; no other name is honoured.
  rmSync(join(f.build, ".codex/hooks.json"));
  const other = f.run(["--quiet"], f.build, { KIT_HELP_TIMEOUT: "0.3", KIT_DOCTOR_SKIP: "hook config,help" });
  assert.equal(other.status, 1, other.stdout + other.stderr);
  assert.ok(other.stdout.includes(problem), other.stdout);
  assert.ok(other.stdout.endsWith("RESULT: fail doctor 1 failed: hook config\n"), other.stdout);
});

test("KIT_DOCTOR_SKIP=help keeps a working help check counted", (t) => {
  const f = fixture(t);
  const result = f.run(["--quiet"], f.build, { KIT_DOCTOR_SKIP: "help" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, "RESULT: ok doctor 11/11 checks passed\n");
});

test("doctor fails when a copy of the kit named by KIT_HOME cannot run kit version", (t) => {
  const f = fixture(t);
  // A kit whose front door still needs something only the project has fails from its copy.
  const home = join(f.directory, "kit-home");
  mkdirSync(home);
  // The temporary project's front door is the copy's: it gets the copy as KIT_HOME and the project as KIT_ROOT.
  executable(join(home, "kit"), '[[ -f $KIT_HOME/kit && -f $KIT_ROOT/scripts/agents/kit.json && $KIT_ROOT != "$KIT_HOME" ]] || exit 3; printf "RESULT: fail helper missing\\n"; exit 1');
  // Run doctor directly: the front door would refuse this KIT_HOME itself.
  const result = f.run([], f.build, { KIT_HOME: home }, true);
  failure(result, "kit home");
  assert.ok(result.stdout.includes(`✗ kit home: a copy of ${home} fails kit version: RESULT: fail helper missing; fix: reach shared helpers through KIT_HOME, not scripts/agents/\n`), result.stdout);
});

test("doctor fails the help check when the command folder has no commands", (t) => {
  const f = fixture(t);
  const empty = join(f.directory, "no-commands");
  mkdirSync(empty);
  writeFileSync(join(empty, "readme"), "not a command\n");
  // Run doctor directly: the kit front door reads the same empty folder.
  const result = f.run([], f.build, { KIT_COMMANDS_DIR: empty }, true);
  failure(result, "help");
  assert.ok(result.stdout.includes(`✗ help: no commands in ${empty}; fix: restore scripts/agents/kit.d or the "commands" folder\n`), result.stdout);
});

test("doctor passes the help check when every real shared and project command answers --help", (t) => {
  const f = fixture(t);
  const count = (folder: string) => readdirSync(join(repo, folder)).filter(name => !/^[._]/.test(name) && statSync(join(repo, folder, name)).mode & 0o111).length;
  const shared = count("scripts/agents/kit.d"), own = count("scripts/agents/project.d");
  // Some helps read this checkout's files (shots runs its CLI), so check from the repository itself.
  // Under the fixture's 10 s spawn limit, a slow help is named rather than cut off.
  // Through the front door, so both the kit and doctor find the commands by their default folders.
  const result = f.run([], repo, { KIT_COMMANDS_DIR: undefined, KIT_HELP_TIMEOUT: "5" });
  assert.ok(result.stdout.includes(`✓ commands: ${shared} shared, ${own} in scripts/agents/project.d\n`), result.stdout);
  assert.ok(result.stdout.includes(`✓ help: ${shared + own} commands answer --help\n`), result.stdout);
});

test("doctor fails a project command that takes a shared name, naming both files", (t) => {
  const f = fixture(t);
  // Without KIT_COMMANDS_DIR the shared folder is the one doctor sits in, here the fixture's command folder.
  const own = join(f.build, "own");
  mkdirSync(own);
  executable(join(own, "ok.sh"), 'printf "Usage: kit ok (project)\\n"');
  executable(join(own, "mine"), 'printf "Usage: kit mine\\n"');
  writeFileSync(join(f.build, "scripts/agents/kit.json"), JSON.stringify({ project: "native-site-editor", branches: { land: "dev" },
    devRoot: f.dev, sharedNodeModules: join(f.dev, "node_modules"), commands: "own" }));
  const direct = (root = f.build) => spawnSync("/bin/bash", [join(f.commands, "doctor")], {
    cwd: root, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: f.main, KIT_LIB: library, KIT_COMMANDS_DIR: undefined, KIT_GROK: join(f.directory, "no-grok") },
  });
  const clash = direct();
  failure(clash, "commands");
  assert.ok(clash.stdout.includes(`✗ commands: ok in both ${join(f.commands, "ok")} and ${join(own, "ok.sh")}; fix: rename the project command\n`), clash.stdout);
  rmSync(join(own, "ok.sh"));
  const clean = direct();
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /^✓ commands: 2 shared, 1 in own$/m);
  assert.match(clean.stdout, /^✓ help: 3 commands answer --help$/m);
  rmSync(own, { recursive: true });
  const missing = direct();
  failure(missing, "commands");
  assert.ok(missing.stdout.includes(`✗ commands: no folder ${own}; fix: create it or fix "commands" in scripts/agents/kit.json\n`), missing.stdout);
  // An old "commands" naming the shared folder is said plainly, not as a clash of every command with itself.
  writeFileSync(join(f.build, "scripts/agents/kit.json"), JSON.stringify({ project: "native-site-editor", branches: { land: "dev" },
    devRoot: f.dev, sharedNodeModules: join(f.dev, "node_modules"), commands: f.commands }));
  const shared = direct();
  failure(shared, "commands");
  assert.ok(shared.stdout.includes(`✗ commands: "commands" names the shared folder ${f.commands}; fix: point "commands" in scripts/agents/kit.json at the project's own folder\n`), shared.stdout);
  assert.match(shared.stdout, /^✓ help: 2 commands answer --help$/m);
});

test("doctor reports only the first three conflict locations", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.build, "conflict.txt"), `${"<".repeat(7)} ours\n${">".repeat(7)} theirs\n`.repeat(2));
  commit(f.build, "conflict.txt");
  const result = f.run();
  failure(result, "conflicts");
  assert.match(result.stdout, /✗ conflicts: conflict.txt:1 conflict.txt:2 conflict.txt:3; fix:/);
  assert.doesNotMatch(result.stdout, /conflict.txt:4/);
});

test("doctor fails when the hooks cannot reach a kit: the hook launcher's warning, not silence", (t) => {
  const f = fixture(t);
  copyFileSync(join(repo, "scripts/agents/launcher/hooks-run.sh"), join(f.build, "scripts/agents/hooks/run.sh"));
  // No machine copy and no cache clone; the KIT_HOME doctor itself runs on does not reach the probe.
  const result = f.run([], f.build, { XDG_DATA_HOME: join(f.directory, "data"), XDG_CACHE_HOME: join(f.directory, "cache"),
    KIT_HOME: join(repo, "scripts/agents") });
  failure(result, "hooks live");
  assert.ok(result.stdout.includes("✗ hooks live: hooks cannot reach a kit (Agent Kit not found); fix: run scripts/agents/kit update to fill the machine copy\n"), result.stdout);
});

test("doctor warns, without failing, on a machine copy two days after its last kit update", (t) => {
  const f = fixture(t);
  const data = join(f.directory, "data"), sha = "0123456789abcdef0123456789abcdef01234567";
  const home = join(data, "agent-kit", sha);
  cpSync(join(repo, "scripts/agents"), home, { recursive: true, filter: (source) => source !== join(repo, "scripts/agents/project.d") });
  writeFileSync(join(data, "agent-kit/updated"), `${Math.floor(Date.now() / 1000) - 2 * 86400 - 60}\n`);
  // A machine copy is read-only; doctor's own copy of it must still clean up.
  spawnSync("chmod", ["-R", "a-w", home]);
  const env = { XDG_DATA_HOME: data, KIT_HOME: home };
  const result = f.run([], f.build, env);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const project = git(f.build, "rev-parse", "--short", "HEAD");
  assert.ok(result.stdout.includes(`✓ kit home: a copy of ${home} runs kit version`), result.stdout);
  assert.ok(result.stdout.includes(`✗ kit: commit 0123456 (machine copy, updated 2 days ago); project ${project}; ` +
    "kit not updated for 2 days; fix: run scripts/agents/kit update\n"), result.stdout);
  assert.ok(result.stdout.endsWith("RESULT: ok doctor 11/11 checks passed; warning: kit not updated for 2 days\n"), result.stdout);
  // Quiet still shows the warning; a fresh copy shows nothing extra.
  assert.equal(f.run(["--quiet"], f.build, env).stdout, `✗ kit: commit 0123456 (machine copy, updated 2 days ago); project ${project}; ` +
    "kit not updated for 2 days; fix: run scripts/agents/kit update\nRESULT: ok doctor 11/11 checks passed; warning: kit not updated for 2 days\n");
  spawnSync("chmod", ["u+w", join(data, "agent-kit")]);
  writeFileSync(join(data, "agent-kit/updated"), `${Math.floor(Date.now() / 1000) - 3 * 3600}\n`);
  const fresh = f.run([], f.build, env);
  assert.equal(fresh.status, 0, fresh.stdout + fresh.stderr);
  assert.ok(fresh.stdout.includes(`✓ kit: commit 0123456 (machine copy, updated 3 hours ago); project ${project}\n`), fresh.stdout);
  assert.equal(f.run(["--quiet"], f.build, env).stdout, "RESULT: ok doctor 11/11 checks passed\n");
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

test("a broken --help stops agent.sh review and kit doctor but not agent.sh build, which names it", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "broken"), 'printf "SyntaxError: missing import\\n" >&2; exit 1');
  // A front door marks the fixture worktree as a kit checkout, so agent.sh gates it.
  executable(join(f.build, "scripts/agents/kit"), "exit 0");
  const env = { ...process.env, KIT_MAIN_ROOT: f.main, KIT_LIB: library, KIT_COMMANDS_DIR: f.commands,
    KIT_GROK: join(f.directory, "no-grok"), KIT_HELP_TIMEOUT: "0.3", ASE_SKIP_DOCTOR: "", KIT_DOCTOR_SKIP: "" };
  const agent = (...args: string[]) => spawnSync("/bin/bash", [join(repo, "scripts/agents/agent.sh"), ...args], {
    cwd: f.directory, encoding: "utf8", timeout: 10_000, env,
  });
  const missing = join(f.directory, "missing.md");
  const problem = "problem: help: broken (exit 1); fix: run scripts/agents/kit <command> --help and repair it\n";
  const build = agent("build", f.build, missing, "--out", join(f.directory, "out-build"));
  // Past the gate the runner rejects the missing brief (exit 2).
  assert.equal(build.status, 2, build.stdout + build.stderr);
  assert.ok(build.stderr.startsWith(`${problem}agent.sh: building in ${f.build} despite the problem above; the builder should repair it\n`), build.stderr);
  assert.doesNotMatch(build.stderr, /kit doctor failed/);
  const review = agent("review", f.build, missing, "--out", join(f.directory, "out-review"));
  assert.equal(review.status, 3, review.stdout + review.stderr);
  assert.match(review.stderr, /^✗ help: broken \(exit 1\); fix: .*\nRESULT: fail doctor 1 failed: help\nagent.sh: kit doctor failed in /);
  // A KIT_DOCTOR_SKIP from the caller does not reach a review's gate.
  const forced = spawnSync("/bin/bash", [join(repo, "scripts/agents/agent.sh"), "review", f.build, missing], {
    cwd: f.directory, encoding: "utf8", timeout: 10_000, env: { ...env, KIT_DOCTOR_SKIP: "help" },
  });
  assert.equal(forced.status, 3, forced.stdout + forced.stderr);
  // A resumed run gates as the kind it recorded; a status.json without a kind (an older runner) gets the full gate.
  for (const kind of ["build", "review", undefined]) {
    const out = join(f.directory, `resume-${kind ?? "no-kind"}`);
    mkdirSync(out);
    writeFileSync(join(out, "status.json"), JSON.stringify({ worktree: f.build, kind }));
    const resumed = agent("--resume", out);
    if (kind === "build") {
      // Past the gate the runner refuses a status.json with no session (exit 1).
      assert.equal(resumed.status, 1, resumed.stderr);
      assert.ok(resumed.stderr.startsWith(`${problem}agent.sh: building in ${f.build} despite the problem above; the builder should repair it\n`), resumed.stderr);
      assert.match(resumed.stderr, /no session id recorded/);
    } else {
      assert.equal(resumed.status, 3, resumed.stderr);
      assert.match(resumed.stderr, /^✗ help: broken/);
    }
  }
  // An unreadable status.json stops the resume before any gate.
  const broken = join(f.directory, "resume-broken");
  mkdirSync(broken);
  writeFileSync(join(broken, "status.json"), "{");
  const unreadable = agent("--resume", broken);
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.match(unreadable.stderr, /SyntaxError/);
  assert.doesNotMatch(unreadable.stderr, /building in/);
  // A status.json without a worktree gates nothing and the runner refuses it.
  writeFileSync(join(broken, "status.json"), JSON.stringify({ kind: "build" }));
  const nowhere = agent("--resume", broken);
  assert.notEqual(nowhere.status, 0, nowhere.stderr);
  assert.doesNotMatch(nowhere.stderr, /building in|kit doctor/);
  const doctor = f.run(["--quiet"], f.build, { KIT_HELP_TIMEOUT: "0.3" });
  assert.equal(doctor.status, 1, doctor.stdout + doctor.stderr);
  assert.ok(doctor.stdout.endsWith("RESULT: fail doctor 1 failed: help\n"), doctor.stdout);
  // The skip covers only the help: a build with another failing check is still refused.
  rmSync(join(f.build, ".codex/hooks.json"));
  const refused = agent("build", f.build, missing, "--out", join(f.directory, "out-refused"));
  assert.equal(refused.status, 3, refused.stdout + refused.stderr);
  assert.match(refused.stderr, /RESULT: fail doctor 1 failed: hook config\n/);
  assert.doesNotMatch(refused.stderr, /building in/);
});

test("agent.sh hands the builder no KIT_DOCTOR_SKIP, so its own kit doctor sees a broken help", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "broken"), "exit 1");
  executable(join(f.build, "scripts/agents/kit"), "exit 0");
  const bin = join(f.directory, "bin");
  const seen = join(f.directory, "seen");
  mkdirSync(bin);
  executable(join(bin, "claude"), `printf '%s\\n' "\${KIT_DOCTOR_SKIP-unset}" > ${JSON.stringify(seen)}; exit 1`);
  const brief = join(f.directory, "brief.md");
  writeFileSync(brief, "test brief\n");
  const result = spawnSync("/bin/bash", [join(repo, "scripts/agents/agent.sh"), "build", f.build, brief, "--cli", "claude", "--out", join(f.directory, "out")], {
    cwd: f.directory, encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIT_MAIN_ROOT: f.main, KIT_LIB: library, KIT_COMMANDS_DIR: f.commands,
      KIT_GROK: join(f.directory, "no-grok"), KIT_HELP_TIMEOUT: "0.3", ASE_SKIP_DOCTOR: "", KIT_DOCTOR_SKIP: "help" },
  });
  assert.match(result.stderr, /agent.sh: building in /);
  assert.equal(readFileSync(seen, "utf8"), "unset\n", result.stdout + result.stderr);
});

test("a broken version command, which the kit home check runs, does not stop agent.sh build either", (t) => {
  const f = fixture(t);
  executable(join(f.commands, "version"), 'printf "SyntaxError: missing import\\n" >&2; exit 1');
  executable(join(f.build, "scripts/agents/kit"), "exit 0");
  // The kit home check copies KIT_HOME and runs its version; this home's version fails as the broken one would.
  const home = join(f.directory, "kit-home");
  mkdirSync(home);
  copyFileSync(library, join(home, "kit-lib.sh"));
  executable(join(home, "kit"), 'printf "RESULT: fail version broken\\n"; exit 1');
  const env = { ...process.env, KIT_MAIN_ROOT: f.main, KIT_LIB: library, KIT_COMMANDS_DIR: f.commands, KIT_HOME: home,
    KIT_GROK: join(f.directory, "no-grok"), KIT_HELP_TIMEOUT: "0.3", ASE_SKIP_DOCTOR: "", KIT_DOCTOR_SKIP: "" };
  const agent = (kind: string) => spawnSync("/bin/bash", [join(repo, "scripts/agents/agent.sh"), kind, f.build, join(f.directory, "missing.md")], {
    cwd: f.directory, encoding: "utf8", timeout: 10_000, env,
  });
  const build = agent("build");
  assert.equal(build.status, 2, build.stdout + build.stderr);
  assert.ok(build.stderr.startsWith("problem: help: version (exit 1); fix: run scripts/agents/kit <command> --help and repair it\n" +
    `problem: kit home: a copy of ${home} fails kit version: RESULT: fail version broken; fix: repair kit version (its --help is broken too)\n` +
    `agent.sh: building in ${f.build} despite the problem above; the builder should repair it\n`), build.stderr);
  const review = agent("review");
  assert.equal(review.status, 3, review.stdout + review.stderr);
  assert.match(review.stderr, /RESULT: fail doctor 2 failed: help,kit home\n/);
  const skipped = f.run(["--quiet"], f.build, { KIT_HOME: home, KIT_HELP_TIMEOUT: "0.3", KIT_DOCTOR_SKIP: "help" });
  assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
  assert.ok(skipped.stdout.endsWith("RESULT: ok doctor 9/9 checks passed; skipped help, kit home (KIT_DOCTOR_SKIP)\n"), skipped.stdout);
  // Another command's broken help leaves a failing kit home check failing.
  rmSync(join(f.commands, "version"));
  executable(join(f.commands, "other"), "exit 1");
  const other = agent("build");
  assert.equal(other.status, 3, other.stdout + other.stderr);
  assert.match(other.stderr, /RESULT: fail doctor 1 failed: kit home\n/);
});

test("the kit home check follows the help skip only for a version that fails, not one without usage or a home that cannot be copied", (t) => {
  const f = fixture(t);
  const missingHome = join(f.directory, "no-kit-home");
  // Run doctor directly: the front door refuses a missing KIT_HOME itself.
  const run = () => f.run(["--quiet"], f.build, { KIT_HOME: missingHome, KIT_HELP_TIMEOUT: "0.3", KIT_DOCTOR_SKIP: "help" }, true);
  executable(join(f.commands, "version"), 'printf "version help\\n"');
  const unused = run();
  assert.equal(unused.status, 1, unused.stdout + unused.stderr);
  assert.ok(unused.stdout.startsWith("problem: help: version (no usage); fix:"), unused.stdout);
  assert.ok(unused.stdout.includes(`✗ kit home: a copy of ${missingHome} fails kit version: cannot copy ${missingHome}; fix:`), unused.stdout);
  assert.ok(unused.stdout.endsWith("RESULT: fail doctor 1 failed: kit home\n"), unused.stdout);
  executable(join(f.commands, "version"), "exit 1");
  const uncopied = run();
  assert.equal(uncopied.status, 1, uncopied.stdout + uncopied.stderr);
  assert.ok(uncopied.stdout.startsWith("problem: help: version (exit 1); fix:"), uncopied.stdout);
  assert.ok(uncopied.stdout.endsWith("RESULT: fail doctor 1 failed: kit home\n"), uncopied.stdout);
});
