import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const next = resolve("scripts/agents/kit.d/next");
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };

type Ticket = { type?: string; assignee?: string; builder?: string; files?: string[]; runsAlone?: boolean; blockedBy?: string[]; status?: string };

function ticket({ type = "task (AFK)", assignee = "", builder = "claude", files = [], runsAlone, blockedBy = [], status = "open" }: Ticket) {
  return ["---", "title: T", `type: ${type}`, `status: ${status}`, `assignee: ${assignee}`, `builder: ${builder}`, `blocked_by: [${blockedBy.join(", ")}]`,
    ...(runsAlone === undefined ? [] : [`runs_alone: ${runsAlone}`]), "---", "", "## Goal", "", "Do it.", "", "## Files", "", ...files.map(file => `- \`${file}\``), "", "## Done when", "", "- done", ""].join("\n");
}

// A bare origin and a dev clone holding the given files, a fake kit (bg --list reads
// each worktree's job records; bg <name> logs its call) and a fake worktree.sh.
function fixture(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "kit-next-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, ...identity, GIT_CONFIG_NOSYSTEM: "1", KIT_DEV_ROOT: join(root, "dev"), KIT_NEXT_KIT: join(root, "fake-kit"), KIT_NEXT_WORKTREE: join(root, "fake-worktree.sh"), FAKE_KIT_LOG: join(root, "kit.log") };
  delete env.KIT_ROOT;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const dev = join(root, "dev");
  git(root, "init", "-q", "--bare", "-b", "dev", "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "dev");
  git(dev, "checkout", "-q", "-b", "dev");
  const write = (base: string, entries: Record<string, string>) => {
    for (const [path, content] of Object.entries(entries)) { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), content); }
  };
  write(dev, { "README.md": "repo\n", ...files });
  git(dev, "add", "-A");
  git(dev, "commit", "-q", "-m", "fixture");
  git(dev, "push", "-q", "-u", "origin", "dev");
  writeFileSync(join(root, "fake-kit"), `#!/usr/bin/env bash
if [[ $1 == bg && $2 == --list ]]; then
  for d in "$KIT_ROOT"/.scratch/kit-jobs/*/; do [[ -d $d ]] && printf '%s\\t%s\\t1s\\t%slog\\n' "$(basename "$d")" "$(cat "$d/state")" "$d"; done
  echo 'RESULT: ok bg list'; exit 0
fi
printf '%s|%s|%s|%s\\n' "$PWD" "$ASE_REVIEW_MODEL" "$ASE_OWNER" "$*" >> "$FAKE_KIT_LOG"
echo "RESULT: ok bg $2 pid 1"
`);
  writeFileSync(join(root, "fake-worktree.sh"), `#!/usr/bin/env bash
set -euo pipefail
path="$(dirname "$(git rev-parse --show-toplevel)")/wt-\${1//\\//-}"
git worktree add -q -b "$1" "$path" "$2" >&2
printf '%s\\n' "$ASE_OWNER" > "$path/owner"
printf '%s\\n' "$path"
`);
  chmodSync(join(root, "fake-kit"), 0o755);
  chmodSync(join(root, "fake-worktree.sh"), 0o755);
  // A slice job in its own worktree: the recorded command names its ticket, as kit bg writes it.
  const running = (name: string, ticketFile: string, state = "running") => {
    const worktree = join(root, `job-${name}`);
    git(dev, "worktree", "add", "-q", "--detach", worktree, "origin/dev");
    const directory = join(worktree, ".scratch/kit-jobs", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "state"), `${state}\n`);
    writeFileSync(join(directory, "command"), `'scripts/agents/kit' 'slice' '--ticket' '${ticketFile}' '--builder' 'claude-opus-5-5'\n`);
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [next, ...args], { env, encoding: "utf8", timeout: 30_000 });
  const lines = (...args: string[]) => {
    const result = run(...args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout.trim().split("\n").filter(line => !line.startsWith("running: "));
  };
  return { root, dev, env, git, write, running, run, lines };
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
    [build("beta", "01-b")]: ticket({ builder: "", files: ["b/one.ts"] }),
    "docs/wayfinder/gamma/build/README.md": "# Build\n\n**Not started:** after alpha lands.\n\nprefix: ga\n",
    [build("gamma", "01-g")]: ticket({}),
    "docs/wayfinder/gamma/tickets/02-map-task.md": ticket({ files: ["g/map.ts"] }),
  });
  assert.deepEqual(lines("beta", "alpha", "gamma"), [
    `next: ${build("beta", "01-b")} builder=claude-opus-5-5 owner=beta-01 why=slot 1/5`,
    `next: ${build("alpha", "9-nine")} builder=claude-opus-5-5 owner=al-9 why=slot 2/5`,
    `next: ${build("alpha", "10-ten")} builder=claude-opus-5-5 owner=al-10 why=slot 3/5`,
    `next: ${build("alpha", "11-free")} builder=delegate opencode/deepseek-v4.1-flash-free owner=al-11 why=slot 4/5`,
    `next: ${build("alpha", "12-luna")} builder=gpt-6-luna owner=al-12 why=slot 5/5`,
    `waits: ${build("alpha", "01-grill")} needs Lex (type: grilling (HITL))`,
    "waits: docs/wayfinder/alpha/tickets/05-research.md needs Lex (type: research (AFK))",
    `waits: ${build("gamma", "01-g")} build not started (README **Not started:**)`,
    "waits: docs/wayfinder/gamma/tickets/02-map-task.md cap 5 slices running",
    "RESULT: ok next 5 ready, 4 waiting",
  ]);
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

test("rule 4 waits on any shared file, a glob or a find-it-with line counting as its directory", t => {
  const { running, write, git, dev, lines } = fixture(t, {
    [build("alpha", "01-run")]: ticket({ assignee: "alpha-01", files: ["scripts/a.mjs", "tests/foo/*.test.ts"] }),
    [build("alpha", "02-same")]: ticket({ files: ["scripts/a.mjs"] }),
    [build("alpha", "03-under-glob")]: ticket({ files: ["tests/foo/bar.test.ts"] }),
    [build("alpha", "05-free")]: ticket({ files: ["docs/five.md"] }),
    [build("alpha", "06-after-free")]: ticket({ files: ["docs/five.md", "docs/six.md"] }),
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
    "RESULT: ok next 1 ready, 4 waiting",
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

// A pre-push hook in the dev clone lands another commit on origin the first time it runs.
function racePush(root: string, git: (cwd: string, ...args: string[]) => string, change: string, content: string) {
  git(root, "clone", "-q", "-b", "dev", join(root, "origin.git"), "other");
  const hooks = join(root, "hooks");
  mkdirSync(hooks);
  writeFileSync(join(hooks, "pre-push"), `#!/usr/bin/env bash
[[ -e ${root}/raced ]] && exit 0
touch ${root}/raced
cd ${join(root, "other")} || exit 1
mkdir -p "$(dirname '${change}')" && printf '%s' '${content}' > '${change}'
git add -A && git commit -q -m 'other lead' && git push -q origin HEAD:dev
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
  assert.ok(!existsSync(join(root, "wt-build-alpha-01-one")));
});
