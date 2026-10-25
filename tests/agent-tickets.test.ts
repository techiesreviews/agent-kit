import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { loadFeedback, loadTickets, parseFeedback, parseFiles, parseTicket, resolveTickets } from "../scripts/agents/tickets.mjs";

const fixtures = "tests/fixtures/agent-tickets";

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
  const script = resolve("scripts/agents/tickets.mjs");
  for (const fixture of ["list-forms", "unsupported"]) {
    const cwd = mkdtempSync(join(tmpdir(), "agent-tickets-"));
    try {
      mkdirSync(join(cwd, "docs"));
      symlinkSync(resolve(fixtures, fixture), join(cwd, "docs/wayfinder"), "dir");
      for (const command of ["check", "frontier"]) {
        const result = spawnSync(process.execPath, [script, command], { cwd, encoding: "utf8" });
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
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Kit test", GIT_AUTHOR_EMAIL: "kit@example.com", GIT_COMMITTER_NAME: "Kit test", GIT_COMMITTER_EMAIL: "kit@example.com" };
  const git = (...args: string[]) => {
    const run = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 5_000 });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "-q", "--initial-branch=dev");
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

  const script = resolve("scripts/agents/tickets.mjs");
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
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
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

  const script = resolve("scripts/agents/tickets.mjs");
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
