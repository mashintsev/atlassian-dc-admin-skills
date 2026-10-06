import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addResultToPlan, applyPlan, digestOf, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const GH = "/rest/greenhopper/1.0";

/** Fake board 56 whose Detail View can be changed through the internal resource. */
function fakeBoard(opts: { version?: string; canEdit?: boolean; editmodelStatus?: number } = {}) {
  const cfg = fx("detailviewfield-configured.json");
  let rows: Array<{ id: number; fieldId: string; name: string }> = cfg.currentFields.map((f: any) => ({ id: f.id, fieldId: f.fieldId, name: f.name }));
  const available: any[] = cfg.availableFields;
  let nextId = 500;
  const configured = () => ({
    rapidViewId: 56,
    canEdit: opts.canEdit ?? true,
    currentFields: rows.map((r) => ({ ...r, isValid: true, isEstimationField: false, category: "details" })),
    availableFields: available.filter((a) => !rows.some((r) => r.fieldId === a.fieldId)),
  });
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.version ?? "11.3.6" } };
    if (p === "/rest/agile/1.0/board/56/configuration") return { body: fx("agile-board-configuration.json") };
    if (p === `${GH}/rapidviewconfig/editmodel`) {
      if (opts.editmodelStatus) return { status: opts.editmodelStatus, body: { errorMessages: ["no"] } };
      return { body: { ...fx("greenhopper-editmodel.json"), canEdit: opts.canEdit ?? true, detailViewFieldConfig: configured() } };
    }
    if (p === `${GH}/detailviewfield/56/configured`) return { body: configured() };
    if (p === `${GH}/detailviewfield/56/field` && c.method === "POST") {
      const a = available.find((x) => x.fieldId === c.body.fieldId) ?? { fieldId: c.body.fieldId, name: c.body.fieldId };
      const row = { id: nextId++, fieldId: a.fieldId, name: a.name };
      rows.push(row);
      return { body: row };
    }
    const m = new RegExp(`^${GH}/detailviewfield/56/field/(\\d+)(/move)?$`).exec(p);
    if (m) {
      const row = rows.find((r) => r.id === Number(m[1]))!;
      if (c.method === "DELETE") { rows = rows.filter((r) => r !== row); return { status: 204 }; }
      if (m[2]) {
        rows = rows.filter((r) => r !== row);
        if (c.body.position === "First") rows.unshift(row);
        else rows.splice(rows.findIndex((r) => r.id === Number(String(c.body.after).split("/").pop())) + 1, 0, row);
        return { body: row };
      }
    }
    return undefined;
  };
  return { responder, order: () => rows.map((r) => r.fieldId) };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("jira_get_board_configuration (6.1)", () => {
  it("combines filter, columns, quick filters, card layout, Detail View, estimation, sub-filter and admins", async () => {
    const r = await run("jira_get_board_configuration", { board_id: 56 }, fakeBoard().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const v = r.value;
    assert.deepEqual(v.filter, { id: 10900, name: "Filter for DEMO board", jql: "project = DEMO ORDER BY Rank ASC", owner: "admin" });
    assert.deepEqual(v.columns[1], { name: "In Progress", statuses: ["In Progress"], min: null, max: 5 });
    assert.deepEqual(v.unmappedStatuses, ["Review"]);
    assert.deepEqual(v.quickFilters.map((q: any) => q.name), ["Only my issues", "Recently updated"]);
    assert.deepEqual(v.cardLayout, ["Priority"]);
    assert.deepEqual(v.detailView.map((f: any) => f.fieldId), ["status", "components", "versions", "fixVersions", "labels", "customfield_10201"]);
    assert.equal(v.estimation.name, "Story Points");
    assert.equal(v.subFilter, "fixVersion in unreleasedVersions() OR fixVersion is EMPTY");
    assert.deepEqual(v.administrators, { users: ["Board Admin"], groups: ["demo-leads"] });
    assert.equal(v.canEdit, true);
    assert.equal(v.unavailable, undefined);
  });

  it("returns the public parts and marks the rest unavailable when the internal model is forbidden", async () => {
    const r = await run("jira_get_board_configuration", { board_id: 56 }, fakeBoard({ editmodelStatus: 403 }).responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.columns.length, 3);
    assert.equal(r.value.estimation.field, "customfield_10400");
    assert.match(r.value.unavailable.quickFilters, /403/);
  });
});

describe("Detail View changes (6.2)", () => {
  it("JC-83: removes Components, Affects Version/s and Fix Version/s and keeps Labels and the order", async () => {
    const board = fakeBoard();
    const r = await run("jira_set_board_detail_fields", { board_id: 56, remove_fields: "Component/s,versions,Fix Version/s", dry_run: false }, board.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(board.order(), ["status", "labels", "customfield_10201"]);
    assert.equal(r.calls.filter((c) => c.method === "DELETE").length, 3);
    assert.ok(!r.calls.some((c) => c.method === "POST"), "no moves needed");
    assert.deepEqual(r.value.result.detailView.map((f: any) => f.fieldId), board.order());
  });

  it("dry run shows the old and new list and sends nothing", async () => {
    const r = await run("jira_set_board_detail_fields", { board_id: 56, remove_fields: "components", add_fields: "Start date,Release URL" }, fakeBoard().responder);
    assert.equal(r.value.dry_run, true);
    assert.deepEqual(r.value.before, ["Status", "Component/s", "Affects Version/s", "Fix Version/s", "Labels", "Epic Link"]);
    assert.deepEqual(r.value.after, ["Status", "Affects Version/s", "Fix Version/s", "Labels", "Epic Link", "Start date", "Release URL"]);
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("sets a full ordered list with additions and moves", async () => {
    const board = fakeBoard();
    const fields = "labels,customfield_10500,status,customfield_10201";
    const r = await run("jira_set_board_detail_fields", { board_id: 56, fields, dry_run: false }, board.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(board.order(), fields.split(","));
  });

  it("adds and removes single fields and is satisfied when nothing changes", async () => {
    const board = fakeBoard();
    assert.ok((await run("jira_add_board_detail_field", { board_id: 56, field: "Start date", dry_run: false }, board.responder)).res.ok);
    assert.equal(board.order().at(-1), "customfield_10500");
    assert.ok((await run("jira_remove_board_detail_field", { board_id: 56, field: "Epic Link", dry_run: false }, board.responder)).res.ok);
    assert.ok(!board.order().includes("customfield_10201"));
    const again = await run("jira_add_board_detail_field", { board_id: 56, field: "labels" }, board.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("stops on a field Detail View does not offer, and on conflicting arguments", async () => {
    const r = await run("jira_add_board_detail_field", { board_id: 56, field: "Summary Of Everything" }, fakeBoard().responder);
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /Summary Of Everything/);
    const both = await run("jira_set_board_detail_fields", { board_id: 56, fields: "labels", add_fields: "status" }, fakeBoard().responder);
    assert.equal(both.res.ok, false);
  });

  it("refuses without board edit rights (exit 3) and on other Jira versions", async () => {
    const denied = await run("jira_remove_board_detail_field", { board_id: 56, field: "labels" }, fakeBoard({ canEdit: false }).responder);
    assert.equal(denied.res.ok, false);
    assert.equal(denied.res.exitCode, 3);
    const old = await run("jira_remove_board_detail_field", { board_id: 56, field: "labels" }, fakeBoard({ version: "10.3.4" }).responder);
    assert.equal(old.error.type, "Unsupported");
    assert.ok(!old.calls.some((c) => path(c).startsWith(GH)));
  });

  it("applies several planned single-field changes to one board without drifting itself", async () => {
    const board = fakeBoard();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    for (const [tool, field] of [["jira_remove_board_detail_field", "components"], ["jira_remove_board_detail_field", "versions"], ["jira_add_board_detail_field", "Start date"]]) {
      const r = await run(tool, { board_id: 56, field }, board.responder);
      addResultToPlan(file, tool, { board_id: 56, field }, r.value);
    }
    const outcomes = await applyPlan(testContext(board.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(outcomes.map((o) => o.status), ["done", "done", "done"]);
    assert.deepEqual(board.order(), ["status", "fixVersions", "labels", "customfield_10201", "customfield_10500"]);
  });

  it("stops on an ambiguous field name", async () => {
    const r = await run("jira_add_board_detail_field", { board_id: 56, field: "Twin" }, (c) => {
      if (path(c) === `${GH}/detailviewfield/56/configured`) return { body: { canEdit: true, currentFields: [], availableFields: [{ fieldId: "customfield_1", name: "Twin" }, { fieldId: "customfield_2", name: "twin" }] } };
      return fakeBoard().responder(c);
    });
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /ambiguous/i);
  });

  it("drifts when the Detail View changed after planning", async () => {
    // a full target list is absolute: a field added meanwhile changes what the change does
    const a = await run("jira_set_board_detail_fields", { board_id: 56, fields: "status,labels" }, fakeBoard().responder);
    const board = fakeBoard();
    await run("jira_add_board_detail_field", { board_id: 56, field: "priority", dry_run: false }, board.responder);
    const b = await run("jira_set_board_detail_fields", { board_id: 56, fields: "status,labels" }, board.responder);
    assert.notEqual(digestOf(a.value), digestOf(b.value));
  });
});
