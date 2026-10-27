# Kitchen extras: <project>

Copy to `docs/agents/kitchen-extras.md`, name it in `scripts/agents/kit.json` as
`"rulebookExtras": "docs/agents/kitchen-extras.md"` and keep only the lines this project needs.
`scripts/agents/kit rulebook` prints the shared rulebook, then this file. Where they differ, this
file wins.

## Branches, checks and the shared file

- **Landing branch `<land>`, release branch `<release>`** (`branches` in `scripts/agents/kit.json`).
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

## Other

- Anything else only this project does: out-of-bounds folders, sibling projects, its history links.
