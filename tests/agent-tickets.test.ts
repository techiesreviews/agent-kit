import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { loadTickets, parseTicket, resolveTickets } from "../scripts/agents/tickets.mjs";

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
