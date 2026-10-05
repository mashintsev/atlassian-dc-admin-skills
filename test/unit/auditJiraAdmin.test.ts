import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, calls, q: (i = 0) => new URL(calls[i].url).searchParams };
}

describe("jira_list_custom_fields", () => {
  it("requests one server page with 1-based page numbers and server-side search/project filters", async () => {
    const r = await run("jira_list_custom_fields", { search: "cost", project_key: "FDP", offset: 40, limit: 20 }, (c) => {
      if (c.url.includes("/project/FDP")) return { body: { id: "10100", key: "FDP" } };
      return { body: { total: 45, isLast: true, values: [{ id: "customfield_1", name: "Cost", issuesWithValue: 3 }] } };
    });
    assert.ok(r.res.ok);
    assert.equal(r.calls.length, 2);
    assert.ok(!r.calls.some((c) => new URL(c.url).pathname.endsWith("/rest/api/2/project")), "no full project list");
    const q = r.q(1);
    assert.equal(q.get("startAt"), "3"); // offset 40 / limit 20 → page 3
    assert.equal(q.get("maxResults"), "20");
    assert.equal(q.get("search"), "cost");
    assert.equal(q.get("projectIds"), "10100");
    assert.equal(r.value.total, 45);
  });

  it("bounds the usage scan and reports truncation", async () => {
    const r = await run("jira_list_custom_fields", { unused_only: true, max_scan: 600 }, (c) => {
      const page = Number(new URL(c.url).searchParams.get("startAt"));
      return { body: { total: 2000, values: Array.from({ length: 500 }, (_, i) => ({ id: `cf${page}_${i}`, name: "x", issuesWithValue: i % 2 })) } };
    });
    assert.equal(r.calls.length, 2);
    assert.equal(r.q(0).get("maxResults"), "500");
    assert.equal(r.value.scanned, 600);
    assert.equal(r.value.truncatedScan, true);
    assert.equal(r.value.total, 300);
  });
});

describe("narrow expansions", () => {
  it("permission scheme list does not expand grants unless counts are requested", async () => {
    const plain = await run("jira_list_permission_schemes", {}, () => ({ body: { permissionSchemes: [{ id: 1, name: "D" }] } }));
    assert.equal(plain.q().get("expand"), null);
    assert.equal(plain.value[0].grantCount, undefined);
    const counted = await run("jira_list_permission_schemes", { with_grant_counts: true }, () => ({ body: { permissionSchemes: [{ id: 1, name: "D", permissions: [{}, {}] }] } }));
    assert.equal(counted.q().get("expand"), "permissions");
    assert.equal(counted.value[0].grantCount, 2);
  });

  it("permission and notification schemes avoid expand=all", async () => {
    const p = await run("jira_get_permission_scheme", { scheme_id: 1 }, () => ({ body: { id: 1, permissions: [] } }));
    assert.equal(p.q().get("expand"), "permissions,user,projectRole,field");
    const n = await run("jira_get_notification_scheme", { scheme_id: 1 }, () => ({ body: { id: 1 } }));
    assert.equal(n.q().get("expand"), "notificationSchemeEvents");
  });
});

describe("server-side filters", () => {
  it("application properties use keyFilter", async () => {
    const r = await run("jira_get_application_properties", { key_contains: "jira.title" }, () => ({ body: [{ id: "jira.title", key: "jira.title", value: "J", desc: "long" }] }));
    assert.equal(r.q().get("keyFilter"), ".*jira\\.title.*");
    assert.deepEqual(JSON.parse(JSON.stringify(r.value.items)), [{ id: "jira.title", key: "jira.title", value: "J" }]);
  });

  it("workflows pass an exact name to the server", async () => {
    const r = await run("jira_list_workflows", { name: "FDP Workflow" }, () => ({ body: [{ name: "FDP Workflow" }] }));
    assert.equal(r.q().get("workflowName"), "FDP Workflow");
  });

  it("list tools that page on the server pass offset/limit through", async () => {
    const screens = await run("jira_list_screens", { search: "Bug", offset: 10, limit: 5 }, () => ({ body: { values: [], total: 0 } }));
    assert.equal(screens.q().get("startAt"), "10");
    assert.equal(screens.q().get("maxResults"), "5");
    assert.equal(screens.q().get("search"), "Bug");
    const members = await run("jira_get_group_members", { group: "g", offset: 50, limit: 25 }, () => ({ body: { values: [], total: 0 } }));
    assert.equal(members.q().get("startAt"), "50");
    assert.equal(members.q().get("maxResults"), "25");
    const users = await run("jira_find_users", { query: "iv", limit: 10 }, () => ({ body: [] }));
    assert.equal(users.q().get("maxResults"), "10");
  });

  it("rejects page sizes above the cap", async () => {
    const r = await run("jira_list_projects", { limit: 5000 }, () => ({ body: [] }));
    assert.equal(r.res.ok, false);
    assert.equal(r.calls.length, 0);
  });
});
