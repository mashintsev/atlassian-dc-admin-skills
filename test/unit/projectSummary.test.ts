import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => new URL(c.url).pathname;

describe("project scheme summary (4.5)", () => {
  function responder(scheme: { status: number; body?: unknown }) {
    return (c: Call) => {
      const p = path(c);
      if (p === "/rest/api/2/project/TEST") return { body: { key: "TEST", name: "Test", issueTypes: [] } };
      if (p.endsWith("/workflowscheme")) return scheme;
      if (p === "/rest/api/2/issuetypescheme") return { body: { schemes: [] } };
      if (p.endsWith("/permissionscheme")) return { body: { id: 1, name: "Perms" } };
      return { status: 404, body: {} };
    };
  }

  it("reports a throttled or failing scheme read as an error, not as the default scheme", async () => {
    for (const status of [429, 500]) {
      const { ctx } = testContext(responder({ status, body: {} }));
      const r = await runToolByName("jira_get_project_config", { project_key: "TEST" }, ctx);
      assert.ok(r.ok, JSON.stringify((r as any).error));
      const wf = (r.value as any).schemes.workflowScheme;
      assert.notEqual(wf.name, "Default", `HTTP ${status} must not read as the default scheme`);
      assert.match(wf.error, new RegExp(`HTTP ${status}`));
    }
  });

  it("still reads a 404 as the default scheme", async () => {
    const { ctx } = testContext(responder({ status: 404, body: {} }));
    const r = await runToolByName("jira_get_project_config", { project_key: "TEST" }, ctx);
    assert.equal((r as any).value.schemes.workflowScheme.name, "Default");
    assert.equal((r as any).value.schemes.notificationScheme.name, "Default");
  });
});
