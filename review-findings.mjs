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

// Severity sits within 40 characters after a leading location, or within the first 80
// characters as before (a finding may name several locations ahead of its severity).
const severityOf = text => {
  const token = window => /\bP[0-3]\b/i.exec(window)?.[0].toUpperCase() ?? null;
  const body = text.replace(LOCATION, "");
  return (body === text ? null : token(body.slice(0, 40))) ?? token(text.slice(0, 80));
};

// Parse the Markdown variants emitted by kit review without reading files or changing state.
// A group whose first line says "none" holds notes, not findings, until the next heading;
// an indented sub-bullet belongs to the finding above it.
export function openFindings(resultMd) {
  const findings = [];
  let defects = false, labelled = false, section = "", group = "", pending;
  // notes: the group's first line said "none"; fresh: the group's first line is still to come;
  // labelSection: the section was opened by a "Spec defects" / "Standards defects" heading.
  let notes = false, fresh = false, labelSection = false;
  const listItem = raw => /^\s*(?:[-+*]|\d+[.)])\s+/.test(raw);
  const clean = text => text.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "").trim();
  const none = text => /^none\b/i.test(text);
  const lines = resultMd.split(/\r?\n/);
  const explicitDefects = lines.some(raw => /^Defects(?:\s*[—–-]\s*(?:Spec|Standards))?(?::.*|\s*)$/i.test(clean(raw)));
  const flush = () => {
    if (pending && !none(pending.text)) findings.push({ group: pending.group, text: pending.text,
      severity: pending.group === "Validation gaps" ? null : severityOf(pending.text) });
    pending = undefined;
  };
  for (const raw of lines) {
    const text = clean(raw);
    const heading = /^(Defects(?:\s*[—–-]\s*(Spec|Standards))?|Spec defects|Standards defects|Validation gaps|Optional nits|Spec|Standards)(?::\s*(.*)|\s*)$/i.exec(text);
    const bareGroup = /^(Spec|Standards)$/i.test(heading?.[1] ?? "");
    const defectsLabel = /^(Spec|Standards) defects$/i.test(heading?.[1] ?? "");
    // After Validation gaps or Optional nits, bare Spec:/Standards: lines are text once a
    // "Spec defects" / "Standards defects" heading has opened.
    const topGroup = !explicitDefects && !labelled && section !== "Optional nits" && !listItem(raw);
    // "Spec defects" / "Standards defects" always open their group before the notes. After them an
    // unbulleted heading still does (fail closed) when it is bare, marked with # or bold, or names a
    // severity; a bulleted one, or a plain one with severity-less inline text, is gap or nit text.
    const lateLabel = defectsLabel && !listItem(raw) &&
      (!heading[3] || /^\s*(?:#{1,6}\s|\*\*|__)/.test(raw) || severityOf(clean(heading[3])) !== null);
    // Inside a defects-label section a bulleted bare Spec:/Standards: stays in that section's group,
    // except under "none" notes, where it switches so a real fault after the notes still counts.
    const groupSwitch = section === "Defects" && !(labelSection && listItem(raw) && !notes) || topGroup;
    if (heading && (defectsLabel ? ["", "Defects"].includes(section) || lateLabel : !bareGroup || groupSwitch)) {
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
      notes = none(value);
      fresh = !value;
      if (value && !notes && section !== "Optional nits") pending = { group, text: value, indent: 0 };
      continue;
    }
    if (!text || !section || section === "Optional nits" || notes) continue;
    if (fresh) {
      fresh = false;
      if ((notes = none(text))) continue;
    }
    const bullet = /^(\s*)(?:[-+*]|\d+[.)])\s+/.exec(raw);
    const indent = bullet?.[1].length ?? 0;
    if (bullet && (!pending || indent <= pending.indent)) flush();
    if (pending) pending.text += ` ${text}`;
    else pending = { group, text, indent };
  }
  flush();
  const readable = /^REVIEW_STATUS: complete\s*$/m.test(resultMd.replace(/^\uFEFF/, "")) && defects;
  return readable ? { findings, readable } : {
    findings: [{ group: "Review", text: "review format unreadable", severity: null }], readable: false,
  };
}
