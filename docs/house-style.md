# House style

How every Techies tool should look and feel, whatever the project. It collects the choices Lex made
again and again across the Native Site Editor (editor.techies.tools), the script editor
(script.techies.tools), the prompter (prompter.techies.tools), the TechiesTools site and the Techies
Reviews website (techies.review). It travels with the kit, so a new project starts with it.

Read it when making a mock-up, writing a visible ticket, building one and reviewing one (kitchen
stations 3, 4 and 8). `kit ux` gives these rules to the UX reviewer together with the project's own
UX rulebook (`docs/agents/ux-rulebook.md`). **The project's rulebook adds detail and wins where it
differs**; a ticket may break a rule only when Lex asked for it there.

Each rule opens with one plain line, then any detail, a **why** naming the corrections it comes from
(dates are Lex's own words in that project; the chat memory's `memory/corrections/<project>.md`
lists them), and a **check**: `eye` is the UX reviewer judging screenshots or trying it, `try` means
using it as a person would, in a normal browser and in T3's browser.

## Say less

- **HS1** No toasts, pop-up statuses, banners or info strips after an action.
  The result shows where it happened: the button's label or a check mark, the item itself, a small
  dot on the button that opens the thing. A screen-reader status line (visually hidden) still
  announces it.
  Why: "the interface should show what is happening or what it is doing" (Native Site Editor,
  2026-10-23); "not everything needs to be mentioned in a toast" (2026-10-25); "remove the statusses
  al of them" (prompter, 2026-10-28).
  Check: `eye`.
- **HS2** No explainer lines, hints or keyboard tips beside controls.
  A control shows its name or its icon; the thing itself makes clear what it does.
  Why: "Drag the dot" removed from the image controls (2026-10-21); the agent menu cut to three
  actions, "no explainer or what soever needed" (2026-10-23); "Remove the explainer on the dragger"
  (prompter, 2026-10-28).
  Check: `eye`.
- **HS3** An action with a clear icon shows the icon alone.
  Its name goes in the tooltip and the accessible label.
  Why: "remove the text with ask agent, just show the icon" (Native Site Editor, 2026-10-25).
  Check: `eye`.
- **HS4** Visible words are plain, never code.
  No commit ids, file paths, selectors, technical field names or computer-only addresses
  (`localhost`) on screen.
  Why: the Native Site Editor's Files header and media audit (its rule S7).
  Check: `eye`.
- **HS5** The main screen holds only what is used all the time.
  Everything else (settings, the microphone, the agent connection, a second screen) sits in a
  popover anchored to the button that opens it, never in a sidebar. Leave out modes and toggles Lex
  did not ask for.
  Why: prompter, 2026-10-28: Copy MCP inside the folder icon, the microphone and the monitor control
  moved into settings, settings in a popover rather than a sidebar; Native Site Editor rule S5.
  Check: `eye`.

## Feel

- **HS6** Changes apply as they are made; there is no Save, Apply or Done step for a live edit.
  Undo is the safety net: one action is one Undo step, and Undo restores all of it. Done or Close
  only leaves.
  Why: "It needs to be done instantly" (image Replace, 2026-10-21) and "Also instantly" (shape, focus,
  zoom and trimming, 2026-10-21); Native Site Editor rules B10 and B11.
  Check: `try`.
- **HS7** Nothing pauses after a change or an Undo.
  The next keystroke or drag works at once; zooming, moving and dragging draw without a blank frame
  or a jump.
  Why: "It feels there is a delay when I changed something", "Undo feels slow" (2026-10-25); the
  image flicker while zooming and moving (2026-10-22).
  Check: `try`.
- **HS8** People act on the thing itself, not on a handle for it.
  One click on text types there; a draggable thing can be grabbed anywhere along it; no extra dot,
  tab or grip when the object can be dragged.
  Why: "click, and directly select and type text" (2026-10-23); "the dot feels not needed … just use
  the square" (2026-10-25); "I want the horizontal line to be totally draggable" (prompter,
  2026-10-28).
  Check: `try`.
- **HS9** A tool opens on a clear, calm start screen.
  It never opens content by itself that the person did not ask for; text reads left-aligned inside a
  centred column.
  Why: prompter, 2026-10-28.
  Check: `eye`.
- **HS10** A look Lex approved stays until he approves a new mock-up.
  Keep what exists (screen sizes, canvas dragging, layouts) unless the ticket changes it; when Lex
  prefers the old one, restore it rather than trying a third design.
  Why: "screen sizes need to stay as is in the current editor, also on the canvas with dragging"
  (2026-10-26); Native Site Editor rule L11.
  Check: `eye` against today's screen.
- **HS11** A new or redesigned screen starts from a mock-up Lex approved, with references from
  Mobbin first.
  Why: "this looks horrible. use mobbin" (Native Site Editor media); "use Mobbin to make it look
  better" (techies.tools, 2026-10-27).
  Check: the ticket links the mock-up; `eye` side by side.

## The same in every tool

- **HS12** Connecting an agent works the same way in every tool.
  The Copy MCP button looks, reads and gives feedback exactly like the one in the script editor and
  the Native Site Editor: the same labels, the same states from copying to connected (showing the
  agent's name) to Disconnect, the feedback on the button itself, and setup text that works for any agent app, not
  only Claude Code. Copy from the newest working one rather than building a new one. The copy happens
  on the click itself, before any server call, or the browser blocks it.
  Why: "The copy MCP should work exactly the same as in others like the script.techies.tools and
  editor.techies.tools, that means also the same statuses and how that button works and gives
  feedback" (prompter, 2026-10-28); "the prompt is not copied" (2026-10-24, again 2026-10-26); any
  agent (script editor, 2026-10-29).
  Check: `try`, in a normal browser and in T3's browser.
- **HS13** Agents appear under their own name and logo.
  "Claude", "Codex", "ChatGPT", never "(agent)"; the model's own logo where Phosphor has one, else a
  sparkle. A collaborator's caret is a thin line with a small first-letter circle, the name on hover.
  Agent changes go straight into the text, lightly marked with the agent's logo, and Undo takes them
  back. No chat panel: people bring their own agent through the MCP.
  Why: agent caret (script editor, 2026-10-28); agents and multiplayer plan (Native Site Editor,
  2026-10-24/25); "straight in" (script editor, 2026-10-28).
  Check: `eye` + `try`.

## Looks

- **HS14** No borders between surfaces.
  Cards, panels, headers and secondary buttons are set apart by soft shadows, tinted fills and
  surfaces that get lighter as they stack. Focus rings and functional lines (table rows, a divider)
  stay.
  Why: Lex, 2026-09-28 (brand guide and component library).
  Check: `eye`.
- **HS15** Only the project's colour and size tokens; no raw colours and no one-off sizes.
  Why: "one look across the chrome" (Native Site Editor colours); every Techies stylesheet builds its
  colours from a few named tokens.
  Check: the project's colour check where it has one, else `eye`.
- **HS16** Inter for text, Roboto Mono for code and numbers, Phosphor for icons.
  Code panels use Monaco's own themes (light and dark following the page), not the brand palette.
  Why: the Techies token set (2026-09-26); code blocks (2026-09-28); Phosphor in the Native Site
  Editor, the script editor and CamFrame.
  Check: `eye`.
- **HS17** Light and dark both look right, following the device's setting.
  Text above 4.5:1 (3:1 for large text) and the focus ring above 3:1, in both. A tool used in one
  setting only may ship one scheme, as the prompter ships dark.
  Why: every redesign Lex judged in the dark theme; the prompter's contrast test.
  Check: the project's contrast check where it has one, else `eye` in both schemes.
- **HS18** Phones and keyboards work too.
  Every visible change is tried at 390 px; `:hover` rules sit inside
  `@media (hover: hover) and (pointer: fine)`; targets are at least 24 px (44 px on touch); focus
  shows with `:focus-visible`; Esc closes what it opened. Motion is quick and calm (about 120–200 ms,
  ease-out, no bounce) and respects reduced motion.
  Why: Lex works from his phone too; Native Site Editor rules U4, U6, U7 and U8.
  Check: `eye` at 390 px and `try` by keyboard.

## Brand colours

What the live sites use, read from their stylesheets on 2026-10-29. Start a new tool from these;
copy the token block from the website's `styles/site.css` (techiesreviews/techies-reviews) rather
than picking new values.

| | Light | Dark |
| --- | --- | --- |
| techies.review | orange-red `oklch(52.3% 0.197 32.3)` (#c12200) on a warm near-white made from it | indigo night `oklch(16% 0.06 282)` (#0b0826), the orange lifted to 65% lightness |
| prompter.techies.tools | none (dark only) | the website's night and its dark orange `oklch(65% 0.227 32.3)` |
| script.techies.tools | calm neutral greys | night blue (hue 280), warm orange `#ff6a3d` (`oklch(70.4% 0.19 37.1)`) as the only accent |

- **HS19** Orange is the one accent; everything else is neutral or indigo.
  Orange marks actions, links, focus and what is current (the reading line, a pending change).
  Green and red only carry a meaning (done, failed, agent marks), never decoration.
  Why: the website's tokens ("the orange stays for actions, links and focus"); the script editor
  ("the warm orange as the only accent"); the prompter ("bright orange actions").
  Check: `eye`.
- **HS20** Dark mode is the indigo night, never pure black or grey-black.
  Dark pages, cards, tags and shadows are made from the night colour by lightness; scales stop near
  black (about 8%), never at it.
  Why: the website's default dark mode (techies-reviews PR #10); the prompter uses the same night and
  the script editor a near-identical one.
  Check: `eye`.
- **HS21** One base colour makes the whole scale.
  A tool's palette is built from its one brand colour (and the night for dark mode) with relative
  OKLCH steps, so changing that one value changes everything and the contrast between steps holds.
  Why: the website's `--color-primary` and `--color-night`; the Native Site Editor's
  `--color-primary`.
  Check: `eye` on the stylesheet's token block.
- **HS22** White text on orange only when it is large and bold; otherwise use dark text on the
  orange, or the darker orange.
  Why: light text on the brighter oranges falls under 4.5:1 (brand guide, 2026-09-28); the prompter
  allows white on orange only at 19 px bold; the script editor sets dark text on its orange.
  Check: the contrast check, else `eye`.

### Not yet decided (ask Lex before aligning)

- **The exact orange.** The website and the prompter use hue 32 (#c12200 in light mode); the script
  editor uses a brighter, warmer #ff6a3d (hue 37).
- **Light mode's background.** The website tints it warm from the orange; the script editor keeps
  calm neutral greys and pure white panels.
- **The Native Site Editor's own colours** are blue (`oklch(54.6% 0.215 262.9)`), not the orange.
- **Older guides.** The Neon Lab purple and red (2026-09-27) and brand guide v2 with plum and red
  #EB2939 (2026-09-28) predate the live sites; the live sites win for new work.
- Thumbnails keep their own Calm Sunset style (navy and plum with orange edge accents), a close
  relative of these colours.

## How rules are added

- A correction Lex gives in two or more projects, or one that applies to every tool, becomes a rule
  here after Lex has seen it (`kit learn` marks it covered once it is). One that belongs to one
  project goes in that project's UX rulebook.
- A new rule takes the next `HS` number and has its why and its check. Extend a rule rather than
  adding a near-copy.
- When Lex reverses a rule, change or remove it with the date and his words in the why.
