import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error The script is plain JavaScript without declarations.
import { options, parseWorktrees, pathInside, pruneDecision } from "../scripts/agents/worktrees.mjs";

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
