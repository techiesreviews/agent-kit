# The kitchen

How work moves from idea to release in every project of Lex's: one road every session and every model
follows. **Lex is head chef**, the lead session runs the pass, helpers build and reviewers check, Agent Kit
and the skills are the knives.

This is the shared rulebook; it travels with the kit. `scripts/agents/kit rulebook` prints it followed by
the project's extras (the file `rulebookExtras` names in `scripts/agents/kit.json`): the project's landing
and release branches, checks, own commands, previews, release steps and history. **Where the extras
differ, they win.** Below, "the landing branch" is `branches.land` in the settings file, "the project's
checks" are its `checks` commands, and "`<land>`" stands for the landing branch's name.

<a id="ux-confidence-ladder"></a>

## The road: six steps and the grill

Lex, 2026-11-14 (TOOLS-235): every card takes the same road, each step with one owner. The
[flow chart](flow-chart.html) (`docs/flow-chart.html` in the kit) draws it; [the steps in
detail](#the-steps-in-detail) below hold what each step uses and when it is done.

1. **Card.** The idea is a card on the board with a goal and a "Done when" list (Lex or the lead,
   `kit ticket`).
2. **Grill.** Before any helper starts, the lead opens a question round for Lex in its own desk thread
   (the `grilling` skill): what the card must do, what it must not, how he will know it works. His
   answers go on the card as a dated comment. Every card has one, bug fixes and work behind the scenes
   included; a question the helper finds later goes back to the lead, never guessed.
3. **Prototype, for anything he sees or clicks.** A clickable prototype he tries before the build (the
   `prototype` skill, or an HTML page shown with T3 `html_render`), linked from the card. A bug fix or
   work behind the scenes skips this step, never the grill.
4. **Build and prove.** The lead runs `kit brief <KEY>` (on an Orbit project it claims the card) and gives it to a
   T3 helper in its own worktree.
   The helper builds, runs the quick checks and writes one proof line per "Done when" item, what it
   really tried on the real thing (`Done when <n>: met — <proof>`: the test that failed first, the command
   and what it printed, what it clicked on the preview), in its report and the PR text. Checks passing is
   not proof on its own; a bug fix shows its failing test first. A change to what a person sees gets
   `kit ux`, the automatic UX check, before it lands.
5. **Land.** `kit pr`: the checks, the UX check's result for a visible change, the Opus review, the
   second look, GitHub's checks, merge. A direct project is live here.
6. **Lex tries it.** A desk thread with the preview link, the prototype beside it, what to click and what
   to see.
7. **His go.** `kit pr --release` puts a public tool live, only after his go (a direct project has no
   release step).

Around the road, not on it: the Board drive schedule (every 2 hours it reads the board with `kit ticket`,
checks the helper threads, restarts stalled work and opens desks), the weekly sweep, the kit's update timer
and the guards. Lex tries every visible change himself; the UX confidence ladder was dropped on 2026-11-14.
The old factory (`kit slice`, `kit fix`, `kit next`, `kit heartbeat`) was cut on 2026-11-15: each name now
says where its job went.

## House rules

- **Dev must always work:** only a working, checked increment merges into dev (or the project's landing
  branch). Unfinished work stays on its branch. Builders report what stays on a branch and why, including
  the branch name and the next step.
- **Start each feature plainly:** the lead starts with 3 to 5 plain lines for Lex: what he will see on
  the preview, where (link), and when (after which step).
- **Agent Kit for every coding step, every model:** `scripts/agents/kit`, `kit doctor` first. A kit
  command that cannot run is reported in the result; it is never skipped silently.
- **One job, one worktree:** `git worktree add -b <branch> ../<project>-<branch> origin/<land>` (or the
  project's `scripts/agents/worktree.sh` where it has one); `git -C` or `cd … || exit 1`; work in progress is
  a commit on your own branch.
- **Lex in plain words:** questions are plain choices about what changes for him, each with a
  recommended answer. Technical questions go to him too, explained plainly, with file paths only where
  he must act on them. What a message to him holds and how it reads: [Messages to
  Lex](#messages-to-lex), which wins over every other line of this rulebook for what a message to him
  holds and how it reads.
- **Plain English** (Lex, 2026-10-30): every ticket, doc, code comment, commit message, PR text,
  and review finding is in plain English, since Lex reads them; a message to Lex follows [Messages to
  Lex](#messages-to-lex) (caveman bullets in plain words). Talk between agents
  (a brief, a child's report to its lead) is the short English `kit brief` sets (`KIT_TALK_STYLE=plain`
  turns it off), never in anything a person reads; the Classical Chinese trial ended on 2026-11-14.
- **Every card takes [the road](#the-road-six-steps-and-the-grill)** (Lex, 2026-11-14): a grill for Lex in
  its own desk thread before any helper starts, a prototype he tries first for anything he sees or clicks,
  and proof lines per "Done when" item in every helper's report and PR.
- **Briefs come from the kit** (Lex, 2026-10-31): every child's brief is the output of
  `scripts/agents/kit brief <ticket> [--stage build|review|second-look|fix] [--note "<text>"]`, never
  retyped, so a rule changes once, in the kit. The `brief-guard` hook refuses a `delegate_task` or
  `Agent` brief without its `kit-brief:` marker line; a research, review-only or question task starts
  with `kit-brief: none (<reason>)`.
- **Builds run as T3 helper threads** (Lex, 2026-11-13): in a T3 session every build runs as its own
  helper thread, a `delegate_task` with `isolation: "worktree"` and the `kit brief` output as its task,
  and work on LexTop goes through T3's environment link (`t3_environment_links`, then `delegate_task`
  with `target.environmentId`) when the link is there, so its result comes back to the lead. Codex alone
  (no T3) builds in its own session from the same `kit brief` and lands with `kit pr`, a long step under
  `kit go`; LexTop alone (no link) runs the kit in LexTop's own shell. Either way the work itself still
  runs through the kit.
- **Finish the job in the turn** (Lex, 2026-10-31): a short check runs in the foreground; a long job
  runs as `scripts/agents/kit go <job> -- <command>`, and its `Run again: scripts/agents/kit go <job>`
  line is run again in the foreground until the job's RESULT line. The `stop-guard` hook refuses a
  turn end while such a job runs (it gives way past the job's time limit, after six refusals in a
  row, or with `KIT_ALLOW_STOP=1`).
- **Messages to Lex** (Lex, 2026-11-05): only what matters to him, question first, caveman bullets;
  the rule is under [Messages to Lex](#messages-to-lex) below.
- **Private repos land directly on main** (Lex, 2026-11-05): a project in a private GitHub repo sets
  `"branches": { "land": "main", "release": "main", "direct": true }`; its PRs then go straight into main
  as ordinary PRs through the same gates as any `kit pr` (checks and review by the change's size, the second look when a
  model can take it), with no raw pushes and no `--release` step.
  `kit init` sets it up for a new private repo and `kit init --check` names the change for an existing
  one; a public repo keeps its landing and release branches. A direct project goes live mid-week, as soon
  as the gates `kit pr` applies to that change pass, without Lex's "ship it" (Lex, 2026-11-05: "yes", his own sites too). For
  his two websites, techies-reviews and lexvd-site, the lead tells Lex in plain words right after each change goes live
  and keeps the rollback in the ticket or PR (never in the message to Lex): `kit rollback <first commit> [<last commit>]`
  (the commits `kit pr` printed as "landed:", else found by subject in `git log origin/main`). It cuts a branch at origin/main,
  runs `git revert --no-edit <first>^..<last>` there and lands it with `kit pr` like any change (it waits for its gates).
- **Review loop** (Lex, 2026-11-06, after Theo's sol-loop): a review's budget depends on the risk, it stops when only
  nits are left, and the PR carries a findings ledger; the rule is under [Review loop](#review-loop) below.
- **Lex answers in desk threads, any day** (Lex, 2026-11-14; the Tuesday-only review day and its pack
  were dropped): each question or thing to try goes to him in its own desk thread, and the work keeps
  moving meanwhile ([What waits for Lex](#what-waits-for-lex)). Budget: his $200/month Claude
  subscription and the free workers, never more.
- **Cards live on Orbit** (Lex, 2026-11-06): every card in every project goes through `scripts/agents/kit ticket`
  (`--help`), Orbit's public API inside the kit. With `"tickets": "orbit"` in `scripts/agents/kit.json`, `kit brief`
  claims the card and `kit pr` moves it to Done with a dated comment naming the PR and its merge SHA; a project still on
  `files` (the default) keeps ticket files on the landing branch until `kit ticket migrate` moves it. **The Orbit
  rule:** only leads write (`ORBIT_ROLE=lead`); helpers read and report to their lead. Never delete a card for good; the
  trash, the Publish status or label and the "Scheduled in Radaar" tick each need Lex's exact words (`--lex-said`). No
  date without a source. The Orbit token and the Cloudflare pass never go in a chat, a log or a repository. **The card
  standard** ([`orbit-card-standard.md`](orbit-card-standard.md), `docs/orbit-card-standard.md` in the kit): one short
  card, history in dated comments, parts as sub-tasks, a question for Lex in a desk thread; `kit ticket check` lists the
  cards that break it.
- **One house style for every tool:** anything a person sees follows the kit's
  [house style](house-style.md) (`docs/house-style.md` in the kit; `scripts/agents/kit --home`
  prints the folder): quiet screens, instant changes with Undo, the same agent connection
  everywhere, and the Techies brand colours. The project's UX rulebook adds detail and wins where
  it differs.
- **Kit changes go through one board** (Lex, 2026-10-30): a change to the shared kit is a ticket on
  the kitchen-everywhere board (`docs/wayfinder/kitchen-everywhere/build/` in the Native Site
  Editor's repo, on its landing branch), built only by the thread that orchestrates that board. A
  thread in any other project writes the ticket there (or asks the orchestrator to) and goes on
  with its own work. A kit change that adds something `kit init` writes into a project (a file, a
  line, a hook entry) is done only when `kit init --all` has run on the machine and every listed
  project's PR has landed: `kit doctor` warns about each missing piece until then, and a project
  keeps one out on purpose by naming it in `init.skip` in its `scripts/agents/kit.json`.
- **A build's tests stay in the project** (Lex, 2026-10-30): tests and helper scripts a build
  depends on are committed and wired into the project's checks (`checks.*`,
  `unit.files`/`unit.run` or its `specs` command in `scripts/agents/kit.json`), so `kit doctor`,
  reviews and later builds find them; `/tmp` holds only throwaway output.
- **Always-loaded files stay short** (Lex, 2026-10-30): `AGENTS.md` and `CLAUDE.md` hold rules and
  pointers only; feature descriptions, history and long explanations live in the project's docs,
  linked from there. Docs and `--help` point to the test files for what is checked ("what each
  suite checks: the comments and assertion messages in its file") instead of listing the checks.

## Messages to Lex

<!-- messages-to-lex:start v1 -->
- Only what matters to him. Start with the question, or what he must do (test, do or answer).
- Add a recommendation when it fits.
- Caveman style, short bullets, plain words (he is not technical). He asks if he wants more context.
- Leave out internal process (review rounds, waivers, SHAs, file paths) unless he must act on it.
- Example: "Keep the old export button or remove it?" / "Both do the same." / "Recommend: remove it."
<!-- messages-to-lex:end -->

The two-line status notes (the after-merge note, the Board drive's check-in) keep their two-line shape (done, then running/next); when the lead passes them on, anything he must answer or do goes first.

The start marker carries the rule's version. Raise it (v2, v3 …) whenever the text changes: `kit init` brings a
project's copy up to date only when the rulebook's version is higher, so a machine with an older kit never
undoes a newer rule.

## Review loop

<!-- review-loop:start v3 -->
- Budget: 3 fix rounds; 5 only for security, permissions, auth, data loss, or state and concurrency, and only while a blocker or a should stays open with its evidence. The kit decides it from the changed paths and the ticket's words (`paths.risky` in the settings adds project patterns), never from a fixed number.
- Stop early: a round that returns only nits (a rare path, a small cost, a comment, doc or format-only point, or a missing test) ends the loop. Declined nits need no new round.
- Round 1 reviews everything. Later rounds review only the code changed since the last review and the open finding ids; the reviewer marks every old id `resolved` or `still open (<severity>): <reason>`, and a review that leaves one out is rejected as incomplete (`kit review` exits 1 and nothing reuses it): run `kit review` again. A "still open" id counts as an open finding.
- One reviewer at a time: Claude Opus through `kit review` (read-only, never the builder), and it starts no subagents. GPT may review since 2026-11-09; Claude Opus stays the main reviewer. `kit pr` then runs the second look, its models in order from [`second-look.json`](../second-look.json) (GPT through Codex first, else Grok, else the free OpenCode model; GPT never for a docs-only change, and once per PR, except as the last resort after the free OpenCode model fails), and the PR names the model that looked; when no model can run, the PR says `second look: skipped (<reason>)`, never a silent swap. For a big or risky change, `kit review --second gpt` asks GPT on purpose.
- The builder checks each finding and its severity itself (blocker, should or nit), downgrades the rare-path ones, fixes with the smallest change, and declines with evidence.
- The ledger (id, severity, outcome) comes from what the reviews wrote and is shown in the PR, never guessed.
- Stuck (disputed after two replies) or out of budget: give both sides in 2-3 lines for Lex to decide; running out of budget is never approval.
- The PR says: "Reviewed with review-loop: N rounds with <model>. Verdict: approved".
<!-- review-loop:end -->

The start marker carries this rule's version too (v2, v3 …).

`kit pr` counts the fix rounds from the review records (each earlier head at which a review, Claude's or a second
look, left a finding above a nit), and the second look follows the same budget: once it is used, only blockers block
(TOOLS-287). Known gap since the factory cut (2026-11-15): nothing hands a helper's declined findings to the next
review: a decline goes, with its reason, in the helper's report and the PR text, and the lead waives a declined
finding by id.

A diff with no change has nothing to review and a reviewer whose CLI crashes counts as unavailable (`kit review --help`);
what the PR's review block says after a rebase, and how a lead answers a builder's rounds: the README's Review loop
section.

Known limits of the review loop today (waived follow-ups): "disputed after two replies" is not detected, so the lead
tells Lex both sides by hand.

## Who cooks (pins from 2026-10-22)

`kit review` defaults to these pins (`kit review --help`), so a review needs `ASE_REVIEW_MODEL` only for the second
opinions below. `kit brief` names the builder and reviewer from the "Builder, every build" and "Review, every change"
rows here (a row with the same role in the project's extras wins). The shared `lex-coding` skill holds the same table
for all of Lex's projects.

<a id="small-chores-on-free-models"></a>

| Role | Model | How |
| --- | --- | --- |
| Lead | the selected model | runs the road; never builds and reviews the same change |
| Builder, every build | `claude-opus-5-5`, high | a T3 helper thread with the `kit brief` output (Lex, 2026-11-13: Opus builds everything; the free-model chores were dropped) |
| Review, every change | `claude-opus-5-5`, high | default (`kit review`, Lex 2026-11-13; `ASE_REVIEW_EFFORT` overrides the effort), fresh read-only session |
| Second opinion: a big or risky change, on purpose | `gpt-6.1-sol`, high, through Codex (GPT may review since 2026-11-09, Lex) | `kit review --second gpt [--pr N]`: the kind's GPT model from [`second-look.json`](../second-look.json), even when the PR already had its GPT look (never for a docs-only change), and no other model in its place; it is the PR's second look, which `kit pr` reuses on the same HEAD |
| Second look, every change, after Claude's review | per review kind (code, UX, DX, agent), first choice first, from [`second-look.json`](../second-look.json): `gpt-6.1-sol` through Codex at high effort, else `grok-4.7`, else the free `opencode/deepseek-v4.1-flash-free` | `kit pr` runs it (`kit review --second-look`); its findings block and get fix rounds like Claude's, and the PR says which model looked. Cost guard: GPT never for a docs-only change (every file in `paths.docs`, or a .md, .markdown, .rst or .adoc file outside `paths.tests` and `paths.css`, even when the project sets `paths.docs`) and once per PR, except as the last resort after the free OpenCode model fails (Lex, 2026-11-12); a model that cannot run hands over to the next; none can, or 25 minutes pass (`ASE_SECOND_LOOK_TIMEOUT`): `second look: skipped (<reason>)`. The whole order and its limits: `kit review --help`. The lead updates the table when new models appear |
| UX and design review | `claude-opus-5-5`, medium | `kit ux` (step 4) |

Sol never builds. `kit review` counts GPT and Grok reviews per week for the whole computer and refuses at the limit; on
a usage-limit `problem:` line, tell Lex the reset time and carry on with Claude.

The OpenCode second look reads only; how the kit keeps the branch's and the machine's OpenCode settings out of it:
the README's Review loop section.

<a id="stations"></a>

## The steps in detail

The twelve old stations folded into these steps (2026-11-15); an old station's link lands on its step.

<a id="1-idea"></a>
<a id="4-tickets"></a>

### 1. Card

- **Use:** `kit ticket` (`list` for what is already open, `create` with the source named); the context card at session
  start (about 30 lines read fresh from Lex's central memory). A project on ticket files keeps a map with its tickets
  (skills `wayfinder` and `to-tickets`; `node "$(scripts/agents/kit --home)/tickets.mjs" check` must pass), and
  A change Lex asks for always has a card (or ticket) that opens with "Lex (YYYY-MM-DD): …", lead fixes included.
  `triage` sorts new problems (Lex's feedback, sweep findings, failing tests) into cards or tickets.
- **Decides:** Lex, whether it is worth doing; the lead proposes where it goes. Choices Lex should see are marked
  "Check with Lex".
- **Done when:** the card has a goal and a "Done when" list (`kit ticket check` names a card without one, and
  `kit brief` warns).

<a id="2-map-and-questions"></a>

### 2. Grill

- **Use:** the `grilling` skill with Lex in the card's own desk thread; `research` (AFK, on a `research/*` branch)
  for facts; `teach` when Lex wants a concept explained.
- **Decides:** Lex answers; meanwhile an easy-to-undo question may take its recommended answer, named in that thread
  ([What waits for Lex](#what-waits-for-lex)).
- **Evidence:** his answers as a dated comment on the card (a ticket file: its `## Resolution (date)`).
- **Done when:** every question the build depends on is answered.

<a id="3-mock-up-before-any-visible-build"></a>

### 3. Prototype

- **Use:** a clickable prototype (`prototype` skill: a `prototype/<slug>` branch, or an HTML page shown with T3
  `html_render`), plus screenshots of today's screens with the project's own tool (extras). It follows the
  [house style](house-style.md) and the project's UX rulebook (`docs/agents/ux-rulebook.md`).
- **Show and tell** (Lex, 2026-10-27): a prototype of something that already exists has a Today / After switch, with
  today's real screen against the change, plus demo buttons that play each step with the feedback shown in place.
- **Prototypes ahead:** the lead prepares prototypes for the next visible cards in the queue, so Lex can try them in
  their desk threads and no build waits for sign-off.
- **Decides:** Lex clicks through and approves, in the prototype's desk thread.
- **Done when:** Lex approved it and the card links it. Changes with nothing visible skip this step (never the grill).

<a id="5-hand-out"></a>
<a id="6-build"></a>
<a id="7-checks"></a>

### 4. Build and prove

- **Hand-out:** the lead starts each card as **its own T3 thread**: one `delegate_task` with `isolation: "worktree"`,
  the pinned builder as `target`, and as `task` the whole output of `scripts/agents/kit brief <KEY> [--note "<text>"]`
  above its RESULT line (a project without cards: `kit brief --task "<title>" --owner <id> --note "<the task>"`). The
  brief names the owner, setup, pins, commands, evidence, house rules, the Messages to Lex rule, wait rule, skills, talk
  style and the report's last line (PR <full URL>, head <SHA>, checks and reviews <state>). The `agent-cap` hook caps the
  subagents inside one Claude session (5 by default); nothing counts T3 helper threads, so the lead keeps the number of
  builds running at once in hand.
- **The lead's thread is the overview** (Lex, 2026-10-26): pinned (`t3_thread_organize pin`), no PR links, no long jobs
  of its own. It follows each child's `next` notice, relays what matters to Lex and asks his decisions. Building, checks
  and landing live in the child threads.
- **Long jobs:** a long `kit pr` or spec run goes through `kit go` ([Finish the job in the turn](#house-rules)): give
  each call a 10-minute tool time limit (Claude's Bash `timeout: 600000`) and run it again on its `RUNNING:` line
  (exit 75) until the job's RESULT line; how its lock and its Windows jobs work: the README's `kit go` entry. Order of
  steps and the manual fallback: the project's runner guide (`docs/agents/runner.md`).
- **Skills:** the brief names the skills the [skills map](#skills-map) picks for the card's files.
- **Visible work:** the builder follows the [house style](house-style.md), the project's UX rulebook and the approved
  prototype.
- **Checks:** `kit unit --affected` and the project's checks (`checks` in the settings: `check` when types move,
  `lint`, `test`) while building, plus the project's own check commands for the change (extras); T3 `preview_*` tools
  to try a change by hand. A visible change also gets the project's user-level check and the screenshots its extras
  name. A visible change (one matching `paths.visible`) gets `kit ux` once it is built and the
  feature list is updated: the builder fixes what it calls broken or looks off, or says why not.
- **Decides:** the builder, inside the card's scope; anything outside it goes back to the lead.
- **Proof:** one proof line per Done when item in the report and the PR text (step 4 of
  [the road](#the-road-six-steps-and-the-grill)).
- **Closing a ticket file:** `status: closed` needs a `## Done (YYYY-MM-DD)` with one line per `## Done when` item,
  `Done when <n>: met — <evidence>` (a builder whose item is not met writes `not met — <why>` and leaves it open);
  `tickets.mjs check` and `kit pr` refuse a ticket closed without them.
- **Done when:** every check's `RESULT:` line is ok and quoted in the report, and each Done when item has its proof.

<a id="8-review"></a>
<a id="9-land"></a>

### 5. Land

- **Use:** `kit pr` (`--ticket <KEY or file>` for a card or ticket); a lead's own change runs `kit pr` too. T3
  `link_pull_request` for every PR. It runs the checks, `kit review` (Claude on every change, the
  [review loop](#review-loop)) and the second look; severities and blocking: the runner guide's Review and close.
- **UX gate** (Lex, 2026-11-14: every screen change gets the automatic UX check before it lands): `kit pr` lands a
  visible change (`paths.visible`) only with a passed result `kit ux` saved for the branch as it is now, and puts a
  `UX check:` line in the PR text; a later change to a visible file or to one of the features covering it needs `kit ux`
  again. A change that matches those paths but shows a person nothing new lands with `kit pr --not-visible "<reason>"`
  (refused when `kit ux` tried that very change and it did not pass); `--waive` does not cover the UX check. No feature
  list gives `UX check: skipped`, a change no listed feature covers `UX check: nothing to try`, never "ok"
  (`kit ux --help`).
- **Waivers** (lead only): `--waive "<reason>"` for the findings that stop the landing (above P3; once the fix rounds
  are used up, only P0 and P1) names each by id (`--waive "R1-2, SL-1: <reason>"`) or starts with their number
  (`--waive "2 findings: <reason>"`); a finding it leaves out, or one new at a head a rebase brought, stops `kit pr`
  with a plain reason. P3 findings, test gaps and docs wording need no names; the waiver text stays in the PR. A project
  with a feature list (`featureList` in the settings) stops a visible change unless it updated the list or its Done
  says `Feature list: no change (<reason>)`.
- **Browser runs on a busy machine:** `kit pr`'s browser step runs one at a time per machine; a failed spec file the
  change did not touch is rerun once alone and, passing alone, lands as `flaky under load: <file>` (the weekly
  `kit sweep` names a file flaky 3 or more times in 7 days: give it a fix card). The locks, timing files and what
  `kit pr` reads from the project's specs command: the README's Browser runs section.
- **Evidence:** the main root's `.scratch/reviews/<owner>/<time>/`, with `findings.json` listing each finding's kind
  (real fault, mismatch with the ticket, timing/race, style); a helper's declined findings and their reasons are in its
  report and the PR text.
- **Never:** a raw `git push` to the release branch (or a landing branch that is also the release branch, as on a live
  site); the Bash hook refuses it and names `kit pr`.
- **Done when:** the PR is merged into the landing branch; on Orbit `kit pr` moves the card to Done with the PR and its
  merge SHA (a PR the merge queue takes leaves the card open: close it with `kit ticket update <KEY> --status Done` once
  it lands).

<a id="10-after-a-merge-note-scoreboard"></a>
<a id="11-lexs-end-check"></a>

### 6. Lex tries it

- **After a merge:** the lead runs the project's after-merge step (a preview deploy where the project has one;
  extras), then a two-line plain note to Lex (see [Messages to Lex](#messages-to-lex)): what was done, and whether he
  would notice anything; a screenshot contact sheet through `html_render` only when something visible changed. Lex's
  corrections go to the chat memory, which the weekly learning reads.
- **Scoreboard:** `kit score [map]` prints what the kit recorded per piece (builder, time, review rounds, findings by
  kind, cost where known, landing); `--html` makes the build page the lead shows with T3 `html_render`.
- **The desk:** the lead tells Lex the change is ready to try in a desk thread, with the prototype beside it (where to
  try it: extras) and a plain what-to-test list (what a user could notice, where to look, what to try). First the lead
  runs the project's whole user-level check on the landing branch, where it has one (extras), and sends its summary
  with that list. In a direct project the landing branch is live: a user-level check the project wants before going
  live belongs in its `checks` (which `kit pr` runs for code-size changes; docs and CSS changes run lighter steps, so a
  check that must guard those needs a CI workflow on pull requests); otherwise the lead runs it right after the merge,
  rolls the change back if it fails, and the note to Lex follows.
- **Releases wait for Lex's go, work doesn't** (a direct project has no release to wait for): the next card starts at
  once on the landing branch.
- **Decides:** Lex. Each correction becomes a card.
- **Done when:** Lex says "ship it". A direct project (`branches.direct`) is the exception: the release does not wait
  for his go (other hard-to-undo items still do); the project's `checks` are the gate, and Lex hears about the change afterwards (the house rule says how for his two
  websites).

<a id="12-release"></a>

### 7. His go

- **Use:** only after Lex's written "ship it". The exception is a direct project
  (`branches.direct`): it has no release step and needs no "ship it", its merge into main is the release as
  soon as the project's `checks` pass for a code-size change (docs and CSS changes run lighter steps) and the
  review passes, and the project's steps follow it (the house rule says what the lead tells Lex). Otherwise `kit pr --release` (the landing
  branch into the release branch, `branches.release`), merge once CI passes, then the project's
  release steps and first-hour check (extras). A build with a rollout checklist follows it.
- **Release check:** `kit pr --release` first runs `kit release-check --land` (a clean tree, HEAD
  exactly `origin/<land>` before `origin/<release>` is merged into it), and a project's own live
  deploy command starts with `scripts/agents/kit release-check` (a clean tree outside `.scratch/`,
  HEAD exactly `origin/<release>` after a fetch), so nothing unsaved and nothing that skipped
  `kit pr` goes live (a rerun after kit pr merged main into the cut says to cut it again from
  `origin/<land>`). A preview deploy from a landing branch that is not live runs no check. Only a
  lead may pass it with `--waive "<reason>"`, which its `RESULT:` line names; `kit pr --release
  --waive` hands the reason on, so one waiver covers both the review findings and the check.
  The release joins `origin/<release>` by one merge into the cut and lands once CI passes as a merge commit,
  never a rebase or squash; `kit pr --sync-main` lands a merge of main into dev, kit's or one made by hand (README, "Releases").
- **Done when:** the live project serves the new version and its number is recorded where the
  extras say.

## Skills map

The kit names skills, never copies them (paid skills stay on the machine): `skills.json` in the kit
maps a job to skill names, each with the kit's own one-line fallback. `kit brief` and `kit review`'s brief use it.
Claude gets `/name`, Codex `$name`, and a model without skills (OpenCode, Grok) the fallback line. **House rules beat
skill advice:** where a skill suggests what a house rule forbids (a toast, say, against "no toasts, feedback in
place"), the house rule wins.

- **Talk style** (the style line): caveman.
- **Any UI build or styling** (CSS, UI and component files, or styling words in the card): good-css,
  emil-design-foundations, emil-ui-polish; by topic, only when the change touches UI: forms, inputs and buttons
  (emil-forms-and-inputs), type (emil-typography), colour and tokens (emil-color), menus, popovers, panels and dialogs
  (emil-surfaces), touch and accessibility (emil-touch-and-accessibility), phone layouts (emil-mobile-native), motion
  (emil-animations, animate), speed (emil-performance), component APIs (emil-component-design), the design system docs
  (emil-design-system-docs), marketing pages (emil-marketing-pages).
- **UI review** (`kit review` on a UI diff; **planned** for `kit ux`): emil-ui-review, emil-unslop-design, break-ui.
- **Before a release** (**planned**: no release brief yet, so never claim it ran): emil-prep-for-prod.

A project adds or removes names with `"skills": { "add": [...], "remove": [...] }` in `scripts/agents/kit.json`. A
skill missing on a machine is a `kit doctor` note (`skills map`), never a failure.

## Weekly routines

Scheduled with T3 `schedule_task` at a fixed time (Europe/Amsterdam), on Tuesday morning (Lex,
2026-10-27; was Monday); each result goes to Lex in a desk thread.

- **Sweep, Tuesdays 07:00:** the project's `docs/agents/routines/sweep.md`. `kit sweep` gathers the
  week's numbers into a small bundle; the session applies `improve-codebase-architecture` (list
  only) plus guardrail candidates and writes `docs/work/sweeps/YYYY-MM-DD.md` through `kit pr`. It
  lists bad patterns and changes nothing; Lex gets the top 3, each with a recommended fix, and picks
  which become cards.
- **Chat learning, even ISO weeks, right after the Tuesday sweep (same scheduled run):** the
  project's `docs/agents/routines/learning.md`. `kit sweep --learn` (was `kit learn`) groups the corrections the chat
  project's sync collects in `~/Projects/chat/memory/` with any build feedback logs still on file; the session
  applies `retro` and writes `docs/work/learning/YYYY-MM-DD.md` through `kit pr`. Each correction
  Lex gave more than once gets one proposed automatic check (hook, lint rule or kit check; the
  project's `docs/agents/guardrails.md`) or UX rulebook line, or a [house style](house-style.md)
  rule when the same correction comes from two or more projects; nothing is added until Lex picks.

<a id="tuesday-review"></a>

## What waits for Lex

Lex answers in desk threads, any day (Lex, 2026-11-14; the Tuesday-only review day of 2026-10-27 and its
Tuesday pack were dropped). Agents keep working on everything that does not need him.

- **Easy-to-undo defaults:** an easy-to-undo choice takes its recommended answer at once, and the lead
  names it in that card's desk thread so he can reverse it. Easy to undo: anything that lands on the
  landing branch (or a preview of it) and can be changed by a later card (not in a direct project, whose
  landing branch is live). Grilling answers and prototype choices count when the work they steer is still
  unreleased.
- **Hard to undo, waits for his word:** going live (release; a direct project goes live on its own merge,
  see the house rule); public repos, packages or GitHub Issues; anything that costs money; deleting what
  cannot be recovered; changes to visitors' sites (a direct project's own site excepted: it goes live on
  its merge, see the house rule); his settings, keys and secrets (T3 `request_secret`, never chat); a
  change in builder routing; which sweep findings become cards; new checks or rulebook lines from chat
  learning.
- **Questions in their own thread:** each question for Lex gets its own desk thread, written in plain
  words with a ➡️ recommended answer; ⚠️ marks the hard-to-undo ones.
