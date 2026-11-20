import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { coveringReview, createReviewFolder, findingsSeenAt, gptLookDone, markSecondLook, previousReview, readReviewReport, reviewIncomplete, reviewReportPath, reviewsFolder, saveReview, secondLookMark } from "../review-records.mjs";

// The review record module owns .scratch/reviews/<owner>/<stamp>: these tests use only its interface on a temporary folder.
const complete = "REVIEW_STATUS: complete\nDefects: none\nValidation gaps: none.\n";
const withShould = "REVIEW_STATUS: complete\nDefects:\n- Spec: f.txt:1 P2 a should with its evidence.\n- Spec: f.txt:2 P3 a nit.\n";

function temp(t: { after: (fn: () => void) => void }, prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A git repo with commits one, two and three on main; returns their heads.
function repo(t: { after: (fn: () => void) => void }) {
  const dir = temp(t, "kit-records-git-");
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=T", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).stdout.trim();
  git("init", "-q", "-b", "main");
  const heads = ["one", "two", "three"].map(name => { writeFileSync(join(dir, "f.txt"), `${name}\n`); git("add", "."); git("commit", "-qm", name); return git("rev-parse", "HEAD"); });
  return { dir, git, heads };
}

// Saves one review the way kit review does: a temporary run folder (out.md, refs.txt) through saveReview into a new record folder.
function save(reviews: string, owner: string, { head, base, report = complete, record = {}, look = null }: { head: string; base: string; report?: string; record?: object; look?: object | null }) {
  const run = mkdtempSync(join(tmpdir(), "kit-records-run-"));
  writeFileSync(join(run, "out.md"), report);
  writeFileSync(join(run, "refs.txt"), `${head}\n${base}\n`);
  let folder = "";
  saveReview(run, () => { folder = createReviewFolder(reviews, owner); if (look) markSecondLook(folder, { ...look, ok: false }); return folder; }, () => record);
  if (look) markSecondLook(folder, { ...look, ok: true });
  return folder;
}

test("the records live under the main checkout's .scratch/reviews, one folder per owner and UTC stamp, a suffix on a clash", t => {
  const root = temp(t, "kit-records-");
  const reviews = reviewsFolder(root);
  assert.equal(reviews, join(root, ".scratch/reviews"));
  const first = createReviewFolder(reviews, "fleet-lead"), second = createReviewFolder(reviews, "fleet-lead");
  assert.match(first, new RegExp(`^${join(reviews, "fleet-lead")}/\\d{8}T\\d{6}Z(?:-\\d+)?$`));
  assert.notEqual(first, second);
  assert.ok(existsSync(first) && existsSync(second));
});

test("a saved review keeps its report, refs and findings record, and its report is read back by its path", t => {
  const reviews = reviewsFolder(temp(t, "kit-records-"));
  const folder = save(reviews, "builder", { head: "a1", base: "b1", record: { round: 1, findings: [] } });
  assert.deepEqual(readdirSync(folder).sort(), ["findings.json", "refs.txt", "result.md"]);
  assert.equal(reviewReportPath(folder), join(folder, "result.md"));
  assert.equal(readReviewReport(folder), complete);
  assert.equal(reviewIncomplete(folder), false);
  writeFileSync(join(folder, "findings.json"), JSON.stringify({ incomplete: true }));
  assert.equal(reviewIncomplete(folder), true);
  assert.throws(() => readReviewReport(join(reviews, "builder", "nowhere")), { code: "ENOENT" });
});

test("a second look's mark: the mark it saved, null for Claude's review, and an unreadable mark still counts as a second look", t => {
  const reviews = reviewsFolder(temp(t, "kit-records-"));
  const claude = save(reviews, "builder", { head: "a1", base: "b1" });
  const look = save(reviews, "builder", { head: "a1", base: "b1", look: { kind: "code", model: "grok-4.7", branch: "feature", pr: "7" } });
  assert.equal(secondLookMark(claude), null);
  assert.deepEqual(secondLookMark(look), { kind: "code", model: "grok-4.7", branch: "feature", pr: "7", ok: true });
  assert.equal(readFileSync(join(look, "second-look.json"), "utf8"), `${JSON.stringify({ kind: "code", model: "grok-4.7", branch: "feature", pr: "7", ok: true })}\n`);
  writeFileSync(join(look, "second-look.json"), "{ not json");
  assert.deepEqual(secondLookMark(look), {});
});

test("the review that covers a head: a complete review of this head and base, Claude's or a second look that came back, never an incomplete one", async t => {
  const reviews = reviewsFolder(temp(t, "kit-records-"));
  const patchId = async () => "0".repeat(40);
  const options = (second = false) => ({ head: "h1", base: "b1", patchId, ticket: undefined, root: "/nowhere", second, reviewable: "h1" });
  assert.equal(await coveringReview(reviews, "builder", options()), undefined, "no folder yet");
  const look = save(reviews, "builder", { head: "h1", base: "b1", look: { kind: "code", model: "grok-4.7" } });
  assert.equal(await coveringReview(reviews, "builder", options()), undefined, "a second look never stands for Claude's review");
  assert.deepEqual(await coveringReview(reviews, "builder", options(true)), { folder: look, samePatch: false });
  const claude = save(reviews, "builder", { head: "h1", base: "b1" });
  assert.deepEqual(await coveringReview(reviews, "builder", options()), { folder: claude, samePatch: false });
  assert.equal(await coveringReview(reviews, "lead", options()), undefined, "another owner's review is not this owner's");
  writeFileSync(join(claude, "findings.json"), JSON.stringify({ incomplete: true }));
  assert.equal(await coveringReview(reviews, "builder", options()), undefined, "an incomplete round is never reused");
  writeFileSync(join(look, "second-look.json"), JSON.stringify({ kind: "code", model: "grok-4.7", ok: false }));
  assert.equal(await coveringReview(reviews, "builder", options(true)), undefined, "a second look that did not come back is none");
});

test("a review with nothing but nits carries over to the same patch on a new base; one with a should does not", async t => {
  const reviews = reviewsFolder(temp(t, "kit-records-"));
  const patchId = async () => "a".repeat(40);
  const options = { head: "h2", base: "b2", patchId, ticket: undefined, root: "/nowhere", second: false, reviewable: "h2" };
  save(reviews, "builder", { head: "h1", base: "b1", report: withShould });
  assert.equal(await coveringReview(reviews, "builder", options), undefined);
  const nits = save(reviews, "builder", { head: "h1", base: "b1", report: "REVIEW_STATUS: complete\nDefects:\n- Spec: f.txt:2 P3 a nit.\n" });
  assert.deepEqual(await coveringReview(reviews, "builder", options), { folder: nits, samePatch: true });
});

test("the findings above P3 an owner's reviews left at a commit, with the ids the records gave them (SL-<n> for a second look)", t => {
  const reviews = reviewsFolder(temp(t, "kit-records-"));
  save(reviews, "lead", { head: "c1", base: "b1", report: withShould, record: { round: 2, findings: [{ id: "R2-1" }, { id: "R2-2" }] } });
  save(reviews, "lead", { head: "c1", base: "b1", report: withShould, look: { kind: "code", model: "grok-4.7" } });
  save(reviews, "lead", { head: "c2", base: "b1", report: withShould });
  save(reviews, "builder", { head: "c1", base: "b1", report: withShould });
  const seen = findingsSeenAt(reviews, "lead", "c1");
  assert.deepEqual([...seen].map(entry => entry.split("\n")[0]).sort(), ["R2-1", "SL-1"]);
  assert.match([...seen][0], /\n.*a should with its evidence/);
  assert.equal(findingsSeenAt(reviews, "nobody", "c1").size, 0);
});

test("the earlier round a review answers is found in the owner's own folder or in another owner's review of the same branch", t => {
  const { dir, heads } = repo(t);
  const reviews = reviewsFolder(dir);
  const options = (branch: string) => ({ head: heads[2], base: heads[0], root: dir, branch });
  const record = (round: number, branch: string) => ({ round, branch, model: "m", head: heads[1], findings: [{ id: `R${round}-1`, group: "Spec", severity: "P2", kind: "fault", text: "a should" }] });
  assert.equal(previousReview(reviews, "lead", options("feature")), null, "no records yet");
  save(reviews, "builder", { head: heads[1], base: heads[0], report: withShould, record: record(1, "feature") });
  const found = previousReview(reviews, "lead", options("feature"));
  assert.equal(found?.round, 1);
  assert.match(found?.name ?? "", /^\.\.\/builder\/\d{8}T\d{6}Z/);
  assert.equal(previousReview(reviews, "lead", options("other")), null, "another branch is never answered");
});

test("one GPT second look per PR: a GPT look that came back for this PR, or this branch's own work, counts; other looks do not", t => {
  const { dir, git, heads } = repo(t);
  const reviews = reviewsFolder(dir);
  const options = (pr: string | undefined, branch = "feature") => ({ pr, branch, root: dir, head: heads[2], base: heads[0] });
  save(reviews, "builder", { head: heads[1], base: heads[0], look: { kind: "code", model: "grok-4.7", branch: "feature", pr: "7" } });
  assert.equal(gptLookDone(reviews, options("7")), null, "a Grok look is not GPT's");
  const failed = save(reviews, "builder", { head: heads[1], base: heads[0], look: { kind: "code", model: "gpt-6.1-sol", branch: "feature", pr: "7" } });
  writeFileSync(join(failed, "second-look.json"), JSON.stringify({ kind: "code", model: "gpt-6.1-sol", branch: "feature", pr: "7", ok: false }));
  assert.equal(gptLookDone(reviews, options("7")), null, "a look that did not come back does not count");
  const gpt = save(reviews, "lead", { head: heads[1], base: heads[0], look: { kind: "code", model: "gpt-6.1-sol", branch: "feature", pr: "7" } });
  assert.equal(gptLookDone(reviews, options("7")), gpt, "any owner's look for this PR");
  assert.equal(gptLookDone(reviews, options("8")), null, "both name a PR, and another one");
  // No PR named: the branch's look counts while its own work is in this head.
  assert.equal(gptLookDone(reviews, options(undefined)), gpt);
  assert.equal(gptLookDone(reviews, options(undefined, "other")), null);
  git("checkout", "-q", "-b", "fresh", heads[0]);
  assert.equal(gptLookDone(reviews, { ...options(undefined), head: git("rev-parse", "HEAD") }), null, "work not in this head leaves the new PR its own look");
  assert.equal(gptLookDone(reviewsFolder(join(dir, "missing")), options("7")), null);
});
