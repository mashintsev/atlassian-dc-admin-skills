import type { FetchLike } from "../../src/client.js";
import { createContext } from "../../src/runner.js";

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

type Responder = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/** A fetch double that records calls and answers from a responder (default 200 {}). */
export function fakeFetch(responder: Responder = () => undefined): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(call);
    const res = responder(call) ?? {};
    const text = res.body === undefined ? "{}" : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
    const headers = res.headers ?? {};
    return {
      status: res.status ?? 200,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      text: async () => text,
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
