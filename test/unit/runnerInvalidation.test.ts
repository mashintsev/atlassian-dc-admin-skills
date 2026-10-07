import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import type { ToolDef } from "../../src/tools/types.js";
import { dryRunShape } from "../../src/tools/util.js";

describe("scan invalidation after a write (review fix)", () => {
  it("returns the tool's structured error when the client cannot be created", async () => {
    const tool: ToolDef = {
      name: "jira_test_write",
      product: "jira",
      write: true,
      invalidates: ["workflow-usage"],
      description: "test",
      inputShape: { ...dryRunShape },
      async handler(ctx) {
        ctx.client("jira");
        return { dry_run: false };
      },
    };
    const ctx = { client: () => { throw Object.assign(new Error("JIRA_URL is not set"), { name: "ConfigurationError" }); } } as any;
    const r = await runTool(tool, { dry_run: false }, ctx);
    assert.equal(r.ok, false);
    assert.match((r as any).error.message, /JIRA_URL is not set/);
  });
});
