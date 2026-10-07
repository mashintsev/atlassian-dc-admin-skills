import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AtlassianClient } from "../../src/client.js";
import { loadConfig } from "../../src/config.js";
import { jiraVersion, jsmVersion } from "../../src/jiraVersion.js";
import { cached, invalidateScans } from "../../src/scanCache.js";
import { fakeFetch, TEST_ENV } from "./helpers.js";

const newClient = (responder: any) => {
  const { fetch, calls } = fakeFetch(responder);
  return { client: new AtlassianClient(loadConfig("jira", TEST_ENV), fetch), calls };
};

describe("scan cache (4.1)", () => {
  it("shares one promise per kind and key, and forgets rejected ones", async () => {
    const { client } = newClient(() => ({ body: {} }));
    let runs = 0;
    const scan = () => cached(client, "workflow-usage", "500", async () => ++runs);
    assert.equal(await scan(), 1);
    assert.equal(await scan(), 1);
    assert.equal(await cached(client, "workflow-usage", "2000", async () => ++runs), 2, "other key, own entry");
    invalidateScans(client, ["workflow-usage"]);
    assert.equal(await scan(), 3);
    let fail = true;
    const flaky = () => cached(client, "screen-usage", "1", async () => { if (fail) throw new Error("boom"); return "ok"; });
    await assert.rejects(flaky());
    fail = false;
    assert.equal(await flaky(), "ok");
  });

  it("retries the Jira and JSM version reads after a failure in the same run", async () => {
    let n = 0;
    const { client } = newClient(() => (n++ === 0 ? { status: 400, body: {} } : { body: { version: "11.3.7" } }));
    await assert.rejects(jiraVersion(client));
    assert.equal(await jiraVersion(client), "11.3.7");
    let m = 0;
    const jsm = newClient(() => (m++ === 0 ? { status: 400, body: {} } : { body: { version: "11.3.5" } }));
    await assert.rejects(jsmVersion(jsm.client));
    assert.equal(await jsmVersion(jsm.client), "11.3.5");
  });
});

describe("writes declare and clear the scans they make stale (4.2)", async () => {
  const { TOOL_GROUPS } = await import("../../src/tools/index.js");
  const { runToolByName } = await import("../../src/runner.js");
  const { testContext } = await import("./helpers.js");

  it("every write tool in the scheme, project and screen groups declares invalidates (possibly empty)", () => {
    const groups = TOOL_GROUPS.filter(([title]) => /workflow schemes|projects and roles|— screens/.test(title));
    assert.equal(groups.length, 3);
    const missing = groups.flatMap(([, tools]) => tools.filter((t) => t.write && !Array.isArray(t.invalidates)).map((t) => t.name));
    assert.deepEqual(missing, []);
  });

  it("an executed write clears the declared scans; a dry run does not", async () => {
    const { ctx } = testContext((c) => (new URL(c.url).pathname.endsWith("/workflowscheme/1") ? { body: { id: 1, name: "S", defaultWorkflow: "jira", issueTypeMappings: {} } } : { body: {} }));
    const client = ctx.client("jira");
    let runs = 0;
    const scan = () => cached(client, "workflow-usage", "500", async () => ++runs);
    await scan();
    await runToolByName("jira_set_workflow_scheme_default", { scheme_id: 1, workflow: "Other WF" }, ctx);
    assert.equal(await scan(), 1, "dry run keeps the scan");
    await runToolByName("jira_set_workflow_scheme_default", { scheme_id: 1, workflow: "Other WF", dry_run: false }, ctx);
    assert.equal(await scan(), 2, "executed write cleared it");
  });
});
