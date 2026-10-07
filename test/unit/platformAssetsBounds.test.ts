import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "../../src/format.js";
import { runToolByName } from "../../src/runner.js";
import { findTool } from "../../src/tools/index.js";
import { benchResponder } from "../bench/payloads.js";
import { testContext, type Call } from "./helpers.js";

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runToolByName(tool, args, ctx);
  return { value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error, calls };
}

const path = (c: Call) => new URL(c.url).pathname;
const XML = `<workflow>${"<step id='1'/>".repeat(2300)}</workflow>`; // 30,000+ characters
const CUT = /^.{120}…\(\+\d+\)$/s;

describe("audit and history values are bounded (optimize-read-token-usage 4.1)", () => {
  const events = (n: number) => ({
    entities: Array.from({ length: n }, (_, i) => ({
      timestamp: "2026-09-01T10:00:00.000Z",
      author: { name: "admin", type: "user" },
      type: { category: "Workflows", action: "Workflow updated" },
      changedValues: [{ key: "Workflow", from: XML, to: XML }, { key: "Name", from: "A", to: `B${i}` }],
    })),
    pagingInfo: { lastPage: true },
  });

  it("caps limit at 200 and cuts changed values to 120 characters", async () => {
    const limit: any = findTool("atlassian_audit_events")!.inputShape.limit;
    assert.equal(limit.safeParse(201).success, false);
    assert.equal(limit.safeParse(200).success, true);
    const r = await run("atlassian_audit_events", { product: "jira" }, () => ({ body: events(3) }));
    const change = r.value.items[0].changes[0];
    assert.match(change.from, CUT);
    assert.match(change.to, CUT);
    assert.equal(r.value.items[0].changes[1].to, "B0");
    assert.ok(XML.length > 30_000);
  });

  it("allows raw=true only with limit at most 50", async () => {
    const r = await run("atlassian_audit_events", { product: "jira", raw: true, limit: 100 }, () => ({ body: events(1) }));
    assert.equal(r.error?.type, "ValidationError");
    assert.match(r.error.message, /raw=true.*limit.*50/);
    assert.equal(r.calls.length, 0);
    const ok = await run("atlassian_audit_events", { product: "jira", raw: true }, () => ({ body: events(1) }));
    assert.ok(ok.value, JSON.stringify(ok.error));
  });

  it("keeps the default call of the benchmark under the guard in JSON too", async () => {
    const r = await run("atlassian_audit_events", { product: "jira" }, benchResponder().responder);
    assert.ok(render(r.value, "json").length < 25_000, String(render(r.value, "json").length));
  });

  it("assets_object_history cuts old and new values and pages with offset", async () => {
    const list = Array.from({ length: 5 }, (_, i) => ({ created: `2026-09-0${i + 1}`, actor: { name: "ivan" }, type: 2, affectedAttribute: "Notes", oldValue: i === 0 ? XML : `old ${i}`, newValue: `new ${i}` }));
    const responder = (c: Call) => {
      const p = path(c);
      if (p.endsWith("/object/77")) return { body: { id: 77, objectKey: "ITAM-7", objectType: { id: 31 } } };
      if (p.endsWith("/object/77/history")) return { body: list };
      return undefined;
    };
    const r = await run("assets_object_history", { object: 77 }, responder);
    assert.match(r.value[0].from, CUT);
    const page = await run("assets_object_history", { object: 77, offset: 2, limit: 2 }, responder);
    assert.deepEqual(page.value.map((h: any) => h.to), ["new 2", "new 3"]);
  });
});

describe("Assets and service desk rows are bounded (optimize-read-token-usage 4.2)", () => {
  it("assets_search shows at most 20 attributes per row with values of at most 120 characters", async () => {
    const r = await run("assets_search", { aql: 'objectType = "Laptop"' }, benchResponder().responder);
    const row = r.value.items[0];
    assert.equal(Object.keys(row.attributes).length, 20);
    assert.equal(row.moreAttributes, "+40 more");
    for (const v of Object.values(row.attributes)) assert.ok(String(v).length <= 130, String(v));
    assert.ok(render(r.value, "json").length < 25_000, String(render(r.value, "json").length));
  });

  it("assets_search with named attributes returns those without the count cap", async () => {
    const names = Array.from({ length: 25 }, (_, a) => `Attribute ${a}`);
    const r = await run("assets_search", { aql: "x", attributes: names }, benchResponder().responder);
    assert.equal(Object.keys(r.value.items[0].attributes).length, 25);
    assert.equal(r.value.items[0].moreAttributes, undefined);
    assert.match(String(r.value.items[0].attributes["Attribute 0"]), CUT);
  });

  it("assets_get_object cuts long attribute values", async () => {
    const responder = (c: Call) =>
      path(c).endsWith("/object/77")
        ? { body: { id: 77, objectKey: "ITAM-7", label: "LT", objectType: { id: 31, name: "Laptop" }, attributes: [{ objectTypeAttributeId: 9, objectTypeAttribute: { name: "Notes" }, objectAttributeValues: [{ value: XML, displayValue: XML }] }] } }
        : undefined;
    const r = await run("assets_get_object", { object: 77 }, responder);
    assert.match(r.value.attributes.Notes, CUT);
  });

  it("assets_get_object_type returns attribute counts and points to assets_list_attributes", async () => {
    const attrs = Array.from({ length: 80 }, (_, i) => ({ id: i, name: `A${i}`, type: 0, objectType: { id: i < 30 ? 1 : 2 }, objectTypeId: 2 }));
    const r = await run("assets_get_object_type", { object_type_id: 2 }, (c) => (path(c).endsWith("/attributes") ? { body: attrs } : { body: { id: 2, name: "Server", objectSchemaId: 1 } }));
    assert.equal(r.value.attributes, undefined);
    assert.deepEqual(r.value.attributeCount, { total: 80, inherited: 30 });
    assert.match(r.value.hint, /assets_list_attributes object_type_id=2/);
  });

  it("jira_get_request_type_fields shows at most 50 valid values per field", async () => {
    const field = { fieldId: "customfield_1", name: "Country", required: true, jiraSchema: { type: "option" }, validValues: Array.from({ length: 120 }, (_, i) => ({ value: String(i), label: `Country ${i}` })) };
    const r = await run("jira_get_request_type_fields", { service_desk: "3", request_type_id: "12" }, () => ({ body: { requestTypeFields: [field] } }));
    const values: string[] = r.value.fields[0].validValues;
    assert.equal(values.length, 51);
    assert.equal(values.at(-1), "+70 more");
  });
});

describe("allowlists instead of raw passthrough (optimize-read-token-usage 4.5)", () => {
  it("atlassian_audit_settings returns retention, coverage levels and denylisted action names only", async () => {
    const responder = (c: Call) => {
      const p = path(c);
      if (p.endsWith("/retention")) return { body: { period: "P3Y", self: "x", internal: { a: 1 } } };
      if (p.endsWith("/coverage")) return { body: { levelByArea: { USER_MANAGEMENT: "BASE", PERMISSIONS: "FULL" }, _links: { self: "x" } } };
      if (p.endsWith("/denylist")) return { body: { actions: [{ key: "jira.auditing.login", name: "User login", meta: { x: 1 } }, "jira.auditing.logout"] } };
      return undefined;
    };
    const r = await run("atlassian_audit_settings", { product: "jira" }, responder);
    assert.deepEqual(r.value, {
      retention: "P3Y",
      coverage: ["USER_MANAGEMENT=BASE", "PERMISSIONS=FULL"],
      denylist: ["User login", "jira.auditing.logout"],
    });
  });

  it("assets_object_references returns reference type, object type and count only", async () => {
    const info = [
      { referenceTypeBean: { id: 2, name: "Depends on", description: "d", color: "red", url16: "x", objectSchemaId: 3 }, numberOfReferencedObjects: 4, objectType: { id: 40, name: "Model", icon: { url16: "x" } }, extra: { a: 1 } },
    ];
    const responder = (c: Call) => {
      const p = path(c);
      if (p.endsWith("/object/77")) return { body: { id: 77, objectKey: "ITAM-7", objectType: { id: 31 } } };
      if (p.endsWith("/referenceinfo")) return { body: info };
      return undefined;
    };
    const r = await run("assets_object_references", { object: 77 }, responder);
    assert.deepEqual(r.value, [{ referenceType: "Depends on", objectType: "Model", objects: 4 }]);
  });
});
