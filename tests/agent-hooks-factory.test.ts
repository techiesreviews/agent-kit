import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

// The factory's two hooks: brief-guard (PreToolUse on delegate_task and Agent|Task) and stop-guard (Stop).
const hooks = resolve("hooks");
const kit = resolve("kit");
function hook(name: string, payload: unknown, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [join(hooks, "run.sh"), name], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8", env: { ...kitEnv(), ...env },
  });
}

const delegate = (task: string) => ({ hook_event_name: "PreToolUse", tool_name: "mcp__t3-code__delegate_task", tool_input: { task } });
const agent = (prompt: string, type?: string) => ({ hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { prompt, ...(type ? { subagent_type: type } : {}) } });

test("brief-guard refuses a hand-written coding brief and names kit brief", () => {
  for (const payload of [delegate("Build ticket 84 in the kit repo. Run kit pr."), agent("Fix the failing test in tests/x.test.ts"),
    { ...agent("Do it"), tool_name: "Task" }, delegate("Research it.\nkit-brief: none ()"), delegate("Build it.\nkit-brief: none (research)"),
    delegate("Build it; the marker looks like kit-brief: abc docs/x.md build"), delegate("kit-brief: abc docs/x.md ship")]) {
    const output = hook("brief-guard", payload);
    assert.equal(output.status, 2, JSON.stringify(payload));
    assert.match(output.stderr, /scripts\/agents\/kit brief <ticket>/);
    assert.match(output.stderr, /kit-brief: none \(<reason>\)/);
  }
});

test("brief-guard allows a kit brief, a first line kit-brief: none (reason), read-only agent types and other tools", () => {
  for (const payload of [
    delegate("Build it.\n\nkit-brief: 974ed10 docs/tickets/84.md build\n"),
    delegate("kit-brief: none (research only: compare two libraries)\nFind out which is smaller."),
    delegate("\n  kit-brief: none (a question for the lead)\nWhat is the land branch?"),
    agent("Where is kitRoot defined?", "Explore"),
    agent("Plan the change", "Plan"),
    agent("kit-brief: none (review only)\nReview the diff."),
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    "not json",
  ]) {
    const output = hook("brief-guard", payload);
    assert.equal(output.status, 0, `${JSON.stringify(payload)}: ${output.stderr}`);
  }
});

// A git worktree with a kit go job in it, and a private state folder for the refusal counts.
function worktree(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "stop-guard-"));
  const state = join(root, ".state");
  mkdirSync(state);
  spawnSync("git", ["init", "-q", root]);
  const env = { ...kitEnv(), KIT_ROOT: root, KIT_GO_WAIT_MS: "50", KIT_BG_SCOPE: "off", KIT_STOP_STATE_DIR: state, KIT_STOP_SYSTEMCTL: join(root, "no-systemctl") };
  t.after(() => {
    const jobs = join(root, ".scratch/kit-jobs");
    if (existsSync(jobs)) for (const name of readdirSync(jobs).filter(name => !name.startsWith("."))) spawnSync(kit, ["bg", "--stop", name], { env, encoding: "utf8" });
    rmSync(root, { recursive: true, force: true });
  });
  const go = (...args: string[]) => spawnSync(kit, ["go", ...args], { cwd: root, env, encoding: "utf8" });
  const stop = (extra: NodeJS.ProcessEnv = {}, session = "s1") =>
    hook("stop-guard", { hook_event_name: "Stop", session_id: session, cwd: join(root), stop_hook_active: false }, { ...env, ...extra });
  return { root, env, go, stop };
}
const held = (file: string) => [process.execPath, "-e", `const fs = require("fs"); const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(file)})) { clearInterval(t); process.exit(0); } }, 10);`];
const refused = (output: ReturnType<typeof spawnSync>) => {
  assert.equal(output.status, 0, String(output.stderr));
  const answer = JSON.parse(String(output.stdout));
  assert.equal(answer.decision, "block");
  return String(answer.reason);
};
const allowed = (output: ReturnType<typeof spawnSync>) => {
  assert.equal(output.status, 0, String(output.stderr));
  assert.equal(String(output.stdout).trim(), "");
};

test("stop-guard refuses a turn end while a kit go job of this worktree runs, naming the job and the wait command", t => {
  const w = worktree(t);
  allowed(w.stop());
  const release = join(w.root, "release");
  assert.equal(w.go("slice-84", "--", ...held(release)).status, 75);
  const reason = refused(w.stop());
  assert.match(reason, /slice-84/);
  assert.match(reason, /scripts\/agents\/kit go slice-84/);
  assert.match(reason, /refusal 1 of 6/);
  // Another worktree's session is not refused.
  const elsewhere = mkdtempSync(join(tmpdir(), "stop-guard-other-"));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  allowed(hook("stop-guard", { hook_event_name: "Stop", session_id: "s2", cwd: elsewhere }, { ...w.env, KIT_ROOT: "" }));
  writeFileSync(release, "");
  let done = w.go("slice-84");
  for (let i = 0; i < 40 && done.status === 75; i++) done = w.go("slice-84");
  assert.equal(done.status, 0, done.stdout);
  allowed(w.stop());
});

test("stop-guard's ways out: KIT_ALLOW_STOP=1, the sixth refusal, and a job past its time limit", t => {
  const w = worktree(t);
  const release = join(w.root, "release");
  assert.equal(w.go("long", "--", ...held(release)).status, 75);
  allowed(w.stop({ KIT_ALLOW_STOP: "1" }));
  for (let i = 1; i <= 6; i++) assert.match(refused(w.stop()), new RegExp(`refusal ${i} of 6`));
  allowed(w.stop());
  // The count is per session: another session starts again at one.
  assert.match(refused(w.stop({}, "s9")), /refusal 1 of 6/);
  assert.equal(w.go("short", "--max", "1s", "--", ...held(release)).status, 75);
  spawnSync("sleep", ["1.2"]);
  // Past its 1s limit "short" no longer holds the turn; "long" (6h) still does.
  const reason = refused(w.stop({}, "s10"));
  assert.match(reason, /long/);
  assert.doesNotMatch(reason, /short/);
  spawnSync(kit, ["bg", "--stop", "long"], { env: w.env, encoding: "utf8" });
  allowed(w.stop({}, "s10"));
});

test("stop-guard refuses while a kit systemd unit of this worktree runs, naming kit wait pid", t => {
  const w = worktree(t);
  const systemctl = join(w.root, "systemctl");
  writeFileSync(systemctl, `#!/usr/bin/env bash
case $2 in
  list-units) printf 'kit-slice-ke84.service loaded active running kit slice\\nkit-other.service loaded active running other\\n' ;;
  show) if [[ $* == *kit-slice-ke84* ]]; then printf 'MainPID=4242\\nWorkingDirectory=${w.root}\\n'; else printf 'MainPID=7\\nWorkingDirectory=/elsewhere\\n'; fi ;;
esac
`);
  chmodSync(systemctl, 0o755);
  const reason = refused(w.stop({ KIT_STOP_SYSTEMCTL: systemctl }));
  // A unit in a worktree nested inside this one is that worktree's, not this one's.
  const nested = join(w.root, ".claude/worktrees/inner");
  mkdirSync(nested, { recursive: true });
  spawnSync("git", ["init", "-q", nested]);
  writeFileSync(systemctl, readFileSync(systemctl, "utf8").replace(`WorkingDirectory=${w.root}`, `WorkingDirectory=${nested}`));
  allowed(w.stop({ KIT_STOP_SYSTEMCTL: systemctl }, "s-nested"));
  assert.match(reason, /kit-slice-ke84/);
  assert.match(reason, /`scripts\/agents\/kit wait pid 4242 --timeout 9m`, run again while it times out \(exit 124\)/);
  assert.doesNotMatch(reason, /kit-other/);
});

test("stop-guard reads Codex's Stop payload the same way", t => {
  const w = worktree(t);
  const release = join(w.root, "release");
  assert.equal(w.go("codex-job", "--", ...held(release)).status, 75);
  const codex = { hook_event_name: "Stop", session_id: "019a-codex", turn_id: "t1", cwd: w.root, model: "gpt-6.1-sol", stop_hook_active: false, last_assistant_message: "done" };
  assert.match(refused(hook("stop-guard", codex, w.env)), /codex-job/);
  writeFileSync(release, "");
});

test("stop-guard never blocks on bad input or outside a Stop event", () => {
  for (const payload of ["not json", { hook_event_name: "PreToolUse", session_id: "s1", cwd: "/" }, { hook_event_name: "Stop", cwd: "/" }]) {
    const output = hook("stop-guard", payload);
    assert.equal(output.status, 0);
    assert.equal(output.stdout.trim(), "");
  }
});
