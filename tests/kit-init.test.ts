import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { kitFiles } from "./support/kit-files.ts";
import { ghConfig } from "./support/kit-env.ts";
import { kitRegisterProject } from "../kit-lib.mjs";

const launchers = resolve("launcher");
type After = { after: (fn: () => void) => void };

// A fake machine kit (a copy of this kit as kit update leaves it, with current and updated) and temporary
// HOME and XDG folders, so nothing reaches the real ~/.local; a git repo per test, worked on in a worktree.
function fixture(t: After) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "kit-init-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = join(directory, "data/agent-kit"), state = join(directory, "state");
  const kit = join(data, "0123456789abcdef0123456789abcdef01234567");
  cpSync(resolve("."), kit, { recursive: true, filter: kitFiles });
  symlinkSync(kit, join(data, "current"));
  writeFileSync(join(data, "updated"), `${Math.floor(Date.now() / 1000)}\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: directory, XDG_DATA_HOME: join(directory, "data"), XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: state, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", CLAUDE_PROJECT_DIR: "", KIT_GROK: join(directory, "no-grok") };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_DEV_ROOT", "KIT_LIB", "KIT_LIB_MJS", "KIT_HOME", "KIT_HOME_DEFAULT", "KIT_HOME_PINNED",
    "KIT_COMMANDS_DIR", "KIT_PLAYWRIGHT_MODULE", "KIT_PLAYWRIGHT_MODULE_DEFAULT", "KIT_DOCTOR_SKIP", "ASE_OWNER", "NODE_TEST_CONTEXT"]) delete env[name];
  // gh's config is the fixture one (it knows ghe.example), and no GH_REPO or GH_HOST comes from the shell.
  Object.assign(env, { GH_CONFIG_DIR: ghConfig }); delete env.GH_REPO; delete env.GH_HOST;
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
  assert.match(result(run), /^RESULT: ok init wrote 11 files, listed the project; doctor (\d+)\/\1 checks passed$/);
  assert.deepEqual(written(run), [".claude/settings.json", ".codex/hooks.json", ".gitattributes", "AGENTS.md", "docs/agents/kitchen-extras.md", "docs/agents/kitchen.md",
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
  // The pointer sends a wanted kit change to the one board that builds kit changes.
  assert.match(readFileSync(join(work, "docs/agents/kitchen.md"), "utf8"),
    /^A change to the shared kit is a ticket on the kitchen-everywhere board\s+\(`docs\/wayfinder\/kitchen-everywhere\/build\/` in native-site-editor, on `dev`\),\s+built only by that\s+board's orchestrator: write it there, or ask the orchestrator to, and go on with this project's work\.$/m);
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

test("on a machine with no kit, the hook launcher kit init wrote warns on every hook and exits 0, never blocking", (t) => {
  const f = fixture(t);
  const { work } = f.repo("site", { "package.json": "{}" });
  const run = f.init(work);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // Another machine: empty HOME and XDG folders, so no machine copy and no cache clone, and no KIT_HOME.
  const bare = join(f.directory, "bare");
  mkdirSync(bare);
  const env = { ...f.env, HOME: bare, XDG_DATA_HOME: join(bare, "data"), XDG_CACHE_HOME: join(bare, "cache"), XDG_STATE_HOME: join(bare, "state"), CLAUDE_PROJECT_DIR: work };
  const warning = "Agent Kit not found: guards are off; run `scripts/agents/kit doctor`";
  // Each hook as .claude/settings.json runs it, with a payload that a kit's guard would block.
  const commands = (Object.values(JSON.parse(readFileSync(join(work, ".claude/settings.json"), "utf8")).hooks) as { hooks: { command: string }[] }[][])
    .flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
  const payload = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git stash pop" } });
  for (const [name, stdout] of [["bash-guard", `{"systemMessage":"${warning}"}\n`], ["agent-cap", `{"systemMessage":"${warning}"}\n`],
    ["session-env", `${warning}\n`], ["context-card", ""]]) {
    assert.ok(commands.includes(hookCommand(name)), name);
    const hook = spawnSync("bash", ["-c", hookCommand(name)], { cwd: work, env, input: payload, encoding: "utf8", timeout: 10_000 });
    assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, stdout, ""], name);
  }
  assert.equal(existsSync(join(bare, "cache")), false);
  assert.equal(existsSync(join(bare, "data")), false);
});

test("a repo with no package.json gets a light setup that passes doctor and writes less than full", (t) => {
  const f = fixture(t);
  const light = f.repo("plain", { "index.html": "<p>hi</p>\n" }, ["main"]);
  const run = f.init(light.work, ["--light"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(result(run), /^RESULT: ok init wrote 7 files, listed the project; doctor (\d+)\/\1 checks passed$/);
  assert.match(run.stdout, /^note: checks: none guessed \(no package\.json\); add "checks" to scripts\/agents\/kit\.json$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(light.work, "scripts/agents/kit.json"), "utf8")), { project: "plain", mainRoot: light.main, branches: { land: "main" } });
  const full = f.repo("plain-full", { "index.html": "<p>hi</p>\n" }, ["main"]);
  const fullRun = f.init(full.work);
  assert.equal(fullRun.status, 0, fullRun.stdout + fullRun.stderr);
  const lightFiles = written(run), fullFiles = written(fullRun);
  assert.deepEqual(lightFiles, [".claude/settings.json", ".codex/hooks.json", ".gitattributes", "AGENTS.md", "scripts/agents/hooks/run.sh", "scripts/agents/kit", "scripts/agents/kit.json"]);
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
  assert.equal(result(landed), "RESULT: ok init wrote 7 files, listed the project; doctor ok but for place (the main checkout; see the note)");
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

test("an existing kit.json is kept byte for byte with notes (--full on one that names no full piece); a failing doctor fails init, and what it wrote stays", (t) => {
  const f = fixture(t);
  const settings = `{"project":"mine","branches":{"land":"dev"},"checks":{"doctor":"exit 3"}}`;
  const { main, work } = f.repo("mine-folder", { "scripts/agents/kit.json": settings });
  const run = f.init(work, ["--land", "dev", "--full"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(result(run), "RESULT: fail init wrote 10 files, listed the project; doctor 1 failed: exit 3");
  assert.equal(readFileSync(join(work, "scripts/agents/kit.json"), "utf8"), settings);
  assert.match(run.stdout, /^note: --land ignored: scripts\/agents\/kit\.json already names "branches"$/m);
  assert.match(run.stdout, /^note: add to scripts\/agents\/kit\.json \(kit init never edits it\): "commands": "scripts\/agents\/project\.d", "maps": "docs\/wayfinder", "rulebookExtras": "docs\/agents\/kitchen-extras\.md"$/m);
  assert.equal(written(run).length, 10);
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
  assert.match(result(run), /^RESULT: ok init wrote 10 files, listed the project; doctor (\d+)\/\1 checks passed$/);
  assert.doesNotMatch(run.stdout, /^note: (place|add to)/m);
  assert.match(run.stdout, /^✓ place: .+ \(main checkout; allowMainCheckout\)$/m);
  for (const path of ["tools/kit/.gitkeep", "plans/README.md", "docs/kitchen.local.md", "docs/agents/kitchen.md"]) assert.ok(written(run).includes(path), path);
  for (const path of ["scripts/agents/project.d", "docs/wayfinder", "docs/agents/kitchen-extras.md"]) assert.equal(existsSync(join(main, path)), false, path);
  assert.match(readFileSync(join(main, "docs/agents/kitchen.md"), "utf8"), /\[docs\/kitchen\.local\.md\]\(\.\.\/kitchen\.local\.md\)/);
  assert.match(readFileSync(join(main, "plans/README.md"), "utf8"), /`plans\/<map>\/`/);
});

test("a project set up before a new piece: --check names it, kit init adds it and the check goes quiet; init.skip keeps one out", (t) => {
  const f = fixture(t);
  const { work } = f.repo("older", { "package.json": "{}" });
  assert.equal(f.init(work, ["--light"]).status, 0);
  // As set up before the session's context card and the line-endings file came in.
  const settingsPath = join(work, ".claude/settings.json");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.SessionStart[0].hooks = settings.hooks.SessionStart[0].hooks.filter((hook: { command: string }) => !hook.command.endsWith(" context-card"));
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  rmSync(join(work, ".gitattributes"));
  const before = snapshot(work);
  const check = f.init(work, ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout, "missing: .claude/settings.json SessionStart context-card (the context-card hook entry)\n" +
    "missing: .gitattributes (the line \"* text=auto eol=lf\")\nRESULT: ok init check: 2 missing\n");
  assert.deepEqual(snapshot(work), before);
  // A light project stays light: kit init adds the two pieces and none of the full ones.
  const run = f.init(work);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(written(run), [".claude/settings.json", ".gitattributes"]);
  assert.match(run.stdout, /^wrote \.claude\/settings\.json \(merged 1 hook entry\)$/m);
  assert.equal(existsSync(join(work, "docs")), false);
  assert.equal(result(f.init(work, ["--check"])), "RESULT: ok init check: nothing missing");

  // Turned off by name, and a whole file by its path: never reported, never written.
  const kitJson = join(work, "scripts/agents/kit.json");
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: { skip: [".gitattributes", ".codex/hooks.json SessionStart context-card"] } }));
  rmSync(join(work, ".gitattributes"));
  const codexPath = join(work, ".codex/hooks.json"), codex = JSON.parse(readFileSync(codexPath, "utf8"));
  codex.hooks.SessionStart[0].hooks = codex.hooks.SessionStart[0].hooks.filter((hook: { command: string }) => !hook.command.endsWith(" context-card"));
  writeFileSync(codexPath, `${JSON.stringify(codex, null, 2)}\n`);
  const quiet = f.init(work, ["--check"]);
  assert.equal(quiet.stdout, "RESULT: ok init check: nothing missing; 2 turned off in init.skip\n");
  const again = f.init(work);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.deepEqual(written(again), []);
  assert.match(again.stdout, /^left out \(init\.skip in scripts\/agents\/kit\.json\): \.codex\/hooks\.json SessionStart context-card, \.gitattributes$/m);
  assert.equal(existsSync(join(work, ".gitattributes")), false);
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: { skip: ".gitattributes" } }));
  const bad = f.init(work, ["--check"]);
  assert.equal(bad.status, 1);
  assert.equal(result(bad), "RESULT: fail init \"init.skip\" in scripts/agents/kit.json must be a list of piece names; fix it first");
  // --check needs settings and takes nothing else; --full adds the full pieces to a light project.
  const fresh = f.repo("fresh", {});
  assert.equal(result(f.init(fresh.work, ["--check"])), "RESULT: ok init check: no scripts/agents/kit.json (run kit init to set the project up)");
  assert.equal(f.init(fresh.work, ["--check", "--light"]).status, 2);
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: { skip: [] } }));
  const full = f.init(work, ["--full"]);
  assert.equal(full.status, 0, full.stdout + full.stderr);
  for (const path of ["docs/agents/kitchen.md", "docs/agents/kitchen-extras.md", "docs/wayfinder/README.md", "scripts/agents/project.d/.gitkeep"]) assert.ok(written(full).includes(path), path);
  // A whole file turned off counts only for what it lacks; "init" must be an object.
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: { skip: [".claude/settings.json"] } }));
  assert.equal(f.init(work, ["--check"]).stdout, "RESULT: ok init check: nothing missing\n");
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: [".gitattributes"] }));
  assert.equal(result(f.init(work, ["--check"])), 'RESULT: fail init "init" in scripts/agents/kit.json must be an object, as in "init": { "skip": [...] }; fix it first');
});

test(".gitattributes gets the line-endings line at the top of the project's own, never overwritten, with a note on CRLF files", (t) => {
  const f = fixture(t);
  const { work } = f.repo("endings", { ".gitattributes": "*.png binary\n", "notes.txt": "one\r\ntwo\r\n" });
  const run = f.init(work, ["--light"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^wrote \.gitattributes \(added the line-endings line at the top\)$/m);
  assert.equal(readFileSync(join(work, ".gitattributes"), "utf8"), "* text=auto eol=lf\n*.png binary\n");
  assert.match(run.stdout, /^note: line endings: 1 tracked file holds CRLF; commit \.gitattributes, then run git add --renormalize \. and commit that$/m);
  // A file that has the line already, spaced its own way, is kept byte for byte.
  const own = f.repo("own-endings", { ".gitattributes": "*.svg text\n*   text=auto   eol=lf\n" });
  const kept = f.init(own.work, ["--light"]);
  assert.equal(kept.status, 0, kept.stdout + kept.stderr);
  assert.ok(!written(kept).includes(".gitattributes"));
  assert.equal(readFileSync(join(own.work, ".gitattributes"), "utf8"), "*.svg text\n*   text=auto   eol=lf\n");
  // The same two attributes in another order count too; a CRLF file gets the line with its own endings.
  const swapped = f.repo("swapped", { ".gitattributes": "* eol=lf text=auto\n" });
  assert.ok(!written(f.init(swapped.work, ["--light"])).includes(".gitattributes"));
  const windows = f.repo("windows", { ".gitattributes": "*.png binary\r\n" });
  assert.equal(f.init(windows.work, ["--light"]).status, 0);
  assert.equal(readFileSync(join(windows.work, ".gitattributes"), "utf8"), "* text=auto eol=lf\r\n*.png binary\r\n");
});

test("a project whose kit.json names no full piece but holds a full stub at its default place counts as full", (t) => {
  const f = fixture(t);
  const { work } = f.repo("stubbed", { "scripts/agents/kit.json": JSON.stringify({ project: "stubbed", branches: { land: "dev" } }),
    "docs/wayfinder/README.md": "# Maps\n", ".codex/hooks.json": "{ not json" });
  // A whole hook file turned off is not read, so one kit init could not merge into is left out, not a stop.
  const kitJson = join(work, "scripts/agents/kit.json");
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: { skip: [".codex/hooks.json"] } }));
  const check = f.init(work, ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  for (const piece of ["scripts/agents/project.d/ (the project's own commands folder)", "docs/agents/kitchen.md (the kitchen pointer)",
    "docs/agents/kitchen-extras.md (the project's kitchen extras)"]) assert.match(check.stdout, new RegExp(`^missing: ${piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(result(check), /^RESULT: ok init check: \d+ missing; 1 turned off in init\.skip$/);
});

// A project set up a while ago, listed in projects.json: its main checkout and origin hold the setup of then (no
// context card, no line-endings file) and a file committed with CRLF; change() edits the setup before it is pushed.
function olderProject(f: ReturnType<typeof fixture>, name: string, change: (work: string) => void = () => {}, setup = ["--light"]) {
  const origin = join(f.directory, `${name}.git`);
  f.git(f.directory, "init", "-q", "--bare", "--initial-branch=main", origin);
  const { main, work } = f.repo(name, { "notes.txt": "one\r\ntwo\r\n" }, ["main"]);
  f.git(main, "remote", "add", "origin", origin);
  f.git(main, "push", "-q", "origin", "main");
  const setUp = f.init(work, setup);
  assert.equal(setUp.status, 0, setUp.stdout + setUp.stderr);
  const settingsPath = join(work, ".claude/settings.json"), settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.hooks.SessionStart[0].hooks = settings.hooks.SessionStart[0].hooks.filter((hook: { command: string }) => !hook.command.endsWith(" context-card"));
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  rmSync(join(work, ".gitattributes"));
  change(work);
  f.git(work, "add", "-A");
  f.git(work, "commit", "-q", "-m", "setup");
  f.git(work, "push", "-q", "origin", "HEAD:main");
  f.git(main, "pull", "-q", "origin", "main");
  f.git(main, "worktree", "remove", "--force", work);
  return main;
}
const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
// kit pr's stand-in, through KIT_COMMANDS_DIR beside the kit's init and version: it records where it ran and what it
// would land in records/<worktree folder>, fails for a stuck-* folder and sleeps for a slow-* one.
function standInKit(f: ReturnType<typeof fixture>) {
  const commands = join(f.directory, "commands"), records = join(f.directory, "records");
  mkdirSync(commands);
  mkdirSync(records);
  symlinkSync(join(f.kit, "kit.d/init"), join(commands, "init"));
  symlinkSync(join(f.kit, "kit.d/version"), join(commands, "version"));
  writeFileSync(join(commands, "pr"), `#!/bin/bash
# kit: stand-in pr
name=$(basename "$PWD")
{ printf 'args %s\\n' "$*"; printf 'root %s\\n' "$KIT_ROOT"; printf 'branch %s\\n' "$(git branch --show-current)"
  printf 'node_modules %s %s\\n' "$(readlink node_modules)" "$(readlink node_modules/dep)"; printf 'status %s\\n' "$(git status --porcelain | tr '\\n' ' ')"
  printf 'author %s\\n' "$(git log -1 --format='%an <%ae> | %cn <%ce>')"; printf 'env author %s\\n' "\${GIT_AUTHOR_NAME:-none}"
  git log --format='commit %s' origin/main..HEAD; git diff --name-only origin/main HEAD | sed 's/^/file /'; } > "${records}/$name"
if [[ $name == stuck-* ]]; then echo 'RESULT: fail pr #9 checks failed'; exit 1; fi
if [[ $name == slow-* ]]; then sleep 30; fi
if [[ $name == open-* ]]; then echo 'RESULT: ok opened #8'; exit 0; fi
echo 'RESULT: ok merged #7 abc1234'
`);
  chmodSync(join(commands, "pr"), 0o755);
  const all = (env: NodeJS.ProcessEnv = {}) => spawnSync(join(f.kit, "kit"), ["init", "--all"],
    { cwd: f.directory, env: { ...f.env, ...ident, KIT_COMMANDS_DIR: commands, ...env }, encoding: "utf8", timeout: 120_000 });
  return { records, all };
}

test("--all lands the missing pieces in every listed project through its own kit pr, skipping a busy main checkout", (t) => {
  const f = fixture(t);
  Object.assign(f.env, ident);
  const project = (name: string) => olderProject(f, name);
  const behind = project("behind");
  // Its own dependencies in the main checkout (no sharedNodeModules), and a .gitignore naming node_modules/ (a
  // folder) on origin; the main checkout's git settings stay as they were.
  mkdirSync(join(behind, "node_modules/dep"), { recursive: true });
  writeFileSync(join(behind, ".gitignore"), "node_modules/\n");
  f.git(behind, "add", ".gitignore");
  f.git(behind, "commit", "-q", "-m", "ignore");
  f.git(behind, "push", "-q", "origin", "HEAD:main");
  const exclude = readFileSync(join(behind, ".git/info/exclude"), "utf8");
  const busy = project("busy"), stuck = project("stuck"), open = project("open");
  // A full project set up before the kitchen pointer: the pieces go in as full ones.
  olderProject(f, "wide", (work) => rmSync(join(work, "docs/agents/kitchen.md")), []);
  writeFileSync(join(busy, ".claude/settings.json"), "{ \"someone\": \"working\" }\n");
  // A project already up to date.
  const current = project("current");
  const kitJson = join(current, "scripts/agents/kit.json");
  writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), init: { skip: [".gitattributes", ".claude/settings.json"] } }));
  f.git(current, "commit", "-q", "-am", "keep out");
  f.git(current, "push", "-q", "origin", "HEAD:main");
  const listed = f.projects();
  writeFileSync(join(f.state, "agent-kit/projects.json"), JSON.stringify({ ...listed, gone: { root: join(f.directory, "gone") } }));

  const { records, all } = standInKit(f);
  const run = all();
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const results = run.stdout.split("\n").filter((line) => line.startsWith("RESULT: "));
  assert.deepEqual(results.slice(0, -1), [
    "RESULT: ok init behind: 2 files changed, 1 file renormalized, through kit pr into main: merged #7 abc1234",
    `RESULT: ok init busy: skipped: ${busy} has uncommitted changes in .claude/settings.json; commit or land them, then rerun`,
    "RESULT: ok init current: nothing missing on origin/main",
    `RESULT: ok init gone: skipped: no git checkout at ${join(f.directory, "gone")}`,
    `RESULT: ok init open: waiting: kit pr says opened #8; the change waits in ${open}-kit-init-pieces on kit/init-pieces until it lands, log ${join(f.state, "agent-kit/init-all/open.log")}`,
    `RESULT: fail init stuck: kit pr failed (pr #9 checks failed); the change waits in ${stuck}-kit-init-pieces on kit/init-pieces, log ${join(f.state, "agent-kit/init-all/stuck.log")}`,
    "RESULT: ok init wide: 3 files changed, 1 file renormalized, through kit pr into main: merged #7 abc1234",
  ]);
  assert.equal(results.at(-1), "RESULT: fail init --all: 2 updated (behind, wide), 1 waiting (open), 1 up to date, 2 skipped (busy, gone), 1 failed (stuck)");
  assert.deepEqual(readFileSync(join(records, "wide-kit-init-pieces"), "utf8").split("\n").filter((line) => line.startsWith("file ")),
    ["file .claude/settings.json", "file .gitattributes", "file docs/agents/kitchen.md", "file notes.txt"]);
  assert.equal(existsSync(`${open}-kit-init-pieces`), true);
  // behind's change ran through kit pr from a worktree of origin/main: the pieces, then the line-endings commit.
  const record = readFileSync(join(records, "behind-kit-init-pieces"), "utf8");
  assert.match(record, /^args --title Kit setup: add what kit init writes today \(kit 0123456\)$/m);
  assert.match(record, new RegExp(`^root ${behind}-kit-init-pieces$`, "m"));
  assert.match(record, /^branch kit\/init-pieces$/m);
  assert.match(record, new RegExp(`^node_modules  ${join(behind, "node_modules/dep")}\nstatus $`, "m"));
  assert.equal(readFileSync(join(behind, ".git/info/exclude"), "utf8"), exclude);
  assert.deepEqual(record.split("\n").filter((line) => line.startsWith("commit ")),
    ["commit Normalize line endings (git add --renormalize . after .gitattributes)", "commit Kit setup: add what kit init writes today (kit 0123456)"]);
  assert.deepEqual(record.split("\n").filter((line) => line.startsWith("file ")), ["file .claude/settings.json", "file .gitattributes", "file notes.txt"]);
  // The worktree and its branch are gone once kit pr landed it; a failed one waits; the main checkouts are untouched.
  assert.equal(existsSync(`${behind}-kit-init-pieces`), false);
  assert.equal(spawnSync("git", ["-C", behind, "rev-parse", "--verify", "--quiet", "refs/heads/kit/init-pieces"], { env: f.env }).status, 1);
  assert.equal(existsSync(`${stuck}-kit-init-pieces`), true);
  assert.equal(existsSync(`${busy}-kit-init-pieces`), false);
  assert.equal(readFileSync(join(busy, ".claude/settings.json"), "utf8"), "{ \"someone\": \"working\" }\n");
  assert.equal(existsSync(join(behind, ".gitattributes")), false);
  for (const name of ["busy-kit-init-pieces", "current-kit-init-pieces"]) assert.equal(existsSync(join(records, name)), false, name);
  // A rerun says the failed one's worktree is still there rather than make another; the waiting one's PR has
  // landed since (its branch is on origin/main), so its worktree goes and the project is up to date.
  f.git(`${open}-kit-init-pieces`, "push", "-q", "origin", "HEAD:main");
  const again = all();
  assert.match(again.stdout, /^open: the earlier run's kit\/init-pieces has landed on origin\/main; removed it and its worktree$/m);
  assert.match(again.stdout, /^RESULT: ok init open: nothing missing on origin\/main$/m);
  assert.equal(existsSync(`${open}-kit-init-pieces`), false);
  assert.match(again.stdout, new RegExp(`^RESULT: fail init stuck: ${stuck}-kit-init-pieces or branch kit/init-pieces is left from an earlier run; land or remove it, then rerun$`, "m"));
});

test("--all skips a project with no origin or no settings on origin, names old kit files, links shared node_modules and stops a slow kit pr", (t) => {
  const f = fixture(t);
  Object.assign(f.env, ident);
  const solo = f.repo("solo", {}, ["main"]);
  assert.equal(f.init(solo.work, ["--light"]).status, 0);
  // Set up in the main checkout only: origin/main has no settings yet.
  const fresh = olderProject(f, "fresh");
  f.git(fresh, "rm", "-q", "-r", "scripts");
  f.git(fresh, "commit", "-q", "-m", "not yet");
  f.git(fresh, "push", "-q", "origin", "HEAD:main");
  f.git(fresh, "checkout", "-q", "HEAD~1", "--", "scripts");
  const legacy = olderProject(f, "legacy", (work) => writeFileSync(join(work, "scripts/agents/kit-lib.sh"), "# old\n"));
  const modules = join(f.directory, "shared-modules");
  mkdirSync(join(modules, "dep"), { recursive: true });
  const slow = olderProject(f, "slow", (work) => {
    const kitJson = join(work, "scripts/agents/kit.json");
    writeFileSync(kitJson, JSON.stringify({ ...JSON.parse(readFileSync(kitJson, "utf8")), sharedNodeModules: "../shared-modules", worktreeLinks: ["public/preview"] }));
  });
  // A main checkout busy with a file only the line-endings commit touches; one whose origin went away.
  const edited = olderProject(f, "edited");
  writeFileSync(join(edited, "notes.txt"), "mine\n");
  const lost = olderProject(f, "lost");
  f.git(lost, "remote", "set-url", "origin", join(f.directory, "nowhere.git"));
  // This run has no git identity (nor a guess from EMAIL or the host name): a project commits, and runs kit pr, as its
  // landing branch's last author; one with its own identity keeps it.
  const landed = (main: string, who: string) => {
    const [name, email] = who.split(" ");
    spawnSync("git", ["-C", main, "commit", "-q", "--allow-empty", "-m", "last"], { env: { ...f.env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email } });
    f.git(main, "push", "-q", "origin", "HEAD:main");
  };
  const nameless = olderProject(f, "nameless");
  landed(nameless, "Lander land@example.test");
  const half = olderProject(f, "half");
  f.git(half, "config", "user.name", "Own");
  landed(half, "Lander land@example.test");
  const owned = olderProject(f, "owned");
  f.git(owned, "config", "user.name", "Own");
  f.git(owned, "config", "user.email", "own@example.test");
  landed(owned, "Lander land@example.test");
  const { records, all } = standInKit(f);
  for (const key of Object.keys(ident)) delete f.env[key];
  delete f.env.EMAIL;
  // No user.useConfigOnly: a name git could guess from the host never stands in for the landing branch's author.
  // all() adds the fixture's identity unless told otherwise.
  const run = all({ KIT_INIT_PR_TIMEOUT: "1", ...Object.fromEntries(Object.keys(ident).map((key) => [key, undefined])) });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.deepEqual(run.stdout.split("\n").filter((line) => line.startsWith("RESULT: ")).map((line) => line.replace(/(fetch origin failed: ).*/, "$1…")), [
    `RESULT: ok init edited: skipped: ${edited} has uncommitted changes in notes.txt; commit or land them, then rerun`,
    "RESULT: ok init fresh: skipped: origin/main has no scripts/agents/kit.json; land the project's setup first",
    "RESULT: ok init half: 2 files changed, 1 file renormalized, through kit pr into main: merged #7 abc1234",
    "RESULT: fail init legacy: adding the pieces failed: old kit files: scripts/agents/kit-lib.sh",
    "RESULT: fail init lost: git fetch origin failed: …",
    "RESULT: ok init nameless: 2 files changed, 1 file renormalized, through kit pr into main: merged #7 abc1234",
    "RESULT: ok init owned: 2 files changed, 1 file renormalized, through kit pr into main: merged #7 abc1234",
    `RESULT: fail init slow: kit pr timed out after 1s and was stopped; the change waits in ${slow}-kit-init-pieces on kit/init-pieces (its branch on origin may have moved), log ${join(f.state, "agent-kit/init-all/slow.log")}`,
    "RESULT: ok init solo: skipped: no origin remote, so no kit pr; run kit init there by hand",
    "RESULT: fail init --all: 3 updated (half, nameless, owned), 0 up to date, 3 skipped (edited, fresh, solo), 3 failed (legacy, lost, slow)",
  ]);
  assert.equal(existsSync(`${legacy}-kit-init-pieces`), false);
  // The slow project's kit pr ran with the shared dependencies linked, as in any of its worktrees.
  // No .gitignore line covers node_modules there: there is none, rather than one kit pr would see as a change.
  assert.match(readFileSync(join(records, "slow-kit-init-pieces"), "utf8"), /^node_modules  $/m);
  assert.equal(readlinkSync(`${slow}-kit-init-pieces/public/preview`), join(slow, "public/preview"));
  assert.match(readFileSync(join(records, "nameless-kit-init-pieces"), "utf8"), /^author Lander <land@example\.test> \| Lander <land@example\.test>\nenv author Lander$/m);
  assert.match(readFileSync(join(records, "half-kit-init-pieces"), "utf8"), /^author Own <land@example\.test> \| Own <land@example\.test>\nenv author none$/m);
  assert.match(readFileSync(join(records, "owned-kit-init-pieces"), "utf8"), /^author Own <own@example\.test> \| Own <own@example\.test>\nenv author none$/m);
  assert.equal(existsSync(`${slow}-kit-init-pieces`), true);
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
// A repo as `gh repo view <repo> --json nameWithOwner,url` names it now.
type GhRepo = { nameWithOwner: string; url: string };
// A fake gh on PATH: `repo view` answers from repos.json (keyed by the --repo form; a missing one is not found),
// `issue list --repo R` prints the open Issues of R as repos.json names it now (or list-output.txt as it is, or
// fails with list-error.txt, or first sleeps list-sleep.txt seconds), `issue close` marks one closed (a number
// listed in fail-close.json fails once instead); every call is logged as one JSON line in calls.log.
function fakeGh(f: ReturnType<typeof fixture>, issues: GhIssue[], repos: Record<string, GhRepo> = { "acme/tools": { nameWithOwner: "acme/tools", url: "https://github.com/acme/tools" } }) {
  const bin = join(f.directory, "fake-gh");
  mkdirSync(bin);
  writeFileSync(join(bin, "issues.json"), JSON.stringify(issues));
  writeFileSync(join(bin, "repos.json"), JSON.stringify(repos));
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const store = ${JSON.stringify(join(bin, "issues.json"))}, args = process.argv.slice(2);
appendFileSync(${JSON.stringify(join(bin, "calls.log"))}, JSON.stringify(args) + "\\n");
const issues = JSON.parse(readFileSync(store, "utf8")), repos = JSON.parse(readFileSync(${JSON.stringify(join(bin, "repos.json"))}, "utf8"));
const repoArg = args[args.indexOf("--repo") + 1], listSleep = ${JSON.stringify(join(bin, "list-sleep.txt"))};
if (args[0] === "issue" && args[1] === "list" && existsSync(listSleep)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(readFileSync(listSleep, "utf8")) * 1000);
const listError = ${JSON.stringify(join(f.directory, "fake-gh/list-error.txt"))}, listOutput = ${JSON.stringify(join(f.directory, "fake-gh/list-output.txt"))};
if (args[0] === "issue" && args[1] === "list" && existsSync(listError)) { process.stderr.write(readFileSync(listError, "utf8")); process.exit(1); }
else if (args[0] === "issue" && args[1] === "list" && existsSync(listOutput)) process.stdout.write(readFileSync(listOutput, "utf8"));
else if (args[0] === "issue" && args[1] === "list" && repos[repoArg]) process.stdout.write(JSON.stringify(issues.filter((issue) => issue.state === "OPEN" && issue.url.startsWith(repos[repoArg].url + "/issues/"))));
else if (args[0] === "repo" && args[1] === "view" && repos[args[2]]) process.stdout.write(JSON.stringify(repos[args[2]]));
else if (args[0] === "repo" && args[1] === "view") { process.stderr.write("GraphQL: Could not resolve to a Repository"); process.exit(1); }
else if (args[0] === "issue" && args[1] === "close") {
  const failing = ${JSON.stringify(join(f.directory, "fake-gh/fail-close.json"))};
  const once = existsSync(failing) ? JSON.parse(readFileSync(failing, "utf8")) : [];
  if (once.includes(args[2])) { writeFileSync(failing, JSON.stringify(once.filter((n) => n !== args[2]))); process.stderr.write("HTTP 502: try later\\nmore"); process.exit(1); }
  issues.find((issue) => issue.number === Number(args[2])).state = "CLOSED";
  writeFileSync(store, JSON.stringify(issues));
} else { process.stderr.write("unexpected gh " + args.join(" ")); process.exit(1); }
`, { mode: 0o755 });
  const env = { ...f.env, PATH: `${bin}:${f.env.PATH}` };
  const init = (cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(join(f.directory, "data/agent-kit/current/kit"), ["init", ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
  const calls = () => existsSync(join(bin, "calls.log"))
    ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
  const add = (...more: GhIssue[]) => writeFileSync(join(bin, "issues.json"), JSON.stringify([...JSON.parse(readFileSync(join(bin, "issues.json"), "utf8")), ...more]));
  const setRepos = (more: Record<string, GhRepo>) => writeFileSync(join(bin, "repos.json"), JSON.stringify(more));
  return { init, calls, add, setRepos, closes: () => calls().filter((args) => args[1] === "close") };
}
const issue = (number: number, title: string, extra: Partial<GhIssue> = {}): GhIssue => ({ number, title, state: "OPEN", url: `https://github.com/acme/tools/issues/${number}`,
  author: { login: "lex" }, createdAt: "2026-10-01T10:00:00Z", body: "", labels: [], comments: [], ...extra });
// A repo whose origin names a GitHub URL that git rewrites to a local bare repo, so pushes and fetches stay here.
const issueRepo = (f: ReturnType<typeof fixture>, settings = JSON.stringify({ project: "tools", branches: { land: "dev" }, maps: "docs/wayfinder" }),
  originUrl = "https://github.com/acme/tools.git") => {
  const repo = f.repo("tools", { "scripts/agents/kit.json": settings });
  const origin = join(f.directory, "origin.git");
  f.git(f.directory, "init", "-q", "--bare", origin);
  f.git(repo.main, "remote", "add", "origin", originUrl);
  f.git(repo.main, "config", `url.${origin}.insteadOf`, originUrl);
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
  assert.deepEqual(gh.calls(), [["repo", "view", "acme/tools", "--json", "nameWithOwner,url"],
    ["issue", "list", "--repo", "acme/tools", "--state", "open", "--limit", "1000", "--json", "number,title,body,labels,url,author,createdAt,comments"]]);
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
  const body = "Crash on save.\r\n## Files\r\n- `src/save.ts`\r\n# Steps\r\n```sh\r\n# keep this shell comment\r\n```js not a close\r\n## and this\r\n```\r\n### Deeper stays\r\n" +
    "```md\r\n## Files\r\n- `src/x.ts`\r\n```";
  const comments = Array.from({ length: 100 }, (_, n) => ({ author: { login: "sam" }, createdAt: "2026-10-02T09:00:00Z", body: n ? `+${n}` : "## Comments\r\nme too" }));
  const gh = fakeGh(f, [issue(8, "Save crash", { body, comments })]);
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^note: #8 has 100 or more comments; its file says to read the rest on GitHub$/m);
  const text = readFileSync(join(work, `${backlog}/tickets/01-save-crash.md`), "utf8");
  assert.doesNotMatch(text, /\r/);
  // Inside a fence a top heading gets one leading space: the block reads the same, and tickets.mjs sees no section.
  assert.ok(text.includes("Crash on save.\n#### Files\n- `src/save.ts`\n### Steps\n```sh\n # keep this shell comment\n```js not a close\n ## and this\n```\n### Deeper stays\n" +
    "```md\n ## Files\n- `src/x.ts`\n```\n"), text);
  assert.ok(text.includes("**sam, 2026-10-02:**\n\n#### Comments\nme too"), text);
  assert.deepEqual(text.match(/^## .*/gm), ["## Issue", "## Comments"]);
  assert.match(text, /\n_Only the first 100 comments were copied; read the rest on the Issue\._\n$/);
  const files = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { loadTickets } from ${JSON.stringify(join(f.kit, "tickets.mjs"))}; console.log(JSON.stringify(loadTickets("docs/wayfinder").tickets.map((t) => t.files)));`],
    { cwd: work, env: f.env, encoding: "utf8" });
  assert.deepEqual(JSON.parse(files.stdout), [[]]);
});

test("--close works on another GitHub host and after the repo was renamed, and needs a landing branch", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f, undefined, "git@ghe.example:acme/tools.git");
  const ghe = (name: string, number: number) => `https://ghe.example/acme/${name}/issues/${number}`;
  const gh = fakeGh(f, [issue(4, "On our own host", { url: ghe("tools", 4) }), issue(6, "Before the rename", { url: ghe("tools", 6) })],
    { "ghe.example/acme/tools": { nameWithOwner: "acme/tools", url: "https://ghe.example/acme/tools" } });
  const first = gh.init(work, ["--issues"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.deepEqual(gh.calls()[1].slice(0, 4), ["issue", "list", "--repo", "ghe.example/acme/tools"]);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  // The repo is renamed (origin still names the old one, which GitHub redirects): gh gives new links, and a
  // rerun still finds both files.
  const renamed = { nameWithOwner: "acme/tools-renamed", url: "https://ghe.example/acme/tools-renamed" };
  gh.setRepos({ "ghe.example/acme/tools": renamed, "ghe.example/acme/tools-renamed": renamed });
  const store = join(f.directory, "fake-gh/issues.json");
  writeFileSync(store, readFileSync(store, "utf8").replaceAll("acme/tools/issues/", "acme/tools-renamed/issues/"));
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
  assert.match(close.stdout, /^note: #6's file docs\/wayfinder\/backlog\/tickets\/02-before-the-rename\.md names https:\/\/ghe\.example\/acme\/tools\/issues\/6; GitHub now gives https:\/\/ghe\.example\/acme\/tools-renamed\/issues\/6$/m);
  assert.deepEqual(gh.closes().map((args) => args.slice(0, 5).concat(args[6].split("\n")[0])), [
    ["issue", "close", "4", "--repo", "ghe.example/acme/tools-renamed", `Moved to a ticket file: https://ghe.example/acme/tools-renamed/blob/dev/${backlog}/tickets/01-on-our-own-host.md`],
    ["issue", "close", "6", "--repo", "ghe.example/acme/tools-renamed", `Moved to a ticket file: https://ghe.example/acme/tools-renamed/blob/dev/${backlog}/tickets/02-before-the-rename.md`],
  ]);
});

test("--issues reads an ssh alias for github.com as kit pr does: gh is asked about OWNER/NAME on github.com", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f, undefined, "git@github-work:acme/tools.git");
  const gh = fakeGh(f, [issue(3, "Aliased")]);
  // ssh -G as ssh answers it for Host github-work → HostName github.com.
  writeFileSync(join(f.directory, "fake-gh/ssh"), '#!/bin/bash\n[[ $3 == github-work ]] && echo "hostname github.com" || echo "hostname $3"\n', { mode: 0o755 });
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(gh.calls().map((args) => args.slice(0, 3)), [["repo", "view", "acme/tools"], ["issue", "list", "--repo"]]);
  assert.equal(gh.calls()[1][3], "acme/tools");
});

test("a token in origin's url never shows: not in init's messages, the project name or the --issues stop", (t) => {
  const f = fixture(t);
  const token = "ke63-fake-token-0000";
  // An origin url with no path names the project after its host, never after the token (.invalid: no fetch leaves).
  const bare = f.repo("plain", { "index.html": "<p>hi</p>\n" }, ["main"]);
  f.git(bare.main, "remote", "add", "origin", `https://ke63:${token}@gitlab.invalid`);
  const run = f.init(bare.work, ["--light"]);
  assert.equal(`${run.stdout}${run.stderr}`.includes(token), false, run.stdout + run.stderr);
  assert.equal(JSON.parse(readFileSync(join(bare.work, "scripts/agents/kit.json"), "utf8")).project, "gitlab.invalid");
  // --issues stops on an origin that is no GitHub repo, naming its host only.
  const { work } = issueRepo(f, undefined, `https://ke63:${token}@gitlab.example.com/acme/tools.git`);
  const issues = fakeGh(f, []).init(work, ["--issues"]);
  assert.equal(result(issues), "RESULT: fail init origin (https://gitlab.example.com/acme/tools.git) is not a GitHub repo gh knows; --issues reads the Issues of origin's repo");
  assert.equal(`${issues.stdout}${issues.stderr}`.includes(token), false, issues.stdout + issues.stderr);
});

test("--issues runs beside old kit files, and a failing or odd gh issue list writes nothing", (t) => {
  const f = fixture(t);
  const { main, work } = f.repo("old", { "scripts/agents/kit-lib.sh": "# old\n", "scripts/agents/kit.json": JSON.stringify({ project: "old", branches: { land: "dev" }, maps: "docs/wayfinder" }) });
  const gh = fakeGh(f, [issue(1, "Kept")]);
  const noOrigin = gh.init(work, ["--issues"]);
  assert.equal(result(noOrigin), "RESULT: fail init origin (none) is not a GitHub repo gh knows; --issues reads the Issues of origin's repo");
  f.git(main, "remote", "add", "origin", "https://github.com/acme/tools");
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

test("a fork lists and closes origin's Issues, never upstream's, and links only origin's files", (t) => {
  const f = fixture(t);
  const { main, work } = issueRepo(f, undefined, "https://github.com/me/tools.git");
  f.git(main, "remote", "add", "upstream", "https://github.com/acme/tools.git");
  const gh = fakeGh(f, [issue(3, "Upstream's own"), issue(4, "Ours", { url: "https://github.com/me/tools/issues/4" })], {
    "me/tools": { nameWithOwner: "me/tools", url: "https://github.com/me/tools" },
    "acme/tools": { nameWithOwner: "acme/tools", url: "https://github.com/acme/tools" } });
  const run = gh.init(work, ["--issues"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(written(run), [`${backlog}/map.md`, `${backlog}/tickets/01-ours.md`]);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  const close = gh.init(work, ["--issues", "--close"]);
  assert.equal(close.status, 0, close.stdout + close.stderr);
  assert.deepEqual(gh.closes().map((args) => [args[2], args[4], args[6].split("\n")[0]]),
    [["4", "me/tools", `Moved to a ticket file: https://github.com/me/tools/blob/dev/${backlog}/tickets/01-ours.md`]]);
  assert.ok(gh.calls().filter((args) => args[0] === "issue").every((args) => args[args.indexOf("--repo") + 1] === "me/tools"), JSON.stringify(gh.calls()));
  // Issues gh gives for another repo stop the run before anything is written or closed.
  gh.setRepos({ "me/tools": { nameWithOwner: "me/tools", url: "https://github.com/acme/tools" } });
  const odd = gh.init(work, ["--issues", "--close"]);
  assert.equal(odd.status, 1, odd.stdout + odd.stderr);
  assert.equal(result(odd), "RESULT: fail init gh gave #3 as https://github.com/acme/tools/issues/3, not an Issue of github.com/me/tools; closed nothing, wrote nothing");
  assert.equal(gh.closes().length, 1);
});

test("a file naming another repo's Issue of the same number never stands for this repo's, and a non-ASCII file name is found", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const ticket = (url: string) => `---\ntitle: x\ntype: task (AFK)\nstatus: needs-triage\nassignee:\nblocked_by: []\nissue: ${url}\n---\n`;
  mkdirSync(join(work, `${backlog}/tickets`), { recursive: true });
  writeFileSync(join(work, `${backlog}/tickets/01-x.md`), ticket("https://github.com/other/repo/issues/5"));
  writeFileSync(join(work, `${backlog}/tickets/02-café.md`), ticket("https://github.com/acme/tools/issues/7"));
  const gh = fakeGh(f, [issue(5, "Five"), issue(7, "Seven")]);
  const run = gh.init(work, ["--issues"]);
  assert.equal(result(run), "RESULT: ok init issues wrote 1 ticket and the map, skipped 1 with a file; nothing closed", run.stdout + run.stderr);
  assert.deepEqual(written(run), [`${backlog}/map.md`, `${backlog}/tickets/03-five.md`]);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  const close = gh.init(work, ["--issues", "--close"]);
  assert.equal(close.status, 0, close.stdout + close.stderr);
  assert.deepEqual(gh.closes().map((args) => [args[2], args[6].split("\n")[0]]), [
    ["5", `Moved to a ticket file: https://github.com/acme/tools/blob/dev/${backlog}/tickets/03-five.md`],
    ["7", `Moved to a ticket file: https://github.com/acme/tools/blob/dev/${backlog}/tickets/02-caf%C3%A9.md`],
  ]);
});

test("an Issue list and a landed ticket over 1 MiB are read whole, and a gh that hangs stops at KIT_ISSUES_TIMEOUT", (t) => {
  const f = fixture(t);
  const { work } = issueRepo(f);
  const gh = fakeGh(f, [issue(1, "Long", { body: "x".repeat(2 * 1024 * 1024) })]);
  const bin = join(f.directory, "fake-gh");
  const big = gh.init(work, ["--issues"]);
  assert.equal(big.status, 0, big.stdout + big.stderr);
  assert.ok(statSync(join(work, `${backlog}/tickets/01-long.md`)).size > 2 * 1024 * 1024);
  f.git(work, "add", "-A");
  f.git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "backlog");
  f.git(work, "push", "-q", "origin", "HEAD:dev");
  const close = gh.init(work, ["--issues", "--close"]);
  assert.equal(close.status, 0, close.stdout + close.stderr);
  assert.match(close.stdout, /^closed #1 → https:\/\/github\.com\/acme\/tools\/blob\/dev\/docs\/wayfinder\/backlog\/tickets\/01-long\.md$/m);
  gh.add(issue(2, "Slow"));
  writeFileSync(join(bin, "list-sleep.txt"), "5");
  const slow = gh.init(work, ["--issues"], { KIT_ISSUES_TIMEOUT: "1" });
  assert.equal(slow.status, 1, slow.stdout + slow.stderr);
  assert.equal(result(slow), "RESULT: fail init gh issue list failed: timed out after 1s");
});
