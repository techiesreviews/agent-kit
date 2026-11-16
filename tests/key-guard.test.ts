import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapArgs, bwrapWorks, checkLock, codexPaths, codexProfile, existingPaths, keyGuard, keyGuardReport, keyPathsWarning, linkTargets, lockedPaths, outerLock, resetBwrapProbe, runProgram, scrubbedEnv, startCommand } from "../key-guard.mjs";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { folderRemote, gitCommonDir, gitNetworkCall, gitSafety } from "../git-safety.mjs";
import { kitEnv, testHomeFolder } from "./support/kit-env.ts";
import { asPlatform, onLinux, onMacos, pathWithout, pathWithoutBwrap } from "./support/no-bwrap.ts";

// The key lock (TOOLS-285): agents the kit starts cannot read the machine's key files. Every key here is a made-up
// dummy in a temporary HOME; no test reads a real key file.
delete process.env.KIT_API_KEY_FILE; delete process.env.KIT_API_CONFIG_DIR;
const dummy = "dummy-key-0123456789-not-real";
const bwrapUsable = bwrapWorks() === null;
const noBwrap = bwrapUsable ? false : `bubblewrap cannot run here: ${bwrapWorks()}`;

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
