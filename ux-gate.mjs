// The UX check before a visible change lands: kit ux saves its result for the branch with the visible files as it
// checked them, and kit pr reads it. Every screen change gets the automatic UX check (Lex, TOOLS-235, 2026-11-14).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { visiblePath } from "./pr-tier.mjs";

/** The feature list kit ux reads; a project without it has nothing kit ux can try. */
export const uxFeatureList = "docs/agents/features.md";

const resultFile = (mainRoot, branch) => join(mainRoot, ".scratch/ux-results", `${encodeURIComponent(branch)}.json`);

const gitIn = root => (args, input) => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
/** Every path that differs from the merge-base with `base`, unsaved and untracked files included, sorted. */
function changedPaths(root, base) {
  const git = gitIn(root), mergeBase = git(["merge-base", "HEAD", base]).trim();
  const changed = [...git(["diff", "--name-only", "--no-renames", "-z", mergeBase]).split("\0"), ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")];
  return [...new Set(changed)].filter(Boolean).sort();
}

/**
 * The visible change of a checkout: each path a person can see (`paths.visible`) that differs from the merge-base with
 * `base`, unsaved and untracked files included, with the hash of its text as it is now ("gone" for a deleted one). The
 * same change gives the same answer before and after it is committed or rebased, so a result stays good until a
 * visible file changes.
 */
export function visibleFiles(root, base, settings) {
  const paths = changedPaths(root, base).filter(path => visiblePath(path, settings));
  const kept = paths.filter(path => statSync(join(root, path), { throwIfNoEntry: false })?.isFile());
  const hashes = kept.length ? gitIn(root)(["hash-object", "--stdin-paths"], `${kept.join("\n")}\n`).trim().split("\n") : [];
  return Object.fromEntries(paths.map(path => [path, kept.includes(path) ? hashes[kept.indexOf(path)] : "gone"]));
}

const backticked = value => [...(value ?? "").matchAll(/`([^`]+)`/g)].map(match => match[1]);

/** Feature entries of docs/agents/features.md, outside code fences. */
export function parseFeatures(markdown) {
  const features = [];
  let current, fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) { fenced = !fenced; current = undefined; continue; }
    if (fenced) continue;
    const heading = /^### (F-[a-z]+-\d{2}) (\S.*)$/.exec(line);
    if (heading) { current = { id: heading[1], name: heading[2], fields: {} }; features.push(current); continue; }
    if (line.startsWith("#")) { current = undefined; continue; }
    const field = current && /^- ([A-Za-z]+): (\S.*)$/.exec(line);
    if (field) current.fields[field[1]] = field[2];
  }
  return features.map(({ id, name, fields }) => ({
    id, name, try: fields.Try ?? "", good: fields.Good ?? "", files: backticked(fields.Files),
    phone: fields.Phone === "yes", steps: backticked(fields.Steps)[0] ?? null,
  }));
}

/** Features whose Files globs match a changed path, each with the paths that matched. */
export function touchedFeatures(features, changed) {
  return features.flatMap(feature => {
    const matched = changed.filter(path => feature.files.some(glob => matchesGlob(path, glob)));
    return matched.length ? [{ ...feature, matched }] : [];
  });
}

/**
 * One hash over the listed features that cover the change (those whose Files globs match a changed path), each with
 * its whole entry; null when the project has no feature list. It moves when a feature that covers the change is added,
 * dropped or edited, and stays when the list changes about other features, as it does with most visible PRs that land.
 */
export function coverageHash(root, base) {
  let list;
  try { list = readFileSync(join(root, uxFeatureList), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  // By id, so two covering entries that only swap places in the list change nothing.
  const covering = touchedFeatures(parseFeatures(list), changedPaths(root, base)).map(({ matched: _matched, ...feature }) => feature)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(covering)).digest("hex");
}

/**
 * Saves kit ux's result for a branch: { branch, head, files, list, ok, summary, partial, bundle }, where `list` is the
 * hash of the features that covered the change (coverageHash), and `nothing: true` when none did, so nothing was
 * tried. The newest one counts.
 */
export function saveUxResult(mainRoot, record) {
  const file = resultFile(mainRoot, record.branch), temporary = `${file}.${process.pid}.tmp`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2)}\n`);
  renameSync(temporary, file);
}

/** The result kit ux last saved for a branch; null when there is none, or it cannot be read. */
export function readUxResult(mainRoot, branch) {
  try {
    const record = JSON.parse(readFileSync(resultFile(mainRoot, branch), "utf8"));
    return record && typeof record === "object" && record.files && typeof record.files === "object" ? record : null;
  } catch { return null; }
}

/**
 * The UX guard for a PR: { ok, line, problem } where `line` is the PR body note (none when nothing visible changed)
 * and `problem` says what to do when it is refused. `files` is the PR's visible change (visibleFiles), `record` the
 * result kit ux saved for the branch, `notVisible` the reason given with `kit pr --not-visible`, and `featureList`
 * the hash of the listed features that cover the change as they are now (coverageHash), null when the project has no
 * feature list.
 */
export function uxGuard({ branch, files, record, notVisible, featureList }) {
  const paths = Object.keys(files).sort();
  if (!paths.length) return { ok: true };
  const mine = record && record.branch === branch ? record : null;
  const at = String(mine?.head ?? "").slice(0, 7) || "an unknown commit";
  // What kit ux read is what lands: the visible files, and the listed features that cover the change (a feature added
  // for it after kit ux ran was never tried).
  const file = mine && [...new Set([...paths, ...Object.keys(mine.files)])].sort().find(path => files[path] !== mine.files[path]);
  const moved = file ? `${file} changed` : mine && featureList && (mine.list ?? null) !== featureList ? `the features in ${uxFeatureList} that cover the change are not the ones kit ux tried at ${at}` : null;
  // kit ux tried exactly this change and it did not pass, in a whole run or a partial one: a person does see it, so no
  // reason makes it "not visible".
  const failed = mine && !moved && mine.ok !== true;
  if (notVisible && failed) return { ok: false, line: `UX check: failed (kit ux at ${at}: ${mine.summary})`,
    problem: "kit ux tried this change and it did not pass, so --not-visible does not fit it; fix what kit ux found and run `scripts/agents/kit ux` again" };
  if (notVisible) return { ok: true, line: `UX check: not visible (${notVisible.replace(/\s*[\r\n]+\s*/g, " ").trim()}); ${paths[0]} is a visible path` };
  if (!featureList) return { ok: true, line: `UX check: skipped (no ${uxFeatureList}, so kit ux has nothing to try); ${paths[0]} is visible` };
  if (!mine) return { ok: false, line: `UX check: missing; ${paths[0]} is visible`,
    problem: 'visible change without a kit ux result; run `scripts/agents/kit ux`, or pass --not-visible "<reason>" when the change shows a person nothing new' };
  if (file) return { ok: false, line: `UX check: out of date; ${file} changed since kit ux ran at ${at}`,
    problem: `the visible change is not the one kit ux checked (${file} changed since it ran at ${at}); run \`scripts/agents/kit ux\` again` };
  if (moved) return { ok: false, line: `UX check: out of date; ${moved}`, problem: `${moved}; run \`scripts/agents/kit ux\` again` };
  if (mine.partial) return { ok: false, line: `UX check: partial; kit ux ran with ${mine.partial}`,
    problem: `kit ux ran with ${mine.partial}, so it did not check the whole change; run \`scripts/agents/kit ux\` without it` };
  if (failed) return { ok: false, line: `UX check: failed (kit ux at ${at}: ${mine.summary})`,
    problem: "kit ux did not pass for this change; fix what it found and run `scripts/agents/kit ux` again" };
  // No feature in the list covers the changed files, so kit ux tried and reviewed nothing: it lands, as it did in kit
  // slice, but the PR never calls that "ok".
  if (mine.nothing) return { ok: true, line: `UX check: nothing to try (kit ux at ${at}: no feature in ${uxFeatureList} covers ${paths[0]})` };
  return { ok: true, line: `UX check: ok (kit ux at ${at}: ${mine.summary})` };
}
