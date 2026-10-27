import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
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

// A repo whose main checkout sits on `home`, with linked worktrees on the given branches and a devRoot
// checkout on feature/dev; `settings` (without devRoot) becomes its scripts/agents/kit.json, null for none.
function worktreeRepo(t: TestContext, settings: object | null, branches: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "agent-worktrees-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  for (const key of ["KIT_ROOT", "KIT_DEV_ROOT", "KIT_MAIN_ROOT"]) delete env[key];
  const root = join(dir, "site"), devRoot = join(dir, "site-checkout");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  mkdirSync(join(root, "scripts/agents"), { recursive: true });
  if (settings) writeFileSync(join(root, "scripts/agents/kit.json"), JSON.stringify({ ...settings, devRoot }));
  else writeFileSync(join(root, "README.md"), "site\n");
  git("init", "-q", "-b", "home"); git("add", "-A"); git("commit", "-q", "-m", "base");
  for (const branch of branches) git("worktree", "add", "-q", "-b", branch, join(dir, `on-${branch}`));
  git("worktree", "add", "-q", "-b", "feature/dev", devRoot);
  const run = (...args: string[]) => {
    const result = spawnSync("bash", [resolve("scripts/agents/worktrees.sh"), ...args], { cwd: root, env, encoding: "utf8" });
    const decision = (branch: string) => result.stdout.split("\n").find(line => line.includes(`\tbranch=${JSON.stringify(branch)}\t`))?.split("\t").at(-1);
    return { ...result, decision, last: result.stdout.trimEnd().split("\n").at(-1) };
  };
  return { run };
}

test("worktrees.sh protects the devRoot worktree and the land branch from the settings file", t => {
  // Main lives in a linked worktree; dev is an ordinary branch in a project that lands on main.
  const result = worktreeRepo(t, { project: "site", branches: { land: "main" } }, ["main", "dev"]).run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.decision("main"), "protected");
  assert.equal(result.decision("feature/dev"), "protected");
  assert.notEqual(result.decision("dev"), "protected");
  assert.equal(result.last, "Branches kept. Review git branch --merged origin/main, then git branch -d <branch>.");
});

test("worktrees.sh protects the release branch too and names both merge targets", t => {
  const result = worktreeRepo(t, { project: "site", branches: { land: "dev", release: "main" } }, ["main", "dev", "feature/x"]).run();
  assert.equal(result.status, 0, result.stderr);
  for (const branch of ["dev", "main", "feature/dev"]) assert.equal(result.decision(branch), "protected", branch);
  assert.notEqual(result.decision("feature/x"), "protected");
  assert.equal(result.last, "Branches kept. Review git branch --merged origin/dev (or origin/main), then git branch -d <branch>.");
});

test("without readable settings worktrees.sh still lists, says why, and refuses --prune", t => {
  const repo = worktreeRepo(t, null, ["dev"]);
  const listed = repo.run();
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stderr, /^problem: no scripts\/agents\/kit\.json; .*; listing without protected branches or merge state$/m);
  assert.equal(listed.decision("dev"), "not merged or merge unknown");
  assert.equal(listed.last, "Branches kept.");
  const pruned = repo.run("--prune");
  assert.equal(pruned.status, 1);
  assert.equal(pruned.stdout, "");
  assert.match(pruned.stderr, /^worktrees\.sh --prune needs readable settings: no scripts\/agents\/kit\.json/);
});
