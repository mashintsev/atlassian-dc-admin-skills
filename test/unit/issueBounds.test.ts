import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "../../src/format.js";
import { runToolByName } from "../../src/runner.js";
import { benchResponder } from "../bench/payloads.js";
import { testContext, type Call } from "./helpers.js";

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any = benchResponder().responder) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runToolByName(tool, args, ctx);
  return { value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error, calls };
}

describe("issue text bounds (optimize-read-token-usage 3.3)", () => {
  it("cuts a long description at max_description_chars and reports the total; 0 omits it", async () => {
    const long = { body: { key: "PRJ1-1", fields: { summary: "S", description: Array.from({ length: 2000 }, (_, i) => `line ${i} of a pasted log`).join("\n") } } };
    const responder = (c: Call) => (new URL(c.url).pathname.startsWith("/rest/api/2/issue/") ? long : { body: [] });
    const r = await run("jira_get_issue", { issue_key: "PRJ1-1", markup: "wiki" }, responder);
    assert.ok(r.value.description.length <= 8000, String(r.value.description.length));
    assert.match(r.value.description, /of a pasted log$/, "cut at a line boundary");
    assert.ok(r.value.descriptionTruncated.total > 40_000);
    assert.equal(r.value.descriptionTruncated.shown, r.value.description.length);
    const small = await run("jira_get_issue", { issue_key: "PRJ1-1", markup: "wiki", max_description_chars: 100 }, responder);
    assert.ok(small.value.description.length <= 100);
    const none = await run("jira_get_issue", { issue_key: "PRJ1-1", max_description_chars: 0 }, responder);
    assert.equal(none.value.description, undefined);
  });

  it("summarizes long changelog values as lengths and a 120-character preview, and stays under the guard", async () => {
    const r = await run("jira_get_issue", { issue_key: "PRJ1-1", include: "changelog" });
    const changes: string[] = r.value.changelog[0].changes;
    const desc = changes.find((x) => x.startsWith("description"))!;
    assert.match(desc, /^description: \d+ chars → \d+ chars: .{1,125}$/);
    assert.ok(desc.length < 200, desc);
    assert.equal(changes.find((x) => x.startsWith("status")), "status: Open → In Progress");
    assert.ok(render(r.value, "compact").length < 25_000);
    assert.ok(render(r.value, "json").length < 25_000, "JSON is bounded too");
  });
});

describe("issue lists without raw field dumps (optimize-read-token-usage 3.4)", () => {
  it("refuses fields=*all in every issue list", async () => {
    for (const [tool, args] of [
      ["jira_search", { jql: "x" }],
      ["jira_get_project_issues", { project_key: "PRJ1" }],
      ["jira_get_board_issues", { board_id: 1 }],
      ["jira_get_sprint_issues", { sprint_id: 1 }],
    ] as const) {
      const r = await run(tool, { ...args, fields: "*all" });
      assert.equal(r.error?.type, "ValidationError", tool);
      assert.match(r.error.message, /\*all.*jira_get_issue/, tool);
      assert.equal(r.calls.length, 0, `${tool} sends nothing`);
    }
  });

  it("shows each extra field as its own column with a readable value", async () => {
    const r = await run("jira_search", { jql: "x", fields: "customfield_10000,customfield_10005,customfield_10001" });
    const row = r.value.items[0];
    assert.equal(row.customfield_10000, "Option 0");
    assert.equal(row.customfield_10005, "value 5");
    assert.equal(row.fields, undefined);
    assert.ok(!("customfield_10001" in row), "null fields stay out");
  });

  it("flattens service desk SLA and request type columns in queue issues", async () => {
    const r = await run("jira_get_queue_issues", { service_desk: "3", queue_id: "65" });
    const row = r.value.items[0];
    assert.equal(row.customfield_10900, "7h remaining");
    assert.equal(row.customfield_10901, "Get IT help");
    assert.ok(render(r.value, "json").length < 25_000, "JSON is bounded too");
  });

  it("jira_get_issue fields=*all keeps the fields but not comment, worklog, watches, votes or progress", async () => {
    const r = await run("jira_get_issue", { issue_key: "PRJ1-1", fields: "*all" });
    for (const k of ["comment", "worklog", "watches", "votes", "progress", "aggregateprogress"]) assert.ok(!(k in (r.value.fields ?? {})), k);
    assert.ok(Object.keys(r.value.fields).some((k) => k.startsWith("customfield_")));
  });
});

describe("list defaults and caps (optimize-read-token-usage 3.5)", () => {
  it("agile issue lists default to 20 and cap at 100; comments and worklogs cap at 100", async () => {
    const { findTool } = await import("../../src/tools/index.js");
    for (const name of ["jira_get_board_issues", "jira_get_sprint_issues", "jira_get_comments", "jira_get_worklog"]) {
      const limit: any = findTool(name)!.inputShape.limit;
      assert.equal(limit.safeParse(101).success, false, `${name} rejects 101`);
      assert.equal(limit.safeParse(100).success, true, name);
    }
    const r = await run("jira_get_board_issues", { board_id: 1 }, (c) => ({ body: { issues: [], total: 0, maxResults: Number(new URL(c.url).searchParams.get("maxResults")) } }));
    assert.equal(new URL(r.calls.at(-1)!.url).searchParams.get("maxResults"), "20");
  });
});

it("issue search and project issues reject limits above their applied 100-row cap", async () => {
  for (const [tool, args] of [["jira_search", { jql: "order by updated DESC" }], ["jira_get_project_issues", { project_key: "PRJ1" }]] as const) {
    const r = await run(tool, { ...args, limit: 101 });
    assert.equal(r.error?.type, "ValidationError", tool);
    assert.equal(r.calls.length, 0);
  }
});
