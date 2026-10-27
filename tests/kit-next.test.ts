import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const next = resolve("scripts/agents/kit.d/next");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

type Ticket = { type?: string; assignee?: string; builder?: string; files?: string[]; runsAlone?: boolean; blockedBy?: string[]; status?: string; group?: string };

function ticket({ type = "task (AFK)", assignee = "", builder = "claude", files = [], runsAlone, blockedBy = [], status = "open", group }: Ticket) {
  return ["---", "title: T", `type: ${type}`, `status: ${status}`, `assignee: ${assignee}`, `builder: ${builder}`, `blocked_by: [${blockedBy.join(", ")}]`,
    ...(runsAlone === undefined ? [] : [`runs_alone: ${runsAlone}`]), ...(group ? [`group: ${group}`] : []), "---", "", "## Goal", "", "Do it.", "", "## Files", "", ...files.map(file => `- \`${file}\``), "", "## Done when", "", "- done", ""].join("\n");
}

// A bare origin and a dev clone holding the given files, a fake kit (bg --list reads
// each worktree's job records; bg <name> logs its call) and a fake worktree.sh. The dev clone sits at `devPath`.
function fixture(t: TestContext, files: Record<string, string>, land = "dev", overrides: Record<string, unknown> = {}, devPath = "dev") {
  const root = mkdtempSync(join(tmpdir(), "kit-next-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dev = join(root, devPath);
  const env: NodeJS.ProcessEnv = { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: "1", KIT_DEV_ROOT: dev, KIT_NEXT_KIT: join(root, "fake-kit"), KIT_NEXT_WORKTREE: join(root, "fake-worktree.sh"), FAKE_KIT_LOG: join(root, "kit.log") };
  delete env.KIT_ROOT;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(root, "init", "-q", "--bare", "-b", land, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), devPath);
  git(dev, "checkout", "-q", "-b", land);
  const write = (base: string, entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), content); }
  };
  const settings = { project: "kit-next", branches: { land }, maps: "docs/wayfinder", sharedFile: "src/main.ts", ...overrides };
  write(dev, { "README.md": "repo\n", "scripts/agents/kit.json": JSON.stringify(settings), ...files });
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "fixture");
  git(dev, "push", "-q", "-u", "origin", land);
  writeFileSync(join(root, "fake-kit"), `#!/usr/bin/env bash
if [[ $1 == bg && $2 == --list ]]; then
  for d in "$KIT_ROOT"/.scratch/kit-jobs/*/; do [[ -d $d ]] && printf '%s\\t%s\\t1s\\t%slog\\n' "$(basename "$d")" "$(cat "$d/state")" "$d"; done
  echo 'RESULT: ok bg list'; exit 0
fi
printf '%s|%s|%s|%s\\n' "$PWD" "$ASE_REVIEW_MODEL" "$ASE_OWNER" "$*" >> "$FAKE_KIT_LOG"
[[ -z \${FAKE_BG_FAIL:-} ]] || { echo "RESULT: fail bg $2 broken"; exit 1; }
[[ -z \${FAKE_BG_HOOK:-} ]] || bash -c "$FAKE_BG_HOOK" hook "$@" >&2
[[ -z \${FAKE_FAIL_ON:-} || $* != *"$FAKE_FAIL_ON"* ]] || { echo "RESULT: fail $1 broken"; exit 1; }
echo "RESULT: ok bg $2 pid 1"
`);
  writeFileSync(join(root, "fake-worktree.sh"), `#!/usr/bin/env bash
set -euo pipefail
[[ -z \${FAKE_WORKTREE_FAIL:-} ]] || { echo "fatal: a branch named '$1' already exists" >&2; exit 1; }
path="$(dirname "$(git rev-parse --show-toplevel)")/wt-\${1//\\//-}"
git worktree add -q -b "$1" "$path" "$2" >&2
printf '%s\\n' "$ASE_OWNER" > "$path/owner"
printf '%s %s\\n' "$1" "$2" >> "$(dirname "$path")/bases"
printf '%s\\n' "$path"
`);
  chmodSync(join(root, "fake-kit"), 0o755);
  chmodSync(join(root, "fake-worktree.sh"), 0o755);
  // A slice job in its own worktree: the recorded command names its ticket, as kit bg writes it.
  const running = (name: string, ticketFile: string, state = "running", command = `'scripts/agents/kit' 'slice' '--ticket' '${ticketFile}' '--builder' 'claude-opus-5-5'\n`) => {
    const worktree = join(root, `job-${name}`);
    git(dev, "worktree", "add", "-q", "--detach", worktree, `origin/${land}`);
    const directory = join(worktree, ".scratch/kit-jobs", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state"), `${state}\n`);
    writeFileSync(join(directory, "command"), command);
    return worktree;
  };
  const runIn = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [next, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  const run = (...args: string[]) => runIn(dev, ...args);
  const lines = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim().split("\n").filter(line => !line.startsWith("running: "));
  };
  return { root, dev, env, git, write, running, run, runIn, lines };
}

const build = (map: string, slug: string) => `docs/wayfinder/${map}/build/tickets/${slug}.md`;

test("rule 1 skips non-AFK and claimed tickets and unstarted builds; order and builders follow the fixed rules", t => {
  const { lines } = fixture(t, {
    "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
    [build("alpha", "01-grill")]: ticket({ type: "grilling (HITL)" }),
    [build("alpha", "03-claimed")]: ticket({ assignee: "al-03" }),
    "docs/wayfinder/alpha/tickets/05-research.md": ticket({ type: "research (AFK)" }),
    [build("alpha", "9-nine")]: ticket({ builder: "sol", files: ["a/nine.ts"] }),
    [build("alpha", "10-ten")]: ticket({ builder: "claude-opus-5-5", files: ["a/ten.ts"] }),
    [build("alpha", "11-free")]: ticket({ builder: "opencode/deepseek-v4.1-flash-free", files: ["a/eleven.ts"] }),
    [build("alpha", "12-luna")]: ticket({ builder: "gpt-6-luna", files: ["a/twelve.ts"] }),
    [build("alpha", "13-blocked")]: ticket({ blockedBy: ["01-grill"] }),
    [build("alpha", "14-more")]: ticket({ files: ["a/fourteen.ts"] }),
    [build("alpha", "15-over")]: ticket({ files: ["a/fifteen.ts"] }),
    [build("beta", "01-b")]: ticket({ builder: "", files: ["b/one.ts"] }),
    "docs/wayfinder/gamma/build/README.md": "# Build\n\n**Not started:** after alpha lands.\n\nprefix: ga\n",
    "docs/wayfinder/delta/build/README.md": "# Build\n\n## Notes\n\n**Not started:** quoted below the first heading, so it does not count.\n",
    [build("delta", "01-d")]: ticket({ files: ["d/one.ts"] }),
    [build("Upper", "01-u")]: ticket({ files: ["u/one.ts"] }),
    [build("gamma", "01-g")]: ticket({}),
    "docs/wayfinder/gamma/tickets/02-map-task.md": ticket({ files: ["g/map.ts"] }),
  });
  assert.deepEqual(lines("beta", "alpha", "gamma"), [
    `next: ${build("beta", "01-b")} builder=claude-opus-5-5 owner=beta-01 why=slot 1/5`,
    `next: ${build("alpha", "9-nine")} builder=claude-opus-5-5 owner=al-9 why=slot 2/5`,
    `next: ${build("alpha", "10-ten")} builder=claude-opus-5-5 owner=al-10 why=slot 3/5`,
    `next: ${build("alpha", "11-free")} builder=delegate opencode/deepseek-v4.1-flash-free owner=al-11 why=delegated, no slot`,
    `next: ${build("alpha", "12-luna")} builder=gpt-6-luna owner=al-12 why=slot 4/5`,
    `next: ${build("alpha", "14-more")} builder=claude-opus-5-5 owner=al-14 why=slot 5/5`,
    `waits: ${build("alpha", "01-grill")} needs Lex (type: grilling (HITL))`,
    `waits: ${build("alpha", "03-claimed")} claimed by al-03, no running job found`,
    "waits: docs/wayfinder/alpha/tickets/05-research.md needs Lex (type: research (AFK))",
    `waits: ${build("alpha", "15-over")} cap 5 slices running`,
    `waits: ${build("gamma", "01-g")} build not started (README **Not started:**)`,
    "waits: docs/wayfinder/gamma/tickets/02-map-task.md build not started (README **Not started:**)",
    "RESULT: ok next 6 ready, 6 waiting",
  ]);
  assert.match(lines("delta").join("\n"), /^next: docs\/wayfinder\/delta\/build\/tickets\/01-d\.md /);
  assert.equal(lines("Upper").at(-1), "RESULT: ok next 0 ready, 1 waiting");
  // Without maps, alphabetical: alpha's tickets come first.
  assert.match(lines()[0], /^next: docs\/wayfinder\/alpha\/build\/tickets\/9-nine\.md /);
});

test("rule 2 counts running slices of every worktree toward the cap; --max lowers it and never raises it", t => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 6; i++) files[build("alpha", `0${i}-t`)] = ticket({ assignee: i <= 4 ? `alpha-0${i}` : "", files: [`a/${i}.ts`] });
  const { running, lines } = fixture(t, files);
  for (let i = 1; i <= 4; i++) running(`slice-alpha0${i}`, build("alpha", `0${i}-t`));
  running("slice-old", build("alpha", "01-t"), "exit 0");
  running("review-1", build("alpha", "02-t"));
  assert.deepEqual(lines("alpha"), [
    `next: ${build("alpha", "05-t")} builder=claude-opus-5-5 owner=alpha-05 why=slot 5/5`,
    `waits: ${build("alpha", "06-t")} cap 5 slices running`,
    "RESULT: ok next 1 ready, 1 waiting",
  ]);
  assert.deepEqual(lines("alpha", "--max", "4").slice(0, 2), [`waits: ${build("alpha", "05-t")} cap 4 slices running`, `waits: ${build("alpha", "06-t")} cap 4 slices running`]);
  assert.equal(lines("alpha", "--max", "9").at(-1), "RESULT: ok next 1 ready, 1 waiting");
});

test("rule 3 allows at most two slices in src/main.ts, counting the ones it hands out", t => {
  const { running, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["src/main.ts"] }),
    [build("alpha", "02-main")]: ticket({ files: ["src/main.ts", "src/two.ts"] }),
    [build("alpha", "03-main")]: ticket({ files: ["src/main.ts", "src/three.ts"] }),
    [build("alpha", "04-glob")]: ticket({ files: ["src/**/*.ts"] }),
    [build("alpha", "05-other")]: ticket({ files: ["scripts/five.mjs"] }),
  });
  running("slice-alpha01", build("alpha", "01-run"));
  assert.deepEqual(lines("alpha"), [
    `next: ${build("alpha", "02-main")} builder=claude-opus-5-5 owner=alpha-02 why=slot 2/5, src/main.ts 2/2`,
    `next: ${build("alpha", "05-other")} builder=claude-opus-5-5 owner=alpha-05 why=slot 3/5`,
    `waits: ${build("alpha", "03-main")} 2 slices in src/main.ts: slice-alpha01, slice-alpha02`,
    `waits: ${build("alpha", "04-glob")} 2 slices in src/main.ts: slice-alpha01, slice-alpha02`,
    "RESULT: ok next 2 ready, 2 waiting",
  ]);
});

test("without sharedFile in the settings, src/main.ts is shared like any other file", t => {
  const { running, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["src/main.ts"] }),
    [build("alpha", "02-main")]: ticket({ files: ["src/main.ts", "src/two.ts"] }),
  }, "dev", { sharedFile: undefined });
  running("slice-alpha01", build("alpha", "01-run"));
  assert.deepEqual(lines("alpha"), [
    `waits: ${build("alpha", "02-main")} shares src/main.ts with slice-alpha01`,
    "RESULT: ok next 0 ready, 1 waiting",
  ]);
});

test("rule 4 waits on any shared file, a glob or a find-it-with line counting as its directory", t => {
  const { running, write, git, dev, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["scripts/a.mjs", "tests/foo/*.test.ts", ".github/workflows/ci.yml"] }),
    [build("alpha", "02-same")]: ticket({ files: ["scripts/a.mjs"] }),
    [build("alpha", "03-under-glob")]: ticket({ files: ["tests/foo/bar.test.ts"] }),
    [build("alpha", "05-free")]: ticket({ files: ["docs/five.md"] }),
    [build("alpha", "06-after-free")]: ticket({ files: ["docs/five.md", "docs/six.md"] }),
    [build("alpha", "07-ci")]: ticket({ files: [".github/workflows/ci.yml"] }),
  });
  write(dev, { [build("alpha", "04-find")]: `${ticket({})}`.replace("## Done when", "- `tests/kit-x.test.ts` (or the file covering it; find it with `grep -ln x tests/`)\n\n## Done when") });
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "find");
  git(dev, "push", "-q");
  running("slice-alpha01", build("alpha", "01-run"));
  assert.deepEqual(lines("alpha"), [
    `next: ${build("alpha", "05-free")} builder=claude-opus-5-5 owner=alpha-05 why=slot 2/5`,
    `waits: ${build("alpha", "02-same")} shares scripts/a.mjs with slice-alpha01`,
    `waits: ${build("alpha", "03-under-glob")} shares tests/foo/bar.test.ts with slice-alpha01`,
    `waits: ${build("alpha", "04-find")} shares tests/ with slice-alpha01`,
    `waits: ${build("alpha", "06-after-free")} shares docs/five.md with slice-alpha05`,
    `waits: ${build("alpha", "07-ci")} shares .github/workflows/ci.yml with slice-alpha01`,
    "RESULT: ok next 1 ready, 5 waiting",
  ]);
});

test("rule 5: runs_alone waits for every other slice of its map and blocks new ones while it runs", t => {
  const { running, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["a/one.ts"] }),
    [build("alpha", "02-alone")]: ticket({ runsAlone: true, files: ["a/two.ts"] }),
    [build("beta", "01-alone")]: ticket({ runsAlone: true, files: ["b/one.ts"] }),
    [build("beta", "02-after")]: ticket({ runsAlone: false, files: ["b/two.ts"] }),
    [build("gamma", "01-run")]: ticket({ assignee: "gamma-01", runsAlone: true, files: ["g/one.ts"] }),
    [build("gamma", "02-after")]: ticket({ files: ["g/two.ts"] }),
  });
  running("slice-alpha01", build("alpha", "01-run"));
  running("slice-gamma01", build("gamma", "01-run"));
  assert.deepEqual(lines(), [
    `next: ${build("beta", "01-alone")} builder=claude-opus-5-5 owner=beta-01 why=slot 3/5`,
    `waits: ${build("alpha", "02-alone")} runs alone; waits for slice-alpha01`,
    `waits: ${build("beta", "02-after")} slice-beta01 runs alone`,
    `waits: ${build("gamma", "02-after")} slice-gamma01 runs alone`,
    "RESULT: ok next 1 ready, 3 waiting",
  ]);
});

test("a running job's absolute --ticket path still gives its map and Files and covers its claim", t => {
  const { dev, running, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", runsAlone: true, files: ["a/one.ts"] }),
    [build("alpha", "02-shared")]: ticket({ files: ["a/one.ts"] }),
    [build("alpha", "03-other")]: ticket({ files: ["a/three.ts"] }),
  });
  running("slice-alpha01", "", "running", `'scripts/agents/kit' 'slice' '--ticket' '${join(dev, build("alpha", "01-run"))}' '--builder' 'claude-opus-5-5'\n`);
  assert.deepEqual(lines("alpha"), [
    `waits: ${build("alpha", "02-shared")} shares a/one.ts with slice-alpha01`,
    `waits: ${build("alpha", "03-other")} slice-alpha01 runs alone`,
    "RESULT: ok next 0 ready, 2 waiting",
  ]);
});

test("a bad runs_alone value or a broken blocker fails before any hand-out", t => {
  const { run } = fixture(t, { [build("alpha", "01-bad")]: ticket({}).replace("blocked_by: []", "blocked_by: []\nruns_alone: yes") });
  const result = run("alpha");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /01-bad\.md:8: runs_alone must be true or false: yes/);
  assert.match(result.stdout, /^RESULT: fail next 1 ticket problems$/m);
  assert.equal(run("--max", "x").status, 2);
});

const startFiles = {
  "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
  [build("alpha", "01-first-slice")]: ticket({ files: ["a/one.ts"] }),
  [build("alpha", "02-free")]: ticket({ builder: "opencode/deepseek-v4.1-flash-free", files: ["a/two.ts"] }),
};

test("--start claims on dev, pushes, makes the worktree and starts the slice; delegated tickets are only claimed", t => {
  const { root, dev, env, git, run } = fixture(t, startFiles);
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const worktree = join(root, "wt-build-al-01-first-slice");
  const claims = git(join(root, "origin.git"), "log", "--format=%s", "dev").trim().split("\n");
  assert.deepEqual(claims, ["docs: claim alpha 02", "docs: claim alpha 01", "fixture"]);
  for (const [slug, owner] of [["01-first-slice", "al-01"], ["02-free", "al-02"]])
    assert.match(git(join(root, "origin.git"), "show", `dev:${build("alpha", slug)}`), new RegExp(`^assignee: ${owner}$`, "m"));
  assert.equal(git(worktree, "branch", "--show-current").trim(), "build/al-01-first-slice");
  assert.match(git(worktree, "log", "-1", "--format=%s"), /docs: claim alpha 01/);
  assert.equal(readFileSync(join(worktree, "owner"), "utf8"), "al-01\n");
  assert.equal(readFileSync(env.FAKE_KIT_LOG!, "utf8"),
    `${worktree}|claude-opus-5-5|al-01|bg slice-al01 -- scripts/agents/kit slice --ticket ${build("alpha", "01-first-slice")} --builder claude-opus-5-5\n`);
  assert.ok(!existsSync(join(root, "wt-build-al-02-free")));
  const out = result.stdout;
  assert.match(out, /^claimed: docs\/wayfinder\/alpha\/build\/tickets\/01-first-slice\.md owner=al-01 [0-9a-f]+ \(pushed\)$/m);
  assert.ok(out.includes(`worktree: ${worktree}\nstarted: slice-al01\nwait: KIT_ROOT=${worktree} scripts/agents/kit wait job slice-al01 --timeout 2h\n`));
  assert.match(out, /^delegate: docs\/wayfinder\/alpha\/build\/tickets\/02-free\.md opencode\/deepseek-v4\.1-flash-free owner=al-02$/m);
  assert.match(out, /RESULT: ok next 2 ready, 0 waiting, 1 started\n$/);
  assert.equal(git(dev, "status", "--porcelain").trim(), "");
});

test("--start without a fake kit starts the job through $KIT_HOME/kit in the new worktree", t => {
  const { root, env, run } = fixture(t, startFiles);
  delete env.KIT_NEXT_KIT;
  // A kit home with the real commands and library, whose front door records its call.
  const home = join(root, "kit-home"), log = join(root, "home-kit.log");
  mkdirSync(home);
  for (const name of ["kit.d", "kit-lib.sh", "kit-lib.mjs"]) symlinkSync(resolve("scripts/agents", name), join(home, name));
  writeFileSync(join(home, "kit"), `#!/usr/bin/env bash\nprintf '%s|%s\\n' "$PWD" "$*" >> ${JSON.stringify(log)}\necho "RESULT: ok bg $2 pid 1"\n`);
  chmodSync(join(home, "kit"), 0o755);
  env.KIT_HOME = home;
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const worktree = join(root, "wt-build-al-01-first-slice");
  assert.equal(readFileSync(log, "utf8"),
    `${worktree}|bg slice-al01 -- scripts/agents/kit slice --ticket ${build("alpha", "01-first-slice")} --builder claude-opus-5-5\n`);
  assert.match(result.stdout, /RESULT: ok next 2 ready, 0 waiting, 1 started\n$/);
});

test("--start on a project that lands on main claims, pushes and branches from origin/main", t => {
  const { root, dev, git, run } = fixture(t, startFiles, "main");
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(git(join(root, "origin.git"), "log", "--format=%s", "main").trim().split("\n"), ["docs: claim alpha 02", "docs: claim alpha 01", "fixture"]);
  assert.equal(git(join(root, "origin.git"), "branch", "--list", "dev").trim(), "");
  const worktree = join(root, "wt-build-al-01-first-slice");
  assert.ok(existsSync(worktree));
  assert.equal(readFileSync(join(root, "bases"), "utf8"), "build/al-01-first-slice origin/main\n");
  assert.equal(git(dev, "branch", "--show-current").trim(), "main");
  assert.match(result.stdout, /RESULT: ok next 2 ready, 0 waiting, 1 started\n$/);
});

test("next --help names this editor's land branch, and placeholders when the settings file is unreadable", t => {
  const own = spawnSync(process.execPath, [next, "--help"], { encoding: "utf8" });
  assert.equal(own.status, 0, own.stderr);
  assert.ok(own.stdout.includes("read from origin/dev in the dev worktree"), own.stdout);
  assert.ok(own.stdout.includes("--start claims each next: ticket or group on dev"), own.stdout);
  const broken = mkdtempSync(join(tmpdir(), "kit-next-"));
  t.after(() => rmSync(broken, { recursive: true, force: true }));
  mkdirSync(join(broken, "scripts/agents"), { recursive: true });
  writeFileSync(join(broken, "scripts/agents/kit.json"), "{ broken");
  const placeholder = spawnSync(process.execPath, [next, "--help"], { env: { ...process.env, KIT_ROOT: broken }, encoding: "utf8" });
  assert.equal(placeholder.status, 0, placeholder.stderr);
  assert.ok(placeholder.stdout.includes("read from origin/<land> in the dev worktree"), placeholder.stdout);
});

// A pre-push hook in the dev clone lands another commit on origin the first `times` times it runs.
function racePush(root: string, git: (cwd: string, ...args: string[]) => string, change: string, content: string, times = 1) {
  git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), `#!/usr/bin/env bash
n=$(cat ${root}/raced 2>/dev/null || echo 0)
(( n >= ${times} )) && exit 0
echo $((n + 1)) > ${root}/raced
cd ${join(root, "other")} || exit 1
mkdir -p "$(dirname '${change}')" && printf '%s' '${content}' > '${change}'
git add -A && git commit -q --allow-empty -m 'other lead' && git push -q origin HEAD:dev
`);
  chmodSync(join(hooks, "pre-push"), 0o755);
  git(join(root, "dev"), "config", "core.hooksPath", hooks);
}

test("--start rebases a rejected claim push onto the new dev and retries once", t => {
  const { root, git, run } = fixture(t, { [build("alpha", "01-one")]: ticket({ files: ["a/one.ts"] }) });
  racePush(root, git, "notes.md", "other\n");
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^claimed: \S+01-one\.md owner=alpha-01 [0-9a-f]+ \(pushed after rebase\)$/m);
  assert.deepEqual(git(join(root, "origin.git"), "log", "--format=%s", "dev").trim().split("\n"), ["docs: claim alpha 01", "other lead", "fixture"]);
});

test("--start stops when the claim conflicts with a claim another lead pushed meanwhile", t => {
  const { root, dev, git, run } = fixture(t, { [build("alpha", "01-one")]: ticket({ files: ["a/one.ts"] }) });
  racePush(root, git, build("alpha", "01-one"), ticket({ assignee: "someone-else", files: ["a/one.ts"] }));
  const result = run("alpha", "--start");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail next start \S+01-one\.md: claim conflicts with origin\/dev; rebase aborted$/m);
  assert.equal(git(dev, "status", "--porcelain").trim(), "");
  assert.equal(git(dev, "rev-list", "origin/dev..HEAD").trim(), "");
  assert.ok(!existsSync(join(root, "wt-build-alpha-01-one")));
  const again = run("alpha", "--start");
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert.match(again.stdout, /^waits: \S+01-one\.md claimed by someone-else, no running job found$/m);
  assert.match(again.stdout, /RESULT: ok next 0 ready, 1 waiting, 0 started\n$/);
});

type Git = (cwd: string, ...args: string[]) => string;

test("--start fails when the push is rejected again after the rebase and leaves dev on origin/dev", t => {
  const { root, dev, git, run } = fixture(t, { [build("alpha", "01-one")]: ticket({ files: ["a/one.ts"] }) });
  racePush(root, git, "notes.md", "other\n", 2);
  const result = run("alpha", "--start");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail next start \S+01-one\.md: git push failed: /m);
  assert.equal(git(dev, "rev-parse", "HEAD"), git(dev, "rev-parse", "origin/dev"));
  assert.equal(git(dev, "status", "--porcelain").trim(), "");
  assert.deepEqual(git(join(root, "origin.git"), "log", "--format=%s", "dev").trim().split("\n"), ["other lead", "other lead", "fixture"]);
});

test("--start adds a missing assignee: line right after status:", t => {
  const { root, run } = fixture(t, { [build("alpha", "01-one")]: ticket({ files: ["a/one.ts"] }).replace("assignee: \n", "") });
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const claimed = execFileSync("git", ["-C", join(root, "origin.git"), "show", `dev:${build("alpha", "01-one")}`], { encoding: "utf8" });
  assert.deepEqual(claimed.split("\n").slice(2, 5), ["type: task (AFK)", "status: open", "assignee: alpha-01"]);
});

test("map and build tickets with one number get different owners and jobs", t => {
  const { run } = fixture(t, {
    "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
    [build("alpha", "01-build")]: ticket({ files: ["a/build.ts"] }),
    "docs/wayfinder/alpha/tickets/01-map.md": ticket({ files: ["a/map.ts"] }),
  });
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^next: \S+build\/tickets\/01-build\.md builder=claude-opus-5-5 owner=al-01 /m);
  assert.match(result.stdout, /^next: docs\/wayfinder\/alpha\/tickets\/01-map\.md builder=claude-opus-5-5 owner=al-m01 /m);
  assert.match(result.stdout, /^started: slice-al01$/m);
  assert.match(result.stdout, /^started: slice-alm01$/m);
  assert.match(result.stdout, /RESULT: ok next 2 ready, 0 waiting, 2 started\n$/);
});

test("--start refuses a dev worktree off dev, with tracked changes, or ahead (and behind) of origin, and pushes nothing", t => {
  const behind = (git: Git, root: string) => {
    git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
    git(join(root, "other"), "commit", "-q", "--allow-empty", "-m", "other lead");
    git(join(root, "other"), "push", "-q", "origin", "HEAD:dev");
  };
  for (const [setup, message, origin] of [
    [(git: Git, dev: string) => git(dev, "checkout", "-q", "-b", "elsewhere"), "is not on dev", ["fixture"]],
    [(_git: Git, dev: string) => writeFileSync(join(dev, "README.md"), "changed\n"), "has uncommitted changes", ["fixture"]],
    [(git: Git, dev: string) => git(dev, "commit", "-q", "--allow-empty", "-m", "local"), "has commits not on origin/dev", ["fixture"]],
    [(git: Git, dev: string, root: string) => { git(dev, "commit", "-q", "--allow-empty", "-m", "local"); behind(git, root); }, "has commits not on origin/dev", ["other lead", "fixture"]],
  ] as const) {
    const { root, dev, git, run } = fixture(t, { [build("alpha", "01-one")]: ticket({ files: ["a/one.ts"] }) });
    setup(git, dev, root);
    const result = run("alpha", "--start");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^RESULT: fail next start \\S+01-one\\.md: \\S+ ${message}$`, "m"));
    assert.deepEqual(git(join(root, "origin.git"), "log", "--format=%s", "dev").trim().split("\n"), origin);
  }
});

test("a ticket claimed by another lead during --start moves from ready to waiting in the summary", t => {
  const { root, env, git, run } = fixture(t, {
    [build("alpha", "01-one")]: ticket({ files: ["a/one.ts"] }),
    [build("alpha", "02-two")]: ticket({ files: ["a/two.ts"] }),
  });
  git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
  const other = join(root, "other");
  writeFileSync(join(root, "claim-two.sh"), `cd ${other} || exit 1
git pull -q --rebase origin dev
sed -i 's/^assignee: $/assignee: someone-else/' ${build("alpha", "02-two")}
git commit -qam 'other claim' && git push -q origin HEAD:dev
`);
  env.FAKE_BG_HOOK = `bash ${join(root, "claim-two.sh")}`;
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^waits: \S+02-two\.md claimed meanwhile \(someone-else\)$/m);
  assert.match(result.stdout, /RESULT: ok next 1 ready, 1 waiting, 1 started\n$/);
});

test("a start that fails after the claim landed says so, and later runs report the stuck claim", t => {
  const { env, run } = fixture(t, startFiles);
  env.FAKE_BG_FAIL = "1";
  const result = run("alpha", "--start");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail next start \S+01-first-slice\.md: claimed [0-9a-f]+ but not started: kit bg slice-al01 failed: RESULT: fail bg slice-al01 broken$/m);
  delete env.FAKE_BG_FAIL;
  const after = run("alpha");
  assert.match(after.stdout, /^waits: \S+01-first-slice\.md claimed by al-01, no running job found$/m);
});

test("a worktree.sh failure after the claim landed says so, and a rerun reports the stuck claim", t => {
  const { env, run } = fixture(t, startFiles);
  env.FAKE_WORKTREE_FAIL = "1";
  const result = run("alpha", "--start");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail next start \S+01-first-slice\.md: claimed [0-9a-f]+ but not started: worktree\.sh build\/al-01-first-slice failed: fatal: a branch named 'build\/al-01-first-slice' already exists$/m);
  delete env.FAKE_WORKTREE_FAIL;
  assert.match(run("alpha").stdout, /^waits: \S+01-first-slice\.md claimed by al-01, no running job found$/m);
});

test("a running slice whose ticket is unknown or unreadable is listed and still takes a slot", t => {
  const files: Record<string, string> = {};
  for (let i = 1; i <= 4; i++) files[build("alpha", `0${i}-t`)] = ticket({ files: [`a/${i}.ts`] });
  const { running, run } = fixture(t, files);
  running("slice-a", "", "running", "'sleep' '600'\n");
  running("slice-b", build("alpha", "09-gone"));
  running("slice-c", "", "running", "");
  const result = run("alpha", "--max", "4");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n").slice(0, 4), ["running: slice-a (ticket unknown)", "running: slice-b (ticket unknown)", "running: slice-c (ticket unknown)",
    `next: ${build("alpha", "01-t")} builder=claude-opus-5-5 owner=alpha-01 why=slot 4/4`]);
  assert.match(result.stdout, /RESULT: ok next 1 ready, 3 waiting\n$/);
});

test("the real kit bg --list rows and command quoting reach kit next", t => {
  const quoted = build("alpha", "01-o'neil");
  const { root, dev, env, git, run } = fixture(t, {
    [quoted]: ticket({ assignee: "alpha-01", files: ["a/shared.ts"] }),
    [build("alpha", "02-next")]: ticket({ files: ["a/shared.ts"] }),
  });
  const worktree = join(root, "job-real");
  git(dev, "worktree", "add", "-q", "--detach", worktree, "origin/dev");
  const real = { ...env, KIT_ROOT: worktree };
  delete real.KIT_NEXT_KIT;
  const bg = (...args: string[]) => spawnSync(process.execPath, [resolve("scripts/agents/kit.d/bg"), ...args], { env: real, cwd: worktree, encoding: "utf8", timeout: 15_000 });
  const started = bg("slice-alpha01", "--", process.execPath, "-e", "setTimeout(() => {}, 60000)", "--", "--ticket", quoted);
  assert.equal(started.status, 0, started.stdout + started.stderr);
  delete env.KIT_NEXT_KIT;
  // Stop the job before the fixture's cleanup removes its records.
  let result;
  try { result = run("alpha"); }
  finally { assert.equal(bg("--stop", "slice-alpha01").status, 0); }
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), [`running: slice-alpha01 ${quoted}`, `waits: ${build("alpha", "02-next")} shares a/shared.ts with slice-alpha01`, "RESULT: ok next 0 ready, 1 waiting"]);
});

test("a group waits while one ticket is still blocked from outside it, then is one hand-out in blocked_by order", t => {
  const { dev, git, write, lines } = fixture(t, {
    "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
    [build("alpha", "01-ext")]: ticket({ files: ["x/ext.ts"] }),
    [build("alpha", "02-a")]: ticket({ group: "fonts", blockedBy: ["04-b"], files: ["a/a.ts"] }),
    [build("alpha", "03-c")]: ticket({ group: "fonts", blockedBy: ["01-ext"], files: ["a/c.ts"] }),
    [build("alpha", "04-b")]: ticket({ group: "fonts", files: ["a/b.ts"] }),
    [build("alpha", "05-done")]: ticket({ group: "fonts", status: "closed", files: ["a/done.ts"] }),
    [build("alpha", "06-z")]: ticket({ group: "later", blockedBy: ["01-ext"], files: ["z/z.ts"] }),
  });
  // 06-z's group has no member that may start, so it is not listed; 05-done is closed and left out.
  assert.deepEqual(lines("alpha"), [
    `next: ${build("alpha", "01-ext")} builder=claude-opus-5-5 owner=al-01 why=slot 1/5`,
    "waits: group fonts tickets=03-c,04-b,02-a waits for 03-c (blocked)",
    "RESULT: ok next 1 ready, 1 waiting",
  ]);
  write(dev, { [build("alpha", "01-ext")]: ticket({ status: "closed", files: ["x/ext.ts"] }) });
  git(dev, "commit", "-qam", "close 01");
  git(dev, "push", "-q");
  assert.deepEqual(lines("alpha"), [
    "next: group fonts tickets=03-c,04-b,02-a builder=claude-opus-5-5 owner=al-g-fonts why=slot 1/5",
    "next: group later tickets=06-z builder=claude-opus-5-5 owner=al-g-later why=slot 2/5",
    "RESULT: ok next 2 ready, 0 waiting",
  ]);
});

test("a group with a human ticket, mixed builders, a partial claim or a blocked_by cycle waits", t => {
  const { lines } = fixture(t, {
    [build("alpha", "01-a")]: ticket({ group: "human", files: ["a/1.ts"] }),
    [build("alpha", "02-b")]: ticket({ group: "human", type: "grilling (HITL)", files: ["a/2.ts"] }),
    [build("alpha", "03-c")]: ticket({ group: "mixed", files: ["a/3.ts"] }),
    [build("alpha", "04-d")]: ticket({ group: "mixed", builder: "gpt-6-luna", files: ["a/4.ts"] }),
    [build("alpha", "05-e")]: ticket({ group: "part", assignee: "alpha-05", files: ["a/5.ts"] }),
    [build("alpha", "06-f")]: ticket({ group: "part", files: ["a/6.ts"] }),
    [build("alpha", "07-g")]: ticket({ group: "loop", blockedBy: ["08-h"], files: ["a/7.ts"] }),
    [build("alpha", "08-h")]: ticket({ group: "loop", blockedBy: ["07-g"], files: ["a/8.ts"] }),
  });
  assert.deepEqual(lines("alpha"), [
    "waits: group human tickets=01-a,02-b needs Lex (02-b type: grilling (HITL))",
    "waits: group mixed tickets=03-c,04-d builders differ: claude-opus-5-5, gpt-6-luna",
    "waits: group part tickets=05-e,06-f partly claimed by alpha-05",
    "waits: group loop tickets=07-g,08-h blocked_by cycle in 07-g, 08-h",
    "RESULT: ok next 0 ready, 4 waiting",
  ]);
});

const groupCommand = (...files: string[]) => `'scripts/agents/kit' 'next' '--run-group' '--branch' 'build/al-g-fonts' '--builder' 'claude-opus-5-5'${files.map(file => ` '--ticket' '${file}'`).join("")}\n`;

test("a running group takes one slot, and cap and shared-file rules use the union of a group's Files", t => {
  const { running, run, lines } = fixture(t, {
    "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
    [build("alpha", "01-a")]: ticket({ group: "fonts", assignee: "al-g-fonts", files: ["a/one.ts"] }),
    [build("alpha", "02-b")]: ticket({ group: "fonts", assignee: "al-g-fonts", files: ["a/two.ts"] }),
    [build("alpha", "03-shares")]: ticket({ files: ["a/two.ts"] }),
    [build("alpha", "04-free")]: ticket({ files: ["a/four.ts"] }),
    [build("alpha", "07-p")]: ticket({ group: "pair", files: ["b/p.ts"] }),
    [build("alpha", "08-q")]: ticket({ group: "pair", files: ["b/q.ts"] }),
    [build("alpha", "09-after")]: ticket({ files: ["b/q.ts"] }),
    [build("alpha", "10-r")]: ticket({ group: "clash", files: ["c/r.ts"] }),
    [build("alpha", "11-s")]: ticket({ group: "clash", files: ["a/one.ts"] }),
  });
  // One unreadable ticket in the job leaves the others' Files counting.
  running("slice-alg-fonts", "", "running", groupCommand(build("alpha", "01-a"), build("alpha", "05-gone"), build("alpha", "02-b")));
  assert.match(run("alpha").stdout, /^running: slice-alg-fonts group fonts tickets=01-a,02-b$/m);
  assert.deepEqual(lines("alpha"), [
    `next: ${build("alpha", "04-free")} builder=claude-opus-5-5 owner=al-04 why=slot 2/5`,
    "next: group pair tickets=07-p,08-q builder=claude-opus-5-5 owner=al-g-pair why=slot 3/5",
    `waits: ${build("alpha", "03-shares")} shares a/two.ts with slice-alg-fonts`,
    `waits: ${build("alpha", "09-after")} shares b/q.ts with slice-alg-pair`,
    "waits: group clash tickets=10-r,11-s shares a/one.ts with slice-alg-fonts",
    "RESULT: ok next 2 ready, 3 waiting",
  ]);
  assert.deepEqual(lines("alpha", "--max", "2").slice(0, 3), [
    `next: ${build("alpha", "04-free")} builder=claude-opus-5-5 owner=al-04 why=slot 2/2`,
    `waits: ${build("alpha", "03-shares")} shares a/two.ts with slice-alg-fonts`,
    "waits: group pair tickets=07-p,08-q cap 2 slices running",
  ]);
});

test("--start claims a ready group in one commit and starts one job that runs its slices in order", t => {
  const files = [build("alpha", "01-a"), build("alpha", "02-b")];
  const { root, env, git, run, runIn } = fixture(t, {
    ".gitignore": "owner\n",
    "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
    [files[1]]: ticket({ group: "fonts", files: ["a/two.ts"] }),
    [files[0]]: ticket({ group: "fonts", blockedBy: ["02-b"], files: ["a/one.ts"] }),
  });
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const worktree = join(root, "wt-build-al-g-fonts");
  assert.deepEqual(git(join(root, "origin.git"), "log", "--format=%s", "dev").trim().split("\n"), ["docs: claim alpha group fonts", "fixture"]);
  for (const file of files) assert.match(git(join(root, "origin.git"), "show", `dev:${file}`), /^assignee: al-g-fonts$/m);
  assert.equal(git(worktree, "branch", "--show-current").trim(), "build/al-g-fonts");
  assert.equal(readFileSync(env.FAKE_KIT_LOG!, "utf8"),
    `${worktree}|claude-opus-5-5|al-g-fonts|bg slice-alg-fonts -- scripts/agents/kit next --run-group --branch build/al-g-fonts --builder claude-opus-5-5 --ticket ${files[1]} --ticket ${files[0]}\n`);
  assert.match(result.stdout, /^claimed: group fonts tickets=02-b,01-a owner=al-g-fonts [0-9a-f]+ \(pushed\)$/m);
  assert.match(result.stdout, /^started: slice-alg-fonts$/m);
  assert.match(result.stdout, /RESULT: ok next 1 ready, 0 waiting, 1 started\n$/);

  // The job's command runs kit slice for each ticket in order. Each fake slice lands like kit pr:
  // a work commit on the branch, a rebased copy on origin dev, and the worktree switched off it.
  git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
  writeFileSync(join(root, "land.sh"), `[[ $1 == slice ]] || exit 0
printf '%s|%s|%s\\n' "$3" "$(git branch --show-current)" "$(git log -1 --format=%s)" >> ${join(root, "slices.log")}
git commit -q --allow-empty -m "work $3"
git -C ${join(root, "other")} pull -q --rebase origin dev
git -C ${join(root, "other")} commit -q --allow-empty -m "landed $3"
git -C ${join(root, "other")} push -q origin HEAD:dev
git checkout -q --detach
`);
  env.FAKE_BG_HOOK = `bash ${join(root, "land.sh")} "$@"`;
  writeFileSync(env.FAKE_KIT_LOG!, "");
  const group = runIn(worktree, "--run-group", "--branch", "build/al-g-fonts", "--builder", "claude-opus-5-5", "--ticket", files[1], "--ticket", files[0]);
  assert.equal(group.status, 0, group.stdout + group.stderr);
  assert.deepEqual(readFileSync(env.FAKE_KIT_LOG!, "utf8").trim().split("\n").map(line => line.split("|").at(-1)),
    files.toReversed().map(file => `slice --ticket ${file} --builder claude-opus-5-5`));
  // Slice 2 starts on its own branch from the new origin/dev, so its fix rounds start afresh.
  assert.deepEqual(readFileSync(join(root, "slices.log"), "utf8").trim().split("\n"), [
    `${files[1]}|build/al-g-fonts|docs: claim alpha group fonts`,
    `${files[0]}|build/al-g-fonts-01|landed ${files[1]}`,
  ]);
  assert.match(group.stdout, /^slice 2\/2: \S+01-a\.md$/m);
  assert.match(group.stdout, /RESULT: ok next group 2 slices done\n$/);
  delete env.FAKE_BG_HOOK;
  git(worktree, "switch", "-q", "build/al-g-fonts");
  writeFileSync(env.FAKE_KIT_LOG!, "");
  env.FAKE_BG_FAIL = "1";
  const failed = runIn(worktree, "--run-group", "--branch", "build/al-g-fonts", "--builder", "claude-opus-5-5", "--ticket", files[1], "--ticket", files[0]);
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.equal(readFileSync(env.FAKE_KIT_LOG!, "utf8").trim().split("\n").length, 1);
  assert.match(failed.stdout, /^RESULT: fail next group stopped at \S+02-b\.md \(slice 1\/2\)$/m);
  assert.equal(run("--run-group", "--branch", "b", "--ticket", files[0]).status, 2);
  assert.equal(run("--run-group", "--builder", "m", "--ticket", files[0]).status, 2);
  assert.equal(run("--run-group", "--branch", "b", "--builder", "m", "--ticket", files[0], "--max", "2").status, 2);
  assert.equal(run("alpha", "--ticket", files[0]).status, 2);
});

test("a group whose later member names src/main.ts waits when two slices are in it", t => {
  const { running, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["src/main.ts"] }),
    [build("alpha", "02-run")]: ticket({ assignee: "alpha-02", files: ["src/main.ts", "src/two.ts"] }),
    [build("alpha", "03-x")]: ticket({ group: "pair", files: ["a/x.ts"] }),
    [build("alpha", "04-y")]: ticket({ group: "pair", files: ["src/main.ts"] }),
  });
  running("slice-alpha01", build("alpha", "01-run"));
  running("slice-alpha02", build("alpha", "02-run"));
  assert.deepEqual(lines("alpha"), [
    "waits: group pair tickets=03-x,04-y 2 slices in src/main.ts: slice-alpha01, slice-alpha02",
    "RESULT: ok next 0 ready, 1 waiting",
  ]);
});

const raceFiles = {
  [build("alpha", "01-solo")]: ticket({ files: ["a/solo.ts"] }),
  [build("alpha", "02-a")]: ticket({ group: "fonts", files: ["a/a.ts"] }),
  [build("alpha", "03-b")]: ticket({ group: "fonts", files: ["a/b.ts"] }),
};

test("a group member claimed, newly blocked, joining, leaving or changing builder during --start leaves the whole group unclaimed", t => {
  for (const [change, file, taken] of [
    ["s/^assignee: $/assignee: someone-else/", "03-b", "someone-else"],
    ["s/^blocked_by: \\[\\]$/blocked_by: [01-solo]/", "03-b", "group changed"],
    ["/^status: open$/a group: fonts", "01-solo", "group changed"],
    ["/^group: fonts$/d", "03-b", "group changed"],
    ["s/^builder: claude$/builder: gpt-6-luna/", "03-b", "group changed"],
  ]) {
    const { root, dev, env, git, run } = fixture(t, raceFiles);
    git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
    writeFileSync(join(root, "race.sh"), `[[ $1 == bg ]] || exit 0
cd ${join(root, "other")} || exit 1
git pull -q --rebase origin dev
sed -i '${change}' ${build("alpha", file)}
git commit -qam 'other lead' && git push -q origin HEAD:dev
`);
    env.FAKE_BG_HOOK = `bash ${join(root, "race.sh")} "$@"`;
    const result = run("alpha", "--start");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, new RegExp(`^waits: group fonts tickets=02-a,03-b claimed meanwhile \\(${taken}\\)$`, "m"));
    assert.match(result.stdout, /RESULT: ok next 1 ready, 1 waiting, 1 started\n$/);
    assert.match(git(join(root, "origin.git"), "show", `dev:${build("alpha", "02-a")}`), /^assignee: $/m);
    assert.equal(git(dev, "rev-parse", "HEAD"), git(dev, "rev-parse", "origin/dev"));
    assert.equal(git(dev, "status", "--porcelain").trim(), "");
  }
});

test("a group claim whose push fails again after the rebase restores every member and leaves dev on origin/dev", t => {
  const { root, dev, git, run } = fixture(t, {
    [build("alpha", "01-a")]: ticket({ group: "fonts", files: ["a/a.ts"] }),
    [build("alpha", "02-b")]: ticket({ group: "fonts", files: ["a/b.ts"] }),
  });
  racePush(root, git, "notes.md", "other\n", 2);
  const result = run("alpha", "--start");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail next start group fonts tickets=01-a,02-b: git push failed: /m);
  assert.equal(git(dev, "rev-parse", "HEAD"), git(dev, "rev-parse", "origin/dev"));
  assert.equal(git(dev, "status", "--porcelain").trim(), "");
  for (const slug of ["01-a", "02-b"]) assert.match(readFileSync(join(dev, build("alpha", slug)), "utf8"), /^assignee: $/m);
});

// A group worktree on build/al-g-fonts, and a fake kit slice that lands like kit pr: it logs its
// branch and HEAD, commits, puts a rebased copy on origin dev with its ticket closed, saves its
// state with "pr" finished (as kit slice does under the git-ignored .scratch/kit-slice/<slug>/)
// and leaves the branch. FAKE_PARTIAL=<file> makes that slice commit partial work and save its
// state unfinished; FAKE_KEEP_OPEN lands without closing the ticket; FAKE_STRAY leaves an untracked file.
function groupWorktree(t: TestContext, second = build("alpha", "02-b")) {
  const files = [build("alpha", "01-a"), second];
  const fx = fixture(t, {
    [files[0]]: ticket({ group: "fonts", files: ["a/one.ts"], assignee: "al-g-fonts" }),
    [files[1]]: ticket({ group: "fonts", files: ["a/two.ts"], assignee: "al-g-fonts" }),
  });
  const { root, dev, env, git } = fx;
  const worktree = join(root, "wt-group");
  git(dev, "worktree", "add", "-q", "-b", "build/al-g-fonts", worktree, "origin/dev");
  writeFileSync(join(dev, ".git/info/exclude"), ".scratch/\n");
  git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
  const other = join(root, "other");
  writeFileSync(join(root, "land.sh"), `[[ $1 == slice ]] || exit 0
printf '%s|%s|%s\\n' "$3" "$(git branch --show-current)" "$(git log -1 --format=%s)" >> ${join(root, "slices.log")}
state=".scratch/kit-slice/$(basename "$3" .md)"
if [[ $3 == "\${FAKE_PARTIAL:-}" ]]; then
  git commit -q --allow-empty -m "partial $3"
  mkdir -p "$state" && echo '{"finished":["build"]}' > "$state/state.json" && exit 0
fi
[[ -z \${FAKE_STRAY:-} ]] || touch stray.txt
git commit -q --allow-empty -m "work $3"
git -C ${other} pull -q --rebase origin dev
[[ -n \${FAKE_KEEP_OPEN:-} ]] || sed -i 's/^status: open$/status: closed/' ${other}/$3
git -C ${other} commit -q --allow-empty -am "landed $3" && git -C ${other} push -q origin HEAD:dev
mkdir -p "$state" && echo '{"finished":["build","pr"]}' > "$state/state.json"
git checkout -q --detach
`);
  env.FAKE_BG_HOOK = `bash ${join(root, "land.sh")} "$@"`;
  const group = () => fx.runIn(worktree, "--run-group", "--branch", "build/al-g-fonts", "--builder", "claude-opus-5-5", "--ticket", files[0], "--ticket", files[1]);
  const slices = () => readFileSync(join(root, "slices.log"), "utf8").trim().split("\n");
  return { ...fx, files, worktree, group, slices };
}

test("--run-group stops when a slice leaves the worktree dirty", t => {
  const { env, files, group, slices } = groupWorktree(t);
  env.FAKE_STRAY = "1";
  const result = group();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^RESULT: fail next group stopped at \S+02-b\.md \(slice 2\/2\): worktree not clean after the previous slice$/m);
  assert.deepEqual(slices(), [`${files[0]}|build/al-g-fonts|fixture`]);
});

test("a --run-group rerun skips landed slices, closed or merged by their saved slice, and resumes a stopped slice on its branch", t => {
  for (const [keepOpen, skipped] of [[false, "closed on origin/dev"], [true, "merged by its saved slice"]] as const) {
    const { env, files, worktree, git, group, slices } = groupWorktree(t);
    if (keepOpen) env.FAKE_KEEP_OPEN = "1";
    env.FAKE_PARTIAL = files[1];
    env.FAKE_FAIL_ON = files[1];
    const first = group();
    assert.equal(first.status, 1, first.stdout + first.stderr);
    assert.match(first.stdout, /^RESULT: fail next group stopped at \S+02-b\.md \(slice 2\/2\)$/m);
    delete env.FAKE_FAIL_ON;
    delete env.FAKE_PARTIAL;
    git(worktree, "checkout", "-q", "--detach");
    // kit pr deleted slice 1's branch when it merged.
    git(worktree, "branch", "-q", "-D", "build/al-g-fonts");
    const again = group();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, new RegExp(`^slice 1/2: \\S+01-a\\.md ${skipped}, skipped$`, "m"));
    assert.match(again.stdout, /RESULT: ok next group 1 slices done, 1 landed before\n$/);
    // The rerun keeps 02-b's branch and its partial work rather than restarting it from origin/dev.
    assert.deepEqual(slices(), [
      `${files[0]}|build/al-g-fonts|fixture`,
      `${files[1]}|build/al-g-fonts-02|landed ${files[0]}`,
      `${files[1]}|build/al-g-fonts-02|partial ${files[1]}`,
    ]);
  }
});

test("a map ticket later in a group gets an m-numbered branch", t => {
  const map = "docs/wayfinder/alpha/tickets/02-m.md";
  const { files, group, slices } = groupWorktree(t, map);
  const result = group();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(slices(), [`${files[0]}|build/al-g-fonts|fixture`, `${map}|build/al-g-fonts-m02|landed ${files[0]}`]);
});

test("a lone ticket that joins a group before its own claim is not claimed alone", t => {
  const { root, dev, env, git, run } = fixture(t, {
    [build("alpha", "01-first")]: ticket({ files: ["a/first.ts"] }),
    [build("alpha", "02-solo")]: ticket({ files: ["a/solo.ts"] }),
  });
  git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
  writeFileSync(join(root, "join.sh"), `[[ $1 == bg ]] || exit 0
cd ${join(root, "other")} || exit 1
git pull -q --rebase origin dev
sed -i '/^status: open$/a group: fonts' ${build("alpha", "02-solo")}
git commit -qam 'other lead' && git push -q origin HEAD:dev
`);
  env.FAKE_BG_HOOK = `bash ${join(root, "join.sh")} "$@"`;
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`^waits: ${build("alpha", "02-solo")} claimed meanwhile \\(group changed\\)$`, "m"));
  assert.match(result.stdout, /RESULT: ok next 1 ready, 1 waiting, 1 started\n$/);
  assert.match(git(join(root, "origin.git"), "show", `dev:${build("alpha", "02-solo")}`), /^assignee: $/m);
  assert.equal(git(dev, "rev-parse", "HEAD"), git(dev, "rev-parse", "origin/dev"));
});

test("a delegated group is claimed once and handed to its delegate with no job or slot", t => {
  const { env, run } = fixture(t, {
    "docs/wayfinder/alpha/build/README.md": "# Build\n\nprefix: al\n",
    [build("alpha", "01-a")]: ticket({ group: "free", builder: "opencode/deepseek-v4.1-flash-free", files: ["a/one.ts"] }),
    [build("alpha", "02-b")]: ticket({ group: "free", builder: "opencode/deepseek-v4.1-flash-free", files: ["a/two.ts"] }),
  });
  const result = run("alpha", "--start");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /^next: group free tickets=01-a,02-b builder=delegate opencode\/deepseek-v4\.1-flash-free owner=al-g-free why=delegated, no slot$/m);
  assert.equal(result.stdout.match(/^claimed: /gm)?.length, 1);
  assert.match(result.stdout, /^delegate: group free tickets=01-a,02-b opencode\/deepseek-v4\.1-flash-free owner=al-g-free$/m);
  assert.ok(!existsSync(env.FAKE_KIT_LOG!));
  assert.match(result.stdout, /RESULT: ok next 1 ready, 0 waiting, 0 started\n$/);
});

test("runs_alone on one member applies to the whole group", t => {
  const { running, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["a/run.ts"] }),
    [build("alpha", "02-x")]: ticket({ group: "pair", files: ["a/x.ts"] }),
    [build("alpha", "03-y")]: ticket({ group: "pair", runsAlone: true, files: ["a/y.ts"] }),
  });
  running("slice-alpha01", build("alpha", "01-run"));
  assert.deepEqual(lines("alpha"), [
    "waits: group pair tickets=02-x,03-y runs alone; waits for slice-alpha01",
    "RESULT: ok next 0 ready, 1 waiting",
  ]);
});

test("a maps folder other than docs/wayfinder still gives a running slice its map, so runs_alone waits", t => {
  const plan = (slug: string) => `plans/alpha/build/tickets/${slug}.md`;
  const { running, lines } = fixture(t, {
    [plan("01-run")]: ticket({ assignee: "alpha-01", files: ["a/one.ts"] }),
    [plan("02-alone")]: ticket({ runsAlone: true, files: ["a/two.ts"] }),
  }, "dev", { maps: "plans" });
  running("slice-alpha01", plan("01-run"));
  assert.deepEqual(lines("alpha"), [
    `waits: ${plan("02-alone")} runs alone; waits for slice-alpha01`,
    "RESULT: ok next 0 ready, 1 waiting",
  ]);
});

test("a running ticket under a folder that only ends in the maps name has no map, so runs_alone does not wait on it", t => {
  const { running, lines } = fixture(t, {
    "myplans/alpha/build/tickets/01-run.md": ticket({ files: ["a/one.ts"] }),
    "plans/alpha/build/tickets/02-alone.md": ticket({ runsAlone: true, files: ["a/two.ts"] }),
  }, "dev", { maps: "plans" });
  running("slice-other01", "myplans/alpha/build/tickets/01-run.md");
  assert.deepEqual(lines("alpha"), [
    "next: plans/alpha/build/tickets/02-alone.md builder=claude-opus-5-5 owner=alpha-02 why=slot 2/5",
    "RESULT: ok next 1 ready, 0 waiting",
  ]);
});

test("an absolute --ticket path under a maps folder other than docs/wayfinder still gives its map", t => {
  const plan = (slug: string) => `plans/alpha/build/tickets/${slug}.md`;
  const { dev, running, lines } = fixture(t, {
    [plan("01-run")]: ticket({ assignee: "alpha-01", files: ["a/one.ts"] }),
    [plan("02-alone")]: ticket({ runsAlone: true, files: ["a/two.ts"] }),
  }, "dev", { maps: "plans" });
  running("slice-alpha01", "", "running", `'scripts/agents/kit' 'slice' '--ticket' '${join(dev, plan("01-run"))}' '--builder' 'claude-opus-5-5'\n`);
  assert.deepEqual(lines("alpha"), [
    `waits: ${plan("02-alone")} runs alone; waits for slice-alpha01`,
    "RESULT: ok next 0 ready, 1 waiting",
  ]);
});

test("an absolute --ticket under a dev root whose parent folder is named like maps still names its own map", t => {
  const plan = (slug: string) => `plans/alpha/build/tickets/${slug}.md`;
  const { dev, running, lines } = fixture(t, {
    [plan("01-run")]: ticket({ assignee: "alpha-01", files: ["a/one.ts"] }),
    [plan("02-alone")]: ticket({ runsAlone: true, files: ["a/two.ts"] }),
  }, "dev", { maps: "plans" }, "plans/site");
  running("slice-alpha01", "", "running", `'scripts/agents/kit' 'slice' '--ticket' '${join(dev, plan("01-run"))}' '--builder' 'claude-opus-5-5'\n`);
  assert.deepEqual(lines("alpha"), [
    `waits: ${plan("02-alone")} runs alone; waits for slice-alpha01`,
    "RESULT: ok next 0 ready, 1 waiting",
  ]);
});
