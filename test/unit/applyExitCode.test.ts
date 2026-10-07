import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EXIT } from "../../src/format.js";
import { applyExitCode, renderOutcomes, type ApplyOutcome } from "../../src/plan.js";

const o = (n: number, status: ApplyOutcome["status"]): ApplyOutcome => ({ n, status, summary: `item ${n}`, tool: "t" } as ApplyOutcome);

describe("apply exit code (fix-cli-output 2.1)", () => {
  it("is 0 when every item is done or already satisfied, and when nothing ran", () => {
    assert.equal(applyExitCode([o(1, "done"), o(2, "already-satisfied")]), EXIT.OK);
    assert.equal(applyExitCode([o(1, "skipped"), o(2, "already-satisfied")]), EXIT.OK);
    assert.equal(applyExitCode([]), EXIT.OK);
  });

  it("is 5 (stale) for drift without failures, and 1 when anything failed", () => {
    assert.equal(applyExitCode([o(1, "done"), o(2, "drifted")]), EXIT.STALE);
    assert.equal(applyExitCode([o(1, "failed"), o(2, "drifted")]), EXIT.GENERIC);
  });

  it("tells how to re-plan drifted items", () => {
    assert.match(renderOutcomes([o(1, "drifted")]), /re-run the dry run.*--plan/);
  });
});

describe("re-plan command for drifted items (unify 4.4)", () => {
  it("prints the tool call that re-plans each drifted item", () => {
    const out = renderOutcomes([
      { ...o(1, "done") },
      { ...o(2, "drifted"), replan: `jira_add_screen_field screen_id=1 tab_id=2 field=components --plan=<file>` } as any,
    ]);
    const lines = out.split("\n");
    const i = lines.findIndex((l) => l.startsWith("2. DRIFTED"));
    assert.match(lines[i + 1]!, /^\s+re-plan: jira_add_screen_field screen_id=1 tab_id=2 field=components --plan=<file>$/);
  });

  it("builds the command from the item's tool and arguments", async () => {
    const { replanCommand } = await import("../../src/plan.js");
    assert.equal(replanCommand("jira_x", { a: "b c", n: 2, list: ["x", "y"], dry_run: false }), `jira_x a='b c' n=2 list='["x","y"]' --plan=<file>`);
  });
});

describe("created objects are recorded in the plan (unify 4.1)", () => {
  it("keeps the id of an object an item created, and offers it to later items", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { addToPlan, applyPlan, readPlan } = await import("../../src/plan.js");
    const file = join(mkdtempSync(join(tmpdir(), "created-")), "p.json");
    const dry = { dry_run: true, summary: "s", request: { method: "POST", url: "u" } };
    addToPlan(file, "make", { name: "Ops scheme" }, dry);
    addToPlan(file, "use", { scheme: "Ops scheme" }, dry);
    let seen: unknown;
    const run = async (tool: string, args: any, ctx: any) => {
      if (args.dry_run) return { ok: true, value: dry } as any;
      if (tool === "make") return { ok: true, value: { dry_run: false, created: { type: "workflow-scheme", name: "Ops scheme", id: 42 } } } as any;
      seen = ctx.created?.("workflow-scheme");
      return { ok: true, value: { dry_run: false } } as any;
    };
    const { testContext } = await import("./helpers.js");
    await applyPlan(testContext().ctx, readPlan(file), undefined, file, run);
    assert.deepEqual(readPlan(file).items[0]!.outcome!.created, { type: "workflow-scheme", name: "Ops scheme", id: "42" });
    assert.deepEqual(seen, [{ type: "workflow-scheme", name: "Ops scheme", id: "42" }]);
  });
});
