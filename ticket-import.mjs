// The last stage of the move to Orbit, per project: `kit ticket import` makes a card for every ticket file,
// `kit ticket parity` checks the cards against the files, and `kit ticket migrate` runs both, tags the repository so the
// files stay readable in git history, and sends one PR that removes the ticket files, sets "tickets": "orbit" and points
// doc links at the cards. Each card's "Imported from: <path> (project <name>)" line names its file, so a second run
// finds the cards it made instead of making new ones. Maps, research notes, ADRs and other docs stay; only the links in
// them that named a ticket file change.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, posix, relative } from "node:path";
import { OrbitError } from "./orbit-client.mjs";
import { blockedBy } from "./ticket-store.mjs";
import { loadTickets, resolveTickets } from "./tickets.mjs";

const importedLine = /^Imported from:[ \t]*(.+?) \(project (.+)\)[ \t]*$/;

/** The project name the "Imported from" lines carry: kit.json's "project", else the folder's name. */
export const importProject = (settings, root) => String(settings?.project ?? basename(root));

/** The file a card was imported from, as { path, project }, or null for a card the import did not make. */
export function importedFrom(description) {
  for (const line of String(description ?? "").split("\n")) {
    const found = importedLine.exec(line.trim());
    if (found) return { path: found[1], project: found[2] };
  }
  return null;
}

/**
 * The board status a ticket's file status maps to, by name first (statusFor): closed is Done, wontfix Cancelled (else
 * Done), an open "task (AFK)" Todo (kit next may start it), and every other open or waiting ticket Backlog, as kit next
 * on files never starts those either.
 */
export function wantedStatus(ticket) {
  if (ticket.status === "closed") return { name: "done", category: "completed" };
  if (ticket.status === "wontfix") return { name: "cancelled", category: "cancelled", fallback: { name: "done", category: "completed" } };
  if (ticket.status === "open" && ticket.type === "task (AFK)") return { name: "todo", category: "unstarted" };
  return { name: "backlog", category: "unstarted" };
}
/** File statuses the board has no own place for, so the card keeps them on a "File status:" line. */
const keptStatuses = new Set(["needs-triage", "needs-info", "ready-for-agent", "ready-for-human"]);

const fence = /^\s{0,3}(```|~~~)/;
/** The frontmatter lines besides title, status and blocked_by, as "Name: value" lines for the card. */
function headerLines(text, ticket) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/), end = lines.findIndex((line, index) => index > 0 && line === "---");
  const out = [];
  const parsed = { type: ticket.type, assignee: ticket.assignee, builder: ticket.builder, group: ticket.group };
  for (let index = 1; index < end; index++) {
    const field = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[index]);
    if (!field) {
      // A list or folded value goes on with its field's line.
      if (out.length && lines[index].trim() && !lines[index].trim().startsWith("#")) out.at(-1).value = `${out.at(-1).value} ${lines[index].trim()}`.trim();
      continue;
    }
    const [, key, raw] = field;
    if (["title", "status", "blocked_by"].includes(key)) { out.push({ key, skip: true }); continue; }
    if (key === "runs_alone") { out.push({ key, value: ticket.runs_alone ? "yes" : "" }); continue; }
    out.push({ key, value: Object.hasOwn(parsed, key) ? parsed[key] : raw.trim() });
  }
  const name = key => `${key[0].toUpperCase()}${key.slice(1).replace(/_/g, " ")}`;
  return out.filter(entry => !entry.skip && !/^(?:|null|~)$/i.test(String(entry.value ?? "").trim())).map(entry => `${name(entry.key)}: ${String(entry.value).replace(/\s*[\r\n]+\s*/g, " ").trim()}`);
}

/** The ticket's text after its frontmatter, without leading blank lines and trailing white space. */
function ticketBody(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n"), end = lines.findIndex((line, index) => index > 0 && line === "---");
  return lines.slice(end + 1).join("\n").replace(/^\s*\n/, "").replace(/^\n+/, "").trimEnd();
}

/**
 * The body without its "## Comments" sections, and their entries as comments, in order: each top-level list item with
 * the lines under it, and any text before the first item as one entry of its own. Every line goes to exactly one side.
 */
export function splitComments(body) {
  const lines = String(body).split("\n"), kept = [], comments = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    if (fence.test(lines[index])) inFence = !inFence;
    if (inFence || lines[index].trim() !== "## Comments") { kept.push(lines[index]); continue; }
    let next = index + 1, sectionFence = false, current = null;
    for (; next < lines.length; next++) {
      const line = lines[next];
      if (!sectionFence && /^#{1,2}\s/.test(line)) break;
      if (fence.test(line)) sectionFence = !sectionFence;
      if (!sectionFence && /^[-*+]\s/.test(line)) { if (current) comments.push(current); current = [line]; }
      else if (current) current.push(line);
      else if (line.trim()) current = [line];
    }
    if (current) comments.push(current);
    while (kept.length && !kept.at(-1).trim()) kept.pop();
    if (next < lines.length && kept.length) kept.push("");
    index = next - 1;
  }
  return { body: kept.join("\n").trimEnd(), comments: comments.map(entry => entry.join("\n").trimEnd()).filter(Boolean) };
}

const scheme = /^[a-z][a-z0-9+.-]*:/i;
/** The repository path a link target names from a file in `folder`, without its #part, or null outside the repo. */
function linkPath(target, folder) {
  if (!target || scheme.test(target) || target.startsWith("#")) return null;
  const plain = target.replace(/[?#].*$/, "");
  if (!plain) return null;
  let path;
  try { path = decodeURI(plain); } catch { path = plain; }
  const resolved = posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(folder, path));
  return resolved.startsWith("../") || resolved === ".." ? null : resolved;
}

/**
 * The text with its links to ticket files pointing at their cards: inline links and link definitions get the card's
 * address, and a ticket path in backticks gets "(Orbit KEY)" after it. `card(path)` gives { key, url } or null. With
 * `rebase`, other relative links get their repository path (a card has no folder to be relative to).
 */
export function rewriteTicketLinks(text, file, card, { rebase = false } = {}) {
  const folder = posix.dirname(file);
  let count = 0;
  const target = original => {
    const path = linkPath(original, folder);
    if (path === null) return original;
    const found = card(path);
    if (found) { count++; return found.url || found.key; }
    if (!rebase) return original;
    const part = /[?#].*$/.exec(original)?.[0] ?? "";
    return path + part;
  };
  const lines = String(text).split("\n");
  let inFence = false;
  const out = lines.map(line => {
    if (fence.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    let next = line.replace(/^(\s{0,3}\[[^\]]+\]:[ \t]*)(<[^>]*>|\S+)/, (_, lead, value) => lead + (value.startsWith("<") ? `<${target(value.slice(1, -1))}>` : target(value)));
    next = next.replace(/(\]\()(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\))/g, (_, open, value, close) => open + (value.startsWith("<") ? `<${target(value.slice(1, -1))}>` : target(value)) + close);
    next = next.replace(/`([^`\s]+\.md)`(?! \(Orbit )/g, (whole, value) => {
      const found = card(linkPath(value, "") ?? "") ?? card(linkPath(value, folder) ?? "");
      if (!found) return whole;
      count++;
      return `${whole} (Orbit ${found.key})`;
    });
    return next;
  });
  return { text: out.join("\n"), count };
}

/** A ticket file read for the import: its card's title, wanted status, header lines, blockers, body and comments. */
export function ticketSource(ticket, text) {
  const { body, comments } = splitComments(ticketBody(text));
  return { path: ticket.file, title: String(ticket.title || ticket.slug).replace(/\s*[\r\n]+\s*/g, " ").trim(), ticket, status: wantedStatus(ticket),
    header: headerLines(text, ticket), blockers: ticket.blocked_by.map(blocker => blocker.slug), body, comments, map: ticket.map };
}

/**
 * The card a ticket becomes: its description (the "Imported from" line, the frontmatter lines, a "Blocked by:" line with
 * the blockers' card keys, then the body with its links rewritten) and its comments. `card(path)` gives the card made
 * for a ticket path, or null when there is none yet; `pathOf(map, slug)` the path of a blocker. A blocker or link whose
 * ticket has no card yet is named in `unresolved`.
 */
export function expectedCard(source, { project, card, pathOf, known = new Set() }) {
  const unresolved = new Set();
  const look = path => {
    const found = card(path);
    if (!found && known.has(path)) unresolved.add(path);
    return found ?? null;
  };
  const keys = source.blockers.map(slug => {
    const path = pathOf(source.map, slug), found = card(path);
    if (found) return found.key;
    unresolved.add(path);
    return `<new card for ${path}>`;
  });
  const header = [`Imported from: ${source.path} (project ${project})`, ...source.header];
  if (keptStatuses.has(source.ticket.status)) header.push(`File status: ${source.ticket.status}`);
  if (keys.length) header.push(`Blocked by: ${keys.join(", ")}`);
  const body = rewriteTicketLinks(source.body, source.path, look, { rebase: true }).text;
  return { title: source.title, status: source.status, description: `${header.join("\n")}${body ? `\n\n${body}` : ""}`, comments: source.comments, blocked: keys, unresolved: [...unresolved] };
}

/** The card lookups for a set of ticket files: by path, and a blocker's path by its map and slug (tickets.mjs's rule). */
function lookups(sources, made, { placeholders = false } = {}) {
  const known = new Set(sources.map(source => source.path));
  const bySlug = new Map(sources.map(source => [`${source.map}/${source.ticket.slug}`, source.path]));
  const card = path => made.get(path) ?? (placeholders && known.has(path) ? { key: `<new card for ${path}>`, url: "" } : null);
  return { known, card, pathOf: (map, slug) => bySlug.get(`${map}/${slug}`) ?? `${map}/${slug}` };
}

/** The project's ticket files (every map's tickets/ and build/tickets/, as the kit's ticket reader finds them). */
export function projectTickets(root, settings) {
  const mapsDir = settings?.maps;
  if (!mapsDir) throw new OrbitError('this project has no "maps" folder in scripts/agents/kit.json, so it has no ticket files to import');
  const folder = join(root, mapsDir);
  if (!existsSync(folder)) return { sources: [] };
  const { tickets, problems } = loadTickets(folder);
  const all = [...problems, ...resolveTickets(tickets).problems];
  if (all.length) throw new OrbitError(`fix the ticket files first: ${all.slice(0, 10).map(problem => `${relative(root, problem.file)}:${problem.line}: ${problem.message}`).join("; ")}${all.length > 10 ? `; and ${all.length - 10} more` : ""}`);
  const sources = tickets.map(ticket => {
    const absolute = ticket.file, path = relative(root, absolute).split("\\").join("/");
    return ticketSource({ ...ticket, file: path }, readFileSync(absolute, "utf8"));
  });
  return { sources };
}

/** The cards an earlier import made for this project, by ticket path; two cards for one path are a problem to fix. */
function importedCards(cards, project) {
  const byPath = new Map(), twice = [];
  for (const card of cards) {
    const from = importedFrom(card.description);
    if (!from || from.project !== project) continue;
    if (byPath.has(from.path)) twice.push(`${from.path} (${byPath.get(from.path).identifier} and ${card.identifier})`);
    else byPath.set(from.path, card);
  }
  return { byPath, twice };
}

const normal = text => String(text ?? "").replace(/\r\n?/g, "\n").trimEnd();
const quoteBlock = text => normal(text).split("\n").map(line => `    | ${line}`);

async function readBoard(store, project) {
  const board = await store.board({ project, limit: 10_000 });
  if (board.more) throw new OrbitError(`board ${board.board} holds more than 10000 cards, so the import cannot be sure it makes no duplicates`);
  return board;
}

async function statusIdFor(store, boardId, wanted) {
  try { return await store.statusOn(boardId, wanted.name, wanted.category); }
  catch (error) { if (!wanted.fallback) throw error; return store.statusOn(boardId, wanted.fallback.name, wanted.fallback.category); }
}

/** True when a card made earlier is not under the named parent yet (the parent card itself never moves under itself). */
const movesUnder = (card, parentCard) => Boolean(parentCard) && card.identifier !== parentCard.identifier && card.parent_task_id !== parentCard.id;

/** The comments still to add: the file's entries the card does not hold yet, counted per text. */
function missingComments(wanted, have) {
  const left = have.map(comment => normal(comment.body));
  return wanted.filter(text => { const index = left.indexOf(normal(text)); if (index < 0) return true; left.splice(index, 1); return false; });
}

/**
 * Makes or brings up to date one card per ticket file, then adds the comments each card is missing. Missing cards are
 * made first, so every card's text can name every other card. A dry run prints every card and comment it would send.
 * Returns the counts.
 */
export async function importTickets({ store, root, settings, project: boardKey, parent, dryRun = false, say = console.log }) {
  const project = importProject(settings, root);
  const { sources } = projectTickets(root, settings);
  const board = await readBoard(store, boardKey);
  // With a parent named (kit ticket migrate --parent), every imported card sits under it, those an earlier import made too.
  // It is read first: a parent Orbit cannot show stops the run before any write.
  const parentCard = parent ? await store.read(parent) : null;
  const { byPath, twice } = importedCards(board.cards, project);
  if (twice.length) throw new OrbitError(`two cards were imported from the same file, so the import stopped: ${twice.join(", ")}; move the extra card to the trash first`);
  const made = new Map([...byPath].map(([path, card]) => [path, { key: card.identifier, url: card.url }]));
  const look = lookups(sources, made, { placeholders: dryRun });
  const counts = { created: 0, updated: 0, unchanged: 0, comments: 0 };
  const statusIds = new Map();
  const statusOf = async wanted => {
    const id = JSON.stringify(wanted);
    if (!statusIds.has(id)) statusIds.set(id, await statusIdFor(store, board.id, wanted));
    return statusIds.get(id);
  };
  // First every missing card, with only its "Imported from" line: then every key is known, and no text is ever
  // sent with a link or blocker that names a card not made yet. A run cut off here is finished by the next one.
  const fresh = new Set();
  for (const source of sources) {
    if (byPath.has(source.path)) continue;
    const status = await statusOf(source.status);
    if (dryRun) {
      const want = expectedCard(source, { project, ...look });
      say(`would create a card from ${source.path}: ${source.title} [${status.name}]`);
      say("  description:", ...quoteBlock(want.description));
    } else {
      const outcome = await store.create({ project: boardKey, title: source.title, description: `Imported from: ${source.path} (project ${project})`, status: status.name });
      made.set(source.path, { key: outcome.key, url: outcome.task?.url });
      fresh.add(source.path);
      say(`created ${outcome.key} from ${source.path}`);
    }
    counts.created++;
  }
  // Then each card's title, status and text, as its file says.
  if (!dryRun) for (const source of sources) {
    const key = made.get(source.path).key;
    const existing = fresh.has(source.path) ? null : byPath.get(source.path);
    const want = expectedCard(source, { project, ...look });
    const status = await statusOf(source.status);
    const change = {};
    if (existing && normal(existing.title) !== want.title) change.title = want.title;
    if (existing && existing.status_id !== status.id) change.status_id = status.id;
    if (existing && movesUnder(existing, parentCard)) change.parent_task_id = parentCard.id;
    if (normal(existing ? existing.description : `Imported from: ${source.path} (project ${project})`) !== normal(want.description)) change.description = want.description;
    if (!Object.keys(change).length) { if (existing) counts.unchanged++; continue; }
    await store.replace(key, change);
    if (existing) { say(`updated ${key} from ${source.path} (${Object.keys(change).join(", ")})`); counts.updated++; }
    else say(`wrote the text of ${key} from ${source.path}`);
  } else for (const source of sources) {
    const existing = byPath.get(source.path);
    if (!existing) continue;
    const want = expectedCard(source, { project, ...look });
    const status = await statusOf(source.status);
    const change = [normal(existing.title) !== want.title && "title", existing.status_id !== status.id && "status_id", movesUnder(existing, parentCard) && "parent_task_id", normal(existing.description) !== normal(want.description) && "description"].filter(Boolean);
    if (!change.length) { counts.unchanged++; continue; }
    say(`would update ${existing.identifier} from ${source.path} (${change.join(", ")})`);
    if (change.includes("description")) say("  description:", ...quoteBlock(want.description));
    counts.updated++;
  }
  for (const source of sources) {
    if (!source.comments.length) continue;
    const existing = byPath.get(source.path);
    const have = existing ? await store.comments(existing.identifier) : [];
    const missing = missingComments(source.comments, have);
    for (const [index, text] of missing.entries()) {
      if (dryRun) say(`would add comment ${index + 1}/${missing.length} to ${existing?.identifier ?? `the new card from ${source.path}`}:`, ...quoteBlock(text));
      else await store.comment(made.get(source.path).key, text);
      counts.comments++;
    }
    if (missing.length && !dryRun) say(`added ${missing.length} comment${missing.length === 1 ? "" : "s"} to ${made.get(source.path).key}`);
  }
  return { ...counts, tickets: sources.length, board: board.board };
}

const clip = text => { const line = String(text ?? ""); return line.length > 100 ? `${line.slice(0, 97)}...` : line; };
/** Where two texts first part, as one plain line. */
function firstDifference(want, have) {
  const a = normal(want).split("\n"), b = normal(have).split("\n");
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if (a[index] !== b[index]) return `line ${index + 1}: file has ${a[index] === undefined ? "nothing" : JSON.stringify(clip(a[index]))}, card has ${b[index] === undefined ? "nothing" : JSON.stringify(clip(b[index]))}`;
  }
  return "";
}

/**
 * Compares the project's ticket files with their cards: one card per file and none extra, and per card its title,
 * status, description (body text and header lines), comments and blockers. Returns every difference as a plain line.
 */
export async function ticketParity({ store, root, settings, project: boardKey }) {
  const project = importProject(settings, root);
  const { sources } = projectTickets(root, settings);
  const board = await readBoard(store, boardKey);
  const { byPath, twice } = importedCards(board.cards, project);
  const differences = twice.map(entry => `two cards were imported from ${entry}`);
  const look = lookups(sources, new Map([...byPath].map(([path, card]) => [path, { key: card.identifier, url: card.url }])));
  for (const source of sources) {
    const found = byPath.get(source.path);
    if (!found) { differences.push(`${source.path}: no card`); continue; }
    const key = found.identifier, want = expectedCard(source, { project, ...look });
    if (normal(found.title) !== want.title) differences.push(`${key} (${source.path}): title is ${JSON.stringify(clip(found.title))}, file says ${JSON.stringify(clip(want.title))}`);
    const status = await statusIdFor(store, board.id, source.status);
    if (found.status_id !== status.id) differences.push(`${key} (${source.path}): status is ${found.status_name}, file says ${status.name} (${source.ticket.status})`);
    const blockers = blockedBy(found.description), wanted = want.blocked;
    if (blockers.join(",") !== wanted.join(",")) differences.push(`${key} (${source.path}): blocked by ${blockers.join(", ") || "nothing"}, file says ${wanted.join(", ") || "nothing"}`);
    if (normal(found.description) !== normal(want.description)) differences.push(`${key} (${source.path}): description differs at ${firstDifference(want.description, found.description)}`);
    const have = await store.comments(key);
    const missing = missingComments(want.comments, have), extra = missingComments(have.map(comment => comment.body), want.comments.map(body => ({ body })));
    if (missing.length) differences.push(`${key} (${source.path}): ${missing.length} comment${missing.length === 1 ? "" : "s"} from the file missing on the card (first: ${JSON.stringify(clip(missing[0].split("\n")[0]))})`);
    if (extra.length) differences.push(`${key} (${source.path}): ${extra.length} comment${extra.length === 1 ? "" : "s"} on the card that the file does not have (first: ${JSON.stringify(clip(normal(extra[0]).split("\n")[0]))})`);
    if (!missing.length && !extra.length && have.map(comment => normal(comment.body)).join("\0") !== want.comments.map(normal).join("\0")) differences.push(`${key} (${source.path}): comments are in another order than in the file`);
  }
  const files = new Set(sources.map(source => source.path));
  for (const [path, found] of byPath) if (!files.has(path)) differences.push(`${found.identifier}: imported from ${path}, which is not a ticket file now`);
  return { differences, tickets: sources.length, cards: byPath.size, board: board.board };
}

/** The date in Amsterdam as YYYYMMDD, for the tag name. */
export function amsterdamDay(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Amsterdam", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}`;
}

/** The files the move changes: ticket files gone, kit.json on Orbit, and docs whose ticket links now name the cards. */
export function migrationChanges({ root, sources, cards, project, parent, tracked }) {
  const tickets = new Set(sources.map(source => source.path));
  const card = path => cards.get(path) ?? null;
  const docs = [];
  for (const file of tracked) {
    if (!file.endsWith(".md") || tickets.has(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    const { text: next, count } = rewriteTicketLinks(text, file, card);
    if (count && next !== text) docs.push({ file, text: next, count });
  }
  const settingsFile = join(root, "scripts/agents/kit.json");
  const json = JSON.parse(readFileSync(settingsFile, "utf8"));
  json.tickets = "orbit";
  // The parent card sits on the board: without one for this board, an old parent from another board goes.
  json.orbit = { ...(json.orbit ?? {}), project };
  if (parent) json.orbit.parent = parent;
  else delete json.orbit.parent;
  return { remove: [...tickets], docs, settings: `${JSON.stringify(json, null, 2)}\n` };
}

/**
 * The whole move for one project, in order: checks, import, parity (stops on any difference), the tag (pushed, so the
 * files stay readable from git history), one commit (ticket files removed, kit.json on Orbit, doc links to the cards),
 * then kit pr. It refuses while a ticket is being built: an open AFK ticket with an assignee (kit next's claim) or an
 * imported card In Progress. A dry run checks, prints the import and the changes, and changes nothing.
 */
export async function migrateTickets({ store, root, settings, project: boardKey, parent, moveExisting = false, dryRun = false, say = console.log, runPr, now = new Date() }) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tryGit = (...args) => { try { return git(...args); } catch { return null; } };
  if (settings?.tickets === "orbit") throw new OrbitError('this project is already on Orbit ("tickets": "orbit"), so there is nothing to move');
  if (!boardKey) throw new OrbitError('which board? Add --project <KEY>, or "orbit": { "project": "<KEY>" } to scripts/agents/kit.json');
  const land = settings?.branches?.land ?? "main";
  if (tryGit("fetch", "-q", "origin") === null) throw new OrbitError("git fetch origin failed, so the move did not start");
  const branch = git("branch", "--show-current").trim();
  const fresh = `git switch -c tickets-to-orbit origin/${land}`;
  if (!branch || branch === land) throw new OrbitError(`start from a branch of its own, not ${branch || "a detached HEAD"}: ${fresh}`);
  if (git("status", "--porcelain", "--untracked-files=no").trim()) throw new OrbitError("this checkout has uncommitted changes; commit or remove them first");
  if (git("rev-parse", "HEAD").trim() !== git("rev-parse", `origin/${land}`).trim()) throw new OrbitError(`this branch must be exactly origin/${land}, so the PR holds only the move: ${fresh}`);
  const project = importProject(settings, root);
  const { sources } = projectTickets(root, settings);
  if (!sources.length) throw new OrbitError("this project has no ticket files to move");
  const claimed = sources.filter(source => source.ticket.status === "open" && source.ticket.type === "task (AFK)" && source.ticket.assignee);
  if (claimed.length) throw new OrbitError(`a build is running, so the move waits: ${claimed.map(source => `${source.path} (claimed by ${source.ticket.assignee})`).join(", ")}`);
  const before = await readBoard(store, boardKey);
  const working = before.cards.filter(card => card.stage === "working" && importedFrom(card.description)?.project === project);
  if (working.length) throw new OrbitError(`a build is running, so the move waits: ${working.map(card => `${card.identifier} (${card.status_name}${card.claimed_by ? `, claimed by ${card.claimed_by}` : ""})`).join(", ")}`);

  say(`1. import into ${before.board}${dryRun ? " (dry run)" : ""}`);
  // Cards an earlier import made move only under a parent typed as --parent, never under one kit.json merely names.
  const imported = await importTickets({ store, root, settings, project: boardKey, parent: moveExisting ? parent : undefined, dryRun, say: (...lines) => lines.forEach(line => say(`   ${line}`)) });
  say(`   ${imported.tickets} tickets: ${imported.created} created, ${imported.updated} updated, ${imported.unchanged} unchanged, ${imported.comments} comments added`);
  let cards;
  if (dryRun) {
    say("2. parity: runs after the import (a dry run makes no cards to compare)");
    const { byPath } = importedCards(before.cards, project);
    cards = new Map(sources.map(source => [source.path, byPath.has(source.path) ? { key: byPath.get(source.path).identifier, url: byPath.get(source.path).url } : { key: `<new card for ${source.path}>`, url: "" }]));
  } else {
    const parity = await ticketParity({ store, root, settings, project: boardKey });
    if (parity.differences.length) {
      say(`2. parity: ${parity.differences.length} difference${parity.differences.length === 1 ? "" : "s"}; the move stopped, nothing was tagged or removed`);
      for (const line of parity.differences) say(`   ${line}`);
      return { status: "fail", message: `migrate stopped: parity found ${parity.differences.length} difference${parity.differences.length === 1 ? "" : "s"}` };
    }
    say(`2. parity: clean (${parity.tickets} files, ${parity.cards} cards)`);
    const { byPath } = importedCards((await readBoard(store, boardKey)).cards, project);
    cards = new Map([...byPath].map(([path, card]) => [path, { key: card.identifier, url: card.url }]));
  }

  const head = git("rev-parse", "HEAD").trim();
  const base = `tickets-in-files-${amsterdamDay(now)}`;
  let tag = base;
  for (let round = 2; ; round++) {
    const local = tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`)?.trim();
    const remote = tryGit("ls-remote", "--tags", "origin", `refs/tags/${tag}`)?.trim().split(/\s+/)[0];
    if ((!local || local === head) && (!remote || remote === head)) break;
    tag = `${base}-${round}`;
  }
  const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
  const changes = migrationChanges({ root, sources, cards, project: before.board, parent, tracked });
  const prTitle = `Move the tickets to Orbit board ${before.board}`;
  if (dryRun) {
    say(`3. would tag ${head.slice(0, 7)} as ${tag} and push the tag to origin`);
    say(`4. would commit on ${branch}: remove ${changes.remove.length} ticket files, set "tickets": "orbit" with board ${before.board}${parent ? ` and parent ${parent}` : " and no parent card"} in scripts/agents/kit.json, and point ticket links at the cards in ${changes.docs.length} doc${changes.docs.length === 1 ? "" : "s"}`);
    for (const doc of changes.docs) say(`   ${doc.file}: ${doc.count} link${doc.count === 1 ? "" : "s"}`);
    say(`5. would run: kit pr --title ${JSON.stringify(prTitle)}`);
    return { status: "ok", message: `migrate dry run: ${sources.length} tickets, tag ${tag}, ${changes.docs.length} docs; nothing was changed` };
  }

  if (!tryGit("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) git("tag", tag, head);
  try { git("push", "-q", "origin", `refs/tags/${tag}`); }
  catch { throw new OrbitError(`the tag ${tag} could not be pushed to origin, so the ticket files were not removed; push it by hand (git push origin ${tag}) and run migrate again`); }
  say(`3. tagged ${head.slice(0, 7)} as ${tag} (pushed): the ticket files stay readable with git show ${tag}:<path>`);
  git("rm", "-q", "--", ...changes.remove);
  writeFileSync(join(root, "scripts/agents/kit.json"), changes.settings);
  for (const doc of changes.docs) writeFileSync(join(root, doc.file), doc.text);
  git("add", "--", "scripts/agents/kit.json", ...changes.docs.map(doc => doc.file));
  git("commit", "-q", "-m", prTitle, "-m", `The ${changes.remove.length} ticket files are now cards on Orbit board ${before.board}; the files stay in git history at tag ${tag}. Links in ${changes.docs.length} doc${changes.docs.length === 1 ? "" : "s"} now name the cards.`);
  say(`4. committed on ${branch}: ${changes.remove.length} ticket files removed, "tickets": "orbit", ${changes.docs.length} doc${changes.docs.length === 1 ? "" : "s"} with card links`);
  say(`5. kit pr --title ${JSON.stringify(prTitle)}`);
  const landed = await runPr(["pr", "--title", prTitle]);
  if (!landed) return { status: "fail", message: `migrate: the commit and tag ${tag} are made, but kit pr did not land the move; fix what it says and run kit pr --title ${JSON.stringify(prTitle)}` };
  return { status: "ok", message: `migrate ${sources.length} tickets to ${before.board}, tag ${tag}, landed through kit pr` };
}
