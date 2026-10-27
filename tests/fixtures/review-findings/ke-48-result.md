REVIEW_STATUS: complete

**Defects**

*Spec*

- None. All four "Done when" items are met:
  - `grep -n "origin/dev\|check-colours" scripts/agents/kit.d/ux` finds nothing.
  - Ticket 25's wider grep finds only `kit.json`, the editor's own commands (`shots.sh`, `deploy-preview.sh`, `project.d/*`) and comments.
  - The land-on-`main`, own-`checks.css`, no-`checks.css` and editor raw-versus-allowed tests are all present.
  - `kit slice` calls `kit ux` with no `--base` (`scripts/agents/kit.d/slice:340`), so it now gets `origin/<land>`.
  - The ticket asks for every failure line to become a finding. The change instead drops lines about files outside the diff. That is a deliberate, documented choice to keep parity with the old code, so I have not counted it as a defect.

*Standards*

CODING_STANDARDS.md has no section for kit plumbing. Only "Test fixtures" applies, and the test file meets it: the `Ux` type declares `colourFindings`, and `editorColours` is typed. So the faults below are judged on behaviour.

- 0297da793:scripts/agents/kit.d/ux:464 — P2 fault: the "subject" rule decides every located line, CSS lines included.
  - Evidence: for any line, `subject()` takes the first token of the message text that names a known tracked or untracked file, and that token wins over the line's own file. So a real finding on a changed CSS file is dropped as "outside the diff" whenever its message names an unchanged file. Another project's checker could print `src/a.css:3: #fff (use the token from src/theme.css)`; with `src/a.css` changed and `src/theme.css` not, this yields no finding and `1 outside the diff`. Because `known` holds every tracked file, any message token that matches a root-level file name does the same.
  - Fix: use the named-file subject only when the line's own file is not one of the CSS files passed to the checker, i.e. for allow-list or other non-CSS lines. A line whose own file is a changed CSS file always counts for that file.

- 0297da793:scripts/agents/kit.d/ux:344 — P3 fault: `landBase` treats a padded value inconsistently.
  - Evidence: it checks for blankness after trimming but returns the untrimmed value. `branches.land: " dev"` passes the check, then fails with `no merge-base with origin/ dev`. This mirrors `kitBranch` in `kit-lib.mjs:61`, so `kit pr` has the same edge.
  - Fix: return `origin/${textSetting(value)}` (or throw when it is undefined), which also reuses the helper defined three lines above.

**Validation gaps**

- `tests/kit-ux.test.ts`: add a run with a broken `kit.json` (`'{ "branches": '`), an explicit `--base origin/dev`, and a touched feature that needs no screenshots. Assert `RESULT: fail ux scripts/agents/kit.json is unreadable: …`. Done says the settings are now read on every run, even with `--base` and no screenshots, but the only broken-file test (lines 327–330) goes through the shots lookup.
- `tests/kit-ux.test.ts`: add a fixture with no `scripts/agents/kit.json` at all, which makes `projectSettings` return `{}`. Assert that no `--base` gives `RESULT: fail ux needs --base (no branches.land in scripts/agents/kit.json)`, and that `--base origin/dev` with a changed CSS file prints `colours: skipped (no checks.css …)`.
- In the `colourFindings` parser test: call it with `known: ["src/a.css", "src/theme.css"]` and `changed: ["src/a.css"]` on `src/a.css:3: #fff (see src/theme.css)`. Assert one finding for `src/a.css`. This pins the P2 above; today it would return `outside: 1`.
- In the `colourFindings` parser test: add a path containing a space (`src/my file.css:2: red`). Pin whether it becomes a located finding or the generic log finding. The `[^\s:()]+` regex currently sends it to the generic finding without saying so.

**Optional nits**

- `scripts/agents/kit.d/ux:338` redefines `oneLine`, and `kit-lib.mjs:50` already has one; `projectSettings` partly repeats `kitSettings`. The lenient reader is justified, because `kitSettings` requires `project`. But the problem-line format could be exported from `kit-lib.mjs` once, so the two error messages cannot drift apart.
- `kit.d/ux:559` runs `git ls-files` for `known`, and `kit.d/ux:593` runs it again for `tracked`. Computing it once would serve both.
- Parity edge: an invalid allow entry (`allow entry requires file, match and reason`) names no file, so its subject is the allow list itself. It is dropped when the allow list is not in the diff. The old code reported it whenever the entry's `file` was a changed CSS file. In practice an invalid entry only appears when the allow list was edited, so this rarely matters.
- The ticket's "each failing before the fix" can't hold for the editor raw-versus-allowed test, since a parity test passes on both versions. Done already says so; the ticket wording could say "parity" for that item.
