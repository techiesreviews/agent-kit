# Agent Kit

The shared kitchen every one of Lex's projects runs: one set of agent commands (`kit doctor`, `kit brief`,
`kit review`, `kit pr`, …), the guard hooks for Claude and Codex, and the kitchen rulebook. Each project keeps
only a small launcher and its own settings; the kit itself lives here, once.

## How a project uses it

- On a machine without the kit yet, fetch it once and fill the machine copy:
  `git clone --depth 1 https://github.com/techiesreviews/agent-kit ~/.cache/agent-kit && ~/.cache/agent-kit/kit update`.
- Then turn on the update timer, so every later kit merge reaches the machine within 15 minutes while you are
  logged in (a `systemd --user` timer; `loginctl enable-linger` keeps it running logged out):
  `~/.local/share/agent-kit/current/kit update --install-timer`.
- `kit init` (run once, from the machine copy: `~/.local/share/agent-kit/current/kit init`) writes the project's
  `scripts/agents/kit.json` settings, the launcher `scripts/agents/kit`, the hook launcher
  `scripts/agents/hooks/run.sh`, the hook entries in `.claude/settings.json` and `.codex/hooks.json`, and the
  line `* text=auto eol=lf` in `.gitattributes`, and a one-line `CLAUDE.md` (`@AGENTS.md`) so a direct Claude session loads `AGENTS.md`. It writes only what is missing (and updates the kit's own marked "Messages to Lex" section when the rulebook's version is higher), so it can run again: when the kit
  adds a piece later, `kit doctor` warns about it in every project set up before, `kit init` adds it, and
  `kit init --all` lands it in every project the machine lists, each through its own `kit pr`. A project keeps a
  piece out on purpose by naming it in `"init": { "skip": [...] }` in its settings (`kit init --check` prints the names).
- A project in a **private** GitHub repo lands straight on main: `"branches": { "land": "main", "release": "main", "direct": true }` in its settings, so `kit pr` opens ordinary PRs into main (the same gates as any `kit pr`: checks and review by the change's size, the second look when a model can take it; no `--release` step).
  `kit init` sets this for a new private repo (asked of `gh repo view --json visibility`; if gh cannot tell, it sets nothing and says so), and `kit init --check` prints the exact change for an existing project, whose settings it never edits.
- Every command then goes through the launcher: `scripts/agents/kit <command>`; bare `scripts/agents/kit` lists
  them, `scripts/agents/kit <command> --help` explains one. A project's own commands sit in the folder its
  settings name (`commands`).
- The launcher runs the machine copy, `${XDG_DATA_HOME:-~/.local/share}/agent-kit/current`, filled by
  `kit update` from this repo's `main`. Where there is no machine copy (GitHub Actions, a new laptop) it clones
  `main` once into `${XDG_CACHE_HOME:-~/.cache}/agent-kit`. This repo is public so that needs no token.
- To try a kit branch in a project before it lands: `KIT_HOME=~/Projects/agent-kit-<branch> scripts/agents/kit …`.

## A raw push to a live branch is stopped

- The Bash hook (`hooks/bash-guard.sh`) refuses an agent's `git push` that would reach the project's release branch
  (`branches.release` in `scripts/agents/kit.json`), however it is written (`main`, `HEAD:main`, `refs/heads/main`,
  `+main`, `--force`, `--all`, `--mirror`, a lone `:`, a deletion, `git -C`, after a `cd`, or a bare `git push`
  whose upstream is that branch), and names `kit pr` as the way through. A folder named through a variable,
  `$( … )`, `cd -`, `popd` or `--git-dir`, or a `cd` that did not take, is checked as both the session's folder and
  its project folder. Any remote counts, a fork too. `--dry-run` passes, and so does every push in a project
  without `branches.release`. The hook reads the settings only when a command pushes.
- A landing branch that goes live on every push (a site that deploys from it) is guarded by naming it as the release
  branch too: `"branches": { "land": "main", "release": "main" }`.
- Only agents' shells are guarded: the hook runs in Claude and Codex sessions, so a person's own terminal, CI and the
  Native Site Editor's saves (through the GitHub API) are untouched. The kit's own pushes run inside kit commands
  (`kit pr`'s PR branch, from Node; `kit pr`'s merge goes through
  `gh`), which the hook never sees. That is the allowance for the kit's steps: a step that must push a guarded
  branch belongs in a kit command, never in a raw `git push`.
- What changes for a lead: docs and ticket commits pushed straight to the landing branch keep working where it is not
  the release branch (the Native Site Editor's `dev`). Where the two are one branch (this repo, a live site), they
  land through `kit pr` (docs tier).

## Review loop

The review budget follows the risk (after Theo's sol-loop): 3 fix rounds, 5 only for security, permissions, auth, data loss, state or
concurrency (by changed paths and the ticket's words; `paths.risky` in the settings adds project patterns), and a review that returns
only nits ends the loop. Round 2 and later review only the code changed since the last review and the open finding ids (`R1-1`, …),
each marked resolved or still open; `kit pr` puts the line "Reviewed with review-loop: N rounds with <model>. Verdict: approved" and a
findings ledger in the PR, and an out-of-budget run is reported, never approved. The rule's one source is the "Review loop" section of
`docs/kitchen.md`; briefs carry it and `kit init` points projects at it.

The PR's review block says "Verdict: pending" while a new head (after a "behind" rebase) is reviewed and "not approved" when that review stops the landing or does not finish; a review with only nits is reused after a rebase with the same patch; the ledger lists the second look's findings as SL-<n> rows; an out-of-budget report counts every open item and shows the builder's declined findings with their reasons. A second look that no model could take is written into the PR block as "second look: skipped (<reason>)"; one that ran is named there in plain words, such as "Second look by gpt-6.1-sol (GPT through Codex).". An out-of-budget should lands as a follow-up.

After a merge from the base, the "changes since the last review" file lists only the branch's own commits (merges left out, so a conflict fixed inside a merge commit is not in it). A lead who lands a builder's branch answers the builder's rounds, so the PR line counts them and names every model the rounds used. A ticket's risk comes from its title and its whole text (an Orbit card's description and Done when line too) and the files it names, never from the follow-ups `kit pr` adds later.

`kit pr` counts the fix rounds from the review records (TOOLS-287): each earlier head of the branch at which a review left a finding above a nit, Claude's rounds (the chain of `findings.json` records) and the branch's earlier second looks alike. Reviews at the same head (both looks, or a round after a decline) are one round, and a clean or nits-only review calls for no fix and counts none. Once 3 are used (5 for a risky change), only blockers (P0, P1) block, for both looks, and the shoulds left land as follow-ups for Lex, never as approval. The count survives a rebase that keeps the patch only while the head stays (Claude's review is reused, and the second looks are found from the head it saw); the next commit after it starts the count again, as Claude's review starts again at round 1 once the old head is gone from the history. A rebase that changes the patch starts it again at once, and so does any rebase in the docs tier, which has no Claude review to anchor it. Rounds the cut `kit fix` saved (`.scratch/kit-fix`) still count. A lead may give `--waive` more than once: ids count in any of the reasons, and counts add up (once any reason names an id, the counts are not read). Nor does anything hand a helper's declined findings to the next review any more (`kit fix` set `ASE_REVIEW_DECLINED` and saved them): a decline goes, with its reason, in the helper's report and the PR text, and the lead waives it by id.

Known limits (waived follow-ups): a review that leaves an id out is rejected as incomplete: run `kit review` again by hand. The fix brief points at the newest complete review.

The OpenCode second look reads only: it may read, search and list files, nothing else. The kit works with OpenCode 1 and 2 (before each OpenCode review it reads `opencode run --help` to tell them apart, usually well under a second, about 30 seconds at most if the CLI hangs; it stops in plain words when the help names neither). OpenCode 2 has no switch to turn plugins off, so there the kit turns the branch's own OpenCode settings off and gives each review an empty settings folder of its own, and drops a settings file or folder named in `OPENCODE_CONFIG` or `OPENCODE_CONFIG_DIR`: no plugin from the branch under review or from `~/.config/opencode` loads, and the machine's OpenCode settings (default model, global instructions) do not apply to the review either.

## Browser runs

`kit pr`'s browser step runs one at a time per machine (it waits, saying `waiting for <owner>'s full browser run`). A
failed spec file the change did not touch is rerun once alone: passing alone, it lands as `flaky under load: <file>` on
the `RESULT:` line and in `flaky.jsonl` in the kit's state folder; a file the change touched must pass in the full run,
and a run that did not report every file it ran is never forgiven. The settings' `timing` spec files run after the
rest, each alone; with a `timing` list the selection is listed first, and a change that selects nothing takes no lock.
While a spec file runs alone (timing file or rerun) no new kit job starts (`waiting for <owner>'s lone browser run`),
except `wait`, `version`, `rulebook` and help; jobs already running carry on. The locks need `flock` (`kit doctor` says
when it is missing; the runs then go unlocked). What `kit pr` reads from the project's specs command: `--list` prints
one `<file> [<groups>] …` line per selected file, or ends `RESULT: ok specs none affected` (or `0 selected`); a run
prints `✓ <file> (…)` or `✗ <file>: <test> — <error>` per file and ends `RESULT: fail specs N of M failed` when any
failed. The weekly `kit sweep` bundle names a file flaky 3 or more times in 7 days.

## Messages to Lex

One short rule for every message to Lex (question or what he must do first, a recommendation, caveman bullets,
no internal process): the "Messages to Lex" section of `docs/kitchen.md` is its only text. `kit rulebook` prints it,
every `kit brief` carries it, and `kit init` copies it into a project's `AGENTS.md` between markers. A later change
to the rule reaches those copies the same way: the rule carries a version (`v1` in its start marker, raised with
every text change); `kit doctor` and `kit init --check` report a marked section with a lower version as outdated (not missing), and `kit init`
updates it in place. A machine with an older kit never undoes a newer copy. A project whose "Messages to Lex" heading has no
markers keeps its own words. A project set up before the rule gets the section like any new piece: `kit doctor`
warns, `kit init` (in the project) or `kit init --all` (every listed project, each through its own `kit pr`) adds it.

## Spending API credit on the kit's own Claude calls (opt-in, off by default)

- **Turn on:** put your API key alone on one line in a file, run `chmod 600` on it, and start the kit with `KIT_API_KEY_FILE=<that file>` in the environment (optional: `KIT_API_CONFIG_DIR`, default `~/.claude-api`).
- **What it covers:** the kit's headless Claude calls (`kit review`, `kit ux`). Interactive sessions are not touched; Anthropic's credit does not cover them.
- **Jobs systemd starts for you** do not see your shell's variables: run `systemctl --user import-environment KIT_API_KEY_FILE KIT_API_CONFIG_DIR` first (leave out the second if you use the default), or export them in the shell that starts the kit; to turn the route off for those jobs, run `systemctl --user unset-environment KIT_API_KEY_FILE KIT_API_CONFIG_DIR` as well.
- **Turn off:** unset `KIT_API_KEY_FILE`. The kit then uses the subscription as before.
- **Safety:** only the child process that runs `claude` passes the key on (the kit itself reads the key file's first line just to see it is not blank, and never keeps, prints or logs it, or puts it on a command line), and Claude Code is told to keep it out of everything else it starts (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`): the shell commands a builder runs, hooks from settings or plugins, nested kit calls. The flag is on for every call except one kind: a call with a tool list of plain readers only (`Read`, `Grep`, `Glob`) that starts no hooks (`--bare`, or `--setting-sources` with an empty value) and no other program (`--strict-mcp-config` with no MCP servers, no `--plugin-dir`, `--plugin-url`, `--settings` or `--agents`), such as a review, because the flag makes claude leave empty `.env`, `.npmrc`, `yarn.lock` files in the folder it runs in. A call with no tools, an empty list, a list over several lines with anything else in it, or a `--tools`, `--bare`, `--setting-sources`, `--strict-mcp-config` or `--mcp-config` that is not an option of the call (the value of another option, or after `--`) keeps the flag on. A machine with managed (admin-installed) settings (a `managed-settings.json`, a `managed-mcp.json`, or a filled `managed-settings.d/` folder, in `/etc/claude-code`, or in `/Library/Application Support/ClaudeCode` on macOS) keeps the flag on for every call, because those settings can hold hooks that neither `--bare` nor an empty `--setting-sources` is known to switch off, and MCP servers that `--strict-mcp-config` is not known to keep out. The key file and the config folder must be absolute paths, the key file with mode 600; otherwise the call stops with a plain message. What this does not stop: a process of yours with the same user name can still read the Claude process's own environment, since Claude has to hold the key to use it.
- **Limits:** the API config folder starts empty, so skills and settings from `~/.claude` are not used on the route (link them in if you want them); a saved session does not resume across switching the route on or off (start a fresh run); a run killed before it printed its cost counts as unknown, and doctor says so.
- **Known limits (follow-ups):** the spend total misses a run whose runner was killed outright (no line is written); `kit doctor` shows the total only while the route is on and healthy; a config folder that exists but cannot be written gets the CLI's own error, not a plain refusal; a Claude started from a builder's shell on the route cannot sign in to the subscription (its `CLAUDE_CONFIG_DIR` still points at the API folder).
- **Check it:** `kit doctor` says whether the route is on or off, the key file's mode, and the total spent; every run adds a line (time, command, model, tokens, cost) to `~/.local/state/agent-kit/api-spend.log`.

### Cut and merged commands (TOOLS-235, releases 1 and 2)

Lex approved the kit trim on 2026-11-14. Its first release cut three commands and merged three, so `kit --help` lists
22 shared commands instead of 28. Each old name still answers, with one plain line saying where its job went and a
`RESULT: fail <name> cut|retired|moved` line (exit 2):

- `kit ask` (retired 2026-11-13: its API credit ran out): write with a subscription helper, a T3 `delegate_task` to
  Sonnet or Opus.
- `kit status`: `kit ticket list` shows the cards, T3 the linked pull requests and their checks; the weekly
  `kit sweep` bundle lists spec files `kit pr` forgave as flaky 3 or more times in 7 days.
- `kit feedback`: Lex's corrections go to the chat memory, which the weekly learning reads. Old feedback logs are still
  read.
- `kit learn` is now `kit sweep --learn` (same `--since` and `--project`; its code is `learn.mjs`).
- `kit card` was merged into the session-start hook, which shows the card; `node "$(kit --home)/context-card.mjs"`
  prints it.
- The UX confidence ladder was dropped from the rulebook, but `kit score --html` still draws its section until the build
  page itself is decided after 30 Nov (the trim plan); it no longer moves, since nothing writes feedback logs now.
- Release 2 (2026-11-15) cut the old factory, so `kit --help` lists 18 shared commands:
  - `kit slice`: a build runs as a T3 helper thread (`delegate_task` with `isolation: "worktree"`) with
    `kit brief <KEY>` as its task; the helper builds, proves each Done when item and lands with `kit pr`.
  - `kit fix`: the helper fixes its own review findings in its own thread and runs `kit pr` again;
    `kit brief <KEY> --stage fix` writes a new helper's brief.
  - `kit next`: the Board drive schedule picks the next cards; `kit ticket list` shows them. A ticket in a `group:`
    is briefed one at a time, or the whole group as one `kit brief --task`.
  - `kit heartbeat`: the Board drive schedule (a T3 `schedule_task` every 2 hours) checks the helper threads.
  - `kit pr` on a merge queue leaves the card open and says to close it once the PR lands, with its follow-ups on the
    card at once (no slice waits for the queue any more).
- `kit version` stays as an inside helper: `kit doctor` shows the kit's commit and age, and the doctor's kit home check
  still runs it. A file in `kit.d/` whose header says `# kit-inside: <summary>` runs by name and stays out of the list.

## Generated briefs, long jobs that wait

- `kit brief <ticket> [--stage build|review|second-look|fix] [--note "<text>"]` prints the whole brief for a
  delegated child from the ticket, the project's settings and the rules: owner, worktree setup, pins, commands and
  evidence, the house rules, the wait rule, the skills for the ticket's files (the skills map, `skills.json`), the
  talk style (short English) and the report's last line. A build brief also carries the grill and prototype step and
  asks for proof lines: per "Done when" item, what the builder really tried on the real thing, in its report and the
  PR text. It ends with a marker line, `kit-brief: <kit version> <ticket> <stage>`.
  A lead passes it to `delegate_task`; a rule changes once, here. The ticket may be an Orbit card key in any project; in
  one that keeps ticket files the kit neither claims nor closes the card, so the build brief has the builder ask the lead
  to close it after the merge.
  A job with no ticket file or card uses `kit brief --task "<title>" --owner <id> --note "<the task>"`.
- `kit go <job> -- <command>` starts a long job (a long `kit pr`, specs, a build) with `kit bg`, in its own user
  systemd scope, and waits in the foreground for at most 9 minutes per call. While the job runs it ends with
  `RUNNING: <job> (…). Run again: scripts/agents/kit go <job>` and exit 75; once the job ends it prints the job's
  RESULT line and exits with the job's code (1 for a job's own 75, or for a job whose RESULT line says fail
  although it exited 0).
- `kit bg` and `kit go` take one lock per job name while they start or stop it. Linux and macOS use `flock`.
  Windows has no `flock`, so there the lock is a file, `<worktree>/.scratch/kit-jobs/.<name>.lock`, made in one
  step with the create-only flag and holding `<pid> <token>`. A second start or stop of the same name is refused
  at once with `bg <name> is busy; retry after its current operation` (the lock is never waited for). The file is
  removed when the command ends; the file of a process that died, or one older than five minutes (a reused pid), is
  taken over, one taker at a time (under a `.<name>.lock.recover` guard file), so a killed launcher never blocks a
  name. `KIT_BG_LOCK=file` or `flock` picks the lock by hand (tests).
- On Windows (no `setsid`, process groups, `/proc` or systemd) `kit bg` starts the job as a hidden, detached
  process tree: the wrapper is spawned with `detached` and `windowsHide`, gets the same launch handoff on fd 3, and
  ends with the session (the start prints the same note as a machine without a user systemd). A process is alive by
  `process.kill(pid, 0)`; its parent and start time come from one `Get-CimInstance Win32_Process` call (the start as
  a file time, never mixed with `Get-Process`), and the job's identity record is `{ "pid", "started" }` as JSON. The
  job is the process tree below its pinned processes (the wrapper, its command process, and the command itself, kept
  in a `work` record; Node ends a process's non-detached children with it on Windows, so the work ends with its
  command process unless it broke away from Node's job object, and the inner processes stay attached so they keep a
  hidden console and a console program they start opens no window), walked by parent pid in one process list; a child counts only when it started at or after its
  parent, since Windows reuses pids and never re-parents, and a process whose parent has ended (and is not pinned) is
  no longer followed (as with `taskkill /T`); the hidden `conhost.exe` each console process gets is not counted.
  `--max` is a timer in the wrapper that holds until the job's whole tree has ended. An exit record keeps any 32-bit
  Windows exit code; `kit go` gives 1 for one above 255 (a shell keeps only its low 8 bits). The time limit and the
  command's pin read the process list too: a limit that meets an unreadable list looks again a second later, and a
  command that cannot be pinned runs on unpinned, with a line in its log. `kit bg --stop` ends the whole tree at
  once with `taskkill /PID <pid> /T /F` (Windows has no graceful stop) and records `ended` and exit 143 itself; only
  the top of the tree goes to taskkill (the wrapper, or what is left below it when it died). A process list that
  cannot be read fails the command (`kit bg --list` shows the job as `unknown (…)`), never reads as an ended job;
  only when it keeps failing while a job that has finished waits for its leftover processes does the job give up
  after ten tries and record its own exit status, and its log says so.
  `kit go` looks once a second there (a process list takes about 0.4s). `KIT_BG_PLATFORM=win32` picks the Windows way
  by hand (tests, with fake `powershell.exe`, `taskkill`, `bash.exe` and `cmd.exe`). A job's command is started
  without a shell, as on Linux, unless it is a `.cmd`, `.bat` or shell script: Windows starts only a program itself
  (an `.exe` or `.com`; Node refuses a `.cmd` or `.bat` without a shell), so its first word is looked up as Windows
  does (a word with a folder in the job's folder; a bare name in the job's folder, then on `PATH`, a `PATH` folder in
  quotes (which may hold a `;`) without them, a relative one taken from the job's folder, as Node looks): a bare name
  first as `.com`, `.exe`, `.bat` or `.cmd` in each of those folders, then as the name itself; a name that already has
  an extension (`job.sh`) in each folder in turn, first exactly as written, then with `.com`, `.exe`, `.bat` or `.cmd`
  added. A `.cmd` or `.bat` runs through `cmd.exe /d /s /c` (`ComSpec`, else `System32\cmd.exe` in the Windows
  folder), each argument quoted and every cmd special character escaped with `^` (cross-spawn's way), so each argument
  stays in its quotes when the batch file reads it again (`%1`, or `%*` handed on); an argument with a `"` of its own,
  which would end those quotes early, one that ends with a backslash, which the batch file and a program it calls
  cannot both read as given, or one with a line break, is refused, and so is a `.cmd` or `.bat` job whose folder is a
  network share (`\\server\share`), where cmd.exe cannot work. Any other file that is not a program and is a shell
  script (one with a `#!` line, such as `scripts/agents/kit`, or one without whose name has no extension or ends in
  `.sh` or `.bash`) runs through Git Bash's `bash.exe`: on `PATH`, else beside the `git.exe` on `PATH`, else under
  `ProgramW6432`, `ProgramFiles`, `ProgramFiles(x86)` or `LOCALAPPDATA\Programs` in `Git\bin`, never WSL's `bash.exe`
  in the Windows folder or `WindowsApps`. Git Bash would glob bare words of a command line and take `'` as a quote, so
  the words reach it in `KIT_BG_ARGC` and `KIT_BG_ARG_<n>`, which a fixed script reads and clears before it runs them
  (by `exec` for a file with a `#!` line, which Git Bash follows; as a bash script for one without); as in any Git
  Bash, a program it starts that is not Git Bash's own gets path-like words in Windows form. Without Git Bash such a
  job does not start: `kit bg` fails with a plain message and records nothing. A file without a `#!` line and with
  another extension (`.ps1`, `.py`, `.js`) is refused, to be started through its own program, and a Windows program
  with no extension at all is refused too (Node adds `.com` or `.exe` to such a name). A program, or a word not found,
  starts as given, as before.
- Two hooks back this up. `brief-guard` (Claude `PreToolUse` on `mcp__t3-code__delegate_task` and `Agent|Task`)
  refuses a brief without the marker; research, review-only and question tasks start with
  `kit-brief: none (<reason>)`, and the read-only agent types (Explore, Plan) pass. `stop-guard` (Claude and Codex
  `Stop`) refuses to end a turn while a `kit go` job of the worktree, or a `kit-*` systemd unit working in it, still
  runs; it lets the turn end for a job past its time limit, after six refusals in a row, or with
  `KIT_ALLOW_STOP=1`.
- `status-nudge` is a third, opt-in hook: `kit init` never writes it. A project turns it on by adding
  `scripts/agents/hooks/run.sh status-nudge` under Claude `UserPromptSubmit` in its own `.claude/settings.json`. For a
  prompt that is a finished helper's result (first line `Delegated task <id> (<title>) [completed|failed|interrupted]`)
  it adds context asking the lead to say first anything Lex must answer or do, and to end its reply with the
  two-line status (Done; then Running and Next). It only adds context: it never blocks, never loops, and stays
  silent for every other prompt. `node status-nudge-check.mjs <transcript.jsonl>` (run it by the kit's folder,
  `kit --home`) lists the replies after a finished helper that lack the status, for the weekly learning review; it
  ends with one RESULT line of counts.

## Tickets are moving to Orbit (in stages)

- Tickets are moving from markdown files to Orbit cards, one project at a time. Stage 1 is here: the Orbit client and
  `kit ticket` (`kit ticket --help`): create, get, list, update, dates, repeat, note, comment, sub-tasks, members, next-lex and
  clear-next-lex, trash, setup. `--assignee NAME|ID|none` on create and update assigns by member name; `next-lex` also assigns the member called Lex and `clear-next-lex` takes only him off. It reaches every board the token covers, from any project folder or with `--project`.
- A project's `scripts/agents/kit.json` says which store it uses: `"tickets": "files"` (the default) or `"orbit"`, and
  `"orbit": { "project": "TOOLS", "parent": "TOOLS-10" }` names its board and the card new tickets go under (parent is
  optional). Stage 2: with `"orbit"`, `kit brief`, `kit pr` and `kit init --issues` read and
  write cards through `ticket-store.mjs` and `ticket-cards.mjs` instead of ticket files. Stage 3 moves a project's
  ticket files to cards (below); removing the file store from the kit comes last, once every project has moved.
- On Orbit: a lead's `kit brief <KEY>` claims the card (below); when the PR lands, `kit pr` sets the card to Done
  and adds a dated comment naming the PR and merge SHA; when that write fails the merge still counts and the RESULT line says so.
  `kit init --issues` makes a card per open GitHub Issue in
  the project and parent (its "GitHub Issue:" line holds the link and number), then closes each Issue with a comment
  naming its card; a rerun finds the cards it made, and an Issue whose text holds a secret stays open.
- The rules are built in: reads work for anyone; writes need `ORBIT_ROLE=lead`, read the latest version first and retry
  once on a version conflict. A move to a Publish status or a tick on "Scheduled in Radaar" needs `--lex-said "<his exact
  words>"`; so does `trash`, which only moves a card to Orbit's trash (the kit has no permanent delete). A date needs a
  `--source`, written on the card's "Planned dates" line; a plain date is a whole day in Europe/Amsterdam. `--dry-run`
  on every write prints the exact change and sends nothing. Each write adds one line (time, card, fields, who) to
  `~/.local/state/fleet/orbit.log`.
- Secrets live in `~/.config/fleet/orbit.json`: mode 600, outside every git work tree, refused otherwise, never printed
  or logged. `kit ticket setup` makes it, with a hidden prompt for the token or `--from-file <path>` (read, then
  deleted); `--from-mcp-config [file]` copies the Cloudflare pass from the MCP settings (default `~/.claude.json`) only
  after a yes. `kit ticket setup --help` gives the steps.
- Only leads write, so an agent the kit starts never inherits `ORBIT_ROLE` (`agent-run.mjs`): a lead sets it in
  its own shell for its own `kit ticket` calls.
- **The key lock** (`key-guard.mjs`, TOOLS-285, Lex 2026-11-15): an agent the kit starts through `agent-run.mjs` (a
  `kit go` build, a `kit review` or `kit ux` reviewer, a second look) cannot read the machine's key files:
  `~/.config/fleet` (the Orbit secrets), `~/.config/gh`, the Cloudflare/wrangler folders, `~/.ssh`, `~/.netrc`, `~/.npmrc`,
  cloud and registry logins (the list is `homeKeyPaths` in `key-guard.mjs`: AWS, Azure, gcloud, kube, Docker, Podman,
  rclone, cargo, RubyGems, Kaggle, DigitalOcean, Fly, Netlify, Vercel, Hugging Face; a store that is not on it goes in
  `KIT_KEY_PATHS`), `~/.claude.json` (it holds MCP Authorization headers), `~/.Xauthority`, the API route's key file, the
  other CLIs' logins, Claude's `settings.json` for the other CLIs (it can hold a token), a git config with a token in a
  URL and a shell start-up file that sets a token (quoted, `+=` and default forms too: `export "GH_TOKEN=…"`,
  `GH_TOKEN+=…`, `${GH_TOKEN:=…}`; with the files they pull in, however long the chain: a shell file's relative
  `source ./x.env` is read from the folders a shell runs in, HOME, the worktree and the lead's folder), folders and
  files that variables name (`GH_CONFIG_DIR`, `KUBECONFIG`, `GNUPGHOME` …), what links
  inside those folders point to (a link to a folder holding HOME or the worktree, or to a system folder, stops the run:
  the lock cannot hide it; so do a key folder that cannot be listed and key folders too large to search, over 200000
  entries), the SSH agent and session-bus sockets where their variables point, and the desktop's runtime folder
  (keyring, session bus, agent sockets); a relative name counts from both the worktree and the lead's folder.
  `KIT_KEY_PATHS` adds more (full paths, separated by the system's path separator; an entry that is not a full path is
  not locked, and the run's log and `kit doctor` say so). Claude, Grok and OpenCode run inside bubblewrap (`bwrap`, which
  exists on Linux only; Grok's own sandbox cannot start inside
  it, so Grok runs with `--sandbox off` there and the lock itself is read-only for a Grok review, but its own state
  folder and the temp folders); Codex, whose own
  sandbox cannot start inside another, gets a permissions profile with the same paths unreadable. Variables holding tokens, passwords, agent
  sockets and the display are dropped; each CLI keeps only its own sign-in. Known limits: a CLI's own login stays
  readable to it (Claude's `~/.claude/.credentials.json`, Grok's `~/.grok/auth.json`, OpenCode's data folder, whose
  `opencode.db` holds every provider key saved there; Codex hides its own), loopback
  services and abstract sockets stay reachable, the repository's own Git config stays readable (git needs it; keep
  tokens out of remote URLs), proxy variables (`HTTPS_PROXY` …) are kept with any password in them
  (the CLI needs them to reach its service), and a helper thread T3 starts (`delegate_task`) is not started by the kit
  and is outside the lock. At start-up the lock tries, from inside bubblewrap, to read through `/proc` (where that works,
  as with a setuid bwrap, it refuses to run) and to reach the X display without its cookie: a display that lets the user
  in by name (some desktops set `xhost +si:localuser` at every start) stays reachable, which `kit doctor` and the run's
  log say as a warning while the lock stays on. A build on the API route is refused under the lock (its Claude sandbox cannot start inside it).
  `ASE_KEY_GUARD=off` runs without the lock and writes a warning in the run's log.
- **Where the key lock is off** (TOOLS-285 fix round, the lead's decision of 2026-11-16: Lex's Windows laptop must keep
  working). Bubblewrap exists on Linux only. On a system without it (macOS, Windows) the kit's Claude, Grok and OpenCode
  runs start unwrapped and can read the key files, and say so in one line, in the run's log and in `kit doctor`:
  `key lock: off on this machine (no bubblewrap); builders can read key files (token variables are still dropped, and
  Codex keeps its own profile)`. Those two parts need no bubblewrap, so they stay. `ASE_KEY_GUARD=on` stops such a run
  instead (for a machine that must never run unwrapped). On Linux nothing changed: a missing bubblewrap stops the kit's
  Claude, Grok and OpenCode runs with its install step (`apt install bubblewrap`; WSL counts as Linux), and so does one
  that is installed but cannot start (the system blocks it, the `/proc` check fails). `kit doctor`'s `key lock:` line
  searches the key folders as a run in that worktree would, so it says "on" only where a run would really start: a
  key folder that cannot be listed, is too large or links to a folder the lock cannot hide shows there first.
- **What the key lock does not do.** It keeps an agent the kit starts from reading the key files while it runs; it does
  not confine what the agent writes. A build writes wherever the user can (the worktree, the repository's Git folder and
  settings, files under HOME), and what it leaves runs later with whoever starts it. The kit's own later steps are
  covered (TOOLS-303):
  - **Git calls.** Every git call the runner and `kit pr` make on a build's worktree (`kit pr`'s own, the kit's helpers
    in its process, and those of the programs it starts: `kit review`, `gh`) runs with `git-safety.mjs`'s settings: no
    hooks (`core.hooksPath=/dev/null`), no file system monitor, no signing or signature checks, no automatic maintenance
    or submodule recursion, and the settings in the repository's own config that name a program set empty, which starts
    nothing: those whose name ends in command, cmd, program, helper, driver, textconv, editor, pager, askpass, proxy,
    pack, hook, filter, clean, smudge, process or external (a filter, `diff.external`, a text converter, a merge driver,
    `core.sshCommand`, `core.alternateRefsCommand`, a credential helper...), every alias, per-command pager and trace2
    target. Settings that only commands `kit pr` never runs read (`difftool.<tool>.path`, `submodule.<name>.update`) are
    not matched. A call without the network reads no global or system Git config (a build can write `~/.gitconfig`); the
    user's name and e-mail, the excludes file and the line-ending settings come along. A fetch or push keeps the global
    config (its credential helper) and is refused while the repository's own config holds `http.*` or `credential.*`
    settings. Every call allows only the transports git has itself (file, git, http, https, ssh), and a fetch or push
    also refuses a remote helper the repository's config names (`remote.<name>.vcs`, a `<helper>::` URL or rewrite), so
    no `git-remote-<name>` from PATH starts. A fetch or push starts git's ssh by its full path (TOOLS-320), found as the
    programs below are: the lead's `GIT_SSH_COMMAND`, else `core.sshCommand` from the lead's own config (the
    repository's is set empty), else `GIT_SSH`, else `ssh`, with the command's other words kept, and where a PATH folder
    holds a link into the worktree or the Git folder the command's PATH leaves that folder out, for a program it starts
    by name in turn (`timeout 30 ssh`, a wrapper script). A command whose program cannot be told (shell syntax beyond
    words and quotes, an expansion, `env`, a `PATH=` of its own), or an ssh PATH holds only as such a link, is swapped
    for one that says so and fails, so only a call to an ssh remote stops. `kit pr` pushes to a folder remote (whose hooks git runs without
    these settings) inside the key lock. It weighs every push address the remote lists, rewrites applied (TOOLS-320):
    a folder beside other addresses (which need the credentials the lock hides), or an address on this machine itself
    (localhost, the machine's own name, or a host any of whose addresses is loopback or one of the machine's own, whose
    hooks run outside any lock), stops the push.
    `safe.directory` names only the worktree and its Git folder. The runner's own git calls also run inside the lock where
    bubblewrap runs. The runner finds the Git folder from the worktree's files before its first git, so that git is
    never one a link on PATH leads into the worktree or a linked worktree's shared Git folder for (those files are the
    worktree's own: a build that rewrote its `.git` file to name another folder takes the real one out of that lookup).
    `ASE_KEY_GUARD=off` turns these settings off with the lock. Settings a project uses on purpose are switched off too:
    hooks such as a pre-push check do not run in `kit pr`, and Git LFS (set up in the global config, which `kit pr` does
    not read) does not run there at all, so `kit pr` stops before its rebase when the branch's or the land branch's
    `.gitattributes`, or the repository's own attributes file, names `filter=lfs` (land such a change with
    `ASE_KEY_GUARD=off`).
  - **`kit pr`'s checks.** The project's check, unit, lint, colour, tickets and spec commands come from the worktree's
    own settings and run the build's code, so they run inside the key lock (every CLI's login hidden too, the token
    variables dropped). A check may start the key lock itself (the kit's own tests do), and many systems block a sandbox
    inside another (Ubuntu's `kernel.apparmor_restrict_unprivileged_userns=1`), so this lock leaves a mark only a
    process inside it sees (a random token in the runtime folder it masks, matched by `KIT_OUTER_LOCK`, in a user
    namespace of its own): a kit run there that cannot start bubblewrap starts without it and says so in its log, since
    the outer lock already hides the key files; the kit's tests of bubblewrap itself skip there. Where bubblewrap does
    not exist (macOS, Windows) or `ASE_KEY_GUARD=off`, the checks run as before and the PR's test lines say `checks: not
    locked (…)`.
  - **Programs by name.** The runner and `kit pr` start git, `gh`, bubblewrap and a CLI by their full path, found only
    in PATH's full-path folders outside the worktree and the repository's Git folder (links followed), and a script's
    interpreter the same way: a `#!/usr/bin/env node` CLI, or the API route's `#!/usr/bin/env bash` wrapper, starts the
    interpreter by its full path, never a link someone made into the worktree (an `npm link`, a dotfiles `bin`). A
    `#!/usr/bin/env -S MODE=review node` first line is split as env splits it (quotes, escapes, `NAME=value` words, which
    env still sets), and one env would expand (`${NAME}`) or that holds another env option is refused (TOOLS-320), as
    is one with a `PATH=` word anywhere in it or env again as its program (TOOLS-326). The run's PATH leaves those folders out,
    so `<worktree>/node_modules/.bin` (which npm puts on PATH) supplies none of them; a link elsewhere stays on PATH,
    and the next program on PATH starts in its place, or the run stops and says so. `kit pr` puts links to the git,
    node, gh, bash and sh it found that way in a private folder in the temp folder, first on PATH (and `KIT_NODE` is
    its own Node), so the kit's helpers in its process and the programs it starts
    (`gh`, `kit review`, `kit release-check`) take those too; its own git and gh start by the real path. The checks see
    that folder read-only where they run locked; checks that run unlocked (no bubblewrap), another build running
    meanwhile, or one run without the lock can write it: `kit pr` checks the links before every program it starts and
    after every check and stops if one changed, but a program it started (`gh` with its token among them) may take a
    changed one in between. The API route's wrapper, which reads the key outside the lock, takes its own tools from the
    system's folders (`command -p`).
  - **The machine's kit.** A locked build or review and `kit pr`'s locked checks see the kit copy that runs them and
    `${XDG_DATA_HOME:-~/.local/share}/agent-kit` (every copy `kit update` keeps, its `current` link and clone)
    read-only, so they cannot change the kit `kit pr` and the runner then run with the keys (TOOLS-320); a key path
    inside them stays hidden. A kit inside the worktree or its Git folder (a build of the kit itself with `KIT_HOME` at
    its worktree) is the build's own code and stays writable, and so does a kit folder that holds either.
  - **Start-up files.** `BASH_ENV` and `ENV` (the file every non-interactive bash or sh reads first) are dropped for a
    run and for everything `kit pr` starts (not with `ASE_KEY_GUARD=off`), and the file they name is locked like any
    start-up file when it sets a token.
  What is still not covered: the lead's own commands outside the kit (a git or a shell the lead runs by hand reads what
  a build wrote under HOME: `~/.gitconfig`, `~/.bashrc`, a PATH folder there), a Node kept under HOME (an nvm Node),
  which a build or a check can change and `kit pr` then runs, the machine's kit copy where builds and checks run
  unlocked (no bubblewrap, or `ASE_KEY_GUARD=off`; Codex's own sandbox keeps it read-only), a `kit pr` started through
  `npm run` (its own `#!/usr/bin/env node` is found before `kit pr` can look), a fetch or push reading a global Git
  config a build wrote, and what ssh itself starts from a config under HOME a build wrote (`~/.ssh/config`'s
  `ProxyCommand`, `Match exec`, or a host name it maps to this machine), and a push host whose address changes between
  `kit pr`'s check and the push. For those the lead's guard is the review before anything a build wrote is run (`kit
  review` is read-only).
- Keyed steps happen only in the lead's own process, never inside a locked run. Already the lead's: `git push`, `kit pr`
  (push, PR, merge, card close) and `kit pr --release` (the build contract leaves a builder's changes unstaged). Moved to
  the lead for locked runs: reading Orbit cards (`kit ticket get|list`, which need the token too), GitHub calls (`gh`,
  `kit wait ci`, a fetch from a private remote), Cloudflare deploys (`kit preview`, `wrangler`) and installs that need a
  registry token from `~/.npmrc`. A brief carries what the builder needs from the card: `kit brief` puts the card's text
  and comments in it and sends no builder to the board, and its "Key lock" line, like the build contract every
  kit-started build gets, names these steps as the lead's (the builder reports each one it left as `Lead: <step>`). A T3
  helper thread is outside the lock (card TOOLS-302) and still lands its own work with `kit pr`, as its brief says.
- `kit doctor` on a project with `"tickets": "orbit"` names its board and asks Orbit once, with a short limit: connected,
  token refused or expired, Cloudflare blocked it, Orbit not answering, setup file needs attention, or not set up, with
  the days left when the saved file records the token's expiry. The line never fails doctor, and `kit doctor --quiet` makes no call.
- Labels are set by name on the card's own board (`--label NAME,NAME`, `--clear-labels`, `kit ticket labels`); a name
  Orbit does not list is refused, and the kit never makes a label (the public API has no way to). Adding a label with the
  word publish in its name (any letter case) needs `--lex-said`, like a move to a Publish status.
- Orbit's public API has no task relations, so blockers are a `Blocked by: KEY-n, KEY-m` line in the description
  (`--blocked-by`). Its docs: `docs/public-api.md` in github.com/coollabsio/orbit; which parts the kit uses and which it
  leaves out, and why: [docs/public-api.md](docs/public-api.md).
- `kit ticket repeat <KEY> --every [N ]day|week|month|year [--on mon,thu] [--from due|completion]` makes a card repeat
  (Orbit's `recurrence`): closing it makes Orbit create the next one. `--stop` ends it, `get` shows a "Repeats:" line,
  and an Orbit without repeating tasks yet gets nothing sent.
- How a project moves (`ticket-import.mjs`; a lead, `ORBIT_ROLE=lead`, in the project, from a fresh branch:
  `git switch -c tickets-to-orbit origin/<land>`): `kit ticket migrate [--project KEY] [--parent KEY-n] [--dry-run]`
  runs every step in order and stops at the first problem. (1) It refuses while a build runs (an open AFK ticket with an
  assignee, a claimed card, or an imported card In Progress); run it again once the build lands. (2) `kit ticket import` makes one card per ticket file
  (every map's `tickets/` and `build/tickets/`, as `tickets.mjs` reads them) under the parent card (a board other than
  kit.json's gets none unless `--parent` names one, and migrate then drops kit.json's old parent; a typed `migrate --parent KEY` also moves cards an earlier import made under that parent, whatever parent they had, and the parent card itself stays where it is): the first line
  "Imported from: <path> (project <name>)" names the file, so a rerun finds the card and makes no second one; then the
  frontmatter (Type, Assignee, Builder, ...), a "Blocked by:" line with the blockers' card keys, and the ticket's text,
  whose links to other tickets point at their cards. Each entry of a "## Comments" section becomes a card comment; the
  closing notes (Done, Resolution) stay in the text. Status: closed is Done, wontfix Cancelled, an open "task (AFK)"
  Todo, the rest Backlog (a "File status:" line keeps needs-info and the like). (3) `kit ticket parity` compares files
  and cards (count, title, status, text, comments, blockers) and lists every difference; any difference stops the move.
  (4) A tag `tickets-in-files-YYYYMMDD` on the commit that still holds the files, pushed to origin
  (`git show <tag>:<path>` reads a file back). (5) One commit through `kit pr`: the ticket files removed,
  `"tickets": "orbit"` and the board in `scripts/agents/kit.json`, and links in docs that named a ticket file now name
  its card (a ticket path in backticks gets "(Orbit KEY)"). Maps, research notes, ADRs and other docs stay as they are.
  `import --dry-run` and `migrate --dry-run` print every card, comment and change and send nothing.
- `kit brief <KEY>` on an Orbit project builds the brief from the card: its title, text and comments, in place of a
  ticket file's. A build brief run by a lead (`ORBIT_ROLE=lead`) claims a card nobody holds for its owner (In Progress and
  "Claimed by:"), so no second helper starts on it; a Todo or Backlog card that is
  blocked or waits for Lex is refused, and any other card is left as it is, with a warning that says why (someone else
  holds it, it waits for Lex, it is Done or in another status; on a board with no Todo status, every status not yet
  started counts as Todo).
- The card standard (`docs/orbit-card-standard.md`: one short card, history in comments, parts as sub-tasks, questions in a
  desk thread) is kept by the tickets tool, not by guesswork: `kit ticket note KEY text` posts a dated comment (the
  description is not touched); `create` and `update` print a warning, and still exit 0, when a new description is over 12
  lines with text, has a `## Notes` section or a checklist line, or has no `Done when:` line (the kit's own Next step,
  Planned dates, Blocked by and Claimed by lines do not count); `kit ticket check KEY | --project KEY | --all [--json]`
  lists every card that breaks it and which rule, for any role; `kit ticket next-lex KEY "reason" [--comment "details"]`
  also posts a comment that starts with `@Lex` (never the same text twice) and moves a Backlog or Todo card to In Progress;
  `kit ticket tidy KEY --dir FOLDER [--dry-run]` posts `comments.txt` (split by a line with only `-----`), sets
  `description.txt` and creates each sub-task of `subtasks.json` (`[{title, description, assignee}]`, assignee `Lex` by
  member name), skipping what is already there, so a run again after a failure finishes the rest and never doubles anything.
  A card that waited for Lex and was given back by `clear-next-lex` stays In Progress; a build brief may claim it again when it has no claim line, no assignee and no `Next step (Lex):`. A claim never takes an unassigned card in
  another started status (In Review, say). `kit ticket check` leaves sub-tasks with no description alone, except a bare card under the project's own parent card (with `--all` only that project's parent is known), and does not count
  a `Next step (fleet):` line toward the 12 lines.
  Projects that keep ticket files (`"tickets": "files"`) keep how `kit brief` and `kit pr` work today; `kit ticket` itself always talks to Orbit, as before.

## Rolling back a direct project

- `kit rollback <first> [<last>]` undoes landed commits in a direct project (`branches.direct`), where `kit pr` refuses to run
  on main. It fetches origin, cuts `rollback/<first>-<last>` at `origin/<land>`, runs `git revert --no-edit <first>^..<last>`
  and lands the branch with `kit pr` (its checks, review and merge). `<first>` and `<last>` are the commits `kit pr` printed as
  `landed:` (`<last>` defaults to `<first>`). It needs a clean tree, both commits on `origin/<land>` with `<first>` not after
  `<last>`, and no merge commit in the range; a revert that conflicts is undone and the checkout goes back to its branch.

## Nothing unsaved goes live

- `kit release-check` is the second half of that gate: it fails unless the working tree is clean (no changed or
  untracked file outside `.scratch/`) and HEAD is exactly `origin/<release>` after a fetch (`branches.release`,
  the branch the push guard reads). A project's own live deploy command runs it first
  (`scripts/agents/kit release-check && <deploy>`); `kit pr --release` runs `kit release-check --land` before it
  opens the release PR, so the release is cut from exactly what landed (then `origin/<release>` is merged into it, never replayed; see "Releases" below for how it lands).
  It pushes nothing; ignored files (a built `dist/`) do not count. Only a `*-lead` owner may pass it with
  `--waive "<reason>"`, which its `RESULT:` line names with what was let through; `kit pr --release --waive` hands
  its reason on, so one waiver covers both the review findings and the check.
  The findings that stop a landing (above P3; after the fix rounds only P0 and P1) are waived only by id or by count: `kit pr --waive "R1-2, SL-1: <reason>"` or `--waive "2 findings: <reason>"`;
  a finding the waiver does not name, or one that is new at a head a rebase brought (at the start of the run too), stops `kit pr` with a plain reason that lists it (P3 findings, test gaps and docs wording need no names).
- Re-cutting a release (TOOLS-310): reset the release branch to `origin/<land>` and run `kit pr --release` again. The
  merge of `origin/<release>` into the cut is dated by its newer parent, not by the clock, so the same dev and the same
  release branch always make the same commit, run by the same git identity (`user.name` and `user.email` are part of
  it, so a re-cut by another lead or machine set-up is a new commit): its saved review and second look are reused and a
  lead's waiver for their findings is taken. There is no need to force `GIT_AUTHOR_DATE` or `GIT_COMMITTER_DATE` any
  more (a merge signed by `commit.gpgSign` never repeats either: a signature differs each time). After dev changed, the new cut answers the
  earlier cut's review as a later round: the reviewer reads the plain diff from the earlier cut (what dev changed since
  then and the merge itself), and the fix rounds of every cut of the release count against one budget.

## Releases

Dev and main stay joined: main only ever takes dev by a merge commit, so every commit on main is in dev's history or
is one of those merges (TOOLS-325). A release once landed on main as copies of dev's commits (a rebase merge), so the
two split, the next release conflicted, and a "sync main into dev" PR had to be merged by hand.

- `kit pr --release --base main` (after Lex's go) cuts the release from `origin/dev`, merges `origin/main` into the
  cut, opens the PR and, once CI passes, lands it with `gh pr merge --merge --match-head-commit <head>`: a merge
  commit, never a rebase, squash or cherry-pick. `--no-merge` only opens it and prints that merge command. The line
  `landed: <sha> merges <head> into main (a merge commit)` says what landed. A merge queue lands by its own method,
  whatever gh asks, so a release or a sync goes into one only when the queue makes merge commits; a queue set to squash
  or rebase, one whose method cannot be read, or a lookup that cannot tell whether there is a queue, stops the run
  before anything is queued (gh adds a PR to a required
  queue whatever method it names, so `--no-merge` then prints why, never a `gh pr merge` command to run by hand).
- A main that already holds copies of dev's commits (merges left out, every commit main holds outside dev's history
  has the same change as one of dev's, by `git log --cherry-mark`), with main's files dev's files at a dev commit made
  since the two last joined: the cut's merge keeps dev's files (`git merge -s ours`, said as `merge: origin/main's
  files are dev's at <sha>, so the cut keeps dev's files`). Main then holds nothing dev lacks, and a plain merge would
  only conflict or bring back what dev changed since. When main's own commits are changes of its own only (a hotfix
  made on main, a revert of a release merge), the merge stays a plain one, so they are carried; a real conflict stops
  the run and names its files, as before. When main holds copies and changes of its own together (a rollback of a
  copied commit looks like a hotfix there, and neither kind of merge keeps it), the run stops and names main's own
  commits: land those changes on dev from a new branch with an ordinary `kit pr` first. After an ordinary release
  main's own commits are only merges, so the merge stays plain too.
- `kit pr --sync-main` lands a "sync main into dev" merge into dev. From a branch cut at `origin/dev` it merges
  `origin/main` into the branch (its own merge commit, never a fast-forward, keeping dev's files under the same rule),
  refuses unless the merge changes no file on dev (`the sync would change <files> on dev: main holds changes dev
  lacks; land them on dev with an ordinary kit pr first`), and lands it as a merge commit, never rebased (an ordinary
  `kit pr` rebases, which flattens such a merge away). Kit always makes the merge itself, dated by its parents, so a
  rerun on the same dev and main makes the same commit and one on a newer dev or main makes it again there. A merge
  of main kit finds on the branch is made again only when it keeps dev's files (a hand-made one that keeps dev's
  files over a change main holds is then refused); one that changes dev's files is never reset away, and the run
  names it. A branch with work of its own is refused, with advice to cut a new branch at `origin/dev`. The empty
  diff has nothing to review, so the review and the second look say so, and CI still gates the merge. It needs
  `branches.release` apart from `branches.land`.
- `kit release-check` (on its own and inside `kit pr --release`) warns, without failing, when `origin/main` holds
  commits outside dev's history, merges left out: `warning: origin/main has N commits outside dev's history (<sha>
  <subject>, …): copied by a rebase or squash merge, or made straight on main; join them with kit pr --sync-main`.

## Changing the kit

- Work in a worktree (`git worktree add -b <branch> ../agent-kit-<branch> origin/dev`) and land with this repo's
  own `scripts/agents/kit pr`; it opens the PR into `dev`, waits for CI and merges. `main` only takes `dev`,
  through `scripts/agents/kit pr --release --base main` from a branch cut at `origin/dev` (`kit pr` refuses to
  run on `dev` itself); machines keep following `main`.
- CI runs the kit's tests and lint, then the Native Site Editor's `npm test` and `npm run lint` from its `dev`
  branch against the changed kit. A kit change lands only when both pass, because every project runs the kit
  once it is released to `main`.
- After a release to `main`, `kit update` brings it to every project on the machine. `kit update --install-timer`
  (once per machine, and again after a change to `systemd/` or to `KIT_REPO` or `XDG_DATA_HOME`, which the timer
  keeps) runs it every 15 minutes through a `systemd --user` timer; `kit update --remove-timer` takes it out.

## Layout

| Path | What |
| --- | --- |
| `kit`, `kit-lib.sh`, `kit-lib.mjs` | the front door and the shared library |
| `kit.d/` | one file per shared command, each with a `# kit:` summary line (an inside helper such as `version` says `# kit-inside:` and stays out of the list) |
| `hooks/` | the guard hooks (`bash-guard`, `agent-cap`, `session-env`, `brief-guard`, `stop-guard`, and the opt-in `status-nudge`) and their `run.sh` |
| `context-card.mjs`, `learn.mjs`, `worktree.sh`, `tickets.mjs`, `unit.sh`, `review-findings.mjs`, `second-look.json`, … | helpers beside `kit` that commands and a project's forwarders run through `kit --home` |
| `orbit-client.mjs`, `ticket-store.mjs`, `orbit-setup.mjs`, `ticket-import.mjs` | the Orbit API client and its secrets file, the ticket store's rules and guards, `kit ticket setup`, and moving a project's ticket files to cards |
| `skills.json`, `skills.mjs`, `brief-lib.mjs` | the skills map (names and the kit's own one-line fallbacks, never a skill's text), and the brief `kit brief` writes |
| `launcher/` | the two launchers `kit init` copies into a project |
| `systemd/` | the update timer and service `kit update --install-timer` writes into `~/.config/systemd/user/` |
| `docs/` | the shared kitchen rulebook, the template for a project's extras, and the flow chart (`flow-chart.html`) |
| `skill-guard.mjs` | keeps paid skills out of every repo (below) |
| `tests/` | one test file per command or helper |

## Paid skills never go public

No skill file or skill text from `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` or plugins ever goes
into this repo or any project. `.gitignore` keeps skill folders out; `skill-guard.mjs` fails CI on a tracked
`SKILL.md` or anything under a `skills/` folder, and `kit pr` (in every project) also fails when a changed line
matches a line from the local skill files. Licence texts are shared word for word, so they are never compared:
a skill's licence files (`LICENSE`, `UNLICENSE`, `COPYING`, `NOTICE`, a longer name ending in `LICENSE` such as
`x-1.0.LICENSE.md`, or a font's `OFL.txt` / `Font-OFL.txt`) give no skill lines, and a project's own licence in its
top folder (a licence name on its own, such as `LICENSE`, `LICENSE.md`, `LICENSE-MIT`, `COPYING` or `UNLICENSE`) is left out of the changed lines `kit pr` checks (`--history` still
reads it). Tests use made-up skill text only.

A private project may keep its own skill (not a paid one): list each such folder by its repo path in
`"skillGuard": { "allow": [".claude/skills/<name>"] }` of `scripts/agents/kit.json` (a repo of skills lists
`"<name>"`). The path check lets exactly
those folders' own files through (never a `skills/` folder or another skill's `SKILL.md` below them, so a parent
such as `.claude` lets no other skill through), an entry that cannot be one skill folder (a whole `skills/` folder,
`.`, `..` or an absolute path) fails the guard, and the line check against the local skills still reads every line in them. Nothing is
allowed by default; `kit doctor` lists the allowed skills when the list is set.
