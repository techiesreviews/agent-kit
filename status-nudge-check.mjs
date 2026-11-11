#!/usr/bin/env node
// Usage: status-nudge-check.mjs <transcript.jsonl>; list the lead's replies after a finished helper that lack the
// two-line status (Done, Running, Next), for the weekly learning review. Reads one Claude transcript, writes nothing.
// Standalone on purpose: plain Node, no imports from this repo, so a project can call it by the kit's absolute path
// (`node "$(scripts/agents/kit --home)/status-nudge-check.mjs" <file>`).
// A finished helper is a user turn whose first line is "Delegated task <id> (<title>) [completed|failed|interrupted]".
// Meta entries and side chains are skipped. Its reply is the last text the assistant wrote before the next real user
// turn (tool results do not end a turn). The reply has the status when its last few non-empty lines carry all three
// labels, "Done:", "Running:" and "Next:" (any case, bold or bulleted; a dash needs a space on each side). A helper
// whose turn ended with no text, or that the person interrupted, has no reply to judge and is not counted.
import { readFileSync } from "node:fs";

const tail = 8;
const finishedLine = /^Delegated task \S+ (?:\((.*)\) )?\[(completed|failed|interrupted)\]/;
const labels = ["done", "running", "next"];
const usage = "Usage: status-nudge-check.mjs <transcript.jsonl>";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

function isToolResult(content) {
  return Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === "tool_result");
}

export function hasStatus(reply) {
  const lines = reply.split("\n").map((line) => line.trim()).filter(Boolean).slice(-tail).join("\n").toLowerCase();
  // A label stands at the start of a line (after a bullet, quote or bold marker) or after "; ", ". " or "| " on a
  // line, and ends in a colon or in a dash with a space on each side: a sentence that only mentions the words, or
  // "next-step", is not a label.
  const start = "(?:^|[;.|]\\s*)[>*_#\\s-]*";
  return labels.every((label) => new RegExp(`${start}${label}(?:\\*\\*|__)?(?:\\s*:|\\s+[\\u2013\\u2014-]\\s)`, "m").test(lines));
}

export function scan(source) {
  const results = [];
  let bad = 0;
  let open = null;
  const close = () => {
    if (open?.reply !== undefined) results.push({ ...open, ok: hasStatus(open.reply) });
    open = null;
  };
  source.split("\n").forEach((raw, index) => {
    if (!raw.trim()) return;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      bad += 1;
      return;
    }
    if (!entry || entry.isSidechain || entry.isMeta || (entry.type !== "user" && entry.type !== "assistant")) return;
    const content = entry.message?.content;
    if (entry.type === "user") {
      if (isToolResult(content)) return;
      const first = textOf(content).trimStart().split("\n")[0];
      // The person stopped the turn, so its reply is cut short and not judged.
      if (first.startsWith("[Request interrupted by user")) {
        open = null;
        return;
      }
      close();
      const match = finishedLine.exec(first);
      if (match) open = { line: index + 1, time: entry.timestamp ?? "", title: match[1] ?? "", state: match[2] };
      return;
    }
    const reply = textOf(content).trim();
    if (open && reply) open.reply = reply;
  });
  close();
  return { results, bad };
}

function snippet(reply) {
  const lines = reply.split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  return last.length > 100 ? `${last.slice(0, 97)}...` : last;
}

function main(args) {
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.log(usage);
    console.log("RESULT: fail status check: give one transcript file");
    return 2;
  }
  let source;
  try {
    source = readFileSync(args[0], "utf8");
  } catch (error) {
    console.log(`RESULT: fail status check: cannot read ${args[0]} (${error.code ?? error.message})`);
    return 2;
  }
  const { results, bad } = scan(source);
  const missing = results.filter((result) => !result.ok);
  for (const result of missing) {
    const label = result.title ? `"${result.title}" ` : "";
    console.log(`line ${result.line}${result.time ? ` ${result.time}` : ""}: helper ${label}[${result.state}]: reply has no two-line status; it ends: ${snippet(result.reply)}`);
  }
  const noun = results.length === 1 ? "reply" : "replies";
  const skipped = bad ? `, ${bad} unreadable line${bad === 1 ? "" : "s"} skipped` : "";
  console.log(`RESULT: ok status check: ${results.length} ${noun} after a finished helper, ${missing.length} without the two-line status${skipped}`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
