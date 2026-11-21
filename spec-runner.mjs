// kit pr's browser specs (ticket ke-88): one full run per machine at a time, the timing files after it, and a
// failed file the change did not touch rerun alone. kit pr hands in how to run kit and take a machine lock, so the
// steps here are tested without a project or a real browser.
import { appendFileSync, mkdirSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname } from "node:path";
import { failedSpecs, isTiming, listedSpecs, nothingSelected, timingList, wholeReport } from "./browser-runs.mjs";

/**
 * The browser specs of one landing, as lines for the PR body, and the files forgiven as flaky under load.
 *
 * One full run per machine at a time (the full-run lock in the kit's state folder, waited for). With a `timing` list
 * (which needs a specs command that answers --list; others may not) the selection is listed first: nothing selected
 * takes no lock, and the timing files run after the rest, each alone. A failed file the change did not touch is
 * rerun once alone. Both alone kinds hold the quiet lock, so no other kit job starts meanwhile. A file that passes
 * alone is flaky under load: named, logged to flaky.jsonl, forgiven; but only when the run reported every file it
 * ran, so a crash is never forgiven. Throws one line naming the failed files.
 *
 * io.list(argv): runs `kit <argv>` and returns its output, throwing when it fails.
 * io.exec(argv, extraEnv): runs `kit <argv>` and returns { status, text, stderr, failure }.
 * io.failure(ran): a failed run's message.
 * io.machineLock(name, { onWait }): a machine-wide lock, { missing, release }.
 * io.flakyLog: the flaky.jsonl path; io.record: what each of its lines names besides the file (project, owner, branch).
 */
export async function runSpecs({ changes, settings, base: baseBranch, io, log = console.log }) {
  const timing = timingList(settings), base = ["specs", "--affected", "--base", `origin/${baseBranch}`];
  const lines = [], failed = [], flaky = [], touched = new Set(changes.map(change => change.path));
  const result = text => text.split(/\r?\n/).findLast(line => line.startsWith("RESULT: ")) || "ok";
  let main = base, alone = [], listed;
  if (timing.length) {
    const list = await io.list([...base, "--list"]);
    listed = listedSpecs(list);
    // An empty list counts as nothing selected only when the command says so; any other output is unreadable.
    if (!listed.length && !nothingSelected(list)) throw new Error(`kit specs --list named no spec files and did not say none were selected (${result(list)})`);
    if (!listed.length) return { lines: [`- kit ${base.join(" ")}: ${result(list)}`], flaky };
    alone = listed.filter(file => isTiming(file, timing));
    if (alone.length) main = listed.length > alone.length ? ["specs", ...listed.filter(file => !alone.includes(file))] : null;
  }
  // While the quiet lock is held, every run says so to the kit jobs it starts (KIT_QUIET_HOLDER).
  let quiet;
  const quietEnv = () => quiet ? { KIT_QUIET_HOLDER: String(process.pid) } : undefined;
  // A run's failed files, with the highest load seen while it ran; a failed run that did not report every file
  // it ran (a crash, a server that never started) fails as before.
  const check = async (argv, label, expected) => {
    let peak = loadavg()[0];
    const timer = setInterval(() => { peak = Math.max(peak, loadavg()[0]); }, 5_000);
    let ran;
    try { ran = await io.exec(argv, quietEnv()); } finally { clearInterval(timer); }
    lines.push(`- kit ${label}: ${result(ran.text)}`);
    if (ran.status === 0) return [];
    const files = failedSpecs(ran.text);
    if (!files.length || !wholeReport(ran.text, expected)) throw new Error(io.failure(ran));
    return files.map(file => ({ ...file, load: Math.max(peak, loadavg()[0]) }));
  };
  const blame = file => failed.push(`${file} (this change touches it)`);
  // A machine without flock runs the specs as before, unlocked, and says so.
  const noFlock = () => {
    const line = "specs: problem: flock is not installed, so browser runs are not kept one at a time (install util-linux)";
    if (!lines.includes(`- ${line.slice("specs: ".length)}`)) { log(line); lines.push(`- ${line.slice("specs: ".length)}`); }
  };
  const full = await io.machineLock("browser-run", { onWait: owner => log(`specs: waiting for ${owner}'s full browser run`) });
  if (full.missing) noFlock();
  try {
    const retry = [];
    if (main) {
      const expected = main === base ? listed : main.slice(1);
      const label = main === base ? base.join(" ") : `specs <${main.length - 1} affected files without the timing ones>`;
      for (const file of await check(main, label, expected)) {
        if (touched.has(file.file)) blame(file.file);
        else retry.push({ ...file, where: "the full run" });
      }
    }
    const holdQuiet = async () => {
      if (quiet) return;
      quiet = await io.machineLock("quiet", { onWait: owner => log(`specs: waiting for ${owner}'s lone browser run`) });
      if (quiet.missing) noFlock();
    };
    // Once a touched file failed the run fails anyway: no lone runs to hold other kit jobs back for.
    const notRun = [];
    for (const [index, file] of alone.entries()) {
      if (failed.length) { notRun.push(...alone.slice(index)); break; }
      await holdQuiet();
      const [first] = await check(["specs", file], `specs ${file} (timing, alone)`, [file]);
      if (!first) continue;
      if (touched.has(file)) blame(file);
      else retry.push({ ...first, file, where: "its timing run" });
    }
    const skipped = failed.length ? retry.splice(0) : [];
    for (const file of retry) {
      await holdQuiet();
      const again = await io.exec(["specs", file.file], quietEnv());
      if (again.status !== 0 || !wholeReport(again.text, [file.file])) { failed.push(`${file.file} (failed alone too)`); continue; }
      const load = Number(file.load.toFixed(2));
      log(`specs: flaky under load: ${file.file} (failed in ${file.where} at load ${load}, passed alone)`);
      lines.push(`- flaky under load: ${file.file} (failed in ${file.where}, passed alone)`);
      flaky.push(file.file);
      mkdirSync(dirname(io.flakyLog), { recursive: true });
      appendFileSync(io.flakyLog, `${JSON.stringify({ time: new Date().toISOString(), project: settings.project,
        file: file.file, test: file.test, load, ...io.record })}\n`);
    }
    failed.push(...skipped.map(file => `${file.file} (not rerun)`), ...notRun.map(file => `${file} (timing, not run)`));
  } finally {
    await quiet?.release();
    await full.release();
  }
  if (failed.length) throw new Error(`${failed.length} spec file${failed.length === 1 ? "" : "s"} failed: ${failed.join(", ")}`);
  return { lines, flaky };
}
