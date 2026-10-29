# Agent Kit

The shared kitchen every one of Lex's projects runs: one set of agent commands (`kit doctor`, `kit slice`,
`kit review`, `kit pr`, …), the guard hooks for Claude and Codex, and the kitchen rulebook. Each project keeps
only a small launcher and its own settings; the kit itself lives here, once.

## How a project uses it

- On a machine without the kit yet, fetch it once and fill the machine copy:
  `git clone --depth 1 https://github.com/techiesreviews/agent-kit ~/.cache/agent-kit && ~/.cache/agent-kit/kit update`.
- Then turn on the update timer, so every later kit merge reaches the machine within 15 minutes:
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
