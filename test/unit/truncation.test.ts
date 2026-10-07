import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

/** A Jira-style paged endpoint with `total` items that never says isLast before the end. */
const paged = (c: Call, total: number, item: (i: number) => any) => {
  const q = new URL(c.url).searchParams;
  const start = Number(q.get("startAt") ?? 0);
  const size = Number(q.get("maxResults") ?? 50);
  const values = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, k) => item(start + k));
  return { body: { total, isLast: start + values.length >= total, values } };
};

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx } = testContext(responder);
  const r = await runToolByName(tool, args, ctx);
  assert.ok(r.ok, JSON.stringify((r as any).error));
  return r.value as any;
}

describe("capped reads say so (3.2)", () => {
  it("versions filtered over more than the cap", async () => {
    const v = await run("jira_get_project_versions", { project_key: "TEST", unreleased_only: true }, (c) =>
      paged(c, 2500, (i) => ({ id: String(i), name: `v${i}`, released: false, archived: false })));
    assert.equal(v.truncated, true);
    assert.equal(v.cap, 2000);
  });

  it("issue types of a project over the cap", async () => {
    const v = await run("jira_get_project_issue_types", { project_key: "TEST" }, (c) => paged(c, 250, (i) => ({ id: String(i), name: `T${i}` })));
    assert.equal(v.truncated, true);
    assert.equal(v.items.length, 200);
    const small = await run("jira_get_project_issue_types", { project_key: "TEST" }, (c) => paged(c, 3, (i) => ({ id: String(i), name: `T${i}` })));
    assert.ok(Array.isArray(small), "unchanged shape when nothing is cut");
  });

  it("create fields filtered over the cap", async () => {
    const v = await run("jira_get_create_fields", { project_key: "TEST", issue_type_id: "1", required_only: true }, (c) =>
      paged(c, 600, (i) => ({ fieldId: `f${i}`, name: `F${i}`, required: true })));
    assert.equal(v.truncated, true);
    assert.equal(v.cap, 500);
  });

  it("the Confluence space-scan fallback says it stopped at the cap", async () => {
    const v = await run("confluence_list_spaces", { name_contains: "x" }, (c) => {
      const u = new URL(c.url);
      if (u.pathname.endsWith("/search")) return { status: 400, body: {} };
      const start = Number(u.searchParams.get("start") ?? 0);
      return { body: { results: Array.from({ length: 200 }, (_, k) => ({ id: start + k, key: `K${start + k}`, name: `x${start + k}` })), _links: { next: "/next" } } };
    });
    assert.equal(v.truncated, true);
    assert.equal(v.cap, 2000);
    assert.match(v.fallback, /stopped at 2000/);
  });
});

describe("capped reads used for lookups (3.2)", () => {
  it("project fields say when a per-type field list was cut", async () => {
    const v = await run("jira_get_project_fields", { project_key: "TEST" }, (c) => {
      const p = new URL(c.url).pathname;
      if (p.endsWith("/issuetypes")) return paged(c, 1, () => ({ id: "1", name: "Task" }));
      return paged(c, 600, (i) => ({ fieldId: `f${i}`, name: `F${i}` }));
    });
    assert.equal(v.truncated, true);
  });

  it("the screen list is marked truncated past 5000 screens, and a failed read is not cached", async () => {
    const { AtlassianClient } = await import("../../src/client.js");
    const { loadConfig } = await import("../../src/config.js");
    const { allScreens } = await import("../../src/tools/jira/screens.js");
    const { fakeFetch, TEST_ENV } = await import("./helpers.js");
    const { fetch } = fakeFetch((c) => paged(c, 6000, (i) => ({ id: i, name: `S${i}` })));
    const list = await allScreens(new AtlassianClient(loadConfig("jira", TEST_ENV), fetch));
    assert.equal(list.length, 5000);
    assert.equal(list.truncated, true);
    let n = 0;
    const flaky = fakeFetch((c) => (n++ === 0 ? { status: 400, body: {} } : paged(c, 2, (i) => ({ id: i, name: `S${i}` }))));
    const client = new AtlassianClient(loadConfig("jira", TEST_ENV), flaky.fetch);
    await assert.rejects(allScreens(client));
    assert.equal((await allScreens(client)).length, 2);
  });
});
