import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AtlassianClient } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { resolveIssueType } from "../../src/tools/jira/issueTypeRefs.js";
import { runToolByName } from "../../src/runner.js";
import { fakeFetch, testContext, TEST_ENV, type Call } from "./helpers.js";

const TYPES = [{ id: "1", name: "Bug" }, { id: "10004", name: "Incident" }, { id: "10005", name: "Change Request" }];
const client = (responder = (c: Call) => (new URL(c.url).pathname === "/rest/api/2/issuetype" ? { body: TYPES } : undefined)) => {
  const { fetch, calls } = fakeFetch(responder);
  return { c: new AtlassianClient(loadConfig("jira", TEST_ENV), fetch), calls };
};

describe("issue type references (unify 1.3)", () => {
  it("resolves ids without a lookup and names case-insensitively", async () => {
    const { c, calls } = client();
    assert.deepEqual(await resolveIssueType(c, "10004"), { id: "10004", ref: "10004" });
    assert.equal(calls.length, 0);
    const byName = await resolveIssueType(c, "change request");
    assert.equal(byName.id, "10005");
    assert.equal(byName.name, "Change Request");
    // the identity keeps the name as typed, as a pending reference does, so a plan never drifts on case alone
    assert.deepEqual(byName.ref, { issueType: "change request" });
  });

  it("fails on an unknown name, or gives a pending reference when allowed", async () => {
    const { c } = client();
    await assert.rejects(resolveIssueType(c, "Nope"), /No issue type 'Nope'/);
    const pending = await resolveIssueType(c, "Problem", { allowPending: true });
    assert.equal(pending.pending, true);
    assert.equal(pending.id, undefined);
  });

  it("old and new argument names give the same request", async () => {
    const responder = (c: Call) => {
      const p = new URL(c.url).pathname;
      if (p === "/rest/api/2/issuetype") return { body: TYPES };
      return { body: { id: 7, name: "WS", defaultWorkflow: "jira", issueTypeMappings: {} } };
    };
    const run = async (args: Record<string, unknown>) => {
      const { ctx } = testContext(responder);
      const r: any = await runToolByName("jira_set_workflow_scheme_mapping", { scheme_id: 7, workflow: "Ops WF", ...args }, ctx);
      assert.ok(r.ok, JSON.stringify(r.error));
      return r.value.request;
    };
    const old = await run({ issue_type_id: "10004" });
    assert.deepEqual(await run({ issue_type: "10004" }), old);
    assert.deepEqual(await run({ issue_type: "Incident" }), old);
  });
});

describe("jira_create_issue issue type by id", () => {
  it("sends an id as an id and a name as a name", async () => {
    const run = async (issue_type: string) => {
      const { ctx } = testContext(() => ({ body: [] }));
      const r: any = await runToolByName("jira_create_issue", { project_key: "TEST", summary: "S", issue_type }, ctx);
      assert.ok(r.ok, JSON.stringify(r.error));
      return r.value.request.body.fields.issuetype;
    };
    assert.deepEqual(await run("10004"), { id: "10004" });
    assert.deepEqual(await run("Task"), { name: "Task" });
  });
});
