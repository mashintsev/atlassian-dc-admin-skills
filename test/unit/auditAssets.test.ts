import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const OBJ = { id: 77, objectKey: "ITAM-7", label: "LT-7", objectType: { id: 31, name: "Laptop" } };

async function run(name: string, args: Record<string, unknown>, body: (c: Call) => unknown) {
  const { ctx, calls } = testContext((c) => {
    const path = new URL(c.url).pathname;
    if (/\/rest\/insight\/1\.0\/object\/(77|ITAM-7)$/.test(path)) return { body: OBJ };
    return { body: body(c) };
  });
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, calls };
}

const params = (c: Call) => new URL(c.url).searchParams;
const callTo = (calls: Call[], frag: string) => calls.find((c) => c.url.includes(frag))!;

describe("assets read tools: paging, server-side filters, minimal payload", () => {
  it("assets_search asks only for what it shows", async () => {
    const r = await run("assets_search", { aql: "objectType = Laptop", attributes: [] }, () => ({ totalFilterCount: 0, objectEntries: [] }));
    const p = params(callTo(r.calls, "/aql/objects"));
    assert.equal(p.get("includeAttributes"), "false");
    assert.equal(p.get("includeTypeAttributes"), "false");
    assert.equal(p.get("includeAttributesDeep"), "0");
    assert.equal(p.get("includeExtendedInfo"), "false");
    assert.equal(p.get("page"), "1");
    assert.equal(p.get("resultPerPage"), "25");
  });

  it("assets_search with attributes keeps reference depth 1 and pages", async () => {
    const r = await run("assets_search", { aql: "x", page: 3, limit: 10 }, () => ({ totalFilterCount: 0, objectEntries: [] }));
    const p = params(callTo(r.calls, "/aql/objects"));
    assert.equal(p.get("includeAttributesDeep"), "1");
    assert.equal(p.get("page"), "3");
    assert.equal(p.get("resultPerPage"), "10");
  });

  it("assets_list_schemas filters on the server", async () => {
    const r = await run("assets_list_schemas", { name_contains: "IT", limit: 1 }, () => ({
      objectschemas: [{ id: 1, name: "IT Assets", objectSchemaKey: "ITAM" }, { id: 2, name: "IT People", objectSchemaKey: "ITP" }],
    }));
    assert.equal(params(callTo(r.calls, "/objectschema/list")).get("query"), "IT");
    assert.equal(r.value.returned, 1);
    assert.equal(r.value.nextOffset, 1);
  });

  it("assets_list_attributes sends filters to the server", async () => {
    const r = await run("assets_list_attributes", { object_type_id: 31, name_contains: "own", only_editable: true, exclude_inherited: true }, () => [
      { id: 3, name: "Owner", type: 2 },
    ]);
    const p = params(callTo(r.calls, "/objecttype/31/attributes"));
    assert.equal(p.get("query"), "own");
    assert.equal(p.get("onlyValueEditable"), "true");
    assert.equal(p.get("excludeParentAttributes"), "true");
    assert.equal(r.value.items[0].name, "Owner");
  });

  it("assets_get_schema_attributes filters on the server and pages locally", async () => {
    const r = await run("assets_get_schema_attributes", { schema_id: 3, query: "date", only_editable: true, limit: 1 }, () => [
      { id: 1, name: "Purchase date", type: 0 }, { id: 2, name: "Warranty date", type: 0 },
    ]);
    const p = params(callTo(r.calls, "/objectschema/3/attributes"));
    assert.equal(p.get("query"), "date");
    assert.equal(p.get("onlyValueEditable"), "true");
    assert.equal(r.value.returned, 1);
  });

  it("object lookups for history/comments/issues/attachments load the object without attributes", async () => {
    for (const [tool, frag] of [
      ["assets_object_history", "/history"],
      ["assets_object_comments", "/comment/object/77"],
      ["assets_object_issues", "/objectconnectedtickets/77/tickets"],
      ["assets_object_attachments", "/attachments/object/77"],
    ] as const) {
      const r = await run(tool, { object: "ITAM-7" }, () => []);
      assert.ok(r.res.ok, tool);
      const lookup = callTo(r.calls, "/object/ITAM-7");
      assert.equal(params(lookup).get("includeAttributes"), "false", tool);
      assert.ok(callTo(r.calls, frag), tool);
    }
  });

  it("history is abbreviated newest first, issues default to limit 50", async () => {
    const h = await run("assets_object_history", { object: 77 }, () => []);
    const hp = params(callTo(h.calls, "/object/77/history"));
    assert.equal(hp.get("abbreviate"), "true");
    assert.equal(hp.get("asc"), "false");
    const i = await run("assets_object_issues", { object: 77 }, () => ({ tickets: [] }));
    assert.equal(params(callTo(i.calls, "/tickets")).get("limit"), "50");
  });

  it("comments page locally with a small default", async () => {
    const list = Array.from({ length: 30 }, (_, n) => ({ id: n, comment: `c${n}` }));
    const r = await run("assets_object_comments", { object: 77 }, () => list);
    assert.equal(params(callTo(r.calls, "/comment/object/77")).get("asc"), "false");
    assert.equal(r.value.returned, 20);
    assert.equal(r.value.nextOffset, 20);
  });

  it("statuses filter by schema on the server and page locally", async () => {
    const r = await run("assets_list_statuses", { schema_id: 3, name_contains: "act" }, () => [
      { id: 1, name: "Active", category: 1 }, { id: 2, name: "Retired", category: 0 },
    ]);
    assert.equal(params(callTo(r.calls, "/config/statustype")).get("objectSchemaId"), "3");
    assert.deepEqual(r.value.items.map((s: any) => s.name), ["Active"]);
  });
});
