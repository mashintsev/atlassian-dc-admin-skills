import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const q = (c: Call) => new URL(c.url).searchParams;

/**
 * Fake Jira: DEMO's Story uses "Demo Field Configuration" (id 10100), Bug uses the default
 * (served as -1 and as 10000). Field configuration ids 10000 and 10100 exist.
 */
function fakeJira(opts: { storyConfig?: string; whereFails?: boolean } = {}) {
  const custom = fx("fieldconfiguration-custom.json");
  const def = fx("fieldconfiguration-default.json");
  const descriptions: Record<string, string> = {};
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/project/DEMO") return { body: { key: "DEMO", issueTypes: [{ id: "10001", name: "Story" }, { id: "10002", name: "Bug" }] } };
    if (p === "/rest/api/2/customFields") return { body: { values: [{ id: "customfield_10101" }], total: 1 } };
    if (p === "/rest/api/2/field") return { body: [{ id: "customfield_10200", name: "Parent Link", custom: true }, { id: "customfield_10201", name: "Epic Link", custom: true }, { id: "labels", name: "Labels" }] };
    if (p.startsWith("/rest/whereismycf/1.0/fields/")) {
      if (opts.whereFails) return { status: 404, body: {} };
      const green = fx("whereismycf-green.json");
      const name = q(c).get("issueTypeId") === "10001" ? (opts.storyConfig ?? "Demo Field Configuration") : "Default Field Configuration";
      green.statusLines[1].details[0].parameters[1].value = name;
      return { body: green };
    }
    const m = /^\/rest\/internal\/2\/fieldConfiguration\/(-?\d+)(\/projects)?$/.exec(p);
    if (m) {
      const [, id, projects] = m;
      const cfg = id === "10100" ? custom : id === "-1" || id === "10000" ? { ...def, default: id === "-1" } : undefined;
      if (!cfg) return { status: 404, body: "" };
      if (projects) return { body: id === "10100" ? fx("fieldconfiguration-projects.json") : id === "-1" ? { associatedProjects: [{ id: "10102", key: "HR", name: "HR" }] } : { associatedProjects: [] } };
      const query = (q(c).get("query") ?? "").toLowerCase();
      let fields = cfg.fields.map((f: any) => (descriptions[f.id] !== undefined ? { ...f, description: descriptions[f.id] } : f));
      if (query) fields = fields.filter((f: any) => f.name.toLowerCase().includes(query));
      const max = Number(q(c).get("maxResults") ?? 10);
      const page = Number(q(c).get("page") ?? 1);
      return { body: { ...cfg, total: fields.length, fields: fields.slice((page - 1) * max, page * max) } };
    }
    return undefined;
  };
  return { responder, descriptions };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("jira_get_field_configuration (5.1)", () => {
  it("names the configuration of a project and issue type, with fields and sharing projects", async () => {
    const r = await run("jira_get_field_configuration", { project_key: "DEMO", issue_type_id: "10001" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const cfg = r.value.configurations[0];
    assert.equal(cfg.id, 10100);
    assert.equal(cfg.name, "Demo Field Configuration");
    assert.deepEqual(cfg.issueTypes, ["Story"]);
    assert.deepEqual(cfg.sharedWith, ["DEMO", "OPS"]);
    const parent = cfg.fields.items.find((f: any) => f.id === "customfield_10200");
    assert.deepEqual(parent, { id: "customfield_10200", name: "Parent Link", description: "Links to a parent", hidden: false, required: false });
    assert.equal(cfg.fields.items.find((f: any) => f.id === "components").hidden, true);
    assert.equal(r.value.fieldConfigurationScheme, null);
  });

  it("groups issue types by configuration without merging their fields", async () => {
    const r = await run("jira_get_field_configuration", { project_key: "DEMO" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.configurations.map((c: any) => [c.name, c.issueTypes]), [["Demo Field Configuration", ["Story"]], ["Default Field Configuration", ["Bug"]]]);
    assert.ok(r.value.configurations.every((c: any) => c.fields === undefined));
    assert.match(r.value.hint, /issue_type_id|field_configuration_id/);
  });

  it("treats the default configuration specially: sharing from -1, writes via its edit id", async () => {
    const r = await run("jira_get_field_configuration", { project_key: "DEMO", issue_type_id: "10002" }, fakeJira().responder);
    const cfg = r.value.configurations[0];
    assert.equal(cfg.default, true);
    assert.equal(cfg.id, 10000);
    assert.deepEqual(cfg.sharedWith, ["HR"]);
  });

  it("uses a given field_configuration_id, pages fields and filters by name", async () => {
    const r = await run("jira_get_field_configuration", { project_key: "DEMO", field_configuration_id: 10100, name_contains: "link", limit: 1 }, fakeJira().responder);
    const cfg = r.value.configurations[0];
    assert.equal(cfg.fields.total, 2);
    assert.equal(cfg.fields.items.length, 1);
    assert.equal(cfg.fields.nextOffset, 1);
    assert.ok(!r.calls.some((c) => path(c).startsWith("/rest/whereismycf")));
  });

  it("reports an unresolvable configuration instead of guessing", async () => {
    const r = await run("jira_get_field_configuration", { project_key: "DEMO", issue_type_id: "10001" }, fakeJira({ storyConfig: "Vanished Configuration" }).responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.configurations[0].id, null);
    assert.match(r.value.configurations[0].unresolved, /field_configuration_id/);
    const down = await run("jira_get_field_configuration", { project_key: "DEMO", issue_type_id: "10001" }, fakeJira({ whereFails: true }).responder);
    assert.match(down.value.configurations[0].unresolved, /field_configuration_id/);
  });
});

describe("jira_update_field_description (5.2)", () => {
  it("dry-runs with old and new value, sharing projects and the edit link", async () => {
    const r = await run("jira_update_field_description", { field_configuration_id: 10100, field_id: "Parent Link", description: "Links an Epic to its Initiative" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.dry_run, true);
    assert.equal(r.value.before, "Links to a parent");
    assert.equal(r.value.after, "Links an Epic to its Initiative");
    assert.deepEqual(r.value.sharedWith, ["DEMO", "OPS"]);
    assert.match(r.value.warning, /2 projects/);
    assert.match(r.value.request.url, /EditFieldLayoutItem!default\.jspa\?id=10100&fieldId=customfield_10200/);
    assert.ok(r.value.manual);
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("never sends the change: execution reports unsupported with the edit link", async () => {
    const r = await run("jira_update_field_description", { field_configuration_id: 10100, field_id: "customfield_10201", description: "Choose the parent Epic of a Story", dry_run: false }, fakeJira().responder);
    assert.equal(r.res.ok, false);
    assert.equal(r.error.type, "Unsupported");
    assert.match(r.error.message, /websudo/i);
    assert.match(r.error.message, /EditFieldLayoutItem/);
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("verifies a manual edit: an equal stored description is already satisfied", async () => {
    const jira = fakeJira();
    jira.descriptions.customfield_10201 = "Choose the parent Epic of a Story";
    const r = await run("jira_update_field_description", { field_configuration_id: 10100, field_id: "Epic Link", description: "Choose the parent Epic of a Story", dry_run: false }, jira.responder);
    assert.equal(r.value.already_satisfied, true);
  });

  it("rejects a field that is not in the configuration", async () => {
    const r = await run("jira_update_field_description", { field_configuration_id: 10100, field_id: "customfield_99999", description: "x" }, fakeJira().responder);
    assert.equal(r.res.ok, false);
  });
});
