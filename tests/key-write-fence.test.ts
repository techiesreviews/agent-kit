import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapWorks, checkLock, keyGuard } from "../key-guard.mjs";
import { kitEnv } from "./support/kit-env.ts";

const noBwrap = bwrapWorks() === null ? false : "bubblewrap cannot run here";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-write-fence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), worktree = join(home, "work"), common = join(dir, "git");
  for (const folder of [home, worktree, common]) mkdirSync(folder, { recursive: true });
  const env = { ...kitEnv(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "KIT_OUTER_LOCK"]) delete env[name];
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
