#!/usr/bin/env node
// Usage: sol-run.mjs <duration> <command...>; wait for one job, kill its process group on expiry.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

export function durationMilliseconds(duration) {
  const match = /^([1-9][0-9]*)([smhd]?)$/.exec(duration ?? "");
  const milliseconds = match ? Number(match[1]) * ({ "": 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]) * 1000 : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 2_147_483_647) {
    throw new Error("agent timeout must be positive and at most 2147483 seconds");
  }
  return milliseconds;
}

export function supervise(duration, command, args, { cwd, input = 0, log, capture = false } = {}) {
  const milliseconds = durationMilliseconds(duration);
  return new Promise(resolve => {
    // detached makes the child's PID its process-group ID on Linux. Unlike some
    // timeout implementations, expiry signals all descendants, whichever CLI runs.
    const child = spawn(command, args, { cwd, detached: true, stdio: log === undefined ? "inherit" : [input, "pipe", "pipe"] });
    let stdout = "";
    if (log !== undefined) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { writeSync(log, chunk); if (capture) stdout += chunk; });
      child.stderr.on("data", chunk => writeSync(log, chunk));
    }
    let result;
    function stop(code) {
      result ??= code;
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") console.error(`problem: cannot kill agent process group: ${error.message}`);
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
      resolve({ status: result ?? code ?? (signal === "SIGINT" ? 130 : 1), stdout });
    });
  });
}

if (import.meta.main) {
  const [duration, command, ...args] = process.argv.slice(2);
  try {
    if (!command) throw new Error("need a command");
    process.exitCode = (await supervise(duration, command, args)).status;
  } catch (error) {
    console.error(`problem: ${error.message}`);
    process.exitCode = 2;
  }
}
