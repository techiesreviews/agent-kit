// The ticket a kit run works on (TOOLS-292): one seam, with an Orbit adapter for cards (ticket-cards.mjs) and a files
// adapter for ticket files in the repo. kit brief and kit pr ask it what the ticket says and what happens to it when the
// work is briefed and when it lands; neither asks itself whether the project keeps its tickets on Orbit or in files.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { kitSettings } from "./kit-lib.mjs";
import { doneHeading } from "./pr-tier.mjs";
import { briefFollowups, cardBriefFor, claimCard, closeLandedCard, isCardKey, onOrbit, orbitProblem, queuedCardFollowups, readCard, ticketCardKey } from "./ticket-cards.mjs";

const nothingToGiveBack = async () => "";

/**
 * The ticket kit brief writes a brief for: `ticket` (the path or card key the brief names), its `text`, the `card` the
 * brief shows (cards only), `closesOnLanding` (true for a card on an Orbit project: kit claims it here and kit pr closes it),
 * and `claim(owner)`, which a build brief calls once its brief is written. The claim returns what gives it back, for a
 * step after it that fails; a ticket file, and a card read in a files project, claim nothing.
 * A card key reads the card on an Orbit project, and in a files project too unless a ticket file sits at that path.
 */
export async function briefTicket({ root, ticket, who, env = process.env }) {
  const absolute = isAbsolute(ticket) ? ticket : join(root, ticket);
  if (isCardKey(ticket) && (onOrbit(kitSettings(root)) || !existsSync(absolute))) {
    const settings = kitSettings(root), closesOnLanding = onOrbit(settings);
    const { key, free, left, text, card } = await readCard({ settings, key: ticket, who, env });
    async function claim(owner) {
      if (!closesOnLanding) return nothingToGiveBack;
      if (free) return claimCard({ settings, key, owner, who, env });
      // The claim refuses a card that is held, done or not up for building; the brief still comes (a builder that
      // stopped is started again this way), with the reason said, so a second builder is never started unnoticed.
      const why = left(owner);
      if (why) console.error(`warning: ${key} is left as it is, not claimed for ${owner}: ${why}`);
      return nothingToGiveBack;
    }
    return { ticket: key, text, card, closesOnLanding, claim };
  }
  if (!existsSync(absolute)) throw new Error(`no ticket at ${ticket} in ${root} (for a project without ticket files, use --task)`);
  return { ticket: relative(root, realpathSync(absolute)), text: readFileSync(absolute, "utf8"), card: undefined, closesOnLanding: false, claim: async () => nothingToGiveBack };
}

/**
 * The ticket kit pr lands: `path` (the ticket file, or the card's brief, relative to `root`; undefined with no ticket),
 * `cardKey` (the key of the card that closes on landing, or null), `keepsNotes` (kit writes its notes into the ticket file: follow-ups,
 * commits by subject), `noteFollowups(lines)` for review follow-ups, and what happens once the PR lands (`land`) or a merge
 * queue takes it (`queued`); both return the line and words to show, or null for a ticket file.
 * On Orbit a card KEY is read into a brief in `folder` (read only: kit pr claims nothing, and its brief is no worktree's
 * saved one); a brief is no tracked file, so none of kit's ticket commits is made for it. A files project takes a card's
 * brief as a ticket file.
 */
export async function prTicket({ root, settings, ticket, who, folder, env = process.env }) {
  if (!ticket || !onOrbit(settings)) return ticketFile(ticket);
  let path = ticket, fromKey = false;
  if (isCardKey(ticket)) {
    fromKey = true;
    try { path = relative(root, (await cardBriefFor({ root, key: ticket, settings, who, folder, env })).path); }
    catch (error) { throw new Error(orbitProblem(error)); }
  }
  const card = ticketCardKey(root, path);
  if (!card) return ticketFile(path);
  // A card's review follow-ups go on the card as one comment when it closes, with the UX ones its brief keeps.
  const followups = [];
  const kept = () => {
    try { return briefFollowups(readFileSync(resolve(root, path), "utf8")); } catch { return []; /* No brief left: no follow-ups kept in it. */ }
  };
  return { path, cardKey: card, keepsNotes: false,
    noteFollowups: lines => { followups.push(...lines); },
    // The merge already happened, so a card that cannot be closed (Orbit down, no lead role) is said, with the command that closes it.
    land: ({ pr, sha }) => closeLandedCard({ settings, key: card, pr, sha, followups: [...followups, ...kept()], who, env }),
    // Nothing here waits for the queue: the card stays open and its follow-ups (a saved brief's UX ones too) go on it now.
    queued: ({ pr, number, folder: into, comment }) => queuedCardFollowups({ settings, key: card, pr, number,
      followups: [...followups, ...(fromKey ? [] : kept())], who, env, folder: into, comment }) };
}

const ticketFile = path => ({ path, cardKey: null, keepsNotes: Boolean(path), noteFollowups: () => {}, land: async () => null, queued: async () => null });

/**
 * A ticket file's text with kit's follow-ups in its last Done section (a new "## Done (<today>)" when it has none), under
 * "### Follow-ups", each line once: a rerun adds only what is missing. `cut` holds the same findings as `lines`, as an older
 * kit pr cut them (before 2026-10-27: 160 UTF-16 units, no mark); such a bullet is swapped for its full line.
 */
export function withFollowups(original, { lines, cut = [], today = new Date().toISOString().slice(0, 10) }) {
  // The ticket's own line endings, whether or not it has a Follow-ups section yet.
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const sections = [...original.matchAll(doneHeading())];
  const start = sections.at(-1)?.index;
  const prefix = start === undefined ? `${original.trimEnd()}${eol}${eol}## Done (${today})` : original.slice(0, start);
  const rest = start === undefined ? "" : original.slice(start);
  const end = rest.slice(1).search(/^## /m);
  const doneEnd = end < 0 ? rest.length : end + 1;
  let done = rest.slice(0, doneEnd);
  const followups = /^### Follow-ups\s*\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/m.exec(done);
  const raw = followups?.[1].split("\n") ?? [];
  const existing = raw.map(line => line.trimEnd());
  // Each old cut bullet is upgraded by one finding at most, so findings that share their first
  // 160 characters each keep their own full line.
  const used = new Set();
  const kept = existing.map(line => {
    const index = cut.findIndex((old, at) => !used.has(at) && old !== lines[at] && old.trimEnd() === line &&
      !existing.includes(lines[at]));
    if (index < 0) return line;
    used.add(index);
    return lines[index];
  });
  const missing = lines.filter(line => !kept.includes(line));
  if (followups) {
    const header = followups[0].slice(0, followups[0].length - followups[1].length);
    let section = header + raw.map((line, index) => kept[index] === existing[index] ? line
      : kept[index] + (line.endsWith("\r") ? "\r" : "")).join("\n");
    const position = section.trimEnd().length;
    if (missing.length) section = `${section.slice(0, position)}${eol}${missing.join(eol)}${section.slice(position)}`;
    done = done.slice(0, followups.index) + section + done.slice(followups.index + followups[0].length);
  } else if (missing.length) done = `${done.trimEnd()}${eol}${eol}### Follow-ups${eol}${eol}${missing.join(eol)}${eol}${eol}`;
  return prefix + done + rest.slice(doneEnd);
}
