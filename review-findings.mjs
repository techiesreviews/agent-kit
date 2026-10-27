import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export const FIX_ROUNDS = 3;
export const afterFixRounds = rounds => rounds >= FIX_ROUNDS;

export function blockingFindings(findings) {
  return findings.filter(item => item.group !== "Validation gaps" && !["P2", "P3"].includes(item.severity));
}

// Older kit fix versions save rounds in the worktree rather than the main root.
export function completedFixRounds(directory, fallback = directory) {
  const folder = existsSync(directory) ? directory : fallback;
  if (!existsSync(folder)) return 0;
  const pending = resolve(folder, "pending.json");
  const round = existsSync(pending) ? JSON.parse(readFileSync(pending, "utf8")).round : null;
  return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isFile() &&
    /^round-[1-9]\d*\.md$/.test(entry.name) && Number(entry.name.slice(6, -3)) !== round).length;
}

// A ticket-only descendant preserves review coverage, including findings-bearing reviews.
export function reviewCoversHead(reviewedHead, head, ticket, root) {
  if (reviewedHead === head) return true;
  if (!ticket || !reviewedHead || !head) return false;
  const git = args => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    git(["merge-base", "--is-ancestor", reviewedHead, head]);
    const paths = git(["diff", "--name-only", "--no-renames", "-z", reviewedHead, head, "--"]).split("\0").filter(Boolean);
    return paths.every(path => resolve(root, path) === resolve(root, ticket));
  } catch { return false; }
}

// Empty or failed patch-id output must never count as a matching review.
export function sameReviewPatch(reviewedId, currentId) {
  return typeof reviewedId === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(reviewedId) && reviewedId === currentId;
}

// A leading `<sha>:<path>:<line>` or `<path>:<line>` (line may be a range, optionally
// backticked) and the separator that follows it. Severity is read after this location.
const LOCATION = /^`?(?:[0-9a-f]{7,64}:)?[^\s:`]+:\d+(?:[-–]\d+)?`?\s*(?:[—–-]|:)?\s*/i;

const SEVERITY = /\bP[0-3]\b/i;
const KINDS = ["fault", "ticket", "race", "style"];
// Backticks around the severity and kind are optional and unpaired on purpose: `` `P2` `race` ``
// and `` `P2 race` `` both pass, so do not tighten this to balanced pairs.
const KIND = new RegExp(`^\`?\\s*\`?(${KINDS.join("|")})(?![\\w-])`, "i");

// Severity sits within 40 characters after a leading location, or within the first 80
// characters as before (a finding may name several locations ahead of its severity).
// The kind is the word right after it (`P2 fault:`, `` `P2` `fault` ``); bold is cleaned earlier.
const classify = text => {
  const token = (source, limit) => {
    const match = SEVERITY.exec(source.slice(0, limit));
    if (!match) return null;
    const kind = KIND.exec(source.slice(match.index + 2))?.[1];
    return { severity: match[0].toUpperCase(), kind: kind?.toLowerCase() ?? "unsorted" };
  };
  const body = text.replace(LOCATION, "");
  return (body === text ? null : token(body, 40)) ?? token(text, 80) ?? { severity: null, kind: "unsorted" };
};
const severityOf = text => classify(text).severity;

// Parse the Markdown variants emitted by kit review without reading files or changing state.
// A group whose first line says "none" holds notes, not findings, until the next heading;
// an indented sub-bullet belongs to the finding above it. A defects line that names no severity
// and starts with no location is reviewer prose: it is returned under notes and never blocks.
export function openFindings(resultMd) {
  const findings = [], notes = [];
  let defects = false, labelled = false, section = "", group = "", pending;
  // noneGroup: the group's first line said "none"; fresh: the group's first line is still to come;
  // labelSection: the section was opened by a "Spec defects" / "Standards defects" heading.
  let noneGroup = false, fresh = false, labelSection = false;
  const listItem = raw => /^\s*(?:[-+*]|\d+[.)])\s+/.test(raw);
  // A leading single `*` or `_` emphasis around words (`*Spec*`, `_Standards:_ none`) is removed, so
  // such a heading opens its group; a path such as `_site/a.ts:1` is left alone. The late-label check
  // below still looks for `#` or bold only.
  const clean = text => text.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "").replace(/^([*_])([a-z][a-z \u2013\u2014-]*:?)\1(?![*_\w])/i, "$2").trim();
  const none = text => /^none\b/i.test(text);
  const lines = resultMd.split(/\r?\n/);
  const explicitDefects = lines.some(raw => /^Defects(?:\s*[—–-]\s*(?:Spec|Standards))?(?::.*|\s*)$/i.test(clean(raw)));
  const flush = () => {
    if (pending && !none(pending.text)) {
      const gap = pending.group === "Validation gaps", found = gap ? { severity: null, kind: null } : classify(pending.text);
      // Gaps, located lines and lines naming a P0–P3 anywhere are findings (an unread severity still
      // blocks, fail closed); other defects lines are notes.
      if (gap || SEVERITY.test(pending.text) || LOCATION.test(pending.text)) findings.push({ group: pending.group, text: pending.text, ...found });
      else notes.push({ group: pending.group, text: pending.text });
    }
    pending = undefined;
  };
  for (const raw of lines) {
    const text = clean(raw);
    const heading = /^(Defects(?:\s*[—–-]\s*(Spec|Standards))?|Spec defects|Standards defects|Validation gaps|Optional nits|Spec|Standards)(?::\s*(.*)|\s*)$/i.exec(text);
    const bareGroup = /^(Spec|Standards)$/i.test(heading?.[1] ?? "");
    const defectsLabel = /^(Spec|Standards) defects$/i.test(heading?.[1] ?? "");
    // An unbulleted bare Spec:/Standards: opens a group when no explicit Defects heading exists,
    // outside Optional nits; after the notes it is text once a defects label has opened.
    const topGroup = !explicitDefects && !labelled && section !== "Optional nits" && !listItem(raw);
    // "Spec defects" / "Standards defects" always open their group before the notes. After them an
    // unbulleted heading still does (fail closed) when it is bare, marked with # or bold, or names a
    // severity; a bulleted one, or a plain one with severity-less inline text, is gap or nit text.
    const lateLabel = defectsLabel && !listItem(raw) &&
      (!heading[3] || /^\s*(?:#{1,6}\s|\*\*|__)/.test(raw) || severityOf(clean(heading[3])) !== null);
    // Inside a defects-label section a bulleted bare Spec:/Standards: stays in that section's group,
    // except under "none" notes, where it switches so a real fault after the notes still counts, or
    // when it says "none" itself, so it and its notes never join the finding above.
    const stays = labelSection && listItem(raw) && !noneGroup && !none(clean(heading?.[3] ?? ""));
    const groupSwitch = section === "Defects" && !stays || topGroup;
    const opens = defectsLabel ? ["", "Defects"].includes(section) || lateLabel : !bareGroup || groupSwitch;
    if (heading && opens) {
      flush();
      const label = heading[1].toLowerCase();
      labelSection = false;
      if (label.startsWith("defects")) {
        defects = true;
        section = "Defects";
        group = heading[2] ? heading[2][0].toUpperCase() + heading[2].slice(1).toLowerCase() : "Defects";
      } else if (bareGroup || defectsLabel) {
        defects = true;
        section = "Defects";
        group = label.startsWith("spec") ? "Spec" : "Standards";
        if (defectsLabel) labelled = labelSection = true;
      } else {
        section = label === "validation gaps" ? "Validation gaps" : "Optional nits";
        group = section;
      }
      const value = clean(heading[3] ?? "");
      noneGroup = none(value);
      fresh = !value;
      if (value && !noneGroup && section !== "Optional nits") pending = { group, text: value, indent: 0 };
      continue;
    }
    if (!text || !section || section === "Optional nits") continue;
    if (fresh) {
      fresh = false;
      if ((noneGroup = none(text))) continue;
    }
    const bullet = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(raw);
    const indent = bullet?.[1].length ?? 0;
    // An unindented, unbulleted line starting with a location also starts a new item, so a located
    // defect after a prose paragraph is judged on its own and still blocks.
    const located = !bullet && section === "Defects" && !/^\s/.test(raw) && LOCATION.test(text);
    if (bullet && (!pending || indent <= pending.indent) || located) flush();
    // Under "none" notes a line that starts with a location and names a severity is still a finding
    // (fail closed); its continuation lines and sub-bullets join it, and other notes are skipped.
    if (noneGroup && !pending && !(LOCATION.test(text) && severityOf(text))) continue;
    if (pending) pending.text += ` ${text}`;
    else pending = { group, text, indent };
  }
  flush();
  const readable = /^REVIEW_STATUS: complete\s*$/m.test(resultMd.replace(/^\uFEFF/, "")) && defects;
  return readable ? { findings, notes, readable } : {
    findings: [{ group: "Review", text: "review format unreadable", severity: null, kind: "unsorted" }], notes: [], readable: false,
  };
}

// The structured record kit review saves beside result.md, with counts by kind and severity.
// notes counts the prose lines openFindings set aside; lines under a "none" group are not counted.
// Validation gaps carry neither and count as "gap" in both, so a severity "none" is always a
// defect whose severity could not be read (one that blocks).
export function findingsRecord(resultMd, meta) {
  const { findings, notes, readable } = openFindings(resultMd);
  if (!readable) return { ...meta, unreadable: true };
  const counts = { kind: Object.fromEntries([...KINDS, "unsorted", "gap"].map(kind => [kind, 0])),
    severity: Object.fromEntries(["P0", "P1", "P2", "P3", "none", "gap"].map(severity => [severity, 0])) };
  for (const { group, kind, severity } of findings) {
    const gap = group === "Validation gaps";
    counts.kind[gap ? "gap" : kind]++;
    counts.severity[gap ? "gap" : severity ?? "none"]++;
  }
  return { ...meta, findings: findings.map(({ group, severity, kind, text }) => ({ group, severity, kind, text })), counts, notes: notes.length };
}

// One line for logs: "findings 3: fault 1, ticket 2; P1 2, P2 1".
export function countsLine({ findings, counts, unreadable }) {
  if (unreadable) return "findings unreadable";
  const nonzero = values => Object.entries(values).filter(([, count]) => count).map(([name, count]) => `${name} ${count}`).join(", ");
  return `findings ${findings.length}${findings.length ? `: ${nonzero(counts.kind)}; ${nonzero(counts.severity)}` : ""}`;
}
