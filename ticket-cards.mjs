// Tickets as Orbit cards for kit brief, pr and init --issues, when scripts/agents/kit.json says "tickets": "orbit".
// kit pr copies a card into a brief shaped like a ticket file (title, the card's text), so its review reads it as it
// reads a ticket; only the lead's own kit commands write the board (ORBIT_ROLE=lead), and the agents they start never do.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OrbitError, OrbitSetupProblem, orbitCardKey, orbitCardRedactor, orbitClient, orbitLogPath, orbitRedactor, orbitSecrets, readOrbitConfig } from "./orbit-client.mjs";
import { cardFree, orbitStore, ticketSettings } from "./ticket-store.mjs";
import { kitSliceBranch } from "./kit-lib.mjs";
import { fencedLines } from "./tickets.mjs";

const keyShape = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;
/** True for a card key such as TOOLS-10 (never a path: a ticket file always has a slash or .md). */
export const isCardKey = value => keyShape.test(String(value ?? "").trim());
/** A card's build names, the same in every kit brief: owner kit-12, job slice-kit-12, branch build/kit-12-<first words of the title>. */
export function cardNaming(card) {
  const owner = String(card.identifier).toLowerCase();
  const words = String(card.title ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-");
  return { owner, job: `slice-${owner}`, branch: words ? kitSliceBranch(owner, words) : `build/${owner}` };
}
/** True when the project keeps its tickets on Orbit. */
export const onOrbit = settings => ticketSettings(settings).backend === "orbit";

/**
 * The project's Orbit store from the saved setup, the one place it is built (kit ticket, brief, pr and init all open it
 * here); throws OrbitSetupProblem when Orbit is not set up on this computer. `project` and `parent` replace kit.json's
 * board and parent card when given; `problem` names a settings problem the store says when it needs the board.
 */
export function openOrbitTickets({ settings, who, env = process.env, role = env.ORBIT_ROLE, dryRun = false, project, parent, problem }) {
  const config = readOrbitConfig(env), secrets = orbitSecrets(config), redact = orbitRedactor(secrets);
  const own = ticketSettings(settings);
  const board = { project: project === undefined ? own.project : project, parent: parent === undefined ? own.parent : parent };
  const store = orbitStore({ client: orbitClient(config), role, who, logPath: orbitLogPath(env), redact, secrets, dryRun, defaults: { ...board, problem } });
  return { store, redact, redactCard: orbitCardRedactor(secrets), secrets, ...board };
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
export async function cardBriefFor({ root, key, settings, who, folder, env }) {
  const path = folder ? join(folder, `${orbitCardKey(key)}.md`) : cardBriefPath(root, key);
  if (existsSync(path)) return { path, arg: cardBriefArg(key), key: orbitCardKey(key), resumed: true };
  const { store } = openOrbitTickets({ settings, who, env });
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
export async function closeLandedCard({ settings, key, pr, sha, followups = [], who, env }) {
  let redact;
  try {
    const opened = openOrbitTickets({ settings, who, env });
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

/**
 * A PR a merge queue took leaves its card open: its follow-ups go on the card now as one comment, since no later step reads
 * the brief. When Orbit refuses them they are saved in `folder` and `comment` posts that file on the PR. The line names who
 * closes the card and where the follow-ups are.
 */
export async function queuedCardFollowups({ settings, key, pr, number, followups = [], who, env, folder, comment }) {
  const lines = [...new Set(followups)];
  let where = "";
  if (lines.length) {
    let redact;
    try {
      const opened = openOrbitTickets({ settings, who, env });
      redact = opened.redact;
      await opened.store.comment(key, `Follow-ups from ${pr}:\n${lines.join("\n")}`);
    } catch (error) {
      // The brief's UX follow-ups are in no PR comment yet, so all of them go there now, and the line names where they are.
      const problem = orbitProblem(error, redact), file = join(folder, "card-followups.md");
      writeFileSync(file, `Follow-ups for card ${key} (Orbit did not take them):\n${lines.join("\n")}\n`);
      try { await comment(file); where = ` (its follow-ups were not added: ${problem}; they are in a PR comment)`; }
      catch { where = ` (its follow-ups were not added: ${problem}; they are only in ${file})`; }
    }
  }
  return { line: `card: ${key} stays open: nothing here waits for the queue; run kit ticket update ${key} --status Done once #${number} lands${where}`,
    words: `; card ${key} stays open: close it once #${number} lands` };
}

/**
 * Free to claim: a card up for building (stage "ready": Todo, or every unstarted status on a board with no Todo; and
 * In Progress given back after Lex) and Backlog. A claim narrower than that would let a second helper start on the card. Any other status a board with Todo keeps (Ideas, say) is not the brief's to move.
 * Asked of the card as the brief first reads it, and again by the claim of the card as it is right before its write.
 */
const cardOpen = task => task.stage === "ready" || String(task.status_name ?? "").trim().toLowerCase() === "backlog" || cardFree(task);
/** Why a card that is not free is left as it is, for the owner the brief is written for; "" for the owner's own card. */
function whyLeft(task, owner) {
  if (task.stage === "done") return `it is already ${task.status_name}, so there is nothing to build`;
  if (task.claimed_by && task.claimed_by === oneLine(owner)) return "";
  const why = task.claimed_by ? `${task.claimed_by} holds it (${task.status_name})`
    : task.next_lex !== null ? `it waits for Lex (Next step (Lex): ${task.next_lex})`
    : task.assignee_ids?.length ? `someone is assigned to it (${task.status_name})` : `it is in ${task.status_name}`;
  return `${why}; make sure no second builder starts on it`;
}

/** A card as the ticket text kit brief reads (title, builder, assignee, Files), and the card itself for the brief. */
export async function readCard({ settings, key, who, env }) {
  let redact;
  try {
    const opened = openOrbitTickets({ settings, who, env });
    redact = opened.redact;
    const task = await opened.store.read(key);
    const comments = await opened.store.comments(task.identifier);
    const line = name => new RegExp(`^${name}:[ \\t]*(.*?)\\s*$`, "m").exec(task.description ?? "")?.[1] ?? "";
    const owner = task.claimed_by || line("Assignee");
    const text = `---\ntitle: ${JSON.stringify(oneLine(task.title))}\norbit: ${task.identifier}\nbuilder: ${oneLine(line("Builder"))}\nassignee: ${oneLine(owner)}\n---\n\n${String(task.description ?? "").replace(/\r\n?/g, "\n")}\n`;
    return { key: task.identifier, free: cardOpen(task), left: owner => whyLeft(task, owner), text, card: { title: oneLine(task.title), url: task.url, description: task.description,
      comments: comments.map(note => ({ who: note.author_service_account?.name ?? note.author_id ?? "someone", when: note.created_at, body: note.body })) } };
  } catch (error) {
    if (isOrbitFailure(error)) throw new Error(`card ${key} could not be read: ${orbitProblem(error, redact)}`);
    throw error;
  }
}

/**
 * A build brief takes a card nobody holds (Todo, Backlog, or In Progress given back after Lex): In Progress and
 * "Claimed by: <owner>" in one write, so no second helper starts on the same card. A Todo or Backlog card waiting for Lex or still blocked is refused (next-lex moves a card
 * it marks to In Progress, which the brief leaves alone). Only a lead writes to Orbit; anyone else is warned.
 * A card that stopped being free after the brief read it is not claimed: the claim asks again right before its write.
 * Returns what gives a new claim back (the status the card had, no "Claimed by" line), for a step after it that fails.
 */
export async function claimCard({ settings, key, owner, who, env = process.env }) {
  const none = async () => "";
  if (env.ORBIT_ROLE !== "lead") {
    console.error(`warning: ${key} is not claimed (only a lead writes to Orbit: ORBIT_ROLE=lead); until it is, another helper may start it too`);
    return none;
  }
  let redact;
  try {
    const opened = openOrbitTickets({ settings, who, env });
    redact = opened.redact;
    // The brief's first read may be old by now: the claim puts the same test to the card as it is right before its write,
    // so a card moved in between (Todo to Ideas, say) keeps its place and the brief says why it holds no claim.
    const claim = await opened.store.claim(key, owner, { free: cardOpen });
    const why = claim.left ? whyLeft(claim.left, owner) : "";
    if (why) console.error(`warning: ${key} changed while its brief was written and is left as it is, not claimed for ${owner}: ${why}`);
    if (claim.unchanged) return none;
    console.error(`claimed ${key} for ${owner}: In Progress with "Claimed by: ${owner}"`);
    // Named now, while Orbit answers: what the card needs by hand if giving the claim back fails later.
    const before = await opened.store.statusName({ project_id: claim.task.project_id, status_id: claim.previous });
    const undo = `take that line off the card${before.trim().toLowerCase() === "in progress" ? "" : ` and set its status back to ${before}`}`;
    return async () => {
      try { await opened.store.unclaim(key, owner, claim.previous); return "; the claim was given back"; }
      catch (error) { return `; giving the claim back failed (${isOrbitFailure(error) ? orbitProblem(error, redact) : error.message}): ${key} is still In Progress with "Claimed by: ${owner}", so ${undo}`; }
    };
  } catch (error) {
    if (error?.taken) throw new Error(error.message);
    if (!isOrbitFailure(error)) throw error;
    // Only the claim's own write left with no answer (a dropped connection, a timeout, a gateway's error page) can be saved
    // with its reply lost: running the brief again settles it (a card that now shows the claim is In Progress, so its brief
    // is written without a second claim). A refused write (a stale version, a token that may not change the card) and a
    // failed read saved nothing, and their own message says what to do.
    const unknown = error.write && error.noAnswer;
    throw new Error(`card ${key} could not be claimed: ${orbitProblem(error, redact)}${unknown ? `; it may be claimed anyway, so run kit brief again: a card that shows "Claimed by: ${owner}" then gets its brief` : ""}`);
  }
}
