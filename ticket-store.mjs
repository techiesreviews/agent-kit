// The kit's ticket store on Orbit: the card rules and guards every ticket action passes, and the seam later stages use.
// `ticketSettings` says which store a project uses (scripts/agents/kit.json: "tickets": "files"|"orbit", default files,
// and "orbit": { "project": "<KEY>", "parent": "<KEY-n>" }); `orbitStore` is the Orbit side. The markdown side stays in
// tickets.mjs until kit next, slice, pr and status move here in later stages.
import { appendFileSync, chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
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

const dateProblem = value => new OrbitError(`not a date: ${value} (use YYYY-MM-DD, read as Europe/Amsterdam, or a full RFC 3339 time with its offset)`);
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
const tick = /^(?:[\s>]|[-*+](?=\s)|\d+[.)](?=\s))*\[[xX]\]\s+(.*)$/;

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

/** The card keys in the description's "Blocked by:" line. Orbit's public API has no relations, so this line carries them. */
export function blockedBy(description) {
  for (const line of split(description)) {
    const found = blockedLine.exec(line.trim());
    if (found) return found[1].split(/[\s,]+/).filter(word => blockerKey.test(word)).map(word => word.toUpperCase());
  }
  return [];
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

/** The ticked "Scheduled in Radaar" lines as letters and digits only, so markup, spacing and letter case make no difference. */
const ticked = description => String(description ?? "").split(/\r\n|[\n\r\u2028\u2029]/)
  .map(line => (tick.exec(line)?.[1] ?? "").replace(/<[^>]*>/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))
  .filter(text => text.includes("scheduledinradaar"));
const amsterdamToday = () => { const now = zoneParts(Date.now()); return `${now.year}-${now.month}-${now.day}`; };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sameTime = (a, b) => (a && b) ? Date.parse(a) === Date.parse(b) : same(a, b);

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
    if (change.description !== undefined) {
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
    return [...new Set(keys.map(orbitCardKey))];
  };
  const parentId = async value => (await client.task(value)).id;
  const textOnly = (name, text) => { if (!oneLine(text)) throw new OrbitError(`${name} needs some text`); };

  return {
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
      return { ...task, status_name: await statusName(task), blocked_by: blockedBy(task.description), next_lex: nextLexReason(task.description), parent_key };
    },
    comments: key => client.comments(orbitCardKey(key)),
    /** The cards of one board, or of every board the token reaches with project "all". */
    async list({ project, status, parent, assignee, q, limit = 50 }) {
      // A parent's key already names the card, on whichever board it sits; a status name needs one board.
      const everywhere = project?.toLowerCase() === "all" || (project === undefined && parent !== undefined && status === undefined);
      if (everywhere && status !== undefined) throw new OrbitError("--status names differ per board: use it with one --project");
      const board = everywhere ? null : await projectFrom(project);
      const query = { project_id: board?.id, assignee_id: assignee, q, parent_task_id: parent === undefined ? undefined : orbitCardKey(parent) };
      if (status !== undefined) query.status_id = (await statusByName(board.id, status)).id;
      const { items, more } = await client.tasks(query, limit);
      return { more, items: await Promise.all(items.map(async task => ({ ...task, status_name: await statusName(task) }))) };
    },
    async subTasks(key) {
      const { items, more } = await client.tasks({ parent_task_id: orbitCardKey(key) });
      return { more, items: await Promise.all(items.map(async task => ({ ...task, status_name: await statusName(task) }))) };
    },
    async create({ project, title, description, status, priority, parent, noParent, blocked, lexSaid }) {
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
      const text = blocked === undefined ? description : withBlockedBy(description, blockers(blocked));
      if (text !== undefined) body.description = text;
      if (priority !== undefined) body.priority = priority;
      const ownBoard = board.key.toLowerCase() === String(defaults.project ?? "").toLowerCase();
      const ownParent = parent ?? (noParent || !ownBoard ? undefined : defaults.parent ?? undefined);
      if (ownParent) body.parent_task_id = await parentId(ownParent);
      await guard(null, body, board.id, lexSaid);
      if (dryRun) return { action: "create", key: board.key, dry: { method: "POST", path: client.pathOf.tasks, body } };
      const task = await sent({ action: "create", fields: Object.keys(body), lexSaid }, () => client.createTask(body)).catch(error => {
        // No key to read yet, and running create again could make a second card.
        if (error?.noAnswer) throw new OrbitError(`Orbit gave no clear answer, so the new card may or may not have been made: look for it with kit ticket list --q "<its title>" before trying again.`, { status: error.status, code: error.code, noAnswer: true });
        throw error;
      });
      return { key: task.identifier, action: "create", task, fields: Object.keys(body) };
    },
    update(key, { title, description: text, clearDescription, status, priority, parent, blocked, lexSaid }) {
      if (clearDescription && text !== undefined) throw new OrbitError("use --description or --clear-description, not both");
      // A blank text is more often a failed pipe than a wish: wiping a card is asked for by name.
      if (text !== undefined && !text.trim()) throw new OrbitError("that description is blank, so nothing was sent; to empty a card on purpose use --clear-description");
      const description = clearDescription ? "" : text;
      if ([title, description, status, priority, parent, blocked].every(value => value === undefined)) throw new OrbitError("nothing to change: name at least one of --title, --description, --clear-description, --status, --priority, --parent, --blocked-by");
      if (priority !== undefined && !priorities.includes(priority)) throw new OrbitError(`priority must be one of ${priorities.join(", ")}`);
      if (title !== undefined && !oneLine(title)) throw new OrbitError("--title cannot be blank");
      // The fields set outright; a retry stops if someone else changed one of them. A blockers-only change merges.
      const replaces = [title !== undefined && "title", description !== undefined && "description", status !== undefined && "status_id", priority !== undefined && "priority", parent !== undefined && "parent_task_id"].filter(Boolean);
      const keys = blocked === undefined ? undefined : blockers(blocked);
      return changeCard("update", key, async task => {
        const wanted = {};
        if (title !== undefined) wanted.title = oneLine(title);
        if (description !== undefined) wanted.description = description;
        if (keys !== undefined) wanted.description = withBlockedBy(wanted.description ?? task.description, keys);
        if (status !== undefined) wanted.status_id = (await statusByName(task.project_id, status)).id;
        if (priority !== undefined) wanted.priority = priority;
        if (parent !== undefined) wanted.parent_task_id = parent === "none" ? null : await parentId(parent);
        return wanted;
      }, { replaces, lexSaid });
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
    note(key, text) {
      textOnly("a note", text);
      return changeCard("note", key, task => ({ description: withNote(task.description, amsterdamToday(), who, text) }));
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
    nextLex(key, reason) {
      if (!oneLine(reason)) throw new OrbitError("next-lex needs a reason");
      return changeCard("next-lex", key, task => ({ description: withNextLex(task.description, reason) }));
    },
    clearNextLex(key) {
      return changeCard("clear-next-lex", key, task => ({ description: withoutNextLex(task.description) }));
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
}
