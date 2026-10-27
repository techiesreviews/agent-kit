import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { options, parseWorktrees, pathInside, pruneDecision, pruneWorktree } from "../scripts/agents/worktrees.mjs";

const eligible = { protected: false, locked: false, dirty: false, merged: true, commitAge: 4, createdAge: 4, live: false };

test("pruning requires every safety condition, with unknown state kept", () => {
  assert.equal(pruneDecision(eligible), "eligible");
  for (const unsafe of [
    { protected: true }, { locked: true }, { dirty: true }, { dirty: undefined },
    { merged: false }, { merged: null }, { live: true }, { live: null },
    { commitAge: 3 }, { commitAge: 0 }, { commitAge: NaN }, { createdAge: 0 },
    { createdAge: undefined },
  ]) assert.notEqual(pruneDecision({ ...eligible, ...unsafe }), "eligible", JSON.stringify(unsafe));
  assert.equal(pruneDecision(eligible, 4), "too recent");
  assert.equal(pruneDecision({ ...eligible, commitAge: 3.01, createdAge: 3.01 }), "eligible");
});

test("NUL worktree records preserve spaces and newlines, detached and locked worktrees", () => {
  assert.deepEqual(parseWorktrees("worktree /repo root\0HEAD abc\0branch refs/heads/dev\0\0worktree /agent\nspace\0HEAD def\0detached\0locked reason\0\0"), [
    { path: "/repo root", head: "abc", branch: "dev", locked: false },
    { path: "/agent\nspace", head: "def", branch: "(detached)", locked: true },
  ]);
});

test("cwd containment respects path boundaries", () => {
  assert.ok(pathInside("/repo/worktree", "/repo/worktree"));
  assert.ok(pathInside("/repo/worktree/sub", "/repo/worktree"));
  assert.equal(pathInside("/repo/worktree-other", "/repo/worktree"), false);
});

test("worktree arguments default to listing and reject bad usage", () => {
  assert.deepEqual(options([]), { prune: false, olderThan: 3 });
  assert.deepEqual(options(["--older-than", "5", "--prune"]), { prune: true, olderThan: 5 });
  for (const args of [["--unknown"], ["--older-than"], ["--older-than", "-1"], ["--older-than", "NaN"]]) assert.throws(() => options(args), /Usage:/);
});

test("pruning catches a process entering during inspection or the final dirty check", async () => {
  for (const entersDuring of ["inspect", "status"]) {
    const info = { ...eligible, path: "/agent", head: "abc" };
    let paths: string[] = [];
    let removed = false;
    const reason = await pruneWorktree(info, 3, {
      inspect: async () => {
        await Promise.resolve();
        if (entersDuring === "inspect") paths = ["/agent/subdirectory"];
        return { ...info };
      },
      status: async () => {
        await Promise.resolve();
        if (entersDuring === "status") paths = ["/agent/subdirectory"];
        return "";
      },
      scan: () => ({ paths, complete: true }),
      remove: async () => { removed = true; },
    });
    assert.equal(reason, "live process", entersDuring);
    assert.equal(removed, false);
  }
});

test("pruning rechecks dirty status after inspection and keeps incomplete process scans", async () => {
  const info = { ...eligible, path: "/agent", head: "abc" };
  for (const [status, complete, expected] of [["?? new-file\n", true, "dirty"], ["", false, "process scan incomplete"]] as const) {
    let removed = false;
    const reason = await pruneWorktree(info, 3, {
      inspect: async () => ({ ...info }),
      status: async () => status,
      scan: () => ({ paths: [], complete }),
      remove: async () => { removed = true; },
    });
    assert.equal(reason, expected);
    assert.equal(removed, false);
  }
});

test("each removal follows its own final dirty check and synchronous cwd scan", async () => {
  const calls: string[] = [];
  for (const path of ["/agent-one", "/agent-two"]) {
    const info = { ...eligible, path, head: "abc" };
    assert.equal(await pruneWorktree(info, 3, {
      inspect: async () => { calls.push(`${path}:inspect`); return { ...info }; },
      status: async () => { calls.push(`${path}:status`); return ""; },
      scan: () => { calls.push(`${path}:scan`); return { paths: [`${path}-other`], complete: true }; },
      remove: async () => { calls.push(`${path}:remove`); },
    }), "removed");
  }
  assert.deepEqual(calls, ["/agent-one:inspect", "/agent-one:status", "/agent-one:scan", "/agent-one:remove", "/agent-two:inspect", "/agent-two:status", "/agent-two:scan", "/agent-two:remove"]);
});

test("pruning preserves a changed HEAD and never removes after a failed dirty check", async () => {
  const info = { ...eligible, path: "/agent", head: "abc" };
  let removed = false;
  const ports = {
    inspect: async () => ({ ...info, head: "def" }),
    status: async () => "",
    scan: () => ({ paths: [], complete: true }),
    remove: async () => { removed = true; },
  };
  assert.equal(await pruneWorktree(info, 3, ports), "HEAD changed");
  await assert.rejects(pruneWorktree(info, 3, {
    ...ports,
    status: async () => { throw new Error("status unavailable"); },
  }), /status unavailable/);
  assert.equal(removed, false);
});

test("worktrees.sh protects the devRoot worktree and the land branch from the settings file", t => {
  const dir = mkdtempSync(join(tmpdir(), "agent-worktrees-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  for (const key of ["KIT_ROOT", "KIT_DEV_ROOT", "KIT_MAIN_ROOT"]) delete env[key];
  const root = join(dir, "site"), devRoot = join(dir, "site-checkout");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ project: "site", branches: { land: "main" }, devRoot }));
  git("init", "-q", "-b", "main"); git("add", "-A"); git("commit", "-q", "-m", "base");
  // The main checkout moves off main, so main lives in a linked worktree; dev is an ordinary branch here.
  git("switch", "-q", "-c", "home");
  git("worktree", "add", "-q", join(dir, "on-main"), "main");
  git("worktree", "add", "-q", "-b", "feature/dev", devRoot);
  git("worktree", "add", "-q", "-b", "dev", join(dir, "on-dev"));
  const result = spawnSync("bash", [resolve("scripts/agents/worktrees.sh")], { cwd: root, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const decision = (branch: string) => result.stdout.split("\n").find(line => line.includes(`\tbranch=${JSON.stringify(branch)}\t`))?.split("\t").at(-1);
  assert.equal(decision("main"), "protected");
  assert.equal(decision("feature/dev"), "protected");
  assert.notEqual(decision("dev"), "protected");
  assert.equal(result.stdout.trimEnd().split("\n").at(-1), "Branches kept. Review git branch --merged origin/main, then git branch -d <branch>.");
});
