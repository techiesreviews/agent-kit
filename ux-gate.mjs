// The UX check before a visible change lands: kit ux saves its result for the branch with the visible files as it
// checked them, and kit pr reads it. Every screen change gets the automatic UX check (Lex, TOOLS-235, 2026-11-14).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { visiblePath } from "./pr-tier.mjs";

/** The feature list kit ux reads; a project without it has nothing kit ux can try. */
export const uxFeatureList = "docs/agents/features.md";

const resultFile = (mainRoot, branch) => join(mainRoot, ".scratch/ux-results", `${encodeURIComponent(branch)}.json`);

/**
 * The visible change of a checkout: each path a person can see (`paths.visible`) that differs from the merge-base with
 * `base`, unsaved and untracked files included, with the hash of its text as it is now ("gone" for a deleted one). The
 * same change gives the same answer before and after it is committed or rebased, so a result stays good until a
 * visible file changes.
 */
export function visibleFiles(root, base, settings) {
  const git = (args, input) => execFileSync("git", ["-C", root, "-c", "core.quotePath=false", ...args], { encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  const mergeBase = git(["merge-base", "HEAD", base]).trim();
  const changed = [...git(["diff", "--name-only", "--no-renames", "-z", mergeBase]).split("\0"), ...git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")];
  const paths = [...new Set(changed)].filter(path => path && visiblePath(path, settings)).sort();
  const kept = paths.filter(path => statSync(join(root, path), { throwIfNoEntry: false })?.isFile());
  const hashes = kept.length ? git(["hash-object", "--stdin-paths"], `${kept.join("\n")}\n`).trim().split("\n") : [];
  return Object.fromEntries(paths.map(path => [path, kept.includes(path) ? hashes[kept.indexOf(path)] : "gone"]));
}

/**
 * Saves kit ux's result for a branch: { branch, head, files, ok, summary, partial, bundle }, and `nothing: true` when no
 * listed feature covered the change, so nothing was tried. The newest one counts.
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
 * whether the project has the feature list kit ux reads.
 */
export function uxGuard({ branch, files, record, notVisible, featureList }) {
  const paths = Object.keys(files).sort();
  if (!paths.length) return { ok: true };
  const mine = record && record.branch === branch ? record : null;
  const at = String(mine?.head ?? "").slice(0, 7) || "an unknown commit";
  const moved = mine && [...new Set([...paths, ...Object.keys(mine.files)])].sort().find(path => files[path] !== mine.files[path]);
  // kit ux tried exactly this change and it did not pass: a person does see it, so no reason makes it "not visible".
  const failed = mine && !moved && !mine.partial && mine.ok !== true;
  if (notVisible && failed) return { ok: false, line: `UX check: failed (kit ux at ${at}: ${mine.summary})`,
    problem: "kit ux tried this change and it did not pass, so --not-visible does not fit it; fix what kit ux found and run `scripts/agents/kit ux` again" };
  if (notVisible) return { ok: true, line: `UX check: not visible (${notVisible.replace(/\s*[\r\n]+\s*/g, " ").trim()}); ${paths[0]} is a visible path` };
  if (!featureList) return { ok: true, line: `UX check: skipped (no ${uxFeatureList}, so kit ux has nothing to try); ${paths[0]} is visible` };
  if (!mine) return { ok: false, line: `UX check: missing; ${paths[0]} is visible`,
    problem: 'visible change without a kit ux result; run `scripts/agents/kit ux`, or pass --not-visible "<reason>" when the change shows a person nothing new' };
  if (moved) return { ok: false, line: `UX check: out of date; ${moved} changed since kit ux ran at ${at}`,
    problem: `the visible change is not the one kit ux checked (${moved} changed since it ran at ${at}); run \`scripts/agents/kit ux\` again` };
  if (mine.partial) return { ok: false, line: `UX check: partial; kit ux ran with ${mine.partial}`,
    problem: `kit ux ran with ${mine.partial}, so it did not check the whole change; run \`scripts/agents/kit ux\` without it` };
  if (failed) return { ok: false, line: `UX check: failed (kit ux at ${at}: ${mine.summary})`,
    problem: "kit ux did not pass for this change; fix what it found and run `scripts/agents/kit ux` again" };
  // No feature in the list covers the changed files, so kit ux tried and reviewed nothing: it lands, as it did in kit
  // slice, but the PR never calls that "ok".
  if (mine.nothing) return { ok: true, line: `UX check: nothing to try (kit ux at ${at}: no feature in ${uxFeatureList} covers ${paths[0]})` };
  return { ok: true, line: `UX check: ok (kit ux at ${at}: ${mine.summary})` };
}
