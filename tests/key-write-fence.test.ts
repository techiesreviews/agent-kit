import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapWorks, checkLock, keyGuard } from "../key-guard.mjs";
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
