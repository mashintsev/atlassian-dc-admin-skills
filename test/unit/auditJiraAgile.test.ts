import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, calls };
}
const q = (c: Call) => new URL(c.url).searchParams;

describe("read tools request one small page with server-side filters", () => {
  it("agile boards: name/project/type filters and startAt/maxResults", async () => {
    const r = await run("jira_get_agile_boards", { board_name: "Fin", project_key: "FDP", board_type: "scrum", offset: 10, limit: 5 }, () => ({ body: { values: [], isLast: true } }));
    const p = q(r.calls[0]);
    assert.deepEqual([p.get("name"), p.get("projectKeyOrId"), p.get("type"), p.get("startAt"), p.get("maxResults")], ["Fin", "FDP", "scrum", "10", "5"]);
  });

  it("board and sprint issues: jql + minimal fields + paging", async () => {
    for (const [tool, idArg] of [["jira_get_board_issues", { board_id: 1 }], ["jira_get_sprint_issues", { sprint_id: 2 }]] as const) {
      const r = await run(tool, { ...idArg, jql: "status = Open", limit: 7 }, () => ({ body: { issues: [], total: 0 } }));
      const p = q(r.calls[0]);
      assert.equal(p.get("jql"), "status = Open");
      assert.equal(p.get("maxResults"), "7");
      assert.ok(p.get("fields")?.includes("summary") && !p.get("fields")?.includes("*all"));
      assert.equal(p.get("expand"), null);
    }
  });

  it("sprints: state filter server-side", async () => {
    const r = await run("jira_get_sprints_from_board", { board_id: 1, state: "active" }, () => ({ body: { values: [], isLast: true } }));
    assert.equal(q(r.calls[0]).get("state"), "active");
    assert.equal(q(r.calls[0]).get("maxResults"), "50");
  });

  it("assignable users: one request, bounded size", async () => {
    const r = await run("jira_search_assignable_users", { query: "iv", project_key: "FDP" }, () => ({ body: [] }));
    assert.equal(r.calls.length, 1);
    assert.equal(q(r.calls[0]).get("maxResults"), "20");
    assert.equal((await run("jira_search_assignable_users", { query: "iv", project_key: "FDP", limit: 5000 })).res.ok, false);
  });

  it("service desk for project stops at the first matching page", async () => {
    let pages = 0;
    const r = await run("jira_get_service_desk_for_project", { project_key: "itsm" }, (c) => {
      pages++;
      const start = Number(q(c).get("start"));
      return start === 0
        ? { body: { values: [{ id: 1, projectKey: "HR" }, { id: 7, projectKey: "ITSM" }], isLastPage: false } }
        : { body: { values: [{ id: 9, projectKey: "X" }], isLastPage: true } };
    });
    assert.equal(r.value.service_desk.id, 7);
    assert.equal(pages, 1);
    assert.equal(q(r.calls[0]).get("limit"), "50");
  });

  it("queues and queue issues do not count unless asked", async () => {
    const queues = await run("jira_get_service_desk_queues", { service_desk_id: 7 }, () => ({ body: { values: [], isLastPage: true } }));
    assert.equal(q(queues.calls[0]).get("includeCount"), "false");
    const issues = await run("jira_get_queue_issues", { service_desk_id: 7, queue_id: 3 }, () => ({ body: { values: [], isLastPage: true } }));
    assert.equal(issues.calls.length, 1);
    assert.match(issues.calls[0].url, /\/queue\/3\/issue\?start=0&limit=50$/);
  });

  it("request types: groupId filter server-side", async () => {
    const r = await run("jira_get_request_types", { service_desk_id: 7, group_id: 4 }, () => ({ body: { values: [], isLastPage: true } }));
    assert.equal(q(r.calls[0]).get("groupId"), "4");
  });

  it("attachment listing asks only for the attachment field and downloads nothing", async () => {
    const r = await run("jira_get_attachments", { issue_key: "FDP-1" }, () => ({ body: { fields: { attachment: [{ id: 1, filename: "a.png", content: "https://jira.example.com/x" }] } } }));
    assert.equal(r.calls.length, 1);
    assert.equal(q(r.calls[0]).get("fields"), "attachment");
  });

  it("issue dates read changelog for one issue with minimal fields", async () => {
    const r = await run("jira_get_issue_dates", { issue_key: "FDP-1" }, () => ({ body: { fields: { created: "2026-01-01T00:00:00Z", status: { name: "Open" } }, changelog: { histories: [] } } }));
    assert.equal(r.calls.length, 1);
    assert.equal(q(r.calls[0]).get("expand"), "changelog");
    assert.equal(q(r.calls[0]).get("fields"), "status,created,updated,duedate,resolutiondate");
  });

  it("project analysis is capped and pages search with minimal fields", async () => {
    const r = await run("jira_get_cross_project_dependencies", { project_key: "FDP", max_issues: 60 }, (c) => {
      const start = Number(q(c).get("startAt"));
      return { body: { total: 500, issues: Array.from({ length: Number(q(c).get("maxResults")) }, (_, i) => ({ key: `FDP-${start + i}`, fields: {} })) } };
    });
    assert.equal(r.value.issuesScanned, 60);
    assert.ok(r.calls.every((c) => q(c).get("fields") === "issuelinks" && Number(q(c).get("maxResults")) <= 50));
    assert.equal(r.calls.length, 2);
  });
});
