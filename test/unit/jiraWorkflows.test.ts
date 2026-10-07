import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { compareModels, toModel } from "../../src/tools/jira/workflows.js";
import { toCompact } from "../../src/format.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira11/${name}.json`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const query = (c: Call) => new URL(c.url).searchParams;
const WD = "/rest/workflowDesigner/1.0";
const WF = "Incident WF";
const SPARE = "Spare WF";

/**
 * Fake Jira with the workflow designer: live versions and drafts in memory. "Incident WF" is used by
 * project DEMO's scheme (active), "Spare WF" by none.
 */
function fakeJira(opts: { version?: string; refuseRemove?: string[]; withDraft?: boolean; forbidOps?: boolean } = {}) {
  const clone = (x: any) => JSON.parse(JSON.stringify(x));
  const live: Record<string, any> = { [WF]: fx("workflow-designer"), [SPARE]: fx("workflow-designer") };
  const drafts: Record<string, any> = {};
  if (opts.withDraft) drafts[WF] = { ...clone(live[WF]), isDraft: true };
  const statuses: any[] = fx("workflow-statuses");
  const cats: any[] = fx("workflow-status-categories");
  const opsScheme: any = { id: 2, name: "Ops scheme", defaultWorkflow: "Other WF", issueTypeMappings: {} };
  let nextAction = 100;
  let nextStatus = 10200;
  /** The version a designer write lands in: the draft when there is one. */
  const target = (name: string) => (drafts[name] ?? live[name]).layout;
  const step = (L: any, stepId: number) => L.statuses.find((s: any) => s.stepId === stepId && !String(s.id).startsWith("I<"));
  const byStatus = (L: any, statusId: string) => L.statuses.find((s: any) => String(s.statusId) === String(statusId));
  const addStatus = (L: any, st: any, catId: number) => {
    const stepId = Math.max(...L.statuses.map((s: any) => s.stepId)) + 1;
    L.statuses.push({ id: `S<${stepId}>`, name: st.name, description: st.description ?? "", initial: false, stepId, statusId: String(st.id), x: 0, y: 0, statusCategory: { id: catId } });
  };
  const transition = (name: string, src: string, tgt: string, extra: any = {}) => {
    const actionId = nextAction++;
    return { id: `A<${actionId}:${src}:${tgt}>`, name, sourceId: src, targetId: tgt, actionId, initial: false, description: "", globalTransition: false, loopedTransition: false, transitionOptions: [], ...extra };
  };

  const responder = (c: Call) => {
    const p = path(c);
    const q = query(c);
    const b = c.body ?? {};
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.version ?? "11.3.7" } };
    if (p === "/rest/api/2/project") return { body: [{ key: "DEMO" }, { key: "OPS" }] };
    if (p === "/rest/api/2/project/DEMO/workflowscheme") return { body: { id: 1, name: "Demo scheme", defaultWorkflow: "jira", issueTypeMappings: { "10004": WF } } };
    if (p === "/rest/api/2/project/OPS/workflowscheme" && opts.forbidOps) return { status: 403, body: {} };
    if (p === "/rest/api/2/project/OPS/workflowscheme") return { body: opsScheme };
    if (p === "/rest/api/2/workflowscheme/2" && c.method === "GET") return { body: opsScheme };
    if (p.startsWith("/rest/api/2/workflowscheme/2/issuetype/") && c.method === "PUT") {
      opsScheme.issueTypeMappings[decodeURIComponent(p.split("/").pop()!)] = b.workflow;
      return { body: opsScheme };
    }
    if (p === "/rest/api/2/project/DEMO") return { body: { key: "DEMO", issueTypes: [{ id: "10004", name: "Incident" }] } };
    if (p === "/rest/api/2/issuetype") return { body: [{ id: "10004", name: "Incident" }] };
    if (p === "/rest/projectconfig/1/issuetype/DEMO/10004/workflow") return { body: fx("projectconfig-issuetype-workflow") };
    if (p === "/rest/api/2/workflow") return { body: [{ name: q.get("workflowName"), description: "Incident handling" }] };
    if (p === "/rest/api/2/screens") return { body: [{ id: 10010, name: "Workflow Screen" }, { id: 10011, name: "Resolve Screen" }] };
    if (/^\/rest\/api\/2\/workflow\/transitions\/\d+\/properties$/.test(p)) return { body: [{ key: "opsbar-sequence", value: "10", id: "opsbar-sequence" }] };
    if (p === `${WD}/statuses`) return { body: statuses };
    if (p === `${WD}/statusCategories`) return { body: cats };
    if (p === `${WD}/workflows` && c.method === "GET") {
      const name = q.get("name")!;
      if (!live[name]) return { status: 404, body: { errorMessages: [`Workflow ${name} not found`] } };
      if (q.get("draft") === "true" && !drafts[name]) drafts[name] = { ...clone(live[name]), isDraft: true };
      const wantDraft = q.get("draft") === "true" || q.get("preferDraft") === "true";
      return { body: wantDraft && drafts[name] ? drafts[name] : live[name] };
    }
    if (p === `${WD}/workflows/statuses/validateRemove`) {
      if (opts.refuseRemove?.includes(b.statusId)) return { status: 400, body: { errorMessages: ["The status is used by 3 issues"] } };
      return { body: {} };
    }
    const name = b.workflowName;
    if (p === `${WD}/workflows/statuses` && c.method === "POST") {
      addStatus(target(name), statuses.find((s) => s.id === b.statusId), 2);
      return { body: {} };
    }
    if (p === `${WD}/workflows/statuses/create`) {
      const st = { id: String(nextStatus++), name: b.name, description: b.description };
      statuses.push(st);
      addStatus(target(name), st, Number(b.statusCategoryId));
      return { body: {} };
    }
    if (p === `${WD}/workflows/statuses` && c.method === "PUT") {
      for (const v of [...Object.values(live), ...Object.values(drafts)]) {
        const s = byStatus(v.layout, b.statusId);
        if (s) Object.assign(s, { name: b.name, description: b.description, statusCategory: { id: Number(b.statusCategoryId) } });
      }
      return { body: {} };
    }
    if (p === `${WD}/workflows/statuses` && c.method === "DELETE") {
      const L = target(name);
      L.statuses = L.statuses.filter((s: any) => String(s.statusId) !== b.statusId);
      return { body: {} };
    }
    if (p === `${WD}/workflows/transitions` && c.method === "POST") {
      const L = target(name);
      L.transitions.push(transition(b.name, step(L, Number(b.sourceStepId)).id, step(L, Number(b.targetStepId)).id, { description: b.description, ...(Number(b.screenId) ? { screenId: Number(b.screenId), screenName: "Workflow Screen" } : {}) }));
      return { body: {} };
    }
    if (p === `${WD}/workflows/transitions` && c.method === "PUT") {
      const t = target(name).transitions.find((x: any) => String(x.actionId) === b.transitionId);
      Object.assign(t, { name: b.name, description: b.description });
      if (Number(b.screenId)) Object.assign(t, { screenId: Number(b.screenId), screenName: b.screenId === "10011" ? "Resolve Screen" : "Workflow Screen" });
      else delete t.screenId, delete t.screenName;
      return { body: {} };
    }
    if (p === `${WD}/workflows/transitions/target`) {
      const L = target(name);
      const t = L.transitions.find((x: any) => String(x.actionId) === b.transitionId);
      t.targetId = byStatus(L, b.targetStatusId).id;
      return { body: {} };
    }
    if ((p === `${WD}/workflows/transitions` || p === `${WD}/workflows/globalTransitions`) && c.method === "DELETE") {
      const L = target(name);
      const hit = L.transitions.find((x: any) => String(x.actionId) === b.transitionId);
      // a plain transition is addressed by its source step as well
      if (p.endsWith("/transitions") && hit && String(step(L, Number(b.sourceStepId))?.id) !== hit.sourceId) return { status: 400, body: { errorMessages: ["wrong source step"] } };
      L.transitions = L.transitions.filter((x: any) => x !== hit);
      return { body: {} };
    }
    if (p === `${WD}/workflows/globalTransitions/simple`) {
      const L = target(name);
      const s = byStatus(L, b.statusId);
      L.transitions.push(transition(b.name, s.id, s.id, { globalTransition: true }));
      return { body: {} };
    }
    if (p === `${WD}/workflows/publishDraft`) {
      const n = c.body.name;
      live[n] = { ...drafts[n], isDraft: false };
      delete drafts[n];
      return { body: {} };
    }
    if (p === `${WD}/workflows/discardDraft`) {
      delete drafts[c.body];
      return { body: {} };
    }
    return undefined;
  };
  return { responder, live, drafts, statuses };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

const designerWrites = (calls: Call[]) => calls.filter((c) => path(c).startsWith(`${WD}/workflows`) && c.method !== "GET" && !path(c).endsWith("/validateRemove"));
const names = (v: any) => v.layout.transitions.map((t: any) => t.name);

describe("jira_get_workflow (2.1)", () => {
  it("reads the workflow of a project and issue type with directions, sharing and the rule gap", async () => {
    const r = await run("jira_get_workflow", { project: "DEMO", issue_type: "Incident" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const v = r.value;
    assert.equal(v.name, WF);
    assert.equal(v.description, "Incident handling");
    assert.equal(v.isDraft, false);
    assert.equal(v.initialStatus, "Open");
    assert.deepEqual(v.statuses.map((s: any) => [s.id, s.name, s.category]), [["1", "Open", "To Do"], ["3", "In Progress", "In Progress"], ["10001", "Resolved", "Done"]]);
    const t = Object.fromEntries(v.transitions.map((x: any) => [x.name, x]));
    assert.deepEqual([t.Create.from, t.Create.to, t.Create.initial], ["(create)", "Open", true]);
    assert.deepEqual([t["Start progress"].from, t["Start progress"].to, t["Start progress"].screen], ["Open", "In Progress", "Workflow Screen"]);
    assert.deepEqual([t.Reopen.from, t.Reopen.to, t.Reopen.global], ["any", "Open", true]);
    assert.deepEqual([t.Comment.from, t.Comment.to, t.Comment.looped], ["any", "(itself)", true]);
    assert.deepEqual(t.Resolve.ruleCounts, { conditions: 1, validators: 0, postFunctions: 3 });
    assert.deepEqual(t.Resolve.properties, { "opsbar-sequence": "10" });
    assert.deepEqual(v.sharing, { projects: ["DEMO"], hiddenProjects: undefined, issueTypes: ["Incident"] });
    assert.equal(v.rules.available, false);
    assert.match(v.rules.reason, /not readable/);
    assert.ok(!("conditions" in t.Resolve) && !("postFunctions" in t.Resolve), "no guessed rule lists");
  });

  it("reads by name with sharing from the scheme scan, and reads a draft", async () => {
    const jira = fakeJira({ withDraft: true });
    jira.drafts[WF]!.layout.transitions.push({ id: "A<99:S<2>:S<1>>", name: "Back", sourceId: "S<2>", targetId: "S<1>", actionId: 99, globalTransition: false, loopedTransition: false });
    const r = await run("jira_get_workflow", { workflow: WF, properties: false }, jira.responder);
    assert.equal(r.value.hasDraft, true);
    assert.deepEqual(r.value.sharing.projects, ["DEMO"]);
    assert.deepEqual(r.value.sharing.schemes, [{ scheme: "Demo scheme", schemeId: 1, asDefault: false, issueTypes: ["10004"] }]);
    assert.ok(!r.value.transitions.some((t: any) => t.name === "Back"));
    const d = await run("jira_get_workflow", { workflow: WF, draft: true, properties: false }, jira.responder);
    assert.equal(d.value.isDraft, true);
    assert.ok(d.value.transitions.some((t: any) => t.name === "Back" && t.from === "In Progress" && t.to === "Open"));
    const none = await run("jira_get_workflow", { workflow: SPARE, draft: true }, jira.responder);
    assert.match(none.error.message, /has no draft/);
    assert.ok(!none.calls.some((c) => query(c).get("draft") === "true"), "reading never creates a draft");
  });
});

describe("comparison (2.2)", () => {
  const model = () => toModel("A", fx("workflow-designer"));
  it("reports no differences for the same model under another name", () => {
    assert.equal(compareModels(model(), toModel("B", fx("workflow-designer"))).identical, true);
  });
  it("lists missing statuses, missing and renamed transitions", () => {
    const raw = fx("workflow-designer");
    raw.layout.transitions = raw.layout.transitions.filter((t: any) => t.name !== "Resolve");
    raw.layout.transitions.find((t: any) => t.name === "Start progress").name = "Begin";
    raw.layout.statuses.push({ id: "S<9>", name: "Escalated", stepId: 9, statusId: "10100", statusCategory: { id: 4 } });
    const cmp = compareModels(model(), toModel("B", raw));
    assert.equal(cmp.identical, false);
    assert.deepEqual(cmp.statuses.onlyInSecond, ["Escalated"]);
    assert.deepEqual(cmp.transitions.onlyInFirst, [{ from: "In Progress", to: "Resolved", names: ["Resolve"] }]);
    assert.deepEqual(cmp.transitions.nameDiffers, [{ from: "Open", to: "In Progress", first: ["Start progress"], second: ["Begin"] }]);
  });
  it("compares two workflows given by name and by project", async () => {
    const r = await run("jira_compare_workflows", { first_workflow: SPARE, second_project: "DEMO", second_issue_type: "10004" }, fakeJira().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.identical, true);
    assert.equal(r.value.second, WF);
  });
});

describe("status tools (3.2)", () => {
  it("refuses on another Jira version before any designer request", async () => {
    const r = await run("jira_add_workflow_status", { workflow: WF, status: "Escalated" }, fakeJira({ version: "10.3.4" }).responder);
    assert.equal(r.error.type, "Unsupported");
    assert.match(r.error.message, /10\.3\.4/);
    assert.ok(!r.calls.some((c) => path(c).startsWith(WD) || path(c).startsWith("/rest/api/2/project")));
  });

  it("adds a new status to the draft of an active workflow, leaving the live one alone", async () => {
    const jira = fakeJira();
    const dry = await run("jira_add_workflow_status", { workflow: WF, status: "Waiting", category: "In Progress" }, jira.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.match(dry.value.target, /draft of 'Incident WF'.*created on apply/);
    assert.deepEqual(dry.value.request.body, { name: "Waiting", description: "", statusCategoryId: 4, workflowName: WF, createGlobalTransition: false });
    assert.equal(designerWrites(dry.calls).length, 0);
    assert.equal(jira.drafts[WF], undefined, "a dry run creates no draft");
    const r = await run("jira_add_workflow_status", { workflow: WF, status: "Waiting", category: "In Progress", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const post = designerWrites(r.calls)[0]!;
    assert.equal(post.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.equal(post.headers["X-Atlassian-Token"], "no-check");
    assert.equal(r.value.result.name, "Waiting");
    assert.ok(jira.drafts[WF]!.layout.statuses.some((s: any) => s.name === "Waiting"));
    assert.ok(!jira.live[WF].layout.statuses.some((s: any) => s.name === "Waiting"));
  });

  it("adds an existing status to an inactive workflow directly, and reports a present one as satisfied", async () => {
    const jira = fakeJira();
    const r = await run("jira_add_workflow_status", { workflow: SPARE, status: "Escalated", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.match(r.value.target, /workflow itself/);
    assert.deepEqual(designerWrites(r.calls)[0].body, { statusId: "10100", workflowName: SPARE, createGlobalTransition: "false" });
    assert.ok(jira.live[SPARE].layout.statuses.some((s: any) => s.name === "Escalated"));
    assert.equal(jira.drafts[SPARE], undefined);
    assert.equal((await run("jira_add_workflow_status", { workflow: SPARE, status: "escalated" }, jira.responder)).value.already_satisfied, true);
    const unknown = await run("jira_add_workflow_status", { workflow: SPARE, status: "Nope" }, jira.responder);
    assert.match(unknown.error.message, /pass category/);
  });

  it("updates a status and reports equal values as satisfied", async () => {
    const jira = fakeJira();
    const dry = await run("jira_update_workflow_status", { workflow: SPARE, status: "Resolved", name: "Done!" }, jira.responder);
    assert.deepEqual(dry.value.before, { name: "Resolved" });
    assert.deepEqual(dry.value.state, { name: "Resolved" });
    const r = await run("jira_update_workflow_status", { workflow: SPARE, status: "Resolved", name: "Done!", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(designerWrites(r.calls)[0].body, { statusId: "10001", name: "Done!", description: "", statusCategoryId: "3", workflowName: SPARE });
    assert.equal((await run("jira_update_workflow_status", { workflow: SPARE, status: "10001", name: "Done!" }, jira.responder)).value.already_satisfied, true);
  });

  it("refuses a removal Jira rejects, with Jira's reason, and removes otherwise", async () => {
    const jira = fakeJira({ refuseRemove: ["3"] });
    const refused = await run("jira_remove_workflow_status", { workflow: SPARE, status: "In Progress" }, jira.responder);
    assert.equal(refused.res.ok, false);
    assert.match(refused.error.message, /refuses.*used by 3 issues/);
    const initial = await run("jira_remove_workflow_status", { workflow: SPARE, status: "Open" }, jira.responder);
    assert.match(initial.error.message, /initial status/);
    const r = await run("jira_remove_workflow_status", { workflow: SPARE, status: "Resolved", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const del = designerWrites(r.calls)[0];
    assert.equal(del.method, "DELETE");
    assert.deepEqual(del.body, { statusId: "10001", workflowName: SPARE });
    assert.equal((await run("jira_remove_workflow_status", { workflow: SPARE, status: "Resolved" }, jira.responder)).value.already_satisfied, true);
  });

  it("defers Jira's removal check on an active workflow without a draft to apply, creating no draft in the dry run", async () => {
    const jira = fakeJira();
    const dry = await run("jira_remove_workflow_status", { workflow: WF, status: "Resolved" }, jira.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.match(dry.value.precheck, /when it is applied/);
    assert.ok(!dry.calls.some((c) => path(c).endsWith("/validateRemove")));
    assert.equal(jira.drafts[WF], undefined);
    const refused = await run("jira_remove_workflow_status", { workflow: WF, status: "In Progress", dry_run: false }, fakeJira({ refuseRemove: ["3"] }).responder);
    assert.match(refused.error.message, /refuses.*used by 3 issues/);
    assert.ok(!designerWrites(refused.calls).length, "nothing removed after a refusal");
    const r = await run("jira_remove_workflow_status", { workflow: WF, status: "Resolved", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const order = r.calls.map((c) => path(c) + (query(c).get("draft") === "true" ? "?draft" : "")).filter((x) => x.includes("/workflows"));
    assert.ok(order.indexOf(`${WD}/workflows?draft`) < order.indexOf(`${WD}/workflows/statuses/validateRemove`));
    assert.ok(!jira.drafts[WF]!.layout.statuses.some((s: any) => s.name === "Resolved"));
    assert.ok(jira.live[WF].layout.statuses.some((s: any) => s.name === "Resolved"));
  });

  it("refuses to edit a workflow it cannot classify because the scan was incomplete", async () => {
    const r = await run("jira_add_workflow_status", { workflow: SPARE, status: "Escalated" }, fakeJira({ forbidOps: true }).responder);
    assert.match(r.error.message, /Cannot tell whether 'Spare WF' is active.*403/);
    const used = await run("jira_add_workflow_status", { workflow: WF, status: "Escalated" }, fakeJira({ forbidOps: true }).responder);
    assert.ok(used.res.ok, "a workflow found in use is active regardless");
  });

  it("changes a status of an active workflow without creating a draft (statuses are global)", async () => {
    const jira = fakeJira();
    const r = await run("jira_update_workflow_status", { workflow: WF, status: "3", description: "Work started", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.match(r.value.target, /statuses are global/);
    assert.equal(jira.drafts[WF], undefined);
    assert.equal(r.value.result.description, "Work started");
  });

  it("applies two edits of an active workflow in one plan without drift", async () => {
    const jira = fakeJira();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const steps: Array<[string, Record<string, unknown>]> = [
      ["jira_add_workflow_status", { workflow: WF, status: "Escalated" }],
      ["jira_add_workflow_transition", { workflow: WF, name: "Close", from: "In Progress", to: "Resolved" }],
    ];
    for (const [tool, args] of steps) addResultToPlan(file, tool, args, (await run(tool, args, jira.responder)).value);
    const out = await applyPlan(testContext(jira.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    assert.ok(names(jira.drafts[WF]).includes("Close"));
    assert.ok(jira.drafts[WF]!.layout.statuses.some((s: any) => s.name === "Escalated"));
  });
});

describe("workflow usage scan cached per run (http-resilience 4.3)", () => {
  it("scans once for a five-edit plan", async () => {
    const jira = fakeJira();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const names = ["A", "B", "C", "D", "E"];
    for (const n of names) {
      const args = { workflow: WF, name: n, from: "Open", to: "Resolved" };
      addResultToPlan(file, "jira_add_workflow_transition", args, (await run("jira_add_workflow_transition", args, jira.responder)).value);
    }
    const { ctx, calls } = testContext(jira.responder);
    const out = await applyPlan(ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done", "done", "done", "done"], JSON.stringify(out));
    assert.equal(calls.filter((c) => path(c) === "/rest/api/2/project").length, 1, "one project scan for the whole apply");
  });

  it("sees a scheme mapping made by an earlier item: the workflow becomes active", async () => {
    const jira = fakeJira();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const map = { scheme_id: 2, issue_type_id: "10004", workflow: SPARE };
    addResultToPlan(file, "jira_set_workflow_scheme_mapping", map, (await run("jira_set_workflow_scheme_mapping", map, jira.responder)).value);
    const add = { workflow: SPARE, status: "Escalated" };
    addResultToPlan(file, "jira_add_workflow_status", add, (await run("jira_add_workflow_status", add, jira.responder)).value);
    const out = await applyPlan(testContext(jira.responder).ctx, readPlan(file), undefined, file);
    assert.equal(out[0]!.status, "done", JSON.stringify(out));
    // planned while inactive, so applying it as active differs: drift is the safe outcome, or it goes to the draft
    assert.ok(out[1]!.status === "drifted" || jira.drafts[SPARE]?.layout.statuses.some((s: any) => s.name === "Escalated"), JSON.stringify(out));
    assert.ok(!jira.live[SPARE].layout.statuses.some((s: any) => s.name === "Escalated"), "the published workflow is never edited once active");
  });
});

describe("transition tools (3.3)", () => {
  it("adds 'Escalate' to the draft of an active workflow; the published one is unchanged", async () => {
    const jira = fakeJira();
    await run("jira_add_workflow_status", { workflow: WF, status: "Escalated", dry_run: false }, jira.responder);
    const args = { workflow: WF, name: "Escalate", from: "In Progress", to: "Escalated" };
    const dry = await run("jira_add_workflow_transition", args, jira.responder);
    assert.match(dry.value.target, /draft of 'Incident WF'.*the draft exists/);
    assert.deepEqual(dry.value.request.body, { name: "Escalate", description: "", screenId: 0, sourceStepId: 2, targetStepId: 4, workflowName: WF });
    const r = await run("jira_add_workflow_transition", { ...args, dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual([r.value.result.from, r.value.result.to], ["In Progress", "Escalated"]);
    assert.ok(names(jira.drafts[WF]).includes("Escalate"));
    assert.ok(!names(jira.live[WF]).includes("Escalate"));
    assert.equal((await run("jira_add_workflow_transition", args, jira.responder)).value.already_satisfied, true);
  });

  it("updates name, keeps the current screen, and changes the target in a follow-up request", async () => {
    const jira = fakeJira();
    const r = await run("jira_update_workflow_transition", { workflow: SPARE, transition: "Start progress", name: "Start", to: "Resolved", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const [put, tgt] = designerWrites(r.calls);
    assert.deepEqual(put.body, { transitionId: "11", sourceStepId: "1", name: "Start", description: "", screenId: "10010", workflowName: SPARE });
    assert.deepEqual(tgt.body, { transitionId: "11", targetStatusId: "10001", workflowName: SPARE });
    assert.deepEqual([r.value.result.name, r.value.result.to, r.value.result.screen], ["Start", "Resolved", "Workflow Screen"]);
    const none = await run("jira_update_workflow_transition", { workflow: SPARE, transition: "11", screen: "none", dry_run: false }, jira.responder);
    assert.equal(designerWrites(none.calls)[0].body.screenId, "0");
    assert.equal(none.value.result.screen, null);
  });

  it("removes transitions and global transitions; absent ones are satisfied", async () => {
    const jira = fakeJira();
    const r = await run("jira_remove_workflow_transition", { workflow: SPARE, transition: "Resolve", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(designerWrites(r.calls)[0].body, { transitionId: "21", sourceStepId: "2", workflowName: SPARE });
    assert.equal((await run("jira_remove_workflow_transition", { workflow: SPARE, transition: "Resolve" }, jira.responder)).value.already_satisfied, true);
    const notGlobal = await run("jira_remove_workflow_transition", { workflow: SPARE, transition: "Reopen" }, jira.responder);
    assert.equal(notGlobal.value.already_satisfied, true, "global transitions are not removed by the plain tool");
    const g = await run("jira_remove_workflow_global_transition", { workflow: SPARE, transition: "Reopen", dry_run: false }, jira.responder);
    assert.ok(g.res.ok, JSON.stringify(g.error));
    assert.deepEqual(designerWrites(g.calls)[0].body, { transitionId: "31", workflowName: SPARE });
  });

  it("adds a global transition with a screen", async () => {
    const jira = fakeJira();
    const r = await run("jira_add_workflow_global_transition", { workflow: SPARE, name: "Escalate now", to: "Resolved", screen: "Workflow Screen", dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(designerWrites(r.calls)[0].body, { statusId: "10001", workflowName: SPARE, name: "Escalate now", description: "", screenId: "10010" });
    assert.deepEqual([r.value.result.from, r.value.result.to, r.value.result.global], ["any", "Resolved", true]);
  });

  it("asks for from when a transition name is ambiguous", async () => {
    const jira = fakeJira();
    jira.live[SPARE].layout.transitions.push({ id: "A<12:S<3>:S<2>>", name: "Start progress", sourceId: "S<3>", targetId: "S<2>", actionId: 12 });
    const r = await run("jira_remove_workflow_transition", { workflow: SPARE, transition: "Start progress" }, jira.responder);
    assert.match(r.error.message, /ambiguous/);
    const ok = await run("jira_remove_workflow_transition", { workflow: SPARE, transition: "Start progress", from: "Resolved" }, jira.responder);
    assert.deepEqual(ok.value.request.body, { transitionId: 12, sourceStepId: 3, workflowName: SPARE });
  });
});

describe("drafts (3.4)", () => {
  it("publishes a draft: dry run lists the added transition and the projects, then no draft remains", async () => {
    const jira = fakeJira();
    await run("jira_add_workflow_transition", { workflow: WF, name: "Back", from: "In Progress", to: "Open", dry_run: false }, jira.responder);
    const dry = await run("jira_publish_workflow_draft", { workflow: WF }, jira.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.differences.transitions.onlyInSecond, [{ from: "In Progress", to: "Open", names: ["Back"] }]);
    assert.deepEqual(dry.value.affectedProjects, ["DEMO"]);
    assert.equal(dry.value.request.body.draft, true);
    assert.ok(dry.value.request.body.layout.transitions.every((t: any) => t.id));
    const r = await run("jira_publish_workflow_draft", { workflow: WF, dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(jira.drafts[WF], undefined);
    assert.ok(names(jira.live[WF]).includes("Back"));
    assert.equal((await run("jira_publish_workflow_draft", { workflow: WF }, jira.responder)).value.already_satisfied, true);
  });

  it("keeps a planned publish valid when the draft changes before apply", async () => {
    const jira = fakeJira({ withDraft: true });
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const steps: Array<[string, Record<string, unknown>]> = [
      ["jira_add_workflow_transition", { workflow: WF, name: "Back", from: "In Progress", to: "1" }],
      ["jira_publish_workflow_draft", { workflow: WF }],
    ];
    for (const [tool, args] of steps) addResultToPlan(file, tool, args, (await run(tool, args, jira.responder)).value);
    const out = await applyPlan(testContext(jira.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    assert.ok(names(jira.live[WF]).includes("Back"));
    assert.equal(jira.drafts[WF], undefined);
  });

  it("shows the differences and affected projects in the compact dry run of a publish", async () => {
    const jira = fakeJira();
    await run("jira_add_workflow_transition", { workflow: WF, name: "Back", from: "In Progress", to: "Open", dry_run: false }, jira.responder);
    const dry = await run("jira_publish_workflow_draft", { workflow: WF }, jira.responder);
    const out = toCompact(dry.value);
    assert.match(out, /^DRY-RUN \| Publish the draft/);
    assert.match(out, /onlyInSecond \(1\):[\s\S]*In Progress \| Open \| Back/);
    assert.match(out, /affectedProjects: DEMO/);
    assert.ok(!/identity|hasDraft/.test(out), out);
  });

  it("discards a draft and leaves the published workflow; no draft → satisfied", async () => {
    const jira = fakeJira({ withDraft: true });
    const r = await run("jira_discard_workflow_draft", { workflow: WF, dry_run: false }, jira.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const post = r.calls.find((c) => path(c).endsWith("/discardDraft"))!;
    assert.equal(post.body, WF);
    assert.equal(jira.drafts[WF], undefined);
    assert.equal((await run("jira_discard_workflow_draft", { workflow: WF }, jira.responder)).value.already_satisfied, true);
  });
});
