// Tickets as Orbit cards for kit next, slice, pr, status and init --issues, when scripts/agents/kit.json says
// "tickets": "orbit". A card a slice builds is copied once into a local brief, .scratch/kit-tickets/<KEY>.md, shaped like
// a ticket file (title, the card's Files and Done when), so the build, review, fix and UX steps read it as they read a
// ticket; only the lead's own kit commands write the board (ORBIT_ROLE=lead), and the agents they start never do.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OrbitError, OrbitSetupProblem, orbitCardKey, orbitClient, orbitLogPath, orbitRedactor, orbitSecrets, readOrbitConfig } from "./orbit-client.mjs";
import { orbitStore, ticketSettings } from "./ticket-store.mjs";

const keyShape = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;
/** True for a card key such as TOOLS-10 (never a path: a ticket file always has a slash or .md). */
export const isCardKey = value => keyShape.test(String(value ?? "").trim());
/** True when the project keeps its tickets on Orbit. */
export const onOrbit = settings => ticketSettings(settings).backend === "orbit";

/** The project's Orbit store from the saved setup; throws OrbitSetupProblem when Orbit is not set up on this computer. */
export function openOrbitTickets({ settings, who, role = process.env.ORBIT_ROLE, env = process.env }) {
  const config = readOrbitConfig(env), secrets = orbitSecrets(config), redact = orbitRedactor(secrets);
  const { project, parent } = ticketSettings(settings);
  const store = orbitStore({ client: orbitClient(config), role, who, logPath: orbitLogPath(env), redact, secrets, defaults: { project, parent } });
  return { store, redact, secrets, project, parent };
}

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

/** True when a card's description has the "## Files" and "## Done when" sections a slice builds from. */
export const cardBuildable = description => hasSection(description, "Files") && hasSection(description, "Done when");

/** A card as a ticket file; a card without "## Files" and "## Done when" in its description cannot be built yet. */
export function cardBrief(task, owner = "") {
  if (!cardBuildable(task.description)) {
    throw new OrbitError(`${task.identifier} cannot be built yet: its description needs a "## Files" and a "## Done when" section`);
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
  try { return briefCardKey(readFileSync(join(root, ticket), "utf8")); } catch { return null; }
}

/**
 * The brief for a card in this worktree, made from the card when it is not there yet. With `owner` the card is claimed
 * first (status In Progress, "Claimed by: owner"), and the claim is given back when the brief cannot be written, so a
 * failure never leaves a half-claimed card. A brief already there is a resumed slice: it is used as it is.
 */
export async function cardBriefFor({ root, key, settings, owner, who = owner }) {
  const path = cardBriefPath(root, key);
  if (existsSync(path)) return { path, arg: cardBriefArg(key), key: orbitCardKey(key), resumed: true };
  const { store } = openOrbitTickets({ settings, who });
  const task = await store.read(key);
  const text = cardBrief(task, owner);
  const claim = owner ? await store.claim(task.identifier, owner) : null;
  try {
    mkdirSync(join(root, ".scratch/kit-tickets"), { recursive: true });
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

/** The follow-up lines a slice kept under "### UX follow-ups" in a card's brief. */
export function briefFollowups(text) {
  const list = /^### UX follow-ups[ \t]*\r?\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/m.exec(String(text ?? ""))?.[1] ?? "";
  return list.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.startsWith("- "));
}

/**
 * Closes a landed card: status Done with a note naming the PR and its merge SHA, then its follow-ups (review and UX) as
 * one comment, added once (a rerun on a card already closed adds nothing). The merge already happened, so a failure is
 * returned as words for the caller to show, with the command that closes the card by hand.
 */
export async function closeLandedCard({ settings, key, pr, sha, followups = [], who }) {
  let redact;
  try {
    const opened = openOrbitTickets({ settings, who });
    redact = opened.redact;
    const closed = await opened.store.close(key, `Landed in ${pr} (merge ${sha})`);
    let extra = "";
    const lines = [...new Set(followups)];
    if (lines.length && !closed.unchanged) {
      try { await opened.store.comment(key, `Follow-ups from ${pr}:\n${lines.join("\n")}`); }
      catch (error) { extra = `; its follow-ups were not added (${orbitProblem(error, redact)}): they are in ${pr}`; }
    }
    return { closed: true, line: `card: ${key} Done (${pr})${extra}`, suffix: ` (card ${key} Done)` };
  } catch (error) {
    const why = orbitProblem(error, redact);
    return { closed: false, line: `card: ${key} not closed: ${why}; close it with kit ticket update ${key} --status Done`, suffix: `; card ${key} not closed: ${why}` };
  }
}
