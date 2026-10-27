import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { kitDevRoot, kitMainRoot, kitMaps, kitSettings, kitSettingsProblems, scoreMap } from "../scripts/agents/kit-lib.mjs";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { optionsFor } from "../scripts/agents/deps-check.mjs";
// @ts-expect-error The agent helpers are plain JavaScript without declarations.
import { classify, featureListGuard } from "../scripts/agents/pr-tier.mjs";

const kit = resolve("scripts/agents/kit");
const doctor = resolve("scripts/agents/kit.d/doctor");
const library = resolve("scripts/agents/kit-lib.sh");
const sha = "abcdef0123456789abcdef0123456789abcdef01";
const noProject = 'add "project": "<name>" to scripts/agents/kit.json';
const noLand = 'add "branches": { "land": "<branch>" } to scripts/agents/kit.json';
const noFile = 'no scripts/agents/kit.json; add one with "project" and "branches": { "land": "<branch>" }';

// Kit runs export these into the test process; each test sets its own.
const clean: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
for (const key of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_DEV_ROOT", "KIT_PREVIEW_URL", "KIT_LIB", "KIT_LIB_MJS", "KIT_HOME", "KIT_HOME_DEFAULT", "KIT_COMMANDS_DIR", "NODE_TEST_CONTEXT"]) delete clean[key];

function temp(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-settings-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function executable(file: string, body: string) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

function settingsFile(root: string, settings: object | string) {
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
}

function bash(script: string, env: NodeJS.ProcessEnv) {
  return spawnSync("bash", ["-c", `source ${JSON.stringify(library)}; ${script}`], { env: { ...clean, ...env }, encoding: "utf8" });
}

// A repo whose origin has only the land branch `main`, a feature branch one commit ahead,
// and fakes for gh (CI and PR reads) and for the kit children of kit pr.
function repo(t: TestContext, settings?: object | string) {
  const dir = temp(t), origin = join(dir, "origin.git"), root = join(dir, "work"), main = join(dir, "main"), bin = join(dir, "bin");
  for (const path of [root, main, bin]) mkdirSync(path);
  const calls = join(dir, "calls");
  executable(join(bin, "gh"), `#!/bin/bash
printf 'gh %s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1 $2" in
  'api repos/{owner}/{repo}/commits/'*) echo ${sha} ;;
  'pr view') echo '{"headRefName":"feature/x","headRefOid":"${sha}"}' ;;
  'workflow list') echo '[{"id":1,"name":"Checks","state":"active"}]' ;;
  'run list')
    if [[ $* == *--commit* ]]; then echo '[{"databaseId":10,"workflowName":"Checks","status":"completed","conclusion":"success","headSha":"${sha}","createdAt":"2026-10-27","url":"https://example.test/run/10"}]'
    else echo '[]'; fi ;;
  'pr list') echo '[]' ;;
  *) echo "unexpected gh: $*" >&2; exit 1 ;;
esac
`);
  executable(join(bin, "fake-kit"), `#!/bin/bash\nprintf 'kit %s\\n' "$*" >> ${JSON.stringify(calls)}\necho "RESULT: ok $1 done"\n`);
  // kit-lib's nodeEnv puts the Node directory first on PATH; a node link keeps the fake gh ahead of a real one beside it.
  symlinkSync(process.execPath, join(bin, "node"));
  const env: NodeJS.ProcessEnv = { ...clean, PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: root, KIT_MAIN_ROOT: main, ASE_OWNER: "ke-test",
    KIT_PR_KIT: join(bin, "fake-kit"), KIT_STATUS_GH: join(bin, "gh"), KIT_GROK: join(dir, "no-grok"), CLAUDECODE: "" };
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Kit settings"); git("config", "user.email", "kit-settings@example.test");
  git("remote", "add", "origin", origin);
  writeFileSync(join(root, ".gitignore"), ".scratch/\nnode_modules/\n");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  if (settings !== undefined) settingsFile(root, settings);
  git("add", "-A"); git("commit", "-qm", "base");
  git("push", "-q", "-u", "origin", "main");
  git("switch", "-q", "-c", "feature/x");
  mkdirSync(join(root, "tests"));
  writeFileSync(join(root, "tests/a.test.ts"), "// a\n");
  git("add", "-A"); git("commit", "-qm", "Add a test");
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(kit, args, { cwd: root, env: { ...env, ...extra }, encoding: "utf8", timeout: 30_000 });
  const called = () => { try { return readFileSync(calls, "utf8"); } catch { return ""; } };
  return { dir, root, main, bin, env, git, run, called };
}

function lastLine(output: { stdout: string }) {
  return output.stdout.trimEnd().split("\n").at(-1);
}

test("only project and branches.land are required, and both readers say what to add", t => {
  assert.deepEqual(kitSettingsProblems({ project: "x", branches: { land: "main" } }), []);
  const cases: [object | string | null, string[]][] = [
    [null, [noFile]],
    [{}, [noProject, noLand]],
    [{ project: "x", branches: { land: " " } }, [noLand]],
    [{ project: "", branches: { land: "main" }, preview: "https://example.test" }, [noProject]],
    [[], ["scripts/agents/kit.json must hold one JSON object"]],
  ];
  for (const [settings, problems] of cases) {
    const root = temp(t);
    if (settings !== null) settingsFile(root, settings);
    assert.throws(() => kitSettings(root), { message: problems.join("; ") }, JSON.stringify(settings));
    const shell = bash("kit_settings_problems", { KIT_ROOT: root });
    assert.equal(shell.status, 1, JSON.stringify(settings));
    assert.equal(shell.stdout, `${problems.join("\n")}\n`, JSON.stringify(settings));
  }
  const broken = temp(t);
  settingsFile(broken, '{ "project": ');
  assert.throws(() => kitSettings(broken), /^Error: scripts\/agents\/kit\.json is unreadable: /);
  const shell = bash("kit_settings_problems", { KIT_ROOT: broken });
  assert.equal(shell.status, 1);
  assert.match(shell.stdout, /^scripts\/agents\/kit\.json is unreadable: /);
  const good = temp(t);
  settingsFile(good, { project: "x", branches: { land: "main" } });
  assert.deepEqual(kitSettings(good), { project: "x", branches: { land: "main" } });
  assert.equal(bash("kit_settings_problems && kit_setting .branches.land", { KIT_ROOT: good }).stdout, "main\n");
});

test("a missing, broken or incomplete settings file fails doctor with what to add", t => {
  const commands = temp(t);
  symlinkSync(doctor, join(commands, "doctor"));
  for (const [settings, problem] of [[undefined, noFile], ['{ "project": ', "scripts/agents/kit.json is unreadable: "], [{ project: "x" }, noLand]] as const) {
    const f = repo(t, settings);
    const output = f.run(["doctor"], { KIT_COMMANDS_DIR: commands });
    assert.equal(output.status, 1, output.stdout + output.stderr);
    const line = output.stdout.split("\n").find(text => text.startsWith("✗ settings: "));
    assert.ok(line?.startsWith(`✗ settings: ${problem}`), output.stdout);
    // Only a missing file is to be added; an existing one is to be edited.
    assert.ok(line.endsWith(settings === undefined ? '; fix: add scripts/agents/kit.json with "project" and "branches": { "land": "<branch>" }'
      : "; fix: edit scripts/agents/kit.json as the problem says"), line);
    assert.match(output.stdout, /^✗ base: no land branch; fix: fix scripts\/agents\/kit\.json first$/m);
    assert.match(lastLine(output)!, /^RESULT: fail doctor \d+ failed: settings,base/);
  }
  const f = repo(t, { project: "kit-land", branches: { land: "main" } });
  const output = f.run(["doctor"], { KIT_COMMANDS_DIR: commands });
  assert.match(output.stdout, /^✓ settings: scripts\/agents\/kit\.json \(kit-land, lands on main\)$/m);
  assert.match(output.stdout, /^✓ base: contains origin\/main [0-9a-f]{7}$/m);
  // No sharedNodeModules: the dependency check only asks for installed dependencies.
  assert.match(output.stdout, /^✗ node_modules: missing or dangling node_modules; fix: install the dependencies$/m);
});

test("a missing optional key turns its feature off with a plain line", t => {
  const f = repo(t, { project: "kit-land", branches: { land: "main" } });
  const status = f.run(["status", "--no-fetch"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.doesNotMatch(status.stdout, /^preview:/m);
  assert.match(status.stdout, /^tickets: none \(no maps folder in scripts\/agents\/kit\.json\)$/m);
  for (const args of [["next"], ["heartbeat", "alpha"]]) {
    const output = f.run(args);
    assert.equal(output.status, 1, output.stdout + output.stderr);
    assert.equal(lastLine(output), `RESULT: fail ${args[0]} needs a dev worktree; add devRoot to scripts/agents/kit.json`);
  }
  const unit = f.run(["unit", "tests/a.test.ts"]);
  assert.notEqual(unit.status, 0);
  assert.match(unit.stderr, /^unit\.sh needs unit\.run in scripts\/agents\/kit\.json$/m);
  // No paths and no feature list: every change is code, and nothing needs a feature-list update.
  const settings = { project: "kit-land", branches: { land: "main" } }, rows = [{ status: "M", path: "src/ui/a.css" }];
  assert.equal(classify(rows, { settings }).tier, "full");
  assert.deepEqual(featureListGuard(rows, { settings }), { ok: true });
  assert.equal(featureListGuard(rows, { settings: { ...settings, featureList: "FEATURES.md", paths: { visible: ["^src/ui/"] } } }).ok, false);
});

test("environment overrides still win over the settings file", async t => {
  const root = temp(t);
  settingsFile(root, { project: "x", branches: { land: "main" }, mainRoot: "/settings/main", devRoot: "/settings/dev" });
  const saved = { root: process.env.KIT_ROOT, main: process.env.KIT_MAIN_ROOT, dev: process.env.KIT_DEV_ROOT };
  t.after(() => {
    for (const [key, value] of [["KIT_ROOT", saved.root], ["KIT_MAIN_ROOT", saved.main], ["KIT_DEV_ROOT", saved.dev]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  process.env.KIT_ROOT = root;
  delete process.env.KIT_MAIN_ROOT; delete process.env.KIT_DEV_ROOT;
  assert.equal(kitMainRoot(), "/settings/main");
  assert.equal(kitDevRoot(kitSettings(root)), "/settings/dev");
  assert.equal(bash("kit_main_root; kit_dev_root", { KIT_ROOT: root }).stdout, "/settings/main\n/settings/dev\n");
  process.env.KIT_MAIN_ROOT = "/env/main"; process.env.KIT_DEV_ROOT = "/env/dev";
  assert.equal(kitMainRoot(), "/env/main");
  assert.equal(kitDevRoot(kitSettings(root)), "/env/dev");
  assert.equal(bash("kit_main_root; kit_dev_root", { KIT_ROOT: root, KIT_MAIN_ROOT: "/env/main", KIT_DEV_ROOT: "/env/dev" }).stdout, "/env/main\n/env/dev\n");
  // KIT_PREVIEW_URL beats an unreachable preview address in the file.
  const f = repo(t, { project: "kit-land", branches: { land: "main" }, preview: "http://127.0.0.1:9/settings" });
  const server = createServer((_request, response) => response.end('<script src="/assets/index-env123.js"></script>'));
  await new Promise<void>(accept => server.listen(0, "127.0.0.1", accept));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const { stdout } = await promisify(execFile)(kit, ["status", "--no-fetch"], { cwd: f.root, env: { ...f.env, KIT_PREVIEW_URL: `http://127.0.0.1:${port}/` }, encoding: "utf8" });
  assert.match(stdout, /^preview: index-env123\.js$/m);
});

test("land: main reaches review, unit --affected, pr --dry-run, status and wait ci", t => {
  const f = repo(t, { project: "kit-land", branches: { land: "main" } });
  // An invalid model stops the review after it states its scope, before any CLI runs.
  const review = f.run(["review"], { ASE_REVIEW_MODEL: "-invalid" });
  assert.match(review.stdout, /^scope: --base origin\/main \(git diff [0-9a-f]{40}\.\.\.HEAD\)$/m);
  assert.match(lastLine(review)!, /^RESULT: fail /);
  // The repo has no origin/dev, so the selection can only come from origin/main; --affected reads the project's import scan.
  symlinkSync(resolve("scripts/agents/specs-affected.mjs"), join(f.root, "scripts/agents/specs-affected.mjs"));
  const unit = f.run(["unit", "--affected", "--list"]);
  assert.equal(unit.status, 0, unit.stdout + unit.stderr);
  assert.match(unit.stdout, /^tests\/a\.test\.ts — changed$/m);
  assert.equal(lastLine(unit), "RESULT: ok unit 1 selected (list only)");
  rmSync(join(f.root, "scripts/agents/specs-affected.mjs")); // kit pr needs a clean tree.
  const pr = f.run(["pr", "--dry-run"]);
  assert.equal(pr.status, 0, pr.stdout + pr.stderr);
  assert.match(pr.stdout, /^base: main$/m);
  assert.match(pr.stdout, /^check: skipped \(no checks\.check in scripts\/agents\/kit\.json\)$/m);
  assert.match(lastLine(pr)!, /^RESULT: ok dry-run [0-9a-f]{7} feature\/x -> main$/);
  assert.match(f.called(), /^kit specs --affected --base origin\/main$/m);
  const status = f.run(["status", "--no-fetch"]);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.match(status.stdout, /^ref origin\/main [0-9a-f]{7} {2}main CI: -$/m);
  assert.match(f.called(), /^gh pr list --state all --base main /m);
  assert.match(f.called(), /^gh run list --branch main /m);
  const ci = f.run(["wait", "ci", "--timeout", "10s"], { KIT_WAIT_POLL_MS: "50" });
  assert.equal(ci.status, 0, ci.stdout + ci.stderr);
  assert.match(lastLine(ci)!, /^RESULT: ok ci main abcdef0 green /);
  assert.match(f.called(), /^gh api repos\/\{owner\}\/\{repo\}\/commits\/main --jq \.sha$/m);
  assert.match(f.called(), /^gh run list --workflow 1 --branch main /m);
});

test("wait ci follows branches.ci over land, and a --pr wait needs no settings", t => {
  const f = repo(t, { project: "kit-land", branches: { land: "main", ci: "ci-branch" } });
  const ci = f.run(["wait", "ci", "--timeout", "10s"], { KIT_WAIT_POLL_MS: "50" });
  assert.equal(ci.status, 0, ci.stdout + ci.stderr);
  assert.match(lastLine(ci)!, /^RESULT: ok ci ci-branch abcdef0 green /);
  assert.match(f.called(), /^gh api repos\/\{owner\}\/\{repo\}\/commits\/ci-branch --jq \.sha$/m);
  assert.match(f.called(), /^gh run list --workflow 1 --branch ci-branch /m);
  // A broken file stops a plain wait but not one that names its PR.
  const broken = repo(t, '{ "project": ');
  const plain = broken.run(["wait", "ci", "--timeout", "10s"], { KIT_WAIT_POLL_MS: "50" });
  assert.notEqual(plain.status, 0, plain.stdout + plain.stderr);
  const pr = broken.run(["wait", "ci", "--pr", "7", "--timeout", "10s"], { KIT_WAIT_POLL_MS: "50" });
  assert.equal(pr.status, 0, pr.stdout + pr.stderr);
  assert.match(lastLine(pr)!, /^RESULT: ok ci pr 7 abcdef0 green /);
  assert.match(broken.called(), /^gh run list --workflow 1 --branch feature\/x /m);
});

test("bash and node agree on mainRoot, which only a valid file supplies", t => {
  const root = temp(t);
  spawnSync("git", ["init", "-q", root], { env: clean });
  const saved = process.env.KIT_ROOT, savedMain = process.env.KIT_MAIN_ROOT;
  t.after(() => {
    if (saved === undefined) delete process.env.KIT_ROOT; else process.env.KIT_ROOT = saved;
    if (savedMain === undefined) delete process.env.KIT_MAIN_ROOT; else process.env.KIT_MAIN_ROOT = savedMain;
  });
  process.env.KIT_ROOT = root;
  delete process.env.KIT_MAIN_ROOT;
  settingsFile(root, { project: "x", mainRoot: "/a" });
  // Incomplete: both use the main worktree, never the file's mainRoot.
  assert.equal(kitMainRoot(), realpathSync(root));
  assert.equal(bash("kit_main_root", { KIT_ROOT: root }).stdout, `${kitMainRoot()}\n`);
});

test("a maps folder with a trailing slash is read as one spelling", t => {
  const root = temp(t);
  settingsFile(root, { project: "x", branches: { land: "main" }, maps: "docs/wayfinder/" });
  assert.equal(kitSettings(root).maps, "docs/wayfinder");
  assert.equal(scoreMap("docs/wayfinder/alpha/build/tickets/01-x.md", kitMaps(kitSettings(root))), "alpha");
});

test("deps add takes its prefix from KIT_DEV_ROOT, then devRoot, else asks for --prefix", t => {
  const root = temp(t);
  settingsFile(root, { project: "x", branches: { land: "main" }, devRoot: "/settings/dev" });
  const saved = process.env.KIT_DEV_ROOT;
  t.after(() => { if (saved === undefined) delete process.env.KIT_DEV_ROOT; else process.env.KIT_DEV_ROOT = saved; });
  delete process.env.KIT_DEV_ROOT;
  assert.equal(optionsFor(["add", "left-pad"], root).prefix, "/settings/dev");
  assert.equal(optionsFor(["add", "left-pad", "--prefix", "/given"], root).prefix, "/given");
  process.env.KIT_DEV_ROOT = "/env/dev";
  assert.equal(optionsFor(["add", "left-pad"], root).prefix, "/env/dev");
  // The override wins even without a usable settings file.
  const bare = temp(t);
  assert.equal(optionsFor(["add", "left-pad"], bare).prefix, "/env/dev");
  delete process.env.KIT_DEV_ROOT;
  assert.throws(() => optionsFor(["add", "left-pad"], bare),
    (error: Error) => error.constructor.name === "UsageError" && error.message === "add needs --prefix or devRoot in scripts/agents/kit.json");
});

test("kit pr pairs --release with branches.release, whatever its name", t => {
  const prod = repo(t, { project: "kit-land", branches: { land: "main", release: "prod" } });
  for (const [args, message] of [[["--base", "prod"], "--base prod requires --release"], [["--release"], "--release requires --base prod"]] as const) {
    const output = prod.run(["pr", "--dry-run", ...args]);
    assert.equal(output.status, 1, output.stdout + output.stderr);
    assert.equal(lastLine(output), `RESULT: fail guards: ${message}`);
  }
  const none = repo(t, { project: "kit-land", branches: { land: "main" } });
  const output = none.run(["pr", "--dry-run", "--release"]);
  assert.equal(lastLine(output), "RESULT: fail guards: --release needs branches.release in scripts/agents/kit.json");
});

test("worktree.sh names, bases and links a worktree from the settings file", t => {
  const f = repo(t, { project: "kit-land", branches: { land: "main" } });
  const made = spawnSync("bash", [resolve("scripts/agents/worktree.sh"), "feature/y"], { cwd: f.root, env: { ...f.env, KIT_MAIN_ROOT: "" }, encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const path = join(dirname(realpathSync(f.root)), "kit-land-feature-y");
  assert.equal(made.stdout, `${path}\n`);
  assert.match(readFileSync(join(path, ".scratch/owner"), "utf8"), / feature\/y origin\/main\n$/);
  assert.match(made.stderr, /No sharedNodeModules in scripts\/agents\/kit\.json/);
  assert.equal(existsSync(join(path, "node_modules")), false);
  // The preview link is made even before the main checkout builds its fixture.
  const link = join(path, ".scratch/native-static-preview");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), join(realpathSync(f.root), ".scratch/native-static-preview"));
});

test("without a maps folder, next and heartbeat say so, tickets.mjs reads nothing and score still lists records", t => {
  const f = repo(t, { project: "kit-land", branches: { land: "main" }, devRoot: "/settings/dev" });
  for (const args of [["next"], ["heartbeat", "alpha"]]) {
    const output = f.run(args);
    assert.equal(output.status, 1, output.stdout + output.stderr);
    assert.equal(lastLine(output), `RESULT: fail ${args[0]} needs a maps folder; add maps to scripts/agents/kit.json`);
  }
  const tickets = spawnSync(process.execPath, [resolve("scripts/agents/tickets.mjs"), "check"], { cwd: f.root, env: f.env, encoding: "utf8" });
  assert.equal(tickets.status, 0, tickets.stderr);
  assert.equal(tickets.stdout, "No maps folder in scripts/agents/kit.json; no tickets to read.\n");
  // kitScore files records under _untracked without maps; kit score lists them, and only a page or snapshot needs maps.
  const records = join(f.main, ".scratch/scoreboard/_untracked");
  mkdirSync(records, { recursive: true });
  writeFileSync(join(records, "feature%2Fx.json"), JSON.stringify({ ticket: null, title: null, kind: null, builder: null, phases: [], rounds: 1, reviews: [], cost: null, costs: {}, landed: null }));
  const listed = f.run(["score"]);
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.match(listed.stdout, /^score: _untracked \(1 pieces\)$/m);
  const page = f.run(["score", "_untracked", "--html"]);
  assert.equal(page.status, 1, page.stdout + page.stderr);
  assert.equal(lastLine(page), 'RESULT: fail score no "maps" folder in scripts/agents/kit.json; this command needs one');
});

test("a settings problem fails kit review and unit.sh as a failure, not a usage error", t => {
  const f = repo(t, { project: "kit-land" });
  const review = f.run(["review"]);
  assert.equal(review.status, 1, review.stdout + review.stderr);
  assert.match(review.stderr, /^problem: add "branches": \{ "land": "<branch>" \} to scripts\/agents\/kit\.json$/m);
  assert.doesNotMatch(review.stderr, /Usage:/);
  const broken = repo(t, '{ "project": ');
  const unit = spawnSync("bash", [resolve("scripts/agents/unit.sh"), "tests/a.test.ts"], { cwd: broken.root, env: broken.env, encoding: "utf8" });
  assert.equal(unit.status, 1, unit.stdout + unit.stderr);
  assert.match(unit.stderr, /^unit\.sh: scripts\/agents\/kit\.json is unreadable: /m);
});
