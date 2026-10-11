#!/usr/bin/env node
// Usage: sol-run.mjs <duration> <command...>; wait for one job, kill its process group on expiry.
import { spawn } from "node:child_process";

const [duration, command, ...args] = process.argv.slice(2);
const match = /^([1-9][0-9]*)([smhd]?)$/.exec(duration ?? "");
const milliseconds = match ? Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]) * 1000 : NaN;
if (!command || !Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
  console.error("problem: SOL_TIMEOUT must be positive and at most 2147483 seconds");
  process.exit(2);
}
// detached makes the child's PID its process-group ID on Linux. Unlike some
// timeout implementations, expiry signals all descendants, not only codex.
const child = spawn(command, args, { detached: true, stdio: "inherit" });
let result;
function stop(code) {
  result ??= code;
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
    if (error.code !== "ESRCH") console.error(`problem: cannot kill Sol process group: ${error.message}`);
  }
}
const timer = setTimeout(() => stop(124), milliseconds);
const interrupt = () => stop(130);
const terminate = () => stop(143);
process.once("SIGINT", interrupt);
process.once("SIGTERM", terminate);
child.once("error", error => {
  console.error(`problem: ${error.message}`);
  result = 1;
});
child.once("close", (code, signal) => {
  clearTimeout(timer);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
  process.exitCode = result ?? code ?? (signal === "SIGINT" ? 130 : 1);
});
