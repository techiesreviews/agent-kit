import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { kitDevRoot, kitRoot, kitResult, kitSettings } from "./kit-lib.mjs";

class UsageError extends Error {}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const packageName = name => /^(?:@[a-z0-9_~-][a-z0-9_.~-]*\/)?[a-z0-9_~-][a-z0-9_.~-]*$/i.test(name);

/** Select only actual top-level packages; never follow a lock key outside modules. */
export function lockedPackages(lock) {
  if (!object(lock) || !object(lock.packages)) throw new UsageError("invalid lock: expected packages object");
  const packages = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/") || key.includes("/node_modules/")) continue;
    const name = key.slice("node_modules/".length);
    if (!packageName(name) || !object(entry)) throw new UsageError(`invalid lock entry ${key}`);
    if (entry.link === true) continue;
    if (typeof entry.version !== "string" || !entry.version) throw new UsageError(`invalid lock version for ${name}`);
    packages.push({ name, version: entry.version, optional: entry.optional === true });
  }
  return packages;
}

/** Follow Node's package lookup through lock keys, including nested packages. */
export function dependencyClosure(lock, name) {
  const closure = new Map();
  const find = (key, dependency) => {
    if (!packageName(dependency)) throw new Error(`invalid dependency name ${dependency}`);
    for (let parent = key; ; parent = dirname(parent)) {
      const candidate = parent === "." ? `node_modules/${dependency}` : `${parent}/node_modules/${dependency}`;
      if (object(lock.packages[candidate])) return candidate;
      if (parent === ".") return null;
    }
  };
  const visit = key => {
    if (closure.has(key)) return;
    const locked = lock.packages[key];
    const entry = locked?.link === true ? { ...lock.packages[locked.resolved], ...locked,
      version: lock.packages[locked.resolved]?.version } : locked;
    if (!object(entry) || typeof entry.version !== "string") throw new Error(`no resolved version for ${key}`);
    closure.set(key, entry);
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies })) {
      const target = find(key, dependency);
      if (target) visit(target);
      else if (Object.hasOwn(entry.dependencies ?? {}, dependency) && !Object.hasOwn(entry.optionalDependencies ?? {}, dependency)) {
        throw new Error(`missing locked dependency ${dependency} of ${key}`);
      }
    }
  };
  visit(`node_modules/${name}`);
  return closure;
}

/**
 * Check every closure entry, nested ones included, against what Node would load
 * from the staged tree: walk up from the dependent's folder like `require` does.
 * Only top-level packages are pinned, so this catches nested drift before copying.
 */
export function stagedMismatches(closure, staging) {
  const drift = [];
  for (const [key, entry] of closure) {
    const segments = key.split("/node_modules/");
    const installName = segments.at(-1).replace(/^node_modules\//, "");
    let parent = segments.length > 1 ? join(staging, segments.slice(0, -1).join("/node_modules/")) : staging;
    let actual;
    for (;;) {
      try { actual = String(json(join(parent, "node_modules", installName, "package.json")).version); break; }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (parent === staging || !parent.startsWith(staging)) break;
      parent = dirname(parent);
      if (parent.endsWith("/node_modules")) parent = dirname(parent);
    }
    if (actual === undefined && entry.optional === true) continue;
    if (actual !== entry.version) drift.push(`${key} locked ${entry.version} staged ${actual ?? "missing"}`);
  }
  return drift;
}

/** Compare lock entries with installed name -> version values, without filesystem IO. */
export function comparePackages(packages, installed) {
  return packages.flatMap(({ name, version, optional }) => {
    const actual = installed.get(name);
    if (actual === undefined && optional) return [];
    if (actual === version) return [];
    return [{ name, locked: version, installed: actual,
      text: actual === undefined ? `missing ${name}@${version}` : `mismatch ${name} locked ${version} installed ${actual}` }];
  });
}

/** Existing entries must survive unchanged; additions alone are allowed. */
export function snapshotChanges(before, after) {
  return [...before].flatMap(([name, value]) => after.get(name) === value ? [] : [name]);
}

function json(file) { return JSON.parse(readFileSync(file, "utf8")); }
function readLock(file) {
  try { const lock = json(file); lockedPackages(lock); return lock; }
  catch (error) { throw new UsageError(`cannot read lock ${file}: ${error.message}`); }
}

function check(lock, modules) {
  const packages = lockedPackages(lock);
  const installed = new Map();
  for (const { name } of packages) {
    try { installed.set(name, String(json(join(modules, name, "package.json")).version)); }
    catch (error) {
      // An unreadable or malformed installed manifest is not a valid match.
      if (error.code !== "ENOENT") installed.set(name, "unreadable");
    }
  }
  return { packages, mismatches: comparePackages(packages, installed) };
}

function entries(directory) {
  try { return readdirSync(directory).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

function installedPackages(modules) {
  return entries(modules).filter(name => !name.startsWith(".")).flatMap(name =>
    name.startsWith("@") ? entries(join(modules, name)).map(child => `${name}/${child}`) : [name]);
}

function fingerprint(file) {
  const stat = lstatSync(file);
  return stat.isSymbolicLink() ? `link:${readlinkSync(file)}` :
    `file:${stat.mode}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

function snapshot(modules) {
  const result = new Map();
  for (const name of installedPackages(modules)) {
    const manifest = join(modules, name, "package.json");
    result.set(name, `${json(manifest).version}:${fingerprint(manifest)}`);
  }
  for (const name of entries(join(modules, ".bin"))) result.set(`.bin/${name}`, fingerprint(join(modules, ".bin", name)));
  return result;
}

function npm(root, args) {
  console.log(`deps: npm ${args.join(" ")}`);
  const result = spawnSync("npm", [...args, "--no-audit", "--no-fund"], {
    cwd: root, encoding: "utf8", env: process.env, maxBuffer: 10 * 1024 * 1024,
  });
  // Keep npm output off stdout, preserving exactly one machine-readable RESULT.
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`npm failed: ${result.error?.message ?? result.status}`);
}

function dependencies(manifest) { return { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }; }

// npm 9 writes a hidden node_modules/.package-lock.json even with
// --package-lock-only. Resolve a copy so the worktree's shared symlink is never
// handed to npm. Rebase local references in both directions, retaining locked
// versions and worktree-relative file: dependencies (including linked packages).
function relocate(value, from, to, field = "") {
  const localPath = path => relative(to, resolve(from, path)).split("\\").join("/");
  if (typeof value === "string") return value.startsWith("file:") ? `file:${localPath(value.slice(5))}` : value;
  if (Array.isArray(value)) return value.map(item => relocate(item, from, to));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const nextKey = field === "packages" && key && !key.startsWith("node_modules/") ? localPath(key) : key;
    const nextValue = key === "resolved" && value.link === true && typeof item === "string" ? localPath(item) : relocate(item, from, to, key);
    return [nextKey, nextValue];
  }));
}

function localSpec(root, spec) {
  if (spec.startsWith("file:")) return `file:${resolve(root, spec.slice(5))}`;
  if (/^(?:\.{0,2}\/)/.test(spec) || /\.tgz$/.test(spec)) return resolve(root, spec);
  return null;
}

function copyNpmrc(root, destination) {
  try { cpSync(join(root, ".npmrc"), join(destination, ".npmrc")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

function resolveLock(root, spec, dev) {
  const scratch = mkdtempSync(join(tmpdir(), "kit-deps-lock-"));
  try {
    for (const name of ["package.json", "package-lock.json"]) {
      writeFileSync(join(scratch, name), `${JSON.stringify(relocate(json(join(root, name)), root, scratch), null, 2)}\n`);
    }
    copyNpmrc(root, scratch);
    npm(scratch, ["install", "--package-lock-only", "--ignore-scripts", "--prefix", scratch,
      ...(dev ? ["--save-dev"] : []), localSpec(root, spec) ?? spec]);
    return {
      manifest: relocate(json(join(scratch, "package.json")), scratch, root),
      lock: relocate(readLock(join(scratch, "package-lock.json")), scratch, root),
    };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

function resolvedPackage(root, spec, before, manifest, lock) {
  const after = dependencies(manifest);
  let names = Object.keys(after).filter(name => after[name] !== before[name]);
  if (names.length !== 1) {
    const named = spec.match(/^(@[^/]+\/[^@/]+|[^@/:]+)(?:@|$)/)?.[1];
    const local = spec.startsWith("file:") ? spec.slice(5) : spec;
    names = Object.keys(after).filter(name => name === named || after[name] === spec ||
      (after[name].startsWith("file:") && resolve(root, after[name].slice(5)) === resolve(root, local)));
  }
  if (names.length !== 1) throw new Error(`cannot identify resolved package for ${spec}`);
  const name = names[0];
  const entry = lock.packages[`node_modules/${name}`];
  const resolvedEntry = entry?.link === true ? lock.packages[entry.resolved] : entry;
  if (!resolvedEntry || typeof resolvedEntry.version !== "string") throw new Error(`no resolved version for ${name}`);
  return { name, version: resolvedEntry.version };
}

function add(root, options) {
  const modules = join(options.prefix, "node_modules");
  const before = snapshot(modules);
  const baseline = check(readLock(join(root, "package-lock.json")), modules);
  console.log(`deps: baseline ${baseline.mismatches.length} mismatches; ${before.size} installed entries`);
  const previous = dependencies(json(join(root, "package.json")));
  const { manifest, lock } = resolveLock(root, options.spec, options.dev);
  const { name, version } = resolvedPackage(root, options.spec, previous, manifest, lock);
  const closure = dependencyClosure(lock, name);
  const topLevel = [...closure].filter(([key]) => !key.slice("node_modules/".length).includes("/node_modules/"));
  const pins = topLevel.map(([key, entry]) => {
    const source = entry.resolved;
    if (entry.link === true || (typeof source === "string" && source.startsWith("file:"))) {
      return `file:${resolve(root, source.replace(/^file:/, ""))}`;
    }
    const installName = key.slice("node_modules/".length);
    // An npm alias (`alias: npm:real@^1`) keeps its real package identity in the lock's `name`.
    return typeof entry.name === "string" && entry.name !== installName
      ? `${installName}@npm:${entry.name}@${entry.version}` : `${installName}@${entry.version}`;
  });
  const staging = mkdtempSync(join(tmpdir(), "kit-deps-stage-"));
  try {
    writeFileSync(join(staging, "package.json"), `${JSON.stringify({ private: true, overrides: manifest.overrides }, null, 2)}\n`);
    copyNpmrc(root, staging);
    // Pin the top-level closure to the lock instead of resolving its ranges
    // again. Install scripts run here before anything reaches the shared tree.
    npm(staging, ["install", "--no-save", "--no-package-lock", "--install-links", "--prefix", staging,
      localSpec(root, options.spec) ?? `${name}@${version}`, ...pins]);
    const stagedModules = join(staging, "node_modules");
    const drift = stagedMismatches(closure, staging);
    if (drift.length) throw new Error(`staged versions differ from the lock: ${drift.join(", ")}`);
    const staged = snapshot(stagedModules);
    const additions = [];
    // Preflight every package and bin before the first shared-folder write.
    for (const stagedName of installedPackages(stagedModules)) {
      const stagedVersion = json(join(stagedModules, stagedName, "package.json")).version;
      if (before.has(stagedName)) {
        const sharedVersion = json(join(modules, stagedName, "package.json")).version;
        if (sharedVersion !== stagedVersion) throw new Error(`conflict ${stagedName} shared ${sharedVersion} requested ${stagedVersion}`);
      } else additions.push(stagedName);
    }
    const bins = [...staged.keys()].filter(key => key.startsWith(".bin/"));
    for (const bin of bins) {
      if (before.has(bin) && before.get(bin) !== staged.get(bin)) throw new Error(`conflict ${bin}`);
      if (!lstatSync(join(stagedModules, bin)).isSymbolicLink()) throw new Error(`invalid staged bin ${bin}`);
      const target = resolve(stagedModules, ".bin", readlinkSync(join(stagedModules, bin)));
      const destination = relative(stagedModules, target);
      if (destination.startsWith("..") || isAbsolute(destination)) throw new Error(`invalid staged bin target ${bin}`);
    }
    const changedDuringStaging = snapshotChanges(before, snapshot(modules));
    if (changedDuringStaging.length) throw new Error(`shared entries changed: ${changedDuringStaging.join(", ")}`);
    for (const [file, value] of [["package.json", manifest], ["package-lock.json", lock]]) {
      writeFileSync(join(root, file), `${JSON.stringify(value, null, 2)}\n`);
    }
    for (const addition of additions) {
      console.log(`deps: copy ${addition}`);
      mkdirSync(dirname(join(modules, addition)), { recursive: true });
      cpSync(join(stagedModules, addition), join(modules, addition), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    }
    for (const bin of bins) {
      if (before.has(bin)) continue;
      mkdirSync(join(modules, ".bin"), { recursive: true });
      symlinkSync(readlinkSync(join(stagedModules, bin)), join(modules, bin));
    }
    const changed = snapshotChanges(before, snapshot(modules));
    if (changed.length) throw new Error(`shared entries removed or changed: ${changed.join(", ")}`);
    const after = check(lock, modules);
    const baselineKeys = new Set(baseline.mismatches.map(item => JSON.stringify([item.name, item.locked, item.installed])));
    const grown = after.mismatches.filter(item => !baselineKeys.has(JSON.stringify([item.name, item.locked, item.installed])));
    if (grown.length || after.mismatches.some(item => item.name === name)) {
      throw new Error(`check worsened: ${grown.map(item => item.text).join(", ") || name}`);
    }
    return `${name}@${version} (${additions.length} packages added to shared node_modules)`;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function optionsFor(args, root) {
  const [command, ...rest] = args;
  if (command !== "check" && command !== "add") throw new UsageError("expected check or add (see kit deps --help)");
  const options = { command, lock: join(root, "package-lock.json"), modules: join(root, "node_modules"),
    prefix: "", spec: "", dev: false };
  const allowed = command === "check" ? { "--lock": "lock", "--modules": "modules" } : { "--prefix": "prefix", "--lock-file": "lockFile" };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (command === "add" && argument === "--dev") { options.dev = true; continue; }
    if (Object.hasOwn(allowed, argument)) {
      const value = rest[++index];
      if (!value || value.startsWith("-")) throw new UsageError(`${argument} needs a path`);
      options[allowed[argument]] = resolve(value);
    } else if (command === "add" && !argument.startsWith("-") && !options.spec) options.spec = argument;
    else throw new UsageError(`unexpected argument ${argument}`);
  }
  if (command === "add" && !options.spec) throw new UsageError("add needs a package spec");
  // The shared parent defaults to the dev worktree (KIT_DEV_ROOT, else devRoot in scripts/agents/kit.json).
  if (command === "add" && !options.prefix) {
    options.prefix = process.env.KIT_DEV_ROOT || "";
    if (!options.prefix) try { options.prefix = kitDevRoot(kitSettings(root)) ?? ""; } catch { /* No usable settings: the line below asks for --prefix. */ }
  }
  if (command === "add" && !options.prefix) throw new UsageError("add needs --prefix or devRoot in scripts/agents/kit.json");
  return options;
}

function main(args) {
  try {
    const root = kitRoot();
    const options = optionsFor(args, root);
    if (options.command === "add") {
      if (process.env.KIT_DEPS_LOCKED !== "1") throw new UsageError("use kit deps add to acquire the shared lock");
      kitResult("ok", `deps add ${add(root, options)}`);
      return;
    }
    const { packages, mismatches } = check(readLock(options.lock), options.modules);
    for (const item of mismatches) console.log(item.text);
    if (mismatches.length) {
      kitResult("fail", `deps check ${mismatches.length} mismatches: ${mismatches.slice(0, 5).map(item => item.name).join(", ")}`);
      process.exitCode = 1;
    } else {
      const skipped = packages.filter(item => item.optional && !existsSync(join(options.modules, item.name, "package.json"))).length;
      kitResult("ok", `deps check ${packages.length - skipped} packages match` + (skipped ? ` (${skipped} absent optional skipped)` : ""));
    }
  } catch (error) {
    kitResult("fail", `deps ${error.message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
