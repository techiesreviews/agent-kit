import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { loadFeedback, loadTickets, newlyClosed, parseFeedback, parseFiles, parseTicket, resolveTickets } from "../tickets.mjs";

const fixtures = "tests/fixtures/agent-tickets";

/** Env for a temp repo run the way CI runs it: no kit wrapper roots leaking in from the outer worktree. */
function repoEnv(extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...extra };
  for (const name of ["KIT_ROOT", "KIT_MAIN_ROOT", "KIT_DEV_ROOT"]) delete env[name];
  return env;
}

/** Give a temp repo the settings file `tickets.mjs` reads its maps folder from. */
function writeSettings(cwd: string) {
  mkdirSync(join(cwd, "scripts/agents"), { recursive: true });
  writeFileSync(join(cwd, "scripts/agents/kit.json"), JSON.stringify({ project: "temp", branches: { land: "dev" }, maps: "docs/wayfinder" }));
}

test("ticket fixtures parse quotes and comments, resolve both directories and sort the frontier", () => {
  const loaded = loadTickets(`${fixtures}/valid`);
  assert.deepEqual(loaded.problems, []);
  const resolved = resolveTickets(loaded.tickets);
  assert.deepEqual(resolved.problems, []);
  assert.deepEqual(resolved.frontier.map((ticket: { map: string; slug: string }) => `${ticket.map}/${ticket.slug}`), ["alpha/02-ready", "alpha/10-ready", "beta/01-closed"]);
  assert.equal(resolved.frontier[0].title, "Ready: author's #1");
  assert.equal(resolved.frontier[0].builder, "sol");
  assert.equal(loadTickets(`${fixtures}/valid`, "alpha").tickets.length, 4);
  assert.throws(() => loadTickets(`${fixtures}/valid`, "missing"), /Unknown map/);
});

test("missing blockers never unblock tickets and do not resolve across maps", () => {
  const loaded = loadTickets(`${fixtures}/invalid`);
  assert.deepEqual(loaded.problems.map((problem: { line: number }) => problem.line), [3]);
  const resolved = resolveTickets(loaded.tickets);
  assert.equal(resolved.frontier.length, 0);
  assert.deepEqual(resolved.problems, [{ file: `${fixtures}/invalid/alpha/tickets/02-broken.md`, line: 6, message: "Unknown blocked_by ticket in alpha: 01-only-in-beta" }]);
});

test("frontmatter ends before body fields and malformed dependencies fail", () => {
  const source = readFileSync(`${fixtures}/valid/alpha/tickets/02-ready.md`, "utf8");
  const parsed = parseTicket(`${source}\nstatus: closed\nblocked_by: [absent]`, "02-ready.md", "alpha");
  assert.equal(parsed.ticket.status, "open");
  assert.equal(parsed.ticket.blocked_by.length, 1);
  for (const frontmatter of ["title: Missing status", "status: open\nblocked_by: slug", "status: open\nstatus: closed", "status: open\nblocked_by: [unclosed", 'status: open\nblocked_by: ["01-closed" "02-ready"]', "status: open\nblocked_by: [01-closed,,]"]) {
    assert.ok(parseTicket(`---\n${frontmatter}\n---`, "bad.md", "alpha").problems.length > 0);
  }
  assert.ok(parseTicket("status: open", "bad.md", "alpha").problems.length > 0);
});

test("block dependency lists preserve diagnostic line numbers and duplicate map slugs fail", () => {
  const parsed = parseTicket("---\nstatus: open\nblocked_by:\n  - 'missing' # note\n---", "02-block.md", "alpha");
  assert.deepEqual(parsed.problems, []);
  assert.equal(resolveTickets([parsed.ticket]).problems[0].line, 4);
  assert.match(resolveTickets([parsed.ticket, parsed.ticket]).problems[0].message, /Duplicate ticket slug/);
});

test("flow and block list fixtures retain every blocker across comments and blank lines", () => {
  const loaded = loadTickets(`${fixtures}/list-forms`);
  assert.deepEqual(loaded.problems, []);
  for (const ticket of loaded.tickets) {
    assert.deepEqual(ticket.blocked_by.map((blocker: { slug: string }) => blocker.slug), ["missing-one", "missing-two"], ticket.file);
  }
  const resolved = resolveTickets(loaded.tickets);
  assert.deepEqual(resolved.frontier, []);
  assert.deepEqual(resolved.problems.map((problem: { line: number }) => problem.line), [3, 3, 5, 8, 5, 8]);
  const closed = ["missing-one", "missing-two"].map((slug) => parseTicket("---\nstatus: closed\nblocked_by: []\n---", `${slug}.md`, "alpha").ticket);
  assert.equal(resolveTickets([...loaded.tickets, ...closed]).frontier.length, 3);
});

test("unsupported dependency content produces file:line diagnostics and no frontier", () => {
  const loaded = loadTickets(`${fixtures}/unsupported`);
  assert.deepEqual(loaded.problems.map((problem: { file: string; line: number }) => [problem.file, problem.line]), [
    [`${fixtures}/unsupported/alpha/tickets/01-nested.md`, 5],
    [`${fixtures}/unsupported/alpha/tickets/02-list-mapping.md`, 4],
    [`${fixtures}/unsupported/alpha/tickets/03-flow-extra.md`, 4],
    [`${fixtures}/unsupported/alpha/tickets/04-list-extra.md`, 5],
    [`${fixtures}/unsupported/alpha/tickets/05-empty-item.md`, 4],
  ]);
  assert.deepEqual(resolveTickets(loaded.tickets).frontier, []);
});

test("check and frontier report fixture dependency errors with file:line and exit 1", () => {
  const script = resolve("tickets.mjs");
  for (const fixture of ["list-forms", "unsupported"]) {
    const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-"));
    try {
      mkdirSync(join(cwd, "docs"));
      symlinkSync(resolve(fixtures, fixture), join(cwd, "docs/wayfinder"), "dir");
      mkdirSync(join(cwd, "scripts/agents"), { recursive: true });
      writeFileSync(join(cwd, "scripts/agents/kit.json"), JSON.stringify({ project: "p", branches: { land: "dev" }, maps: "docs/wayfinder" }));
      for (const command of ["check", "frontier"]) {
        const result = spawnSync(process.execPath, [script, command], { cwd, env: { ...process.env, KIT_ROOT: cwd }, encoding: "utf8" });
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /docs\/wayfinder\/alpha\/tickets\/.*\.md:\d+: /);
        assert.match(result.stderr, fixture === "list-forms" ? /Unknown blocked_by ticket/ : /blocked_by/);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("assignee is a scalar, supports quotes and comments, and defaults to empty", () => {
  for (const [field, expected] of [["", ""], ["assignee:", ""], ["assignee: # unassigned", ""],
    ['assignee: "Lex Example" # owner', "Lex Example"], ["assignee: 'Sam O''Neil'", "Sam O'Neil"]]) {
    const parsed = parseTicket(`---\nstatus: open\n${field}\n---`, "01-ready.md", "alpha");
    assert.deepEqual(parsed.problems, []);
    assert.equal(parsed.ticket.assignee, expected);
  }
});

test("type and runs_alone are read; runs_alone must be true or false", () => {
  const parsed = parseTicket("---\ntype: task (AFK) # slice\nstatus: open\nruns_alone: true\n---", "01-ready.md", "alpha");
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.ticket.type, "task (AFK)");
  assert.equal(parsed.ticket.runs_alone, true);
  assert.equal(parseTicket("---\nstatus: open\n---", "01-ready.md", "alpha").ticket.runs_alone, false);
  assert.deepEqual(parseTicket("---\nstatus: open\nruns_alone: yes\n---", "01-bad.md", "alpha").problems, [{ file: "01-bad.md", line: 3, message: "runs_alone must be true or false: yes" }]);
});

test("group is an optional slug; check fails on a malformed one", () => {
  const parsed = parseTicket("---\nstatus: open\ngroup: font-loading # shared cause\n---", "01-ready.md", "alpha");
  assert.deepEqual(parsed.problems, []);
  assert.equal(parsed.ticket.group, "font-loading");
  assert.equal(parseTicket("---\nstatus: open\n---", "01-ready.md", "alpha").ticket.group, "");
  assert.equal(parseTicket("---\nstatus: open\ngroup:\n---", "01-ready.md", "alpha").ticket.group, "");
  for (const bad of ["Fonts", "font loading", "-fonts", "fonts/x", "fonts--x"])
    assert.deepEqual(parseTicket(`---\nstatus: open\ngroup: "${bad}"\n---`, "01-bad.md", "alpha").problems, [{ file: "01-bad.md", line: 3, message: `group must be a slug (a-z, 0-9, -): ${bad}` }]);
  assert.deepEqual(parseTicket("---\nstatus: open\ngroup: a\ngroup: b\n---", "01-bad.md", "alpha").problems, [{ file: "01-bad.md", line: 4, message: "Duplicate group" }]);
});

test("Files lists exact paths; globs, placeholders and find-it-with lines name their directory", () => {
  const source = [
    "---", "status: open", "---", "", "## Goal", "", "- `src/not-a-file.ts` outside Files", "", "## Files", "",
    "- `scripts/agents/kit.d/next` (new), `tests/kit-next.test.ts` (new)",
    "- `docs/agents/kitchen.md` (station 5), `AGENTS.md`, `runs_alone:` and the `**Not started:**` line",
    "- `src/**/*.css` files, `scripts/agents/kit.d/<command>`, `scripts/agents/shots/features/`, `*.md`",
    "- `tests/kit-fix.test.ts` (or the file covering it; find it with `grep -ln \"kit.d/fix\" tests/`)",
    "- src/**, worker/** files with findings, e.g. dead exports",
    "- `.github/workflows/ci.yml`, `.gitignore` and `...`",
    "- .github/workflows/deploy-preview.yml (new), ../plain-outside.md, and/or read/write N/A",
    "- scripts/agents/kit.d/wait (three segments), tests/support/",
    "- `/home/lex/elsewhere.md`, `../outside.md`, `..`, `https://example.com/x`",
    "  1. `docs/nested.md` (sub-item)",
    "", "### Notes", "- `docs/notes.md`", "", "## Done when", "", "- `tests/later.test.ts`",
  ].join("\n");
  assert.deepEqual(parseFiles(source), [
    "scripts/agents/kit.d/next", "tests/kit-next.test.ts", "docs/agents/kitchen.md", "AGENTS.md",
    "src/", "scripts/agents/kit.d/", "scripts/agents/shots/features/", "./", "tests/", "worker/",
    ".github/workflows/ci.yml", ".gitignore", ".github/workflows/deploy-preview.yml", "scripts/agents/kit.d/wait", "tests/support/", "docs/nested.md", "docs/notes.md",
  ]);
  assert.deepEqual(parseFiles("---\nstatus: open\n---\nNo files section"), []);
  assert.deepEqual(parseTicket(source, "01-ready.md", "alpha").ticket.files, parseFiles(source));
});

test("ref loading and CLI use committed tickets, including maps absent from the working tree", t => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-ref-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = repoEnv({ GIT_AUTHOR_NAME: "Kit test", GIT_AUTHOR_EMAIL: "kit@example.com", GIT_COMMITTER_NAME: "Kit test", GIT_COMMITTER_EMAIL: "kit@example.com" });
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "-q", "--initial-branch=dev");
  writeSettings(cwd);
  const root = "docs/wayfinder";
  const file = `${root}/alpha/build/tickets/02-ready.md`;
  const regular = `${root}/alpha/tickets/01-closed.md`;
  const beta = `${root}/beta/tickets/01-ready.md`;
  for (const folder of ["alpha/build/tickets", "alpha/tickets", "beta/tickets", "empty"]) mkdirSync(join(cwd, root, folder), { recursive: true });
  writeFileSync(join(cwd, root, "empty/map.md"), "# Empty map\n");
  writeFileSync(join(cwd, file), "---\nstatus: open\nassignee: Lex Example\nbuilder: sol\nblocked_by: [01-closed]\n---");
  writeFileSync(join(cwd, regular), "---\nstatus: closed\n---");
  writeFileSync(join(cwd, beta), "---\nstatus: open\n---");
  git("add", "."); git("commit", "-qm", "tickets");
  const ref = git("rev-parse", "HEAD");
  writeFileSync(join(cwd, file), "---\nstatus: closed\n---");
  rmSync(join(cwd, root, "beta"), { recursive: true });
  mkdirSync(join(cwd, root, "local/tickets"), { recursive: true });
  writeFileSync(join(cwd, root, "local/tickets/01-local.md"), "---\nstatus: open\n---");

  const loaded = loadTickets(root, undefined, { ref, cwd });
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded.tickets.map((ticket: { file: string }) => ticket.file), [regular, file, beta]);
  const alpha = loadTickets(root, "alpha", { ref, cwd });
  assert.equal(alpha.tickets[1].status, "open");
  assert.equal(alpha.tickets[1].assignee, "Lex Example");
  assert.deepEqual(loadTickets(root, "empty", { ref, cwd }).tickets, []);
  assert.equal(loadTickets(join(cwd, root), "alpha").tickets[1].status, "closed");
  assert.throws(() => loadTickets(root, "local", { ref, cwd }), /Unknown map: local/);
  assert.throws(() => loadTickets(root, undefined, { ref: "missing-ref", cwd }), /Invalid ref: missing-ref/);

  const script = resolve("tickets.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 5_000 });
  for (const args of [["frontier", "alpha", "--ref", ref], ["frontier", "--ref", ref, "alpha"]]) {
    const output = run(...args);
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, /alpha\/build\/tickets\/02-ready.md\tsol\t02-ready/);
    assert.doesNotMatch(output.stdout, /beta|local/);
  }
  const all = run("frontier", "--ref", "dev");
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /beta\/tickets\/01-ready.md/);
  const check = run("check", "--ref", ref);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(check.stdout, "Tickets checked: 3\n");
  const bad = run("frontier", "--ref", "missing-ref");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Invalid ref: missing-ref/);
  for (const args of [["check", "alpha"], ["frontier", "--ref"], ["check", "--ref", ref, "--ref", ref]]) {
    const invalid = run(...args);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Usage:.*--ref <ref>/);
  }
});

test("the CLI in a repo without a settings file says what to add and exits 1", t => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-nosettings-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = repoEnv();
  assert.equal(spawnSync("git", ["init", "-q"], { cwd, env }).status, 0);
  const output = spawnSync(process.execPath, [resolve("tickets.mjs"), "check"], { cwd, env, encoding: "utf8", timeout: 5_000 });
  assert.equal(output.status, 1);
  assert.match(output.stderr, /no scripts\/agents\/kit\.json/);
});

test("ref loading preserves frontmatter and dependency diagnostics", t => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-errors-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => {
    const output = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
    assert.equal(output.status, 0, output.stderr);
  };
  git("init", "-q");
  const file = "docs/wayfinder/alpha/tickets/01-broken.md";
  mkdirSync(join(cwd, "docs/wayfinder/alpha/tickets"), { recursive: true });
  writeFileSync(join(cwd, file), "---\nstatus: invalid\nblocked_by: [missing]\n---");
  git("add", ".");
  git("-c", "user.name=Kit test", "-c", "user.email=kit@example.com", "commit", "-qm", "bad ticket");
  const loaded = loadTickets("docs/wayfinder", "alpha", { ref: "HEAD", cwd });
  assert.deepEqual(loaded.problems, [{ file, line: 2, message: "Invalid status: invalid" }]);
  assert.deepEqual(resolveTickets(loaded.tickets).problems, [{ file, line: 3, message: "Unknown blocked_by ticket in alpha: missing" }]);
});

test("check validates build feedback logs and names file:line for a bad date, kind, flag or fix", t => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-feedback-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = repoEnv();
  writeSettings(cwd);
  const git = (...args: string[]) => {
    const output = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
    assert.equal(output.status, 0, output.stderr);
  };
  const file = "docs/wayfinder/alpha/build/feedback.md";
  mkdirSync(join(cwd, "docs/wayfinder/alpha/build/tickets"), { recursive: true });
  mkdirSync(join(cwd, "docs/wayfinder/alpha/tickets"), { recursive: true });
  mkdirSync(join(cwd, "docs/wayfinder/beta/tickets"), { recursive: true });
  writeFileSync(join(cwd, "docs/wayfinder/alpha/build/tickets/24-fix.md"), "---\nstatus: open\n---");
  writeFileSync(join(cwd, "docs/wayfinder/alpha/tickets/01-x.md"), "---\nstatus: closed\n---");
  writeFileSync(join(cwd, "docs/wayfinder/beta/tickets/01-ready.md"), "---\nstatus: open\n---");
  const head = "# Feedback: alpha\n\nKinds: …\n\n## Feedback\n\n";
  const good = [
    "- 2026-10-24 · felt-wrong · \"too many buttons\" · after release: no · fix: [24](tickets/24-fix.md)",
    "- 2026-10-23 · fault · save lost text · after release: yes · fix: PR #12",
    "- 2026-10-22 · workflow · asked twice · after release: no · fix: open",
    "- 2026-10-21 · below-bar · grey on grey · after release: no · fix: [01](../tickets/01-x.md)",
  ];
  writeFileSync(join(cwd, file), `${head}### October\n\n${good.join("\n")}\n\n## Notes\n\nfree text\n`);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Kit test", "-c", "user.email=kit@example.com", "commit", "-qm", "feedback");
  const parsed = loadFeedback("docs/wayfinder", { cwd, ref: "HEAD" });
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.entries.map((entry: { line: number; kind: string }) => [entry.line, entry.kind]), [[9, "felt-wrong"], [10, "fault"], [11, "workflow"], [12, "below-bar"]]);

  const script = resolve("tickets.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 5_000 });
  for (const args of [["check"], ["check", "--ref", "HEAD"]]) {
    const output = run(...args);
    assert.equal(output.status, 0, output.stderr);
    assert.equal(output.stdout, "Tickets checked: 3\nFeedback lines checked: 4\n");
  }

  writeFileSync(join(cwd, file), `${head}${[
    "- 2026-02-30 · fault · bad date · after release: no · fix: open",
    "- 2026-10-23 · ugly · bad kind · after release: no · fix: open",
    "- 2026-10-23 · fault · bad flag · after release: maybe · fix: open",
    "- 2026-10-23 · fault · bad fix · after release: no · fix: soon",
    "- 2026-10-23 · fault · missing link · after release: no · fix: [25](tickets/25-gone.md)",
    "- 2026-10-23 · fault · no fields",
    "- 2026-10-23 · fault · missing map ticket · after release: no · fix: [02](../tickets/02-gone.md)",
  ].join("\n")}\n`);
  const bad = run("check");
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  const expected = [
    `${file}:7: Invalid date: 2026-02-30`,
    `${file}:8: Invalid kind: ugly`,
    `${file}:9: Invalid after release: maybe`,
    `${file}:10: Invalid fix: soon (use open, PR #n or [NN](tickets/NN-slug.md))`,
    `${file}:11: Fix link not found: tickets/25-gone.md`,
    `${file}:12: Malformed feedback line`,
    `${file}:13: Fix link not found: ../tickets/02-gone.md`,
  ];
  assert.deepEqual(bad.stderr.trim().split("\n"), expected);
  git("add", ".");
  git("-c", "user.name=Kit test", "-c", "user.email=kit@example.com", "commit", "-qm", "bad feedback");
  const badRef = run("check", "--ref", "HEAD");
  assert.equal(badRef.status, 1);
  assert.deepEqual(badRef.stderr.trim().split("\n"), expected);
  assert.equal(run("frontier").status, 0, "frontier ignores feedback logs");
  assert.deepEqual(parseFeedback("# Feedback\n", file).problems, [{ file, line: 1, message: "Missing ## Feedback heading" }]);
  writeFileSync(join(cwd, file), "# Feedback\n");
  git("add", ".");
  git("-c", "user.name=Kit test", "-c", "user.email=kit@example.com", "commit", "-qm", "no heading");
  for (const args of [["check"], ["check", "--ref", "HEAD"]]) {
    const output = run(...args);
    assert.equal(output.status, 1);
    assert.equal(output.stderr, `${file}:1: Missing ## Feedback heading\n`);
  }
  writeFileSync(join(cwd, file), `${head}- 2026-10-23 · fault · folder link · after release: no · fix: [t](tickets)\n`);
  assert.equal(run("check").stderr, `${file}:7: Fix link not found: tickets\n`, "a folder is not a fix");
});

/** A ticket with a Done when list of three items and the given Done section (heading date `date`, default after the check starts). */
function closedTicket(done: string[], { date = "2026-11-11", status = "closed", doneWhen = ["- First check.", "- Second check.", "- Third check."] } = {}) {
  const sections = ["---", `status: ${status}`, "---", "", "## Goal", "", "Do it.", "", "## Done when", "", ...doneWhen];
  if (done.length) sections.push("", `## Done${date ? ` (${date})` : ""}`, "", ...done);
  return sections.join("\n");
}
const doneProblems = (source: string) => parseTicket(source, "01-x.md", "alpha").ticket.doneProblems as { file: string; line: number; message: string }[];

test("a closed ticket is refused when its Done section says not met, pending or open for a check", () => {
  const source = closedTicket([
    "- Done when 1: met — `kit unit --affected` RESULT: ok",
    "- **Done when 2:** Not met — the spec needs a second browser",
    "- Done when item 3: pending, the lead adds it after the merge",
  ]);
  assert.deepEqual(doneProblems(source), [
    { file: "01-x.md", line: 18, message: 'Closed ticket, but its Done section says "not met": - **Done when 2:** Not met — the spec needs a second browser' },
    { file: "01-x.md", line: 19, message: 'Closed ticket, but its Done section says "pending": - Done when item 3: pending, the lead adds it after the merge' },
  ]);
  // The word "open" counts when it is a check's verdict, and "Not met" or "Pending" count as the start of a list item.
  assert.match(doneProblems(closedTicket(["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: open"]))[0].message, /says "open"/);
  assert.match(doneProblems(closedTicket(["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c", "- Pending, for the lead after merge: the score"]))[0].message, /says "pending"/);
  assert.match(doneProblems(closedTicket(["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c", "1. not met: the size check"]))[0].message, /says "not met"/);
});

test("words that only look like a verdict are left alone: a note that starts with Open, a wrapped line, a ticket that is not closed", () => {
  const met = ["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c"];
  assert.deepEqual(doneProblems(closedTicket([...met, "- Open: redo re-creates the files later.", "- Open for Lex: which colour.", "- Opening the file now works.",
    "- The save is shown while the copy is", "pending load, then it settles.", "  pending commands end on reload.", "", "### Follow-ups", "", "- Not part of this slice."])), []);
  assert.deepEqual(doneProblems(closedTicket(["- Done when 1: pending", "- Done when 2: not met"], { status: "open" })), []);
  // Only the last Done section counts, and a heading `## Done when` is not one.
  const earlier = `${closedTicket(["- Done when 1: pending"])}\n\n## Done (2026-11-12)\n\n${met.join("\n")}\n`;
  assert.deepEqual(doneProblems(earlier), []);
});

test("a closed ticket needs an evidence line for every Done when item", () => {
  const met = (n: number, text = "`kit unit --affected` RESULT: ok") => `- Done when ${n}: met — ${text}`;
  assert.deepEqual(doneProblems(closedTicket([met(1), met(2), met(3)])), []);
  assert.deepEqual(doneProblems(closedTicket([met(1), met(3)])), [
    { file: "01-x.md", line: 12, message: 'Closed ticket: Done when item 2 has no evidence line in its Done section (write "Done when 2: met — <evidence>")' },
  ]);
  // A verdict with no proof after it, or a line that gives no verdict, is not evidence.
  for (const line of ["- Done when 2: met", "- Done when 2: met —", "- Done when 2: met — ", "- Done when 2: it works", "- Done when 2:"]) {
    assert.equal(doneProblems(closedTicket([met(1), line, met(3)])).length, 1, line);
  }
  // Bold, numbering, "item" and the separators people type are all fine.
  assert.deepEqual(doneProblems(closedTicket(["1. **Done when 1:** met - RESULT: ok", "* Done when item 2: Met (PR #84)", "Done when #3: met: tests/a.test.ts"])), []);
  // A numbered Done when list and a wrapped item count once each.
  const numbered = closedTicket([met(1), met(2)], { doneWhen: ["1. First check", "   continues here.", "2. Second check"] });
  assert.deepEqual(doneProblems(numbered), []);
  // Each item names its own line in the ticket.
  const none = closedTicket(["Everything works."]);
  assert.deepEqual(doneProblems(none).map(problem => problem.line), [11, 12, 13]);
  // A ticket with no Done section was written before the check (or closed by hand with a Resolution) and is left alone.
  assert.deepEqual(doneProblems(closedTicket([])), []);
  // Nothing to prove without a Done when list.
  assert.deepEqual(doneProblems("---\nstatus: closed\n---\n\n## Resolution\n\nDecided.\n"), []);
  assert.deepEqual(doneProblems(closedTicket([], { status: "open" })), []);
});

test("tickets closed before the check started keep their old Done sections", () => {
  const prose = ["Everything works.", "- Pending, for the lead after merge: the score."];
  assert.equal(doneProblems(closedTicket(prose, { date: "2026-11-10" })).length, 0);
  assert.equal(doneProblems(closedTicket(prose, { date: "2026-10-31" })).length, 0);
  assert.equal(doneProblems(closedTicket(prose, { date: "" })).length, 0, "an undated heading is an old ticket");
  // A heading with more than the date after "Done" still has its date read.
  const heading = (text: string) => closedTicket(prose).replace("## Done (2026-11-11)", text);
  for (const [text, count] of [["## Done (2026-10-01, PR #3)", 0], ["## Done — 2026-10-01", 0], ["## Done (2026-11-12, PR #3)", 4], ["## Done: 2026-11-12", 4], ["## Done 2026-11-12", 4], ["## DONE (2026-11-12)", 4], ["## Done when", 0], ["## Done criteria", 0], ["## Done notes", 0]] as const)
    assert.equal(doneProblems(heading(text)).length, count, text);
  assert.equal(doneProblems(closedTicket(prose, { date: "2026-11-11" })).length, 4);
  assert.equal(doneProblems(closedTicket(prose, { date: "2027-01-02" })).length, 4);
});

test("check refuses a closed ticket with file:line, and its other output stays as it was", t => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-done-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = repoEnv();
  assert.equal(spawnSync("git", ["init", "-q"], { cwd, env }).status, 0);
  writeSettings(cwd);
  const dir = join(cwd, "docs/wayfinder/alpha/build/tickets");
  mkdirSync(dir, { recursive: true });
  const good = ["- Done when 1: met — RESULT: ok", "- Done when 2: met — PR #1", "- Done when 3: met — RESULT: ok"];
  writeFileSync(join(dir, "01-good.md"), closedTicket(good));
  writeFileSync(join(dir, "02-old.md"), closedTicket(["Done."], { date: "2026-11-09" }));
  const script = resolve("tickets.mjs");
  const run = () => spawnSync(process.execPath, [script, "check"], { cwd, env, encoding: "utf8", timeout: 5_000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "Tickets checked: 2\n");
  const file = "docs/wayfinder/alpha/build/tickets/03-bad.md";
  writeFileSync(join(cwd, file), closedTicket([good[0], "- Done when 2: pending", good[2]]));
  const bad = run();
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, "");
  assert.equal(bad.stderr, `${file}:18: Closed ticket, but its Done section says "pending": - Done when 2: pending\n`);
  // The same ticket reopened passes, and frontier still lists nothing for a closed one.
  writeFileSync(join(cwd, file), closedTicket([good[0], "- Done when 2: pending", good[2]], { status: "open" }));
  assert.equal(run().status, 0);
});

test("fenced code in a ticket is never read as a heading, an item or a verdict", () => {
  const fence = ["```", "# run the check", "npm test", "- Pending, a line of a pasted log", "## Done (2026-12-01)", "```"];
  const met = ["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c"];
  assert.deepEqual(doneProblems(closedTicket([...fence, ...met])), []);
  assert.deepEqual(doneProblems(closedTicket([...met, ...fence, "", "~~~", "- Done when 1: not met", "~~~"])), []);
  // A fence inside the Done when list does not cut it short or add an item.
  const list = closedTicket(["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c"], { doneWhen: ["- First check.", "  ```", "  # note", "  ```", "- Second check.", "- Third check."] });
  assert.deepEqual(doneProblems(list), []);
  assert.deepEqual(doneProblems(closedTicket([...fence, met[0], met[2]])).map(problem => problem.message.slice(0, 40)), ["Closed ticket: Done when item 2 has no e"]);
});

test("a heading after the Done section ends it, and a Done-like heading after a dated one does not replace it", () => {
  const met = ["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c"];
  assert.deepEqual(doneProblems(closedTicket([...met, "", "# Notes", "", "- Pending: ask Lex"])), []);
  assert.deepEqual(doneProblems(closedTicket([...met, "", "## Done notes", "", "- Pending: ask Lex"])), []);
  assert.equal(doneProblems(closedTicket(["- Done when 1: pending", ...met.slice(1), "", "## Done criteria", "", "Fine."])).length, 1);
});

const strictProblems = (source: string) => parseTicket(source, "01-x.md", "alpha").ticket.strictDoneProblems as { file: string; line: number; message: string }[];

test("the strict reading has no date cutoff and refuses a missing or undated Done, and the plain one still leaves them", () => {
  const met = ["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c"];
  // An undated Done holding an unmet line: the plain check leaves it, the strict one names the line and the missing date.
  const undated = closedTicket(["- Done when 1: met — a", "- Done when 2: not met — x", met[2]], { date: "" });
  assert.deepEqual(doneProblems(undated), []);
  assert.deepEqual(strictProblems(undated), [
    { file: "01-x.md", line: 15, message: 'Closed ticket: its ## Done has no date (write "## Done (YYYY-MM-DD)")' },
    { file: "01-x.md", line: 18, message: 'Closed ticket, but its Done section says "not met": - Done when 2: not met — x' },
  ]);
  // No Done section at all: one problem, on the Done when heading.
  assert.deepEqual(doneProblems(closedTicket([])), []);
  assert.deepEqual(strictProblems(closedTicket([])), [{ file: "01-x.md", line: 9, message: 'Closed ticket: it has no ## Done section, so no Done when item has an evidence line (write "Done when <n>: met — <evidence>")' }]);
  // An old date does not exempt it, and a good ticket passes both ways.
  assert.equal(strictProblems(closedTicket(["Done."], { date: "2026-10-01" })).length, 3);
  assert.deepEqual(strictProblems(closedTicket(met, { date: "2026-10-01" })), []);
  assert.deepEqual(strictProblems(closedTicket(met)), []);
  // A later Done heading with no date does not hide the dated one: its unmet line is still read, by both readings.
  const followUp = closedTicket(["- Done when 1: met — a", "- Done when 2: pending", met[2], "", "## Done (follow-up)", "", "Later notes."]);
  for (const read of [doneProblems, strictProblems]) assert.deepEqual(read(followUp).map(problem => problem.message.slice(0, 40)), ['Closed ticket, but its Done section says']);
  // Nothing to prove for a ticket that is not closed or lists no checks.
  assert.deepEqual(strictProblems(closedTicket([], { status: "open" })), []);
  assert.deepEqual(strictProblems("---\nstatus: closed\n---\n\n## Resolution\n\nDecided.\n"), []);
});

test("newlyClosed names the tickets that are closed now and were not closed at the merge base, new ones included", t => {
  const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-since-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const env = repoEnv({ GIT_AUTHOR_NAME: "Kit test", GIT_AUTHOR_EMAIL: "kit@example.com", GIT_COMMITTER_NAME: "Kit test", GIT_COMMITTER_EMAIL: "kit@example.com" });
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "-q", "--initial-branch=dev");
  writeSettings(cwd);
  const dir = "docs/wayfinder/alpha/build/tickets";
  mkdirSync(join(cwd, dir), { recursive: true });
  const old = closedTicket(["Done."], { date: "2026-10-01" });
  writeFileSync(join(cwd, `${dir}/01-old.md`), old);
  writeFileSync(join(cwd, `${dir}/02-will-close.md`), closedTicket([], { status: "open" }));
  writeFileSync(join(cwd, `${dir}/03-will-stay-open.md`), closedTicket([], { status: "open" }));
  writeFileSync(join(cwd, `${dir}/06-moves-and-closes.md`), closedTicket([], { status: "open" }));
  git("add", "."); git("commit", "-qm", "base");
  git("switch", "-qc", "feature");
  writeFileSync(join(cwd, `${dir}/01-old.md`), `${old}\n\nA follow-up line.\n`);
  writeFileSync(join(cwd, `${dir}/02-will-close.md`), closedTicket(["- Done when 1: met — a", "- Done when 2: met — b", "- Done when 3: met — c"], { date: "" }));
  writeFileSync(join(cwd, `${dir}/04-new-closed.md`), closedTicket([]));
  writeFileSync(join(cwd, `${dir}/05-new-open.md`), closedTicket([], { status: "open" }));
  // A closed ticket moved to another folder, edited a little, is the same ticket and was closed before.
  mkdirSync(join(cwd, "docs/wayfinder/alpha/tickets"), { recursive: true });
  git("mv", `${dir}/01-old.md`, "docs/wayfinder/alpha/tickets/01-old.md");
  writeFileSync(join(cwd, "docs/wayfinder/alpha/tickets/01-old.md"), `${old}\n\nMoved.\n`);
  // A ticket that was open, moved and closed, is a new close under its new path.
  git("mv", `${dir}/06-moves-and-closes.md`, "docs/wayfinder/alpha/tickets/06-moves-and-closes.md");
  writeFileSync(join(cwd, "docs/wayfinder/alpha/tickets/06-moves-and-closes.md"), closedTicket([]));
  git("add", "."); git("commit", "-qm", "feature");
  const loaded = loadTickets("docs/wayfinder", undefined, { ref: "HEAD", cwd });
  assert.deepEqual([...newlyClosed(loaded.tickets, "dev", { cwd })].sort(), ["docs/wayfinder/alpha/tickets/06-moves-and-closes.md", `${dir}/02-will-close.md`, `${dir}/04-new-closed.md`].sort());
  assert.equal(loaded.tickets.some((ticket: { file: string }) => ticket.file === "docs/wayfinder/alpha/tickets/01-old.md"), true);
  assert.throws(() => newlyClosed(loaded.tickets, "missing-ref", { cwd }), /Invalid ref: missing-ref/);

  const script = resolve("tickets.mjs");
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8", timeout: 5_000 });
  const plain = run("check");
  assert.equal(plain.status, 0, plain.stderr);
  const strict = run("check", "--closed-since", "dev");
  assert.equal(strict.status, 1);
  assert.equal(strict.stdout, "");
  const lines = strict.stderr.trim().split("\n");
  assert.equal(lines.length, 3, strict.stderr);
  assert.ok(lines[0].startsWith(`${dir}/02-will-close.md:15: Closed ticket: its ## Done has no date`), lines[0]);
  assert.ok(lines[1].startsWith(`${dir}/04-new-closed.md:9: Closed ticket: it has no ## Done section`), lines[1]);
  assert.ok(lines[2].startsWith("docs/wayfinder/alpha/tickets/06-moves-and-closes.md:9: Closed ticket: it has no ## Done section"), lines[2]);
  assert.match(run("check", "--closed-since", "missing-ref").stderr, /Invalid ref: missing-ref/);
  assert.equal(run("check", "--closed-since").status, 2);
  assert.equal(run("frontier", "--closed-since", "dev").status, 2);
  assert.equal(run("check", "--ref", "HEAD", "--closed-since", "dev").status, 2, "the two ways of choosing a version do not mix");
  assert.match(run("check", "--closed-since", "dev", "--closed-since", "dev").stderr, /Usage:.*--closed-since <ref>/);
});
