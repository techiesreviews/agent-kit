import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { costTotal, kitScore, runCost, scoreMap, scoreReview } from "../scripts/agents/kit-lib.mjs";

const kit = resolve("scripts/agents/kit");
type Counts = Record<string, number>;
interface Cost { usd: number | null; tokens: number | null; partial?: true }
// Builder and review runs are summed apart.
interface PieceCost { build: Cost | null; review: Cost | null }
interface Review { dir: string; model: string | null; effort: string | null; counts: { kind: Counts; severity: Counts } | null; declined: unknown[] }
interface Landed { pr?: number; sha?: string; at?: string; tier?: string; ci?: string; waived?: string | null; queued?: boolean }
// A scoreboard record as the kit writes it; ScorePiece is how --json and --snapshot show one.
export interface ScoreRecord {
  ticket: string | null; title: string | null; kind: string | null;
  builder: { model: string; effort: string; previousModels: string[]; built?: string | null } | null;
  phases: { name: string; start: string; end: string; exit: number }[];
  rounds: number; reviews: Review[]; cost: PieceCost | null; costs: Record<string, Cost & { role: "build" | "review" }>; landed: Landed | null;
}
type ScorePiece = Omit<ScoreRecord, "costs"> & { piece: string; minutes: number | null; findings: Counts };
interface Total { pieces: number; minutes: number; rounds: number; findings: Counts; cost: PieceCost }
interface ScoreData { map: string; pieces: ScorePiece[]; totals: { builders: Record<string, Total>; kinds: Record<string, Total> }; feedback: string | null }
const claudeResult = JSON.stringify({ type: "result", result: "Done.", total_cost_usd: 0.57,
  usage: { input_tokens: 14, output_tokens: 5786, cache_creation_input_tokens: 50640, cache_read_input_tokens: 245282 },
  modelUsage: { "claude-opus-5-5": { inputTokens: 14, outputTokens: 5786, cacheReadInputTokens: 245282, cacheCreationInputTokens: 50640, costUSD: 0.5697 },
    "claude-haiku-5-5": { inputTokens: 2341, outputTokens: 16, costUSD: 0.0003 } } });

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-score-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work"), main = join(dir, "main");
  mkdirSync(join(root, "docs/wayfinder/demo/build/tickets"), { recursive: true }); mkdirSync(main);
  const records = join(main, ".scratch/scoreboard/demo");
  mkdirSync(records, { recursive: true });
  const review = (name: string, kind: Counts): Review => ({ dir: join(main, ".scratch/reviews/demo-01", name), model: "claude-opus-5-5", effort: "medium",
    counts: { kind: { fault: 0, ticket: 0, race: 0, style: 0, unsorted: 0, gap: 0, ...kind }, severity: { P0: 0, P1: 0, P2: 0, P3: 0, none: 0, gap: 0 } }, declined: [] });
  writeFileSync(join(records, "01-first.json"), JSON.stringify({
    ticket: "docs/wayfinder/demo/build/tickets/01-first.md", title: "First piece", kind: "task (AFK) M",
    builder: { model: "claude-opus-5-5", effort: "high", previousModels: [] },
    phases: [{ name: "build", start: "2026-10-25T10:00:00.000Z", end: "2026-10-25T10:30:00.000Z", exit: 0 },
      { name: "review", start: "2026-10-25T10:30:00.000Z", end: "2026-10-25T10:42:00.000Z", exit: 0 }],
    rounds: 2, reviews: [review("a", { fault: 1, gap: 1 }), review("b", { ticket: 2 })],
    cost: { build: { usd: 1.5, tokens: 300000, partial: true }, review: { usd: 0.5, tokens: 100000 } },
    costs: { [join(main, "x")]: { role: "build", usd: 1.5, tokens: 300000 } },
    landed: { pr: 101, sha: "a".repeat(40), at: "2026-10-25T11:00:00.000Z", tier: "full", ci: "pass", waived: null },
  } satisfies ScoreRecord));
  writeFileSync(join(records, "02-second.json"), JSON.stringify({
    ticket: "docs/wayfinder/demo/build/tickets/02-second.md", title: "Second piece", kind: "task (AFK) S",
    builder: { model: "gpt-6-luna", effort: "high", previousModels: ["gpt-6.1-sol"], built: "gpt-6.1-sol" },
    phases: [{ name: "build", start: "2026-10-25T12:00:00.000Z", end: "2026-10-25T12:20:00.000Z", exit: 0 }],
    rounds: 0, reviews: [review("c", {})], cost: { build: { usd: null, tokens: 80000 }, review: { usd: 0.57, tokens: 300000 } }, costs: {}, landed: { pr: 102, tier: "full" },
  } satisfies ScoreRecord));
  const env = { ...process.env, KIT_ROOT: root, KIT_MAIN_ROOT: main, ASE_SKIP_DOCTOR: "1" };
  const run = (...args: string[]) => {
    const result = spawnSync("bash", [kit, "score", ...args], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
    const lines = result.stdout.trimEnd().split("\n");
    assert.equal(lines.filter(line => line.startsWith("RESULT:")).length, 1, result.stdout + result.stderr);
    assert.match(lines.at(-1)!, /^RESULT: /);
    return result;
  };
  return { dir, root, main, records, run };
}

// The merged data the page reads: the same object for --json <map> and --snapshot.
const expected = (() => {
  const review = (name: string, kind: Counts): Review => ({ dir: `.scratch/reviews/demo-01/${name}`, model: "claude-opus-5-5", effort: "medium",
    counts: { kind: { fault: 0, ticket: 0, race: 0, style: 0, unsorted: 0, gap: 0, ...kind }, severity: { P0: 0, P1: 0, P2: 0, P3: 0, none: 0, gap: 0 } }, declined: [] });
  return {
    map: "demo",
    pieces: [
      { piece: "01-first", ticket: "docs/wayfinder/demo/build/tickets/01-first.md", title: "First piece", kind: "task (AFK) M",
        builder: { model: "claude-opus-5-5", effort: "high", previousModels: [] },
        phases: [{ name: "build", start: "2026-10-25T10:00:00.000Z", end: "2026-10-25T10:30:00.000Z", exit: 0 },
          { name: "review", start: "2026-10-25T10:30:00.000Z", end: "2026-10-25T10:42:00.000Z", exit: 0 }],
        rounds: 2, reviews: [review("a", { fault: 1, gap: 1 }), review("b", { ticket: 2 })], cost: { build: { usd: 1.5, tokens: 300000, partial: true }, review: { usd: 0.5, tokens: 100000 } },
        landed: { pr: 101, sha: "a".repeat(40), at: "2026-10-25T11:00:00.000Z", tier: "full", ci: "pass", waived: null },
        minutes: 42, findings: { fault: 1, gap: 1, ticket: 2 } },
      { piece: "02-second", ticket: "docs/wayfinder/demo/build/tickets/02-second.md", title: "Second piece", kind: "task (AFK) S",
        builder: { model: "gpt-6-luna", effort: "high", previousModels: ["gpt-6.1-sol"], built: "gpt-6.1-sol" },
        phases: [{ name: "build", start: "2026-10-25T12:00:00.000Z", end: "2026-10-25T12:20:00.000Z", exit: 0 }],
        rounds: 0, reviews: [review("c", {})], cost: { build: { usd: null, tokens: 80000 }, review: { usd: 0.57, tokens: 300000 } }, landed: { pr: 102, tier: "full" },
        minutes: 20, findings: {} },
    ],
    totals: {
      builders: {
        "claude-opus-5-5": { pieces: 1, minutes: 42, rounds: 2, findings: { fault: 1, gap: 1, ticket: 2 }, cost: { build: { usd: 1.5, tokens: 300000, partial: true }, review: { usd: 0.5, tokens: 100000 } } },
        "gpt-6.1-sol": { pieces: 1, minutes: 20, rounds: 0, findings: {}, cost: { build: { usd: null, tokens: 80000 }, review: { usd: 0.57, tokens: 300000 } } },
      },
      kinds: {
        "task (AFK) M": { pieces: 1, minutes: 42, rounds: 2, findings: { fault: 1, gap: 1, ticket: 2 }, cost: { build: { usd: 1.5, tokens: 300000, partial: true }, review: { usd: 0.5, tokens: 100000 } } },
        "task (AFK) S": { pieces: 1, minutes: 20, rounds: 0, findings: {}, cost: { build: { usd: null, tokens: 80000 }, review: { usd: 0.57, tokens: 300000 } } },
      },
    },
    feedback: null,
  } satisfies ScoreData;
})();

test("kit score prints one row per piece and totals per builder and kind", t => {
  const f = fixture(t), result = f.run("demo");
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.equal(lines[0], "score: demo (2 pieces)");
  assert.match(lines[1], /^piece\s+builder\s+min\s+rounds\s+findings\s+build cost\s+review cost\s+PR$/);
  // Dollars and tokens side by side; ">=" marks dollars that leave out tokens-only runs.
  assert.match(lines[2], /^01-first\s+claude-opus-5-5\s+42\s+2\s+fault 1, gap 1, ticket 2\s+>=\$1\.50 300\.0k tok\s+\$0\.50 100\.0k tok\s+#101$/);
  // A tokens-only builder reviewed by priced Claude: the review's dollars never read as the builder's.
  // The totals credit the model that built the piece; the row also names the later fix builder.
  assert.match(lines[3], /^02-second\s+gpt-6\.1-sol -> gpt-6-luna\s+20\s+0\s+none\s+80\.0k tok\s+\$0\.57 300\.0k tok\s+#102 open$/);
  assert.equal(lines[4], "totals by builder:");
  assert.match(lines[5], /^ {2}claude-opus-5-5\s+1 pieces\s+42 min\s+2 rounds\s+fault 1, gap 1, ticket 2\s+build >=\$1\.50 300\.0k tok\s+review \$0\.50 100\.0k tok$/);
  assert.match(lines[6], /^ {2}gpt-6\.1-sol\s+1 pieces\s+20 min\s+0 rounds\s+none\s+build 80\.0k tok\s+review \$0\.57 300\.0k tok$/);
  assert.equal(lines[7], "totals by kind:");
  assert.match(lines[8], /^ {2}task \(AFK\) M\s+1 pieces/);
  assert.match(result.stdout, /RESULT: ok score demo 2 pieces\n$/);
  // With no map, every map with records.
  const all = f.run();
  assert.equal(all.status, 0); assert.match(all.stdout, /^score: demo \(2 pieces\)/); assert.match(all.stdout, /RESULT: ok score 1 maps 2 pieces\n$/);
});

test("kit score --json and --snapshot write the merged data, including the feedback log when present", t => {
  const f = fixture(t), json = f.run("demo", "--json");
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout.slice(0, json.stdout.lastIndexOf("RESULT:"))), expected);
  const snapshot = f.run("demo", "--snapshot"), path = join(f.root, "docs/wayfinder/demo/build/scoreboard.json");
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.match(snapshot.stdout, /^snapshot: docs\/wayfinder\/demo\/build\/scoreboard\.json$/m);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), expected);
  assert.deepEqual(readdirSync(join(f.root, "docs/wayfinder/demo/build")).sort(), ["scoreboard.json", "tickets"]);
  writeFileSync(join(f.root, "docs/wayfinder/demo/build/feedback.md"), "- 2026-10-25 Lex: too many words\n");
  assert.equal(f.run("demo", "--snapshot").status, 0);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).feedback, "- 2026-10-25 Lex: too many words\n");
  // With both flags stdout is the data alone; the snapshot line goes to stderr.
  const both = f.run("demo", "--json", "--snapshot");
  assert.equal(both.status, 0, both.stderr);
  assert.ok(both.stdout.startsWith("{"), both.stdout.slice(0, 40));
  assert.deepEqual(JSON.parse(both.stdout.slice(0, both.stdout.lastIndexOf("RESULT:"))).map, "demo");
  assert.match(both.stderr, /^snapshot: docs\/wayfinder\/demo\/build\/scoreboard\.json$/m);
  const all = f.run("--json");
  assert.deepEqual(JSON.parse(all.stdout.slice(0, all.stdout.lastIndexOf("RESULT:"))).maps.map((map: { map: string }) => map.map), ["demo"]);
});

test("kit score refuses bad options and a snapshot without a map or build folder; skips unreadable records", t => {
  const f = fixture(t);
  for (const args of [["--snapshot"], ["--bogus"], ["demo", "other"], ["../demo"]]) assert.equal(f.run(...args).status, 2, args.join(" "));
  const empty = f.run("other");
  assert.equal(empty.status, 0, empty.stdout + empty.stderr);
  assert.equal(empty.stdout, "score: other (0 pieces)\nRESULT: ok score other 0 pieces\n");
  const missing = f.run("other", "--snapshot");
  assert.equal(missing.status, 1); assert.match(missing.stdout, /RESULT: fail score no build folder for map other/);
  writeFileSync(join(f.records, "03-broken.json"), "{");
  const result = f.run("demo");
  assert.equal(result.status, 0); assert.match(result.stderr, /^problem: scoreboard .+03-broken\.json unreadable/m);
  assert.match(result.stdout, /^score: demo \(2 pieces\)/);
  rmSync(join(f.main, ".scratch/scoreboard"), { recursive: true });
  assert.match(f.run().stdout, /^score: no records\nRESULT: ok score 0 maps 0 pieces\n$/);
});

test("runCost reads Claude JSON cost and tokens, Codex token lines, and leaves a missing cost null", () => {
  assert.deepEqual(runCost(`model: claude-opus-5-5\n${claudeResult}\n`), { usd: 0.57, tokens: 14 + 5786 + 245282 + 50640 + 2341 + 16 });
  assert.deepEqual(runCost(`${claudeResult}\n--- resume ---\n${claudeResult}\n`), { usd: 1.14, tokens: 2 * (14 + 5786 + 245282 + 50640 + 2341 + 16) });
  assert.deepEqual(runCost(JSON.stringify({ type: "result", usage: { input_tokens: 10, output_tokens: 5 } })), { usd: null, tokens: 15 });
  assert.deepEqual(runCost("codex\ntokens used\n79,862\n"), { usd: null, tokens: 79862 });
  assert.deepEqual(runCost(JSON.stringify({ text: "review", modelUsage: { "grok-4.7": { inputTokens: 100, outputTokens: 20 } } })), { usd: null, tokens: 120 });
  assert.equal(runCost("plain output\n{not json\n"), null);
  assert.equal(runCost(JSON.stringify({ type: "result", result: "no cost fields" })), null);
});

test("costTotal sums priced and tokens-only runs, marking dollars that leave runs out", () => {
  assert.equal(costTotal([]), null); assert.equal(costTotal([null]), null);
  assert.deepEqual(costTotal([{ usd: 1, tokens: 10 }, { usd: 0.5, tokens: 5 }]), { usd: 1.5, tokens: 15 });
  assert.deepEqual(costTotal([{ usd: 1, tokens: 10 }, { usd: null, tokens: 5 }]), { usd: 1, tokens: 15, partial: true });
  assert.deepEqual(costTotal([{ usd: null, tokens: 5 }, { usd: null, tokens: 7 }]), { usd: null, tokens: 12 });
  assert.deepEqual(costTotal([{ usd: 1, tokens: 10, partial: true }, null]), { usd: 1, tokens: 10, partial: true });
});

test("kitScore writes one record per ticket atomically with title, kind and size; untracked runs use the branch", t => {
  const f = fixture(t), previous = { root: process.env.KIT_ROOT, main: process.env.KIT_MAIN_ROOT };
  process.env.KIT_MAIN_ROOT = f.main;
  t.after(() => {
    for (const [key, value] of [["KIT_ROOT", previous.root], ["KIT_MAIN_ROOT", previous.main]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  const ticket = "docs/wayfinder/demo/build/tickets/03-third.md";
  writeFileSync(join(f.root, ticket), "---\ntitle: \"Third piece\"\ntype: task (AFK)\nstatus: open\n---\n\n## Files\n");
  writeFileSync(join(f.root, "docs/wayfinder/demo/build/README.md"),
    "| Slice | Size | Builder |\n| --- | --- | --- |\n| [02 Other](tickets/02-other.md) | S | opencode |\n| [03 Third](tickets/03-third.md) | M–L | claude |\n\n" +
    "| Slice | Builder | Size |\n| --- | --- | --- |\n| [04 Later](tickets/04-later.md) | claude | L |\n| [05 Last](tickets/05-last.md) | sol | XL |\n");
  const evidence = join(f.main, ".scratch/reviews/demo-01/20261025T100000Z");
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, "result.md"), "REVIEW_STATUS: complete\nDefects:\nSpec:\n- a.ts:1 P1 fault: wrong\nStandards: none\nValidation gaps: Add a test.\nOptional nits: none\n");
  writeFileSync(join(evidence, "run.log"), `${claudeResult}\n`);
  kitScore({ ticket, root: f.root }, record => { scoreReview(record, evidence); record.rounds = 1; });
  const record: ScoreRecord = JSON.parse(readFileSync(join(f.records, "03-third.json"), "utf8"));
  assert.equal(record.ticket, ticket); assert.equal(record.title, "Third piece"); assert.equal(record.kind, "task (AFK) M–L");
  // A later row of a second table reads Size from that table's own header.
  const last = "docs/wayfinder/demo/build/tickets/05-last.md";
  writeFileSync(join(f.root, last), "---\ntitle: Last\ntype: task\n---\n");
  kitScore({ ticket: last, root: f.root }, () => {});
  assert.equal(JSON.parse(readFileSync(join(f.records, "05-last.json"), "utf8")).kind, "task XL");
  assert.equal(record.rounds, 1); assert.equal(record.reviews.length, 1);
  assert.deepEqual(record.reviews[0].counts.kind, { fault: 1, ticket: 0, race: 0, style: 0, unsorted: 0, gap: 1 });
  assert.deepEqual(record.cost, { build: null, review: { usd: 0.57, tokens: 14 + 5786 + 245282 + 50640 + 2341 + 16 } });
  // A second write of the same review replaces its entry and cost; nothing is counted twice.
  kitScore({ ticket, root: f.root }, current => scoreReview(current, evidence));
  const again = JSON.parse(readFileSync(join(f.records, "03-third.json"), "utf8"));
  assert.equal(again.reviews.length, 1); assert.equal(again.cost.review.usd, 0.57);
  assert.deepEqual(readdirSync(f.records).filter(name => name.includes(".tmp")), []);
  kitScore({ branch: "build/x-01", root: f.root }, current => { current.rounds = 3; });
  assert.equal(JSON.parse(readFileSync(join(f.main, ".scratch/scoreboard/_untracked/build%2Fx-01.json"), "utf8")).rounds, 3);
  assert.equal(scoreMap("docs/work/04-other.md"), "_untracked");
  assert.equal(existsSync(join(f.main, ".scratch/scoreboard/_untracked")), true);
});

test("a scoreboard write failure prints one problem line and never throws", t => {
  const f = fixture(t), previous = process.env.KIT_MAIN_ROOT;
  process.env.KIT_MAIN_ROOT = join(f.dir, "blocked");
  t.after(() => { if (previous === undefined) delete process.env.KIT_MAIN_ROOT; else process.env.KIT_MAIN_ROOT = previous; });
  writeFileSync(join(f.dir, "blocked"), "a file where the main root should be");
  const errors: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };
  try {
    assert.doesNotThrow(() => kitScore({ branch: "build/x-01", root: f.root }, record => { record.rounds = 1; }));
    assert.doesNotThrow(() => kitScore({ branch: "build/x-01", root: f.root }, () => { throw new Error("second"); }));
  } finally { console.error = original; }
  assert.equal(errors.length, 1); assert.match(errors[0], /^problem: scoreboard /);
});

test("parallel writers to one record lose no update; a lock held past the wait is one problem line", async t => {
  const f = fixture(t), library = pathToFileURL(resolve("scripts/agents/kit-lib.mjs")).href;
  const writer = (name: string, wait = "5000", umask = "") => new Promise<{ status: number | null; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `${umask ? `process.umask(${umask});` : ""}const { kitScore } = await import(${JSON.stringify(library)});
kitScore({ branch: "build/x-01", root: ${JSON.stringify(f.root)} }, record => { record.phases.push({ name: ${JSON.stringify(name)}, start: "", end: "", exit: 0 }); });`],
    { env: { ...process.env, KIT_MAIN_ROOT: f.main, ASE_SCORE_LOCK_MS: wait }, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", reject); child.once("close", status => accept({ status, stderr }));
  });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => writer(`writer-${index}`)));
  for (const result of results) assert.equal(result.stderr, "");
  const path = join(f.main, ".scratch/scoreboard/_untracked/build%2Fx-01.json");
  const names = (): string[] => JSON.parse(readFileSync(path, "utf8")).phases.map((phase: { name: string }) => phase.name).sort();
  assert.deepEqual(names(), Array.from({ length: 8 }, (_, index) => `writer-${index}`).sort());
  // A lock left by a dead command is taken over; so is one with no owner after ten waits.
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  mkdirSync(`${path}.lock`); writeFileSync(`${path}.lock/owner`, `${dead} ${Date.now()}\n`);
  const abandoned = await writer("after-dead", "100");
  assert.equal(abandoned.stderr, ""); assert.ok(names().includes("after-dead"));
  assert.equal(existsSync(`${path}.lock`), false);
  mkdirSync(`${path}.lock`); utimesSync(`${path}.lock`, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const old = await writer("after-old", "100");
  assert.equal(old.stderr, ""); assert.ok(names().includes("after-old"));
  // A live owner's fresh lock is held: one problem line, nothing written.
  mkdirSync(`${path}.lock`); writeFileSync(`${path}.lock/owner`, `${process.pid} ${Date.now()}\n`);
  const held = await writer("late", "100");
  assert.equal(held.status, 0); assert.match(held.stderr, /^problem: scoreboard lock .+ is held/);
  assert.equal(names().includes("late"), false);
  rmSync(`${path}.lock`, { recursive: true });
  // An owner file that cannot be written (a read-only lock folder) leaves no lock behind.
  if (process.getuid?.() !== 0) {
    const unwritable = await writer("unwritable", "100", "0o222");
    assert.match(unwritable.stderr, /^problem: scoreboard /); assert.equal(existsSync(`${path}.lock`), false);
    const started = Date.now(), next = await writer("after-unwritable", "5000");
    assert.equal(next.stderr, ""); assert.ok(names().includes("after-unwritable"));
    assert.ok(Date.now() - started < 4_000, "the next write does not wait for the lock");
  }
});


test("real kit review records its review: evidence folder, model, counts and the review's Claude cost", t => {
  const f = fixture(t), bin = join(f.dir, "bin");
  mkdirSync(bin);
  const report = "REVIEW_STATUS: complete\nDefects:\nSpec:\n- file.txt:1 P2 fault: wrong\nStandards: none\nValidation gaps: Add a test.\nOptional nits: none\n";
  // A fake claude CLI: one JSON result naming the requested model, with a reported cost.
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const args = process.argv.slice(2), model = args[args.indexOf("--model") + 1];
require("node:fs").readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "result", subtype: "success", result: ${JSON.stringify(report)}, session_id: "s-1", total_cost_usd: 0.42,
  usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } } }));
`, { mode: 0o755 });
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", f.root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  const ticket = "docs/wayfinder/demo/build/tickets/01-x.md";
  git("init", "-b", "build/x-01"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  writeFileSync(join(f.root, "file.txt"), "base\n"); git("add", "-A"); git("commit", "-m", "base");
  writeFileSync(join(f.root, ticket), "---\ntitle: X\ntype: task\n---\n\n## Files\n- `file.txt`\n\n## Done when\n- Works.\n");
  writeFileSync(join(f.root, "file.txt"), "changed\n"); git("add", "-A"); git("commit", "-m", "change");
  const result = spawnSync(process.execPath, [resolve("scripts/agents/kit.d/review"), "--commit", "HEAD", "--ticket", ticket], {
    cwd: f.root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, KIT_ROOT: f.root, KIT_MAIN_ROOT: f.main, ASE_OWNER: "demo-01",
      ASE_REVIEW_MODEL: "claude-opus-5-5", ASE_AGENT_CLI: "", ASE_AGENT_TIMEOUT: "10s" },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const evidence = / evidence (.+)$/m.exec(result.stdout)?.[1];
  assert.ok(evidence, result.stdout);
  const findings = JSON.parse(readFileSync(join(evidence, "findings.json"), "utf8"));
  const record: ScoreRecord = JSON.parse(readFileSync(join(f.records, "01-x.json"), "utf8"));
  assert.equal(record.reviews.length, 1);
  assert.equal(record.reviews[0].dir, evidence);
  assert.equal(record.reviews[0].model, findings.model);
  assert.deepEqual(record.reviews[0].counts, findings.counts);
  assert.equal(record.reviews[0].counts?.kind.fault, 1);
  assert.deepEqual(record.cost, { build: null, review: { usd: 0.42, tokens: 15 } });
});
