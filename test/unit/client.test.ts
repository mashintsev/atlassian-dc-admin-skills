import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AtlassianClient, buildQuery } from "../../src/client.js";
import { checkAvailableServices, ConfigurationError, loadConfig } from "../../src/config.js";
import { errorDetail, HttpStatusError } from "../../src/errors.js";
import { fakeFetch, TEST_ENV } from "./helpers.js";

describe("buildQuery", () => {
  it("drops null/undefined, repeats arrays, encodes values", () => {
    assert.equal(buildQuery({ a: 1, b: undefined, c: null, ids: ["x", "y"], q: "a b&c", f: false }), "?a=1&ids=x&ids=y&q=a+b%26c&f=false");
    assert.equal(buildQuery({}), "");
  });
});

describe("loadConfig", () => {
  it("uses Bearer for a PAT and strips the trailing slash", () => {
    const cfg = loadConfig("jira", TEST_ENV);
    assert.equal(cfg.baseUrl, "https://jira.example.com");
    assert.equal(cfg.headers.Authorization, "Bearer jira-pat");
    assert.equal(cfg.headers["X-Atlassian-Token"], "no-check");
    assert.equal(cfg.verifySsl, true);
  });

  it("uses Basic for username/password", () => {
    const cfg = loadConfig("confluence", TEST_ENV);
    assert.equal(cfg.headers.Authorization, `Basic ${Buffer.from("admin:secret").toString("base64")}`);
  });

  it("supports proxy gateway mode", () => {
    const cfg = loadConfig("jira", { ...TEST_ENV, JIRA_PROXY_USER: "gw", JIRA_PROXY_PASS: "pw", JIRA_SSL_VERIFY: "false" });
    assert.equal(cfg.headers.Authorization, `Basic ${Buffer.from("gw:pw").toString("base64")}`);
    assert.equal(cfg.headers["X-Atlassian-Pat"], "jira-pat");
    assert.equal(cfg.verifySsl, false);
  });

  it("reports missing configuration per product", () => {
    assert.throws(() => loadConfig("jira", {}), ConfigurationError);
    const status = checkAvailableServices({ JIRA_URL: "https://j", JIRA_PAT_TOKEN: "t" });
    assert.deepEqual(status.available_services, ["jira"]);
    assert.match(status.unavailable_services.confluence!, /CONFLUENCE_URL/);
  });
});

describe("AtlassianClient.request", () => {
  it("raises HttpStatusError with the Jira error detail and an admin hint", async () => {
    const { fetch } = fakeFetch(() => ({ status: 403, body: { errorMessages: ["You are not an administrator"] } }));
    const client = new AtlassianClient(loadConfig("jira", TEST_ENV), fetch);
    await assert.rejects(client.get("/rest/api/2/serverInfo"), (e: unknown) => {
      assert.ok(e instanceof HttpStatusError);
      assert.equal(e.status, 403);
      assert.match(e.message, /You are not an administrator/);
      assert.match(e.message, /administrator/);
      return true;
    });
  });

  it("retries on 429 with Retry-After", async () => {
    let n = 0;
    const { fetch, calls } = fakeFetch(() => (n++ === 0 ? { status: 429, headers: { "retry-after": "0.01" } } : { body: { ok: 1 } }));
    const client = new AtlassianClient(loadConfig("jira", TEST_ENV), fetch);
    assert.deepEqual(await client.get("/x"), { ok: 1 });
    assert.equal(calls.length, 2);
  });

  it("sends JSON bodies with a custom content type", async () => {
    const { fetch, calls } = fakeFetch();
    const client = new AtlassianClient(loadConfig("jira", TEST_ENV), fetch);
    await client.request("PUT", "/rest/plugins/1.0/k-key", { json: { enabled: false }, contentType: "application/vnd.atl.plugins.plugin+json" });
    assert.equal(calls[0].headers["Content-Type"], "application/vnd.atl.plugins.plugin+json");
    assert.deepEqual(calls[0].body, { enabled: false });
  });

  it("auto-pages startAt/maxResults responses", async () => {
    const { fetch, calls } = fakeFetch((call) => {
      const start = Number(new URL(call.url).searchParams.get("startAt"));
      return { body: { total: 5, values: [start, start + 1].filter((v) => v < 5) } };
    });
    const client = new AtlassianClient(loadConfig("jira", TEST_ENV), fetch);
    assert.deepEqual(await client.getPaged("/p", "values", {}, 2), [0, 1, 2, 3, 4]);
    assert.equal(calls.length, 3);
  });

  it("auto-pages Confluence results until _links.next disappears", async () => {
    const { fetch } = fakeFetch((call) => {
      const start = Number(new URL(call.url).searchParams.get("start"));
      return { body: { results: [start], _links: start < 2 ? { next: "/n" } : {} } };
    });
    const client = new AtlassianClient(loadConfig("confluence", TEST_ENV), fetch);
    assert.deepEqual(await client.getPagedConfluence("/rest/api/space", {}, 1), [0, 1, 2]);
  });
});

describe("errorDetail", () => {
  it("joins Jira errors, reads Confluence message, ignores HTML", () => {
    assert.equal(errorDetail('{"errorMessages":["a"],"errors":{"name":"taken"}}'), "a; name: taken");
    assert.equal(errorDetail('{"statusCode":404,"message":"No space with key"}'), "No space with key");
    assert.equal(errorDetail("<html>oops</html>"), "");
  });
});
