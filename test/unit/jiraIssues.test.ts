import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraIssueTools } from "../../src/tools/jira/issues.js";
import { jiraProjectMetaTools } from "../../src/tools/jira/projectMeta.js";
import type { ToolDef } from "../../src/tools/types.js";
import { type Call, testContext } from "./helpers.js";

const TOOLS = [...jiraIssueTools, ...jiraProjectMetaTools];
const tool = (name: string): ToolDef => TOOLS.find((t) => t.name === name)!;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
const J = "https://jira.example.com/rest/api/2";

const FIELDS = [
  { id: "summary", name: "Summary", schema: { type: "string", system: "summary" } },
  { id: "priority", name: "Priority", schema: { type: "priority", system: "priority" } },
  { id: "labels", name: "Labels", schema: { type: "array", items: "string", system: "labels" } },
  { id: "customfield_10100", name: "Epic Link", schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" } },
  { id: "customfield_10101", name: "Epic Name", schema: { type: "string", custom: "com.pyxis.greenhopper.jira:gh-epic-label" } },
  { id: "customfield_10200", name: "Team", schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } },
];

/** Route fake responses by method + path prefix. */
function router(routes: Record<string, unknown>) {
  return (call: Call) => {
    const u = new URL(call.url);
    const key = `${call.method} ${u.pathname}`;
    for (const [k, body] of Object.entries(routes)) {
      if (key === k || key.startsWith(k.endsWith("*") ? k.slice(0, -1) : `${k}\u0000`)) {
        return typeof body === "function" ? (body as any)(call, u) : { body };
      }
    }
    return { body: {} };
  };
}

async function run(name: string, args: Record<string, unknown>, routes: Record<string, unknown> = {}) {
  const { ctx, calls } = testContext(router({ "GET /rest/api/2/field": FIELDS, ...routes }));
  const res = await runTool(tool(name), args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : res.error, calls };
}

describe("jira issue tools", () => {
  it("every write tool is dry-run guarded and names are unique", () => {
    const names = TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const t of TOOLS) assert.equal("dry_run" in t.inputShape, !!t.write, t.name);
  });

  it("search keeps the description out and pages on the server", async () => {
    const { value, calls } = await run("jira_search", { jql: "assignee = currentUser() ORDER BY updated DESC", projects: "FDP,HR", limit: 2 }, {
      "GET /rest/api/2/search": {
        total: 5,
        issues: [
          { key: "FDP-1", fields: { summary: "A", status: { name: "Open" }, issuetype: { name: "Task" }, assignee: { name: "ivan", avatarUrls: {} }, description: "long" } },
          { key: "FDP-2", fields: { summary: "B", status: { name: "Done" }, issuetype: { name: "Bug" } } },
        ],
      },
    });
    const q = new URL(calls[0].url).searchParams;
    assert.equal(q.get("jql"), "(assignee = currentUser()) AND (project IN (FDP, HR)) ORDER BY updated DESC");
    assert.equal(q.get("maxResults"), "2");
    assert.ok(!q.get("fields")!.includes("description"));
    assert.equal(value.total, 5);
    assert.equal(value.nextOffset, 2);
    assert.deepEqual(plain(value.items[0]), { key: "FDP-1", type: "Task", status: "Open", assignee: "ivan", summary: "A", components: [], fixVersions: [] });
  });

  it("get_issue returns the description as Markdown and the epic key", async () => {
    const { value, calls } = await run("jira_get_issue", { issue_key: "FDP-7", comments: 1, include: "transitions" }, {
      "GET /rest/api/2/issue/FDP-7": { key: "FDP-7", fields: { summary: "S", description: "h2. Title", customfield_10100: "FDP-1" } },
      "GET /rest/api/2/issue/FDP-7/comment": { total: 3, comments: [{ id: "9", author: { name: "a" }, body: "*bold*", created: "2026-10-01T10:00:00.000+0300" }] },
      "GET /rest/api/2/issue/FDP-7/transitions": { transitions: [{ id: "31", name: "Done", to: { name: "Closed" } }] },
    });
    assert.ok(calls.some((c) => /\/issue\/FDP-7\?/.test(c.url) && new URL(c.url).searchParams.get("fields")!.includes("customfield_10100")));
    assert.equal(value.epic, "FDP-1");
    assert.equal(value.fields, undefined);
    assert.match(value.description, /^## Title/);
    assert.equal(value.commentTotal, 3);
    assert.deepEqual(value.transitions, [{ id: "31", name: "Done", to: "Closed" }]);
  });

  it("create_issue converts Markdown, resolves field names and plans the assignee safety net", async () => {
    const { value, calls } = await run("jira_create_issue", {
      project_key: "FDP",
      summary: "New",
      issue_type: "Task",
      description: "# Head\n**bold**",
      assignee: "ivan",
      fields: { priority: "High", labels: "a,b", "Epic Link": "FDP-1", Team: "Core" },
    });
    assert.equal(calls.every((c) => c.method === "GET"), true, "dry run sends no write");
    assert.equal(value.dry_run, true);
    const f = value.request.body.fields;
    assert.deepEqual(f.project, { key: "FDP" });
    assert.deepEqual(f.issuetype, { name: "Task" });
    assert.deepEqual(f.priority, { name: "High" });
    assert.deepEqual(f.labels, ["a", "b"]);
    assert.equal(f.customfield_10100, "FDP-1");
    assert.deepEqual(f.customfield_10200, { value: "Core" });
    assert.deepEqual(f.assignee, { name: "ivan" });
    assert.match(f.description, /^h1\. Head/);
    assert.deepEqual(value.followUps.map((s: any) => s.label), ["assign ivan"]);
  });

  it("create_issue executes and returns the created key", async () => {
    const { value, calls } = await run("jira_create_issue", { project_key: "FDP", summary: "X", issue_type: "Task", assignee: "ivan", dry_run: false }, {
      "POST /rest/api/2/issue": { id: "100", key: "FDP-9" },
    });
    assert.equal(value.result.key, "FDP-9");
    assert.deepEqual(value.result.followUpsDone, ["assign ivan"]);
    assert.ok(calls.some((c) => c.method === "PUT" && c.url === `${J}/issue/FDP-9/assignee`));
  });

  it("creates an epic with Epic Name moved after create when it is not on the create screen", async () => {
    const { value } = await run("jira_create_issue", { project_key: "FDP", summary: "Big", issue_type: "Epic" }, {
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes": { values: [{ id: "10000", name: "Epic" }], isLast: true },
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes/10000": { values: [{ fieldId: "summary" }], isLast: true },
    });
    assert.deepEqual(value.request.body.fields.issuetype, { id: "10000" });
    assert.equal(value.request.body.fields.customfield_10101, undefined);
    assert.deepEqual(value.followUps[0].body, { fields: { customfield_10101: "Big" } });
  });

  it("update_issue turns status into a transition and keeps the other fields", async () => {
    const { value } = await run("jira_update_issue", { issue_key: "FDP-1", fields: { status: "done", summary: "Renamed" }, comment: "ok" }, {
      "GET /rest/api/2/issue/FDP-1/transitions": { transitions: [{ id: "31", name: "Done", to: { name: "Closed" } }] },
    });
    assert.equal(value.request.method, "PUT");
    assert.deepEqual(value.request.body, { fields: { summary: "Renamed" } });
    assert.deepEqual(value.followUps.map((s: any) => s.method + " " + s.url), [`POST ${J}/issue/FDP-1/transitions`, `POST ${J}/issue/FDP-1/comment`]);
    assert.deepEqual(value.followUps[0].body, { transition: { id: "31" } });
  });

  it("transition_issue sends DC {name} assignees and a wiki comment", async () => {
    const { value } = await run("jira_transition_issue", { issue_key: "FDP-1", transition: "DONE", fields: { assignee: "ivan", resolution: "Fixed" }, comment: "**x**" }, {
      "GET /rest/api/2/issue/FDP-1/transitions": { transitions: [{ id: "31", name: "Done", to: { name: "Closed" } }] },
      "GET /rest/api/2/field": [...FIELDS, { id: "resolution", name: "Resolution", schema: { type: "resolution", system: "resolution" } }, { id: "assignee", name: "Assignee", schema: { type: "user", system: "assignee" } }],
    });
    assert.deepEqual(value.request.body, {
      transition: { id: "31" },
      fields: { assignee: { name: "ivan" }, resolution: { name: "Fixed" } },
      update: { comment: [{ add: { body: "*x*" } }] },
    });
  });

  it("unknown transitions list what is available", async () => {
    const { error } = await run("jira_transition_issue", { issue_key: "FDP-1", transition: "nope" }, {
      "GET /rest/api/2/issue/FDP-1/transitions": { transitions: [{ id: "31", name: "Done", to: { name: "Closed" } }] },
    });
    assert.match(error!.message, /Available: 31:Done→Closed/);
  });

  it("delete_issue keeps subtasks unless asked", async () => {
    const { value } = await run("jira_delete_issue", { issue_key: "FDP-1" });
    assert.equal(value.request.url, `${J}/issue/FDP-1`);
    const r2 = await run("jira_delete_issue", { issue_key: "FDP-1", delete_subtasks: true });
    assert.equal(r2.value.request.url, `${J}/issue/FDP-1?deleteSubtasks=true`);
  });

  it("assign resolves e-mails and unassigns with null", async () => {
    const { value } = await run("jira_assign_issue", { issue_key: "FDP-1", assignee: "ivan@example.com" }, {
      "GET /rest/api/2/user/search": [{ name: "ivan", emailAddress: "ivan@example.com" }],
    });
    assert.deepEqual(value.request.body, { name: "ivan" });
    const r2 = await run("jira_assign_issue", { issue_key: "FDP-1" });
    assert.deepEqual(r2.value.request.body, { name: null });
  });

  it("field options come from create metadata and can be filtered", async () => {
    const { value } = await run("jira_get_field_options", { field_id: "customfield_10200", project_key: "FDP", issue_type: "task", contains: "co" }, {
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes": { values: [{ id: "3", name: "Task" }], isLast: true },
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes/3": {
        values: [{ fieldId: "customfield_10200", name: "Team", allowedValues: [{ id: "1", value: "Core" }, { id: "2", value: "Ops" }] }],
        isLast: true,
      },
    });
    assert.deepEqual(plain(value.items), [{ id: "1", value: "Core" }]);
  });

  it("comments are read newest first and converted to Markdown", async () => {
    const { value, calls } = await run("jira_get_comments", { issue_key: "FDP-1", limit: 1 }, {
      "GET /rest/api/2/issue/FDP-1/comment": { total: 2, comments: [{ id: "5", author: { name: "a" }, body: "h3. Hi", created: "c", updated: "c" }] },
    });
    assert.equal(new URL(calls[0].url).searchParams.get("orderBy"), "-created");
    assert.equal(value.nextOffset, 1);
    assert.match(value.items[0].body, /^### Hi/);
  });

  it("versions: create body uses the project key, update needs a field", async () => {
    const { value } = await run("jira_create_version", { project_key: "FDP", name: "1.0", release_date: "2026-12-01" });
    assert.deepEqual(value.request.body, { project: "FDP", name: "1.0", releaseDate: "2026-12-01" });
    const r2 = await run("jira_update_version", { version_id: "10" });
    assert.match(r2.error!.message, /at least one/);
    const r3 = await run("jira_batch_create_versions", { project_key: "FDP", versions: '[{"name":"1.1"},{"name":"1.2"}]', dry_run: false }, {
      "POST /rest/api/2/version": (call: Call) => ({ body: { id: call.body.name === "1.1" ? "11" : "12", name: call.body.name } }),
    });
    assert.deepEqual(r3.value.result.items.map((i: any) => i.id), ["11", "12"]);
  });

  it("project fields are merged across issue types", async () => {
    const { value } = await run("jira_get_project_fields", { project_key: "FDP" }, {
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes": { values: [{ id: "1", name: "Task" }, { id: "2", name: "Bug" }], isLast: true },
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes/1": { values: [{ fieldId: "summary", name: "Summary", required: true, schema: { type: "string" } }], isLast: true },
      "GET /rest/api/2/issue/createmeta/FDP/issuetypes/2": {
        values: [{ fieldId: "summary", name: "Summary", required: false, schema: { type: "string" } }, { fieldId: "environment", name: "Environment", schema: { type: "string" } }],
        isLast: true,
      },
    });
    assert.deepEqual(value.items, [
      { id: "summary", name: "Summary", required: true, custom: false, type: "string", issueTypes: "all" },
      { id: "environment", name: "Environment", required: false, custom: false, type: "string", issueTypes: "Bug" },
    ]);
  });
});
