#!/usr/bin/env node
// Usage: unit-summary.mjs <log>; summarize Node's default spec reporter.
import { readFileSync } from "node:fs";

export function unitCounts(log) {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  // Node uses spec output on a terminal and TAP when stdout is redirected.
  // Accept both, including indented/CRLF output and colour around individual fields.
  const count = name => {
    const pattern = new RegExp(`^\\s*(?:ℹ\\s+|#\\s+)?${name}\\s+(\\d+)\\s*$`);
    const value = lines.findLast(line => pattern.test(line))?.match(pattern)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const pass = count("pass"), fail = count("fail"), cancelled = count("cancelled") ?? 0;
  if (pass === undefined || fail === undefined) throw new Error("unit report lacks pass/fail counts");
  return { pass, fail, cancelled, total: count("tests") ?? pass + fail + cancelled + (count("skipped") ?? 0) + (count("todo") ?? 0) };
}

export function unitSummary(log) {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const { pass, fail, cancelled } = unitCounts(log);
  const failures = [];
  const start = lines.findLastIndex(line => line === "✖ failing tests:");
  for (let i = start + 1; start >= 0 && i < lines.length; i++) {
    if (!/^✖ /.test(lines[i])) continue;
    failures.push(lines[i].replace(/ \([\d.]+ms\)$/, ""));
    const errors = [];
    while (i + 1 < lines.length && !/^(✖ |test at )/.test(lines[i + 1])) {
      const line = lines[++i];
      if (line.trim() && errors.length < 4) errors.push(line);
    }
    failures.push(...errors);
  }
  return [`pass ${pass}, fail ${fail}${cancelled ? `, cancelled ${cancelled}` : ""}`, ...failures].join("\n");
}

if (import.meta.main) {
  try { console.log(unitSummary(readFileSync(process.argv[2], "utf8"))); } catch (error) {
    console.error(`problem: ${error.message}; see full log`);
    process.exitCode = 1;
  }
}
