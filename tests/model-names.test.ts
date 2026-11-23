import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { inferCli, lookFamily as namesLookFamily, opencodeModelRuns, reviewFamily, skillsFamily } from "../model-names.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { lookFamily, lookFamilyWords } from "../pr-tier.mjs";
// @ts-expect-error The agent helper is plain JavaScript without declarations.
import { ticketSkillLines } from "../skills.mjs";

// One rule set names every model (TOOLS-290): the CLI it runs on, its weekly budget family, its second-look family and
// its skills family all come from model-names.mjs, so the four can no longer disagree. The table reads them for a review.
const names = [
  // model, CLI, budget family, second-look family, skills family
  ["gpt-6.1-sol", "codex", "gpt", "gpt", "codex"],
  ["o3", "codex", "gpt", "gpt", "codex"],
  ["codex-mini-latest", "codex", "gpt", "gpt", "codex"],
  ["grok-4.7", "grok", "grok", "grok", "none"],
  ["opencode/deepseek-v4.1-flash-free", "opencode", null, "opencode", "none"],
  ["claude-opus-5-5", "claude", null, null, "claude"],
  ["opus", "claude", null, null, "claude"],
  ["opus[1m]", "claude", null, null, "claude"],
  // As reviews, bare sol and luna run nowhere: the runner refuses them, so no review brief names Codex skills for them.
  ["sol", null, null, null, "none"],
  ["luna", null, null, null, "none"],
];

test("model names: the runner, the budget, the second look and the skills agree on every model", () => {
  for (const [model, cli, budget, look, skills] of names) {
    assert.equal(inferCli(model), cli, `${model} CLI`);
    assert.equal(reviewFamily(inferCli(model), model), budget, `${model} budget family`);
    assert.equal(namesLookFamily(model), look, `${model} second-look family`);
    assert.equal(lookFamily(model), look, `${model} second-look family in pr-tier`);
    assert.equal(skillsFamily(model, "review"), skills, `${model} skills family`);
  }
});

test("model names: a brief names skills for where the model runs; a name no rule knows builds on Codex but reviews nowhere", () => {
  const ticket = "---\ntitle: Restyle the page\n---\n## Files\n- `site/page.css`\n";
  const first = (model: string, stage = "build") => ticketSkillLines(ticket, stage, {}, model)[0];
  assert.match(first("gpt-6.1-sol"), /^- \$good-css \(the good-css skill\) — /);
  assert.match(first("o3"), /^- \$good-css /);
  assert.match(first("claude-opus-5-5"), /^- \/good-css — /);
  // parseAgentArgs sends a build (or fix) model no rule knows to Codex, so its brief names the Codex skills.
  for (const stage of ["build", "fix"]) {
    for (const model of ["luna", "sol", "gpt5"]) assert.equal(skillsFamily(model, stage), "codex", `${model} ${stage}`);
    assert.match(first("luna", stage), /^- \$good-css /);
  }
  // A review by such a name is refused, so its brief keeps the kit's own words.
  for (const stage of ["review", "second-look"]) assert.equal(skillsFamily("luna", stage), "none", stage);
  assert.doesNotMatch(first("luna", "review"), /^- [$/]/);
  assert.match(first("gpt-6.1-sol", "review"), /^- \$/);
});

test("model names: o3 runs on Codex, so the PR names its family GPT through Codex, not unknown", () => {
  assert.equal(lookFamilyWords("o3"), "GPT through Codex");
  assert.equal(lookFamilyWords("sol"), "unknown family");
});

test("model names: a second-look name with a space or nothing after its prefix is no model", () => {
  for (const model of ["gpt-", "gpt-6 x", "grok-", "opencode/", "", undefined, 3]) assert.equal(namesLookFamily(model), null, String(model));
});

test("model names: skills family is undefined for no model, and OpenCode runs only free or counted models", () => {
  assert.equal(skillsFamily(""), undefined);
  assert.equal(skillsFamily(undefined), undefined);
  // With --cli opencode, OpenCode's own openai/… and xai/… models count under GPT and Grok.
  assert.equal(reviewFamily("opencode", "openai/gpt-6.1"), "gpt");
  assert.equal(reviewFamily("opencode", "xai/grok-4.7"), "grok");
  assert.equal(opencodeModelRuns("deepseek-v4.1-flash-free"), true);
  assert.equal(opencodeModelRuns("openai/gpt-6.1"), true);
  assert.equal(opencodeModelRuns("anthropic/claude-opus-5-5"), false);
});
