// The PR body kit pr writes and PATCHes (TOOLS-495). GitHub refuses a body over 65,536 characters ("Body is too long"), and
// a release's Summary, one line per commit, passes that on a big release (the Site Editor's 1,658 commits wrote 121,013).
// The cap leaves room under the limit, and the body is measured in UTF-8 bytes: never fewer than the characters GitHub
// counts, however it counts them, so a body under the cap is under GitHub's limit too.
export const bodyCap = 60000;

const size = text => Buffer.byteLength(text, "utf8");
const moreLine = (count, range) => `- …and ${count} more commit${count === 1 ? "" : "s"} (git log --oneline ${range})`;
const morePattern = /^- …and (\d+) more commits? \(git log --oneline [^)]*\)$/;

// The body as it is when it fits under `cap`; otherwise its Summary list keeps, in order, the subject lines that fit, and
// ends with one line saying how many more commits there are and the git log range that shows them all. A body cut before
// (a later PATCH added the review-loop block or the ledger) is cut again, and its count adds up. Only a Summary that is a
// list is cut: a sync's sentence, or a body with no Summary, is left as it is.
export function fitBody(text, { cap = bodyCap, range }) {
  if (size(text) <= cap) return text;
  const section = /(## Summary\n\n)([\s\S]*?)(\n\n## Tests\n)/.exec(text);
  if (!section) return text;
  const lines = section[2].split("\n");
  if (!lines.every(line => line.startsWith("- "))) return text;
  const earlier = morePattern.exec(lines.at(-1));
  const items = earlier ? lines.slice(0, -1) : lines;
  const hidden = earlier ? Number(earlier[1]) : 0;
  const before = text.slice(0, section.index + section[1].length), after = text.slice(section.index + section[1].length + section[2].length);
  // Room for the list, with the ending line at its longest count; a shorter count only leaves more room.
  let room = cap - size(before) - size(after) - size(moreLine(items.length + hidden, range));
  let kept = 0;
  for (const item of items) {
    const cost = size(item) + 1;
    if (cost > room) break;
    room -= cost;
    kept++;
  }
  return `${before}${[...items.slice(0, kept), moreLine(items.length - kept + hidden, range)].join("\n")}${after}`;
}
