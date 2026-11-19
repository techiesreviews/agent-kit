import { readFileSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";

// The tasks runnable at this moment (Linux's /proc/loadavg), which a burst of test workers raises well before the
// one-minute load average catches up; 0 where the file cannot be read.
function runnableNow() {
  try { return Math.max(0, Number(readFileSync("/proc/loadavg", "utf8").split(" ")[3]?.split("/")[0]) - 1 || 0); } catch { return 0; }
}

/**
 * The time limit for a speed check (doctor under 2 s, …), stretched by how busy this machine is. A wall clock check
 * measures the machine as much as the code: at a load of 30 on 16 cores, a doctor run that takes under 1 s on a quiet
 * machine took 3 s (TOOLS-359). On a quiet machine the limit is `ms` as it was; with more runnable tasks than cores it
 * grows by the tasks per core (each one, this test's run too, gets a share of a core), and never past four times `ms`,
 * so a real slowdown (a hang, a network wait, a check run in series) still fails.
 */
export function loadLimit(ms: number, { load = Math.max(loadavg()[0], runnableNow()), cores = availableParallelism() } = {}) {
  const limit = Math.round(ms * Math.min(4, Math.max(1, (load + 1) / cores)));
  return { ms: limit, note: `limit ${limit} ms: ${ms} ms stretched for load ${load.toFixed(1)} on ${cores} cores` };
}
