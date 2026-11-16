import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapArgs, bwrapWorks, codexPaths, codexProfile, existingPaths, keyGuard, keyGuardReport, keyPathsWarning, linkTargets, lockedPaths, resetBwrapProbe, scrubbedEnv } from "../key-guard.mjs";
import { kitEnv, testHomeFolder } from "./support/kit-env.ts";
import { asPlatform, onLinux, onMacos, pathWithoutBwrap } from "./support/no-bwrap.ts";

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
  for (const name of ["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME", "GH_CONFIG_DIR", "ZDOTDIR", "GIT_CONFIG_GLOBAL"]) delete env[name];
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
  const paths = lockedPaths("claude", { HOME: home });
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
  const env = { ...homeEnv(home), PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
    FAKE_SEEN: seenFile, FAKE_TRIES: JSON.stringify(files) } as NodeJS.ProcessEnv;
  delete env.ASE_KEY_GUARD;
  const run = spawnSync(process.execPath, [resolve("agent-run.mjs"), "build", root, brief, "--out", out, "--cli", "claude", "--model", "claude-opus-5-5"],
    { cwd: root, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
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
  const profile = codexProfile("build", join(dir, "common"), paths);
  const run = spawnSync("codex", ["sandbox", ...profile, "--", "sh", "-c", `cat ${JSON.stringify(files.orbit)}; echo rc=$?; cat ${JSON.stringify(join(reviewHome, "auth.json"))}; cat ${JSON.stringify(join(runtime, "xauth"))}; cat ${JSON.stringify(join(ghElsewhere, "hosts.yml"))}; touch built && echo built-ok`],
    // Its own temporary HOME and CODEX_HOME: the test never touches the real ~/.codex.
    // Codex keeps sandbox state in TMPDIR: the test's own folder, removed with it.
    { cwd: root, encoding: "utf8", timeout: 60_000, env: { ...kitEnv(), HOME: home, CODEX_HOME: reviewHome, TMPDIR: codexTmp,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), XDG_DATA_HOME: join(home, ".local/share"), XDG_STATE_HOME: join(home, ".local/state") } });
  const said = run.stdout + run.stderr;
  assert.ok(!said.includes(dummy), "the dummy key was readable");
  assert.match(said, /Permission denied/); assert.match(said, /rc=1/); assert.match(said, /built-ok/);
});

test("a CLI that is not installed is started as it is, so the run still fails as a missing CLI", { skip: noBwrap }, () => {
  const guard = keyGuard({ cli: "grok", kind: "review", common: "/c", env: { HOME: "/h", PATH: "/nonexistent-folder" } });
  assert.deepEqual(guard.wrap("grok", ["-m", "x"]), ["grok", ["-m", "x"]]);
  const present = keyGuard({ cli: "claude", kind: "review", common: "/c", env: { HOME: "/h", PATH: process.env.PATH } });
  const [command, args] = present.wrap("sh", ["-c", "true"]);
  assert.equal(command, "bwrap"); assert.deepEqual(args.slice(-4), ["--", "sh", "-c", "true"]);
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
