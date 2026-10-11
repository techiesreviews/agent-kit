#!/usr/bin/env node
// Usage: unit-summary.mjs <log>; summarize Node's default spec reporter.
import { readFileSync } from "node:fs";

export function unitSummary(log) {
  const lines = log.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  const count = name => lines.findLast(line => new RegExp(`^ℹ ${name} \\d+$`).test(line))?.split(" ").at(-1);
  const pass = count("pass");
  const fail = count("fail");
  const cancelled = count("cancelled");
  if (pass === undefined || fail === undefined) throw new Error("unit report lacks pass/fail counts");
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
  return [`pass ${pass}, fail ${fail}${cancelled && cancelled !== "0" ? `, cancelled ${cancelled}` : ""}`, ...failures].join("\n");
}

if (import.meta.main) {
  try { console.log(unitSummary(readFileSync(process.argv[2], "utf8"))); } catch (error) {
    console.error(`problem: ${error.message}; see full log`);
    process.exitCode = 1;
  }
}
