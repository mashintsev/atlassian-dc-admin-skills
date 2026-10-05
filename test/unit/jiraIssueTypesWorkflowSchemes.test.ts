import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, calls };
}

const path = (c: Call) => new URL(c.url).pathname;

const ISSUE_TYPES = [
  { id: "1", name: "Bug", subtask: false, description: "A problem" },
  { id: "5", name: "Sub-task", subtask: true },
];

describe("jira_list_issue_types", () => {
  it("lists issue types filtered by name", async () => {
    const r = await run("jira_list_issue_types", { name_contains: "bug" }, () => ({ body: ISSUE_TYPES }));
    assert.ok(r.res.ok);
    assert.equal(path(r.calls[0]), "/rest/api/2/issuetype");
    assert.deepEqual(r.value.items.map((t: any) => t.id), ["1"]);
    assert.equal(r.value.items[0].subtask, false);
  });
});

describe("jira_create_issue_type", () => {
  it("dry-runs a standard issue type without sending the POST", async () => {
    const r = await run("jira_create_issue_type", { name: "Risk", description: "Project risk" }, () => ({ body: ISSUE_TYPES }));
    assert.ok(r.res.ok);
    assert.equal(r.value.dry_run, true);
    assert.ok(!r.calls.some((c) => c.method === "POST"));
    assert.deepEqual(r.value.request.body, { name: "Risk", description: "Project risk", type: "standard" });
  });

  it("creates a sub-task type with dry_run=false", async () => {
    const r = await run("jira_create_issue_type", { name: "Review", subtask: true, avatar_id: 10300, dry_run: false }, (c) =>
      c.method === "POST" ? { status: 201, body: { id: "10200", name: "Review", subtask: true } } : { body: ISSUE_TYPES });
    assert.ok(r.res.ok);
    const post = r.calls.find((c) => c.method === "POST")!;
    assert.equal(path(post), "/rest/api/2/issuetype");
    assert.deepEqual(post.body, { name: "Review", type: "subtask", avatarId: 10300 });
  });

  it("refuses a name that already exists (case-insensitive)", async () => {
    const r = await run("jira_create_issue_type", { name: "bug" }, () => ({ body: ISSUE_TYPES }));
    assert.equal(r.res.ok, false);
    assert.ok(!r.calls.some((c) => c.method === "POST"));
  });
});

const SCHEME = { id: 10100, name: "FDP WS", defaultWorkflow: "jira", issueTypeMappings: { "1": "Bug WF" } };

describe("workflow scheme changes", () => {
  it("get_workflow_scheme reads the draft when asked", async () => {
    const r = await run("jira_get_workflow_scheme", { scheme_id: 10100, draft: true }, () => ({ body: { ...SCHEME, draft: true } }));
    assert.equal(path(r.calls[0]), "/rest/api/2/workflowscheme/10100/draft");
    assert.equal(r.value.draft, true);
  });

  it("sets an issue type mapping and reports the previous workflow", async () => {
    const r = await run("jira_set_workflow_scheme_mapping", { scheme_id: 10100, issue_type_id: "1", workflow: "New Bug WF", update_draft_if_needed: true, dry_run: false }, () => ({ body: SCHEME }));
    assert.ok(r.res.ok);
    const put = r.calls.find((c) => c.method === "PUT")!;
    assert.equal(path(put), "/rest/api/2/workflowscheme/10100/issuetype/1");
    assert.deepEqual(put.body, { issueType: "1", workflow: "New Bug WF", updateDraftIfNeeded: true });
    assert.match(r.value.summary, /Bug WF → New Bug WF/);
  });

  it("removes an issue type mapping (dry run by default)", async () => {
    const r = await run("jira_delete_workflow_scheme_mapping", { scheme_id: 10100, issue_type_id: "1" }, () => ({ body: SCHEME }));
    assert.equal(r.value.dry_run, true);
    assert.ok(!r.calls.some((c) => c.method === "DELETE"));
    const url = new URL(r.value.request.url);
    assert.equal(url.pathname, "/rest/api/2/workflowscheme/10100/issuetype/1");
    assert.equal(url.searchParams.get("updateDraftIfNeeded"), "false");
  });

  it("refuses to remove a mapping that does not exist", async () => {
    const r = await run("jira_delete_workflow_scheme_mapping", { scheme_id: 10100, issue_type_id: "7" }, () => ({ body: SCHEME }));
    assert.equal(r.res.ok, false);
  });

  it("sets the default workflow", async () => {
    const r = await run("jira_set_workflow_scheme_default", { scheme_id: 10100, workflow: "FDP Workflow", dry_run: false }, () => ({ body: SCHEME }));
    const put = r.calls.find((c) => c.method === "PUT")!;
    assert.equal(path(put), "/rest/api/2/workflowscheme/10100/default");
    assert.deepEqual(put.body, { workflow: "FDP Workflow", updateDraftIfNeeded: false });
    assert.match(r.value.summary, /jira → FDP Workflow/);
  });
});

const ITS = {
  id: "10300", name: "FDP Issue Types", description: "FDP",
  defaultIssueType: { id: "1", name: "Bug" },
  issueTypes: [{ id: "1", name: "Bug", subtask: false }, { id: "5", name: "Sub-task", subtask: true }],
};
const ALL_TYPES = [...ISSUE_TYPES, { id: "10200", name: "Risk", subtask: false }];

function itsResponder(c: Call) {
  const p = path(c);
  if (p === "/rest/api/2/issuetype") return { body: ALL_TYPES };
  if (p.endsWith("/associations")) return { body: [{ key: "FDP", name: "Fin Data" }] };
  if (p === "/rest/api/2/issuetypescheme") return { body: { schemes: [ITS, { id: "10000", name: "Default Issue Type Scheme" }] } };
  return { body: ITS };
}

describe("issue type schemes", () => {
  it("lists schemes filtered by name", async () => {
    const r = await run("jira_list_issue_type_schemes", { name_contains: "fdp" }, itsResponder);
    assert.deepEqual(r.value.items.map((s: any) => s.id), ["10300"]);
  });

  it("gets a scheme with its issue types, default type and projects", async () => {
    const r = await run("jira_get_issue_type_scheme", { scheme_id: 10300 }, itsResponder);
    assert.ok(r.res.ok);
    assert.equal(new URL(r.calls[0].url).searchParams.get("expand"), "issueTypes,defaultIssueType");
    assert.equal(r.value.defaultIssueTypeId, "1");
    assert.deepEqual(r.value.issueTypes.map((t: any) => t.id), ["1", "5"]);
    assert.deepEqual(r.value.projects, ["FDP"]);
    assert.equal(r.value.projectCount, 1);
    const capped = await run("jira_get_issue_type_scheme", { scheme_id: 10300, max_projects: 0 }, itsResponder);
    assert.deepEqual(capped.value.projects, []);
    assert.equal(capped.value.projectCount, 1);
  });

  it("adds issue types by keeping the current list and the default", async () => {
    const r = await run("jira_add_issue_types_to_scheme", { scheme_id: 10300, issue_type_ids: "10200,5", dry_run: false }, itsResponder);
    assert.ok(r.res.ok);
    const put = r.calls.find((c) => c.method === "PUT")!;
    assert.equal(path(put), "/rest/api/2/issuetypescheme/10300");
    assert.deepEqual(put.body, { name: "FDP Issue Types", description: "FDP", defaultIssueTypeId: "1", issueTypeIds: ["1", "5", "10200"] });
    assert.match(r.value.summary, /Risk/);
  });

  it("can make an added type the default", async () => {
    const r = await run("jira_add_issue_types_to_scheme", { scheme_id: 10300, issue_type_ids: "10200", default_issue_type_id: "10200" }, itsResponder);
    assert.equal(r.value.dry_run, true);
    assert.equal(r.value.request.body.defaultIssueTypeId, "10200");
  });

  it("rejects unknown ids, nothing to add, and a default outside the scheme", async () => {
    const unknown = await run("jira_add_issue_types_to_scheme", { scheme_id: 10300, issue_type_ids: "999" }, itsResponder);
    assert.equal(unknown.res.ok, false);
    const nothing = await run("jira_add_issue_types_to_scheme", { scheme_id: 10300, issue_type_ids: "1" }, itsResponder);
    assert.equal(nothing.res.ok, false);
    const badDefault = await run("jira_add_issue_types_to_scheme", { scheme_id: 10300, issue_type_ids: "10200", default_issue_type_id: "777" }, itsResponder);
    assert.equal(badDefault.res.ok, false);
    for (const r of [unknown, nothing, badDefault]) assert.ok(!r.calls.some((c) => c.method === "PUT"));
  });
});
