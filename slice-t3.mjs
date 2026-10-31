// kit slice's T3 mode (ticket ke-85): the slice starts no agent itself. It prints the next stage and that stage's
// brief for the runner, a T3 thread that passes the brief to delegate_task and ends its turn; when T3 wakes the
// runner, kit slice --next checks the stage's evidence and prints the next stage. The rules stay here: stage order,
// the fix-round limit, "after three rounds only P0/P1 block" and the second look's time limit.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { composeBrief, kitVersion, nextTalkStyle, readTicket } from "./brief-lib.mjs";
import { kitBranch, kitGhEnv, kitHome, kitMainRoot, kitOwner, kitResult, kitRulebookPins, kitScore, nodeEnv } from "./kit-lib.mjs";
import { visiblePath } from "./pr-tier.mjs";
import { afterFixRounds, blockingFindings, openFindings } from "./review-findings.mjs";

/** The second look's time limit: a look with no report by then counts as skipped, and its child is cancelled. */
export const SECOND_LOOK_LIMIT_MS = 25 * 60 * 1000;
const SECOND_LOOK = { first: "grok-4.7", fallback: "opencode/deepseek-v4.1-flash-free" };
const openAi = model => /(^|\/)(gpt|o\d|codex|sol\b)|openai/i.test(model);
// The scoreboard's phase names, so a T3 slice's record compares with a headless one's.
const phaseName = { build: "build", review: "review", fix: "fix", "second-look": "second", pr: "pr" };

/** Whether kit slice runs in T3 mode: --runner t3, or --runner auto inside a T3 thread (T3 sets T3CODE_THREAD_ID). */
export function t3Runner(choice, env = process.env) {
  if (!["t3", "headless", "auto"].includes(choice)) throw new Error("--runner must be t3, headless or auto");
  return choice === "t3" || (choice === "auto" && Boolean(env.T3CODE_THREAD_ID));
}

/** The T3 state of the slice on this branch: the newest state.json in .scratch/kit-slice with mode t3. */
function findState(root, branch) {
  const parent = join(root, ".scratch/kit-slice");
  if (!existsSync(parent)) return null;
  for (const name of readdirSync(parent).sort().reverse()) {
    const path = join(parent, name, "state.json");
    try {
      const state = JSON.parse(readFileSync(path, "utf8"));
      if (state.mode === "t3" && state.branch === branch) return { state, path };
    } catch { /* Not a slice folder, or a headless state being written. */ }
  }
  return null;
}

export function t3Slice({ root, branch, settings, flags }) {
  const env = nodeEnv();
  const git = (...argv) => execFileSync("git", ["-C", root, ...argv], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  // A --next with no slice to go on names no stage.
  let stage = flags.next ? "" : "brief";
  try {
    let found = flags.next ? findState(root, branch) : null;
    if (flags.next && !found) throw new Error(`no T3-mode slice on ${branch}; start one with --runner t3`);
    let state, statePath;
    if (found) ({ state, path: statePath } = found);
    else {
      const ticket = resolve(root, flags.ticket);
      const directory = join(root, ".scratch/kit-slice", basename(ticket, ".md"));
      statePath = join(directory, "state.json");
      if (existsSync(statePath)) {
        state = JSON.parse(readFileSync(statePath, "utf8"));
        if (state.mode !== "t3") throw new Error(`a headless slice of this ticket has saved state (${relative(root, statePath)}); finish it with kit slice --ticket ${flags.ticket} --builder ${state.model}`);
        if (state.branch !== branch) throw new Error("saved slice belongs to a different branch");
      } else {
        const text = readFileSync(ticket, "utf8"), info = readTicket(text);
        // T3 mode has no UX gate yet: a ticket whose Files reach a visible path runs headless, where kit ux checks it.
        const visible = info.files.filter(file => visiblePath(file, settings));
        if (visible.length) throw new Error(`the ticket's Files reach visible paths (${visible.join(", ")}); T3 mode has no UX stage yet, so run it headless (--runner headless)`);
        if (git("status", "--porcelain", "--untracked-files=all")) throw new Error("new slice requires a clean worktree; staged, unstaged or untracked changes exist");
        const start = git("rev-parse", "HEAD");
        state = { mode: "t3", ticket, branch, model: flags.model, effort: flags.effort, owner: info.assignee || kitOwner(), start, head: start,
          stage: "build", stageStarted: new Date().toISOString(), rounds: 0, maxRounds: flags.rounds, history: [] };
        mkdirSync(directory, { recursive: true });
      }
    }
    const save = () => { writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`); renameSync(`${statePath}.tmp`, statePath); };
    const ticketPath = relative(root, state.ticket);
    if (git("branch", "--show-current") !== state.branch) throw new Error("worktree branch changed during slice");
    stage = state.stage;
    // One stage ends: its history entry and scoreboard phase (the comparison with headless slices), then the next.
    const move = (to, detail) => {
      const ended = new Date().toISOString();
      state.history.push({ stage: state.stage, started: state.stageStarted, ended, ...(detail ? { detail } : {}) });
      const name = phaseName[state.stage];
      if (name) kitScore({ ticket: state.ticket, branch: state.branch, root }, record => {
        record.builder ??= { model: state.model, effort: state.effort, previousModels: [], built: state.model };
        record.rounds = Math.max(record.rounds, state.rounds);
        record.runner = "t3";
        record.phases.push({ name, start: state.stageStarted, end: ended, exit: 0, runner: "t3" });
        if (name === "pr" && state.sha) record.landed = { ...record.landed, pr: Number(state.pr), sha: state.sha, at: ended };
      });
      state.stage = to; state.stageStarted = ended; stage = to;
      save();
    };
    const fixDirectory = join(root, ".scratch/kit-fix", encodeURIComponent(state.branch));
    const clean = () => { if (git("status", "--porcelain", "--untracked-files=normal")) throw new Error("uncommitted changes; the stage child commits its work"); };
    const report = () => {
      if (!flags.report) return null;
      const text = readFileSync(resolve(flags.report), "utf8");
      return text;
    };
    // A review's report as evidence kit pr reads: the reviewed HEAD and its base, the report, and for a second look its mark.
    const evidence = (text, second) => {
      if (!/^REVIEW_STATUS: complete\s*$/m.test(text)) throw new Error("the report has no REVIEW_STATUS: complete line (the review format's first line)");
      const { readable } = openFindings(text);
      if (!readable) throw new Error("the report's findings are unreadable (review format)");
      const land = kitBranch("land", settings);
      const base = spawnSync("git", ["-C", root, "merge-base", `origin/${land}`, "HEAD"], { env, encoding: "utf8" }).stdout?.trim() ?? "";
      const folder = join(kitMainRoot(), ".scratch/reviews", kitOwner(), `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-t3-${second ? "second" : "review"}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "refs.txt"), `${state.head}\n${base}\n`);
      writeFileSync(join(folder, "result.md"), text);
      if (second) writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", model: second, ok: true, runner: "t3" }));
      return folder;
    };
    // After a review or second look: fix rounds while findings block (all of them before three rounds, P0/P1 after);
    // past the limit the slice stops for the lead.
    // A skipped second look leaves a mark kit pr reads (second-look.json ok false, skipped), so kit pr --open does not
    // start a look of its own; it has no result.md, so no reader takes it for a review.
    const skipMark = reason => {
      const folder = join(kitMainRoot(), ".scratch/reviews", kitOwner(), `${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-t3-skipped`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "refs.txt"), `${state.head}\n`);
      writeFileSync(join(folder, "second-look.json"), JSON.stringify({ kind: "code", ok: false, skipped: reason, runner: "t3" }));
    };
    const weigh = (folder, after) => {
      const findings = openFindings(readFileSync(join(folder, "result.md"), "utf8")).findings;
      const blocking = afterFixRounds(state.rounds) ? blockingFindings(findings) : findings;
      if (!blocking.length) return move(after);
      if (state.rounds < state.maxRounds) { state.fixFrom = folder; return move("fix"); }
      state.stopped = `${blocking.length} blocking findings after ${state.rounds} fix rounds (${join(folder, "result.md")})`;
      move("stopped");
    };
    let skippedLine;
    if (flags.next) {
      if (flags.skipped !== undefined && stage !== "second-look") throw new Error("only the second look may be skipped");
      if (stage === "build") {
        clean();
        const now = git("rev-parse", "HEAD");
        if (now === state.start) throw new Error("no commit on top of the slice's start; the build child commits its work");
        if (spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", state.start, now], { env }).status !== 0)
          throw new Error(`HEAD ${now.slice(0, 9)} is not on top of the slice's start ${state.start.slice(0, 9)}`);
        state.head = now;
        move("review");
      } else if (stage === "review") {
        const text = report();
        if (text === null) throw new Error("needs --report FILE (the review child's report)");
        const now = git("rev-parse", "HEAD");
        if (now !== state.head) throw new Error(`HEAD moved since the review started (${state.head.slice(0, 7)}, now ${now.slice(0, 7)}); nothing commits during a review`);
        clean();
        state.review = evidence(text, false);
        delete state.declined;
        // A change that reached a visible path needs kit ux, which T3 mode does not run yet.
        const land = kitBranch("land", settings);
        const visible = git("diff", "--name-only", `origin/${land}...HEAD`).split("\n").filter(path => path && visiblePath(path, settings));
        if (visible.length) {
          state.stopped = `visible paths changed (${visible.join(", ")}); T3 mode has no UX stage yet: finish with kit ux and kit pr, or headless`;
          move("stopped");
        } else weigh(state.review, "second-look");
      } else if (stage === "fix") {
        clean();
        const text = report() ?? "";
        const declined = text.split(/\r?\n/).filter(line => /^Declined:/.test(line.trim())).map(line => line.trim());
        const now = git("rev-parse", "HEAD");
        if (now === state.head && !declined.length) throw new Error("no commit on top of the reviewed HEAD (or a report declining every finding)");
        if (now !== state.head && spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", state.head, now], { env }).status !== 0)
          throw new Error(`HEAD ${now.slice(0, 9)} is not on top of the reviewed HEAD ${state.head.slice(0, 9)}`);
        // The round counts where kit pr and kit fix count them, so kit pr relaxes to P0/P1 just as the slice does.
        mkdirSync(fixDirectory, { recursive: true });
        writeFileSync(join(fixDirectory, `round-${state.rounds + 1}.md`), `T3 fix round ${state.rounds + 1} for ${ticketPath}, answering ${join(state.fixFrom ?? "", "result.md")}\n`);
        state.rounds++;
        state.head = now;
        if (declined.length) state.declined = declined;
        delete state.fixFrom;
        move("review", `round ${state.rounds}`);
      } else if (stage === "second-look") {
        const model = flags.model;
        if (model && openAi(model)) throw new Error(`never an OpenAI model (${model})`);
        const late = Date.now() - Date.parse(state.stageStarted) > SECOND_LOOK_LIMIT_MS;
        if (late || flags.skipped !== undefined) {
          state.secondLook = { skipped: late ? "no report within 25 minutes" : flags.skipped.trim() || "no reason given" };
          skipMark(state.secondLook.skipped);
          skippedLine = `second look: skipped (${state.secondLook.skipped})`;
          if (late) console.log("A second look past its time limit is cancelled: task_cancel its child if it still runs.");
          move("pr", skippedLine);
        } else {
          const text = report();
          if (text === null) throw new Error('needs --report FILE, or --skipped "<reason>" when no model can take it');
          if (!model) throw new Error(`needs --model with the report: the model that took the look (${SECOND_LOOK.first} or ${SECOND_LOOK.fallback})`);
          const now = git("rev-parse", "HEAD");
          if (now !== state.head) throw new Error(`HEAD moved since the second look started (${state.head.slice(0, 7)}, now ${now.slice(0, 7)}); nothing commits during a review`);
          clean();
          state.secondLook = { evidence: evidence(text, model) };
          weigh(state.secondLook.evidence, "pr");
        }
      } else if (stage === "pr" && flags.report) {
        // kit pr --open stopped on its own review's findings (after a rebase, or a review it ran itself): the
        // result.md its RESULT line names. Its findings get the fix rounds, as a review's do.
        const result = resolve(flags.report);
        if (basename(result) !== "result.md" || !existsSync(join(result, "..", "refs.txt"))) throw new Error("--report at the pr stage is the result.md that kit pr --open named");
        clean();
        state.head = git("rev-parse", "HEAD");
        weigh(resolve(result, ".."), "pr");
      } else if (stage === "pr") {
        const gh = spawnSync(env.ASE_SLICE_GH || "gh", ["pr", "list", "--head", state.branch, "--state", "all", "--json", "number,state,mergeCommit"],
          { cwd: root, env: kitGhEnv(env, root), encoding: "utf8" });
        if (gh.status !== 0) throw new Error(`gh pr list failed: ${(gh.stderr || gh.stdout || "").trim().split("\n").at(-1)}`);
        const prs = JSON.parse(gh.stdout || "[]");
        const merged = prs.find(pr => pr.state === "MERGED"), open = prs.find(pr => pr.state === "OPEN");
        if (merged) {
          if (!/^[a-f\d]{40}$/i.test(merged.mergeCommit?.oid ?? "")) throw new Error(`PR #${merged.number} merged without a merge SHA`);
          state.pr = String(merged.number); state.sha = merged.mergeCommit.oid;
          move("done");
        } else if (open) throw new Error(`PR #${open.number} is open, not merged; when the watch wakes you, run scripts/agents/kit pr --merge --ticket ${ticketPath}`);
        else throw new Error(`no PR for ${state.branch} yet; run scripts/agents/kit pr --open --ticket ${ticketPath}`);
      }
    }
    save();
    if (skippedLine) console.log(skippedLine);
    return print({ root, settings, state, ticketPath });
  } catch (error) {
    console.log(`slice: ${stage || "next"} fail`);
    kitResult("fail", `slice ${stage ? `${stage}: ` : ""}${error.message}`);
    return 1;
  }
}

// The stage's NEXT line, how to start its child and its brief; done and stopped end the slice.
function print({ root, settings, state, ticketPath }) {
  const { stage } = state;
  console.log(`NEXT: ${stage === "stopped" ? "lead" : stage}`);
  if (stage === "done") { kitResult("ok", `slice ${ticketPath} PR #${state.pr} ${state.sha}`); return 0; }
  if (stage === "stopped") {
    console.log(`decide: ${state.stopped}; the lead may land with ASE_OWNER=<lead> scripts/agents/kit pr --ticket ${ticketPath} --waive "<reason>"`);
    kitResult("fail", `slice review: ${state.stopped}`);
    return 1;
  }
  if (stage === "pr") {
    const job = `pr-${state.owner.toLowerCase().replace(/-(m?\d+)$/, "$1").replace(/[^a-z0-9._-]/g, "")}`;
    console.log(`run: scripts/agents/kit go ${job} -- scripts/agents/kit pr --open --ticket ${ticketPath}`);
    console.log("then: call watch_pull_request on its WATCH: URL, link the PR with link_pull_request and end your turn");
    console.log(`on the wake: scripts/agents/kit pr --merge --ticket ${ticketPath}, then scripts/agents/kit slice --next`);
    console.log("if kit pr --open stops on review findings: scripts/agents/kit slice --next --report <the result.md it names>");
    kitResult("ok", `slice ${ticketPath} t3 next pr`);
    return 0;
  }
  const pins = kitRulebookPins(root, settings);
  const review = process.env.ASE_REVIEW_MODEL || pins.reviewer;
  const reviewing = stage === "review" || stage === "second-look";
  const delegate = {
    build: `role implementation, isolation shared, model ${state.model}, mode async`,
    fix: `role implementation, isolation shared, model ${state.model}, mode async`,
    review: `role review, isolation shared, model ${review}, mode async`,
    "second-look": `role review, isolation shared, model ${SECOND_LOOK.first} (else ${SECOND_LOOK.fallback}), mode wait, timeoutMs ${SECOND_LOOK_LIMIT_MS}`,
  }[stage];
  let note;
  if (stage === "fix") {
    const result = join(state.fixFrom, "result.md");
    const findings = openFindings(readFileSync(result, "utf8")).findings;
    note = `Open findings (${result}):\n${findings.map(item => `- ${item.group}: ${item.text}`).join("\n")}`;
  } else if (stage === "review" && state.declined?.length) note = `The fix child declined these findings; weigh its reasons:\n${state.declined.join("\n")}`;
  const text = readFileSync(state.ticket, "utf8");
  const brief = composeBrief({ root, settings, ticket: ticketPath, text, stage, owner: state.owner, note, child: true, pins,
    model: stage === "second-look" ? SECOND_LOOK.first : reviewing ? review : state.model,
    style: reviewing ? "plain" : nextTalkStyle(), version: kitVersion(kitHome()) });
  const file = join(root, ".scratch/kit-slice", basename(state.ticket, ".md"), `${stage}-brief.md`);
  writeFileSync(file, `${brief}\n`);
  console.log(`delegate: ${delegate}`);
  console.log(`brief: ${relative(root, file)} (pass it whole to delegate_task, then end your turn)`);
  console.log(brief);
  kitResult("ok", `slice ${ticketPath} t3 next ${stage}`);
  return 0;
}
