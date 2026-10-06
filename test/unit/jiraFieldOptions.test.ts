import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { manualOptionSteps } from "../../src/tools/jira/fieldOptions.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const q = (c: Call) => new URL(c.url).searchParams;
const T = "com.atlassian.jira.plugin.system.customfieldtypes";

/**
 * Fake Jira with Severity (customfield_10700): a global default context (empty unless `globalOptions`)
 * and a DEMO/Incident context holding 1–4 with "4" disabled. Option writes follow setOptions.
 */
function fakeJira(opts: { globalOptions?: string[]; version?: string; withField?: boolean } = {}) {
  const fields: any[] = [{ id: "summary", name: "Summary", custom: false, schema: { type: "string" } }, { id: "customfield_10800", name: "Notes", custom: true, schema: { custom: `${T}:textarea` } }];
  if (opts.withField !== false) fields.push({ id: "customfield_10700", name: "Severity", custom: true, schema: { custom: `${T}:select` } });
  // a field created during the test gets only Jira's global default context
  const contexts: Record<string, any[]> = { customfield_10700: opts.withField === false ? fx("field-contexts-severity.json").slice(0, 1) : fx("field-contexts-severity.json") };
  let nextOption = 20000;
  const store: Record<string, any[]> = {
    "10900": (opts.globalOptions ?? []).map((v) => ({ id: nextOption++, value: v, disabled: false, childrenIds: [] })),
    "10901": fx("customfield-options.json").options,
  };
  // the field configuration (context) Jira resolves for a project/issue type pair
  const resolve = (fieldId: string, p: string | null, t: string | null) => {
    const ctx = contexts[fieldId] ?? [];
    const match = ctx.filter((c) => (c.allProjects || c.projects.some((x: any) => x.id === p)) && (c.allIssueTypes || c.issueTypes.some((x: any) => x.id === t)));
    match.sort((a, b) => (b.allProjects ? 0 : 2) + (b.allIssueTypes ? 0 : 1) - ((a.allProjects ? 0 : 2) + (a.allIssueTypes ? 0 : 1)));
    return match[0] ? String(match[0].fieldConfigIds[0]) : undefined;
  };
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.version ?? "11.3.6" } };
    if (p === "/rest/api/2/field" && c.method === "GET") return { body: fields };
    if (p === "/rest/api/2/field" && c.method === "POST") {
      const id = "customfield_10700";
      fields.push({ id, name: c.body.name, custom: true, schema: { custom: c.body.type } });
      return { status: 201, body: { id } };
    }
    if (p === "/rest/globalconfig/1/customfieldtypes") return { body: fx("customfieldtypes.json") };
    let m = /^\/rest\/internal\/2\/field\/([^/]+)\/context$/.exec(p);
    if (m) return { body: contexts[m[1]] ?? [] };
    m = /^\/rest\/api\/2\/customFields\/(\d+)\/options$/.exec(p);
    if (m) {
      const cfg = resolve(`customfield_${m[1]}`, q(c).get("projectIds"), q(c).get("issueTypeIds"));
      const list = cfg ? store[cfg] : [];
      return { body: { options: list, total: list.length } };
    }
    m = /^\/rest\/globalconfig\/1\/customfieldoptions\/([^/]+)\/setOptions$/.exec(p);
    if (m) {
      const cfg = resolve(m[1], c.body.issueContext.projectId, c.body.issueContext.issueTypeId)!;
      store[cfg] = c.body.options.map((o: any) => ({ id: nextOption++, value: o.name, disabled: false, childrenIds: [] }));
      return { body: {} };
    }
    return undefined;
  };
  return { responder, store };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("jira_get_custom_field_options (2.1)", () => {
  it("lists options per context in order with disabled state", async () => {
    const r = await run("jira_get_custom_field_options", { field: "Severity" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const bank = r.value.contexts.find((c: any) => c.id === 10801);
    assert.deepEqual(bank.options.map((o: any) => [o.value, o.disabled]), [["1", false], ["2", false], ["3", false], ["4", true]]);
    assert.equal(bank.scope, "projects 10100; issue types 10004");
    assert.deepEqual(r.value.contexts.find((c: any) => c.id === 10800).options, []);
    const one = await run("jira_get_custom_field_options", { field: "customfield_10700", context: 10801 }, fakeJira().responder);
    assert.equal(one.value.contexts.length, 1);
  });

  it("rejects field types without options", async () => {
    const r = await run("jira_get_custom_field_options", { field: "Notes" }, fakeJira().responder);
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /textarea/);
  });
});

describe("manual option steps (3.1)", () => {
  const stored = [{ id: 1, value: "1", disabled: false }, { id: 2, value: "2", disabled: false }, { id: 3, value: "3", disabled: false }, { id: 4, value: "4", disabled: false }];

  it("names options to disable, keeps unlisted options, and is empty when satisfied", () => {
    const retire = manualOptionSteps(stored, [{ value: "1" }, { value: "2" }, { value: "3" }, { value: "4", disabled: true }]);
    assert.deepEqual(retire.steps, ["disable '4'"]);
    assert.deepEqual(manualOptionSteps(stored, [{ value: "1" }, { value: "2" }]).steps, []);
    assert.deepEqual(manualOptionSteps(stored, [{ value: "1" }, { value: "2" }]).kept, ["3", "4"]);
  });

  it("names additions, renames by id and reorders", () => {
    const r = manualOptionSteps(stored, [{ value: "4" }, { id: 1, value: "One" }, { value: "5" }]);
    assert.deepEqual(r.steps, ["rename '1' to 'One'", "add '5'", "order: '4', 'One', '5', then '2', '3'"]);
  });

  it("rejects duplicate values", () => {
    assert.throws(() => manualOptionSteps(stored, [{ value: "1" }, { value: "1" }]), /'1'/);
    assert.throws(() => manualOptionSteps(stored, [{ id: 2, value: "1" }]), /'1'/);
  });
});

describe("jira_set_custom_field_options (3.2)", () => {
  it("writes Severity 1–4 to an empty context and reads them back", async () => {
    const jira = fakeJira();
    const r = await run("jira_set_custom_field_options", { field: "Severity", context: 10800, options: "1,2,3,4", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const post = r.calls.find((c) => c.method === "POST")!;
    assert.equal(path(post), "/rest/globalconfig/1/customfieldoptions/customfield_10700/setOptions");
    assert.deepEqual(post.body, { options: [{ name: "1" }, { name: "2" }, { name: "3" }, { name: "4" }], issueContext: { projectId: null, issueTypeId: null } });
    assert.deepEqual(jira.store["10900"].map((o: any) => o.value), ["1", "2", "3", "4"]);
    const again = await run("jira_set_custom_field_options", { field: "Severity", context: 10800, options: "1,2,3,4" }, jira.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("prepares changes to existing options as a manual change and never sends them", async () => {
    const jira = fakeJira();
    const target = JSON.stringify([{ value: "1" }, { value: "2" }, { value: "3", disabled: true }, { value: "4", disabled: true }]);
    const dry = await run("jira_set_custom_field_options", { field: "Severity", context: 10801, options: target }, jira.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "MANUAL");
    assert.match(dry.value.request.url, /EditCustomFieldOptions!default\.jspa\?fieldConfigId=10901/);
    assert.deepEqual(dry.value.request.body.steps, ["disable '3'"]);
    const exec = await run("jira_set_custom_field_options", { field: "Severity", context: 10801, options: target, dry_run: false }, jira.responder);
    assert.equal(exec.error.type, "Unsupported");
    assert.ok(exec.calls.every((c) => c.method === "GET"));
    jira.store["10901"][2].disabled = true; // the administrator did it in the UI
    const verify = await run("jira_set_custom_field_options", { field: "Severity", context: 10801, options: target }, jira.responder);
    assert.equal(verify.value.already_satisfied, true);
  });

  it("creates disabled options enabled and says they must be disabled in the UI", async () => {
    const r = await run("jira_set_custom_field_options", { field: "Severity", context: 10800, options: JSON.stringify([{ value: "1" }, { value: "2", disabled: true }]) }, fakeJira().responder);
    assert.deepEqual(r.value.request.body.options, [{ name: "1" }, { name: "2" }]);
    assert.match(r.value.warning, /'2'.*disable/);
  });

  it("refuses when the derived pair belongs to a more specific context", async () => {
    const jira = fakeJira();
    const r = await run("jira_set_custom_field_options", { field: "Severity", context: 10800, options: "1" }, (c) => {
      if (path(c) === "/rest/internal/2/field/customfield_10700/context") {
        const list = fx("field-contexts-severity.json");
        // target: all projects, issue type Incident → pair (null, 10004); another context: DEMO + Incident is more specific only for DEMO,
        // so (null, 10004) still resolves to the target. Make a second all-projects context for Incident with a project list instead:
        list[0].allIssueTypes = false; list[0].issueTypes = [{ id: "10004" }];
        list[1].allProjects = true; list[1].projects = []; list[1].allIssueTypes = false; list[1].issueTypes = [{ id: "10004" }, { id: "10005" }];
        return { body: list };
      }
      return jira.responder(c);
    });
    assert.equal(r.res.ok, false);
    assert.equal(r.error.type, "Unsupported");
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("rejects duplicates and other Jira versions", async () => {
    const dup = await run("jira_set_custom_field_options", { field: "Severity", context: 10800, options: "1,1" }, fakeJira().responder);
    assert.equal(dup.res.ok, false);
    const old = await run("jira_set_custom_field_options", { field: "Severity", context: 10800, options: "1" }, fakeJira({ version: "10.3.4" }).responder);
    assert.equal(old.error.type, "Unsupported");
  });

  it("plans the field and its options before the field exists and applies both", async () => {
    const jira = fakeJira({ withField: false });
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const plan = async (tool: string, args: Record<string, unknown>) => {
      const r = await run(tool, args, jira.responder);
      assert.ok(r.res.ok, `${tool}: ${JSON.stringify(r.error)}`);
      addResultToPlan(file, tool, args, r.value);
    };
    await plan("jira_create_custom_field", { name: "Severity", field_type: `${T}:select` });
    await plan("jira_set_custom_field_options", { field: "Severity", options: "1,2,3,4" });
    const outcomes = await applyPlan(testContext(jira.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(outcomes.map((o) => o.status), ["done", "done"]);
    assert.deepEqual(jira.store["10900"].map((o: any) => o.value), ["1", "2", "3", "4"]);
  });
});
