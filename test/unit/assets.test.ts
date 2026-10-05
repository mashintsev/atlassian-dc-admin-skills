import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const B = "https://jira.example.com/rest/insight/1.0";

/** Laptop type 31: Key(1, system), Name(2, label), Owner(3, user), Model(4, reference), Tags(5, multi text) */
const ATTRS = [
  { id: 1, name: "Key", type: 0, defaultType: { id: 0, name: "Text" }, editable: false, system: true },
  { id: 2, name: "Name", type: 0, defaultType: { id: 0, name: "Text" }, label: true, minimumCardinality: 1, maximumCardinality: 1 },
  { id: 3, name: "Owner", type: 2, minimumCardinality: 0, maximumCardinality: 1 },
  { id: 4, name: "Model", type: 1, referenceObjectTypeId: 40, referenceType: { id: 2, name: "Depends on" }, maximumCardinality: 1 },
  { id: 5, name: "Tags", type: 0, defaultType: { id: 0, name: "Text" }, maximumCardinality: -1 },
];

function responder(extra?: (c: Call) => any) {
  return (c: Call) => {
    const r = extra?.(c);
    if (r) return r;
    const path = new URL(c.url).pathname.replace("/rest/insight/1.0", "");
    if (path === "/objecttype/31/attributes") return { body: ATTRS };
    if (path === "/object/ITAM-7" || path === "/object/77") {
      return {
        body: {
          id: 77, objectKey: "ITAM-7", label: "LT-7", objectType: { id: 31, name: "Laptop", objectSchemaId: 3 },
          attributes: [
            { objectTypeAttributeId: 2, objectTypeAttribute: { name: "Name" }, objectAttributeValues: [{ value: "LT-7", displayValue: "LT-7" }] },
            { objectTypeAttributeId: 3, objectTypeAttribute: { name: "Owner" }, objectAttributeValues: [{ user: { name: "ivan", avatarUrl: "x" }, displayValue: "Ivan" }] },
            { objectTypeAttributeId: 4, objectTypeAttribute: { name: "Model" }, objectAttributeValues: [{ referencedObject: { id: 9, objectKey: "ITAM-1", label: "T14" } }] },
            { objectTypeAttributeId: 5, objectTypeAttribute: { name: "Tags" }, objectAttributeValues: [{ value: "a" }, { value: "b" }] },
          ],
        },
      };
    }
    if (path === "/objectschema/3/objecttypes/flat") return { body: [{ id: 31, name: "Laptop" }, { id: 40, name: "Model" }] };
    return undefined;
  };
}

async function run(name: string, args: Record<string, unknown>, extra?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder(extra));
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : res.error, calls };
}

describe("assets objects", () => {
  it("reads an object with attributes by name, users and references flattened", async () => {
    const r = await run("assets_get_object", { object: "ITAM-7" });
    assert.deepEqual(r.value.attributes, { Name: "LT-7", Owner: "ivan", Model: "ITAM-1", Tags: ["a", "b"] });
    assert.equal(r.value.type, "Laptop");
  });

  it("creates an object from attribute names, resolving the type by name", async () => {
    const r = await run("assets_create_object", {
      object_type: "Laptop", schema_id: 3, attributes: { Name: "LT-8", owner: "ivan", Model: "ITAM-1", Tags: ["x", "y"] },
    });
    assert.equal(r.value.dry_run, true);
    assert.equal(r.value.request.url, `${B}/object/create`);
    assert.deepEqual(r.value.request.body, {
      objectTypeId: 31,
      attributes: [
        { objectTypeAttributeId: 2, objectAttributeValues: [{ value: "LT-8" }] },
        { objectTypeAttributeId: 3, objectAttributeValues: [{ value: "ivan" }] },
        { objectTypeAttributeId: 4, objectAttributeValues: [{ value: "ITAM-1" }] },
        { objectTypeAttributeId: 5, objectAttributeValues: [{ value: "x" }, { value: "y" }] },
      ],
    });
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("rejects unknown and read-only attributes with the list of known ones", async () => {
    const unknown = await run("assets_update_object", { object: "ITAM-7", attributes: { Colour: "red" } });
    assert.equal(unknown.error?.type, "ValidationError");
    assert.match(unknown.error!.message, /Unknown attribute\(s\).*Colour.*Known: Name, Owner, Model, Tags/);
    const readonly = await run("assets_update_object", { object: "ITAM-7", attributes: { Key: "X" } });
    assert.match(readonly.error!.message, /not editable/);
  });

  it("updates only the given attributes, null clears", async () => {
    const r = await run("assets_update_object", { object: "ITAM-7", attributes: '{"Owner": null}', dry_run: false });
    const put = r.calls.find((c) => c.method === "PUT")!;
    assert.equal(put.url, `${B}/object/77`);
    assert.deepEqual(put.body, { objectTypeId: 31, attributes: [{ objectTypeAttributeId: 3, objectAttributeValues: [] }] });
  });

  it("searches with AQL, falls back to the Insight iql path on 404, and maps attribute names", async () => {
    const r = await run("assets_search", { aql: 'objectType = "Laptop"', limit: 1, attributes: ["Owner"] }, (c) => {
      if (c.url.includes("/aql/objects")) return { status: 404, body: "" };
      if (c.url.includes("/iql/objects")) {
        assert.match(c.url, /iql=objectType/);
        return {
          body: {
            totalFilterCount: 2,
            objectTypeAttributes: [{ id: 3, name: "Owner" }],
            objectEntries: [{ id: 77, objectKey: "ITAM-7", label: "LT-7", objectType: { id: 31, name: "Laptop" },
              attributes: [{ objectTypeAttributeId: 3, objectAttributeValues: [{ user: { name: "ivan" } }] }, { objectTypeAttributeId: 2, objectAttributeValues: [{ value: "LT-7" }] }] }],
          },
        };
      }
    });
    assert.equal(r.value.total, 2);
    assert.equal(r.value.nextPage, 2);
    assert.deepEqual(r.value.items[0].attributes, { Owner: "ivan" });
  });

  it("bulk update refuses more matches than max_objects and lists matches in the dry run", async () => {
    const page = (n: number) => ({ body: { totalFilterCount: n, objectEntries: Array.from({ length: Math.min(n, 3) }, (_, i) => ({ id: i, objectKey: `ITAM-${i}`, label: `L${i}`, objectType: { id: 31 } })) } });
    const tooMany = await run("assets_bulk_update", { aql: "x", attributes: { Owner: "ivan" }, max_objects: 2 }, (c) => (c.url.includes("/aql/objects") ? page(3) : undefined));
    assert.match(tooMany.error!.message, /matches 3 objects/);
    const ok = await run("assets_bulk_update", { aql: "x", attributes: { Owner: "ivan" } }, (c) => (c.url.includes("/aql/objects") ? page(3) : undefined));
    assert.equal(ok.value.dry_run, true);
    assert.deepEqual(ok.value.objects, ["ITAM-0 L0", "ITAM-1 L1", "ITAM-2 L2"]);
    assert.ok(ok.calls.every((c) => c.method === "GET"));
  });
});

describe("assets structure", () => {
  it("creates attributes from readable types", async () => {
    const ref = await run("assets_create_attribute", { object_type_id: 31, name: "Vendor", type: "reference", reference_object_type_id: 50, reference_type_id: 2, multiple: true });
    assert.equal(ref.value.request.url, `${B}/objecttypeattribute/31`);
    assert.deepEqual(ref.value.request.body, { name: "Vendor", type: 1, typeValue: "50", additionalValue: "2", maximumCardinality: -1 });
    const sel = await run("assets_create_attribute", { object_type_id: 31, name: "Size", type: "select", options: "S,M,L", required: true });
    assert.deepEqual(sel.value.request.body, { name: "Size", type: 0, defaultTypeId: 10, options: "S,M,L", minimumCardinality: 1 });
    const bad = await run("assets_create_attribute", { object_type_id: 31, name: "X", type: "reference" });
    assert.match(bad.error!.message, /reference_object_type_id/);
  });

  it("updates an attribute on top of its current definition", async () => {
    const r = await run("assets_update_attribute", { object_type_id: 31, attribute_id: 4, name: "Hardware model" }, (c) =>
      c.url.endsWith("/objecttypeattribute/4") ? { body: { ...ATTRS[3], minimumCardinality: 0 } } : undefined,
    );
    assert.deepEqual(r.value.request.body, {
      id: 4, name: "Hardware model", type: 1, minimumCardinality: 0, maximumCardinality: 1, typeValue: "40", additionalValue: "2",
    });
  });

  it("renders the schema object type tree", async () => {
    const r = await run("assets_get_schema", { schema_id: 3 }, (c) => {
      if (c.url.endsWith("/objectschema/3")) return { body: { id: 3, objectSchemaKey: "ITAM", name: "IT Assets", objectCount: 5 } };
      if (c.url.includes("/objectschema/3/objecttypes/flat")) {
        return { body: [{ id: 30, name: "Hardware", position: 0, objectCount: 0, abstractObjectType: true }, { id: 31, name: "Laptop", parentObjectTypeId: 30, position: 0, objectCount: 5 }] };
      }
    });
    assert.equal(r.value.objectTypeTree, "Hardware [30] 0 abstract\n  Laptop [31] 5");
  });

  it("creates statuses with a category code", async () => {
    const r = await run("assets_create_status", { name: "In repair", category: "pending", schema_id: 3 });
    assert.deepEqual(JSON.parse(JSON.stringify(r.value.request.body)), { name: "In repair", category: 2, objectSchemaId: 3 });
  });
});
