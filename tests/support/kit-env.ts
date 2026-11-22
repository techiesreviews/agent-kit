import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapWorks, outerLock } from "../../key-guard.mjs";

// This test process's environment without the kit's own home names. The kit run that started the tests exports
// KIT_HOME, and KIT_HOME_DEFAULT when its front door filled that in: a fixture inheriting a person's KIT_HOME would
// run that other kit, and one inheriting KIT_HOME_DEFAULT would read a KIT_HOME it set itself as a front door's.
// KIT_SKILL_DIRS is empty, so kit pr's skill guard never reads the real skill folders under HOME. GH_REPO and GH_HOST
// are left out, so a fixture's gh target comes only from its own remotes, never from the shell that started the tests;
// gh's config is tests/fixtures/gh-config, whose hosts.yml knows github.com, git.example.com and ghe.example, never the
// real one.
export const ghConfig = resolve(import.meta.dirname, "../fixtures/gh-config");
// XDG_STATE_HOME is one temporary folder per test process (removed when it exits), so no test reads or writes the
// machine's kit state, such as a real run's quiet lock (ticket ke-88); a fixture may still set its own.
let state: string | undefined;
function testState() {
  if (state) return state;
  const folder = mkdtempSync(join(tmpdir(), "kit-test-state-"));
  process.once("exit", () => rmSync(folder, { recursive: true, force: true }));
  return state = folder;
}
// The kit puts the folder of the first Node 24+ on PATH ahead of everything else. Where that folder also holds a real
// claude, codex, grok or opencode (a machine keeping them in ~/.local/bin), it would hide a test's fake of that tool.
// One folder holding only node, first on PATH, is the folder the kit puts first, so a fixture's own fake folder, put
// before the rest of PATH, still wins. Fixtures build their PATH from process.env.PATH, so this process's own PATH
// gets the folder once, when this file is first loaded: only test files that import this file are covered.
let nodeOnly: string | undefined;
function testNode() {
  if (nodeOnly) return nodeOnly;
  const folder = mkdtempSync(join(tmpdir(), "kit-test-node-"));
  symlinkSync(process.execPath, join(folder, "node"));
  process.once("exit", () => rmSync(folder, { recursive: true, force: true }));
  return nodeOnly = folder;
}
process.env.PATH = `${testNode()}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
// HOME and the XDG config, cache and data folders are one temporary folder per test process as well. The key lock
// (key-guard.mjs) searches the key folders under HOME before every agent run, so a fixture with the real HOME would
// list the developer's own key folders and read their git config and shell start-up files, and a dotfiles link there
// could refuse the run. Fixtures build their environment from process.env or kitEnv(), so this process's own HOME is
// swapped once, when this file is first loaded; the names that move a CLI's or git's own folders go with it. A fixture
// may still set its own.
function testHome() {
  const folder = mkdtempSync(join(tmpdir(), "kit-test-home-"));
  for (const name of [".config", ".cache", ".local/share"]) mkdirSync(join(folder, name), { recursive: true });
  process.once("exit", () => rmSync(folder, { recursive: true, force: true }));
  return folder;
}
// Build sessions keep private state beside their temporary work so a real run can resume. Give each test process
// its own temp root; removing it also removes those retained sessions, without scanning another process's folders.
const testTemporary = mkdtempSync(join(tmpdir(), "kit-test-tmp-"));
process.once("exit", () => rmSync(testTemporary, { recursive: true, force: true }));
Object.assign(process.env, { TMPDIR: testTemporary, TMP: testTemporary, TEMP: testTemporary });
export const testHomeFolder = testHome();
Object.assign(process.env, { HOME: testHomeFolder, XDG_CONFIG_HOME: join(testHomeFolder, ".config"), XDG_CACHE_HOME: join(testHomeFolder, ".cache"),
  XDG_DATA_HOME: join(testHomeFolder, ".local/share"), TMPDIR: testTemporary, TMP: testTemporary, TEMP: testTemporary });
// ASE_KEY_GUARD and KIT_KEY_PATHS from the shell that started the tests would change what the lock does in every
// fixture (off: no lock is tested at all; a path: one more folder to search), so they are dropped; a test of either
// sets it itself.
for (const name of ["ASE_KEY_GUARD", "KIT_KEY_PATHS", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "ZDOTDIR", "GIT_CONFIG_GLOBAL"]) delete process.env[name];
// KIT_SKILL_HOME names a folder that never exists, so kit doctor's skills map note reads no real skill folder.
const noSkills = resolve(import.meta.dirname, "../fixtures/no-skill-home");
// KIT_TALK_STYLE=plain keeps briefs in plain English, and KIT_BG_SCOPE=off keeps kit bg jobs out of the user's
// systemd; the tests of those two unset them.
export function kitEnv(): NodeJS.ProcessEnv {
  const { KIT_HOME: _home, KIT_HOME_DEFAULT: _default, GH_REPO: _repo, GH_HOST: _host, KIT_API_KEY_FILE: _key, KIT_API_CONFIG_DIR: _config, ASE_KEY_GUARD: _guard, KIT_KEY_PATHS: _paths, ...env } = process.env;
  return { ...env, KIT_SKILL_DIRS: "", GH_CONFIG_DIR: ghConfig, XDG_STATE_HOME: testState(), KIT_TALK_STYLE: "plain", KIT_BG_SCOPE: "off", KIT_SKILL_HOME: noSkills };
}

// Inside kit pr's lock for its checks (TOOLS-303) on a system that blocks a sandbox inside another, the kit's runs start
// no sandbox of their own (the outer lock hides the key files): a test of what bubblewrap itself does skips there, with
// this reason, and runs everywhere else (inside that lock too, where one sandbox can start inside another).
export const insideKitPrLock: string | false = outerLock() && bwrapWorks() !== null ? "inside kit pr's lock for its checks, where the kit's runs start no sandbox of their own" : false;
