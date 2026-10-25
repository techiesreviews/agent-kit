import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const script = resolve("scripts/agents/kit.d/learn"), kit = resolve("scripts/agents/kit");
const fixtures = resolve("tests/fixtures/kit-learn"), memory = join(fixtures, "memory"), repo = join(fixtures, "repo");
type Entry = { date: string; kind: string; text: string; repeats?: string; source: string; file: string; line: number };
type Group = { members: (Entry & { words: Set<string> })[]; outside: string[]; times: number; kinds: string[] };
type Block = { file: string; line: number; id?: string; words: Set<string> };
// Node loads this extensionless executable as ESM; a URL keeps tsx from resolving it as TS.
const learn: {
  parseArgs(args: string[]): { since: string; project?: string };
  parseCorrections(text: string, file: string): { entries: Entry[]; problems: { file: string; line: number; message: string }[] };
  groupCorrections(entries: Entry[], otherSlugs?: string[]): Group[];
  ruleBlocks(text: string, file: string): Block[];
  coveredBy(group: Group, blocks: Block[]): (Block & { shared: string[] }) | undefined;
  projectMap(readme: string): { slug: string; workspace: string }[];
  findSlug(rows: { slug: string; workspace: string }[], roots: string[]): string | undefined;
  keyWords(text: string): Set<string>;
  sinceDate(since: string, now?: number): string;
  bundleLimit: number;
  groupLines(group: Group, root: string, blocks: Block[]): string[];
} = await import(pathToFileURL(script).href);

const corrections = join(memory, "corrections/demo.md");
const parsed = () => learn.parseCorrections(readFileSync(corrections, "utf8"), corrections);
const texts = (group: Group) => group.members.map(member => member.text);

function temp(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-learn-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(env: Record<string, string>, args: string[] = []) {
  const base: Record<string, string | undefined> = { ...process.env, ASE_SKIP_DOCTOR: "1", KIT_ROOT: repo };
  // A test names the memory folder itself, or none to read the default under HOME.
  delete base.KIT_CHAT_MEMORY;
  delete base.CHAT_MEMORY_DIR;
  return spawnSync("bash", [kit, "learn", ...args], { encoding: "utf8", timeout: 20_000, env: { ...base, ...env } });
}

const pad = (number: number) => String(number).padStart(2, "0");
const localDate = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const daysAgo = (days: number) => { const today = new Date(); return localDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - days)); };
const correctionsFile = (lines: string[]) => `# demo\n\n## Corrections\n\n${lines.join("\n")}\n`;
const bundleOf = (output: string) => {
  const path = /^RESULT: ok learn .*, bundle (.+)$/m.exec(output)?.[1];
  assert.ok(path, output);
  return readFileSync(path, "utf8");
};

/** Every file under a folder with its bytes and modification time. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, name), stat = statSync(path);
    out[name] = stat.isDirectory() ? "dir" : `${stat.mtimeMs} ${readFileSync(path, "base64")}`;
  }
  return out;
}

test("each line parses into date, kind, text, repeats and thread; a malformed line is reported, not fatal", () => {
  const { entries, problems } = parsed();
  assert.equal(entries.length, 8);
  assert.deepEqual(entries[0], { date: "2026-10-20", kind: "too-much", text: "Removed the hint text beside the save button again",
    repeats: "2026-10-10", source: "Hints", file: corrections, line: 7 });
  assert.equal(entries[1].text, '"Publishing lost the page title after a rename"');
  assert.equal(entries[4].repeats, "2026-10-01 (other-project)");
  assert.deepEqual(problems.map(problem => [problem.line, problem.message.split(" (")[0]]),
    [[10, "malformed correction line"], [12, "invalid kind: bogus"]]);
  // Lines outside the Corrections section are not corrections; a file without the heading says so.
  assert.deepEqual(learn.parseCorrections("# x\n\n- 2026-10-01 · fault · x · repeats: first · [t](u)\n", "f").problems,
    [{ file: "f", line: 1, message: "missing ## Corrections heading" }]);
  assert.deepEqual(learn.parseCorrections("", "f"), { entries: [], problems: [] });
});

test("repeats group by a repeats: date and by the same kind with close wording", () => {
  const groups = learn.groupCorrections(parsed().entries, ["other-project"]);
  const of = (text: string) => groups.find(group => texts(group).some(item => item.includes(text)))!;
  assert.deepEqual(texts(of("hint text")), ["Removed the hint text beside the save button again", "Hint text beside the save button is noise"]);
  assert.equal(of("hint text").times, 2);
  // Same kind, close wording, no repeats: field.
  assert.deepEqual(of("Dragging").members.map(member => member.date), ["2026-10-16", "2026-10-14"]);
  // A date in another project is one earlier time the list does not hold; its own-project neighbour stays apart.
  assert.deepEqual([of("Asked twice").times, of("Asked twice").outside, texts(of("Asked twice")).length], [2, ["2026-10-01 in other-project"], 1]);
  assert.equal(of("Posted no status").times, 1);
  // Close wording of another kind does not group.
  const kinds = learn.groupCorrections([
    { date: "2026-10-02", kind: "fault", text: "Dragging a card snaps it back", source: "a", file: "f", line: 1 },
    { date: "2026-10-01", kind: "felt-wrong", text: "Dragging a card snaps it back", source: "a", file: "f", line: 2 },
  ]);
  assert.equal(kinds.length, 2);
  // A repeats: date with only an unrelated line of another kind that day is an earlier time not in the list.
  const unrelated = learn.groupCorrections([
    { date: "2026-10-02", kind: "too-much", text: "Menu has too many words", repeats: "2026-10-01", source: "a", file: "f", line: 1 },
    { date: "2026-10-01", kind: "workflow", text: "Status line missing", repeats: "first", source: "a", file: "f", line: 2 },
  ]);
  assert.deepEqual(unrelated.map(group => [group.times, group.outside]), [[2, ["2026-10-01"]], [1, []]]);
});

test("key words are stemmed, so word forms meet", () => {
  assert.deepEqual(learn.keyWords("replacing images"), learn.keyWords("replace image"));
  assert.ok(learn.keyWords("quickly").has("quick"));
  assert.deepEqual(learn.keyWords("saved in the notes"), learn.keyWords("save the note"));
  assert.deepEqual([...learn.keyWords("The agent should show the explainers. Borderline: phrased as a wish")], ["show", "explainer"]);
});

test("a slug inside repeats: prose does not make a date another project's", () => {
  const groups = learn.groupCorrections([
    { date: "2026-10-02", kind: "fault", text: "Save lost the title", repeats: "2026-10-01 (noted across projects)", source: "a", file: "f", line: 1 },
    { date: "2026-10-01", kind: "fault", text: "Undo dropped a block", repeats: "first", source: "a", file: "f", line: 2 },
  ], ["projects"]);
  assert.deepEqual(groups.map(group => [group.members.length, group.outside]), [[2, []]]);
  const elsewhere = learn.groupCorrections([
    { date: "2026-10-02", kind: "fault", text: "Save lost the title", repeats: "2026-10-01 (projects)", source: "a", file: "f", line: 1 },
    { date: "2026-10-01", kind: "fault", text: "Undo dropped a block", repeats: "first", source: "a", file: "f", line: 2 },
  ], ["projects"]);
  assert.deepEqual(elsewhere.map(group => [group.members.length, group.outside]), [[1, ["2026-10-01 in projects"]], [1, []]]);
});

test("a repeats: date recorded in the feedback log links there and counts once", () => {
  const [group, ...rest] = learn.groupCorrections([
    { date: "2026-10-20", kind: "too-much", text: "Removed the hint text beside the save button again", repeats: "2026-10-19", source: "a", file: "chat.md", line: 1 },
    { date: "2026-10-19", kind: "too-much", text: "Removed the hint text beside the save button", source: "b", file: "feedback.md", line: 5 },
  ]);
  assert.deepEqual([group.times, group.outside, rest.length], [2, [], 0]);
});

test("the recorded-twice note needs a chat and a feedback line within a day", () => {
  const line = (date: string, origin: string, text = "Toolbar covers the heading on scroll") =>
    ({ date, kind: "fault", text, source: origin, file: `${origin}.md`, line: 1, origin, where: `${origin}.md:1` });
  const note = (...entries: ReturnType<typeof line>[]) => {
    const groups = learn.groupCorrections(entries);
    assert.equal(groups.length, 1);
    return learn.groupLines(groups[0], "/", []).some(text => text.includes("within a day in both lists"));
  };
  assert.equal(note(line("2026-10-02", "chat"), line("2026-10-01", "feedback")), true);
  assert.equal(note(line("2026-10-02", "chat"), line("2026-10-01", "chat", "Toolbar covers the heading on scroll again")), false);
  assert.equal(note(line("2026-10-03", "chat"), line("2026-10-01", "feedback")), false);
});

test("covered? names the rule block whose key words the correction shares", () => {
  const rulebook = join(repo, "docs/agents/ux-rulebook.md"), guardrails = join(repo, "docs/agents/guardrails.md");
  const blocks = [...learn.ruleBlocks(readFileSync(rulebook, "utf8"), rulebook), ...learn.ruleBlocks(readFileSync(guardrails, "utf8"), guardrails)];
  const groups = learn.groupCorrections(parsed().entries);
  const of = (text: string) => groups.find(group => texts(group).some(item => item.includes(text)))!;
  const hint = learn.coveredBy(of("hint text"), blocks)!;
  assert.deepEqual([hint.file, hint.line, hint.id], [rulebook, 5, "S1"]);
  assert.ok(["hint", "text", "besid"].every(word => hint.shared.includes(word)), hint.shared.join());
  assert.equal(learn.coveredBy(of("Publishing"), blocks)?.file, guardrails);
  assert.equal(learn.coveredBy(of("Dragging"), blocks), undefined);
});

test("the slug comes from the project map by workspace, a sibling worktree included", () => {
  const rows = learn.projectMap("| Slug | Workspace |\n| --- | --- |\n| site | `/w/site` |\n| site-starter | `/w/site-starter` (github) |\n| bad slug | `/w/x` |\n");
  assert.deepEqual(rows.map(row => row.slug), ["site", "site-starter"]);
  assert.equal(learn.findSlug(rows, ["/w/site-build-x"]), "site");
  assert.equal(learn.findSlug(rows, ["/w/site-starter"]), "site-starter");
  assert.equal(learn.findSlug(rows, ["/w/elsewhere"]), undefined);
});

test("arguments: --since Nd or a real date, --project a slug", () => {
  assert.deepEqual(learn.parseArgs([]), { since: "14d", project: undefined });
  // N days back, inclusive: runs 14 days apart share their boundary day.
  assert.equal(learn.sinceDate("14d", new Date(2026, 9, 26, 9).getTime()), "2026-10-12");
  assert.equal(learn.sinceDate("1d", new Date(2026, 2, 1, 0, 30).getTime()), "2026-02-28");
  assert.equal(learn.sinceDate("2026-10-01"), "2026-10-01");
  assert.deepEqual(learn.parseArgs(["--since", "2026-10-01", "--project", "demo"]), { since: "2026-10-01", project: "demo" });
  for (const args of [["--since", "2026-02-30"], ["--since", "0d"], ["--project", "../x"], ["--bogus"]]) assert.throws(() => learn.parseArgs(args));
  const result = run({ KIT_MAIN_ROOT: "/nonexistent" }, ["--since", "soon"]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /^RESULT: fail learn invalid --since: soon/m);
});

test("a missing or empty corrections file gives nothing recorded yet", (t) => {
  const dir = temp(t), empty = join(dir, "memory");
  mkdirSync(join(empty, "corrections"), { recursive: true });
  const env = { KIT_CHAT_MEMORY: empty, KIT_ROOT: dir, KIT_MAIN_ROOT: dir, HOME: dir };
  const missing = run(env);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^RESULT: ok learn nothing recorded yet$/m);
  writeFileSync(join(empty, "corrections/native-site-editor.md"), "");
  assert.match(run(env).stdout, /^RESULT: ok learn nothing recorded yet$/m);
  assert.equal(existsSync(join(dir, ".scratch")), false);
});

test("KIT_CHAT_MEMORY is read, never written; the bundle lands in the main root", (t) => {
  const dir = temp(t), home = join(dir, "home"), main = join(dir, "main");
  mkdirSync(home);
  const before = snapshot(memory);
  const result = run({ KIT_CHAT_MEMORY: memory, KIT_MAIN_ROOT: main, HOME: home }, ["--since", "2026-10-01", "--project", "demo"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(snapshot(memory), before);
  assert.deepEqual(readdirSync(home), []);
  assert.match(result.stdout, /demo\.md:10: malformed correction line/);
  const path = /^RESULT: ok learn 5 repeated of 6 groups, 3 malformed, bundle (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(path?.startsWith(join(main, ".scratch/learn/")), result.stdout);
  const bundle = readFileSync(path, "utf8");
  assert.match(bundle, /- \*\*×2 · fault\*\* · 2026-10-19, 2026-10-18 · feedback: demo; chat: Publish\n {2}- covered\?: docs\/agents\/guardrails\.md:3,.*\n {2}- within a day in both lists/);
  // An unknown feedback kind is listed, not grouped; a missing fix link does not matter here.
  assert.match(bundle, /## Malformed lines\n\n.+\n.+\n- .+feedback\.md:6: invalid kind: sideways\n/);
  assert.doesNotMatch(bundle, /A feedback kind the log does not have/);
  // A bad after release: value does not stop a line from grouping.
  assert.match(bundle, /- \*\*×2 · below-bar\*\* · 2026-10-08, 2026-10-07 · feedback: demo\n/);
  assert.doesNotMatch(bundle, /99-missing/);
  assert.match(bundle, /covered\?: docs\/agents\/ux-rulebook\.md:5 \(S1\)/);
  assert.match(bundle, /earlier time not in the list: 2026-10-01 in other-project/);
  assert.doesNotMatch(bundle, /An old line before the window/);
  assert.match(bundle, /## Malformed lines\n\n- .+demo\.md:10: malformed correction line/);
});

test("without --project the slug comes from the map by this checkout's workspace", (t) => {
  const dir = temp(t), copy = join(dir, "memory"), checkout = join(dir, "site-build-x");
  cpSync(memory, copy, { recursive: true });
  writeFileSync(join(copy, "project-notes/README.md"), `| Slug | Workspace |\n| --- | --- |\n| demo | \`${join(dir, "site")}\` |\n`);
  mkdirSync(checkout);
  const result = run({ KIT_CHAT_MEMORY: copy, KIT_ROOT: checkout, KIT_MAIN_ROOT: join(dir, "site"), HOME: dir }, ["--since", "2026-10-01"]);
  assert.match(result.stdout, /^RESULT: ok learn 3 repeated of 5 groups, 2 malformed, bundle /m);
});

test("without KIT_CHAT_MEMORY it reads ~/Projects/chat/memory, and 14d keeps a line 14 days old", (t) => {
  const home = temp(t), main = join(home, "main");
  const dir = join(home, "Projects/chat/memory/corrections");
  mkdirSync(dir, { recursive: true });
  const line = (days: number, text: string) => `- ${daysAgo(days)} · fault · ${text} · repeats: first · [T](t3-thread://v1/x) item i pos 1`;
  writeFileSync(join(dir, "native-site-editor.md"), correctionsFile([line(0, "Toolbar covers the heading"), line(14, "Undo forgets moved blocks"), line(15, "Fonts load twice on open")]));
  const result = run({ HOME: home, KIT_ROOT: home, KIT_MAIN_ROOT: main });
  const bundle = bundleOf(result.stdout);
  assert.match(bundle, new RegExp(`Since ${daysAgo(14)} \\(--since 14d\\)`));
  assert.match(bundle, /Toolbar covers the heading/);
  assert.match(bundle, /Undo forgets moved blocks/);
  assert.doesNotMatch(bundle, /Fonts load twice/);
});

test("a corrections list over the bundle limit trims lines given once before repeated ones", (t) => {
  const dir = temp(t), copy = join(dir, "memory");
  mkdirSync(join(copy, "corrections"), { recursive: true });
  // Made-up words per line, so no two lines share wording.
  const words = (index: number) => Array.from({ length: 12 }, (_, word) => `w${index}x${word}`).join(" ");
  const lines = Array.from({ length: 300 }, (_, index) => `- 2026-10-${pad(10 + (index % 10))} · fault · ${words(index)} · repeats: first · [T](t3-thread://v1/x) item i pos ${index}`);
  lines.unshift("- 2026-10-20 · too-much · Removed the hint text beside the save button again · repeats: 2026-10-10 · [H](t3-thread://v1/h) item i pos 1",
    "- 2026-10-10 · too-much · Hint text beside the save button is noise · repeats: first · [H](t3-thread://v1/h) item i pos 0");
  writeFileSync(join(copy, "corrections/demo.md"), correctionsFile(lines));
  assert.ok(Buffer.byteLength(readFileSync(join(copy, "corrections/demo.md"))) > learn.bundleLimit);
  const result = run({ KIT_CHAT_MEMORY: copy, KIT_ROOT: dir, KIT_MAIN_ROOT: dir, HOME: dir }, ["--since", "2026-10-01", "--project", "demo"]);
  const bundle = bundleOf(result.stdout);
  assert.ok(Buffer.byteLength(bundle) < learn.bundleLimit, String(Buffer.byteLength(bundle)));
  assert.match(bundle, /Trimmed to stay under 40000 bytes: Given once \d+ lines\./);
  assert.match(bundle, /## Given more than once\n\n- \*\*×2 · too-much\*\*.*\n(.*\n){3}\n## Given once/);
});
