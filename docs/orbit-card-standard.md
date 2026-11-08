# Orbit card standard (approved 2026-11-08)

One short card. History in comments. Parts as sub-tasks. Questions in a desk thread.

## Description (short, about 10 lines at most)
1. First line, only when someone must act: `Next step (Lex): <what>` or `Next step (fleet): <what>`. `kit ticket next-lex` writes and keeps the Lex line; the fleet line is written by hand.
2. Goal: 1 to 2 lines. What and why. For an idea: the idea, the claim, the source (one line each).
3. `Done when:` 2 to 4 checks, each checkable.
4. `Links:` files, PRs, docs, other cards. Paths and URLs only.

Nothing else. The kit's own lines (`Planned dates:`, `Blocked by:`, `Claimed by:`) may sit in the description too. No `## Notes`, no timelines, no stage lines, no checklists (`- [ ]`), no planned-date prose, no long source quotes.

## Comments (history and evidence)
- One comment per event. Start with the date: `2026-11-08 <what happened>`. Add the PR or file link.
- Moved text keeps its words. Start the comment with `Moved from the description (<date>):`.
- A card waiting for Lex: also one comment that starts with `@Lex` and says what he must do or decide in 2 to 5 lines, with the desk thread link. (Orbit's API has no documented mention syntax and service-account writes send no notification: the assignment is what puts it on his list.)

## Sub-tasks (the parts)
- Every part that can be done, finished or assigned on its own is a sub-task (`--parent KEY`) with its own status.
- A sub-task is assigned to Lex only when it waits for him. Description: 1 to 2 lines plus `Done when:`.
- A parent keeps the goal; its sub-tasks show the progress.

## Fields
- Status: Backlog, In Progress, Done (Todo only where the board has it). A card waiting for Lex to try or review: In Progress and assigned to Lex.
- Dates only in the date fields. Where a date came from goes in a comment.
- Labels give the type or stage (bug, video stage, series). Never a label or status with the word publish without Lex's exact words.
- Priority only when Lex or the goal says so.
- Ideas (IDEA board): the idea in 2 lines, source, claim. Evidence and research in comments. A chosen idea becomes a VID card; the idea card links to it.
- Titles: verb plus result, short. A series or project goes in a label, not in a `[bracket]` prefix (existing prefixes may stay).

## Never
- A question for Lex inside a card. Use a desk thread, set `Next step (Lex)`, In Progress, assign Lex.
- Delete a card (needs Lex's exact words). Move to Publish or tick "Scheduled in Radaar" (needs Lex's exact words).

## How the kit helps
- `kit ticket note KEY text` posts a dated comment. `kit ticket comment KEY text` posts a comment as it is.
- `kit ticket create` and `kit ticket update` print a warning (the exit code stays 0, nothing is blocked) when a new description is over 12 lines with text, has a `## Notes` section or a checklist line (`- [ ]`, `- [x]`), or has no `Done when:` line. The kit's own lines are not counted.
- `kit ticket check KEY | --project KEY | --all [--json]` lists every card that breaks the standard and which rule. It changes nothing and any role may run it.
- `kit ticket next-lex KEY "reason" [--comment "details"]` sets `Next step (Lex):`, assigns Lex, moves a Backlog or Todo card to In Progress and posts the `@Lex` comment.
- `kit ticket tidy KEY --dir FOLDER [--dry-run]` moves a long card to the standard: comments first, then the description, then the sub-tasks. A lead runs it; run it again after a failure and it finishes the rest without doubling anything.
