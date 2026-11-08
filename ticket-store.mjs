// The kit's ticket store on Orbit: the card rules and guards every ticket action passes, and the seam kit next, slice,
// pr, status and init --issues use when a project is on Orbit. `ticketSettings` says which store a project uses
// (scripts/agents/kit.json: "tickets": "files"|"orbit", default files, and "orbit": { "project": "<KEY>", "parent":
// "<KEY-n>" }); `orbitStore` is the Orbit side. The markdown side stays in tickets.mjs.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { OrbitError, orbitBringsSecret, orbitCardKey } from "./orbit-client.mjs";

/** The project's ticket store and its Orbit board: { backend, project, parent }. */
export function ticketSettings(settings = {}) {
  return { backend: settings?.tickets === "orbit" ? "orbit" : "files", project: settings?.orbit?.project ?? null, parent: settings?.orbit?.parent ?? null };
}

const zone = "Europe/Amsterdam";
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function zoneParts(ms) {
  const found = Object.fromEntries(parts.formatToParts(new Date(ms)).map(({ type, value }) => [type, value]));
  return { ...found, offset: Date.UTC(+found.year, +found.month - 1, +found.day, +found.hour, +found.minute, +found.second) - Math.floor(ms / 1000) * 1000 };
}
/** The moment a wall-clock time in Amsterdam is. Only used at 00:00 and 23:59, which the 02:00-03:00 clock changes never touch. */
function amsterdamMs(year, month, day, hour, minute) {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - zoneParts(wall).offset;
  return wall - zoneParts(first).offset;
}

const dateProblem = value => new OrbitError(`not a date: ${value} (use YYYY-MM-DD, read as Europe/Amsterdam, or a full time with its offset, like 2026-12-02T09:30:00+01:00)`);
const realDay = (year, month, day) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

/**
 * A date for Orbit, in UTC with milliseconds. YYYY-MM-DD is a whole day in Europe/Amsterdam: a start begins at 00:00 and
 * a due date ends at 23:59, so a card is not late on the day it is due. RFC 3339 times stay the moment they name.
 */
export function orbitDate(value, edge) {
  const text = String(value ?? "").trim();
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (plain) {
    const [year, month, day] = plain.slice(1).map(Number);
    if (!realDay(year, month, day)) throw dateProblem(text);
    return new Date(edge === "start" ? amsterdamMs(year, month, day, 0, 0) : amsterdamMs(year, month, day, 23, 59)).toISOString();
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(text);
  if (!full) throw dateProblem(text);
  const [year, month, day, hour, minute, second] = full.slice(1, 7).map(Number);
  const ms = Date.parse(text);
  if (!realDay(year, month, day) || hour > 23 || minute > 59 || second > 60 || Number.isNaN(ms)) throw dateProblem(text);
  return new Date(ms).toISOString();
}

/** An Orbit time as a person reads it: the plain date when it is that edge of a day in Amsterdam (see orbitDate), else the UTC time. */
export function showDate(iso, edge) {
  if (!iso) return "";
  const when = zoneParts(Date.parse(iso)), minutes = `${when.hour}:${when.minute}`;
  return when.second === "00" && minutes === (edge === "start" ? "00:00" : "23:59") ? `${when.year}-${when.month}-${when.day}` : new Date(iso).toISOString();
}

const oneLine = text => String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();
const nextLexPrefix = "Next step (Lex):";
const blockedLine = /^Blocked by:\s*(.*)$/i;
const plannedLine = /^Planned dates:/i;
const notesHeading = "## Notes";
const isNotesHeading = line => line.trimEnd() === notesHeading;
const tick = /^(?:[\s>]|[-*+](?=\s)|\d+[.)](?=\s))*\[[xX]\](?:\s+(.*))?$/;

const split = text => String(text ?? "").split("\n");
const blockerKey = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;
/** The text without the matching lines and the blank line each leaves behind; every other line stays exactly as it was. */
function dropLines(description, match) {
  const lines = split(description), kept = [];
  for (let index = 0; index < lines.length; index++) {
    if (!match(lines[index].trim())) { kept.push(lines[index]); continue; }
    const blankBefore = !kept.length || kept.at(-1).trim() === "";
    if (blankBefore && lines[index + 1]?.trim() === "") index++;
    else if (index === lines.length - 1 && kept.at(-1)?.trim() === "") kept.pop();
  }
  return kept.join("\n");
}
/** The text with the first matching line replaced and any others taken out; null when no line matches. */
function replaceLine(description, match, line) {
  const lines = split(description), first = lines.findIndex(item => match(item.trim()));
  if (first < 0) return null;
  const before = lines.slice(0, first).join("\n"), after = dropLines(lines.slice(first + 1).join("\n"), match);
  return [...(first ? [before] : []), line, ...(first + 1 < lines.length ? [after] : [])].join("\n");
}

/** The reason in the first description line "Next step (Lex): reason", or null. */
export function nextLexReason(description) {
  const first = String(description ?? "").replace(/^\n+/, "").split("\n", 1)[0];
  return first.startsWith(nextLexPrefix) ? first.slice(nextLexPrefix.length).trim() : null;
}
/** The description without its next-step line. */
export function withoutNextLex(description) {
  const text = String(description ?? "");
  return nextLexReason(text) === null ? text : text.replace(/^\n+/, "").split("\n").slice(1).join("\n").replace(/^\n+/, "");
}
/** The description with "Next step (Lex): reason" as its first line, replacing an old one. */
export function withNextLex(description, reason) {
  const rest = withoutNextLex(description);
  return `${nextLexPrefix} ${oneLine(reason)}${rest ? `\n\n${rest}` : ""}`;
}

/** Every word on the description's "Blocked by:" lines. */
const blockedWords = description => split(description).flatMap(line => blockedLine.exec(line.trim())?.[1].split(/[\s,]+/).filter(Boolean) ?? []);
/** The card keys on the description's "Blocked by:" lines. Orbit's public API has no relations, so these lines carry them. */
export function blockedBy(description) {
  return [...new Set(blockedWords(description).filter(word => blockerKey.test(word)).map(word => word.toUpperCase()))];
}
/** The description with one "Blocked by:" line (in its place, else first after a next-step line), or none for an empty list. */
export function withBlockedBy(description, keys) {
  const isBlocked = line => blockedLine.test(line);
  if (!keys.length) return dropLines(description, isBlocked);
  const line = `Blocked by: ${keys.join(", ")}`;
  const replaced = replaceLine(description, isBlocked, line);
  if (replaced !== null) return replaced;
  const reason = nextLexReason(description), rest = withoutNextLex(description);
  const body = `${line}${rest ? `\n\n${rest}` : ""}`;
  return reason === null ? body : withNextLex(body, reason);
}

const claimedLine = /^Claimed by:\s*(.*)$/i;
/** The owner on the description's "Claimed by:" line (the slice building the card), or null. */
export function claimedBy(description) {
  const line = split(description).map(item => claimedLine.exec(item.trim())).find(Boolean);
  return line ? oneLine(line[1]) || null : null;
}
/** The description with one "Claimed by: owner" line (first after a next-step line), or none for a null owner. */
export function withClaimedBy(description, owner) {
  const rest = dropLines(description, line => claimedLine.test(line));
  if (!owner) return rest;
  const reason = nextLexReason(rest), body = withoutNextLex(rest);
  const claimed = `Claimed by: ${oneLine(owner)}${body ? `\n\n${body}` : ""}`;
  return reason === null ? claimed : withNextLex(claimed, reason);
}

/**
 * Where a card stands for the kit, by its status NAME on the project's board: done (Done, or a completed, cancelled or
 * duplicate status), working (In Progress, or another started status), ready (Todo; on a board without Todo, any
 * unstarted status) or waiting (Backlog and the other unstarted ones). Labels never count: a board that keeps its stage in
 * labels keeps them as they are.
 */
export function cardStage(status, statuses = []) {
  const name = String(status?.name ?? "").trim().toLowerCase(), category = status?.category;
  if (name === "done" || ["completed", "cancelled", "canceled", "duplicate"].includes(category)) return "done";
  if (name === "in progress" || category === "started") return "working";
  const hasTodo = statuses.some(item => String(item.name).trim().toLowerCase() === "todo");
  if (name === "todo" || (!hasTodo && category === "unstarted")) return "ready";
  return "waiting";
}

/** How many lines with text a card's own description may have (the kit's own lines do not count). */
export const cardStandardLines = 12;
const kitLine = line => line.startsWith(nextLexPrefix) || plannedLine.test(line) || blockedLine.test(line) || claimedLine.test(line);
/**
 * The ways a description breaks the Orbit card standard (docs/orbit-card-standard.md): [{ rule, message }], none when it
 * follows it. Lines without text are not counted, and neither are the lines the kit keeps (Next step, Planned dates,
 * Blocked by, Claimed by).
 */
export function cardStandardProblems(description) {
  const own = split(description).map(line => line.trim()).filter(line => line && !kitLine(line));
  const problems = [];
  if (own.length > cardStandardLines) problems.push({ rule: "too-long", message: `The description is ${own.length} lines; the standard allows ${cardStandardLines}. Move history to comments and parts to sub-tasks.` });
  if (own.some(line => /^##\s*Notes\b/i.test(line))) problems.push({ rule: "notes", message: 'The description has a "## Notes" section. Put history in comments, one per event.' });
  if (own.some(line => /^[-*+]\s+\[[ xX]\]/.test(line))) problems.push({ rule: "checklist", message: "The description has a checklist (- [ ] or - [x]). Make each part a sub-task." });
  if (!own.some(line => /^[*_]*Done when:/i.test(line))) problems.push({ rule: "no-done-when", message: 'The description has no "Done when:" line.' });
  return problems;
}

/** The words on the "Blocked by:" lines that are not card keys, which a change of blockers would lose. */
const otherBlockedWords = description => blockedWords(description).filter(word => !blockerKey.test(word));

/**
 * A new description with the lines the kit itself looks after carried over from the old one, unless the new text has its
 * own: the next step, the blockers and (on a dated card, so no date loses its source) the Planned dates line.
 */
function keepingKitLines(text, task) {
  const has = (body, pattern) => split(body).some(line => pattern.test(line.trim()));
  let body = text;
  if (task.due_at && !has(body, plannedLine)) {
    const planned = split(task.description).find(line => plannedLine.test(line.trim()));
    if (planned) body = withPlannedDates(body, planned.trim());
  }
  if (!has(body, blockedLine)) {
    // Carried as written: the line can hold ordinary words as well as card keys.
    const old = split(task.description).filter(line => blockedLine.test(line.trim())).map(line => line.trim());
    if (old.length) {
      // Under the text's own next step, if it has one, which stays the first line.
      const own = nextLexReason(body), rest = withoutNextLex(body);
      body = `${old.join("\n")}${rest ? `\n\n${rest}` : ""}`;
      if (own !== null) body = withNextLex(body, own);
    }
  }
  // The claim of the slice building the card stays until the slice lands or gives it back.
  const owner = claimedBy(task.description);
  if (owner && !has(body, claimedLine)) body = withClaimedBy(body, owner);
  const reason = nextLexReason(task.description);
  return reason !== null && nextLexReason(body) === null ? withNextLex(body, reason) : body;
}

/** The source named on the "Planned dates:" line, without what it replaced; null when there is none. */
function plannedSource(description) {
  const line = split(description).find(item => plannedLine.test(item.trim()));
  return /\(source: (.*?)(?:; before: .*)?\)\s*$/.exec(line ?? "")?.[1] ?? null;
}
/** The description with one "Planned dates:" line, before the notes; a null line takes it out. */
export function withPlannedDates(description, line) {
  const isPlanned = item => plannedLine.test(item);
  if (!line) return dropLines(description, isPlanned);
  const replaced = replaceLine(description, isPlanned, line);
  if (replaced !== null) return replaced;
  if (!String(description ?? "").trim()) return line;
  const lines = split(description), notes = lines.findIndex(isNotesHeading);
  if (notes >= 0) lines.splice(notes, 0, ...(notes && lines[notes - 1].trim() !== "" ? [""] : []), line, "");
  else lines.push(...(lines.at(-1).trim() === "" ? [] : [""]), line);
  return lines.join("\n");
}

/** The description with a dated line added at the end of its Notes section. */
export function withNote(description, date, who, text) {
  const line = `- ${date} (${oneLine(who)}): ${oneLine(text)}`;
  const body = String(description ?? "").replace(/\s+$/, ""), lines = split(body), heading = lines.findIndex(isNotesHeading);
  if (heading < 0) return `${body ? `${body}\n\n` : ""}${notesHeading}\n\n${line}`;
  // The end of the Notes section: before the next heading and the blank lines above it.
  let end = lines.findIndex((item, index) => index > heading && /^#{1,6}\s/.test(item));
  if (end < 0) end = lines.length;
  while (end > heading + 1 && lines[end - 1].trim() === "") end--;
  lines.splice(end, 0, line);
  return lines.join("\n");
}

/**
 * The ticked "Scheduled in Radaar" items as letters and digits only, so markup, spacing and letter case make no difference.
 * The lines that follow a ticked one belong to it, as in Markdown.
 */
function ticked(description) {
  const items = [];
  let open = false;
  for (const line of String(description ?? "").split(/\r\n|[\n\r\u2028\u2029]/)) {
    const found = tick.exec(line), text = line.replace(/^[\s>]+/, "");
    if (found) { items.push(found[1] ?? ""); open = true; }
    // The item runs on until a blank line, a heading, the next list item or one of the kit's own lines.
    else if (open && text && !/^(?:[-*+]|\d+[.)])\s|^#/.test(text) && !plannedLine.test(text) && !blockedLine.test(text)) items[items.length - 1] += ` ${text}`;
    else open = false;
  }
  const entity = (_, hex, decimal) => { const code = hex ? parseInt(hex, 16) : Number(decimal); return code <= 0x10FFFF ? String.fromCodePoint(code) : " "; };
  return items.map(text => text.replace(/&#x([0-9a-f]+);|&#(\d+);/gi, entity).replace(/&\w+;/g, " ").replace(/<[^>]*>/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(text => text.includes("scheduledinradaar"));
}
const amsterdamToday = () => { const now = zoneParts(Date.now()); return `${now.year}-${now.month}-${now.day}`; };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameTime = (a, b) => (a && b) ? Date.parse(a) === Date.parse(b) : same(a, b);

/**
 * What a `kit ticket tidy` folder holds: description.txt (the new description), comments.txt (comments, split by a line
 * with only -----) and subtasks.json (a list of { title, description, assignee }), each one optional. Every problem is
 * found here, before anything is sent.
 */
export function readTidyFolder(folder) {
  const dir = String(folder ?? "");
  let info;
  try { info = statSync(dir); } catch { throw new OrbitError(`the folder ${dir} does not exist`); }
  if (!info.isDirectory()) throw new OrbitError(`${dir} is not a folder`);
  const read = name => {
    try { return readFileSync(join(dir, name), "utf8").replace(/\r\n?/g, "\n"); }
    catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new OrbitError(`cannot read ${name} in ${dir}`);
    }
  };
  const [descriptionText, commentsText, subtasksText] = ["description.txt", "comments.txt", "subtasks.json"].map(read);
  if (descriptionText === undefined && commentsText === undefined && subtasksText === undefined) throw new OrbitError(`${dir} holds none of description.txt, comments.txt or subtasks.json`);
  const found = {};
  if (descriptionText !== undefined) {
    found.description = descriptionText.replace(/\s+$/, "");
    if (!found.description.trim()) throw new OrbitError("description.txt is blank, so nothing was sent; leave the file out to keep the description");
  }
  if (commentsText !== undefined) found.comments = commentsText.split(/^-----[ \t]*$/m).map(text => text.trim()).filter(Boolean);
  if (subtasksText !== undefined) {
    let list;
    try { list = JSON.parse(subtasksText); } catch { throw new OrbitError("subtasks.json cannot be read: it must be a list of { title, description, assignee }"); }
    if (!Array.isArray(list)) throw new OrbitError("subtasks.json must be a list of { title, description, assignee }");
    const titles = new Set();
    found.subtasks = list.map((item, index) => {
      const at = `subtasks.json item ${index + 1}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new OrbitError(`${at} must be { title, description, assignee }`);
      if (typeof item.title !== "string" || !oneLine(item.title)) throw new OrbitError(`${at} needs a title`);
      for (const field of ["description", "assignee"]) {
        if (item[field] !== undefined && item[field] !== null && typeof item[field] !== "string") throw new OrbitError(`${at}: ${field} must be ${field === "assignee" ? "a member's name or id, or null" : "text, or null"}`);
      }
      const title = oneLine(item.title);
      if (titles.has(title)) throw new OrbitError(`subtasks.json lists the title "${title}" twice`);
      titles.add(title);
      return { title, description: item.description ?? undefined, assignee: item.assignee && oneLine(item.assignee) ? oneLine(item.assignee) : undefined };
    });
  }
  return found;
}

const priorities = ["none", "low", "medium", "high", "urgent"];
const words = "needs Lex's exact words";

/**
 * The Orbit ticket store. Reads work for anyone; writes need ORBIT_ROLE=lead, read the latest version first and retry
 * once on a stale version. A dry run reads, passes the same guards, and returns the exact request without sending it.
 * Every send adds one line to the log; a log that cannot be written stops the send.
 */
export function orbitStore({ client, role, who, logPath, redact, secrets = [], dryRun = false, defaults = {} }) {
  const statusCache = new Map();
  const statusesOf = async projectId => {
    // The promise goes in the cache, so cards read at the same time share one request.
    if (!statusCache.has(projectId)) statusCache.set(projectId, client.statuses(projectId));
    return statusCache.get(projectId);
  };
  const statusName = async task => (await statusesOf(task.project_id)).find(status => status.id === task.status_id)?.name ?? task.status_id;
  const statusByName = async (projectId, name) => {
    const list = await statusesOf(projectId), wanted = oneLine(name).toLowerCase();
    const found = list.filter(status => status.name.toLowerCase() === wanted);
    if (found.length !== 1) throw new OrbitError(`no status called ${oneLine(name)} on this board; it has: ${list.map(status => status.name).join(", ")}`);
    return found[0];
  };
  const labelCache = new Map();
  const labelsOf = projectId => {
    // As for statuses: cards read at the same time share one request.
    if (!labelCache.has(projectId)) labelCache.set(projectId, client.labels(projectId));
    return labelCache.get(projectId);
  };
  /** The card's label names, an id Orbit no longer lists shown as it is; a card without labels asks Orbit nothing. */
  const labelNames = async task => {
    if (!task.label_ids?.length) return [];
    const known = await labelsOf(task.project_id);
    return task.label_ids.map(id => known.find(label => label.id === id)?.name ?? id);
  };
  /** Ids for a NAME[,NAME] list on one board. A name Orbit does not list is refused: labels are never made here. */
  const labelIds = async (projectId, value) => {
    const names = String(value).split(",").map(name => oneLine(name)).filter(Boolean);
    if (!names.length) throw new OrbitError("--label needs label names; to take every label off use --clear-labels");
    const known = await labelsOf(projectId);
    const ids = names.map(name => {
      const found = known.filter(label => label.name.toLowerCase() === name.toLowerCase());
      if (found.length !== 1) throw new OrbitError(`no label called ${name} on this board; it has: ${known.map(label => label.name).join(", ") || "none"}`);
      return found[0].id;
    });
    return [...new Set(ids)];
  };
  // The workspace members, read once per run. A failed read is not kept, so the next call asks again.
  let memberRead;
  const membersOf = () => memberRead ??= client.members().catch(error => { memberRead = undefined; throw error; });
  const memberName = member => oneLine(member.display_name ?? "").trim();
  const nameList = members => members.length > 20 ? `${members.slice(0, 20).map(memberName).join(", ")}, … (kit ticket members lists them all)` : members.map(memberName).join(", ") || "none";
  /** Assignee ids for one NAME, ID or none: a name must fit exactly one member (case-insensitive); anything else is refused with the members listed. */
  const assigneeIds = async (value, { anyId = false } = {}) => {
    const wanted = oneLine(value ?? "");
    if (!wanted) throw new OrbitError("--assignee needs a member's name or id, or none to clear it");
    if (wanted.toLowerCase() === "none") return [];
    const members = await membersOf();
    const byId = members.find(member => String(member.user_id).toLowerCase() === wanted.toLowerCase());
    if (byId) return [byId.user_id];
    // A filter may name a person who has left: an id that is no member still asks Orbit.
    if (anyId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wanted)) return [wanted];
    const found = members.filter(member => memberName(member).toLowerCase() === wanted.toLowerCase());
    if (found.length === 1) return [found[0].user_id];
    if (!found.length) throw new OrbitError(`no member called ${wanted}; the members are: ${nameList(members)}`);
    throw new OrbitError(`more than one member called ${wanted}: ${found.map(memberName).join(", ")}; use the id (kit ticket members lists them)`);
  };
  /** The assignees by name; an id that is no member, or a members list that cannot be read, shows the id. */
  const assigneeNames = async task => {
    if (!task.assignee_ids?.length) return [];
    let members = [];
    try { members = await membersOf(); } catch { /* The ids are still true. */ }
    return task.assignee_ids.map(id => { const found = members.find(member => member.user_id === id); return found ? memberName(found) : id; });
  };
  /**
   * The member called exactly Lex (any capitals): { id, name } for exactly one; otherwise { why } and `ids`, the ids of every member so
   * called (`unreadable` when the list cannot be read, so nobody can say who is Lex).
   */
  const lexMember = async () => {
    let members;
    try { members = await membersOf(); } catch (error) { return { ids: [], unreadable: true, why: `Orbit would not list the members (${oneLine(error?.message ?? "no answer").slice(0, 120)})` }; }
    const found = members.filter(member => memberName(member).toLowerCase() === "lex");
    if (found.length === 1) return { id: found[0].user_id, name: memberName(found[0]), ids: [found[0].user_id] };
    return { ids: found.map(member => member.user_id), why: found.length ? "more than one member is called Lex" : "no member is called Lex" };
  };
  const withNames = async task => ({ ...task, status_name: await statusName(task), label_names: await labelNames(task), assignee_names: await assigneeNames(task) });
  const firstOpenStatus = async projectId => {
    const list = [...await statusesOf(projectId)].sort((a, b) => a.position - b.position);
    return list.find(status => status.category === "unstarted") ?? list[0];
  };
  const projectFrom = async value => {
    const wanted = oneLine(value ?? defaults.project);
    if (!wanted) throw new OrbitError(`which board? Add --project <KEY>, or "orbit": { "project": "<KEY>" } to scripts/agents/kit.json${defaults.problem ? ` (${defaults.problem})` : ""}`);
    const projects = await client.projects();
    const found = projects.find(project => project.key.toLowerCase() === wanted.toLowerCase() || project.name.toLowerCase() === wanted.toLowerCase());
    if (!found) throw new OrbitError(`no board ${wanted} for this token; it has: ${projects.map(project => `${project.key} (${project.name})`).join(", ")}`);
    return found;
  };

  const requireLead = () => { if (!dryRun && role !== "lead") throw new OrbitError("only a lead may write to Orbit: set ORBIT_ROLE=lead (helpers only read)"); };
  const checkLog = () => {
    if (dryRun) return;
    try {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      closeSync(openSync(logPath, "a", 0o600));
      chmodSync(logPath, 0o600);
    } catch { throw new OrbitError(`the write log ${logPath} cannot be written, so nothing was sent`); }
  };
  const logLine = ({ card, action, fields, result, lexSaid }) => {
    const said = lexSaid ? ` lex_said=${JSON.stringify(oneLine(lexSaid))}` : "";
    appendFileSync(logPath, `${redact(`${new Date().toISOString()} card=${card} action=${action} fields=${fields.join(",")} who=${oneLine(who)} result=${result}${said}`)}\n`, { mode: 0o600 });
  };
  /** A failure's log line; the failure itself is what gets reported, so a log problem here does not replace it. */
  const logFailure = entry => { try { logLine(entry); } catch { /* The caller reports the failure. */ } };
  /** Sends the change and logs its outcome once; with `retries`, a stale version waits for the retry's outcome. */
  const sent = async (entry, send, { retries = false } = {}) => {
    let answer;
    try { answer = await send(); }
    catch (error) {
      if (!(retries && error?.staleVersion)) logFailure({ ...entry, card: entry.card ?? "new", result: `fail:${error?.code ?? error?.status ?? "error"}` });
      throw error;
    }
    const card = entry.card ?? answer?.identifier;
    try { logLine({ ...entry, card, result: "ok" }); }
    catch { throw new OrbitError(`Orbit saved the change to ${card}, but the write log ${logPath} could not be written; add the line by hand`); }
    return answer;
  };

  /** Refuses a text that brings a secret onto a card; a card that already held such a text can still be edited. */
  const refuseSecrets = (text, before = "") => {
    if (text !== undefined && orbitBringsSecret(text, before, secrets)) throw new OrbitError("that text holds a secret (an Orbit token or the Cloudflare pass), so it was not sent; take it out");
  };
  const needsWords = (lexSaid, what) => {
    if (!oneLine(lexSaid)) throw new OrbitError(`${what} ${words}: add --lex-said "<his exact words>"`);
  };
  /** The two moves only Lex may order: into a Publish status, and ticking "Scheduled in Radaar". */
  const guard = async (before, change, projectId, lexSaid) => {
    refuseSecrets(change.title, before?.title);
    refuseSecrets(change.description, before?.description);
    if (change.status_id && change.status_id !== before?.status_id) {
      const target = (await statusesOf(projectId)).find(status => status.id === change.status_id);
      if (/publish/i.test(target?.name ?? "")) needsWords(lexSaid, `moving a card to ${target.name}`);
    }
    // With stages as labels, putting the Publish label on a card is the same move as the Publish status.
    if (change.label_ids?.length) {
      const known = await labelsOf(projectId);
      const added = change.label_ids.filter(id => !before?.label_ids?.includes(id)).map(id => known.find(label => label.id === id)?.name);
      const publish = added.find(name => /publish/i.test(name ?? ""));
      if (publish) needsWords(lexSaid, `adding the ${publish} label`);
    }
    if (change.description !== undefined) {
      // No date without a source: a Planned dates line this change brings must name one.
      const had = split(before?.description).map(line => line.trim());
      if (split(change.description).some(line => plannedLine.test(line.trim()) && !line.includes("(source:") && !had.includes(line.trim()))) {
        throw new OrbitError("a Planned dates line needs its source: end the line with (source: <where the date comes from>)");
      }
      // Counted per text: a second identical line ticked is a new tick too.
      const old = ticked(before?.description);
      if (ticked(change.description).some(line => { const index = old.indexOf(line); if (index < 0) return true; old.splice(index, 1); return false; })) needsWords(lexSaid, 'ticking "Scheduled in Radaar"');
    }
  };

  /**
   * Runs `attempt` on the latest version, a second time after a stale version and never a third. A write Orbit refused
   * as stale has its log line once the outcome is known: the retry's own, or a failure when the retry stops first.
   */
  async function onLatest(attempt) {
    let refused = null;
    const send = async (entry, call) => {
      refused = null;
      try { return await sent(entry, call, { retries: true }); }
      catch (error) { if (error?.staleVersion) refused = entry; throw error; }
    };
    try {
      for (let round = 1; ; round++) {
        try {
          const outcome = await attempt(send);
          // The retry had nothing left to send: the refused write's line goes in now.
          if (refused) { logFailure({ ...refused, result: "fail:conflict" }); refused = null; }
          return outcome;
        } catch (error) { if (!error?.staleVersion || round === 2) throw error; }
      }
    } catch (error) {
      if (refused) logFailure({ ...refused, result: "fail:conflict" });
      if (error?.staleVersion) throw new OrbitError(`${refused?.card ?? "The card"} changed again while saving, so nothing was saved; read the card and try again`, { status: 409, code: "conflict" });
      throw error;
    }
  }

  /** Runs one change on the latest version: `build` makes the new fields from the card as it is now. */
  async function changeCard(action, rawKey, build, { replaces = [], lexSaid } = {}) {
    const key = orbitCardKey(rawKey);
    requireLead();
    checkLog();
    let first;
    return onLatest(async send => {
      const task = await client.task(key);
      first ??= task;
      for (const field of replaces) {
        if (!same(task[field], first[field])) throw new OrbitError(`someone changed the ${field} of ${task.identifier} while this was saving, so it was not overwritten; read the card and try again`);
      }
      const wanted = await build(task);
      const change = Object.fromEntries(Object.entries(wanted).filter(([field, value]) => !(field.endsWith("_at") ? sameTime(value, task[field]) : same(value, task[field]))));
      const fields = Object.keys(change);
      if (!fields.length) return { key: task.identifier, action, task, unchanged: true };
      await guard(task, change, task.project_id, lexSaid);
      const body = { expected_version: task.version, ...change };
      if (dryRun) return { key: task.identifier, action, task, dry: { method: "PATCH", path: client.pathOf.task(task.identifier), body } };
      const saved = await send({ card: task.identifier, action, fields, lexSaid }, () => client.patchTask(task.identifier, body));
      return { key: saved.identifier, action, fields, task: saved };
    });
  }

  const blockers = value => {
    if (value === "none") return [];
    const keys = String(value).split(/[\s,]+/).filter(Boolean);
    if (!keys.length) throw new OrbitError("--blocked-by needs card keys, or none to clear them");
    // Keys only, not ids: the line is read back by its keys.
    for (const key of keys) if (!blockerKey.test(key)) throw new OrbitError(`not a card key: ${key.slice(0, 40)} (use one like TOOLS-10)`);
    return [...new Set(keys.map(orbitCardKey))];
  };
  const parentId = async value => (await client.task(value)).id;
  const textOnly = (name, text) => { if (!oneLine(text)) throw new OrbitError(`${name} needs some text`); };

  /** The card's status and stage (cardStage) on its own board. */
  const stageOf = async task => {
    const list = await statusesOf(task.project_id), status = list.find(item => item.id === task.status_id);
    return { status: status?.name ?? task.status_id, stage: cardStage(status, list) };
  };
  /** The status a card moves to, by NAME first (In Progress, Done), else the board's first status of that category. */
  const statusFor = async (projectId, name, category) => {
    const list = [...await statusesOf(projectId)].sort((a, b) => a.position - b.position);
    // A Publish status needs Lex's words, so the kit never picks one in place of a missing name.
    const found = list.find(status => status.name.trim().toLowerCase() === name) ?? list.find(status => status.category === category && !/publish/i.test(status.name));
    if (!found) throw new OrbitError(`this board has no ${name} status (it has: ${list.map(status => status.name).join(", ")})`);
    return found;
  };
  /** The blockers of a card that are not done yet, as "KEY (status)"; one this token cannot read counts as not done. */
  const openBlockers = async (task, known = new Map()) => {
    const open = [];
    for (const key of blockedBy(task.description)) {
      let stage = known.get(key);
      if (!stage) {
        try { const card = await client.task(key); stage = await stageOf(card); }
        catch (error) { if (![403, 404].includes(error?.status)) throw error; stage = { status: "not found", stage: "missing" }; }
        known.set(key, stage);
      }
      if (stage.stage !== "done") open.push(`${key} (${stage.status})`);
    }
    return open;
  };

  /** One comment unless the card already has a comment with exactly this text; a dry run says what it would send. */
  async function postComment(identifier, text) {
    const same = comment => String(comment.body ?? "").trim() === text.trim();
    if ((await client.comments(identifier)).some(same)) return { skipped: true };
    if (dryRun) return { dry: { method: "POST", path: client.pathOf.comments(identifier), body: { body: text } } };
    await sent({ card: identifier, action: "comment", fields: ["body"] }, () => client.addComment(identifier, text));
    return { posted: true };
  }

  const api = {
    statusName,
    /** A card with what the kit reads from it: status name, next step and blockers. */
    async read(key) {
      const task = await client.task(orbitCardKey(key));
      let parent_key = null;
      if (task.parent_task_id) {
        // A parent this token cannot read does not hide the card: its id still shows.
        try { parent_key = (await client.task(task.parent_task_id)).identifier; }
        catch (error) { if (![403, 404].includes(error?.status)) throw error; }
      }
      return { ...await withNames(task), stage: (await stageOf(task)).stage, blocked_by: blockedBy(task.description), claimed_by: claimedBy(task.description), next_lex: nextLexReason(task.description), parent_key };
    },
    comments: key => client.comments(orbitCardKey(key)),
    /** The workspace members, as { user_id, display_name }. */
    members: async () => [...await membersOf()],
    /** The cards of one board, or of every board the token reaches with project "all". */
    async list({ project, status, parent, assignee, q, limit = 50 }) {
      // A parent's key already names the card, on whichever board it sits; a status name needs one board.
      const everywhere = project?.toLowerCase() === "all" || (project === undefined && parent !== undefined && status === undefined);
      if (everywhere && status !== undefined) throw new OrbitError("--status names differ per board: use it with one --project");
      // With a parent and no board named, a status name is read on the parent's own board.
      const board = everywhere ? null : project === undefined && parent !== undefined ? { id: (await client.task(orbitCardKey(parent))).project_id } : await projectFrom(project);
      const assigneeId = assignee === undefined || String(assignee).toLowerCase() === "none" ? assignee : (await assigneeIds(assignee, { anyId: true }))[0];
      const query = { project_id: board?.id, assignee_id: assigneeId, q, parent_task_id: parent === undefined ? undefined : orbitCardKey(parent) };
      if (status !== undefined) query.status_id = (await statusByName(board.id, status)).id;
      const { items, more } = await client.tasks(query, limit);
      return { more, items: await Promise.all(items.map(withNames)) };
    },
    /** The label names of one board. */
    async labels(project) {
      const board = await projectFrom(project);
      return { board: board.key, items: await labelsOf(board.id) };
    },
    async subTasks(key) {
      const { items, more } = await client.tasks({ parent_task_id: orbitCardKey(key) });
      return { more, items: await Promise.all(items.map(withNames)) };
    },
    async create({ project, title, description, status, priority, parent, noParent, blocked, label, assignee, lexSaid }) {
      if (!oneLine(title)) throw new OrbitError("a new card needs --title");
      if (priority !== undefined && !priorities.includes(priority)) throw new OrbitError(`priority must be one of ${priorities.join(", ")}`);
      // A blank --parent (an empty variable, say) must not quietly drop the default parent.
      if (parent !== undefined) orbitCardKey(parent);
      // Broken settings hide the project's default parent; a card made without it would be in the wrong place.
      if (defaults.problem && parent === undefined && !noParent) throw new OrbitError(`scripts/agents/kit.json has a problem (${defaults.problem}), so its default parent cannot be read: fix it, or add --parent <KEY> or --no-parent`);
      requireLead();
      checkLog();
      const board = await projectFrom(project);
      const body = { project_id: board.id, status_id: (status === undefined ? await firstOpenStatus(board.id) : await statusByName(board.id, status)).id, title: oneLine(title) };
      if (blocked !== undefined && otherBlockedWords(description).length) throw new OrbitError(`the Blocked by line also says: ${otherBlockedWords(description).join(", ")}; keep it in the text without --blocked-by, so these words are not lost`);
      const text = blocked === undefined ? description : withBlockedBy(description, blockers(blocked));
      if (text !== undefined) body.description = text;
      if (priority !== undefined) body.priority = priority;
      if (label !== undefined) body.label_ids = await labelIds(board.id, label);
      if (assignee !== undefined) body.assignee_ids = await assigneeIds(assignee);
      const ownBoard = board.key.toLowerCase() === String(defaults.project ?? "").toLowerCase();
      const ownParent = parent ?? (noParent || !ownBoard ? undefined : defaults.parent ?? undefined);
      if (ownParent) body.parent_task_id = await parentId(ownParent);
      await guard(null, body, board.id, lexSaid);
      if (dryRun) return { action: "create", key: board.key, dry: { method: "POST", path: client.pathOf.tasks, body }, warnings: cardStandardProblems(body.description) };
      const task = await sent({ action: "create", fields: Object.keys(body), lexSaid }, () => client.createTask(body)).catch(error => {
        // No key to read yet, and running create again could make a second card.
        if (error?.noAnswer) throw new OrbitError(`Orbit gave no clear answer, so the new card may or may not have been made: look for it with kit ticket list --q "<its title>" before trying again.`, { status: error.status, code: error.code, noAnswer: true });
        throw error;
      });
      return { key: task.identifier, action: "create", task, fields: Object.keys(body), warnings: cardStandardProblems(body.description) };
    },
    update(key, { title, description: text, clearDescription, status, priority, parent, blocked, label, clearLabels, assignee, lexSaid }) {
      if (clearLabels && label !== undefined) throw new OrbitError("use --label or --clear-labels, not both");
      if (clearDescription && text !== undefined) throw new OrbitError("use --description or --clear-description, not both");
      // A blank text is more often a failed pipe than a wish: wiping a card is asked for by name.
      if (text !== undefined && !text.trim()) throw new OrbitError("that description is blank, so nothing was sent; to empty a card on purpose use --clear-description (its next step, blockers and dates line stay)");
      const description = clearDescription ? "" : text;
      if ([title, description, status, priority, parent, blocked, label, assignee].every(value => value === undefined) && !clearLabels) throw new OrbitError("nothing to change: name at least one of --assignee, --title, --description, --clear-description, --status, --priority, --parent, --blocked-by, --label, --clear-labels");
      if (priority !== undefined && !priorities.includes(priority)) throw new OrbitError(`priority must be one of ${priorities.join(", ")}`);
      if (title !== undefined && !oneLine(title)) throw new OrbitError("--title cannot be blank");
      // The fields set outright; a retry stops if someone else changed one of them. A blockers-only change merges.
      const replaces = [title !== undefined && "title", description !== undefined && "description", status !== undefined && "status_id", priority !== undefined && "priority", parent !== undefined && "parent_task_id", assignee !== undefined && "assignee_ids", (label !== undefined || clearLabels) && "label_ids"].filter(Boolean);
      const keys = blocked === undefined ? undefined : blockers(blocked);
      // The standard is checked on the text the card will hold, once the kit's own lines are carried over.
      let warnings = [];
      return changeCard("update", key, async task => {
        const wanted = {};
        if (title !== undefined) wanted.title = oneLine(title);
        // --blocked-by none with a new text asks for no Blocked by line at all, so the old one is not carried over.
        const dropping = keys?.length === 0 && description !== undefined;
        if (description !== undefined) wanted.description = keepingKitLines(description, dropping ? { ...task, description: split(task.description).filter(line => !blockedLine.test(line.trim())).join("\n") } : task);
        warnings = description === undefined ? [] : cardStandardProblems(wanted.description);
        if (keys !== undefined) {
          const others = otherBlockedWords(wanted.description ?? task.description);
          if (others.length) throw new OrbitError(`the Blocked by line also says: ${others.join(", ")}; to change that line, give the new text with --description, and add --blocked-by none to drop it`);
          wanted.description = withBlockedBy(wanted.description ?? task.description, keys);
        }
        if (status !== undefined) wanted.status_id = (await statusByName(task.project_id, status)).id;
        if (priority !== undefined) wanted.priority = priority;
        if (clearLabels) wanted.label_ids = [];
        else if (label !== undefined) {
          const ids = await labelIds(task.project_id, label);
          // The same labels in another order are no change.
          wanted.label_ids = same([...ids].sort(), [...(task.label_ids ?? [])].sort()) ? task.label_ids : ids;
        }
        if (parent !== undefined) wanted.parent_task_id = parent === "none" ? null : await parentId(parent);
        if (assignee !== undefined) {
          const ids = await assigneeIds(assignee);
          wanted.assignee_ids = same([...ids].sort(), [...(task.assignee_ids ?? [])].sort()) ? task.assignee_ids : ids;
        }
        return wanted;
      }, { replaces, lexSaid }).then(outcome => ({ ...outcome, warnings }));
    },
    dates(key, { start, due, source, clear }) {
      if (clear && (start !== undefined || due !== undefined)) throw new OrbitError("--clear takes the dates away; use it without --start or --due");
      if (!clear && start === undefined && due === undefined) throw new OrbitError("name a date: --start, --due, or --clear");
      if (!clear && !oneLine(source)) throw new OrbitError('no date without a source: add --source "<where the date comes from>"');
      const newStart = start === undefined ? undefined : orbitDate(start, "start");
      const newDue = due === undefined ? undefined : orbitDate(due, "due");
      return changeCard("dates", key, task => {
        if (clear) return { description: withPlannedDates(task.description, null), due_start_at: null, due_at: null };
        const startAt = newStart ?? task.due_start_at, dueAt = newDue ?? task.due_at;
        if (!dueAt) throw new OrbitError("Orbit needs a due date with a start date: add --due");
        if (startAt && Date.parse(startAt) > Date.parse(dueAt)) throw new OrbitError("the start date is after the due date");
        // A date kept from before keeps the source it had, beside the new one.
        const kept = (newStart === undefined && task.due_start_at) || newDue === undefined;
        const old = kept ? plannedSource(task.description) : null;
        const named = old && old !== oneLine(source) ? `${oneLine(source)}; before: ${old}` : oneLine(source);
        const when = [startAt && `start ${showDate(startAt, "start")}`, `due ${showDate(dueAt, "due")}`].filter(Boolean).join(", ");
        return { description: withPlannedDates(task.description, `Planned dates: ${when} (source: ${named})`), due_start_at: startAt ?? null, due_at: dueAt };
      }, { replaces: [(clear || start !== undefined) && "due_start_at", (clear || due !== undefined) && "due_at"].filter(Boolean) });
    },
    /** A dated comment (the card standard keeps history in comments, never in the description). */
    note(key, text) {
      textOnly("a note", text);
      return api.comment(key, `${amsterdamToday()} ${text.trim()}`);
    },
    async comment(rawKey, text) {
      textOnly("a comment", text);
      refuseSecrets(text);
      const key = orbitCardKey(rawKey);
      requireLead();
      checkLog();
      const task = await client.task(key);
      if (dryRun) return { key: task.identifier, action: "comment", dry: { method: "POST", path: client.pathOf.comments(task.identifier), body: { body: text } } };
      await sent({ card: task.identifier, action: "comment", fields: ["body"] }, () => client.addComment(task.identifier, text));
      return { key: task.identifier, action: "comment", fields: ["body"], task };
    },
    /**
     * Writes the first line, assigns the one member called Lex (with none or several, the line is still written and
     * `assign.note` says why), moves a Backlog or Todo card to In Progress, and posts a comment that starts with @Lex and
     * holds the details (the reason when there are none). A comment the card already has is not posted again.
     */
    async nextLex(key, reason, { comment } = {}) {
      if (!oneLine(reason)) throw new OrbitError("next-lex needs a reason");
      const text = `@Lex ${String(comment ?? "").trim() || oneLine(reason)}`;
      refuseSecrets(text);
      let assign;
      const outcome = await changeCard("next-lex", key, async task => {
        const wanted = { description: withNextLex(task.description, reason) };
        const lex = await lexMember();
        if (lex.id) {
          const ids = task.assignee_ids ?? [];
          wanted.assignee_ids = ids.includes(lex.id) ? ids : [...ids, lex.id];
          assign = { assigned: lex.name };
        } else assign = { note: `could not assign: ${lex.why}; assign in Orbit` };
        // A card that waits for Lex is In Progress; a board without that status keeps the card where it is.
        if (["backlog", "todo"].includes((await statusName(task)).trim().toLowerCase())) {
          const working = (await statusesOf(task.project_id)).find(status => status.name.trim().toLowerCase() === "in progress");
          if (working) wanted.status_id = working.id;
        }
        return wanted;
      });
      const comments = await postComment(outcome.key, text);
      const dries = [outcome.dry, comments.dry].filter(Boolean);
      return { ...outcome, assign, commented: Boolean(comments.posted), commentExisted: Boolean(comments.skipped), ...(dries.length ? { dry: dries[0], dries } : {}), unchanged: Boolean(outcome.unchanged) && !comments.posted && !comments.dry };
    },
    /** Takes the line out and Lex (only that member) off the assignees. */
    async clearNextLex(key) {
      let assign;
      const outcome = await changeCard("clear-next-lex", key, async task => {
        const wanted = { description: withoutNextLex(task.description) };
        const ids = task.assignee_ids ?? [];
        const lex = ids.length ? await lexMember() : null;
        assign = undefined;
        if (lex?.id) {
          if (ids.includes(lex.id)) { wanted.assignee_ids = ids.filter(id => id !== lex.id); assign = { unassigned: lex.name }; }
        } else if (lex?.unreadable) assign = { note: `could not check whether Lex is assigned (${lex.why}); unassign him in Orbit if he is` };
        // With none or several members called Lex, a note only when one of them is on the card.
        else if (lex && lex.ids.some(id => ids.includes(id))) assign = { note: `could not unassign: ${lex.why}; unassign in Orbit` };
        return wanted;
      });
      return { ...outcome, assign };
    },
    /**
     * The cards of the project's board (under its parent card when one is set), each with its stage, blockers, open
     * blockers, claim and next step; `more` when the board holds more than the limit.
     */
    async board({ project, parent, limit = 1000 } = {}) {
      const board = await projectFrom(project);
      const query = { project_id: board.id, parent_task_id: parent ? orbitCardKey(parent) : undefined };
      const { items, more } = await client.tasks(query, limit);
      const known = new Map();
      const cards = [];
      for (const task of items) {
        const { status, stage } = await stageOf(task);
        known.set(task.identifier, { status, stage });
        cards.push({ ...task, status_name: status, stage, blocked_by: blockedBy(task.description), claimed_by: claimedBy(task.description), next_lex: nextLexReason(task.description) });
      }
      for (const card of cards) card.open_blockers = await openBlockers(card, known);
      cards.sort((a, b) => (a.number ?? 0) - (b.number ?? 0) || a.identifier.localeCompare(b.identifier, "en", { numeric: true }));
      return { board: board.key, id: board.id, cards, more };
    },
    /** The board's status for a NAME (Todo, Done), else its first status of that category (statusFor). */
    statusOn: (projectId, name, category) => statusFor(projectId, name, category),
    /**
     * Sets these fields to exactly these values in one write (kit ticket import): unlike update, a new description
     * carries over none of the old card's own lines, so the card holds what its ticket file says and nothing else.
     */
    replace(key, fields) {
      const named = Object.keys(fields);
      return changeCard("import", key, () => ({ ...fields }), { replaces: named });
    },
    /**
     * Claims a card for a slice in one write: status In Progress and a "Claimed by: owner" line. A card the same owner
     * already holds is no change (a resumed slice needs no lead); one held by anyone else, done, waiting for Lex or still
     * blocked is refused. Two claims at once: Orbit takes the first, and the second, read again, is refused as taken.
     */
    async claim(rawKey, owner) {
      const key = orbitCardKey(rawKey), who = oneLine(owner);
      if (!who) throw new OrbitError("a claim needs an owner");
      // A card someone else holds, done, waiting for Lex or blocked: no failure of Orbit's, the card is just not free.
      const taken = message => Object.assign(new OrbitError(message), { taken: true });
      const held = async task => {
        const { status, stage } = await stageOf(task), holder = claimedBy(task.description);
        if (stage === "done") throw taken(`${task.identifier} is already ${status}, so there is nothing to build`);
        if (stage === "working") {
          if (holder === who) return true;
          // In Progress with no claim line, no assignee and no next step is a card that waited for Lex and was given back
          // (next-lex moves it to In Progress, clear-next-lex leaves it there): it is free. A next step still stops it below.
          if (holder || (task.assignee_ids?.length && nextLexReason(task.description) === null)) throw taken(`${task.identifier} is already taken by ${holder ?? "someone"} (${status}), so it was not claimed`);
          return false;
        }
        return false;
      };
      const first = await client.task(key);
      if (await held(first)) return { key: first.identifier, action: "claim", task: first, unchanged: true, previous: null };
      let previous = null;
      const outcome = await changeCard("claim", key, async task => {
        if (await held(task)) return {};
        if (nextLexReason(task.description) !== null) throw taken(`${task.identifier} waits for Lex (Next step (Lex): ${nextLexReason(task.description)}), so it was not claimed`);
        const open = await openBlockers(task);
        if (open.length) throw taken(`${task.identifier} is blocked by ${open.join(", ")}, so it was not claimed`);
        previous = task.status_id;
        return { status_id: (await statusFor(task.project_id, "in progress", "started")).id, description: withClaimedBy(task.description, who) };
      });
      return { ...outcome, previous: outcome.unchanged ? null : previous };
    },
    /** Gives a claim back: the status it had and no "Claimed by" line. A card someone else holds now is left alone. */
    unclaim(key, owner, statusId) {
      return changeCard("unclaim", key, task => claimedBy(task.description) !== oneLine(owner) ? {}
        : { ...(statusId ? { status_id: statusId } : {}), description: withClaimedBy(task.description, null) });
    },
    /**
     * Closes a landed card: status Done and no claim line in one write, then the landing (the PR link and merge SHA) as a
     * dated comment, as the card standard keeps history in comments. A card an older kit closed already holds the text in
     * its description, and one already commented is not commented twice.
     */
    async close(key, text) {
      textOnly("a closing note", text);
      const outcome = await changeCard("close", key, async task => {
        const { stage } = await stageOf(task);
        return {
          ...(stage === "done" ? {} : { status_id: (await statusFor(task.project_id, "done", "completed")).id }),
          description: withClaimedBy(task.description, null),
        };
      });
      const landing = oneLine(text);
      const known = split(outcome.task.description).some(line => line.includes(landing))
        || (await client.comments(outcome.key)).some(item => String(item.body ?? "").includes(landing));
      if (!known) await sent({ card: outcome.key, action: "comment", fields: ["body"] }, () => client.addComment(outcome.key, `${amsterdamToday()} ${landing}`));
      return { ...outcome, unchanged: Boolean(outcome.unchanged) && known };
    },
    /**
     * The cards that break the Orbit card standard (cardStandardProblems): one card by key, a board by project, or every
     * board the token reaches with `all`. Read-only, for any role. { total, more, broken: [{ identifier, title, status, url, rules, problems }] }.
     */
    async check({ key, project, all }) {
      let items, more = false;
      if (key !== undefined) items = [await client.task(orbitCardKey(key))];
      else ({ items, more } = await client.tasks(all ? {} : { project_id: (await projectFrom(project)).id }, 1000));
      const broken = [];
      for (const task of items) {
        const problems = cardStandardProblems(task.description);
        if (problems.length) broken.push({ identifier: task.identifier, title: oneLine(task.title), status: await statusName(task), url: task.url, rules: problems.map(item => item.rule), problems: problems.map(item => item.message) });
      }
      return { total: items.length, more, broken, key: items[0]?.identifier };
    },
    /**
     * Tidies one card from a folder (readTidyFolder): posts the comments (skipping one whose exact text is already a comment),
     * then sets the description (the kit keeps Next step, Planned dates and Blocked by as `update` does), then creates the
     * sub-tasks (skipping a title that is already under the card). Every step skips what is already done, so a run again
     * after a failure finishes the rest and never doubles anything. `step` is told about each step as it happens.
     */
    async tidy(rawKey, { description, comments, subtasks }, { step = () => {} } = {}) {
      const key = orbitCardKey(rawKey);
      requireLead();
      checkLog();
      const card = await client.task(key);
      const board = card.identifier.replace(/-\d+$/, "");
      // Everything that can be refused is refused before the first write.
      for (const text of [description, ...(comments ?? []), ...(subtasks ?? []).flatMap(item => [item.title, item.description])]) refuseSecrets(text);
      for (const item of subtasks ?? []) if (item.assignee) await assigneeIds(item.assignee);
      const done = { key: card.identifier, comments: 0, description: description === undefined ? "absent" : "unchanged", subTasks: 0, warnings: [] };

      if (comments?.length) {
        const known = new Set((await client.comments(card.identifier)).map(item => String(item.body ?? "").trim()));
        for (const [index, text] of comments.entries()) {
          const label = `comment ${index + 1} of ${comments.length}`;
          if (known.has(text)) { step({ message: `Skipped ${label}: the card already has it.` }); continue; }
          known.add(text);
          if (dryRun) {
            step({ message: `Would post ${label}:`, dry: { method: "POST", path: client.pathOf.comments(card.identifier), body: { body: text } } });
            done.comments++;
            continue;
          }
          await sent({ card: card.identifier, action: "comment", fields: ["body"] }, () => client.addComment(card.identifier, text));
          step({ message: `Posted ${label}.` });
          done.comments++;
        }
      }

      if (description !== undefined) {
        const outcome = await api.update(card.identifier, { description });
        done.warnings.push(...outcome.warnings.map(item => ({ where: "the description", message: item.message })));
        if (outcome.unchanged) step({ message: "The description is already as asked." });
        else {
          done.description = "set";
          step({ message: dryRun ? "Would set the description:" : "Set the description.", dry: outcome.dry });
        }
      }

      if (subtasks?.length) {
        const have = new Set((await client.tasks({ parent_task_id: card.identifier })).items.map(item => oneLine(item.title)));
        for (const item of subtasks) {
          if (have.has(item.title)) { step({ message: `Skipped sub-task "${item.title}": it is already under the card.` }); continue; }
          const made = await api.create({ project: board, title: item.title, description: item.description, parent: card.identifier, assignee: item.assignee });
          done.warnings.push(...made.warnings.map(problem => ({ where: `sub-task "${item.title}"`, message: problem.message })));
          step({ message: dryRun ? `Would create sub-task "${item.title}":` : `Created sub-task "${item.title}" (${made.key}).`, dry: made.dry });
          done.subTasks++;
        }
      }
      return done;
    },
    /** Moves a card (and its sub-tasks, as Orbit does) to Orbit's trash. Nothing here can delete a card for good. */
    async trash(rawKey, lexSaid) {
      needsWords(lexSaid, "moving a card to the trash");
      const key = orbitCardKey(rawKey);
      requireLead();
      checkLog();
      return onLatest(async send => {
        const task = await client.task(key);
        const { items } = await client.tasks({ parent_task_id: task.identifier });
        if (dryRun) return { key: task.identifier, action: "trash", subTasks: items.length, dry: { method: "DELETE", path: `${client.pathOf.task(task.identifier)}?expected_version=${task.version}` } };
        await send({ card: task.identifier, action: "trash", fields: ["trash"], lexSaid }, () => client.trashTask(task.identifier, task.version));
        return { key: task.identifier, action: "trash", subTasks: items.length, task };
      });
    },
  };
  return api;
}
