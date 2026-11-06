# Agent Kit

The shared kitchen every one of Lex's projects runs: one set of agent commands (`kit doctor`, `kit slice`,
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
  line `* text=auto eol=lf` in `.gitattributes`. It writes only what is missing (and updates the kit's own marked "Messages to Lex" section when the rulebook's version is higher), so it can run again: when the kit
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
  (`kit next`'s claim commit to the landing branch and `kit pr`'s PR branch, from Node; `kit pr`'s merge goes through
  `gh`), which the hook never sees. That is the allowance for the kit's steps: a step that must push a guarded
  branch belongs in a kit command, never in a raw `git push`.
- What changes for a lead: docs and ticket commits pushed straight to the landing branch keep working where it is not
  the release branch (the Native Site Editor's `dev`). Where the two are one branch (this repo, a live site), they
  land through `kit pr` (docs tier), or `kit next --start`, which claims and starts the slice itself.

## Review loop

The review budget follows the risk (after Theo's sol-loop): 3 fix rounds, 5 only for security, permissions, auth, data loss, state or
concurrency (by changed paths and the ticket's words; `paths.risky` in the settings adds project patterns), and a review that returns
only nits ends the loop. Round 2 and later review only the code changed since the last review and the open finding ids (`R1-1`, …),
each marked resolved or still open; `kit pr` puts the line "Reviewed with review-loop: N rounds with <model>. Verdict: approved" and a
findings ledger in the PR, and an out-of-budget run is reported, never approved. The rule's one source is the "Review loop" section of
`docs/kitchen.md`; briefs carry it and `kit init` points projects at it.

Known limits (waived follow-ups): the PR line and ledger have edge cases (an earlier "approved" can stay in the PR after a "behind" rebase until the next review finishes; a merge from the base puts other people's code in the "changes since the last review" file; a nits-only review is not reused after a rebase; second-look findings count in the verdict but not in the ledger). A second look that no model could take is written into the PR block as "second look: skipped (<reason>)". An out-of-budget should lands as a follow-up with a budget report that shows only the reviewer's side. A review that leaves an id out is rejected as incomplete: run `kit review` again by hand. A ticket's risk comes from its title, goal and named files only, and the fix brief points at the newest complete review.

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
- **What it covers:** the kit's headless Claude calls (`kit review`, `kit fix`, `kit slice` builders, `kit ux`). Interactive sessions are not touched; Anthropic's credit does not cover them.
- **Jobs systemd starts for you** do not see your shell's variables: run `systemctl --user import-environment KIT_API_KEY_FILE KIT_API_CONFIG_DIR` first (leave out the second if you use the default), or export them in the shell that starts the kit; to turn the route off for those jobs, run `systemctl --user unset-environment KIT_API_KEY_FILE KIT_API_CONFIG_DIR` as well.
- **Turn off:** unset `KIT_API_KEY_FILE`. The kit then uses the subscription as before.
- **Safety:** only the child process that runs `claude` passes the key on (the kit itself reads the key file's first line just to see it is not blank, and never keeps, prints or logs it, or puts it on a command line), and Claude Code is told to keep it out of the shell commands a builder starts (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`); a call whose tool list has no Bash, such as a review, runs without that flag because it starts no shell command and the flag would make claude leave empty `.env`, `.npmrc`, `yarn.lock` files in the folder. The key file and the config folder must be absolute paths, the key file with mode 600; otherwise the call stops with a plain message.
- **Limits:** the API config folder starts empty, so skills and settings from `~/.claude` are not used on the route (link them in if you want them); a saved session does not resume across switching the route on or off (start a fresh run); a run killed before it printed its cost counts as unknown, and doctor says so.
- **Known limits (follow-ups):** the spend total misses a run whose runner was killed outright (no line is written); `kit doctor` shows the total only while the route is on and healthy; a config folder that exists but cannot be written gets the CLI's own error, not a plain refusal; a Claude started from a builder's shell on the route cannot sign in to the subscription (its `CLAUDE_CONFIG_DIR` still points at the API folder).
- **Check it:** `kit doctor` says whether the route is on or off, the key file's mode, and the total spent; every run adds a line (time, command, model, tokens, cost) to `~/.local/state/agent-kit/api-spend.log`.

### Writing with the credit: `kit ask`

- **Plain call:** `scripts/agents/kit ask --api --prompt-file <file> [--model sonnet|opus|haiku]` runs one headless `claude -p` on the API route, prints the answer and ends with its cost; `--out <file>` writes it to a file instead. It needs the route on (`KIT_API_KEY_FILE`), so a lead or helper first checks `kit doctor` says "api route: on".
- **Script mode:** add `--script --out <file>`. The call is then given Lex's own rules in front of your prompt (`youtube/AGENTS.md` and the "Current script and prompter playbook" section of `youtube/shared/taste/scripts.md`, under `~/Projects/chat/youtube`, or `KIT_SCRIPT_RULES_ROOT`). If a rules file or that section is missing, nothing is sent and the message names it; the playbook's linked voice and workflow files are not added, so name them in your prompt file if the task needs them.
- **Safe output:** `--out` never overwrites. If the file exists (a connected editor may hold newer edits) the answer goes beside it as `<name>.draft-<time><ext>`, and a lead merges by hand.
- **Spend:** every call adds a line to `~/.local/state/agent-kit/api-spend.log`; the credit expires 2026-11-11.

## The factory: generated briefs, long jobs that wait

- `kit brief <ticket> [--stage build|review|second-look|fix] [--note "<text>"]` prints the whole brief for a
  delegated child from the ticket, the project's settings and the rules: owner, worktree setup, pins, commands and
  evidence, the house rules, the wait rule, the skills for the ticket's files (the skills map, `skills.json`), the
  talk style and the report's last line. It ends with a marker line, `kit-brief: <kit version> <ticket> <stage>`.
  A lead passes it to `delegate_task`; a rule changes once, here. A project without ticket files uses
  `kit brief --task "<title>" --owner <id> --note "<the task>"`.
- `kit go <job> -- <command>` starts a long job (a slice, a long `kit pr`, specs) with `kit bg`, in its own user
  systemd scope, and waits in the foreground for at most 9 minutes per call. While the job runs it ends with
  `RUNNING: <job> (…). Run again: scripts/agents/kit go <job>` and exit 75; once the job ends it prints the job's
  RESULT line and exits with the job's code (1 for a job's own 75, or for a job whose RESULT line says fail
  although it exited 0).
- Two hooks back this up. `brief-guard` (Claude `PreToolUse` on `mcp__t3-code__delegate_task` and `Agent|Task`)
  refuses a brief without the marker; research, review-only and question tasks start with
  `kit-brief: none (<reason>)`, and the read-only agent types (Explore, Plan) pass. `stop-guard` (Claude and Codex
  `Stop`) refuses to end a turn while a `kit go` job of the worktree, or a `kit-*` systemd unit working in it, still
  runs; it lets the turn end for a job past its time limit, after six refusals in a row, or with
  `KIT_ALLOW_STOP=1`.

## Tickets are moving to Orbit (in stages)

- Tickets are moving from markdown files to Orbit cards, one project at a time. Stage 1 is here: the Orbit client and
  `kit ticket` (`kit ticket --help`): create, get, list, update, dates, note, comment, sub-tasks, next-lex and
  clear-next-lex, trash, setup. It reaches every board the token covers, from any project folder or with `--project`.
- A project's `scripts/agents/kit.json` says which store it uses: `"tickets": "files"` (the default) or `"orbit"`, and
  `"orbit": { "project": "TOOLS", "parent": "TOOLS-10" }` names its board and the card new tickets go under (parent is
  optional). `kit next`, `kit slice`, `kit pr`, `kit status` and `kit init --issues` still read ticket files; later
  stages move them behind `ticket-store.mjs`, then remove the file store.
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
- Orbit's public API has no task relations, so blockers are a `Blocked by: KEY-n, KEY-m` line in the description
  (`--blocked-by`). Its docs: `docs/public-api.md` in github.com/coollabsio/orbit.

## Nothing unsaved goes live

- `kit release-check` is the second half of that gate: it fails unless the working tree is clean (no changed or
  untracked file outside `.scratch/`) and HEAD is exactly `origin/<release>` after a fetch (`branches.release`,
  the branch the push guard reads). A project's own live deploy command runs it first
  (`scripts/agents/kit release-check && <deploy>`); `kit pr --release` runs `kit release-check --land` before it
  opens the release PR, so the release is cut from exactly what landed (then rebased onto `origin/<release>`).
  It pushes nothing; ignored files (a built `dist/`) do not count. Only a `*-lead` owner may pass it with
  `--waive "<reason>"`, which its `RESULT:` line names with what was let through; `kit pr --release --waive` hands
  its reason on, so one waiver covers both the review findings and the check.

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
| `kit.d/` | one file per shared command, each with a `# kit:` summary line |
| `hooks/` | the guard hooks (`bash-guard`, `agent-cap`, `session-env`, `brief-guard`, `stop-guard`) and their `run.sh` |
| `context-card.mjs`, `worktree.sh`, `tickets.mjs`, `unit.sh`, `review-findings.mjs`, `second-look.json`, … | helpers beside `kit` that commands and a project's forwarders run through `kit --home` |
| `orbit-client.mjs`, `ticket-store.mjs`, `orbit-setup.mjs` | the Orbit API client and its secrets file, the ticket store's rules and guards, and `kit ticket setup` |
| `skills.json`, `skills.mjs`, `brief-lib.mjs` | the skills map (names and the kit's own one-line fallbacks, never a skill's text), and the brief `kit brief` writes |
| `launcher/` | the two launchers `kit init` copies into a project |
| `systemd/` | the update timer and service `kit update --install-timer` writes into `~/.config/systemd/user/` |
| `docs/` | the shared kitchen rulebook and the template for a project's extras |
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
