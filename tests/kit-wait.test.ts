import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

const script = resolve("scripts/agents/kit.d/wait");
const kit = resolve("scripts/agents/kit");
const baseEnv = { ...process.env, ASE_OWNER: "wait-test", KIT_WAIT_POLL_MS: "50", KIT_WAIT_STATUS_MS: "60000" };
function temp(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "kit-wait-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function child(t: TestContext, command: string, args: string[], env = baseEnv, stdin: "ignore" | "pipe" = "ignore") {
  const process = spawn(command, args, { env, stdio: [stdin, "pipe", "pipe"] });
  t.after(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); });
  return process;
}
function collect(process: ChildProcess) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    process.stdout!.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    process.stderr!.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    process.on("error", reject);
    process.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
function run(t: TestContext, args: string[], env = baseEnv) {
  return collect(child(t, process.execPath, [script, ...args], env));
}
// Resolve with the next complete stdout line matching pattern that arrives after this call.
function nextLine(process: ChildProcess, pattern: RegExp) {
  return new Promise<string>((resolve, reject) => {
    const stream = process.stdout!.setEncoding("utf8");
    let buffer = "";
    const stop = () => { stream.off("data", read); stream.off("end", ended); };
    const read = (text: string) => {
      const lines = (buffer + text).split("\n");
      buffer = lines.pop()!;
      const found = lines.find((line) => pattern.test(line));
      if (found !== undefined) { stop(); resolve(found); }
    };
    const ended = () => { stop(); reject(new Error(`output ended before a line matching ${pattern}`)); };
    stream.on("data", read).on("end", ended);
  });
}
// Status every poll: each "waiting " line is printed after a full scan of the file and /proc.
function watchOutput(t: TestContext, file: string, quiet: string) {
  const wait = child(t, process.execPath, [script, "output", file, "--quiet", quiet], { ...baseEnv, KIT_WAIT_STATUS_MS: "1" });
  return { wait, output: collect(wait), scanned: () => nextLine(wait, /^waiting /) };
}
function result(output: { status: number | null; stdout: string; stderr: string }, status: number, pattern: RegExp) {
  assert.equal(output.status, status, output.stderr + output.stdout);
  const lines = output.stdout.trimEnd().split("\n");
  const results = lines.filter((line) => line.startsWith("RESULT: "));
  assert.equal(results.length, 1, output.stdout);
  assert.equal(lines.at(-1), results[0]);
  assert.match(results[0], pattern);
  return output.stdout;
}
function last20(stdout: string, prefix: string) {
  const lines = stdout.split("\n").filter((line) => line.startsWith(prefix));
  assert.deepEqual(lines, Array.from({ length: 20 }, (_, i) => `${prefix}${i + 11}`));
}

test("wait help covers each subcommand and kit lists its summary", async (t) => {
  assert.equal(readFileSync(script, "utf8").split("\n")[1], "// kit: wait for a process, an output file or CI checks");
  for (const kind of [[], ["pid"], ["output"], ["ci"]]) for (const flag of ["--help", "-h"]) {
    const output = await run(t, [...kind, flag]);
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, /Usage: kit wait pid/);
    assert.doesNotMatch(output.stdout, /RESULT:/);
  }
  const listing = spawnSync("/bin/bash", [kit], { encoding: "utf8" });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /wait\s+wait for a process, an output file or CI checks/);
  const help = spawnSync("/bin/bash", [kit, "wait", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.doesNotMatch(help.stdout, /RESULT:/);
});

test("pid waits for a child exit through the front door and reports owner and elapsed time", async (t) => {
  const sleeper = child(t, "/bin/sleep", ["0.3"]);
  const output = await collect(child(t, "/bin/bash", [kit, "wait", "pid", String(sleeper.pid), "--timeout", "2"]));
  result(output, 0, /ok pid \d+ exited after \d+(?:ms|s)/);
  assert.match(output.stdout, /^kit wait pid \d+ \(owner wait-test\)\n/);
});

test("pid timeout fails and idle status is rate limited", async (t) => {
  const sleeper = child(t, "/bin/sleep", ["10"]);
  const output = await run(t, ["pid", String(sleeper.pid), "--timeout", "1"]);
  result(output, 1, /still running, timed out after 1/);
  assert.doesNotMatch(output.stdout, /waiting /);
});

test("pid already absent succeeds and invalid usage exits 2", async (t) => {
  result(await run(t, ["pid", "2147483647"]), 0, /ok pid 2147483647 not running/);
  for (const args of [[], ["other"], ["pid", "no"], ["pid"], ["pid", "1", "--timeout", "bad"],
    ["pid", "1", "--timeout", "0"], ["pid", "1", "--quiet", "1"], ["output", "x", "--until", "["],
    ["ci", "--pr", "x"], ["ci", "--sha", "abcd"], ["ci", "--branch", "dev", "--pr", "1"],
    ["ci", "--timeout"], ["ci", "--timeout", "1", "--timeout", "2"]]) {
    const output = await run(t, args);
    result(output, 2, /fail /);
    assert.notEqual(output.stderr, "");
  }
  for (const duration of ["90s", "30m", "1h", "90"]) {
    result(await run(t, ["pid", "2147483647", "--timeout", duration]), 0, /not running/);
  }
});

test("output regex waits for creation and an appended multiline match", async (t) => {
  const file = join(temp(t), "output");
  const pending = run(t, ["output", file, "--until", "^done$", "--timeout", "2s"]);
  child(t, process.execPath, ["-e", 'const fs = require("fs"); setTimeout(() => fs.appendFileSync(process.argv[1], "start\\ndone\\n"), 200)', file]);
  const output = await pending;
  result(output, 0, /matched \/\^done\$\/ after /);
  assert.equal(output.stdout.split("\n").filter((line) => line === "done").length, 1);
});

test("output quiet completion prints only the final 20 lines once", async (t) => {
  const file = join(temp(t), "output");
  writeFileSync(file, Array.from({ length: 30 }, (_, i) => `line-${i + 1}\n`).join(""));
  const output = await run(t, ["output", file, "--quiet", "0.1s", "--timeout", "2"]);
  result(output, 0, /finished after /);
  last20(output.stdout, "line-");
});

test("output stays pending while a live writer holds an unchanged file open", async (t) => {
  const file = join(temp(t), "output");
  const released = `${file}.released`;
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "held\\n"); console.log("ready"); setTimeout(() => { fs.writeFileSync(process.argv[2], "released"); fs.closeSync(fd); }, 500)', file, released]);
  await once(writer.stdout!, "data");
  const output = await run(t, ["output", file, "--quiet", "0.05s", "--timeout", "2"]);
  result(output, 0, /finished after /);
  assert.equal(readFileSync(released, "utf8"), "released", "wait must not finish before the writer releases its file");
});

test("output waits for a producer that closes the file and appends again before exiting", async (t) => {
  const file = join(temp(t), "output");
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "w"); fs.writeSync(fd, "first\\n"); console.log("ready"); require("readline").createInterface({ input: process.stdin }).on("line", (step) => { if (step === "close") { fs.closeSync(fd); console.log("closed"); } else { fs.appendFileSync(process.argv[1], "second\\n"); process.exit(0); } })', file], baseEnv, "pipe");
  await nextLine(writer, /^ready$/);
  const { output, scanned } = watchOutput(t, file, "0.05s");
  await scanned(); // The wait has seen the writer holding the file.
  writer.stdin!.write("close\n");
  await nextLine(writer, /^closed$/);
  await scanned(); // Closed but alive: the wait keeps going well past its quiet period.
  const exited = once(writer, "exit");
  writer.stdin!.write("append\n");
  const finished = result(await output, 0, /finished after /);
  assert.match(finished, /first\nsecond\nRESULT:/, "wait must not finish before the producer appends and exits");
  assert.deepEqual(await exited, [0, null]);
});

test("output size changes restart the quiet period", async (t) => {
  const file = join(temp(t), "output");
  writeFileSync(file, "before\n");
  const writer = child(t, process.execPath, ["-e", 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "a"); console.log("ready"); process.stdin.once("data", () => { const before = Date.now(); fs.writeSync(fd, "after\\n"); console.log(before); process.exit(0); })', file], baseEnv, "pipe");
  await nextLine(writer, /^ready$/);
  const { output, scanned } = watchOutput(t, file, "0.3s");
  await scanned(); // The wait has recorded the first size and seen the writer.
  const exited = once(writer, "exit");
  const appended = nextLine(writer, /^\d+$/);
  writer.stdin!.write("append\n");
  const appendedAt = Number(await appended);
  const finished = result(await output, 0, /finished after /);
  // The change is seen no earlier than appendedAt, and a full quiet period must follow it.
  assert.ok(Date.now() - appendedAt >= 300, `finished ${Date.now() - appendedAt}ms after the append`);
  assert.match(finished, /before\nafter\nRESULT:/);
  assert.deepEqual(await exited, [0, null]);
});

test("output timeout names missing files and prints existing content once", async (t) => {
  const file = join(temp(t), "output");
  const missing = await run(t, ["output", file, "--timeout", "0.15s"]);
  result(missing, 1, /output .* timed out after 0.15s/);
  writeFileSync(file, "unfinished\n");
  const output = await run(t, ["output", file, "--until", "done", "--timeout", "0.15s"]);
  result(output, 1, /timed out after 0.15s/);
  assert.equal(output.stdout.split("\n").filter((line) => line === "unfinished").length, 1);
});

const head = "abcdef0123456789abcdef0123456789abcdef01";
const newer = "123456789abcdef0123456789abcdef0123456789";
function fakeGh(t: TestContext, mode: string) {
  const directory = temp(t);
  const fake = join(directory, "gh");
  // Bash fixture dispatches only reads, recording every argv and moving its head via a counter.
  writeFileSync(fake, `#!/bin/bash
set -eu
[[ $GH_PAGER == cat && $NO_COLOR == 1 ]]
printf '%s\\n' "$*" >> "$WAIT_FIXTURE/calls"
count=0
[[ ! -f $WAIT_FIXTURE/count ]] || read -r count < "$WAIT_FIXTURE/count"
old=${head}
new=${newer}
case "$1 $2" in
  'api repos/{owner}/{repo}/commits/dev'|'api repos/{owner}/{repo}/commits/feature%2Fwork')
    count=$((count + 1)); printf '%s\\n' "$count" > "$WAIT_FIXTURE/count"
    if [[ $WAIT_MODE == error ]]; then printf 'fixture gh failure\\nsecond error line\\n' >&2; exit 1; fi
    if [[ $WAIT_MODE == pinned || ( ( $WAIT_MODE == superseded || $WAIT_MODE == moved ) && $count -gt 1 ) ]]; then echo "$new"; else echo "$old"; fi ;;
  'api repos/{owner}/{repo}/commits/abcdef0') echo "$old" ;;
  'pr view')
    [[ $3 == 42 && $4 == --json && $5 == headRefName,headRefOid ]]
    echo '{"headRefName":"feature/work","headRefOid":"${head}"}' ;;
  'workflow list') echo '[{"id":1,"name":"Checks","state":"active"}]' ;;
  'run list')
    if [[ $* == *'--json headBranch'* ]]; then
      count=$((count + 1)); printf '%s\\n' "$count" > "$WAIT_FIXTURE/count"
      if [[ $WAIT_MODE == no-runs || ( $WAIT_MODE == sha-empty && $count -eq 1 ) ]]; then echo '[]'; else echo '[{"headBranch":"dev"}]'; fi
      exit
    fi
    sha=$old
    [[ $* != *"--commit $new"* ]] || sha=$new
    status=completed; conclusion=success
    [[ $WAIT_MODE != failed ]] || conclusion=failure
    [[ $WAIT_MODE != cancelled ]] || conclusion=cancelled
    if [[ $WAIT_MODE == superseded && $sha == "$old" ]]; then conclusion=cancelled; fi
    if [[ $WAIT_MODE == pending ]]; then status=in_progress; conclusion=''; fi
    if [[ $WAIT_MODE == moved && ! -f $WAIT_FIXTURE/listed ]]; then : > "$WAIT_FIXTURE/listed"; status=in_progress; conclusion=''; fi
    echo "[{\\"databaseId\\":10,\\"workflowName\\":\\"Checks\\",\\"status\\":\\"$status\\",\\"conclusion\\":\\"$conclusion\\",\\"headSha\\":\\"$sha\\",\\"createdAt\\":\\"2026-10-16\\",\\"url\\":\\"https://example.test/run/10\\"}]" ;;
  'run view')
    if [[ $* == *--log-failed ]]; then
      printf 'log-%s\\n' {1..30}
    else
      echo '{"jobs":[{"name":"unit","status":"completed","conclusion":"failure","steps":[{"name":"Test suite","status":"completed","conclusion":"failure"}]}]}'
    fi ;;
  *) echo "unexpected gh: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(fake, 0o755);
  return { env: { ...baseEnv, PATH: `${directory}:${process.env.PATH}`, WAIT_FIXTURE: directory, WAIT_MODE: mode },
    calls: () => readFileSync(join(directory, "calls"), "utf8") };
}

test("ci green uses the default branch and pinned per-workflow reads", async (t) => {
  const fixture = fakeGh(t, "green");
  const output = await run(t, ["ci", "--timeout", "2s"], fixture.env);
  result(output, 0, /ok ci dev abcdef0 green \(1 workflows\) after /);
  assert.match(output.stdout, /Checks: success abcdef0/);
  assert.match(fixture.calls(), /api repos\/\{owner\}\/\{repo\}\/commits\/dev --jq .sha/);
  assert.match(fixture.calls(), new RegExp(`--branch dev --limit 1 .*--commit ${head}`));
});

test("ci failure prints failed steps and only the last 20 failed log lines", async (t) => {
  const fixture = fakeGh(t, "failed");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 1, /ci dev abcdef0 failed: Checks/);
  assert.match(output.stdout, /unit: Test suite \(failure\)/);
  last20(output.stdout, "log-");
});

test("ci cancellation follows the fresh branch head without failing the cancelled run", async (t) => {
  const fixture = fakeGh(t, "superseded");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 0, /ci dev 1234567 green/);
  assert.match(output.stdout, /superseded by 1234567/);
  assert.doesNotMatch(fixture.calls(), /run view/);
});

test("ci keeps its starting head when the branch moves without a cancelled run", async (t) => {
  const fixture = fakeGh(t, "moved");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 0, /ci dev abcdef0 green/);
  assert.doesNotMatch(output.stdout, /superseded|1234567/);
});

test("status lines appear at most once per status interval", async (t) => {
  const sleeper = child(t, "/bin/sleep", ["10"]);
  const output = await run(t, ["pid", String(sleeper.pid), "--timeout", "0.7s"], { ...baseEnv, KIT_WAIT_STATUS_MS: "200" });
  result(output, 1, /timed out after 0.7s/);
  const waiting = output.stdout.split("\n").filter((line) => line.startsWith("waiting "));
  assert.ok(waiting.length >= 1 && waiting.length <= 3, output.stdout);
});

test("ci PR resolves the PR branch and head", async (t) => {
  const fixture = fakeGh(t, "green");
  const output = await run(t, ["ci", "--pr", "42", "--timeout", "2"], fixture.env);
  result(output, 0, /ci pr 42 abcdef0 green/);
  assert.match(fixture.calls(), /pr view 42 --json headRefName,headRefOid/);
  assert.match(fixture.calls(), /--branch feature\/work/);
});

test("ci SHA waits for a branch before reading workflows", async (t) => {
  const fixture = fakeGh(t, "sha-empty");
  const output = await run(t, ["ci", "--sha", head, "--timeout", "2"], fixture.env);
  result(output, 0, new RegExp(`ci ${head} abcdef0 green`));
  assert.equal(fixture.calls().split("\n").filter((line) => line.includes("--json headBranch")).length, 2);
});

test("ci abbreviated SHA expands and stays pinned when branch head differs", async (t) => {
  const fixture = fakeGh(t, "pinned");
  const output = await run(t, ["ci", "--sha", "abcdef0", "--timeout", "2"], fixture.env);
  result(output, 0, /ci abcdef0 abcdef0 green/);
  assert.match(fixture.calls(), /commits\/abcdef0 --jq .sha/);
  assert.doesNotMatch(output.stdout, /superseded/);
});

test("ci SHA with no runs waits until its deadline", async (t) => {
  const fixture = fakeGh(t, "no-runs");
  const output = await run(t, ["ci", "--sha", head, "--timeout", "0.2s"], fixture.env);
  result(output, 1, /abcdef0 timed out after 0.2s/);
  assert.doesNotMatch(fixture.calls(), /workflow list/);
});

test("ci cancellation on an unchanged head reports failure", async (t) => {
  const fixture = fakeGh(t, "cancelled");
  const output = await run(t, ["ci", "--timeout", "2"], fixture.env);
  result(output, 1, /ci dev abcdef0 failed: Checks/);
  assert.doesNotMatch(output.stdout, /superseded/);
});

test("ci pending timeout deduplicates workflow lines and rate limits status", async (t) => {
  const fixture = fakeGh(t, "pending");
  const output = await run(t, ["ci", "--timeout", "0.4s"], fixture.env);
  result(output, 1, /ci dev abcdef0 timed out after 0.4s/);
  assert.equal(output.stdout.split("\n").filter((line) => line.startsWith("Checks:")).length, 1);
  assert.doesNotMatch(output.stdout, /waiting /);
});

test("ci gh errors report only their first line", async (t) => {
  const fixture = fakeGh(t, "error");
  const output = await run(t, ["ci"], fixture.env);
  result(output, 1, /fail fixture gh failure$/);
  assert.doesNotMatch(output.stdout, /second error line/);
});

for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
  test(`wait stops promptly on ${signal} and leaves interrupted RESULT to kit`, async (t) => {
    const process = child(t, "/bin/bash", [kit, "wait", "pid", "1", "--timeout", "1h"]);
    const output = collect(process);
    await once(process.stdout!, "data");
    process.kill(signal);
    result(await output, signal === "SIGINT" ? 130 : 143, /fail wait interrupted/);
  });
}
