// A kit review run (kit review, and kit pr in its own process): the review or the second look, with its output written
// through `io` ({ out(text), err(text) }, raw text as a child's stdout and stderr would carry it) and its outcome returned.
// kit.d/review prints the outcome's RESULT line (resultLine) and exits with its code; kit pr reads the outcome itself.
//
// An outcome: { exit, status, text, evidence, nothing, notes, skipped }.
// - exit: kit review's exit code (0 ok, 1 failed, 3 skipped); status: "ok", "fail" or "skip"; text: the RESULT line's words.
// - evidence: the saved review's folder, for a review that came back.
// - nothing: "<scope> is empty" for a review with nothing to review.
// - notes: the second look's own "second look: …" lines (its kind, model, models not used, handovers, a skip).
// - skipped: the second look's "second look: skipped (<reason>)" line, when no model could take it.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inferCli, opencodeModelRuns, parseAgentArgs, plainCode, releaseReviewBudget, reserveReviewBudget } from "./agent-run.mjs";
import { reviewBrief, reviewScope, ticketReviewBrief } from "./review-brief.mjs";
import { countsLine, findingsRecord } from "./review-findings.mjs";
import { createReviewFolder, gptLookDone, markSecondLook, previousReview, reviewsFolder, saveReview } from "./review-records.mjs";
import { branchRisk, loopBriefSection, loopReviewerNote, parseMarks, roundLimit, unmarkedIds } from "./review-loop.mjs";
import { docsOnly as docsOnlyChange, lookFamily, parseChanges, reviewKinds, secondLookEffort, secondLookPick, secondLookTable } from "./pr-tier.mjs";
import { durationMilliseconds } from "./sol-run.mjs";

const { kitBranch, kitGhEnv, kitHideUserInfo, kitRoot, kitMainRoot, kitOwner, kitSettings, kitStateDir, nodeEnv, kitScore, scoreReview } = await import(
  pathToFileURL(process.env.KIT_LIB_MJS || resolve(import.meta.dirname, "kit-lib.mjs")).href
);

/** The RESULT line kit review prints for an outcome (an ok or failed one as kitResult prints it). */
export function resultLine({ status, text }) {
  return `RESULT: ${status} ${status === "skip" ? text : kitHideUserInfo(String(text).replace(/[\n\r]/g, " "))}`;
}

/** The terminal's own streams, for kit review. */
export const processIo = { out: text => process.stdout.write(text), err: text => process.stderr.write(text) };

// A Grok outage: one of the run log's last five lines starts with an HTTP 5xx status or a connection error
// (only such closing lines, so a review or tool trace that names one is not matched). Returns that line or null.
const outagePattern = /^(?:error:|■)?[\t ]*(?:(?:(?:HTTP|status)[\t ]*)?5\d\d\b.*|(?:\w*Error:[\t ]*)?(?:(?:connect|read|write|getaddrinfo)[\t ]+)?(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b.*)$/i;
function grokDown(temporary) {
  let log = "";
  try { log = readFileSync(join(temporary, "run.log"), "utf8"); } catch { return null; }
  return log.split(/\r?\n/).filter(line => line.trim()).slice(-5).reverse().map(line => line.trim()).find(line => outagePattern.test(line)) ?? null;
}

// The label of a scope whose diff is empty (a no-code merge), or null when it has changes or cannot be read: a bad ref or
// settings problem is left to the review itself, which reports it as before.
function emptyScope(flags) {
  try {
    const root = kitRoot();
    const scope = reviewScope("", { base: flags.base ?? (flags.commit === undefined ? `origin/${kitBranch()}` : undefined), commit: flags.commit }, root);
    const same = spawnSync("git", ["-C", root, "diff", "--quiet", ...(scope.commit ? [scope.base, scope.head] : [`${scope.base}...${scope.head}`])], { stdio: "ignore" });
    return same.status === 0 ? scope.label : null;
  } catch { return null; }
}

// One review run, writing all but its RESULT line. A second look (`look`: { kind, model, effort }) sets the
// model, its CLI and any effort, so no ASE_AGENT_CLI can redirect it, and marks its evidence folder with the
// branch and PR it looked at (one GPT second look per PR is told from these marks).
async function reviewOnce(flags, look, io) {
  const say = line => io.out(`${line}\n`), problem = line => io.err(`problem: ${line}\n`);
  let evidence = "none", temporary, status = 1, reason = "review failed", label, budget, env, model, effort, reviewedHead, branchName = "";
  let previous = null, round = 1, loopMeta = {}, sinceHead = null, ledger, outOfCredit = false, kept = false, spawned = false, unavailable = false, stderr = "", timedOut = false;
  const ticket = flags.ticket;
  try {
    // The default base comes from the settings file; a settings problem is a failure, not a usage error.
    if (flags.base === undefined && flags.commit === undefined) flags.base = `origin/${kitBranch()}`;
    const root = kitRoot();
    env = nodeEnv();
    if (look) Object.assign(env, { ASE_REVIEW_MODEL: look.model, ASE_AGENT_CLI: inferCli(look.model) ?? "" });
    const scope = reviewScope("", flags, root);
    label = scope.label;
    reviewedHead = scope.head;
    say(`scope: ${flags.commit ? `--commit ${flags.commit}` : `--base ${flags.base}`} (${label})`);
    const artifacts = join(root, ".scratch/agent");
    mkdirSync(artifacts, { recursive: true });
    temporary = mkdtempSync(join(artifacts, "kit-review-"));
    const briefPath = join(temporary, "brief.md");
    const resolved = scope.commit ? { commit: scope.commit } : { base: scope.base };
    // A second look runs at the table's effort for its model, else medium; only the main review takes the high default.
    const agentArgs = ["review", root, briefPath, ...(scope.commit ? ["--commit", scope.commit] : ["--base", scope.base]), "--out", temporary, ...(look ? ["--effort", look.effort ?? "medium"] : [])];
    // The runner prepares "the changes since the last review" for a later round (set once that round is known, below).
    let cli;
    ({ model, effort, cli } = parseAgentArgs(agentArgs, env));
    // The brief names skills for the model that reviews (a second look's own).
    // Without a ticket, the skills map picks from the reviewed diff's file names.
    const changed = () => {
      const listed = spawnSync("git", ["-C", root, "diff", "--name-only", scope.commit ? `${scope.commit}^..${scope.commit}` : `${scope.base}...HEAD`], { encoding: "utf8" });
      return listed.status === 0 ? `## Files\n${listed.stdout.split("\n").filter(Boolean).map(file => `- \`${file}\``).join("\n")}\n` : "";
    };
    let brief = flags.ticket ? ticketReviewBrief(flags.ticket, resolved, root, undefined, true, model) : reviewBrief("", "", resolved, root, [], true, model, changed());
    // Review loop: round 1 is a full review; a later round reviews only what changed since the last reviewed head and the open ids.
    // A second look or a --commit review is never a loop round.
    branchName = spawnSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).stdout.trim();
    // Other owners' records too: a lead landing a builder's branch answers the builder's rounds (they must name this branch).
    previous = !look && !scope.commit ? previousReview(reviewsFolder(kitMainRoot()), kitOwner(), { head: scope.head, base: scope.base, root, branch: branchName }) : null;
    round = previous ? previous.round + 1 : 1;
    loopMeta = look || scope.commit ? {} : { round, ...(branchName ? { branch: branchName } : {}), ...(previous ? { previous: previous.name } : {}) };
    // Every round, the first included, carries the reviewer's loop rules; a later round with open ids adds its section.
    if (!look) brief += `\n${loopReviewerNote}\n`;
    if (previous && !previous.clean) {
      const { risky } = branchRisk({ root, base: scope.base, ticket: flags.ticket, settings: kitSettings(root) });
      sinceHead = previous.head !== scope.head ? previous.head : null;
      // Declined findings reach the brief once: ASE_REVIEW_DECLINED hands them over with the ticket (the cut kit fix set it) (the "Declined by the author" part), else the saved ones are listed.
      // Decided from the list that builds that part (what ASE_REVIEW_DECLINED handed over, used only with a ticket), never from the text, which a ticket may quote.
      let handed = [];
      try { const given = JSON.parse(process.env.ASE_REVIEW_DECLINED || "[]"); handed = Array.isArray(given) ? given : []; } catch { /* The brief builder already refused a bad list. */ }
      const declinedInBrief = Boolean(flags.ticket) && handed.length > 0;
      brief += `\n${loopBriefSection({ round, limit: roundLimit(risky), previousHead: previous.head, currentHead: scope.head, open: previous.findings, declined: declinedInBrief ? [] : previous.declined, declinedInBrief })}\n`;
      say(`review loop: round ${round}, answering ${previous.name} (${previous.findings.length} open findings)`);
    }
    if (sinceHead && previous && !previous.clean) agentArgs.push("--since", sinceHead);
    writeFileSync(briefPath, brief);
    say(`model: ${model}`);
    // One count for the computer; this project's old per-project count moves in on first use.
    ledger = { path: join(kitStateDir(env), "review-budget.json"), project: kitSettings(root).project, legacy: join(kitMainRoot(), ".scratch/review-budget.json") };
    try { budget = reserveReviewBudget(ledger, { cli, model }, env); }
    catch (error) { unavailable = /^\S+ review budget used up: /.test(error.message); throw error; }
    if (budget) say(`budget: ${budget.family} ${budget.used}/${budget.limit} in ${budget.week}`);
    spawned = true;
    status = await new Promise((accept, reject) => {
      const child = spawn(env.KIT_NODE, [resolve(import.meta.dirname, "agent-run.mjs"), ...agentArgs], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      const interrupt = () => child.kill("SIGINT");
      const terminate = () => child.kill("SIGTERM");
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", terminate);
      // A second look's overall limit: the runner stops its CLI's whole process group on SIGTERM.
      // A runner that already exited for its own reason keeps that reason.
      const limit = look?.deadline && setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        timedOut = true; terminate();
      }, Math.max(0, look.deadline - Date.now()));
      const clear = () => {
        clearTimeout(limit);
        process.removeListener("SIGINT", interrupt);
        process.removeListener("SIGTERM", terminate);
      };
      // Show the report; hide the temporary artifacts path, which is removed below once saved, or named if saving fails.
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop();
        for (const line of lines) if (!line.startsWith("artifacts: ")) io.out(`${line}\n`);
      });
      child.stdout.once("end", () => { if (pending && !pending.startsWith("artifacts: ")) io.out(`${pending}\n`); });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => { stderr += chunk; io.err(chunk); });
      child.once("error", error => { clear(); reject(error); });
      child.once("close", code => { clear(); accept(code === 0 ? 0 : 1); });
    });
    reason = timedOut ? `timed out after ${look.limit}` : [...stderr.matchAll(/^problem: (.+)$/gm)].at(-1)?.[1] || "review failed";
    // An empty account is a review that could not run, not one that failed.
    outOfCredit = status !== 0 && /^\S+ out of credit: /.test(reason);
    // A later round must mark every earlier id (resolved or still open); a review that leaves one out is incomplete.
    if (status === 0 && previous && !previous.clean) {
      const left = unmarkedIds(previous.findings.map(item => item.id), parseMarks(readFileSync(join(temporary, "out.md"), "utf8")));
      if (left.length) {
        status = 1;
        loopMeta = { incomplete: true };
        reason = `the review left out ${left.join(", ")}: every earlier finding must be marked resolved or still open`;
        problem(reason);
      }
    }
    if (!status && flags.pr) {
      const [head, base] = readFileSync(join(temporary, "refs.txt"), "utf8").trim().split("\n");
      const body = join(temporary, "pr-comment.md");
      const [headName, baseName] = scope.commit ? ["Commit", "Parent"] : ["HEAD", "Base"];
      writeFileSync(body, `${look ? `Second look: ${look.kind}\n` : ""}Model: ${model}\nScope: ${label}\n${headName}: ${head}\n${baseName}: ${base}\n\n${readFileSync(join(temporary, "out.md"), "utf8")}`);
      const posted = spawnSync("gh", ["pr", "comment", flags.pr, "--body-file", body], { cwd: root, env: kitGhEnv(env, root), encoding: "utf8" });
      if (posted.error || posted.status !== 0) throw new Error(`gh pr comment failed: ${posted.error?.message || posted.stderr.trim() || posted.status}`);
    }
  } catch (error) {
    reason = error.message;
    status = 1;
    problem(reason);
  } finally {
    try {
      // A review whose CLI never started (empty diff) is not counted; the runner
      // records the process group as soon as the CLI spawns. A provider usage-limit
      // refusal on the first call spent no review, so it gives the slot back; the
      // runner marks it only when the refusal was all that call printed. An out-of-credit
      // run that failed returned no complete review, so it is given back even after earlier turns,
      // and even when saving its evidence fails below: no review came back either way.
      const run = temporary && join(temporary, "status.json");
      const record = run && existsSync(run) ? JSON.parse(readFileSync(run, "utf8")) : {};
      // The model could not run: its CLI is missing (a spawn ENOENT) or not logged in (no Codex auth), refused or hit a usage limit, the account
      // is empty, or the provider is down (OpenCode's error event or no session within its start limit, a Grok
      // run whose closing lines are an HTTP 5xx or a connection error, or one that gave no answer before the
      // timeout: Grok prints its JSON only at the end), or the CLI crashed (a signal or an exit above 128) before it answered.
      // Any other failure, including any other one before the CLI started, is a broken run.
      const missing = status !== 0 && !record.pgid && /^problem: spawn (\S+) ENOENT$/m.exec(stderr)?.[1];
      const down = !missing && status !== 0 && /^grok failed \(\d+\)/.test(reason) && grokDown(temporary);
      const hung = !missing && status !== 0 && /^grok-/i.test(model) && /^agent exceeded timeout=([^;]+);/.exec(reason)?.[1];
      // OpenCode that opened no session within its start limit on the first call never reached the model;
      // the runner marks it only then, so a silent retry after a call that worked keeps its count.
      const silent = status !== 0 && record.silent === true;
      // The reviewer's CLI crashed on its first call (a signal, or an exit above 128) and came back with no review.
      const crashed = status !== 0 && record.crashed === true;
      if (missing || down || hung) {
        reason = missing ? `CLI missing: ${missing} ${plainCode("ENOENT")}` : down ? `grok unavailable: ${down}` : `grok unavailable: no answer within ${hung}`;
        problem(reason);
      }
      if (status !== 0 && spawned && (record.refused === true || outOfCredit || missing || down || hung || crashed ||
        /^\S+ usage limit\b|^OpenCode reported an error: |^opencode unavailable: no session within |^no Codex auth at /.test(reason))) unavailable = true;
      // An outage, like an empty account, returned no review, so its count is given back too.
      if (budget && (!record.pgid || record.refused === true || outOfCredit || down || silent || crashed)) releaseReviewBudget(ledger.path, budget, env);
    } catch (error) {
      kept = true;
      problem(`releasing review budget failed: ${error.message}`);
    }
    try {
      // A second look's folder is marked as soon as it exists, before any review file is copied in, so no
      // lookup ever takes it for Claude's review; `ok` turns true below only for a run that came back.
      const mark = ok => markSecondLook(evidence,
        { kind: look.kind, model, ok, ...(branchName ? { branch: branchName } : {}), ...(flags.pr ? { pr: flags.pr } : {}) });
      const { record, cleanup } = saveReview(temporary, () => {
        evidence = createReviewFolder(reviewsFolder(kitMainRoot()), kitOwner());
        if (look) mark(false);
        return evidence;
      }, text => findingsRecord(text, { model, effort, scope: label, head: reviewedHead, ...loopMeta }, previous?.findings ?? []));
      // The evidence is saved; a leftover temporary folder is reported but fails nothing.
      if (cleanup) problem(`removing ${temporary} failed: ${cleanup}`);
      if (record) {
        say(countsLine(record));
        kitScore({ ticket }, score => scoreReview(score, evidence));
      }
      if (look && status === 0 && !outOfCredit) mark(true);
    } catch (error) {
      status = 1;
      outOfCredit = false;
      unavailable = false;
      reason = `saving evidence failed: ${error.message}`;
      problem(reason);
      if (temporary) problem(`review files kept in ${temporary}`);
    }
  }
  // A run stopped at the limit whose evidence then failed to save fails like any failed save.
  return { status, outOfCredit, unavailable: status !== 0 && unavailable, timedOut: timedOut && /^timed out after /.test(reason), kept, budget, model, evidence, label, reason };
}

/** The outcome of one review run. */
function report({ status, outOfCredit, kept, budget, model, evidence, label, reason }, io) {
  if (outOfCredit) {
    io.out(`evidence: ${evidence}\n`);
    return { exit: 3, status: "skip", text: `review out of credit (${model})${kept && budget ? "; count not given back" : ""}` };
  }
  return status === 0
    ? { exit: 0, status: "ok", text: `review ${label} evidence ${evidence}`, evidence }
    : { exit: status, status: "fail", text: `${reason} evidence ${evidence}` };
}

/**
 * Claude's review (or ASE_REVIEW_MODEL's) of `flags` ({ base | commit, ticket, pr }, as kit review's options give them).
 * A scope with no change is a skip that names it, so a no-code merge can go through kit pr.
 */
export async function review(flags, io = processIo) {
  const empty = emptyScope(flags);
  if (empty) {
    io.out(`nothing to review: ${empty} is empty\n`);
    return { exit: 3, status: "skip", text: `review nothing to review (${empty} is empty)`, nothing: `${empty} is empty` };
  }
  return report(await reviewOnce(flags, undefined, io), io);
}

// The second look after Claude's review: the change's kind picks its models in the table, first choice first; the next
// takes over when one cannot run (a used-up count, no credit, a usage limit, a CLI that is missing or down), and when
// none can, it is skipped. Any other failure, such as an incomplete answer or a failed save or PR comment, fails; the one exception
// is the free OpenCode model, whose own failure goes to GPT when GPT may look again (see below), so it can then end as a skip.
// A GPT model is passed over for a docs-only change or when the PR already had its GPT look; `flags.second === "gpt"` asks
// the kind's GPT model alone, on purpose.
export async function secondLook(flags, io = processIo) {
  const notes = [];
  const say = line => { notes.push(line); io.out(`${line}\n`); };
  const skip = why => {
    say(`second look: skipped (${why})`);
    return { exit: 3, status: "skip", text: `second look (${why})`, skipped: `second look: skipped (${why})`, notes };
  };
  let pick, deadline;
  // `again`: the GPT model passed over only because GPT already looked once on this PR; it is the last resort after OpenCode fails.
  let again = null;
  const models = [], unused = [], asked = flags.second === "gpt";
  // One limit for the whole look, fallback included (ASE_SECOND_LOOK_TIMEOUT, default 25m): a reviewer that opened
  // a session but never finishes is stopped, and the look is skipped as timed out so the slice or PR goes on.
  const limit = process.env.ASE_SECOND_LOOK_TIMEOUT || "25m";
  try {
    try { deadline = Date.now() + durationMilliseconds(limit); }
    catch { throw new Error(`ASE_SECOND_LOOK_TIMEOUT must be a duration such as 25m (got ${limit})`); }
    if (flags.base === undefined && flags.commit === undefined) flags.base = `origin/${kitBranch()}`;
    const root = kitRoot(), scope = reviewScope("", flags, root), settings = kitSettings(root);
    const range = scope.commit ? [`${scope.commit}^`, scope.commit] : [`${scope.base}...${scope.head}`];
    const changes = parseChanges(execFileSync("git", ["-C", root, "-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", ...range],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    // Nothing changed (a no-code merge): there is nothing for a second look to read, so it is skipped, never failed.
    if (!changes.length) return skip(`nothing to review: ${scope.label} is empty`);
    // One path for the pick and the check below, so a problem names the file that was read.
    const table = process.env.ASE_SECOND_LOOK || resolve(import.meta.dirname, "second-look.json");
    pick = secondLookPick(changes, settings, { ticket: flags.ticket && relative(root, resolve(root, flags.ticket)), table });
    // A paid OpenCode row would be refused when its turn came, before any handover: every kind's row is checked
    // now, so the table is named as broken whichever kind this change picks.
    const rows = secondLookTable(table);
    for (const kind of reviewKinds) {
      const paid = rows[kind].order.find(model => /^opencode\//.test(model) && !opencodeModelRuns(model));
      if (paid) throw new Error(`second-look table ${table} ${kind}: ${paid} is a paid OpenCode model; a second look on OpenCode must be a -free model`);
    }
    const docsOnly = docsOnlyChange(changes, settings);
    if (asked) {
      const gpt = pick.order.find(model => lookFamily(model) === "gpt");
      if (!gpt) throw new Error(`--second gpt: second-look table ${table} names no GPT model for ${pick.kind}`);
      // Asked on purpose, GPT still never looks at a docs-only change.
      if (docsOnly) unused.push({ model: gpt, why: "docs-only change" });
      else models.push(gpt);
    } else {
      const branch = spawnSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).stdout?.trim() ?? "";
      for (const model of pick.order) {
        const done = lookFamily(model) === "gpt" && !docsOnly && gptLookDone(reviewsFolder(kitMainRoot()), { pr: flags.pr, branch, root, head: scope.head, base: `origin/${kitBranch()}` });
        const why = lookFamily(model) !== "gpt" ? null : docsOnly ? "docs-only change" : done ? `one GPT second look per PR, done in ${done}` : null;
        if (why) unused.push({ model, why });
        else models.push(model);
        if (done) again = model;
      }
    }
    pick.effort = Object.fromEntries([...models, ...(again ? [again] : [])].map(model => [model, secondLookEffort(model, table)]));
  } catch (error) {
    io.err(`problem: ${error.message}\n`);
    return { exit: 1, status: "fail", text: `${error.message} evidence none`, notes };
  }
  for (const { model, why } of unused) say(`second look: ${model} not used (${why})`);
  const notUsed = unused.map(({ model, why }) => ({ model, text: `${model} not used: ${why}` })), tried = [];
  if (models.length) say(`second look: ${pick.kind} (${pick.path}) ${models[0]}${asked ? " (asked with --second gpt)" : ""}`);
  const label = /^\d+$/.test(limit) ? `${limit}s` : limit;
  let opencodeFailed = null, repeated = false;
  const attempt = (model, look) => reviewOnce(flags, { kind: pick.kind, model, effort: pick.effort[model], ...look }, io);
  // Whether the look is over for this model: it came back, or failed in a way that is a real failure, not an outage.
  // A failure of kit's own work after the review ran (saving its evidence, the PR comment, which reviewOnce reports as the reason), which another model would meet too.
  const ownFailure = /^(saving evidence failed|gh pr comment failed)/;
  const ended = result => (result.status === 0 && !result.outOfCredit) || (!result.unavailable && !result.timedOut);
  for (const model of models) {
    // A fallback needs a minute left to start: with less it would reserve a count for a review the limit stops.
    if (tried.length && deadline - Date.now() < 60_000) { tried.push(`${model} not started: under a minute left of ${label}`); break; }
    if (tried.length) say(`second look: ${model} takes it (${tried.at(-1)})`);
    const result = await attempt(model, { deadline, limit: label });
    // OpenCode that fails for any reason of its own (not a failed save of its evidence or PR comment) goes on to the next model, and GPT looks again only when none of them took it.
    const gaveUp = again && lookFamily(model) === "opencode" && result.status !== 0 && !ownFailure.test(result.reason);
    if (ended(result) && !gaveUp) return { ...report(result, io), notes };
    if (result.evidence !== "none") io.out(`evidence: ${result.evidence}\n`);
    tried.push(`${model} ${result.outOfCredit ? "out of credit" : result.reason}`.replace(/\s+/g, " "));
    if (lookFamily(model) === "opencode") opencodeFailed = tried.at(-1);
    if (result.timedOut) break;
  }
  // Lex (2026-11-12): when the free OpenCode model fails (for a reason of its own), times out or hits its limit, GPT looks again, even though it looked
  // once on this PR already (within the weekly GPT count). It gets a whole time limit of its own: OpenCode may have used the first.
  if (again && opencodeFailed) {
    repeated = true;
    say(`second look: ${again} takes it again (${opencodeFailed}; GPT looked once already on this PR or branch)`);
    const result = await attempt(again, { deadline: Date.now() + durationMilliseconds(limit), limit: label });
    if (ended(result)) return { ...report(result, io), notes };
    if (result.evidence !== "none") io.out(`evidence: ${result.evidence}\n`);
    tried.push(`${again} ${result.outOfCredit ? "out of credit" : result.reason}`.replace(/\s+/g, " "));
  }
  // GPT that was asked again is named by what happened, not as left unused.
  return skip([...notUsed.filter(entry => !(repeated && entry.model === again)).map(entry => entry.text), ...tried].join("; "));
}
