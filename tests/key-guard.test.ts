import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { bwrapArgs, bwrapWorks, codexProfile, existingPaths, keyGuard, lockedPaths, resetBwrapProbe, scrubbedEnv } from "../key-guard.mjs";
import { kitEnv } from "./support/kit-env.ts";

// The key lock (TOOLS-285): agents the kit starts cannot read the machine's key files. Every key here is a made-up
// dummy in a temporary HOME; no test reads a real key file.
delete process.env.KIT_API_KEY_FILE; delete process.env.KIT_API_CONFIG_DIR;
const dummy = "dummy-key-0123456789-not-real";
const bwrapUsable = bwrapWorks() === null;
const noBwrap = bwrapUsable ? false : `bubblewrap cannot run here: ${bwrapWorks()}`;

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
});

test("the locked paths hold the Orbit, GitHub and Cloudflare keys, Claude's MCP config, the other CLIs' logins and the desktop's sockets", () => {
  const env = { HOME: "/h", XDG_RUNTIME_DIR: "/run/user/7", XDG_CONFIG_HOME: "/cfg", KIT_KEY_PATHS: "/extra/one:relative/skipped:/extra/two" };
  const claude = lockedPaths("claude", env);
  for (const path of ["/h/.config/fleet", "/h/.config/gh", "/h/.config/.wrangler", "/h/.wrangler", "/h/.cloudflared", "/h/.ssh", "/h/.netrc", "/h/.npmrc",
    "/h/.claude.json", "/h/.codex/auth.json", "/h/.codex/config.toml", "/h/.grok/auth.json", "/cfg/gh", "/cfg/fleet", "/extra/one", "/extra/two", "/run/user/7"]) {
    assert.ok(claude.includes(path), path);
  }
  assert.ok(!claude.some((path: string) => path.includes("relative")));
  assert.ok(!claude.includes("/h/.claude/.credentials.json"), "Claude must still sign in");
  const codex = lockedPaths("codex", { HOME: "/h", CODEX_HOME: "/review-home" });
  for (const path of ["/h/.claude/.credentials.json", "/h/.codex/auth.json", "/h/.codex/config.toml", "/review-home/auth.json"]) assert.ok(codex.includes(path), path);
  assert.ok(lockedPaths("claude", { HOME: "/h", KIT_API_KEY_FILE: "/keys/api" }, { apiRoute: true }).includes("/keys/api"));
  assert.ok(lockedPaths("claude", { HOME: "/h" }, { apiRoute: true }).includes("/h/.claude/.credentials.json"), "the API route signs in with its key");
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

test("the lock is on unless ASE_KEY_GUARD=off; without bubblewrap a Claude run is refused in plain words; an API-route build is refused", t => {
  const off = keyGuard({ cli: "claude", kind: "build", common: "/c", env: { ASE_KEY_GUARD: "off" } });
  assert.equal(off.off, true);
  assert.deepEqual(off.wrap("claude", ["-p"]), ["claude", ["-p"]]);
  const codex = keyGuard({ cli: "codex", kind: "build", common: "/c", env: { HOME: "/h", GH_TOKEN: "x" } });
  assert.equal(codex.codex[1], 'default_permissions="kit-build"');
  assert.ok(Object.hasOwn(codex.env, "GH_TOKEN"));
  const empty = mkdtempSync(join(tmpdir(), "kit-no-bwrap-"));
  t.after(() => { rmSync(empty, { recursive: true, force: true }); resetBwrapProbe(); });
  resetBwrapProbe();
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: "/c", env: { HOME: "/h", PATH: empty } }),
    /cannot lock the key files for this build: bubblewrap \(bwrap\) is not installed; install bubblewrap, or set ASE_KEY_GUARD=off/);
  resetBwrapProbe();
  if (!bwrapUsable) return;
  assert.throws(() => keyGuard({ cli: "claude", kind: "build", common: "/c", env: { HOME: "/h", PATH: process.env.PATH }, apiRoute: true }),
    /cannot lock the key files for a build on the API route/);
});

// A fake claude that acts like a builder told to read the keys: it tries each dummy key file and the token variable
// from its shell, writes a file in the worktree (a normal build step) and prints Claude's JSON result.
function fakeClaude(bin: string) {
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const tries = JSON.parse(process.env.FAKE_TRIES);
const seen = {};
for (const [name, file] of Object.entries(tries)) {
  try { seen[name] = execFileSync("cat", [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (error) { seen[name] = "refused: " + String(error.stderr).trim(); }
}
seen.token = execFileSync("sh", ["-c", "printf %s \\"$GH_TOKEN\\""], { encoding: "utf8" });
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
  const env = { ...kitEnv(), HOME: home, PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: dummy, ASE_SKIP_DOCTOR: "1", ASE_AGENT_TIMEOUT: "60s", KIT_TALK_STYLE: "plain",
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
  // Claude's own login stays readable to Claude (it must sign in): the known limit.
  assert.ok(seen.claudeLogin.includes(dummy));
  assert.equal(readFileSync(join(root, "built.txt"), "utf8"), "a normal build step\n");
  assert.match(run.stdout, /built/);
  // Outside the run nothing changed: the dummy files are still there and still hold their dummy.
  for (const file of Object.values(files)) assert.equal(readFileSync(file, "utf8"), `${dummy}\n`);
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
  const env = { ...kitEnv(), HOME: home, PATH: `${bin}:${process.env.PATH}`, KIT_API_KEY_FILE: keyFile } as NodeJS.ProcessEnv;
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

test("PROOF: Codex's own sandbox with the kit's profile cannot read a dummy key file and can write the worktree", { skip: !bwrapUsable ? noBwrap : spawnSync("codex", ["--version"]).status !== 0 && "codex is not installed" }, t => {
  const { dir, home, files } = keyHome(t);
  const root = join(dir, "work"); mkdirSync(root);
  const profile = codexProfile("build", join(dir, "common"), existingPaths(lockedPaths("codex", { HOME: home })));
  const run = spawnSync("codex", ["sandbox", ...profile, "--", "sh", "-c", `cat ${JSON.stringify(files.orbit)}; echo rc=$?; touch built && echo built-ok`],
    { cwd: root, encoding: "utf8", timeout: 60_000 });
  const said = run.stdout + run.stderr;
  assert.ok(!said.includes(dummy), "the dummy key was readable");
  assert.match(said, /Permission denied/); assert.match(said, /rc=1/); assert.match(said, /built-ok/);
});
