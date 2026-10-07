import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../../src/cli.js";
import { coerceArgs, runToolByName } from "../../src/runner.js";
import { findTool } from "../../src/tools/index.js";
import { testContext } from "./helpers.js";

const coerced = (tool: string, ...argv: string[]) => coerceArgs(findTool(tool)!, parseArgs(argv).args);

describe("arguments converted by parameter type (fix-cli-output 3.1)", () => {
  it("keeps number-, boolean- and null-looking text for string parameters", () => {
    assert.deepEqual(coerced("jira_create_version", "project_key=TEST", "name=2025"), { project_key: "TEST", name: "2025" });
    const page = coerced("confluence_copy_page", "title=true", "page=00123");
    assert.equal(page.title, "true");
    assert.equal(page.page, "00123");
    assert.equal(coerced("jira_create_version", "name=null").name, "null");
  });

  it("converts numbers and booleans only where the schema expects them", () => {
    const a = coerced("jira_search", "jql=project=TEST", "limit=20");
    assert.equal(a.limit, 20);
    assert.equal(coerced("atlassian_audit_events", "product=jira", "raw=yes").raw, true);
  });

  it("normalizes dry_run spellings to a boolean, so the confirmation gate sees them", () => {
    for (const v of ["false", "0", "no", "off", "False"]) assert.equal(coerced("jira_create_version", "name=x", `dry_run=${v}`).dry_run, false, v);
    assert.equal(coerced("jira_create_version", "name=x", "dry_run=true").dry_run, true);
  });

  it("keeps comma lists and JSON arrays for list parameters, and inline JSON objects", () => {
    assert.equal(coerced("jira_add_issue_types_to_scheme", "scheme_id=1", "issue_type_ids=1,2").issue_type_ids, "1,2");
    assert.deepEqual(coerced("jira_add_issue_types_to_scheme", "scheme_id=1", 'issue_type_ids=["1","2"]').issue_type_ids, ["1", "2"]);
    assert.deepEqual(parseArgs(['{"name":"2025","project_key":"TEST"}']).args, { name: "2025", project_key: "TEST" });
  });

  it("lets the tool validate name=2025 end to end", async () => {
    const { ctx } = testContext(() => ({ body: [] }));
    const r = await runToolByName("jira_create_version", parseArgs(["project_key=TEST", "name=2025"]).args, ctx);
    assert.ok(r.ok, JSON.stringify((r as any).error));
    assert.equal((r.value as any).request.body.name, "2025");
  });
});
