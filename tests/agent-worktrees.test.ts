import assert from "node:assert/strict";
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
