import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { comparePackages, dependencyClosure, lockedPackages, snapshotChanges } from "../scripts/agents/deps-check.mjs";

const repo = resolve(".");
const kit = join(repo, "scripts/agents/kit");
const deps = join(repo, "scripts/agents/kit.d/deps");
const library = join(repo, "scripts/agents/kit-lib.sh");
const generateFile = "node -e \"require('node:fs').writeFileSync('generated.json', JSON.stringify('fixture'))\"";
type LockEntry = { version?: string; optional?: boolean; link?: boolean; resolved?: string };

function writeJson(file: string, value: object) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "kit-deps-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "worktree");
  const prefix = join(directory, "shared");
  const modules = join(prefix, "node_modules");
  mkdirSync(root);
  mkdirSync(modules, { recursive: true });
  // Any accidental reification of the worktree would hit only this temp tree.
  symlinkSync(modules, join(root, "node_modules"));
  const env = { ...process.env, KIT_ROOT: root, KIT_LIB: library, ASE_OWNER: "ak-11",
    KIT_COMMANDS_DIR: join(repo, "scripts/agents/kit.d"), npm_config_cache: join(directory, "cache"),
    npm_config_offline: "true", npm_config_update_notifier: "false", npm_config_userconfig: join(directory, "npmrc") };
  writeFileSync(env.npm_config_userconfig, "");
  const lock = (packages: Record<string, LockEntry> = {}) => writeJson(join(root, "package-lock.json"), {
    name: "fixture", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name: "fixture", version: "1.0.0" }, ...packages },
  });
  writeJson(join(root, "package.json"), { name: "fixture", version: "1.0.0", private: true });
  lock();
  const install = (name: string, version: string) => writeJson(join(modules, name, "package.json"), { name, version });
  const run = (args: string[], direct = false, overrides: NodeJS.ProcessEnv = {}) => spawnSync(
    "/bin/bash", direct ? [deps, ...args] : [kit, "deps", ...args], {
      cwd: root, encoding: "utf8", timeout: 30_000, env: { ...env, ...overrides },
    },
  );
  const add = (spec: string, args: string[] = [], overrides: NodeJS.ProcessEnv = {}) => run([
    "add", spec, "--prefix", prefix, "--lock-file", join(directory, "add.lock"), ...args,
  ], false, overrides);
  const pack = (name = "newpkg", version = "1.0.0", dependencies: Record<string, string> = {},
    postinstall = generateFile) => {
    const source = join(directory, `${name.replaceAll("/", "-")}-${version}`);
    mkdirSync(source);
    writeJson(join(source, "package.json"), { name, version, dependencies,
      bin: { [name.split("/").at(-1)!]: "cli.js" },
      scripts: { postinstall } });
    writeFileSync(join(source, "cli.js"), "#!/usr/bin/env node\nconsole.log(require('./generated.json'));\n");
    chmodSync(join(source, "cli.js"), 0o755);
    const result = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory], {
      cwd: source, encoding: "utf8", timeout: 15_000, env,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const packed: { filename: string }[] = JSON.parse(result.stdout);
    return join(directory, packed[0].filename);
  };
  return { directory, root, prefix, modules, env, lock, install, run, add, pack };
}

// Seed npm's own cache with packuments and npm-pack tarballs. The registry is
// deliberately unreachable; every npm invocation retains offline=true.
async function cachedRegistry(f: ReturnType<typeof fixture>, definitions: {
  name: string; version: string; dependencies?: Record<string, string>;
}[]) {
  const registry = "https://kit-deps.invalid/";
  const npm = spawnSync("/bin/bash", ["-c", "command -v npm"], { encoding: "utf8", env: f.env }).stdout.trim();
  const cache: { put: (path: string, key: string, data: Buffer | string, options?: object) => Promise<unknown> } =
    createRequire(realpathSync(npm))("cacache");
  const cachePath = join(f.env.npm_config_cache, "_cacache");
  const packages: Record<string, Record<string, object>> = {};
  const locked: Record<string, { version: string; resolved: string; integrity: string }> = {};
  for (const { name, version, dependencies = {} } of definitions) {
    const tarball = readFileSync(f.pack(name, version, dependencies));
    const resolved = `${registry}${name}/-/${name}-${version}.tgz`;
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    await cache.put(cachePath, `fixture:${name}@${version}`, tarball);
    (packages[name] ??= {})[version] = { name, version, dependencies, hasInstallScript: true,
      scripts: { postinstall: generateFile }, bin: { [name.split("/").at(-1)!]: "cli.js" },
      dist: { tarball: resolved, integrity } };
    locked[`${name}@${version}`] = { version, resolved, integrity };
  }
  for (const [name, versions] of Object.entries(packages)) {
    const url = `${registry}${name}`;
    const packument = JSON.stringify({ name, "dist-tags": { latest: Object.keys(versions).at(-1) }, versions });
    for (const accept of ["application/json", "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"]) {
      await cache.put(cachePath, `make-fetch-happen:request-cache:${url}`, packument, { metadata: {
        time: Date.now(), url, reqHeaders: { accept }, resHeaders: { "content-type": "application/json" },
        options: { compress: true },
      } });
    }
  }
  return { registry, locked };
}

function resultLine(result: ReturnType<typeof spawnSync<string>>, status: number, pattern: RegExp) {
  assert.equal(result.status, status, result.stdout + result.stderr);
  const lines = result.stdout.trimEnd().split("\n");
  assert.equal(lines.filter(line => line.startsWith("RESULT:")).length, 1, result.stdout);
  assert.match(lines.at(-1)!, pattern);
}

function tree(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) result[name] = `link:${readlinkSync(file)}`;
    else if (stat.isDirectory()) {
      for (const [child, value] of Object.entries(tree(file))) result[`${name}/${child}`] = value;
    } else result[name] = `${stat.mode}:${readFileSync(file).toString("base64")}`;
  }
  return result;
}

test("deps pure rules select top-level entries and allow only snapshot additions", () => {
  const packages = lockedPackages({ packages: {
    "": {}, "node_modules/@scope/pkg": { version: "1.0.0" },
    "node_modules/a/node_modules/b": { version: "2" }, "node_modules/link": { link: true },
    "node_modules/platform": { version: "3", optional: true },
  } });
  assert.equal(packages.length, 2);
  assert.deepEqual(comparePackages(packages, new Map([["@scope/pkg", "1.0.0"]])), []);
  assert.deepEqual(snapshotChanges(new Map([["keep", "1"]]), new Map([["keep", "1"], ["new", "2"]])), []);
  assert.deepEqual(snapshotChanges(new Map([["keep", "1"], ["gone", "2"]]), new Map([["keep", "3"]])), ["keep", "gone"]);
});

test("deps closure follows nested, scoped, optional and peer dependencies through parents and cycles", () => {
  const lock = { packages: {
    "node_modules/newpkg": { version: "1", dependencies: { branch: "*", "@scope/shared": "*" },
      optionalDependencies: { absent: "*", optional: "*" }, peerDependencies: { absentPeer: "*", peer: "*" } },
    "node_modules/branch": { version: "1", dependencies: { leaf: "*" } },
    "node_modules/branch/node_modules/leaf": { version: "2", dependencies: { sibling: "*", "@scope/shared": "*" } },
    "node_modules/branch/node_modules/sibling": { version: "1", dependencies: { newpkg: "*" } },
    "node_modules/leaf": { version: "9", dependencies: { unrelated: "*" } },
    "node_modules/@scope/shared": { version: "1" },
    "node_modules/optional": { version: "1", optional: true },
    "node_modules/peer": { version: "1" },
    "node_modules/unrelated": { version: "1" },
  } };
  assert.deepEqual([...dependencyClosure(lock, "newpkg").keys()], [
    "node_modules/newpkg", "node_modules/branch", "node_modules/branch/node_modules/leaf",
    "node_modules/branch/node_modules/sibling", "node_modules/@scope/shared", "node_modules/optional", "node_modules/peer",
  ]);
  assert.throws(() => dependencyClosure({ packages: {
    "node_modules/newpkg": { version: "1", dependencies: { missing: "*" } },
  } }, "newpkg"), /missing locked dependency missing/);
});

test("deps check matches ordinary and scoped packages, skips links, nested keys and absent optional packages", t => {
  const f = fixture(t);
  f.lock({ "node_modules/a": { version: "1.0.0" }, "node_modules/@scope/pkg": { version: "2.0.0" },
    "node_modules/a/node_modules/b": { version: "3.0.0" }, "node_modules/platform": { version: "4", optional: true },
    "node_modules/link": { link: true } });
  f.install("a", "1.0.0");
  f.install("@scope/pkg", "2.0.0");
  resultLine(f.run(["check"]), 0, /^RESULT: ok deps check 2 packages match \(1 absent optional skipped\)$/);
});

test("deps check reports missing, mismatched and present wrong optional packages", t => {
  const f = fixture(t);
  f.lock({ "node_modules/missing": { version: "1.0.0" }, "node_modules/wrong": { version: "2.0.0" },
    "node_modules/@scope/optional": { version: "3.0.0", optional: true } });
  f.install("wrong", "9.0.0");
  f.install("@scope/optional", "9.0.0");
  const result = f.run(["check"]);
  resultLine(result, 1, /^RESULT: fail deps check 3 mismatches: missing, wrong, @scope\/optional$/);
  assert.match(result.stdout, /missing missing@1\.0\.0/);
  assert.match(result.stdout, /mismatch wrong locked 2\.0\.0 installed 9\.0\.0/);
  assert.match(result.stdout, /mismatch @scope\/optional locked 3\.0\.0 installed 9\.0\.0/);
});

test("deps check overrides lock and modules and runs quickly for 300 packages", t => {
  const f = fixture(t);
  const alternate = join(f.directory, "other-modules");
  const packages: Record<string, LockEntry> = {};
  for (let index = 0; index < 300; index++) {
    packages[`node_modules/p${index}`] = { version: "1.0.0" };
    writeJson(join(alternate, `p${index}`, "package.json"), { version: "1.0.0" });
  }
  const lock = join(f.directory, "other-lock.json");
  writeJson(lock, { packages });
  const start = performance.now();
  resultLine(f.run(["check", "--lock", lock, "--modules", alternate], true), 0, /300 packages match$/);
  assert.ok(performance.now() - start < 1000, "300-package check should finish under one second");
});

test("deps check rejects unreadable, malformed and unsafe lock entries with exit 2", t => {
  const f = fixture(t);
  for (const contents of ["{", "{}", '{"packages":[]}', '{"packages":{"node_modules/../escape":{"version":"1"}}}',
    '{"packages":{"node_modules/bad":{}}}']) {
    writeFileSync(join(f.root, "package-lock.json"), contents);
    resultLine(f.run(["check"]), 2, /^RESULT: fail deps cannot read lock /);
  }
  resultLine(f.run(["check", "--lock", join(f.directory, "missing.json")]), 2, /^RESULT: fail deps cannot read lock /);
});

test("deps help works for all subcommands, is executable, and kit discovers its summary", t => {
  const f = fixture(t);
  assert.equal(statSync(deps).mode & 0o111, 0o111);
  assert.equal(readFileSync(deps, "utf8").split("\n")[1], "# kit: check or add npm packages in the shared node_modules");
  for (const args of [["--help"], ["check", "--help"], ["add", "--help"]]) {
    const result = f.run(args);
    resultLine(result, 0, /^RESULT: ok deps help$/);
    assert.match(result.stdout, /Usage: kit deps check/);
    assert.match(result.stdout, /kit deps add/);
  }
  const listing = spawnSync("/bin/bash", [kit, "--help"], { cwd: f.root, encoding: "utf8", env: f.env });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /deps\s+check or add npm packages in the shared node_modules/);
});

test("deps rejects bad arguments without npm operations", t => {
  const f = fixture(t);
  const before = tree(f.root);
  for (const args of [[], ["wat"], ["check", "--wat"], ["check", "--lock"], ["check", "extra"],
    ["add", "--prefix", f.prefix, "--lock-file", join(f.directory, "add.lock")],
    ["add", "newpkg", "--lock-file"], ["add", "newpkg", "--lock-file", join(f.directory, "add.lock"), "--wat"]]) {
    resultLine(f.run(args), 2, /^RESULT: fail deps /);
  }
  assert.deepEqual(tree(f.root), before);
});

for (const dev of [false, true]) {
  test(`deps add local tarball preserves existing bytes and bin links${dev ? " with --dev" : ""}`, t => {
    const f = fixture(t);
    f.install("keep-me", "1.0.0");
    writeFileSync(join(f.modules, "keep-me", "important.txt"), "do not change\n");
    mkdirSync(join(f.modules, ".bin"));
    symlinkSync("../keep-me/important.txt", join(f.modules, ".bin", "keep"));
    const before = tree(f.modules);
    const tarball = f.pack();
    const result = f.add(tarball, dev ? ["--dev"] : []);
    resultLine(result, 0, /^RESULT: ok deps add newpkg@1\.0\.0 \(1 packages added to shared node_modules\)$/);
    const after = tree(f.modules);
    for (const [key, value] of Object.entries(before)) assert.equal(after[key], value, key);
    assert.equal(JSON.parse(readFileSync(join(f.modules, "newpkg/package.json"), "utf8")).version, "1.0.0");
    assert.equal(readlinkSync(join(f.modules, ".bin/newpkg")), "../newpkg/cli.js");
    assert.equal(JSON.parse(readFileSync(join(f.modules, "newpkg/generated.json"), "utf8")), "fixture");
    const cli = spawnSync(join(f.modules, ".bin/newpkg"), [], { cwd: f.root, encoding: "utf8", env: f.env });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout, "fixture\n");
    const manifest = JSON.parse(readFileSync(join(f.root, "package.json"), "utf8"));
    assert.match(manifest[dev ? "devDependencies" : "dependencies"].newpkg, /^file:/);
    const lock = JSON.parse(readFileSync(join(f.root, "package-lock.json"), "utf8"));
    assert.equal(lock.packages["node_modules/newpkg"].version, "1.0.0");
    assert.equal(Boolean(lock.packages["node_modules/newpkg"].dev), dev);
    assert.ok(lstatSync(join(f.root, "node_modules")).isSymbolicLink());
    resultLine(f.run(["check"]), 0, /packages match$/);
    // Re-adding an already resolved tarball identifies it and copies nothing.
    resultLine(f.add(`file:${tarball}`, dev ? ["--dev"] : []), 0, /\(0 packages added to shared node_modules\)$/);
  });
}

test("deps add uses locked transitive versions even when a newer matching version is cached", async t => {
  const f = fixture(t);
  const { registry, locked } = await cachedRegistry(f, [
    { name: "child", version: "1.0.0" }, { name: "child", version: "1.1.0" },
    { name: "newpkg", version: "1.0.0", dependencies: { child: "^1" } },
  ]);
  writeJson(join(f.root, "package.json"), { name: "fixture", version: "1.0.0", dependencies: { child: "^1" } });
  f.lock({ "node_modules/child": locked["child@1.0.0"] });
  f.install("child", "1.0.0");
  writeFileSync(join(f.modules, "child/keep.txt"), "locked child must survive\n");
  const before = tree(f.modules);
  resultLine(f.add("newpkg", [], { npm_config_registry: registry }), 0, /deps add newpkg@1\.0\.0/);
  for (const [key, value] of Object.entries(before)) assert.equal(tree(f.modules)[key], value, key);
  const lock = JSON.parse(readFileSync(join(f.root, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/child"].version, "1.0.0");
  assert.equal(existsSync(join(f.modules, "newpkg/node_modules/child")), false);
});

test("deps add honours worktree npmrc for both offline npm operations", async t => {
  const f = fixture(t);
  const { registry } = await cachedRegistry(f, [{ name: "newpkg", version: "1.0.0" }]);
  writeFileSync(join(f.root, ".npmrc"), `registry=${registry}\n`);
  resultLine(f.add("newpkg", [], { npm_config_registry: undefined }), 0, /deps add newpkg@1\.0\.0/);
  assert.equal(JSON.parse(readFileSync(join(f.modules, "newpkg/generated.json"), "utf8")), "fixture");
});

for (const reference of [false, true]) {
  test(`deps add retains root overrides while staging the locked closure${reference ? " with a dependency reference" : ""}`, async t => {
    const f = fixture(t);
    const { registry, locked } = await cachedRegistry(f, [
      { name: "child", version: "1.0.0" }, { name: "child", version: "2.0.0" },
      { name: "newpkg", version: "1.0.0", dependencies: { child: "^1" } },
    ]);
    const overrides = { newpkg: { child: reference ? "$child" : "2.0.0" } };
    writeJson(join(f.root, "package.json"), { name: "fixture", version: "1.0.0", overrides,
      ...(reference ? { dependencies: { child: "2.0.0" } } : {}) });
    if (reference) f.lock({ "node_modules/child": locked["child@2.0.0"] });
    f.install("child", "2.0.0");
    const before = tree(f.modules);
    resultLine(f.add("newpkg", [], { npm_config_registry: registry }), 0, /deps add newpkg@1\.0\.0/);
    assert.equal(existsSync(join(f.modules, "newpkg/node_modules/child")), false);
    for (const [key, value] of Object.entries(before)) assert.equal(tree(f.modules)[key], value, key);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, "package.json"), "utf8")).overrides, overrides);
  });
}

test("deps add validates every staged closure version before writing anything", t => {
  const f = fixture(t);
  const child = f.pack("child", "1.0.0", {},
    "node -e \"const fs=require('node:fs'); const p=require('./package.json'); p.version='9.0.0'; fs.writeFileSync('package.json', JSON.stringify(p));\"");
  const tarball = f.pack("newpkg", "1.0.0", { child: `file:${child}` });
  f.install("child", "1.0.0");
  const shared = tree(f.modules);
  const worktree = tree(f.root);
  resultLine(f.add(tarball), 1, /^RESULT: fail deps staged version differs for child: locked 1\.0\.0, staged 9\.0\.0$/);
  assert.deepEqual(tree(f.modules), shared);
  assert.deepEqual(tree(f.root), worktree);
});

test("deps add fails before any shared or manifest write when postinstall fails", t => {
  const f = fixture(t);
  f.install("keep-me", "1.0.0");
  const tarball = f.pack("newpkg", "1.0.0", {}, "node -e 'process.exit(99)'");
  const shared = tree(f.modules);
  const worktree = tree(f.root);
  resultLine(f.add(tarball), 1, /^RESULT: fail deps npm failed: 99$/);
  assert.deepEqual(tree(f.modules), shared);
  assert.deepEqual(tree(f.root), worktree);
});

test("deps add conflicts before copying anything", t => {
  const f = fixture(t);
  f.install("keep-me", "1.0.0");
  f.install("newpkg", "9.0.0");
  const before = tree(f.modules);
  const manifests = tree(f.root);
  const result = f.add(f.pack());
  resultLine(result, 1, /^RESULT: fail deps conflict newpkg shared 9\.0\.0 requested 1\.0\.0$/);
  assert.deepEqual(tree(f.modules), before);
  assert.deepEqual(tree(f.root), manifests);
});

test("deps add preflights transitive package conflicts before copying the requested package", t => {
  const f = fixture(t);
  f.install("@scope/child", "2.0.0");
  const child = f.pack("@scope/child");
  const tarball = f.pack("newpkg", "1.0.0", { "@scope/child": `file:${child}` });
  const before = tree(f.modules);
  resultLine(f.add(tarball), 1, /conflict @scope\/child shared 2\.0\.0 requested 1\.0\.0$/);
  assert.deepEqual(tree(f.modules), before);
});

test("deps add copies scoped transitive packages and keeps baseline mismatches", t => {
  const f = fixture(t);
  f.install("keep-me", "1.0.0");
  f.lock({ "node_modules/absent": { version: "1.0.0" } });
  // Keep the baseline dependency in npm's manifest and lock without registry IO.
  const absent = f.pack("absent");
  writeJson(join(f.root, "package.json"), { name: "fixture", version: "1.0.0", dependencies: { absent: `file:${absent}` } });
  f.lock({ "node_modules/absent": { version: "1.0.0", resolved: `file:${absent}` } });
  const child = f.pack("@scope/child");
  const tarball = f.pack("newpkg", "1.0.0", { "@scope/child": `file:${child}` });
  resultLine(f.add(tarball), 0, /\(2 packages added to shared node_modules\)$/);
  assert.equal(JSON.parse(readFileSync(join(f.modules, "@scope/child/package.json"), "utf8")).version, "1.0.0");
  assert.equal(existsSync(join(f.modules, "absent")), false);
  resultLine(f.run(["check"]), 1, /1 mismatches: absent$/);
});

test("deps add refuses conflicting bin links before copying", t => {
  const f = fixture(t);
  f.install("keep-me", "1.0.0");
  mkdirSync(join(f.modules, ".bin"));
  symlinkSync("../keep-me/package.json", join(f.modules, ".bin/newpkg"));
  const before = tree(f.modules);
  resultLine(f.add(f.pack()), 1, /conflict \.bin\/newpkg$/);
  assert.deepEqual(tree(f.modules), before);
});

test("deps add holds its temp flock during both npm operations", t => {
  const f = fixture(t);
  const tarball = f.pack();
  const bin = join(f.directory, "bin");
  mkdirSync(bin);
  const npm = spawnSync("/bin/bash", ["-c", "command -v npm"], { encoding: "utf8", env: f.env }).stdout.trim();
  const capture = join(f.directory, "npm-lock-checks");
  writeFileSync(join(bin, "npm"), `#!/bin/bash\nif flock -n "$DEPS_TEST_LOCK" true; then exit 98; fi\nprintf 'locked\\n' >> "$DEPS_TEST_CAPTURE"\nexec "$DEPS_TEST_NPM" "$@"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  resultLine(f.add(tarball, [], { PATH: `${bin}:${process.env.PATH}`, DEPS_TEST_NPM: npm,
    DEPS_TEST_LOCK: join(f.directory, "add.lock"), DEPS_TEST_CAPTURE: capture }), 0, /deps add newpkg@1\.0\.0/);
  assert.equal(readFileSync(capture, "utf8"), "locked\nlocked\n");
});

test("deps add preserves worktree-relative linked file dependencies while resolving in isolation", t => {
  const f = fixture(t);
  writeJson(join(f.root, "tools/local/package.json"), { name: "local", version: "1.0.0" });
  writeJson(join(f.root, "package.json"), { name: "fixture", version: "1.0.0", dependencies: { local: "file:tools/local" } });
  f.lock({ "node_modules/local": { link: true, resolved: "tools/local" }, "tools/local": { version: "1.0.0" } });
  resultLine(f.add(f.pack(), [], { npm_config_install_links: "false" }), 0, /deps add newpkg@1\.0\.0/);
  const manifest = JSON.parse(readFileSync(join(f.root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(f.root, "package-lock.json"), "utf8"));
  assert.equal(manifest.dependencies.local, "file:tools/local");
  assert.equal(lock.packages["node_modules/local"].resolved, "tools/local");
  assert.equal(lock.packages["tools/local"].version, "1.0.0");
  assert.equal(JSON.stringify(lock).includes("kit-deps-lock-"), false);
});

test("deps add installs a local file directory as a concrete package with bin links", t => {
  const f = fixture(t);
  const source = join(f.directory, "source");
  writeJson(join(source, "package.json"), { name: "newpkg", version: "1.0.0", bin: { newpkg: "cli.js" } });
  writeFileSync(join(source, "cli.js"), "#!/usr/bin/env node\n");
  resultLine(f.add("file:../source", [], { npm_config_install_links: "false" }), 0, /deps add newpkg@1\.0\.0 \(1 packages added/);
  assert.equal(lstatSync(join(f.modules, "newpkg")).isSymbolicLink(), false);
  assert.equal(readlinkSync(join(f.modules, ".bin/newpkg")), "../newpkg/cli.js");
  resultLine(f.run(["check"]), 0, /packages match$/);
});
