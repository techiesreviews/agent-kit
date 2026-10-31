# Agents

Kitchen rulebook: `scripts/agents/kit rulebook` (stations, who decides, builder and reviewer pins).
Agent commands: `scripts/agents/kit --help`; `scripts/agents/kit <command> --help` for one.

## This repo is the kit

- The kit lives at the top folder (`kit`, `kit-lib.*`, `kit.d/`, `hooks/`, `launcher/`, `systemd/`, `docs/`); `kit update` unpacks `main` from here into every machine's `~/.local/share/agent-kit/`, so whatever lands on `main` reaches every project within the update interval. The exception is `systemd/`: a machine's installed timer files (and the `KIT_REPO` and `XDG_DATA_HOME` they keep) change only when `kit update --install-timer` runs there again.
- `scripts/agents/kit` here is the launcher like in any project: it runs the machine copy. To try this checkout, set `KIT_HOME` to it (`KIT_HOME=$PWD scripts/agents/kit doctor`), or in a project `KIT_HOME=~/Projects/agent-kit-<branch> scripts/agents/kit unit --affected`.
- Work in a worktree (`git worktree add -b <branch> ../agent-kit-<branch> main`), land with `scripts/agents/kit pr` into `main`. CI runs this repo's tests, then the Native Site Editor's `npm test` and `npm run lint` from its `dev` branch against the changed kit; a kit change lands only when both pass.
- Projects link into `docs/kitchen.md` by heading, and their tests check those links against the kit they run. Renaming a heading keeps the old anchor as `<a id="old-heading"></a>` beside the new one, so no project's gate fails on the rename (the Native Site Editor's `tests/kit-editor.test.ts` on `dev` reads those anchors and tests a renamed heading).
- Every command is one file in `kit.d/` with a `# kit: <summary>` line and its own `tests/kit-<command>.test.ts`; shared helpers sit beside `kit`, reached from commands through `import.meta.dirname` or `KIT_HOME`, never through a project's `scripts/agents/`.

## Standards

- Plain words in every message a person reads; every run ends with one `RESULT: ok|fail …` line. The exceptions: `kit --home` (launcher and front door), whose output scripts read, prints only the kit's folder; and `kit go` ends with its `RUNNING: …` line (exit 75) while its job still runs.
- Tests never touch the real `~/.local`, `~/.cache`, `~/.claude`, `~/.codex` or `~/.agents`: temporary `HOME` and `XDG_*` folders.
- **Paid skills never go in this repo** (Lex, 2026-10-29): the skills map (`skills.json`) names skills and gives the kit's own one-line fallback, never a skill's text; no `SKILL.md`, nothing under a `skills/` folder, and no text from a local skill, in any file, commit or test fixture. `.gitignore` keeps them out; `skill-guard.mjs` runs in CI (paths) and in `kit pr` (paths and, on a machine with skill folders, changed lines). This repo never sets `skillGuard.allow` (a private project's own skills only). Tests use made-up skill text only.
