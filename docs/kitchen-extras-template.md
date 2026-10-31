# Kitchen extras: <project>

Copy to `docs/agents/kitchen-extras.md`, name it in `scripts/agents/kit.json` as
`"rulebookExtras": "docs/agents/kitchen-extras.md"` and keep only the lines this project needs.
`scripts/agents/kit rulebook` prints the shared rulebook, then this file. Where they differ, this
file wins.

## Branches, checks and the shared file

- **Landing branch `<land>`, release branch `<release>`** (`branches` in `scripts/agents/kit.json`).
  The push guard refuses an agent's raw `git push` to both branches. A project that lands on the branch
  it releases from (a site that deploys on every push) sets `"release"` to it and names why in
  `"exception"`, or `kit doctor` warns and `kit init --all` skips it.
- **Checks:** the commands in `checks` (`check`, `lint`, `test`) and when each runs.
- **Own check commands** (the `commands` folder): which to run for which change.
- **Shared file:** the one file two slices may share (`sharedFile`), or none.
- **Docs the shared rulebook names:** where this project keeps its runner guide, issue tracker
  guide, UX rulebook and routines, or that it has none.

## Visible changes

- **Feature list** (`featureList`) and the user-level check (`kit ux`), or none.
- **Screenshots:** how to shoot today's screens and a visible change.

## After a merge

- The after-merge step (a preview deploy and its `RESULT:` line), or none; where Lex tries a change.

## Release

- The release steps after `kit pr --release`, the first-hour check, and where the live version is
  recorded.
- **First step of the live deploy command:** `scripts/agents/kit release-check &&` before the deploy
  itself (nothing unsaved, HEAD exactly `origin/<release>`); a preview deploy needs none. A lead who
  must deploy past it runs `scripts/agents/kit release-check --waive "<reason>"` and then the deploy's
  own steps. A deploy that uploads a built folder builds it in the same command, as ignored files
  are not checked.

## Other

- Anything else only this project does: out-of-bounds folders, sibling projects, its history links.
- **Pins:** a `| Builder, every slice |` or `| Review, every change |` row here (same columns as the
  shared Who cooks table) replaces that pin for this project; `kit next` reads it.
