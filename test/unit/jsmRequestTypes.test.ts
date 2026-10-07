import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jsm11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const IJ = "/rest/servicedesk/1/servicedesk";
const ISSUE_TYPES = [{ id: "10004", name: "Incident" }, { id: "10001", name: "Service Request" }];

/** A small stateful JSM: service desk 3 of project BANK (id 10100), groups 1–3, request types, forms. */
function fakeJsm(opts: { jsm?: string } = {}) {
  const groups = fx("request-type-groups.json");
  const types: any[] = [...fx("group-request-types.json"), ...fx("hidden-request-types.json")];
  const order: Record<string, number[]> = { "1": [83, 84, 85], "2": [85], "3": [] };
  const forms: Record<string, { visible: any[]; hidden: any[] }> = {
    "83": { visible: fx("request-type-fields-visible.json"), hidden: fx("request-type-fields-hidden.json") },
  };
  const unused = fx("request-type-fields-unused.json");
  let nextRt = 90;
  let nextRow = 600;
  const publicRt = (t: any) => ({ id: String(t.id), name: t.name, description: t.description, helpText: t.helpText, issueTypeId: t.issueType.id, groupIds: t.groups.map((g: any) => String(g.id)) });
  const syncOrder = () => {
    for (const g of groups) {
      const members = types.filter((t) => t.groups.some((x: any) => String(x.id) === String(g.id))).map((t) => t.id);
      order[g.id] = [...(order[g.id] ?? []).filter((id) => members.includes(id)), ...members.filter((id) => !(order[g.id] ?? []).includes(id))];
    }
  };
  const responder = (c: Call) => {
    const p = path(c);
    const url = new URL(c.url);
    if (p === "/rest/servicedeskapi/info") return { body: { version: opts.jsm ?? "11.3.5-QR-0008" } };
    if (p === "/rest/api/2/serverInfo") return { body: { version: "11.3.6" }, headers: { "set-cookie": "atlassian.xsrf.token=TOKEN123|abc|lin; Path=/" } };
    if (p === "/rest/servicedeskapi/servicedesk") return { body: { isLastPage: true, values: [{ id: "3", projectId: "10100", projectKey: "BANK", projectName: "Bank" }] } };
    if (p === "/rest/servicedeskapi/servicedesk/3") return { body: { id: "3", projectId: "10100", projectKey: "BANK", projectName: "Bank" } };
    if (p === "/rest/api/2/project/BANK") return { body: { id: "10100", key: "BANK", issueTypes: ISSUE_TYPES } };
    if (p === "/rest/servicedeskapi/servicedesk/3/requesttype") {
      if (c.method === "GET") return { body: { isLastPage: true, values: types.map(publicRt) } };
      const it = ISSUE_TYPES.find((x) => x.id === String(c.body.issueTypeId))!;
      const t = { ...fx("hidden-request-types.json")[0], id: nextRt++, name: c.body.name, description: c.body.description ?? "", helpText: c.body.helpText ?? "", issueType: { id: it.id, name: it.name }, groups: [] };
      types.push(t);
      forms[String(t.id)] = { visible: [], hidden: [] };
      return { status: 201, body: publicRt(t) };
    }
    let m = /^\/rest\/servicedeskapi\/servicedesk\/3\/requesttype\/(\d+)$/.exec(p);
    if (m && c.method === "DELETE") { types.splice(types.findIndex((t) => t.id === Number(m![1])), 1); syncOrder(); return { status: 204 }; }
    if (p === `${IJ}/10100/request-type-groups`) return { body: groups };
    m = new RegExp(`^${IJ}/10100/request-type-groups/(\\w+)/request-types(?:/(\\d+)(/move)?)?$`).exec(p);
    if (m) {
      const [, g, id, move] = m;
      if (!id) {
        const list = g === "hidden" ? types.filter((t) => !t.groups.length) : (order[g] ?? []).map((x) => types.find((t) => t.id === x));
        return { body: list };
      }
      const t = types.find((x) => x.id === Number(id));
      if (c.method === "GET") return { body: t };
      if (c.method === "PUT") {
        Object.assign(t, { name: c.body.name, description: c.body.description, groups: c.body.groups, issueType: c.body.issueType });
        syncOrder();
        return { body: t };
      }
      if (c.method === "DELETE") { t.groups = t.groups.filter((x: any) => String(x.id) !== g); syncOrder(); return { status: 204 }; }
      if (move) {
        const list = order[g].filter((x) => x !== t.id);
        const at = c.body.position === "First" ? 0 : list.indexOf(Number(String(c.body.after).split("/").pop())) + 1;
        list.splice(at, 0, t.id);
        order[g] = list;
        return { body: {} };
      }
    }
    m = new RegExp(`^${IJ}/10100/request-type-groups/help-text/(\\d+)$`).exec(p);
    if (m) { types.find((t) => t.id === Number(m![1])).helpText = c.body.helpText; return { body: { helpText: c.body.helpText } }; }
    m = new RegExp(`^${IJ}/(\\d+)/request-type-fields(?:/(\\w+))?(?:/(\\d+))?(?:/(\\w+))?$`).exec(p);
    if (m) {
      const [, rt, a, id, b] = m;
      const f = forms[rt];
      if (!a && c.method === "POST") {
        const rows = c.body.fields.map((fid: string) => {
          const u = unused.find((x: any) => x.fieldId === fid);
          const row = { ...u, id: nextRow++, displayed: true, order: f.visible.length };
          f.visible.push(row);
          return row;
        });
        return { body: rows };
      }
      if (a === "editform") return { body: { form: { id: Number(rt), name: types.find((t) => t.id === Number(rt)).name } } };
      if (a === "visible" && !id) return { body: f.visible };
      if (a === "hidden" && !id) return { body: f.hidden };
      if (a === "unused") return { body: unused.filter((u: any) => !f.visible.concat(f.hidden).some((x) => x.fieldId === u.fieldId)) };
      const all = [...f.visible, ...f.hidden];
      const rowId = Number(a === "visible" || a === "hidden" ? id : a);
      const row = all.find((x) => x.id === rowId);
      const action = a === "visible" || a === "hidden" ? b : (p.split("/").pop());
      if ((a === "visible" || a === "hidden") && c.method === "PUT" && !b) { Object.assign(row, c.body); return { body: row }; }
      if ((a === "visible" || a === "hidden") && c.method === "DELETE") { f.visible = f.visible.filter((x) => x !== row); f.hidden = f.hidden.filter((x) => x !== row); return { status: 204 }; }
      if (action === "move") {
        const list = f.visible.filter((x) => x !== row);
        const at = c.body.position === "First" ? 0 : list.findIndex((x) => x.id === Number(String(c.body.after).split("/").pop())) + 1;
        list.splice(at, 0, row);
        f.visible = list;
        return { body: row };
      }
      if (action === "hide") { f.visible = f.visible.filter((x) => x !== row); row.displayed = false; f.hidden.push(row); return { body: {} }; }
      if (action === "show") { f.hidden = f.hidden.filter((x) => x !== row); row.displayed = true; f.visible.push(row); return { body: {} }; }
      if (action === "preset") {
        if (url.searchParams.get("atl_token") !== "TOKEN123|abc|lin" || !/atlassian\.xsrf\.token=TOKEN123/.test(c.headers.Cookie ?? "")) return { status: 403, body: { errorMessages: ["XSRF check failed"] } };
        row.values = c.body.values;
        return { body: {} };
      }
    }
    return undefined;
  };
  return { responder, types, order, forms };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("request types (3.1)", () => {
  it("creates a request type for an issue type and is satisfied on re-run", async () => {
    const jsm = fakeJsm();
    const dry = await run("jira_create_request_type", { service_desk: "BANK", name: "Escalation", issue_type: "Incident", help_text: "Use for escalations" }, jsm.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { issueTypeId: "10004", name: "Escalation", description: "", helpText: "Use for escalations" });
    const r = await run("jira_create_request_type", { service_desk: "BANK", name: "Escalation", issue_type: "Incident", help_text: "Use for escalations", dry_run: false }, jsm.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.name, "Escalation");
    const again = await run("jira_create_request_type", { service_desk: "BANK", name: "escalation", issue_type: "10004" }, jsm.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("stops on a name with another issue type and on an unknown issue type", async () => {
    const conflict = await run("jira_create_request_type", { service_desk: "BANK", name: "Bank incident", issue_type: "Service Request" }, fakeJsm().responder);
    assert.match(conflict.error.message, /83.*Incident/);
    const unknown = await run("jira_create_request_type", { service_desk: "BANK", name: "X", issue_type: "Epic" }, fakeJsm().responder);
    assert.match(unknown.error.message, /Incident.*Service Request/);
  });

  it("updates name, issue type and help text, verifies, and is satisfied when equal", async () => {
    const jsm = fakeJsm();
    const r = await run("jira_update_request_type", { service_desk: "BANK", request_type: "Outage", name: "Major outage", issue_type: "Service Request", help_text: "Call the duty officer", dry_run: false }, jsm.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const t = jsm.types.find((x) => x.id === 84);
    assert.equal(t.name, "Major outage");
    assert.equal(t.issueType.id, "10001");
    assert.equal(t.helpText, "Call the duty officer");
    assert.deepEqual(t.groups, [{ id: 1, name: "Incidents" }], "groups unchanged");
    const same = await run("jira_update_request_type", { service_desk: "BANK", request_type: 84, name: "Major outage" }, jsm.responder);
    assert.equal(same.value.already_satisfied, true);
  });

  it("deletes with an irreversible warning", async () => {
    const jsm = fakeJsm();
    const dry = await run("jira_delete_request_type", { service_desk: "BANK", request_type: "Outage" }, jsm.responder);
    assert.match(dry.value.summary, /irreversible/i);
    assert.equal(dry.value.request.method, "DELETE");
    await run("jira_delete_request_type", { service_desk: "BANK", request_type: "Outage", dry_run: false }, jsm.responder);
    const gone = await run("jira_delete_request_type", { service_desk: "BANK", request_type: "Outage" }, jsm.responder);
    assert.equal(gone.value.already_satisfied, true);
  });
});

describe("portal visibility and groups (3.2)", () => {
  it("hides a request type by clearing its groups, and is satisfied when hidden", async () => {
    const jsm = fakeJsm();
    const r = await run("jira_set_request_type_hidden", { service_desk: "BANK", request_type: "Outage", hidden: true, dry_run: false }, jsm.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(jsm.types.find((x) => x.id === 84).groups, []);
    const again = await run("jira_set_request_type_hidden", { service_desk: "BANK", request_type: 84, hidden: true }, jsm.responder);
    assert.equal(again.value.already_satisfied, true);
    const show = await run("jira_set_request_type_hidden", { service_desk: "BANK", request_type: 84, hidden: false }, jsm.responder);
    assert.equal(show.res.ok, false, "showing needs a group");
  });

  it("adds to a group at a position, removes, and warns when the last group goes", async () => {
    const jsm = fakeJsm();
    const add = await run("jira_add_request_type_to_group", { service_desk: "BANK", request_type: "Internal only", group: "Incidents", position: 1, dry_run: false }, jsm.responder);
    assert.ok(add.res.ok, JSON.stringify(add.error));
    assert.deepEqual(jsm.order["1"], [86, 83, 84, 85]);
    const rm = await run("jira_remove_request_type_from_group", { service_desk: "BANK", request_type: 86, group: 1 }, jsm.responder);
    assert.match(rm.value.warning, /hidden/);
  });

  it("moves within a group, and several moves in one plan do not drift each other", async () => {
    const jsm = fakeJsm();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    for (const [rt, args] of [["Data fix", { position: 1 }], ["Bank incident", { after: "Outage" }]] as const) {
      const a = { service_desk: "BANK", request_type: rt, group: "Incidents", ...args };
      const r = await run("jira_move_request_type_in_group", a, jsm.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      addResultToPlan(file, "jira_move_request_type_in_group", a, r.value);
    }
    const out = await applyPlan(testContext(jsm.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"]);
    assert.deepEqual(jsm.order["1"], [85, 84, 83]);
  });

  it("refuses internal writes on other JSM versions", async () => {
    const r = await run("jira_add_request_type_to_group", { service_desk: "BANK", request_type: 86, group: 1 }, fakeJsm({ jsm: "10.3.4" }).responder);
    assert.equal(r.error.type, "Unsupported");
    assert.ok(!r.calls.some((c) => path(c).startsWith(IJ)));
  });
});

describe("form (4.1, 4.2)", () => {
  it("counts addable fields without returning them by default", async () => {
    const r = await run("jira_get_request_type_form", { service_desk: "BANK", request_type: "Bank incident" }, fakeJsm().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.addable, undefined);
    assert.equal(r.value.addableCount, 2);
  });

  it("reads visible fields in order, hidden fields with presets, and addable fields", async () => {
    const r = await run("jira_get_request_type_form", { service_desk: "BANK", request_type: "Bank incident", include_addable: true }, fakeJsm().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.visible.map((f: any) => f.fieldId), ["summary", "description", "priority", "components"]);
    assert.deepEqual(r.value.hidden[0], { fieldId: "duedate", name: "Due date", preset: ["2026-12-31"] });
    assert.deepEqual(r.value.addable.map((f: any) => f.fieldId), ["customfield_10700", "labels"]);
    assert.deepEqual(r.value.addable.map((f: any) => f.name), ["Severity", "Labels"]);
  });

  it("adds Severity at position 2 as required with a description", async () => {
    const jsm = fakeJsm();
    const r = await run("jira_add_request_type_field", { service_desk: "BANK", request_type: 83, field: "Severity", position: 2, required: true, description: "1 = critical … 4 = low", dry_run: false }, jsm.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const v = jsm.forms["83"].visible;
    assert.equal(v[1].fieldId, "customfield_10700");
    assert.equal(v[1].sdRequired, true);
    assert.equal(v[1].description, "1 = critical … 4 = low");
    const again = await run("jira_add_request_type_field", { service_desk: "BANK", request_type: 83, field: "Severity", position: 2 }, jsm.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("updates, moves and removes fields", async () => {
    const jsm = fakeJsm();
    assert.ok((await run("jira_update_request_type_field", { service_desk: "BANK", request_type: 83, field: "description", label: "What happened?", dry_run: false }, jsm.responder)).res.ok);
    assert.equal(jsm.forms["83"].visible[1].label, "What happened?");
    assert.ok((await run("jira_move_request_type_field", { service_desk: "BANK", request_type: 83, field: "components", position: 1, dry_run: false }, jsm.responder)).res.ok);
    assert.equal(jsm.forms["83"].visible[0].fieldId, "components");
    assert.ok((await run("jira_remove_request_type_field", { service_desk: "BANK", request_type: 83, field: "components", dry_run: false }, jsm.responder)).res.ok);
    assert.ok(!jsm.forms["83"].visible.some((f) => f.fieldId === "components"));
    const gone = await run("jira_remove_request_type_field", { service_desk: "BANK", request_type: 83, field: "components" }, jsm.responder);
    assert.equal(gone.value.already_satisfied, true);
  });

  it("hides a field with a preset (XSRF token) and refuses a Jira-required field without one", async () => {
    const jsm = fakeJsm();
    const r = await run("jira_hide_request_type_field", { service_desk: "BANK", request_type: 83, field: "priority", preset: "High", dry_run: false }, jsm.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const row = jsm.forms["83"].hidden.find((f) => f.fieldId === "priority");
    assert.deepEqual(row.values, { priority: ["High"] });
    const dry = await run("jira_hide_request_type_field", { service_desk: "BANK", request_type: 83, field: "components", preset: "Core" }, jsm.responder);
    assert.match(dry.value.request.url, /atl_token=\*\*\*/);
    assert.ok(!JSON.stringify(dry.value).includes("TOKEN123"));
    const bare = await run("jira_hide_request_type_field", { service_desk: "BANK", request_type: 83, field: "summary" }, jsm.responder);
    assert.match(bare.error.message, /Summary/);
    const show = await run("jira_show_request_type_field", { service_desk: "BANK", request_type: 83, field: "priority", dry_run: false }, jsm.responder);
    assert.ok(show.res.ok, JSON.stringify(show.error));
    assert.ok(jsm.forms["83"].visible.some((f) => f.fieldId === "priority"));
  });

  it("applies several form changes to one form in one plan without drift", async () => {
    const jsm = fakeJsm();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const plan = async (tool: string, args: Record<string, unknown>) => {
      const r = await run(tool, args, jsm.responder);
      assert.ok(r.res.ok, `${tool}: ${JSON.stringify(r.error)}`);
      addResultToPlan(file, tool, args, r.value);
    };
    await plan("jira_remove_request_type_field", { service_desk: "BANK", request_type: 83, field: "components" });
    await plan("jira_remove_request_type_field", { service_desk: "BANK", request_type: 83, field: "description" });
    await plan("jira_add_request_type_field", { service_desk: "BANK", request_type: 83, field: "labels" });
    const out = await applyPlan(testContext(jsm.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done", "done"]);
    assert.deepEqual(jsm.forms["83"].visible.map((f) => f.fieldId), ["summary", "priority", "labels"]);
  });
});
