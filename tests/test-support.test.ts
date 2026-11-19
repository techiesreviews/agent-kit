import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { orbitWorkTreeAround } from "../orbit-client.mjs";
import { loadLimit } from "./support/machine-load.ts";
import { tempOutsideGit } from "./support/temp-outside-git.ts";

test("a speed limit stays as it is on a quiet machine and grows with the load per core, at most four times", () => {
  assert.equal(loadLimit(2000, { load: 0, cores: 16 }).ms, 2000);
  assert.equal(loadLimit(2000, { load: 15, cores: 16 }).ms, 2000);
  // Load 30 on 16 cores, the editor sweep's (TOOLS-359): every core has about two runnable tasks.
  assert.equal(loadLimit(2000, { load: 31, cores: 16 }).ms, 4000);
  assert.equal(loadLimit(4000, { load: 31, cores: 16 }).ms, 8000);
  // A hang or a check that waits on the network still fails: never more than four times the quiet limit.
  assert.equal(loadLimit(2000, { load: 400, cores: 16 }).ms, 8000);
  assert.equal(loadLimit(2000, { load: 3, cores: 1 }).ms, 8000);
  assert.equal(loadLimit(2000, { load: 31, cores: 16 }).note, "limit 4000 ms: 2000 ms stretched for load 31.0 on 16 cores");
  // Without a load given, the limit reads this machine's own and still keeps to the bounds.
  const here = loadLimit(2000);
  assert.ok(here.ms >= 2000 && here.ms <= 8000, here.note);
  assert.match(here.note, /^limit \d+ ms: 2000 ms stretched for load \d+\.\d on \d+ cores$/);
});

test("a test's own temp folder is outside every git work tree, even when the system temp folder is inside one", t => {
  const scratch = mkdtempSync(join(tmpdir(), "temp-outside-git-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // A temp folder that something made a git work tree, as /tmp was for a moment in the kit release's gate (TOOLS-354).
  const repo = join(scratch, "repo"), inRepo = join(repo, "tmp"), clean = join(scratch, "clean");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(inRepo);
  mkdirSync(clean);
  const made = tempOutsideGit("kit-ticket-", [inRepo, clean]);
  assert.equal(dirname(made), clean);
  assert.match(made, /\/kit-ticket-[^/]+$/);
  assert.equal(orbitWorkTreeAround(join(made, ".config/fleet/orbit.json")), null);
  // A base that is missing or cannot be written is passed over, and nothing is left in a base it passed over.
  const next = tempOutsideGit("kit-ticket-", [join(scratch, "missing"), inRepo, clean]);
  assert.equal(dirname(next), clean);
  assert.equal(existsSync(join(scratch, "missing")), false);
  assert.throws(() => tempOutsideGit("kit-ticket-", [inRepo]), new RegExp(`no temp folder outside a git work tree: ${inRepo} is inside ${repo}`));
  // The default bases: whatever this machine has, the folder is outside every git work tree.
  const real = tempOutsideGit("kit-ticket-");
  t.after(() => rmSync(real, { recursive: true, force: true }));
  assert.equal(orbitWorkTreeAround(join(real, "orbit.json")), null);
});
