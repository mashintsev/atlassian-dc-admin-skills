import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { runTool } from "../../src/runner.js";
import type { ToolDef } from "../../src/tools/types.js";
import { testContext } from "./helpers.js";

const echo: ToolDef = {
  name: "test_echo",
  product: "jira",
  description: "Echo",
  inputShape: { field: z.string(), limit: z.coerce.number().optional() },
  aliases: { field_id: "field" },
  async handler(_ctx, args) {
    return args;
  },
};

describe("argument aliases (unify 1.1)", () => {
  const { ctx } = testContext();

  it("accepts the old name as an alias of the canonical one", async () => {
    const r = await runTool(echo, { field_id: "customfield_1", limit: "5" }, ctx);
    assert.ok(r.ok, JSON.stringify((r as any).error));
    assert.deepEqual(r.value, { field: "customfield_1", limit: 5 });
  });

  it("accepts an identical duplicate and refuses conflicting values", async () => {
    const same = await runTool(echo, { field_id: "a", field: "a" }, ctx);
    assert.ok(same.ok);
    const conflict = await runTool(echo, { field_id: "a", field: "b" }, ctx);
    assert.equal(conflict.ok, false);
    assert.equal((conflict as any).error.type, "ValidationError");
    assert.match((conflict as any).error.message, /field_id.*field/);
  });
});

describe("describe shows aliases (unify 1.2)", () => {
  it("prints the old name next to the canonical argument", async () => {
    const { describeTool } = await import("../../src/cli.js");
    const { ALL_TOOLS } = await import("../../src/tools/index.js");
    const tool = ALL_TOOLS.find((t) => t.aliases && Object.keys(t.aliases).length);
    assert.ok(tool, "at least one tool declares aliases");
    const [alias, canonical] = Object.entries(tool!.aliases!)[0]!;
    assert.match(describeTool(tool!.name, false)!, new RegExp(`${canonical}\\??: [^\\n]*\\(alias: ${alias}\\)`));
  });
});

describe("old names give the same request (unify 1.4)", async () => {
  const { runToolByName } = await import("../../src/runner.js");
  const same = async (tool: string, oldArgs: Record<string, unknown>, newArgs: Record<string, unknown>, responder?: any) => {
    const req = async (args: Record<string, unknown>) => {
      const { ctx, calls } = testContext(responder);
      const r: any = await runToolByName(tool, args, ctx);
      assert.ok(r.ok, `${tool} ${JSON.stringify(args)}: ${JSON.stringify(r.error)}`);
      return JSON.stringify({ value: r.value, calls: calls.map((c) => [c.method, c.url, c.body]) });
    };
    assert.equal(await req(oldArgs), await req(newArgs), tool);
  };

  it("user, project, service desk and property key", async () => {
    await same("jira_add_user_to_group", { group: "g", username: "ivan" }, { group: "g", user: "ivan" });
    await same("jira_kill_user_sessions", { username: "ivan" }, { user: "ivan" });
    await same("jira_add_watcher", { issue_key: "TEST-1", username: "ivan" }, { issue_key: "TEST-1", user: "ivan" });
    await same("confluence_add_user_to_group", { group: "g", username: "ivan" }, { group: "g", user: "ivan" });
    await same("jira_set_application_property", { id: "jira.title", value: "X" }, { key: "jira.title", value: "X" });
    await same("jira_get_request_types", { service_desk_id: "3" }, { service_desk: "3" }, () => ({ body: { values: [], isLastPage: true } }));
  });

  it("a service desk given by project key resolves to its id", async () => {
    const { ctx, calls } = testContext((c: any) => {
      const p = new URL(c.url).pathname;
      if (p === "/rest/servicedeskapi/servicedesk") return { body: { values: [{ id: "3", projectKey: "TEST" }], isLastPage: true } };
      return { body: { values: [], isLastPage: true } };
    });
    const r: any = await runToolByName("jira_get_request_types", { service_desk: "TEST" }, ctx);
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.ok(calls.some((c) => new URL(c.url).pathname === "/rest/servicedeskapi/servicedesk/3/requesttype"));
  });
});

describe("unverifiable writes are marked", () => {
  it("describe shows the reason and a dry run warns about repeats", async () => {
    const { describeTool } = await import("../../src/cli.js");
    const marked: ToolDef = { name: "test_marked", product: "jira", write: true, description: "Start", unverifiable: "Jira reports no state", inputShape: { dry_run: z.boolean().optional() },
      async handler() { return { dry_run: true, summary: "x", request: { method: "POST", url: "u" } }; } };
    const r: any = await runTool(marked, {}, testContext().ctx);
    assert.match(r.value.warning, /not verifiable \(Jira reports no state\).*repeated apply/);
    const { ALL_TOOLS } = await import("../../src/tools/index.js");
    ALL_TOOLS.push(marked);
    try {
      assert.match(describeTool("test_marked", false)!, /not verifiable: Jira reports no state/);
    } finally {
      ALL_TOOLS.pop();
    }
  });
});
