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
const LOCATION = /^`?(?:[0-9a-f]{7,64}:)?[^\s:`]+:\d+(?:[-–]\d+)?`?\s*(?:[—–-]|:)\s*/i;

const severityOf = text => {
  const body = text.replace(LOCATION, "");
  const window = body === text ? text.slice(0, 80) : body.slice(0, 40);
  return /\bP[0-3]\b/i.exec(window)?.[0].toUpperCase() ?? null;
};

// Parse the Markdown variants emitted by kit review without reading files or changing state.
export function openFindings(resultMd) {
  const findings = [];
  let defects = false, section = "", group = "", pending;
  const clean = text => text.trim().replace(/^#{1,6}\s+/, "").replace(/\*\*|__/g, "")
    .replace(/^(?:[-+*]|\d+[.)])\s+/, "").trim();
  const lines = resultMd.split(/\r?\n/);
  const explicitDefects = lines.some(raw => /^Defects(?:\s*[—–-]\s*(?:Spec|Standards))?(?::.*|\s*)$/i.test(clean(raw)));
  const flush = () => {
    if (pending && !/^none\b/i.test(pending.text)) findings.push({ group: pending.group, text: pending.text,
      severity: pending.group === "Validation gaps" ? null : severityOf(pending.text) });
    pending = undefined;
  };
  for (const raw of lines) {
    const text = clean(raw);
    const heading = /^(Defects(?:\s*[—–-]\s*(Spec|Standards))?|Spec defects|Standards defects|Validation gaps|Optional nits|Spec|Standards)(?::\s*(.*)|\s*)$/i.exec(text);
    const topGroup = !explicitDefects && section !== "Optional nits" && !/^\s*(?:[-+*]|\d+[.)])\s+/.test(raw);
    const bareGroup = /^(Spec|Standards)$/i.test(heading?.[1] ?? "");
    if (heading && (!bareGroup || section === "Defects" || topGroup)) {
      flush();
      const label = heading[1].toLowerCase();
      if (label.startsWith("defects")) {
        defects = true;
        section = "Defects";
        group = heading[2] ? heading[2][0].toUpperCase() + heading[2].slice(1).toLowerCase() : "Defects";
      } else if (label === "spec" || label === "standards" || label === "spec defects" || label === "standards defects") {
        defects = true;
        section = "Defects";
        group = label.startsWith("spec") ? "Spec" : "Standards";
      } else {
        section = label === "validation gaps" ? "Validation gaps" : "Optional nits";
        group = section;
      }
      if (heading[3] && section !== "Optional nits") pending = { group, text: clean(heading[3]), indent: 0 };
      continue;
    }
    if (!text || !section || section === "Optional nits") continue;
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
