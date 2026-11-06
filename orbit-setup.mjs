// `kit ticket setup`: makes the private Orbit setup file. The token comes from a hidden prompt or a file that is read,
// then deleted; the Cloudflare pass comes from the existing MCP settings only after a yes, else a hidden prompt. It is
// checked against Orbit before anything is saved, and no value is ever printed.
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OrbitError, OrbitSetupProblem, orbitClient, orbitConfigPath, orbitOrigin, orbitRedactor, orbitSecrets, orbitWorkTreeAround, readOrbitConfig } from "./orbit-client.mjs";

const headerValue = (headers, name) => {
  for (const [key, value] of Object.entries(headers ?? {})) if (key.toLowerCase() === name) return typeof value === "string" ? value.trim() : undefined;
  return undefined;
};

/** One MCP entry's address and pass, from its url and headers or from an mcp-remote style command line. */
function passOfEntry(entry) {
  // A value like ${CF_ID} counts as the pass when the entry's own env section holds that name.
  const own = value => {
    const name = /^\$\{?(\w+)\}?$/.exec(value ?? "")?.[1];
    return name && typeof entry?.env?.[name] === "string" ? entry.env[name].trim() : value;
  };
  let id = headerValue(entry?.headers, "cf-access-client-id");
  let secret = headerValue(entry?.headers, "cf-access-client-secret");
  let url = typeof entry?.url === "string" ? entry.url : undefined;
  const args = Array.isArray(entry?.args) ? entry.args.filter(item => typeof item === "string") : [];
  for (const arg of args) {
    if (!url && /^https?:\/\//.test(arg)) url = arg;
    const header = /^(CF-Access-Client-(?:Id|Secret))\s*:\s*(.+)$/i.exec(arg);
    if (header) { if (/id$/i.test(header[1])) id = header[2].trim(); else secret = header[2].trim(); }
  }
  let origin;
  try { origin = url ? new URL(url).origin : undefined; } catch { origin = undefined; }
  return { origin, id: own(id), secret: own(secret) };
}

/**
 * The Orbit address and Cloudflare pass in MCP settings text (the shape of ~/.claude.json or a .mcp.json): { origin, id,
 * secret }, or { problem } in plain words. Its values never go in a problem, and a parse error's text (which can quote
 * the file) is never used.
 */
export function cloudflarePassFrom(text) {
  let settings;
  try { settings = JSON.parse(text); } catch { return { problem: "those settings cannot be read" }; }
  const groups = [settings?.mcpServers, ...Object.values(settings?.projects ?? {}).map(project => project?.mcpServers)];
  const entries = groups.flatMap(group => Object.entries(group ?? {})).filter(([name]) => /orbit/i.test(name)).map(([, entry]) => passOfEntry(entry));
  if (!entries.length) return { problem: "those settings have no Orbit connection" };
  const withPass = entries.filter(entry => entry.id && entry.secret);
  if (!withPass.length) return { problem: "the Orbit connection there has no Cloudflare pass" };
  const isReference = value => /^\$\w+$|\$\{/.test(value);
  if (withPass.some(entry => isReference(entry.id) || isReference(entry.secret))) return { problem: "the Orbit connection there holds a reference to the Cloudflare pass, not the pass itself" };
  if (new Set(withPass.map(entry => JSON.stringify(entry))).size > 1) return { problem: "those settings have more than one Orbit connection with different passes" };
  return withPass[0];
}

/** Questions and answers on the terminal: prompts go to stderr, a hidden answer is never echoed. Piped answers also work. */
function terminal(input = process.stdin, output = process.stderr) {
  let piped = null;
  const fromPipe = async () => {
    if (piped === null) {
      let text = "";
      for await (const chunk of input) text += chunk;
      piped = text.split(/\r?\n/);
    }
    return piped.shift() ?? "";
  };
  const fromKeys = hidden => new Promise(done => {
    let text = "";
    const finish = () => { input.off("data", onData); input.setRawMode(false); input.pause(); output.write("\n"); done(text); };
    const onData = chunk => {
      for (const key of chunk.toString("utf8")) {
        if (key === "\r" || key === "\n" || key === "\u0004") return finish();
        if (key === "\u0003") { input.setRawMode(false); output.write("\n"); process.kill(process.pid, "SIGINT"); return; }
        if (key === "\u007f" || key === "\b") {
          if (text && !hidden) output.write("\b \b");
          text = text.slice(0, -1);
        } else if (key >= " ") {
          text += key;
          if (!hidden) output.write(key);
        }
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
  const ask = async (question, hidden) => {
    output.write(`${question} `);
    if (input.isTTY) return (await fromKeys(hidden)).trim();
    const answer = (await fromPipe()).trim();
    output.write("\n");
    return answer;
  };
  return { ask: question => ask(question, false), askHidden: question => ask(`${question} (hidden: nothing shows as you paste)`, true) };
}

const stop = message => { throw new OrbitSetupProblem("stopped", message); };

/** Reads the token file, then deletes it, whatever comes after. Only a plain file: a folder or a pipe stays as it is. */
function takeTokenFile(path) {
  let info;
  try { info = lstatSync(path); } catch { stop(`no file at ${path}, so it cannot be read`); }
  if (!info.isFile()) stop(`${path} must be a plain file`);
  let text = "";
  try { text = readFileSync(path, "utf8"); }
  finally { rmSync(path, { force: true }); }
  return text.split("\n", 1)[0].trim();
}

function saveConfig(path, config) {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const scratch = join(folder, `.orbit-${process.pid}.tmp`);
  try {
    writeFileSync(scratch, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(scratch, 0o600);
    renameSync(scratch, path);
  } finally { rmSync(scratch, { force: true }); }
}

/**
 * The setup run: answers `say` lines and returns the RESULT text; throws OrbitSetupProblem or OrbitError on a stop. The
 * saved file is checked first, so a refusal leaves the token file alone; only a token that was read is lost to a later stop.
 */
export async function orbitSetup({ env = process.env, flags = {}, say, io = terminal() }) {
  const path = orbitConfigPath(env);
  const tree = orbitWorkTreeAround(path);
  if (tree) stop(`${path} would be inside the git work tree ${tree}; secrets stay out of every repository, so nothing was saved`);
  const mcpPath = flags.fromMcpConfig === true ? join(env.HOME || homedir(), ".claude.json") : flags.fromMcpConfig;

  if (flags.dryRun) {
    say(`Would save your Orbit setup in ${path}, private to you.`);
    if (flags.fromFile) say(`Would read the token from ${flags.fromFile}, then delete that file.`);
    if (mcpPath) say(`Would ask before copying the Cloudflare pass from ${mcpPath}.`);
    say("Nothing was read, sent or saved.");
    return "setup dry run";
  }

  let saved = null;
  if (lstatExists(path)) {
    try { saved = readOrbitConfig(env); }
    catch (error) {
      if (!(error instanceof OrbitSetupProblem) || error.reason === "unsafe") throw error;
    }
    const answer = await io.ask(`Orbit is already set up in ${path}. Replace the saved setup? Type yes or no:`);
    if (answer.toLowerCase() !== "yes") stop("The saved setup was kept. Nothing changed.");
  }

  let copied = null;
  if (mcpPath) {
    const answer = await io.ask(`May I copy the Cloudflare pass from ${mcpPath}? Type yes or no:`);
    if (answer.toLowerCase() === "yes") {
      let text = null;
      try { text = readFileSync(mcpPath, "utf8"); } catch { say(`Could not read ${mcpPath}.`); }
      if (text !== null) {
        const found = cloudflarePassFrom(text);
        if (found.problem) say(`Could not copy the pass: ${found.problem}. I will ask for it instead.`);
        else { copied = found; say("Found the Cloudflare pass. It stays hidden."); }
      }
    }
  }

  // The address comes before the token: a bad one stops here, with a token file still in place.
  const origin = orbitOrigin(flags.origin ?? copied?.origin ?? saved?.origin ?? await io.ask("Orbit's web address (like https://orbit.example.com):"));
  const token = flags.fromFile ? takeTokenFile(flags.fromFile) : await io.askHidden("Paste the Orbit token, then press Enter");
  if (!token.startsWith("orb_") || /\s/.test(token)) stop("That does not look like an Orbit token (they start with orb_). Nothing was saved.");

  let id = copied?.id ?? saved?.cf_access_client_id, secret = copied?.secret ?? saved?.cf_access_client_secret;
  if (!id) {
    say("Orbit sits behind Cloudflare, so it needs a pass with two parts. Press Enter on both if yours does not.");
    id = await io.askHidden("Paste the Cloudflare pass id");
    secret = await io.askHidden("Paste the Cloudflare pass secret");
  }
  if (Boolean(id) !== Boolean(secret)) stop("The Cloudflare pass has two parts and one is missing. Nothing was saved.");

  const config = { origin, workspace_id: flags.workspace ?? "", token, ...(id ? { cf_access_client_id: id, cf_access_client_secret: secret } : {}) };
  let me;
  try { me = await orbitClient(config).me(); }
  catch (error) {
    if (error instanceof OrbitError) stop(orbitRedactor(orbitSecrets(config))(`Orbit refused this setup, so nothing was saved. ${error.message}`));
    throw error;
  }
  const workspaces = Array.isArray(me?.workspaces) && me.workspaces.length ? me.workspaces : me?.workspace ? [me.workspace] : [];
  const workspace = flags.workspace ? workspaces.find(item => item.id === flags.workspace) : workspaces.length === 1 ? workspaces[0] : null;
  const reached = workspaces.map(item => `${item.id} (${item.name})`).join(", ");
  if (!workspace) stop(`${flags.workspace ? `No workspace ${flags.workspace} for this token; it reaches: ${reached}` : `This token reaches several workspaces; name one with --workspace <id>: ${reached}`}. Nothing was saved.`);
  config.workspace_id = workspace.id;

  saveConfig(path, config);
  say(`Saved in ${path}, private to you.`);
  const expires = me?.token?.expires_at ? `, runs out ${String(me.token.expires_at).slice(0, 10)}` : "";
  say(`Connected to ${workspace.name} with the token named ${me?.token?.name ?? "(no name)"}${expires}.`);
  if (!me?.token?.scopes?.includes("tasks:write")) say("This token can only read cards. Writing needs a token with Tasks set to Write.");
  return `setup saved, workspace ${workspace.name}`;
}

function lstatExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}
