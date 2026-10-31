// Full browser runs on a busy machine (ticket ke-88): kit pr reads the project's `kit specs` output to rerun a
// failed file alone, splits off the settings' `timing` files to run last and alone, and kit status names the files
// that keep passing only alone (`<kit state>/flaky.jsonl`).

/** Days kit status looks back in flaky.jsonl, and how many flaky runs in that time ask for a fix. */
export const FLAKY_DAYS = 7, FLAKY_REPORT_AT = 3;

/** The files `kit specs … --list` selected: each selection line starts `<file> [<groups>]`. */
export function listedSpecs(text) {
  return text.split(/\r?\n/).map(line => /^(\S+) \[[^\]]*\]/.exec(line)?.[1]).filter(Boolean);
}

/** The failed files of a `kit specs` run, each with its first failed test: `✗ <file>: <test> — <error>`. */
export function failedSpecs(text) {
  const failed = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^✗ (\S+?): (.*?)(?: — .*)?$/.exec(line);
    if (match && !failed.has(match[1])) failed.set(match[1], { file: match[1], test: match[2].trim() });
  }
  return [...failed.values()];
}

/**
 * Whether a failed run reported every file it ran, so its failures can be told apart from a crash: each expected
 * file has a `✓ <file>` or `✗ <file>:` line; with no expected list, its `RESULT: fail specs N of M failed` line
 * counts the ✗ files as N and every reported file as M.
 */
export function wholeReport(text, expected) {
  const seen = new Set(), failed = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([✓✗]) (\S+?)(?::| \(|$)/.exec(line);
    if (!match) continue;
    seen.add(match[2]);
    if (match[1] === "✗") failed.add(match[2]);
  }
  if (expected) return expected.every(file => seen.has(file));
  const counts = /^RESULT: fail specs (\d+) of (\d+) failed\b/m.exec(text);
  return Boolean(counts) && Number(counts[1]) === failed.size && Number(counts[2]) === seen.size;
}

/** The settings' `timing` list (spec files that measure speed or memory); none when unset. */
export function timingList(settings) {
  const timing = settings.timing;
  if (timing === undefined) return [];
  if (!Array.isArray(timing) || !timing.every(item => typeof item === "string" && item.trim()))
    throw new Error('"timing" in scripts/agents/kit.json must be a list of spec files');
  return timing.map(item => item.trim());
}

/** Whether a spec file is on the timing list, named by its path, its file name, or its name without `.spec.<ext>`. */
export function isTiming(file, timing) {
  const name = file.slice(file.lastIndexOf("/") + 1), bare = name.replace(/\.spec\.[^.]+$/, "");
  return timing.some(item => item === file || item === name || (bare !== name && item === bare));
}

/** This project's files flaky under load at least FLAKY_REPORT_AT times in the last FLAKY_DAYS, most first. */
export function flakyFiles(text, { project, now = Date.now(), days = FLAKY_DAYS, at = FLAKY_REPORT_AT } = {}) {
  const counts = new Map(), since = now - days * 86_400_000;
  for (const line of text.split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // A torn or foreign line counts for nothing.
    const time = Date.parse(entry?.time);
    if (entry?.project !== project || typeof entry.file !== "string" || !(time >= since && time <= now)) continue;
    counts.set(entry.file, (counts.get(entry.file) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= at).map(([file, count]) => ({ file, count }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}
