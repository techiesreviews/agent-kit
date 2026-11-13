import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

// kit ask is retired (Lex, 2026-11-13, TOOLS-228): it spent paid API credit, which ran out on 2026-11-11. The command
// stays only to print one plain line pointing to a subscription helper; it never calls Claude or reads a key.
const kit = resolve("kit");
const retired = "RESULT: fail ask retired: it spent paid API credit (off since 2026-11-11). Write with a subscription helper instead: a T3 delegate_task to Sonnet or Opus; for a script, its brief names youtube/AGENTS.md and the \"Current script and prompter playbook\" in youtube/shared/taste/scripts.md";

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-ask-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), home = join(dir, "home"), state = join(dir, "state"), work = join(dir, "work");
  for (const path of [bin, home, state, work]) mkdirSync(path, { recursive: true });
  // A claude that leaves a mark if anything starts it.
  const called = join(dir, "called");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\ntouch ${JSON.stringify(called)}\necho '{"result":"no"}'\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, "sk-ant-test-ask-not-a-real-key\n", { mode: 0o600 });
  const prompt = join(work, "prompt.md");
  writeFileSync(prompt, "WRITE: a 60-second script about backups.\n");
  const env = { ...kitEnv(), HOME: home, XDG_STATE_HOME: state, PATH: `${bin}:${process.env.PATH}`, KIT_API_KEY_FILE: keyFile } as NodeJS.ProcessEnv;
  const ask = (args: string[]) => spawnSync(kit, ["ask", ...args], { cwd: work, env, encoding: "utf8", timeout: 30_000 });
  return { called, prompt, state, ask };
}

test("kit ask is retired: any call prints one plain line pointing to a subscription helper and starts no Claude", t => {
  const f = folder(t);
  for (const args of [[], ["--api", "--prompt-file", f.prompt], ["--api", "--script", "--prompt-file", f.prompt, "--out", "draft.md"], ["--unknown"]]) {
    const run = f.ask(args);
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.equal(run.stdout, `${retired}\n`, `kit ask ${args.join(" ")}`);
    assert.equal(run.stderr, "");
  }
  assert.ok(!existsSync(f.called), "no Claude call was started");
  assert.ok(!existsSync(join(f.state, "agent-kit/api-spend.log")), "no spend was logged");
});

test("kit ask --help gives the usage line every command has, then the same plain pointer, and succeeds", t => {
  const f = folder(t);
  for (const flag of ["--help", "-h"]) {
    const run = f.ask([flag]);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stdout, `Usage: kit ask (retired)\n${retired.replace(/^RESULT: fail ask /, "kit ask is ")}\n`);
  }
});
