#!/usr/bin/env node
// Usage: tickets.mjs frontier [map] [--ref <ref>] | check [--ref <ref>]; inspect ticket dependencies and build feedback logs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

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
    if (!/^'(?:''|[^'])*'$/.test(value)) throw new Error("Malformed quoted scalar");
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
    items.push(dependencySlug(match[1]));
  }
  return items;
}

function dependencySlug(value) {
  // Plain mappings, nested collections, anchors and tags are not ticket slugs.
  // Quoted strings remain scalars even when they contain YAML punctuation.
  if (!/^["']/.test(value) && (/[:\[\]{},]/.test(value) || /^[&*!>|]/.test(value))) throw new Error("blocked_by items must be scalar ticket slugs");
  const slug = scalar(value);
  if (typeof slug !== "string" || !slug) throw new Error("Empty blocked_by slug");
  return slug;
}

export function parseTicket(source, file, map) {
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const problems = [];
  const ticket = { file, map, slug: basename(file, ".md"), title: "", builder: "", assignee: "", status: "", blocked_by: [], lines: {}, valid: true };
  const problem = (line, message) => { ticket.valid = false; problems.push({ file, line, message }); };
  const end = lines.findIndex((line, i) => i > 0 && line === "---");
  if (lines[0] !== "---" || end < 0) {
    problem(1, "Missing YAML frontmatter");
    return { ticket, problems };
  }
  for (let i = 1; i < end; i++) {
    const field = /^(title|builder|assignee|status|blocked_by):\s*(.*)$/.exec(lines[i]);
    if (!field) continue;
    const [, key, raw] = field;
    if (ticket.lines[key]) { problem(i + 1, `Duplicate ${key}`); continue; }
    ticket.lines[key] = i + 1;
    let errorLine = i + 1;
    try {
      if (key !== "blocked_by") { ticket[key] = scalar(raw); continue; }
      // Consume the entire value through the next top-level field. Comments and
      // blank lines do not end a list; unconsumed nested content is an error.
      const content = [{ raw, line: i + 1 }];
      while (i + 1 < end && !/^[\w-]+:/.test(lines[i + 1])) {
        i++;
        content.push({ raw: lines[i], line: i + 1 });
      }
      let flow;
      let indentation;
      for (const entry of content) {
        errorLine = entry.line;
        const value = uncomment(entry.raw);
        if (!value) continue;
        if (flow !== undefined || value.startsWith("[")) {
          if (ticket.blocked_by.length || (flow !== undefined && flow.endsWith("]"))) throw new Error("Unexpected blocked_by content");
          flow = flow === undefined ? value : `${flow} ${value}`;
          continue;
        }
        const item = /^(\s*)-\s+(.*)$/.exec(entry.raw);
        if (!item || entry.line === ticket.lines[key]) throw new Error("blocked_by must be a list of scalar ticket slugs");
        if (indentation !== undefined && item[1].length !== indentation) throw new Error("Inconsistent blocked_by list indentation");
        indentation = item[1].length;
        ticket.blocked_by.push({ slug: dependencySlug(uncomment(item[2])), line: entry.line });
      }
      if (flow !== undefined) {
        errorLine = ticket.lines[key];
        ticket.blocked_by = inlineList(flow).map((slug) => ({ slug, line: ticket.lines[key] }));
      }
    } catch (error) { problem(errorLine, error.message); }
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
  const frontier = tickets.filter((ticket) => ticket.valid && ticket.status === "open" && ticket.blocked_by.every((blocker) => index.get(`${ticket.map}/${blocker.slug}`)?.status === "closed"));
  frontier.sort((a, b) => a.map.localeCompare(b.map) || a.slug.localeCompare(b.slug, "en", { numeric: true }));
  return { frontier, problems };
}

export function loadTickets(root = "docs/wayfinder", map, { ref, cwd = process.cwd() } = {}) {
  const tickets = [];
  const problems = [];
  let tracked;
  const git = (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (ref !== undefined) {
    root = relative(resolve(cwd), resolve(cwd, root));
    try { tracked = git(["ls-tree", "-r", "--name-only", ref, "--", root]).split("\n").filter(Boolean); }
    catch (error) { throw new Error(`Invalid ref: ${ref} (${String(error.stderr || error.message).trim().split("\n")[0]})`); }
  }
  const maps = tracked
    ? [...new Set(tracked.map(file => file.slice(root.length + 1)).filter(file => file.includes("/")).map(file => file.split("/")[0]))].sort().map(name => ({ name }))
      .filter(entry => !map || entry.name === map)
    : readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && (!map || entry.name === map));
  if (map && !maps.length) throw new Error(`Unknown map: ${map}`);
  for (const entry of maps) for (const folder of ["tickets", "build/tickets"]) {
    const directory = join(root, entry.name, folder);
    let files;
    try {
      files = tracked
        ? tracked.filter(file => file.startsWith(`${directory}/`) && !file.slice(directory.length + 1).includes("/") && file.endsWith(".md"))
          .map(file => basename(file)).sort()
        : readdirSync(directory).filter((file) => file.endsWith(".md")).sort();
    }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of files) {
      const file = join(directory, name);
      const parsed = parseTicket(tracked ? git(["show", `${ref}:${file}`]) : readFileSync(file, "utf8"), file, entry.name);
      tickets.push(parsed.ticket);
      problems.push(...parsed.problems);
    }
  }
  return { tickets, problems };
}

// One feedback log per build: docs/wayfinder/<map>/build/feedback.md, newest first under
// "## Feedback", in the same line shape as the chat project's corrections list.
export const feedbackKinds = {
  "too-much": "too much text or decoration",
  "below-bar": "looks below the bar",
  "felt-wrong": "felt wrong once used",
  fault: "a real fault",
  workflow: "how agents worked",
};
export const feedbackHeading = "## Feedback";
export const feedbackLegend = `Kinds: ${Object.entries(feedbackKinds).map(([kind, meaning]) => `\`${kind}\` ${meaning}`).join(" · ")}. \`after release: yes\` marks a UX problem found on production.`;
const feedbackEntry = /^- (\S+) · (\S+) · (.+) · after release: (\S+) · fix: (.+)$/;

export function feedbackFile(map) { return `docs/wayfinder/${map}/build/feedback.md`; }

export function feedbackLine({ date, kind, afterRelease = false, text, fix = "open" }) {
  return `- ${date} · ${kind} · ${text} · after release: ${afterRelease ? "yes" : "no"} · fix: ${fix}`;
}

export function parseFeedbackLine(line) {
  const match = feedbackEntry.exec(line);
  return match && { date: match[1], kind: match[2], text: match[3], afterRelease: match[4], fix: match[5] };
}

function realDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(+match[1], match[2] - 1, +match[3]));
  return date.toISOString().slice(0, 10) === value;
}

// A fix is "open", "PR #n" or a markdown link whose target exists beside the log.
function fixProblem(fix, file, exists) {
  if (fix === "open" || /^PR #[1-9]\d*$/.test(fix)) return "";
  const link = /^\[[^\]]+\]\(([^()\s]+)\)$/.exec(fix);
  if (!link) return `Invalid fix: ${fix} (use open, PR #n or [NN](tickets/NN-slug.md))`;
  const target = join(dirname(file), link[1]);
  return exists(target) ? "" : `Fix link not found: ${link[1]}`;
}

const isFile = file => { try { return statSync(file).isFile(); } catch { return false; } };

export function parseFeedback(source, file, exists = isFile) {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  const problems = [], entries = [];
  const problem = (line, message) => problems.push({ file, line, message });
  const start = lines.indexOf(feedbackHeading);
  if (start < 0) { problem(1, `Missing ${feedbackHeading} heading`); return { entries, problems }; }
  for (let i = start + 1; i < lines.length && !/^#{1,2} /.test(lines[i]); i++) {
    // Blank lines and ### subheadings (for example a month) may group entries.
    if (!lines[i].trim() || /^#{3,6} /.test(lines[i])) continue;
    const entry = parseFeedbackLine(lines[i]);
    if (!entry) { problem(i + 1, "Malformed feedback line"); continue; }
    entries.push({ ...entry, line: i + 1 });
    if (!realDate(entry.date)) problem(i + 1, `Invalid date: ${entry.date}`);
    if (!Object.hasOwn(feedbackKinds, entry.kind)) problem(i + 1, `Invalid kind: ${entry.kind}`);
    if (!["yes", "no"].includes(entry.afterRelease)) problem(i + 1, `Invalid after release: ${entry.afterRelease}`);
    const fix = fixProblem(entry.fix, file, exists);
    if (fix) problem(i + 1, fix);
  }
  return { entries, problems };
}

export function loadFeedback(root = "docs/wayfinder", { ref, cwd = process.cwd() } = {}) {
  const entries = [], problems = [];
  const git = (args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  let files, read, exists;
  if (ref !== undefined) {
    root = relative(resolve(cwd), resolve(cwd, root));
    const tracked = new Set(git(["ls-tree", "-r", "--name-only", ref, "--", root]).split("\n").filter(Boolean));
    files = [...tracked].filter(file => /^[^/]+\/build\/feedback\.md$/.test(file.slice(root.length + 1))).sort();
    read = file => git(["show", `${ref}:${file}`]);
    exists = file => tracked.has(file);
  } else {
    files = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name, "build/feedback.md")).filter(file => existsSync(file)).sort();
    read = file => readFileSync(file, "utf8");
    exists = isFile;
  }
  for (const file of files) {
    const parsed = parseFeedback(read(file), file, exists);
    entries.push(...parsed.entries.map(entry => ({ ...entry, file })));
    problems.push(...parsed.problems);
  }
  return { files, entries, problems };
}

function main(args) {
  const [command, ...rest] = args;
  let map, ref, invalid = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--ref" && ref === undefined && rest[i + 1] && !rest[i + 1].startsWith("-")) ref = rest[++i];
    else if (command === "frontier" && map === undefined && /^[\w-]+$/.test(arg) && !arg.startsWith("-")) map = arg;
    else invalid = true;
  }
  if (!["check", "frontier"].includes(command) || invalid) {
    console.error("Usage: tickets.mjs frontier [map] [--ref <ref>] | check [--ref <ref>]");
    process.exitCode = 2;
    return;
  }
  try {
    const loaded = loadTickets("docs/wayfinder", map, { ref });
    const resolved = resolveTickets(loaded.tickets);
    const feedback = command === "check" ? loadFeedback("docs/wayfinder", { ref }) : { files: [], entries: [], problems: [] };
    const problems = [...loaded.problems, ...resolved.problems, ...feedback.problems];
    for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.message}`);
    if (problems.length) { process.exitCode = 1; return; }
    if (command === "check") {
      console.log(`Tickets checked: ${loaded.tickets.length}`);
      if (feedback.files.length) console.log(`Feedback lines checked: ${feedback.entries.length}`);
    }
    else for (const ticket of resolved.frontier) console.log(`${ticket.file}\t${ticket.builder || "unassigned"}\t${ticket.title || ticket.slug}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

if (import.meta.main) main(process.argv.slice(2));
