import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fakeCfId, fakeCfSecret, fakeOrbit, fakeToken, fakeWorkspace } from "./fake-orbit.ts";

// A project on Orbit for the kit commands' tests: the fake Orbit with its KIT board (Backlog, Todo, In Progress, Done),
// a saved setup in a temporary HOME, and the environment a lead's kit command runs with. Never the real Orbit.
export const orbitSecretsForTests = [fakeToken, fakeCfId, fakeCfSecret];
export const orbitSettings = { tickets: "orbit", orbit: { project: "KIT" } };

export async function orbitProject(t: TestContext) {
  const orbit = await fakeOrbit(t, { kitBoard: true });
  const home = mkdtempSync(join(tmpdir(), "kit-orbit-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(join(home, ".config/fleet"), { recursive: true, mode: 0o700 });
  const configPath = join(home, ".config/fleet/orbit.json");
  writeFileSync(configPath, JSON.stringify({ origin: orbit.origin, workspace_id: fakeWorkspace, token: fakeToken, cf_access_client_id: fakeCfId, cf_access_client_secret: fakeCfSecret }), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  const logPath = join(home, "orbit-state/fleet/orbit.log");
  // XDG_CONFIG_HOME is unset so the setup is read from this HOME; the write log goes to its own state folder.
  const env: NodeJS.ProcessEnv = { HOME: home, XDG_STATE_HOME: join(home, "orbit-state"), XDG_CONFIG_HOME: "", ORBIT_ROLE: "lead" };
  const log = () => existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  /** A card on the KIT board in the named status, with a description that has the sections a slice needs. */
  const card = (fields: Record<string, any> = {}, status = "Todo") => orbit.addTask(orbit.kit, {
    status_id: orbit.statusId(orbit.kit, status),
    description: "## Goal\n\nDo it.\n\n## Files\n\n- `file.txt`\n\n## Done when\n\n- done\n", ...fields,
  });
  return { orbit, home, env, configPath, log, card };
}

export type Run = { status: number | null; stdout: string; stderr: string; all: string };

/** Runs a command without blocking this process, so the fake Orbit it talks to keeps answering. */
export function runAsync(command: string, args: string[], { cwd, env, timeout = 30_000 }: { cwd?: string; env: NodeJS.ProcessEnv; timeout?: number }): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], timeout });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.once("error", fail);
    child.once("close", status => done({ status, stdout, stderr, all: stdout + stderr }));
  });
}
