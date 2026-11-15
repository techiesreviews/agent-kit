// Tickets as Orbit cards for kit next, slice, pr, status and init --issues, when scripts/agents/kit.json says
// "tickets": "orbit". A card a slice builds is copied once into a local brief, .scratch/kit-tickets/<KEY>.md, shaped like
// a ticket file (title, the card's Files and Done when), so the build, review, fix and UX steps read it as they read a
// ticket; only the lead's own kit commands write the board (ORBIT_ROLE=lead), and the agents they start never do.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OrbitError, OrbitSetupProblem, orbitCardKey, orbitClient, orbitLogPath, orbitRedactor, orbitSecrets, readOrbitConfig } from "./orbit-client.mjs";
import { orbitStore, ticketSettings } from "./ticket-store.mjs";
import { kitSliceBranch } from "./kit-lib.mjs";
import { fencedLines } from "./tickets.mjs";

const keyShape = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;
/** True for a card key such as TOOLS-10 (never a path: a ticket file always has a slash or .md). */
export const isCardKey = value => keyShape.test(String(value ?? "").trim());
/** A card's slice names, the same in kit next and kit brief: owner kit-12, job slice-kit-12, branch build/kit-12-<first words of the title>. */
export function cardNaming(card) {
  const owner = String(card.identifier).toLowerCase();
  const words = String(card.title ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");
  return { owner, job: `slice-${owner}`, branch: words ? kitSliceBranch(owner, words) : `build/${owner}` };
}
/** True when the project keeps its tickets on Orbit. */
export const onOrbit = settings => ticketSettings(settings).backend === "orbit";

/** The project's Orbit store from the saved setup; throws OrbitSetupProblem when Orbit is not set up on this computer. */
export function openOrbitTickets({ settings, who, role = process.env.ORBIT_ROLE, env = process.env }) {
  const config = readOrbitConfig(env), secrets = orbitSecrets(config), redact = orbitRedactor(secrets);
  const { project, parent } = ticketSettings(settings);
  const store = orbitStore({ client: orbitClient(config), role, who, logPath: orbitLogPath(env), redact, secrets, defaults: { project, parent } });
  return { store, redact, secrets, project, parent };
}

/** True for a failure of Orbit or of its setup, whose words orbitProblem gives; any other error keeps its own message. */
export const isOrbitFailure = error => error instanceof OrbitError || error instanceof OrbitSetupProblem;

/** One plain line for an Orbit failure: Orbit down, token refused, Cloudflare blocked or a refused change. */
export function orbitProblem(error, redact = orbitRedactor()) {
  if (error instanceof OrbitError || error instanceof OrbitSetupProblem) return redact(String(error.message)).replace(/\s+/g, " ").trim();
  // Anything else stays one plain line: a stack or a system error can quote what it was reading.
  return `stopped on an unexpected error (${error?.code ?? error?.name ?? "unknown"})`;
}

/** Where a card's brief lives in a worktree. */
export const cardBriefPath = (root, key) => join(root, ".scratch/kit-tickets", `${orbitCardKey(key)}.md`);
/** The brief's path as kit commands pass it on (relative to the worktree). */
export const cardBriefArg = key => `.scratch/kit-tickets/${orbitCardKey(key)}.md`;

const oneLine = text => String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

/**
 * What a description says is done: the text under a "## Done when" heading, else the card standard's "Done when:" line (its
 * own text, then the lines under it: plain lines that follow directly and list lines, which may sit after blank lines). It
 * ends at a heading, a "Links:" style line or a plain line after a blank one. Fenced code under the line is skipped; a
 * heading's section is returned whole, fenced examples included (the closing check reads it again and skips them), but
 * one that is only fenced code counts as no heading, and of several filled headings the last is read. Empty when there is none.
 */
export function doneWhen(description) {
  const text = String(description ?? "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n"), fenced = fencedLines(lines);
  // Fenced code is no heading and no "Done when:" line: an example in a code block never stands for the real list.
  // The last filled heading is read, as the closing check reads the last one (and falls back to this list when it is empty).
  const headings = lines.flatMap((line, index) => !fenced[index] && /^## Done when[ \t]*$/.test(line) ? [index] : []);
  for (const heading of headings.reverse()) {
    // Any level-one or level-two heading ends it, as in the closing check (doneProblems).
    const next = lines.findIndex((line, index) => index > heading && !fenced[index] && /^#{1,2} /.test(line));
    const section = lines.slice(heading + 1, next < 0 ? undefined : next);
    // A section that is only fenced code is empty: an example never stands for the real list. Only blank lines are
    // trimmed, so an indented list keeps its first item's indent.
    if (section.some((line, at) => line.trim() && !fenced[heading + 1 + at])) return section.join("\n").replace(/^(?:[ \t]*\n)+|\s+$/g, "");
  }
  const start = lines.findIndex((line, index) => !fenced[index] && /^[*_]*Done when[*_]*:/i.test(line.trim()));
  if (start < 0) return "";
  const found = [/^[*_]*Done when[*_]*:[*_]*(.*)$/i.exec(lines[start].trim())[1].trim()].filter(Boolean);
  let gap = false;
  for (const [at, line] of lines.slice(start + 1).entries()) {
    // Fenced code under the line is an example, never an item; it leaves the blank-line gap as it was.
    if (fenced[start + 1 + at]) continue;
    if (!line.trim()) { gap = true; continue; }
    const listed = /^(?:[-*+]|\d+[.)])\s|^\s/.test(line);
    // A plain line counts when it follows directly; after a blank line only list lines do. A heading or a "Links:" style line ends it.
    if (!listed && (gap || /^#|^[*_]*[A-Za-z][A-Za-z ]{0,30}:/.test(line))) break;
    gap = false;
    found.push(line.trimEnd());
  }
  // An indented list keeps its first item's indent (found holds no blank lines).
  return found.join("\n").trimEnd();
}

/**
 * A card as a ticket file, whatever shape its description has: kit slice, which needed "## Files" for its builder's
 * scope, was cut (TOOLS-235), and a card in the card standard's short shape has none.
 */
export function cardBrief(task, owner = "") {
  return `---\ntitle: ${oneLine(task.title)}\norbit: ${task.identifier}\ntype: task (AFK)\nstatus: open\nassignee: ${oneLine(owner)}\n---\n\n`
    + `Orbit card ${task.identifier}${task.url ? `: ${task.url}` : ""}\n\n${String(task.description).replace(/\r\n?/g, "\n").trim()}\n`;
}

/** The card key a brief names in its frontmatter ("orbit: KEY"), or null for an ordinary ticket file. */
export function briefCardKey(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ""))?.[1] ?? "";
  const key = /^orbit:[ \t]*(\S+)[ \t]*$/m.exec(front)?.[1];
  return key && isCardKey(key) ? key.toUpperCase() : null;
}

/** The card key of a ticket argument: the key itself, or the one a brief file names. */
export function ticketCardKey(root, ticket) {
  if (!ticket) return null;
  if (isCardKey(ticket)) return orbitCardKey(ticket);
  try { return briefCardKey(readFileSync(resolve(root, ticket), "utf8")); } catch { return null; }
}

/**
 * The brief for a card, read only: made from the card when it is not there yet (in `folder`, else the worktree's
 * .scratch/kit-tickets), the saved one when it is. It claims nothing: a lead's `kit brief <KEY>` claims the card
 * (kit slice, which also claimed here, was cut in TOOLS-235).
 */
export async function cardBriefFor({ root, key, settings, who, folder }) {
  const path = folder ? join(folder, `${orbitCardKey(key)}.md`) : cardBriefPath(root, key);
  if (existsSync(path)) return { path, arg: cardBriefArg(key), key: orbitCardKey(key), resumed: true };
  const { store } = openOrbitTickets({ settings, who });
  const task = await store.read(key);
  mkdirSync(folder ?? join(root, ".scratch/kit-tickets"), { recursive: true });
  writeFileSync(path, cardBrief(task));
  return { path, arg: cardBriefArg(key), key: task.identifier };
}

const followupList = name => new RegExp(`^### ${name} follow-ups[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))`, "m");
/** The follow-up lines kept in a card's brief: "### Review follow-ups" and "### UX follow-ups" (both written by the cut kit slice and older kit pr runs). */
export function briefFollowups(text) {
  return ["Review", "UX"].flatMap(name => (followupList(name).exec(String(text ?? ""))?.[1] ?? "").split(/\r?\n/))
    .map(line => line.trimEnd()).filter(line => line.startsWith("- "));
}
/**
 * Closes a landed card: status Done and a dated comment naming the PR and its merge SHA, then its follow-ups (review and UX) as
 * one comment, added once (a rerun adds only what is missing, never the follow-ups twice). The merge already happened, so a failure is
 * returned as words for the caller to show, with the command that closes the card by hand.
 */
export async function closeLandedCard({ settings, key, pr, sha, followups = [], who }) {
  let redact;
  try {
    const opened = openOrbitTickets({ settings, who });
    redact = opened.redact;
    const landing = `Landed in ${pr} (${sha ? `merge commit ${sha}` : "GitHub named no merge commit"})`;
    const lines = [...new Set(followups)];
    const closed = await opened.store.close(key, landing, { followups: lines.length ? `Follow-ups from ${pr}:\n${lines.join("\n")}` : undefined });
    let extra = closed.landingNotAdded ? `; the landing comment was not added (${orbitProblem(closed.landingNotAdded, redact)}): add it with kit ticket note ${key} "${landing}"` : "";
    if (closed.followupsNotAdded) extra += `; its follow-ups were not added (${orbitProblem(closed.followupsNotAdded, redact)}): they are in ${pr}`;
    return { closed: true, line: `card: ${key} Done (${pr})${extra}`, suffix: ` (card ${key} Done)` };
  } catch (error) {
    const why = orbitProblem(error, redact);
    return { closed: false, line: `card: ${key} not closed: ${why}; close it with kit ticket update ${key} --status Done`, suffix: `; card ${key} not closed: ${why}` };
  }
}
