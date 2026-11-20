// The review records: one place reads and writes .scratch/reviews/<owner>/<UTC stamp>[-n]/ in the main checkout.
// A record folder holds what one kit review run saved:
// - result.md: the reviewer's report (REVIEW_STATUS: complete when it finished)
// - refs.txt: the reviewed head and base, one per line
// - findings.json: the findings record (round, branch, previous folder, finding ids, incomplete, declined)
// - second-look.json: only in a second look's folder, { kind, model, ok, branch?, pr? }; ok turns true when the look came back
// - run.log and diff.patch: the run's log and the reviewed diff
// kit review saves records (saveReview, markSecondLook) and kit pr asks them questions: which review covers this head,
// the chain of rounds, which second looks ran. The loop's rules on what a finding means stay in review-loop.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { lookFamily } from "./pr-tier.mjs";
import { openFindings, reviewCoversHead, sameReviewPatch } from "./review-findings.mjs";
import { earlierReleaseCut, inHistory, isNit, parseMarks } from "./review-loop.mjs";

/** The folder that holds every owner's review records under a main checkout. */
export const reviewsFolder = mainRoot => join(mainRoot, ".scratch/reviews");

/** A new, empty record folder for `owner`, named by the UTC time to the second, with -1, -2, … when that name is taken. */
export function createReviewFolder(reviews, owner) {
  const parent = join(reviews, owner);
  mkdirSync(parent, { recursive: true });
  const time = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  for (let suffix = 0; ; suffix++) {
    const directory = join(parent, time + (suffix ? `-${suffix}` : ""));
    try { mkdirSync(directory); return directory; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
}

const runFiles = [["out.md", "result.md"], ["run.log", "run.log"], ["diff.patch", "diff.patch"], ["refs.txt", "refs.txt"]];

/**
 * Saves a review run: copies the temporary run folder's files into the folder createFolder() makes, writes findings.json
 * from result.md with findings(text), and only then removes the temporary folder; any failure throws and leaves it in
 * place for recovery. A run that left no file makes no folder (a usage error leaves no empty record).
 * A failed removal after a full save does not undo the save: it comes back as cleanup, the error message.
 * Returns { evidence: the folder or "none", record: the findings record or null, cleanup }.
 */
export function saveReview(temporary, createFolder, findings) {
  if (!temporary) return { evidence: "none", record: null, cleanup: null };
  const saved = runFiles.filter(([source]) => existsSync(join(temporary, source)));
  const evidence = saved.length ? createFolder() : "none";
  for (const [source, target] of saved) copyFileSync(join(temporary, source), join(evidence, target));
  let record = null;
  if (saved.some(([, target]) => target === "result.md")) {
    record = findings(readFileSync(join(evidence, "result.md"), "utf8"));
    writeFileSync(join(evidence, "findings.json.tmp"), JSON.stringify(record, null, 2) + "\n");
    renameSync(join(evidence, "findings.json.tmp"), join(evidence, "findings.json"));
  }
  let cleanup = null;
  try { rmSync(temporary, { recursive: true, force: true }); } catch (error) { cleanup = error.message; }
  return { evidence, record, cleanup };
}

/** Marks a folder as a second look's: `mark` is { kind, model, ok, branch?, pr? }, written as one JSON line in that order. */
export function markSecondLook(folder, mark) {
  writeFileSync(join(folder, "second-look.json"), `${JSON.stringify(mark)}\n`);
}

/** A second look's mark ({ kind, model, ok }), null for any other review; an unreadable mark is still a second look. */
export function secondLookMark(folder) {
  try { return JSON.parse(readFileSync(join(folder, "second-look.json"), "utf8")) ?? {}; }
  catch (error) { return error.code === "ENOENT" ? null : {}; }
}

/** A saved review marked incomplete (a later review loop round that left an earlier id out) is never reused or answered. */
export function reviewIncomplete(folder) {
  try { return JSON.parse(readFileSync(resolve(folder, "findings.json"), "utf8")).incomplete === true; } catch { return false; }
}

/** The path of a record's report, the file kit pr names in its RESULT line and PR comment. */
export const reviewReportPath = folder => join(folder, "result.md");

/** A record's report text; throws as readFileSync does when it is missing. */
export const readReviewReport = folder => readFileSync(reviewReportPath(folder), "utf8");

/**
 * The review in `owner`'s records that covers `head` on `base`, newest first, or undefined: a complete review (Claude's,
 * or with `second` a second look that came back; a second look never stands for Claude's review) of this head and base,
 * never an incomplete round. A clean whole-PR review, or one with nothing but nits, also survives a rebase that keeps
 * the stable patch ID, of HEAD or of `reviewable` (HEAD without kit's own ticket-only commits): then samePatch is true.
 * `patchId(base, head)` returns a patch ID; `ticket` and `root` go to reviewCoversHead.
 */
export async function coveringReview(reviews, owner, { head, base, patchId, ticket, root, second = false, reviewable = head }) {
  const parent = join(reviews, owner);
  if (!existsSync(parent)) return;
  // Review folder names start with UTC timestamps; numeric sorting handles collision suffixes.
  const folders = readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => entry.name).sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  let currentIds;
  for (const name of folders) {
    const folder = join(parent, name), refs = join(folder, "refs.txt");
    const result = reviewReportPath(folder), mark = secondLookMark(folder);
    if (!existsSync(refs) || !existsSync(result) || (second ? mark?.ok !== true : mark)) continue;
    const [reviewedHead, reviewedBase] = readFileSync(refs, "utf8").split(/\r?\n/);
    const resultMd = readFileSync(result, "utf8");
    if (!/^REVIEW_STATUS: complete$/m.test(resultMd)) continue;
    // A later review loop round that left an earlier id out was marked incomplete when it was saved: never reused.
    if (reviewIncomplete(folder)) continue;
    if (reviewedBase === base && reviewCoversHead(reviewedHead, head, ticket, root)) return { folder, samePatch: false };
    // A review with nothing but nits ended the loop, so it carries over to the same patch like a clean one (a blocker or a should does not).
    if (!reviewedHead || !reviewedBase || openFindings(resultMd).findings.some(item => !isNit(item))) continue;
    currentIds ??= [await patchId(base, head), ...(reviewable === head ? [] : [await patchId(base, reviewable)])];
    const reviewedId = await patchId(reviewedBase, reviewedHead);
    if (currentIds.some(id => sameReviewPatch(reviewedId, id))) return { folder, samePatch: true };
  }
}

/**
 * The findings above P3 of the reviews `owner` saved for `commit`, as a Set of "<id>\n<text>": what the lead could have
 * seen before a rebase changed the head. The ids are the ones a lookAt run gives the same findings (findings.json, else
 * its position; SL-<n> for a second look).
 */
export function findingsSeenAt(reviews, owner, commit) {
  const seen = new Set(), parent = join(reviews, owner);
  if (!existsSync(parent)) return seen;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = join(parent, entry.name);
    try {
      if (readFileSync(join(folder, "refs.txt"), "utf8").split(/\r?\n/)[0] !== commit) continue;
      const second = Boolean(secondLookMark(folder));
      const saved = existsSync(join(folder, "findings.json")) ? JSON.parse(readFileSync(join(folder, "findings.json"), "utf8")).findings : null;
      openFindings(readReviewReport(folder)).findings.forEach((item, index) => {
        if (!isNit(item)) seen.add(`${second ? `SL-${index + 1}` : saved?.[index]?.id ?? `review-${index + 1}`}\n${item.text}`);
      });
    } catch { /* Not a readable review: it shows the lead nothing. */ }
  }
  return seen;
}

/**
 * The earlier review this one answers (later rounds), for `owner`: findPreviousReview over the owner's folder, and the
 * other owners' folders too, since a lead landing a builder's branch answers the builder's rounds (they must name this branch).
 */
export function previousReview(reviews, owner, { head, base, root, branch }) {
  const otherOwners = existsSync(reviews) ? readdirSync(reviews, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== owner).map(entry => join(reviews, entry.name)) : [];
  return findPreviousReview(join(reviews, owner), { head, base, root, branch, otherOwners });
}

/**
 * The earlier review this one answers (later rounds): in `parent` (the owner's folder under .scratch/reviews) the newest review of the
 * same base that still had findings and whose reviewed head is an ancestor of the current head, or an earlier cut of the
 * same release. A second look's folder is never one.
 * Returns { name, round, head, findings, declined } or null (then this is round 1, a full review).
 */
export function findPreviousReview(parent, { head, base, root, branch, otherOwners = [] }) {
  if (!head || !base) return null;
  const isAncestor = other => {
    try { execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", other, head], { stdio: "ignore" }); return true; }
    catch { return false; }
  };
  // The owner's own folder first; a lead landing a builder's branch also answers the reviews other owners saved for this same branch
  // (they must name it), and such a review is linked by a path from the owner's folder. Newest first by the timestamp in the name.
  const candidates = [parent, ...otherOwners].filter(folder => existsSync(folder))
    .flatMap(folder => readdirSync(folder).map(name => ({ name, folder: join(folder, name), foreign: folder !== parent,
      link: folder === parent ? name : `${relative(parent, folder)}/${name}` })))
    .sort((a, b) => b.name.localeCompare(a.name) || Number(a.foreign) - Number(b.foreign));
  for (const { name, folder, foreign, link } of candidates) {
    if (existsSync(join(folder, "second-look.json")) || !existsSync(join(folder, "findings.json")) || !existsSync(join(folder, "refs.txt"))) continue;
    try {
      const [reviewedHead, reviewedBase] = readFileSync(join(folder, "refs.txt"), "utf8").trim().split("\n");
      const record = JSON.parse(readFileSync(join(folder, "findings.json"), "utf8"));
      // The base may have moved on (another PR landed): the earlier base only has to be part of this branch's history.
      // The same branch's own history only: a branch cut from a reviewed head starts at round 1, and so does a rebased one
      // (its old head is gone from the history), which gets the full first review its new code needs.
      // An earlier cut of the same release counts as this history too (TOOLS-310): a re-cut answers its review.
      const connected = (reviewedBase === base || isAncestor(reviewedBase)) && (reviewedHead === head || isAncestor(reviewedHead) || earlierReleaseCut(root, reviewedHead, head, { base }));
      if (record.unreadable || record.incomplete || record.round === undefined || !connected || (record.branch && branch && record.branch !== branch)) continue;
      // Another owner's review counts only when it names this very branch.
      if (foreign && (!branch || record.branch !== branch)) continue;
      // The newest review of this change decides: when it found nothing, the loop had ended, so no open ids carry over, but the rounds still link.
      // The builder's declined findings saved on that review (text, reason, round; the cut kit fix saved them); a malformed entry is dropped.
      const declined = (Array.isArray(record.declined) ? record.declined : []).filter(entry => entry && typeof entry.text === "string" && entry.text.trim());
      return { name: link, clean: !record.findings?.length, round: record.round ?? 1, head: reviewedHead, declined, findings: record.findings.map((item, index) => ({ ...item, id: item.id ?? `R${record.round ?? 1}-${index + 1}` })) };
    } catch { /* An unreadable record is not a previous review. */ }
  }
  return null;
}

/**
 * The chain of review records ending at a review's evidence folder, oldest first, from the findings.json each review saved
 * (`round`, `previous` = the earlier folder's name, `findings` with ids) and each result.md's marks.
 */
export function reviewChain(folder) {
  const chain = [];
  for (let current = resolve(folder), guard = 0; current && guard < 20; guard++) {
    const recordPath = join(current, "findings.json");
    if (!existsSync(recordPath)) break;
    let record;
    try { record = JSON.parse(readFileSync(recordPath, "utf8")); } catch { break; }
    if (!record || typeof record !== "object" || Array.isArray(record)) break;
    let marks = new Map();
    try { marks = parseMarks(readReviewReport(current)); } catch { /* No report text: no marks. */ }
    const round = record.round ?? 1;
    // A review saved before ids existed gets the ids a new one would have been given.
    chain.unshift({ round, model: record.model, head: record.head, declined: (Array.isArray(record.declined) ? record.declined : []).filter(entry => entry && typeof entry.text === "string" && entry.text.trim()), findings: (record.findings ?? []).map((item, index) => ({ ...item, id: item.id ?? `R${round}-${index + 1}` })), marks });
    current = record.previous ? join(dirname(current), record.previous) : null;
  }
  return chain;
}

/**
 * The branch's earlier second looks that came back, under any owner in `reviews`: each one marked for `branch` whose
 * reviewed head is an ancestor of `head` (or an earlier cut of the same release, given `base`) and not `head` itself. kit pr passes the head Claude's review saw, which a review
 * reused after a rebase with the same patch keeps, so the count survives that rebase until the next commit (then, like Claude's
 * rounds, it starts again); a rebase that changes the patch, or one in the docs tier (no Claude review), starts it again at once.
 * Returns [{ head, findings }] with the findings its result.md left open; a result.md kit cannot read counts no round.
 */
export function earlierSecondLooks(reviews, { branch, head, root, base }) {
  if (!branch || !head || !existsSync(reviews)) return [];
  const looks = [];
  for (const owner of readdirSync(reviews, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const entry of readdirSync(join(reviews, owner.name), { withFileTypes: true }).filter(item => item.isDirectory())) {
      const folder = join(reviews, owner.name, entry.name);
      try {
        const mark = JSON.parse(readFileSync(join(folder, "second-look.json"), "utf8"));
        if (mark?.ok !== true || mark.branch !== branch) continue;
        const looked = readFileSync(join(folder, "refs.txt"), "utf8").split(/\r?\n/)[0].trim();
        if (!/^[0-9a-f]{7,64}$/.test(looked) || looked === head) continue;
        if (!inHistory(root, looked, head, base)) continue;
        // A report kit cannot read stands for a blocker when it is weighed, but it is no review that asked for a fix.
        const report = openFindings(readReviewReport(folder));
        if (report.readable) looks.push({ head: looked, findings: report.findings });
      } catch { /* Not a second look of this branch's history, or unreadable: it counts no round. */ }
    }
  }
  return looks;
}

// The commits of `head` whose patch is not in `upstream` (git cherry's "+" lines), or null when git fails.
function cherryPlus(root, upstream, head) {
  const run = spawnSync("git", ["-C", root, "cherry", upstream, head], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.split("\n").filter(line => line.startsWith("+ ")).map(line => line.slice(2).trim()) : null;
}

/**
 * The PR's GPT second look that already ran (a mark that came back, for `pr` or `branch`, under any owner), or null.
 * The cost guard: one GPT second look per PR. A branch match counts unless both name a PR, and only when the look's own
 * work (its HEAD's commits not in `base`, by patch) is all in `head`, by commit or by patch, so a rebase keeps it, while an
 * earlier PR on a branch name that comes back (its work already in the base, or never in this branch) leaves the new PR
 * its own GPT look. A look whose refs.txt cannot be read never counts: GPT looks again.
 */
export function gptLookDone(reviews, { pr, branch, root, head, base }) {
  if (!existsSync(reviews)) return null;
  const folders = readdirSync(reviews, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .flatMap(owner => readdirSync(join(reviews, owner.name), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(reviews, owner.name, entry.name)));
  for (const folder of folders.sort().reverse()) {
    let mark;
    try { mark = JSON.parse(readFileSync(join(folder, "second-look.json"), "utf8")); } catch { continue; }
    if (mark?.ok !== true || lookFamily(mark.model) !== "gpt") continue;
    if (pr && mark.pr === pr) return folder;
    if (!branch || mark.branch !== branch || (pr && mark.pr)) continue;
    let looked = "";
    try { looked = readFileSync(join(folder, "refs.txt"), "utf8").split(/\r?\n/)[0].trim(); } catch { continue; }
    if (!/^[0-9a-f]{7,64}$/.test(looked)) continue;
    const own = cherryPlus(root, base, looked), missing = cherryPlus(root, head, looked);
    if (own?.length && missing && own.every(commit => !missing.includes(commit))) return folder;
  }
  return null;
}
