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
const q = (c: Call) => new URL(c.url).searchParams;

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

const F = (id: string, name: string) => ({ id, name, type: "System field" });
const FIELD_LIST = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
  { id: "components", name: "Component/s", custom: false, schema: { type: "array" } },
  { id: "fixVersions", name: "Fix Version/s", custom: false, schema: { type: "array" } },
  { id: "versions", name: "Affects Version/s", custom: false, schema: { type: "array" } },
  { id: "labels", name: "Labels", custom: false, schema: { type: "array" } },
  { id: "customfield_10300", name: "Release URL", custom: true, schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:url" } },
];

/**
 * A small fake Jira: screen 10433 with tabs 10633 (main) and 10634 (other), mutable field order,
 * no projects (usage scan finds nothing unless a test adds them).
 */
function fakeJira(initial: Record<string, string[]>, extra?: (c: Call) => any) {
  const tabs: Record<string, string[]> = JSON.parse(JSON.stringify(initial));
  const name = (id: string) => FIELD_LIST.find((f) => f.id === id)?.name ?? id;
  const responder = (c: Call) => {
    const special = extra?.(c);
    if (special !== undefined) return special;
    const p = path(c);
    if (p === "/rest/api/2/serverInfo") return { body: { version: "11.3.6" } };
    if (p === "/rest/api/2/field") return { body: FIELD_LIST };
    if (p === "/rest/api/2/screens") return { body: fx("screens-list.json") };
    if (p === "/rest/api/2/project") return { body: [] };
    if (p === "/rest/api/2/customFields") return { body: { values: [{ id: "customfield_10101", name: "Probe Field" }], total: 1 } };
    const m = /^\/rest\/api\/2\/screens\/(\d+)\/tabs(?:\/(\d+)\/fields(?:\/([^/]+)(\/move)?)?)?$/.exec(p);
    if (m) {
      const [, , tab, field, move] = m;
      if (!tab) return { body: [{ id: 10633, name: "Main" }, { id: 10634, name: "Other" }] };
      const list = tabs[tab];
      if (c.method === "GET") return { body: list.map((id) => F(id, name(id))) };
      if (c.method === "POST" && !field) { list.push(c.body.fieldId); return { body: F(c.body.fieldId, name(c.body.fieldId)) }; }
      if (c.method === "DELETE") { list.splice(list.indexOf(field), 1); return { status: 204 }; }
      if (c.method === "POST" && move) {
        list.splice(list.indexOf(field), 1);
        if (c.body.position === "First") list.unshift(field);
        else list.splice(list.indexOf(String(c.body.after).split("/").pop()!) + 1, 0, field);
        return { status: 204 };
      }
    }
    return undefined;
  };
  return { tabs, responder };
}

describe("screen listing (3.1)", () => {
  it("reads the Jira 11 `screens` key", async () => {
    const r = await run("jira_list_screens", {}, () => ({ body: fx("screens-list.json") }));
    assert.ok(r.res.ok);
    assert.equal(r.value.total, 3);
    assert.deepEqual(r.value.items.map((s: any) => s.id), [10433, 10434, 10435]);
  });

  it("still reads the older `values` key", async () => {
    const r = await run("jira_list_screens", {}, () => ({ body: { total: 1, values: [{ id: 1, name: "Default Screen" }] } }));
    assert.deepEqual(r.value.items.map((s: any) => s.id), [1]);
  });

  it("accepts a numeric-looking search text", async () => {
    const r = await run("jira_list_screens", { search: 10433 }, () => ({ body: fx("screens-list.json") }));
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(q(r.calls[0]).get("search"), "10433");
  });
});

describe("jira_get_screen_usage (3.2)", () => {
  const projects = [{ key: "DEMO", id: "10100" }, { key: "OPS", id: "10101" }];
  const issueTypes = [{ id: "10001", name: "Story", subtask: false }, { id: "10002", name: "Bug", subtask: false }];
  const green = fx("whereismycf-green.json");
  const red = fx("whereismycf-red.json");
  // DEMO uses 10435 (create) / 10434 (edit) / 10433 (view); OPS only views with 10433
  const usage = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/screens") return { body: fx("screens-list.json") };
    if (p === "/rest/api/2/project") return { body: projects };
    if (p.startsWith("/rest/api/2/project/")) return { body: { key: p.split("/").pop(), issueTypes } };
    if (p === "/rest/api/2/customFields") return { body: { values: [{ id: "customfield_10101", name: "Probe Field" }], total: 1 } };
    if (p.startsWith("/rest/projectconfig/1/issuetype/")) {
      const v = fx("projectconfig-issuetype-fields.json");
      if (p.includes("/OPS/") && p.includes("/10002/")) v.viewScreen.screenId = 10435;
      return { body: v };
    }
    if (p.startsWith("/rest/whereismycf/1.0/fields/")) {
      const op = q(c).get("issueOperation");
      if (q(c).get("projectKey") === "OPS") return { status: 403, body: {} };
      return { body: op === "0" ? green : red };
    }
    return undefined;
  };

  it("lists projects, issue types and operations, with schemes and a sharing warning", async () => {
    const r = await run("jira_get_screen_usage", { screen_id: 10434 }, usage);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.screen.name, "DEMO: Edit Screen");
    assert.deepEqual(r.value.items.map((u: any) => `${u.project}/${u.issueType}/${u.operation}`), ["DEMO/Story/edit", "DEMO/Bug/edit"]);
    assert.deepEqual(r.value.screenSchemes, ["10505"]);
    assert.deepEqual(r.value.issueTypeScreenSchemes, ["10503"]);
    assert.match(r.value.warning, /2 issue types/);
    // OPS answered 403 for create/edit: reported, not silently dropped
    assert.equal(r.value.unreadableProjects, 1);
    assert.equal(r.value.complete, false);
  });

  it("finds view usage through project-config", async () => {
    const r = await run("jira_get_screen_usage", { screen_id: 10433 }, usage);
    const ops = r.value.items.map((u: any) => `${u.project}/${u.issueType}/${u.operation}`);
    assert.ok(ops.includes("DEMO/Story/view") && ops.includes("OPS/Story/view"));
    assert.deepEqual(r.value.projects, ["DEMO", "OPS"]);
    assert.match(r.value.warning, /2 projects/);
  });

  it("reports a truncated scan", async () => {
    const r = await run("jira_get_screen_usage", { screen_id: 10433, scan_projects: 1 }, usage);
    assert.equal(r.value.scannedProjects, 1);
    assert.equal(r.value.truncatedScan, true);
    assert.equal(r.value.complete, false);
  });
});

describe("screen field changes (3.3)", () => {
  it("adds a field at a 1-based position and returns the screen read back", async () => {
    const jira = fakeJira({ 10633: ["summary", "labels", "components"], 10634: [] });
    const r = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "Release URL", position: 2, dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(jira.tabs[10633], ["summary", "customfield_10300", "labels", "components"]);
    const move = r.calls.find((c) => c.method === "POST" && path(c).endsWith("/move"))!;
    assert.match(move.body.after, /^https:\/\/jira\.example\.com\/rest\/api\/2\/screens\/10433\/tabs\/10633\/fields\/summary$/);
    const tab = r.value.result.find((t: any) => t.id === 10633);
    assert.deepEqual(tab.fields.map((f: any) => f.id), jira.tabs[10633]);
  });

  it("dry run shows screen, tab, field, resulting order and affected projects", async () => {
    const jira = fakeJira({ 10633: ["summary", "labels"], 10634: [] });
    const r = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "labels", position: 1 }, jira.responder);
    assert.equal(r.value.dry_run, true);
    for (const part of [/DEMO: View Screen/, /\/ Main/, /Labels/]) assert.match(r.value.summary, part);
    assert.deepEqual(r.value.after, ["labels", "summary"]);
    assert.ok("affectedProjects" in r.value);
    assert.match(r.value.warning, /^affected projects: /);
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("is already satisfied when the field is present (add) or absent (remove)", async () => {
    const jira = fakeJira({ 10633: ["summary", "labels"], 10634: [] });
    const add = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "labels" }, jira.responder);
    assert.equal(add.value.already_satisfied, true);
    const rm = await run("jira_remove_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", dry_run: false }, jira.responder);
    assert.equal(rm.value.already_satisfied, true);
    assert.ok(rm.calls.every((c) => c.method === "GET"));
  });

  it("refuses to add a field that sits on another tab of the screen", async () => {
    const jira = fakeJira({ 10633: ["summary"], 10634: ["labels"] });
    const r = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "labels" }, jira.responder);
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /Other/);
  });

  it("removes the JC-83 fields one by one", async () => {
    const jira = fakeJira({ 10633: ["summary", "components", "fixVersions", "labels"], 10634: [] });
    for (const f of ["Component/s", "fixVersions"]) {
      const r = await run("jira_remove_screen_field", { screen_id: 10433, tab_id: 10633, field_id: f, dry_run: false }, jira.responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
    }
    assert.deepEqual(jira.tabs[10633], ["summary", "labels"]);
  });

  it("moves with position or after_field_id and is satisfied when already in place", async () => {
    const jira = fakeJira({ 10633: ["summary", "labels", "components"], 10634: [] });
    const first = await run("jira_move_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", position: 1, dry_run: false }, jira.responder);
    assert.ok(first.res.ok, JSON.stringify(first.error));
    assert.deepEqual(jira.tabs[10633], ["components", "summary", "labels"]);
    const after = await run("jira_move_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", after_field_id: "labels", dry_run: false }, jira.responder);
    assert.ok(after.res.ok);
    assert.deepEqual(jira.tabs[10633], ["summary", "labels", "components"]);
    const same = await run("jira_move_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", position: 3 }, jira.responder);
    assert.equal(same.value.already_satisfied, true);
    const both = await run("jira_move_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", position: 1, after_field_id: "labels" }, jira.responder);
    assert.equal(both.res.ok, false);
  });

  it("drifts when the state the change depends on changed after planning", async () => {
    const planned = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", position: 2 }, fakeJira({ 10633: ["summary", "labels"], 10634: [] }).responder);
    // the field that position 2 follows is no longer Summary
    const moved = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", position: 2 }, fakeJira({ 10633: ["labels", "summary"], 10634: [] }).responder);
    assert.notEqual(digestOf(planned.value), digestOf(moved.value));
    // an unrelated field added at the end does not matter
    const same = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", position: 2 }, fakeJira({ 10633: ["summary", "labels", "versions"], 10634: [] }).responder);
    assert.equal(digestOf(planned.value), digestOf(same.value));
  });

  it("applies several planned changes to one tab without drifting itself (JC-83)", async () => {
    const jira = fakeJira({ 10633: ["summary", "components", "fixVersions", "labels"], 10634: [] });
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    for (const f of ["components", "fixVersions"]) {
      const r = await run("jira_remove_screen_field", { screen_id: 10433, tab_id: 10633, field_id: f }, jira.responder);
      addResultToPlan(file, "jira_remove_screen_field", { screen_id: 10433, tab_id: 10633, field_id: f }, r.value);
    }
    const outcomes = await applyPlan(testContext(jira.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(outcomes.map((o) => o.status), ["done", "done"]);
    assert.deepEqual(jira.tabs[10633], ["summary", "labels"]);
  });

  it("is already satisfied when adding a present field without a position", async () => {
    const jira = fakeJira({ 10633: ["summary", "components", "labels"], 10634: [] });
    const r = await run("jira_add_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components" }, jira.responder);
    assert.equal(r.value.already_satisfied, true);
  });

  it("fails verification when the read-back does not show the change", async () => {
    const jira = fakeJira({ 10633: ["summary", "components"], 10634: [] }, (c) =>
      c.method === "DELETE" ? { status: 204 } : undefined); // Jira "accepts" but keeps the field
    const r = await run("jira_remove_screen_field", { screen_id: 10433, tab_id: 10633, field_id: "components", dry_run: false }, jira.responder);
    assert.equal(r.res.ok, false);
    assert.equal(r.error.type, "VerificationError");
  });
});
