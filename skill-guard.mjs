#!/usr/bin/env node
// Usage: skill-guard.mjs [--base REF | --history] [--paths-only]; paid skills never reach a repo (Lex, 2026-10-29).
// Fails when a tracked path is a SKILL.md or lies under a skills/ folder, and, on a machine that has the local
// skill folders, when a changed line (or with --history any line of any blob in history) holds a line of 60+
// characters from a skill there. It never prints skill text: only the repo path and line, and the skill's name.
// A project's own skill folders, listed by path in `skillGuard.allow` of scripts/agents/kit.json, pass the path
// check; the line check still reads every line in them.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { kitSettingsFile } from "./kit-lib.mjs";

const usage = "Usage: skill-guard.mjs [--base REF | --history] [--paths-only]";
const minimum = 60, window = 32, largest = 1 << 20;
// Files inside a skill that hold lines every project shares, not skill text: generated or installed files
// (lockfiles and installed packages of any package manager, minified bundles) and licence texts (MIT, Apache and
// the like, word for word in many repos). A licence is named so in any case, with at most a licence family,
// version and text extension after it (License.md, LICENSE-MIT, LICENSE.APACHE-2.0.txt); a file merely named
// like one (notice-and-consent.md, license-check.py) is skill text and is read.
const generated = /(^|\/)(node_modules|\.git|\.venv|venv|site-packages|vendor)\/|(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|composer\.lock)$|\.min\.(js|css)$/;
const licence = /(^|\/)(licen[cs]e|copying|notice)([-.](mit|apache|bsd|isc|mpl|gpl|lgpl|agpl|unlicense|ofl|zlib)([-.]?v?\d[\d.]*)?(-\d-clause)?)?(\.(md|txt|rst))?$/i;
const shared = (path) => generated.test(path) || licence.test(path);
// Whole lines every web page shares with some skill's code, never skill text: a page's set-up tags (viewport,
// charset or http-equiv meta; a link to an outside font, stylesheet or icon), in any attribute spelling.
export const boilerplate = [
  /^<meta (?:name="viewport"|charset=|http-equiv=)[^<>]*>$/i,
  /^<link rel="(?:preconnect|dns-prefetch|preload|stylesheet|icon)" href="https?:\/\/[^"<>]*"[^<>]*>$/i,
];

/** A normalised line that is shared web boilerplate, never left in the index. */
export const isBoilerplate = (line) => boilerplate.some(pattern => pattern.test(line));

/** A tracked path that is a skill: a SKILL.md anywhere, or anything under a folder named skills. */
export const skillPath = (path) => /(^|\/)SKILL\.md$/i.test(path) || /(^|\/)skills\//i.test(path);

/**
 * The project's own skill folders from `skillGuard.allow` in its settings, as { allow, problems }. Each entry is one
 * skill folder by its repo path (`.claude/skills/<name>`, or `<name>` in a repo of skills); a whole skills/ folder,
 * the top folder, an absolute path or one with . or .. parts is a problem. An entry only ever lets one skill through:
 * allowedPath refuses a skills/ folder or another SKILL.md below it. No settings file or no list allows nothing.
 */
export function allowedSkills(root) {
  let settings;
  try { settings = JSON.parse(readFileSync(join(root, kitSettingsFile), "utf8")); } catch { return { allow: [], problems: [] }; }
  const list = settings?.skillGuard?.allow;
  if (list === undefined) return { allow: [], problems: [] };
  if (!Array.isArray(list)) return { allow: [], problems: [`${kitSettingsFile}: skillGuard.allow must be a list of skill folder paths`] };
  const allow = [], problems = [];
  for (const entry of list) {
    const folder = typeof entry === "string" ? entry.replace(/\/+$/, "") : "";
    const parts = folder.split("/");
    if (!folder || folder.startsWith("/") || parts.some(part => ["", ".", ".."].includes(part)) || /^skills$/i.test(parts.at(-1))) {
      problems.push(`${kitSettingsFile}: skillGuard.allow entry ${JSON.stringify(entry)} is not one skill folder's repo path`);
    } else if (!allow.includes(folder)) allow.push(folder);
  }
  return { allow, problems };
}

/** A path of one allowed skill folder's own: inside it, but not in a skills/ folder or another skill's folder below it. */
export const allowedPath = (path, allow) => allow.some(folder => {
  if (!path.startsWith(`${folder}/`)) return false;
  const rest = path.slice(folder.length + 1);
  return !/(^|\/)skills\//i.test(rest) && !/\/SKILL\.md$/i.test(rest);
});

/** One spelling for comparing lines: no list, quote or heading marks in front, single spaces, trimmed. */
export function normalLine(line) {
  return line.replace(/\s+/g, " ").trim().replace(/^(?:(?:[-*+>#]+|\d+[.)])\s*)+/, "");
}

/** The local skill folders: KIT_SKILL_DIRS (colon-separated) or the agents' folders under HOME. */
export function skillRoots(env = process.env) {
  if (env.KIT_SKILL_DIRS !== undefined) return env.KIT_SKILL_DIRS.split(":").filter(Boolean);
  const home = env.HOME || homedir();
  return [".claude/skills", ".agents/skills", ".codex/skills", ".claude/plugins", ".codex/plugins"].map(path => join(home, path));
}

function walk(folder, found, seen) {
  let entries;
  try { entries = readdirSync(folder, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    let real, stat;
    try { real = realpathSync(path); stat = statSync(real); } catch { continue; }
    if (stat.isDirectory()) { if (!seen.has(real)) { seen.add(real); walk(real, found, seen); } }
    else if (stat.isFile()) found.push(real);
  }
}

/**
 * Every file of every skill under the roots: a skill is a folder holding a SKILL.md, and its other files
 * (references, scripts, templates) count too; binary files are skipped when read, and so are shared ones
 * (lockfiles, installed packages, minified files, licence texts). Returns
 * { files: [{ path, skill }], roots: number of roots that exist }.
 */
export function skillFiles(roots) {
  const files = new Map();
  let present = 0;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    present++;
    const all = [];
    walk(root, all, new Set([realpathSync(root)]));
    for (const skillFile of all.filter(path => basename(path) === "SKILL.md")) {
      const folder = dirname(skillFile), inside = [];
      walk(folder, inside, new Set([folder]));
      for (const path of inside) if (!shared(relative(folder, path)) && !files.has(path)) files.set(path, basename(folder));
    }
  }
  return { files: [...files].map(([path, skill]) => ({ path, skill })), roots: present };
}

/** An index of the skills' long lines, found by any window of their first characters. */
export function skillIndex(files) {
  const index = new Map();
  let count = 0;
  for (const { path, skill } of files) {
    let text;
    try {
      if (statSync(path).size > largest) continue;
      text = readFileSync(path, "utf8");
    } catch { continue; }
    if (text.includes("\0")) continue;
    for (const raw of text.split(/\r?\n/)) {
      const line = normalLine(raw);
      if (line.length < minimum || isBoilerplate(line)) continue;
      const key = line.slice(0, window), list = index.get(key) || [];
      if (!list.some(item => item.line === line)) { list.push({ line, skill }); count++; }
      index.set(key, list);
    }
  }
  return { index, count };
}

/** The skill a text line holds a long line of, or "". */
export function skillMatch(text, { index }) {
  const line = normalLine(text);
  if (line.length < minimum) return "";
  for (let at = 0; at + minimum <= line.length; at++) {
    const list = index.get(line.slice(at, at + window));
    if (!list) continue;
    for (const item of list) if (line.startsWith(item.line, at)) return item.skill;
  }
  return "";
}

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });

/** Added lines of base...HEAD plus staged, unstaged and untracked changes, as { path, line, text }. */
function changedLines(root, base) {
  const lines = [];
  const read = (diff) => {
    let path = "", number = 0;
    for (const text of diff.split("\n")) {
      if (text.startsWith("+++ ")) { path = text.slice(4).replace(/^b\//, ""); continue; }
      const hunk = /^@@ -\S+ \+(\d+)/.exec(text);
      if (hunk) { number = Number(hunk[1]); continue; }
      if (text.startsWith("+") && path !== "/dev/null") lines.push({ path, line: number++, text: text.slice(1) });
      else if (!text.startsWith("-") && !text.startsWith("\\")) number++;
    }
  };
  read(git(root, ["diff", "--no-color", "--no-ext-diff", "-U0", `${base}...HEAD`]));
  read(git(root, ["diff", "--no-color", "--no-ext-diff", "-U0", "HEAD"]));
  for (const path of git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0").filter(Boolean)) {
    try {
      if (statSync(join(root, path)).size > largest) continue;
      const text = readFileSync(join(root, path), "utf8");
      if (!text.includes("\0")) text.split(/\r?\n/).forEach((line, index) => lines.push({ path, line: index + 1, text: line }));
    } catch { /* A file that went away is no change. */ }
  }
  return lines;
}

/** Every path any commit of any ref has held. */
const historyPaths = (root) => [...new Set(git(root, ["log", "--all", "--name-only", "--format="]).split("\n").filter(Boolean))];

/** Every blob any ref reaches, as { path, line, text } for each line, plus every commit message. */
function* historyLines(root) {
  const names = new Map();
  for (const row of git(root, ["rev-list", "--all", "--objects"]).split("\n")) {
    const [sha, ...name] = row.split(" ");
    if (sha && !names.has(sha)) names.set(sha, name.join(" "));
  }
  const out = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: [...names.keys()].join("\n") + "\n", maxBuffer: 2 ** 32 });
  for (let at = 0; at < out.length;) {
    const end = out.indexOf(10, at), [sha, type, size] = out.subarray(at, end).toString().split(" ");
    const body = out.subarray(end + 1, end + 1 + Number(size));
    at = end + 2 + Number(size);
    if (type === "commit") {
      const message = body.toString("utf8").split("\n\n").slice(1).join("\n\n");
      yield* message.split("\n").map((text, index) => ({ path: `commit ${sha.slice(0, 9)}`, line: index + 1, text }));
    } else if (type === "blob" && body.length <= largest && !body.includes(0)) {
      const path = `${names.get(sha) || "blob"}@${sha.slice(0, 9)}`;
      yield* body.toString("utf8").split(/\r?\n/).map((text, index) => ({ path, line: index + 1, text }));
    }
  }
}

/** Run the guard in root; returns { problems, notes }. */
export function skillGuard(root, { base = "", history = false, pathsOnly = false, env = process.env } = {}) {
  const { allow, problems } = allowedSkills(root), notes = [];
  const paths = history ? historyPaths(root) : git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const path of paths.filter(path => skillPath(path) && !allowedPath(path, allow))) {
    problems.push(`${path}: a skill file or skills/ folder ${history ? "in history" : "is tracked"}`);
  }
  const done = (note) => {
    notes.push(note);
    if (allow.length) notes.push(`allowed own skills: ${allow.join(", ")} (skillGuard.allow; lines still checked)`);
    return { problems, notes };
  };
  if (pathsOnly) return done("line check: skipped (paths only)");
  const { files, roots } = skillFiles(skillRoots(env));
  if (!roots) return done("line check: skipped (no local skill folders)");
  const index = skillIndex(files);
  const lines = history ? historyLines(root) : changedLines(root, base);
  let checked = 0;
  for (const item of lines) {
    checked++;
    const skill = skillMatch(item.text, index);
    if (skill) problems.push(`${item.path}:${item.line}: holds a line from the local skill ${skill}`);
  }
  return done(`line check: ${checked} lines against ${index.count} skill lines from ${files.length} skill files`);
}

function main(argv) {
  const flags = { base: "", history: false, pathsOnly: false };
  for (let at = 0; at < argv.length; at++) {
    const arg = argv[at];
    if (arg === "--base" && argv[at + 1]) flags.base = argv[++at];
    else if (arg === "--history") flags.history = true;
    else if (arg === "--paths-only") flags.pathsOnly = true;
    else if (arg === "--help" || arg === "-h") { console.log(usage); return 0; }
    else { console.error(usage); console.log("RESULT: fail skill-guard usage"); return 2; }
  }
  if (flags.base && flags.history) { console.error(usage); console.log("RESULT: fail skill-guard usage"); return 2; }
  if (!flags.base && !flags.history && !flags.pathsOnly) {
    console.error(`${usage}\nskill-guard: the line check needs --base REF or --history (or --paths-only)`);
    console.log("RESULT: fail skill-guard usage");
    return 2;
  }
  let root;
  try { root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).trim(); }
  catch { console.error("skill-guard: not in a git repo"); console.log("RESULT: fail skill-guard not in a git repo"); return 1; }
  let result;
  try { result = skillGuard(root, flags); }
  catch (error) { console.error(`skill-guard: ${error.message.split("\n")[0]}`); console.log("RESULT: fail skill-guard"); return 2; }
  for (const note of result.notes) console.log(`skill-guard: ${note}`);
  for (const problem of result.problems.slice(0, 50)) console.error(`problem: ${problem}`);
  if (result.problems.length > 50) console.error(`problem: ${result.problems.length - 50} more`);
  console.log(result.problems.length ? `RESULT: fail skill-guard ${result.problems.length} problem(s); paid skills never go in a repo` : "RESULT: ok skill-guard");
  return result.problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
