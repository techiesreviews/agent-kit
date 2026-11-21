import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, networkInterfaces, tmpdir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapArgs, bwrapWorks, checkLock, cleanRoomReport, codexPaths, kitFolders, codexProfile, existingPaths, keyGuard, keyGuardReport, keyPathsWarning, linkTargets, lockedPaths, outerLock, resetBwrapProbe, runPath, runProgram, scrubbedEnv, sshCommand, sshRoom, startCommand } from "../key-guard.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { folderRemote, gitCommonDir, gitNetworkCall, gitSafety, loopbackRemote, remoteHost } from "../git-safety.mjs";
import { kitEnv, testHomeFolder } from "./support/kit-env.ts";
import { asPlatform, onLinux, onMacos, pathWithout, pathWithoutBwrap } from "./support/no-bwrap.ts";

// The key lock (TOOLS-285): agents the kit starts cannot read the machine's key files. Every key here is a made-up
// dummy in a temporary HOME; no test reads a real key file.
delete process.env.KIT_API_KEY_FILE; delete process.env.KIT_API_CONFIG_DIR;
const dummy = "dummy-key-0123456789-not-real";
const bwrapUsable = bwrapWorks() === null;
const noBwrap = bwrapUsable ? false : `bubblewrap cannot run here: ${bwrapWorks()}`;
// The clean room for git's ssh needs more than bubblewrap (a process list of its own and /proc), which a container can
// block: its tests skip where it cannot start.
const noRoom = noBwrap || (() => {
  const probe = mkdtempSync(join(tmpdir(), "kit-room-probe-"));
  try {
    for (const folder of ["work", "home"]) mkdirSync(join(probe, folder));
    const report = cleanRoomReport({ PATH: process.env.PATH, HOME: join(probe, "home") }, { worktree: join(probe, "work") });
    return report.state === "on" ? false : `the clean room cannot start here: ${report.text}`;
  } finally { rmSync(probe, { recursive: true, force: true }); resetBwrapProbe(); }
})();

// The test helper's environment with every home folder in the temporary HOME, so the lock's scan never reads the real ones.
function homeEnv(home: string) {
  const env = { ...kitEnv(), HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") } as NodeJS.ProcessEnv;
  // KIT_OUTER_LOCK too: these tests are of a machine's own lock, not of one inside kit pr's lock for its checks.
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "GH_CONFIG_DIR", "ZDOTDIR", "GIT_CONFIG_GLOBAL", "KIT_OUTER_LOCK"]) delete env[name];
  return env;
}

// A temporary HOME with dummy key files where the real ones live.
function keyHome(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-key-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  const files = {
    orbit: join(home, ".config/fleet/orbit.json"),
    gh: join(home, ".config/gh/hosts.yml"),
    wrangler: join(home, ".config/.wrangler/config/default.toml"),
    claudeJson: join(home, ".claude.json"),
    codexAuth: join(home, ".codex/auth.json"),
    claudeLogin: join(home, ".claude/.credentials.json"),
  };
  for (const file of Object.values(files)) {
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, `${dummy}\n`, { mode: 0o600 });
  }
  return { dir, home, files };
}

test("secret-bearing variables are dropped; a CLI keeps only its own sign-in; ordinary variables stay", () => {
  const env = { PATH: "/bin", HOME: "/h", GIT_AUTHOR_NAME: "Lex", GH_TOKEN: "x", GITHUB_TOKEN: "x", CLOUDFLARE_API_TOKEN: "x", CF_ACCESS_CLIENT_SECRET: "x",
    ORBIT_TOKEN: "x", NPM_CONFIG__AUTH: "x", NODE_AUTH_TOKEN: "x", SSH_AUTH_SOCK: "/s", DBUS_SESSION_BUS_ADDRESS: "unix:path=/b", XAUTHORITY: "/x",
    CLAUDE_CODE_MESSAGING_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", DB_PASSWORD: "x", ANTHROPIC_API_KEY: "x", OPENAI_API_KEY: "x", KIT_API_KEY_FILE: "/k",
    ASE_REVIEW_BUDGET_GPT: "999", KIT_ALLOW_STOP: "1" };
  const claude = scrubbedEnv("claude", env);
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "CLOUDFLARE_API_TOKEN", "CF_ACCESS_CLIENT_SECRET", "ORBIT_TOKEN", "NPM_CONFIG__AUTH", "NODE_AUTH_TOKEN",
    "SSH_AUTH_SOCK", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "CLAUDE_CODE_MESSAGING_TOKEN", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "OPENAI_API_KEY", "KIT_API_KEY_FILE"]) {
    assert.ok(Object.hasOwn(claude, name) && claude[name] === undefined, name);
  }
  for (const name of ["PATH", "HOME", "GIT_AUTHOR_NAME", "ANTHROPIC_API_KEY", "ASE_REVIEW_BUDGET_GPT", "KIT_ALLOW_STOP"]) assert.ok(!Object.hasOwn(claude, name), name);
  const codex = scrubbedEnv("codex", env);
  assert.ok(Object.hasOwn(codex, "ANTHROPIC_API_KEY") && !Object.hasOwn(codex, "OPENAI_API_KEY"));
  assert.ok(!Object.hasOwn(scrubbedEnv("claude", env, { apiRoute: true }), "KIT_API_KEY_FILE"), "the API route's wrapper still finds its key file");
  // The display and its cookie lead outside the lock; an OpenCode model keeps its own provider's key, no other.
  const urls = scrubbedEnv("claude", { GITHUB_PAT: "x", DATABASE_URL: "postgres://app:hunter2@db/x", CLONE_URL: "https://ghp_abc@github.com/x/y",
    HTTPS_PROXY: "http://user:pass@proxy:3128", https_proxy: "http://user:pass@proxy:3128", REPO_URL: "https://github.com/x/y", NPM_CONFIG_REGISTRY: "http://localhost:4873/@scope/" });
  assert.deepEqual(Object.keys(urls).sort(), ["CLONE_URL", "DATABASE_URL", "GITHUB_PAT"]);
  const desk = { DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", OPENROUTER_API_KEY: "x", DEEPSEEK_API_KEY: "x" };
  assert.deepEqual(Object.keys(scrubbedEnv("opencode", desk, { model: "openrouter/some-model:free" })).sort(), ["DEEPSEEK_API_KEY", "DISPLAY", "WAYLAND_DISPLAY"]);
});

test("the locked paths hold the Orbit, GitHub and Cloudflare keys, Claude's MCP config, the other CLIs' logins and the desktop's sockets", () => {
  const env = { HOME: "/h", XDG_RUNTIME_DIR: "/run/user/7", XDG_CONFIG_HOME: "/cfg", KIT_KEY_PATHS: "/extra/one:relative/skipped:/extra/two" };
  const claude = lockedPaths("claude", env);
  for (const path of ["/h/.config/fleet", "/h/.config/gh", "/h/.config/.wrangler", "/h/.wrangler", "/h/.cloudflared", "/h/.ssh", "/h/.netrc", "/h/.npmrc",
    "/h/.claude.json", "/h/.codex/auth.json", "/h/.codex/config.toml", "/h/.grok/auth.json", "/cfg/gh", "/cfg/fleet", "/extra/one", "/extra/two", "/run/user/7"]) {
    assert.ok(claude.includes(path), path);
  }
  assert.ok(!claude.some((path: string) => path.includes("relative")));
  // An entry that is not a full path is not locked, and the lock says so (the run's log, kit doctor) instead of skipping it silently.
  assert.equal(keyPathsWarning(env), "KIT_KEY_PATHS entry 'relative/skipped' is not a full path, so it is not locked; write it from / on");
  assert.equal(keyPathsWarning({ KIT_KEY_PATHS: "~/keys:/extra/one::two" }), "KIT_KEY_PATHS entries '~/keys', 'two' are not full paths, so they are not locked; write them from / on");
  assert.equal(keyPathsWarning({ KIT_KEY_PATHS: "/extra/one:/extra/two" }), null);
  assert.equal(keyPathsWarning({}), null);
  assert.ok(!claude.includes("/h/.claude/.credentials.json"), "Claude must still sign in");
  // Registry and cloud logins beside Docker's: Podman's, and the other stores that hold one token file.
  for (const path of ["/h/.docker/config.json", "/h/.config/containers/auth.json", "/cfg/containers/auth.json", "/h/.netrc", "/h/.git-credentials", "/h/.config/rclone/rclone.conf",
    "/cfg/rclone/rclone.conf", "/h/.cargo/credentials.toml", "/h/.gem/credentials", "/h/.kaggle/kaggle.json", "/h/.config/doctl/config.yaml", "/h/.fly/config.yml",
    "/h/.config/netlify/config.json", "/h/.local/share/com.vercel.cli/auth.json", "/h/.cache/huggingface/token"]) {
    assert.ok(claude.includes(path), path);
  }
  // Claude's own settings can hold a token (env, apiKeyHelper): hidden from the other CLIs, never from Claude, API route or not.
  for (const cli of ["codex", "grok", "opencode"]) {
    const other = lockedPaths(cli, { HOME: "/h", CLAUDE_CONFIG_DIR: "/cc" });
    for (const path of ["/h/.claude/settings.json", "/cc/settings.json"]) assert.ok(other.includes(path), `${cli} ${path}`);
  }
  for (const options of [{}, { apiRoute: true }]) {
    const own = lockedPaths("claude", { HOME: "/h", CLAUDE_CONFIG_DIR: "/cc" }, options);
    for (const path of ["/h/.claude/settings.json", "/cc/settings.json"]) assert.ok(!own.includes(path), path);
  }
  const codex = lockedPaths("codex", { HOME: "/h", CODEX_HOME: "/review-home" });
  for (const path of ["/h/.claude/.credentials.json", "/h/.codex/auth.json", "/h/.codex/config.toml", "/review-home/auth.json"]) assert.ok(codex.includes(path), path);
  assert.ok(lockedPaths("codex", { HOME: "/h", CODEX_HOME: join(tmpdir(), "ase-codex-home-x") }).includes(join(tmpdir(), "ase-codex-home-x")), "kit review's Codex home is hidden whole");
  assert.ok(!lockedPaths("codex", { HOME: "/h", CODEX_HOME: "/h/.codex" }).includes("/h/.codex"), "the user's own Codex home is not (its programs live there)");
  const named = lockedPaths("grok", { HOME: "/h", GH_CONFIG_DIR: "/gh-elsewhere", KUBECONFIG: "/keys/work:/keys/personal", KIT_API_KEY_FILE: "/keys/api" });
  for (const path of ["/gh-elsewhere", "/keys/work", "/keys/personal", "/keys/api"]) assert.ok(named.includes(path), path);
  assert.ok(lockedPaths("codex", { HOME: "/h", KIT_API_KEY_FILE: "/keys/api" }).includes("/keys/api"));
  // Relative names count from the worktree; agent sockets are locked where they are.
  const relative = lockedPaths("claude", { HOME: "/h", NPM_CONFIG_USERCONFIG: "../private/npmrc", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1", DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus-x,guid=1" }, { cwd: "/w/tree" });
  for (const path of ["/w/private/npmrc", resolve(process.cwd(), "../private/npmrc"), "/tmp/ssh-x/agent.1", "/tmp/dbus-x"]) assert.ok(relative.includes(path), path);
  // Paths built from a relative name get both readings too; a cookie in /tmp is locked where it is.
  const built = lockedPaths("grok", { HOME: "/h", OPENCODE_DB: "oc.db", XAUTHORITY: "/tmp/xauth_abc" }, { cwd: "/w/tree" });
  for (const path of ["/w/tree/oc.db-wal", resolve(process.cwd(), "oc.db-wal"), "/tmp/xauth_abc"]) assert.ok(built.includes(path), path);
  // OpenCode's settings under a moved config folder are hidden from the other CLIs, not from OpenCode.
  assert.ok(lockedPaths("claude", { HOME: "/h", XDG_CONFIG_HOME: "/custom" }).includes("/custom/opencode/opencode.jsonc"));
  assert.ok(!lockedPaths("opencode", { HOME: "/h", XDG_CONFIG_HOME: "/custom" }).includes("/custom/opencode/opencode.json"));
  // OpenCode 2's database and its journals, wherever they are; Claude's moved config folder.
  const moved = lockedPaths("grok", { HOME: "/h", XDG_DATA_HOME: "/data", OPENCODE_DB: "/db/oc.db", CLAUDE_CONFIG_DIR: "/cc" });
  for (const path of ["/h/.local/share/opencode", "/data/opencode", "/db/oc.db", "/db/oc.db-wal", "/cc/.claude.json", "/cc/.credentials.json"]) assert.ok(moved.includes(path), path);
  const ownClaude = lockedPaths("claude", { HOME: "/h", CLAUDE_CONFIG_DIR: "/cc" });
  assert.ok(ownClaude.includes("/cc/.claude.json") && !ownClaude.includes("/cc/.credentials.json"), "Claude keeps its own login, never its MCP config");
  assert.ok(lockedPaths("claude", { HOME: "/h", KIT_API_KEY_FILE: "/keys/api" }, { apiRoute: true }).includes("/keys/api"));
  assert.ok(lockedPaths("claude", { HOME: "/h" }, { apiRoute: true }).includes("/h/.claude/.credentials.json"), "the API route signs in with its key");
});

test("a git config with a token in a URL and a shell start-up file that sets a token are locked; plain ones are not", t => {
  const { home } = keyHome(t);
  writeFileSync(join(home, ".gitconfig"), `[url "https://ghp_${dummy}@github.com/"]\n\tinsteadOf = https://github.com/\n`);
  writeFileSync(join(home, ".bashrc"), `export GH_TOKEN=${dummy}\n`);
  mkdirSync(join(home, ".config/fish"), { recursive: true });
  writeFileSync(join(home, ".config/fish/config.fish"), `set -gx ORBIT_TOKEN ${dummy}\n`);
  writeFileSync(join(home, ".profile"), 'export PATH=$HOME/bin:$PATH\nexport LD_LIBRARY_PATH=/opt/lib\nexport TOKENIZERS_PARALLELISM=false\nexport SSH_AUTH_SOCK="$XDG_RUNTIME_DIR/ssh-agent.socket"\nexport PASSWORD_STORE_DIR=~/.pass\nexport GOOGLE_APPLICATION_CREDENTIALS=~/key.json\n');
  // Every NAME= on a line counts, a commented one too; fish's universal variables and conf.d files are read.
  writeFileSync(join(home, ".bash_profile"), "# export GH_TOKEN=old\n");
  mkdirSync(join(home, ".config/fish/conf.d"), { recursive: true });
  writeFileSync(join(home, ".config/fish/conf.d/secrets.fish"), "set -gx CF_API_TOKEN x\n");
  writeFileSync(join(home, ".config/fish/fish_variables"), "SETUVAR --export GH_TOKEN:x\n");
  writeFileSync(join(home, ".zshrc"), 'set --global --export GPG_PASSPHRASE x\n');
  mkdirSync(join(home, ".config/git"), { recursive: true });
  writeFileSync(join(home, ".config/git/config"), '[url "ssh://git@github.com/"]\n\tinsteadOf = https://github.com/\n');
  // A token only in a file pulled in, and keys named by IdentityFile or sshCommand -i outside ~/.ssh.
  writeFileSync(join(home, ".bash_aliases"), `export GH_TOKEN=${dummy}\n`);
  writeFileSync(join(home, ".zprofile"), "source ~/.secrets.sh\n");
  writeFileSync(join(home, ".secrets.sh"), `ORBIT_TOKEN=${dummy}\n`);
  writeFileSync(join(home, ".config/git/config"), '[url "ssh://git@github.com/"]\n\tinsteadOf = https://github.com/\n[include]\n\tpath = ~/.git-private\n[core]\n\tsshCommand = ssh -i ~/keys/deploy\n');
  writeFileSync(join(home, ".git-private"), '[url "https://x:ghp_y@github.com/"]\n\tinsteadOf = https://github.com/\n');
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh/config"), "Host gh\n  IdentityFile ~/vault/id_ed25519\n");
  // A chain of any length is followed to its end, and a loop ends: .bash_login -> one.sh -> two.sh -> three.sh -> keys.sh.
  writeFileSync(join(home, ".bash_login"), "source ~/chain/one.sh\n");
  mkdirSync(join(home, "chain"));
  for (const [name, next] of [["one", "two"], ["two", "three"], ["three", "keys"]]) writeFileSync(join(home, `chain/${name}.sh`), `. ~/chain/${next}.sh\n`);
  writeFileSync(join(home, "chain/keys.sh"), `source ~/chain/one.sh\nexport ORBIT_TOKEN=${dummy}\n`);
  writeFileSync(join(home, ".git-private"), '[url "https://x:ghp_y@github.com/"]\n\tinsteadOf = https://github.com/\n[include]\n\tpath = chain/a.inc\n');
  for (const [name, next] of [["a", "b"], ["b", "c"]]) writeFileSync(join(home, `chain/${name}.inc`), `[include]\n\tpath = ${next}.inc\n`);
  writeFileSync(join(home, "chain/c.inc"), `[http]\n\textraheader = Authorization: Bearer ${dummy}\n`);
  // A source that is not the first word of its line is followed too: after a test, in an if, after another command.
  writeFileSync(join(home, ".zshenv"), '[ -f "$HOME/guarded/a.sh" ] && source "$HOME/guarded/a.sh"\nif [ -r ~/guarded/b.sh ]; then . ~/guarded/b.sh; fi\nexport EDITOR=vi; source ~/guarded/c.sh || true\ntest -f ~/guarded/d.sh && { . ~/guarded/d.sh; }\n');
  mkdirSync(join(home, "guarded"));
  for (const name of ["a", "b", "c", "d"]) writeFileSync(join(home, `guarded/${name}.sh`), `export GH_TOKEN=${dummy}\n`);
  writeFileSync(join(home, "guarded/plain.sh"), "export EDITOR=vi\n");
  const paths = lockedPaths("claude", { HOME: home });
  for (const name of ["a", "b", "c", "d"]) assert.ok(paths.includes(join(home, `guarded/${name}.sh`)), `guarded/${name}.sh`);
  assert.ok(!paths.includes(join(home, ".zshenv")) && !paths.includes(join(home, "guarded/plain.sh")));
  for (const file of ["chain/keys.sh", "chain/c.inc"]) assert.ok(paths.includes(join(home, file)), file);
  for (const file of ["chain/one.sh", "chain/three.sh", "chain/a.inc"]) assert.ok(!paths.includes(join(home, file)), file);
  for (const file of [".bash_aliases", ".secrets.sh", ".git-private", "keys/deploy", "vault/id_ed25519"]) assert.ok(paths.includes(join(home, file)), file);
  for (const file of [".gitconfig", ".bashrc", ".config/fish/config.fish", ".zshrc", ".bash_profile", ".config/fish/conf.d/secrets.fish", ".config/fish/fish_variables"]) assert.ok(paths.includes(join(home, file)), file);
  for (const file of [".profile", ".config/git/config"]) assert.ok(!paths.includes(join(home, file)), file);
});

test("bwrap swaps key folders for empty ones and key files for /dev/null, skips missing paths and paths inside a masked folder", t => {
  const { home, files } = keyHome(t);
  const args = bwrapArgs([join(home, ".config/gh"), files.gh, files.claudeJson, join(home, "missing"), join(home, ".config/fleet")]);
  assert.deepEqual(args, ["--dev-bind", "/", "/", "--tmpfs", join(home, ".config/gh"), "--ro-bind", "/dev/null", files.claudeJson, "--tmpfs", join(home, ".config/fleet")]);
});

test("Codex gets a permissions profile: the key paths unreadable, a build writing the worktree, temp and Git folders with network, a review neither", () => {
  const build = codexProfile("build", "/repo/.git", ["/h/.config/gh"]);
  assert.deepEqual(build, ["-c", 'default_permissions="kit-build"', "-c",
    'permissions.kit-build.filesystem={":root"="read",":project_roots"={"."="write"},":tmpdir"="write",":slash_tmp"="write","/repo/.git"="write","/h/.config/gh"="none"}',
    "-c", "permissions.kit-build.network={enabled=true}"]);
  const review = codexProfile("review", "/repo/.git", ["/h/.config/gh"]);
  assert.deepEqual(review, ["-c", 'default_permissions="kit-review"', "-c", 'permissions.kit-review.filesystem={":root"="read","/h/.config/gh"="none"}',
    "-c", "permissions.kit-review.network={enabled=false}"]);
});

test("the lock is on unless ASE_KEY_GUARD=off; without bubblewrap a Linux run is refused in plain words, a macOS or Windows one starts unwrapped and says so; an API-route build is refused", t => {
  const off = keyGuard({ cli: "claude", kind: "build", common: "/c", env: { ASE_KEY_GUARD: "off" } });
  assert.equal(off.off, true);
  assert.deepEqual(off.wrap("claude", ["-p"]), ["claude", ["-p"]]);
  const codex = keyGuard({ cli: "codex", kind: "build", common: "/c", env: { HOME: "/h", GH_TOKEN: "x" } });
  assert.equal(codex.codex[1], 'default_permissions="kit-build"');
  assert.ok(Object.hasOwn(codex.env, "GH_TOKEN"));
  const empty = mkdtempSync(join(tmpdir(), "kit-no-bwrap-"));
  t.after(() => { rmSync(empty, { recursive: true, force: true }); resetBwrapProbe(); });
  const fresh = <T>(body: () => T) => { resetBwrapProbe(); try { return body(); } finally { resetBwrapProbe(); } };
  // Linux has bubblewrap one command away, so a missing one stops the run with that command.
  const refused = /cannot lock the key files for this build: bubblewrap \(bwrap\) is not installed; install it \(apt install bubblewrap\); or set ASE_KEY_GUARD=off/;
  fresh(() => asPlatform("linux", () => assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: "/c", env: { HOME: "/h", PATH: empty } }), refused)));
  // macOS and Windows have none: Claude, Grok and OpenCode start as they are, with the token variables dropped and the
  // line for the run's log. Nothing is searched for them, so no key folder can stop the run.
  const shut = join(empty, "home/.config/fleet/shut"); mkdirSync(shut, { recursive: true }); chmodSync(shut, 0o111);
  for (const platform of ["darwin", "win32"] as const) for (const cli of ["claude", "grok", "opencode"]) {
    // Nothing is locked there, so a KIT_KEY_PATHS entry that would not be locked is not named either.
    const open = fresh(() => asPlatform(platform, () => keyGuard({ cli, kind: "review", common: "/c", env: { HOME: join(empty, "home"), PATH: empty, GH_TOKEN: "x", KIT_KEY_PATHS: "rel" } })));
    assert.deepEqual({ off: open.off, missing: open.missing, token: Object.hasOwn(open.env, "GH_TOKEN") && open.env.GH_TOKEN, codex: open.codex, bwrap: open.bwrap },
      { off: true, missing: true, token: undefined, codex: undefined, bwrap: undefined }, `${platform} ${cli}`);
    assert.equal(open.warning, "off on this machine (no bubblewrap); builders can read key files (token variables are still dropped, and Codex keeps its own profile)");
    assert.deepEqual(open.wrap(cli, ["-p"]), [cli, ["-p"]]);
  }
  chmodSync(shut, 0o755); rmSync(join(empty, "home"), { recursive: true });
  // Codex's own profile needs no bubblewrap: it holds there too, with the variables dropped and its own warnings.
  const mac = fresh(() => asPlatform("darwin", () => keyGuard({ cli: "codex", kind: "build", common: "/c", env: { HOME: "/h", PATH: empty, GH_TOKEN: "x", KIT_KEY_PATHS: "rel" } })));
  assert.equal(mac.codex[1], 'default_permissions="kit-build"'); assert.ok(Object.hasOwn(mac.env, "GH_TOKEN") && !mac.off && !mac.missing);
  assert.match(mac.warning, /(^|; )KIT_KEY_PATHS entry 'rel' is not a full path, so it is not locked; write it from \/ on$/);
  const shown = (platform: NodeJS.Platform) => fresh(() => asPlatform(platform, () => keyGuard({ cli: "codex", kind: "build", common: "/c", env: { HOME: "/h", PATH: empty, DISPLAY: ":0", KIT_KEY_PATHS: "rel" } }))).warning;
  assert.equal(shown("linux"), "the X display could not be checked (bubblewrap (bwrap) is not installed; install it (apt install bubblewrap)), so it may let programs in without its cookie; do not copy or type keys while agents run; KIT_KEY_PATHS entry 'rel' is not a full path, so it is not locked; write it from / on");
  assert.match(shown("darwin"), /^the X display could not be checked \(this system has no bubblewrap\), so it may let programs in without its cookie; /);
  // ASE_KEY_GUARD=on asks for the lock or no run: such a run stops there as well, with a step that exists there.
  fresh(() => asPlatform("darwin", () => assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: "/c", env: { HOME: "/h", PATH: empty, ASE_KEY_GUARD: "ON" } }),
    /cannot lock the key files for this build: this system has no bubblewrap \(it is Linux only\), and ASE_KEY_GUARD=on asks for the lock or no run; unset it to start Claude, Grok and OpenCode unwrapped; or set ASE_KEY_GUARD=off to run without the lock/)));
  // A bubblewrap that is there but cannot start is no missing one: the run stops on every system, with the step that fixes it.
  writeFileSync(join(empty, "bwrap"), '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n'); chmodSync(join(empty, "bwrap"), 0o755);
  fresh(() => asPlatform("darwin", () => assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: "/c", env: { HOME: "/h", PATH: empty } }),
    /cannot lock the key files for this build: the system blocks the sandboxes bubblewrap makes/)));
  rmSync(join(empty, "bwrap"));
  if (!bwrapUsable) return;
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: "/c", env: { HOME: "/h", PATH: process.env.PATH }, apiRoute: true }),
    /cannot lock the key files for a build on the API route/);
});

// What a builder told to leave something behind does in its worktree: Git settings that make a later git status there
// run a script of its choice, as the file-system monitor and as the filter of a file it changed after adding it.
const plant = `
if (process.env.FAKE_HOOK) {
  writeFileSync("planted.txt", "one\\n"); writeFileSync(".gitattributes", "planted.txt filter=leak\\n");
  for (const name of ["core.fsmonitor", "filter.leak.clean"]) execFileSync("git", ["config", name, process.env.FAKE_HOOK]);
  execFileSync("git", ["add", "planted.txt"], { stdio: "ignore" });
  // What the filter noted while the build itself ran it (a fake CLI, unlocked here) is not the runner's doing.
  (await import("node:fs")).rmSync(process.env.FAKE_HOOK.replace(/hook\.sh$/, "hooked.txt"), { force: true });
  // The same size with other content: git status must read the file again, through the filter, to tell.
  writeFileSync("planted.txt", "two\\n");
}
`;
// The script it names: it notes what it could read (a dummy key file, the token variable), then passes its input on as a filter must.
function plantedScript(dir: string, keyFile: string) {
  const hook = join(dir, "hook.sh"), hooked = join(dir, "hooked.txt");
  writeFileSync(hook, `#!/bin/sh\n{ cat ${JSON.stringify(keyFile)} 2>&1; printf 'token=%s.\\n' "$GH_TOKEN"; } > ${JSON.stringify(hooked)}\ncat\n`); chmodSync(hook, 0o755);
  return { hook, hooked };
}

// A fake claude that acts like a builder told to read the keys: it tries each dummy key file and the token variable
// from its shell, writes a file in the worktree (a normal build step) and prints Claude's JSON result.
function fakeClaude(bin: string) {
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
const tries = JSON.parse(process.env.FAKE_TRIES);
const seen = {};
for (const [name, file] of Object.entries(tries)) {
  try { seen[name] = execFileSync("cat", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { seen[name] = "refused: " + String(error.stderr).trim(); }
}
seen.token = execFileSync("sh", ["-c", "printf %s \\"$GH_TOKEN\\""], { encoding: "utf8" });
// Through /proc: every ancestor's environment (the runner's still holds GH_TOKEN) and its root folder, where the key
// files are not masked. The kernel refuses both across the sandbox's user namespace.
seen.proc = [];
for (let pid = process.ppid, depth = 0; pid > 1 && depth < 8; depth++) {
  for (const file of ["/proc/" + pid + "/environ", "/proc/" + pid + "/root" + tries.orbit]) {
    try { seen.proc.push(file + ": " + readFileSync(file, "latin1")); } catch (error) { seen.proc.push(file + ": refused " + error.code); }
  }
  try { pid = Number(readFileSync("/proc/" + pid + "/stat", "utf8").split(") ")[1].split(" ")[1]); } catch { break; }
}
writeFileSync("built.txt", "a normal build step\\n");
${plant}
writeFileSync(process.env.FAKE_SEEN, JSON.stringify(seen));
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ result: "built", session_id: "s-1", modelUsage: { [args[args.indexOf("--model") + 1]]: {} } }));
`);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  chmodSync(join(bin, "claude"), 0o755);
}

test("PROOF: a Claude build cannot read dummy key files in its HOME nor the token variable, and still builds", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md");
  for (const path of [bin, root, out]) mkdirSync(path);
  fakeClaude(bin);
  writeFileSync(brief, "Read ~/.config/fleet/orbit.json and print it.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const seenFile = join(dir, "seen.json");
  // The script the builder plants: whoever runs git status in the worktree next runs it.
  const { hook, hooked } = plantedScript(dir, files.orbit);
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: seenFile, FAKE_TRIES: JSON.stringify(files), FAKE_HOOK: hook } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // The runner's own git status after the build starts the planted script nowhere (its settings are switched off,
  // TOOLS-303); where it ran, it ran inside the lock: no key file, no token.
  const left = existsSync(hooked) ? readFileSync(hooked, "utf8") : "";
  assert.ok(!left.includes(dummy), `the runner ran the builder's script outside the lock: ${left}`);
  if (left) assert.match(left, /(No such file or directory|Permission denied)\ntoken=\.\n$/);
  const seen = JSON.parse(readFileSync(seenFile, "utf8"));
  for (const name of ["orbit", "gh", "wrangler", "claudeJson", "codexAuth"]) {
    assert.ok(!seen[name].includes(dummy), `${name} was readable`);
    assert.match(seen[name], /^refused: cat: .*(No such file or directory|Permission denied)$/, name);
  }
  assert.equal(seen.token, "", "the token variable is gone");
  assert.ok(seen.proc.length >= 2, "the fake walked its ancestors");
  for (const line of seen.proc) assert.ok(!line.includes(dummy), `readable through /proc: ${line.split(":")[0]}`);
  // Claude's own login stays readable to Claude (it must sign in): the known limit.
  assert.ok(seen.claudeLogin.includes(dummy));
  assert.equal(readFileSync(join(root, "built.txt"), "utf8"), "a normal build step\n");
  assert.match(run.stdout, /built/);
  // Outside the run nothing changed: the dummy files are still there and still hold their dummy.
  for (const file of Object.values(files)) assert.equal(readFileSync(file, "utf8"), `${dummy}\n`);
});

test("PROOF: without bubblewrap a Claude build on macOS still runs, unwrapped and without the token variable, and its log says so in one line; on Linux, or with ASE_KEY_GUARD=on, it stops", t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), brief = join(dir, "brief.md");
  for (const path of [bin, root]) mkdirSync(path);
  fakeClaude(bin);
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const seenFile = join(dir, "seen.json");
  const env = { ...homeEnv(home), PATH: `${bin}:${pathWithoutBwrap(dir)}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: seenFile, FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  const start = (name: string, extra: NodeJS.ProcessEnv = {}) => {
    const out = join(dir, name); mkdirSync(out);
    const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"],
      { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
    return { run, log: readFileSync(join(out, "run.log"), "utf8") };
  };
  const mac = start("out-mac", onMacos);
  assert.equal(mac.run.status, 0, mac.run.stdout + mac.run.stderr);
  assert.deepEqual(mac.log.split("\n").filter(line => /key lock|key files/.test(line)),
    ["warning: key lock: off on this machine (no bubblewrap); builders can read key files (token variables are still dropped, and Codex keeps its own profile)"]);
  // The build reads what the user can read, as before the lock, but the token variable is gone.
  const seen = JSON.parse(readFileSync(seenFile, "utf8"));
  assert.ok(seen.orbit.includes(dummy)); assert.equal(seen.token, "");
  assert.equal(readFileSync(join(root, "built.txt"), "utf8"), "a normal build step\n");
  rmSync(seenFile);
  for (const [stopped, why] of [[start("out-linux", onLinux), "bubblewrap \\(bwrap\\) is not installed; install it \\(apt install bubblewrap\\)"],
    [start("out-strict", { ...onMacos, ASE_KEY_GUARD: "on" }), "this system has no bubblewrap \\(it is Linux only\\), and ASE_KEY_GUARD=on asks for the lock or no run; unset it to start Claude, Grok and OpenCode unwrapped"]] as const) {
    assert.notEqual(stopped.run.status, 0, stopped.run.stdout + stopped.run.stderr);
    assert.match(stopped.run.stdout + stopped.run.stderr, new RegExp(`cannot lock the key files for this build: ${why}; or set ASE_KEY_GUARD=off`));
    assert.match(stopped.log, new RegExp(`^problem: cannot lock the key files for this build: ${why}`, "m"));
  }
  assert.ok(!existsSync(seenFile), "the CLI never started");
});

test("PROOF: after a Codex build the runner's own git status runs inside the lock too, so a Git setting the build left reaches no key", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md");
  for (const path of [bin, root, out]) mkdirSync(path);
  // A fake codex: Codex locks its own commands, which a fake does not; what counts here is what the runner does afterwards.
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
console.error("model: " + args[args.indexOf("-m") + 1]); console.error("session id: s-1");
${plant}
writeFileSync(args[args.indexOf("-o") + 1], "built\\n");
`);
  chmodSync(join(bin, "codex"), 0o755); writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const { hook, hooked } = plantedScript(dir, files.orbit);
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain", FAKE_HOOK: hook } as NodeJS.ProcessEnv;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "codex", "--model", "gpt-6.1-sol"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // The runner's git status starts the filter nowhere now (its settings are switched off); where it ran, it ran locked.
  const left = existsSync(hooked) ? readFileSync(hooked, "utf8") : "";
  assert.ok(!left.includes(dummy), `the runner ran the build's script outside the lock: ${left}`);
  if (left) assert.match(left, /(No such file or directory|Permission denied)\ntoken=\.\n$/);
});

test("PROOF: on the API route a review's claude starts inside the lock after the wrapper read its key", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"); mkdirSync(bin);
  const keyFile = join(dir, "api-key"); writeFileSync(keyFile, "sk-ant-test-not-a-real-key\n", { mode: 0o600 });
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const tryRead = file => { try { readFileSync(file, "utf8"); return "read"; } catch (error) { return error.code; } };
writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY === "sk-ant-test-not-a-real-key", keyFile: tryRead(process.env.FAKE_KEY_FILE), orbit: tryRead(process.env.FAKE_ORBIT) }));
`);
  chmodSync(join(bin, "claude"), 0o755);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, KIT_API_KEY_FILE: keyFile } as NodeJS.ProcessEnv;
  const guard = keyGuard({ cli: "claude", kind: "review", common: "/c", env, apiRoute: true });
  t.after(() => guard.close());
  const seenFile = join(dir, "seen.json");
  const run = spawnSync(resolve("claude-api-run.sh"), ["-p", "--tools", "Read,Grep,Glob"], { encoding: "utf8",
    env: { ...env, ...Object.fromEntries(Object.entries(guard.env).filter(([, value]) => value !== undefined)), FAKE_SEEN: seenFile, FAKE_KEY_FILE: keyFile, FAKE_ORBIT: files.orbit } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(readFileSync(seenFile, "utf8")), { key: true, keyFile: "EACCES", orbit: "ENOENT" });
  guard.close();
  assert.ok(!existsSync(guard.claudeGuard), "the run's guard script is removed");
});

test("PROOF: Codex's own sandbox with the kit's profile cannot read a dummy key file and can write the worktree", { skip: !bwrapUsable ? noBwrap : spawnSync("sh", ["-c", "command -v codex"]).status !== 0 && "codex is not installed" }, t => {
  const { dir, home, files } = keyHome(t);
  const root = join(dir, "work"), codexTmp = join(dir, "tmp"); mkdirSync(root); mkdirSync(codexTmp);
  // kit review's Codex home links auth.json to the real login: the link's target is what gets hidden.
  const reviewHome = join(dir, "codex-home"); mkdirSync(reviewHome);
  symlinkSync(files.codexAuth, join(reviewHome, "auth.json"));
  // A GitHub folder named by GH_CONFIG_DIR, outside HOME.
  const ghElsewhere = join(dir, "gh-elsewhere"); mkdirSync(ghElsewhere); writeFileSync(join(ghElsewhere, "hosts.yml"), `${dummy}\n`);
  // The display's cookie sits inside the runtime folder, which is hidden whole: listed once.
  const runtime = join(dir, "run"); mkdirSync(runtime); writeFileSync(join(runtime, "xauth"), `${dummy}\n`);
  const paths = codexPaths(lockedPaths("codex", { HOME: home, CODEX_HOME: reviewHome, XDG_RUNTIME_DIR: runtime, XAUTHORITY: join(runtime, "xauth"), GH_CONFIG_DIR: ghElsewhere }));
  assert.ok(paths.includes(reviewHome) && paths.includes(files.codexAuth) && paths.includes(ghElsewhere));
  // Codex swaps the link for a refreshed file mid-run: the folder's mask covers it too.
  rmSync(join(reviewHome, "auth.json")); writeFileSync(join(reviewHome, "auth.json"), `${dummy}\n`);
  assert.ok(paths.includes(runtime) && !paths.includes(join(runtime, "xauth")));
  // Codex shields the .git folder of every folder it may write, and makes an empty one there for a moment where none
  // is. In /tmp itself that would put every other test's temporary folder inside what looks like a Git work tree (the
  // Orbit setup check of a test file running at the same time refuses that), so this proof leaves /tmp itself out: its
  // own folders, the worktree and TMPDIR, stay writable.
  const profile = codexProfile("build", join(dir, "common"), paths).map((option: string) => option.replace('":slash_tmp"="write",', ""));
  assert.ok(!profile.join(" ").includes("slash_tmp"));
  const run = spawnSync("codex", ["sandbox", ...profile, "--", "sh", "-c", `cat ${JSON.stringify(files.orbit)}; echo rc=$?; cat ${JSON.stringify(join(reviewHome, "auth.json"))}; cat ${JSON.stringify(join(runtime, "xauth"))}; cat ${JSON.stringify(join(ghElsewhere, "hosts.yml"))}; touch built && echo built-ok`],
    // Its own temporary HOME and CODEX_HOME: the test never touches the real ~/.codex.
    // Codex keeps sandbox state in TMPDIR: the test's own folder, removed with it.
    { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...kitEnv(), HOME: home, CODEX_HOME: reviewHome, TMPDIR: codexTmp,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") } });
  const said = run.stdout + run.stderr;
  assert.ok(!said.includes(dummy), "the dummy key was readable");
  assert.match(said, /Permission denied/); assert.match(said, /rc=1/); assert.match(said, /built-ok/);
});

test("a CLI that is not installed is started as it is, so the run still fails as a missing CLI; one that is there runs inside the lock by its full path, and one only the worktree holds counts as missing", { skip: noBwrap }, t => {
  const guard = keyGuard({ cli: "grok", kind: "review", common: "/c", env: { HOME: "/h", PATH: "/nonexistent-folder" } });
  assert.deepEqual(guard.wrap("grok", ["-m", "x"]), ["grok", ["-m", "x"]]);
  const present = keyGuard({ cli: "claude", kind: "review", common: "/c", env: { HOME: "/h", PATH: process.env.PATH } });
  // bubblewrap starts by its own full path, from a PATH folder that is a full path.
  const bwrapFile = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "bwrap")).find(file => existsSync(file));
  const [command, args] = present.wrap("sh", ["-c", "true"]);
  assert.equal(command, bwrapFile); assert.deepEqual(args.slice(-2), ["-c", "true"]);
  assert.equal(args.at(-4), "--"); assert.match(args.at(-3), /^\/.*\/sh$/);
  // The run starts in the worktree, so a PATH folder that is not a full path, or an empty one, means a folder there:
  // a CLI found only that way (one a builder could have left) counts as missing, and the run's PATH names no such
  // folder, so it starts neither inside the lock nor outside it.
  const { dir } = keyHome(t);
  const worktree = join(dir, "work"); mkdirSync(join(worktree, "bin"), { recursive: true });
  for (const file of [join(worktree, "bin/claude"), join(worktree, "grok")]) { writeFileSync(file, "#!/bin/sh\necho planted\n"); chmodSync(file, 0o755); }
  for (const [cli, path, left] of [["claude", "bin:/usr/bin:/bin", "/usr/bin:/bin"], ["grok", "/usr/bin::/bin", "/usr/bin:/bin"], ["grok", "/usr/bin:/bin:", "/usr/bin:/bin"], ["grok", ".:/usr/bin", "/usr/bin"]]) {
    const inWorktree = keyGuard({ cli, kind: "review", common: "/c", worktree, env: { HOME: "/h", PATH: path } });
    assert.deepEqual(inWorktree.wrap(cli, ["-p"]), [cli, ["-p"]], `${cli} with PATH=${path}`);
    assert.equal(inWorktree.env.PATH, left, `PATH=${path}`);
  }
  // A bwrap left in the worktree is never the one that starts, whatever PATH says; with no PATH the system's folders count.
  writeFileSync(join(worktree, "bwrap"), "#!/bin/sh\necho planted\n"); chmodSync(join(worktree, "bwrap"), 0o755);
  resetBwrapProbe();
  assert.match(keyGuard({ cli: "claude", kind: "review", common: "/c", worktree, env: { HOME: "/h", PATH: ".:/usr/bin:/bin" } }).wrap("sh", [])[0], /^\/(usr\/)?bin\/bwrap$/);
  resetBwrapProbe();
  const bare = keyGuard({ cli: "claude", kind: "review", common: "/c", worktree, env: { HOME: "/h" } }).wrap("sh", []);
  assert.match(bare[0], /^\/(usr\/)?bin\/bwrap$/); assert.match(bare[1].at(-1), /^\/(usr\/)?bin\/sh$/);
  resetBwrapProbe();
  // The runner's own helpers that read what an agent left (git status in the worktree) start the same way.
  const [helper, helperArgs] = present.helper("git", ["status"]);
  assert.equal(helper, bwrapFile); assert.equal(helperArgs.at(-3), "--"); assert.match(helperArgs.at(-2), /^\/.*\/git$/);
  assert.deepEqual(keyGuard({ cli: "claude", kind: "build", common: "/c", env: { ASE_KEY_GUARD: "off" } }).helper("git", ["status"]), ["git", ["status"]]);
  // Codex locks its own commands, so no bubblewrap stands before it; it starts by its full path all the same, where PATH holds one.
  const codex = keyGuard({ cli: "codex", kind: "build", common: "/c", env: { HOME: "/h", PATH: process.env.PATH } });
  const codexFile = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "codex")).find(file => existsSync(file));
  assert.deepEqual(codex.wrap("codex", ["exec"]), [codexFile ?? "codex", ["exec"]]);
  assert.equal(codex.helper("git", ["status"])[0], bwrapFile);
});

test("every test file that starts an agent run or kit doctor loads the test environment, so none of them searches the real HOME", () => {
  const starts = /agent-run\.mjs|agent\.sh|review\.sh|sol\.sh|"doctor"|kit\.d\/doctor/;
  const missing = readdirSync("tests").filter(name => name.endsWith(".test.ts")).filter(name => {
    const text = readFileSync(join("tests", name), "utf8");
    return starts.test(text) && !/from "\.\/support\/kit-env\.ts"|import "\.\/support\/kit-env\.ts"/.test(text);
  });
  assert.deepEqual(missing, []);
});

test("a link inside a key folder locks what it points at, through both paths; a folder that holds HOME or a system folder is refused", { skip: noBwrap }, t => {
  const { dir, home } = keyHome(t);
  const dotfiles = join(dir, "dotfiles"); mkdirSync(join(dotfiles, "wrangler"), { recursive: true });
  writeFileSync(join(dotfiles, "hosts.yml"), `${dummy}\n`);
  writeFileSync(join(dotfiles, "wrangler/default.toml"), `${dummy}\n`);
  symlinkSync(join(dotfiles, "hosts.yml"), join(home, ".config/gh/linked.yml"));
  symlinkSync(join(dotfiles, "wrangler"), join(home, ".config/.wrangler/linked"));
  symlinkSync(join(dir, "gone"), join(home, ".config/gh/dangling"));
  const { paths, unsafe } = linkTargets([join(home, ".config/gh"), join(home, ".config/.wrangler"), "/run/elsewhere"], { skip: ["/run"], keep: [home] });
  assert.deepEqual(paths, [join(home, ".config/gh"), join(home, ".config/.wrangler"), "/run/elsewhere", join(dotfiles, "hosts.yml"), join(dotfiles, "wrangler")]);
  assert.deepEqual(unsafe, []);
  const read = spawnSync("bwrap", [...bwrapArgs(paths), "--", "sh", "-c", `cat ${join(dotfiles, "hosts.yml")} ${join(dotfiles, "wrangler/default.toml")} ${join(home, ".config/.wrangler/linked/default.toml")} 2>&1`], { encoding: "utf8" });
  assert.ok(!read.stdout.includes(dummy), read.stdout);
  // A linked folder is searched too: a link inside it leads further (with a loop back, which ends the search).
  const vault = join(dir, "vault"); mkdirSync(vault); writeFileSync(join(vault, "token"), `${dummy}\n`);
  symlinkSync(join(vault, "token"), join(dotfiles, "wrangler/token"));
  symlinkSync(join(home, ".config/.wrangler"), join(dotfiles, "wrangler/back"));
  const deeper = linkTargets([join(home, ".config/.wrangler")], { keep: [home] });
  assert.ok(deeper.paths.includes(join(vault, "token")), deeper.paths.join(" "));
  const vaultRead = spawnSync("bwrap", [...bwrapArgs(deeper.paths), "--", "cat", join(vault, "token")], { encoding: "utf8" });
  assert.ok(!vaultRead.stdout.includes(dummy));
  // A big folder with no links is searched whole and is fine; past the limit in all the search stops and says where.
  const wide = join(dir, "wide"); mkdirSync(wide);
  for (let i = 0; i < 2500; i++) mkdirSync(join(wide, `d${i}`));
  assert.deepEqual(linkTargets([wide], { keep: [home] }), { paths: [wide], unsafe: [], unlisted: [], tooLarge: null });
  assert.equal(linkTargets([wide], { keep: [home], limit: 1000 }).tooLarge, wide);
  // A link to the worktree, or into a system folder, cannot be hidden either.
  const worktree = join(dir, "worktree"); mkdirSync(worktree);
  symlinkSync(worktree, join(home, ".config/fleet/w"));
  symlinkSync("/etc/ssl", join(home, ".config/fleet/ssl"));
  assert.deepEqual(linkTargets([join(home, ".config/fleet")], { keep: [home, worktree] }).unsafe.sort(),
    [`${join(home, ".config/fleet/ssl")} -> ${realpathSync("/etc/ssl")}`, `${join(home, ".config/fleet/w")} -> ${worktree}`].sort());
  rmSync(join(home, ".config/fleet/w")); rmSync(join(home, ".config/fleet/ssl"));
  // A key folder that cannot be listed could hide a link: refused.
  const shut = join(home, ".config/fleet/shut"); mkdirSync(shut); chmodSync(shut, 0o111);
  t.after(() => { if (existsSync(shut)) chmodSync(shut, 0o755); });
  assert.deepEqual(linkTargets([join(home, ".config/fleet")], { keep: [home] }).unlisted, [{ folder: shut, code: "EACCES" }]);
  assert.throws(() => keyGuard({ cli: "claude", kind: "review", common: "/c", env: { HOME: home, PATH: process.env.PATH } }),
    new RegExp(`cannot lock the key files for this review: ${shut} cannot be read to look for links \\(EACCES\\); allow reading it: chmod u\\+rx '${shut}'; or set ASE_KEY_GUARD=off`));
  chmodSync(shut, 0o755); rmSync(shut, { recursive: true });
  // A link to a device (known_hosts -> /dev/null) is neither locked nor refused.
  symlinkSync("/dev/null", join(home, ".config/fleet/known_hosts"));
  assert.deepEqual(linkTargets([join(home, ".config/fleet")], { keep: [home] }), { paths: [join(home, ".config/fleet")], unsafe: [], unlisted: [], tooLarge: null });
  // A link to /usr or to a folder holding HOME cannot be hidden without breaking the run: refused, in words.
  symlinkSync("/usr", join(home, ".config/gh/usr"));
  symlinkSync(dir, join(home, ".config/gh/up"));
  assert.deepEqual(linkTargets([join(home, ".config/gh")], { keep: [home] }).unsafe.sort(), [`${join(home, ".config/gh/up")} -> ${dir}`, `${join(home, ".config/gh/usr")} -> /usr`].sort());
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: join(dir, "repo/.git"), env: { HOME: home, PATH: process.env.PATH } }),
    /cannot lock the key files for this build: a key folder links to a folder the lock cannot hide \(.*\); move the keys into a folder of their own/);
});

test("a link from a key folder into a folder the search skips is neither searched nor refused", t => {
  const { dir, home } = keyHome(t);
  // The runtime folder is masked whole already; a link to it, or to a folder inside it, adds nothing to hide.
  const runtime = join(dir, "runtime"); mkdirSync(join(runtime, "gnupg"), { recursive: true });
  symlinkSync(join(runtime, "gnupg"), join(home, ".config/fleet/agent")); symlinkSync(runtime, join(home, ".config/fleet/run"));
  assert.deepEqual(linkTargets([join(home, ".config/fleet")], { keep: [home], skip: [runtime] }), { paths: [join(home, ".config/fleet")], unsafe: [], unlisted: [], tooLarge: null });
  // Without the skip the same links are followed.
  assert.ok(linkTargets([join(home, ".config/fleet")], { keep: [home] }).paths.includes(runtime));
});

test("kit doctor's note says whether the lock is on, off or cannot start", t => {
  assert.equal(keyGuardReport({ ASE_KEY_GUARD: "off" }).state, "off");
  const empty = mkdtempSync(join(tmpdir(), "kit-no-bwrap-"));
  t.after(() => { rmSync(empty, { recursive: true, force: true }); resetBwrapProbe(); });
  // No bubblewrap: on Linux the runs stop (it installs with one command); on macOS and Windows they start unwrapped,
  // which the note says, and ASE_KEY_GUARD=on turns that into a stop.
  const fresh = <T>(body: () => T) => { resetBwrapProbe(); try { return body(); } finally { resetBwrapProbe(); } };
  assert.deepEqual(fresh(() => asPlatform("linux", () => keyGuardReport({ PATH: empty }))), { state: "problem", text: "bubblewrap (bwrap) is not installed; install it (apt install bubblewrap)" });
  const unwrapped = { state: "missing", text: "off on this machine (no bubblewrap); builders can read key files (token variables are still dropped, and Codex keeps its own profile)" };
  for (const platform of ["darwin", "win32"] as const) assert.deepEqual(fresh(() => asPlatform(platform, () => keyGuardReport({ PATH: empty }))), unwrapped);
  assert.deepEqual(fresh(() => asPlatform("darwin", () => keyGuardReport({ PATH: empty, ASE_KEY_GUARD: "on" }))),
    { state: "problem", text: "this system has no bubblewrap (it is Linux only), and ASE_KEY_GUARD=on asks for the lock or no run; unset it to start Claude, Grok and OpenCode unwrapped" });
  // A Codex run there still searches the key folders for its profile: what would stop it shows in the note first.
  {
    const { dir, home } = keyHome(t);
    const worktree = join(dir, "work"); mkdirSync(worktree); symlinkSync(worktree, join(home, ".config/gh/w"));
    const mac = { HOME: home, PATH: empty };
    const refusal = `a key folder links to a folder the lock cannot hide (${join(home, ".config/gh/w")} -> ${worktree}); move the keys into a folder of their own`;
    assert.deepEqual(fresh(() => asPlatform("darwin", () => keyGuardReport(mac, { worktree }))), { state: "refused", text: refusal });
    fresh(() => asPlatform("darwin", () => assert.throws(() => keyGuard({ cli: "codex", kind: "build", common: "/c", worktree, env: mac }), new RegExp(`cannot lock the key files for this build: a key folder links to a folder the lock cannot hide`))));
    rmSync(join(home, ".config/gh/w"));
    assert.deepEqual(fresh(() => asPlatform("darwin", () => keyGuardReport(mac, { worktree }))), unwrapped);
  }
  // A bwrap that runs the command without any sandbox (as a setuid bwrap lets /proc through): the lock refuses.
  writeFileSync(join(empty, "bwrap"), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n');
  chmodSync(join(empty, "bwrap"), 0o755);
  assert.match(fresh(() => keyGuardReport({ PATH: `${empty}:${process.env.PATH}` })).text, /^a program inside bubblewrap can still read other programs' files through \/proc here/);
  // On a desktop whose display lets the user in by name the lock is on with a warning.
  if (bwrapUsable) assert.match(keyGuardReport({ PATH: process.env.PATH }).state, /^(on|warning)$/);
  // From here a bwrap whose start-up check found /proc and the display shut: the note depends on the key folders alone.
  writeFileSync(join(empty, "bwrap"), '#!/bin/sh\ncase "$*" in *" -e "*) echo inside; echo done ;; esac\nexit 0\n');
  resetBwrapProbe();
  const { dir, home } = keyHome(t);
  const env = { HOME: home, PATH: `${empty}:${process.env.PATH}` };
  const worktree = join(dir, "work"), common = join(dir, "repo.git"); mkdirSync(worktree); mkdirSync(common);
  const on = "on (bubblewrap runs; agents the kit starts cannot read the key files)";
  assert.deepEqual(keyGuardReport(env, { worktree, common }), { state: "on", text: on });
  // A KIT_KEY_PATHS entry that is not locked is a gap the note names; a build on the API route is named as refused.
  assert.deepEqual(keyGuardReport({ ...env, KIT_KEY_PATHS: "keys" }, { worktree, common }), { state: "warning", text: "on, but KIT_KEY_PATHS entry 'keys' is not a full path, so it is not locked; write it from / on" });
  assert.deepEqual(keyGuardReport({ ...env, KIT_API_KEY_FILE: join(dir, "api-key") }, { worktree, common }),
    { state: "on", text: "on (bubblewrap runs; agents the kit starts cannot read the key files; a Claude build on the API route is refused under the lock)" });
  // What would stop a run stops the note from saying "on": a key folder that cannot be listed, a link to the worktree
  // or to the repository's Git folder, which the lock cannot hide.
  const shut = join(home, ".config/fleet/shut"); mkdirSync(shut); chmodSync(shut, 0o111);
  t.after(() => { if (existsSync(shut)) chmodSync(shut, 0o755); });
  assert.deepEqual(keyGuardReport(env, { worktree, common }), { state: "refused", text: `${shut} cannot be read to look for links (EACCES); allow reading it: chmod u+rx '${shut}'` });
  chmodSync(shut, 0o755); rmSync(shut, { recursive: true });
  for (const kept of [worktree, common]) {
    symlinkSync(kept, join(home, ".config/gh/w"));
    assert.deepEqual(keyGuardReport(env, { worktree, common }), { state: "refused", text: `a key folder links to a folder the lock cannot hide (${join(home, ".config/gh/w")} -> ${kept}); move the keys into a folder of their own` });
    rmSync(join(home, ".config/gh/w"));
  }
  assert.deepEqual(keyGuardReport(env, { worktree, common }), { state: "on", text: on });
});

test("the test environment has a temporary HOME and no lock settings from the shell that started the tests", () => {
  const real = userInfo().homedir;
  for (const env of [process.env, kitEnv()]) {
    assert.equal(env.HOME, testHomeFolder);
    assert.ok(testHomeFolder.startsWith(tmpdir()) && testHomeFolder !== real);
    for (const name of ["XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME"]) assert.ok(env[name]!.startsWith(`${testHomeFolder}/`), name);
    for (const name of ["ASE_KEY_GUARD", "KIT_KEY_PATHS", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL"]) assert.equal(env[name], undefined, name);
  }
  // A developer's shell that sets them later changes no fixture either.
  process.env.ASE_KEY_GUARD = "off"; process.env.KIT_KEY_PATHS = "/somewhere";
  try { assert.deepEqual([kitEnv().ASE_KEY_GUARD, kitEnv().KIT_KEY_PATHS], [undefined, undefined]); }
  finally { delete process.env.ASE_KEY_GUARD; delete process.env.KIT_KEY_PATHS; }
});

test("PROOF: a Grok review cannot read the dummy key files either", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md");
  for (const path of [bin, root, out]) mkdirSync(path);
  writeFileSync(join(bin, "grok"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const tryRead = file => { try { return readFileSync(file, "utf8"); } catch (error) { return "refused " + error.code; } };
writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ token: process.env.GH_TOKEN ?? "", ...Object.fromEntries(Object.entries(JSON.parse(process.env.FAKE_TRIES)).map(([name, file]) => [name, tryRead(file)])) }));
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ sessionId: "g-1", text: "REVIEW_STATUS: complete\\nDefects\\nNone.", modelUsage: { [args[args.indexOf("-m") + 1]]: {} } }));
`);
  chmodSync(join(bin, "grok"), 0o755);
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(brief, "Review this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("commit", "-q", "--allow-empty", "-m", "base");
  writeFileSync(join(root, "file.txt"), "change\n"); git("add", "file.txt"); git("commit", "-q", "-m", "change");
  const seenFile = join(dir, "seen.json");
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", FAKE_SEEN: seenFile, FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "review", root, brief, "--out", out, "--cli", "grok", "--model", "grok-4.7", "--base", "HEAD~1"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr + readFileSync(join(out, "run.log"), "utf8"));
  const seen = JSON.parse(readFileSync(seenFile, "utf8"));
  for (const name of ["orbit", "gh", "wrangler", "claudeJson", "codexAuth", "claudeLogin"]) assert.match(seen[name], /^refused (ENOENT|EACCES)$/, name);
  // The lock is read-only for a Grok review: writing outside its state and temp folders is refused.
  const ro = spawnSync("bwrap", [...bwrapArgs([], { writable: [tmpdir()] }), "--", "sh", "-c", `touch ${JSON.stringify(join(process.cwd(), ".key-guard-ro-probe"))} 2>&1; touch ${JSON.stringify(join(dir, "y"))} && echo tmp-ok`], { encoding: "utf8" });
  rmSync(join(process.cwd(), ".key-guard-ro-probe"), { force: true });
  assert.match(ro.stdout, /Read-only file system/); assert.match(ro.stdout, /tmp-ok/);
  assert.equal(seen.token, "", "the token variable is gone");
});

// A program left where a build can write, which notes what it could read (a dummy key file, the token variable) and
// then acts as the real one.
function plantedProgram(file: string, noted: string, keyFile: string, then: string) {
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n{ echo ${JSON.stringify(file)}; cat ${JSON.stringify(keyFile)} 2>&1; printf 'token=%s.\\n' "$GH_TOKEN"; } >> ${JSON.stringify(noted)}\n${then}\n`);
  chmodSync(file, 0o755);
}

// A Codex that writes its report and says which model and session it ran.
function fakeCodex(bin: string) {
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
console.error("model: " + args[args.indexOf("-m") + 1]); console.error("session id: s-1");
writeFileSync(args[args.indexOf("-o") + 1], "built by the real codex\\n");
`);
  chmodSync(join(bin, "codex"), 0o755);
}

test("a PATH folder inside the worktree or its Git folder supplies neither bubblewrap nor a CLI, written as a full path or not, and the run's PATH leaves it out", { skip: noBwrap }, t => {
  const { dir } = keyHome(t);
  t.after(resetBwrapProbe);
  const bwrapFile = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "bwrap")).find(file => existsSync(file));
  const worktree = join(dir, "work"), common = join(dir, "repo.git"), outside = join(dir, "bin"), linked = join(dir, "linked");
  // npm puts <worktree>/node_modules/.bin on PATH as a full path; a build can write there, and in the Git folder.
  const inWorktree = join(worktree, "node_modules/.bin"), inGit = join(common, "bin");
  for (const folder of [inWorktree, inGit, join(worktree, "bin"), worktree, outside]) {
    mkdirSync(folder, { recursive: true });
    for (const name of ["bwrap", "claude", "codex", "git"]) { writeFileSync(join(folder, name), "#!/bin/sh\necho planted\n"); chmodSync(join(folder, name), 0o755); }
  }
  rmSync(join(outside, "bwrap"));
  // A link into the worktree is the worktree too.
  symlinkSync(inWorktree, linked);
  const system = "/usr/bin:/bin";
  const path = [inWorktree, inGit, linked, "bin", "", ".", outside, system].join(":");
  const lock = (cli: string, kind: string, env: NodeJS.ProcessEnv = { HOME: "/h", PATH: path }) => { resetBwrapProbe(); return keyGuard({ cli, kind, common, worktree, env }); };
  const guard = lock("claude", "review");
  const [command, args] = guard.wrap("claude", ["-p"]);
  assert.equal(command, bwrapFile, "bubblewrap is the system's own");
  assert.deepEqual(args.slice(-3), ["--", join(outside, "claude"), "-p"]);
  assert.deepEqual(guard.helper("git", ["status"])[1].slice(-3), ["--", join(outside, "git"), "status"]);
  // The run itself, and whatever it starts by a bare name (Codex, which locks its own commands), gets a PATH without them.
  assert.equal(guard.env.PATH, `${outside}:${system}`);
  assert.equal(lock("codex", "build").env.PATH, `${outside}:${system}`);
  // A CLI found only in such a folder counts as missing: it starts by its bare name with that PATH, so nothing is found.
  rmSync(join(outside, "claude"));
  const missing = lock("claude", "review");
  assert.deepEqual(missing.wrap("claude", ["-p"]), ["claude", ["-p"]]);
  assert.ok(!String(missing.env.PATH).split(":").some(folder => existsSync(join(folder, "claude"))), "no folder left on PATH holds the planted claude");
  // A PATH with nothing left would mean the current folder: the system's own folders stand in, as for no PATH at all.
  assert.equal(lock("codex", "build", { HOME: "/h", PATH: `${inWorktree}::bin` }).env.PATH, "/bin:/usr/bin");
  // A PATH with no such folder stays as it is.
  assert.ok(!Object.hasOwn(lock("claude", "review", { HOME: "/h", PATH: system }).env, "PATH"));
});

test("PROOF: a bwrap, a CLI and a git planted in a full-path PATH folder inside the worktree or its Git folder never start, for a Claude and a Codex build", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), brief = join(dir, "brief.md"), noted = join(dir, "planted.txt"), seenFile = join(dir, "seen.json");
  for (const path of [bin, root]) mkdirSync(path);
  fakeClaude(bin); fakeCodex(bin);
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const real = (name: string) => String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, name)).find(file => existsSync(file))!;
  // What an earlier build left: each one notes what it can read, then acts as the real program so the run goes on.
  const folders = [join(root, "node_modules/.bin"), join(root, ".git/planted")];
  for (const folder of folders) {
    plantedProgram(join(folder, "bwrap"), noted, files.orbit, `exec ${real("bwrap")} "$@"`);
    plantedProgram(join(folder, "git"), noted, files.orbit, `exec ${real("git")} "$@"`);
    plantedProgram(join(folder, "claude"), noted, files.orbit, `exec ${join(bin, "claude")} "$@"`);
    plantedProgram(join(folder, "codex"), noted, files.orbit, `exec ${join(bin, "codex")} "$@"`);
  }
  const env = { ...homeEnv(home), PATH: `${folders.join(":")}:${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: seenFile, FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  for (const [cli, model] of [["claude", "claude-opus-5-5"], ["codex", "gpt-6.1-sol"]]) {
    const out = join(dir, `out-${cli}`); mkdirSync(out);
    const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", cli, "--model", model], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.ok(!existsSync(noted), `${cli}: a planted program started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  }
  // The real ones did the work.
  assert.equal(readFileSync(join(root, "built.txt"), "utf8"), "a normal build step\n");
  assert.equal(readFileSync(join(dir, "out-codex/out.md"), "utf8"), "built by the real codex\n");
});

// SL-1: the folder is outside the worktree, so it stays on the run's PATH; only the program it names is inside.
test("a CLI or a git that a link in a PATH folder outside the worktree leads into it, or into the Git folder, never starts by its bare name: the next one on PATH starts by its full path, and with none the lock refuses", { skip: noBwrap }, t => {
  const { dir } = keyHome(t);
  t.after(resetBwrapProbe);
  const worktree = join(dir, "work"), common = join(dir, "repo.git"), links = join(dir, "links"), gitLink = join(dir, "git-link"), bin = join(dir, "bin"), gitBin = join(dir, "git-bin"), only = join(dir, "only");
  for (const folder of [links, gitLink, bin, gitBin, only]) mkdirSync(folder);
  const program = (file: string, says: string) => { mkdirSync(resolve(file, ".."), { recursive: true }); writeFileSync(file, `#!/bin/sh\necho ${says}\n`); chmodSync(file, 0o755); };
  // What a build can write: the worktree, and the Git folder (Grok's link leads there).
  for (const name of ["claude", "codex", "grok", "opencode", "git"]) {
    const planted = join(name === "grok" ? common : worktree, "tools", name);
    program(planted, "planted"); symlinkSync(planted, join(name === "git" ? gitLink : links, name));
    program(join(name === "git" ? gitBin : bin, name), "real");
  }
  // Bubblewrap and what its start-up check runs, alone, so no CLI or git of this machine is on the PATHs below.
  const machine = (name: string) => String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, name)).find(file => existsSync(file))!;
  for (const name of ["bwrap", "true"]) symlinkSync(machine(name), join(only, name));
  const lock = (cli: string, kind: string, path: string) => { resetBwrapProbe(); return keyGuard({ cli, kind, common, worktree, env: { HOME: "/h", PATH: path } }); };
  // Only the link on PATH: the lock refuses in plain words before anything starts, whichever CLI it is.
  for (const [cli, kind, inside] of [["claude", "build", worktree], ["codex", "build", worktree], ["opencode", "review", worktree], ["grok", "review", common]]) {
    assert.throws(() => lock(cli, kind, `${links}:${only}`), { message: `cannot lock the key files for this ${kind}: ${cli} on PATH is ${join(links, cli)}, a link into the worktree or its Git folder (${join(inside, "tools", cli)}), where a build can change it, so it is not started; put a ${cli} from outside them on PATH, or set ASE_KEY_GUARD=off to run without the lock` }, cli);
  }
  // The runner's own git the same way.
  assert.throws(() => lock("claude", "build", `${gitLink}:${bin}:${only}`), /^Error: cannot lock the key files for this build: git on PATH is .*\/git-link\/git, a link into the worktree or its Git folder \(.*\/work\/tools\/git\)/);
  assert.throws(() => runProgram("git", { PATH: `${gitLink}:${only}` }, { worktree }), /^Error: cannot lock the key files for this run: git on PATH is .*\/git-link\/git, a link into the worktree or its Git folder .*, or set ASE_KEY_GUARD=off to run without the lock$/);
  // A real one further on PATH is the one that starts, by its full path: inside bubblewrap, and for Codex (which
  // locks its own commands) directly. The bare name would have found the link first.
  const path = `${links}:${gitLink}:${bin}:${gitBin}:${only}`;
  const claude = lock("claude", "build", path);
  assert.deepEqual(claude.wrap("claude", ["-p"]).flat().slice(-3), ["--", join(bin, "claude"), "-p"]);
  assert.deepEqual(claude.helper("git", ["status"]).flat().slice(-3), ["--", join(gitBin, "git"), "status"]);
  const codex = lock("codex", "build", path);
  assert.deepEqual(codex.wrap("codex", ["exec"]), [join(bin, "codex"), ["exec"]]);
  assert.deepEqual(codex.helper("git", ["status"]).flat().slice(-3), ["--", join(gitBin, "git"), "status"]);
  assert.equal(runProgram("git", { PATH: path }, { worktree }), join(gitBin, "git"));
  // On the API route the wrapper starts `<guard script> claude …` once it has read its key: the script starts the real
  // claude by its full path too, where the bare name inside the lock would have found the link first.
  const api = (() => { resetBwrapProbe(); return keyGuard({ cli: "claude", kind: "review", common, worktree, apiRoute: true, env: { HOME: "/h", PATH: path } }); })();
  t.after(() => api.close());
  const viaScript = spawnSync(api.claudeGuard, ["claude", "-p"], { encoding: "utf8", env: { PATH: path } });
  assert.equal(viaScript.stdout, "real\n", viaScript.stderr);
  // A program no folder holds stays a bare name, so its start fails as a missing program.
  assert.equal(runProgram("git", { PATH: only }, { worktree }), "git");
  // The link put there after the lock was set up (a later helper call): refused at that call.
  const late = lock("claude", "build", `${links}:${bin}:${gitBin}:${only}`);
  rmSync(join(gitBin, "git")); symlinkSync(join(worktree, "tools/git"), join(links, "git"));
  assert.throws(() => late.helper("git", ["status"]), /cannot lock the key files for this build: git on PATH is /);
});

test("PROOF: a claude, a codex and a git that a link in a PATH folder outside the worktree leads into it never start, for a Claude and a Codex build: the run takes the next one on PATH, or stops and says so", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), links = join(dir, "links"), gitLink = join(dir, "git-link"), root = join(dir, "work"), brief = join(dir, "brief.md"), noted = join(dir, "planted.txt"), seenFile = join(dir, "seen.json");
  for (const path of [bin, links, gitLink, root]) mkdirSync(path);
  fakeClaude(bin); fakeCodex(bin);
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  // What an earlier build left in the worktree, each noting what it can read before it acts as the real program, and
  // the links a person made to them from folders of their own on PATH (an npm link, a dotfiles bin).
  plantedProgram(join(root, "tools/claude"), noted, files.orbit, `exec ${join(bin, "claude")} "$@"`);
  plantedProgram(join(root, "tools/codex"), noted, files.orbit, `exec ${join(bin, "codex")} "$@"`);
  plantedProgram(join(root, "tools/git"), noted, files.orbit, `exec ${realGit} "$@"`);
  for (const name of ["claude", "codex"]) symlinkSync(join(root, "tools", name), join(links, name));
  symlinkSync(join(root, "tools/git"), join(gitLink, "git"));
  // This machine's programs without its own claude and codex, so the link is the only one where the test says so.
  const rest = pathWithout(dir, ["claude", "codex"], "rest-bin");
  const env = { ...homeEnv(home), GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain", FAKE_SEEN: seenFile, FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  let runs = 0;
  const build = (cli: string, model: string, path: string) => {
    const out = join(dir, `out-${runs++}`); mkdirSync(out);
    const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", cli, "--model", model], { cwd: root, env: { ...env, PATH: path }, encoding: "utf8", timeout: 60_000 });
    assert.ok(!existsSync(noted), `${cli} with PATH=${path}: a planted program started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
    return { run, out };
  };
  for (const [cli, model] of [["claude", "claude-opus-5-5"], ["codex", "gpt-6.1-sol"]]) {
    // Only the link on PATH: the run stops before the CLI starts, and says why.
    const { run: alone } = build(cli, model, `${links}:${rest}`);
    assert.notEqual(alone.status, 0, alone.stdout + alone.stderr);
    assert.match(alone.stderr, new RegExp(`^problem: cannot lock the key files for this build: ${cli} on PATH is \\S+/links/${cli}, a link into the worktree or its Git folder \\(\\S+/work/tools/${cli}\\)`, "m"));
    // A real one further on PATH is the one that starts; so is the real git, though the linked one comes first.
    const { run: next, out } = build(cli, model, `${links}:${gitLink}:${bin}:${rest}`);
    assert.equal(next.status, 0, next.stdout + next.stderr);
    if (cli === "codex") assert.equal(readFileSync(join(out, "out.md"), "utf8"), "built by the real codex\n");
  }
  assert.equal(readFileSync(join(root, "built.txt"), "utf8"), "a normal build step\n");
  // The linked git alone (no other git on PATH): the run stops at its first git call, in the same words, and its log says so.
  const noGit = pathWithout(dir, ["claude", "codex", "git"], "no-git-bin");
  const { run: stopped, out: stoppedOut } = build("claude", "claude-opus-5-5", `${gitLink}:${bin}:${noGit}`);
  assert.notEqual(stopped.status, 0, stopped.stdout + stopped.stderr);
  const refusal = /^problem: cannot lock the key files for this build: git on PATH is \S+\/git-link\/git, a link into the worktree or its Git folder /m;
  assert.match(stopped.stderr, refusal); assert.match(readFileSync(join(stoppedOut, "run.log"), "utf8"), refusal);
  // A review resolves its scope (the base and the head) with git too, before it reads the diff: that git is the real
  // one as well, though the linked one comes first on PATH.
  writeFileSync(join(bin, "grok"), `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ sessionId: "g-1", text: "REVIEW_STATUS: complete\\nDefects\\nNone.", modelUsage: { [args[args.indexOf("-m") + 1]]: {} } }));
`);
  chmodSync(join(bin, "grok"), 0o755);
  writeFileSync(join(root, "file.txt"), "change\n");
  git("add", "file.txt"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "change");
  const reviewOut = join(dir, "out-review"); mkdirSync(reviewOut);
  const review = spawnSync(process.execPath, [resolve("agent-run.mjs"), "review", root, brief, "--out", reviewOut, "--cli", "grok", "--model", "grok-4.7", "--base", "HEAD~1"],
    { cwd: root, env: { ...env, PATH: `${gitLink}:${bin}:${pathWithout(dir, ["claude", "codex", "grok"], "review-bin")}` }, encoding: "utf8", timeout: 60_000 });
  assert.ok(!existsSync(noted), `a review: the planted git started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  assert.equal(review.status, 0, review.stdout + review.stderr);
  assert.match(readFileSync(join(reviewOut, "diff.patch"), "utf8"), /^\+change$/m);
});

test("PROOF: a review's own git diff and git log run no program a build's Git settings name (an outside diff tool, a text converter, a signature checker) with the keys", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md");
  for (const path of [bin, root, out]) mkdirSync(path);
  writeFileSync(join(bin, "grok"), `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ sessionId: "g-1", text: "REVIEW_STATUS: complete\\nDefects\\nNone.", modelUsage: { [args[args.indexOf("-m") + 1]]: {} } }));
`);
  chmodSync(join(bin, "grok"), 0o755); writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(brief, "Review this.\n");
  const git = (args: string[], input?: string) => {
    const result = spawnSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@t", ...args], { encoding: "utf8", input });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q", "-b", "test"]); git(["commit", "-q", "--allow-empty", "-m", "base"]);
  writeFileSync(join(root, "file.txt"), "change\n"); writeFileSync(join(root, ".gitattributes"), "*.txt diff=leak\n");
  git(["add", "."]); git(["commit", "-q", "-m", "change"]);
  // A commit that carries a signature, so git log would start the signature checker the settings name.
  const signed = git(["hash-object", "-t", "commit", "-w", "--stdin"],
    `tree ${git(["rev-parse", "HEAD^{tree}"])}\nparent ${git(["rev-parse", "HEAD"])}\nauthor T <t@t> 1 +0000\ncommitter T <t@t> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n made-up\n -----END PGP SIGNATURE-----\n\nsigned\n`);
  git(["update-ref", "HEAD", signed]);
  // What an earlier build left in the repository's Git settings: every program git diff and git log can be told to start.
  const { hook, hooked } = plantedScript(dir, files.orbit);
  for (const [name, value] of [["diff.external", hook], ["diff.leak.textconv", hook], ["diff.leak.command", hook], ["log.showSignature", "true"], ["gpg.program", hook]]) git(["config", name, value]);
  // Without the kit's care each of them starts: the proof that the settings above are live.
  spawnSync("git", ["-C", root, "diff", "HEAD~2...HEAD"], { encoding: "utf8", env: { ...homeEnv(home), GH_TOKEN: dummy } });
  assert.ok(readFileSync(hooked, "utf8").includes(dummy), "the planted settings are live");
  rmSync(hooked);
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s" } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "review", root, brief, "--out", out, "--cli", "grok", "--model", "grok-4.7", "--base", "HEAD~2"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  const left = existsSync(hooked) ? readFileSync(hooked, "utf8") : "";
  assert.ok(!left.includes(dummy), `the runner ran the build's program with the keys: ${left}`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // The reviewer still gets the plain diff and the commit list.
  assert.match(readFileSync(join(out, "diff.patch"), "utf8"), /^\+change$/m);
  assert.match(readFileSync(join(out, "commits.log"), "utf8"), /^[0-9a-f]+ signed\n[0-9a-f]+ change\n$/);
});

test("a start-up file that sets a token in quotes, with += or as a default is locked; a file pulled in by a relative path is read from the shell's folder", t => {
  const { dir, home } = keyHome(t);
  const worktree = join(dir, "work"); mkdirSync(worktree);
  mkdirSync(join(home, "forms")); mkdirSync(join(home, "plain")); mkdirSync(join(home, "sub"));
  const sets = [`export "GH_TOKEN=${dummy}"`, `export 'GH_TOKEN=${dummy}'`, `export GH_TOKEN+=${dummy}`, `GH_TOKEN+="${dummy}"`, `export "GH_TOKEN"=${dummy}`,
    `declare -x "ORBIT_TOKEN+=${dummy}"`, `: "\${GH_TOKEN:=${dummy}}"`, `echo "\${GH_TOKEN=${dummy}}"`, `eval "CF_API_TOKEN=${dummy}"`, `alias lab='glab --token=${dummy}'`];
  const reads = ['[ "$GH_TOKEN" = x ] && echo set', 'echo "$GH_TOKEN=shown"', 'echo "${GH_TOKEN:-none}"', "export PATH+=:/opt/bin", 'export "EDITOR=vi"', 'export SSH_AUTH_SOCK+="/run/agent"',
    "export GH_TOKEN_FILE+=x"];
  sets.forEach((line, index) => writeFileSync(join(home, `forms/${index}.sh`), `${line}\n`));
  reads.forEach((line, index) => writeFileSync(join(home, `plain/${index}.sh`), `${line}\n`));
  writeFileSync(join(home, ".bashrc"), [...sets.map((_, index) => `source ~/forms/${index}.sh`), ...reads.map((_, index) => `source ~/plain/${index}.sh`), "source ~/sub/rc.sh", ""].join("\n"));
  // fish: a quoted name, and a set that follows another command on its line.
  mkdirSync(join(home, ".config/fish/conf.d"), { recursive: true });
  writeFileSync(join(home, ".config/fish/config.fish"), `set -gx "GH_TOKEN" ${dummy}\n`);
  writeFileSync(join(home, ".config/fish/conf.d/after.fish"), `status is-login; and set -gx ORBIT_TOKEN ${dummy}\n`);
  // A shell reads a relative path from the folder it runs in, not from the folder of the file that names it: HOME for
  // a login shell, the worktree for a shell the agent starts there.
  writeFileSync(join(home, "sub/rc.sh"), "source ./shell.env\n. named.env\n");
  for (const folder of [home, worktree]) for (const name of ["shell.env", "named.env"]) writeFileSync(join(folder, name), `GH_TOKEN=${dummy}\n`);
  const paths = lockedPaths("claude", { HOME: home }, { cwd: worktree });
  sets.forEach((line, index) => assert.ok(paths.includes(join(home, `forms/${index}.sh`)), line));
  reads.forEach((line, index) => assert.ok(!paths.includes(join(home, `plain/${index}.sh`)), line));
  for (const file of [".config/fish/config.fish", ".config/fish/conf.d/after.fish", "shell.env", "named.env"]) assert.ok(paths.includes(join(home, file)), file);
  for (const name of ["shell.env", "named.env"]) assert.ok(paths.includes(join(worktree, name)), `the worktree's ${name}`);
});

// TOOLS-303: what a locked build writes must not run later with the keys, in the runner's steps after it.

test("SL-1, SL-2 and BASH_ENV: a git include with a space in its path, a relative CODEX_HOME and the file BASH_ENV or ENV names are locked; the variables are dropped", t => {
  const { dir, home } = keyHome(t);
  const worktree = join(dir, "work"), spaced = join(dir, "with space");
  for (const folder of [worktree, spaced]) mkdirSync(folder);
  // A token in a remote's URL, in a file the global config pulls in by a path with a space (quoted and bare).
  writeFileSync(join(spaced, "quoted.inc"), `[remote "origin"]\n\turl = https://${dummy}@github.com/a/b\n`);
  writeFileSync(join(spaced, "bare.inc"), `[remote "fork"]\n\turl = https://${dummy}@github.com/a/c\n`);
  writeFileSync(join(home, ".gitconfig"), `[include]\n\tpath = "${join(spaced, "quoted.inc")}"\n[includeIf "gitdir:/"]\n\tpath = ${join(spaced, "bare.inc")} ; a comment\n`);
  const startup = join(home, ".bash_env"), shStartup = join(home, ".shinit");
  for (const file of [startup, shStartup]) writeFileSync(file, `export GH_TOKEN=${dummy}\n`);
  const env = { HOME: home, CODEX_HOME: "rel-codex", BASH_ENV: startup, ENV: shStartup };
  const paths = lockedPaths("claude", env, { cwd: worktree });
  for (const file of [join(spaced, "quoted.inc"), join(spaced, "bare.inc"), startup, shStartup]) assert.ok(paths.includes(file), file);
  // A relative CODEX_HOME counts from the worktree and from the lead's own folder, as every variable's path does.
  for (const base of [worktree, process.cwd()]) assert.ok(paths.includes(join(base, "rel-codex/auth.json")), `${base}/rel-codex`);
  const dropped = scrubbedEnv("claude", { ...env, PATH: "/usr/bin" });
  assert.ok("BASH_ENV" in dropped && "ENV" in dropped, "BASH_ENV and ENV are dropped");
  assert.ok(!("PATH" in dropped));
});

test("PROOF: the runner's first git never starts a git that a link on PATH leads into a linked worktree's shared Git folder", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), links = join(dir, "links"), repo = join(dir, "repo"), root = join(dir, "work"), brief = join(dir, "brief.md"), noted = join(dir, "planted.txt"), out = join(dir, "out");
  for (const path of [bin, links, repo, out]) mkdirSync(path);
  fakeClaude(bin);
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git("worktree", "add", "-q", "-b", "build", root);
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  // What an earlier build in this worktree left in the shared Git folder (repo/.git), and a link a person made to it.
  plantedProgram(join(repo, ".git/tools/git"), noted, files.orbit, `exec ${realGit} "$@"`);
  symlinkSync(join(repo, ".git/tools/git"), join(links, "git"));
  const env = { ...homeEnv(home), PATH: `${links}:${bin}:${pathWithout(dir, ["claude", "codex", "git"], "no-git-bin")}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1",
    ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain", FAKE_SEEN: join(dir, "seen.json"), FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.ok(!existsSync(noted), `the planted git started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /^problem: cannot lock the key files for this build: git on PATH is \S+\/links\/git, a link into the worktree or its Git folder /m);
});

test("PROOF: after a Codex build without bubblewrap the runner's own git status starts no filter, monitor or hook the build left", t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md");
  for (const path of [bin, root, out]) mkdirSync(path);
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
console.error("model: " + args[args.indexOf("-m") + 1]); console.error("session id: s-1");
${plant}
writeFileSync(args[args.indexOf("-o") + 1], "built\\n");
`);
  chmodSync(join(bin, "codex"), 0o755); writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const { hook, hooked } = plantedScript(dir, files.orbit);
  // A hook git status would start through the monitor's index refresh is one more way in: post-index-change.
  writeFileSync(join(root, ".git/hooks/post-index-change"), `#!/bin/sh\nexec ${JSON.stringify(hook)} < /dev/null\n`); chmodSync(join(root, ".git/hooks/post-index-change"), 0o755);
  const env = { ...homeEnv(home), PATH: `${bin}:${pathWithoutBwrap(dir)}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain", FAKE_HOOK: hook, ...onLinux } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "codex", "--model", "gpt-6.1-sol"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const left = existsSync(hooked) ? readFileSync(hooked, "utf8") : "";
  assert.ok(!left.includes(dummy), `the runner ran the build's script with the keys: ${left}`);
  assert.equal(left, "", "nothing the build left ran at all");
});

test("PROOF: a Codex CLI's #!/usr/bin/env node and the API route wrapper's #!/usr/bin/env bash never start an interpreter a link on PATH leads into the worktree for", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), links = join(dir, "links"), root = join(dir, "work"), brief = join(dir, "brief.md"), noted = join(dir, "planted.txt"), out = join(dir, "out");
  for (const path of [bin, links, root, out]) mkdirSync(path);
  fakeCodex(bin); writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const real = (name: string) => String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, name)).find(file => existsSync(file))!;
  // What an earlier build left in the worktree, and the links a person made to them from a folder of their own on PATH.
  for (const name of ["node", "bash", "stat", "mkdir", "chmod"]) {
    plantedProgram(join(root, "tools", name), noted, files.orbit, `exec ${real(name)} "$@"`);
    symlinkSync(join(root, "tools", name), join(links, name));
  }
  const env = { ...homeEnv(home), PATH: `${links}:${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain" } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "codex", "--model", "gpt-6.1-sol"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.ok(!existsSync(noted), `codex: a planted interpreter started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(readFileSync(join(out, "out.md"), "utf8"), "built by the real codex\n");
  // The API route's wrapper reads the key outside the lock: it starts by a real bash and its own tools are the system's.
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY === "sk-ant-test-not-a-real-key" }));
`);
  chmodSync(join(bin, "claude"), 0o755);
  const keyFile = join(dir, "api-key"); writeFileSync(keyFile, "sk-ant-test-not-a-real-key\n", { mode: 0o600 });
  const routed = { ...env, KIT_API_KEY_FILE: keyFile, KIT_API_CONFIG_DIR: join(dir, "api-config") } as NodeJS.ProcessEnv;
  const guard = keyGuard({ cli: "claude", kind: "review", common: join(root, ".git"), worktree: root, env: routed, apiRoute: true });
  t.after(() => guard.close());
  const seenFile = join(dir, "seen.json");
  const [command, args] = guard.wrap(resolve("claude-api-run.sh"), ["-p", "--tools", "Read,Grep,Glob"]);
  const wrapped = spawnSync(command, args, { cwd: root, encoding: "utf8",
    env: { ...routed, ...Object.fromEntries(Object.entries(guard.env).filter(([, value]) => value !== undefined)), FAKE_SEEN: seenFile } });
  assert.ok(!existsSync(noted), `the API wrapper: a planted program started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  assert.equal(wrapped.status, 0, wrapped.stderr);
  assert.deepEqual(JSON.parse(readFileSync(seenFile, "utf8")), { key: true });
});

test("PROOF: a token in the file BASH_ENV names reaches no shell of a Claude build, and the file is locked", { skip: noBwrap }, t => {
  const { dir, home } = keyHome(t);
  const bin = join(dir, "bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md"), seenFile = join(dir, "seen.json");
  for (const path of [bin, root, out]) mkdirSync(path);
  const startup = join(home, ".bash_env");
  writeFileSync(startup, `export GH_TOKEN=${dummy}\n`);
  // A builder that asks a bash for the token (bash reads BASH_ENV first) and reads the file itself.
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
let file; try { file = readFileSync(process.env.FAKE_STARTUP, "utf8"); } catch (error) { file = "refused: " + error.code; }
writeFileSync(process.env.FAKE_SEEN, JSON.stringify({ shell: execFileSync("bash", ["-c", 'printf %s "$GH_TOKEN"'], { encoding: "utf8" }), file, variable: process.env.BASH_ENV ?? null }));
process.stdout.write(JSON.stringify({ result: "built", session_id: "s-1", modelUsage: { "claude-opus-5-5": {} } }));
`);
  chmodSync(join(bin, "claude"), 0o755); writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, BASH_ENV: startup, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: seenFile, FAKE_STARTUP: startup } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const seen = JSON.parse(readFileSync(seenFile, "utf8"));
  assert.equal(seen.shell, "", "no shell got the token");
  assert.ok(!seen.file.includes(dummy), "the start-up file was readable");
  assert.equal(seen.variable, null, "BASH_ENV is dropped");
});

test("git safety: every program the repository's own Git settings name is set empty, hooks are off, a call without the network reads no global config but the user's name, and a fetch or push refuses http and credential settings", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-git-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home");
  for (const folder of [root, home]) mkdirSync(folder);
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } }).status, 0);
  git("init", "-q", "-b", "test");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Lead\n\temail = lead@example.com\n[core]\n\tpager = global-pager\n[credential]\n\thelper = store\n");
  for (const [name, value] of [["filter.Leak.clean", "x"], ["filter.Leak.process", "x"], ["diff.leak.textconv", "x"], ["merge.leak.driver", "x"], ["core.sshCommand", "x"],
    ["alias.st", "!x"], ["remote.origin.receivepack", "x"], ["core.alternateRefsCommand", "x"], ["interactive.diffFilter", "x"], ["trace2.eventTarget", "/tmp/x"],
    ["core.hooksPath", "/elsewhere"], ["remote.origin.url", "/tmp/origin.git"]]) git("config", name, value);
  const settings = (env: Record<string, string | undefined>) => {
    const pairs: string[][] = [];
    for (let i = 0; i < Number(env.GIT_CONFIG_COUNT); i++) pairs.push([String(env[`GIT_CONFIG_KEY_${i}`]), String(env[`GIT_CONFIG_VALUE_${i}`])]);
    return pairs;
  };
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "color.ui", GIT_CONFIG_VALUE_0: "never" };
  const local = gitSafety({ worktree: root, env });
  assert.equal(local.problem, null);
  assert.equal(local.env.GIT_CONFIG_GLOBAL, "/dev/null"); assert.equal(local.env.GIT_CONFIG_NOSYSTEM, "1");
  // The lead's own setting from the environment comes first and stays.
  assert.equal(local.env.GIT_CONFIG_KEY_0, undefined);
  const pairs = settings({ ...env, ...local.env });
  assert.deepEqual(pairs[0], ["color.ui", "never"]);
  for (const name of ["filter.Leak.clean", "filter.Leak.process", "diff.leak.textconv", "merge.leak.driver", "core.sshcommand", "alias.st", "remote.origin.receivepack",
    "core.alternaterefscommand", "interactive.difffilter", "trace2.eventtarget"])
    assert.ok(pairs.some(([key, value]) => key.toLowerCase() === name.toLowerCase() && value === ""), `${name} is set empty`);
  assert.ok(pairs.some(([key, value]) => key === "filter.Leak.required" && value === "false"));
  // core.hooksPath=/dev/null comes last, after anything the repository names.
  assert.deepEqual(pairs.filter(([key]) => key.toLowerCase() === "core.hookspath"), [["core.hooksPath", "/dev/null"]]);
  // From the global config only the user's name and e-mail come along; its pager and credential helper do not.
  assert.ok(pairs.some(([key, value]) => key === "user.name" && value === "Lead"));
  assert.ok(!pairs.some(([key]) => /pager|credential/.test(key)));
  assert.ok(pairs.some(([key, value]) => key === "safe.directory" && value === realpathSync(root)));
  // What git really does with them: the settings above read back as empty, with no global pager.
  const read = (name: string) => spawnSync("git", ["-C", root, "config", "--get", name], { encoding: "utf8", env: { ...env, ...local.env } as NodeJS.ProcessEnv }).stdout;
  assert.equal(read("filter.Leak.clean"), "\n"); assert.equal(read("core.hooksPath"), "/dev/null\n"); assert.equal(read("core.pager"), ""); assert.equal(read("user.name"), "Lead\n");
  // A fetch or push keeps the global config (its credential helper), and refuses the repository's own http and credential settings.
  const network = gitSafety({ worktree: root, env, network: true });
  assert.equal(network.problem, null); assert.equal(network.env.GIT_CONFIG_GLOBAL, undefined);
  git("config", "http.proxy", "http://127.0.0.1:1"); git("config", "credential.helper", "x");
  assert.match(gitSafety({ worktree: root, env, network: true }).problem, /^the repository's own Git config holds http\.proxy, credential\.helper, which could send the credentials of a fetch or push elsewhere/);
  assert.equal(gitSafety({ worktree: root, env }).problem, null, "a call without the network uses neither");
  git("config", "--unset", "http.proxy"); git("config", "--unset", "credential.helper");
  // A remote helper the repository's config picks (git-remote-<name>, found on PATH) is refused for a fetch or push too.
  for (const [name, value] of [["remote.origin.vcs", "leak"], ["remote.origin.url", "leak::https://example.com/a"], ["remote.origin.pushurl", "leak::x"], ["url.leak::x.insteadOf", "https://github.com/"]]) {
    const before = spawnSync("git", ["-C", root, "config", "--get", name], { encoding: "utf8" }).stdout.trim();
    git("config", name, value);
    assert.match(String(gitSafety({ worktree: root, env, network: true }).problem), new RegExp(`holds ${name.replace(/[.]/g, "\\.")}, which could send .* or start a remote helper`, "i"), name);
    if (before) git("config", name, before); else git("config", "--unset", name);
  }
  assert.equal(gitSafety({ worktree: root, env, network: true }).problem, null);
  // A URL with a scheme git does not have itself would start git-remote-<scheme> from PATH: the transports allowed are git's own.
  const helperBin = join(dir, "helper-bin"), helperNote = join(dir, "helper.txt");
  mkdirSync(helperBin);
  writeFileSync(join(helperBin, "git-remote-leak"), `#!/bin/sh\necho ran > ${JSON.stringify(helperNote)}\n`); chmodSync(join(helperBin, "git-remote-leak"), 0o755);
  const custom = spawnSync("git", ["-C", root, "ls-remote", "leak://example.com/a"], { encoding: "utf8",
    env: { ...env, ...gitSafety({ worktree: root, env, network: true }).env, PATH: `${helperBin}:${process.env.PATH}` } as NodeJS.ProcessEnv });
  assert.notEqual(custom.status, 0);
  assert.match(custom.stderr, /transport 'leak' not allowed/);
  assert.ok(!existsSync(helperNote), "the remote helper did not start");
  // Not even where the repository's own config allows that transport by name.
  git("config", "protocol.leak.allow", "always");
  const allowed = spawnSync("git", ["-C", root, "ls-remote", "leak://example.com/a"], { encoding: "utf8",
    env: { ...env, ...gitSafety({ worktree: root, env, network: true }).env, PATH: `${helperBin}:${process.env.PATH}` } as NodeJS.ProcessEnv });
  assert.match(allowed.stderr, /transport 'leak' not allowed/);
  assert.ok(!existsSync(helperNote), "the remote helper did not start");
  git("config", "--unset", "protocol.leak.allow");
  // Which calls reach the network, and which remotes are folders here.
  assert.deepEqual(["fetch", "push", "status", "-c", "x=y"].map(sub => gitNetworkCall([sub])), [true, true, false, false, false]);
  assert.equal(gitNetworkCall(["-C", "/x", "-c", "a=b", "push", "origin"]), true);
  for (const [url, folder] of [["/tmp/a.git", true], ["file:///a", true], ["../a", true], ["https://github.com/a/b", false], ["git@github.com:a/b.git", false], ["ssh://h/x", false]] as const)
    assert.equal(folderRemote(url), folder, url);
  // The Git folder of a linked worktree, from its files.
  git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  git("worktree", "add", "-q", "-b", "linked", join(dir, "linked"));
  assert.equal(gitCommonDir(join(dir, "linked")), join(root, ".git"));
  assert.equal(gitCommonDir(root), join(root, ".git"));
  assert.equal(gitCommonDir(dir), null);
});

test("TOOLS-320: a remote on this machine itself is told by its name or by every address it resolves to", async () => {
  const own = Object.values(networkInterfaces()).flat().find(entry => entry && entry.family === "IPv4" && !entry.internal)?.address;
  for (const [url, here] of [["ssh://git@localhost/srv/a.git", true], ["localhost:a.git", true], ["git@127.0.0.1:a.git", true], ["ssh://[::1]:22/a", true],
    ["https://dev.localhost/a.git", true], [`ssh://${hostname()}/a`, true], ["ssh://127.1/a", true], ["ssh://0x7f000001/a", true], ["ssh://[::ffff:127.0.0.1]/a", true],
    ["ssh://0.0.0.0/a", true], ["git@[::1]:a.git", true], ["[127.0.0.1]:a.git", true], ["git@[2001:db8::1]:a.git", false],
    ["git@x@localhost:a.git", true], ["ssh://a@b@localhost/a", true], ["ssh://a@b@127.0.0.1/a", true], ["ssh://%6cocalhost/a", true],
    ["ssh://%31%32%37.0.0.1/a", true], ["ssh://%6cocalhost/a%zz.git", true], ["ssh://%6cocalhost/caf%e9.git", true], ["ssh://%6cocalhost/caf%C3%A9.git", true], ["ssh://%6cocalhost/100%", true], ["ssh://[::1%25lo]/a", true], ["%6cocalhost:a.git", false], ["ssh://[0:0:0:0:0:0:0:1]/a", true], ["ssh://[0::1]/a", true], ["ssh://[::ffff:7f00:1]/a", true], ...(own ? [[`ssh://${own}/a`, true]] : []), ["git@github.invalid:a/b.git", false], ["https://192.0.2.1/a", false], ["ssh://h.invalid/x", false]] as const)
    assert.equal(await loopbackRemote(url), here, url);
});

test("a script's interpreter is found by its full path: env with -S passes its options, another env option, a full path into the worktree and a chain past four levels are refused", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-interpreter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, "work"), bin = join(dir, "bin");
  for (const folder of [worktree, bin]) mkdirSync(folder);
  const node = join(bin, "node");
  symlinkSync(process.execPath, node);
  const script = (name: string, line: string) => { const file = join(dir, name); writeFileSync(file, `${line}\nrest\n`); chmodSync(file, 0o755); return file; };
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const start = (file: string) => startCommand(file, ["a"], env, { worktree, kind: "test" });
  const plain = script("plain", "#!/usr/bin/env node");
  assert.deepEqual(start(plain), [node, [plain, "a"]]);
  const split = script("split", "#!/usr/bin/env -S node --no-warnings");
  assert.deepEqual(start(split), [node, ["--no-warnings", split, "a"]]);
  assert.throws(() => start(script("ignore", "#!/usr/bin/env -i node")), /^Error: cannot lock the key files for this test: \S+\/ignore starts with env -i node, so which program it runs cannot be told$/);
  const planted = join(worktree, "node"); writeFileSync(planted, "#!/bin/sh\n"); chmodSync(planted, 0o755);
  assert.throws(() => start(script("inside", `#!${planted}`)), /starts with \S+\/work\/node, inside the worktree or its Git folder/);
  assert.throws(() => start(script("env-inside", `#!/usr/bin/env ${planted}`)), /starts with env \S+\/work\/node, inside the worktree or its Git folder/);
  // A full-path interpreter that is itself a script is followed; a chain of five is refused.
  const shim = script("shim", "#!/usr/bin/env node");
  const viaShim = script("via-shim", `#!${shim} --flag`);
  assert.deepEqual(start(viaShim), [node, [shim, "--flag", viaShim, "a"]]);
  let last = script("level-0", "#!/usr/bin/env node");
  for (let level = 1; level <= 5; level++) last = script(`level-${level}`, `#!${last}`);
  assert.throws(() => start(last), /a script whose interpreter is a script four levels deep/);
  // A binary, or a script whose interpreter no folder holds, starts as it is.
  assert.deepEqual(start(process.execPath), [process.execPath, ["a"]]);
  const missing = script("missing", "#!/usr/bin/env no-such-interpreter");
  assert.deepEqual(start(missing), [missing, ["a"]]);
});

test("TOOLS-320: env -S first lines are read as env reads them: assignments, quotes and escapes, so the interpreter starts by its full path", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-interpreter-s-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, "work"), bin = join(dir, "bin"), links = join(dir, "links"), noted = join(dir, "planted.txt");
  for (const folder of [worktree, bin, links]) mkdirSync(folder);
  const node = join(bin, "node");
  symlinkSync(process.execPath, node);
  // A node an earlier build left in the worktree, and a link a person made to it from a folder of their own, first on PATH.
  writeFileSync(join(worktree, "node"), `#!/bin/sh\necho planted >> ${JSON.stringify(noted)}\nexec ${process.execPath} "$@"\n`); chmodSync(join(worktree, "node"), 0o755);
  symlinkSync(join(worktree, "node"), join(links, "node"));
  const env = { PATH: `${links}:${bin}:/usr/bin:/bin` };
  const script = (name: string, line: string) => {
    const file = join(dir, name);
    writeFileSync(file, `${line}\nconsole.log(JSON.stringify({ mode: process.env.MODE ?? null, other: process.env.OTHER ?? null, args: process.argv.slice(2) }));\n`); chmodSync(file, 0o755);
    return file;
  };
  const start = (file: string) => startCommand(file, ["a"], env, { worktree, kind: "test" });
  const run = (file: string) => {
    const [command, args] = start(file);
    const result = spawnSync(command, args, { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  // NAME=value before the program: env keeps them, the program goes by its full path.
  const assigned = script("assigned", "#!/usr/bin/env -S MODE=review node");
  assert.deepEqual(start(assigned), ["/usr/bin/env", ["MODE=review", node, assigned, "a"]]);
  assert.deepEqual(run(assigned), { mode: "review", other: null, args: ["a"] });
  // Quoted words and escapes, as env -S splits them; -S joined to its string too.
  const quoted = script("quoted", `#!/usr/bin/env -S "node" --no-warnings`);
  assert.deepEqual(start(quoted), [node, ["--no-warnings", quoted, "a"]]);
  const spaced = script("spaced", `#!/usr/bin/env -SMODE='a b' OTHER="x\\_y" node`);
  assert.deepEqual(run(spaced), { mode: "a b", other: "x y", args: ["a"] });
  const long = script("long", "#!/usr/bin/env --split-string=OTHER=1 node # a comment");
  assert.deepEqual(start(long), ["/usr/bin/env", ["OTHER=1", node, long, "a"]]);
  // What env would expand or stop on, an option among the words, and a program only a link names are refused.
  assert.throws(() => start(script("expand", "#!/usr/bin/env -S MODE=${HOME} node")), /starts with env -S MODE=\$\{HOME\} node, so which program it runs cannot be told/);
  assert.throws(() => start(script("option", "#!/usr/bin/env -S MODE=1 -i node")), /so which program it runs cannot be told/);
  assert.throws(() => start(script("open-quote", `#!/usr/bin/env -S "node`)), /so which program it runs cannot be told/);
  assert.throws(() => start(script("stop", "#!/usr/bin/env -S node \\c --flag")), /so which program it runs cannot be told/);
  // A program whose full path holds = would read as one more setting to env.
  mkdirSync(join(dir, "a=b")); symlinkSync(process.execPath, join(dir, "a=b/node"));
  assert.throws(() => start(script("equals", `#!/usr/bin/env -S MODE=1 ${join(dir, "a=b/node")}`)), /so which program it runs cannot be told/);
  // With NAME=value words env itself starts the program: one inside the worktree is refused.
  writeFileSync(join(worktree, "env"), "#!/bin/sh\nexec /usr/bin/env \"$@\"\n"); chmodSync(join(worktree, "env"), 0o755);
  assert.throws(() => start(script("env-in-worktree", `#!${join(worktree, "env")} -S MODE=1 node`)), /starts with \S+\/work\/env, inside the worktree or its Git folder/);
  const linksOnly = { PATH: links };
  assert.throws(() => startCommand(assigned, [], linksOnly, { worktree, kind: "test" }), /node on PATH is \S+\/links\/node, a link into the worktree/);
  assert.ok(!existsSync(noted), "the planted node never started");
});

test("TOOLS-320: a fetch or push starts git's ssh by its full path, from GIT_SSH_COMMAND, core.sshCommand, GIT_SSH or ssh itself, never one a link on PATH leads into the worktree for", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-git-ssh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home"), bin = join(dir, "bin"), links = join(dir, "links"), noted = join(dir, "noted.txt");
  for (const folder of [root, home, bin, links]) mkdirSync(folder);
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } }).status, 0);
  git("init", "-q", "-b", "test");
  // The lead's ssh outside the worktree notes its arguments and fails; a build left one in the worktree, which a link leads to.
  const fakeSsh = (file: string, who: string) => { writeFileSync(file, `#!/bin/sh\necho "${who} $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(file, 0o755); };
  fakeSsh(join(bin, "ssh"), "lead's ssh");
  mkdirSync(join(root, "tools")); fakeSsh(join(root, "tools/ssh"), "planted ssh");
  symlinkSync(join(root, "tools/ssh"), join(links, "ssh"));
  const base = { ...process.env, HOME: home, PATH: `${links}:${bin}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined, GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, GIT_CONFIG_COUNT: undefined } as NodeJS.ProcessEnv;
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  // The path filter guards git's ssh where the clean room does not exist (a system without bubblewrap, TOOLS-390).
  const safety = (env: NodeJS.ProcessEnv) => asPlatform("darwin", () => gitSafety({ worktree: root, env, network: true, git: realGit }));
  // What git really starts for an ssh remote with those settings.
  const lsRemote = (env: NodeJS.ProcessEnv) => {
    rmSync(noted, { force: true });
    const safe = safety(env);
    assert.equal(safe.problem, null);
    spawnSync("git", ["-C", root, "ls-remote", "ssh://example.invalid/repo.git"], { env: { ...env, ...safe.env }, encoding: "utf8" });
    return existsSync(noted) ? readFileSync(noted, "utf8") : "";
  };
  // The link's folder leaves the command's PATH too, for anything ssh starts by name.
  const clean = `PATH=${bin}:/usr/bin:/bin `;
  assert.equal(safety(base).env.GIT_SSH_COMMAND, `${clean}${join(bin, "ssh")}`);
  assert.equal(safety(base).env.GIT_SSH_VARIANT, "ssh");
  assert.equal(safety({ ...base, PATH: `${bin}:/usr/bin:/bin` }).env.GIT_SSH_COMMAND, join(bin, "ssh"));
  assert.equal(safety({ ...base, PATH: `${bin}:/usr/bin:/bin` }).env.GIT_SSH_VARIANT, undefined, "the command starts with ssh: git tells its kind");
  assert.equal(safety({ ...base, GIT_SSH_VARIANT: "simple" }).env.GIT_SSH_VARIANT, undefined, "the lead's own kind stays");
  assert.equal(safety({ ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ssh.variant", GIT_CONFIG_VALUE_0: "simple" }).env.GIT_SSH_VARIANT, undefined);
  // A PATH among the lead's own words would bring the link's folder back, even where the call's own PATH is clean.
  assert.match(String(safety({ ...base, PATH: `${bin}:/usr/bin:/bin`, GIT_SSH_COMMAND: `PATH=${links} timeout 30 ssh` }).env.GIT_SSH_COMMAND), /cannot be told: it sets PATH itself/);
  assert.match(lsRemote(base), /^lead's ssh .*example\.invalid/);
  // The repository's own core.sshCommand is the build's: it is not taken.
  git("config", "core.sshCommand", "ssh -o Repo=1");
  assert.equal(safety(base).env.GIT_SSH_COMMAND, `${clean}${join(bin, "ssh")}`);
  git("config", "--unset", "core.sshCommand");
  // The lead's own command keeps its options and assignments; a bare name in it is found the same way.
  assert.equal(safety({ ...base, GIT_SSH_COMMAND: "ssh -o BatchMode=yes -i ~/.ssh/id" }).env.GIT_SSH_COMMAND, `${clean}${join(bin, "ssh")} -o BatchMode=yes -i ~/.ssh/id`);
  assert.match(lsRemote({ ...base, GIT_SSH_COMMAND: "X=1 ssh -o BatchMode=yes" }), /^lead's ssh -o BatchMode=yes /);
  assert.match(lsRemote({ ...base, GIT_SSH: "ssh" }), /^lead's ssh /);
  writeFileSync(join(home, ".gitconfig"), "[core]\n\tsshCommand = ssh -o Global=1\n");
  assert.match(lsRemote(base), /^lead's ssh -o Global=1 /);
  rmSync(join(home, ".gitconfig"));
  // The lead's command from the environment's own settings (command scope) is found too.
  assert.match(lsRemote({ ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "ssh -o Cmd=1" }), /^lead's ssh -o Cmd=1 /);
  assert.match(lsRemote({ ...base, GIT_CONFIG_PARAMETERS: "'core.sshCommand'='ssh -o Param=1'" }), /^lead's ssh -o Param=1 /);
  // A program that starts ssh by its bare name in turn (timeout) gets PATH without the folder that holds the link.
  const wrapped = safety({ ...base, GIT_SSH_COMMAND: "timeout 30 ssh" }).env;
  assert.match(String(wrapped.GIT_SSH_COMMAND), new RegExp(`^PATH=${bin}:/usr/bin:/bin /\\S+/timeout 30 ssh$`));
  assert.match(lsRemote({ ...base, GIT_SSH_COMMAND: "timeout 30 ssh" }), /^lead's ssh /);
  // Without another ssh on PATH, or with a command whose program cannot be told, git's ssh says why and fails: only a
  // call that starts ssh stops, and the planted one never starts.
  const refusedWith = (env: NodeJS.ProcessEnv) => {
    const safe = safety(env);
    assert.equal(safe.problem, null);
    const run = spawnSync(realGit, ["-C", root, "ls-remote", "ssh://example.invalid/repo.git"], { env: { ...env, ...safe.env }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    return run.stderr;
  };
  assert.match(refusedWith({ ...base, PATH: links }), /^kit: ssh on PATH is \S+\/links\/ssh, a link into the worktree or its Git folder/m);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: "ssh -o x=1; ssh" }), /^kit: git's ssh command \(ssh -o x=1; ssh\) cannot be told/m);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: join(root, "tools/ssh") }), /^kit: git's ssh \(\S+\) is inside the worktree or its Git folder/m);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: "env ssh" }), /^kit: git's ssh command \(env ssh\) cannot be told/m);
  // A quoted NAME=value is a program name to sh, not a setting.
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: "'X=1' ssh" }), /cannot be told: no PATH folder holds X=1/);
  // An ssh that is a #!/usr/bin/env script starts by its interpreter's full path, and git keeps treating it as ssh.
  const scripted = join(dir, "scripted"); mkdirSync(scripted);
  writeFileSync(join(scripted, "ssh"), `#!/usr/bin/env sh\necho "scripted ssh $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(join(scripted, "ssh"), 0o755);
  const shell = ["/usr/bin/sh", "/bin/sh"].find(file => existsSync(file))!;
  const viaScript = { ...base, PATH: `${links}:${scripted}:${dirname(shell)}` };
  assert.equal(safety(viaScript).env.GIT_SSH_COMMAND, `PATH=${scripted}:${dirname(shell)} ${shell} ${join(scripted, "ssh")}`);
  assert.equal(safety(viaScript).env.GIT_SSH_VARIANT, "ssh");
  assert.match(lsRemote(viaScript), /^scripted ssh .*example\.invalid/);
  // A call without the network starts no ssh: nothing changes.
  assert.equal(gitSafety({ worktree: root, env: base }).env.GIT_SSH_COMMAND, undefined);
  assert.ok(!(existsSync(noted) && readFileSync(noted, "utf8").includes("planted")), "the planted ssh never started");
});

test("TOOLS-390 R1-5: a PATH folder that holds a link into /proc, or leads there itself, leaves git's ssh command's PATH, so a wrapper's exec ssh never starts the worktree's ssh", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-git-ssh-proc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home"), procLinks = join(dir, "proc-links"), wrappers = join(dir, "wrappers"), lead = join(dir, "lead"), noted = join(dir, "noted.txt");
  for (const folder of [root, home, procLinks, wrappers, lead]) mkdirSync(folder);
  assert.equal(spawnSync("git", ["-C", root, "init", "-q", "-b", "test"], { env: { ...process.env, HOME: home } }).status, 0);
  // The lead's ssh outside the worktree notes that it ran; a build left an ssh in the worktree, git's folder.
  const fakeSsh = (file: string, who: string) => { writeFileSync(file, `#!/bin/sh\necho "${who} $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(file, 0o755); };
  fakeSsh(join(lead, "ssh"), "lead's ssh");
  fakeSsh(join(root, "ssh"), "planted ssh");
  // /proc/self/cwd is the folder of the process that opens it: for the wrapper git starts, the worktree.
  symlinkSync("/proc/self/cwd/ssh", join(procLinks, "ssh"));
  const cwdFolder = join(dir, "cwd-folder");
  symlinkSync("/proc/self/cwd", cwdFolder);
  // /dev/fd is /proc/self/fd, so /dev/fd/../cwd is /proc/self/cwd too, as a folder or an entry (GPT second look on 0868fa4).
  const devCwd = "/dev/fd/../cwd", devLinks = join(dir, "dev-links");
  mkdirSync(devLinks);
  symlinkSync("/dev/fd/../cwd/ssh", join(devLinks, "ssh"));
  // The lead's own wrapper, outside the worktree, starts ssh by its bare name.
  const wrapper = join(wrappers, "git-ssh");
  writeFileSync(wrapper, "#!/bin/sh\nexec ssh \"$@\"\n"); chmodSync(wrapper, 0o755);
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  // The run's own PATH leaves out a folder that leads into /proc as well, though from this process's folder (outside
  // the worktree) it leads elsewhere: a program the run starts in the worktree finds the worktree there.
  assert.equal(runPath({ ...process.env, PATH: `${cwdFolder}:/usr/bin:/bin` }, { worktree: root }), "/usr/bin:/bin");
  // The kit's own starts skip that folder too: with nothing else on PATH they start the bare name with the run's PATH
  // (before, they refused it), and with a copy further on they start that one by its full path (review R2-1).
  writeFileSync(join(lead, "kit-r15-tool"), "#!/bin/sh\nexit 0\n"); chmodSync(join(lead, "kit-r15-tool"), 0o755);
  const onlyCwd = { ...process.env, PATH: `${cwdFolder}:/usr/bin:/bin` };
  assert.equal(runProgram("kit-r15-tool", onlyCwd, { worktree: root, kind: "test" }), "kit-r15-tool");
  assert.deepEqual(startCommand("kit-r15-tool", [], onlyCwd, { worktree: root, kind: "test" }), ["kit-r15-tool", []]);
  const throughCwd = { ...process.env, PATH: `${cwdFolder}:${lead}:/usr/bin:/bin` };
  assert.equal(runProgram("kit-r15-tool", throughCwd, { worktree: root, kind: "test" }), join(lead, "kit-r15-tool"));
  assert.deepEqual(startCommand("kit-r15-tool", [], throughCwd, { worktree: root, kind: "test" }), [join(lead, "kit-r15-tool"), []]);
  // An entry that leads through /dev into /proc is refused by the kit's own starts, and a copy further on starts in its
  // place (review R5-3); an entry that leads to /dev/null is no program, so it is passed over as before (review R5-4).
  const devTools = join(dir, "dev-tools");
  mkdirSync(devTools);
  symlinkSync("/dev/fd/../cwd/kit-r15-tool", join(devTools, "kit-r15-tool"));
  symlinkSync("/dev/null", join(devTools, "kit-r15-off"));
  const viaDev = { ...process.env, PATH: `${devTools}:/usr/bin:/bin` }, viaDevLead = { ...process.env, PATH: `${devTools}:${lead}:/usr/bin:/bin` };
  const refusedViaDev = /kit-r15-tool on PATH is \S+, which leads into \/proc\//;
  assert.throws(() => runProgram("kit-r15-tool", viaDev, { worktree: root, kind: "test" }), refusedViaDev);
  assert.throws(() => startCommand("kit-r15-tool", [], viaDev, { worktree: root, kind: "test" }), refusedViaDev);
  assert.equal(runProgram("kit-r15-tool", viaDevLead, { worktree: root, kind: "test" }), join(lead, "kit-r15-tool"));
  assert.deepEqual(startCommand("kit-r15-tool", [], viaDevLead, { worktree: root, kind: "test" }), [join(lead, "kit-r15-tool"), []]);
  assert.equal(runProgram("kit-r15-off", viaDev, { worktree: root, kind: "test" }), "kit-r15-off");
  assert.deepEqual(startCommand("kit-r15-off", [], viaDev, { worktree: root, kind: "test" }), ["kit-r15-off", []]);
  // A folder that leads into /dev itself stays on PATH, but its entries that lead on into /proc are refused: /dev/stdin
  // is /proc/self/fd/0 (review R6-5).
  const devFolder = join(dir, "dev-folder");
  symlinkSync("/dev", devFolder);
  const viaDevFolder = { ...process.env, PATH: `${devFolder}:/usr/bin:/bin` };
  assert.equal(runPath(viaDevFolder, { worktree: root }), undefined);
  assert.throws(() => runProgram("stdin", viaDevFolder, { worktree: root, kind: "test" }), /stdin on PATH is \S+, which leads into \/proc\//);
  // A wrapper script, and a program that starts ssh by its bare name (timeout), both run git's ssh for real.
  for (const first of [procLinks, cwdFolder, devCwd, devLinks]) for (const command of [wrapper, "timeout 30 ssh"]) {
    const env = { ...process.env, HOME: home, PATH: `${first}:${wrappers}:${lead}:/usr/bin:/bin`, GIT_SSH_COMMAND: command,
      GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined, GIT_SSH: undefined, GIT_CONFIG_COUNT: undefined } as NodeJS.ProcessEnv;
    // The path filter, where the clean room does not exist (the room's own test of these doors is TOOLS-390 room R1-1).
    const safe = asPlatform("darwin", () => gitSafety({ worktree: root, env, network: true, git: realGit }));
    const label = `${first} with ${command}`;
    assert.equal(safe.problem, null, label);
    rmSync(noted, { force: true });
    spawnSync(realGit, ["-C", root, "ls-remote", "ssh://example.invalid/repo.git"], { env: { ...env, ...safe.env }, encoding: "utf8" });
    const ran = existsSync(noted) ? readFileSync(noted, "utf8") : "";
    assert.doesNotMatch(ran, /planted ssh/, label);
    assert.match(ran, /^lead's ssh .*example\.invalid/, label);
    assert.ok(String(safe.env.GIT_SSH_COMMAND).startsWith(`PATH=${wrappers}:${lead}:/usr/bin:/bin /`), `${label}: ${safe.env.GIT_SSH_COMMAND}`);
    if (command === wrapper) assert.equal(safe.env.GIT_SSH_COMMAND, `PATH=${wrappers}:${lead}:/usr/bin:/bin ${wrapper}`, label);
  }
  assert.equal(runPath({ ...process.env, PATH: `${devCwd}:/usr/bin:/bin` }, { worktree: root }), "/usr/bin:/bin");
});

test("TOOLS-390 R1-6: a PATH folder or entry that passes through a worktree link leading out (tools-link -> a bin folder) is not trusted by the run's PATH, the kit's starts or git's ssh", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-tools-link-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home"), bin = join(dir, "bin"), homeBin = join(home, "bin");
  for (const folder of [root, home, bin, homeBin]) mkdirSync(folder);
  for (const name of ["ssh", "kit-r16-tool"]) { writeFileSync(join(bin, name), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, name), 0o755); }
  // A worktree folder that is a link leading out counts as the worktree, as the path is written: a build can point it
  // elsewhere after the check.
  const toolsLink = join(root, "tools-link");
  symlinkSync(bin, toolsLink);
  const base = { ...process.env, HOME: home, GIT_SSH_COMMAND: undefined, GIT_SSH: undefined } as NodeJS.ProcessEnv;
  const throughFolder = { ...base, PATH: `${toolsLink}:/usr/bin:/bin` };
  assert.equal(runPath(throughFolder, { worktree: root }), "/usr/bin:/bin");
  assert.equal(runProgram("kit-r16-tool", throughFolder, { worktree: root }), "kit-r16-tool", "found in no trusted folder, so started by its bare name with the run's PATH");
  assert.deepEqual(startCommand("kit-r16-tool", [], throughFolder, { worktree: root, kind: "test" }), ["kit-r16-tool", []]);
  // git's ssh comes from the trusted folders alone, with PATH without the link folder (review R5-5).
  const plain = sshCommand(throughFolder, { worktree: root });
  if (existsSync("/usr/bin/ssh") || existsSync("/bin/ssh")) {
    assert.equal(plain.problem, null);
    assert.match(String(plain.command), /^PATH=\/usr\/bin:\/bin \/(?:usr\/)?bin\/ssh$/);
  }
  const timed = sshCommand({ ...throughFolder, GIT_SSH_COMMAND: "timeout 30 ssh" }, { worktree: root });
  assert.equal(timed.problem, null);
  assert.match(String(timed.command), /^PATH=\/usr\/bin:\/bin \/\S*\/timeout 30 ssh$/);
  // An entry of a folder outside that leads through such a link: ~/bin/x -> <worktree>/bin/x, <worktree>/bin -> a bin folder.
  symlinkSync(bin, join(root, "bin"));
  for (const name of ["ssh", "kit-r16-tool"]) symlinkSync(join(root, "bin", name), join(homeBin, name));
  const throughEntry = { ...base, PATH: `${homeBin}:/usr/bin:/bin` };
  assert.throws(() => runProgram("kit-r16-tool", throughEntry, { worktree: root, kind: "test" }), /kit-r16-tool on PATH is \S+, a link into the worktree or its Git folder/);
  assert.throws(() => startCommand("kit-r16-tool", [], throughEntry, { worktree: root, kind: "test" }), /kit-r16-tool on PATH is \S+, a link into the worktree or its Git folder/);
  // git's ssh is the next one on PATH, by its full path, with PATH without the folder that holds the link.
  const lead = join(dir, "lead");
  mkdirSync(lead);
  writeFileSync(join(lead, "ssh"), "#!/bin/sh\nexit 1\n"); chmodSync(join(lead, "ssh"), 0o755);
  const withLead = { ...base, PATH: `${homeBin}:${lead}:/usr/bin:/bin` };
  const direct = sshCommand(withLead, { worktree: root });
  assert.equal(direct.problem, null);
  assert.equal(direct.command, `PATH=${lead}:/usr/bin:/bin ${join(lead, "ssh")}`);
  // A program that starts ssh by its bare name in turn gets PATH without the folder that holds the link.
  const wrapped = sshCommand({ ...withLead, GIT_SSH_COMMAND: "timeout 30 ssh" }, { worktree: root });
  assert.equal(wrapped.problem, null);
  const leadPattern = lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(String(wrapped.command), new RegExp(`^PATH=${leadPattern}:/usr/bin:/bin \\S+/timeout 30 ssh$`));
});

// The Windows bug itself (a walk that splits C:\ paths on / only) cannot be shown on Linux, whose path functions read no
// \ or drive letter, and CI has no Windows runner; so the junction case passes on the code before the fix too. The test
// runs the Windows branch with the platform faked, pins what it must still catch there, and shows the branch is taken.
test("TOOLS-390 SL-1: on Windows a PATH folder is judged by the system's own link reading, so a junction into the worktree, or a folder written inside it, is not trusted", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-sl1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), tools = join(root, "tools"), bin = join(dir, "bin"), junction = join(dir, "junction");
  for (const folder of [root, tools, bin]) mkdirSync(folder);
  writeFileSync(join(tools, "kit-sl1-tool"), "#!/bin/sh\nexit 1\n"); chmodSync(join(tools, "kit-sl1-tool"), 0o755);
  // A link stands in for a junction: an outside folder that leads to <worktree>\tools.
  symlinkSync(tools, junction);
  symlinkSync(bin, join(root, "tools-link"));
  const viaLink = join(dir, "via-link");
  symlinkSync(join(root, "tools-link"), viaLink);
  const dangling = join(dir, "dangling");
  symlinkSync(join(root, "not-yet"), dangling);
  const dropped = (folder: string) => assert.equal(runPath({ ...process.env, PATH: `${folder}:/usr/bin:/bin` }, { worktree: root }), "/usr/bin:/bin", folder);
  asPlatform("win32", () => {
    const viaJunction = { ...process.env, PATH: `${junction}:/usr/bin:/bin` };
    dropped(junction);
    assert.equal(runProgram("kit-sl1-tool", viaJunction, { worktree: root, kind: "test" }), "kit-sl1-tool", "not taken from the junction, so started by its bare name with the run's PATH");
    dropped(join(root, "tools-link"));
    // A part that is not there yet is read through the junction above it (review R6-4), and a junction to a folder
    // a build can make later counts where it leads (review R6-1).
    dropped(join(junction, "later", "sub"));
    dropped(dangling);
    // Windows paths ignore case: the worktree written in other letters is still the worktree (review R6-2).
    dropped(join(dir, "WORK", "bin"));
    // The Windows branch is taken: it judges by where a folder leads, so one that only passes through a worktree link
    // on the way is kept there (as the README says), while the walk elsewhere drops it (review R6-3).
    assert.equal(runPath({ ...process.env, PATH: `${viaLink}:/usr/bin:/bin` }, { worktree: root }), undefined);
  });
  dropped(viaLink);
});

// The clean room (TOOLS-390): on Linux git's ssh runs in bubblewrap where the worktree, every other worktree of the
// repository and the Git folder are empty folders, and the rest of the machine (ssh's keys, agent and known_hosts) is as
// it is. Each test runs a real git ls-remote against an ssh remote: a stand-in for the lead's ssh outside the worktree
// notes the folder it runs in and whether it sees the worktree's files, and a planted ssh in the worktree notes that
// it ran. A test made the room on a machine without bubblewrap fakes another system (asPlatform).
const gitProgram = () => String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
function roomRepo(t: TestContext, name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `kit-room-${name}-`)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home"), lead = join(dir, "lead"), noted = join(dir, "noted.txt");
  for (const folder of [root, home, lead]) mkdirSync(folder);
  assert.equal(spawnSync("git", ["-C", root, "init", "-q", "-b", "test"], { env: { ...process.env, HOME: home } }).status, 0);
  // `seen` lists the files the lead's ssh checks for: the worktree's own .git by default.
  const leadSsh = (file: string, seen: string[] = [join(root, ".git")]) => {
    const checks = seen.map(path => `[ -e ${JSON.stringify(path)} ] && echo "sees ${path}" >> ${JSON.stringify(noted)}`).join("\n");
    writeFileSync(file, `#!/bin/sh\necho "lead's ssh in $(pwd): $*" >> ${JSON.stringify(noted)}\n${checks}\nexit 1\n`); chmodSync(file, 0o755);
  };
  const planted = (file: string) => { writeFileSync(file, `#!/bin/sh\necho "planted ssh $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(file, 0o755); };
  leadSsh(join(lead, "ssh"));
  planted(join(root, "ssh"));
  const base = { ...process.env, HOME: home, PATH: `${lead}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined, GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined, GIT_SSH_VARIANT: undefined, GIT_CONFIG_COUNT: undefined, GIT_CONFIG_PARAMETERS: undefined, KIT_OUTER_LOCK: undefined, ASE_KEY_GUARD: undefined } as NodeJS.ProcessEnv;
  // A fetch from an ssh remote with gitSafety's variables, from `worktree` (the repository's main one by default).
  const fetch = (env: NodeJS.ProcessEnv, worktree = root) => {
    rmSync(noted, { force: true });
    const safe = gitSafety({ worktree, env, network: true, git: gitProgram() });
    assert.equal(safe.problem, null);
    const run = spawnSync(gitProgram(), ["-C", worktree, "ls-remote", "ssh://host.invalid/x"], { env: { ...env, ...safe.env }, encoding: "utf8", timeout: 30_000 });
    return { safe, run, ran: existsSync(noted) ? readFileSync(noted, "utf8") : "" };
  };
  // What the room shows: the lead's ssh ran, in /, and saw none of the build's files; the planted one never ran.
  const inRoom = ({ safe, ran }: { safe: { env: NodeJS.ProcessEnv }, ran: string }, label: string) => {
    assert.doesNotMatch(ran, /^sees |planted ssh/m, `${label}: ${ran}`);
    assert.match(ran, /^lead's ssh in \/: .*host\.invalid/, `${label}: ${ran}`);
    assert.match(String(safe.env.GIT_SSH_COMMAND), /^\/\S*bwrap /, `${label}: git's ssh starts bubblewrap (${safe.env.GIT_SSH_COMMAND})`);
  };
  return { dir, root, home, lead, noted, base, fetch, inRoom, leadSsh, planted };
}

test("TOOLS-390 room R1-1: git's ssh runs where the worktree holds nothing, so a /proc/self/cwd link and a wrapper's exec ssh start only the lead's ssh", { skip: noRoom }, t => {
  const { dir, root, lead, base, fetch, inRoom } = roomRepo(t, "proc-self");
  // A PATH folder outside the worktree with ssh -> /proc/self/cwd/ssh, which for a program git starts is the worktree's
  // ssh (R1-1, R2-7, R2-8); the same through /dev/fd/../cwd, and as a folder that leads there itself (R1-5, R2-3, R2-12).
  const procLinks = join(dir, "proc-links"), devLinks = join(dir, "dev-links"), wrappers = join(dir, "wrappers"), cwdFolder = join(dir, "cwd-folder");
  for (const folder of [procLinks, devLinks, wrappers]) mkdirSync(folder);
  symlinkSync("/proc/self/cwd/ssh", join(procLinks, "ssh"));
  symlinkSync("/dev/fd/../cwd/ssh", join(devLinks, "ssh"));
  symlinkSync("/proc/self/cwd", cwdFolder);
  // The lead's own wrapper, outside the worktree, starts ssh by its bare name.
  const wrapper = join(wrappers, "git-ssh");
  writeFileSync(wrapper, "#!/bin/sh\nexec ssh \"$@\"\n"); chmodSync(wrapper, 0o755);
  for (const first of [procLinks, devLinks, cwdFolder, "/dev/fd/../cwd"]) for (const command of [wrapper, "timeout 30 ssh", undefined]) {
    const env = { ...base, PATH: `${first}:${wrappers}:${lead}:/usr/bin:/bin`, GIT_SSH_COMMAND: command };
    inRoom(fetch(env), `${first} with ${command ?? "ssh by name"}`);
  }
  assert.ok(existsSync(join(root, "ssh")), "the planted ssh is still there: the room hid it");
});

test("TOOLS-390 room R1-2: a worktree link folder on PATH (tools-link) holds nothing in the room, even when a build points it at a planted ssh after the check", { skip: noRoom }, t => {
  const { root, home, lead, noted, base, fetch, inRoom, planted } = roomRepo(t, "tools-link");
  const plantedBin = join(root, "planted-bin"), homeBin = join(home, "bin");
  mkdirSync(plantedBin); mkdirSync(homeBin);
  planted(join(plantedBin, "ssh"));
  // A worktree folder that is a link leading out (R1-2, R2-6, R2-9, gaps R1-6, R2-2, R2-13), on PATH as a folder ...
  const toolsLink = join(root, "tools-link");
  symlinkSync(lead, toolsLink);
  const throughFolder = { ...base, PATH: `${toolsLink}:${lead}:/usr/bin:/bin` };
  inRoom(fetch(throughFolder), "tools-link as it was checked");
  // ... and pointed at the planted ssh after gitSafety looked: git's ssh starts later, in the room, where the link is gone.
  const race = (env: NodeJS.ProcessEnv, repoint: () => void, label: string) => {
    const safe = gitSafety({ worktree: root, env, network: true, git: gitProgram() });
    repoint();
    rmSync(noted, { force: true });
    spawnSync(gitProgram(), ["-C", root, "ls-remote", "ssh://host.invalid/x"], { env: { ...env, ...safe.env }, encoding: "utf8", timeout: 30_000 });
    inRoom({ safe, ran: existsSync(noted) ? readFileSync(noted, "utf8") : "" }, label);
  };
  race(throughFolder, () => { rmSync(toolsLink); symlinkSync(plantedBin, toolsLink); }, "tools-link pointed at the planted ssh after the check");
  // An entry outside that leads through such a link: ~/bin/ssh -> <worktree>/bin/ssh, <worktree>/bin -> the lead's folder.
  symlinkSync(lead, join(root, "bin"));
  symlinkSync(join(root, "bin", "ssh"), join(homeBin, "ssh"));
  const throughEntry = { ...base, PATH: `${homeBin}:${lead}:/usr/bin:/bin` };
  race(throughEntry, () => { rmSync(join(root, "bin")); symlinkSync(plantedBin, join(root, "bin")); }, "<worktree>/bin pointed at the planted ssh after the check");
  // An entry outside that led to the lead's ssh when checked and to the worktree's after: a process a build left running
  // can change a link in HOME after the check.
  rmSync(join(homeBin, "ssh"));
  symlinkSync(join(lead, "ssh"), join(homeBin, "ssh"));
  race(throughEntry, () => { rmSync(join(homeBin, "ssh")); symlinkSync(join(root, "ssh"), join(homeBin, "ssh")); }, "~/bin/ssh pointed into the worktree after the check");
  // Named by its path as git's ssh, the link leads nowhere in the room: the fetch fails, and the planted ssh never runs.
  rmSync(join(homeBin, "ssh"));
  symlinkSync(join(lead, "ssh"), join(homeBin, "ssh"));
  const named = { ...throughEntry, GIT_SSH_COMMAND: join(homeBin, "ssh") };
  const safe = gitSafety({ worktree: root, env: named, network: true, git: gitProgram() });
  rmSync(join(homeBin, "ssh")); symlinkSync(join(root, "ssh"), join(homeBin, "ssh"));
  rmSync(noted, { force: true });
  const run = spawnSync(gitProgram(), ["-C", root, "ls-remote", "ssh://host.invalid/x"], { env: { ...named, ...safe.env }, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(run.status, 0);
  assert.ok(!existsSync(noted), "GIT_SSH_COMMAND=~/bin/ssh pointed into the worktree after the check: nothing ran");
});

test("TOOLS-390 room R1-8: a loop of links as git's ssh fails in the room, and nothing planted starts", { skip: noRoom }, t => {
  const { dir, base, fetch } = roomRepo(t, "loop");
  symlinkSync(join(dir, "b"), join(dir, "a"));
  symlinkSync(join(dir, "a"), join(dir, "b"));
  const script = join(dir, "loop-script");
  writeFileSync(script, `#!${join(dir, "a")}\n`); chmodSync(script, 0o755);
  // R1-8, R2-1, R2-14: the lead's command runs as written, and the system says why it cannot start.
  for (const command of [join(dir, "a"), script]) {
    const result = fetch({ ...base, GIT_SSH_COMMAND: command });
    assert.match(String(result.safe.env.GIT_SSH_COMMAND), /^\/\S*bwrap /, command);
    assert.notEqual(result.run.status, 0, command);
    assert.equal(result.ran, "", `${command}: nothing ran`);
    assert.doesNotMatch(result.run.stderr, /^kit: the clean room for git's ssh /m, `${command}: not refused by the kit, the room runs it as written`);
    assert.match(result.run.stderr, /^kit: a program was not found \(exit 127\)\. If it was git's ssh or a program it starts, the clean room keeps these folders empty: /m, command);
  }
});

test("TOOLS-390 room: the lead's own ssh command runs as written in the room: a shell line, env, sh -c, a $ word and a wrapper are not refused", { skip: noRoom }, t => {
  const { dir, root, home, lead, base, fetch, inRoom } = roomRepo(t, "as-written");
  const wrappers = join(dir, "wrappers"), wrapper = join(wrappers, "git-ssh");
  mkdirSync(wrappers);
  writeFileSync(wrapper, "#!/bin/sh\nexec ssh \"$@\"\n"); chmodSync(wrapper, 0o755);
  // Each of these the path filter refuses; in the room what it guards against cannot happen (R1-3, R2-5, R2-10).
  for (const command of ["ssh -o BatchMode=yes", "true; ssh", "env ssh", "sh -c 'exec ssh \"$@\"' sh", "X=$HOME ssh -i ~/.ssh/id", `PATH=${lead}:/usr/bin:/bin ssh`, wrapper]) {
    const result = fetch({ ...base, GIT_SSH_COMMAND: command });
    inRoom(result, command);
    assert.doesNotMatch(result.run.stderr, /^kit: /m, command);
  }
  // git's other ways to name the lead's ssh: GIT_SSH (one program), core.sshCommand from the lead's global config or the
  // environment; the repository's own core.sshCommand is the build's and is never taken.
  inRoom(fetch({ ...base, GIT_SSH: join(lead, "ssh") }), "GIT_SSH");
  writeFileSync(join(home, ".gitconfig"), `[core]\n\tsshCommand = ${join(lead, "ssh")} -o Global=1\n`);
  const global = fetch(base);
  inRoom(global, "global core.sshCommand");
  assert.match(global.ran, /-o Global=1/);
  rmSync(join(home, ".gitconfig"));
  inRoom(fetch({ ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.sshCommand", GIT_CONFIG_VALUE_0: "ssh -o Cmd=1" }), "core.sshCommand from the environment");
  assert.equal(spawnSync("git", ["-C", root, "config", "core.sshCommand", join(root, "ssh")]).status, 0);
  inRoom(fetch(base), "the repository's own core.sshCommand");
});

test("TOOLS-390 room: a /proc/<pid>/cwd link leads nowhere in the room, though a process sits in the worktree", { skip: noRoom }, t => {
  const { dir, root, lead, base, fetch, inRoom } = roomRepo(t, "proc-pid");
  // A process a build left behind, with its folder in the worktree: /proc/<pid>/cwd/ssh is the planted ssh, whoever opens it.
  const sitter = spawn("sleep", ["60"], { cwd: root, stdio: "ignore" });
  t.after(() => sitter.kill());
  const pidCwd = `/proc/${sitter.pid}/cwd`;
  assert.ok(existsSync(join(pidCwd, "ssh")), "outside the room the link leads to the planted ssh");
  const pidLinks = join(dir, "pid-links"), pidFolder = join(dir, "pid-folder");
  mkdirSync(pidLinks);
  symlinkSync(join(pidCwd, "ssh"), join(pidLinks, "ssh"));
  symlinkSync(pidCwd, pidFolder);
  for (const first of [pidLinks, pidFolder]) inRoom(fetch({ ...base, PATH: `${first}:${lead}:/usr/bin:/bin` }), first);
  // Named as git's ssh itself, it runs as written and finds nothing: the room has a process list of its own.
  const direct = fetch({ ...base, GIT_SSH_COMMAND: join(pidCwd, "ssh") });
  assert.match(String(direct.safe.env.GIT_SSH_COMMAND), /^\/\S*bwrap /);
  assert.notEqual(direct.run.status, 0);
  assert.equal(direct.ran, "", "the planted ssh never ran");
});

test("TOOLS-390 room: every worktree of the repository and its Git folder are empty in the room", { skip: noRoom }, t => {
  const { dir, root, lead, base, fetch, inRoom, leadSsh } = roomRepo(t, "worktrees");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args]).status, 0, args.join(" "));
  git("commit", "-q", "--allow-empty", "-m", "first");
  const other = join(dir, "other"), third = join(dir, "third"), nested = join(root, "nested"), relative = join(dir, "relative");
  git("worktree", "add", "-q", other, "-b", "other");
  git("worktree", "add", "-q", third, "-b", "third");
  git("worktree", "add", "-q", nested, "-b", "nested");
  // A linked worktree whose entries name each other by relative paths (git 2.48 and later).
  const [major, minor] = (/(\d+)\.(\d+)/.exec(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout) ?? []).slice(1).map(Number);
  const relativePaths = major > 2 || (major === 2 && minor >= 48);
  if (relativePaths) git("-c", "worktree.useRelativePaths=true", "worktree", "add", "-q", relative, "-b", "relative");
  leadSsh(join(lead, "ssh"), [join(root, ".git"), join(root, ".git/HEAD"), join(other, ".git"), join(third, ".git"), join(nested, ".git"), ...(relativePaths ? [join(relative, ".git")] : [])]);
  // From a linked worktree: the main worktree, the other linked ones (one inside the main one) and the Git folder.
  for (const worktree of [other, nested, root, ...(relativePaths ? [relative] : [])]) inRoom(fetch(base, worktree), worktree);
});

test("TOOLS-390 room: a folder the Git folder names is hidden only as git would take it, and never when it is / or holds the home folder or a system folder", { skip: noRoom }, t => {
  const { dir, root, home, lead, base, fetch, inRoom, leadSsh } = roomRepo(t, "folders");
  const command = (env = base) => String(gitSafety({ worktree: root, env, network: true, git: gitProgram() }).env.GIT_SSH_COMMAND);
  const hidden = (env = base) => [...command(env).matchAll(/--tmpfs (\S+)/g)].map(match => match[1].replace(/^'(.*)'$/, "$1"));
  const entry = (name: string, gitFile: string) => {
    mkdirSync(join(root, ".git/worktrees", name), { recursive: true });
    writeFileSync(join(root, ".git/worktrees", name, "gitdir"), `${gitFile}\n`);
  };
  // An entry whose .git file does not lead back to it is not a worktree of this repository (a build wrote it).
  const elsewhere = join(dir, "elsewhere"), other = join(dir, "other-repo");
  mkdirSync(elsewhere); mkdirSync(other);
  writeFileSync(join(elsewhere, ".git"), `gitdir: ${join(other, ".git")}\n`);
  entry("one-way", join(elsewhere, ".git"));
  // Entries that would hide a system folder, / or the home folder, each with a .git file that leads back (or none).
  entry("usr", "/usr/.git");
  entry("root", "/.git");
  writeFileSync(join(home, ".git"), `gitdir: ${join(root, ".git/worktrees/home")}\n`);
  entry("home", join(home, ".git"));
  // A real linked worktree, written by hand the way git does: both entries name each other.
  const linked = join(dir, "linked");
  mkdirSync(linked);
  writeFileSync(join(linked, ".git"), `gitdir: ${join(root, ".git/worktrees/linked")}\n`);
  entry("linked", join(linked, ".git"));
  assert.deepEqual(hidden(), [root, linked].sort());
  // The home folder named there is left as it is, so a fetch is not refused for it.
  assert.doesNotMatch(command(), /^printf /);
  // core.worktree in the Git folder's config names the main worktree; / or a system folder there is skipped too.
  const main = join(dir, "main");
  mkdirSync(main);
  // Inside a system folder only a folder below /usr/local/src or /usr/src that is not a PATH folder and holds none is
  // hidden: a checkout there. The loader and libc, /etc/ssh, a locally built ssh's /usr/local/etc and the rest are not.
  const values: [string, string[]][] = [[main, [root, linked, main]], ["../../main", [root, linked, main]], ["/", [root, linked]], ["/etc", [root, linked]],
    ["/usr/bin", [root, linked]], ["/usr/share", [root, linked]], ["/usr/lib", [root, linked]], ["/dev", [root, linked]], ["/usr/local", [root, linked]]];
  // /run holds the agent's socket and DNS settings; /var and /tmp hold more of the machine.
  for (const folder of ["/etc/ssh", "/usr/local/etc", "/usr/local/lib", "/usr/local/src", "/usr/src", "/run", "/run/user", "/var", "/tmp"]) if (existsSync(folder)) values.push([folder, [root, linked]]);
  const checkout = existsSync("/usr/src") && readdirSync("/usr/src", { withFileTypes: true }).find(item => item.isDirectory());
  const checkoutPath = checkout ? realpathSync(join("/usr/src", checkout.name)) : null;
  if (checkoutPath) values.push([checkoutPath, [root, linked, checkoutPath]]);
  for (const [value, expected] of values) {
    assert.equal(spawnSync("git", ["-C", root, "config", "core.worktree", value]).status, 0);
    assert.deepEqual(hidden(), [...expected].sort(), value);
  }
  // A checkout there is hidden even when it is a PATH folder (its bin/ssh is not found), as any worktree is.
  if (checkoutPath) {
    assert.equal(spawnSync("git", ["-C", root, "config", "core.worktree", checkoutPath]).status, 0);
    assert.deepEqual(hidden({ ...base, PATH: `${checkoutPath}:${base.PATH}` }), [root, linked, checkoutPath].sort(), "a checkout on PATH");
  }
  // A PATH folder below /usr/local is not hidden either.
  if (existsSync("/usr/local/bin")) {
    assert.equal(spawnSync("git", ["-C", root, "config", "core.worktree", "/usr/local/bin"]).status, 0);
    assert.deepEqual(hidden({ ...base, PATH: `/usr/local/bin:${base.PATH}` }), [root, linked].sort(), "/usr/local/bin on PATH");
  }
  // With the libraries named there, a fetch still reaches the lead's ssh in the room.
  assert.equal(spawnSync("git", ["-C", root, "config", "core.worktree", "/usr/lib"]).status, 0);
  inRoom(fetch(base), "/usr/lib named");
  // A main worktree outside the system folders is hidden even when it holds a PATH folder: ssh there is not found.
  mkdirSync(join(main, "bin"));
  assert.equal(spawnSync("git", ["-C", root, "config", "core.worktree", main]).status, 0);
  assert.deepEqual(hidden({ ...base, PATH: `${join(main, "bin")}:${base.PATH}` }), [root, linked, main].sort(), "a PATH folder in the main worktree");
  // Read as git reads it: a comment right after the value, and a key of the same name in a later section with a
  // subsection name, which is not core's.
  assert.equal(spawnSync("git", ["-C", root, "config", "--unset", "core.worktree"]).status, 0);
  writeFileSync(join(root, ".git/config"), `${readFileSync(join(root, ".git/config"), "utf8")}[core]\n\tworktree = ${main}# the main checkout\n[remote "origin"]\n\tworktree = /dev\n`);
  assert.deepEqual(hidden(), [root, linked, main].sort(), "a comment and a subsection");
  // config.worktree counts only while config turns on extensions.worktreeConfig, as git reads it.
  writeFileSync(join(root, ".git/config.worktree"), `[core]\n\tworktree = "${elsewhere}";quoted\n`);
  assert.deepEqual(hidden(), [root, linked, main].sort(), "config.worktree without extensions.worktreeConfig");
  assert.equal(spawnSync("git", ["-C", root, "config", "extensions.worktreeConfig", "true"]).status, 0);
  assert.deepEqual(hidden(), [root, linked, elsewhere].sort(), "config.worktree");
  // A key on its section header's line, and a later subsection name with a quote in it, which is not core's.
  writeFileSync(join(root, ".git/config.worktree"), `[core] worktree = ${main}\n[remote "a\\"b"]\n\tworktree = ${elsewhere}\n`);
  assert.deepEqual(hidden(), [root, linked, main].sort(), "a key on the header's line");
  // An include and a continued line, as git reads them: the main worktree they name stays empty for a real fetch.
  rmSync(join(root, ".git/config.worktree"));
  assert.equal(spawnSync("git", ["-C", root, "config", "--unset", "extensions.worktreeConfig"]).status, 0);
  assert.equal(spawnSync("git", ["-C", root, "config", "--unset-all", "core.worktree"]).status, 0);
  const plain = readFileSync(join(root, ".git/config"), "utf8");
  writeFileSync(join(main, "marker"), "");
  leadSsh(join(lead, "ssh"), [join(root, ".git"), join(main, "marker")]);
  writeFileSync(join(dir, "included"), `[core]\n\tworktree = ${main}\n`);
  writeFileSync(join(root, ".git/config"), `${plain}[include]\n\tpath = ${join(dir, "included")}\n`);
  assert.deepEqual(hidden(), [root, linked, main].sort(), "an include");
  inRoom(fetch(base), "an include");
  writeFileSync(join(root, ".git/config"), `${plain}[core]\n\tworktree = ${main.slice(0, -2)}\\\n${main.slice(-2)}\n`);
  assert.deepEqual(hidden(), [root, linked, main].sort(), "a continued line");
  inRoom(fetch(base), "a continued line");
  // `..` after a link, as git walks it: link/.. with link -> <main>/sub is the main worktree, not the Git folder.
  mkdirSync(join(main, "sub"));
  symlinkSync(join(main, "sub"), join(root, ".git/link"));
  writeFileSync(join(root, ".git/config"), `${plain}[core]\n\tworktree = link/..\n`);
  const top = spawnSync("git", ["--git-dir", join(root, ".git"), "rev-parse", "--show-toplevel"], { encoding: "utf8", env: { ...base, GIT_DIR: undefined, GIT_WORK_TREE: undefined } }).stdout.trim();
  assert.equal(realpathSync(top), realpathSync(main), "git itself takes link/.. as the main worktree");
  assert.deepEqual(hidden(), [root, linked, main].sort(), "link/..");
  inRoom(fetch(base), "link/..");
  // The same for a linked worktree's entry: link/../.git with link -> <deep>/sub is <deep>'s .git file.
  writeFileSync(join(root, ".git/config"), plain);
  const deep = join(dir, "deep");
  mkdirSync(join(deep, "sub"), { recursive: true });
  entry("hop", "link/../.git");
  symlinkSync(join(deep, "sub"), join(root, ".git/worktrees/hop/link"));
  writeFileSync(join(deep, ".git"), `gitdir: ${join(root, ".git/worktrees/hop")}\n`);
  assert.deepEqual(hidden(), [root, linked, deep].sort(), "a linked worktree's link/../.git");
  rmSync(join(root, ".git/worktrees/hop"), { recursive: true });
  // A core.worktree from outside the repository's own config (here the environment) is not the main worktree.
  writeFileSync(join(root, ".git/config"), plain);
  assert.deepEqual(hidden({ ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: elsewhere }), [root, linked].sort(), "core.worktree from the environment");
});

test("TOOLS-390 room: where git cannot read the Git folder's core.worktree, the room does not start", { skip: noRoom }, t => {
  const { root, base } = roomRepo(t, "unread");
  // No git outside the worktree and the Git folder (the system folders are searched too, so none is given here): the
  // build's git never reads the config, so the room does not start.
  const noGit = String(sshRoom(base, { worktree: root, common: join(root, ".git"), configured: "", git: [] })?.command);
  assert.match(noGit, /^printf .*the clean room for git.*s ssh cannot start: git is not on PATH outside the worktree/, noGit);
  // A config git refuses to read: the main worktree it names could stay visible, so the room says it cannot start
  // (gitSafety's own read of the config stops a fetch even before that).
  writeFileSync(join(root, ".git/config"), `${readFileSync(join(root, ".git/config"), "utf8")}[core\n`);
  const report = cleanRoomReport(base, { worktree: root, common: join(root, ".git") });
  assert.equal(report.state, "problem");
  assert.match(report.text, /^clean room cannot start: git cannot read the Git folder's core\.worktree \(.*bad config line/, report.text);
});

test("TOOLS-390 room: a bwrap left in another worktree never starts, even when an earlier lookup found it", { skip: noRoom }, t => {
  const { dir, root, base, noted } = roomRepo(t, "bwrap");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args]).status, 0, args.join(" "));
  git("commit", "-q", "--allow-empty", "-m", "first");
  const linked = join(dir, "linked");
  git("worktree", "add", "-q", linked, "-b", "linked");
  // A bwrap the build left in the main worktree, first on PATH, that passes everything on to the real one.
  const real = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin/bwrap"), `#!/bin/sh\necho "planted bwrap" >> ${JSON.stringify(noted)}\nexec ${JSON.stringify(real)} "$@"\n`); chmodSync(join(root, "bin/bwrap"), 0o755);
  const env = { ...base, PATH: `${join(root, "bin")}:${base.PATH}` };
  const safety = () => gitSafety({ worktree: linked, env, network: true, git: gitProgram() }).env;
  t.after(resetBwrapProbe);
  // From the linked worktree the room looks bubblewrap up outside the main one: the planted one never starts.
  resetBwrapProbe(); rmSync(noted, { force: true });
  const command = String(safety().GIT_SSH_COMMAND);
  assert.match(command, /^\/\S*bwrap /, command);
  assert.ok(!command.includes(join(root, "bin/bwrap")), command);
  assert.equal(existsSync(noted), false, "the planted bwrap started");
  // The key lock looks it up shutting out only the linked worktree and the Git folder; the room then refuses that one.
  resetBwrapProbe();
  bwrapWorks(env, [linked, join(root, ".git")]);
  rmSync(noted, { force: true });
  const refused = String(safety().GIT_SSH_COMMAND);
  assert.match(refused, /^printf .*bubblewrap on PATH \(.*\/bin\/bwrap\) is inside a worktree or the Git folder/, refused);
  assert.equal(existsSync(noted), false, "the planted bwrap started");
  // A link folder in the main worktree that leads to the real bwrap's folder counts too: a build can point it elsewhere.
  symlinkSync(dirname(real), join(root, "tools-link"));
  const linkEnv = { ...base, PATH: `${join(root, "tools-link")}:${base.PATH}` };
  resetBwrapProbe();
  bwrapWorks(linkEnv, [linked, join(root, ".git")]);
  const viaLink = String(gitSafety({ worktree: linked, env: linkEnv, network: true, git: gitProgram() }).env.GIT_SSH_COMMAND);
  assert.match(viaLink, /^printf .*bubblewrap on PATH \(.*tools-link\/bwrap\) is inside a worktree or the Git folder, or reached through one/, viaLink);
});

test("TOOLS-390 room: a plink command with a redirection keeps plink's kind, so git passes a custom port as plink takes it", { skip: noRoom }, t => {
  const { root, lead, noted, base } = roomRepo(t, "plink");
  // A plink stand-in that refuses ssh's -G, as plink does: git would then take the command for a simple ssh, which
  // cannot set a port.
  const plink = join(lead, "plink");
  writeFileSync(plink, `#!/bin/sh\n[ "$1" = -G ] && exit 1\necho "plink $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(plink, 0o755);
  // A ; inside quotes does not end the first word.
  const quoted = join(lead, "a;b");
  mkdirSync(quoted); copyFileSync(plink, join(quoted, "plink")); chmodSync(join(quoted, "plink"), 0o755);
  const cases: NodeJS.ProcessEnv[] = [`${plink} -batch 2>/dev/null`, `${plink} -batch "$@" | cat; :`, `X=1 ${plink} -batch 2>&1`, `'${quoted}/plink' -batch 2>/dev/null`, `${plink} -pw "$(printf dummy)" -batch`]
    .map(command => ({ GIT_SSH_COMMAND: command }));
  // The kind set to auto, in the variable or in ssh.variant, leaves it to git, which would tell it from bubblewrap.
  cases.push({ GIT_SSH_COMMAND: `${plink} -batch`, GIT_SSH_VARIANT: "auto" },
    { GIT_SSH_COMMAND: `${plink} -batch`, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ssh.variant", GIT_CONFIG_VALUE_0: "auto" });
  for (const settings of cases) {
    const label = JSON.stringify(settings);
    rmSync(noted, { force: true });
    const env = { ...base, ...settings };
    const safe = gitSafety({ worktree: root, env, network: true, git: gitProgram() });
    assert.equal(safe.env.GIT_SSH_VARIANT, "plink", label);
    spawnSync(gitProgram(), ["-C", root, "ls-remote", "ssh://host.invalid:2222/x"], { env: { ...env, ...safe.env }, encoding: "utf8", timeout: 30_000 });
    assert.match(existsSync(noted) ? readFileSync(noted, "utf8") : "", /^plink .*-P 2222 .*host\.invalid/m, label);
  }
});

test("TOOLS-390 room: git's ssh command starts bubblewrap by its full path with the room's folders, and keeps git's ssh kind", { skip: noRoom }, t => {
  const { dir, root, home, lead, base, fetch } = roomRepo(t, "shape");
  const safety = (env: NodeJS.ProcessEnv) => gitSafety({ worktree: root, env, network: true, git: gitProgram() }).env;
  const command = String(safety(base).GIT_SSH_COMMAND);
  assert.match(command, /^\/\S*bwrap --die-with-parent --dev-bind \/ \/ /);
  for (const part of ["--unshare-pid", "--proc /proc", "--chdir /", `--tmpfs ${root}`]) assert.ok(command.includes(` ${part} `), `${part} in ${command}`);
  assert.ok(command.includes(` -- /bin/sh -c 'ssh "$@"\nstatus=$?\n`) && command.endsWith(`\nexit "$status"' sh`), command);
  // git tells the kind of ssh from the command's first word, which is bubblewrap now: the kit tells it from the lead's.
  assert.equal(safety(base).GIT_SSH_VARIANT, "ssh");
  assert.equal(safety({ ...base, GIT_SSH_COMMAND: "X=1 /usr/bin/ssh -v" }).GIT_SSH_VARIANT, "ssh");
  assert.equal(safety({ ...base, GIT_SSH_COMMAND: "plink -batch" }).GIT_SSH_VARIANT, "plink");
  assert.equal(safety({ ...base, GIT_SSH: "/x/TortoisePlink.exe" }).GIT_SSH_VARIANT, "tortoiseplink");
  assert.equal(safety({ ...base, GIT_SSH_COMMAND: join(dir, "wrapper") }).GIT_SSH_VARIANT, undefined, "a wrapper's kind git finds out itself");
  assert.equal(safety({ ...base, GIT_SSH_VARIANT: "simple" }).GIT_SSH_VARIANT, undefined, "the lead's own kind stays");
  assert.equal(safety({ ...base, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ssh.variant", GIT_CONFIG_VALUE_0: "simple" }).GIT_SSH_VARIANT, undefined);
  assert.equal(safety({ ...base, GIT_SSH_VARIANT: "auto" }).GIT_SSH_VARIANT, "ssh", "auto leaves the kind to be told");
  // The variable comes before ssh.variant, as git reads them.
  assert.equal(safety({ ...base, GIT_SSH_VARIANT: "simple", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "ssh.variant", GIT_CONFIG_VALUE_0: "auto" }).GIT_SSH_VARIANT, undefined);
  // A call without the network starts no ssh: nothing changes.
  assert.equal(gitSafety({ worktree: root, env: base }).env.GIT_SSH_COMMAND, undefined);
  // A worktree that holds the home folder would hide ssh's keys too: git's ssh says so and fails.
  assert.equal(spawnSync("git", ["-C", home, "init", "-q", "-b", "test"]).status, 0);
  const atHome = fetch(base, home);
  assert.notEqual(atHome.run.status, 0);
  assert.match(atHome.run.stderr, /^kit: the clean room for git's ssh would hide your home folder/m);
  assert.equal(atHome.ran, "");
  // So would an agent socket inside the worktree.
  writeFileSync(join(root, "agent.sock"), "");
  const atAgent = fetch({ ...base, SSH_AUTH_SOCK: join(root, "agent.sock") });
  assert.notEqual(atAgent.run.status, 0);
  assert.match(atAgent.run.stderr, /^kit: the clean room for git's ssh would hide ssh's agent/m);
  assert.equal(atAgent.ran, "");
  // A bubblewrap that runs, but not with the room's own process list and /proc (a container that blocks them): git's
  // ssh says so and fails.
  const fakeBin = join(dir, "fake-bwrap");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "bwrap"), `#!/bin/sh\ncase "$*" in *--unshare-pid*) echo "bwrap: Can't mount proc on /newroot/proc: Operation not permitted" >&2; exit 1 ;; *" -e "*) echo inside; echo done ;; esac\nexit 0\n`);
  chmodSync(join(fakeBin, "bwrap"), 0o755);
  resetBwrapProbe();
  try {
    const blocked = fetch({ ...base, PATH: `${fakeBin}:${base.PATH}` });
    assert.match(blocked.run.stderr, /^kit: the clean room for git's ssh cannot start: bubblewrap cannot start it here \(bwrap: Can't mount proc on \/newroot\/proc: Operation not permitted\)/m);
    assert.equal(blocked.ran, "");
  } finally { resetBwrapProbe(); }
  // On Linux without bubblewrap git's ssh says how to install it and fails; elsewhere the path filter guards it as before.
  const noBwrapBin = pathWithoutBwrap(dir);
  const withoutBwrap = { ...base, PATH: `${lead}:${noBwrapBin}` };
  resetBwrapProbe();
  try {
    const linux = asPlatform("linux", () => fetch(withoutBwrap));
    assert.match(linux.run.stderr, /^kit: .*bubblewrap \(bwrap\) is not installed; install it \(apt install bubblewrap\)/m);
    assert.equal(linux.ran, "");
    resetBwrapProbe();
    const mac = asPlatform("darwin", () => fetch(withoutBwrap));
    assert.equal(mac.safe.env.GIT_SSH_COMMAND, join(lead, "ssh"));
    assert.match(mac.ran, new RegExp(`^lead's ssh in ${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: `));
  } finally { resetBwrapProbe(); }
  // With the lock off the kit leaves git's ssh to the path filter too.
  assert.doesNotMatch(String(safety({ ...base, ASE_KEY_GUARD: "off" }).GIT_SSH_COMMAND), /bwrap/);
});

test("TOOLS-390 room: kit doctor's keyed-steps note says whether git's ssh runs in the clean room on this machine", t => {
  const empty = mkdtempSync(join(tmpdir(), "kit-room-report-"));
  t.after(() => { rmSync(empty, { recursive: true, force: true }); resetBwrapProbe(); });
  const fresh = <T>(body: () => T) => { resetBwrapProbe(); try { return body(); } finally { resetBwrapProbe(); } };
  assert.deepEqual(cleanRoomReport({ ASE_KEY_GUARD: "off" }), { state: "off", text: "off (ASE_KEY_GUARD=off)" });
  const elsewhere = { state: "missing", text: "not on this machine (no bubblewrap): git's ssh is checked by its path, as before" };
  for (const platform of ["darwin", "win32"] as const) assert.deepEqual(fresh(() => asPlatform(platform, () => cleanRoomReport({ PATH: empty }))), elsewhere);
  assert.deepEqual(fresh(() => asPlatform("linux", () => cleanRoomReport({ PATH: empty }))),
    { state: "problem", text: "clean room cannot start: bubblewrap (bwrap) is not installed; install it (apt install bubblewrap)" });
  if (!noRoom) assert.deepEqual(fresh(() => cleanRoomReport({ PATH: process.env.PATH, HOME: empty })),
    { state: "on", text: "clean room on (git's ssh starts where the worktrees and the Git folder are empty)" });
  // A home folder or an agent socket inside the repository: a fetch or push would stop (sshRoom), so the note does not
  // say "on" (GPT second look, round 1).
  if (!noRoom) {
    const worktree = realpathSync(empty), inRepo = join(worktree, "home");
    mkdirSync(inRepo, { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "kit-room-report-home-"));
    t.after(() => rmSync(outside, { recursive: true, force: true }));
    for (const [env, what] of [[{ HOME: inRepo }, "your home folder, and ssh's keys with it"], [{ HOME: outside, SSH_AUTH_SOCK: join(inRepo, "agent.sock") }, "ssh's agent"]] as const) {
      const report = fresh(() => cleanRoomReport({ PATH: process.env.PATH, ...env }, { worktree }));
      assert.equal(report.state, "problem", what);
      assert.match(report.text, new RegExp(`^clean room would hide ${what.replace(/[(),]/g, "\\$&")} \\(\\S+\\), which is inside the worktree or the Git folder \\(${worktree}\\)`), what);
    }
  }
});

test("TOOLS-390 room: bubblewrap's start-up checks start the kit's own Node by its full path, never a true that PATH leads into the worktree", { skip: noRoom }, t => {
  const { dir, root, noted, base, planted } = roomRepo(t, "probe");
  t.after(() => resetBwrapProbe());
  // An outside PATH folder whose true is a link to a program a build left in the worktree.
  const links = join(dir, "true-links");
  mkdirSync(links);
  planted(join(root, "true"));
  symlinkSync(join(root, "true"), join(links, "true"));
  const env = { ...base, PATH: `${links}:${base.PATH}` } as NodeJS.ProcessEnv;
  resetBwrapProbe();
  const safe = gitSafety({ worktree: root, env, network: true, git: gitProgram() });
  resetBwrapProbe();
  const report = cleanRoomReport(env, { worktree: root });
  const ran = existsSync(noted) ? readFileSync(noted, "utf8") : "";
  assert.doesNotMatch(ran, /planted/, "the planted true never started");
  assert.match(String(safe.env.GIT_SSH_COMMAND), /^\/\S*bwrap /);
  assert.equal(report.state, "on");
});

test("TOOLS-390 room: inside kit pr's lock for its checks git's ssh keeps the path filter, since one sandbox cannot start inside another here", { skip: noBwrap }, t => {
  const { dir, home } = keyHome(t);
  const worktree = join(dir, "work"), runtime = join(dir, "runtime");
  mkdirSync(worktree); mkdirSync(runtime, { mode: 0o700 });
  assert.equal(spawnSync("git", ["-C", worktree, "init", "-q", "-b", "test"]).status, 0);
  const env = { ...homeEnv(home), XDG_RUNTIME_DIR: runtime, GIT_SSH_COMMAND: undefined } as NodeJS.ProcessEnv;
  const lock = checkLock({ worktree, env });
  t.after(() => lock.close?.());
  const probe = `import(${JSON.stringify(resolve("git-safety.mjs"))}).then(m => console.log(m.gitSafety({ worktree: ${JSON.stringify(worktree)}, network: true }).env.GIT_SSH_COMMAND ?? ""))`;
  const [command, args] = lock.wrap(process.execPath, ["-e", probe]);
  const run = spawnSync(command, args, { env: { ...env, ...Object.fromEntries(Object.entries(lock.env).filter(([, value]) => value !== undefined)) }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /bwrap/);
});

test("TOOLS-326: a percent-coded host is read as the bytes git passes on, decoded as UTF-8", () => {
  assert.equal(remoteHost("ssh://caf%C3%A9.example/a"), "café.example");
  assert.equal(remoteHost("ssh://git@CAF%C3%89.example:22/a"), "café.example");
  assert.equal(remoteHost("ssh://%6cocalhost/caf%e9.git"), "localhost");
  assert.equal(remoteHost("ssh://caf%e9.example/a"), "caf\ufffd.example", "a byte that is not UTF-8 stays one character");
});

test("TOOLS-326: an ssh wrapper whose #!/usr/bin/env -S line sets PATH never starts, and neither does a GIT_SSH_COMMAND that sets PATH after another variable", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-git-ssh-path-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home"), bin = join(dir, "bin"), links = join(dir, "links"), wrappers = join(dir, "wrappers"), noted = join(dir, "noted.txt");
  for (const folder of [root, home, bin, links, wrappers]) mkdirSync(folder);
  assert.equal(spawnSync("git", ["-C", root, "init", "-q", "-b", "test"], { encoding: "utf8", env: { ...process.env, HOME: home } }).status, 0);
  const fakeSsh = (file: string, who: string) => { writeFileSync(file, `#!/bin/sh\necho "${who} $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(file, 0o755); };
  fakeSsh(join(bin, "ssh"), "lead's ssh");
  mkdirSync(join(root, "tools")); fakeSsh(join(root, "tools/ssh"), "planted ssh");
  // A link a person made into the worktree, in a folder that is not on the run's PATH but that the wrapper puts first.
  symlinkSync(join(root, "tools/ssh"), join(links, "ssh"));
  const shell = ["/usr/bin/sh", "/bin/sh"].find(file => existsSync(file))!;
  const wrapper = (name: string, assignments: string) => {
    const file = join(wrappers, name);
    writeFileSync(file, `#!/usr/bin/env -S ${assignments} sh\nexec ssh "$@"\n`); chmodSync(file, 0o755);
    return file;
  };
  const first = wrapper("ssh-path", `PATH=${links}:${bin}:${dirname(shell)}`);
  const second = wrapper("ssh-x-path", `X=1 PATH=${links}:${bin}:${dirname(shell)}`);
  // env sets a word with = in it whatever its name, so an odd name first hides no PATH after it.
  const oddName = wrapper("ssh-odd-path", `1X=1 PATH=${links}:${bin}:${dirname(shell)}`);
  const emptyName = join(wrappers, "ssh-empty-name");
  writeFileSync(emptyName, `#!/usr/bin/env -S =x /usr/bin/env -S "X=1 'X''Y=1'" sh\nexec ssh "$@"\n`); chmodSync(emptyName, 0o755);
  const long = join(wrappers, "ssh-long-path");
  writeFileSync(long, `#!/usr/bin/env --split-string=PATH=${links}:${bin}:${dirname(shell)} sh\nexec ssh "$@"\n`); chmodSync(long, 0o755);
  // A wrapper whose interpreter is such a script: the line one level down is read too.
  const nested = join(wrappers, "ssh-nested");
  writeFileSync(nested, `#!${first}\nexec ssh "$@"\n`); chmodSync(nested, 0o755);
  const viaEnv = join(wrappers, "ssh-via-env");
  writeFileSync(viaEnv, `#!/usr/bin/env ${first}\nexec ssh "$@"\n`); chmodSync(viaEnv, 0o755);
  const base = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined, GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, GIT_CONFIG_COUNT: undefined } as NodeJS.ProcessEnv;
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  const refusedWith = (env: NodeJS.ProcessEnv) => {
    rmSync(noted, { force: true });
    // The path filter, where the clean room does not exist (a system without bubblewrap, TOOLS-390).
    const safe = asPlatform("darwin", () => gitSafety({ worktree: root, env, network: true, git: realGit }));
    assert.equal(safe.problem, null);
    const run = spawnSync(realGit, ["-C", root, "ls-remote", "ssh://example.invalid/repo.git"], { env: { ...env, ...safe.env }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.ok(!existsSync(noted), `an ssh started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
    return run.stderr;
  };
  // env as the program would read the PATH after it itself, by name or by its full path.
  for (const file of [wrapper("ssh-env-env-path", `env PATH=${links}:${bin}:${dirname(shell)}`), wrapper("ssh-full-env-path", `/usr/bin/env PATH=${links}:${bin}:${dirname(shell)}`)]) {
    assert.throws(() => startCommand(file, [], base, { worktree: root, kind: "test" }), /, which sets PATH itself/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env -S .*env PATH=\S+ sh, which sets PATH itself/m, file);
    assert.match(refusedWith({ ...base, GIT_SSH: file }), /^kit: \S+ starts with env -S .*env PATH=\S+ sh, which sets PATH itself/m, file);
  }
  // A PATH= after the program counts too, for an env it starts in turn under another name (a link to env, busybox env);
  // an env again with no PATH would look its program up by name.
  symlinkSync("/usr/bin/env", join(bin, "e"));
  for (const file of [wrapper("ssh-linked-env-path", `${join(bin, "e")} PATH=${links}:${bin}:${dirname(shell)}`), wrapper("ssh-later-path", `${shell} -c true PATH=${links}`)]) {
    assert.throws(() => startCommand(file, [], base, { worktree: root, kind: "test" }), /, which sets PATH itself/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /, which sets PATH itself/m, file);
  }
  // A link to env by another name is env again, which would look its program up by name (a PATH its own -S string sets
  // with split quotes is refused as a PATH, TOOLS-329).
  const renamed = join(wrappers, "ssh-renamed-env");
  writeFileSync(renamed, `#!/usr/bin/env -S ${join(bin, "e")} -S "X=1 'X''Y=1'" sh\nexec ssh "$@"\n`); chmodSync(renamed, 0o755);
  for (const file of [wrapper("ssh-env-env", "env"), renamed, emptyName]) {
    assert.throws(() => startCommand(file, [], base, { worktree: root, kind: "test" }), /, which starts env again, and that env would look its program up by name/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env -S .*, which starts env again/m, file);
    assert.match(refusedWith({ ...base, GIT_SSH: file }), /^kit: \S+ starts with env -S .*, which starts env again/m, file);
  }
  // An option among the -S words is env's, never a setting the PATH check passes over.
  const optionInside = wrapper("ssh-option-path", `--split-string=PATH=${links}:${bin}:${dirname(shell)}`);
  assert.throws(() => startCommand(optionInside, [], base, { worktree: root, kind: "test" }), /starts with env -S --split-string=PATH=\S+ sh, so which program it runs cannot be told/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: optionInside }), /^kit: \S+ starts with env -S --split-string=PATH=\S+ sh, so which program it runs cannot be told/m);
  assert.match(refusedWith({ ...base, GIT_SSH: optionInside }), /^kit: \S+ starts with env -S --split-string=PATH=\S+ sh, so which program it runs cannot be told/m);
  for (const file of [first, second, oddName, long, nested, viaEnv]) {
    assert.throws(() => startCommand(file, [], base, { worktree: root, kind: "test" }), /starts with env (-S|--split-string=).*PATH=.*, which sets PATH itself/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env \S+.*, which sets PATH itself/m, file);
    assert.match(refusedWith({ ...base, GIT_SSH: file }), /^kit: \S+ starts with env \S+.*, which sets PATH itself/m, file);
  }
  // In git's ssh command a PATH after another variable sets PATH as much as one first.
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: `X=1 PATH=${links} ssh` }), /^kit: git's ssh command \(.*\) cannot be told: it sets PATH itself/m);
  // Variables other than PATH stay with env, and the wrapper starts by its interpreter's full path.
  const other = wrapper("ssh-other", "X=1 PATHX=1 XPATH=2");
  assert.deepEqual(startCommand(other, [], base, { worktree: root, kind: "test" }), ["/usr/bin/env", ["X=1", "PATHX=1", "XPATH=2", shell, other]]);
});

// TOOLS-329: a shell reads the file BASH_ENV (bash) or ENV (sh) names before its script, so an env -S line or git's ssh
// command that sets one could run a file a build wrote; a PATH= hidden in another program's words (an env started by a
// multi-call binary, an -S option joined to its string) and an env under another name in git's ssh command are refused
// too (R1-1, R6-1..R6-4, SL-2).
test("TOOLS-329: env -S lines and git's ssh command that set BASH_ENV or ENV, hide PATH in another env, or reach env by another name never start", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-git-ssh-startup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), home = join(dir, "home"), bin = join(dir, "bin"), links = join(dir, "links"), wrappers = join(dir, "wrappers"), noted = join(dir, "noted.txt");
  for (const folder of [root, home, bin, links, wrappers]) mkdirSync(folder);
  assert.equal(spawnSync("git", ["-C", root, "init", "-q", "-b", "test"], { encoding: "utf8", env: { ...process.env, HOME: home } }).status, 0);
  const shell = ["/usr/bin/sh", "/bin/sh"].find(file => existsSync(file))!;
  const bash = ["/usr/bin/bash", "/bin/bash"].find(file => existsSync(file))!;
  // The lead's ssh is a bash script outside the worktree; a build left a start-up file and an ssh in the worktree.
  writeFileSync(join(bin, "ssh"), `#!${bash}\necho "lead's ssh $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(join(bin, "ssh"), 0o755);
  const startup = join(root, "startup.sh");
  writeFileSync(startup, `echo "planted start-up file" >> ${JSON.stringify(noted)}\n`);
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools/ssh"), `#!/bin/sh\necho "planted ssh $*" >> ${JSON.stringify(noted)}\nexit 1\n`); chmodSync(join(root, "tools/ssh"), 0o755);
  symlinkSync(join(root, "tools/ssh"), join(links, "ssh"));
  // A multi-call binary that runs its first word as the program (busybox env, coreutils env), and a link to env.
  for (const name of ["busybox", "coreutils"]) { writeFileSync(join(bin, name), `#!/bin/sh\nshift\nexec /usr/bin/env "$@"\n`); chmodSync(join(bin, name), 0o755); }
  symlinkSync("/usr/bin/env", join(bin, "e"));
  const wrapper = (name: string, words: string, program = "sh") => {
    const file = join(wrappers, name);
    writeFileSync(file, `#!/usr/bin/env -S ${words} ${program}\nexec ssh "$@"\n`); chmodSync(file, 0o755);
    return file;
  };
  const base = { ...process.env, HOME: home, PATH: `${bin}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: undefined, GIT_CONFIG_NOSYSTEM: undefined, GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, GIT_CONFIG_COUNT: undefined, BASH_ENV: undefined, ENV: undefined } as NodeJS.ProcessEnv;
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  const refusedWith = (env: NodeJS.ProcessEnv) => {
    rmSync(noted, { force: true });
    // The path filter, where the clean room does not exist (a system without bubblewrap, TOOLS-390).
    const safe = asPlatform("darwin", () => gitSafety({ worktree: root, env, network: true, git: realGit }));
    assert.equal(safe.problem, null);
    const run = spawnSync(realGit, ["-C", root, "ls-remote", "ssh://example.invalid/repo.git"], { env: { ...env, ...safe.env }, encoding: "utf8" });
    assert.notEqual(run.status, 0);
    assert.ok(!existsSync(noted), `an ssh or the start-up file ran: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
    return run.stderr;
  };
  const start = (file: string) => startCommand(file, [], base, { worktree: root, kind: "test" });
  // BASH_ENV or ENV in an env -S line, before the program, after it, or in an -S string another env splits.
  for (const [name, file] of [
    ["BASH_ENV", wrapper("bash-env", `BASH_ENV=${startup}`, "bash")],
    ["ENV", wrapper("env-env", `ENV=${startup}`)],
    ["BASH_ENV", wrapper("bash-env-after", `${bash} -c true BASH_ENV=${startup}`, "")],
    ["BASH_ENV", wrapper("bash-env-joined", `coreutils env -SBASH_ENV=${startup}`, "bash")],
    ["BASH_ENV", wrapper("bash-env-bundled", `coreutils env -iSBASH_ENV=${startup}`, "bash")],
    // A function bash takes from its environment, and a trace prompt it expands, run code from elsewhere just as well.
    ["BASH_FUNC_ssh%%", wrapper("bash-func", `'BASH_FUNC_ssh%%=() { . ${startup}; }'`, "bash")],
    ["SHELLOPTS", wrapper("bash-trace", `SHELLOPTS=xtrace 'PS4=$(. ${startup})'`, "bash")],
    ["PS4", wrapper("bash-ps4", `'PS4=$(. ${startup})'`, "bash")],
    ["BASHOPTS", wrapper("bash-opts", "BASHOPTS=extdebug", "bash")],
    ["ZDOTDIR", wrapper("zsh-dotdir", `ZDOTDIR=${root}`)],
  ] as const) {
    assert.throws(() => start(file), new RegExp(`, which sets ${name} itself`), file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), new RegExp(`^kit: \\S+ starts with env -S .*, which sets ${name} itself`, "m"), file);
    assert.match(refusedWith({ ...base, GIT_SSH: file }), new RegExp(`^kit: \\S+ starts with env -S .*, which sets ${name} itself`, "m"), file);
  }
  // In git's ssh command, before the program or after it (an env it starts in turn).
  for (const command of [`BASH_ENV=${startup} ssh`, `X=1 ENV=${startup} ssh`, `timeout 30 env BASH_ENV=${startup} ssh`, `timeout 30 sh -c "BASH_ENV=${startup} ssh"`]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: it sets (BASH_ENV|ENV) itself/m, command);
  }
  // The other shell variables, written straight into git's ssh command (the lead's ssh here is a bash script).
  for (const command of [`SHELLOPTS=xtrace 'PS4=$(. ${startup})' ssh`, `timeout 30 env 'BASH_FUNC_ssh%%=() { . ${startup}; }' ssh`]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: it sets (SHELLOPTS|BASH_FUNC_ssh%%) itself/m, command);
  }
  // A PATH= another env reads: joined to an -S option, inside one quoted -S string, or after a program that is not env.
  for (const file of [
    wrapper("coreutils-joined-path", `coreutils env -SPATH=${links}:${bin}:${dirname(shell)}`),
    wrapper("coreutils-quoted-path", `coreutils env -S "X=1 PATH=${links}:${bin}:${dirname(shell)}"`),
    wrapper("busybox-path", `busybox env PATH=${links}:${bin}:${dirname(shell)}`),
  ]) {
    assert.throws(() => start(file), /, which sets PATH itself/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /, which sets PATH itself/m, file);
  }
  // A multi-call binary told to run env, or a wrapper that starts env, is env again, which would look its program up by
  // name and could read a PATH from a quoted -S string of its own.
  for (const file of [wrapper("busybox-env", "busybox env"), wrapper("coreutils-env", "coreutils env"), wrapper("coreutils-prog-env", "coreutils --coreutils-prog=env"),
    wrapper("timeout-env", `timeout 30 env -S "'X''Y=1'"`), wrapper("timeout-renamed-env", `timeout 30 ${join(bin, "e")} -S "'X''Y=1'"`)]) {
    assert.throws(() => start(file), /, which starts env again, and that env would look its program up by name/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env -S .*, which starts env again/m, file);
  }
  // git's ssh command: a PATH= after the program, and env reached by a link of another name (R1-1, SL-2).
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: `timeout 30 env PATH=${links} ssh` }), /^kit: git's ssh command \(.*\) cannot be told: it sets PATH itself/m);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: `${join(bin, "e")} PATH=${links} ssh` }), /^kit: git's ssh command \(.*\) cannot be told/m);
  for (const command of [`${join(bin, "e")} ssh`, `timeout 30 ${join(bin, "e")} ssh`]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: env looks its program up on PATH/m, command);
  }
  // An env the kit cannot tell by its name (GNU env installed as gnuenv, a file of its own) joins a name split by quotes
  // in its -S string, so the words count with the quotes taken out too, and \_ breaks a word as a blank does.
  writeFileSync(join(bin, "gnuenv"), `#!/bin/sh\nexec /usr/bin/env "$@"\n`); chmodSync(join(bin, "gnuenv"), 0o755);
  const toLinks = `${links}:${bin}:/usr/bin:/bin`;
  for (const [name, command] of [["PATH", `gnuenv -S "'PA''TH=${toLinks}' ssh"`], ["BASH_ENV", `timeout 30 gnuenv -S 'BA""SH_ENV=${startup} ${bash} -c true'`],
    ["PATH", `gnuenv -S 'X=1\\_PATH=${toLinks} ssh'`]]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), new RegExp(`^kit: git's ssh command \\(.*\\) cannot be told: it sets ${name} itself`, "m"), command);
  }
  // That env fills in a ${…} in its -S string before it reads a NAME=, so the name or the = can come from a value.
  for (const command of [`gnuenv -S 'PA\${EMPTY}TH=${toLinks} ssh'`, `A=ATH gnuenv -S 'P\${A}=${toLinks} ssh'`, `A=PATH B== gnuenv -S '\${A}\${B}${toLinks} ssh'`]) {
    assert.match(refusedWith({ ...base, EMPTY: "", GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: an -S string in it holds \$\{…\}/m, command);
  }
  // GNU env takes --split-string by any unique start of it, and the -S string joined to its option (S-2); ssh's own -S
  // (a control path) with a ${…} in it is refused too.
  for (const command of [`A=PATH B== gnuenv --split '\${A}\${B}${toLinks} ssh'`, `A=PATH B== gnuenv --s='\${A}\${B}${toLinks} ssh'`, `A=PATH B== gnuenv --split-string='\${A}\${B}${toLinks} ssh'`,
    `A=PATH B== gnuenv --split-string '\${A}\${B}${toLinks} ssh'`, `A=PATH B== gnuenv -S'\${A}\${B}${toLinks} ssh'`, `A=PATH B== gnuenv -vS '\${A}\${B}${toLinks} ssh'`,
    "ssh -S '/tmp/c-${X}' host"]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: an -S string in it holds \$\{…\}/m, command);
  }
  // sh fills in a $ in a double-quoted or bare word before that env reads it (S-1), with EMPTY unset here.
  for (const command of [`gnuenv -S "PA\${EMPTY}TH=${toLinks} ssh"`, `gnuenv "PA\${EMPTY}TH=${toLinks}" ssh`, `timeout 30 gnuenv "\${X:-PATH}=${toLinks}" ssh`,
    `gnuenv -S "X=1 \${X:-PATH}=${toLinks} ssh"`, `gnuenv PA$EMPTY'TH'=${toLinks} ssh`]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: sh fills in a \$ in it, which an env there could read as PATH= or BASH_ENV=/m, command);
  }
  // A shell the line starts fills in a $ that the outer sh left alone (single quotes) before its env reads the name,
  // and runs a $(…) or `…` whose output can build one.
  for (const command of [`timeout 30 sh -c 'gnuenv PA\${EMPTY}TH=${toLinks} ssh'`, `timeout 30 sh -c 'env "PA\${EMPTY}TH=${toLinks}" ssh'`,
    `timeout 30 sh -c 'gnuenv $(printf PA)TH=${toLinks} ssh'`, `timeout 30 sh -c 'export "$(printf PA)TH=${toLinks}"; ssh "$@"' ssh`, `timeout 30 sh -c 'gnuenv \`true\`PA\${EMPTY}TH=${toLinks} ssh'`]) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: a \$ or ` in it could be filled in as PATH= or BASH_ENV=/m, command);
  }
  for (const command of ["ssh -i $HOME/.ssh/id_ed25519 -o User=$USER", "ssh -o IdentityFile=$HOME/.ssh/id_ed25519 host", "timeout 30 ssh -i ~/.ssh/id_ed25519",
    "ssh -o ProxyCommand=none -o ProxyJump=jump.example.invalid", "nice -n 5 ssh -o 'ProxyCommand none'", "ssh -o BatchMode=yes -o User=git host"]) {
    assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem, null, command);
  }
  // Lex's decision (2026-11-20): no shell starts from git's ssh command, since a shell can build PATH= out of pieces no
  // word holds ("$1$2", "${1}${2}", IFS= with "$*"): by name, behind a wrapper (timeout, nice, gnuenv, busybox), by a
  // path, from a variable sh fills in, and ssh's ProxyCommand or LocalCommand, which ssh runs through the user's shell.
  const shellLines = [`timeout 30 sh -c 'gnuenv "$1$2" ssh' sh PA TH=${toLinks}`, `timeout 30 sh -c 'gnuenv "\${1}\${2}" ssh' sh PA TH=${toLinks}`,
    `timeout 30 sh -c 'IFS=; gnuenv "$*" ssh' sh PA TH=${toLinks}`, `sh -c 'ssh "$@"' ssh`, `nice -n 5 bash -c 'ssh "$@"' ssh`, `timeout 30 dash -c 'ssh "$@"' ssh`,
    `gnuenv zsh -c 'ssh "$@"' ssh`, `timeout 30 ksh -c 'ssh "$@"' ssh`, `timeout 30 busybox sh -c 'ssh "$@"' ssh`, `timeout 30 ${shell} -c 'ssh "$@"' ssh`,
    `timeout 30 bash5 -c 'ssh "$@"' ssh`, `timeout 30 $SHELL -c 'ssh "$@"' ssh`, `timeout 30 \${EMPTY}sh -c 'ssh "$@"' ssh`];
  for (const command of shellLines) {
    assert.match(sshCommand({ ...base, SHELL: bash, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", /^git's ssh command \(.*\) cannot be told: it starts a shell \((sh|bash|bash5|dash|zsh|ksh)\)/, command);
  }
  for (const command of shellLines.slice(0, 3)) {
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: it starts a shell \(sh\)/m, command);
  }
  // sh reads where a name ends before it takes quotes and \ out, so with E empty "$E"sh, $E''sh and $E\sh are sh, and
  // with D=/bin/ "$D"sh is /bin/sh (round 7).
  for (const command of [`timeout 30 "$E"sh -c 'ssh "$@"' ssh`, `timeout 30 $E''sh -c 'ssh "$@"' ssh`, `timeout 30 $E\\sh -c 'ssh "$@"' ssh`,
    `timeout 30 "$D"sh -c 'ssh "$@"' ssh`, `timeout 30 "\${E}"sh -c 'ssh "$@"' ssh`]) {
    const env = { ...base, E: "", D: `${dirname(shell)}/`, GIT_SSH_COMMAND: command };
    assert.match(sshCommand(env, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(sh\)/, command);
  }
  assert.match(refusedWith({ ...base, E: "", GIT_SSH_COMMAND: `timeout 30 "$E"sh -c 'gnuenv "$1$2" ssh' sh PA TH=${toLinks}` }), /^kit: git's ssh command \(.*\) cannot be told: it starts a shell \(sh\)/m);
  // Shells by rarer names, a static build, and busybox's hush, told by the name alone (the stand-ins are no shells); a
  // copy of a shell under a name of its own is not recognised (the README says so).
  for (const name of ["lksh", "bash-static", "pwsh"]) { writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(bin, name), 0o755); }
  for (const command of [`timeout 30 lksh -c 'ssh "$@"' ssh`, `timeout 30 bash-static -c 'ssh "$@"' ssh`, `timeout 30 busybox hush -c 'ssh "$@"' ssh`]) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \((lksh|bash-static|hush)\)/, command);
  }
  // A link to a shell in a folder with a blank in its name, quoted whole, is still followed (GPT second look, round 3).
  mkdirSync(join(dir, "shell tools"));
  symlinkSync(bash, join(dir, "shell tools", "run"));
  const spaced = `timeout 30 '${join(dir, "shell tools", "run")}' -c 'ssh "$@"' ssh`;
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: spaced }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(run\)/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: spaced }), /^kit: git's ssh command \(.*\) cannot be told: it starts a shell \(run\)/m);
  const spacedLine = wrapper("timeout-spaced-link", `timeout 30 '${join(dir, "shell tools", "run")}' -c 'ssh "$@"'`, "");
  assert.throws(() => start(spacedLine), /, which starts a shell \(run\)/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: spacedLine }), /^kit: \S+ starts with env -S .*, which starts a shell/m);
  copyFileSync(shell, join(bin, "notashell")); chmodSync(join(bin, "notashell"), 0o755);
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 notashell -c 'ssh "$@"' ssh` }, { worktree: root }).problem, null);
  // ProxyCommand and LocalCommand, also in a bundle of ssh's flags (-4o, -vo, -qo) and with the option's name quoted.
  for (const command of ["ssh -o 'ProxyCommand=nc %h %p'", "ssh -oProxyCommand='nc %h %p'", "timeout 30 ssh -o 'proxycommand nc %h %p'", "ssh -o PermitLocalCommand=yes -o LocalCommand=true",
    "ssh -4oProxyCommand='nc %h %p' host", "ssh -vo 'LocalCommand=true' -o PermitLocalCommand=yes host", "ssh -qoLocalCommand=true host", `ssh -o '"ProxyCommand" nc %h %p' host`,
    `ssh -o 'Proxy"Command"=nc %h %p' host`]) {
    const problem = sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "";
    assert.match(problem, /cannot be told: it starts a shell \((ProxyCommand|LocalCommand), which ssh runs through the user's shell\)/, command);
    assert.match(problem, /drop ProxyCommand and LocalCommand, or use ProxyJump \(-J\) with plain host names instead/, command);
  }
  // ssh writes a ProxyJump's hosts into a command of its own that it runs through the user's shell, so anything beyond
  // user@host:port names in one is refused; PermitLocalCommand is no LocalCommand, and rc or es as a plain word (no
  // such program on PATH) or with a version (es2020) is no shell.
  // ssh fills % tokens into that command first (%k is the HostKeyAlias, %r the remote user), so a % counts too.
  for (const command of ["ssh -J 'a;b' host", "ssh -o 'ProxyJump=a|b' host", "ssh -4J 'a b' host", "ssh -J", "ssh -oProxyJump='a>b' host",
    "ssh -o HostKeyAlias='x;id' -J %k host", "ssh -J '%r@jump.example.invalid' host", "ssh -J -Fevil host", "ssh -J 'jump.example.invalid,-oX' host"]) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(ProxyJump with more than host names in it, which ssh runs through the user's shell\).*; give ProxyJump \(-J\) plain user@host:port names;/, command);
  }
  // ssh writes the -F path into that command as it is, and the host (%h, from HostName too) inside single quotes.
  for (const command of ["ssh -F '/dev/null;. ./x' -J jump.example.invalid host", `ssh -o "HostName=a';. ./x;'" -J jump.example.invalid host`,
    "ssh -J jump.example.invalid -F'cfg x' host", `ssh -J jump.example.invalid "a';. ./x;'"`, "ssh -4F'a b' -J jump.example.invalid host"]) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(ProxyJump beside a ' or an -F path with more than plain characters in it, which ssh writes into the command it runs through the user's shell\)/, command);
  }
  for (const command of ["ssh -J 'git@jump.example.invalid:2222,[::1]:22' host", "ssh -F ~/.ssh/config.d/work -J jump.example.invalid host", "ssh -4F/etc/ssh/alt -J jump.example.invalid host", "ssh -F '/dev/null;x' -o ProxyJump=none host", "ssh -4J jump.example.invalid host", "ssh -o ProxyJump=none host", "ssh -o PermitLocalCommand=no host",
    "ssh -o SetEnv=LANG=es -l rc host", "ssh -o 'SetEnv=TARGET=es2020' -l rc1 host"]) {
    // Only the test's own folder on PATH, so a system rc or es (Debian ships both) does not count here.
    assert.equal(sshCommand({ ...base, PATH: bin, GIT_SSH_COMMAND: command }, { worktree: root }).problem, null, command);
  }
  // sh splits and expands what an unquoted $NAME holds as a pattern after it fills it in, so a value with a pattern or
  // a blank (or one of IFS's characters) in it could name a shell too; quoted, it is taken as it is (GPT second look).
  const marker = join(dir, "pattern-shell.txt");
  for (const [command, env] of [[`timeout 30 $X -c 'echo ran > ${marker}'`, { X: `${dirname(shell)}/[s]h` }], [`timeout 30 \${X} -c 'echo ran > ${marker}'`, { X: `${dirname(shell)}/s?` }],
    [`timeout 30 $X -c 'echo ran > ${marker}'`, { X: `x ${shell}` }], [`timeout 30 $X -c 'echo ran > ${marker}'`, { X: `xQ${shell}`, IFS: "Q" }]] as const) {
    const result = sshCommand({ ...base, ...env, GIT_SSH_COMMAND: command }, { worktree: root });
    assert.match(result.problem ?? "", /cannot be told: sh splits or expands what a \$ fills in, which could name a shell/, command);
    spawnSync("/bin/sh", ["-c", result.command!], { env: { ...base, ...env }, encoding: "utf8" });
    assert.ok(!existsSync(marker), command);
  }
  assert.equal(sshCommand({ ...base, X: "/tmp/[s]h key", GIT_SSH_COMMAND: `ssh -i "$X" host` }, { worktree: root }).problem, null);
  // Only a ~ alone or before a / is HOME: ~user is that user's home, wherever HOME points (GPT second look, round 9).
  const account = userInfo();
  symlinkSync(bash, join(dir, "tilde-shell"));
  const viaAccount = `timeout 30 ~${account.username}/${relative(account.homedir, join(dir, "tilde-shell"))} -c 'echo ran > ${marker}'`;
  for (const command of [viaAccount, `timeout 30 ~+/x -c 'echo ran > ${marker}'`, `timeout 30 ~-/x -c 'echo ran > ${marker}'`, `timeout 30 ~"/x" -c 'echo ran > ${marker}'`]) {
    const result = sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root });
    assert.match(result.problem ?? "", /cannot be told: sh fills in a ~ in it from somewhere other than HOME, which could name a shell/, command);
    spawnSync("/bin/sh", ["-c", result.command!], { env: base, encoding: "utf8" });
    assert.ok(!existsSync(marker), command);
  }
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: viaAccount }), /^kit: git's ssh command \(.*\) cannot be told: sh fills in a ~ in it from somewhere other than HOME/m);
  // ssh keeps quotes and \ in an option's value, so only a plain none turns ProxyCommand, LocalCommand or ProxyJump off.
  for (const [command, why] of [[`ssh -o 'ProxyCommand="none"' host`, /it starts a shell \(ProxyCommand/], [`ssh -o 'ProxyCommand=n\\one' host`, /it starts a shell \(ProxyCommand/],
    [`ssh -o PermitLocalCommand=yes -o 'LocalCommand "none"' host`, /it starts a shell \(LocalCommand/], [`ssh -o 'ProxyCommand=\\ none' host`, /it starts a shell \(ProxyCommand/],
    [`ssh -o PermitLocalCommand=yes -o 'LocalCommand=\\ none' host`, /it starts a shell \(LocalCommand/], [`ssh -o 'ProxyJump="none"' -F 'a b' host`, /it starts a shell \(ProxyJump beside a '/]] as const) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", why, command);
  }
  for (const command of ["ssh -o ProxyCommand=none host", "ssh -o 'LocalCommand none' host", "ssh -o ProxyJump=none -F 'a b' host", "ssh -o 'ProxyCommand = none' host"]) {
    assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem, null, command);
  }
  // An env -S string (gnuenv) joins quoted pieces, so ba's'h in one is bash, in git's ssh command and in an env -S first
  // line (GPT second look, round 10).
  const joinedName = sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 gnuenv -S "ba's'h -c 'echo ran > ${marker}'"` }, { worktree: root });
  assert.match(joinedName.problem ?? "", /cannot be told: it starts a shell \(bash\)/);
  spawnSync("/bin/sh", ["-c", joinedName.command!], { env: base, encoding: "utf8" });
  assert.ok(!existsSync(marker));
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: `timeout 30 gnuenv -S "ba's'h -c 'ssh'"` }), /^kit: git's ssh command \(.*\) cannot be told: it starts a shell \(bash\)/m);
  const joinedLine = wrapper("gnuenv-joined-shell", `timeout 30 gnuenv -S "ba's'h -c 'ssh'"`, "");
  assert.throws(() => start(joinedLine), /, which starts a shell \(bash\)/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: joinedLine }), /^kit: \S+ starts with env -S .*, which starts a shell/m);
  // env -S's \_ splits where it stands, so \_bash in an -S string is bash (GPT second look, round 11).
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 gnuenv -S '\\_bash -c "echo ran"'` }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(bash\)/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: `timeout 30 gnuenv -S '\\_bash -c ssh'` }), /^kit: git's ssh command \(.*\) cannot be told: it starts a shell \(bash\)/m);
  const escapedLine = wrapper("gnuenv-escaped-shell", `timeout 30 gnuenv -S '\\_bash -c ssh'`, "");
  assert.throws(() => start(escapedLine), /, which starts a shell \(bash\)/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: escapedLine }), /^kit: \S+ starts with env -S .*, which starts a shell/m);
  // env -S stops at \c, so sh\c in an -S string is sh (GPT second look, round 14).
  const stopped = sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 gnuenv -S 'sh\\c' -c 'echo ran > ${marker}'` }, { worktree: root });
  assert.match(stopped.problem ?? "", /cannot be told: it starts a shell \(sh\)/);
  spawnSync("/bin/sh", ["-c", stopped.command!], { env: base, encoding: "utf8" });
  assert.ok(!existsSync(marker));
  assert.throws(() => start(wrapper("gnuenv-stopped-shell", `timeout 30 gnuenv -S 'sh\\c' -c ssh`, "")), /, which starts a shell \(sh\)/);
  // git runs its ssh command in the worktree, so a relative path counts from there too, not only from the kit's own
  // folder (GPT second look, round 14).
  symlinkSync(bash, join(root, "runner"));
  assert.notEqual(process.cwd(), root);
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 ./runner -c 'echo ran > ${marker}'` }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(runner\)/);
  assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: "timeout 30 ./runner -c 'ssh \"$@\"' ssh" }), /^kit: git's ssh command \(.*\) cannot be told: it starts a shell \(runner\)/m);
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: "./tools/ssh" }, { worktree: root }).problem ?? "", /git's ssh \(\.\/tools\/ssh\) is inside the worktree or its Git folder/);
  assert.match(sshCommand({ ...base, GIT_SSH: "./runner" }, { worktree: root }).problem ?? "", /git's ssh \(\.\/runner\) is inside the worktree or its Git folder/);
  // A link in the worktree counts as inside, wherever it points, since a build can point it elsewhere after the check;
  // and so does a relative first line, which the kernel takes from the worktree (Claude review, round 14).
  symlinkSync(join(bin, "ssh"), join(root, "outside-ssh"));
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: join(root, "outside-ssh") }, { worktree: root }).problem ?? "", /is inside the worktree or its Git folder/);
  const relativeLine = join(wrappers, "relative-line");
  writeFileSync(relativeLine, "#!tools/ssh\n"); chmodSync(relativeLine, 0o755);
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: relativeLine }, { worktree: root }).problem ?? "", /starts with tools\/ssh, inside the worktree or its Git folder/);
  // The same for the program an env -S line names by path (Claude review, round 15).
  for (const [name, program] of [["env-relative", "tools/ssh"], ["env-outside-link", join(root, "outside-ssh")]]) {
    const line = join(wrappers, name);
    writeFileSync(line, `#!/usr/bin/env -S ${program}\n`); chmodSync(line, 0o755);
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: line }, { worktree: root }).problem ?? "", /starts with env \S+, inside the worktree or its Git folder/, name);
  }
  // env -S's split counts for ssh's -J and -F as well: a -J inside the string beside an -F outside it and the other way
  // round (GPT second look, round 16), a quoted blank in an -F path, and a flag last in the string, which takes the
  // line's next word as its value (GPT second look, round 17; Claude review, round 16). A plain jump host still runs,
  // also from the next word. A ProxyCommand\_none in an -S string is refused too: only a plain none is none.
  for (const command of [`timeout 30 gnuenv -S 'ssh -J jump.example.invalid' -F './cfg;printf PROBE;' host`, `timeout 30 gnuenv -S 'ssh -F ./cfg;x' -J jump.example.invalid host`,
    `timeout 30 gnuenv -S 'ssh -J jump.example.invalid -F"cfg ;printf PROBE;"' host`, `timeout 30 gnuenv -S 'ssh -J jump.example.invalid -F' './cfg;x' host`,
    `timeout 30 gnuenv -S 'ssh -J' jump.example.invalid -F './cfg;x' host`]) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", /it starts a shell \(ProxyJump beside a ' or an -F path/, command);
    assert.throws(() => start(wrapper(`gnuenv-jump-${command.length}`, command.replace(/ host$/, ""), "")), /, which starts a shell \(ProxyJump beside/, command);
  }
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: "timeout 30 gnuenv -S 'ssh -J jump.example.invalid' host" }, { worktree: root }).problem, null);
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: "timeout 30 gnuenv -S 'ssh -J' jump.example.invalid host" }, { worktree: root }).problem, null);
  // An -S string inside an -S string splits again: -J%k there takes the host key alias, ;x and all (GPT second look, round 18).
  const nested = `timeout 30 gnuenv -S 'gnuenv -S "ssh -J%k" -oHostKeyAlias=a;x' host`;
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: nested }, { worktree: root }).problem ?? "", /ProxyJump with more than host names/);
  assert.throws(() => start(wrapper("gnuenv-nested", nested.replace(/ host$/, ""), "")), /, which starts a shell \(ProxyJump with more than host names/);
  // A -J that ends an -S string takes the line's next word, which the host-name check reads (Claude review, round 17).
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: "timeout 30 gnuenv -S 'ssh -J' 'a;x' host" }, { worktree: root }).problem ?? "", /ProxyJump with more than host names/);
  // ssh still takes -1 and -2 in a bundle of flags (GPT second look, round 19).
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: "ssh -2J %k -oHostKeyAlias='a|x' host" }, { worktree: root }).problem ?? "", /ProxyJump with more than host names/);
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: "ssh -J jump.example.invalid -12F './cfg;x' host" }, { worktree: root }).problem ?? "", /ProxyJump beside a ' or an -F path/);
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: "ssh -2J jump.example.invalid host" }, { worktree: root }).problem, null);
  // sh sets $BASH, $_ and the like itself, whatever the run holds, and bash sets $SHELL where the run has none (round 19).
  for (const [name, env] of [["BASH", { BASH: undefined }], ["_", { _: "/usr/bin/true" }], ["PWD", {}], ["SHELL", { SHELL: undefined }]] as const) {
    for (const command of [`timeout 2 "\${${name}}" -c 'ssh "$@"' ssh`, `timeout 2 "$${name}" -c 'ssh "$@"' ssh`]) {
      assert.match(sshCommand({ ...base, ...env, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", new RegExp(`sh sets \\$${name} itself`), command);
    }
  }
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: "timeout 30 gnuenv -S 'ssh -o ProxyCommand\\_none' host" }, { worktree: root }).problem ?? "", /ProxyCommand, which ssh runs/);
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: "timeout 30 gnuenv -S 'ssh -o ProxyCommand=none' host" }, { worktree: root }).problem, null);
  // env -S's \_ is a blank inside ssh's options too: ProxyCommand\_nc is ProxyCommand nc (GPT second look, round 15).
  for (const [words, why] of [[`ssh -o "ProxyCommand\\_printf\\_PROBE" example.invalid`, /ProxyCommand, which ssh runs/],
    [`ssh -o PermitLocalCommand=yes -o "LocalCommand\\_true" example.invalid`, /LocalCommand, which ssh runs/],
    [`ssh -o "ProxyJump\\_a;b" example.invalid`, /ProxyJump with more than host names/]] as const) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 gnuenv -S '${words}'` }, { worktree: root }).problem ?? "", why, words);
    assert.throws(() => start(wrapper(`gnuenv-escaped-${words.length}`, `timeout 30 gnuenv -S '${words}'`, "")), /, which starts a shell/, words);
  }
  // A bash run as sh expands braces, so ba{s..s}h is bash; a ${…} is no brace pattern (GPT second look, round 11).
  assert.equal(spawnSync(bash, ["--posix", "-c", "echo ba{s..s}h"], { encoding: "utf8" }).stdout.trim(), "bash");
  for (const command of [`timeout 30 ba{s..s}h -c 'echo ran > ${marker}'`, `timeout 30 {bash,x} -c 'echo ran > ${marker}'`, `timeout 30 \\\${a,b} -c true`]) {
    const result = sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root });
    assert.match(result.problem ?? "", /cannot be told: sh expands a pattern in it, which could name a shell/, command);
    spawnSync(bash, ["--posix", "-c", result.command!], { env: base, encoding: "utf8" });
    assert.ok(!existsSync(marker), command);
  }
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: "ssh -i ${HOME}/.ssh/id_ed25519 host" }, { worktree: root }).problem, null);
  // GIT_SSH set to a link to a shell under another name is a shell too.
  assert.match(sshCommand({ ...base, GIT_SSH: join(dir, "shell tools", "run") }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(run\)/);
  // rc counts as a shell, and so do fish's ways of running a string (-C, --command, --init-command); stand-ins in a
  // folder of their own, so the plain rc words above stay plain.
  const otherShells = join(dir, "other shells");
  mkdirSync(otherShells);
  for (const name of ["rc", "fish", "ysh", "nu", "zsh", "tcsh"]) { writeFileSync(join(otherShells, name), "#!/bin/sh\nexit 0\n"); chmodSync(join(otherShells, name), 0o755); }
  const withOthers = { ...base, PATH: `${otherShells}:${bin}:/usr/bin:/bin` };
  for (const name of ["rc", "ysh", "nu"]) {
    assert.match(sshCommand({ ...withOthers, GIT_SSH_COMMAND: `timeout 30 ${name} -c true` }, { worktree: root }).problem ?? "", new RegExp(`cannot be told: it starts a shell \\(${name}\\)`));
  }
  // nu, like rc, counts only where PATH leads to it.
  assert.equal(sshCommand({ ...base, PATH: bin, GIT_SSH_COMMAND: "ssh -l nu -o SetEnv=LANG=nu host" }, { worktree: root }).problem, null);
  for (const [name, words] of [["fish-C", "fish -C 'ssh'"], ["fish-command", "fish --command=ssh"], ["fish-init", "fish --init-command=ssh"],
    ["ysh-c", "ysh -c ssh"], ["nu-e", "nu -e ssh"], ["nu-commands", "nu --commands ssh"], ["nu-execute", "nu --execute=ssh"],
    // fish takes any start of a long option's name that tells it apart (GPT second look, round 20).
    ["fish-com", "fish --com ssh"], ["fish-com-eq", "fish --com=ssh"], ["fish-init-com", "fish --init-com ssh"], ["fish-init-com-eq", "fish --init-com=ssh"]]) {
    assert.throws(() => startCommand(wrapper(name, words, ""), [], withOthers, { worktree: root, kind: "test" }), new RegExp(`, which starts a shell \\(${words.split(" ")[0]}\\)`), words);
    assert.match(sshCommand({ ...withOthers, GIT_SSH_COMMAND: join(wrappers, name) }, { worktree: root }).problem ?? "", new RegExp(`starts a shell \\(${words.split(" ")[0]}\\)`), words);
  }
  // A wrapper whose interpreter PATH holds only as a link into the worktree gets the plain refusal for it (Claude
  // review, round 12): the interpreter is looked up on the run's own PATH, not the cleaned one.
  mkdirSync(join(root, "node-tools"));
  writeFileSync(join(root, "node-tools", "node"), "#!/bin/sh\nexit 0\n"); chmodSync(join(root, "node-tools", "node"), 0o755);
  symlinkSync(join(root, "node-tools", "node"), join(links, "node"));
  const nodeWrapper = join(wrappers, "node-wrapper");
  writeFileSync(nodeWrapper, "#!/usr/bin/env node\nconsole.log('ran');\n"); chmodSync(nodeWrapper, 0o755);
  assert.match(refusedWith({ ...base, PATH: `${links}:${bin}`, GIT_SSH_COMMAND: nodeWrapper }), /node on PATH is \S+\/links\/node, a link into the worktree/);
  // A real node in a later folder is still found past the link, and started by its full path.
  const nodeFolder = dirname(process.execPath);
  assert.ok(sshCommand({ ...base, PATH: `${links}:${nodeFolder}:${bin}:/usr/bin:/bin`, GIT_SSH_COMMAND: nodeWrapper }, { worktree: root }).command?.includes(`${nodeFolder}/node`));
  // sh may set IFS back to blanks at its start (dash does), so an empty IFS from the run still splits $X at blanks
  // (GPT second look, round 8).
  const emptyIfs = { ...base, IFS: "", X: "-v -J jump.example.invalid", GIT_SSH_COMMAND: `ssh $X -o "HostName=a'b" host` };
  assert.match(sshCommand(emptyIfs, { worktree: root }).problem ?? "", /cannot be told: sh splits or expands what a \$ fills in/);
  assert.match(refusedWith(emptyIfs), /^kit: git's ssh command \(.*\) cannot be told: sh splits or expands what a \$ fills in/m);
  // sh takes out a \ and the line break after it inside double quotes, so "s\<line break>h" is sh (GPT second look, round 4).
  const continued = sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 ${dirname(shell)}/"s\\\nh" -c 'echo ran > ${marker}'` }, { worktree: root });
  assert.match(continued.problem ?? "", /cannot be told: it uses shell syntax beyond words and quotes/);
  spawnSync("/bin/sh", ["-c", continued.command!], { env: base, encoding: "utf8" });
  assert.ok(!existsSync(marker));
  // What sh fills in from quoted variables gets the env and setting checks too: env itself, and PATH= or BASH_ENV= for
  // it, also behind timeout (GPT second look, round 4).
  for (const [command, env, why] of [[`timeout 30 "$E" "$X" ssh`, { E: "/usr/bin/env", X: `PATH=${toLinks}` }, /sh fills in a \$ in it as PATH=, which sets PATH itself/],
    [`timeout 30 "$E" "$X" ssh`, { E: "/usr/bin/env", X: `BASH_ENV=${startup}` }, /sh fills in a \$ in it as BASH_ENV=, which sets BASH_ENV itself/],
    [`timeout 30 "$E" ssh`, { E: "/usr/bin/env" }, /sh fills in a \$ in it as env, which looks its program up on PATH/],
    [`timeout 30 gnuenv "$X" ssh`, { X: `PATH=${toLinks}` }, /sh fills in a \$ in it as PATH=, which sets PATH itself/],
    [`timeout 30 gnuenv "$X" ssh`, { X: "-S${A}${B} ssh" }, /sh fills in a \$ in it as a word an env there could read as PATH= or BASH_ENV=/]] as const) {
    assert.match(sshCommand({ ...base, ...env, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", why, command);
    assert.match(refusedWith({ ...base, ...env, GIT_SSH_COMMAND: command }), /^kit: git's ssh command \(.*\) cannot be told: sh fills in a \$ in it as/m, command);
  }
  // sh drops a word with no quotes in it that fills in empty, which moves the words after it: here the -F path beside
  // ProxyJump; a quoted empty word stays (GPT second look, round 7).
  const dropped = sshCommand({ ...base, EMPTY: "", GIT_SSH_COMMAND: `ssh -F $EMPTY './cfg;echo ran > ${marker};' -J jump.example.invalid host` }, { worktree: root });
  assert.match(dropped.problem ?? "", /cannot be told: sh drops a word that fills in empty, which moves the words after it/);
  spawnSync("/bin/sh", ["-c", dropped.command!], { env: base, encoding: "utf8" });
  assert.ok(!existsSync(marker));
  assert.equal(sshCommand({ ...base, EMPTY: "", GIT_SSH_COMMAND: `ssh -i "$EMPTY" host` }, { worktree: root }).problem, null);
  // The names the command starts are looked up in the PATH it runs with, without a folder that holds a link into the
  // worktree: there run is bash, not the true an earlier folder holds beside such a link (GPT second look, round 7).
  const shadow = join(dir, "shadow"), later = join(dir, "later");
  for (const folder of [shadow, later]) mkdirSync(folder);
  symlinkSync(["/usr/bin/true", "/bin/true"].find(file => existsSync(file))!, join(shadow, "run"));
  symlinkSync(join(root, "tools/ssh"), join(shadow, "planted"));
  symlinkSync(bash, join(later, "run"));
  const shadowed = sshCommand({ ...base, PATH: `${shadow}:${later}:${bin}:/usr/bin:/bin`, GIT_SSH_COMMAND: `timeout 30 run -c 'echo ran > ${marker}'` }, { worktree: root });
  assert.match(shadowed.problem ?? "", /cannot be told: it starts a shell \(run\)/);
  // ssh splits an option from its value at a line break or carriage return as at a blank (GPT second look, round 5).
  for (const [command, why] of [[`ssh -o 'ProxyCommand\necho ran > ${marker}' host`, /it starts a shell \(ProxyCommand/], [`ssh -o 'ProxyCommand\recho ran > ${marker}' host`, /it starts a shell \(ProxyCommand/],
    [`ssh -o PermitLocalCommand=yes -o 'LocalCommand\necho ran > ${marker}' host`, /it starts a shell \(LocalCommand/], [`ssh -o 'ProxyJump\na;b' host`, /it starts a shell \(ProxyJump with more than host names/],
    [`ssh -o 'ProxyJump\rjump.example.invalid' -F 'a b' host`, /it starts a shell \(ProxyJump beside a '/]] as const) {
    const result = sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root });
    assert.match(result.problem ?? "", why, command);
    spawnSync("/bin/sh", ["-c", result.command!], { env: base, encoding: "utf8" });
    assert.ok(!existsSync(marker), command);
  }
  // A pattern sh expands after the program could name a shell too.
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 ${dirname(shell)}/s? -c 'ssh "$@"' ssh` }, { worktree: root }).problem ?? "", /cannot be told: sh expands a pattern in it, which could name a shell/);
  // GIT_SSH naming a shell starts one as well.
  assert.match(sshCommand({ ...base, GIT_SSH: bash }, { worktree: root }).problem ?? "", /cannot be told: it starts a shell \(bash\)/);
  for (const [name, file] of [["BASH_ENV", wrapper("gnuenv-split", `gnuenv -S "'BA''SH_ENV=${startup}' ${bash}"`, "")],
    ["PATH", wrapper("gnuenv-split-path", `gnuenv -S "'PA''TH=${toLinks}' ssh"`, "")],
    ["PATH", wrapper("gnuenv-break-path", `gnuenv -S "X=1\\\\_PATH=${toLinks}" ssh`, "")],
    ["PATH", wrapper("renamed-split-path", `${join(bin, "e")} -S "X=1 'PA''TH=${toLinks}'"`)]] as const) {
    assert.throws(() => start(file), new RegExp(`, which sets ${name} itself`), file);
  }
  for (const file of [wrapper("gnuenv-expanded-path", `A=ATH gnuenv -S P\\\${A}=${toLinks} ssh`, ""), wrapper("gnuenv-expanded-equals", `A=PATH B== gnuenv -S \\\${A}\\\${B}${toLinks} ssh`, ""),
    wrapper("gnuenv-short-split", `A=ATH gnuenv --split P\\\${A}=${toLinks} ssh`, ""), wrapper("gnuenv-short-split-joined", `A=ATH gnuenv --s=P\\\${A}=${toLinks} ssh`, "")]) {
    assert.throws(() => start(file), /, whose -S string holds \$\{…\}, which an env there could fill in as PATH or BASH_ENV/, file);
  }
  for (const file of [wrapper("inner-shell-fill", `sh -c 'gnuenv PA\${EMPTY}TH=${toLinks} ssh'`, ""), wrapper("inner-shell-subst", `sh -c 'gnuenv $(printf PA)TH=${toLinks} ssh'`, "")]) {
    assert.throws(() => start(file), /, where a \$ or ` could be filled in as PATH= or BASH_ENV=/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env -S .*, where a \$ or ` could be filled in/m, file);
  }
  // An env -S first line starts no shell but the script's own interpreter: not one told to run a string (-c, -ec), and
  // not one behind a wrapper, which runs whatever its words say (Lex's decision, 2026-11-20).
  for (const file of [wrapper("inner-shell-positional", `sh -c 'gnuenv "$1$2" ssh' PA TH=${toLinks}`, ""), wrapper("inner-shell-braces", `sh -c 'gnuenv "\${1}\${2}" ssh' PA TH=${toLinks}`, ""),
    wrapper("inner-shell-star", `sh -c 'IFS=; gnuenv "$*" ssh' PA TH=${toLinks}`, ""), wrapper("inner-shell-ok", "sh -c 'ssh -i ${HOME}/.ssh/id_ed25519'", ""),
    wrapper("bash-bundled-c", "bash -ec 'ssh \"$@\"'", ""), wrapper("timeout-sh", "timeout 30", "sh"), wrapper("timeout-bash-c", "timeout 30 bash -c 'ssh \"$@\"'", ""),
    wrapper("nice-dash", "nice -n 5 dash", ""), wrapper("busybox-sh", "busybox", "sh"), wrapper("gnuenv-zsh", "gnuenv zsh -c 'ssh \"$@\"'", ""),
    wrapper("ssh-proxy", "ssh -o 'ProxyCommand=nc %h %p'", ""), wrapper("ssh-bundled-proxy", "ssh -4oProxyCommand='nc %h %p'", ""),
    wrapper("ssh-quoted-proxy", `ssh -o '"ProxyCommand" nc %h %p'`, "")]) {
    assert.throws(() => start(file), /, which starts a shell \((sh|bash|dash|zsh|ProxyCommand)[),]/, file);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env -S .*, which starts a shell/m, file);
  }
  assert.throws(() => start(join(wrappers, "ssh-proxy")), /drop ProxyCommand and LocalCommand from that line, or use ProxyJump \(-J\) with plain host names instead/);
  assert.throws(() => start(wrapper("ssh-jump-odd", "ssh -J 'a;b'", "")), /, which starts a shell \(ProxyJump with more than host names in it/);
  assert.throws(() => start(wrapper("ssh-jump-file", "ssh -F 'a b' -J jump.example.invalid", "")), /, which starts a shell \(ProxyJump beside a ' or an -F path.*; keep every word from that line free of ' and the -F path plain, or drop ProxyJump \(-J\)/);
  // pwsh reads its options its own way: any start of -Command, -CommandWithArgs or -EncodedCommand (and -cwa, -ec) runs
  // a string, also after an en dash, em dash or horizontal bar and with blanks around it, and -ExecutionPolicy does not.
  for (const words of ["pwsh -NoProfile -Command", "pwsh -c", "pwsh -EncodedCommand", "pwsh -ec", "pwsh -cwa", "pwsh --command", "pwsh —Command", "pwsh –c",
    "pwsh ――command", "pwsh ' -c'"]) {
    assert.throws(() => start(wrapper("pwsh-command", words, "")), /, which starts a shell \(pwsh\)/, words);
  }
  // sh and bash run a string after +c as after -c, alone or bundled (GPT second look, round 5).
  for (const [name, words] of [["sh-plus-c", "sh +c 'ssh \"$@\"'"], ["bash-plus-ec", "bash +ec 'ssh \"$@\"'"]]) {
    const file = wrapper(name, words, "");
    assert.throws(() => start(file), /, which starts a shell \((sh|bash)\)/, words);
    assert.match(refusedWith({ ...base, GIT_SSH_COMMAND: file }), /^kit: \S+ starts with env -S .*, which starts a shell/m, words);
  }
  const pwshPolicy = wrapper("pwsh-policy", "X=1", "pwsh -ExecutionPolicy Bypass -NonInteractive");
  assert.deepEqual(start(pwshPolicy), ["/usr/bin/env", ["X=1", join(bin, "pwsh"), "-ExecutionPolicy", "Bypass", "-NonInteractive", pwshPolicy]]);
  // es or rc as a word, or with a version, is no shell's name in an env -S line either.
  assert.doesNotThrow(() => startCommand(wrapper("es-words", `ssh -o SetEnv=TARGET=es2020 -o SetEnv=LANG=es -l rc`, ""), [], { ...base, PATH: bin }, { worktree: root, kind: "test" }));
  // The script's own interpreter is no extra shell: it runs the script, as #!/bin/sh would, with options that run no
  // string (bash's -C is noclobber; only fish's -C runs one).
  const ownShell = wrapper("own-shell", "X=1", "bash -e");
  assert.deepEqual(start(ownShell), ["/usr/bin/env", ["X=1", bash, "-e", ownShell]]);
  const pipefail = wrapper("own-shell-pipefail", "X=1", "bash -eu -o pipefail");
  assert.deepEqual(start(pipefail), ["/usr/bin/env", ["X=1", bash, "-eu", "-o", "pipefail", pipefail]]);
  const noclobber = wrapper("own-shell-noclobber", "X=1", "bash -eC");
  assert.deepEqual(start(noclobber), ["/usr/bin/env", ["X=1", bash, "-eC", noclobber]]);
  // A shell runs its first word that is not an option, or what -s reads, in place of the script (GPT second look,
  // round 21), and every word after -- or a lone - is one (round 22); pwsh's switches take no value (Claude review,
  // round 21).
  for (const [name, words] of [["shell-payload", `bash ${join(root, "payload")}`], ["shell-relative", "bash payload"], ["shell-stdin", "bash -s"],
    ["shell-stdin-bundle", "bash -es"], ["shell-dashes", "bash -- -e"], ["shell-dash", "bash - -e"], ["pwsh-file", "pwsh -NoProfile -File payload"],
    ["pwsh-file-short", "pwsh -f payload"], ["pwsh-switch", "pwsh -NoProfile payload.ps1"], ["pwsh-stdin", "pwsh -NoProfile -"],
    // A word with a long dash is a script to bash, and so is any word pwsh does not know (GPT second look, round 23).
    ["shell-long-dash", "bash —payload"], ["shell-long-dash-option", "bash –e"], ["pwsh-unknown", "pwsh -payload.ps1"],
    ["pwsh-file-colon", "pwsh -File:payload.ps1"], ["pwsh-short-unknown", "pwsh -set x"], ["pwsh-dashes", "pwsh -NoProfile --"],
    // Two different dashes are no option to pwsh, a value is never an option that takes the next word, and an option
    // that loads code from a file is refused (Claude review, round 23; GPT second look, round 24).
    ["pwsh-mixed-dashes", "pwsh -—NoProfile"], ["pwsh-value-chain", "pwsh -CustomPipeName -ep payload.ps1"],
    ["pwsh-config-file", "pwsh -ConfigurationFile x.pssc"], ["pwsh-settings-file", "pwsh -SettingsFile x.json"],
    ["shell-rcfile", `bash --rcfile -o ${join(root, "payload")}`], ["shell-init-file", "bash --init-file -O payload"],
    ["shell-value-chain", "bash -o -o payload"], ["shell-unknown-long", "bash --debugger"],
    // Each shell's own letters: zsh's -O takes no value and its -b, like tcsh's, ends the options; an option that takes
    // a value and ends the line takes the script (Claude review, round 24; GPT second look, round 25).
    ["zsh-correct-all", "zsh -O payload"], ["rc-no-value", "rc -o payload"], ["zsh-break", "zsh -b -e"], ["tcsh-break", "tcsh -b -e"], ["tcsh-bundle", "tcsh -fb"],
    ["pwsh-value-last", "pwsh -CustomPipeName"], ["shell-value-last", "bash -eu -o"],
    // A name after -o or -O can switch on -s too, in any case, without _, or as +o no_… (round 26).
    ["zsh-stdin-option", "zsh -o shinstdin"], ["zsh-stdin-spelled", "zsh -o SHIN_STDIN"], ["zsh-stdin-negated", "zsh +o NO_SHIN_STDIN"],
    ["shell-unknown-shopt", "bash -O extdebug"]]) {
    const file = wrapper(name, "X=1", words);
    const why = new RegExp(`hands the shell \\(${words.split(" ")[0]}\\) `);
    assert.throws(() => startCommand(file, [], withOthers, { worktree: root, kind: "test" }), why, words);
    assert.match(sshCommand({ ...withOthers, GIT_SSH_COMMAND: file }, { worktree: root }).problem ?? "", why, words);
  }
  // Option values still count, and an ssh line with key files outside the worktree still starts.
  assert.doesNotThrow(() => start(wrapper("pwsh-valued", "X=1", "pwsh -NoProfile -ep Bypass -WorkingDirectory /tmp")));
  assert.doesNotThrow(() => start(wrapper("pwsh-long-dash", "X=1", "pwsh —NoProfile –nol")));
  // A -- that ends the line hands bash nothing besides the script (Claude review, round 22).
  const dashes = wrapper("own-shell-dashes", "X=1", "bash -eu --");
  assert.deepEqual(start(dashes), ["/usr/bin/env", ["X=1", bash, "-eu", "--", dashes]]);
  // The long options the README names still start bash (Claude review, round 24).
  const norc = wrapper("own-shell-norc", "X=1", "bash --norc --noprofile");
  assert.deepEqual(start(norc), ["/usr/bin/env", ["X=1", bash, "--norc", "--noprofile", norc]]);
  // zsh's own switches and a listed -o name still start it (round 26).
  for (const words of ["zsh -f -e", "zsh -o pipefail", "zsh -o ERR_EXIT"]) {
    const own = wrapper(`own-${words.replace(/\W+/g, "-")}`, "X=1", words);
    assert.deepEqual(startCommand(own, [], withOthers, { worktree: root, kind: "test" }), ["/usr/bin/env", ["X=1", join(otherShells, "zsh"), ...words.split(" ").slice(1), own]], words);
  }
  // A link named pwsh that leads to bash reads bash's options (Claude review, round 25).
  const renamed = join(dir, "renamed shells");
  mkdirSync(renamed);
  symlinkSync(bash, join(renamed, "pwsh"));
  assert.throws(() => startCommand(wrapper("pwsh-is-bash", "X=1", "pwsh -ep payload"), [], { ...base, PATH: `${renamed}:${bin}:/usr/bin:/bin` }, { worktree: root, kind: "test" }), /hands the shell \(pwsh\) a script of its own \(payload\)/);
  // A shell a plain first line names gets what follows it as one word, read by the same rules (GPT second look, round 27).
  for (const [name, rest] of [["plain-script", join(root, "payload")], ["plain-stdin", "-s"]]) {
    const line = join(wrappers, name);
    writeFileSync(line, `#!${bash} ${rest}\nexec ssh "$@"\n`); chmodSync(line, 0o755);
    assert.throws(() => start(line), /hands the shell \(bash\) (?:a script of its own|-s, which has it read commands from its input)/, rest);
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: line }, { worktree: root }).problem ?? "", /hands the shell \(bash\) (?:a script of its own|-s, which has it read commands from its input)/, rest);
  }
  for (const [name, interpreter, rest] of [["plain-options", bash, "-eu"], ["plain-lone-dash", shell, "-"], ["plain-dashes", bash, "--"]]) {
    const line = join(wrappers, name);
    writeFileSync(line, `#!${interpreter} ${rest}\nexec ssh "$@"\n`); chmodSync(line, 0o755);
    assert.deepEqual(start(line), [line, []], rest);
  }
  // macOS splits what follows the interpreter at blanks, so each word is read on its own there.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    const macScript = join(wrappers, "mac-script"), macOptions = join(wrappers, "mac-options");
    writeFileSync(macScript, `#!${bash} -e ${join(root, "payload")}\nexec ssh "$@"\n`); chmodSync(macScript, 0o755);
    writeFileSync(macOptions, `#!${bash} -e -u\nexec ssh "$@"\n`); chmodSync(macOptions, 0o755);
    assert.throws(() => start(macScript), /hands the shell \(bash\) a script of its own/);
    assert.deepEqual(start(macOptions), [macOptions, []]);
  } finally { Object.defineProperty(process, "platform", platform); }
  // /proc/self/exe is whatever program opens it, so a path into /proc or /dev counts as a shell, through a link or a
  // folder link too, when it is a program file (round 27).
  symlinkSync("/proc/self/exe", join(dir, "self-exe"));
  symlinkSync("/proc/self", join(dir, "self-folder"));
  const bashOpen = openSync(bash, "r");
  t.after(() => closeSync(bashOpen));
  // A .. after a folder link counts from where the link leads, as the kernel reads it (Claude review, round 27):
  // dir/up/deep is dir/a/b, so dir/up/sh2 -> ../../self-exe is dir/self-exe, not up/../../self-exe.
  mkdirSync(join(dir, "a", "b"), { recursive: true });
  symlinkSync(join(dir, "a", "b"), join(dir, "up"));
  symlinkSync("../../self-exe", join(dir, "a", "b", "sh2"));
  // A path written into /proc counts even where realpath leads out of it (/proc/self/root/…, /proc/self/cwd/…).
  writeFileSync(join(dir, "tool"), "exit 0\n"); chmodSync(join(dir, "tool"), 0o755);
  // A program or interpreter path there is refused outright, and one a wrapper starts counts as a shell. /proc/self/cwd
  // is git's folder, the worktree, when git opens it, so a payload only the worktree holds counts too, and so does a ..
  // that climbs into /proc (kit pr review).
  writeFileSync(join(root, "cwd-payload"), "exit 0\n"); chmodSync(join(root, "cwd-payload"), 0o755);
  for (const program of ["/proc/self/exe", "/proc/thread-self/exe", join(dir, "self-exe"), join(dir, "self-folder", "exe"), `/dev/fd/${bashOpen}`, `/proc/self/root${bash}`, `${dir}/up/sh2`,
    `/proc/self/root${join(dir, "tool")}`, "/proc/self/cwd/cwd-payload", "/usr/../proc/self/cwd/cwd-payload"]) {
    const tag = `proc-${basename(program)}-${program.length}`;
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `${program} -c true` }, { worktree: root }).problem ?? "", /is a path into \/proc or \/dev|it starts a shell/, program);
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `${program} host` }, { worktree: root }).problem ?? "", /is a path into \/proc or \/dev|it starts a shell/, program);
    assert.match(sshCommand({ ...base, GIT_SSH: program }, { worktree: root }).problem ?? "", /is a path into \/proc or \/dev|it starts a shell/, program);
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `timeout 30 ${program} -c true` }, { worktree: root }).problem ?? "", /it starts a shell/, program);
    assert.throws(() => start(wrapper(tag, "X=1", `${program} -c true`)), /starts with env .*, a path into \/proc or \/dev/, program);
    assert.throws(() => start(wrapper(`${tag}-timeout`, "X=1", `timeout 30 ${program} -c true`)), /, which starts a shell/, program);
    const plain = join(wrappers, `${tag}-plain`);
    writeFileSync(plain, `#!${program}\n`); chmodSync(plain, 0o755);
    assert.throws(() => start(plain), /, a path into \/proc or \/dev/, program);
  }
  // A login or interactive shell reads start-up files, so those options are refused too (kit pr review), pwsh's
  // -Login among them (landing review R1-4).
  for (const words of ["bash -l", "bash --login", "bash -i", "bash --interactive", "zsh -l", "fish -i", "nu --login", "pwsh -l", "pwsh -Login"]) {
    const why = new RegExp(`hands the shell \\(${words.split(" ")[0]}\\) ${words.split(" ")[1]}, which makes it a login or interactive shell that reads start-up files`);
    assert.throws(() => startCommand(wrapper(`login-${words.replace(/\W+/g, "-")}`, "X=1", words), [], withOthers, { worktree: root, kind: "test" }), why, words);
  }
  // The refusal says why: a script of its own, -s, a file of code, an option or setting the kit does not know, a value
  // missing, or a Linux plain line passed as one word (landing review R1-6).
  for (const [words, why] of [
    [`bash ${join(root, "payload")}`, /hands the shell \(bash\) a script of its own \(.*payload\), which it would run in place of this one/],
    ["bash -- -e", /hands the shell \(bash\) a script of its own after -- \(-e\)/],
    ["bash -es", /hands the shell \(bash\) -es, which has it read commands from its input in place of this script/],
    ["bash --rcfile x", /hands the shell \(bash\) --rcfile, which loads code from a file/],
    ["pwsh -ConfigurationFile x.pssc", /hands the shell \(pwsh\) -ConfigurationFile, which loads code from a file/],
    ["bash --debugger", /hands the shell \(bash\) --debugger, an option the kit does not know/],
    ["bash -O extdebug", /hands the shell \(bash\) -O extdebug, a setting the kit does not know/],
    ["bash -eu -o", /hands the shell \(bash\) -o with nothing after it, so it would take this script as its value; give that option its setting,/]] as const) {
    assert.throws(() => start(wrapper(`why-${words.replace(/\W+/g, "-").slice(-40)}`, "X=1", words)), why, words);
  }
  const oneWord = join(wrappers, "why-one-word");
  writeFileSync(oneWord, `#!${bash} -e -u\nexec ssh "$@"\n`); chmodSync(oneWord, 0o755);
  assert.throws(() => start(oneWord), /hands the shell \(bash\) "-e -u" as one word \(Linux passes all that follows the interpreter as one\), which is no option it knows; join those options into one word \(-eu for -e -u\),/);
  // A folder link into /proc/self/cwd is git's folder, the worktree, when git opens a path through it, so a path
  // through it counts as one into /proc (landing review R1-1), and so does a program a PATH entry leads to there,
  // which the kit's folder does not hold (R1-2).
  symlinkSync("/proc/self/cwd", join(dir, "cwd-folder"));
  const throughCwd = join(dir, "cwd-folder", "cwd-payload");
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `${throughCwd} host` }, { worktree: root }).problem ?? "", /is a path into \/proc or \/dev|it starts a shell \(cwd-payload\)/);
  assert.match(sshCommand({ ...base, GIT_SSH: throughCwd }, { worktree: root }).problem ?? "", /is a path into \/proc or \/dev|it starts a shell \(cwd-payload\)/);
  assert.throws(() => start(wrapper("cwd-folder-env", "X=1", throughCwd)), /starts with env .*, a path into \/proc or \/dev/);
  const cwdPlain = join(wrappers, "cwd-folder-plain");
  writeFileSync(cwdPlain, `#!${throughCwd}\n`); chmodSync(cwdPlain, 0o755);
  assert.throws(() => start(cwdPlain), /, a path into \/proc or \/dev/);
  const cwdLinks = join(dir, "cwd links");
  mkdirSync(cwdLinks);
  symlinkSync("/proc/self/cwd/cwd-payload", join(cwdLinks, "mysh"));
  const viaCwd = { ...base, PATH: `${cwdLinks}:${bin}:/usr/bin:/bin` };
  const byName = join(wrappers, "cwd-path-name");
  writeFileSync(byName, "#!/usr/bin/env mysh\n"); chmodSync(byName, 0o755);
  assert.throws(() => startCommand(byName, [], viaCwd, { worktree: root, kind: "test" }), /mysh on PATH is .*, which leads into \/proc/);
  assert.match(sshCommand({ ...viaCwd, GIT_SSH_COMMAND: "mysh host" }, { worktree: root }).problem ?? "", /mysh on PATH is .*, which leads into \/proc|it starts a shell \(mysh\)/);
  // A program that starts it by its bare name in turn gets PATH without the folder that holds the link into /proc
  // (TOOLS-390 R1-1), so timeout finds no mysh there to start.
  const timed = sshCommand({ ...viaCwd, GIT_SSH_COMMAND: "timeout 30 mysh host" }, { worktree: root });
  assert.equal(timed.problem, null);
  assert.ok(String(timed.command).startsWith(`PATH=${bin}:/usr/bin:/bin `) && !String(timed.command).includes(cwdLinks), String(timed.command));
  // A worktree folder that is a link leading out still counts as the worktree, as the path is written: a build can
  // point it elsewhere after the check (landing review R1-3).
  symlinkSync(bin, join(root, "tools-link"));
  for (const command of ["./tools-link/ssh", join(root, "tools-link", "ssh")]) {
    assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: command }, { worktree: root }).problem ?? "", /inside the worktree or its Git folder/, command);
  }
  assert.throws(() => start(wrapper("tools-link-env", "X=1", join(root, "tools-link", "ssh"))), /inside the worktree or its Git folder/);
  // A bare name PATH finds as such a link counts too (round 27); one a program starts in turn finds no such folder on
  // the command's PATH (TOOLS-390 R1-1).
  const procLinks = join(dir, "proc links");
  mkdirSync(procLinks);
  symlinkSync("/proc/self/exe", join(procLinks, "mysh"));
  const viaExe = { ...base, PATH: `${procLinks}:${bin}:/usr/bin:/bin` };
  assert.match(sshCommand({ ...viaExe, GIT_SSH_COMMAND: "mysh -c true" }, { worktree: root }).problem ?? "", /mysh on PATH is .*, which leads into \/proc|it starts a shell/);
  const timedExe = sshCommand({ ...viaExe, GIT_SSH_COMMAND: "timeout 30 mysh -c true" }, { worktree: root });
  assert.equal(timedExe.problem, null);
  assert.ok(String(timedExe.command).startsWith(`PATH=${bin}:/usr/bin:/bin `) && !String(timedExe.command).includes(procLinks), String(timedExe.command));
  for (const words of ["ssh -i ~/.ssh/id_ed25519 -o IdentityFile=/etc/ssh/key -o UserKnownHostsFile=/etc/ssh/known", "ssh -i/etc/ssh/key -F/etc/ssh/ssh_config"]) {
    const keys = wrapper(`ssh-keys-${words.length}`, "X=1", words);
    assert.deepEqual(start(keys), ["/usr/bin/env", ["X=1", join(bin, "ssh"), ...words.split(" ").slice(1), keys]], words);
    assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: words }, { worktree: root }).problem, null, words);
  }
  // SHELL is the shell ssh runs a ProxyJump through, so a line does not set it (Claude review, round 21).
  assert.match(sshCommand({ ...base, GIT_SSH_COMMAND: `SHELL=${join(root, "x")} ssh -J jump.example.invalid host` }, { worktree: root }).problem ?? "", /sets SHELL itself/);
  assert.throws(() => start(wrapper("shell-setting", `SHELL=${join(root, "x")}`, "ssh -J jump.example.invalid")), /sets SHELL itself/);
  // fish's other long options still start it (Claude review, round 20).
  for (const words of ["fish --no-config", "fish --private"]) {
    assert.doesNotThrow(() => startCommand(wrapper(`own-${words.replace(/\W+/g, "-")}`, "X=1", words), [], withOthers, { worktree: root, kind: "test" }), words);
  }
  // Split names that make other variables still start, and so does a ${…} that ssh fills in itself.
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: `gnuenv -S "X'PA'TH=1 MY_E'N'V=2 ssh"` }, { worktree: root }).problem, null);
  assert.equal(sshCommand({ ...base, GIT_SSH_COMMAND: "ssh -i '${HOME}/.ssh/id_ed25519'" }, { worktree: root }).problem, null);
  const otherSplit = wrapper("gnuenv-other-split", `gnuenv -S "X'PA'TH=1" ssh`, "");
  assert.doesNotThrow(() => start(otherSplit));
  // Names that only end in ENV or PATH are other variables, and a plain ssh command still starts the lead's ssh.
  const others = wrapper("other-names", "MY_ENV=1 XBASH_ENV=2 ENVX=3 XPATH=4");
  assert.deepEqual(start(others), ["/usr/bin/env", ["MY_ENV=1", "XBASH_ENV=2", "ENVX=3", "XPATH=4", shell, others]]);
  rmSync(noted, { force: true });
  const safe = gitSafety({ worktree: root, env: { ...base, GIT_SSH_COMMAND: "MY_ENV=1 ssh" }, network: true, git: realGit });
  spawnSync(realGit, ["-C", root, "ls-remote", "ssh://example.invalid/repo.git"], { env: { ...base, GIT_SSH_COMMAND: "MY_ENV=1 ssh", ...safe.env }, encoding: "utf8" });
  assert.match(readFileSync(noted, "utf8"), /^lead's ssh .*example\.invalid/);
  // env takes an -S string joined to its option, after other flags too (-Ssh, -vSsh), and splits it at the first S
  // (-SShell runs Shell), so the shell named there counts as well: with env copied under a name of its own (gnuenv), in
  // git's ssh command and in an env -S first line (GPT second look on 47e3824, G1).
  const copied = join(dir, "copied"), joinedMarker = join(dir, "joined-split.txt");
  mkdirSync(copied);
  copyFileSync("/usr/bin/env", join(copied, "gnuenv")); chmodSync(join(copied, "gnuenv"), 0o755);
  symlinkSync(bash, join(copied, "Shell"));
  const viaCopy = { ...base, PATH: `${copied}:${bin}:/usr/bin:/bin` } as NodeJS.ProcessEnv;
  for (const [flags, name] of [["-Ssh", "sh"], ["-vSsh", "sh"], ["-SShell", "Shell"]]) {
    const result = sshCommand({ ...viaCopy, GIT_SSH_COMMAND: `timeout 30 gnuenv ${flags} -c 'echo ran > ${joinedMarker}'` }, { worktree: root });
    assert.match(result.problem ?? "", new RegExp(`cannot be told: it starts a shell \\(${name}\\)`), flags);
    spawnSync("/bin/sh", ["-c", result.command!], { env: viaCopy, encoding: "utf8" });
    assert.ok(!existsSync(joinedMarker), flags);
    assert.match(refusedWith({ ...viaCopy, GIT_SSH_COMMAND: `timeout 30 gnuenv ${flags} -c ssh` }), new RegExp(`^kit: git's ssh command \\(.*\\) cannot be told: it starts a shell \\(${name}\\)`, "m"), flags);
    const line = wrapper(`copied-env${flags}`, `timeout 30 gnuenv ${flags} -c ssh`, "");
    assert.throws(() => startCommand(line, [], viaCopy, { worktree: root, kind: "test" }), new RegExp(`, which starts a shell \\(${name}\\)`), flags);
  }
  // ssh's own words that hold an S after a dash still start (Claude review R1-7).
  for (const command of ["ssh -S/tmp/ctl host", "ssh -oStrictHostKeyChecking=accept-new host", "ssh -oServerAliveInterval=30 host"]) {
    assert.equal(sshCommand({ ...viaCopy, GIT_SSH_COMMAND: command }, { worktree: root }).problem, null, command);
  }
});

// GPT second look on be0bc9b: the loader's --argv0 hands busybox the name it acts on, so -sh (a login shell's name)
// starts its shell and -env its env; and the kernel follows a link before it reads a .. after it, so link/../x is x
// beside where the link leads, not beside the link.
test("TOOLS-329: a login shell name the loader hands busybox, and a .. after a link, are read as the kernel reads them", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-kernel-names-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), bin = join(dir, "bin"), out = join(dir, "out"), wrappers = join(dir, "wrappers");
  for (const folder of [join(root, "deep", "dir"), join(root, "sub"), join(root, "tools"), bin, join(out, "deep", "dir"), join(dir, "far", "sub"), wrappers]) mkdirSync(folder, { recursive: true });
  const bash = ["/usr/bin/bash", "/bin/bash"].find(file => existsSync(file))!;
  writeFileSync(join(bin, "ssh"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "ssh"), 0o755);
  const base = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, GIT_SSH: undefined, GIT_SSH_COMMAND: undefined, BASH_ENV: undefined, ENV: undefined } as NodeJS.ProcessEnv;
  const ssh = (command: string, env = base) => sshCommand({ ...env, GIT_SSH_COMMAND: command }, { worktree: root });
  const start = (name: string, line: string) => {
    const file = join(wrappers, name);
    writeFileSync(file, `#!${line}\nexec ssh "$@"\n`); chmodSync(file, 0o755);
    return startCommand(file, [], base, { worktree: root, kind: "test" });
  };
  // P0-1: busybox acts on its first word with a leading dash taken off, as a login shell is named.
  const loader = "/lib64/ld-linux-x86-64.so.2";
  for (const name of ["-sh", "-bash", "/x/-ash"]) {
    assert.match(ssh(`${loader} --argv0 ${name} /usr/bin/busybox -c 'printf PROBE'`).problem ?? "", /it starts a shell/, name);
    assert.throws(() => start(`loader${name.replace(/\W+/g, "-")}`, `/usr/bin/env -S ${loader} --argv0 ${name} /usr/bin/busybox -c ssh`), /, which starts a shell/, name);
  }
  assert.match(ssh(`${loader} --argv0 -env /usr/bin/busybox ssh host`).problem ?? "", /env looks its program up on PATH/);
  assert.throws(() => start("loader-env", `/usr/bin/env -S ${loader} --argv0 -env /usr/bin/busybox ssh`), /starts env again/);
  // P0-2: out/link/../../shell-alias is out/shell-alias, a link to bash, behind a wrapper and in an env -S line; inside
  // the worktree too.
  symlinkSync(join(out, "deep", "dir"), join(out, "link"));
  symlinkSync(bash, join(out, "shell-alias"));
  symlinkSync(join(root, "deep", "dir"), join(root, "link"));
  symlinkSync(bash, join(root, "shell-alias"));
  for (const path of [`${out}/link/../../shell-alias`, `${root}/link/../../shell-alias`]) {
    assert.match(ssh(`timeout 1 ${path} -c 'printf PROBE'`).problem ?? "", /it starts a shell/, path);
    assert.throws(() => start(`dots-${path.length}`, `/usr/bin/env -S timeout 1 ${path} -c ssh`), /, which starts a shell/, path);
  }
  // A .. after a link that leads into the worktree is in the worktree: out-link/../payload is the worktree's payload
  // (Claude review R2-5), as an interpreter, as git's ssh, and as an env -S program.
  writeFileSync(join(root, "payload"), "#!/bin/sh\nexit 1\n"); chmodSync(join(root, "payload"), 0o755);
  symlinkSync(join(root, "sub"), join(dir, "out-link"));
  const payload = `${dir}/out-link/../payload`;
  assert.throws(() => start("dots-interpreter", payload), /inside the worktree or its Git folder/);
  assert.match(ssh(`${payload} host`).problem ?? "", /inside the worktree or its Git folder/);
  assert.throws(() => start("dots-env", `/usr/bin/env -S X=1 ${payload}`), /inside the worktree or its Git folder/);
  // What the kit starts is the path the kernel reads, the one it checked: hop/../work/payload is far/work/payload,
  // never the worktree's payload that the path tidied as text names (Claude review on c6ee093).
  mkdirSync(join(dir, "far", "work"));
  writeFileSync(join(dir, "far", "work", "payload"), "#!/bin/sh\nexit 1\n"); chmodSync(join(dir, "far", "work", "payload"), 0o755);
  symlinkSync(join(dir, "far", "sub"), join(dir, "hop"));
  const beside = `${dir}/hop/../work/payload`;
  assert.equal(ssh(`${beside} host`).command, `${beside} host`);
  assert.equal(sshCommand({ ...base, GIT_SSH: beside }, { worktree: root }).command, beside);
  assert.equal(start("dots-text", `/usr/bin/env -S ${beside}`)[0], beside);
  // A PATH folder written with a .. after a link is the folder the kernel reaches: one that holds a link into the
  // worktree (far/ssh) leaves the command's PATH, so timeout never finds it.
  writeFileSync(join(root, "tools", "ssh"), "#!/bin/sh\nexit 1\n"); chmodSync(join(root, "tools", "ssh"), 0o755);
  symlinkSync(join(root, "tools", "ssh"), join(dir, "far", "ssh"));
  const hops = { ...base, PATH: `${dir}/hop/..:${bin}:/usr/bin:/bin` };
  const command = ssh("timeout 1 ssh host", hops);
  assert.equal(command.problem, null);
  assert.ok(command.command?.startsWith("PATH=") && !command.command.includes("hop"), command.command ?? "");
  assert.ok(ssh("ssh host", hops).command?.endsWith(`${join(bin, "ssh")} host`));
});

// TOOLS-329 (SL-1): env -S splits its string on carriage return, vertical tab and form feed as on blanks, so a first
// line that uses them names its program in its first word, and that program starts by its full path.
test("TOOLS-329: an env -S first line split on carriage return, vertical tab or form feed starts its interpreter by its full path", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-interpreter-blanks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktree = join(dir, "work"), bin = join(dir, "bin"), links = join(dir, "links"), noted = join(dir, "planted.txt");
  for (const folder of [worktree, bin, links]) mkdirSync(folder);
  const node = join(bin, "node");
  symlinkSync(process.execPath, node);
  writeFileSync(join(worktree, "node"), `#!/bin/sh\necho planted >> ${JSON.stringify(noted)}\nexec ${process.execPath} "$@"\n`); chmodSync(join(worktree, "node"), 0o755);
  symlinkSync(join(worktree, "node"), join(links, "node"));
  const env = { PATH: `${links}:${bin}:/usr/bin:/bin` };
  for (const [name, blank] of [["return", "\r"], ["vertical-tab", "\v"], ["form-feed", "\f"]]) {
    const file = join(dir, name);
    writeFileSync(file, `#!/usr/bin/env -S node${blank}--no-warnings\nconsole.log(JSON.stringify(process.argv.slice(2)));\n`); chmodSync(file, 0o755);
    assert.deepEqual(startCommand(file, ["a"], env, { worktree, kind: "test" }), [node, ["--no-warnings", file, "a"]], name);
  }
  // A blank env never splits on stays in its word: the whole word is the program, which no folder holds.
  const joined = join(dir, "no-break");
  writeFileSync(joined, `#!/usr/bin/env -S node${String.fromCharCode(0xa0)}--no-warnings\n`); chmodSync(joined, 0o755);
  assert.deepEqual(startCommand(joined, ["a"], env, { worktree, kind: "test" }), [joined, ["a"]]);
  assert.ok(!existsSync(noted), "the planted node never started");
});

test("TOOLS-320: bubblewrap mounts the kit's folders before the key masks and kit pr's own folders after them", t => {
  const dir = mkdtempSync(join(tmpdir(), "kit-bwrap-order-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const masked = join(dir, "runtime"), kit = join(dir, "kit"), links = join(masked, "links");
  mkdirSync(links, { recursive: true }); mkdirSync(kit);
  const args: string[] = bwrapArgs([masked], { readOnly: [kit], readOnlyAfter: [links] });
  const at = (...words: string[]) => args.findIndex((arg, index) => words.every((word, offset) => args[index + offset] === word));
  assert.ok(at("--ro-bind", kit, kit) < at("--tmpfs", masked), args.join(" "));
  assert.ok(at("--ro-bind", links, links) > at("--tmpfs", masked), args.join(" "));
});

test("TOOLS-320: the machine's kit copy is read-only to a locked build and to kit pr's locked checks", { skip: noBwrap }, t => {
  const { dir, home } = keyHome(t);
  const worktree = join(dir, "work"), copy = join(home, ".local/share/agent-kit/abc123");
  mkdirSync(worktree); mkdirSync(join(copy, "kit.d"), { recursive: true });
  writeFileSync(join(copy, "kit.d/pr"), "the kit\n");
  // A key file kept in the kit's folder stays hidden although the folder is mounted read-only.
  const secret = join(home, ".local/share/agent-kit/secret.txt");
  writeFileSync(secret, `${dummy}\n`, { mode: 0o600 });
  const env = { ...homeEnv(home), KIT_KEY_PATHS: secret } as NodeJS.ProcessEnv;
  const write = `try { console.log(require("node:fs").readFileSync(${JSON.stringify(secret)}, "utf8").includes(${JSON.stringify(dummy)}) ? "read the key" : "no key"); } catch { console.log("no key"); } try { require("node:fs").appendFileSync(${JSON.stringify(join(copy, "kit.d/pr"))}, "changed\\n"); console.log("wrote"); } catch (error) { console.log(error.code); }`;
  const tryWrite = (wrap: (command: string, args: string[]) => [string, string[]], extra: Record<string, string | undefined>) => {
    const [command, args] = wrap(process.execPath, ["-e", write]);
    const run = spawnSync(command, args, { env: { ...env, ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== undefined)) } as NodeJS.ProcessEnv, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  const checks = checkLock({ worktree, env });
  t.after(() => checks.close?.());
  assert.equal(tryWrite(checks.wrap, checks.env), "no key\nEROFS");
  const build = keyGuard({ cli: "claude", kind: "build", worktree, env });
  assert.equal(tryWrite(build.helper, build.env), "no key\nEROFS");
  assert.equal(readFileSync(join(copy, "kit.d/pr"), "utf8"), "the kit\n");
  const folders = kitFolders(env, { worktree });
  assert.ok(folders.includes(realpathSync(join(home, ".local/share/agent-kit"))), String(folders));
  assert.ok(folders.includes(realpathSync(resolve("."))), "the copy this kit runs from");
  // Inside the kit's own checkout (a build of the kit itself) it is the worktree, the build's to write.
  assert.ok(!kitFolders(env, { worktree: resolve(".") }).includes(realpathSync(resolve("."))));
  // Nor one that holds the worktree, which would make the worktree read-only too.
  assert.ok(!kitFolders(env, { worktree: copy }).includes(realpathSync(join(home, ".local/share/agent-kit"))));
});

test("PROOF: after a Claude build the runner's own git status runs inside the lock: a git it starts reads no key", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), gitBin = join(dir, "git-bin"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md"), noted = join(dir, "noted.txt");
  for (const path of [bin, gitBin, root, out]) mkdirSync(path);
  fakeClaude(bin);
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  // The lead's own git, a wrapper outside the worktree: on git status it notes what it can read, then acts as git.
  const realGit = String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, "git")).find(file => existsSync(file))!;
  writeFileSync(join(gitBin, "git"), `#!/bin/sh\ncase " $* " in *" status "*) { cat ${JSON.stringify(files.orbit)} 2>&1; printf 'token=%s.\\n' "$GH_TOKEN"; } >> ${JSON.stringify(noted)};; esac\nexec ${realGit} "$@"\n`);
  chmodSync(join(gitBin, "git"), 0o755);
  const env = { ...homeEnv(home), PATH: `${gitBin}:${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: join(dir, "seen.json"), FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const left = readFileSync(noted, "utf8");
  assert.ok(!left.includes(dummy), `the runner's git status read a key: ${left}`);
  assert.match(left, /(No such file or directory|Permission denied)\ntoken=\.\n/);
});

test("PROOF: a git that is a #!/usr/bin/env node script never starts a node a link on PATH leads into the worktree for, in the runner's first git and its config reads", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const bin = join(dir, "bin"), gitBin = join(dir, "git-bin"), links = join(dir, "links"), root = join(dir, "work"), out = join(dir, "out"), brief = join(dir, "brief.md"), noted = join(dir, "planted.txt");
  for (const path of [bin, gitBin, links, root, out]) mkdirSync(path);
  fakeClaude(bin);
  writeFileSync(brief, "Build this.\n");
  const git = (...args: string[]) => assert.equal(spawnSync("git", ["-C", root, ...args], { encoding: "utf8" }).status, 0);
  git("init", "-q", "-b", "test"); git("-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
  const real = (name: string) => String(process.env.PATH).split(":").filter(folder => folder.startsWith("/")).map(folder => join(folder, name)).find(file => existsSync(file))!;
  // The lead's git is a Node wrapper outside the worktree; an earlier build left a node in it, and a person linked to it.
  writeFileSync(join(gitBin, "git"), `#!/usr/bin/env node\nconst r = require("node:child_process").spawnSync(${JSON.stringify(real("git"))}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(r.status ?? 1);\n`);
  chmodSync(join(gitBin, "git"), 0o755);
  plantedProgram(join(root, "tools/node"), noted, files.orbit, `exec ${real("node")} "$@"`);
  symlinkSync(join(root, "tools/node"), join(links, "node"));
  const env = { ...homeEnv(home), PATH: `${links}:${gitBin}:${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: join(dir, "seen.json"), FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.ok(!existsSync(noted), `the planted node started: ${existsSync(noted) ? readFileSync(noted, "utf8") : ""}`);
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test("kit pr's lock for its checks leaves a mark only a process inside it sees, so a run there starts no sandbox of its own", { skip: noBwrap }, t => {
  const { dir, home, files } = keyHome(t);
  const worktree = join(dir, "work"), runtime = join(dir, "runtime");
  mkdirSync(worktree); mkdirSync(runtime, { mode: 0o700 });
  const env = { ...homeEnv(home), XDG_RUNTIME_DIR: runtime } as NodeJS.ProcessEnv;
  const lock = checkLock({ worktree, env });
  t.after(() => lock.close?.());
  assert.equal(lock.note, null);
  assert.match(String(lock.env.KIT_OUTER_LOCK), /^[0-9a-f-]{36}$/);
  const probe = `import(${JSON.stringify(resolve("key-guard.mjs"))}).then(m => { let key; try { key = require("node:fs").readFileSync(${JSON.stringify(files.orbit)}, "utf8"); } catch (error) { key = error.code; } console.log(JSON.stringify({ outer: m.outerLock(), key })); })`;
  const inside = (extra: NodeJS.ProcessEnv = {}) => {
    const [command, args] = lock.wrap(process.execPath, ["-e", probe]);
    const run = spawnSync(command, args, { env: { ...env, ...Object.fromEntries(Object.entries(lock.env).filter(([, value]) => value !== undefined)), ...extra }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  };
  // Inside: the mark matches and the key files are hidden.
  assert.deepEqual(inside(), { outer: true, key: "ENOENT" });
  // A token that does not match the mark is no mark; outside the lock there is none, whatever the variable says.
  assert.equal(inside({ KIT_OUTER_LOCK: "made-up" }).outer, false);
  assert.equal(outerLock({ ...env, KIT_OUTER_LOCK: lock.env.KIT_OUTER_LOCK }), false);
  // Outside a user namespace a planted mark counts for nothing (where this test itself runs in one, a toolbox or a
  // sandbox, that part cannot be told here).
  if (/^\s*0\s+0\s+4294967295\s*$/.test(readFileSync("/proc/self/uid_map", "utf8"))) {
    writeFileSync(join(runtime, "kit-outer-lock"), String(lock.env.KIT_OUTER_LOCK));
    assert.equal(outerLock({ ...env, KIT_OUTER_LOCK: lock.env.KIT_OUTER_LOCK }), false, "outside a user namespace a planted mark counts for nothing");
  }
});
