// The one page per build that kit score --html writes: self-contained HTML (inline CSS and SVG, no network,
// light and dark) that teaches Lex where the build is, what reviews caught, what he corrected, the ladder and builders.
import { posix } from "node:path";
import { feedbackKinds, parseFeedback } from "./tickets.mjs";

const findingKinds = { fault: "Real fault", ticket: "Not what the ticket asked", race: "Timing", style: "Style", unsorted: "Unsorted" };
const findingNouns = { fault: "real faults", ticket: "mismatches with the ticket", race: "timing problems", style: "style points", unsorted: "unsorted findings" };
const phaseKinds = { build: "Building", review: "Review", fix: "Fixing", land: "Landing" };
const rungs = ["Lex checks everything before release", "Lex checks a sample; the UX reviewer checks everything",
  "Changes with nothing visible release on their own; visible ones wait for Lex", "Small visible changes release on their own; bigger ones wait"];
// The ladder counts corrections about how things look and feel; a real fault or a workflow note is not a UX correction.
const uxKinds = new Set(["too-much", "below-bar", "felt-wrong"]);
const streakGoal = 5, compareAt = 10;

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const sum = values => values.reduce((total, value) => total + value, 0);
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const round = value => Math.round(value * 10) / 10;
const sentence = text => text.charAt(0).toUpperCase() + text.slice(1);
const median = values => {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null;
};

// Brief and commit are short steps around the build, so they count as building.
const phaseKind = name => ({ review: "review", fix: "fix", pr: "land" })[name] ?? "build";
function phaseMinutes(piece) {
  const totals = Object.fromEntries(Object.keys(phaseKinds).map(kind => [kind, 0]));
  for (const { name, start, end } of piece.phases ?? []) {
    const span = Date.parse(end) - Date.parse(start);
    if (span >= 0) totals[phaseKind(name)] += span / 60_000;
  }
  return totals;
}

// A declined finding keeps its review text; its kind is the word after the severity, else unsorted.
// The page counts a declined finding only where its kind was recorded, so the lighter segments and the totals agree.
function declinedKinds(piece) {
  const counts = {};
  for (const review of piece.reviews ?? []) for (const item of review.declined ?? []) {
    const kind = /\bP[0-3]\b\W{0,3}(fault|ticket|race|style)\b/.exec(item?.text ?? "")?.[1] ?? "unsorted";
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

// Serious is P0 and P1, minor P2, style P3: the page never shows P-codes.
function severity(piece) {
  const total = { serious: 0, minor: 0, style: 0 };
  for (const review of piece.reviews ?? []) {
    const counts = review.counts?.severity ?? {};
    total.serious += (counts.P0 ?? 0) + (counts.P1 ?? 0); total.minor += counts.P2 ?? 0; total.style += counts.P3 ?? 0;
  }
  return total;
}

const found = piece => sum(Object.keys(findingKinds).map(kind => piece.findings?.[kind] ?? 0));

// Done is merged or a closed ticket (a queued merge may never record its SHA); waiting on Lex is a ticket
// marked for him; running has a record; the rest wait to start. Only the build's own tickets are pieces, and a
// dropped (wontfix) ticket is none: scorePage drops its record before any section sees it.
const buildTickets = tickets => tickets.filter(ticket => ticket.file.includes("/build/tickets/"));
function pieceStates(pieces, allTickets = []) {
  const tickets = buildTickets(allTickets);
  const bySlug = new Map(tickets.map(ticket => [ticket.slug, ticket]));
  const lex = ticket => ["ready-for-human", "needs-info"].includes(ticket?.status);
  const rows = pieces.map(piece => {
    const ticket = bySlug.get(piece.piece);
    return { piece, state: piece.landed?.sha || ticket?.status === "closed" ? "done" : lex(ticket) ? "lex" : "running" };
  });
  const recorded = new Set(pieces.map(piece => piece.piece));
  for (const ticket of tickets) {
    if (recorded.has(ticket.slug) || ticket.status === "wontfix") continue;
    rows.push({ ticket, state: ticket.status === "closed" ? "done" : lex(ticket) ? "lex" : "waiting" });
  }
  return rows;
}

// Builds oldest first, each { map, entries, unreadable }: up a rung after five in a row without a UX correction,
// down one when Lex finds a UX problem after release. A build whose log could not be read is left out, never
// counted as clean.
export function ladder(builds) {
  let rung = 1, streak = 0, unreadable = 0;
  for (const build of builds) {
    if (build.unreadable) { unreadable++; continue; }
    const ux = build.entries.filter(entry => uxKinds.has(entry.kind));
    if (ux.some(entry => entry.afterRelease === "yes")) rung = Math.max(1, rung - 1);
    streak = ux.length ? 0 : streak + 1;
    if (streak === streakGoal) { rung = Math.min(rungs.length, rung + 1); streak = 0; }
  }
  return { rung, streak, builds: builds.length - unreadable, unreadable };
}

// Entries of a known kind, and whether any line (or the heading) could not be read; tickets.mjs check names them.
function feedbackLog(text, file) {
  if (!text) return { entries: [], unreadable: false };
  const { entries, problems } = parseFeedback(text, file, () => true);
  return { entries: entries.filter(entry => Object.hasOwn(feedbackKinds, entry.kind)), unreadable: problems.length > 0 };
}

// Per kind of job, per builder: pieces, median minutes, rounds and findings per piece, build cost per piece where known.
// Dollars are a floor (partial) when any piece is unpriced or its own dollars leave out runs.
function builderGroups(pieces) {
  const kinds = new Map();
  for (const piece of pieces) {
    const kind = piece.kind || "unknown", who = piece.who || "unknown";
    if (!kinds.has(kind)) kinds.set(kind, new Map());
    const builders = kinds.get(kind);
    if (!builders.has(who)) builders.set(who, []);
    builders.get(who).push(piece);
  }
  return [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([kind, builders]) => {
    const rows = [...builders].sort(([a], [b]) => a.localeCompare(b)).map(([who, items]) => {
      const usd = items.map(item => item.cost?.build?.usd).filter(Number.isFinite);
      const tokens = items.map(item => item.cost?.build?.tokens).filter(Number.isFinite);
      const partial = usd.length < items.length || items.some(item => item.cost?.build?.partial);
      return { who, pieces: items.length, minutes: median(items.map(item => item.minutes)), rounds: round(sum(items.map(item => item.rounds ?? 0)) / items.length),
        findings: round(sum(items.map(found)) / items.length), usd: usd.length ? sum(usd) / items.length : null, partial: usd.length > 0 && partial,
        tokens: tokens.length ? sum(tokens) / tokens.length : null };
    });
    const pieces = sum(rows.map(row => row.pieces));
    return { kind, pieces, rows, advice: pieces >= compareAt ? advice(kind, rows) : null };
  });
}

const dollars = row => `${row.partial ? ">=" : ""}$${row.usd.toFixed(2)}`;

// Best is fewest findings per piece, then fewest rounds, then fewest minutes; cheapest is the lowest dollars per piece
// among builders whose every piece has its full price, so a floor never wins.
function advice(kind, rows) {
  const best = [...rows].sort((a, b) => a.findings - b.findings || a.rounds - b.rounds || (a.minutes ?? Infinity) - (b.minutes ?? Infinity))[0];
  const priced = rows.filter(row => row.usd !== null && !row.partial).sort((a, b) => a.usd - b.usd);
  const lead = `${best.who} builds ${kind} best (${plural(best.findings, "finding")} a piece)`;
  if (!priced.length) return `${lead}; which is cheapest is not known yet.`;
  if (priced[0] === best) return `${best.who} builds ${kind} best and cheapest (${plural(best.findings, "finding")}, ${dollars(priced[0])} a piece).`;
  return `${lead}; ${priced[0].who} builds it cheapest (${dollars(priced[0])} a piece).`;
}

// A fix link is relative to the build folder: tickets/… is the build's, ../tickets/… the map's. The page shows it as
// text: a PR link would be an external URL, and a ticket link would not resolve from the page's .scratch folder.
function fixText(fix, tickets, map) {
  if (fix === "open") return "No fix yet";
  const link = /^\[([^\]]+)\]\(([^()\s]+)\)$/.exec(fix);
  if (!link) return `Fixed in ${fix}`;
  const path = `/${map}/${posix.normalize(posix.join("build", link[2]))}`, ticket = tickets.find(item => item.file.endsWith(path));
  return `Fix: ticket ${link[1]}${ticket?.title ? `, ${ticket.title}` : ""}${ticket ? ticket.status === "closed" ? " (done)" : " (open)" : ""}`;
}

const legend = (items, extra = "") => `<ul class="legend">${items.map(([key, text]) => `<li><span class="key" data-key="${key}"></span>${esc(text)}</li>`).join("")}${extra}</ul>`;
// Each row's name spans the table above its numbers, so the columns fit a phone.
const table = (head, rows) => `<details><summary>Show the numbers as a table</summary><table><thead><tr>${head.map(cell => `<th scope="col">${esc(cell)}</th>`).join("")}</tr></thead>` +
  rows.map(([name, ...cells]) => `<tbody><tr><th scope="rowgroup" colspan="${head.length}">${esc(name)}</th></tr><tr>${cells.map(cell => `<td>${esc(cell)}</td>`).join("")}</tr></tbody>`).join("") + "</table></details>";
const section = (id, title, caption, body) => `<section aria-labelledby="${id}"><h2 id="${id}">${title}</h2><p class="caption">${esc(caption)}</p>${body}</section>`;
const name = piece => piece.title || piece.piece;
// A bar whose segments grow by value, 2px apart, its length a share of the whole.
const bar = (share, segments) => `<div class="track"><div class="bar" style="inline-size:${round(Math.max(share, 0.01) * 100)}%">` +
  segments.filter(segment => segment.value > 0).map(segment => `<span data-key="${segment.key}"${segment.light ? " data-light" : ""} style="flex-grow:${round(segment.value * 100)}" title="${esc(segment.title)}"></span>`).join("") + "</div></div>";

function whereSection(pieces, tickets) {
  const rows = pieceStates(pieces, tickets), count = state => rows.filter(row => row.state === state).length;
  const tiles = [["done", "Done"], ["running", "Running"], ["lex", "Waiting on Lex"], ["waiting", "Not started"]]
    .map(([state, label]) => `<div class="tile" data-state="${state}"${count(state) ? " data-some" : ""}><span class="value">${count(state)}</span><span class="label">${label}</span></div>`).join("");
  const timed = pieces.filter(piece => piece.minutes > 0), longest = Math.max(...timed.map(piece => piece.minutes), 0);
  const slow = timed.find(piece => piece.minutes === longest);
  let caption = `${count("done")} of ${plural(rows.length, "piece")} done`;
  if (count("lex")) caption += `, ${count("lex")} waiting on Lex`;
  if (slow) {
    const phases = phaseMinutes(slow), most = Object.keys(phases).sort((a, b) => phases[b] - phases[a])[0];
    caption += `; the longest, ${name(slow)}, took ${Math.round(longest)} minutes, most of it ${phaseKinds[most].toLowerCase()}.`;
  } else caption += "; no piece has recorded time yet.";
  const timeline = timed.length ? `<h3>Time per piece</h3><ol class="bars">${timed.map(piece => {
    const phases = phaseMinutes(piece);
    return `<li><span class="name">${esc(name(piece))}</span><span class="value">${Math.round(piece.minutes)} min</span>` +
      bar(piece.minutes / longest, Object.entries(phaseKinds).map(([key, label]) => ({ key, value: phases[key], title: `${label}: ${Math.round(phases[key])} min` }))) + "</li>";
  }).join("")}</ol>${legend(Object.entries(phaseKinds))}` +
    table(["Minutes", ...Object.values(phaseKinds)], timed.map(piece => {
      const phases = phaseMinutes(piece);
      return [name(piece), Math.round(piece.minutes), ...Object.keys(phaseKinds).map(key => Math.round(phases[key]))];
    })) : "";
  return section("where", "Where the build is", caption, `<div class="tiles">${tiles}</div>${timeline}`);
}

function reviewSection(pieces) {
  const capped = piece => {
    const declined = declinedKinds(piece);
    return Object.fromEntries(Object.keys(findingKinds).map(kind => [kind, Math.min(piece.findings?.[kind] ?? 0, declined[kind] ?? 0)]));
  };
  const rows = pieces.map(piece => ({ piece, declined: capped(piece), severity: severity(piece), total: found(piece) })).filter(row => row.total);
  const most = Math.max(...rows.map(row => row.total), 0), all = sum(rows.map(row => row.total));
  const byKind = Object.keys(findingKinds).map(kind => [kind, sum(rows.map(row => row.piece.findings?.[kind] ?? 0))]);
  const top = Math.max(...byKind.map(([, count]) => count)), common = byKind.filter(([, count]) => count === top).map(([kind]) => findingNouns[kind]);
  const serious = sum(rows.map(row => row.severity.serious)), declined = sum(rows.map(row => sum(Object.values(row.declined))));
  const caption = all ? `Over every review round, reviews caught ${plural(all, "problem")} across ${plural(rows.length, "piece")}, ${serious} of them serious; ` +
    `${common.length > 1 ? `${common.slice(0, -1).join(", ")} and ${common.at(-1)} were` : `${common[0]} were`} the most common` +
    `${declined ? `, and the builder declined ${declined} with a reason (lighter)` : ""}.`
    : "Reviews have caught nothing yet.";
  if (!rows.length) return section("reviews", "What reviews caught", caption, "");
  const chart = `<ol class="bars">${rows.map(({ piece, declined, severity, total }) => {
    const parts = Object.entries(findingKinds).flatMap(([key, label]) => {
      const count = piece.findings?.[key] ?? 0, light = declined[key];
      return [{ key, value: count - light, title: `${label}: ${count - light} fixed` }, { key, value: light, light: true, title: `${label}: ${light} declined` }];
    });
    const detail = Object.entries(severity).filter(([, count]) => count).map(([word, count]) => `${count} ${word}`).join(" · ");
    return `<li><span class="name">${esc(name(piece))}</span><span class="value">${total}</span>${bar(total / most, parts)}` +
      `<span class="detail">${esc(detail || "no severity given")} · ${plural(piece.rounds ?? 0, "fix round")}</span></li>`;
  }).join("")}</ol>`;
  return section("reviews", "What reviews caught", caption, chart +
    legend(Object.entries(findingKinds), '<li><span class="key" data-key="fault" data-light></span>Lighter: declined</li>') +
    // Soft hyphens let the two long headers break on a phone.
    table([...Object.values(findingKinds).map(text => text.replace("Unsorted", "Un\u00adsorted")), "De\u00adclined"], rows.map(({ piece, declined }) =>
      [name(piece), ...Object.keys(findingKinds).map(key => piece.findings?.[key] ?? 0), sum(Object.values(declined))])));
}

function correctionSection({ entries, unreadable }, tickets, map) {
  const open = entries.filter(entry => entry.fix === "open").length;
  const left = unreadable ? " (lines of the log that could not be read are left out)" : "";
  const caption = entries.length ? `Lex corrected ${plural(entries.length, "thing")} in this build${open ? `; ${open} still ${open === 1 ? "has" : "have"} no fix` : "; every one has its fix"}${left}.`
    : `Lex has not corrected anything in this build yet${left}.`;
  const counts = Object.keys(feedbackKinds).map(kind => [kind, entries.filter(entry => entry.kind === kind).length]);
  const chart = `<ol class="bars">${counts.map(([kind, count]) => `<li><span class="name">${esc(sentence(feedbackKinds[kind]))}</span>` +
    `<span class="value">${count}</span>${count ? bar(count / entries.length, [{ key: "single", value: count, title: `${count}` }]) : '<div class="track"></div>'}</li>`).join("")}</ol>`;
  const list = entries.length ? `<ul class="entries">${entries.map(entry => `<li><span class="when">${esc(entry.date)} · ${esc(sentence(feedbackKinds[entry.kind] ?? entry.kind))}` +
    `${entry.afterRelease === "yes" ? " · after release" : ""}</span><span class="what">${esc(entry.text)}</span><span class="fix">${esc(fixText(entry.fix, tickets, map))}</span></li>`).join("")}</ul>` : "";
  return section("corrections", "What Lex had to correct", caption, chart + list);
}

function ladderSection(state, current) {
  const ux = current.filter(entry => uxKinds.has(entry.kind)).length;
  const caption = `${state.streak} of ${streakGoal} builds in a row without a UX correction` +
    `${state.builds ? "" : " (no finished build counted yet)"}; this build has ${plural(ux, "UX correction")} so far` +
    `${state.unreadable ? `; ${plural(state.unreadable, "finished build")} with a feedback log that could not be read ${state.unreadable === 1 ? "is" : "are"} not counted` : ""}.`;
  const dots = Array.from({ length: streakGoal }, (_, index) => `<circle cx="${12 + index * 28}" cy="12" r="9"${index < state.streak ? ' class="on"' : ""}/>`).join("");
  const steps = rungs.map((text, index) => `<li${index + 1 === state.rung ? ' aria-current="step"' : ""}><span class="rung">Rung ${index + 1}</span>${esc(text)}</li>`).reverse().join("");
  return section("ladder", "Ladder", caption,
    `<p class="streak"><svg viewBox="0 0 136 24" width="136" height="24" role="img" aria-label="${state.streak} of ${streakGoal}">${dots}</svg>` +
    `<span>Builds in a row without a UX correction: <strong>${state.streak} of ${streakGoal}</strong></span></p>` +
    `<ol class="rungs">${steps}</ol><p class="note">Five builds in a row without a UX correction move up one rung; a build in which Lex finds UX problems after release moves down one, however many he finds.</p>`);
}

function builderSection(pieces) {
  const groups = builderGroups(pieces);
  const caption = groups.length ? `${plural(groups.length, "kind")} of job so far; comparing builders means more once a kind has about ${compareAt} pieces.`
    : "No piece has a builder recorded yet.";
  const money = row => row.usd !== null ? dollars(row) : row.tokens !== null ? `${Math.round(row.tokens / 1000)}k tokens` : "not known";
  const body = groups.map(group => `<article><h3>${esc(group.kind)} <span>${plural(group.pieces, "piece")}</span></h3>` +
    (group.advice ? `<p class="advice"><strong>To bring to Lex:</strong> ${esc(group.advice)}</p>` : "") +
    group.rows.map(row => `<dl><dt>${esc(row.who)}</dt><dd><span>${row.pieces}</span> ${row.pieces === 1 ? "piece" : "pieces"}</dd><dd><span>${row.minutes === null ? "-" : Math.round(row.minutes)}</span> min (median)</dd>` +
      `<dd><span>${row.rounds}</span> fix rounds a piece</dd><dd><span>${row.findings}</span> findings a piece</dd><dd><span>${esc(money(row))}</span> a piece</dd></dl>`).join("") + "</article>").join("");
  return section("builders", "Builders", caption, body);
}

const style = `
:root { color-scheme: light dark; --surface: #fcfcfb; --plane: #f9f9f7; --ink: #0b0b0b; --ink-2: #52514e; --muted: #6e6c66; --line: #e1e0d9; --ring: rgb(11 11 11 / 0.1);
  /* Validated dataviz palette: categorical slots 1-4 for kinds of finding, a one-hue blue ramp for the build's phases. */
  --fault: #2a78d6; --ticket: #eb6834; --race: #1baf7a; --style: #eda100; --unsorted: #898781;
  --build: #86b6ef; --review: #3987e5; --fix: #1c5cab; --land: #0d366b; --single: #2a78d6; --on: #2a78d6; --accent-wash: #cde2fb; }
@media (prefers-color-scheme: dark) { :root { --surface: #1a1a19; --plane: #0d0d0d; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #a3a29a; --line: #2c2c2a; --ring: rgb(255 255 255 / 0.1);
  --fault: #3987e5; --ticket: #d95926; --race: #199e70; --style: #c98500; --build: #86b6ef; --review: #3987e5; --fix: #256abf; --land: #184f95;
  --single: #3987e5; --on: #3987e5; --accent-wash: #184f95; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--plane); color: var(--ink); font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-inline-size: 56rem; margin-inline: auto; padding: clamp(1rem, 4vw, 2.5rem) clamp(0.75rem, 4vw, 2rem); display: grid; gap: 1rem; }
header h1 { margin: 0; font-size: clamp(1.4rem, 1.1rem + 1.5vw, 2rem); line-height: 1.2; text-wrap: balance; }
header p { margin: 0.25rem 0 0; color: var(--ink-2); }
section { background: var(--surface); border-radius: 0.75rem; box-shadow: 0 0 0 1px var(--ring); padding: clamp(1rem, 3vw, 1.5rem); min-inline-size: 0; }
h2 { margin: 0; font-size: 1.25rem; }
h3 { margin: 1rem 0 0.25rem; font-size: 1rem; }
h3 span { color: var(--muted); font-weight: 400; }
.caption { margin: 0.25rem 0 1rem; color: var(--ink-2); max-inline-size: 60ch; text-wrap: pretty; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: 0.5rem; margin-block-end: 1rem; }
.tile { display: grid; padding: 0.75rem; border-radius: 0.5rem; box-shadow: 0 0 0 1px var(--ring); }
.tile .value { font-size: 2rem; font-weight: 600; line-height: 1.1; }
.tile .label { color: var(--ink-2); font-size: 0.875rem; }
.tile[data-state="lex"][data-some] { background: var(--accent-wash); }
.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.75rem; }
.bars li { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 0.75rem; row-gap: 0.25rem; }
.bars .name { overflow-wrap: anywhere; }
.bars .value { font-variant-numeric: tabular-nums; color: var(--ink-2); }
.bars .detail { grid-column: 1 / -1; color: var(--muted); font-size: 0.875rem; }
.track { grid-column: 1 / -1; block-size: 0.875rem; }
.bar { display: flex; gap: 2px; block-size: 100%; }
.bar span { min-inline-size: 2px; flex-basis: 0; }
.bar span:last-child { border-start-end-radius: 4px; border-end-end-radius: 4px; }
[data-key="fault"] { background: var(--fault); } [data-key="ticket"] { background: var(--ticket); } [data-key="race"] { background: var(--race); }
[data-key="style"] { background: var(--style); } [data-key="unsorted"] { background: var(--unsorted); } [data-key="single"] { background: var(--single); }
[data-key="build"] { background: var(--build); } [data-key="review"] { background: var(--review); } [data-key="fix"] { background: var(--fix); } [data-key="land"] { background: var(--land); }
[data-light] { opacity: 0.4; }
.legend { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.25rem 1rem; color: var(--ink-2); font-size: 0.875rem; }
.legend li { display: flex; align-items: center; gap: 0.375rem; }
.key { inline-size: 0.75rem; block-size: 0.75rem; border-radius: 2px; flex: none; }
details { margin-block-start: 0.75rem; color: var(--ink-2); font-size: 0.875rem; }
summary { cursor: pointer; padding-block: 0.5rem; min-block-size: 2.75rem; display: flex; align-items: center; }
summary:focus-visible { outline: 2px solid var(--on); outline-offset: 2px; }
table { inline-size: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; table-layout: fixed; }
th, td { padding: 0.25rem; text-align: end; vertical-align: bottom; }
thead th { font-weight: 600; font-size: 0.8125rem; line-height: 1.3; padding-inline-start: 0.5rem; border-block-end: 1px solid var(--line); }
th[scope="rowgroup"] { text-align: start; font-weight: 400; color: var(--ink); overflow-wrap: anywhere; padding-block-start: 0.5rem; }
tbody tr:last-child td { border-block-end: 1px solid var(--line); }
.entries { list-style: none; margin: 1rem 0 0; padding: 0; display: grid; gap: 0.75rem; }
.entries li { display: grid; gap: 0.125rem; padding-block-start: 0.75rem; border-block-start: 1px solid var(--line); }
.entries .when, .entries .fix { color: var(--ink-2); font-size: 0.875rem; }
.streak { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; margin: 0 0 1rem; }
.streak circle { fill: none; stroke: var(--line); stroke-width: 2; } .streak circle.on { fill: var(--on); stroke: var(--surface); }
.rungs { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.375rem; }
.rungs li { display: grid; padding: 0.5rem 0.75rem; border-radius: 0.5rem; color: var(--muted); box-shadow: 0 0 0 1px var(--line); }
.rungs li[aria-current] { color: var(--ink); background: var(--accent-wash); box-shadow: 0 0 0 2px var(--on); }
.rung { font-size: 0.875rem; font-weight: 600; }
.note { color: var(--muted); font-size: 0.875rem; margin: 0.75rem 0 0; }
article + article { margin-block-start: 0.5rem; }
.advice { margin: 0.25rem 0 0.5rem; padding: 0.5rem 0.75rem; border-radius: 0.5rem; background: var(--accent-wash); }
dl { margin: 0.5rem 0 0; display: flex; flex-wrap: wrap; gap: 0.125rem 1rem; padding-block-start: 0.5rem; border-block-start: 1px solid var(--line); }
dt { flex-basis: 100%; font-weight: 600; overflow-wrap: anywhere; }
dd { margin: 0; color: var(--ink-2); font-size: 0.875rem; }
dd span { color: var(--ink); font-variant-numeric: tabular-nums; font-weight: 600; }
`;

/**
 * The page for one build. data is kit score's merged map data with each piece's builder label as `who`;
 * tickets are the map's tickets (file, slug, title, status) from both ticket folders; builds are finished builds oldest first,
 * each { map, feedback } with its feedback log text.
 */
export function scorePage({ data, tickets = [], builds = [], generated = new Date() }) {
  const dropped = new Set(buildTickets(tickets).filter(ticket => ticket.status === "wontfix").map(ticket => ticket.slug));
  const pieces = data.pieces.filter(piece => !dropped.has(piece.piece));
  const current = feedbackLog(data.feedback, `docs/wayfinder/${data.map}/build/feedback.md`);
  const state = ladder(builds.map(build => ({ map: build.map, ...feedbackLog(build.feedback, `docs/wayfinder/${build.map}/build/feedback.md`) })));
  const when = generated.toISOString().slice(0, 16).replace("T", " ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build ${esc(data.map)}: scoreboard</title>
<style>${style}</style>
</head>
<body>
<main>
<header><h1>Build: ${esc(data.map)}</h1><p>${plural(pieces.length, "piece")} recorded · made ${when} UTC</p></header>
${whereSection(pieces, tickets)}
${reviewSection(pieces)}
${correctionSection(current, tickets, data.map)}
${ladderSection(state, current.entries)}
${builderSection(pieces)}
</main>
</body>
</html>
`;
}
