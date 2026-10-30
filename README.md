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
  `scripts/agents/hooks/run.sh` and the hook entries in `.claude/settings.json` and `.codex/hooks.json`.
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

## Changing the kit

- Work in a worktree (`git worktree add -b <branch> ../agent-kit-<branch> main`) and land with this repo's own
  `scripts/agents/kit pr`; it opens the PR into `main`, waits for CI and merges.
- CI runs the kit's tests and lint, then the Native Site Editor's `npm test` and `npm run lint` from its `dev`
  branch against the changed kit. A kit change lands only when both pass, because every project runs the newest
  kit.
- After a merge, `kit update` brings it to every project on the machine. `kit update --install-timer` (once per
  machine, and again after a change to `systemd/` or to `KIT_REPO` or `XDG_DATA_HOME`, which the timer keeps) runs
  it every 15 minutes through a `systemd --user` timer; `kit update --remove-timer` takes it out.

## Layout

| Path | What |
| --- | --- |
| `kit`, `kit-lib.sh`, `kit-lib.mjs` | the front door and the shared library |
| `kit.d/` | one file per shared command, each with a `# kit:` summary line |
| `hooks/` | the guard hooks (`bash-guard`, `agent-cap`, `session-env`) and their `run.sh` |
| `context-card.mjs`, `worktree.sh`, `tickets.mjs`, `unit.sh`, `review-findings.mjs`, `second-look.json`, … | helpers beside `kit` that commands and a project's forwarders run through `kit --home` |
| `launcher/` | the two launchers `kit init` copies into a project |
| `systemd/` | the update timer and service `kit update --install-timer` writes into `~/.config/systemd/user/` |
| `docs/` | the shared kitchen rulebook and the template for a project's extras |
| `skill-guard.mjs` | keeps paid skills out of every repo (below) |
| `tests/` | one test file per command or helper |

## Paid skills never go public

No skill file or skill text from `~/.claude/skills`, `~/.agents/skills`, `~/.codex/skills` or plugins ever goes
into this repo or any project. `.gitignore` keeps skill folders out; `skill-guard.mjs` fails CI on a tracked
`SKILL.md` or anything under a `skills/` folder, and `kit pr` (in every project) also fails when a changed line
matches a line from the local skill files. Tests use made-up skill text only.

A private project may keep its own skill (not a paid one): list each such folder by its repo path in
`"skillGuard": { "allow": [".claude/skills/<name>"] }` of `scripts/agents/kit.json` (a repo of skills lists
`"<name>"`). The path check lets exactly
those folders' own files through (never a `skills/` folder or another skill's `SKILL.md` below them, so a parent
such as `.claude` lets no other skill through), an entry that cannot be one skill folder (a whole `skills/` folder,
`.`, `..` or an absolute path) fails the guard, and the line check against the local skills still reads every line in them. Nothing is
allowed by default; `kit doctor` lists the allowed skills when the list is set.
