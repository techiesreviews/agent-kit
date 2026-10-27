import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const script = resolve("scripts/agents/kit.d/sweep"), kit = resolve("scripts/agents/kit");
// Node loads this extensionless executable as ESM; a URL keeps tsx from resolving it as TS.
type Counts = { px: number; radii: number; shadows: number; timings: number };
type Sweep = {
  bundleLimit: number;
  parseArgs(args: string[]): { since: string };
  handTyped(text: string): Counts;
  unitOutcomes(log: string): [string, string[]][];
  specOutcomes(report: unknown): [string, string[]][];
  flippedTests(runs: { worktree: string; path: string; time: number; outcomes: [string, string[]][] }[]): { name: string; times: number; worktrees: Set<string> }[];
  codeSections(now: Map<string, string>, then: Map<string, string>, sharedFile: string | null): Section[];
  correctionsSection(root: string, then: string, head: string, maps: string | null): Section;
  staleDebtSection(root: string, now: number, techDebt: string | null): Section;
};
type Section = { title: string; priority: number; lines: string[] };
const sweep: Sweep = await import(pathToFileURL(script).href);

const day = 86_400_000;
const pad = (number: number) => String(number).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const stamp = (time: number) => new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function write(path: string, text: string, time?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (time !== undefined) utimesSync(path, new Date(time), new Date(time));
}

function commit(repo: string, time: number, message: string) {
  const date = new Date(time).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  execFileSync("git", ["-C", repo, "add", "-A"], { env });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", message], { env });
}

function repository(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-sweep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "dev"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "sweep@example.test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Sweep"]);
  write(join(repo, ".gitignore"), ".scratch/\n");
  write(join(repo, "scripts/agents/kit.json"), JSON.stringify({ project: "kit-sweep", branches: { land: "dev" },
    maps: "docs/wayfinder", sharedFile: "src/main.ts", techDebt: "docs/work/tech-debt/issues" }));
  return { dir, repo };
}

function run(repo: string, args: string[] = [], root = repo) {
  return spawnSync("bash", [kit, "sweep", ...args], { cwd: root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: repo, ASE_SKIP_DOCTOR: "1" } });
}

const bundleOf = (output: string) => {
  const path = /^RESULT: ok sweep bundle (.+)$/m.exec(output)?.[1];
  assert.ok(path, output);
  return { path, text: readFileSync(path, "utf8") };
};
const section = (bundle: string, title: string) => {
  const start = bundle.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `missing section ${title}:\n${bundle}`);
  return bundle.slice(start + title.length + 5).split("\n## ")[0].trim().split("\n");
};

const flipNote = "- A removed worktree takes its runs with it, so a low count does not prove steady tests; unit tests are matched by name only.";
const firstCss = ".a {\n  padding: 4px 8px;\n  border-radius: 6px;\n  box-shadow: 0 1px 2px #000;\n  transition: opacity 120ms;\n}\n";
const secondCss = firstCss.replace("}\n", "  margin: 2px;\n  border-radius: var(--r);\n  box-shadow: var(--s);\n  border-top-left-radius: 50%;\n  text-shadow: none;\n  /* padding: 9px; */\n}\n");
const lines = (count: number) => Array.from({ length: count }, (_, index) => `export const line${index} = ${index};`).join("\n") + "\n";
const report = (tests: [string, string][]) => JSON.stringify({ suites: [{ title: "native-save/x.spec.ts", file: "native-save/x.spec.ts",
  specs: tests.map(([title, status]) => ({ title, file: "native-save/x.spec.ts", tests: [{ status }] })) }] });

test("each number in the bundle comes from the fixture repo, logs, records and feedback", (t) => {
  const { dir, repo } = repository(t);
  const now = Date.now();
  write(join(repo, "docs/work/tech-debt/issues/01-old.md"), "---\ntitle: Old debt\nstatus: needs-triage\nassignee:\nblocked_by: []\n---\n");
  write(join(repo, "docs/work/tech-debt/issues/02-done.md"), "---\ntitle: Done debt\nstatus: closed\nassignee:\nblocked_by: []\n---\n");
  commit(repo, now - 40 * day, "debt");
  write(join(repo, "src/main.ts"), lines(3));
  write(join(repo, "src/big.ts"), lines(10));
  write(join(repo, "src/a.css"), firstCss);
  // Shell scripts count; data files and binary blobs do not.
  write(join(repo, "scripts/x.sh"), "#!/usr/bin/env bash\n".repeat(6));
  write(join(repo, "scripts/data.json"), "{}\n".repeat(50));
  write(join(repo, "scripts/blob"), "a\0b\n".repeat(50));
  commit(repo, now - 10 * day, "code");
  // Corrections count by the commit that adds them, not the date they carry.
  const [d0, d1, d3, d8, d9] = [0, 1, 3, 8, 9].map(days => localDate(new Date(now - days * day)));
  const feedback = join(repo, "docs/wayfinder/demo/build/feedback.md");
  const log = (...entries: string[]) => write(feedback, ["# Feedback: demo", "", "## Feedback", "", ...entries, ""].join("\n"));
  const lastWeek = (fix: string) => `- ${d8} · workflow · Last week · after release: no · fix: ${fix}`;
  log(lastWeek("open"));
  commit(repo, now - 8 * day, "last week's feedback");
  // Added this week: a line dated last week that landed late, and last week's line with its fix filled in.
  log(`- ${d1} · fault · Save lost a page · after release: yes · fix: open`, `- ${d3} · too-much · Too many hints · after release: no · fix: PR #4`,
    `- ${d9} · felt-wrong · Landed late · after release: no · fix: open`, lastWeek("PR #5"));
  write(join(repo, "src/main.ts"), lines(5));
  write(join(repo, "src/new.ts"), lines(4));
  write(join(repo, "src/a.css"), secondCss);
  write(join(repo, "scripts/agents/kit.d/foo"), "#!/usr/bin/env node\n".repeat(7));
  write(join(repo, "docs/work/tech-debt/issues/03-fresh.md"), "---\ntitle: Fresh debt\nstatus: ready-for-agent\nassignee:\nblocked_by: []\n---\n");
  commit(repo, now - day, "grow");

  // kit pr runs: two in the window here, one before it, three in a second worktree.
  const w2 = join(dir, "w2");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "other", w2]);
  const prRun = (root: string, name: string, time: number, unit: string, specs?: [string, [string, string][]]) => {
    write(join(root, ".scratch/pr", name, "unit.log"), unit, time);
    if (!specs) return;
    write(join(root, ".scratch/kit-specs", specs[0], "0-default.json"), report(specs[1]));
    write(join(root, ".scratch/pr", name, "specs.log"), `owner: x\nlog: ${join(root, ".scratch/kit-specs", specs[0], "0-default.log")}\n`, time);
  };
  prRun(repo, "c", now - 20 * day, "✖ old (1ms)\n");
  prRun(repo, "a", now - 2 * day, "✖ adds one (1.5ms)\n✔ keeps two (2ms)\nℹ tests 2\n✖ failing tests:\n\n✖ adds one (1.5ms)\n",
    ["run-a", [["saves", "unexpected"], ["loads", "flaky"]]]);
  write(join(repo, ".scratch/unit/b.log"), "✔ adds one (1ms)\n✔ keeps two (1ms)\n✔ old (1ms)\n");
  prRun(repo, "b", now - day, "pass 3, fail 0\nlog: .scratch/unit/b.log\n", ["run-b", [["saves", "expected"]]]);
  // TAP, as npm test writes to a pipe on older Node: a skipped test neither passes nor fails.
  prRun(repo, "t1", now - 2 * day, "TAP version 13\n# Subtest: tap one\nnot ok 1 - tap one\nok 2 - tap skipped # SKIP\n");
  prRun(repo, "t2", now - day, "TAP version 13\nok 1 - tap one\nnot ok 2 - tap skipped # SKIP\n");
  prRun(w2, "e", now - 3 * day, "✖ keeps two (1ms)\n");
  prRun(w2, "f", now - 2 * day, "✖ shared (1ms)\n");
  prRun(w2, "g", now - day, "  ✔ shared (1ms)\n");
  write(join(repo, "tests/known-failures.json"), JSON.stringify([{ spec: "native-save/x.spec.ts", title: "loads", status: "flaky", reason: "slow CI" }]));

  // Scoreboard: a review in the window, one before it, and one found by its record's phase end.
  const counts = (kind: Record<string, number>, severity: Record<string, number>) => ({
    kind: { fault: 0, ticket: 0, race: 0, style: 0, unsorted: 0, gap: 0, ...kind }, severity: { P0: 0, P1: 0, P2: 0, P3: 0, none: 0, gap: 0, ...severity } });
  const records = join(repo, ".scratch/scoreboard/demo");
  write(join(records, "01-a.json"), JSON.stringify({ reviews: [
    { dir: join(repo, ".scratch/reviews/demo-01", stamp(now - 2 * day)), counts: counts({ fault: 2, ticket: 1 }, { P2: 2, P3: 1 }), declined: [{ text: "x", reason: "y" }] },
    { dir: join(repo, ".scratch/reviews/demo-01", stamp(now - 20 * day)), counts: counts({ race: 9 }, { P1: 9 }), declined: [] }] }));
  write(join(records, "02-b.json"), JSON.stringify({ reviews: [{ dir: join(repo, ".scratch/reviews/demo-02", stamp(now - 9 * day)), counts: counts({ gap: 4 }, {}) }] }));
  write(join(records, "03-c.json"), JSON.stringify({ phases: [{ name: "review", start: new Date(now - day - 60_000).toISOString(), end: new Date(now - day).toISOString() }],
    reviews: [{ dir: join(repo, "reviews/plain"), counts: counts({ style: 1 }, { P3: 1 }) }] }));

  // Not committed yet: next week's sweep counts it once it lands.
  writeFileSync(feedback, readFileSync(feedback, "utf8").replace("## Feedback\n\n", `## Feedback\n\n- ${d0} · workflow · Not committed · after release: no · fix: open\n`));

  const result = run(repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { path, text } = bundleOf(result.stdout);
  assert.equal(path, join(repo, ".scratch/sweep", localDate(new Date()), "bundle.md"));
  assert.match(result.stdout, /^## Lex's corrections \(\d+ bytes\)$/m);
  assert.deepEqual(section(text, "src/main.ts"), ["- 5 lines (+2)"]);
  assert.deepEqual(section(text, "Biggest source files"), ["- src/a.css: 12 lines (+6)", "- src/big.ts: 10 lines (0)",
    "- scripts/agents/kit.d/foo: 7 lines (+7)", "- scripts/x.sh: 6 lines (0)", "- src/main.ts: 5 lines (+2)", "- src/new.ts: 4 lines (+4)"]);
  assert.deepEqual(section(text, "Biggest growth"), ["- scripts/agents/kit.d/foo: +7 to 7 lines", "- src/a.css: +6 to 12 lines", "- src/new.ts: +4 to 4 lines", "- src/main.ts: +2 to 5 lines"]);
  assert.deepEqual(section(text, "Hand-typed values in src/**/*.css"), ["- raw px spacing: 3 (+1)", "- raw radii: 2 (+1)", "- bespoke shadows: 1 (0)",
    "- hand-timed transitions: 1 (0)", "", "Files with the most (px, radii, shadows, timings; change):", "- src/a.css: 3, 2, 1, 1; +2"]);
  assert.deepEqual(section(text, "Tests that failed then passed in kit pr runs"), ["- 7 kit pr runs read from 2 live worktrees, 5 tests flipped", flipNote,
    "- native-save/x.spec.ts › loads: 1× in repo", "- native-save/x.spec.ts › saves: 1× in repo", "- unit › adds one: 1× in repo", "- unit › shared: 1× in w2", "- unit › tap one: 1× in repo"]);
  assert.deepEqual(section(text, "Known failures (tests/known-failures.json)"), ["- native-save/x.spec.ts › loads · flaky · slow CI"]);
  assert.deepEqual(section(text, "Review findings by kind"), ["- 2 reviews of 2 pieces, 1 findings declined", "- by kind: fault 2, ticket 1, style 1",
    "- by severity: P2 2, P3 2", "- demo/01-a: fault 2, ticket 1 (1 review)", "- demo/03-c: style 1 (1 review)"]);
  const corrections = (...extra: string[]) => [`- ${d1} · fault · Save lost a page · demo · after release: yes · fix: open`,
    `- ${d3} · too-much · Too many hints · demo · after release: no · fix: PR #4`, ...extra, `- ${d9} · felt-wrong · Landed late · demo · after release: no · fix: open`];
  assert.deepEqual(section(text, "Lex's corrections"), ["- 3 corrections committed in the window; by kind: fault 1, too-much 1, felt-wrong 1", ...corrections()]);
  assert.deepEqual(section(text, "Tech-debt issues untouched 30+ days"), ["- 01-old.md: Old debt · needs-triage · untouched 40 days"]);
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }), " M docs/wayfinder/demo/build/feedback.md\n",
    "the sweep changes nothing tracked beyond the fixture's own uncommitted line");

  // A worktree folder deleted without git worktree remove is still listed by git, but it is not live; its runs are gone.
  rmSync(w2, { recursive: true, force: true });
  assert.match(execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"], { encoding: "utf8" }), /^prunable/m);
  assert.deepEqual(section(bundleOf(run(repo).stdout).text, "Tests that failed then passed in kit pr runs"), ["- 4 kit pr runs read from 1 live worktree, 4 tests flipped",
    flipNote, "- native-save/x.spec.ts › loads: 1× in repo", "- native-save/x.spec.ts › saves: 1× in repo", "- unit › adds one: 1× in repo", "- unit › tap one: 1× in repo"]);
  execFileSync("git", ["-C", repo, "worktree", "prune"]);

  // Last week's sweep, run on last week's checkout, counted last week's line and not the late one: each counts once.
  const lastCheckout = join(dir, "last-week");
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", lastCheckout, "HEAD~1"]);
  assert.deepEqual(section(bundleOf(run(repo, ["--since", "14d"], lastCheckout).stdout).text, "Lex's corrections"),
    ["- 1 corrections committed in the window; by kind: workflow 1", `- ${d8} · workflow · Last week · demo · after release: no · fix: open`]);

  // A date starts at its local midnight; the code commit is the last one before it, and last week's line now counts.
  const dated = bundleOf(run(repo, ["--since", d8]).stdout).text;
  const code = execFileSync("git", ["-C", repo, "rev-parse", "HEAD~2"], { encoding: "utf8" }).slice(0, 9);
  assert.match(dated, new RegExp(`^Since ${new Date(`${d8}T00:00:00`).toISOString().replace(/\./g, "\\.")} \\(--since ${d8}\\); code at \\w{9} against ${code}, the last commit before the window\\.`, "m"));
  assert.deepEqual(section(dated, "Lex's corrections"), ["- 4 corrections committed in the window; by kind: fault 1, too-much 1, workflow 1, felt-wrong 1",
    ...corrections(`- ${d8} · workflow · Last week · demo · after release: no · fix: PR #5`)]);

  // A wider window reaches the older run, review and correction; before the first commit nothing grew.
  const wide = section(bundleOf(run(repo, ["--since", "30d"]).stdout).text, "Review findings by kind");
  assert.equal(wide[1], "- by kind: fault 2, ticket 1, race 9, style 1, gap 4");
  assert.deepEqual(section(bundleOf(run(repo, ["--since", "60d"]).stdout).text, "src/main.ts"), ["- 5 lines (+5)"]);
});

test("a huge week is trimmed under the size limit and keeps the top sections", (t) => {
  const { repo } = repository(t);
  write(join(repo, "src/main.ts"), lines(2));
  commit(repo, Date.now() - day, "start");
  const names = Array.from({ length: 4000 }, (_, index) => `a long unit test name that keeps the bundle growing past its limit, number ${index}`);
  write(join(repo, ".scratch/pr/a/unit.log"), names.map(name => `✖ ${name} (1ms)`).join("\n"), Date.now() - 2 * day);
  write(join(repo, ".scratch/pr/b/unit.log"), names.map(name => `✔ ${name} (1ms)`).join("\n"), Date.now() - day);
  const result = run(repo);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { text } = bundleOf(result.stdout);
  assert.ok(Buffer.byteLength(text) < sweep.bundleLimit, `${Buffer.byteLength(text)} bytes`);
  assert.equal(sweep.bundleLimit, 40_000);
  assert.match(text, /^Trimmed to stay under 40000 bytes: Tests that failed then passed in kit pr runs \d+ lines\.$/m);
  assert.equal(section(text, "Tests that failed then passed in kit pr runs")[0], "- 2 kit pr runs read from 1 live worktree, 4000 tests flipped");
  assert.deepEqual(section(text, "src/main.ts"), ["- 2 lines (+2)"]);
  assert.match(text, /\n## Tech-debt issues untouched 30\+ days\n\n- none\n/);
});

test("hand-typed values: raw px and timings as kit ux counts them, radii and shadows by declaration", () => {
  assert.deepEqual(sweep.handTyped(firstCss), { px: 2, radii: 1, shadows: 1, timings: 1 });
  assert.deepEqual(sweep.handTyped(secondCss), { px: 3, radii: 2, shadows: 1, timings: 1 });
  assert.deepEqual(sweep.handTyped(".b { border-radius: var(--radius, 4px); box-shadow: var(--a), var(--b); border-radius: 0; box-shadow: none; }"),
    { px: 0, radii: 0, shadows: 0, timings: 0 });
  assert.deepEqual(sweep.unitOutcomes("✔ a (1ms)\n  ✖ b\n✖ failing tests:\n✖ b\n"), [["unit › a", ["pass"]], ["unit › b", ["fail"]]]);
  assert.deepEqual(sweep.unitOutcomes("TAP version 13\n# Subtest: c\n    not ok 1 - c \\# 2\nok 2 - d # TODO later\nok 3 - e # 12ms\n1..3\n"),
    [["unit › c # 2", ["fail"]], ["unit › e", ["pass"]]]);
});

test("nested describe groups name a spec by file and group; a flaky test failed then passed", () => {
  const report = { suites: [{ title: "native-save/x.spec.ts", file: "native-save/x.spec.ts", suites: [{ title: "group",
    specs: [{ title: "t", tests: [{ status: "flaky" }] }, { title: "skipped", tests: [{ status: "skipped" }] }] }] }] };
  assert.deepEqual(sweep.specOutcomes(report), [["native-save/x.spec.ts › group > t", ["fail", "pass"]]]);
});

test("unit tests are matched by name: one name failing in one file and passing in another counts as one flip", () => {
  // The spec reporter prints no file per test, so two files' "parses" are one test to the sweep (the bundle says so).
  const runs = [{ worktree: "/w", path: "/w/.scratch/pr/1", time: 1, outcomes: sweep.unitOutcomes("✖ parses (1ms)\n") },
    { worktree: "/w", path: "/w/.scratch/pr/2", time: 2, outcomes: sweep.unitOutcomes("✔ parses (1ms)\n") }];
  assert.deepEqual(sweep.flippedTests(runs).map(item => [item.name, item.times, [...item.worktrees]]), [["unit › parses", 1, ["w"]]]);
});

test("--since takes days or a date; anything else is a usage error", (t) => {
  assert.deepEqual(sweep.parseArgs([]), { since: "7d" });
  assert.deepEqual(sweep.parseArgs(["--since", "14d"]), { since: "14d" });
  assert.deepEqual(sweep.parseArgs(["--since", "2026-10-01"]), { since: "2026-10-01" });
  for (const args of [["--since", "0d"], ["--since", "2026-13-01"], ["--since", "2026-02-31"], ["--since"], ["--since", "7d", "--since", "8d"], ["extra"]])
    assert.throws(() => sweep.parseArgs(args), /invalid/, args.join(" "));
  const { repo } = repository(t);
  const result = run(repo, ["--since", "week"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^RESULT: fail sweep invalid --since: week/m);
});

test("a missing sharedFile, maps or techDebt setting drops its section or says so", t => {
  const { repo } = repository(t);
  const files = new Map([["src/main.ts", "a\nb\n"], ["src/other.ts", "c\n"]]);
  const titles = (sections: Section[]) => sections.map(section => section.title);
  assert.ok(titles(sweep.codeSections(files, new Map(), "src/main.ts")).includes("src/main.ts"));
  assert.deepEqual(titles(sweep.codeSections(files, new Map(), null)), ["Biggest source files", "Biggest growth", "Hand-typed values in src/**/*.css"]);
  assert.deepEqual(sweep.correctionsSection(repo, "", "HEAD", null).lines, ["- no maps folder in scripts/agents/kit.json"]);
  assert.deepEqual(sweep.staleDebtSection(repo, Date.now(), null).lines, ["- no techDebt folder in scripts/agents/kit.json"]);
});

test("corrections name their map under a maps folder other than docs/wayfinder", t => {
  const { repo } = repository(t);
  write(join(repo, "README.md"), "base\n");
  commit(repo, Date.now() - 2 * day, "base");
  const then = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  write(join(repo, "notes/maps/alpha/build/feedback.md"), "# Feedback: alpha\n\n## Feedback\n\n- 2026-10-26 · fault · Lost a page · after release: no · fix: open\n");
  commit(repo, Date.now() - day, "feedback");
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const section = sweep.correctionsSection(repo, then, head, "notes/maps");
  assert.deepEqual(section.lines, ["- 1 corrections committed in the window; by kind: fault 1",
    "- 2026-10-26 · fault · Lost a page · alpha · after release: no · fix: open"]);
});
