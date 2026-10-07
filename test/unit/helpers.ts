import { timing, type FetchLike } from "../../src/client.js";
import { createContext } from "../../src/runner.js";

// retries must not wait in unit tests
timing.sleep = async () => {};

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

/** JSON bodies parsed, urlencoded bodies as an object of strings, other text as is. */
function parseBody(init: Record<string, any>): any {
  if (init.body === undefined) return undefined;
  if (init.headers?.["Content-Type"] === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(init.body));
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

type Responder = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string>; url?: string } | undefined;

/** A fetch double that records calls and answers from a responder (default 200 {}). */
export function fakeFetch(responder: Responder = () => undefined): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: parseBody(init),
    };
    calls.push(call);
    const res = responder(call) ?? {};
    const text = res.body === undefined ? "{}" : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    const headers = res.headers ?? {};
    return {
      status: res.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => text,
      url: res.url ?? url,
    };
  };
  return { fetch, calls };
}

export const TEST_ENV: NodeJS.ProcessEnv = {
  JIRA_URL: "https://jira.example.com/",
  JIRA_PAT_TOKEN: "jira-pat",
  CONFLUENCE_URL: "https://wiki.example.com",
  CONFLUENCE_USERNAME: "admin",
  CONFLUENCE_PASSWORD: "secret",
};

export function testContext(responder?: Responder) {
  const { fetch, calls } = fakeFetch(responder);
  const { ctx } = createContext(fetch, TEST_ENV);
  return { ctx, calls };
}

/**
 * A small Jira user directory that keeps group memberships and the active flag, so user and group
 * writes can check the state before and read it back after. `fail` answers a write with HTTP 500.
 */
export function fakeJiraUsers(opts: { fail?: (call: Call) => boolean } = {}) {
  const users = new Map<string, { groups: Set<string>; active: boolean }>();
  const user = (name: string) => {
    let u = users.get(name);
    if (!u) users.set(name, (u = { groups: new Set(), active: true }));
    return u;
  };
  const responder = (c: Call) => {
    if (opts.fail?.(c)) return { status: 500, body: { errorMessages: ["boom"] } };
    const url = new URL(c.url);
    const q = url.searchParams;
    if (url.pathname === "/rest/api/2/group/user") {
      const name = c.method === "POST" ? (c.body as any)?.name : q.get("username");
      if (c.method === "POST") user(name).groups.add(q.get("groupname")!);
      if (c.method === "DELETE") user(name).groups.delete(q.get("groupname")!);
      return { status: c.method === "POST" ? 201 : 200, body: {} };
    }
    if (url.pathname === "/rest/api/2/user") {
      const name = q.get("username") ?? q.get("key")!;
      const u = user(name);
      if (c.method === "PUT" && typeof (c.body as any)?.active === "boolean") u.active = (c.body as any).active;
      return { body: { name, key: name, active: u.active, groups: { size: u.groups.size, items: [...u.groups].map((g) => ({ name: g })) } } };
    }
    return undefined;
  };
  return { responder, users };
}
