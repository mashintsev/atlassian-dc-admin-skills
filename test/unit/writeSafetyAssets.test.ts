import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { describeTool } from "../../src/cli.js";
import { testContext, type Call } from "./helpers.js";

const P = "/rest/insight/1.0";

/**
 * A small in-memory Assets server: schemas, object types, attributes, statuses and objects.
 * `ignore` makes one kind of write a no-op on the server, to provoke a read-back mismatch.
 */
function fakeAssets(opts: { ignore?: string } = {}) {
  const schemas: any[] = [{ id: 3, objectSchemaKey: "ITAM", name: "IT Assets", description: "Hardware" }];
  const types: any[] = [{ id: 31, name: "Laptop", objectSchemaId: 3, description: "Laptops", inherited: false, abstractObjectType: false, icon: { id: 1 } }];
  const attrs: Record<number, any[]> = {
    31: [
      { id: 2, name: "Name", type: 0, defaultType: { id: 0 }, label: true, minimumCardinality: 1, maximumCardinality: 1 },
      { id: 4, name: "Model", type: 1, referenceObjectTypeId: 40, referenceType: { id: 2 }, minimumCardinality: 0, maximumCardinality: 1 },
      { id: 6, name: "Size", type: 0, defaultType: { id: 10 }, options: "S,M,L", minimumCardinality: 0, maximumCardinality: 1 },
    ],
  };
  const statuses: any[] = [{ id: 8, name: "In repair", category: 2, objectSchemaId: 3, description: "" }];
  const objects: any[] = [{
    id: 77, objectKey: "ITAM-7", label: "LT-7", archived: false, objectType: { id: 31, name: "Laptop", objectSchemaId: 3 },
    attributes: [
      { objectTypeAttributeId: 2, objectAttributeValues: [{ value: "LT-7", displayValue: "LT-7" }] },
      { objectTypeAttributeId: 4, objectAttributeValues: [{ referencedObject: { id: 9, objectKey: "ITAM-1", label: "T14" } }] },
    ],
  }];
  let next = 100;
  const notFound = { status: 404, body: { errorMessages: ["not found"] } };
  const skip = (kind: string) => opts.ignore === kind;

  const responder = (c: Call) => {
    const url = new URL(c.url);
    const p = url.pathname.replace(P, "");
    const b = c.body ?? {};
    const m = (re: RegExp) => re.exec(p);
    let r: RegExpExecArray | null;
    // schemas
    if (p === "/objectschema/list") return { body: { objectschemas: schemas } };
    if (p === "/objectschema/create" && c.method === "POST") {
      const s = { id: next++, name: b.name, objectSchemaKey: b.objectSchemaKey, description: b.description };
      if (!skip("schema")) schemas.push(s);
      return { body: s };
    }
    if ((r = m(/^\/objectschema\/(\d+)$/))) {
      const i = schemas.findIndex((s) => s.id === Number(r![1]));
      if (i < 0) return notFound;
      if (c.method === "GET") return { body: schemas[i] };
      if (c.method === "PUT") { if (!skip("schema")) schemas[i] = { ...schemas[i], name: b.name, description: b.description }; return { body: schemas[i] }; }
      if (c.method === "DELETE") { if (!skip("schema")) schemas.splice(i, 1); return { body: "" }; }
    }
    if ((r = m(/^\/objectschema\/(\d+)\/objecttypes\/flat$/))) return { body: types.filter((t) => t.objectSchemaId === Number(r![1])) };
    // object types
    if (p === "/icon/global") return { body: [{ id: 1 }] };
    if (p === "/objecttype/create" && c.method === "POST") {
      const t = { id: next++, name: b.name, description: b.description, objectSchemaId: b.objectSchemaId, parentObjectTypeId: b.parentObjectTypeId, icon: { id: b.iconId }, inherited: b.inherited, abstractObjectType: b.abstractObjectType };
      if (!skip("type")) types.push(t);
      return { body: t };
    }
    if ((r = m(/^\/objecttype\/(\d+)\/attributes$/))) return { body: attrs[Number(r[1])] ?? [] };
    if ((r = m(/^\/objecttype\/(\d+)$/))) {
      const i = types.findIndex((t) => t.id === Number(r![1]));
      if (i < 0) return notFound;
      if (c.method === "GET") return { body: types[i] };
      if (c.method === "PUT") {
        if (!skip("type")) types[i] = { ...types[i], name: b.name, description: b.description, parentObjectTypeId: b.parentObjectTypeId, icon: { id: b.iconId }, inherited: b.inherited, abstractObjectType: b.abstractObjectType };
        return { body: types[i] };
      }
      if (c.method === "DELETE") { if (!skip("type")) types.splice(i, 1); return { body: "" }; }
    }
    // attributes
    if ((r = m(/^\/objecttypeattribute\/(\d+)$/)) && c.method === "POST") {
      const a = { id: next++, name: b.name, type: b.type, defaultType: b.defaultTypeId !== undefined ? { id: b.defaultTypeId } : undefined, options: b.options, minimumCardinality: b.minimumCardinality ?? 0, maximumCardinality: b.maximumCardinality ?? 1 };
      if (!skip("attribute")) (attrs[Number(r[1])] ??= []).push(a);
      return { body: a };
    }
    if ((r = m(/^\/objecttypeattribute\/(\d+)$/))) {
      const all = Object.values(attrs).flat();
      const a = all.find((x) => x.id === Number(r![1]));
      if (!a) return notFound;
      if (c.method === "GET") return { body: a };
      if (c.method === "DELETE") {
        if (!skip("attribute")) for (const list of Object.values(attrs)) { const i = list.indexOf(a); if (i >= 0) list.splice(i, 1); }
        return { body: "" };
      }
    }
    if ((r = m(/^\/objecttypeattribute\/(\d+)\/(\d+)$/)) && c.method === "PUT") {
      const a = (attrs[Number(r[1])] ?? []).find((x) => x.id === Number(r![2]));
      if (!a) return notFound;
      if (!skip("attribute")) Object.assign(a, { name: b.name, minimumCardinality: b.minimumCardinality, maximumCardinality: b.maximumCardinality, options: b.options, description: b.description });
      return { body: a };
    }
    // statuses
    if (p === "/config/statustype" && c.method === "GET") {
      const schema = url.searchParams.get("objectSchemaId");
      return { body: statuses.filter((s) => !schema || s.objectSchemaId === undefined || String(s.objectSchemaId) === schema) };
    }
    if (p === "/config/statustype" && c.method === "POST") {
      const s = { id: next++, name: b.name, category: b.category, objectSchemaId: b.objectSchemaId, description: b.description };
      if (!skip("status")) statuses.push(s);
      return { body: s };
    }
    if ((r = m(/^\/config\/statustype\/(\d+)$/))) {
      const i = statuses.findIndex((s) => s.id === Number(r![1]));
      if (i < 0) return notFound;
      if (c.method === "GET") return { body: statuses[i] };
      if (c.method === "PUT") { if (!skip("status")) statuses[i] = { ...statuses[i], name: b.name, category: b.category, description: b.description }; return { body: statuses[i] }; }
      if (c.method === "DELETE") { if (!skip("status")) statuses.splice(i, 1); return { body: "" }; }
    }
    // objects
    if ((r = m(/^\/object\/(archive|restore)\/(.+)$/)) && c.method === "PUT") {
      const o = objects.find((x) => String(x.id) === r![2] || x.objectKey === r![2]);
      if (!o) return notFound;
      if (!skip("object")) o.archived = r[1] === "archive";
      return { body: "" };
    }
    if ((r = m(/^\/object\/([^/]+)$/))) {
      const o = objects.find((x) => String(x.id) === r![1] || x.objectKey === r![1]);
      if (!o) return notFound;
      if (c.method === "GET") return { body: o };
      if (c.method === "PUT") {
        if (!skip("object")) {
          for (const a of b.attributes) {
            const cur = o.attributes.find((x: any) => x.objectTypeAttributeId === a.objectTypeAttributeId);
            const values = a.objectAttributeValues.map((v: any) => ({ value: v.value, displayValue: v.value }));
            if (cur) cur.objectAttributeValues = values;
            else o.attributes.push({ objectTypeAttributeId: a.objectTypeAttributeId, objectAttributeValues: values });
          }
        }
        return { body: o };
      }
      if (c.method === "DELETE") { if (!skip("object")) objects.splice(objects.indexOf(o), 1); return { body: "" }; }
    }
    if (p === "/aql/objects") return { body: { totalFilterCount: objects.length, objectEntries: objects } };
    return undefined;
  };
  return { responder, schemas, types, attrs, statuses, objects };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("Assets schemas (unify 3.3)", () => {
  it("create: same settings → already-satisfied, other settings → error, new → read back", async () => {
    const a = fakeAssets();
    const same = await run("assets_create_schema", { name: "IT Assets", key: "ITAM", dry_run: false }, a.responder);
    assert.equal(same.value.already_satisfied, true);
    assert.equal(writes(same.calls).length, 0);
    const other = await run("assets_create_schema", { name: "Other", key: "ITAM" }, a.responder);
    assert.equal(other.error.type, "ValidationError");
    assert.match(other.error.message, /already exists/);
    const created = await run("assets_create_schema", { name: "Facilities", key: "FAC", dry_run: false }, a.responder);
    assert.ok(created.res.ok, JSON.stringify(created.error));
    assert.ok(a.schemas.some((s) => s.objectSchemaKey === "FAC"));
    const lost = await run("assets_create_schema", { name: "Lost", key: "LOST", dry_run: false }, fakeAssets({ ignore: "schema" }).responder);
    assert.equal(lost.error.type, "VerificationError");
  });

  it("update: no difference → already-satisfied; change → read back; mismatch → VerificationError", async () => {
    const a = fakeAssets();
    assert.equal((await run("assets_update_schema", { schema_id: 3, name: "IT Assets" }, a.responder)).value.already_satisfied, true);
    const r = await run("assets_update_schema", { schema_id: 3, name: "IT Hardware", dry_run: false }, a.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(a.schemas[0].name, "IT Hardware");
    const bad = await run("assets_update_schema", { schema_id: 3, name: "IT Hardware", dry_run: false }, fakeAssets({ ignore: "schema" }).responder);
    assert.equal(bad.error.type, "VerificationError");
    assert.ok(bad.error.state, "carries the observed state");
  });

  it("delete: absent → already-satisfied; present → read back gone", async () => {
    const a = fakeAssets();
    const gone = await run("assets_delete_schema", { schema_id: 99, dry_run: false }, a.responder);
    assert.equal(gone.value.already_satisfied, true);
    assert.equal(writes(gone.calls).length, 0);
    assert.ok((await run("assets_delete_schema", { schema_id: 3, dry_run: false }, a.responder)).res.ok);
    assert.equal(a.schemas.length, 0);
    const stuck = await run("assets_delete_schema", { schema_id: 3, dry_run: false }, fakeAssets({ ignore: "schema" }).responder);
    assert.equal(stuck.error.type, "VerificationError");
  });
});

describe("Assets object types (unify 3.3)", () => {
  it("create, update and delete follow the same rules", async () => {
    const a = fakeAssets();
    assert.equal((await run("assets_create_object_type", { schema_id: 3, name: "laptop", dry_run: false }, a.responder)).value.already_satisfied, true);
    const conflict = await run("assets_create_object_type", { schema_id: 3, name: "Laptop", abstract: true }, a.responder);
    assert.match(conflict.error.message, /already exists/);
    const created = await run("assets_create_object_type", { schema_id: 3, name: "Monitor", dry_run: false }, a.responder);
    assert.ok(created.res.ok, JSON.stringify(created.error));
    assert.equal((await run("assets_update_object_type", { object_type_id: 31, description: "Laptops" }, a.responder)).value.already_satisfied, true);
    assert.ok((await run("assets_update_object_type", { object_type_id: 31, description: "Notebooks", dry_run: false }, a.responder)).res.ok);
    assert.equal(a.types[0].description, "Notebooks");
    assert.equal((await run("assets_update_object_type", { object_type_id: 31, name: "X", dry_run: false }, fakeAssets({ ignore: "type" }).responder)).error.type, "VerificationError");
    assert.equal((await run("assets_delete_object_type", { object_type_id: 999 }, a.responder)).value.already_satisfied, true);
    assert.ok((await run("assets_delete_object_type", { object_type_id: 31, dry_run: false }, a.responder)).res.ok);
    assert.ok(!a.types.some((t) => t.id === 31));
  });
});

describe("Assets attributes (unify 3.3)", () => {
  it("create: same settings → already-satisfied; other settings → error; new → read back", async () => {
    const a = fakeAssets();
    const same = await run("assets_create_attribute", { object_type_id: 31, name: "size", type: "select", options: "S,M,L", dry_run: false }, a.responder);
    assert.equal(same.value.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    const other = await run("assets_create_attribute", { object_type_id: 31, name: "Size", type: "select", options: "S,XL" }, a.responder);
    assert.match(other.error.message, /already exists/);
    const dry = await run("assets_create_attribute", { object_type_id: 31, name: "Serial", type: "text" }, a.responder);
    assert.deepEqual(dry.value.state, { attribute: "Serial", present: false });
    assert.ok((await run("assets_create_attribute", { object_type_id: 31, name: "Serial", type: "text", dry_run: false }, a.responder)).res.ok);
    assert.ok(a.attrs[31]!.some((x) => x.name === "Serial"));
    assert.equal((await run("assets_create_attribute", { object_type_id: 31, name: "Lost", type: "text", dry_run: false }, fakeAssets({ ignore: "attribute" }).responder)).error.type, "VerificationError");
  });

  it("update: state holds only the touched attribute's changed settings; no difference → already-satisfied", async () => {
    const a = fakeAssets();
    assert.equal((await run("assets_update_attribute", { object_type_id: 31, attribute_id: 6, options: "S,M,L" }, a.responder)).value.already_satisfied, true);
    const dry = await run("assets_update_attribute", { object_type_id: 31, attribute_id: 6, required: true }, a.responder);
    assert.deepEqual(dry.value.state, { attribute: 6, before: { minimumCardinality: 0 } });
    assert.ok((await run("assets_update_attribute", { object_type_id: 31, attribute_id: 6, required: true, dry_run: false }, a.responder)).res.ok);
    assert.equal(a.attrs[31]!.find((x) => x.id === 6).minimumCardinality, 1);
    assert.equal((await run("assets_update_attribute", { object_type_id: 31, attribute_id: 6, required: true, dry_run: false }, fakeAssets({ ignore: "attribute" }).responder)).error.type, "VerificationError");
  });

  it("delete: absent → already-satisfied; present → read back gone", async () => {
    const a = fakeAssets();
    assert.equal((await run("assets_delete_attribute", { attribute_id: 555 }, a.responder)).value.already_satisfied, true);
    assert.ok((await run("assets_delete_attribute", { attribute_id: 6, dry_run: false }, a.responder)).res.ok);
    assert.ok(!a.attrs[31]!.some((x) => x.id === 6));
    assert.equal((await run("assets_delete_attribute", { attribute_id: 6, dry_run: false }, fakeAssets({ ignore: "attribute" }).responder)).error.type, "VerificationError");
  });
});

describe("Assets statuses (unify 3.3)", () => {
  it("create, update and delete follow the same rules", async () => {
    const a = fakeAssets();
    assert.equal((await run("assets_create_status", { name: "in repair", category: "pending", schema_id: 3, dry_run: false }, a.responder)).value.already_satisfied, true);
    assert.match((await run("assets_create_status", { name: "In repair", category: "active", schema_id: 3 }, a.responder)).error.message, /already exists/);
    assert.ok((await run("assets_create_status", { name: "Retired", category: "inactive", schema_id: 3, dry_run: false }, a.responder)).res.ok);
    assert.ok(a.statuses.some((s) => s.name === "Retired"));
    assert.equal((await run("assets_create_status", { name: "Lost", category: "inactive", dry_run: false }, fakeAssets({ ignore: "status" }).responder)).error.type, "VerificationError");
    assert.equal((await run("assets_update_status", { status_id: 8, category: "pending" }, a.responder)).value.already_satisfied, true);
    assert.ok((await run("assets_update_status", { status_id: 8, category: "active", dry_run: false }, a.responder)).res.ok);
    assert.equal(a.statuses.find((s) => s.id === 8).category, 1);
    assert.equal((await run("assets_update_status", { status_id: 8, name: "Fixing", dry_run: false }, fakeAssets({ ignore: "status" }).responder)).error.type, "VerificationError");
    assert.equal((await run("assets_delete_status", { status_id: 404 }, a.responder)).value.already_satisfied, true);
    assert.ok((await run("assets_delete_status", { status_id: 8, dry_run: false }, a.responder)).res.ok);
    assert.equal((await run("assets_delete_status", { status_id: 8, dry_run: false }, fakeAssets({ ignore: "status" }).responder)).error.type, "VerificationError");
  });
});

describe("Assets objects (unify 3.4)", () => {
  it("update: same values → already-satisfied (references by key); change → read back; mismatch → VerificationError", async () => {
    const a = fakeAssets();
    const same = await run("assets_update_object", { object: "ITAM-7", attributes: { Name: "LT-7", Model: "ITAM-1" }, dry_run: false }, a.responder);
    assert.equal(same.value.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    assert.equal(writes(same.calls).length, 0);
    const r = await run("assets_update_object", { object: "ITAM-7", attributes: { Name: "LT-7b" }, dry_run: false }, a.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const bad = await run("assets_update_object", { object: "ITAM-7", attributes: { Name: "LT-9" }, dry_run: false }, fakeAssets({ ignore: "object" }).responder);
    assert.equal(bad.error.type, "VerificationError");
  });

  it("delete and archive: already in the target state → already-satisfied; otherwise read back", async () => {
    const a = fakeAssets();
    assert.equal((await run("assets_delete_object", { object: "ITAM-99" }, a.responder)).value.already_satisfied, true);
    assert.equal((await run("assets_archive_object", { object: "ITAM-7", archived: false }, a.responder)).value.already_satisfied, true);
    assert.ok((await run("assets_archive_object", { object: "ITAM-7", dry_run: false }, a.responder)).res.ok);
    assert.equal(a.objects[0].archived, true);
    assert.equal((await run("assets_archive_object", { object: "ITAM-7", dry_run: false }, fakeAssets({ ignore: "object" }).responder)).error.type, "VerificationError");
    assert.ok((await run("assets_delete_object", { object: "ITAM-7", dry_run: false }, a.responder)).res.ok);
    assert.equal(a.objects.length, 0);
    assert.equal((await run("assets_delete_object", { object: "ITAM-7", dry_run: false }, fakeAssets({ ignore: "object" }).responder)).error.type, "VerificationError");
  });

  it("bulk update: every object already matching → already-satisfied; otherwise each changed object is read back", async () => {
    const a = fakeAssets();
    const same = await run("assets_bulk_update", { aql: "x", attributes: { Name: "LT-7" }, dry_run: false }, a.responder);
    assert.equal(same.value.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    const r = await run("assets_bulk_update", { aql: "x", attributes: { Name: "LT-8" }, dry_run: false }, a.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.updated, 1);
    const bad = await run("assets_bulk_update", { aql: "x", attributes: { Name: "LT-8" }, dry_run: false }, fakeAssets({ ignore: "object" }).responder);
    assert.equal(bad.error.type, "VerificationError");
  });

  it("create object and add comment are marked unverifiable", () => {
    assert.match(describeTool("assets_create_object", false)!, /not verifiable/);
    assert.match(describeTool("assets_add_object_comment", false)!, /not verifiable/);
  });
});
