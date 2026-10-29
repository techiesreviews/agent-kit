import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { normalLine, skillFiles, skillIndex, skillMatch, skillPath } from "../skill-guard.mjs";
import { kitEnv } from "./support/kit-env.ts";

const guard = resolve("skill-guard.mjs");
// Made-up skill text: never a line from a real skill.
const secret = "Fold the paper crane twice along the moonlit diagonal before the kettle sings";
const other = "Count seven marbles into the blue jar and whisper the inventory to the cat";

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
  // Licence texts are word for word in many repos; page set-up tags in a template are in every web page.
  put(join(home, ".claude/skills/crane/LICENSE"), "Licence: anyone may fold this paper crane freely, with no promise it will ever fly\n");
  put(join(home, ".claude/skills/crane/templates/page.html"), [
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1, some-longer-value-here">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">',
    "<p>The paper crane template greets the reader with a folded welcome banner here</p>",
  ].join("\n") + "\n");
  // An extensionless file that is not a licence still counts.
  put(join(home, ".claude/skills/crane/Makefile"), "fold:\n\t@echo crease the wing twice and let the crane rest beside the teapot\n");
  // Files only named like a licence are skill text and are read.
  put(join(home, ".claude/skills/crane/references/notice-and-consent.md"), "Ask the paper crane politely before folding its wings back along the crease\n");
  put(join(home, ".claude/skills/crane/scripts/license-check.py"), "print('A crane may only be folded by someone who has thanked the paper first')\n");
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
  assert.equal(index.count, 8);
  assert.equal(skillMatch("Ask the paper crane politely before folding its wings back along the crease", index), "crane");
  assert.equal(skillMatch("print('A crane may only be folded by someone who has thanked the paper first')", index), "crane");
  assert.equal(skillMatch("\t@echo crease the wing twice and let the crane rest beside the teapot", index), "crane");
  assert.equal(skillMatch("<p>The paper crane template greets the reader with a folded welcome banner here</p>", index), "crane");
  for (const line of ['<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    '<meta http-equiv="X-UA-Compatible" content="IE=edge,chrome=1, some-longer-value-here">',
    '    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">',
    "Licence: anyone may fold this paper crane freely, with no promise it will ever fly"])
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
  assert.match(clean.stdout, /^skill-guard: line check: \d+ lines against 8 skill lines from 8 skill files\nRESULT: ok skill-guard\n$/);
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
