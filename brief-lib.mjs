// The shared parts of a brief: the talk style, and the brief kit brief prints (skills from skills.mjs).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { builderChecks, plainEnglish, projectCommand, reviewFormat, ticketReviewBrief } from "./review-brief.mjs";
import { kitMessagesToLexRule, kitReviewLoopRule, kitRulebookPins, kitSliceBranch } from "./kit-lib.mjs";
import { map, modelFamily, pickSkills, readTicket, skillLine } from "./skills.mjs";
import { cardNaming, onOrbit } from "./ticket-cards.mjs";
import { lookFamily, lookFamilyWords, secondLookTable } from "./pr-tier.mjs";

export { map, modelFamily, pickSkills, readTicket, skillLine, skillSettingsProblems } from "./skills.mjs";

export const STAGES = ["build", "review", "second-look", "fix"];
// One shell word, as written: single quotes, so a title's $ or backtick is never run.
const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;

const peopleText = "Everything written to a file or GitHub (code, comments, docs, tickets, commits, PR text) stays plain full English, and so do the report keywords the kit reads (Declined:, RESULT:, REVIEW_STATUS:) with each declined finding's reason. Messages for Lex follow the Messages to Lex rule (`scripts/agents/kit rulebook`, section \"Messages to Lex\"): short bullets in plain English (caveman style, no jargon).";
/** The talk-style line: short English (the trial of ticket 83 ended with TOOLS-235), or plain (the house rule's plain English line). */
export function talkStyleLine(style) {
  if (style === "en") return `Talk style: very short English for your messages and report to the agent that started you (Claude: /${map.talk} ultra): drop articles and filler; keep paths, commands, numbers and quoted rules exact. ${peopleText}`;
  return `${plainEnglish}\nMessages for Lex follow the Messages to Lex rule (\`scripts/agents/kit rulebook\`, section \"Messages to Lex\"): short bullets in plain English (caveman style, no jargon).`;
}

/** The style for the next agent start: short English, or plain when KIT_TALK_STYLE=plain. */
export function nextTalkStyle(env = process.env) {
  const forced = env.KIT_TALK_STYLE;
  if (forced && !["en", "plain"].includes(forced)) throw new Error(`KIT_TALK_STYLE must be en or plain, not ${forced}`);
  return forced || "en";
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

// The second look's models, first choice first: the code row of the kit's second-look table.
// A broken table stops no brief: the line then points at the table (kit review names what is wrong with it).
const lookOrder = () => { try { return secondLookTable().code.order; } catch { return null; } };
const lookModels = order => !order ? "the models in the kit's `second-look.json`, first choice first" : order.map(model => lookFamily(model) === "opencode" ? `the free \`${model}\`` : `\`${model}\`${lookFamily(model) === "gpt" ? ` (${lookFamilyWords(model)})` : ""}`).join(", else ");
const reviewersRule = "GPT may review since 2026-11-09; Claude Opus stays the main reviewer";
// TOOLS-285: a build the kit starts itself runs inside the key lock (key-guard.mjs) and cannot do a keyed step, so no
// brief sends it there; a T3 helper thread is outside the lock and lands its own work as the brief says.
const keyLockRule = "Key lock: in a build the kit starts itself (`agent.sh build`; its prompt ends with a \"Build contract\") the keyed steps are the lead's, since the kit's key lock keeps the machine's key files from such a run wherever it can: board reads (`kit ticket get|list`), GitHub calls (`gh`, `kit wait ci`, `kit pr`, a fetch from or a push to a private remote), Cloudflare deploys (`kit preview`, `wrangler`) and an install that needs a registry token. In such a run do none of them, whatever this brief says elsewhere: work from the text in this brief, and name each step you left in your report as `Lead: <step>`.";

/**
 * The whole brief for one stage of a ticket, ending with its marker line. Inputs: the project's top folder, its
 * settings, the ticket's path there and its text, the stage, owner, note, the target model, the talk style and
 * the kit's version.
 */
export function composeBrief({ messages = kitMessagesToLexRule(), reviewLoop = kitReviewLoopRule(), root, settings, ticket, text, stage, owner, note, model, style, version, task, card, pins = kitRulebookPins(root, settings), review = process.env.ASE_REVIEW_MODEL || pins.reviewer }) {
  const info = readTicket(text);
  // A group ran as one kit next job; kit next was cut (TOOLS-235), so the lead briefs its tickets one by one or as a task.
  if (info.group) throw new Error(`${ticket} is in group ${info.group}: kit brief writes a brief for one ticket; brief the group's tickets one at a time (take the group: line off each), or the whole group as one --task`);
  const land = settings.branches?.land ?? "main";
  const slug = task ? ticket.replace(/^task:/, "") : basename(ticket).replace(/\.md$/i, "");
  // A card's branch and job come from the card (cardNaming), whoever the brief's owner is.
  const named = card ? cardNaming({ identifier: ticket, title: card.title }) : null;
  const branch = named?.branch ?? kitSliceBranch(owner, slug);
  const builder = builderModel(info.builder, pins.builder);
  const order = lookOrder();
  // A second look with no readable table has no model to name: null keeps its skill lines neutral (modelFamily) and never
  // borrows the main reviewer's model. Only the build stage prints the target as a pin.
  const target = model || (stage === "review" ? review : stage === "second-look" ? order?.[0] ?? null : builder);
  const reviewing = stage === "review" || stage === "second-look";
  const skills = pickSkills({ files: info.files, words: `${info.title}\n${info.filesText}${task ? `\n${note ?? ""}` : ""}`, stage, settings });
  // What the brief is about: a ticket file, an Orbit card (its text is in the brief), or a task the note holds.
  const what = task ? `the task "${task}"` : card ? `the Orbit card ${ticket}` : `\`${ticket}\``;
  const out = [];
  const section = (title, lines) => { if (lines.length) out.push("", `## ${title}`, ...lines.map(line => `- ${line}`)); };
  const project = settings.project ?? basename(root);
  if (stage === "build") out.push(`Kit brief: build ${what} in \`${project}\` (${root}), owner \`${owner}\`. Build the whole ${task ? "task (it is in the note below; the project keeps no ticket file for it)" : card ? "card (its text and comments are below)" : "ticket"}, from setup to a merged PR, with Agent Kit.`);
  if (stage === "fix") out.push(`Kit brief: fix round for ${what} in \`${project}\` (${root}), owner \`${owner}\`. Fix round: fix each open finding in one commit on the build branch \`${branch}\`.`);
  if (reviewing) out.push(`Kit brief: ${stage === "review" ? "review" : "second look"} of ${what} in \`${project}\` (${root}), branch \`${branch}\`. You are the reviewer: read-only. Make no changes, no commits and no PR.`);
  const readFirst = task ? "the note below" : card ? `the card below with all its comments (the lead put them in this brief; a newer comment comes from the lead, never from a board read of your own), the docs it links, the Orbit card standard (\`docs/orbit-card-standard.md\` in the kit; \`scripts/agents/kit --home\` prints the kit's folder) for any card you write or report on` : "the ticket with all its Comments, the build README beside it, the docs it links";
  out.push(`Read first: ${readFirst}, and AGENTS.md; ${reviewing ? "" : "the project's runner guide (`docs/agents/runner.md`) for the order of steps; "}\`scripts/agents/kit rulebook\` holds the house rules in full.`);
  if (!reviewing) {
    section("Setup", [
      stage === "fix"
        ? `The build branch holds the work: \`git fetch -q origin && git switch ${branch}\` (it tracks \`origin/${branch}\`). Use \`git -C\` or \`cd … || exit 1\`.`
        : `In a T3 child thread your checkout is the worktree: \`git fetch -q origin && git switch -c ${branch} origin/${land}\`. Elsewhere: \`ASE_OWNER=${owner} scripts/agents/worktree.sh ${branch} origin/${land}\`. Use \`git -C\` or \`cd … || exit 1\`.`,
      `Pins: builder \`${target}\`; reviews \`ASE_REVIEW_MODEL=${review}\`; commands run with \`ASE_OWNER=${owner}\`.`,
    ]);
    const { unit, check, lint } = builderChecks(root, settings);
    const when = existsSync(join(root, "tsconfig.json")) ? "when types moved" : "before handing back";
    section("Commands and evidence", [
      "Agent Kit is required: `scripts/agents/kit doctor` first; fix every ✗ that is not marked optional (a missing optional reviewer or skill is only a note). A kit command that cannot run is said in the report, never skipped silently or claimed.",
      keyLockRule,
      "Tests first: each new test fails before the change.",
      `While building: ${[unit && "`scripts/agents/kit unit --affected`", check && `\`${check}\` ${when}`, lint && `\`${lint}\``, task ? "the task's focused checks" : card ? "the card's focused checks" : "the ticket's focused checks"].filter(Boolean).join(", ")}.`,
      // TOOLS-235 item G (Lex, 2026-11-14): every screen change gets the automatic UX check before it lands, as kit slice
      // gave it. kit pr holds the builder to it (ux-gate.mjs); kit shots is named only where the project has it.
      `UX check: a change to what a person sees gets \`scripts/agents/kit ux\` once it is built${projectCommand("shots", root, settings) ? ", with `scripts/agents/kit shots` for the screenshots you report" : ""}: fix what it calls broken or looks off, or say why not, and run it again after any later visible change or edit to the change's features in the feature list (so update the feature list first). \`kit pr\` refuses to land a visible change (\`paths.visible\`) without a fresh \`kit ux\` result; a change that matches those paths but shows a person nothing new lands with \`scripts/agents/kit pr … --not-visible "<reason>"\`. In a project with no feature list (\`docs/agents/features.md\`) \`kit ux\` has nothing to try: say so in the report.`,
      ...(stage === "build" && task ? [
        `Build it, then \`scripts/agents/kit review\` and \`scripts/agents/kit pr --title ${shellQuote(task)}\` into \`${land}\` (checks for the change's tier, the second look, CI, merge), each under \`kit go\`. Link the PR with T3 \`link_pull_request\`.`,
        "Report every RESULT line, the PR URL and the merge SHA.",
      ] : stage === "build" ? [
        // kit pr reads a card key as a card only on an Orbit project; elsewhere a card lands by its title.
        `Build it, then \`scripts/agents/kit review${card ? "" : ` --ticket ${ticket}`}\` and \`scripts/agents/kit pr ${card && !onOrbit(settings) ? `--title ${shellQuote(`${card.title} (${ticket})`)}` : `--ticket ${ticket}`}\` into \`${land}\` (checks for the change's tier, the second look, CI, merge), each under \`kit go\`. Link the PR with T3 \`link_pull_request\`.`,
        `The ${card ? "card's" : "ticket's"} own "Kit commands and evidence" section adds to this. Report every RESULT line, the PR URL and the merge SHA.`,
        // There kit pr moves no card to Done, and only a lead writes the board: the builder's report hands it over.
        ...(card && !onOrbit(settings) ? [`\`kit pr\` does not close the card in this project (it keeps ticket files): put this line in your report: "Lead: close ${ticket} (Done, with a dated note naming the PR and its merge SHA)".`] : []),
      ] : [
        // kit fix, which handed declined findings to kit review, was cut (TOOLS-235): nothing passes them on yet.
        "For each finding you decline, give it with its reason in your report and the PR text: the next review does not see it yet, so it may report the finding again; answer it the same way, and the lead waives it by id.",
        task ? "The findings are in the newest complete review's `findings.json` under the main checkout's `.scratch/reviews/<owner>/` (a record marked `incomplete: true` is not one) (the note below holds the task)."
          : "The findings are in the note below, else in the newest complete review's `findings.json` under the main checkout's `.scratch/reviews/<owner>/` (a record marked `incomplete: true` is not one).",
      ]),
    ]);
  } else {
    // The build branch, not the lead's checkout, is what is reviewed.
    const range = `Scope: git diff origin/${land}...origin/${branch} (\`git fetch -q origin\` first; inside the kit's key lock the lead has fetched already).`;
    let scope;
    try {
      if (task || card) throw new Error("no ticket file");
      scope = ticketReviewBrief(ticket, undefined, root, [], false).trimEnd().replace(/^Scope: .*$/m, range);
    } catch { scope = `Review this build slice in read-only mode. Make no changes.\n${range}\nSpec axis: ${task ? "the task in the note below" : card ? `the card ${ticket} below, with its comments` : `read ${ticket}, including the linked spec and deciding tickets`}.`; }
    out.push("", scope);
    if (stage === "second-look") section("Second look", [
      `Model: ${lookModels(order)}; ${reviewersRule}. Headless: \`scripts/agents/kit review --second-look${task || card ? "" : ` --ticket ${ticket}`}\`.`,
      "When no model can run, say `second look: skipped (<reason>)` and stop.",
    ]);
  }
  // TOOLS-235 (Lex, 2026-11-14): every card starts with a grill for Lex in its own thread, and anything he sees or clicks
  // gets a prototype he tries first; bug fixes and work behind the scenes skip the prototype, not the grill.
  if (stage === "build") section("Grill and prototype", [
    `Grill first: the question round with Lex in its own thread comes before any build; its answers are in ${task ? "the note below" : card ? "the card's comments" : "the ticket's `## Resolution` sections"}. A question still open, or a choice you would have to guess, goes back to the lead: never guess an answer for Lex.`,
    "Anything Lex sees or clicks follows the prototype he tried and approved (linked from the card); a bug fix or work behind the scenes has no prototype, but still has its grill. Once it lands, Lex tries the result next to the prototype.",
  ]);
  section("House rules", [
    "Paid skills never go in a repo: name a skill, never copy its text (`skill-guard.mjs` runs in `kit pr`).",
    `Second look: ${lookModels(order)}; ${reviewersRule}; GPT never for a docs-only change, and once per PR, except as the last resort after the free OpenCode model fails; \`second look: skipped (<reason>)\` when none can run.`,
    // kit pr counts the fix rounds from the review records (TOOLS-287).
    `\`kit pr\` counts your fix rounds from your reviews (each earlier review, Claude's or a second look, that left a finding above a nit): within the budget a blocker or should blocks; once it is used only blockers (P0, P1) block, for Claude's review and the second look alike, and the shoulds left go to the lead. P3 findings and test gaps never block. Fix with the smallest change, or decline with evidence in your report and the PR text (the next review does not see a decline yet); once you have used 3 fix rounds (5 for a risky change), hand what is left to the lead with both sides, who may land with \`ASE_OWNER=<lead> scripts/agents/kit pr … --waive "<id>: <reason>"\`; say so in ${task || card ? "your report" : "the ticket's Done"}.`,
    "Anything a person sees: No toasts or explainers; show state on the control itself. Reuse the theme tokens and components.",
    "House rules beat skill advice: where a skill suggests something a house rule forbids (a toast, say), the house rule wins.",
    "Commits use the repo's or the machine's set git identity; never borrow another person's name.",
    // Lex, 2026-11-13: a builder may push back on a review point instead of changing the code for it.
    ...(reviewing ? [] : ["If a review point is not worth fixing, say so with the reason instead of changing the code."]),
  ]);
  // The rule is the shared rulebook's (docs/kitchen.md of the kit that runs), not the project's.
  out.push("", "## Messages to Lex", `This covers messages meant for Lex. The Report section's format still applies in full (RESULT lines, PR URL, SHAs, finding locations). This copy is v${messages.version}; a project's own or newer \"Messages to Lex\" section in AGENTS.md wins over it.`, messages.rule);
  // The review loop's rules (budget by risk, stop on nits, ledger): one source, the rulebook's "Review loop" section.
  out.push("", "## Review loop", reviewLoop.rule);
  if (!reviewing) section("Waiting", [
    "Finish the whole job in this turn. A short check runs in the foreground.",
    "A long job (a long `kit pr`, specs, a build) runs as `scripts/agents/kit go <job> -- <command>`: it starts the job in its own systemd scope and waits at most 9 minutes per call.",
    "Give every `kit go` call a tool time limit of 10 minutes (Claude's Bash tool: `timeout: 600000`; its default of 2 minutes cuts the wait short; Codex: a 600-second limit on the shell call).",
    "While the job runs, `kit go` ends with `RUNNING: <job> (…). Run again: scripts/agents/kit go <job>` and exit 75: run that line again at once, in the foreground, until it prints the job's RESULT line.",
    "Never wait in the background, never post progress between waits, and never end your turn while a job of yours runs (the Stop hook refuses it).",
  ]);
  if (skills.length) {
    const family = modelFamily(target);
    out.push("", "## Skills", `Use these for the parts of the ${task ? "task" : card ? "card" : "ticket"} they fit${family === "none" ? " (in the kit's own words; this model has no skills)" : ""}:`,
      ...skills.map(entry => `- ${skillLine(entry, family)}`));
  }
  // A review's findings are posted to GitHub, so they stay plain English (reviewFormat's own line).
  out.push("", "## Talk style", reviewing ? plainEnglish : talkStyleLine(style));
  if (note) out.push("", "## Note from the lead", `Note from the lead: ${note}`);
  if (card) {
    out.push("", `## Card ${ticket}`, `Title: ${card.title}`, ...(card.url ? [`Link: ${card.url}`] : []), "", String(card.description ?? "").replace(/\r\n?/g, "\n").trim());
    if (card.comments.length) out.push("", "### Comments", ...card.comments.flatMap(comment => ["", `- ${comment.who}, ${comment.when}:`, String(comment.body ?? "").replace(/\r\n?/g, "\n").trim()]));
  }
  out.push("", "## Report");
  if (reviewing) out.push(reviewFormat.trimEnd());
  else if (stage === "fix") out.push("Report each finding as fixed or declined (with the reason), the RESULT lines, and the new head.", "Last line: FIXED <n>, DECLINED <n>, head <SHA>.");
  else out.push(task
    ? "Proof: for each thing the note asks for, one line: `<what>: met — <what you really tried on the real thing>` (the test that failed first and now passes, a command and what it printed, what you clicked on the preview and saw), or `<what>: not met — <why>`; checks passing is not proof on its own. A bug fix shows its failing test first. Put the same lines in the PR text."
    : "Proof: for each \"Done when\" item, one line: `Done when <n>: met — <what you really tried on the real thing>` (the test that failed first and now passes, a command and what it printed, what you clicked on the preview and saw), or `Done when <n>: not met — <why>`; checks passing is not proof on its own. A bug fix shows its failing test first. Put the same lines in the PR text.",
  "Report the proof lines, the RESULT lines, the PR URL and the merge SHA.", "Last line: PR <full URL>, head <SHA>, checks and reviews <state>.");
  out.push("", `kit-brief: ${version} ${ticket} ${stage}`);
  return out.join("\n");
}
