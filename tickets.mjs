#!/usr/bin/env node
// Usage: tickets.mjs frontier [map] | check; inspect wayfinder ticket dependencies.
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const statuses = new Set(["open", "closed", "needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"]);

// Ticket frontmatter uses scalar fields and inline or block lists. Reject
// unsupported dependency syntax rather than silently exposing a false frontier.
function uncomment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote === '"' && char === "\\") { i++; continue; }
    if (quote === "'" && char === "'" && value[i + 1] === "'") { i++; continue; }
    if (char === quote) quote = "";
    else if (!quote && (char === '"' || char === "'") && (i === 0 || /[\s[,]/.test(value[i - 1]))) quote = char;
    else if (!quote && char === "#" && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trim();
  }
  if (quote) throw new Error("Unclosed quote");
  return value.trim();
}

function scalar(value) {
  value = uncomment(value);
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) throw new Error("Unclosed quote");
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function inlineList(value) {
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("blocked_by must be a list");
  const content = value.slice(1, -1).trim();
  const token = /\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,\s[\]{}]+)\s*(,|$)/y;
  const items = [];
  while (token.lastIndex < content.length) {
    const match = token.exec(content);
    if (!match) throw new Error("Malformed blocked_by list");
    const item = scalar(match[1]);
    if (!item) throw new Error("Empty blocked_by slug");
    items.push(item);
  }
  return items;
}

export function parseTicket(source, file, map) {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const problems = [];
  const ticket = { file, map, slug: basename(file, ".md"), title: "", builder: "", status: "", blocked_by: [], lines: {} };
  const problem = (line, message) => problems.push({ file, line, message });
  const end = lines.findIndex((line, i) => i > 0 && line === "---");
  if (lines[0] !== "---" || end < 0) {
    problem(1, "Missing YAML frontmatter");
    return { ticket, problems };
  }
  for (let i = 1; i < end; i++) {
    const field = /^(title|builder|status|blocked_by):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const [, key, raw] = field;
    if (ticket.lines[key]) { problem(i + 1, `Duplicate ${key}`); continue; }
    ticket.lines[key] = i + 1;
    try {
      if (key !== "blocked_by") { ticket[key] = scalar(raw); continue; }
      let value = uncomment(raw);
      if (value.startsWith("[")) {
        while (!value.endsWith("]") && i + 1 < end) value += ` ${uncomment(lines[++i])}`;
        ticket.blocked_by = inlineList(value).map((slug) => ({ slug, line: ticket.lines[key] }));
      } else if (!value) {
        while (i + 1 < end && /^\s+-\s+/.test(lines[i + 1])) {
          i++;
          ticket.blocked_by.push({ slug: scalar(lines[i].replace(/^\s+-\s+/, "")), line: i + 1 });
        }
      } else throw new Error("blocked_by must be a list");
    } catch (error) { problem(ticket.lines[key], error.message); }
  }
  if (!statuses.has(ticket.status)) problem(ticket.lines.status ?? 1, `Invalid status: ${ticket.status || "(missing)"}`);
  return { ticket, problems };
}

export function resolveTickets(tickets) {
  const index = new Map();
  const problems = [];
  for (const ticket of tickets) {
    const key = `${ticket.map}/${ticket.slug}`;
    if (index.has(key)) problems.push({ file: ticket.file, line: 1, message: `Duplicate ticket slug in map: ${ticket.slug}` });
    index.set(key, ticket);
  }
  for (const ticket of tickets) for (const blocker of ticket.blocked_by) {
    if (!index.has(`${ticket.map}/${blocker.slug}`)) problems.push({ file: ticket.file, line: blocker.line, message: `Unknown blocked_by ticket in ${ticket.map}: ${blocker.slug}` });
  }
  const frontier = tickets.filter((ticket) => ticket.status === "open" && ticket.blocked_by.every((blocker) => index.get(`${ticket.map}/${blocker.slug}`)?.status === "closed"));
  frontier.sort((a, b) => a.map.localeCompare(b.map) || a.slug.localeCompare(b.slug, "en", { numeric: true }));
  return { frontier, problems };
}

export function loadTickets(root = "docs/wayfinder", map) {
  const tickets = [];
  const problems = [];
  const maps = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (!map || entry.name === map));
  if (map && !maps.length) throw new Error(`Unknown map: ${map}`);
  for (const entry of maps) for (const folder of ["tickets", "build/tickets"]) {
    const directory = join(root, entry.name, folder);
    let files;
    try { files = readdirSync(directory).filter((file) => file.endsWith(".md")).sort(); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of files) {
      const file = join(directory, name);
      const parsed = parseTicket(readFileSync(file, "utf8"), file, entry.name);
      tickets.push(parsed.ticket);
      problems.push(...parsed.problems);
    }
  }
  return { tickets, problems };
}

function main(args) {
  const [command, map] = args;
  if (!((command === "check" && args.length === 1) || (command === "frontier" && args.length <= 2 && (!map || /^[\w-]+$/.test(map))))) {
    console.error("Usage: tickets.mjs frontier [map] | check");
    process.exitCode = 2;
    return;
  }
  try {
    const loaded = loadTickets("docs/wayfinder", map);
    const resolved = resolveTickets(loaded.tickets);
    const problems = [...loaded.problems, ...resolved.problems];
    for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.message}`);
    if (problems.length) { process.exitCode = 1; return; }
    if (command === "check") console.log(`Tickets checked: ${loaded.tickets.length}`);
    else for (const ticket of resolved.frontier) console.log(`${ticket.file}\t${ticket.builder || "unassigned"}\t${ticket.title || ticket.slug}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (import.meta.main) main(process.argv.slice(2));
