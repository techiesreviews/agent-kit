// Model names: the one rule set for every place the kit names a model (TOOLS-290). The CLI a model runs on decides the
// rest, so the runner, the weekly review budget, the second look and the skills map can never disagree: o3 runs on
// Codex, so it is GPT everywhere, and a bare sol or luna runs nowhere, so it is no family anywhere.

// The CLI a model name runs on, or null for a name no rule knows: such a review is refused rather than
// sent to Codex, so a typo never reaches OpenAI. A prefix alone (gpt-, grok-, opencode/) names no model.
export function inferCli(model) {
  if (/^grok-./i.test(model)) return "grok";
  // Case matters: the model check compares OpenCode's provider/model exactly.
  if (/^opencode\/./.test(model)) return "opencode";
  if (/^(claude-|(?:opus|sonnet|haiku|fable)$)/i.test(claudeModelName(model))) return "claude";
  return /^(gpt-.|o\d|codex)/i.test(model) ? "codex" : null;
}

// A Claude model's name without the [1m] context suffix.
export function claudeModelName(model) {
  return model.replace(/\[1m\]$/i, "");
}

// The weekly count a review on an outside plan falls under, or null when it is never counted: Claude, and
// OpenCode's free models. On OpenCode, openai/… counts as GPT and xai/… as Grok; any other paid model is
// refused by parseAgentArgs before it runs, so a model is never uncounted by accident.
export function reviewFamily(cli, model = "") {
  if (cli === "codex") return "gpt";
  if (cli === "grok") return "grok";
  if (cli !== "opencode") return null;
  if (/^openai\//.test(model)) return "gpt";
  if (/^xai\//.test(model)) return "grok";
  return null;
}

// An OpenCode model runs only when it is free (its name ends in -free) or counted under a family; any other
// paid model would go uncounted, so parseAgentArgs and kit review's second-look check both refuse it.
export function opencodeModelRuns(model) {
  return Boolean(reviewFamily("opencode", model)) || /-free$/.test(model);
}

// A second-look model's family (one model per family in the second-look table): gpt for a Codex model, grok, or
// opencode; null for a Claude model, a name no rule knows, or one with a space in it.
export function lookFamily(model) {
  if (typeof model !== "string" || !/^\S+$/.test(model)) return null;
  return { codex: "gpt", grok: "grok", opencode: "opencode" }[inferCli(model)] ?? null;
}

// The skills family a brief names skills for: claude, codex, or none (a model without skills: Grok, OpenCode, or a
// name no rule knows, which never runs); undefined when no model is named.
export function skillsFamily(model) {
  if (!model) return undefined;
  return { claude: "claude", codex: "codex" }[inferCli(model)] ?? "none";
}
