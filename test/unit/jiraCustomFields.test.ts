import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, digestOf, readPlan, renderPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const TYPES = "com.atlassian.jira.plugin.system.customfieldtypes";

/** Fake Jira holding fields, contexts and two screens; mutations change the state. */
function fakeJira(opts: { version?: string; failPlacementOn?: number } = {}) {
  const fields: any[] = [
    { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
    { id: "customfield_10500", name: "Start date", custom: true, schema: { custom: `${TYPES}:datepicker` } },
  ];
  const contexts: Record<string, any[]> = {};
  const tabs: Record<string, string[]> = { "10633": ["summary"], "10634": ["summary"] };
  let nextField = 10600;
  let nextContext = 20000;
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.version ?? "11.3.6" } };
    if (p === "/rest/api/2/field" && c.method === "GET") return { body: fields };
    if (p === "/rest/api/2/field" && c.method === "POST") {
      const id = `customfield_${nextField++}`;
      fields.push({ id, name: c.body.name, custom: true, schema: { custom: c.body.type } });
      contexts[id] = [{ id: nextContext++, name: `Default Configuration Scheme for ${c.body.name}`, description: "", allProjects: true, projects: [], allIssueTypes: true, issueTypes: [] }];
      return { status: 201, body: { id, name: c.body.name } };
    }
    if (p === "/rest/globalconfig/1/customfieldtypes") return { body: fx("customfieldtypes.json") };
    if (p.startsWith("/rest/api/2/project/")) return { body: { id: p.endsWith("OPS") ? "10101" : "10100", key: p.split("/").pop() } };
    let m = /^\/rest\/internal\/2\/field\/([^/]+)\/context(?:\/(\d+))?$/.exec(p);
    if (m) {
      const list = (contexts[m[1]] ??= []);
      if (c.method === "GET") return { body: list };
      const shape = (b: any, id: number) => ({ id, name: b.name, description: b.description ?? "", allProjects: b.allProjects, projects: (b.projects ?? []).map((x: any) => ({ id: String(x.id), key: x.id === "10101" ? "OPS" : "DEMO" })), allIssueTypes: b.allIssueTypes, issueTypes: (b.issueTypes ?? []).map((x: any) => ({ id: String(x.id) })) });
      if (c.method === "POST") { const ctx = shape(c.body, nextContext++); list.push(ctx); return { body: ctx }; }
      const i = list.findIndex((x) => String(x.id) === m![2]);
      if (c.method === "PUT") { list[i] = shape(c.body, Number(m[2])); return { body: list[i] }; }
      if (c.method === "DELETE") { list.splice(i, 1); return { status: 204 }; }
    }
    if (p === "/rest/api/2/screens") return { body: { total: 2, screens: [{ id: 10433, name: "ES: Create" }, { id: 10434, name: "ES: Edit" }] } };
    if (p === "/rest/api/2/project") return { body: [] };
    if (p === "/rest/api/2/customFields") return { body: { values: [], total: 0 } };
    m = /^\/rest\/api\/2\/screens\/(\d+)\/tabs(?:\/(\d+)\/fields(?:\/([^/]+)(\/move)?)?)?$/.exec(p);
    if (m) {
      const [, screen, tab, field, move] = m;
      if (move) {
        const list = tabs[tab];
        list.splice(list.indexOf(field), 1);
        if (c.body.position === "First") list.unshift(field);
        else list.splice(list.indexOf(String(c.body.after).split("/").pop()!) + 1, 0, field);
        return { status: 204 };
      }
      if (!tab) return { body: [{ id: screen === "10433" ? 10633 : 10634, name: "Main" }] };
      if (c.method === "GET") return { body: tabs[tab].map((id) => ({ id, name: fields.find((f) => f.id === id)?.name ?? id })) };
      if (c.method === "POST") {
        if (Number(screen) === opts.failPlacementOn) return { status: 500, body: { errorMessages: ["boom"] } };
        tabs[tab].push(c.body.fieldId);
        return { body: { id: c.body.fieldId } };
      }
    }
    return undefined;
  };
  return { fields, contexts, tabs, responder };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("jira_create_custom_field (4.1)", () => {
  it("maps the short type, takes the default searcher and dry-runs the creation", async () => {
    const jira = fakeJira();
    const r = await run("jira_create_custom_field", { name: "Release URL", field_type: "url", description: "Link to the release notes" }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.request.body, { name: "Release URL", description: "Link to the release notes", type: `${TYPES}:url`, searcherKey: `${TYPES}:exacttextsearcher` });
    assert.ok(r.calls.every((c) => c.method === "GET"));
  });

  it("supports single-line text and date picker, and full type keys from Jira", async () => {
    for (const [t, key] of [["text-single-line", "textfield"], ["date-picker", "datepicker"], [`${TYPES}:select`, "select"]]) {
      const r = await run("jira_create_custom_field", { name: `F ${t}`, field_type: t }, fakeJira().responder);
      assert.ok(r.res.ok, JSON.stringify(r.error));
      assert.equal(r.value.request.body.type, `${TYPES}:${key}`);
    }
  });

  it("rejects an unknown type or searcher and lists the supported types", async () => {
    const r = await run("jira_create_custom_field", { name: "X", field_type: "rocket" }, fakeJira().responder);
    assert.equal(r.res.ok, false);
    assert.match(r.error.message, /text-single-line.*url.*date-picker/);
    const s = await run("jira_create_custom_field", { name: "X", field_type: "url", searcher_key: "nope" }, fakeJira().responder);
    assert.equal(s.res.ok, false);
  });

  it("re-uses an existing field of the same name and type, and stops on a type conflict or ambiguity", async () => {
    const jira = fakeJira();
    const same = await run("jira_create_custom_field", { name: "start DATE", field_type: "date-picker", dry_run: false }, jira.responder);
    assert.equal(same.value.already_satisfied, true);
    assert.equal(same.value.fieldId, "customfield_10500");
    assert.ok(same.calls.every((c) => c.method === "GET"));
    const conflict = await run("jira_create_custom_field", { name: "Start date", field_type: "url" }, jira.responder);
    assert.equal(conflict.res.ok, false);
    assert.match(conflict.error.message, /customfield_10500.*datepicker/);
    jira.fields.push({ id: "customfield_10501", name: "Start Date", custom: true, schema: { custom: `${TYPES}:datepicker` } });
    const ambiguous = await run("jira_create_custom_field", { name: "Start date", field_type: "date-picker" }, jira.responder);
    assert.equal(ambiguous.res.ok, false);
    assert.match(ambiguous.error.message, /customfield_10500.*customfield_10501/);
  });

  it("creates once: a re-run after creation is already satisfied", async () => {
    const jira = fakeJira();
    const first = await run("jira_create_custom_field", { name: "Release URL", field_type: "url", dry_run: false }, jira.responder);
    assert.ok(first.res.ok, JSON.stringify(first.error));
    assert.equal(first.value.result.id, "customfield_10600");
    const again = await run("jira_create_custom_field", { name: "Release URL", field_type: "url", dry_run: false }, jira.responder);
    assert.equal(again.value.already_satisfied, true);
  });
});

describe("field contexts (4.2)", () => {
  it("creates a project-scoped context through the internal API", async () => {
    const jira = fakeJira();
    const r = await run("jira_create_field_context", { field_id: "Start date", name: "DEMO only", project_ids: "DEMO,10101", issue_type_ids: "10001" }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(new URL(r.value.request.url).pathname, "/rest/internal/2/field/customfield_10500/context");
    assert.deepEqual(r.value.request.body, { name: "DEMO only", description: "", allProjects: false, projects: [{ id: "10100" }, { id: "10101" }], allIssueTypes: false, issueTypes: [{ id: "10001" }] });
  });

  it("rejects conflicting or missing scope", async () => {
    const both = await run("jira_create_field_context", { field_id: "Start date", name: "x", global: true, project_ids: "DEMO" }, fakeJira().responder);
    assert.equal(both.res.ok, false);
    const none = await run("jira_create_field_context", { field_id: "Start date", name: "x" }, fakeJira().responder);
    assert.equal(none.res.ok, false);
  });

  it("is already satisfied for an identical context and refuses other Jira versions", async () => {
    const jira = fakeJira();
    await run("jira_create_field_context", { field_id: "Start date", name: "Global", global: true, dry_run: false }, jira.responder);
    const again = await run("jira_create_field_context", { field_id: "Start date", name: "Global", global: true }, jira.responder);
    assert.equal(again.value.already_satisfied, true);
    const old = await run("jira_create_field_context", { field_id: "Start date", name: "Global", global: true }, fakeJira({ version: "10.3.4" }).responder);
    assert.equal(old.res.ok, false);
    assert.equal(old.error.type, "Unsupported");
    assert.ok(!old.calls.some((c) => path(c).includes("/rest/internal/")));
  });

  it("updates the full context, keeps unspecified attributes, and resolves context_id=default", async () => {
    const jira = fakeJira();
    await run("jira_create_custom_field", { name: "Release URL", field_type: "url", dry_run: false }, jira.responder);
    const r = await run("jira_update_field_context", { field_id: "Release URL", context_id: "default", project_ids: "DEMO", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const put = r.calls.find((c) => c.method === "PUT")!;
    assert.deepEqual(put.body, { name: "Default Configuration Scheme for Release URL", description: "", allProjects: false, projects: [{ id: "10100" }], allIssueTypes: true, issueTypes: [] });
    const same = await run("jira_update_field_context", { field_id: "Release URL", context_id: "default", project_ids: "DEMO" }, jira.responder);
    assert.equal(same.value.already_satisfied, true);
  });

  it("refuses context_id=default for deletes", async () => {
    const jira = fakeJira();
    await run("jira_create_custom_field", { name: "Release URL", field_type: "url", dry_run: false }, jira.responder);
    const r = await run("jira_delete_field_context", { field_id: "Release URL", context_id: "default" }, jira.responder);
    assert.equal(r.res.ok, false);
  });

  it("deletes a context and is satisfied when it is gone", async () => {
    const jira = fakeJira();
    await run("jira_create_field_context", { field_id: "Start date", name: "Tmp", global: true, dry_run: false }, jira.responder);
    const id = jira.contexts.customfield_10500[0].id;
    const del = await run("jira_delete_field_context", { field_id: "Start date", context_id: id, dry_run: false }, jira.responder);
    assert.ok(del.res.ok, JSON.stringify(del.error));
    const again = await run("jira_delete_field_context", { field_id: "Start date", context_id: id }, jira.responder);
    assert.equal(again.value.already_satisfied, true);
  });
});

describe("jira_add_field_to_screens (4.3)", () => {
  it("plans only missing placements, each as its own plan item", async () => {
    const jira = fakeJira();
    jira.tabs["10634"].push("customfield_10500");
    const placements = [{ screen_id: 10433, tab_id: 10633 }, { screen_id: 10434, tab_id: 10634 }];
    const r = await run("jira_add_field_to_screens", { field_id: "Start date", placements: JSON.stringify(placements) }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.batch.length, 1);
    assert.equal(r.value.satisfied.length, 1);
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const added = addResultToPlan(file, "jira_add_field_to_screens", { field_id: "Start date", placements }, r.value);
    assert.equal(added.length, 1);
    assert.equal(readPlan(file).items[0].tool, "jira_add_screen_field");
  });
});

describe("provisioning plan end to end (4.4)", () => {
  it("plans a field, its context and two placements before the field exists; resumes after a failed placement; never deletes", async () => {
    const jira = fakeJira({ failPlacementOn: 10434 });
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const plan = async (tool: string, args: Record<string, unknown>) => {
      const r = await run(tool, args, jira.responder);
      assert.ok(r.res.ok, `${tool}: ${JSON.stringify(r.error)}`);
      return addResultToPlan(file, tool, args, r.value);
    };
    await plan("jira_create_custom_field", { name: "Release URL", field_type: "url" });
    await plan("jira_update_field_context", { field_id: "Release URL", context_id: "default", project_ids: "DEMO" });
    await plan("jira_add_field_to_screens", { field_id: "Release URL", placements: [{ screen_id: 10433, tab_id: 10633 }, { screen_id: 10434, tab_id: 10634, position: 1 }] });
    assert.equal(readPlan(file).items.length, 4);

    const first = testContext(jira.responder);
    const outcomes = await applyPlan(first.ctx, readPlan(file), undefined, file);
    assert.deepEqual(outcomes.map((o) => o.status), ["done", "done", "done", "failed"]);
    assert.match(renderPlan(readPlan(file), file), /remaining 1/);
    assert.equal(jira.contexts.customfield_10600[0].allProjects, false);
    assert.deepEqual(jira.tabs["10633"], ["summary", "customfield_10600"]);

    // the placement works now; only it runs again
    const retry = fakeJira();
    Object.assign(retry.fields, jira.fields); retry.fields.splice(0, retry.fields.length, ...jira.fields);
    Object.assign(retry.tabs, jira.tabs); Object.assign(retry.contexts, jira.contexts);
    const second = testContext(retry.responder);
    const again = await applyPlan(second.ctx, readPlan(file), undefined, file);
    assert.deepEqual(again.map((o) => o.status), ["skipped", "skipped", "skipped", "done"], JSON.stringify(again));
    assert.deepEqual(retry.tabs["10634"], ["customfield_10600", "summary"]);
    for (const c of [...first.calls, ...second.calls]) assert.notEqual(c.method, "DELETE");
  });

  it("keeps the identity digest of a pending field reference stable", async () => {
    const jira = fakeJira();
    const planned = await run("jira_update_field_context", { field_id: "Release URL", context_id: "default", project_ids: "DEMO" }, jira.responder);
    assert.ok(planned.res.ok, JSON.stringify(planned.error));
    await run("jira_create_custom_field", { name: "Release URL", field_type: "url", dry_run: false }, jira.responder);
    const later = await run("jira_update_field_context", { field_id: "Release URL", context_id: "default", project_ids: "DEMO" }, jira.responder);
    assert.equal(digestOf(planned.value), digestOf(later.value));
  });
});
