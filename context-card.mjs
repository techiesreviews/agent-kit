#!/usr/bin/env node
// Usage: context-card.mjs [--cwd DIR] [--hook]; print Lex's notes for this project from ~/Projects/chat/memory/.
// Standalone on purpose: plain Node, no imports from this repo, so any project can call it by absolute path.
// --hook reads a SessionStart payload on stdin (its cwd wins) and prints the card as additionalContext JSON.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINES = 30;
const MAX_WIDTH = 160;
const DECISIONS = 5;
const CORRECTION_DAYS = 14;
const NO_NOTES = "context card: no notes for this project yet";

const home = process.env.HOME || "";
const memory = process.env.CHAT_MEMORY_DIR || join(home, "Projects/chat/memory");

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(path, root) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function tilde(path) {
  return home && within(path, home) ? `~${path.slice(home.length)}` : path;
}

// Rows of the README project map: slug and the first path in the Workspace cell.
function workspaces(readme) {
  const rows = [];
  let header = null;
  for (const line of readme.split("\n")) {
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const cells = line.slice(1, line.trimEnd().endsWith("|") ? line.trimEnd().length - 1 : undefined).split("|").map((cell) => cell.trim());
    if (header === null) {
      header = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    const slug = cells[header.indexOf("slug")];
    const cell = cells[header.indexOf("workspace")];
    const path = cell && /`([~/][^`]*)`/.exec(cell)?.[1];
    if (!slug || !path || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) continue;
    rows.push({ slug, root: real(path === "~" || path.startsWith("~/") ? home + path.slice(1) : path) });
  }
  return rows;
}

// The most specific match wins: the workspace itself or a folder inside it, or a sibling worktree
// named `<workspace>-*` (or a folder inside one). On a tie the workspace beats the worktree, so
// `native-site-editor-starter` keeps its own row instead of counting as a native-site-editor worktree.
function findSlug(readme, cwd) {
  const here = real(cwd);
  let best = null;
  for (const { slug, root } of workspaces(readme)) {
    let length = within(here, root) ? root.length : -1;
    let direct = length >= 0;
    if (!direct) {
      for (let folder = here; dirname(folder) !== folder; folder = dirname(folder)) {
        if (dirname(folder) === dirname(root) && basename(folder).startsWith(`${basename(root)}-`)) {
          length = folder.length;
          break;
        }
      }
    }
    if (length < 0) continue;
    if (!best || length > best.length || (length === best.length && direct && !best.direct)) best = { slug, length, direct };
  }
  return best?.slug ?? null;
}

function sections(note) {
  const found = {};
  let name = null;
  for (const line of note.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      name = heading[1].toLowerCase();
      found[name] = [];
    } else if (name && line.trim()) {
      found[name].push(line.trimEnd());
    }
  }
  return found;
}

function dated(line) {
  return /^-\s+(\d{4}-\d{2}-\d{2})\b/.exec(line)?.[1] ?? "";
}

function corrections(text, now) {
  const since = new Date(now.getTime() - CORRECTION_DAYS * 86_400_000).toISOString().slice(0, 10);
  let count = 0;
  let repeated = 0;
  for (const line of text.split("\n")) {
    const date = dated(line);
    if (!date || date < since) continue;
    count += 1;
    const repeats = /·\s*repeats:\s*([^·]*)/.exec(line)?.[1].trim();
    if (repeats && repeats !== "first") repeated += 1;
  }
  return { count, repeated };
}

function cut(line) {
  return line.length > MAX_WIDTH ? `${line.slice(0, MAX_WIDTH - 1)}…` : line;
}

function card(cwd, now = new Date()) {
  const readmePath = join(memory, "project-notes/README.md");
  if (!existsSync(readmePath)) return [NO_NOTES];
  const slug = findSlug(readFileSync(readmePath, "utf8"), cwd);
  const notePath = slug && join(memory, "project-notes", `${slug}.md`);
  if (!notePath || !existsSync(notePath)) return [NO_NOTES];
  const note = readFileSync(notePath, "utf8");
  const parts = sections(note);
  const title = /^#\s+(.+?)\s*$/m.exec(note)?.[1] ?? slug;
  const updated = /updated (\d{4}-\d{2}-\d{2})/.exec(note)?.[1];
  const body = [`Context card: ${title}${updated ? ` (updated ${updated})` : ""}`];
  const add = (heading, lines) => {
    if (lines?.length) body.push(`${heading}:`, ...lines);
  };
  add("Current thinking", parts["current thinking"]);
  const decisions = (parts["recent decisions"] ?? []).filter(dated);
  // Stable sort: same-day decisions keep the note's order.
  add("Recent decisions", decisions.sort((a, b) => (dated(a) < dated(b) ? 1 : dated(a) > dated(b) ? -1 : 0)).slice(0, DECISIONS));
  add("Open questions", parts["open questions"]);

  const footer = [];
  const correctionsPath = join(memory, "corrections", `${slug}.md`);
  if (existsSync(correctionsPath)) {
    const { count, repeated } = corrections(readFileSync(correctionsPath, "utf8"), now);
    footer.push(`corrections (${CORRECTION_DAYS} days): ${count}, repeated: ${repeated} — ${tilde(correctionsPath)}`);
  }
  footer.push("More: ask for the full note.");
  return [...body.slice(0, MAX_LINES - footer.length), ...footer].map(cut);
}

function main(argv) {
  let cwd = process.cwd();
  let hook = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--hook") hook = true;
    else if (argv[index] === "--cwd" && argv[index + 1]) cwd = argv[++index];
  }
  if (hook) {
    try {
      const payload = JSON.parse(readFileSync(0, "utf8"));
      if (typeof payload?.cwd === "string" && payload.cwd) cwd = payload.cwd;
    } catch {
      // No payload: keep the process working directory.
    }
  }
  let lines;
  try {
    lines = card(cwd);
  } catch {
    lines = [NO_NOTES];
  }
  const text = lines.join("\n");
  if (hook) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } })}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
