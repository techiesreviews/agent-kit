import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { kitEnv } from "./support/kit-env.ts";

// Run before anything reads the shell's own route switch.
delete process.env.KIT_API_KEY_FILE; delete process.env.KIT_API_CONFIG_DIR;

// kit ask (Lex, 2026-11-06): a one-shot headless Claude call on the opt-in API credit route, with a script mode that
// puts Lex's script rules in front of the prompt. Every key here is made up and `claude` is a fake on PATH.
const kit = resolve("kit");
const secret = "sk-ant-test-ask-0123456789-not-a-real-key";

function folder(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "kit-ask-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin"), home = join(dir, "home"), state = join(dir, "state"), rules = join(dir, "youtube"), work = join(dir, "work");
  for (const path of [bin, home, state, work, join(rules, "shared/taste")]) mkdirSync(path, { recursive: true });
  const keyFile = join(dir, "key");
  writeFileSync(keyFile, `${secret}\n`, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  writeFileSync(join(rules, "AGENTS.md"), "# Youtube agents\nVOICE: plain, warm, short.\n");
  writeFileSync(join(rules, "shared/taste/scripts.md"), "# Taste · scripts\n\nintro line\n\n## Current script and prompter playbook\n\nPLAYBOOK: open with the question.\n\n### Sub rule\nkeep hooks under 8 seconds.\n\n## Rules learned from Lex's feedback\n\nOTHER SECTION: must not be included.\n");
  // A fake claude: records its arguments and stdin, then answers like `claude -p --output-format json` (or fails like an empty account).
  const calls = join(dir, "calls.jsonl");
  writeFileSync(join(bin, "package.json"), '{"type":"module"}');
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2), input = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input, keyMatches: process.env.ANTHROPIC_API_KEY === ${JSON.stringify(secret)}, configDir: process.env.CLAUDE_CONFIG_DIR, orbitRole: process.env.ORBIT_ROLE ?? null }) + "\\n");
if (process.env.FAKE_EMPTY_ACCOUNT) { console.log(JSON.stringify({ is_error: true, result: "Credit balance is too low" })); process.exit(1); }
console.log(JSON.stringify({ result: process.env.FAKE_ANSWER ?? "The drafted answer.\\n", modelUsage: { "claude-sonnet-5-5": {} }, usage: { input_tokens: 200, output_tokens: 50 }, total_cost_usd: 0.0456 }));
`);
  chmodSync(join(bin, "claude"), 0o755);
  const prompt = join(work, "prompt.md");
  writeFileSync(prompt, "WRITE: a 60-second script about backups.\n");
  const env = { ...kitEnv(), HOME: home, XDG_STATE_HOME: state, KIT_SCRIPT_RULES_ROOT: rules, PATH: `${bin}:${process.env.PATH}` } as NodeJS.ProcessEnv;
  const on = { ...env, KIT_API_KEY_FILE: keyFile };
  const ask = (args: string[], extra: NodeJS.ProcessEnv = on) => spawnSync(kit, ["ask", ...args], { cwd: work, env: { ...extra }, encoding: "utf8", timeout: 60_000 });
  const callList = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const spend = () => existsSync(join(state, "agent-kit/api-spend.log")) ? readFileSync(join(state, "agent-kit/api-spend.log"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  return { dir, work, rules, prompt, keyFile, env, on, ask, callList, spend };
}
const last = (stdout: string) => stdout.trimEnd().split("\n").at(-1)!;

test("kit ask needs --api and the opt-in route: without either it stops in plain words and runs nothing", t => {
  const f = folder(t);
  const noFlag = f.ask(["--prompt-file", f.prompt]);
  assert.equal(noFlag.status, 2, noFlag.stdout + noFlag.stderr);
  assert.match(last(noFlag.stdout), /^RESULT: fail ask needs --api \(it runs on the API credit route, not the subscription\)$/);
  const off = f.ask(["--api", "--prompt-file", f.prompt], f.env);
  assert.equal(off.status, 1);
  assert.match(last(off.stdout), /^RESULT: fail ask the API route is off: set KIT_API_KEY_FILE \(see the README, "Spending API credit"\)$/);
  const bad = join(f.dir, "open-key"); writeFileSync(bad, `${secret}\n`); chmodSync(bad, 0o644);
  const unsafe = f.ask(["--api", "--prompt-file", f.prompt], { ...f.env, KIT_API_KEY_FILE: bad });
  assert.equal(unsafe.status, 1);
  assert.match(last(unsafe.stdout), /^RESULT: fail ask .*can be read by others \(mode 644\); run chmod 600 on it$/);
  assert.deepEqual(f.callList(), []);
  assert.ok(!(noFlag.stdout + off.stdout + unsafe.stdout + unsafe.stderr).includes(secret));
});

test("kit ask --api sends the prompt on stdin to claude -p on the route, prints the answer, and logs the spend", t => {
  const f = folder(t);
  const run = f.ask(["--api", "--prompt-file", f.prompt]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const [call] = f.callList();
  assert.equal(call.input, "WRITE: a 60-second script about backups.\n");
  assert.deepEqual(call.args.slice(0, 3), ["-p", "--model", "claude-sonnet-5-5"]);
  assert.ok(call.args.includes("--output-format") && call.args.includes("json"));
  assert.ok(!call.args.join(" ").includes("WRITE:") && !call.args.join(" ").includes(secret), "no prompt or key on the command line");
  assert.equal(call.keyMatches, true);
  assert.equal(call.configDir, join(f.env.HOME!, ".claude-api"));
  assert.equal(run.stdout.split("\n").slice(0, 1)[0], "The drafted answer.");
  assert.match(last(run.stdout), /^RESULT: ok ask claude-sonnet-5-5 \$0\.0456, 250 tokens$/);
  assert.ok(!(run.stdout + run.stderr).includes(secret));
  const [line] = f.spend();
  assert.equal(line.command, "ask"); assert.equal(line.model, "claude-sonnet-5-5"); assert.equal(line.cost_usd, 0.0456); assert.equal(line.ok, true);
});

test("the call never inherits a lead's ORBIT_ROLE: only leads write to Orbit", t => {
  const f = folder(t);
  const output = f.ask(["--api", "--prompt-file", f.prompt], { ...f.on, ORBIT_ROLE: "lead" });
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.equal(f.callList()[0].orbitRole, null);
});

test("--model takes sonnet, opus, haiku or a claude- id, and nothing else", t => {
  const f = folder(t);
  for (const [name, id] of [["opus", "claude-opus-5-5"], ["haiku", "claude-haiku-5-5"], ["sonnet", "claude-sonnet-5-5"], ["claude-opus-5-5", "claude-opus-5-5"]]) {
    assert.equal(f.ask(["--api", "--prompt-file", f.prompt, "--model", name]).status, 0, name);
    assert.equal(f.callList().at(-1).args[2], id);
  }
  for (const odd of ["constructor", "__proto__", "toString"]) assert.equal(f.ask(["--api", "--prompt-file", f.prompt, "--model", odd]).status, 2, odd);
  const wrong = f.ask(["--api", "--prompt-file", f.prompt, "--model", "gpt-9"]);
  assert.equal(wrong.status, 2);
  assert.match(last(wrong.stdout), /^RESULT: fail ask --model must be sonnet, opus, haiku or a claude- model id, not gpt-9$/);
  assert.equal(f.callList().length, 4);
});

test("a missing prompt file, no --prompt-file and an unknown option stop in plain words", t => {
  const f = folder(t);
  assert.match(last(f.ask(["--api", "--prompt-file", join(f.work, "nope.md")]).stdout), /^RESULT: fail ask cannot read the prompt file .*nope\.md$/);
  assert.match(last(f.ask(["--api"]).stdout), /^RESULT: fail ask needs --prompt-file <file>$/);
  const odd = f.ask(["--api", "--prompt-file", f.prompt, "--surprise"]);
  assert.equal(odd.status, 2);
  assert.match(last(odd.stdout), /^RESULT: fail ask unknown option --surprise$/);
  assert.deepEqual(f.callList(), []);
});

test("--script puts AGENTS.md and only the playbook section of scripts.md in front of the prompt, and writes the answer to the file asked for", t => {
  const f = folder(t);
  const out = join(f.work, "script-out.md");
  const run = f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const [call] = f.callList();
  const input: string = call.input;
  assert.ok(input.includes("VOICE: plain, warm, short."));
  assert.ok(input.includes("PLAYBOOK: open with the question.") && input.includes("keep hooks under 8 seconds."), "the playbook section, sub-sections included");
  assert.ok(!input.includes("OTHER SECTION"), "no other section");
  assert.ok(input.indexOf("VOICE:") < input.indexOf("PLAYBOOK:") && input.indexOf("PLAYBOOK:") < input.indexOf("WRITE:"), "rules first, the prompt last");
  assert.equal(readFileSync(out, "utf8"), "The drafted answer.\n");
  assert.equal(run.stdout.includes("The drafted answer."), false, "the answer goes to the file, not stdout");
  assert.match(last(run.stdout), new RegExp(`^RESULT: ok ask claude-sonnet-5-5 \\$0\\.0456, 250 tokens -> ${out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
});

test("--script needs --out, and stops without guessing when a rules file or the playbook heading is missing", t => {
  const f = folder(t);
  const noOut = f.ask(["--api", "--script", "--prompt-file", f.prompt]);
  assert.equal(noOut.status, 2);
  assert.match(last(noOut.stdout), /^RESULT: fail ask --script needs --out <file> \(where the script goes\)$/);
  const out = join(f.work, "o.md");
  rmSync(join(f.rules, "AGENTS.md"));
  const noAgents = f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]);
  assert.equal(noAgents.status, 1);
  assert.match(last(noAgents.stdout), /^RESULT: fail ask script rules missing: .*youtube\/AGENTS\.md cannot be read; nothing was sent$/);
  writeFileSync(join(f.rules, "AGENTS.md"), "rules\n");
  writeFileSync(join(f.rules, "shared/taste/scripts.md"), "# Taste\n\n## Something else\n");
  const noPlaybook = f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]);
  assert.equal(noPlaybook.status, 1);
  assert.match(last(noPlaybook.stdout), /^RESULT: fail ask script rules missing: .*scripts\.md has no "Current script and prompter playbook" section; nothing was sent$/);
  rmSync(join(f.rules, "shared/taste/scripts.md"));
  assert.match(last(f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]).stdout), /scripts\.md cannot be read; nothing was sent$/);
  assert.deepEqual(f.callList(), [], "claude never ran");
  assert.ok(!existsSync(out));
});

test("an existing output file is never overwritten: the answer goes beside it as a draft and the message says so", t => {
  const f = folder(t);
  const out = join(f.work, "script.md");
  writeFileSync(out, "the editor's newer edits\n");
  const run = f.ask(["--api", "--prompt-file", f.prompt, "--out", out]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.equal(readFileSync(out, "utf8"), "the editor's newer edits\n");
  const drafts = readdirSync(f.work).filter(name => /^script\.draft-\d{8}T\d{6}Z(-\d+)?\.md$/.test(name));
  assert.equal(drafts.length, 1, readdirSync(f.work).join(", "));
  assert.equal(readFileSync(join(f.work, drafts[0]), "utf8"), "The drafted answer.\n");
  assert.match(last(run.stdout), /^RESULT: ok ask claude-sonnet-5-5 \$0\.0456, 250 tokens -> .*script\.draft-.*\.md \(script\.md already exists and was not touched\)$/);
});

test("an empty API account is one plain failure, writes no file and still logs the call", t => {
  const f = folder(t);
  const out = join(f.work, "never.md");
  const run = f.ask(["--api", "--prompt-file", f.prompt, "--out", out], { ...f.on, FAKE_EMPTY_ACCOUNT: "1" });
  assert.equal(run.status, 1);
  assert.match(last(run.stdout), /^RESULT: fail ask Claude out of credit: API credit is used up \(Credit balance is too low\); add credit to the API account, or run this another way$/);
  assert.ok(!existsSync(out));
  assert.equal(f.spend().length, 1);
  assert.equal(f.spend()[0].ok, false);
});

test("kit ask --help is plain and lists the options", t => {
  const f = folder(t);
  const help = f.ask(["--help"], f.env);
  assert.equal(help.status, 0);
  for (const word of ["--api", "--prompt-file", "--model", "--script", "--out", "2026-11-11"]) assert.ok(help.stdout.includes(word), word);
});

test("a bad --out costs nothing, and a file that cannot be written after the call still shows the answer", t => {
  const f = folder(t);
  const blocker = join(f.work, "a-file"); writeFileSync(blocker, "x");
  const early = f.ask(["--api", "--prompt-file", f.prompt, "--out", join(blocker, "sub/out.md")]);
  assert.equal(early.status, 1);
  assert.match(last(early.stdout), /^RESULT: fail ask cannot make the folder for .*out\.md \(ENOTDIR\); nothing was sent$/);
  assert.deepEqual(f.callList(), []);
  // A folder nobody can write to is caught before the call too.
  const locked = join(f.work, "locked"); mkdirSync(locked); chmodSync(locked, 0o500);
  t.after(() => { try { chmodSync(locked, 0o700); } catch { /* The folder is already gone. */ } });
  const readOnly = f.ask(["--api", "--prompt-file", f.prompt, "--out", join(locked, "out.md")]);
  assert.equal(readOnly.status, 1, readOnly.stdout);
  assert.match(last(readOnly.stdout), /^RESULT: fail ask cannot make the folder for .*out\.md \(EACCES\); nothing was sent$/);
  assert.deepEqual(f.callList(), []);
  // A target that is itself a folder cannot be written either: the draft beside it takes the answer, nothing is lost.
  mkdirSync(join(f.work, "target-dir"));
  const beside = f.ask(["--api", "--prompt-file", f.prompt, "--out", join(f.work, "target-dir")]);
  assert.equal(beside.status, 0, beside.stdout);
});

test("the playbook section ends at the next real heading, not at a # line inside a code block", t => {
  const f = folder(t);
  writeFileSync(join(f.rules, "shared/taste/scripts.md"), "# Taste\n\n## Current script and prompter playbook\n\nTOP RULE.\n\n```sh\n# a comment, not a heading\n```\n\nAFTER FENCE RULE.\n\n## Next section\nNOT INCLUDED\n");
  assert.equal(f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", join(f.work, "o.md")]).status, 0);
  const input: string = f.callList()[0].input;
  assert.ok(input.includes("AFTER FENCE RULE.") && !input.includes("NOT INCLUDED"));
});

test("an empty answer is a failure that writes no file, and a bad KIT_ASK_TIMEOUT is a plain failure before any call", t => {
  const f = folder(t);
  const out = join(f.work, "blank.md");
  const blank = f.ask(["--api", "--prompt-file", f.prompt, "--out", out], { ...f.on, FAKE_ANSWER: "  \n" });
  assert.equal(blank.status, 1);
  assert.match(last(blank.stdout), /^RESULT: fail ask claude returned an empty answer \(the call was paid for and logged\); nothing was written$/);
  assert.ok(!existsSync(out));
  assert.equal(f.spend().length, 1);
  for (const value of ["-1", "0", "0.5", "abc"]) {
    const bad = f.ask(["--api", "--prompt-file", f.prompt], { ...f.on, KIT_ASK_TIMEOUT: value });
    assert.equal(bad.status, 2, value);
    assert.match(last(bad.stdout), /^RESULT: fail ask KIT_ASK_TIMEOUT must be a whole number of seconds, 1 or more/);
  }
  assert.equal(f.callList().length, 1);
});

test("a blank prompt file is refused before any call", t => {
  const f = folder(t);
  const blank = join(f.work, "blank-prompt.md"); writeFileSync(blank, " \n\n");
  const run = f.ask(["--api", "--prompt-file", blank]);
  assert.equal(run.status, 1);
  assert.match(last(run.stdout), /^RESULT: fail ask the prompt file .*blank-prompt\.md is blank; nothing was sent$/);
  assert.deepEqual(f.callList(), []);
});

test("script rules that are blank or have an empty playbook stop the call; a fence only closes on a matching fence", t => {
  const f = folder(t);
  const out = join(f.work, "o.md");
  writeFileSync(join(f.rules, "AGENTS.md"), "  \n");
  assert.match(last(f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]).stdout), /script rules missing: .*AGENTS\.md is blank; nothing was sent$/);
  writeFileSync(join(f.rules, "AGENTS.md"), "rules\n");
  writeFileSync(join(f.rules, "shared/taste/scripts.md"), "# T\n\n## Current script and prompter playbook\n\n## Next\ntext\n");
  assert.match(last(f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]).stdout), /has a "Current script and prompter playbook" heading with nothing under it; nothing was sent$/);
  assert.deepEqual(f.callList(), []);
  writeFileSync(join(f.rules, "shared/taste/scripts.md"), "# T\n\n## Current script and prompter playbook\n\nRULE A.\n\n~~~md\n```\n# still inside\n~~~\n\nRULE B.\n\n## Next\nNOT INCLUDED\n");
  assert.equal(f.ask(["--api", "--script", "--prompt-file", f.prompt, "--out", out]).status, 0);
  const input: string = f.callList()[0].input;
  assert.ok(input.includes("RULE B.") && input.includes("# still inside") && !input.includes("NOT INCLUDED"));
});
