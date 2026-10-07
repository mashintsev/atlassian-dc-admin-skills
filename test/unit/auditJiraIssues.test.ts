import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  assert.ok(res.ok, JSON.stringify(!res.ok && res.error));
  return { value: res.value as any, calls, params: calls.map((c) => new URL(c.url)) };
}

describe("audit: jira issue read tools request small pages and explicit fields", () => {
  it("jira_search sends startAt/maxResults and an explicit field list without description", async () => {
    const { params } = await run("jira_search", { jql: "project = FDP", limit: 10, offset: 20 }, () => ({ body: { total: 0, issues: [] } }));
    const q = params[0].searchParams;
    assert.equal(q.get("startAt"), "20");
    assert.equal(q.get("maxResults"), "10");
    assert.ok(q.get("fields") && !q.get("fields")!.includes("*all") && !q.get("fields")!.includes("description"));
    assert.equal(q.get("expand"), null);
  });

  it("jira_search requests its declared maximum", async () => {
    const { params } = await run("jira_search", { jql: "x", limit: 100 }, () => ({ body: { total: 0, issues: [] } }));
    assert.equal(params[0].searchParams.get("maxResults"), "100");
  });

  it("jira_get_issue requests explicit fields and no expand by default", async () => {
    const { params } = await run("jira_get_issue", { issue_key: "FDP-1" }, (c) =>
      c.url.includes("/field") && !c.url.includes("/issue/") ? { body: [] } : { body: { key: "FDP-1", fields: {} } },
    );
    const issueCall = params.find((u) => u.pathname.endsWith("/issue/FDP-1"))!;
    assert.ok(issueCall.searchParams.get("fields"));
    assert.notEqual(issueCall.searchParams.get("fields"), "*all");
    assert.equal(issueCall.searchParams.get("expand"), null);
  });

  it("jira_get_issue keeps only the newest changelog entries", async () => {
    const histories = Array.from({ length: 30 }, (_, i) => ({ created: `2026-01-${String(i + 1).padStart(2, "0")}`, items: [] }));
    const { value } = await run("jira_get_issue", { issue_key: "FDP-1", include: "changelog", history_limit: 5 }, (c) =>
      c.url.includes("/rest/api/2/field") ? { body: [] } : { body: { key: "FDP-1", fields: {}, changelog: { total: 30, histories } } },
    );
    assert.equal(value.changelog.length, 5);
    assert.equal(value.changelogTotal, 30);
    assert.equal(value.changelog[0].created, "2026-01-30");
  });

  it("jira_get_comments pages on the server", async () => {
    const { params } = await run("jira_get_comments", { issue_key: "FDP-1", limit: 5, offset: 10 }, () => ({ body: { total: 0, comments: [] } }));
    assert.equal(params[0].searchParams.get("startAt"), "10");
    assert.equal(params[0].searchParams.get("maxResults"), "5");
  });

  it("jira_get_project_versions uses the paginated endpoint", async () => {
    const { params, value } = await run("jira_get_project_versions", { project_key: "FDP", limit: 2 }, () => ({
      body: { total: 3, isLast: false, values: [{ id: "1", name: "1.0" }, { id: "2", name: "1.1" }] },
    }));
    assert.equal(params[0].pathname, "/rest/api/2/project/FDP/version");
    assert.equal(params[0].searchParams.get("maxResults"), "2");
    assert.equal(value.nextOffset, 2);
  });

  it("jira_get_create_fields pages on the server without filters", async () => {
    const { params } = await run("jira_get_create_fields", { project_key: "FDP", issue_type_id: "3", limit: 10 }, () => ({ body: { values: [], isLast: true } }));
    assert.equal(params[0].searchParams.get("maxResults"), "10");
    assert.equal(params.length, 1);
  });

  it("jira_get_field_options stops paging create fields once the field is found", async () => {
    const { calls } = await run("jira_get_field_options", { field_id: "customfield_1", project_key: "FDP", issue_type: "3" }, (c) => {
      const u = new URL(c.url);
      if (u.pathname.endsWith("/issuetypes")) return { body: { values: [{ id: "3", name: "Task" }], isLast: true } };
      return { body: { total: 500, values: [{ fieldId: "customfield_1", name: "Team", allowedValues: [{ id: "1", value: "A" }] }] } };
    });
    assert.equal(calls.filter((c) => c.url.includes("/issuetypes/3")).length, 1);
  });

  it("jira_get_project_fields bounds the per-type fan-out", async () => {
    const types = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `T${i}` }));
    const { calls, value } = await run("jira_get_project_fields", { project_key: "FDP" }, (c) =>
      new URL(c.url).pathname.endsWith("/issuetypes") ? { body: { values: types, isLast: true } } : { body: { values: [], isLast: true } },
    );
    assert.equal(calls.length, 1 + 20);
    assert.match(value.skippedIssueTypes, /^T20,/);
  });

  it("jira_get_worklog returns newest first with a small default page", async () => {
    const worklogs = Array.from({ length: 60 }, (_, i) => ({ id: String(i), started: `2026-01-01T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}`, timeSpentSeconds: 60 }));
    const { value } = await run("jira_get_worklog", { issue_key: "FDP-1" }, () => ({ body: { worklogs } }));
    assert.equal(value.returned, 50);
    assert.equal(value.total, 60);
    assert.equal(value.totalHours, 1);
  });
});
