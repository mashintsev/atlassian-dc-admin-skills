import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addToPlan, applyPlan, readPlan, renderOutcomes, renderPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext } from "./helpers.js";

async function plan(file: string, tool: string, args: Record<string, unknown>) {
  const { ctx } = testContext();
  const res = await runToolByName(tool, args, ctx);
  assert.ok(res.ok);
  return addToPlan(file, tool, args, res.value);
}

describe("change plans", () => {
  it("records dry runs, lists them and applies all with one command", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    await plan(file, "jira_add_user_to_group", { group: "g1", username: "ivan" });
    await plan(file, "jira_set_user_active", { user: "olga", active: false });
    const p = readPlan(file);
    assert.equal(p.items.length, 2);
    assert.match(renderPlan(p, file), /2 change\(s\)[\s\S]*1\. Add ivan to g1[\s\S]*2\. Deactivate user olga/);

    const { ctx, calls } = testContext();
    const outcomes = await applyPlan(ctx, p);
    assert.deepEqual(outcomes.map((o) => o.status), ["done", "done"]);
    assert.deepEqual(calls.map((c) => c.method), ["POST", "PUT"]);
    assert.match(renderOutcomes(outcomes), /^applied 2\/2/);
  });

  it("applies only the selected items", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    await plan(file, "jira_add_user_to_group", { group: "g1", username: "ivan" });
    await plan(file, "jira_add_user_to_group", { group: "g2", username: "ivan" });
    const { ctx, calls } = testContext();
    const outcomes = await applyPlan(ctx, readPlan(file), [2]);
    assert.equal(outcomes.length, 1);
    assert.match(calls[0].url, /groupname=g2/);
  });

  it("skips an item whose request changed since it was approved", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const page = (version: number) => (c: any) =>
      c.method === "GET" ? { body: { id: "42", type: "page", title: "T", version: { number: version }, space: { key: "DOC" } } } : undefined;
    {
      const { ctx } = testContext(page(3));
      const res = await runToolByName("confluence_update_page", { page: "42", title: "T", content: "<p>x</p>", content_format: "storage" }, ctx);
      assert.ok(res.ok, JSON.stringify(!res.ok && res.error));
      addToPlan(file, "confluence_update_page", { page: "42", title: "T", content: "<p>x</p>", content_format: "storage" }, res.value);
    }
    const { ctx, calls } = testContext(page(4)); // someone edited the page meanwhile
    const outcomes = await applyPlan(ctx, readPlan(file));
    assert.equal(outcomes[0].status, "drifted");
    assert.ok(calls.every((c) => c.method === "GET"));
  });
});
