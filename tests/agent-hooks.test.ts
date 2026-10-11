import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const hooks = resolve("scripts/agents/hooks");
function run(script: string, payload: unknown, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [join(hooks, script)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
function bash(command: string) {
  return run("bash-guard.sh", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });
}
function temp(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "agent-hooks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const blocked: [string, string][] = [
  ...[
    "git stash", "git stash push -u", "git stash pop", "git stash apply", "git stash drop", "git stash clear",
    "git stash save 'wip'", "git stash branch feature", "git stash create", "git stash store abc",
    "git -C /tmp stash push", "git --no-pager -c color.ui=false stash pop",
    "git --git-dir=/tmp/repo stash", "git --work-tree /tmp stash",
    "true && git stash", "echo ok; git stash pop", "printf ok | git stash push",
    "bash -c 'git stash pop'", "bash -lc 'true; git stash'", "sh -c \"git stash push\"",
    "sudo /usr/bin/git stash", "env FOO=bar git stash", "'git' 'stash' 'pop'", "git sta\\sh",
    "git commit -m 'safe'; git stash pop", "git commit -F - <<'EOF'\ngit stash message\nEOF\ngit stash pop",
    "eval 'git stash pop'",
    "if git stash pop; then echo done; fi", "if true; then git stash pop; fi", "! git stash", "time git stash",
    "{ git stash pop; }", "while git stash pop; do true; done",
    'git commit -m "$(git stash pop)"', "echo $(git stash pop)",
    ">/dev/null git stash pop", "2>/dev/null git stash pop", "git 2>/dev/null stash pop",
    "3<>/dev/null env FOO=bar git stash pop", "&>/dev/null git stash pop", "2>&1 >/dev/null git stash pop",
    ">/dev/null>/dev/null git stash pop", "bash -c '>/dev/null git stash pop'",
    "if FOO=bar git stash pop; then :; fi", "while FOO=bar git stash pop; do :; done",
    "if true; then FOO=bar env BAR=baz command git stash pop; fi",
    "until FOO=bar timeout 10 env BAR=baz git stash pop; do :; done",
    "bash <<'EOF'\ngit stash pop\nEOF", "sh <<EOF\ngit stash pop\nEOF",
    "git commit -F - <<EOF\n$(git stash pop)\nEOF",
    "cat <<EOF\n'$(git stash pop)'\nEOF", "cat <<EOF\n`git stash pop`\nEOF",
    "echo `git stash pop`", "bash <<< 'git stash pop'",
  ].map((command): [string, string] => [command, "commit work in progress on your own branch"]),
  ...[
    "timeout 5 scripts/agents/port.sh npm test", "gtimeout 30 ./scripts/agents/full-suite.sh 3",
    "timeout -k 5 10 bash scripts/agents/port.sh npm test", "timeout --signal TERM 5 scripts/agents/full-suite.sh",
    "true && timeout 2 ./port.sh npm test", "bash -c 'timeout 10 scripts/agents/port.sh npm test'",
    "timeout 10 bash -c 'scripts/agents/port.sh npx playwright test'",
    "timeout 10 env FOO=bar scripts/agents/full-suite.sh",
    "2>/dev/null timeout 5 scripts/agents/port.sh npm test",
    "timeout 10 bash <<'EOF'\nscripts/agents/port.sh npm test\nEOF",
  ].map((command): [string, string] => [command, "run port.sh directly; use run_in_background for long runs"]),
  ...[
    "pkill node", "pkill -f vite", "killall node", "/usr/bin/pkill -9 -f server",
    "true; killall -9 node", "bash -c 'pkill -f server'", "pgrep -f vite | xargs kill",
    "pgrep --full server | xargs -r kill -9", "pgrep -af server | xargs /bin/kill", "pgrep -f server | kill",
    "pgrep -f server | xargs -I {} kill {}", "pgrep -f server | xargs -r sh -c 'kill \"$@\"' _",
    "2>/dev/null pkill -f vite", ">/dev/null killall node", "<&0 pkill -f vite", "2>>/dev/null pkill -f vite",
    "pgrep -f vite 2>/dev/null | xargs 2>/dev/null kill", ">|/dev/null pkill -f vite",
    "bash <<'EOF'\npkill -f vite\nEOF", "env FOO=bar bash -s <<-\"EOF\"\n\tpkill -f vite\n\tEOF",
    "bash <<\\EOF\npkill -f vite\nEOF", "bash <<'EOF' | cat\npkill -f vite\nEOF",
  ].map((command): [string, string] => [command, "kill your own PID or process group: kill -- -PGID"]),
  ...[
    "setsid npm run server", "setsid vite", "setsid python -m http.server", "setsid npx playwright test",
    "true && setsid -f node tests/native-save/server.ts", "bash -c 'setsid npm run server'",
    "2>/dev/null setsid vite",
  ].map((command): [string, string] => [command, "start servers through scripts/agents/port.sh"]),
];
for (const [command, reason] of blocked) {
  test(`Bash blocks ${command}`, () => {
    const result = bash(command);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stderr, `${reason}\n`);
    assert.equal(result.stdout, "");
  });
}

for (const command of [
  "git stash list", "git stash show -p stash@{0}", "git -C /tmp stash list", "git --no-pager stash show",
  'git commit -m "mention git stash and pkill -f vite"', "git commit --message='git stash; killall node'",
  "git commit -m'git stash'", "git commit -am 'git stash'", "git commit -m 'one' -m 'git stash pop'",
  "bash -c 'git commit -m \"git stash pop\"'", "echo 'git stash; pkill -f server'", "echo timeout 5 port.sh",
  "git commit -F - <<'EOF'\ngit stash\ntimeout 5 port.sh\nkillall node\nEOF\n",
  "git commit -m \"$(cat <<'EOF'\ngit stash pop\nEOF\n)\"",
  "cat <<-EOF\n\tpkill server\n\tEOF\ngit stash list",
  "# git stash pop\ngit stash list", "kill 1234", "kill -- -1234", "timeout 5 npm test",
  "port.sh npx playwright test", "scripts/agents/port.sh npx playwright test", "setsid sleep 10",
  "pgrep -f vite", "pgrep vite | xargs kill", "pgrep -f vite; kill 1234", "my-pkill node", "git-stash pop",
  "timeout-helper port.sh", "timeout 5 ./port.sh.backup", "echo server; echo setsid",
  "git commit -m '$(git stash pop)'",
  "timeout 5 echo port.sh", "timeout 5 git commit -m port.sh", "timeout 5 bash -c 'echo port.sh'",
  "pgrep -f vite || kill 1234", "pgrep -f vite | xargs echo kill",
  "2>/dev/null git stash list", "git stash 2>/dev/null show", ">/dev/null kill 1234",
  "echo 2>/dev/null 'git stash pop'", "cat <pkill", "cat <<< 'git stash pop'",
  "if FOO=bar git stash list; then :; fi", "if true; then FOO=bar git stash show; fi",
  "git commit -m 'fix vite'; setsid sleep 10", "setsid sleep 10; git commit -m 'fix server'",
  "git commit -m 'fix http.server'; setsid sleep 10", "echo playwright; setsid sleep 10",
  "# vite\nsetsid sleep 10", "setsid sleep 10 # server", "setsid sleep 10 >vite.log",
  "git commit -F - <<'EOF'\nsetsid vite\nEOF\nsetsid sleep 10",
  "git commit -F - <<EOF\ngit stash pop\nEOF", "git commit -F - <<\\EOF\n$(git stash pop)\nEOF",
  "cat <<'EOF'\n$(git stash pop)\nEOF", "cat <<EOF\n\\$(git stash pop)\nEOF",
  "cat <<EOF\n\\`git stash pop\\`\nEOF", "cat <<E\"OF\"\n$(git stash pop)\nEOF",
  "bash <<'EOF'\ngit commit -m 'pkill -f vite'\nEOF",
  "bash -c 'cat' <<'EOF'\npkill -f vite\nEOF", "bash script.sh <<'EOF'\npkill -f vite\nEOF",
  "cat <<ONE <<'TWO'\npkill -f vite\nONE\n$(git stash pop)\nTWO\nsetsid sleep 10",
]) {
  test(`Bash allows ${command}`, () => {
    const result = bash(command);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
}

test("hooks fail open for malformed payloads, wrong events and missing dependencies", () => {
  for (const script of ["bash-guard.sh", "agent-cap.sh", "session-env.sh"]) {
    for (const payload of ["{broken", "null", "{}", { hook_event_name: "Unknown" }]) {
      assert.equal(run(script, payload).status, 0, script);
    }
    assert.equal(run(script, {}, { PATH: "/missing", CLAUDE_ENV_FILE: "/missing/env" }).status, 0, script);
  }
  assert.equal(run("bash-guard.sh", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { command: "git stash" } }).status, 0);
});

test("agent cap counts both tool names, isolates sessions, expires and removes entries", (t) => {
  const dir = temp(t);
  const env = { CLAUDE_AGENT_CAP_STATE_DIR: dir, CLAUDE_AGENT_CAP: "5" };
  const event = (hook_event_name: string, agent_id?: string, tool_name?: string, session_id = "session-1") =>
    run("agent-cap.sh", { hook_event_name, session_id, agent_id, tool_name, tool_input: { run_in_background: true } }, env);
  assert.equal(event("PreToolUse", undefined, "Agent").status, 0);
  for (let i = 0; i < 5; i++) assert.equal(event("SubagentStart", `agent-${i}`).status, 0);
  assert.equal(event("SubagentStart", "agent-0").status, 0); // Duplicate starts count once.
  for (const tool of ["Agent", "Task"]) {
    const result = event("PreToolUse", undefined, tool);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "5 subagents running or pending (cap 5): wait for one to finish\n");
  }
  assert.equal(event("PreToolUse", undefined, "Bash").status, 0);
  assert.equal(event("PreToolUse", undefined, "Agent", "session-2").status, 0);
  const expired = new Date(Date.now() - 6 * 60 * 60 * 1000 - 2000);
  utimesSync(join(dir, "session-1", "agent-0"), expired, expired);
  assert.equal(event("PreToolUse", undefined, "Agent").status, 0);
  assert.equal(event("SubagentStart", "agent-0").status, 0);
  assert.equal(event("PreToolUse", undefined, "Agent").status, 2);
  assert.equal(event("SubagentStop", "agent-0").status, 0);
  assert.equal(existsSync(join(dir, "session-1", "agent-0")), false);
  assert.equal(event("SubagentStop", "agent-0").status, 0);
  assert.equal(event("PreToolUse", undefined, "Agent").status, 0);
  assert.equal(event("SubagentStart", "agent-new").status, 0);
  mkdirSync(join(dir, "session-1", "not-an-agent"));
  assert.equal(event("PreToolUse", undefined, "Agent").status, 2);
});

test("agent cap supports overrides and fails open for bad state or cap", (t) => {
  const dir = temp(t);
  const payload = { hook_event_name: "PreToolUse", session_id: "session", tool_name: "Task" };
  const env = { CLAUDE_AGENT_CAP_STATE_DIR: dir, CLAUDE_AGENT_CAP: "1" };
  run("agent-cap.sh", { hook_event_name: "SubagentStart", session_id: "session", agent_id: "agent" }, env);
  assert.equal(run("agent-cap.sh", payload, env).status, 2);
  assert.equal(run("agent-cap.sh", payload, { ...env, CLAUDE_AGENT_CAP: "2" }).status, 0);
  for (const cap of ["0", "-1", "bad", "99999999999999999999"]) {
    assert.equal(run("agent-cap.sh", payload, { ...env, CLAUDE_AGENT_CAP: cap }).status, 0);
  }
  const file = join(dir, "file");
  writeFileSync(file, "");
  assert.equal(run("agent-cap.sh", { hook_event_name: "SubagentStart", session_id: "session", agent_id: "agent" }, { ...env, CLAUDE_AGENT_CAP_STATE_DIR: file }).status, 0);
  for (const [session_id, agent_id] of [["../escape", "agent"], ["session", "../escape"]]) {
    assert.equal(run("agent-cap.sh", { hook_event_name: "SubagentStart", session_id, agent_id }, env).status, 0);
    assert.equal(existsSync(join(dir, "escape")), false);
  }
});

test("agent cap reserves five rapid launches before any start event", (t) => {
  const dir = temp(t);
  const env = { CLAUDE_AGENT_CAP_STATE_DIR: dir, CLAUDE_AGENT_CAP: "5" };
  const results = Array.from({ length: 6 }, (_, i) => run("agent-cap.sh", {
    hook_event_name: "PreToolUse", session_id: "session", tool_name: i % 2 ? "Task" : "Agent",
  }, env));
  assert.deepEqual(results.map((result) => result.status), [0, 0, 0, 0, 0, 2]);
  assert.equal(results[5].stderr, "5 subagents running or pending (cap 5): wait for one to finish\n");
  assert.equal(readdirSync(join(dir, "session/.pending")).length, 5);
});

test("agent cap atomically reserves concurrent launches and counts live plus pending", async (t) => {
  const dir = temp(t);
  const env = { ...process.env, CLAUDE_AGENT_CAP_STATE_DIR: dir, CLAUDE_AGENT_CAP: "5" };
  for (let i = 0; i < 4; i++) {
    assert.equal(run("agent-cap.sh", { hook_event_name: "SubagentStart", session_id: "session", agent_id: `agent-${i}` }, env).status, 0);
  }
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise<{ status: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn("/bin/bash", [join(hooks, "agent-cap.sh")], { env });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "session", tool_name: "Agent", tool_use_id: `launch-${i}` }));
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 2, 2, 2, 2, 2]);
  for (const result of results) {
    assert.equal(result.stderr, result.status === 2 ? "5 subagents running or pending (cap 5): wait for one to finish\n" : "");
  }
  assert.equal(readdirSync(join(dir, "session/.pending")).length, 1);
});

test("agent starts consume the oldest reservation, duplicate starts preserve slots, and failures release only their own launch", (t) => {
  const dir = temp(t);
  const env = { CLAUDE_AGENT_CAP_STATE_DIR: dir, CLAUDE_AGENT_CAP: "3" };
  const pending = join(dir, "session/.pending");
  const event = (hook_event_name: string, tool_use_id?: string, agent_id?: string) =>
    run("agent-cap.sh", { hook_event_name, session_id: "session", tool_name: "Agent", tool_use_id, agent_id }, env);
  const reserved = () => readdirSync(pending).sort().map((file) => readFileSync(join(pending, file), "utf8").trim());
  for (const id of ["first", "second", "third"]) assert.equal(event("PreToolUse", id).status, 0);
  assert.deepEqual(reserved(), ["first", "second", "third"]);
  assert.equal(event("PreToolUse", "third").status, 0); // Repeated hook delivery.
  assert.equal(event("PreToolUse", "blocked").status, 2);
  assert.equal(event("PostToolUseFailure", "blocked").status, 0);
  assert.deepEqual(reserved(), ["first", "second", "third"]);
  assert.equal(event("SubagentStart", undefined, "agent").status, 0);
  assert.deepEqual(reserved(), ["second", "third"]);
  assert.equal(event("SubagentStart", undefined, "agent").status, 0);
  assert.deepEqual(reserved(), ["second", "third"]);
  assert.equal(event("PreToolUse", "fourth").status, 2); // One live, two pending.
  assert.equal(event("PostToolUseFailure", "first").status, 0); // Already consumed.
  assert.deepEqual(reserved(), ["second", "third"]);
  assert.equal(event("PostToolUseFailure", "second").status, 0);
  assert.deepEqual(reserved(), ["third"]);
  assert.equal(event("PreToolUse", "fourth").status, 0);
  assert.equal(event("PostToolUseFailure", "second").status, 0); // Duplicate failure.
  assert.deepEqual(reserved(), ["third", "fourth"]);
});

test("agent pending reservations expire after three minutes without a start or failure", (t) => {
  const dir = temp(t);
  const env = { CLAUDE_AGENT_CAP_STATE_DIR: dir, CLAUDE_AGENT_CAP: "1" };
  const payload = { hook_event_name: "PreToolUse", session_id: "session", tool_name: "Task" };
  assert.equal(run("agent-cap.sh", payload, env).status, 0);
  const pending = join(dir, "session/.pending");
  const entry = join(pending, readdirSync(pending)[0]);
  const recent = new Date(Date.now() - 170 * 1000);
  utimesSync(entry, recent, recent);
  assert.equal(run("agent-cap.sh", payload, env).status, 2);
  const expired = new Date(Date.now() - 181 * 1000);
  utimesSync(entry, expired, expired);
  assert.equal(run("agent-cap.sh", payload, env).status, 0);
  assert.equal(existsSync(entry), false);
  assert.equal(readdirSync(pending).length, 1);
});

test("agent cap defaults to five and uses the runtime directory", (t) => {
  const dir = temp(t);
  const env = { XDG_RUNTIME_DIR: dir, CLAUDE_AGENT_CAP_STATE_DIR: "", CLAUDE_AGENT_CAP: "" };
  for (let i = 0; i < 5; i++) {
    assert.equal(run("agent-cap.sh", { hook_event_name: "SubagentStart", session_id: "session", agent_id: `agent-${i}` }, env).status, 0);
  }
  assert.equal(existsSync(join(dir, "claude-agent-cap/session/agent-0")), true);
  const result = run("agent-cap.sh", { hook_event_name: "PreToolUse", session_id: "session", tool_name: "Agent" }, env);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "5 subagents running or pending (cap 5): wait for one to finish\n");
});

function fakeNode(path: string, version: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  chmodSync(path, 0o755);
}
function nodeEnv(dir: string) {
  const current = join(dir, "current", "node");
  fakeNode(current, "v22.15.0");
  return {
    PATH: `${dirname(current)}:${process.env.PATH ?? ""}`,
    CLAUDE_NODE_SEARCH_ROOT: dir,
    CLAUDE_ENV_FILE: join(dir, "session.env"),
  };
}

test("session env picks the highest Node >=24 from npm and nvm and preserves PATH", (t) => {
  const dir = temp(t);
  const env = nodeEnv(dir);
  const npm = join(dir, ".npm/_npx/install/node_modules/node/bin/node");
  const nvm = join(dir, ".nvm/versions/node/v25.2.10/bin/node");
  fakeNode(npm, "v24.99.0");
  fakeNode(nvm, "v25.2.10");
  fakeNode(join(dir, ".nvm/versions/node/v25.2.9/bin/node"), "v25.2.9");
  fakeNode(join(dir, ".nvm/versions/node/v25.1.100/bin/node"), "v25.1.100");
  fakeNode(join(dir, ".nvm/versions/node/broken/bin/node"), "bad");
  const result = run("session-env.sh", { hook_event_name: "SessionStart" }, env);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(readFileSync(env.CLAUDE_ENV_FILE, "utf8"), `export PATH="${dirname(nvm)}:$PATH"\n`);
  const sourced = spawnSync("/bin/bash", ["-c", 'source "$CLAUDE_ENV_FILE"; printf "%s" "$PATH"'], { env, encoding: "utf8" });
  assert.equal(sourced.stdout, `${dirname(nvm)}:${env.PATH}`);
});

test("session env handles npm alone, escaped paths and silent no-op cases", (t) => {
  const dir = join(temp(t), 'space $dollar `tick` "quote"');
  const env = nodeEnv(dir);
  const node = join(dir, ".npm/_npx/one/node_modules/node/bin/node");
  fakeNode(node, "v24.0.1");
  const payload = { hook_event_name: "SessionStart" };
  assert.equal(run("session-env.sh", payload, env).status, 0);
  const sourced = spawnSync("/bin/bash", ["-c", 'source "$CLAUDE_ENV_FILE"; printf "%s" "$PATH"'], { env, encoding: "utf8" });
  assert.equal(sourced.stdout, `${dirname(node)}:${env.PATH}`);
  rmSync(env.CLAUDE_ENV_FILE);
  fakeNode(join(dir, "current/node"), "v24.0.0");
  assert.equal(run("session-env.sh", payload, env).status, 0);
  assert.equal(existsSync(env.CLAUDE_ENV_FILE), false);
  fakeNode(join(dir, "current/node"), "v22.0.0");
  fakeNode(node, "v23.9.9");
  assert.equal(run("session-env.sh", payload, env).status, 0);
  assert.equal(existsSync(env.CLAUDE_ENV_FILE), false);
  fakeNode(node, "v24.0.0");
  for (const overrides of [{ CLAUDE_ENV_FILE: "" }, { CLAUDE_ENV_FILE: "/missing/directory/env" }]) {
    const result = run("session-env.sh", payload, { ...env, ...overrides });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
  }
});

test("committed Claude settings wire all events to executable hooks", () => {
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
    hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
  };
  assert.deepEqual(Object.keys(settings.hooks).sort(), ["PostToolUseFailure", "PreToolUse", "SessionStart", "SubagentStart", "SubagentStop"]);
  assert.deepEqual(settings.hooks.PreToolUse.map((entry) => entry.matcher), ["Bash", "Agent|Task"]);
  assert.deepEqual(settings.hooks.PostToolUseFailure.map((entry) => entry.matcher), ["Agent|Task"]);
  for (const entries of Object.values(settings.hooks)) for (const entry of entries) for (const hook of entry.hooks) {
    assert.equal(hook.type, "command");
    assert.match(hook.command, /^"\$CLAUDE_PROJECT_DIR"\/scripts\/agents\/hooks\/(bash-guard|agent-cap|session-env)\.sh$/);
    const script = hook.command.split("/").at(-1)!;
    assert.equal(spawnSync("/usr/bin/test", ["-x", join(hooks, script)]).status, 0);
  }
  assert.equal(spawnSync("git", ["check-ignore", ".claude/settings.json"]).status, 1);
  for (const path of [".claude/settings.local.json", ".claude/worktrees/example"]) {
    assert.equal(spawnSync("git", ["check-ignore", path]).status, 0);
  }
});
