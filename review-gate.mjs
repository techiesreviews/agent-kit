// kit pr's review gate: how the open findings of Claude's review and the second look are weighed, which ones a lead's
// --waive lets through, and the verdict the PR says. kit pr runs the looks and does the GitHub side; everything here works
// on what the looks found, so the gate is tested without a PR, a model or a project.
import { lookFamilyWords } from "./pr-tier.mjs";
import { budgetReport, isNit, ledgerRows, modelsLine, prLine, renderLedger, roundLimit, secondLookRows, stoppingFindings, waiverCheck, waiverRefusal } from "./review-loop.mjs";

// Short form of a finding for the console, PR body and PR comment; the ticket keeps the full text.
// The cut counts graphemes, so it never splits an emoji, flag or accented letter.
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const findingsWord = count => `${count} open finding${count === 1 ? "" : "s"}`;
export const shortText = text => {
  const characters = Array.from(graphemes.segment(text), part => part.segment);
  return characters.length > 160 ? `${characters.slice(0, 160).join("").trimEnd()}…` : text;
};

/**
 * The review gate of one landing. `waives` is each --waive reason (`waive` all of them as one text), `risky` whether the
 * change gets the longer fix-round budget, `seen` the findings ("<id>\n<text>") the lead already saw, which grows as the
 * gate lets findings through, and `reviewedHeads` the heads reviewed before this run's first (1 after a rebase at the start).
 *
 * newHead() starts each head over (Claude's review, then the second look); weigh() takes one look's findings and says
 * what to print and whether the landing stops; finalWaiver() checks the waiver once both looks have run; verdict() is the
 * PR's review line and block. `waived` is how many findings the waiver let through at the current head.
 */
export function reviewGate({ waives = [], waive = waives.length ? waives.join("; ") : undefined, risky = false, seen = new Set(), reviewedHeads = 0 }) {
  let waived = 0, waivedFindings = [], rounds = null, summary = null, left = 0, budgetUsed = false, secondSkipped = null, secondModel = null,
    secondRows = [], declined = [], nothing = false;
  return {
    get waived() { return waived; },
    newHead() {
      reviewedHeads++;
      waived = 0; waivedFindings = []; rounds = null; summary = null; left = 0; budgetUsed = false; secondSkipped = null; secondModel = null;
      secondRows = []; declined = []; nothing = false;
    },
    // A diff with no change has nothing to review; the PR says so in place of a verdict.
    nothingToReview() { nothing = true; },
    // No model could take the second look (`text` says why), or the model that took it.
    secondLookSkipped(text) { secondSkipped = text; },
    secondLookModel(model) { secondModel = typeof model === "string" && model ? model : null; },
    /**
     * One look's open findings. `chain` is the look's review records (Claude's ids and what the builder declined; empty for a
     * second look), `rounds()` works out the fix rounds used (asked once per head: both looks share the budget), `saved` says the
     * look was reused from before the run (what the lead saw). Returns the lines to print, the refusal ({ why }) that stops the
     * landing or null, the findings left for follow-ups, and whether the budget is used up.
     */
    weigh({ second, findings, chain, rounds: roundsUsed, saved = false }) {
      const lines = [];
      rounds ??= roundsUsed();
      const limit = roundLimit(risky);
      // Nits alone never block or call for a round; blockers and shoulds do while the budget lasts, then only blockers (nits stop the loop; out of budget is never approval).
      const relaxed = rounds >= limit;
      const blocking = stoppingFindings(findings, rounds, risky);
      const ids = new Map(findings.map((item, index) => [item, second ? `SL-${index + 1}` : chain.at(-1)?.findings[index]?.id]));
      // What is left that is not a nit, across both looks: out of budget it is reported for Lex and the PR is never called approved.
      const open = findings.filter(item => !isNit(item));
      const refuse = (text, why) => { if (text) lines.push(text); return { lines, refusal: { why }, rest: [], relaxed }; };
      if (findings.length) {
        const ordered = [...blocking, ...findings.filter(item => !blocking.includes(item))];
        for (const finding of ordered.slice(0, 15)) lines.push(`${finding.group}: ${shortText(finding.text)}`);
        if (findings.length > 15) lines.push(`… and ${findings.length - 15} more`);
        // Out of budget with findings left is reported for Lex to decide, never taken as approval: every open item, blockers first, and the builder's side.
        if (relaxed && open.length) {
          const report = [...blocking, ...open.filter(item => !blocking.includes(item))].map(item => ({ ...item, id: ids.get(item) }));
          lines.push(budgetReport({ rounds, limit, open: report, declined: [...declined, ...chain.flatMap(record => record.declined)] }));
        }
        if (blocking.length && !waive) return refuse(null, `has ${blocking.length} open findings`);
        // A waiver lets through only the findings it names (or counts), as the lead saw them: a rebase (at the start or later) brings a
        // new head and a fresh review, and a waiver given for the old findings never covers a finding that is new there, by id or by
        // count. A review reused from before the run is what the lead saw.
        // A finding carried into this round ("R1-1 still open") is also named by the id the ledger keeps, back to its first round.
        const earlier = chain.flatMap(record => record.findings);
        const carriedFrom = item => {
          const out = [];
          for (let text = String(item.text ?? ""), found; out.length < 10 && (found = /^(R\d+-\d+) still open/.exec(text)); text = String(earlier.find(entry => entry.id === found[1])?.text ?? "")) out.push(found[1]);
          return out;
        };
        const waivable = blocking.map(item => ({ id: ids.get(item) ?? (second ? `SL-${findings.indexOf(item) + 1}` : `review-${findings.indexOf(item) + 1}`),
          aliases: carriedFrom(item), severity: item.severity ?? "", text: item.text }));
        const novel = reviewedHeads > 1 && !saved ? waivable.filter(item => !seen.has(`${item.id}\n${item.text}`)) : [];
        if (novel.length) return refuse(waiverRefusal({ mode: "new", open: novel }), `has ${findingsWord(novel.length)} that ${novel.length === 1 ? "is" : "are"} new at the new head`);
        if (waivable.length) {
          // The mode is worked out from every waived finding so far, so a second look cannot fall back to counting when the first one was named.
          const soFar = [...waivedFindings, ...waivable], check = waiverCheck(waives, soFar);
          if (check.unnamed.length) return refuse(waiverRefusal({ mode: check.mode, open: check.unnamed }), `has ${findingsWord(check.unnamed.length)} the waiver does not name`);
          // A count already too small is refused before the next look starts.
          if (check.mode === "count" && soFar.length > check.count)
            return refuse(waiverRefusal({ mode: "count", count: check.count, open: soFar }), "has more open findings than the waiver counts");
          waivedFindings.push(...waivable);
          for (const item of waivable) seen.add(`${item.id}\n${item.text}`);
        }
        waived += blocking.length;
      }
      left += open.length;
      if (open.length && relaxed) budgetUsed = true;
      // A second look has no rounds to mark its findings, so its rows only say what the landing did with them; the builder's side stays the first look's.
      if (!second) declined = chain.flatMap(record => record.declined);
      if (second) secondRows = secondLookRows(findings, { ids, waived: blocking });
      // The PR line and the ledger come from the first review's own evidence and are written once both looks have passed.
      else if (chain.length) summary = { rounds: chain.length, model: modelsLine(chain), rows: ledgerRows(chain) };
      return { lines, refusal: null, rest: findings.filter(item => !blocking.includes(item)), relaxed };
    },
    // Once both looks have run, the waiver is checked against every finding it lets through, so a count covers both looks
    // and a reason that names some ids covers them all. Null when it matches; else the refusal to print and why.
    finalWaiver() {
      const all = waivedFindings.length ? waiverCheck(waives, waivedFindings) : null;
      if (!all || !(all.unnamed.length || (all.mode === "count" && all.count !== waivedFindings.length))) return null;
      return { text: waiverRefusal({ mode: all.mode, count: all.count, open: all.unnamed.length ? all.unnamed : waivedFindings }),
        why: `the waiver does not match the ${findingsWord(waivedFindings.length)} it would let through` };
    },
    /**
     * Rule: the PR says how it was reviewed. The line and the block (between review-loop markers) for this head, or null when
     * there is nothing to say. `review` is whether the tier has Claude's review, `tier` the PR's tier, `base` the landing branch.
     */
    verdict({ review, tier, base }) {
      // A tier with no Claude review (docs) still says what the second look did; with nothing to say, no block.
      const skippedTier = !review && !summary && !nothing && Boolean(secondModel || secondSkipped);
      if (!summary && !nothing && !skippedTier) return null;
      const open = `${left} open finding${left === 1 ? "" : "s"}`;
      const verdict = !left ? "approved" : budgetUsed ? `not approved (budget used, ${open} left for Lex${waived ? ", waived by the lead" : ""})`
        : waived ? `not approved (${open} waived by the lead)` : `not approved (${open} left for Lex: no reason was given for it)`;
      // A PR whose diff is empty was never reviewed: it says so in place of a verdict and a ledger.
      // A tier with no Claude review still shows what its second look found: the verdict and the ledger rows.
      const line = summary ? prLine({ ...summary, verdict })
        : skippedTier ? `Review: Claude's review skipped (${tier} tier).${secondRows.length ? ` Verdict: ${verdict}.` : ""}`
        : `Review: nothing to review (the diff against ${base} is empty).`;
      // A second look that no model could take is said in the PR too, so the PR never reads as fully double-checked.
      const skipped = secondSkipped ? `${secondSkipped}\n\n` : "";
      // The model that took the second look, in plain words, so the PR says who looked after Claude.
      const looked = secondModel ? `Second look by ${secondModel} (${lookFamilyWords(secondModel)}).\n\n` : "";
      const block = summary ? `<!-- review-loop -->\n${line}\n\n${skipped}${looked}${renderLedger([...summary.rows, ...secondRows])}\n<!-- /review-loop -->`
        : `<!-- review-loop -->\n${line}${skipped || looked ? `\n\n${(skipped + looked).trimEnd()}` : ""}${skippedTier && secondRows.length ? `\n\n${renderLedger(secondRows)}` : ""}\n<!-- /review-loop -->`;
      return { line, block };
    },
  };
}
