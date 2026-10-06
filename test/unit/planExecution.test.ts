import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { VerificationError } from "../../src/errors.js";
import { render } from "../../src/format.js";
import { requireJiraVersion } from "../../src/jiraVersion.js";
import { addToPlan, applyPlan, digestOf, readPlan, recordDeclined, renderPlan } from "../../src/plan.js";
import { runToolByName, toToolError } from "../../src/runner.js";
import { resolveField } from "../../src/tools/jira/fieldRefs.js";
import { alreadySatisfied } from "../../src/tools/util.js";
import { testContext } from "./helpers.js";

const tmpPlan = () => join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");

async function plan(file: string, tool: string, args: Record<string, unknown>) {
  const { ctx } = testContext();
  const res = await runToolByName(tool, args, ctx);
  assert.ok(res.ok);
  return addToPlan(file, tool, args, res.value);
}

describe("already-satisfied results", () => {
  it("render as one line and are not write results needing approval", () => {
    const v = alreadySatisfied("Remove Labels from tab 1", "the field is not on the tab");
    assert.equal(v.already_satisfied, true);
    assert.equal(render(v, "compact"), "ALREADY-SATISFIED | Remove Labels from tab 1 | the field is not on the tab");
  });

  it("count as already-satisfied during apply, not as drift", async () => {
    const file = tmpPlan();
    // plan a group add, then let the user already be a member when applying
    await plan(file, "jira_add_user_to_group", { group: "g1", username: "ivan" });
    const p = readPlan(file);
    p.items[0].tool = "test_already_satisfied";
    const outcomes = await applyPlan(testContext().ctx, p, undefined, undefined, async (name, args, ctx) =>
      name === "test_already_satisfied"
        ? ({ ok: true, value: alreadySatisfied("Add ivan to g1", "already a member"), exitCode: 0 } as any)
        : runToolByName(name, args, ctx));
    assert.equal(outcomes[0].status, "already-satisfied");
  });
});

describe("plan outcomes", () => {
  it("records outcomes in the file, shows remaining work and skips finished items on re-apply", async () => {
    const file = tmpPlan();
    for (const g of ["g1", "g2", "g3", "g4", "g5"]) await plan(file, "jira_add_user_to_group", { group: g, username: "ivan" });

    const failing = testContext((c) => (c.url.includes("groupname=g4") && c.method === "POST" ? { status: 500, body: { errorMessages: ["boom"] } } : undefined));
    const first = await applyPlan(failing.ctx, readPlan(file), [1, 2, 3, 4], file);
    recordDeclined(file, [5]);
    assert.deepEqual(first.map((o) => o.status), ["done", "done", "done", "failed"]);

    const stored = readPlan(file);
    assert.deepEqual(stored.items.map((i) => i.outcome?.status), ["done", "done", "done", "failed", "declined"]);
    const text = renderPlan(stored, file);
    assert.match(text, /1\. \[done\]/);
    assert.match(text, /4\. \[failed\]/);
    assert.match(text, /5\. \[declined\]/);
    assert.match(text, /remaining 2/);

    const again = testContext();
    const second = await applyPlan(again.ctx, readPlan(file), undefined, file);
    assert.deepEqual(second.filter((o) => o.status !== "skipped").map((o) => o.n), [4, 5]);
    assert.equal(again.calls.filter((c) => c.method === "POST").length, 2);
    assert.match(renderPlan(readPlan(file), file), /remaining 0/);
  });

  it("loads a plan written without outcomes", () => {
    const file = tmpPlan();
    writeFileSync(file, JSON.stringify({ version: 1, items: [{ n: 1, tool: "x", args: {}, summary: "s", request: {}, digest: "d", plannedAt: "t" }] }));
    assert.match(renderPlan(readPlan(file), file), /remaining 1/);
  });
});

describe("plan identity and state", () => {
  const base = { request: { method: "POST", url: "u/customfield_10300/context", body: { a: 1 } } };

  it("keeps digests of plain dry runs unchanged", () => {
    assert.equal(digestOf({ ...base }), digestOf({ ...base, identity: undefined, state: undefined }));
  });

  it("uses identity instead of the resolved request", () => {
    const planned = { ...base, request: { ...base.request, url: "u/{Release URL}/context" }, identity: { field: { field: "Release URL" }, body: { a: 1 } } };
    const applied = { ...base, identity: { field: { field: "Release URL" }, body: { a: 1 } } };
    assert.equal(digestOf(planned), digestOf(applied));
  });

  it("drifts when the target state changed", () => {
    assert.notEqual(digestOf({ ...base, state: ["labels", "summary"] }), digestOf({ ...base, state: ["summary", "labels"] }));
  });
});

describe("Jira version gate", () => {
  it("allows 11.3.x and refuses other versions before any other request", async () => {
    const ok = testContext(() => ({ body: { version: "11.3.6" } }));
    await requireJiraVersion(ok.ctx.client("jira"), "Detail View changes");
    await requireJiraVersion(ok.ctx.client("jira"), "Detail View changes");
    assert.equal(ok.calls.length, 1, "version is read once per client");

    const old = testContext(() => ({ body: { version: "10.3.4" } }));
    await assert.rejects(requireJiraVersion(old.ctx.client("jira"), "Detail View changes"), /11\.3\.x.*10\.3\.4/);
  });
});

describe("field references", () => {
  const FIELDS = [
    { id: "labels", name: "Labels", custom: false, schema: { type: "array" } },
    { id: "customfield_10300", name: "Release URL", custom: true, schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:url" } },
    { id: "customfield_10301", name: "Twin", custom: true, schema: {} },
    { id: "customfield_10302", name: "twin", custom: true, schema: {} },
  ];
  const client = () => testContext(() => ({ body: FIELDS })).ctx.client("jira");

  it("resolves ids, system ids and exact names", async () => {
    assert.equal((await resolveField(client(), "customfield_10300")).id, "customfield_10300");
    assert.equal((await resolveField(client(), "labels")).id, "labels");
    const byName = await resolveField(client(), "release url");
    assert.equal(byName.id, "customfield_10300");
    assert.deepEqual(byName.ref, { field: "release url" });
  });

  it("returns a pending reference only in dry runs and fails on ambiguity", async () => {
    const pending = await resolveField(client(), "Not Yet", { allowPending: true });
    assert.equal(pending.pending, true);
    assert.equal(pending.id, undefined);
    await assert.rejects(resolveField(client(), "Not Yet"), /not found/);
    await assert.rejects(resolveField(client(), "Twin"), /ambiguous/i);
  });
});

describe("verification errors", () => {
  it("carry the stored state and exit 1", () => {
    const err = toToolError(new VerificationError("Labels is still on the tab", { fields: ["labels"] }));
    assert.equal(err.type, "VerificationError");
    assert.deepEqual(err.state, { fields: ["labels"] });
  });
});
