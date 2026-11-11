# Orbit's public API in the kit

The kit talks to Orbit only through its public REST API (`<origin>/api/public/v1`), in `orbit-client.mjs`; the card
rules sit in `ticket-store.mjs`, and people and agents reach it through `kit ticket`. Orbit's own reference is
`docs/public-api.md` in github.com/coollabsio/orbit, and its full contract is `packages/api/src/generated/openapi.json`
there. This page says which parts the kit uses, and why it leaves the rest out.

Checked on 2026-11-11 against Orbit's source (commit 373126a, "add private projects with member-based access") and,
with read-only calls, against the running Orbit with the kit's own token.

## What the kit uses

| Endpoint | Used by |
| --- | --- |
| `GET /me` | `kit doctor` (one short call: connected, token refused, Cloudflare blocked it), `kit ticket setup` |
| `GET /workspaces/{ws}/projects` | the board by its key (`--project`) |
| `GET /workspaces/{ws}/projects/{id}/statuses` | status names (`--status`, `list`, the card's stage) |
| `GET /workspaces/{ws}/projects/{id}/labels` | label names (`--label`, `labels`) |
| `GET /workspaces/{ws}/members` | assignees by name (`--assignee`, `members`, `next-lex`) |
| `GET /workspaces/{ws}/tasks` | `list`, `sub-tasks`, `check`, `kit next`, `import`, `parity` |
| `GET /workspaces/{ws}/tasks/{task}` | every read and every write (each write reads the latest version first) |
| `POST /workspaces/{ws}/tasks` | `create`, `import`, `tidy` (sub-tasks), `kit init --issues` |
| `PATCH /workspaces/{ws}/tasks/{task}` | `update`, `dates`, `repeat`, `next-lex`, `clear-next-lex`, claims, `kit pr` (Done) |
| `DELETE /workspaces/{ws}/tasks/{task}?expected_version=` | `trash` only, with `--lex-said`; never `permanent=true` |
| `GET` and `POST /workspaces/{ws}/tasks/{task}/comments` | `get --comments`, `note`, `comment`, `next-lex`, `tidy`, `kit pr` |

`repeat` writes the task's `recurrence` field: `{frequency, interval, weekdays, base}`, with `frequency` `daily`,
`weekly`, `monthly` or `yearly`, `interval` 1 to 365, `weekdays` (`mon` to `sun`) only for a weekly rule counted from
the due date, and `base` `due` or `completion`; `null` stops it. Orbit takes it in `PATCH` only (not when it creates a
task), and closing a repeating task (completed or cancelled) makes Orbit create the next one. A card
without a due date counts from the moment the repeat is set. `get` shows it as a "Repeats:" line. An Orbit
from before repeating tasks has no `recurrence` field on its tasks; `repeat` then says Orbit needs an update and sends
nothing. On 2026-11-11 the running Orbit did not have it yet (its source added it that day).

## New since 2026-11-06, and left out

| Endpoint or field | Why the kit leaves it out |
| --- | --- |
| `POST /workspaces/{ws}/projects` (make a board) | It needs a token for all projects; the kit's token covers chosen projects only, and a new board is Lex's choice. |
| `GET /docs/{id}/database`, `POST /docs/{id}/database/query`, `POST /docs/{id}/rows`, `PATCH /docs/{id}/rows/{row}`, `POST /docs/{id}/rows/trash` | Databases in Orbit Docs. The fleet keeps no Orbit docs (the token sees none), and cards are tickets, not database rows. |
| `POST`, `PATCH` and `DELETE /docs/{id}/database/properties` | Changing a database's columns; `DELETE` cannot be undone. Same reason, and not on the running Orbit yet. |
| `POST /exports`, `GET /exports/{id}`, `GET /exports/{id}/download` | A ZIP of the workspace. It needs a token whose only scope is an export scope, so the kit's token cannot use it. |

## Never used

- `DELETE /tasks/{task}?permanent=true` (delete for good): the kit has no permanent delete.
- `GET`, `POST` and `PATCH /docs` (Orbit Docs pages, there before 2026-11-06): no kit command needs them.
- `POST /integrations/discord/events`: for a Discord bot.

The public API has no task relations, mentions, notifications, attachments or comment edits, so the kit keeps
blockers on a `Blocked by:` line and writes new comments only.
