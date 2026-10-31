// The skills map (skills.json): which skills a brief or a kit prompt names for which job. Skills are only ever
// named here, never copied: paid skills stay on the machine that has them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const map = JSON.parse(readFileSync(join(import.meta.dirname, "skills.json"), "utf8"));

/** claude, codex or none (models without skills: OpenCode, Grok); undefined when the model is not known. */
export function modelFamily(model) {
  if (!model) return undefined;
  if (/claude|^(opus|sonnet|haiku|fable)/i.test(model)) return "claude";
  if (/^(gpt|codex|o\d)|sol$|luna$/i.test(model)) return "codex";
  return "none";
}

/**
 * The skills a job needs, in map order: a set applies when one of the ticket's files or a word in its title
 * and Files section matches, when the set it needs applied too, and when the stage is one of its stages (build
 * and fix for a set that names none). The project's "skills": { "add", "remove" } changes the list last.
 */
export function pickSkills({ files = [], words = "", stage = "build", settings = {} }) {
  const hit = (patterns = []) => patterns.some(pattern => new RegExp(pattern, "i").test(words)) ;
  const touched = (patterns = []) => files.some(file => patterns.some(pattern => new RegExp(pattern, "i").test(file)));
  const applied = new Set();
  // A set's own test, before the stage filter, so a review stage still knows the slice touches UI.
  for (const set of map.sets) {
    if (set.needs && !applied.has(set.needs)) continue;
    const always = !set.paths?.length && !set.words?.length;
    if (always ? set.needs || set.stages : touched(set.paths) || hit(set.words)) applied.add(set.name);
  }
  const names = [];
  for (const set of map.sets) {
    if (!applied.has(set.name) || !(set.stages ?? ["build", "fix"]).includes(stage)) continue;
    for (const name of set.skills) if (!names.includes(name)) names.push(name);
  }
  // Only lists count (skillSettingsProblems names any other value), whoever calls.
  const list = value => Array.isArray(value) ? value.filter(name => typeof name === "string") : [];
  const add = list(settings.skills?.add), remove = list(settings.skills?.remove);
  for (const name of add) if (!names.includes(name)) names.push(name);
  return names.filter(name => !remove.includes(name)).map(name => ({ name, ...(map.skills[name] ?? { label: name, fallback: `the ${name} skill's advice, if you know it; else go on without it.` }) }));
}

/** Problems with the settings' "skills", one line each. */
export function skillSettingsProblems(settings = {}) {
  const value = settings.skills;
  if (value === undefined) return [];
  const list = item => Array.isArray(item) && item.every(name => typeof name === "string" && /^[a-z0-9][a-z0-9:._-]*$/.test(name));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ['"skills" in scripts/agents/kit.json must be an object, as in "skills": { "add": [...], "remove": [...] }'];
  return ["add", "remove"].filter(key => value[key] !== undefined && !list(value[key])).map(key => `"skills.${key}" in scripts/agents/kit.json must be a list of skill names`);
}

/** One brief line for a skill: an invocation for Claude, a mention for Codex, the kit's own words for the rest. */
export function skillLine(entry, family) {
  if (family === "claude") return `/${entry.name} — ${entry.fallback}`;
  if (family === "codex") return `$${entry.name} (the ${entry.name} skill) — ${entry.fallback}`;
  if (family === "none") return `${entry.label}: ${entry.fallback}`;
  return `/${entry.name} (Codex: $${entry.name}; without skills: ${entry.fallback})`;
}

/** A ticket's front matter fields, its title, and the paths in backticks in its Files section. */
export function readTicket(text) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const field = name => (new RegExp(`^${name}:[ \\t]*(.*?)\\s*$`, "m").exec(front)?.[1] ?? "").replace(/^(["'])(.*)\1$/, "$2").replace(/^(null|~)$/i, "");
  const files = /^## Files[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  return { title: field("title"), assignee: field("assignee"), builder: field("builder"), group: field("group"), filesText: files,
    files: [...files.matchAll(/`([^`\s]+)`/g)].map(match => match[1]) };
}

/** The skill lines for one stage of a ticket's text, named for the model's family (skillLine). */
export function ticketSkillLines(text, stage, settings, model) {
  const info = readTicket(text);
  const family = modelFamily(model);
  return pickSkills({ files: info.files, words: `${info.title}\n${info.filesText}`, stage, settings }).map(entry => `- ${skillLine(entry, family)}`);
}

