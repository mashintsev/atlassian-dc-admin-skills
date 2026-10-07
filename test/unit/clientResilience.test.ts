import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { AtlassianClient, timing } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { HttpStatusError } from "../../src/errors.js";
import { fakeFetch, TEST_ENV } from "./helpers.js";

const client = (fetch: any) => new AtlassianClient(loadConfig("jira", TEST_ENV), fetch);
let waits: number[] = [];
const saved = { ...timing };
beforeEach(() => {
  waits = [];
  timing.sleep = async (ms: number) => { waits.push(ms); };
  timing.now = () => Date.parse("2026-10-06T12:00:00Z");
  timing.random = () => 0.5;
});
afterEach(() => Object.assign(timing, saved));

describe("read retries (2.1)", () => {
  it("retries a GET after 503 and succeeds", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (n++ === 0 ? { status: 503, body: "<html>busy</html>" } : { body: { ok: 1 } }));
    assert.deepEqual(await client(fetch).get("/x"), { ok: 1 });
    assert.equal(calls.length, 2);
    assert.equal(waits.length, 1);
  });

  it("retries a GET after a connection reset, but never a POST", async () => {
    let n = 0;
    const reset = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const flaky = async (url: string, init: any) => {
      if (n++ === 0) throw reset;
      return { status: 200, headers: { get: () => null }, text: async () => '{"ok":1}' };
    };
    assert.deepEqual(await client(flaky).get("/x"), { ok: 1 });
    let posts = 0;
    const failing = async () => { posts++; throw reset; };
    await assert.rejects(client(failing).request("POST", "/x", { json: {} }));
    assert.equal(posts, 1, "a write is never repeated");
  });

  it("honours Retry-After in seconds and as an HTTP date", async () => {
    let n = 0;
    const { fetch } = fakeFetch(() => (n++ === 0 ? { status: 429, headers: { "retry-after": "3" } } : { body: { ok: 1 } }));
    await client(fetch).get("/x");
    assert.deepEqual(waits, [3000]);
    waits = [];
    n = 0;
    const date = new Date(timing.now() + 7000).toUTCString();
    const { fetch: f2 } = fakeFetch(() => (n++ === 0 ? { status: 503, headers: { "retry-after": date } } : { body: { ok: 1 } }));
    await client(f2).get("/x");
    assert.deepEqual(waits, [7000]);
  });

  it("gives up when Jira asks to wait more than 60 seconds", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 429, headers: { "retry-after": "120" } }));
    await assert.rejects(client(fetch).get("/x"), (e: unknown) => e instanceof HttpStatusError && e.status === 429);
    assert.equal(calls.length, 1);
  });

  it("stops after 5 attempts", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 502, body: "" }));
    await assert.rejects(client(fetch).get("/x"), (e: unknown) => e instanceof HttpStatusError && e.status === 502);
    assert.equal(calls.length, 5);
  });
});

describe("per-client limiter and fail-fast fan-out (2.2)", async () => {
  const { boundedAll } = await import("../../src/client.js");

  /** A fetch that answers after a tick and records the peak number of requests in flight. */
  function slowFetch(status = (_n: number) => 200) {
    let inFlight = 0;
    let peak = 0;
    let n = 0;
    const fetch = async () => {
      const i = n++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      const s = status(i);
      return { status: s, headers: { get: () => null }, text: async () => (s === 200 ? '{"values":[],"isLast":true}' : "{}") };
    };
    return { fetch, peak: () => peak, count: () => n };
  }

  it("never has more requests in flight than the limit, even with nested fan-out", async () => {
    const f = slowFetch();
    const c = client(f.fetch);
    await boundedAll(Array.from({ length: 6 }, () => () => boundedAll(Array.from({ length: 6 }, () => () => c.get("/x")))));
    assert.ok(f.peak() <= 8, `peak ${f.peak()}`);
    assert.equal(f.count(), 36);
  });

  it("honours ATLASSIAN_MAX_CONCURRENCY, halves on 429 and recovers after successes", async () => {
    process.env.ATLASSIAN_MAX_CONCURRENCY = "4";
    try {
      const f = slowFetch((i) => (i === 0 ? 429 : 200));
      const c = client(f.fetch);
      assert.equal(c.limiter.limit, 4);
      await c.get("/x");
      assert.equal(c.limiter.limit, 2, "halved, but never below 2");
      await boundedAll(Array.from({ length: 40 }, () => () => c.get("/x")));
      assert.equal(c.limiter.limit, 4, "recovered to the configured maximum");
    } finally {
      delete process.env.ATLASSIAN_MAX_CONCURRENCY;
    }
  });

  it("starts no new tasks after one failed", async () => {
    let started = 0;
    const thunks = Array.from({ length: 50 }, (_, i) => async () => {
      started++;
      await new Promise((r) => setTimeout(r, 1));
      if (i === 2) throw new Error("boom");
      return i;
    });
    await assert.rejects(boundedAll(thunks, 4), /boom/);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(started < 10, `started ${started}`);
  });
});

describe("HTML responses are errors (2.3)", async () => {
  const { readFileSync } = await import("node:fs");
  const { runToolByName } = await import("../../src/runner.js");
  const { exitCodeFor } = await import("../../src/format.js");
  const { testContext } = await import("./helpers.js");
  const html = (name: string) => readFileSync(new URL(`../fixtures/html/${name}.html`, import.meta.url), "utf8");
  const htmlRes = (status: number, name: string, headers: Record<string, string> = {}) => ({ status, body: html(name), headers: { "content-type": "text/html;charset=UTF-8", ...headers } });

  async function errorFor(res: any) {
    const { ctx } = testContext(() => res);
    const r = await runToolByName("jira_server_info", {}, ctx);
    assert.equal(r.ok, false);
    return { error: (r as any).error, exit: exitCodeFor((r as any).error) };
  }

  it("a login page is AuthenticationRequired (exit 6)", async () => {
    const { error, exit } = await errorFor(htmlRes(200, "login", { "x-seraph-loginreason": "AUTHENTICATION_DENIED" }));
    assert.equal(error.type, "AuthenticationRequired");
    assert.equal(exit, 6);
  });

  it("a websudo page served with 200 is WebSudoRequired (exit 3) with a UI hint", async () => {
    const { error, exit } = await errorFor(htmlRes(200, "websudo"));
    assert.equal(error.type, "WebSudoRequired");
    assert.equal(exit, 3);
    assert.match(error.hint, /UI/);
  });

  it("a proxy error page becomes UpstreamError (exit 10) after the retries", async () => {
    let calls = 0;
    const { ctx } = testContext(() => { calls++; return htmlRes(502, "proxy-502"); });
    const r = await runToolByName("jira_server_info", {}, ctx);
    const error = (r as any).error;
    assert.equal(error.type, "UpstreamError");
    assert.equal(exitCodeFor(error), 10);
    assert.equal(calls, 5);
  });

  it("a single sign-on page (redirect away from Jira) is AuthenticationRequired", async () => {
    const { error, exit } = await errorFor(htmlRes(200, "sso"));
    assert.equal(error.type, "AuthenticationRequired");
    assert.equal(exit, 6);
    const { ctx } = testContext(() => ({ ...htmlRes(200, "proxy-502"), url: "https://login.example-idp.com/tenant/oauth2/v2.0/authorize" }));
    const r = await runToolByName("jira_server_info", {}, ctx);
    assert.equal((r as any).error.type, "AuthenticationRequired", "judged by the final URL too");
  });

  it("never puts HTML into a message", async () => {
    for (const res of [htmlRes(200, "login"), htmlRes(200, "websudo"), htmlRes(502, "proxy-502"), htmlRes(200, "proxy-502")]) {
      const { error } = await errorFor(res);
      assert.ok(!/<|>/.test(error.message), error.message);
    }
  });

  it("leaves downloads alone", async () => {
    const { fetch } = fakeFetch(() => htmlRes(200, "login"));
    const d = await client(fetch).getBytes("/secure/attachment/1/page.html");
    assert.match(d.bytes.toString(), /login-form/);
  });
});

describe("XSRF token reuse (2.4)", () => {
  it("reuses the cookie from an earlier response instead of reading serverInfo again", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { version: "11.3.7" }, headers: { "set-cookie": "atlassian.xsrf.token=ABC-123|lin; Path=/" } }));
    const c = client(fetch);
    await c.get("/rest/api/2/serverInfo");
    assert.equal(await c.xsrfToken(), "ABC-123|lin");
    assert.equal(calls.filter((x) => x.url.includes("serverInfo")).length, 1);
  });

  it("still reads serverInfo when no response carried the cookie", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (n++ === 0 ? { body: {} } : { body: {}, headers: { "set-cookie": "atlassian.xsrf.token=XYZ; Path=/" } }));
    const c = client(fetch);
    await c.get("/rest/api/2/field");
    assert.equal(await c.xsrfToken(), "XYZ");
    assert.equal(calls.length, 2);
  });
});

describe("truncation flag in paging helpers (3.1)", () => {
  it("getPagedResult reports truncated and the cap when items are left", async () => {
    const { fetch } = fakeFetch((call) => {
      const start = Number(new URL(call.url).searchParams.get("startAt"));
      return { body: { total: 10, values: [start, start + 1] } };
    });
    const c = client(fetch);
    assert.deepEqual(await c.getPagedResult("/p", "values", {}, 2, 4), { items: [0, 1, 2, 3], truncated: true, cap: 4 });
    assert.deepEqual(await c.getPagedResult("/p", "values", {}, 2, 20), { items: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], truncated: false, cap: 20 });
    assert.deepEqual(await c.getPaged("/p", "values", {}, 2, 4), [0, 1, 2, 3], "the old helper keeps its shape");
  });

  it("getPagedConfluenceResult reports truncation when a next link remains", async () => {
    const { fetch } = fakeFetch((call) => {
      const start = Number(new URL(call.url).searchParams.get("start"));
      return { body: { results: [start], _links: { next: "/next" } } };
    });
    const r = await client(fetch).getPagedConfluenceResult("/c", {}, 1, 3);
    assert.deepEqual(r, { items: [0, 1, 2], truncated: true, cap: 3 });
  });
});

describe("review fixes: redirects and the request limiter", () => {
  it("a redirect to the canonical host that returns JSON is data, not a login", async () => {
    const { fetch } = fakeFetch(() => ({ body: { version: "11.3.7" }, url: "https://jira-canonical.example.com/rest/api/2/serverInfo" }));
    assert.deepEqual(await client(fetch).get("/rest/api/2/serverInfo"), { version: "11.3.7" });
    const { fetch: port } = fakeFetch(() => ({ body: { ok: true }, url: "https://jira.example.com:8443/rest/api/2/field" }));
    assert.deepEqual(await client(port).get("/rest/api/2/field"), { ok: true });
  });

  it("a redirect to another host that ends on a login page is still AuthenticationRequired", async () => {
    const { fetch } = fakeFetch(() => ({ body: "{}", url: "https://sso.example.com/login.jsp" }));
    await assert.rejects(client(fetch).get("/rest/api/2/serverInfo"), /AuthenticationRequired|login/);
  });

  it("raising the limit never lets more requests run than the limit", async () => {
    const { RequestLimiter } = await import("../../src/client.js");
    const l = new RequestLimiter(8);
    for (let i = 0; i < 8; i++) await l.acquire();
    l.throttled();
    assert.equal(l.limit, 4);
    let woken = 0;
    for (let i = 0; i < 3; i++) void l.acquire().then(() => woken++);
    for (let i = 0; i < 20; i++) l.succeeded();
    await new Promise((r) => setImmediate(r));
    assert.equal(l.limit, 5);
    assert.equal(woken, 0, "8 still run, more than the limit of 5: nobody may start");
    assert.equal((l as any).active, 8);
    // releases bring active down to the limit before the waiters start
    for (let i = 0; i < 4; i++) l.release();
    await new Promise((r) => setImmediate(r));
    assert.ok((l as any).active <= l.limit, `active ${(l as any).active} > limit ${l.limit}`);
  });
});
