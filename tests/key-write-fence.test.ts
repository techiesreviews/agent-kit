import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapWorks, checkLock, keyGuard, openLocalPushTarget, resetBwrapProbe, runProgram } from "../key-guard.mjs";
import { kitEnv } from "./support/kit-env.ts";

const noBwrap = bwrapWorks() === null ? false : "bubblewrap cannot run here";

function workspace(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-write-fence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), worktree = join(home, "work"), common = join(dir, "git");
  for (const folder of [home, worktree, common]) mkdirSync(folder, { recursive: true });
  const env = { ...kitEnv(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIT_OUTER_LOCK"]) delete env[name];
  return { dir, home, worktree, common, env };
}

function fixture(t: TestContext) {
  const { dir, home, worktree, common, env } = workspace(t);
  const guard = keyGuard({ cli: "claude", kind: "build", worktree, common, env });
  t.after(() => guard.close());
  const run = (source: string) => {
    const [command, args] = guard.wrap(process.execPath, ["-e", source]);
    const childEnv = { ...env, ...guard.env };
    for (const key of Object.keys(childEnv)) if (childEnv[key] === undefined) delete childEnv[key];
    const result = spawnSync(command, args, { cwd: worktree, env: childEnv, encoding: "utf8", timeout: 60_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim();
  };
  return { dir, home, worktree, common, env, guard, run };
}

for (const name of [".gitconfig", ".bashrc", ".local/bin/helper", ".profile", ".config/systemd/user/helper.service", ".ssh/config"]) {
  test(`TOOLS-397: locked build refuses to replace or plant ~/${name}`, { skip: noBwrap }, t => {
    const { home, run } = fixture(t);
    const file = join(home, name);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, "original\n");
    const source = `const fs = require('node:fs');
      for (const file of ${JSON.stringify([file, file + ".new"])}) {
        try { fs.writeFileSync(file, 'planted'); console.log('wrote'); }
        catch (error) { console.log(error.code); }
      }`;
    assert.match(run(source), /^(EROFS|EACCES|ENOENT)\n(EROFS|EACCES|ENOENT)$/);
    assert.equal(readFileSync(file, "utf8"), "original\n");
  });
}

test("TOOLS-397: work and Git stay writable; links and temporary paths cannot write home setup", { skip: noBwrap }, t => {
  const { dir, home, worktree, common, run } = fixture(t);
  writeFileSync(join(home, ".bashrc"), "original\n");
  symlinkSync(home, join(worktree, "home-link"));
  assert.equal(run(`const fs = require('node:fs');
    fs.writeFileSync('built', 'build passed');
    fs.writeFileSync(${JSON.stringify(join(common, "built"))}, 'git passed');
    for (const file of ['home-link/.bashrc', ${JSON.stringify(join(dir, "foreign-temp"))}]) {
      try { fs.writeFileSync(file, 'planted'); console.log('wrote'); } catch (error) { console.log(error.code); }
    }
    fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'own-temp'), 'temp passed');
    console.log('build passed');`), "EROFS\nEROFS\nbuild passed");
  assert.equal(readFileSync(join(worktree, "built"), "utf8"), "build passed");
  assert.equal(readFileSync(join(common, "built"), "utf8"), "git passed");
});

test("TOOLS-397: Claude keeps private writable state and cache without changing its home settings", { skip: noBwrap }, t => {
  const { home, run } = fixture(t);
  const original = join(home, ".claude/settings.json");
  mkdirSync(resolve(original, ".."), { recursive: true });
  writeFileSync(original, '{"original":true}');
  assert.equal(run(`const fs = require('node:fs'), path = require('node:path');
    for (const folder of [process.env.CLAUDE_CONFIG_DIR, process.env.XDG_CACHE_HOME]) {
      fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'state'), 'ok');
    }
    console.log('state passed');`), "state passed");
  assert.equal(readFileSync(original, "utf8"), '{"original":true}');
});

test("TOOLS-397: kit pr checks also refuse writes to home setup", { skip: noBwrap }, t => {
  const { home, worktree, common, env } = fixture(t);
  const file = join(home, ".profile");
  writeFileSync(file, "original\n");
  const lock = checkLock({ worktree, common, env });
  t.after(() => lock.close?.());
  const [command, args] = lock.wrap(process.execPath, ["-e", `try { require('node:fs').writeFileSync(${JSON.stringify(file)}, 'planted'); console.log('wrote'); } catch (error) { console.log(error.code); }`]);
  const result = spawnSync(command, args, { cwd: worktree, env: { ...env, ...lock.env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "EROFS");
  assert.equal(readFileSync(file, "utf8"), "original\n");
});

test("TOOLS-397: replacing the run state after setup cannot turn HOME into a writable mount", { skip: noBwrap }, t => {
  const { home, worktree, common, env } = fixture(t);
  const state = join(worktree, "cli-state");
  const guard = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state });
  t.after(() => guard.close());
  const file = join(home, ".profile");
  writeFileSync(file, "original\n");
  rmSync(state, { recursive: true, force: true });
  symlinkSync(home, state);
  const [command, args] = guard.wrap(process.execPath, ["-e", `try { require('node:fs').writeFileSync(${JSON.stringify(file)}, 'planted'); console.log('wrote'); } catch (error) { console.log(error.code); }`]);
  const result = spawnSync(command, args, { cwd: worktree, env: { ...env, ...guard.env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "EROFS");
  assert.equal(readFileSync(file, "utf8"), "original\n");
});

test("TOOLS-397: a saved session survives a resume and a cleared session gives a plain next step", { skip: noBwrap }, t => {
  const { worktree, common, env } = fixture(t);
  const state = join(worktree, "cli-state");
  const first = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state });
  const saved = realpathSync(state);
  t.after(() => rmSync(saved, { recursive: true, force: true }));
  writeFileSync(join(first.env.CLAUDE_CONFIG_DIR, "session"), "saved");
  first.close();
  const second = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state });
  assert.equal(readFileSync(join(second.env.CLAUDE_CONFIG_DIR, "session"), "utf8"), "saved");
  second.close();
  rmSync(saved, { recursive: true, force: true });
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state }), /saved session.*start a new build/);
  assert.equal(existsSync(saved), false);
});

test("TOOLS-397: a private cache keeps installed Playwright browsers readable", { skip: noBwrap }, t => {
  const { home, worktree, common, env } = fixture(t);
  const browsers = join(home, ".cache/ms-playwright");
  mkdirSync(browsers, { recursive: true });
  writeFileSync(join(browsers, "installed"), "browser");
  const lock = checkLock({ worktree, common, env: { ...env, PLAYWRIGHT_BROWSERS_PATH: undefined } });
  t.after(() => lock.close?.());
  assert.equal(lock.env.PLAYWRIGHT_BROWSERS_PATH, browsers);
  const [command, args] = lock.wrap(process.execPath, ["-e", "console.log(require('node:fs').readFileSync(process.env.PLAYWRIGHT_BROWSERS_PATH + '/installed', 'utf8'))"]);
  const result = spawnSync(command, args, { env: { ...env, ...lock.env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "browser");
});

test("TOOLS-397: a folder-remote push can write its named destination while its hook stays locked", { skip: noBwrap }, t => {
  const { dir, home, worktree, common, env } = fixture(t);
  const remote = join(dir, "remote.git"), key = join(home, ".ssh/key");
  mkdirSync(resolve(key, ".."), { recursive: true }); writeFileSync(key, "dummy-key");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: worktree, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", "dev");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "base");
  git("init", "-q", "--bare", remote);
  writeFileSync(join(remote, "hooks/pre-receive"), `#!/bin/sh\nif cat '${key}' > '${remote}/leaked' 2>/dev/null; then exit 1; fi\necho locked > '${remote}/hook-ran'\n`, { mode: 0o755 });
  const lock = checkLock({ worktree, common, env, writable: [remote] });
  t.after(() => lock.close?.());
  const [command, args] = lock.wrap("/usr/bin/git", ["push", remote, "HEAD:refs/heads/dev"]);
  const result = spawnSync(command, args, { cwd: worktree, env: { ...env, ...lock.env }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(remote, "hook-ran"), "utf8"), "locked\n");
  assert.equal(readFileSync(join(remote, "leaked"), "utf8"), "");
});

test("TOOLS-397: a saved-session link cannot select a folder the build can rename", { skip: noBwrap }, t => {
  const { worktree, common, env } = fixture(t);
  const planted = join(worktree, "ase-write-fence-abcdef"), state = join(worktree, "cli-state");
  mkdirSync(planted, { mode: 0o700 });
  for (const name of ["tmp", "cache", "claude"]) mkdirSync(join(planted, name));
  symlinkSync(planted, state);
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state }), /saved session.*start a new build/);
});

test("TOOLS-397: saved sessions live under XDG_STATE_HOME, stay writable inside bwrap, bind to their owner and refresh newer home credentials on resume", { skip: noBwrap }, t => {
  const { home, worktree, common, env } = fixture(t);
  const claudeHome = join(home, ".claude"), creds = join(claudeHome, ".credentials.json"), settings = join(claudeHome, "settings.json");
  const skills = join(claudeHome, "skills"), instructions = join(claudeHome, "CLAUDE.md"), styles = join(claudeHome, "output-styles");
  mkdirSync(skills, { recursive: true }); mkdirSync(styles, { recursive: true });
  writeFileSync(instructions, "global instructions\n");
  writeFileSync(settings, '{"home":true}');
  writeFileSync(creds, '{"token":"v1"}');
  const older = new Date(Date.now() - 10_000);
  utimesSync(creds, older, older);
  const stateA = join(worktree, "cli-state-a"), stateB = join(worktree, "cli-state-b");
  const guardA = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA });
  const guardB = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateB });
  const savedA = realpathSync(stateA), savedB = realpathSync(stateB);
  t.after(() => { rmSync(savedA, { recursive: true, force: true }); rmSync(savedB, { recursive: true, force: true }); });
  assert.equal(dirname(savedA), realpathSync(join(env.XDG_STATE_HOME, "agent-kit/fence")));
  // R1-12 & R1-5: settings.json and .credentials.json are copies; CLAUDE.md, output-styles and skills are read-only links.
  const copySettings = join(guardA.env.CLAUDE_CONFIG_DIR, "settings.json");
  const copyCreds = join(guardA.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  assert.equal(lstatSync(copySettings).isFile(), true);
  assert.equal(lstatSync(copyCreds).isFile(), true);
  for (const name of ["CLAUDE.md", "output-styles", "skills"]) assert.equal(lstatSync(join(guardA.env.CLAUDE_CONFIG_DIR, name)).isSymbolicLink(), true, name);
  assert.equal(readFileSync(join(guardA.env.CLAUDE_CONFIG_DIR, "CLAUDE.md"), "utf8"), "global instructions\n");
  writeFileSync(copySettings, '{"mutated":true}');
  writeFileSync(copyCreds, '{"token":"mutated"}');
  assert.equal(readFileSync(settings, "utf8"), '{"home":true}');
  assert.equal(readFileSync(creds, "utf8"), '{"token":"v1"}');
  // R1-6 & sibling isolation: inside bubblewrap after --remount-ro on the fence root, $CLAUDE_CONFIG_DIR and $TMPDIR
  // remain writable while sibling sessions stay hidden.
  writeFileSync(join(savedB, "sibling-secret"), "hidden");
  const [command, args] = guardA.wrap(process.execPath, ["-e", `const fs = require('node:fs'), path = require('node:path');
    fs.mkdirSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects/x'), 'session-data');
    fs.writeFileSync(path.join(process.env.TMPDIR, 'x'), 'temp-data');
    console.log(JSON.stringify(fs.readdirSync(${JSON.stringify(dirname(savedA))})));
    try { fs.readFileSync(${JSON.stringify(join(savedB, "sibling-secret"))}); console.log('leaked'); } catch (e) { console.log(e.code); }`]);
  const probe = spawnSync(command, args, { cwd: worktree, env: { ...env, ...guardA.env }, encoding: "utf8" });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), `${JSON.stringify([savedA.split("/").at(-1)])}\nENOENT`);
  guardA.close(); guardB.close();
  // R1-7: repointing stateA at another valid session (stateB's) is refused by the owner record.
  rmSync(stateA); symlinkSync(savedB, stateA);
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA }), /saved session cannot be used/);
  rmSync(stateA); symlinkSync(savedA, stateA);
  // R2-4: another worktree linking to this run's artifacts folder (so canonical cli-state matches) is still refused by the worktree owner check.
  const otherWork = join(home, "other-work"), otherAgent = join(otherWork, ".scratch/agent");
  mkdirSync(otherAgent, { recursive: true });
  symlinkSync(worktree, join(otherAgent, "build-1"));
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", worktree: otherWork, common, env, state: join(otherAgent, "build-1/cli-state-a") }), /saved session cannot be used/);
  // R11-20: a symlink outside both writable roots still reaches and triggers the worktree owner check.
  const wtAlias = join(home, "wt-alias");
  symlinkSync(worktree, wtAlias);
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", worktree: otherWork, common, env, state: join(wtAlias, "cli-state-a") }), /saved session cannot be used/);
  // Newer home credentials refresh on resume, safely replacing a symlink in private state, and earlier writes survive.
  rmSync(copyCreds); symlinkSync(join(home, ".profile"), copyCreds);
  writeFileSync(creds, '{"token":"v2"}');
  const newer = new Date(Date.now() + 10_000);
  utimesSync(creds, newer, newer);
  const resumed = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA });
  t.after(() => resumed.close());
  assert.equal(lstatSync(copyCreds).isFile(), true);
  assert.equal(readFileSync(copyCreds, "utf8"), '{"token":"v2"}');
  assert.equal(existsSync(join(home, ".profile")), false);
  const [readCmd, readArgs] = resumed.wrap(process.execPath, ["-e", `const fs = require('node:fs'), path = require('node:path');
    console.log(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects/x'), 'utf8'));
    console.log(fs.readFileSync(path.join(process.env.TMPDIR, 'x'), 'utf8'));`]);
  const readBack = spawnSync(readCmd, readArgs, { cwd: worktree, env: { ...env, ...resumed.env }, encoding: "utf8" });
  assert.equal(readBack.status, 0, readBack.stderr);
  assert.equal(readBack.stdout.trim(), "session-data\ntemp-data");
  // R1-9: swapping dir/claude for a link to ~/.claude before resuming is refused and leaves ~/.claude/.credentials.json intact.
  rmSync(join(savedA, "claude"), { recursive: true, force: true });
  symlinkSync(claudeHome, join(savedA, "claude"));
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA }), /saved session has a changed folder/);
  assert.equal(readFileSync(creds, "utf8"), '{"token":"v2"}');
});

test("TOOLS-397: checkLock.close removes its private folder and refuses a push destination holding HOME", { skip: noBwrap }, t => {
  const { home, worktree, common, env } = fixture(t);
  const lock = checkLock({ worktree, common, env });
  const privateDir = dirname(lock.env.TMPDIR);
  assert.equal(existsSync(privateDir), true);
  lock.close?.();
  assert.equal(existsSync(privateDir), false);
  assert.throws(() => checkLock({ worktree, common, env, writable: [home] }), /push goes to a folder that holds your home folder/);
});

test("TOOLS-397: Codex build puts TMPDIR and cache in a private folder, names it in its profile and removes it on close", t => {
  const { worktree, common, env } = workspace(t);
  const guard = keyGuard({ cli: "codex", kind: "build", worktree, common, env });
  const privateDir = dirname(guard.env.TMPDIR);
  assert.equal(existsSync(privateDir), true);
  assert.equal(dirname(guard.env.XDG_CACHE_HOME), privateDir);
  assert.ok(guard.codex.some((arg: string) => arg.includes(`${JSON.stringify(privateDir)}="write"`)), guard.codex.join(" "));
  guard.close();
  assert.equal(existsSync(privateDir), false);
});

test("TOOLS-397: PLAYWRIGHT_BROWSERS_PATH is not forced to a Linux cache path on macOS", t => {
  const { worktree, common, env } = workspace(t);
  const childEnv = { ...env };
  delete childEnv.PLAYWRIGHT_BROWSERS_PATH;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    Object.defineProperty(process, "platform", { value: "darwin" });
    const { keyGuard } = await import(${JSON.stringify(resolve("key-guard.mjs"))});
    const guard = keyGuard({ cli: "codex", kind: "build", worktree: ${JSON.stringify(worktree)}, common: ${JSON.stringify(common)}, env: process.env });
    console.log(JSON.stringify({ pw: guard.env.PLAYWRIGHT_BROWSERS_PATH ?? null }));
    guard.close();
  `], { env: childEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).pw, null);
});

test("TOOLS-397: coordinated resume swaps before chmod and rename cannot change HOME contents or permissions", { skip: noBwrap }, t => {
  const { dir, home, worktree, common, env } = workspace(t);
  const claudeHome = join(home, ".claude"), creds = join(claudeHome, ".credentials.json");
  const homeProfile = join(home, ".profile"), homeCreds = join(home, ".credentials.json");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(creds, '{"token":"v1"}');
  const older = new Date(Date.now() - 10_000);
  utimesSync(creds, older, older);
  writeFileSync(homeProfile, "original profile\n");
  chmodSync(homeProfile, 0o644);
  writeFileSync(homeCreds, "original home creds\n");
  chmodSync(homeCreds, 0o644);

  const stateStaged = join(worktree, "cli-state-staged"), stateClaude = join(worktree, "cli-state-claude");
  const firstStaged = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateStaged });
  const firstClaude = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateClaude });
  const savedStaged = realpathSync(stateStaged), savedClaude = realpathSync(stateClaude);
  t.after(() => {
    for (const saved of [savedStaged, savedClaude]) {
      rmSync(saved, { recursive: true, force: true });
      rmSync(`${saved}.owner`, { force: true });
    }
  });
  firstStaged.close();
  firstClaude.close();

  writeFileSync(creds, '{"token":"v2"}');
  const newer = new Date(Date.now() + 10_000);
  utimesSync(creds, newer, newer);

  const loader = join(dir, "swap-loader.mjs");
  writeFileSync(loader, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { basename, dirname } from "node:path";
    const mode = process.env.SWAP_MODE;
    const log = process.env.SWAP_LOG;
    const homeProfile = process.env.SWAP_PROFILE;
    const homeDir = process.env.SWAP_HOME;
    const targetCreds = process.env.SWAP_TARGET_CREDS;
    let swapped = false;
    const origCopy = fs.copyFileSync;
    const origOpen = fs.openSync;
    const origRename = fs.renameSync;
    const origUnlink = fs.unlinkSync;
    const origSymlink = fs.symlinkSync;
    const origAppend = fs.appendFileSync;
    const swapStaged = path => {
      if (swapped || mode !== "staged" || typeof path !== "string") return;
      const name = basename(path);
      if (!name.startsWith(".credentials-") || !name.endsWith(".tmp")) return;
      swapped = true;
      origUnlink(path);
      origSymlink(homeProfile, path);
      origAppend(log, "swapped-staged\\n");
    };
    fs.copyFileSync = function (src, dest, ...rest) {
      const result = origCopy.call(fs, src, dest, ...rest);
      swapStaged(dest);
      return result;
    };
    fs.openSync = function (path, ...rest) {
      const fd = origOpen.call(fs, path, ...rest);
      swapStaged(path);
      return fd;
    };
    fs.renameSync = function (from, to) {
      if (!swapped && mode === "claude" && to === targetCreds) {
        swapped = true;
        const claudeDir = dirname(to);
        origRename(claudeDir, claudeDir + ".aside");
        origSymlink(homeDir, claudeDir);
        origAppend(log, "swapped-claude\\n");
      }
      return origRename.call(fs, from, to);
    };
    syncBuiltinESMExports();
  `);

  const runResume = (state: string, saved: string, mode: "staged" | "claude") => {
    const swapLog = join(saved, "swap.log");
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { keyGuard } = await import(${JSON.stringify(resolve("key-guard.mjs"))});
      const guard = keyGuard({ cli: "claude", kind: "build", worktree: ${JSON.stringify(worktree)}, common: ${JSON.stringify(common)}, env: process.env, state: ${JSON.stringify(state)} });
      guard.close();
    `], {
      env: {
        ...env,
        NODE_OPTIONS: `--import=${loader}`,
        SWAP_MODE: mode,
        SWAP_LOG: swapLog,
        SWAP_PROFILE: homeProfile,
        SWAP_HOME: home,
        SWAP_TARGET_CREDS: join(saved, "claude", ".credentials.json"),
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { result, swapLog };
  };

  // Case 1: staged file replaced with a symlink to HOME/.profile right before chmod.
  const stagedRun = runResume(stateStaged, savedStaged, "staged");
  assert.equal(existsSync(stagedRun.swapLog), true, "staged swap hook must fire");
  assert.match(readFileSync(stagedRun.swapLog, "utf8"), /swapped-staged/);
  assert.notEqual(stagedRun.result.status, 0, "resuming with a swapped staged file must fail");
  assert.match(stagedRun.result.stderr, /saved session has a changed folder/);
  assert.equal(readFileSync(homeProfile, "utf8"), "original profile\n");
  assert.equal(statSync(homeProfile).mode & 0o777, 0o644);

  // Case 2: claude/ swapped to HOME immediately after directory validation, right before rename.
  const claudeRun = runResume(stateClaude, savedClaude, "claude");
  assert.equal(existsSync(claudeRun.swapLog), true, "claude/ swap hook must fire");
  assert.match(readFileSync(claudeRun.swapLog, "utf8"), /swapped-claude/);
  assert.notEqual(claudeRun.result.status, 0, "resuming with a swapped claude/ folder must fail");
  assert.match(claudeRun.result.stderr, /saved session has a changed folder/);
  assert.equal(readFileSync(homeCreds, "utf8"), "original home creds\n");
  assert.equal(statSync(homeCreds).mode & 0o777, 0o644);

  // Build bubblewrap runs with --die-with-parent so a killed runner cannot leave its build child behind.
  const [, wrapArgs] = firstStaged.wrap(process.execPath, ["-e", "0"]);
  assert.ok(wrapArgs.includes("--die-with-parent"), wrapArgs.join(" "));
});

test("TOOLS-397: pinned local push targets refuse HOME setup folders and stay pinned across pre-fence and pre-mount swaps", { skip: noBwrap }, t => {
  const { dir, home, worktree, common, env } = workspace(t);
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(worktree, "init", "-q", "-b", "dev");
  git(worktree, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "base");

  // Direct bare repositories inside HOME setup folders are refused.
  for (const rel of [".local/bin/bare.git", ".config/systemd/user/bare.git", ".ssh/bare.git", "bin/bare.git", ".custom-rc/bare.git"]) {
    const insideHome = join(home, rel);
    git(dir, "init", "-q", "--bare", insideHome);
    assert.throws(() => openLocalPushTarget(insideHome, { env }), /home setup or system folder/, rel);
    assert.throws(() => checkLock({ worktree, common, env, writable: [insideHome] }), /home setup or system folder/, rel);
  }
  const linkToBin = join(worktree, "bin-link");
  symlinkSync(join(home, ".local/bin"), linkToBin);
  assert.throws(() => checkLock({ worktree, common, env, writable: [linkToBin] }), /link, not a direct repository folder/);

  // A valid external bare repo pinned by handle succeeds with lock.fds, and does not leak the host fd into the sandbox.
  const bashrc = join(home, ".bashrc"), sshKey = join(home, ".ssh/id_test");
  mkdirSync(dirname(sshKey), { recursive: true });
  writeFileSync(bashrc, "original\n");
  writeFileSync(sshKey, "secret-key\n");
  const validRemote = join(dir, "valid.git");
  git(dir, "init", "-q", "--bare", validRemote);
  const validPinned = openLocalPushTarget(validRemote, { env });
  const validLock = checkLock({ worktree, common, env, writable: [validPinned] });
  t.after(() => validLock.close?.());
  const [validCmd, validArgs] = validLock.wrap("/usr/bin/git", ["push", validRemote, "HEAD:refs/heads/dev"]);
  const validPush = spawnSync(validCmd, validArgs, {
    cwd: worktree,
    env: { ...env, ...validLock.env },
    stdio: ["ignore", "pipe", "pipe", ...(validLock.fds ?? [])],
    encoding: "utf8",
  });
  assert.equal(validPush.status, 0, validPush.stderr);
  const [probeCmd, probeArgs] = validLock.wrap(process.execPath, ["-e", `
    const fs = require("node:fs");
    for (const op of [
      () => fs.writeFileSync("/proc/self/fd/3/../home/.bashrc", "escaped"),
      () => fs.readFileSync("/proc/self/fd/3/../home/.ssh/id_test", "utf8"),
    ]) {
      try { op(); console.log("ESCAPED"); } catch (e) { console.log(e.code); }
    }
  `]);
  const fdProbe = spawnSync(probeCmd, probeArgs, {
    cwd: worktree,
    env: { ...env, ...validLock.env },
    stdio: ["ignore", "pipe", "pipe", ...(validLock.fds ?? [])],
    encoding: "utf8",
  });
  assert.equal(fdProbe.status, 0, fdProbe.stderr);
  assert.doesNotMatch(fdProbe.stdout, /ESCAPED/);
  assert.equal(readFileSync(bashrc, "utf8"), "original\n");
  validLock.close?.();

  // Swapping a pinned external bare repo for a HOME link after checkLock (before wrap) or after wrap (before bwrap mounts)
  // cannot make ~/.local/bin writable or let a sibling .git hook write HOME.
  const bin = join(home, ".local/bin/target"), planted = join(bin, "planted");
  mkdirSync(bin, { recursive: true });
  const swapped = join(dir, "ext"), sibling = join(dir, "ext.git");
  git(dir, "init", "-q", "--bare", swapped);
  git(dir, "init", "-q", "--bare", sibling);
  writeFileSync(join(sibling, "hooks/pre-receive"), `#!/bin/sh\necho planted > ${JSON.stringify(planted)}\n`, { mode: 0o755 });

  const pinned = openLocalPushTarget(swapped, { env });
  const lock = checkLock({ worktree, common, env, writable: [pinned] });
  t.after(() => lock.close?.());
  const [bwrapCmd, bwrapArgList] = lock.wrap("/usr/bin/git", ["push", swapped, "HEAD:refs/heads/dev"]);

  // Swap after wrap(), right before bwrap executes: wrap() rejects any further call, and --bind-fd refuses even a
  // relative-link swap to HOME at mount time.
  renameSync(swapped, `${swapped}.aside`);
  symlinkSync(relative(dirname(swapped), bin), swapped);
  assert.throws(() => lock.wrap("/usr/bin/git", ["push", swapped, "HEAD:refs/heads/dev"]), /push destination changed after validation/);
  const raced = spawnSync(bwrapCmd, bwrapArgList, {
    cwd: worktree,
    env: { ...env, ...lock.env },
    stdio: ["ignore", "pipe", "pipe", ...(lock.fds ?? [])],
    encoding: "utf8",
  });
  assert.notEqual(raced.status, 0, raced.stdout + raced.stderr);
  assert.equal(existsSync(planted), false);
  assert.deepEqual(readdirSync(bin), []);

  // Even for an in-worktree remote swapped for a relative HOME link after wrap(), HOME remains read-only if git falls back to sibling .git.
  const inWork = join(worktree, "r"), inWorkSibling = join(worktree, "r.git");
  git(worktree, "init", "-q", "--bare", inWork);
  git(worktree, "init", "-q", "--bare", inWorkSibling);
  writeFileSync(join(inWorkSibling, "hooks/pre-receive"), `#!/bin/sh\necho planted > ${JSON.stringify(planted)} 2>/dev/null\n`, { mode: 0o755 });
  const inWorkPinned = openLocalPushTarget(inWork, { env });
  const inWorkLock = checkLock({ worktree, common, env, writable: [inWorkPinned] });
  t.after(() => inWorkLock.close?.());
  const [inWorkCmd, inWorkArgs] = inWorkLock.wrap("/usr/bin/git", ["push", inWork, "HEAD:refs/heads/dev"]);
  renameSync(inWork, `${inWork}.aside`);
  symlinkSync(relative(dirname(inWork), bin), inWork);
  assert.throws(() => inWorkLock.wrap("/usr/bin/git", ["push", inWork, "HEAD:refs/heads/dev"]), /push destination changed after validation/);
  spawnSync(inWorkCmd, inWorkArgs, {
    cwd: worktree,
    env: { ...env, ...inWorkLock.env },
    stdio: ["ignore", "pipe", "pipe", ...(inWorkLock.fds ?? [])],
    encoding: "utf8",
  });
  assert.equal(existsSync(planted), false);
  assert.deepEqual(readdirSync(bin), []);

  // Custom XDG/CLI config folders outside HOME are refused, while a host TMPDIR nested under HOME is still accepted.
  const outsideCfg = join(dir, "cfg"), outsideCfgRepo = join(outsideCfg, "repo.git");
  const outsideClaude = join(dir, "claude-cfg"), outsideClaudeRepo = join(outsideClaude, "repo.git");
  const homeTmp = join(home, ".tmp"), homeTmpRepo = join(homeTmp, "x.git");
  git(dir, "init", "-q", "--bare", outsideCfgRepo);
  git(dir, "init", "-q", "--bare", outsideClaudeRepo);
  git(dir, "init", "-q", "--bare", homeTmpRepo);
  assert.throws(() => openLocalPushTarget(outsideCfgRepo, { env: { ...env, XDG_CONFIG_HOME: outsideCfg } }), /home setup or system folder/);
  assert.throws(() => openLocalPushTarget(outsideClaudeRepo, { env: { ...env, CLAUDE_CONFIG_DIR: outsideClaude } }), /home setup or system folder/);
  const inHomeTmp = openLocalPushTarget(homeTmpRepo, { env: { ...env, TMPDIR: homeTmp } });
  inHomeTmp.close();

  // Older bubblewrap without --bind-fd falls back to --bind <path> <path> with empty lock.fds (no host fd leaked);
  // in-worktree destinations are still never bound separately so a relative-link swap inside the worktree cannot write HOME.
  const shimDir = join(dir, "old-bwrap-bin"), shim = join(shimDir, "bwrap");
  mkdirSync(shimDir, { recursive: true });
  const realBwrap = runProgram("bwrap", env, { worktree, common });
  assert.ok(realBwrap.includes("/"), `expected full path to bwrap, got ${realBwrap}`);
  writeFileSync(shim, `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "usage: bwrap [OPTIONS...]"; exit 0; fi\nexec ${JSON.stringify(realBwrap)} "$@"\n`, { mode: 0o755 });
  const oldEnv = { ...env, PATH: `${shimDir}:${env.PATH}` };
  t.after(() => resetBwrapProbe());
  resetBwrapProbe();
  const oldRemote = join(dir, "old-ext");
  git(dir, "init", "-q", "--bare", oldRemote);
  const oldPinned = openLocalPushTarget(oldRemote, { env: oldEnv });
  const oldLock = checkLock({ worktree, common, env: oldEnv, writable: [oldPinned] });
  t.after(() => oldLock.close?.());
  assert.deepEqual(oldLock.fds, []);
  const [oldCmd, oldArgs] = oldLock.wrap("/usr/bin/git", ["push", oldRemote, "HEAD:refs/heads/dev"]);
  assert.ok(oldArgs.some((arg: string, i: number) => arg === "--bind" && oldArgs[i + 1] === oldRemote && oldArgs[i + 2] === oldRemote), `expected --bind ${oldRemote} ${oldRemote} in ${oldArgs.join(" ")}`);
  const oldPush = spawnSync(oldCmd, oldArgs, { cwd: worktree, env: { ...oldEnv, ...oldLock.env }, encoding: "utf8" });
  assert.equal(oldPush.status, 0, oldPush.stderr);

  const oldInWork = join(worktree, "old-r"), oldInWorkSibling = join(worktree, "old-r.git");
  git(worktree, "init", "-q", "--bare", oldInWork);
  git(worktree, "init", "-q", "--bare", oldInWorkSibling);
  writeFileSync(join(oldInWorkSibling, "hooks/pre-receive"), `#!/bin/sh\necho planted > ${JSON.stringify(planted)} 2>/dev/null\n`, { mode: 0o755 });
  const oldInWorkPinned = openLocalPushTarget(oldInWork, { env: oldEnv });
  const oldInWorkLock = checkLock({ worktree, common, env: oldEnv, writable: [oldInWorkPinned] });
  t.after(() => oldInWorkLock.close?.());
  const [oldInWorkCmd, oldInWorkArgs] = oldInWorkLock.wrap("/usr/bin/git", ["push", oldInWork, "HEAD:refs/heads/dev"]);
  renameSync(oldInWork, `${oldInWork}.aside`);
  symlinkSync(relative(dirname(oldInWork), bin), oldInWork);
  assert.throws(() => oldInWorkLock.wrap("/usr/bin/git", ["push", oldInWork, "HEAD:refs/heads/dev"]), /push destination changed after validation/);
  spawnSync(oldInWorkCmd, oldInWorkArgs, { cwd: worktree, env: { ...oldEnv, ...oldInWorkLock.env }, encoding: "utf8" });
  assert.equal(existsSync(planted), false);
  assert.deepEqual(readdirSync(bin), []);
});

test("TOOLS-397: locks started before the saved-session parent exists hide sessions created later and deny it in Codex profiles", { skip: noBwrap }, async t => {
  const { dir, home, worktree, common, env } = workspace(t);
  const fenceParent = join(env.XDG_STATE_HOME, "agent-kit/fence");
  assert.equal(existsSync(fenceParent), false, "saved-session parent must be absent before check starts");

  // Give the user a dummy Claude login that a later build will copy into a new saved session.
  const claudeHome = join(home, ".claude");
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(claudeHome, ".credentials.json"), '{"token":"late-session-secret"}');

  // Start checkLock before fenceParent exists, and keep the check process running.
  const lock = checkLock({ worktree, common, env });
  t.after(() => lock.close?.());
  const readyFile = join(worktree, "ready");
  const targetFile = join(worktree, "target");
  const [checkCmd, checkArgs] = lock.wrap(process.execPath, ["-e", `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(readyFile)}, "ready\\n");
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(${JSON.stringify(targetFile)}) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const credsPath = fs.readFileSync(${JSON.stringify(targetFile)}, "utf8").trim();
    let readResult;
    try { readResult = "LEAKED:" + fs.readFileSync(credsPath, "utf8"); } catch (e) { readResult = e.code; }
    let entries;
    try { entries = fs.readdirSync(${JSON.stringify(fenceParent)}); } catch (e) { entries = e.code; }
    console.log(JSON.stringify({ readResult, entries }));
  `]);
  const child = spawn(checkCmd, checkArgs, { cwd: worktree, env: { ...env, ...lock.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exited = new Promise<number | null>((resolveExit, rejectExit) => {
    child.on("error", rejectExit);
    child.on("exit", code => resolveExit(code));
  });
  const waitDeadline = Date.now() + 15_000;
  while (!existsSync(readyFile) && Date.now() < waitDeadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(existsSync(readyFile), true, `running check did not start: ${stderr}`);

  // Create a Claude saved session AFTER the check is already running.
  const otherWork = join(dir, "other-work"), otherCommon = join(dir, "other-git");
  mkdirSync(otherWork, { recursive: true }); mkdirSync(otherCommon, { recursive: true });
  const lateState = join(otherWork, "cli-state");
  const lateBuild = keyGuard({ cli: "claude", kind: "build", worktree: otherWork, common: otherCommon, env, state: lateState });
  const lateSaved = realpathSync(lateState);
  t.after(() => {
    lateBuild.close();
    rmSync(lateSaved, { recursive: true, force: true });
    rmSync(`${lateSaved}.owner`, { force: true });
  });
  const lateCreds = join(lateBuild.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  assert.equal(readFileSync(lateCreds, "utf8"), '{"token":"late-session-secret"}');

  // Tell the running check where the new session's credentials live and verify it cannot read them.
  writeFileSync(targetFile, `${lateCreds}\n`);
  const code = await exited;
  assert.equal(code, 0, stderr);
  const observed = JSON.parse(stdout.trim());
  assert.equal(observed.readResult, "ENOENT", `running check read late session credentials: ${stdout}`);
  assert.deepEqual(observed.entries, [], `running check listed late session folder: ${stdout}`);

  // Fresh workspaces with no saved-session parent must also deny it in Codex build/review profiles and mask it in reviews.
  for (const kind of ["build", "review"] as const) {
    const codexWs = workspace(t);
    const codexFence = join(codexWs.env.XDG_STATE_HOME, "agent-kit/fence");
    assert.equal(existsSync(codexFence), false);
    const codexGuard = keyGuard({ cli: "codex", kind, worktree: codexWs.worktree, common: codexWs.common, env: codexWs.env });
    t.after(() => codexGuard.close());
    assert.equal(existsSync(codexFence), true, `codex ${kind} must create saved-session parent`);
    const realCodexFence = realpathSync(codexFence);
    assert.ok(codexGuard.codex.some((arg: string) => arg.includes(`${JSON.stringify(realCodexFence)}="none"`)), `codex ${kind} profile must deny ${realCodexFence}: ${codexGuard.codex.join(" ")}`);
  }

  const reviewWs = workspace(t);
  const reviewFence = join(reviewWs.env.XDG_STATE_HOME, "agent-kit/fence");
  assert.equal(existsSync(reviewFence), false);
  const reviewGuard = keyGuard({ cli: "claude", kind: "review", worktree: reviewWs.worktree, common: reviewWs.common, env: reviewWs.env });
  t.after(() => reviewGuard.close());
  assert.equal(existsSync(reviewFence), true);
  const [, reviewArgs] = reviewGuard.wrap(process.execPath, ["-e", "0"]);
  const realReviewFence = realpathSync(reviewFence);
  assert.ok(reviewArgs.some((arg: string, i: number) => arg === "--tmpfs" && reviewArgs[i + 1] === realReviewFence), `review must mask ${realReviewFence}: ${reviewArgs.join(" ")}`);
});

test("TOOLS-397: relative CLAUDE_CONFIG_DIR resolves against the worktree for login, settings, migration and refresh, and refuses worktree configs or symlinked credentials", { skip: noBwrap }, t => {
  const { dir, home, common, env } = workspace(t);
  const runnerCwd = join(dir, "runner/sub");
  const worktree = join(dir, "wt/work");
  mkdirSync(runnerCwd, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const relCfg = "../rel-claude";
  const runnerCfg = resolve(runnerCwd, relCfg);
  const worktreeCfg = resolve(worktree, relCfg);
  const projectKey = realpathSync(worktree).replace(/[^A-Za-z0-9-]/g, "-");
  const sessionId = "legacy-rel-session";
  const homeSecret = join(home, "secret-key");
  writeFileSync(homeSecret, "home-secret");

  for (const [cfg, label] of [[runnerCfg, "runner"], [worktreeCfg, "worktree"]] as const) {
    mkdirSync(join(cfg, "projects", projectKey), { recursive: true });
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ source: label }));
    writeFileSync(join(cfg, ".credentials.json"), JSON.stringify({ token: `${label}-v1` }));
    writeFileSync(join(cfg, "CLAUDE.md"), `${label} instructions\n`);
    writeFileSync(join(cfg, "projects", projectKey, `${sessionId}.jsonl`), JSON.stringify({ from: label }) + "\n");
    const older = new Date(Date.now() - 10_000);
    utimesSync(join(cfg, ".credentials.json"), older, older);
  }

  const state = join(worktree, "cli-state");
  const script = `
    import { readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const { keyGuard } = await import(${JSON.stringify(resolve("key-guard.mjs"))});
    const worktree = ${JSON.stringify(worktree)};
    const common = ${JSON.stringify(common)};
    const state = ${JSON.stringify(state)};
    const session = ${JSON.stringify(sessionId)};
    const projectKey = ${JSON.stringify(projectKey)};
    const runnerCreds = ${JSON.stringify(join(runnerCfg, ".credentials.json"))};
    const worktreeCreds = ${JSON.stringify(join(worktreeCfg, ".credentials.json"))};
    const homeSecret = ${JSON.stringify(homeSecret)};

    const first = keyGuard({ cli: "claude", kind: "build", worktree, common, env: process.env, state, session });
    const cfgDir = first.env.CLAUDE_CONFIG_DIR;
    const firstResult = {
      settings: JSON.parse(readFileSync(join(cfgDir, "settings.json"), "utf8")),
      creds: JSON.parse(readFileSync(join(cfgDir, ".credentials.json"), "utf8")),
      instructions: readFileSync(join(cfgDir, "CLAUDE.md"), "utf8"),
      transcript: JSON.parse(readFileSync(join(cfgDir, "projects", projectKey, session + ".jsonl"), "utf8")),
    };
    first.close();

    // Update both configs so runner's credentials are even newer than the worktree's; resume must still read the worktree's.
    writeFileSync(worktreeCreds, JSON.stringify({ token: "worktree-v2" }));
    const newerWork = new Date(Date.now() + 10_000);
    utimesSync(worktreeCreds, newerWork, newerWork);
    writeFileSync(runnerCreds, JSON.stringify({ token: "runner-v2" }));
    const newerRunner = new Date(Date.now() + 20_000);
    utimesSync(runnerCreds, newerRunner, newerRunner);

    const resumed = keyGuard({ cli: "claude", kind: "build", worktree, common, env: process.env, state, session });
    const resumedCreds = JSON.parse(readFileSync(join(resumed.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8"));
    resumed.close();
    console.log(JSON.stringify({ firstResult, resumedCreds }));
  `;

  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: runnerCwd,
    env: { ...env, CLAUDE_CONFIG_DIR: relCfg },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const out = JSON.parse(run.stdout.trim());
  assert.deepEqual(out.firstResult.settings, { source: "worktree" });
  assert.deepEqual(out.firstResult.creds, { token: "worktree-v1" });
  assert.equal(out.firstResult.instructions, "worktree instructions\n");
  assert.deepEqual(out.firstResult.transcript, { from: "worktree" });
  assert.deepEqual(out.resumedCreds, { token: "worktree-v2" });

  // A CLAUDE_CONFIG_DIR resolving inside the worktree (such as "rel-claude") is refused at start and on resume,
  // preventing a build from planting a symlink there to leak HOME secrets on resume.
  const inWorkCfg = join(worktree, "rel-claude");
  mkdirSync(inWorkCfg, { recursive: true });
  symlinkSync(homeSecret, join(inWorkCfg, ".credentials.json"));
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree, common, env: { ...env, CLAUDE_CONFIG_DIR: "rel-claude" } }),
    /cannot sit inside the worktree or Git folder/,
  );
  const savedCreds = join(realpathSync(state), "claude", ".credentials.json");
  utimesSync(savedCreds, new Date(0), new Date(0));
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree, common, env: { ...env, CLAUDE_CONFIG_DIR: "rel-claude" }, state }),
    /cannot sit inside the worktree or Git folder/,
  );
  assert.ok(!readFileSync(savedCreds, "utf8").includes("home-secret"));

  // A dotfiles symlink to settings.json outside the worktree is followed and copied into private state.
  const dotfiles = join(home, "dotfiles");
  const claudeHome = join(home, ".claude");
  mkdirSync(dotfiles, { recursive: true });
  mkdirSync(claudeHome, { recursive: true });
  writeFileSync(join(dotfiles, "settings.json"), '{"from":"dotfiles"}');
  symlinkSync(join(dotfiles, "settings.json"), join(claudeHome, "settings.json"));
  const linkedGuard = keyGuard({ cli: "claude", kind: "build", worktree, common, env });
  t.after(() => linkedGuard.close());
  assert.equal(readFileSync(join(linkedGuard.env.CLAUDE_CONFIG_DIR, "settings.json"), "utf8"), '{"from":"dotfiles"}');

  // A symlinked login leading into the worktree is refused.
  const plantedInWork = join(worktree, "planted-creds.json");
  writeFileSync(plantedInWork, '{"token":"planted"}');
  symlinkSync(plantedInWork, join(claudeHome, ".credentials.json"));
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree, common, env }),
    /leads into the worktree or Git folder/,
  );
  rmSync(join(claudeHome, ".credentials.json"));

  // An unreadable login file (mode 000) is refused in plain words rather than starting silently without a login.
  const lockedCreds = join(claudeHome, ".credentials.json");
  writeFileSync(lockedCreds, '{"token":"unreadable"}');
  chmodSync(lockedCreds, 0o000);
  t.after(() => { try { chmodSync(lockedCreds, 0o600); } catch {} });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    assert.throws(
      () => keyGuard({ cli: "claude", kind: "build", worktree, common, env }),
      /cannot read Claude's file.*EACCES/,
    );
  }
});

test("TOOLS-397: ensureFenceStateDir refuses worktree state paths without leaking temp dirs and refuses non-folder paths in plain words", { skip: noBwrap }, t => {
  const { worktree, common, env } = workspace(t);

  // (a) XDG_STATE_HOME inside worktree is refused by both keyGuard review and checkLock.
  const inWorkEnv = { ...env, XDG_STATE_HOME: join(worktree, "state") };
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "review", worktree, common, env: inWorkEnv }),
    /cannot hold HOME or sit inside the worktree/,
  );

  // (c) checkLock in case (a) cleans up its temporary ase-write-fence-* folder when ensureFenceStateDir throws.
  const before = new Set(readdirSync(tmpdir()).filter(name => name.startsWith("ase-write-fence-")));
  assert.throws(
    () => checkLock({ worktree, common, env: inWorkEnv }),
    /cannot hold HOME or sit inside the worktree/,
  );
  const leaked = readdirSync(tmpdir()).filter(name => name.startsWith("ase-write-fence-") && !before.has(name));
  assert.deepEqual(leaked, [], `checkLock leaked temporary fence folders: ${leaked.join(", ")}`);

  // (b) A plain file at agent-kit/fence is refused in one plain sentence with no EEXIST and no repeated prefix.
  const fenceFile = join(env.XDG_STATE_HOME, "agent-kit/fence");
  mkdirSync(dirname(fenceFile), { recursive: true });
  writeFileSync(fenceFile, "not a folder\n");
  for (const run of [
    () => keyGuard({ cli: "claude", kind: "review", worktree, common, env }),
    () => checkLock({ worktree, common, env }),
  ]) {
    let caught: Error | null = null;
    try { run(); } catch (error) { caught = error as Error; }
    assert.ok(caught, "expected non-folder fence path to be refused");
    assert.match(caught.message, /is not a folder/);
    assert.doesNotMatch(caught.message, /EEXIST/);
    assert.equal(caught.message.match(/cannot lock the key files/g)?.length, 1, caught.message);
  }

  // When a parent component (agent-kit) is a plain file, the refusal names that parent rather than fence.
  const parentFile = dirname(fenceFile);
  rmSync(parentFile, { recursive: true, force: true });
  writeFileSync(parentFile, "not a folder\n");
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "review", worktree, common, env }),
    new RegExp(`saved-session path \\(${parentFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\) is not a folder`),
  );
});

test("TOOLS-397: replacing a build's artifact folder with a link to another build in the same worktree refuses resume", { skip: noBwrap }, t => {
  const { dir, worktree, common, env } = workspace(t);
  const agentDir = join(worktree, ".scratch/agent");
  const outA = join(agentDir, "build-a"), outB = join(agentDir, "build-b");
  mkdirSync(outA, { recursive: true });
  mkdirSync(outB, { recursive: true });
  const stateA = join(outA, "cli-state"), stateB = join(outB, "cli-state");

  const guardA = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA });
  const guardB = keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateB });
  const savedA = realpathSync(stateA), savedB = realpathSync(stateB);
  t.after(() => {
    for (const saved of [savedA, savedB]) {
      rmSync(saved, { recursive: true, force: true });
      rmSync(`${saved}.owner`, { force: true });
    }
  });
  writeFileSync(join(guardB.env.CLAUDE_CONFIG_DIR, "private-b"), "b-only");
  guardA.close();
  guardB.close();

  // Swapping build A's artifact folder for a link to build B's folder must not let A claim B's private state.
  rmSync(outA, { recursive: true, force: true });
  symlinkSync(outB, outA);
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA }),
    /saved session cannot be used/,
  );

  // Relative link swap and higher writable ancestor link swap are refused the same way.
  rmSync(outA);
  symlinkSync("build-b", outA);
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateA }),
    /saved session cannot be used/,
  );
  rmSync(outA);
  const movedAgent = join(worktree, ".scratch/agent-real");
  renameSync(agentDir, movedAgent);
  symlinkSync(movedAgent, agentDir);
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree, common, env, state: stateB }),
    /saved session cannot be used/,
  );
  rmSync(agentDir);
  renameSync(movedAgent, agentDir);

  // Restoring build B still resumes normally, including through a non-writable symlink to the worktree.
  const wtLink = join(dir, "wt-link");
  symlinkSync(worktree, wtLink);
  const resumedB = keyGuard({ cli: "claude", kind: "build", worktree: wtLink, common, env, state: join(wtLink, ".scratch/agent/build-b/cli-state") });
  t.after(() => resumedB.close());
  assert.equal(readFileSync(join(resumedB.env.CLAUDE_CONFIG_DIR, "private-b"), "utf8"), "b-only");
});

test("TOOLS-397: inherited TMPDIR inside a writable root cannot let one check swap private state into HOME for the next", { skip: noBwrap }, t => {
  const { home, worktree, common, env } = workspace(t);
  const profile = join(home, ".profile");
  writeFileSync(profile, "original\n");
  const inWorkTmp = join(worktree, ".scratch/tmp");
  mkdirSync(inWorkTmp, { recursive: true });

  const childScript = `
    import { spawnSync } from "node:child_process";
    import { existsSync, realpathSync } from "node:fs";
    import { dirname, join, resolve } from "node:path";
    const { checkLock, keyGuard } = await import(${JSON.stringify(resolve("key-guard.mjs"))});
    const worktree = ${JSON.stringify(worktree)};
    const common = ${JSON.stringify(common)};
    const home = ${JSON.stringify(home)};
    const profile = ${JSON.stringify(profile)};
    const inWorkTmp = ${JSON.stringify(inWorkTmp)};
    const lock = checkLock({ worktree, common, env: process.env });
    try {
      const stateRoot = dirname(lock.env.TMPDIR);
      const check1 = lock.wrap(process.execPath, ["-e", \`
        const fs = require("node:fs");
        const path = require("node:path");
        const stateRoot = path.dirname(process.env.TMPDIR);
        const stateParent = path.dirname(stateRoot);
        const home = \${JSON.stringify(home)};
        const inWorkTmp = \${JSON.stringify(inWorkTmp)};
        let swappedStateParent = false;
        try {
          fs.renameSync(stateParent, stateParent + ".aside");
          fs.mkdirSync(stateParent, { recursive: true });
          fs.symlinkSync(path.relative(stateParent, home), stateRoot);
          swappedStateParent = true;
        } catch {}
        if (!swappedStateParent) {
          fs.renameSync(inWorkTmp, inWorkTmp + ".aside");
          fs.mkdirSync(inWorkTmp, { recursive: true });
          fs.symlinkSync(path.relative(inWorkTmp, home), path.join(inWorkTmp, path.basename(stateRoot)));
        }
        console.log(JSON.stringify({ swappedStateParent }));
      \`]);
      const run1 = spawnSync(check1[0], check1[1], { cwd: worktree, env: { ...process.env, ...lock.env }, encoding: "utf8", timeout: 30_000 });
      if (run1.status !== 0) throw new Error("check1 failed: " + run1.stderr);

      const check2 = lock.wrap(process.execPath, ["-e", \`
        const fs = require("node:fs");
        try { fs.writeFileSync(\${JSON.stringify(profile)}, "planted"); console.log("wrote"); }
        catch (error) { console.log(error.code); }
      \`]);
      const run2 = spawnSync(check2[0], check2[1], { cwd: worktree, env: { ...process.env, ...lock.env }, encoding: "utf8", timeout: 30_000 });
      if (run2.status !== 0) throw new Error("check2 failed: " + run2.stderr);

      const guard = keyGuard({ cli: "claude", kind: "build", worktree, common, env: process.env });
      const guardRoot = dirname(guard.env.TMPDIR);
      guard.close();

      console.log(JSON.stringify({
        stateRoot,
        guardRoot,
        worktreeReal: realpathSync(worktree),
        check1: JSON.parse(run1.stdout.trim()),
        check2: run2.stdout.trim(),
        guardCleaned: !existsSync(guardRoot),
      }));
    } finally {
      lock.close?.();
    }
  `;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", childScript], {
    cwd: worktree,
    env: { ...env, TMPDIR: inWorkTmp, TMP: inWorkTmp, TEMP: inWorkTmp },
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const out = JSON.parse(result.stdout.trim());
  assert.equal(out.check1.swappedStateParent, false, `state root must not sit under a writable ancestor: ${out.stateRoot}`);
  assert.equal(out.stateRoot.startsWith(`${out.worktreeReal}/`), false, `checkLock state root sat inside worktree: ${out.stateRoot}`);
  assert.equal(out.guardRoot.startsWith(`${out.worktreeReal}/`), false, `keyGuard state root sat inside worktree: ${out.guardRoot}`);
  assert.equal(out.guardCleaned, true);
  assert.equal(out.check2, "EROFS");
  assert.equal(readFileSync(profile, "utf8"), "original\n");
  assert.equal(existsSync(out.stateRoot), false, "checkLock.close must remove its private folder");

  // An inherited TMPDIR inside the Git common folder is also avoided.
  const inCommonTmp = join(common, "tmp");
  mkdirSync(inCommonTmp, { recursive: true });
  const commonLock = checkLock({ worktree, common, env: { ...env, TMPDIR: inCommonTmp } });
  const commonRoot = dirname(commonLock.env.TMPDIR);
  t.after(() => commonLock.close?.());
  assert.equal(commonRoot.startsWith(`${realpathSync(common)}/`), false, `state root sat inside Git folder: ${commonRoot}`);
});

test("TOOLS-397: fresh build through a worktree symlink names the link, leaves no owner record, and resumes keep the saved-session refusal", { skip: noBwrap }, t => {
  // Case 1 (R11-19): .scratch itself is a symlink to a folder in temporary HOME on a fresh start.
  const ws1 = workspace(t);
  const sharedScratch = join(ws1.home, "shared-scratch");
  mkdirSync(join(sharedScratch, "agent/build-1"), { recursive: true });
  const scratchLink = join(ws1.worktree, ".scratch");
  symlinkSync(sharedScratch, scratchLink);
  const realScratchLink = join(realpathSync(ws1.worktree), ".scratch");
  const freshState1 = join(scratchLink, "agent/build-1/cli-state");

  let err1: Error | null = null;
  try {
    keyGuard({ cli: "claude", kind: "build", worktree: ws1.worktree, common: ws1.common, env: ws1.env, state: freshState1 });
  } catch (error) {
    err1 = error as Error;
  }
  assert.ok(err1, "fresh start through .scratch symlink must be refused");
  assert.match(err1.message, /artifact path passes through a link inside the worktree or Git folder/);
  assert.ok(err1.message.includes(realScratchLink), `expected link path ${realScratchLink} in: ${err1.message}`);
  assert.doesNotMatch(err1.message, /saved session/);
  const fenceDir1 = join(ws1.env.XDG_STATE_HOME, "agent-kit/fence");
  const owners1 = existsSync(fenceDir1) ? readdirSync(fenceDir1).filter(name => name.endsWith(".owner")) : [];
  assert.deepEqual(owners1, [], "refused fresh start must leave no .owner record");

  // Case 2 (R11-21): a middle folder inside the worktree (.scratch/agent) links to a folder in temporary HOME.
  const ws2 = workspace(t);
  const outsideAgent = join(ws2.home, "outside-agent");
  mkdirSync(join(outsideAgent, "build-2"), { recursive: true });
  mkdirSync(join(ws2.worktree, ".scratch"), { recursive: true });
  const agentLink = join(ws2.worktree, ".scratch/agent");
  symlinkSync(outsideAgent, agentLink);
  const realAgentLink = join(realpathSync(ws2.worktree), ".scratch/agent");
  const state2 = join(agentLink, "build-2/cli-state");

  let err2: Error | null = null;
  try {
    keyGuard({ cli: "claude", kind: "build", worktree: ws2.worktree, common: ws2.common, env: ws2.env, state: state2 });
  } catch (error) {
    err2 = error as Error;
  }
  assert.ok(err2, "fresh start through middle worktree symlink must be refused");
  assert.match(err2.message, /artifact path passes through a link inside the worktree or Git folder/);
  assert.ok(err2.message.includes(realAgentLink), `expected link path ${realAgentLink} in: ${err2.message}`);
  assert.doesNotMatch(err2.message, /saved session/);
  const fenceDir2 = join(ws2.env.XDG_STATE_HOME, "agent-kit/fence");
  const owners2 = existsSync(fenceDir2) ? readdirSync(fenceDir2).filter(name => name.endsWith(".owner")) : [];
  assert.deepEqual(owners2, [], "refused fresh start through middle symlink must leave no .owner record");

  // Resume through the same middle link (when cli-state exists or session is set) keeps the saved-session refusal.
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree: ws2.worktree, common: ws2.common, env: ws2.env, state: state2, session: "old-session" }),
    /saved session cannot be used/,
  );
  symlinkSync(join(ws2.home, "some-state"), join(outsideAgent, "build-2/cli-state"));
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree: ws2.worktree, common: ws2.common, env: ws2.env, state: state2 }),
    /saved session cannot be used/,
  );

  // Missing artifact folder gives a plain message rather than raw ENOENT.
  assert.throws(
    () => keyGuard({ cli: "claude", kind: "build", worktree: ws2.worktree, common: ws2.common, env: ws2.env, state: join(ws2.worktree, "no-such-dir/cli-state") }),
    /artifact folder .* is missing/,
  );
});
