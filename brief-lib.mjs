// The factory's shared parts: the talk style, and the brief kit brief prints (skills from skills.mjs).
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { builderChecks, plainEnglish, reviewFormat, ticketReviewBrief } from "./review-brief.mjs";
import { kitRulebookPins, kitSliceBranch, kitStateDir } from "./kit-lib.mjs";
import { map, modelFamily, pickSkills, readTicket, skillLine } from "./skills.mjs";

export { map, modelFamily, pickSkills, readTicket, skillLine, skillSettingsProblems } from "./skills.mjs";

export const STAGES = ["build", "review", "second-look", "fix"];
// One shell word, as written: single quotes, so a title's $ or backtick is never run.
const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;

const peopleText = "Everything written to a file or GitHub (code, comments, docs, tickets, commits, PR text) and every message for Lex stays plain full English, and so do the report keywords the kit reads (Declined:, RESULT:, REVIEW_STATUS:) with each declined finding's reason.";
/** The talk-style line (ticket 83): en, wenyan, or plain (the house rule's plain English line). */
export function talkStyleLine(style) {
  if (style === "en") return `Talk style: very short English for your messages and report to the agent that started you (Claude: /${map.talk} ultra): drop articles and filler; keep paths, commands, numbers and quoted rules exact. ${peopleText}`;
  if (style === "wenyan") return `Talk style: Classical Chinese (wenyan), terse, for your messages and report to the agent that started you (Claude: /${map.talk} wenyan-ultra); leave paths, commands, code, numbers and quoted rules exactly as written. ${peopleText}`;
  return plainEnglish;
}

/**
 * The style for the next agent start: KIT_TALK_STYLE (en, wenyan or plain) when set, which leaves the counter
 * alone; else the counter in the kit's state folder, which alternates en and wenyan from en.
 */
export function nextTalkStyle(env = process.env) {
  const forced = env.KIT_TALK_STYLE;
  if (forced) {
    if (!["en", "wenyan", "plain"].includes(forced)) throw new Error(`KIT_TALK_STYLE must be en, wenyan or plain, not ${forced}`);
    return forced;
  }
  const state = kitStateDir(env), file = join(state, "talk-style.json"), lock = `${file}.lock`;
  mkdirSync(state, { recursive: true });
  // One start at a time reads and moves the counter, so two at once never take the same style.
  let held;
  for (const deadline = Date.now() + 3000; held === undefined;) {
    try { held = openSync(lock, "wx"); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A lock left by a start that died is taken over after 10 seconds; past the deadline the start goes on without it.
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { force: true }); } catch { /* It went away. */ }
      if (Date.now() > deadline) held = null;
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    let next = "en";
    try { next = JSON.parse(readFileSync(file, "utf8")).next === "wenyan" ? "wenyan" : "en"; } catch { /* No counter yet: en first. */ }
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ next: next === "en" ? "wenyan" : "en" })}\n`);
    renameSync(temporary, file);
    return next;
  } finally {
    if (held) { closeSync(held); rmSync(lock, { force: true }); }
  }
}

/** The kit's short commit: a machine copy's folder name, else its checkout's HEAD; "unknown" outside both. */
export function kitVersion(home) {
  if (/^[0-9a-f]{40}$/.test(basename(home))) return basename(home).slice(0, 7);
  try { return execFileSync("git", ["-C", home, "rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"; }
  catch { return "unknown"; }
}

/** The model a ticket's builder line names: none, claude or sol (superseded) means the rulebook's builder pin. */
export function builderModel(builder, pin) {
  return !builder || ["claude", "sol"].includes(builder) ? pin : builder.split(/[\s,]/)[0];
}

const SECOND_LOOK = { first: "grok-4.7", fallback: "opencode/deepseek-v4.1-flash-free" };

/**
 * The whole brief for one stage of a ticket, ending with its marker line. Inputs: the project's top folder, its
 * settings, the ticket's path there and its text, the stage, owner, note, the target model, the talk style and
 * the kit's version.
 */
export function composeBrief({ root, settings, ticket, text, stage, owner, note, model, style, version, task, pins = kitRulebookPins(root, settings), review = process.env.ASE_REVIEW_MODEL || pins.reviewer }) {
  const info = readTicket(text);
  // kit next runs a group's tickets as one job (kit next --run-group) on the group's own branch.
  if (info.group) throw new Error(`${ticket} is in group ${info.group}: kit next --start runs a group as one job; kit brief writes briefs for single tickets`);
  const land = settings.branches?.land ?? "main";
  const slug = task ? ticket.replace(/^task:/, "") : basename(ticket).replace(/\.md$/i, "");
  const branch = kitSliceBranch(owner, slug);
  const builder = builderModel(info.builder, pins.builder);
  const target = model || (stage === "review" ? review : stage === "second-look" ? SECOND_LOOK.first : builder);
  const reviewing = stage === "review" || stage === "second-look";
  // kit next's owner is <prefix>-<NN> (a map ticket's <NN> starts with m) and its job slice-<prefix><NN>:
  // al-01 runs as slice-al01, site-fonts-01 as slice-site-fonts01. Another owner keeps its name.
  const job = `slice-${owner.toLowerCase().replace(/-(m?\d+)$/, "$1").replace(/[^a-z0-9._-]/g, "")}`;
  const sliceLine = `scripts/agents/kit go ${job} -- scripts/agents/kit slice --ticket ${ticket} --builder ${target}`;
  const skills = pickSkills({ files: info.files, words: `${info.title}\n${info.filesText}${task ? `\n${note ?? ""}` : ""}`, stage, settings });
  // What the brief is about: a ticket file, or a task the note holds.
  const what = task ? `the task "${task}"` : `\`${ticket}\``;
  const out = [];
  const section = (title, lines) => { if (lines.length) out.push("", `## ${title}`, ...lines.map(line => `- ${line}`)); };
  const project = settings.project ?? basename(root);
  if (stage === "build") out.push(`Kit brief: build ${what} in \`${project}\` (${root}), owner \`${owner}\`. Build the whole ${task ? "task (it is in the note below; the project keeps no ticket file for it)" : "ticket"}, from setup to a merged PR, with Agent Kit.`);
  if (stage === "fix") out.push(`Kit brief: fix round for ${what} in \`${project}\` (${root}), owner \`${owner}\`. Fix round: fix each open finding in one commit on the slice branch \`${branch}\`.`);
  if (reviewing) out.push(`Kit brief: ${stage === "review" ? "review" : "second look"} of ${what} in \`${project}\` (${root}), branch \`${branch}\`. You are the reviewer: read-only. Make no changes, no commits and no PR.`);
  out.push(`Read first: ${task ? "the note below" : "the ticket with all its Comments, the build README beside it, the docs it links"}, and AGENTS.md; ${reviewing ? "" : "the project's runner guide (`docs/agents/runner.md`) for the order of steps; "}\`scripts/agents/kit rulebook\` holds the house rules in full.`);
  if (!reviewing) {
    section("Setup", [
      stage === "fix"
        ? `The slice branch holds the work: \`git fetch -q origin && git switch ${branch}\` (it tracks \`origin/${branch}\`). Use \`git -C\` or \`cd … || exit 1\`.`
        : `In a T3 child thread your checkout is the worktree: \`git fetch -q origin && git switch -c ${branch} origin/${land}\`. Elsewhere: \`ASE_OWNER=${owner} scripts/agents/worktree.sh ${branch} origin/${land}\`. Use \`git -C\` or \`cd … || exit 1\`.`,
      `Pins: builder \`${target}\`; reviews \`ASE_REVIEW_MODEL=${review}\`; commands run with \`ASE_OWNER=${owner}\`.`,
    ]);
    const { unit, check, lint } = builderChecks(root, settings);
    const when = existsSync(join(root, "tsconfig.json")) ? "when types moved" : "before handing back";
    section("Commands and evidence", [
      "Agent Kit is required: `scripts/agents/kit doctor` first; fix every ✗ that is not marked optional (a missing optional reviewer or skill is only a note). A kit command that cannot run is said in the report, never skipped silently or claimed.",
      "Tests first: each new test fails before the change.",
      `While building: ${[unit && "`scripts/agents/kit unit --affected`", check && `\`${check}\` ${when}`, lint && `\`${lint}\``, task ? "the task's focused checks" : "the ticket's focused checks"].filter(Boolean).join(", ")}.`,
      ...(stage === "build" && task ? [
        `Build it, then \`scripts/agents/kit review\` and \`scripts/agents/kit pr --title ${shellQuote(task)}\` into \`${land}\` (checks for the change's tier, the second look, CI, merge), each under \`kit go\`. Link the PR with T3 \`link_pull_request\`.`,
        "Report every RESULT line, the PR URL and the merge SHA.",
      ] : stage === "build" ? [
        `Default: the slice builds, reviews, runs the fix rounds and the second look, and lands with \`kit pr\`: \`${sliceLine}\`; then \`scripts/agents/kit go ${job}\` again while it prints RUNNING.`,
        `Manual fallback (the runner guide's): build it yourself, then \`scripts/agents/kit review --ticket ${ticket}\` and \`scripts/agents/kit pr --ticket ${ticket}\` into \`${land}\` (checks for the change's tier, the second look, CI, merge), each under \`kit go\`. Link the PR with T3 \`link_pull_request\`.`,
        "The ticket's own \"Kit commands and evidence\" section adds to this. Report every RESULT line, the PR URL and the merge SHA.",
      ] : [
        `For each finding you decline, give it with its reason in your report: \`scripts/agents/kit review${task ? "" : ` --ticket ${ticket}`}\` reads declined findings with their reasons.`,
        "The findings are in the note below, else in the newest `findings.json` under the main checkout's `.scratch/reviews/<owner>/`.",
      ]),
    ]);
  } else {
    // The slice branch, not the lead's checkout, is what is reviewed.
    const range = `Scope: git diff origin/${land}...origin/${branch} (\`git fetch -q origin\` first).`;
    let scope;
    try {
      if (task) throw new Error("no ticket file");
      scope = ticketReviewBrief(ticket, undefined, root, [], false).trimEnd().replace(/^Scope: .*$/m, range);
    } catch { scope = `Review this build slice in read-only mode. Make no changes.\n${range}\nSpec axis: ${task ? "the task in the note below" : `read ${ticket}, including the linked spec and deciding tickets`}.`; }
    out.push("", scope);
    if (stage === "second-look") section("Second look", [
      `Model: \`${SECOND_LOOK.first}\`, else the free \`${SECOND_LOOK.fallback}\`; never an OpenAI model. Headless: \`ASE_REVIEW_MODEL=${SECOND_LOOK.first} scripts/agents/kit review --second-look${task ? "" : ` --ticket ${ticket}`}\`.`,
      "When neither model can run, say `second look: skipped (<reason>)` and stop.",
    ]);
  }
  section("House rules", [
    "Paid skills never go in a repo: name a skill, never copy its text (`skill-guard.mjs` runs in `kit pr`).",
    `Second look: \`${SECOND_LOOK.first}\`, else the free \`${SECOND_LOOK.fallback}\`; never an OpenAI model; \`second look: skipped (<reason>)\` when neither can run.`,
    `After three fix rounds only P0/P1 findings block; P2/P3 go to the lead, who may land with \`ASE_OWNER=<lead> scripts/agents/kit pr … --waive "<reason>"\`; say so in ${task ? "your report" : "the ticket's Done"}.`,
    "Anything a person sees: No toasts or explainers; show state on the control itself. Reuse the theme tokens and components.",
    "House rules beat skill advice: where a skill suggests something a house rule forbids (a toast, say), the house rule wins.",
    "Commits use the repo's or the machine's set git identity; never borrow another person's name.",
  ]);
  if (!reviewing) section("Waiting", [
    "Finish the whole job in this turn. A short check runs in the foreground.",
    "A long job (a slice, a long `kit pr`, specs) runs as `scripts/agents/kit go <job> -- <command>`: it starts the job in its own systemd scope and waits at most 9 minutes per call.",
    "Give every `kit go` call a tool time limit of 10 minutes (Claude's Bash tool: `timeout: 600000`; its default of 2 minutes cuts the wait short; Codex: a 600-second limit on the shell call).",
    "While the job runs, `kit go` ends with `RUNNING: <job> (…). Run again: scripts/agents/kit go <job>` and exit 75: run that line again at once, in the foreground, until it prints the job's RESULT line.",
    "Never wait in the background, never post progress between waits, and never end your turn while a job of yours runs (the Stop hook refuses it).",
  ]);
  if (skills.length) {
    const family = modelFamily(target);
    out.push("", "## Skills", `Use these for the parts of the ${task ? "task" : "ticket"} they fit${family === "none" ? " (in the kit's own words; this model has no skills)" : ""}:`,
      ...skills.map(entry => `- ${skillLine(entry, family)}`));
  }
  // A review's findings are posted to GitHub, so they stay plain English (reviewFormat's own line).
  out.push("", "## Talk style", reviewing ? plainEnglish : talkStyleLine(style));
  if (note) out.push("", "## Note from the lead", `Note from the lead: ${note}`);
  out.push("", "## Report");
  if (reviewing) out.push(reviewFormat.trimEnd());
  else if (stage === "fix") out.push("Report each finding as fixed or declined (with the reason), the RESULT lines, and the new head.", "Last line: FIXED <n>, DECLINED <n>, head <SHA>.");
  else out.push("Report the RESULT lines, the PR URL and the merge SHA.", "Last line: PR <full URL>, head <SHA>, checks and reviews <state>.");
  out.push("", `kit-brief: ${version} ${ticket} ${stage}`);
  return out.join("\n");
}
