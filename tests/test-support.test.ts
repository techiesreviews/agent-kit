import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
// @ts-expect-error The kit's helpers are plain JavaScript without declarations.
import { orbitWorkTreeAround } from "../orbit-client.mjs";
import { kitCleanLimit, loadBesides, loadLimit } from "./support/machine-load.ts";
import { tempOutsideGit } from "./support/temp-outside-git.ts";

// TOOLS-359 follow-up (TOOLS-360): the kit-clean guard's 1200 s for the whole suite stretches the same way.
test("the kit-clean limit is 1200 s on a quiet machine, grows with the load per core up to four times, and a forced limit stays as given", () => {
  assert.equal(kitCleanLimit({}, { load: 0, cores: 16 }).ms, 1_200_000);
  assert.equal(kitCleanLimit({}, { load: 15, cores: 16 }).ms, 1_200_000);
  // The editor sweep's load (about 25 on 16 cores), where the suite ran past 1200 s with nothing hung.
  assert.equal(kitCleanLimit({}, { load: 25, cores: 16 }).ms, 1_950_000);
  assert.equal(kitCleanLimit({}, { load: 400, cores: 16 }).ms, 4_800_000);
  assert.equal(kitCleanLimit({ ASE_KIT_CLEAN_LIMIT_MS: "8000" }, { load: 400, cores: 16 }).ms, 8000, "the cut-off test's seam is never stretched");
  assert.match(kitCleanLimit({}, { load: 25, cores: 16 }).note, /^limit 1950000 ms: 1200000 ms stretched for load 25\.0 on 16 cores$/);
  // Read during the run, the suite's own four workers are left out: on a 2-core runner with only them busy it stays 1200 s.
  assert.equal(loadBesides(4, 4), 0);
  assert.equal(loadBesides(4, 3), 0);
  assert.equal(kitCleanLimit({}, { load: loadBesides(4, 4), cores: 2 }).ms, 1_200_000);
  assert.equal(kitCleanLimit({}, { load: loadBesides(4, 34), cores: 16 }).ms, 2_325_000);
});

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
  // Its own folder is one outside every work tree too, so a work tree around the system temp folder cannot fail it.
  const scratch = tempOutsideGit("temp-outside-git-");
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
  assert.deepEqual(readdirSync(inRepo), []);
  // The paths are matched as they are: a "." or "+" in a temp path must not loosen the pattern.
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.throws(() => tempOutsideGit("kit-ticket-", [inRepo]), new RegExp(`no temp folder outside a git work tree: ${literal(inRepo)} is inside ${literal(repo)}`));
  // The default bases: whatever this machine has, the folder is outside every git work tree.
  const real = tempOutsideGit("kit-ticket-");
  t.after(() => rmSync(real, { recursive: true, force: true }));
  assert.equal(orbitWorkTreeAround(join(real, "orbit.json")), null);
  // KIT_TEST_SHM (the clean guard's own folder) comes first.
  const saved = process.env.KIT_TEST_SHM;
  process.env.KIT_TEST_SHM = clean;
  try { assert.equal(dirname(tempOutsideGit("kit-ticket-")), clean); }
  finally { if (saved === undefined) delete process.env.KIT_TEST_SHM; else process.env.KIT_TEST_SHM = saved; }
});

test("kit-env hides newer host Nodes on PATH while keeping sibling tools reachable", t => {
  const scratch = tempOutsideGit("kit-env-host-node-");
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const hostBin = join(scratch, "host-bin");
  mkdirSync(hostBin);
  writeFileSync(join(hostBin, "node"), "#!/bin/sh\necho v99.0.0\n");
  chmodSync(join(hostBin, "node"), 0o755);
  writeFileSync(join(hostBin, "sibling-tool"), "#!/bin/sh\necho sibling-ok\n");
  chmodSync(join(hostBin, "sibling-tool"), 0o755);
  const script = `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { realpathSync } from "node:fs";
    import { kitEnv } from ${JSON.stringify(pathToFileURL(resolve("tests/support/kit-env.ts")).href)};
    import { nodeEnv } from ${JSON.stringify(pathToFileURL(resolve("kit-lib.mjs")).href)};
    const env = kitEnv();
    const chosen = nodeEnv(env);
    assert.equal(chosen.PATH, env.PATH);
    assert.equal(realpathSync(chosen.KIT_NODE), realpathSync(process.execPath));
    const tool = spawnSync("sibling-tool", [], { env, encoding: "utf8" });
    assert.equal(tool.status, 0, tool.stderr);
    assert.equal(tool.stdout.trim(), "sibling-ok");
  `;
  const ran = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    env: { ...process.env, PATH: `${hostBin}:${process.env.PATH}` },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
});
