// Tickets as Orbit cards for kit next, slice, pr, status and init --issues, when scripts/agents/kit.json says
// "tickets": "orbit". A card a slice builds is copied once into a local brief, .scratch/kit-tickets/<KEY>.md, shaped like
// a ticket file (title, the card's Files and Done when), so the build, review, fix and UX steps read it as they read a
// ticket; only the lead's own kit commands write the board (ORBIT_ROLE=lead), and the agents they start never do.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OrbitError, OrbitSetupProblem, orbitCardKey, orbitClient, orbitLogPath, orbitRedactor, orbitSecrets, readOrbitConfig } from "./orbit-client.mjs";
import { orbitStore, ticketSettings } from "./ticket-store.mjs";
import { kitSliceBranch } from "./kit-lib.mjs";

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

const hasSection = (text, name) => new RegExp(`^## ${name}[ \\t]*$`, "m").test(String(text ?? ""));
const oneLine = text => String(text ?? "").replace(/\s*[\r\n]+\s*/g, " ").trim();

/**
 * What a description says is done: the text under a "## Done when" heading, else the card standard's "Done when:" line (its
 * own text, then the list lines under it, blank lines between them allowed). It ends at the first line that is not part of
 * the list, such as "Links:". Empty when there is none.
 */
export function doneWhen(description) {
  const text = String(description ?? "").replace(/\r\n?/g, "\n");
  const section = /^## Done when[ \t]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text)?.[1]?.trim();
  if (section) return section;
  const lines = text.split("\n"), start = lines.findIndex(line => /^[*_]*Done when:/i.test(line.trim()));
  if (start < 0) return "";
  const found = [/^[*_]*Done when:[*_]*(.*)$/i.exec(lines[start].trim())[1].trim()].filter(Boolean);
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (!/^(?:[-*+]|\d+[.)])\s|^\s/.test(line)) break;
    found.push(line.trimEnd());
  }
  return found.join("\n").trim();
}

/** True when a card's description has the "## Files" section and a "## Done when" heading or "Done when:" line a slice builds from. */
export const cardBuildable = description => hasSection(description, "Files") && doneWhen(description) !== "";

/** A card as a ticket file; a card without "## Files" and a Done when (heading or line) in its description cannot be built yet. */
export function cardBrief(task, owner = "") {
  if (!cardBuildable(task.description)) {
    throw new OrbitError(`${task.identifier} cannot be built yet: its description needs a "## Files" section and a "Done when:" line (or a "## Done when" section)`);
  }
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
 * The brief for a card in this worktree, made from the card when it is not there yet. With `owner` the card is claimed
 * first (status In Progress, "Claimed by: owner"), and the claim is given back when the brief cannot be written, so a
 * failure never leaves a half-claimed card. A brief already there is a resumed slice: with `owner`, the card is read once
 * to check it is still that owner's (or done); someone else's card stops it, and an Orbit it cannot read lets it go on
 * from the saved brief with a `note` saying so.
 */
export async function cardBriefFor({ root, key, settings, owner, who = owner, folder }) {
  const path = folder ? join(folder, `${orbitCardKey(key)}.md`) : cardBriefPath(root, key);
  if (existsSync(path)) {
    const resumed = { path, arg: cardBriefArg(key), key: orbitCardKey(key), resumed: true };
    if (!owner) return resumed;
    let task, redact;
    try {
      const opened = openOrbitTickets({ settings, who });
      redact = opened.redact;
      task = await opened.store.read(key);
    } catch (error) {
      return { ...resumed, note: `card: ${resumed.key} could not be checked on Orbit (${orbitProblem(error, redact)}); going on from the saved brief` };
    }
    // Its own: the owner now, or the one the brief recorded when it claimed the card.
    let recorded = "";
    try { recorded = /^assignee:[ \t]*(.*?)\s*$/m.exec(readFileSync(path, "utf8"))?.[1] ?? ""; } catch { /* Read above; gone now is no owner. */ }
    const own = [oneLine(owner), recorded].filter(Boolean);
    if (task.stage === "done" || (task.stage === "working" && own.includes(task.claimed_by))) return resumed;
    const holder = task.stage === "working" ? task.claimed_by ?? "nobody" : "nobody";
    throw new OrbitError(`${resumed.key} is now held by ${holder} (${task.status_name}), so this slice's saved brief is stale; remove .scratch/kit-tickets/${resumed.key}.md and .scratch/kit-slice/${resumed.key} to start over`);
  }
  const { store } = openOrbitTickets({ settings, who });
  const task = await store.read(key);
  const text = cardBrief(task, owner);
  const claim = owner ? await store.claim(task.identifier, owner) : null;
  try {
    mkdirSync(folder ?? join(root, ".scratch/kit-tickets"), { recursive: true });
    writeFileSync(path, text);
  } catch (error) {
    let back = "";
    if (claim && !claim.unchanged) {
      try { await store.unclaim(task.identifier, owner, claim.previous); }
      catch (problem) { back = `; giving the claim back failed too (${orbitProblem(problem)}): run kit ticket update ${task.identifier} --status Todo`; }
    }
    throw new OrbitError(`the brief ${path} could not be written (${error?.code ?? "error"}), so ${task.identifier} was not claimed${back}`);
  }
  return { path, arg: cardBriefArg(key), key: task.identifier, claimed: Boolean(claim && !claim.unchanged) };
}

const followupList = name => new RegExp(`^### ${name} follow-ups[ \\t]*\\r?\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))`, "m");
/** The follow-up lines kept in a card's brief: "### Review follow-ups" (kit pr, for a queued PR) and "### UX follow-ups" (kit slice). */
export function briefFollowups(text) {
  return ["Review", "UX"].flatMap(name => (followupList(name).exec(String(text ?? ""))?.[1] ?? "").split(/\r?\n/))
    .map(line => line.trimEnd()).filter(line => line.startsWith("- "));
}
/** The brief with these review follow-ups added at its end under "### Review follow-ups", each line once. */
export function withReviewFollowups(text, lines) {
  const kept = new Set(briefFollowups(text)), missing = [...new Set(lines)].filter(line => !kept.has(line));
  if (!missing.length) return text;
  const list = followupList("Review").exec(text);
  if (!list) return `${String(text).trimEnd()}\n\n### Review follow-ups\n\n${missing.join("\n")}\n`;
  const end = list.index + list[0].trimEnd().length;
  return `${text.slice(0, end)}\n${missing.join("\n")}${text.slice(end)}`;
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
