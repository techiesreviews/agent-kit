import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";

// A small local stand-in for Orbit's public API, written from github.com/coollabsio/orbit docs/public-api.md: the same
// paths, problem documents, version checks and date rules. It holds made-up data and a made-up token only.
// Two things it takes because those docs say Orbit does, on GET /tasks: "assignee_id (a user ID, or none for tasks
// without an assignee)" and "parent_task_id (only the direct sub-issues of this task, as a UUID or an identifier such as ENG-12...)".
export type FakeRequest = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: any };
export type FakeTask = Record<string, any>;

export const fakeToken = "orb_faketokenfortheticketsuite000";
export const fakeCfId = "fake-cloudflare-pass-id.access";
export const fakeCfSecret = "fake-cloudflare-pass-secret-0000";
export const fakeWorkspace = "11111111-1111-4111-8111-111111111111";

const statusNames = [["Idea", "unstarted"], ["Script", "started"], ["Record", "started"], ["Edit", "started"], ["Publish", "completed"]] as const;

export async function fakeOrbit(t: TestContext) {
  const projects = [
    { id: randomUUID(), name: "Tools and Builds", key: "TOOLS", color: "blue", version: 1 },
    { id: randomUUID(), name: "Video Production", key: "VID", color: "red", version: 1 },
  ];
  const statuses = new Map(projects.map(project => [project.id, statusNames.map(([name, category], position) => (
    { id: randomUUID(), project_id: project.id, name, description: "", color: "gray", category, position, version: 1 }))]));
  const tasks: FakeTask[] = [], comments: Record<string, any[]> = {}, requests: FakeRequest[] = [];
  let versionSeed = 4_503_599_627_000_000;
  const nextVersion = () => (versionSeed += 1_000_003);
  const controls = {
    // How many task writes answer 409 next; each one first runs `concurrentEdit`, as a person editing the card would.
    conflicts: 0,
    concurrentEdit: undefined as undefined | ((task: FakeTask) => void),
    // Answers for the next requests, oldest first: a 429, a Cloudflare redirect or page, or a problem.
    answers: [] as ("redirect" | "cloudflare-page" | "login-page-200" | "gateway-page" | { retryAfter?: string } | { status: number; code: string; detail: string; errors?: any })[],
    // Answers for the next task writes only (after the reads went through): a problem, or a dropped connection.
    writeAnswers: [] as ("drop" | "saved-then-502" | "page-200" | { retryAfter: string } | { status: number; code: string; detail: string })[],
    me: { token: { id: randomUUID(), name: "fleet", scopes: ["tasks:write"], project_ids: projects.map(project => project.id), expires_at: "2027-02-04T00:00:00.000Z" } } as Record<string, any>,
    requireCloudflare: true,
  };

  const addTask = (project: (typeof projects)[number], fields: FakeTask = {}): FakeTask => {
    const number = tasks.filter(task => task.project_id === project.id).length + 1;
    const task = { id: randomUUID(), project_id: project.id, number, status_id: statuses.get(project.id)![0].id, title: `Card ${number}`, description: "", priority: "none",
      assignee_ids: [], label_ids: [], due_start_at: null, due_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      version: nextVersion(), parent_task_id: null, identifier: `${project.key}-${number}`, url: `http://orbit.test/tasks/${number}`, trashed: false, ...fields };
    tasks.push(task);
    return task;
  };
  const show = ({ trashed: _trashed, ...task }: FakeTask) => task;
  const find = (key: string) => tasks.find(task => !task.trashed && (task.id === key || task.identifier.toLowerCase() === key.toLowerCase()));

  const send = (response: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": status >= 400 ? "application/problem+json" : "application/json", ...headers });
    response.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const problem = (response: ServerResponse, status: number, code: string, detail: string, extra: object = {}, headers: Record<string, string> = {}) =>
    send(response, status, { type: `https://docs.orbit.dev/problems/${code}`, title: code, status, code, detail, ...extra }, headers);

  const validDates = (task: FakeTask) => {
    if (task.due_start_at && !task.due_at) return "due_start_at needs due_at";
    if (task.due_start_at && Date.parse(task.due_start_at) > Date.parse(task.due_at)) return "due_start_at must not be after due_at";
    return null;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://orbit.test");
    let text = "";
    for await (const chunk of request) text += chunk;
    let body: any;
    try { body = text ? JSON.parse(text) : undefined; } catch { return problem(response, 400, "invalid_request", "Not JSON"); }
    requests.push({ method: request.method!, path: url.pathname, query: url.searchParams, headers: request.headers, body });

    const answer = controls.answers.shift();
    if (answer === "redirect") { response.writeHead(302, { location: "https://login.example.test/cdn-cgi/access/login" }); return response.end(); }
    if (answer === "cloudflare-page") { response.writeHead(403, { "content-type": "text/html" }); return response.end(`<html>Forbidden ${fakeToken}</html>`); }
    if (answer === "gateway-page") { response.writeHead(502, { "content-type": "text/html" }); return response.end("<html>Bad gateway</html>"); }
    if (answer === "login-page-200") { response.writeHead(200, { "content-type": "text/html" }); return response.end("<html>Sign in</html>"); }
    if (answer && "status" in answer) return problem(response, answer.status, answer.code, answer.detail, answer.errors ? { errors: answer.errors } : {});
    if (answer) return problem(response, 429, "rate_limit_exceeded", "Too many requests", {}, answer.retryAfter ? { "retry-after": answer.retryAfter } : {});

    if (controls.requireCloudflare && (request.headers["cf-access-client-id"] !== fakeCfId || request.headers["cf-access-client-secret"] !== fakeCfSecret)) {
      response.writeHead(403, { "content-type": "text/html" });
      return response.end("<html>Cloudflare Access</html>");
    }
    if (request.headers.authorization !== `Bearer ${fakeToken}`) return problem(response, 401, "unauthorized", "No token, or the token is not correct.", {}, { "www-authenticate": 'Bearer realm="orbit"' });

    const base = "/api/public/v1";
    if (url.pathname === `${base}/me`) return send(response, 200, { ...controls.me, workspace: { id: fakeWorkspace, name: "Fake" }, workspaces: controls.me.workspaces ?? [{ id: fakeWorkspace, name: "Fake", scopes: controls.me.token.scopes, project_ids: controls.me.token.project_ids }], user: null, service_account: { id: randomUUID(), name: "fleet" } });
    const prefix = `${base}/workspaces/${fakeWorkspace}`;
    if (!url.pathname.startsWith(prefix)) return problem(response, 404, "not_found", "No such workspace");
    const rest = url.pathname.slice(prefix.length);
    const page = (items: unknown[]) => {
      const limit = Number(url.searchParams.get("limit") ?? 50), start = Number(url.searchParams.get("cursor") ?? 0);
      if (limit < 1 || limit > 100) return problem(response, 400, "invalid_request", "limit is 1 to 100");
      return send(response, 200, { items: items.slice(start, start + limit), next_cursor: start + limit < items.length ? String(start + limit) : null });
    };

    if (rest === "/projects" && request.method === "GET") return send(response, 200, { items: projects, next_cursor: null });
    const statusPath = /^\/projects\/([^/]+)\/statuses$/.exec(rest);
    if (statusPath && request.method === "GET") return page(statuses.get(statusPath[1]) ?? []);

    if (rest === "/tasks" && request.method === "GET") {
      const query = url.searchParams;
      const parent = query.get("parent_task_id");
      const parentId = parent ? find(parent)?.id : undefined;
      if (parent && !parentId) return problem(response, 404, "not_found", "No such parent");
      return page(tasks.filter(task => !task.trashed
        && (!query.get("project_id") || task.project_id === query.get("project_id"))
        && (!query.get("status_id") || task.status_id === query.get("status_id"))
        && (!query.get("assignee_id") || (query.get("assignee_id") === "none" ? task.assignee_ids.length === 0 : task.assignee_ids.includes(query.get("assignee_id"))))
        && (!parentId || task.parent_task_id === parentId)
        && (!query.get("q") || `${task.title} ${task.description} ${task.identifier}`.toLowerCase().includes(query.get("q")!.toLowerCase()))).reverse().map(show));
    }
    if (request.method !== "GET") {
      const planned = controls.writeAnswers.shift();
      if (planned === "drop") return request.socket.destroy();
      if (planned === "saved-then-502") {
        // The change reached Orbit, and only the answer was lost on the way back.
        if (rest === "/tasks") addTask(projects.find(item => item.id === body.project_id)!, { title: body.title, status_id: body.status_id });
        response.writeHead(502, { "content-type": "text/html" });
        return response.end("<html>Bad gateway</html>");
      }
      if (planned === "page-200") { response.writeHead(200, { "content-type": "text/html" }); return response.end("<html>Saved?</html>"); }
      if (planned && "retryAfter" in planned) return problem(response, 429, "rate_limit_exceeded", "Too many requests", {}, { "retry-after": planned.retryAfter });
      if (planned) return problem(response, planned.status, planned.code, planned.detail);
    }
    if (rest === "/tasks" && request.method === "POST") {
      const known = new Set(["project_id", "status_id", "title", "description", "priority", "assignee_ids", "label_ids", "parent_task_id", "due_start_at", "due_at"]);
      const unknown = Object.keys(body ?? {}).find(key => !known.has(key));
      if (unknown) return problem(response, 400, "invalid_request", `Unknown field ${unknown}`);
      const project = projects.find(item => item.id === body?.project_id);
      if (!project || !body.title || !statuses.get(project.id)!.some(status => status.id === body.status_id)) return problem(response, 422, "validation_failed", "A value is not valid", { errors: { title: ["bad"] } });
      const parent = body.parent_task_id ? find(body.parent_task_id) : null;
      if (body.parent_task_id && !parent) return problem(response, 422, "parent_invalid", "No such parent");
      return send(response, 201, show(addTask(project, { ...body, parent_task_id: parent?.id ?? null })));
    }

    const taskPath = /^\/tasks\/([^/]+)(\/comments)?$/.exec(rest);
    if (!taskPath) return problem(response, 404, "not_found", "No such path");
    const task = find(decodeURIComponent(taskPath[1]));
    if (!task) return problem(response, 404, "not_found", "The resource does not exist or this token cannot use it.");
    if (taskPath[2]) {
      if (request.method === "GET") return page(comments[task.id] ?? []);
      if (request.method === "POST") {
        const comment = { id: randomUUID(), task_id: task.id, author_id: null, author_service_account: { id: "1", name: "fleet" }, body: body.body, parent_id: null, version: nextVersion(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        (comments[task.id] ??= []).push(comment);
        return send(response, 201, comment);
      }
      return problem(response, 405, "method_not_allowed", "No");
    }
    if (request.method === "GET") return send(response, 200, show(task));
    const conflict = () => {
      controls.conflicts--;
      controls.concurrentEdit?.(task);
      task.version = nextVersion();
      return problem(response, 409, "conflict", "The resource changed after you read it.", { conflict: { current_version: task.version } });
    };
    if (request.method === "PATCH") {
      if (controls.conflicts > 0) return conflict();
      if (body?.expected_version !== task.version) return problem(response, 409, "conflict", "The resource changed after you read it.", { conflict: { current_version: task.version } });
      const { expected_version: _version, ...fields } = body;
      const known = new Set(["title", "description", "status_id", "priority", "assignee_ids", "label_ids", "due_start_at", "due_at", "parent_task_id"]);
      const unknown = Object.keys(fields).find(key => !known.has(key));
      if (unknown) return problem(response, 400, "invalid_request", `Unknown field ${unknown}`);
      const after = { ...task, ...fields };
      if (fields.parent_task_id) {
        const parent = find(fields.parent_task_id);
        if (!parent) return problem(response, 422, "parent_invalid", "No such parent");
        after.parent_task_id = parent.id;
      }
      const wrong = validDates(after);
      if (wrong) return problem(response, 422, "validation_failed", wrong, { errors: { due_at: [wrong] } });
      Object.assign(task, after, { version: nextVersion(), updated_at: new Date().toISOString() });
      return send(response, 200, show(task));
    }
    if (request.method === "DELETE") {
      if (controls.conflicts > 0) return conflict();
      if (Number(url.searchParams.get("expected_version")) !== task.version) return problem(response, 409, "conflict", "The resource changed after you read it.", { conflict: { current_version: task.version } });
      task.trashed = true;
      for (const child of tasks) if (child.parent_task_id === task.id) child.trashed = true;
      response.writeHead(204);
      return response.end();
    }
    return problem(response, 405, "method_not_allowed", "No");
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => done()); }));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const writes = () => requests.filter(item => item.method !== "GET");
  const statusOf = (task: FakeTask) => statuses.get(task.project_id)!.find(status => status.id === task.status_id)!.name;
  return { origin, projects, statuses, tasks, comments, requests, controls, addTask, writes, statusOf, tools: projects[0], video: projects[1] };
}
