// The Stop hook (ticket 79, built with the factory): a turn may not end while a kit go job of this worktree, or a
// kit-* systemd unit working in it, still runs. The message names the job and the command to wait with.
// Ways out: a job past its time limit (kit go --max) no longer counts; the sixth refusal in a row for the same
// jobs lets the turn end; KIT_ALLOW_STOP=1 (the lead's escape hatch) always does. No job, no refusal.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kitJob, kitJobRecord, kitJobRunning } from "../kit-lib.mjs";

const REFUSALS = 6;
const elapsed = ms => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : ""}${seconds >= 60 ? `${Math.floor(seconds / 60) % 60}m` : ""}${seconds % 60}s`;
};

// This worktree's running kit go jobs, leaving out any past its own time limit.
function goJobs(root) {
  const folder = join(root, ".scratch/kit-jobs");
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^[a-z0-9]/.test(entry.name)).flatMap(entry => {
    const directory = join(folder, entry.name);
    if (!existsSync(join(directory, "go"))) return [];
    let job;
    try { job = kitJob(directory); if (!kitJobRunning(job)) return []; } catch { return []; }
    const started = Date.parse(kitJobRecord(directory, "started") ?? ""), max = Number(kitJobRecord(directory, "max") ?? 0);
    const age = Number.isFinite(started) ? Date.now() - started : 0;
    if (max > 0 && age > max * 1000) return [];
    return [{ name: entry.name, text: `${entry.name} (${elapsed(age)})`, wait: `scripts/agents/kit go ${entry.name}`, again: "while it prints RUNNING" }];
  });
}

// The git worktree a folder is in (a worktree nested inside another is its own), else the folder itself.
function topFolder(folder) {
  const top = spawnSync("git", ["-C", folder, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return top.status === 0 ? top.stdout.trim() : folder;
}

// Running kit-* user units whose working directory is this worktree (systemd-run --user --unit=kit-… started them).
function units(root) {
  const systemctl = process.env.KIT_STOP_SYSTEMCTL || "systemctl";
  const ask = args => spawnSync(systemctl, ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
  const listed = ask(["list-units", "--type=service", "--state=running", "--plain", "--no-legend", "kit-*"]);
  if (listed.error || listed.status !== 0) return [];
  return listed.stdout.split("\n").map(row => row.trim().split(/\s+/)[0]).filter(unit => /^kit-.+\.service$/.test(unit)).flatMap(unit => {
    const shown = ask(["show", "-p", "MainPID", "-p", "WorkingDirectory", unit]).stdout ?? "";
    const cwd = /^WorkingDirectory=(\/.*)$/m.exec(shown)?.[1];
    const pid = /^MainPID=(\d+)$/m.exec(shown)?.[1];
    if (!cwd || !pid || pid === "0" || topFolder(cwd) !== root) return [];
    const name = unit.replace(/\.service$/, "");
    return [{ name, text: `the unit ${name}`, wait: `scripts/agents/kit wait pid ${pid} --timeout 9m`, again: "while it times out (exit 124)" }];
  });
}

function main(input) {
  const payload = JSON.parse(input);
  if (payload?.hook_event_name !== "Stop" || !/^[A-Za-z0-9_-]+$/.test(payload.session_id ?? "") || typeof payload.cwd !== "string") return;
  if (process.env.KIT_ALLOW_STOP === "1") return;
  const root = topFolder(payload.cwd);
  const state = process.env.KIT_STOP_STATE_DIR || join(process.env.XDG_RUNTIME_DIR || tmpdir(), "kit-stop-guard");
  const file = join(state, `${payload.session_id}.json`);
  const jobs = [...goJobs(root), ...units(root)];
  if (!jobs.length) { rmSync(file, { force: true }); return; }
  const key = jobs.map(job => job.name).sort().join(" ");
  let count = 0;
  try { const saved = JSON.parse(readFileSync(file, "utf8")); if (saved.key === key) count = saved.count; } catch { /* First refusal. */ }
  if (count >= REFUSALS) { rmSync(file, { force: true }); return; }
  mkdirSync(state, { recursive: true });
  writeFileSync(file, JSON.stringify({ key, count: count + 1 }));
  const reason = `Your kit job ${jobs.map(job => job.text).join(", ")} still runs, so this turn may not end. ` +
    `Wait for it in the foreground: ${jobs.map(job => `\`${job.wait}\`, run again ${job.again}`).join("; then ")}; ` +
    `end your turn only after its RESULT line (refusal ${count + 1} of ${REFUSALS}; the lead's way out is KIT_ALLOW_STOP=1).`;
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => { try { main(input); } catch { /* A hook never blocks on its own error. */ } });
