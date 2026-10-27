# The kitchen

How work moves from idea to release in every project of Lex's: one recipe every session and every
model follows. Lex calls it the kitchen (Poteto's cooking metaphor): **Lex is head chef**, the lead
session runs the pass, builders and reviewers are line cooks, Agent Kit and the skills are the
knives. Each **station** below names its tools, who decides, the **evidence** it leaves and when it
is **done**. The project's own docs stay the detailed source for their station; this page decides
the order.

This is the shared rulebook; it travels with the kit. `scripts/agents/kit rulebook` prints it
followed by the project's extras (the file `rulebookExtras` names in `scripts/agents/kit.json`):
the project's landing and release branches, checks, own commands, shared file, previews, release
steps and history. **Where the extras differ, they win.** Below, "the landing branch" is
`branches.land` in the settings file, "the project's checks" are its `checks` commands, and
"`<land>`" stands for the landing branch's name.

Items marked **planned** are decided but not built. Until a planned item lands, do what the station
says for today; never claim a planned item ran.

## House rules

- **Agent Kit for every coding step, every model:** `scripts/agents/kit`, `kit doctor` first. A kit
  command that cannot run is reported in the result; it is never skipped silently.
- **One job, one worktree:** `scripts/agents/worktree.sh` from `origin/<land>`; `git -C` or
  `cd … || exit 1`; work in progress is a commit on your own branch.
- **Lex in plain words:** questions are plain choices about what changes for him, each with a
  recommended answer. Technical questions go to him too, explained plainly with file paths.
- **Tuesday is Lex's only review day** (Lex, 2026-10-27): everything that needs him waits in one
  [Tuesday pack](#tuesday-review); between Tuesdays the work keeps moving. Budget: his $200/month
  Claude subscription and the free workers, never more.
- **Everything is a file on the landing branch:** maps, tickets, Lex's feedback and decisions
  (the project's issue tracker guide, `docs/agents/issue-tracker.md`). A change Lex asks for always
  has a ticket that opens with "Lex (YYYY-MM-DD): …", including lead fixes.

## Who cooks (pins from 2026-10-22)

`kit review` and `kit fix` default to these pins (`kit review --help`, `kit fix --help`), so a
review needs `ASE_REVIEW_MODEL` only for the second opinions below; `kit slice` still needs
`--builder`. `kit next` reads its builder and reviewer from the "Builder, every slice" and "Review,
every change" rows here (a row with the same role in the project's extras wins). The shared
`lex-coding` skill holds the same table for all of Lex's projects.

| Role | Model | How |
| --- | --- | --- |
| Lead | the selected model | runs the stations; never builds and reviews the same change |
| Builder, every slice | `claude-opus-5-5`, high | `kit slice --builder claude-opus-5-5`; `builder: sol` lines in tickets are superseded |
| Builder, tiny fully specified fix | free OpenCode model | T3 `delegate_task`, only once T3 lists a verified zero-cost model |
| Builder, small chore beside the queue | free OpenCode model | [Small chores](#small-chores-on-free-models); a short Claude check before merging |
| Review, every change | `claude-opus-5-5`, medium | default (`kit review`), fresh read-only session |
| Second opinion: final version of a big, delicate slice, once | off since 2026-10-26: no OpenAI reviews (Lex); use Grok | was `ASE_REVIEW_MODEL=gpt-6.1-sol kit review --ticket <t>` |
| Second opinion: routine, and the weekly sample of 2–3 Claude-approved slices | off since 2026-10-26: no OpenAI reviews (Lex); use Grok | was `ASE_REVIEW_MODEL=gpt-6-luna kit review` |
| Second look, every change, after Claude's review | per review kind (code, UX, DX, agent) from the table [`scripts/agents/second-look.json`](../second-look.json): `grok-4.7`, else the free `opencode/deepseek-v4.1-flash-free` | `kit slice` and `kit pr` run it (`kit review --second-look`); its findings block and get fix rounds like Claude's. Kind from the changed paths: agent setup first, then UX (`paths.visible`), then DX (build, scripts, docs), else code. Grok out of credit or its weekly count used up: OpenCode takes it; neither can run: the change lands with `second look: skipped (<reason>)`. Never an OpenAI model. The lead updates the table when new models appear |
| UX and design review | `claude-opus-5-5`, medium | see Review |

Sol never builds. `kit review` counts GPT and Grok reviews per week for the whole computer (one count
whatever project asks; the Tuesday sweep shows the week's Grok use by project) and refuses at the limit;
on a usage-limit `problem:` line, tell Lex the reset time and carry on with Claude.

## Stations

### 1. Idea

- **Use:** Lex's T3 chat; `kit status` and `node scripts/agents/tickets.mjs frontier` for what is
  already open; the context card (about 30 lines read fresh from Lex's central memory, printed at
  session start and by `kit card`).
- **Decides:** Lex, whether it is worth doing; the lead proposes where it goes.
- **Done when:** the idea has a home on the landing branch: a new map, a ticket in an existing map
  or build, or a tech-debt issue.

### 2. Map and questions

- **Use:** skills `wayfinder` (map and tickets), `research` (AFK, on a `research/*` branch),
  `grilling` (Lex in the loop), `prototype`, `teach` when Lex wants a concept explained. Files and
  claiming: the project's issue tracker guide.
- **Decides:** Lex answers grilling questions in the Tuesday pack; between Tuesdays an easy-to-undo
  one takes its recommended answer and is listed there ([Tuesday review](#tuesday-review)). Research answers facts.
- **Evidence:** each ticket's `## Resolution (date)` and one line in the map's Decisions so far.
- **Done when:** every ticket the build depends on is closed, and Not yet specified holds only what
  the build can do without.

### 3. Mock-up (before any visible build)

- **Use today:** a clickable mock-up (`prototype` skill: a `prototype/<slug>` branch, or an HTML
  page shown with T3 `html_render`), plus screenshots of today's screens with the project's own tool
  (extras). Visible tickets and mock-ups follow the project's UX rulebook (`docs/agents/ux-rulebook.md`).
- **Show and tell** (Lex, 2026-10-27): a mock-up of something that already exists has a Today / After
  switch, with today's real screen against the change, plus demo buttons that play each step with the
  feedback shown in place.
- **Mock-ups ahead:** the week before, the lead prepares mock-ups for the next visible changes in the
  queue (the running build's next stage, then the next build), so Lex approves them in one batch in
  the Tuesday pack and no slice waits for sign-off.
- **Decides:** Lex clicks through and approves, on Tuesday.
- **Done when:** Lex approved it and the ticket links it. Changes with nothing visible skip this station.

### 4. Tickets

- **Use:** `to-tickets`; a build folder with a README holding rules, gates and waves; one slice per
  ticket with size, Files, Done when, kit commands and the evidence its builder reports; a visible
  ticket follows the UX rulebook. `triage` sorts new problems (Lex's feedback, sweep findings,
  failing tests) before hand-out: when two or more new tickets share a cause and touch the same
  files, give each `group: <slug>` and list the group in one row of the build README; `kit next`
  then hands the whole group to one builder. Tickets that only sit in the same area stay apart.
- **Decides:** the lead; choices Lex should see are marked "Check with Lex".
- **Done when:** `node scripts/agents/tickets.mjs check` passes and the frontier shows the first wave.

### 5. Hand-out

- **Use:** `scripts/agents/kit next [map…]` picks the tickets and builders by fixed rules.
  The lead claims each `next:` ticket on the landing branch (assignee, commit, push) and starts it as
  **its own T3 thread**: one `delegate_task` per ticket (or group) with `isolation: "worktree"`,
  `mode: "async"`, the ticket's builder as `target`, and this brief:

  > Build slice `<ticket path>` in `<project>`, owner `<owner>`. Follow docs/agents/runner.md from Setup to
  > Report with Agent Kit (`scripts/agents/kit`); builder `<model>`, `ASE_REVIEW_MODEL=<review pin>`. Last line: PR <full URL>, head <SHA>, checks and reviews <state>.

  The child thread runs the slice from setup to `kit pr`, links only its own PR and settles when T3 sees it merged.
  Delegated (`opencode/…`) tickets go the same way with their free model.
- **The lead's thread is the overview** (Lex, 2026-10-26): pinned (`t3_thread_organize pin`), no PR
  links, no long jobs of its own. It follows each child's `next` notice, relays what matters to Lex,
  asks his decisions and keeps the map; jobs started in a lead turn die when that turn ends (each
  turn is its own systemd scope), so building, checks and landing live in the child threads.
- **Heartbeat** (while a build runs): the lead creates a T3 `schedule_task` every 30 minutes, bound
  to the lead's thread, with this prompt: "In the dev worktree run
  `scripts/agents/kit heartbeat <map> --start` and post its `done:` and `running/next:` lines to
  Lex. On a `stuck:` line read that job's log tail and decide: `kit fix --note`, a helper agent, or
  tell Lex. On `claimed with no job` read that slice's log and rerun it or tell Lex; a delegated
  (`opencode/…`) ticket has no slice log, so check its T3 `delegate_task` instead. After a
  `merged:` line run the project's after-merge step (extras), and the scoreboard page at
  milestones. On `RESULT: … stop` delete this schedule (`delete_scheduled_task`) and tell Lex."
  After an app restart: `kit bg --list`, then `kit heartbeat <map>`. The heartbeat never deploys.
- **Limits** (`kit next` applies them): at most 5 slices at once, at most 2 in the project's shared
  file (`sharedFile` in the settings), no other shared file, `runs_alone: true` tickets alone in
  their map, nothing from a build whose README still says `**Not started:**`; the build's other
  rules stay with the lead.
- **Done when:** every frontier ticket the limits allow is claimed and running. A ticket waiting on
  a hard-to-undo choice goes into the Tuesday pack, and its build's other tickets keep running.

### 6. Build

- **Use:** `kit slice --ticket <t> --builder claude-opus-5-5` under `kit bg` (the kit's default reviewer is Claude; set `ASE_REVIEW_MODEL` only for a second opinion);
  wait once with `kit wait job slice-<NN> --timeout 2h` in the background. Order of steps, manual
  fallback and ticket Done: the project's runner guide (`docs/agents/runner.md`).
- **Decides:** the builder, inside the ticket's Files; anything outside them stops the slice.
- **Done when:** the builder's commits and the ticket's `## Done` are on the slice branch.

### 7. Checks

- **Use:** `kit unit --affected`, the project's checks (`checks` in the settings: `check` when
  types move, `lint`, `test`) and the project's own check commands for the change (extras). T3
  `preview_*` tools to try a change by hand. A visible change (one matching `paths.visible`) gets
  the project's user-level check and screenshots (extras).
- **Done when:** every check's `RESULT:` line is ok and quoted in the report; a visible change has
  its contact sheet.

### 8. Review

- **Use:** `kit review` (inside `kit slice` and `kit pr`), Claude on every change, up to 3 `kit fix`
  rounds; severities and blocking: the runner guide's Review and close. Second opinions per the
  pins above. A visible change also gets the Opus UX review (the gate after the code review in
  `kit slice`; the extras name its command) against the UX rulebook and the approved mock-up:
  broken gets one fix round and stops the slice only if still broken, looks off gets one fix round
  and then lands with UX follow-ups in the ticket.
- **Decides:** the lead weighs each finding; a rejected finding is written down with its reason.
- **Evidence:** the main root's `.scratch/reviews/<owner>/<time>/`, with `findings.json` listing each
  finding's kind (real fault, mismatch with the ticket, timing/race, style) and the builder's declined
  findings with reasons; decisions in the ticket's Done.
- **Done when:** the `kit pr` gate has nothing blocking.

### 9. Land

- **Use:** `kit pr --ticket <t>` (`kit slice` does it); a lead's own change runs `kit pr` too. T3
  `link_pull_request` for every PR. Lead-only `--waive "<reason>"`. A project with a feature list
  (`featureList` in the settings) stops a visible change unless it updated the list or its Done says
  `Feature list: no change (<reason>)`.
- **Done when:** the PR is merged into the landing branch and its number is in the ticket's `landed:`.

### 10. After a merge: note, scoreboard

- **Use:** the lead runs the project's after-merge step (a preview deploy where the project has one;
  extras). Then a two-line plain note to Lex: what was done, and whether he would notice anything;
  a screenshot contact sheet through `html_render` only when something visible changed. Every
  correction from Lex gets one line in the build's feedback log: `kit feedback <map> --kind K
  "<text>"` (the issue tracker guide's build files); fill its fix with `--fix-for` once the ticket
  or PR exists.
- **Scoreboard:** the kit records builder, time, review rounds, findings by kind, cost where known
  and landing per piece; `kit score <map>` prints it and `kit score <map> --snapshot` writes
  `build/scoreboard.json` for the lead to commit at the end of a build.
- **Build page:** at each milestone and at the end, the lead runs `kit score <map> --html` and shows
  the page it prints with T3 `html_render`: where the build is, what reviews caught, what Lex
  corrected, the ladder and builders, in plain words.
- **Done when:** the after-merge step's `RESULT:` line is ok and the note is sent.

### 11. Lex's end check

- **Releases wait for Tuesday, work doesn't:** when a build's (or stage's) frontier is empty, its end
  check goes into the next Tuesday pack, and the next stage or the next build in the queue starts at
  once on the landing branch. A gate line in a build README saying "after X's release" means "after
  X's frontier is empty" for starting work; X's release itself still waits for Lex.
- **Use:** the lead tells Lex the change is ready to try (in the Tuesday pack; where to try it:
  extras), with a plain what-to-test list (what a user could notice, where to look, what to try).
  First the lead runs the project's whole user-level check on the landing branch, where it has one
  (extras), and sends its summary with that list.
- **Decides:** Lex. Each correction becomes a ticket in the build (station 4) and one feedback log
  line (`kit feedback <map> --kind K --fix <ticket> "<text>"`, committed with the ticket); the
  log is what the ladder counts. A problem he finds after release adds `--after-release`.
- **Done when:** Lex says "ship it".

### 12. Release

- **Use:** only after Lex's written "ship it" (given on Tuesday): `kit pr --release` (the landing
  branch into the release branch, `branches.release`), merge once CI passes, then the project's
  release steps and first-hour check (extras). A build with a rollout checklist follows it.
- **Done when:** the live project serves the new version and its number is recorded where the
  extras say.

## UX confidence ladder

**Rung 1 today: Lex checks everything before release.** Rung 2: Lex checks a sample, the UX
reviewer checks everything. Rung 3: changes with nothing visible release on their own once every
check passes; visible ones wait for Lex. Rung 4: small visible changes release on their own, bigger
ones wait.

Up one rung after 5 builds in a row with no UX correction from Lex; down one rung whenever Lex
finds a UX problem after release. The lead brings each move to Lex. Rungs 2–4 need the planned UX
review and checking tool.

## Weekly routines

Scheduled with T3 `schedule_task` at a fixed time (Europe/Amsterdam), on Tuesday morning before Lex
reviews (Lex, 2026-10-27; was Monday); both results go into that day's Tuesday pack.

- **Sweep, Tuesdays 07:00:** the project's `docs/agents/routines/sweep.md`. `kit sweep` gathers the
  week's numbers into a small bundle; the session applies `improve-codebase-architecture` (list
  only) plus guardrail candidates and writes `docs/work/sweeps/YYYY-MM-DD.md` through `kit pr`. It
  lists bad patterns and changes nothing; Lex gets the top 3, each with a recommended fix, and picks
  which become tickets.
- **Chat learning, even ISO weeks, right after the Tuesday sweep (same scheduled run):** the
  project's `docs/agents/routines/learning.md`. `kit learn` groups the corrections the chat
  project's sync collects in `~/Projects/chat/memory/` with the build feedback logs; the session
  applies `retro` and writes `docs/work/learning/YYYY-MM-DD.md` through `kit pr`. Each correction
  Lex gave more than once gets one proposed automatic check (hook, lint rule or kit check; the
  project's `docs/agents/guardrails.md`) or UX rulebook line; nothing is added until Lex picks.

## Tuesday review

Lex reviews only on Tuesdays (Lex, 2026-10-27). The lead keeps one pack per Tuesday and agents
keep working on everything that doesn't need him.

- **The pack:** `docs/work/tuesday/YYYY-MM-DD.md`, filled during the week, plus one visual page
  served online (mock-ups, the build order with ready dates). It is written in plain words, and each question has a ➡️
  recommended answer; ⚠️ marks the hard-to-undo ones; one round of questions. It holds, in order:
  releases ready for his go-ahead (end checks), mock-ups to approve, hard-to-undo questions, the
  easy-to-undo defaults taken since last Tuesday (so he can reverse them), the sweep's top 3, and
  the ready-date guesses.
- **Easy-to-undo defaults:** mid-week, an easy-to-undo choice takes its recommended answer at once, and
  the pack lists it. Easy to undo: anything that lands on the landing branch (or a preview of it)
  and can be changed by a later slice. Grilling answers and mock-up choices count when the work
  they steer is still unreleased.
- **Hard to undo, waits for Tuesday:** going live (release, and every move up the ladder); public
  repos, packages or GitHub Issues; anything that costs money; deleting what cannot be recovered;
  changes to visitors' sites; his settings, keys and secrets (T3 `request_secret`, never chat); a
  change in builder routing; which sweep findings become tickets; new checks or rulebook lines from
  chat learning.
- **Ready-date guesses:** each build README carries one line, `**Ready (guess):**`, with the date it
  should go live. The lead updates it when a build or stage lands, never with live time tracking.
- **Questions in their own thread:** an urgent question that can't wait for Tuesday (a hard-to-undo
  choice blocking every slot) still gets its own T3 thread. Everything else goes into the pack.

## Small chores on free models

Low-risk tidying runs beside the main queue on the free OpenCode workers (Lex, 2026-10-27), for
example splitting a file that grows into a god file, or a DX friction ticket.

- **Fit:** fully specified, no visible change, with tests that pin the behaviour, and none of the
  running build's files (`kit next`'s shared-file rule decides). It runs only when a slot is free;
  main-queue slices come first.
- **Build:** a free OpenCode model through T3 `delegate_task` (as in the pins), then Agent Kit's
  `kit unit --affected` and the project's checks.
- **Check before merging:** one short Claude review (`kit review`, one round, no fix rounds on
  Claude; a failed check goes back to the free worker or is dropped). That review is the chore's only
  Claude use.
- **Evidence:** the chore's ticket under `docs/work/` with its `## Done`, merged through `kit pr`,
  and one line in the next Tuesday pack.
