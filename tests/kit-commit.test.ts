import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { builderAuthor, commitBuilderWork } from "../scripts/agents/kit-lib.mjs";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "kit-commit-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "build/test");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.com");
  const hooks = join(root, ".git/hooks-test"); mkdirSync(hooks);
  git("config", "core.hooksPath", hooks);
  writeFileSync(join(root, "file.txt"), "base\n");
  git("add", "-A"); git("commit", "-m", "base");
  const head = git("rev-parse", "HEAD");
  const args = { root, branch: "build/test", head, message: "Ticket title", author: builderAuthor("gpt-6.1-sol") };
  const hook = (name: string, body: string) => {
    const path = join(hooks, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755);
  };
  t.after(() => {
    try {
      for (const name of ["index.lock", "HEAD.lock"]) assert.equal(existsSync(join(root, ".git", name)), false, name);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  return { root, git, head, args, hook };
}

test("shared commit helper creates exactly one clean commit with model credit and runs normal hooks", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "file.txt"), "built\n");
  f.hook("pre-commit", 'git diff --cached --name-only > .git/hook-files');
  const sha = commitBuilderWork(f.args);
  assert.equal(sha, f.git("rev-parse", "HEAD"));
  assert.equal(f.git("rev-parse", "HEAD^"), f.head);
  assert.equal(f.git("rev-list", "--count", `${f.head}..HEAD`), "1");
  assert.equal(f.git("log", "-1", "--format=%B"), "Ticket title\n\nCo-Authored-By: GPT-6.1-Sol <noreply@openai.com>");
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(f.root, ".git/hook-files"), "utf8"), "file.txt\n");
});

for (const mismatch of ["branch", "HEAD", "detached HEAD"]) test(`shared commit helper refuses wrong ${mismatch} before staging`, t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "file.txt"), "built\n");
  if (mismatch === "branch") f.git("switch", "-c", "other");
  else if (mismatch === "HEAD") f.git("commit", "--allow-empty", "-m", "other");
  else f.git("switch", "--detach");
  assert.throws(() => commitBuilderWork(f.args), /branch or HEAD changed/);
  assert.equal(f.git("diff", "--cached", "--name-only"), "");
});

test("shared commit helper reports nothing to commit", t => {
  const f = fixture(t);
  assert.throws(() => commitBuilderWork(f.args), /nothing to commit/);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
});

for (const move of ["HEAD", "branch", "extra commit"]) test(`shared commit helper rejects a hook moving ${move}`, t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "file.txt"), "built\n");
  if (move === "HEAD") {
    const tree = f.git("rev-parse", "HEAD^{tree}");
    const foreign = f.git("commit-tree", tree, "-m", "foreign root");
    f.hook("post-commit", `git update-ref refs/heads/build/test ${foreign}`);
  } else if (move === "branch") f.hook("post-commit", "git switch -c other");
  else f.hook("post-commit", "git -c core.hooksPath=/dev/null commit --allow-empty -m extra");
  assert.throws(() => commitBuilderWork(f.args), /branch or HEAD changed during commit/);
});

test("shared commit helper reports a rejecting hook without leaving locks", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "file.txt"), "built\n");
  f.hook("pre-commit", "echo validation-rejected >&2\nexit 1");
  assert.throws(() => commitBuilderWork(f.args), /git commit failed:.*validation-rejected/s);
  assert.equal(f.git("rev-parse", "HEAD"), f.head);
});

test("shared builder author mapping names Sol, GPT, Claude and unknown models", () => {
  assert.equal(builderAuthor("gpt-6.1-sol"), "GPT-6.1-Sol <noreply@openai.com>");
  assert.equal(builderAuthor("gpt-6-luna"), "GPT-6-Luna <noreply@openai.com>");
  assert.equal(builderAuthor("claude-opus-5-5"), "Claude Opus 5.5 <noreply@anthropic.com>");
  assert.equal(builderAuthor("claude-sonnet-4-5"), "Claude Sonnet 4.5 <noreply@anthropic.com>");
  assert.equal(builderAuthor("claude-haiku-4-5-20251001"), "Claude Haiku 4.5 <noreply@anthropic.com>");
  assert.equal(builderAuthor("claude-sonnet-4-6[1m]"), "Claude Sonnet 4.6 <noreply@anthropic.com>");
  assert.equal(builderAuthor("claude-opus-4-1-20250805[1m]"), "Claude Opus 4.1 <noreply@anthropic.com>");
  assert.equal(builderAuthor("claude-opus-4-20250514"), "claude-opus-4-20250514 <noreply@anthropic.com>");
  assert.equal(builderAuthor("claude-sonnet-4-20250514"), "claude-sonnet-4-20250514 <noreply@anthropic.com>");
  assert.equal(builderAuthor("opus[1m]"), "opus[1m] <noreply@anthropic.com>");
  assert.equal(builderAuthor("gpt-4o-mini"), "GPT-4o-Mini <noreply@openai.com>");
  for (const alias of ["opus", "sonnet", "haiku", "fable"])
    assert.equal(builderAuthor(alias), `Claude ${alias[0].toUpperCase()}${alias.slice(1)} <noreply@anthropic.com>`);
  assert.equal(builderAuthor("other-model"), "other-model <noreply@openai.com>");
  assert.equal(builderAuthor("grok-4.7"), "grok-4.7 <noreply@openai.com>");
});

test("shared commit helper cannot redirect a commit when a pre-commit hook switches the real branch", t => {
  const f = fixture(t);
  f.git("branch", "other", f.head);
  writeFileSync(join(f.root, "file.txt"), "built\n");
  f.hook("pre-commit", 'git --git-dir="$TEST_REAL_GIT_DIR" --work-tree="$GIT_WORK_TREE" switch other');
  assert.throws(() => commitBuilderWork({ ...f.args, env: { ...process.env, TEST_REAL_GIT_DIR: join(f.root, ".git") } }), /branch or HEAD changed/);
  assert.equal(f.git("rev-parse", "other"), f.head);
  assert.equal(f.git("rev-parse", "build/test"), f.head);
});

test("shared commit helper publishes only its linked worktree branch", t => {
  const f = fixture(t), linked = join(f.root, "linked");
  f.git("worktree", "add", "-b", "build/linked", linked, f.head);
  writeFileSync(join(linked, "file.txt"), "linked build\n");
  const sha = commitBuilderWork({ ...f.args, root: linked, branch: "build/linked" });
  assert.equal(f.git("rev-parse", "build/linked"), sha);
  assert.equal(f.git("rev-parse", "build/linked^"), f.head);
  assert.equal(f.git("rev-parse", "HEAD"), f.head, "main worktree branch must not move");
  assert.equal(f.git("-C", linked, "status", "--porcelain"), "");
  for (const lock of ["index.lock", "HEAD.lock"]) assert.equal(existsSync(join(f.root, ".git/worktrees/linked", lock)), false);
});

test("shared commit helper never redirects publication after its final scope check", t => {
  const f = fixture(t);
  f.git("branch", "other", f.head);
  writeFileSync(join(f.root, "file.txt"), "built\n");
  const bin = join(f.root, ".git/bin"); mkdirSync(bin);
  const shim = join(bin, "git");
  // Interpose at the final transaction, after the last scope check.
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  writeFileSync(shim, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("update-ref")) {
  const rootEnv = { ...process.env }; delete rootEnv.GIT_DIR; delete rootEnv.GIT_WORK_TREE; delete rootEnv.GIT_INDEX_FILE;
  const switched = spawnSync(${JSON.stringify(gitPath)}, ["-C", ${JSON.stringify(f.root)}, "switch", "other"], { env: rootEnv });
  if (switched.status !== 0) process.exit(9);
}
const result = spawnSync(${JSON.stringify(gitPath)}, args, { input: args.includes("--stdin") ? readFileSync(0) : undefined, encoding: "utf8" });
process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status ?? 1);
`);
  chmodSync(shim, 0o755);
  assert.throws(() => commitBuilderWork({ ...f.args, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }), /branch or HEAD changed/);
  assert.equal(f.git("rev-parse", "other"), f.head);
  assert.equal(f.git("rev-parse", "build/test^"), f.head, "only the captured branch can receive the commit");
});
