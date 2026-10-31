import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { allowedPath, allowedSkills, licencePath, normalLine, ownLicencePath, skillFiles, skillIndex, skillMatch, skillPath } from "../skill-guard.mjs";
import { kitEnv } from "./support/kit-env.ts";

const guard = resolve("skill-guard.mjs");
// Made-up skill text: never a line from a real skill.
const secret = "Fold the paper crane twice along the moonlit diagonal before the kettle sings";
const other = "Count seven marbles into the blue jar and whisper the inventory to the cat";
// Made-up licence text, standing in for an MIT, Apache or OFL text that many repos and skills hold word for word.
const licenceText = "Permission is hereby granted to anyone who folds this crane to fold it again and to share the folds";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-skill-guard-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), repo = join(directory, "repo");
  const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  put(join(home, ".claude/skills/crane/SKILL.md"), `---\nname: crane\n---\n# Crane\n\n- ${secret}\nshort line\n`);
  put(join(home, ".claude/skills/crane/references/more.md"), `${other}\n`);
  put(join(home, ".claude/skills/crane/scripts/tool.mjs"), `const fold = "Unfold the crane's left wing slowly and press the crease flat with a spoon";\n` +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n');
  // Generated files in a skill (lockfiles, installed packages) hold registry lines every project shares.
  put(join(home, ".claude/skills/crane/package-lock.json"), '      "resolved": "https://registry.npmjs.org/some-package/-/some-package-1.2.3.tgz",\n');
  put(join(home, ".claude/skills/crane/node_modules/x/index.js"), "module.exports = function installedPackageLineThatIsLongEnoughToCount() {};\n");
  put(join(home, ".claude/skills/crane/.git/config"), '[remote "origin"]\n\turl = https://example.com/someone/a-skill-repository-name-long-enough.git\n');
  put(join(home, ".claude/skills/crane/yarn.lock"), '  resolved "https://registry.yarnpkg.com/some-package/-/some-package-1.2.3.tgz#0123456789abcdef"\n');
  put(join(home, ".claude/skills/crane/dist/app.min.js"), "!function(){var minifiedBundleLineThatIsLongEnoughToCount=1;window.x=minifiedBundleLineThatIsLongEnoughToCount}();\n");
  for (const [index, path] of ["pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb", "poetry.lock", "uv.lock", "Cargo.lock", "Gemfile.lock",
    "composer.lock", "dist/app.min.css", ".venv/lib/python3.12/site-packages/x/core.py", "vendor/pkg/lib.php"].entries())
    put(join(home, ".claude/skills/crane", path), `generated line ${index} that every project which installs the same package shares\n`);
  // Licence texts are word for word in many repos; page set-up tags in a template are in every web page.
  put(join(home, ".claude/skills/crane/LICENSE"), "Licence: anyone may fold this paper crane freely, with no promise it will ever fly\n");
  for (const [index, path] of ["license", "License.md", "LICENSE-MIT", "LICENSE.APACHE-2.0.txt", "COPYING", "NOTICE.txt", "vendor/pkg/LICENSE"].entries())
    put(join(home, ".claude/skills/crane", path), `licence line ${index}: THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND\n`);
  // Licence texts kept under a name that ends in a licence name: a vendored package's or a font's.
  for (const [index, path] of ["templates/x-1.0.LICENSE.md", "y.LICENSE", "assets/fonts/Font-OFL.txt", "OFL.txt", "third-party-LICENSE-MIT.txt"].entries())
    put(join(home, ".claude/skills/crane", path), `${licenceText}\nlicence copy ${index}: the crane may be shared and folded again by anyone who keeps this note\n`);
  put(join(home, ".claude/skills/crane/templates/page.html"), [
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1, some-longer-value-here">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">',
    "<p>The paper crane template greets the reader with a folded welcome banner here</p>",
    '<link rel="icon" href="https://cdn.example.com/a-long-icon-path/favicon-32x32.png" sizes="32x32">',
    '<link rel="dns-prefetch" href="https://cdn.example.com/a-long-path-for-the-prefetch-hint">',
    '<link rel="preload" href="https://cdn.example.com/fonts/a-long-font-name-regular.woff2" as="font">',
    '<meta name="description" content="The paper crane template greets every reader with a fold">',
  ].join("\n") + "\n");
  // An extensionless file that is not a licence still counts.
  put(join(home, ".claude/skills/crane/Makefile"), "fold:\n\t@echo crease the wing twice and let the crane rest beside the teapot\n");
  // Files only named like a licence are skill text and are read.
  put(join(home, ".claude/skills/crane/references/notice-and-consent.md"), "Ask the paper crane politely before folding its wings back along the crease\n");
  put(join(home, ".claude/skills/crane/scripts/license-check.py"), "print('A crane may only be folded by someone who has thanked the paper first')\n");
  // A note whose name ends in a licence name is the price of reading prefixed licence texts as licences: it is skipped.
  put(join(home, ".claude/skills/crane/references/how-to-license.md"), "How to license the paper crane pattern when you sell a folded copy of it\n");
  put(join(home, ".codex/plugins/cache/kit/skills/jar/SKILL.md"), "The jar skill keeps its own long line here so plugins are read too, okay\n");
  mkdirSync(repo);
  const env = { ...kitEnv(), HOME: home, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  delete env.KIT_SKILL_DIRS;
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init", "-q", "-b", "main");
  put(join(repo, "README.md"), "# Repo\n");
  git("add", "."); git("commit", "-q", "-m", "start");
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, [guard, ...args], { cwd: repo, env: { ...env, ...extra }, encoding: "utf8" });
  return { home, repo, put, git, run };
}

test("a SKILL.md or a file under a skills/ folder is a skill path; other paths are not", () => {
  for (const path of ["SKILL.md", "a/SKILL.md", "skills/x.md", ".claude/skills/a/b.md", "docs/Skills/x"]) assert.ok(skillPath(path), path);
  for (const path of ["skill.md.bak/x", "skillset/x", "docs/skills.md", "SKILL.md.txt"]) assert.equal(skillPath(path), false, path);
});

test("a licence is named so on its own or at the end of a longer name; a file merely named like one is not", () => {
  for (const path of ["LICENSE", "a/license", "License.md", "LICENSE-MIT", "LICENSE.APACHE-2.0.txt", "COPYING", "NOTICE.txt", "licence.rst",
    "vendor/shadcn-tailwind-4.13.0.LICENSE.md", "sites-vite-plugin.LICENSE", "x.license.txt", "third-party-LICENSE-MIT.txt", "pkg-licence",
    "assets/fonts/Fraunces-OFL.txt", "OFL.txt", "how-to-license.md"]) assert.ok(licencePath(path), path);
  for (const path of ["license-check.py", "notice-and-consent.md", "scripts/license-check.py", "LICENSE.py", "licenses/mit.js", "my-license-notes.md",
    "privacy-notice.md", "x.copying", "x-NOTICE.txt", "OFL.py", "official.txt", "LICENSE.md/x", "README.md",
    "ofl.md", "Font.OFL", "Font-OFL-1.1.txt"]) assert.equal(licencePath(path), false, path);
  // In a project only a licence name on its own in the top folder is the project's licence; anything else is read.
  for (const path of ["LICENSE", "LICENSE.md", "COPYING", "License.txt", "LICENSE-MIT", "licence"]) assert.ok(ownLicencePath(path), path);
  for (const path of ["docs/choose-a-license.md", "notes.license.md", "x-1.0.LICENSE.md", "brand-OFL.md", "OFL.txt", "license-check.py",
    "NOTICE", "NOTICE.md", "docs/License.txt", "packages/a/LICENSE.md"])
    assert.equal(ownLicencePath(path), false, path);
});

test("lines compare without list marks, quotes, headings or extra spaces", () => {
  assert.equal(normalLine("  -   a   b "), "a b");
  assert.equal(normalLine("> ## 3. title"), "title");
  assert.equal(normalLine("12) step"), "step");
});

test("every file of a skill counts, but only lines of 60 or more characters that are not shared boilerplate", (t) => {
  const f = fixture(t);
  const { files, roots } = skillFiles([join(f.home, ".claude/skills"), join(f.home, ".codex/plugins"), join(f.home, "missing")]);
  assert.equal(roots, 2);
  assert.deepEqual(files.map(file => file.path.slice(f.home.length)).sort(),
    ["/.claude/skills/crane/Makefile", "/.claude/skills/crane/SKILL.md", "/.claude/skills/crane/references/more.md",
      "/.claude/skills/crane/references/notice-and-consent.md", "/.claude/skills/crane/scripts/license-check.py",
      "/.claude/skills/crane/scripts/tool.mjs", "/.claude/skills/crane/templates/page.html", "/.codex/plugins/cache/kit/skills/jar/SKILL.md"]);
  const index = skillIndex(files);
  assert.equal(index.count, 9);
  assert.equal(skillMatch('<meta name="description" content="The paper crane template greets every reader with a fold">', index), "crane");
  assert.equal(skillMatch("Ask the paper crane politely before folding its wings back along the crease", index), "crane");
  assert.equal(skillMatch("print('A crane may only be folded by someone who has thanked the paper first')", index), "crane");
  assert.equal(skillMatch("\t@echo crease the wing twice and let the crane rest beside the teapot", index), "crane");
  assert.equal(skillMatch("<p>The paper crane template greets the reader with a folded welcome banner here</p>", index), "crane");
  for (const line of ['<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1, some-longer-value-here">',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">',
    '<link rel="icon" href="https://cdn.example.com/a-long-icon-path/favicon-32x32.png" sizes="32x32">',
    '<link rel="dns-prefetch" href="https://cdn.example.com/a-long-path-for-the-prefetch-hint">',
    '<link rel="preload" href="https://cdn.example.com/fonts/a-long-font-name-regular.woff2" as="font">',
    "generated line 0 that every project which installs the same package shares",
    'licence line 0: THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
    "Licence: anyone may fold this paper crane freely, with no promise it will ever fly",
    "How to license the paper crane pattern when you sell a folded copy of it"])
    assert.equal(skillMatch(line, index), "", line);
  assert.equal(skillMatch(`  const fold = "Unfold the crane's left wing slowly and press the crease flat with a spoon"; // copied`, index), "crane");
  assert.equal(skillMatch('    <meta name="viewport" content="width=device-width, initial-scale=1">', index), "");
  assert.equal(skillMatch(`    // quoted: ${secret} (end)`, index), "crane");
  assert.equal(skillMatch("short line", index), "");
  assert.equal(skillMatch(secret.slice(0, 50), index), "");
});

test("a tracked SKILL.md or skills/ file fails the path check, also with --paths-only and without skill folders", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "notes/skills/crane.md"), "x\n");
  f.put(join(f.repo, "deep/SKILL.md"), "x\n");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "skills");
  for (const result of [f.run(["--paths-only"]), f.run(["--base", "HEAD~1"], { HOME: join(f.home, "nobody") })]) {
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /problem: deep\/SKILL\.md: a skill file or skills\/ folder is tracked/);
    assert.match(result.stderr, /problem: notes\/skills\/crane\.md: /);
    assert.match(result.stdout, /RESULT: fail skill-guard 2 problem\(s\); paid skills never go in a repo\n$/);
  }
});

test("a changed line holding a skill line fails with its place and the skill's name, never the text", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "docs/guide.md"), `# Guide\n\nkeep this\n  * ${secret}\n`);
  f.git("add", "."); f.git("commit", "-q", "-m", "guide");
  f.put(join(f.repo, "staged.txt"), `${other}\n`); f.git("add", "staged.txt");
  f.put(join(f.repo, "untracked.md"), `The jar skill keeps its own long line here so plugins are read too, okay\n`);
  const result = f.run(["--base", "HEAD~1"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /problem: docs\/guide\.md:4: holds a line from the local skill crane\n/);
  assert.match(result.stderr, /problem: staged\.txt:1: holds a line from the local skill crane\n/);
  assert.match(result.stderr, /problem: untracked\.md:1: holds a line from the local skill jar\n/);
  assert.doesNotMatch(result.stdout + result.stderr, /paper crane|marbles|own long line/);
  assert.match(result.stdout, /RESULT: fail skill-guard 3 problem/);
});

test("a project's own licence passes whatever licence text it holds, and a skill line in any other file still fails", (t) => {
  const f = fixture(t);
  const project = `MIT License\n\nCopyright (c) 2026 Someone\n\n${licenceText}\n`;
  f.put(join(f.repo, "docs/credits.md"), `# Credits\n\n${licenceText}\n`);
  f.put(join(f.repo, "LICENSE"), project);
  f.git("add", "."); f.git("commit", "-q", "-m", "licence");
  const own = f.run(["--base", "HEAD~1"]);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /RESULT: ok skill-guard\n$/);
  assert.equal(f.run(["--history"]).status, 0);

  // A project's own licence file is never read, committed, staged or untracked, so its text matching a skill's
  // licence under a name not yet known passes too; any other file holding it still fails.
  f.put(join(f.home, ".claude/skills/crane/LEGAL-TERMS.md"), `${licenceText}\n`);
  f.put(join(f.repo, "LICENSE.md"), project);
  f.git("add", "."); f.git("commit", "-q", "-m", "more licences");
  f.put(join(f.repo, "COPYING"), project); f.git("add", "COPYING");
  f.put(join(f.repo, "LICENSE"), `${project}${licenceText}\n`);
  f.put(join(f.repo, "LICENSE-APACHE"), project);
  f.put(join(f.repo, "notes.md"), `${licenceText}\n`);
  const unknown = f.run(["--base", "HEAD~2"]);
  assert.equal(unknown.status, 1, unknown.stderr);
  assert.equal(unknown.stderr, "problem: docs/credits.md:3: holds a line from the local skill crane\nproblem: notes.md:1: holds a line from the local skill crane\n");
  // --history reads every blob, the project's licence files too.
  const history = f.run(["--history"]);
  assert.equal(history.status, 1, history.stderr);
  assert.match(history.stderr, /problem: LICENSE@[0-9a-f]{9}:5: holds a line from the local skill crane\n/);
  assert.match(history.stderr, /problem: docs\/credits\.md@[0-9a-f]{9}:3: holds a line from the local skill crane\n/);

  // A file named like a licence, a NOTICE, or a licence below the top folder is read like any other.
  f.git("rm", "-q", "-f", "docs/credits.md", "COPYING");
  rmSync(join(f.repo, "notes.md"));
  rmSync(join(f.repo, "LICENSE-APACHE"));
  f.git("checkout", "-q", "LICENSE");
  f.put(join(f.repo, "scripts/license-check.py"), `# ${secret}\n`);
  f.put(join(f.repo, "notice-and-consent.md"), `${other}\n`);
  f.put(join(f.repo, "docs/choose-a-license.md"), `${secret}\n`);
  f.put(join(f.repo, "docs/NOTICE.md"), `${secret}\n`);
  f.put(join(f.repo, "packages/a/LICENSE.md"), `${secret}\n`);
  f.git("add", "."); f.git("commit", "-q", "-m", "named like a licence");
  const copied = f.run(["--base", "HEAD~3"]);
  assert.equal(copied.status, 1, copied.stderr);
  assert.equal(copied.stderr, ["docs/NOTICE.md", "docs/choose-a-license.md", "notice-and-consent.md", "packages/a/LICENSE.md", "scripts/license-check.py"]
    .map(path => `problem: ${path}:1: holds a line from the local skill crane\n`).join(""));
  assert.doesNotMatch(copied.stdout + copied.stderr, /paper crane|marbles|fold it again/);
});

test("without local skill folders the line check is skipped and says so; a clean change passes", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "a.md"), `${secret}\n`);
  f.git("add", "."); f.git("commit", "-q", "-m", "a");
  const skipped = f.run(["--base", "HEAD~1"], { HOME: join(f.home, "nobody") });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(skipped.stdout, "skill-guard: line check: skipped (no local skill folders)\nRESULT: ok skill-guard\n");
  f.put(join(f.repo, "b.md"), "A line of plain project text that is long enough to be compared with skills\n");
  f.git("add", "b.md"); f.git("commit", "-q", "-m", "b");
  const clean = f.run(["--base", "HEAD~1"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^skill-guard: line check: \d+ lines against 9 skill lines from 8 skill files\nRESULT: ok skill-guard\n$/);
});

test("--history checks every path, blob and commit message any ref ever held", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "old.md"), `${secret}\n`);
  f.git("add", "."); f.git("commit", "-q", "-m", "old");
  f.git("rm", "-q", "old.md"); f.git("commit", "-q", "-m", `gone\n\n${other}`);
  f.git("checkout", "-q", "-b", "side");
  f.put(join(f.repo, "skills/x.md"), "x\n"); f.git("add", "-f", "."); f.git("commit", "-q", "-m", "side");
  f.git("rm", "-q", "-r", "skills"); f.git("commit", "-q", "-m", "drop");
  f.git("checkout", "-q", "main");
  assert.equal(f.run(["--base", "HEAD~1"]).status, 0);
  const result = f.run(["--history"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /problem: skills\/x\.md: a skill file or skills\/ folder in history\n/);
  assert.match(result.stderr, /problem: old\.md@[0-9a-f]{9}:1: holds a line from the local skill crane\n/);
  assert.match(result.stderr, /problem: commit [0-9a-f]{9}:3: holds a line from the local skill crane\n/);
  assert.doesNotMatch(result.stdout + result.stderr, /paper crane|marbles/);
});

test("KIT_SKILL_DIRS names the skill folders instead of HOME's; bad arguments are a usage error", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "a.md"), `${secret}\n`);
  f.git("add", "."); f.git("commit", "-q", "-m", "a");
  assert.equal(f.run(["--base", "HEAD~1"], { KIT_SKILL_DIRS: join(f.home, ".codex/plugins") }).status, 0);
  assert.equal(f.run(["--base", "HEAD~1"], { KIT_SKILL_DIRS: join(f.home, ".claude/skills") }).status, 1);
  for (const args of [["--base"], ["--what"], ["--base", "HEAD", "--history"]]) {
    const result = f.run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /^Usage: skill-guard\.mjs/);
    assert.equal(result.stdout, "RESULT: fail skill-guard usage\n");
  }
  const missing = f.run([]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /the line check needs --base REF or --history \(or --paths-only\)/);
});

test("skillGuard.allow names a project's own skill folders; an entry that is not one skill folder is a problem", (t) => {
  const f = fixture(t);
  assert.deepEqual(allowedSkills(f.repo), { allow: [], problems: [] });
  const settings = (allow: unknown) => f.put(join(f.repo, "scripts/agents/kit.json"), JSON.stringify({ project: "p", skillGuard: { allow } }));
  settings([".claude/skills/heron/", ".claude/skills/heron", "notes/skills/owl"]);
  assert.deepEqual(allowedSkills(f.repo), { allow: [".claude/skills/heron", "notes/skills/owl"], problems: [] });
  for (const path of [".claude/skills/heron/SKILL.md", ".claude/skills/heron/references/a.md", "notes/skills/owl/SKILL.md"]) assert.ok(allowedPath(path, [".claude/skills/heron", "notes/skills/owl"]), path);
  for (const path of [".claude/skills/heron-two/SKILL.md", ".claude/skills/SKILL.md", "skills/heron/SKILL.md", ".claude/skills/heron",
    ".claude/skills/heron/skills/paid/SKILL.md", ".claude/skills/heron/Skills/x.md", ".claude/skills/heron/nested/SKILL.md"])
    assert.equal(allowedPath(path, [".claude/skills/heron"]), false, path);
  settings(["skills", ".claude/skills/", "/abs/skills/x", "../up/skills/x", "./skills/x", "a//b", "", ".", 7, "skills/skills"]);
  const bad = allowedSkills(f.repo);
  assert.deepEqual(bad.allow, []);
  assert.equal(bad.problems.length, 10);
  // A repo of skills names each by its top folder; a parent folder lets only its own SKILL.md through, never a skill below it.
  settings(["heron", "skills/heron", ".claude"]);
  assert.deepEqual(allowedSkills(f.repo), { allow: ["heron", "skills/heron", ".claude"], problems: [] });
  for (const path of ["heron/SKILL.md", "heron/references/a.md", ".claude/SKILL.md"]) assert.ok(allowedPath(path, ["heron", ".claude"]), path);
  for (const path of [".claude/skills/paid/SKILL.md", ".claude/notes/SKILL.md", "heron/skills/paid/x.md"]) assert.equal(allowedPath(path, ["heron", ".claude"]), false, path);
  assert.match(bad.problems[0], /^scripts\/agents\/kit\.json: skillGuard\.allow entry "skills" is not one skill folder's repo path$/);
  settings(null);
  assert.deepEqual(allowedSkills(f.repo), { allow: [], problems: [] });
  settings(".claude/skills/heron");
  assert.deepEqual(allowedSkills(f.repo).problems, ["scripts/agents/kit.json: skillGuard.allow must be a list of skill folder paths"]);
});

test("an allowed own skill passes the path check, yet a local skill's line inside it fails and unlisted skill paths still fail", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "scripts/agents/kit.json"), JSON.stringify({ project: "p", branches: { land: "main" }, skillGuard: { allow: [".claude/skills/heron"] } }));
  f.git("add", "."); f.git("commit", "-q", "-m", "settings");
  f.put(join(f.repo, ".claude/skills/heron/SKILL.md"), "---\nname: heron\n---\nThe heron waits in the reeds until the river forgets it was ever there at all\n");
  f.put(join(f.repo, ".claude/skills/heron/references/fish.md"), "A short note.\n");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "own skill");
  const own = f.run(["--base", "HEAD~1"]);
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stdout, /^skill-guard: line check: \d+ lines against 9 skill lines from 8 skill files\nskill-guard: allowed own skills: \.claude\/skills\/heron \(skillGuard\.allow; lines still checked\)\nRESULT: ok skill-guard\n$/);
  assert.equal(f.run(["--paths-only"]).status, 0);

  f.put(join(f.repo, ".claude/skills/heron/references/fish.md"), `A short note.\n${secret}\n`);
  f.put(join(f.repo, ".claude/skills/egret/SKILL.md"), "x\n");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "copied");
  const copied = f.run(["--base", "HEAD~2"]);
  assert.equal(copied.status, 1, copied.stderr);
  assert.match(copied.stderr, /problem: \.claude\/skills\/egret\/SKILL\.md: a skill file or skills\/ folder is tracked\n/);
  assert.match(copied.stderr, /problem: \.claude\/skills\/heron\/references\/fish\.md:2: holds a line from the local skill crane\n/);
  assert.doesNotMatch(copied.stderr, /heron\/SKILL\.md/);
  assert.doesNotMatch(copied.stdout + copied.stderr, /paper crane/);
  assert.match(copied.stdout, /RESULT: fail skill-guard 2 problem/);

  f.git("rm", "-q", "-r", ".claude/skills/egret"); f.git("checkout", "-q", "HEAD~1", "--", ".claude/skills/heron/references/fish.md");
  f.put(join(f.repo, ".claude/skills/heron/skills/paid/SKILL.md"), "x\n");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "nested");
  const nested = f.run(["--paths-only"]);
  assert.equal(nested.status, 1, nested.stderr);
  assert.equal(nested.stderr, "problem: .claude/skills/heron/skills/paid/SKILL.md: a skill file or skills/ folder is tracked\n");

  f.put(join(f.repo, "scripts/agents/kit.json"), JSON.stringify({ project: "p", branches: { land: "main" }, skillGuard: { allow: [".claude"] } }));
  const parent = f.run(["--paths-only"]);
  assert.equal(parent.status, 1);
  assert.match(parent.stderr, /problem: \.claude\/skills\/heron\/SKILL\.md: a skill file or skills\/ folder is tracked\n/);
  assert.match(parent.stderr, /problem: \.claude\/skills\/heron\/skills\/paid\/SKILL\.md: /);
  f.put(join(f.repo, "scripts/agents/kit.json"), JSON.stringify({ project: "p", branches: { land: "main" }, skillGuard: { allow: [".claude/skills"] } }));
  const wide = f.run(["--paths-only"]);
  assert.equal(wide.status, 1);
  assert.match(wide.stderr, /problem: scripts\/agents\/kit\.json: skillGuard\.allow entry "\.claude\/skills" is not one skill folder's repo path\n/);
  assert.match(wide.stderr, /problem: \.claude\/skills\/heron\/SKILL\.md: a skill file or skills\/ folder is tracked\n/);
});

test("--history lets an allowed own skill's past paths through and still names every other skill path", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, "scripts/agents/kit.json"), JSON.stringify({ project: "p", skillGuard: { allow: ["notes/skills/heron"] } }));
  f.put(join(f.repo, "notes/skills/heron/SKILL.md"), "x\n");
  f.put(join(f.repo, "notes/skills/egret/SKILL.md"), "x\n");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "skills");
  f.git("rm", "-q", "-r", "notes/skills/egret"); f.git("commit", "-q", "-m", "drop egret");
  const result = f.run(["--history"]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, "problem: notes/skills/egret/SKILL.md: a skill file or skills/ folder in history\n");
  assert.match(result.stdout, /^skill-guard: line check: \d+ lines against 9 skill lines from 8 skill files\nskill-guard: allowed own skills: notes\/skills\/heron \(skillGuard\.allow; lines still checked\)\n/);
});

test("a broken settings file allows nothing, and the kit's own repo refuses the list (its kit.json never sets one)", (t) => {
  const f = fixture(t);
  f.put(join(f.repo, ".claude/skills/heron/SKILL.md"), "x\n");
  f.put(join(f.repo, "scripts/agents/kit.json"), "{");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "broken settings");
  const broken = f.run(["--paths-only"]);
  assert.equal(broken.status, 1);
  assert.equal(broken.stderr, "problem: .claude/skills/heron/SKILL.md: a skill file or skills/ folder is tracked\n");

  f.put(join(f.repo, "scripts/agents/kit.json"), JSON.stringify({ project: "agent-kit", skillGuard: { allow: [".claude/skills/heron"] } }));
  f.put(join(f.repo, "skill-guard.mjs"), "\n"); f.put(join(f.repo, "kit.d/doctor"), "\n");
  f.git("add", "-f", "."); f.git("commit", "-q", "-m", "kit");
  const kit = f.run(["--paths-only"]);
  assert.equal(kit.status, 1);
  assert.equal(kit.stderr, "problem: scripts/agents/kit.json: skillGuard.allow is refused in the kit's own repo, which never keeps a skill\n" +
    "problem: .claude/skills/heron/SKILL.md: a skill file or skills/ folder is tracked\n");
  assert.equal(JSON.parse(readFileSync(resolve("scripts/agents/kit.json"), "utf8")).skillGuard, undefined);
});
