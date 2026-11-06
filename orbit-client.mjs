// The kit's Orbit client: the saved setup (a private file outside every repository), the redaction every message and log
// line passes through, and the calls to Orbit's public API (<origin>/api/public/v1, github.com/coollabsio/orbit
// docs/public-api.md). Card rules (who may write, Lex's words, dates) live in ticket-store.mjs; this file knows only Orbit.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const folder = (env, name, fallback) => env[name] && isAbsolute(env[name]) ? env[name] : join(env.HOME || homedir(), fallback);

/** The secrets file: ~/.config/fleet/orbit.json (an absolute XDG_CONFIG_HOME moves it, as the XDG spec says). */
export const orbitConfigPath = (env = process.env) => join(folder(env, "XDG_CONFIG_HOME", ".config"), "fleet/orbit.json");
/** The write log: ~/.local/state/fleet/orbit.log (an absolute XDG_STATE_HOME moves it, as kitStateDir does). */
export const orbitLogPath = (env = process.env) => join(folder(env, "XDG_STATE_HOME", ".local/state"), "fleet/orbit.log");

// One shape for hiding and for refusing: a short word like orb_notes is ordinary text.
const tokenShape = /\borb_[A-Za-z0-9_-]{16,}/g;

/** For card text on the screen: hides the given secrets and Orbit token shapes, and leaves ordinary words whole. */
export function orbitCardRedactor(secrets = []) {
  const known = secrets.filter(secret => typeof secret === "string" && secret).sort((a, b) => b.length - a.length);
  return text => {
    let out = String(text);
    for (const secret of known) out = out.split(secret).join("[hidden]");
    return out.replace(tokenShape, "[hidden]");
  };
}

/** For errors, results and log lines: also hides whatever is shaped like a secret, even at the cost of a few plain words. */
export function orbitRedactor(secrets = []) {
  const card = orbitCardRedactor(secrets);
  return text => {
    return card(text)
      .replace(/\b(Bearer)\s+[^\s"',]+/gi, "$1 [hidden]")
      .replace(/(CF-Access-Client-(?:Id|Secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[hidden]")
      .replace(/("(?:token|cf_access_client_id|cf_access_client_secret)"\s*:\s*")[^"]*/gi, "$1[hidden]")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1");
  };
}

const tokenShapes = text => new Set(String(text ?? "").match(tokenShape) ?? []);

/** True when the text brings a saved secret or a token shape that the old text does not hold; it must not go on a card. */
export function orbitBringsSecret(text, before = "", secrets = []) {
  const now = String(text ?? ""), old = String(before ?? ""), oldShapes = tokenShapes(old);
  return secrets.some(secret => secret && now.includes(secret) && !old.includes(secret)) || [...tokenShapes(now)].some(shape => !oldShapes.has(shape));
}

/** The git work tree holding this path, or null; links in the path are followed and folders not made yet count as their parent. */
export function orbitWorkTreeAround(path) {
  let nearest = dirname(path);
  while (!existsSync(nearest) && nearest !== dirname(nearest)) nearest = dirname(nearest);
  for (let place = realpathSync(nearest); ; place = dirname(place)) {
    if (existsSync(join(place, ".git"))) return place;
    if (place === dirname(place)) return null;
  }
}

/** A plain problem with the setup; `reason` is missing, unsafe or broken. */
export class OrbitSetupProblem extends Error {
  constructor(reason, message) { super(message); this.reason = reason; }
}

/** The origin as "https://host[:port]", or throws: https only (plain http only on this computer), no path or sign-in part. */
export function orbitOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new OrbitSetupProblem("broken", "the Orbit address is not a web address"); }
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new OrbitSetupProblem("broken", "the Orbit address must be only the site's address, like https://orbit.example.com");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new OrbitSetupProblem("broken", "the Orbit address must start with https://");
  return url.origin;
}

/** Problems with the file's contents, in plain words; the values themselves are never named. */
function configProblem(config) {
  const text = value => typeof value === "string" && value.trim() !== "";
  if (!config || typeof config !== "object" || Array.isArray(config)) return "it must hold one set of settings";
  if (!text(config.token)) return "it has no API token";
  if (!text(config.workspace_id)) return "it has no workspace id";
  if (text(config.cf_access_client_id) !== text(config.cf_access_client_secret)) return "it has only half of the Cloudflare pass (the id and the secret go together)";
  return null;
}

/**
 * The saved setup, or throws OrbitSetupProblem. The file must be a plain file of this user's, mode 600 or tighter, outside
 * every git work tree. A parse error's text is never used: it can quote the file.
 */
export function readOrbitConfig(env = process.env) {
  const path = orbitConfigPath(env);
  const again = "Run: scripts/agents/kit ticket setup";
  let info;
  try { info = lstatSync(path); }
  catch { throw new OrbitSetupProblem("missing", `Orbit is not set up on this computer (no ${path}). ${again}`); }
  if (!info.isFile()) throw new OrbitSetupProblem("unsafe", `${path} must be a plain file, not a link or a folder`);
  const tree = orbitWorkTreeAround(path);
  if (tree) throw new OrbitSetupProblem("unsafe", `${path} is inside the git work tree ${tree}; move it out of every repository`);
  if (info.mode & 0o077) throw new OrbitSetupProblem("unsafe", `${path} can be read by others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 ${path}`);
  if (process.getuid && info.uid !== process.getuid()) throw new OrbitSetupProblem("unsafe", `${path} belongs to another user`);
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new OrbitSetupProblem("broken", `${path} cannot be read as settings. ${again}`); }
  const problem = configProblem(config);
  if (problem) throw new OrbitSetupProblem("broken", `${path}: ${problem}. ${again}`);
  return { ...config, origin: orbitOrigin(config.origin) };
}

/** What the saved file says about the token's expiry, in plain words with a leading "; ", or nothing without a readable date. */
function expiryWords(expires, now = Date.now()) {
  const at = Date.parse(expires ?? "");
  if (Number.isNaN(at)) return "";
  const days = Math.floor(Math.abs(at - now) / 86_400_000), plural = `${days} day${days === 1 ? "" : "s"}`;
  return at >= now ? `; token runs out in ${plural}` : `; token ran out ${plural} ago`;
}

/** The one state kit doctor shows for an Orbit failure. Only the kit's own words: nothing Orbit or a page sent goes in it. */
function reportOf(error) {
  const { status, code, noAnswer } = error ?? {};
  if (status === 429) return "Orbit not answering (too many requests)";
  if (status >= 500) return `Orbit not answering (${status})`;
  if (noAnswer) return "Orbit not answering";
  if ((status === 401 || status === 403) && code) return "token refused or expired";
  // No Orbit error document: a redirect to the login page, its 403 page, or that page answered with a 200.
  if (!code && (status < 400 || status === 401 || status === 403)) return "Cloudflare blocked it";
  return `Orbit gave an unexpected answer${status ? ` (${status})` : ""}`;
}

/**
 * One line for kit doctor: what Orbit answers now, and the days left when the saved file records an expiry. It asks once
 * with a short limit (GET /me reads only), and a too-many-requests answer neither waits nor retries.
 */
export async function orbitReport(env = process.env, { timeoutMs = 5_000 } = {}) {
  let config;
  try { config = readOrbitConfig(env); }
  catch (error) {
    if (error?.reason === "missing") return "not set up";
    return `setup file needs attention: ${error instanceof OrbitSetupProblem ? orbitRedactor()(error.message) : "it cannot be read"}`;
  }
  const expiry = expiryWords(config.token_expires_at);
  try {
    const me = await orbitClient(config, { timeoutMs, longestWaitSeconds: -1 }).me();
    return `${me?.token ? "connected" : "Orbit gave an unexpected answer"}${expiry}`;
  } catch (error) {
    return `${reportOf(error)}${expiry}`;
  }
}

/** The secret values of a setup, for the redactor. */
export const orbitSecrets = config => [config?.token, config?.cf_access_client_id, config?.cf_access_client_secret].filter(Boolean);

const identifier = /^[A-Za-z][A-Za-z0-9_]*-[0-9]+$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A card key (TOOLS-10 or a UUID) ready for a path, or throws; nothing else ever goes in a task path. */
export function orbitCardKey(value) {
  const key = String(value ?? "").trim();
  if (uuid.test(key)) return key;
  if (identifier.test(key)) return key.toUpperCase();
  throw new OrbitError(`not a card key: ${key.slice(0, 40) || "(none)"} (use one like TOOLS-10)`);
}

/** An answer or failure from Orbit, already in plain words. `code` is Orbit's; `noAnswer` means a write's outcome is unknown. */
export class OrbitError extends Error {
  constructor(message, { status, code, noAnswer = false } = {}) { super(message); Object.assign(this, { status, code, noAnswer }); }
  /** A stale version, the one thing a fresh read can fix; task_conflict and the GitHub ones are not. */
  get staleVersion() { return this.status === 409 && this.code === "conflict"; }
}

const cloudflareStop = "Cloudflare stopped the request before it reached Orbit (the Cloudflare pass may be wrong or expired). Run: scripts/agents/kit ticket setup --new-pass";

function retrySeconds(header) {
  if (!header) return null;
  if (/^\d+$/.test(header.trim())) return Number(header.trim());
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/**
 * The calls to Orbit. Redirects are never followed: Cloudflare's login page is another site, and fetch would hand it the
 * Cloudflare pass. A 429 waits as Retry-After says, once, and only when the wait is short; nothing else retries here.
 * No call here can ask for a permanent delete: trashTask is the only delete and takes only the card and its version.
 */
export function orbitClient(config, { timeoutMs = 30_000, longestWaitSeconds = 30 } = {}) {
  const base = `${config.origin}/api/public/v1`;
  const headers = { Authorization: `Bearer ${config.token}`, Accept: "application/json" };
  if (config.cf_access_client_id) {
    headers["CF-Access-Client-Id"] = config.cf_access_client_id;
    headers["CF-Access-Client-Secret"] = config.cf_access_client_secret;
  }
  const workspace = `/workspaces/${encodeURIComponent(config.workspace_id ?? "")}`;

  async function once(method, path, { query, body }) {
    const url = new URL(base + path);
    for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    try {
      const response = await fetch(url, {
        method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, text: await response.text() };
    } catch (error) {
      const why = error?.name === "TimeoutError" ? "Orbit did not answer in time" : "could not reach Orbit";
      throw new OrbitError(method === "GET" ? `${why}.` : `${why}. The change may or may not have gone through: read the card before trying again.`, { noAnswer: true, code: "no-answer" });
    }
  }

  function failure(method, { response, text }) {
    let problem = null;
    try { problem = JSON.parse(text); } catch { /* Not Orbit's own error document. */ }
    const status = response.status;
    if (status >= 300 && status < 400) return new OrbitError(cloudflareStop, { status });
    if (!problem || typeof problem !== "object" || !problem.code) {
      if (status === 401 || status === 403) return new OrbitError(cloudflareStop, { status });
      // A gateway's error page (Cloudflare's 502, 504, 524) can come after Orbit saved the change.
      const lost = status >= 500 && method !== "GET";
      return new OrbitError(`Orbit answered ${status} with a page that is not Orbit's own (often Cloudflare); ${lost ? "the change may or may not have gone through: read the card before trying again" : "try again later"}.`, { status, noAnswer: lost });
    }
    const fields = problem.errors && typeof problem.errors === "object" ? ` (${Object.keys(problem.errors).join(", ")})` : "";
    const hint = status === 401 ? " The API token is wrong, expired or revoked. Run: scripts/agents/kit ticket setup" : "";
    return new OrbitError(`Orbit refused: ${problem.detail ?? problem.title ?? problem.code}${fields} [${problem.code}].${hint}`, { status, code: problem.code });
  }

  async function request(method, path, options = {}) {
    let answer = await once(method, path, options);
    if (answer.response.status === 429) {
      const wait = retrySeconds(answer.response.headers.get("retry-after"));
      if (wait === null) throw new OrbitError("Orbit says too many requests. Try again later.", { status: 429, code: "rate_limit_exceeded" });
      if (wait > longestWaitSeconds) throw new OrbitError(`Orbit says too many requests: wait ${wait} seconds, then try again.`, { status: 429, code: "rate_limit_exceeded" });
      await new Promise(done => setTimeout(done, wait * 1000));
      answer = await once(method, path, options);
      if (answer.response.status === 429) throw new OrbitError("Orbit still says too many requests after waiting once. Try again later.", { status: 429, code: "rate_limit_exceeded" });
    }
    if (!answer.response.ok) throw failure(method, answer);
    if (answer.response.status === 204) return null;
    try { return JSON.parse(answer.text); }
    catch {
      // On a read this is Cloudflare's login page. On a write the 2xx may mean the change was saved.
      if (method === "GET") throw new OrbitError(cloudflareStop, { status: answer.response.status });
      throw new OrbitError("Orbit's answer was not readable. The change may or may not have gone through: read the card before trying again.", { status: answer.response.status, code: "no-answer", noAnswer: true });
    }
  }

  /** Every item of a list, up to `limit`; { items, more }. Pages are bounded by the limit, so this never runs on. */
  async function list(path, query = {}, limit = 1000) {
    const items = [];
    let cursor;
    for (;;) {
      const page = await request("GET", path, { query: { ...query, limit: Math.min(100, limit - items.length), cursor } });
      items.push(...page.items);
      if (items.length >= limit) return { items: items.slice(0, limit), more: items.length > limit || Boolean(page.next_cursor) };
      if (!page.next_cursor || page.next_cursor === cursor) return { items, more: false };
      cursor = page.next_cursor;
    }
  }

  const taskPath = key => `${workspace}/tasks/${encodeURIComponent(orbitCardKey(key))}`;
  return {
    me: () => request("GET", "/me"),
    projects: async () => (await list(`${workspace}/projects`)).items,
    statuses: async projectId => (await list(`${workspace}/projects/${encodeURIComponent(projectId)}/statuses`)).items,
    tasks: (query, limit) => list(`${workspace}/tasks`, query, limit),
    task: key => request("GET", taskPath(key)),
    createTask: body => request("POST", `${workspace}/tasks`, { body }),
    patchTask: (key, body) => request("PATCH", taskPath(key), { body }),
    trashTask: (key, version) => request("DELETE", taskPath(key), { query: { expected_version: version } }),
    comments: async key => (await list(`${taskPath(key)}/comments`)).items,
    addComment: (key, body) => request("POST", `${taskPath(key)}/comments`, { body: { body } }),
    /** The path as a person reads it in a dry run. */
    pathOf: { tasks: `${workspace}/tasks`, task: taskPath, comments: key => `${taskPath(key)}/comments` },
  };
}
