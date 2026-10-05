import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : String((res as any).error?.message ?? (res as any).error), calls };
}

const path = (c: Call) => new URL(c.url).pathname;

const WS = { id: 10100, name: "FDP WS", description: "FDP", defaultWorkflow: "jira", issueTypeMappings: { "1": "Bug WF", "5": "Bug WF", "3": "Task WF" } };
const DRAFT = { id: 10100, name: "FDP WS", defaultWorkflow: "jira", issueTypeMappings: { "1": "New Bug WF", "3": "Task WF", "7": "Story WF" }, draft: true };

describe("workflow scheme CRUD", () => {
  it("creates a scheme from scratch", async () => {
    const r = await run("jira_create_workflow_scheme", { name: "New WS", default_workflow: "jira", issue_type_mappings: '{"1":"Bug WF"}', dry_run: false }, (c) =>
      c.method === "POST" ? { status: 201, body: { id: 10200, name: "New WS" } } : undefined);
    assert.ok(r.res.ok);
    const post = r.calls.find((c) => c.method === "POST")!;
    assert.equal(path(post), "/rest/api/2/workflowscheme");
    assert.deepEqual(post.body, { name: "New WS", defaultWorkflow: "jira", issueTypeMappings: { "1": "Bug WF" } });
  });

  it("copies a scheme and lets explicit mappings override the copied ones", async () => {
    const r = await run("jira_create_workflow_scheme", { name: "FDP WS copy", copy_from_scheme_id: 10100, issue_type_mappings: { "3": "Other WF" } }, () => ({ body: WS }));
    assert.equal(r.value.dry_run, true);
    assert.equal(path(r.calls[0]), "/rest/api/2/workflowscheme/10100");
    assert.deepEqual(r.value.request.body, {
      name: "FDP WS copy", description: "FDP", defaultWorkflow: "jira",
      issueTypeMappings: { "1": "Bug WF", "5": "Bug WF", "3": "Other WF" },
    });
  });

  it("updates only name and description", async () => {
    const r = await run("jira_update_workflow_scheme", { scheme_id: 10100, name: "FDP Workflows", dry_run: false }, () => ({ body: WS }));
    const put = r.calls.find((c) => c.method === "PUT")!;
    assert.equal(path(put), "/rest/api/2/workflowscheme/10100");
    assert.deepEqual(put.body, { name: "FDP Workflows", updateDraftIfNeeded: false });
  });

  it("requires something to update", async () => {
    const r = await run("jira_update_workflow_scheme", { scheme_id: 10100 }, () => ({ body: WS }));
    assert.equal(r.res.ok, false);
  });

  it("deletes a scheme and calls it irreversible", async () => {
    const r = await run("jira_delete_workflow_scheme", { scheme_id: 10100 }, () => ({ body: WS }));
    assert.equal(r.value.dry_run, true);
    assert.equal(r.value.request.method, "DELETE");
    assert.match(r.value.summary, /irreversible/i);
    assert.match(r.value.summary, /FDP WS/);
  });
});

describe("workflow scheme drafts", () => {
  it("creates a draft", async () => {
    const r = await run("jira_create_workflow_scheme_draft", { scheme_id: 10100, dry_run: false }, () => ({ body: WS }));
    const post = r.calls.find((c) => c.method === "POST")!;
    assert.equal(path(post), "/rest/api/2/workflowscheme/10100/createdraft");
  });

  it("discards a draft only when one exists", async () => {
    const ok = await run("jira_delete_workflow_scheme_draft", { scheme_id: 10100 }, () => ({ body: DRAFT }));
    assert.equal(ok.value.request.method, "DELETE");
    assert.equal(new URL(ok.value.request.url).pathname, "/rest/api/2/workflowscheme/10100/draft");
    const none = await run("jira_delete_workflow_scheme_draft", { scheme_id: 10100 }, () => ({ status: 404, body: { errorMessages: ["no draft"] } }));
    assert.equal(none.res.ok, false);
  });

  it("compares draft and published mappings", async () => {
    const r = await run("jira_compare_workflow_scheme_draft", { scheme_id: 10100 }, (c) => ({ body: path(c).endsWith("/draft") ? DRAFT : WS }));
    assert.ok(r.res.ok);
    assert.equal(r.value.hasDraft, true);
    assert.deepEqual(r.value.changes, [
      { issueType: "1", published: "Bug WF", draft: "New Bug WF" },
      { issueType: "5", published: "Bug WF", draft: "(default jira)" },
      { issueType: "7", published: "(default jira)", draft: "Story WF" },
    ]);
  });

  it("reports no draft without failing", async () => {
    const r = await run("jira_compare_workflow_scheme_draft", { scheme_id: 10100 }, (c) =>
      path(c).endsWith("/draft") ? { status: 404, body: {} } : { body: WS });
    assert.equal(r.value.hasDraft, false);
    assert.deepEqual(r.value.changes, []);
  });
});

const PROJECTS = [{ key: "FDP" }, { key: "OPS" }, { key: "HR" }];
function usageResponder(c: Call) {
  const p = path(c);
  if (p === "/rest/api/2/project") return { body: PROJECTS };
  if (p === "/rest/api/2/project/FDP/workflowscheme" || p === "/rest/api/2/project/OPS/workflowscheme") return { body: WS };
  if (p === "/rest/api/2/project/HR/workflowscheme") return { body: { name: "Default Workflow Scheme", defaultWorkflow: "jira", issueTypeMappings: {} } };
  return undefined;
}

describe("workflow scheme discovery", () => {
  it("lists schemes in use, grouped with their projects", async () => {
    const r = await run("jira_list_workflow_schemes", {}, usageResponder);
    assert.ok(r.res.ok);
    assert.equal(r.value.scannedProjects, 3);
    const fdp = r.value.items.find((s: any) => s.id === 10100);
    assert.equal(fdp.projectCount, 2);
    assert.equal(fdp.projects, "FDP,OPS");
    assert.equal(fdp.mappings, 3);
    assert.ok(r.value.items.some((s: any) => s.id === null && s.name === "Default Workflow Scheme"));
  });

  it("bounds the project scan and says so", async () => {
    const r = await run("jira_list_workflow_schemes", { scan_projects: 1 }, usageResponder);
    assert.equal(r.value.scannedProjects, 1);
    assert.equal(r.value.truncatedScan, true);
    assert.equal(r.calls.filter((c) => path(c).endsWith("/workflowscheme")).length, 1);
  });

  it("finds where a workflow is used", async () => {
    const r = await run("jira_find_workflow_usage", { workflow: "Bug WF" }, usageResponder);
    assert.ok(r.res.ok);
    assert.equal(r.value.items.length, 1);
    assert.deepEqual(r.value.items[0], { schemeId: 10100, scheme: "FDP WS", asDefault: false, issueTypes: "1,5", projectCount: 2, projects: "FDP,OPS" });
    const def = await run("jira_find_workflow_usage", { workflow: "jira" }, usageResponder);
    assert.equal(def.value.items.length, 2);
    assert.ok(def.value.items.every((i: any) => i.asDefault));
  });
});

describe("jira_replace_workflow_in_scheme", () => {
  it("moves every mapping of one workflow to another in one request", async () => {
    const r = await run("jira_replace_workflow_in_scheme", { scheme_id: 10100, from_workflow: "Bug WF", to_workflow: "New Bug WF", dry_run: false }, () => ({ body: WS }));
    assert.ok(r.res.ok);
    const puts = r.calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(path(puts[0]), "/rest/api/2/workflowscheme/10100");
    assert.deepEqual(puts[0].body, {
      defaultWorkflow: "jira",
      issueTypeMappings: { "1": "New Bug WF", "5": "New Bug WF", "3": "Task WF" },
      updateDraftIfNeeded: false,
    });
  });

  it("also replaces the default workflow", async () => {
    const r = await run("jira_replace_workflow_in_scheme", { scheme_id: 10100, from_workflow: "jira", to_workflow: "FDP WF" }, () => ({ body: WS }));
    assert.deepEqual(r.value.request.body, { defaultWorkflow: "FDP WF", updateDraftIfNeeded: false });
  });

  it("works on the draft when update_draft_if_needed and a draft exists", async () => {
    const r = await run("jira_replace_workflow_in_scheme", { scheme_id: 10100, from_workflow: "Task WF", to_workflow: "T2", update_draft_if_needed: true }, (c) =>
      ({ body: path(c).endsWith("/draft") ? DRAFT : WS }));
    assert.deepEqual(r.value.request.body, {
      defaultWorkflow: "jira",
      issueTypeMappings: { "1": "New Bug WF", "3": "T2", "7": "Story WF" },
      updateDraftIfNeeded: true,
    });
  });

  it("fails when the workflow is not used in the scheme", async () => {
    const r = await run("jira_replace_workflow_in_scheme", { scheme_id: 10100, from_workflow: "Nope", to_workflow: "X" }, () => ({ body: WS }));
    assert.equal(r.res.ok, false);
    assert.ok(!r.calls.some((c) => c.method === "PUT"));
  });
});

describe("review regressions", () => {
  const draftOrPublished = (c: Call) => ({ body: path(c).endsWith("/draft") ? DRAFT : WS });

  it("replace rejects the same workflow on both sides", async () => {
    const r = await run("jira_replace_workflow_in_scheme", { scheme_id: 10100, from_workflow: "Bug WF", to_workflow: "Bug WF" }, () => ({ body: WS }));
    assert.equal(r.res.ok, false);
  });

  it("mapping tools read the draft when the change goes to the draft", async () => {
    const del = await run("jira_delete_workflow_scheme_mapping", { scheme_id: 10100, issue_type_id: "7", update_draft_if_needed: true }, draftOrPublished);
    assert.ok(del.res.ok, del.error);
    assert.match(del.value.summary, /Story WF/);
    const gone = await run("jira_delete_workflow_scheme_mapping", { scheme_id: 10100, issue_type_id: "5", update_draft_if_needed: true }, draftOrPublished);
    assert.equal(gone.res.ok, false);
    const set = await run("jira_set_workflow_scheme_mapping", { scheme_id: 10100, issue_type_id: "1", workflow: "X", update_draft_if_needed: true }, draftOrPublished);
    assert.match(set.value.summary, /New Bug WF → X/);
  });

  it("delete draft distinguishes a missing scheme from a missing draft", async () => {
    const r = await run("jira_delete_workflow_scheme_draft", { scheme_id: 999 }, () => ({ status: 404, body: { errorMessages: ["not found"] } }));
    assert.equal(r.res.ok, false);
    assert.ok(r.calls.some((c) => path(c) === "/rest/api/2/workflowscheme/999"), "checks the scheme itself");
  });

  it("compare ignores an explicit mapping equal to the default", async () => {
    const pub = { ...WS, issueTypeMappings: {} };
    const drf = { ...WS, issueTypeMappings: { "9": "jira" }, draft: true };
    const r = await run("jira_compare_workflow_scheme_draft", { scheme_id: 10100 }, (c) => ({ body: path(c).endsWith("/draft") ? drf : pub }));
    assert.deepEqual(r.value.changes, []);
  });

  it("scan fails loudly when the per-project endpoint is missing everywhere", async () => {
    const r = await run("jira_list_workflow_schemes", {}, (c) => (path(c) === "/rest/api/2/project" ? { body: PROJECTS } : { status: 404, body: {} }));
    assert.equal(r.res.ok, false);
    assert.match(r.error ?? "", /not available|unavailable/i);
  });

  it("scan reports 403 and 404 projects separately", async () => {
    const r = await run("jira_list_workflow_schemes", {}, (c) => {
      const p = path(c);
      if (p === "/rest/api/2/project") return { body: PROJECTS };
      if (p.includes("/FDP/")) return { body: WS };
      if (p.includes("/OPS/")) return { status: 403, body: {} };
      return { status: 404, body: {} };
    });
    assert.ok(r.res.ok, r.error);
    assert.equal(r.value.forbiddenProjects, 1);
    assert.equal(r.value.notFoundProjects, 1);
  });
});
