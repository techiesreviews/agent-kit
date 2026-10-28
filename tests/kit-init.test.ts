import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { kitRegisterProject } from "../scripts/agents/kit-lib.mjs";

const launchers = resolve("scripts/agents/launcher");
type After = { after: (fn: () => void) => void };

// A fake machine kit (a copy of this kit as kit update leaves it, with current and updated) and temporary
// HOME and XDG folders, so nothing reaches the real ~/.local; a git repo per test, worked on in a worktree.
function fixture(t: After) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kit-init-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, "data/agent-kit"), state = join(directory, "state");
  const kit = join(data, "0123456789abcdef0123456789abcdef01234567");
  cpSync(resolve("scripts/agents"), kit, { recursive: true, filter: (source) => source !== resolve("scripts/agents/project.d") });
  symlinkSync(kit, join(data, "current"));
  writeFileSync(join(data, "updated"), `${Math.floor(Date.now() / 1000)}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: state, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CLAUDE_PROJECT_DIR: "", KIT_GROK: join(directory, "no-grok") };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_DEV_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_HOME", "KIT_HOME_DEFAULT", "KIT_HOME_PINNED",
    "KIT_COMMANDS_DIR", "KIT_PLAYWRIGHT_MODULE", "KIT_PLAYWRIGHT_MODULE_DEFAULT", "KIT_DOCTOR_SKIP", "ASE_OWNER", "NODE_TEST_CONTEXT"]) delete env[name];
  const git = (root: string, ...args: string[]) => {
    const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // A repo with its files committed on each branch named, then a worktree on a build branch off the first.
  const repo = (name: string, files: Record<string, string>, branches = ["main", "dev"]) => {
    const main = join(directory, name);
    mkdirSync(main);
    for (const [path, text] of Object.entries(files)) { mkdirSync(join(main, path, ".."), { recursive: true }); writeFileSync(join(main, path), text); }
    git(main, "init", "-q", `--initial-branch=${branches[0]}`);
    git(main, "add", "-A");
    git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
    for (const branch of branches.slice(1)) git(main, "branch", branch);
    const work = join(directory, `${name}-build`);
    git(main, "worktree", "add", "-q", "-b", "build/one", work, branches.at(-1)!);
    return { main, work };
  };
  // kit init as the ticket runs it: the machine copy's front door, in the project's worktree.
  const init = (cwd: string, args: string[] = []) =>
    spawnSync(join(data, "current/kit"), ["init", ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
  const projects = () => JSON.parse(readFileSync(join(state, "agent-kit/projects.json"), "utf8"));
  return { directory, env, kit, state, git, repo, init, projects };
}

// Every file under a folder but .git, with its text and mode, so a rerun can be compared byte for byte.
function snapshot(root: string) {
  const files: Record<string, string> = {};
  const walk = (folder: string) => {
    for (const name of readdirSync(folder).sort()) {
      if (name === ".git") continue;
      const path = join(folder, name), info = statSync(path);
      if (info.isDirectory()) walk(path);
      else files[relative(root, path)] = `${(info.mode & 0o777).toString(8)} ${info.mtimeMs} ${readFileSync(path, "utf8")}`;
    }
  };
  walk(root);
  return files;
}
// The last output line, which every run ends with; a run with no output fails the test here.
function result(run: { stdout: string; stderr: string }): string {
  const last = run.stdout.trimEnd().split("\n").at(-1);
  if (!last) throw new Error(`no output: ${run.stderr}`);
  return last;
}
const written = (run: { stdout: string }) => run.stdout.split("\n").filter((line) => line.startsWith("wrote ")).map((line) => line.split(" ")[1]).sort();
const hookCommand = (name: string) => `bash "\${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"/scripts/agents/hooks/run.sh ${name}`;

test("a fresh npm repo gets a full setup that passes doctor, is listed in projects.json, and a rerun changes nothing", (t) => {
  const f = fixture(t);
  const { main, work } = f.repo("site", { "package.json": JSON.stringify({ scripts: { check: "tsc", test: "node --test", lint: "eslint ." } }) });
  const run = f.init(work);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(result(run), /^RESULT: ok init wrote 10 files, listed the project; doctor (\d+)\/\1 checks passed$/);
  assert.deepEqual(written(run), [".claude/settings.json", ".codex/hooks.json", "AGENTS.md", "docs/agents/kitchen-extras.md", "docs/agents/kitchen.md",
    "docs/wayfinder/README.md", "scripts/agents/hooks/run.sh", "scripts/agents/kit", "scripts/agents/kit.json", "scripts/agents/project.d/.gitkeep"]);
  assert.match(run.stdout, /^note: checks guessed from package\.json: check=npm run check, test=npm test, lint=npm run lint; confirm them in scripts\/agents\/kit\.json$/m);
  assert.match(run.stdout, /^✓ hooks live: bash-guard rejects the probe/m);
  assert.deepEqual(JSON.parse(readFileSync(join(work, "scripts/agents/kit.json"), "utf8")), {
    project: "site", mainRoot: main, branches: { land: "dev", release: "main" },
    checks: { check: "npm run check", test: "npm test", lint: "npm run lint" },
    commands: "scripts/agents/project.d", maps: "docs/wayfinder", rulebookExtras: "docs/agents/kitchen-extras.md",
  });
  // The launchers are the kit's templates, executable; the kit itself is not copied in.
  for (const [path, source] of [["scripts/agents/kit", "kit"], ["scripts/agents/hooks/run.sh", "hooks-run.sh"]]) {
    assert.equal(readFileSync(join(work, path), "utf8"), readFileSync(join(launchers, source), "utf8"));
    assert.equal(statSync(join(work, path)).mode & 0o111, 0o111);
  }
  assert.equal(existsSync(join(work, "scripts/agents/kit-lib.sh")), false);
  assert.equal(existsSync(join(work, "scripts/agents/kit.d")), false);
  const extras = readFileSync(join(work, "docs/agents/kitchen-extras.md"), "utf8");
  assert.match(extras, /^# Kitchen extras: site$/m);
  assert.match(extras, /Landing branch `dev`, release branch `main`/);
  assert.match(readFileSync(join(work, "AGENTS.md"), "utf8"), /`scripts\/agents\/kit rulebook`[\s\S]*`scripts\/agents\/kit --help`/);
  assert.deepEqual(f.projects(), { site: { root: main } });
  // The kit's hook set is this repo's own, so the two cannot drift apart.
  for (const path of [".claude/settings.json", ".codex/hooks.json"]) {
    assert.deepEqual(JSON.parse(readFileSync(join(work, path), "utf8")).hooks, JSON.parse(readFileSync(path, "utf8")).hooks, path);
  }
  // Through the project's own launcher the setup runs the machine kit, and the rulebook prints its extras.
  const rulebook = spawnSync(join(work, "scripts/agents/kit"), ["rulebook"], { cwd: work, env: f.env, encoding: "utf8", timeout: 30_000 });
  assert.equal(result(rulebook), "RESULT: ok rulebook shared and docs/agents/kitchen-extras.md", rulebook.stdout + rulebook.stderr);

  const before = snapshot(work), listed = readFileSync(join(f.state, "agent-kit/projects.json"), "utf8");
  const again = f.init(work);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(result(again), /^RESULT: ok init nothing to write \(already set up\); doctor (\d+)\/\1 checks passed$/);
  assert.deepEqual(written(again), []);
  assert.deepEqual(snapshot(work), before);
  assert.equal(readFileSync(join(f.state, "agent-kit/projects.json"), "utf8"), listed);
});

test("a repo with no package.json gets a light setup that passes doctor and writes less than full", (t) => {
  const f = fixture(t);
  const light = f.repo("plain", { "index.html": "<p>hi</p>\n" }, ["main"]);
  const run = f.init(light.work, ["--light"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(result(run), /^RESULT: ok init wrote 6 files, listed the project; doctor (\d+)\/\1 checks passed$/);
  assert.match(run.stdout, /^note: checks: none guessed \(no package\.json\); add "checks" to scripts\/agents\/kit\.json$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(light.work, "scripts/agents/kit.json"), "utf8")), { project: "plain", mainRoot: light.main, branches: { land: "main" } });
  const full = f.repo("plain-full", { "index.html": "<p>hi</p>\n" }, ["main"]);
  const fullRun = f.init(full.work);
  assert.equal(fullRun.status, 0, fullRun.stdout + fullRun.stderr);
  const lightFiles = written(run), fullFiles = written(fullRun);
  assert.deepEqual(lightFiles, [".claude/settings.json", ".codex/hooks.json", "AGENTS.md", "scripts/agents/hooks/run.sh", "scripts/agents/kit", "scripts/agents/kit.json"]);
  assert.ok(lightFiles.every((path) => fullFiles.includes(path)) && fullFiles.length > lightFiles.length, fullFiles.join(" "));
  for (const path of ["docs", "scripts/agents/project.d"]) assert.equal(existsSync(join(light.work, path)), false, path);
  assert.deepEqual(f.projects(), { plain: { root: light.main }, "plain-full": { root: full.main } });
});

test("existing .claude/settings.json keys, hooks and AGENTS.md text survive; only the missing entries are added", (t) => {
  const f = fixture(t);
  const own = { type: "command", command: "echo mine" };
  const settings = { model: "opus", permissions: { allow: ["Bash(ls:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [own] }], Stop: [{ hooks: [own] }],
      SessionStart: [{ hooks: [{ type: "command", command: hookCommand("session-env") }] }] } };
  const { work } = f.repo("kept", { ".claude/settings.json": JSON.stringify(settings), "AGENTS.md": "# Agents\n\nOur own rules.\nRun `scripts/agents/kit --help` for commands.\n" });
  const run = f.init(work, ["--light"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^wrote \.claude\/settings\.json \(merged 7 hook entries\)$/m);
  assert.match(run.stdout, /^wrote AGENTS\.md \(added 1 line\)$/m);
  const merged = JSON.parse(readFileSync(join(work, ".claude/settings.json"), "utf8"));
  assert.equal(merged.model, "opus");
  assert.deepEqual(merged.permissions, settings.permissions);
  assert.deepEqual(merged.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(merged.hooks.PreToolUse, [{ matcher: "Bash", hooks: [own, { type: "command", command: hookCommand("bash-guard") }] },
    { matcher: "Agent|Task", hooks: [{ type: "command", command: hookCommand("agent-cap") }] }]);
  assert.deepEqual(merged.hooks.SessionStart, [{ hooks: [{ type: "command", command: hookCommand("session-env") }, { type: "command", command: hookCommand("context-card") }] }]);
  for (const event of ["PostToolUse", "PostToolUseFailure", "SubagentStart", "SubagentStop"]) assert.equal(merged.hooks[event].length, 1, event);
  const agents = readFileSync(join(work, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# Agents\n\nOur own rules.\nRun `scripts/agents/kit --help` for commands.\n\nKitchen rulebook: `scripts/agents/kit rulebook`"), agents);
  assert.equal(agents.match(/kit --help/g)!.length, 1);
});

test("old kit files stop kit init with a list and nothing is written", (t) => {
  const f = fixture(t);
  const { work } = f.repo("old", { "scripts/agents/kit-lib.sh": "# old\n", "scripts/agents/kit.d/doctor": "#!/bin/sh\n" });
  const before = snapshot(work);
  const run = f.init(work);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(run.stdout, "kit init: this project holds old kit files; remove them on purpose first (the move does):\n" +
    "  scripts/agents/kit-lib.sh\n  scripts/agents/kit.d/\nRESULT: fail init old kit files: scripts/agents/kit-lib.sh, scripts/agents/kit.d/\n");
  assert.deepEqual(snapshot(work), before);
  assert.equal(existsSync(join(f.state, "agent-kit/projects.json")), false);
});

test("with no usual landing branch kit init asks for --land and writes nothing; a broken settings file or a taken name stops it too", (t) => {
  const f = fixture(t);
  const { work } = f.repo("trunk", {}, ["trunk"]);
  const asked = f.init(work);
  assert.equal(asked.status, 2, asked.stdout + asked.stderr);
  assert.equal(result(asked), "RESULT: fail init no dev, develop, main or master branch; name the landing branch with kit init --land <branch>");
  assert.equal(existsSync(join(work, "scripts")), false);
  // --land writes its branch; run in the main checkout, doctor's place check is a note naming how to make a worktree.
  const main = join(f.directory, "trunk");
  const landed = f.init(main, ["--light", "--land", "trunk"]);
  assert.equal(landed.status, 0, landed.stdout + landed.stderr);
  assert.equal(result(landed), "RESULT: ok init wrote 6 files, listed the project; doctor ok but for place (the main checkout; see the note)");
  assert.match(landed.stdout, /^note: place: this is the main checkout, where kit doctor stops builds; build in a worktree \(git worktree add -b <branch> \.\.\/trunk-<branch> trunk\), or add "allowMainCheckout": true to scripts\/agents\/kit\.json to build here$/m);
  assert.doesNotMatch(landed.stdout, /^✗ place/m);
  assert.deepEqual(JSON.parse(readFileSync(join(main, "scripts/agents/kit.json"), "utf8")).branches, { land: "trunk" });
  const usage = f.init(work, ["--land"]);
  assert.equal(usage.status, 2);
  assert.equal(result(usage), "RESULT: fail init --land needs a branch name");
  const badName = f.init(work, ["--land", "a..b"]);
  assert.equal(badName.status, 2);
  assert.equal(result(badName), "RESULT: fail init --land a..b is not a branch name");
  assert.equal(existsSync(join(work, "scripts")), false);

  const broken = f.repo("broken", { ".claude/settings.json": "{ not json" });
  const before = snapshot(broken.work);
  const refused = f.init(broken.work);
  assert.equal(refused.status, 1, refused.stdout + refused.stderr);
  assert.match(result(refused), /^RESULT: fail init \.claude\/settings\.json is unreadable \(.+\); fix it first, kit init never overwrites it$/);
  assert.deepEqual(snapshot(broken.work), before);

  mkdirSync(join(f.state, "agent-kit"), { recursive: true });
  writeFileSync(join(f.state, "agent-kit/projects.json"), JSON.stringify({ taken: { root: "/elsewhere" } }));
  const taken = f.repo("taken", {});
  const clash = f.init(taken.work, ["--light"]);
  assert.equal(clash.status, 1, clash.stdout + clash.stderr);
  assert.equal(result(clash), `RESULT: fail init ${join(f.state, "agent-kit/projects.json")} already lists taken at /elsewhere; give this project another "project" name in scripts/agents/kit.json`);
  assert.equal(existsSync(join(taken.work, "scripts")), false);
  assert.deepEqual(f.projects(), { taken: { root: "/elsewhere" } });
});

test("checks are guessed from package.json as its lockfile's package manager runs them", (t) => {
  const f = fixture(t);
  const cases: [string, Record<string, string>, Record<string, string>, string][] = [
    ["pnpm", { "pnpm-lock.yaml": "" }, { check: "tsc" }, "check=pnpm run check"],
    ["yarn", { "yarn.lock": "" }, { test: "vitest" }, "test=yarn test"],
    ["bun", { "bun.lockb": "" }, { lint: "eslint ." }, "lint=bun run lint"],
    // typecheck stands in for check; npm's placeholder test is no test.
    ["npm", {}, { typecheck: "tsc", test: "echo \"Error: no test specified\" && exit 1" }, "check=npm run typecheck"],
  ];
  for (const [name, lockfile, scripts, guessed] of cases) {
    const { work } = f.repo(name, { ...lockfile, "package.json": JSON.stringify({ scripts }) });
    const run = f.init(work, ["--light"]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, new RegExp(`^note: checks guessed from package\\.json: ${guessed}; confirm`, "m"), name);
    const [key, command] = guessed.split("=");
    assert.deepEqual(JSON.parse(readFileSync(join(work, "scripts/agents/kit.json"), "utf8")).checks, { [key]: command }, name);
  }
});

test("an existing kit.json is kept byte for byte with notes; a failing doctor fails init, and what it wrote stays", (t) => {
  const f = fixture(t);
  const settings = `{"project":"mine","branches":{"land":"dev"},"checks":{"doctor":"exit 3"}}`;
  const { main, work } = f.repo("mine-folder", { "scripts/agents/kit.json": settings });
  const run = f.init(work, ["--land", "dev"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(result(run), "RESULT: fail init wrote 9 files, listed the project; doctor 1 failed: exit 3");
  assert.equal(readFileSync(join(work, "scripts/agents/kit.json"), "utf8"), settings);
  assert.match(run.stdout, /^note: --land ignored: scripts\/agents\/kit\.json already names "branches"$/m);
  assert.match(run.stdout, /^note: add to scripts\/agents\/kit\.json \(kit init never edits it\): "commands": "scripts\/agents\/project\.d", "maps": "docs\/wayfinder", "rulebookExtras": "docs\/agents\/kitchen-extras\.md"$/m);
  assert.equal(written(run).length, 9);
  for (const path of written(run)) assert.ok(existsSync(join(work, path)), path);
  assert.deepEqual(f.projects(), { mine: { root: main } });
});

test("an existing .codex/hooks.json keeps its own entries, and a kit hook under another matcher is not added twice", (t) => {
  const f = fixture(t);
  const own = { type: "command", command: "echo mine" }, guard = { type: "command", command: hookCommand("bash-guard") };
  const codex = { hooks: { PreToolUse: [{ matcher: "Bash|Edit", hooks: [guard] }], SessionStart: [{ hooks: [own] }] } };
  const { main, work } = f.repo("hooks", { ".codex/hooks.json": JSON.stringify(codex) });
  // An origin named host:repo style still names the project after the repo.
  const origin = join(f.directory, "host:shop.git");
  f.git(f.directory, "init", "-q", "--bare", origin);
  f.git(main, "remote", "add", "origin", origin);
  f.git(main, "push", "-q", "origin", "main", "dev");
  const run = f.init(work, ["--light"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^wrote \.codex\/hooks\.json \(merged 4 hook entries\)$/m);
  assert.equal(JSON.parse(readFileSync(join(work, "scripts/agents/kit.json"), "utf8")).project, "shop");
  const merged = JSON.parse(readFileSync(join(work, ".codex/hooks.json"), "utf8"));
  assert.deepEqual(merged.hooks.PreToolUse, codex.hooks.PreToolUse);
  assert.deepEqual(merged.hooks.SessionStart, [{ hooks: [own, { type: "command", command: hookCommand("session-env") }, { type: "command", command: hookCommand("context-card") }] }]);
  for (const event of ["SubagentStart", "SubagentStop"]) assert.deepEqual(merged.hooks[event], [{ hooks: [{ type: "command", command: hookCommand("agent-cap") }] }], event);
});

test("a write that fails ends with a RESULT line naming it and what was written, and lists nothing", (t) => {
  const f = fixture(t);
  // A file named docs where the docs folder should be.
  const { work } = f.repo("blocked", { docs: "not a folder\n" });
  const run = f.init(work);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(result(run), /^RESULT: fail init writing docs\/agents\/kitchen\.md failed: E[A-Z]+: .+; wrote scripts\/agents\/kit\.json, scripts\/agents\/kit, scripts\/agents\/hooks\/run\.sh, \.claude\/settings\.json, \.codex\/hooks\.json, scripts\/agents\/project\.d\/\.gitkeep$/);
  assert.doesNotMatch(run.stderr, /at .+\(node:/);
  assert.equal(existsSync(join(f.state, "agent-kit/projects.json")), false);
});

test("a broken package.json, hook file or project list stops kit init with nothing written", (t) => {
  const f = fixture(t);
  const cases: [string, Record<string, string>, RegExp][] = [
    ["package", { "package.json": "{" }, /^RESULT: fail init package\.json is unreadable \(.+\); fix it first, kit init never overwrites it$/],
    ["codex-list", { ".codex/hooks.json": "[]" }, /^RESULT: fail init \.codex\/hooks\.json must hold one JSON object; fix it first, kit init never overwrites it$/],
    ["hooks-list", { ".claude/settings.json": JSON.stringify({ hooks: [] }) }, /^RESULT: fail init "hooks" in \.claude\/settings\.json must be an object; fix it first, kit init never overwrites it$/],
    ["event-object", { ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: {} } }) }, /^RESULT: fail init "hooks\.PreToolUse" in \.claude\/settings\.json must be a list; fix it first, kit init never overwrites it$/],
  ];
  for (const [name, files, expected] of cases) {
    const { work } = f.repo(name, files);
    const before = snapshot(work);
    const run = f.init(work);
    assert.equal(run.status, 1, `${name}: ${run.stdout}${run.stderr}`);
    assert.match(result(run), expected, name);
    assert.deepEqual(snapshot(work), before, name);
  }
  assert.equal(existsSync(join(f.state, "agent-kit/projects.json")), false);

  const list = join(f.state, "agent-kit/projects.json");
  mkdirSync(join(f.state, "agent-kit"), { recursive: true });
  writeFileSync(list, "{");
  const { work } = f.repo("listed", {});
  const before = snapshot(work);
  const run = f.init(work);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(result(run), new RegExp(`^RESULT: fail init ${list.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is unreadable: `));
  assert.deepEqual(snapshot(work), before);
  assert.equal(existsSync(`${list}.lock`), false);
  assert.equal(readFileSync(list, "utf8"), "{");
});

test("--land names a branch not made yet with a note", (t) => {
  const f = fixture(t);
  const { work } = f.repo("later", {});
  const run = f.init(work, ["--light", "--land", "release"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^note: branch release is not here or on origin yet; kit doctor's base check needs origin\/release once the project has a GitHub repo$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(work, "scripts/agents/kit.json"), "utf8")).branches, { land: "release" });
});

test("the stubs go where an existing kit.json points, and allowMainCheckout lets doctor pass in the main checkout", (t) => {
  const f = fixture(t);
  const settings = { project: "own-paths", branches: { land: "dev" }, allowMainCheckout: true,
    commands: "tools/kit", maps: "plans/", rulebookExtras: "docs/kitchen.local.md" };
  const { main } = f.repo("own-paths", { "scripts/agents/kit.json": JSON.stringify(settings) });
  const run = f.init(main);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(result(run), /^RESULT: ok init wrote 9 files, listed the project; doctor (\d+)\/\1 checks passed$/);
  assert.doesNotMatch(run.stdout, /^note: (place|add to)/m);
  assert.match(run.stdout, /^✓ place: .+ \(main checkout; allowMainCheckout\)$/m);
  for (const path of ["tools/kit/.gitkeep", "plans/README.md", "docs/kitchen.local.md", "docs/agents/kitchen.md"]) assert.ok(written(run).includes(path), path);
  for (const path of ["scripts/agents/project.d", "docs/wayfinder", "docs/agents/kitchen-extras.md"]) assert.equal(existsSync(join(main, path)), false, path);
  assert.match(readFileSync(join(main, "docs/agents/kitchen.md"), "utf8"), /\[docs\/kitchen\.local\.md\]\(\.\.\/kitchen\.local\.md\)/);
  assert.match(readFileSync(join(main, "plans/README.md"), "utf8"), /`plans\/<map>\/`/);
});

test("kitRegisterProject lists nothing when during() throws, and a failed write leaves no temporary file or lock", (t) => {
  const f = fixture(t);
  const env = { ...f.env, XDG_STATE_HOME: f.state };
  const list = join(f.state, "agent-kit/projects.json");
  assert.equal(kitRegisterProject("a", "/a", env), "added");
  const listed = readFileSync(list, "utf8");
  assert.throws(() => kitRegisterProject("x", "/r", env, () => { throw new Error("boom"); }), /^Error: boom$/);
  assert.equal(readFileSync(list, "utf8"), listed);
  assert.equal(existsSync(`${list}.lock`), false);
  // projects.json replaced by a folder after it was read: the rename fails, and its temporary file goes.
  assert.throws(() => kitRegisterProject("y", "/y", env, () => { rmSync(list); mkdirSync(list); }),
    (error: Error) => error.message.startsWith(`cannot write ${list}: E`));
  assert.deepEqual(readdirSync(join(f.state, "agent-kit")), ["projects.json"]);
});

test("a file changed or made while kit init runs is never overwritten", (t) => {
  const f = fixture(t);
  // A library that edits one file just before init's writes, as another writer would between its check and write.
  const wrapper = join(f.directory, "edit-lib.mjs");
  writeFileSync(wrapper, `export * from ${JSON.stringify(join(f.kit, "kit-lib.mjs"))};
import { kitRegisterProject as register } from ${JSON.stringify(join(f.kit, "kit-lib.mjs"))};
import { writeFileSync } from "node:fs";
export function kitRegisterProject(name, root, env, during) {
  return register(name, root, env, () => { writeFileSync(process.env.EDIT_FILE, process.env.EDIT_TEXT); during(); });
}
`);
  const cases: [string, Record<string, string>, string, RegExp][] = [
    ["merged", { ".claude/settings.json": "{}" }, ".claude/settings.json",
      /^RESULT: fail init writing \.claude\/settings\.json failed: it changed while kit init ran; run kit init again; wrote scripts\/agents\/kit\.json, scripts\/agents\/kit, scripts\/agents\/hooks\/run\.sh$/],
    ["made", {}, "scripts/agents/kit", /^RESULT: fail init writing scripts\/agents\/kit failed: EEXIST: .+; wrote scripts\/agents\/kit\.json$/],
  ];
  for (const [name, files, edited, expected] of cases) {
    const { work } = f.repo(name, files);
    mkdirSync(join(work, "scripts/agents"), { recursive: true });
    const run = spawnSync(join(f.kit, "kit.d/init"), [], { cwd: work, encoding: "utf8", timeout: 60_000,
      env: { ...f.env, KIT_ROOT: work, KIT_HOME: f.kit, KIT_LIB_MJS: wrapper, EDIT_FILE: join(work, edited), EDIT_TEXT: "edited\n" } });
    assert.equal(run.status, 1, `${name}: ${run.stdout}${run.stderr}`);
    assert.match(result(run), expected, name);
    assert.equal(readFileSync(join(work, edited), "utf8"), "edited\n", name);
    assert.deepEqual(readdirSync(join(work, edited, "..")).filter((file) => file.endsWith(".tmp")), [], name);
  }
});

test("an AGENTS.md that cannot be read stops kit init with a plain RESULT line and nothing written", (t) => {
  const f = fixture(t);
  const { work } = f.repo("folder", { "AGENTS.md/notes": "a folder named AGENTS.md\n" });
  const before = snapshot(work);
  const run = f.init(work);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(result(run), /^RESULT: fail init AGENTS\.md is unreadable \(EISDIR: .+\); fix it first, kit init never overwrites it$/);
  assert.doesNotMatch(run.stderr, /at .+\(node:/);
  assert.deepEqual(snapshot(work), before);
});

// An Issue as `gh issue list --json …` gives it, with the state the fake filters on.
type GhIssue = {
  number: number; title: string; state: "OPEN" | "CLOSED"; url: string; author: { login: string }; createdAt: string; body: string;
  labels: { name: string }[]; comments: { author: { login: string }; createdAt: string; body: string }[];
};
// A fake gh on PATH: `issue list` prints the open Issues from issues.json (or list-output.txt as it is, or fails
// with list-error.txt), `issue close` marks one closed (a number listed in fail-close.json fails once instead);
// every call is logged as one JSON line in calls.log.
function fakeGh(f: ReturnType<typeof fixture>, issues: GhIssue[]) {
  const bin = join(f.directory, "fake-gh");
  mkdirSync(bin);
  writeFileSync(join(bin, "issues.json"), JSON.stringify(issues));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const store = ${JSON.stringify(join(bin, "issues.json"))}, args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(bin, "calls.log"))}, JSON.stringify(args) + "\\n");
const issues = JSON.parse(readFileSync(store, "utf8"));
const listError = ${JSON.stringify(join(f.directory, "fake-gh/list-error.txt"))}, listOutput = ${JSON.stringify(join(f.directory, "fake-gh/list-output.txt"))};
if (args[0] === "issue" && args[1] === "list" && existsSync(listError)) { process.stderr.write(readFileSync(listError, "utf8")); process.exit(1); }
else if (args[0] === "issue" && args[1] === "list" && existsSync(listOutput)) process.stdout.write(readFileSync(listOutput, "utf8"));
else if (args[0] === "issue" && args[1] === "list") process.stdout.write(JSON.stringify(issues.filter((issue) => issue.state === "OPEN")));
else if (args[0] === "issue" && args[1] === "close") {
  const failing = ${JSON.stringify(join(f.directory, "fake-gh/fail-close.json"))};
  const once = existsSync(failing) ? JSON.parse(readFileSync(failing, "utf8")) : [];
  if (once.includes(args[2])) { writeFileSync(failing, JSON.stringify(once.filter((n) => n !== args[2]))); process.stderr.write("HTTP 502: try later\\nmore"); process.exit(1); }
  issues.find((issue) => issue.number === Number(args[2])).state = "CLOSED";
  writeFileSync(store, JSON.stringify(issues));
} else { process.stderr.write("unexpected gh " + args.join(" ")); process.exit(1); }
`, { mode: 0o755 });
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}` };
  const init = (cwd: string, args: string[]) => spawnSync(join(f.directory, "data/agent-kit/current/kit"), ["init", ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
  const calls = () => existsSync(join(bin, "calls.log"))
    ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
  const add = (...more: GhIssue[]) => writeFileSync(join(bin, "issues.json"), JSON.stringify([...JSON.parse(readFileSync(join(bin, "issues.json"), "utf8")), ...more]));
  return { init, calls, add, closes: () => calls().filter((args) => args[1] === "close") };
}
const issue = (number: number, title: string, extra: Partial<GhIssue> = {}): GhIssue => ({ number, title, state: "OPEN", url: `https://github.com/acme/tools/issues/${number}`,
  author: { login: "lex" }, createdAt: "2026-10-01T10:00:00Z", body: "", labels: [], comments: [], ...extra });
const issueRepo = (f: ReturnType<typeof fixture>, settings = JSON.stringify({ project: "tools", branches: { land: "dev" }, maps: "docs/wayfinder" })) => {
  const repo = f.repo("tools", { "scripts/agents/kit.json": settings });
  const origin = join(f.directory, "origin.git");
  f.git(f.directory, "init", "-q", "--bare", origin);
  f.git(repo.main, "remote", "add", "origin", origin);
  f.git(repo.main, "push", "-q", "origin", "main", "dev");
  return repo;
};
const backlog = "docs/wayfinder/backlog";

test("--issues writes one valid needs-triage ticket per open Issue and the map, closes nothing, and a rerun writes nothing new", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const gh = fakeGh(f, [
    issue(14, "Search: results ignore accents!", { body: "Typing *café* finds nothing.\n\nSteps: search `café`.", labels: [{ name: "bug" }, { name: "search" }, { name: "a`b" }],
      comments: [{ author: { login: "sam" }, createdAt: "2026-10-02T09:00:00Z", body: "Same on mobile." }] }),
    issue(3, "Add a \"dark mode\" toggle: #2 # not a comment"),
    issue(9, "Closed already", { state: "CLOSED" }),
  ]);
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(result(run), "RESULT: ok init issues wrote 2 tickets and the map; nothing closed");
  assert.deepEqual(written(run), [`${backlog}/map.md`, `${backlog}/tickets/01-add-a-dark-mode-toggle-2.md`, `${backlog}/tickets/02-search-results-ignore-accents.md`]);
  assert.match(run.stdout, /^next: land docs\/wayfinder\/backlog on dev, then run kit init --issues --close to close the 2 Issues with a link to each file$/m);
  assert.deepEqual(gh.calls(), [["issue", "list", "--state", "open", "--limit", "1000", "--json", "number,title,body,labels,url,author,createdAt,comments"]]);
  assert.doesNotMatch(run.stdout, /^note: add "maps"/m);
  assert.equal(readFileSync(join(work, `${backlog}/tickets/02-search-results-ignore-accents.md`), "utf8"), `---
title: "Search: results ignore accents!"
type: task (AFK)
status: needs-triage
assignee:
blocked_by: []
issue: https://github.com/acme/tools/issues/14
---

## Issue

From GitHub Issue [acme/tools#14](https://github.com/acme/tools/issues/14), opened by lex on 2026-10-01.

Labels: \`bug\`, \`search\`, \`\` a\`b \`\`

Typing *café* finds nothing.

Steps: search \`café\`.

## Comments

**sam, 2026-10-02:**

Same on mobile.
`);
  const quiet = readFileSync(join(work, `${backlog}/tickets/01-add-a-dark-mode-toggle-2.md`), "utf8");
  assert.match(quiet, /^title: "Add a \\"dark mode\\" toggle: #2 # not a comment"$/m);
  assert.match(quiet, /^Labels: none\n\n_\(no text\)_\n\n## Comments\n\nNone\.\n$/m);
  assert.match(readFileSync(join(work, `${backlog}/map.md`), "utf8"), /^label: wayfinder:map\ntitle: Backlog\n/m);
  // The files pass the kit's own ticket check, titles read back as written.
  const check = spawnSync(process.execPath, [join(f.kit, "tickets.mjs"), "check"], { cwd: work, env: f.env, encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /^Tickets checked: 2$/m);
  const frontier = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { loadTickets } from ${JSON.stringify(join(f.kit, "tickets.mjs"))}; console.log(JSON.stringify(loadTickets("docs/wayfinder").tickets.map((t) => [t.title, t.status, t.type])));`],
    { cwd: work, env: f.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(frontier.stdout), [["Add a \"dark mode\" toggle: #2 # not a comment", "needs-triage", "task (AFK)"], ["Search: results ignore accents!", "needs-triage", "task (AFK)"]]);

  const before = snapshot(work);
  const again = gh.init(work, ["--issues"]);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.equal(result(again), "RESULT: ok init issues nothing new (2 open Issues have a file)");
  assert.deepEqual(written(again), []);
  assert.deepEqual(snapshot(work), before);
  // A new Issue later gets the next number; the two with files are skipped.
  gh.add(issue(20, "Ünïcode only ✓"));
  const third = gh.init(work, ["--issues"]);
  assert.equal(result(third), "RESULT: ok init issues wrote 1 ticket, skipped 2 with a file; nothing closed");
  assert.deepEqual(written(third), [`${backlog}/tickets/03-unicode-only.md`]);
});

test("--issues --close refuses until the files are on origin's landing branch, then closes each Issue with a link to its file", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const gh = fakeGh(f, [issue(5, "First"), issue(7, "Second")]);
  assert.equal(gh.init(work, ["--issues"]).status, 0);

  // Written here but not landed: nothing closes.
  const early = gh.init(work, ["--issues", "--close"]);
  assert.equal(early.status, 1, early.stdout + early.stderr);
  assert.equal(result(early), "RESULT: fail init closed nothing: 2 open Issues have no ticket file on origin/dev (#5, #7); run kit init --issues and land docs/wayfinder/backlog/tickets on dev first");
  assert.match(early.stdout, /^not on origin\/dev: #5 First$/m);
  assert.equal(gh.calls().filter((args) => args[1] === "close").length, 0);

  // Landed on a build branch only, or partly: still nothing closes.
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:build/one");
  const branchOnly = gh.init(work, ["--issues", "--close"]);
  assert.equal(branchOnly.status, 1, branchOnly.stdout);
  assert.equal(gh.calls().filter((args) => args[1] === "close").length, 0);

  f.git(work, "push", "-q", "origin", "HEAD:dev");
  const close = gh.init(work, ["--issues", "--close"]);
  assert.equal(close.status, 0, close.stdout + close.stderr);
  assert.equal(result(close), "RESULT: ok init issues closed 2 Issues with a link to each file on dev");
  const link = (file: string) => `https://github.com/acme/tools/blob/dev/${backlog}/tickets/${file}`;
  assert.deepEqual(gh.calls().filter((args) => args[1] === "close"), [
    ["issue", "close", "5", "--repo", "acme/tools", "--comment", `Moved to a ticket file: ${link("01-first.md")}\nWork on it goes on there.`],
    ["issue", "close", "7", "--repo", "acme/tools", "--comment", `Moved to a ticket file: ${link("02-second.md")}\nWork on it goes on there.`],
  ]);
  assert.match(close.stdout, new RegExp(`^closed #5 → ${link("01-first.md").replaceAll(".", "\\.")}$`, "m"));
  // A rerun finds no open Issue and closes nothing more.
  const again = gh.init(work, ["--issues", "--close"]);
  assert.equal(result(again), "RESULT: ok init issues no open Issues to close");
  assert.equal(gh.calls().filter((args) => args[1] === "close").length, 2);
});

test("--close needs --issues, and --issues takes no setup flags", (t) => {
  const f = fixture(t);
  const { work } = f.repo("flags", {});
  for (const [args, text] of [[["--close"], "--close goes with --issues"], [["--issues", "--light"], "--issues takes only --close"],
    [["--issues", "--land", "dev"], "--issues takes only --close"]] as const) {
    const run = f.init(work, [...args]);
    assert.equal(run.status, 2, run.stdout + run.stderr);
    assert.equal(result(run), `RESULT: fail init ${text}`);
  }
  assert.deepEqual(readdirSync(work).filter((name) => name !== ".git"), []);
});

test("a link to another Issue in the copied text never stands for that Issue's file, on a rerun or on --close", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const gh = fakeGh(f, [issue(3, "Old crash", { body: "Duplicate of [#5](https://github.com/acme/tools/issues/5)",
    comments: [{ author: { login: "sam" }, createdAt: "2026-10-02T09:00:00Z", body: "See [#5](https://github.com/acme/tools/issues/5)." }] })]);
  assert.equal(gh.init(work, ["--issues"]).status, 0);
  // #5 opens later: the rerun gives it its own file instead of taking #3's link for one.
  gh.add(issue(5, "New crash"));
  const rerun = gh.init(work, ["--issues"]);
  assert.equal(result(rerun), "RESULT: ok init issues wrote 1 ticket, skipped 1 with a file; nothing closed", rerun.stdout + rerun.stderr);
  assert.deepEqual(written(rerun), [`${backlog}/tickets/02-new-crash.md`]);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  const close = gh.init(work, ["--issues", "--close"]);
  assert.equal(close.status, 0, close.stdout + close.stderr);
  assert.deepEqual(gh.closes().map((args) => [args[2], args[6].split("\n")[0]]), [
    ["3", `Moved to a ticket file: https://github.com/acme/tools/blob/dev/${backlog}/tickets/01-old-crash.md`],
    ["5", `Moved to a ticket file: https://github.com/acme/tools/blob/dev/${backlog}/tickets/02-new-crash.md`],
  ]);
});

test("a close that fails is named, the run fails, and a rerun closes only that Issue", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const gh = fakeGh(f, [issue(5, "First"), issue(7, "Second")]);
  assert.equal(gh.init(work, ["--issues"]).status, 0);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  writeFileSync(join(f.directory, "fake-gh/fail-close.json"), JSON.stringify(["7"]));
  const first = gh.init(work, ["--issues", "--close"]);
  assert.equal(first.status, 1, first.stdout + first.stderr);
  assert.match(first.stdout, /^close failed: #7: HTTP 502: try later$/m);
  assert.equal(result(first), "RESULT: fail init closed 1 of 2 Issues; failed: #7; rerun to retry them");
  const retry = gh.init(work, ["--issues", "--close"]);
  assert.equal(result(retry), "RESULT: ok init issues closed 1 Issue with a link to each file on dev", retry.stdout + retry.stderr);
  assert.deepEqual(gh.closes().map((args) => args[2]), ["5", "7", "7"]);
});

test("without \"maps\" in kit.json the backlog goes under docs/wayfinder with a note, and a maps path outside the project is refused", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f, JSON.stringify({ project: "tools", branches: { land: "dev" } }));
  const gh = fakeGh(f, [issue(1, "Only one")]);
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(written(run), [`${backlog}/map.md`, `${backlog}/tickets/01-only-one.md`]);
  assert.match(run.stdout, /^note: add "maps": "docs\/wayfinder" to scripts\/agents\/kit\.json so the kit reads the backlog \(kit init never edits it\)$/m);
  for (const maps of ["../elsewhere", "/tmp/maps"]) {
    writeFileSync(join(work, "scripts/agents/kit.json"), JSON.stringify({ project: "tools", branches: { land: "dev" }, maps }));
    const outside = gh.init(work, ["--issues"]);
    assert.equal(outside.status, 1, outside.stdout + outside.stderr);
    assert.equal(result(outside), `RESULT: fail init "maps" in scripts/agents/kit.json must be a folder inside the project: ${maps}`);
  }
});

test("copied text gets LF endings and its top headings moved down, so they never become the ticket's own sections", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const body = "Crash on save.\r\n## Files\r\n- `src/save.ts`\r\n# Steps\r\n```sh\r\n# keep this shell comment\r\n## and this\r\n```\r\n### Deeper stays";
  const comments = Array.from({ length: 100 }, (_, n) => ({ author: { login: "sam" }, createdAt: "2026-10-02T09:00:00Z", body: n ? `+${n}` : "## Comments\r\nme too" }));
  const gh = fakeGh(f, [issue(8, "Save crash", { body, comments })]);
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^note: #8 has 100 or more comments; its file says to read the rest on GitHub$/m);
  const text = readFileSync(join(work, `${backlog}/tickets/01-save-crash.md`), "utf8");
  assert.doesNotMatch(text, /\r/);
  assert.ok(text.includes("Crash on save.\n#### Files\n- `src/save.ts`\n### Steps\n```sh\n# keep this shell comment\n## and this\n```\n### Deeper stays\n"), text);
  assert.ok(text.includes("**sam, 2026-10-02:**\n\n#### Comments\nme too"), text);
  assert.deepEqual(text.match(/^## .*/gm), ["## Issue", "## and this", "## Comments"]);
  assert.match(text, /\n_Only the first 100 comments were copied; read the rest on the Issue\._\n$/);
  const files = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { loadTickets } from ${JSON.stringify(join(f.kit, "tickets.mjs"))}; console.log(JSON.stringify(loadTickets("docs/wayfinder").tickets.map((t) => t.files)));`],
    { cwd: work, env: f.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(files.stdout), [[]]);
});

test("--close works on another GitHub host and after the repo was renamed, and needs a landing branch", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const ghe = "https://ghe.example/acme/tools/issues/4";
  const gh = fakeGh(f, [issue(4, "On our own host", { url: ghe }), issue(6, "Before the rename")]);
  assert.equal(gh.init(work, ["--issues"]).status, 0);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  // The repo is renamed: gh now gives #6 a new link, and a rerun still finds its file.
  const store = join(f.directory, "fake-gh/issues.json");
  writeFileSync(store, readFileSync(store, "utf8").replace("acme/tools/issues/6", "acme/tools-renamed/issues/6"));
  const rerun = gh.init(work, ["--issues"]);
  assert.equal(result(rerun), "RESULT: ok init issues nothing new (2 open Issues have a file)", rerun.stdout + rerun.stderr);

  const settings = join(work, "scripts/agents/kit.json");
  writeFileSync(settings, JSON.stringify({ project: "tools" }));
  const noLand = gh.init(work, ["--issues", "--close"]);
  assert.equal(noLand.status, 1, noLand.stdout + noLand.stderr);
  assert.equal(result(noLand), 'RESULT: fail init --close needs scripts/agents/kit.json with "branches": { "land": "<branch>" }; run kit init first');
  assert.deepEqual(gh.closes(), []);

  writeFileSync(settings, JSON.stringify({ project: "tools", branches: { land: "dev" }, maps: "docs/wayfinder" }));
  const close = gh.init(work, ["--issues", "--close"]);
  assert.equal(close.status, 0, close.stdout + close.stderr);
  assert.match(close.stdout, /^note: #6's file docs\/wayfinder\/backlog\/tickets\/02-before-the-rename\.md names https:\/\/github\.com\/acme\/tools\/issues\/6; GitHub now gives https:\/\/github\.com\/acme\/tools-renamed\/issues\/6$/m);
  assert.deepEqual(gh.closes().map((args) => args.slice(0, 5).concat(args[6].split("\n")[0])), [
    ["issue", "close", "4", "--repo", "ghe.example/acme/tools", `Moved to a ticket file: https://ghe.example/acme/tools/blob/dev/${backlog}/tickets/01-on-our-own-host.md`],
    ["issue", "close", "6", "--repo", "acme/tools-renamed", `Moved to a ticket file: https://github.com/acme/tools-renamed/blob/dev/${backlog}/tickets/02-before-the-rename.md`],
  ]);
});

test("--issues runs beside old kit files, and a failing or odd gh issue list writes nothing", (t) => {
  const f = fixture(t);
  const { work } = f.repo("old", { "scripts/agents/kit-lib.sh": "# old\n", "scripts/agents/kit.json": JSON.stringify({ project: "old", branches: { land: "dev" }, maps: "docs/wayfinder" }) });
  const gh = fakeGh(f, [issue(1, "Kept")]);
  const bin = join(f.directory, "fake-gh");
  writeFileSync(join(bin, "list-error.txt"), "HTTP 401: Bad credentials\nmore");
  const denied = gh.init(work, ["--issues"]);
  assert.equal(denied.status, 1, denied.stdout + denied.stderr);
  assert.equal(result(denied), "RESULT: fail init gh issue list failed: HTTP 401: Bad credentials");
  rmSync(join(bin, "list-error.txt"));
  for (const [output, text] of [["not json", /^RESULT: fail init gh issue list gave no JSON list \(/], ["{}", /^RESULT: fail init gh issue list gave no JSON list$/],
    [JSON.stringify(Array.from({ length: 1000 }, (_, n) => issue(n + 1, `Issue ${n + 1}`))), /^RESULT: fail init 1000 or more open Issues; kit init --issues reads at most 999$/]] as const) {
    writeFileSync(join(bin, "list-output.txt"), output);
    const odd = gh.init(work, ["--issues"]);
    assert.equal(odd.status, 1, odd.stdout + odd.stderr);
    assert.match(result(odd), text);
  }
  assert.equal(existsSync(join(work, "docs")), false);
  rmSync(join(bin, "list-output.txt"));
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(written(run), [`${backlog}/map.md`, `${backlog}/tickets/01-kept.md`]);
});
