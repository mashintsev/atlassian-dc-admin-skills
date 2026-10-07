import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => new URL(c.url).pathname;
const BASE = "/rest/api/2/workflowscheme";

/**
 * Stateful fake of the workflow scheme resources. `active` schemes write to their draft when
 * updateDraftIfNeeded is true (creating it); `ignoreWrites` accepts writes without changing anything.
 */
export function fakeSchemes(opts: { active?: boolean; ignoreWrites?: boolean; withDraft?: boolean; usedBy?: string[] } = {}) {
  const clone = (x: any) => JSON.parse(JSON.stringify(x));
  const schemes: Record<string, any> = {
    "100": { id: 100, name: "Ops scheme", description: "Ops", defaultWorkflow: "jira", issueTypeMappings: { "1": "Bug WF", "5": "Bug WF" } },
  };
  const drafts: Record<string, any> = {};
  if (opts.withDraft) drafts["100"] = { ...clone(schemes["100"]), draft: true };
  let nextId = 200;
  const target = (id: string, toDraft: boolean) => {
    if (toDraft && opts.active) {
      drafts[id] ??= { ...clone(schemes[id]), draft: true };
      return drafts[id];
    }
    return drafts[id] && toDraft ? drafts[id] : schemes[id];
  };
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    const b = c.body ?? {};
    if (p === "/rest/api/2/project") return { body: (opts.usedBy ?? []).map((key) => ({ key })) };
    const proj = /^\/rest\/api\/2\/project\/([^/]+)\/workflowscheme$/.exec(p);
    if (proj) return { body: schemes["100"] };
    if (p === "/rest/api/2/issuetype") return { body: [{ id: "1", name: "Bug" }, { id: "5", name: "Task" }, { id: "7", name: "Story" }] };
    if (p === BASE && c.method === "POST") {
      const id = String(nextId++);
      if (!opts.ignoreWrites) schemes[id] = { id: Number(id), name: b.name, description: b.description, defaultWorkflow: b.defaultWorkflow ?? "jira", issueTypeMappings: b.issueTypeMappings ?? {} };
      return { status: 201, body: { id: Number(id), name: b.name } };
    }
    const m = /^\/rest\/api\/2\/workflowscheme\/(\d+)(\/.*)?$/.exec(p);
    if (!m) return undefined;
    const [, id, rest = ""] = m;
    const scheme = schemes[id!];
    if (!scheme) return { status: 404, body: { errorMessages: ["no scheme"] } };
    const write = c.method !== "GET" && !opts.ignoreWrites;
    if (rest === "" && c.method === "GET") return { body: scheme };
    if (rest === "/draft" && c.method === "GET") return drafts[id!] ? { body: drafts[id!] } : { status: 404, body: {} };
    if (rest === "/draft" && c.method === "DELETE") {
      if (write) delete drafts[id!];
      return { status: 204, body: "" };
    }
    if (rest === "/createdraft") {
      if (write) drafts[id!] = { ...clone(scheme), draft: true };
      return { status: 201, body: drafts[id!] ?? scheme };
    }
    if (rest === "" && c.method === "DELETE") {
      if (write) delete schemes[id!];
      return { status: 204, body: "" };
    }
    if (rest === "" && c.method === "PUT") {
      if (write) {
        const t = target(id!, b.updateDraftIfNeeded === true);
        for (const k of ["name", "description", "defaultWorkflow", "issueTypeMappings"]) if (b[k] !== undefined) t[k] = b[k];
      }
      return { body: scheme };
    }
    if (rest === "/default" && c.method === "PUT") {
      if (write) target(id!, b.updateDraftIfNeeded === true).defaultWorkflow = b.workflow;
      return { body: scheme };
    }
    const it = /^\/issuetype\/([^/]+)$/.exec(rest);
    if (it && c.method === "PUT") {
      if (write) target(id!, b.updateDraftIfNeeded === true).issueTypeMappings[decodeURIComponent(it[1]!)] = b.workflow;
      return { body: scheme };
    }
    if (it && c.method === "DELETE") {
      if (write) delete target(id!, q.get("updateDraftIfNeeded") === "true").issueTypeMappings[decodeURIComponent(it[1]!)];
      return { body: scheme };
    }
    return undefined;
  };
  return { responder, schemes, drafts };
}

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runToolByName(tool, args, ctx);
  return { r, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error, writes: calls.filter((c) => c.method !== "GET") };
}

/** Each case: args that are already in effect, args that change something, and the check on the fake afterwards. */
const CASES: Array<{
  tool: string;
  satisfied: Record<string, unknown>;
  change: Record<string, unknown>;
  after: (f: ReturnType<typeof fakeSchemes>) => boolean;
}> = [
  { tool: "jira_set_workflow_scheme_mapping", satisfied: { scheme_id: 100, issue_type: "1", workflow: "Bug WF" }, change: { scheme_id: 100, issue_type: "7", workflow: "Story WF" }, after: (f) => f.schemes["100"].issueTypeMappings["7"] === "Story WF" },
  { tool: "jira_delete_workflow_scheme_mapping", satisfied: { scheme_id: 100, issue_type: "7" }, change: { scheme_id: 100, issue_type: "5" }, after: (f) => !("5" in f.schemes["100"].issueTypeMappings) },
  { tool: "jira_set_workflow_scheme_default", satisfied: { scheme_id: 100, workflow: "jira" }, change: { scheme_id: 100, workflow: "Ops WF" }, after: (f) => f.schemes["100"].defaultWorkflow === "Ops WF" },
  { tool: "jira_update_workflow_scheme", satisfied: { scheme_id: 100, name: "Ops scheme", description: "Ops" }, change: { scheme_id: 100, name: "Ops scheme 2" }, after: (f) => f.schemes["100"].name === "Ops scheme 2" },
  { tool: "jira_delete_workflow_scheme", satisfied: { scheme_id: 999 }, change: { scheme_id: 100 }, after: (f) => !f.schemes["100"] },
  { tool: "jira_replace_workflow_in_scheme", satisfied: { scheme_id: 100, from_workflow: "Old WF", to_workflow: "Bug WF" }, change: { scheme_id: 100, from_workflow: "Bug WF", to_workflow: "New Bug WF" }, after: (f) => f.schemes["100"].issueTypeMappings["1"] === "New Bug WF" && f.schemes["100"].issueTypeMappings["5"] === "New Bug WF" },
  { tool: "jira_create_workflow_scheme", satisfied: { name: "Ops scheme", default_workflow: "jira", issue_type_mappings: { "1": "Bug WF", "5": "Bug WF" } }, change: { name: "New scheme", default_workflow: "Ops WF" }, after: (f) => Object.values(f.schemes).some((s: any) => s.name === "New scheme") },
];

describe("workflow scheme write safety (unify 2.3)", () => {
  for (const c of CASES) {
    describe(c.tool, () => {
      it("reports the change already in effect as already-satisfied and sends nothing", async () => {
        const { value, error, writes } = await run(c.tool, { ...c.satisfied, dry_run: false }, fakeSchemes({ usedBy: ["OPS"] }).responder);
        assert.equal(value?.already_satisfied, true, JSON.stringify(error ?? value));
        assert.deepEqual(writes, []);
      });

      it("executes and reads the change back", async () => {
        const f = fakeSchemes({ usedBy: ["OPS"] });
        const { value, error } = await run(c.tool, { ...c.change, dry_run: false }, f.responder);
        assert.ok(value && !value.already_satisfied, JSON.stringify(error ?? value));
        assert.ok(c.after(f), "the fake shows the change");
      });

      it("fails verification when the change is not visible afterwards", async () => {
        const { error } = await run(c.tool, { ...c.change, dry_run: false }, fakeSchemes({ usedBy: ["OPS"], ignoreWrites: true }).responder);
        assert.equal(error?.type, "VerificationError", JSON.stringify(error));
      });
    });
  }

  it("jira_create_workflow_scheme records what it created", async () => {
    const f = fakeSchemes();
    const { value, error } = await run("jira_create_workflow_scheme", { name: "Fresh scheme", dry_run: false }, f.responder);
    assert.ok(value, JSON.stringify(error));
    assert.deepEqual(value.created, { type: "workflow-scheme", name: "Fresh scheme", id: 200 });
  });

  describe("drafts", () => {
    it("creates a draft, reports an existing one as satisfied, and verifies", async () => {
      const f = fakeSchemes();
      assert.ok((await run("jira_create_workflow_scheme_draft", { scheme_id: 100, dry_run: false }, f.responder)).value);
      assert.ok(f.drafts["100"]);
      const again = await run("jira_create_workflow_scheme_draft", { scheme_id: 100, dry_run: false }, f.responder);
      assert.equal(again.value.already_satisfied, true);
      assert.deepEqual(again.writes, []);
      const ignored = await run("jira_create_workflow_scheme_draft", { scheme_id: 100, dry_run: false }, fakeSchemes({ ignoreWrites: true }).responder);
      assert.equal(ignored.error?.type, "VerificationError");
    });

    it("discards a draft, reports a missing one as satisfied, and verifies", async () => {
      const f = fakeSchemes({ withDraft: true });
      assert.ok((await run("jira_delete_workflow_scheme_draft", { scheme_id: 100, dry_run: false }, f.responder)).value);
      assert.equal(f.drafts["100"], undefined);
      const again = await run("jira_delete_workflow_scheme_draft", { scheme_id: 100, dry_run: false }, f.responder);
      assert.equal(again.value.already_satisfied, true);
      assert.deepEqual(again.writes, []);
      const ignored = await run("jira_delete_workflow_scheme_draft", { scheme_id: 100, dry_run: false }, fakeSchemes({ withDraft: true, ignoreWrites: true }).responder);
      assert.equal(ignored.error?.type, "VerificationError");
    });

    it("reads a mapping change back from the draft of an active scheme", async () => {
      const f = fakeSchemes({ active: true });
      const r = await run("jira_set_workflow_scheme_mapping", { scheme_id: 100, issue_type: "7", workflow: "Story WF", update_draft_if_needed: true, dry_run: false }, f.responder);
      assert.ok(r.value, JSON.stringify(r.error));
      assert.equal(f.drafts["100"].issueTypeMappings["7"], "Story WF");
      assert.equal(f.schemes["100"].issueTypeMappings["7"], undefined, "the published scheme is unchanged");
    });
  });

  describe("plans", () => {
    it("applies two mappings of one scheme in one plan without drift", async () => {
      const f = fakeSchemes();
      const file = join(mkdtempSync(join(tmpdir(), "ws-plan-")), "p.json");
      for (const [issue_type, workflow] of [["1", "New Bug WF"], ["Story", "Story WF"]]) {
        const args = { scheme_id: 100, issue_type, workflow };
        const dry = await run("jira_set_workflow_scheme_mapping", args, f.responder);
        assert.ok(dry.value?.identity && dry.value?.state, JSON.stringify(dry.value));
        assert.ok(!JSON.stringify(dry.value.state).includes("Bug WF\",\"5"), "state holds only the touched mapping");
        addResultToPlan(file, "jira_set_workflow_scheme_mapping", args, dry.value);
      }
      const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
      assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
      assert.equal(f.schemes["100"].issueTypeMappings["1"], "New Bug WF");
      assert.equal(f.schemes["100"].issueTypeMappings["7"], "Story WF");
    });

    it("reports a mapping that changed after planning as drifted", async () => {
      const f = fakeSchemes();
      const file = join(mkdtempSync(join(tmpdir(), "ws-plan-")), "p.json");
      const args = { scheme_id: 100, issue_type: "1", workflow: "New Bug WF" };
      addResultToPlan(file, "jira_set_workflow_scheme_mapping", args, (await run("jira_set_workflow_scheme_mapping", args, f.responder)).value);
      f.schemes["100"].issueTypeMappings["1"] = "Someone else's WF";
      const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
      assert.deepEqual(out.map((o) => o.status), ["drifted"]);
    });
  });
});

describe("workflow schemes by name, also created earlier in the plan (unify 4.3)", () => {
  it("resolves a scheme name that a project uses, with the same request as the id", async () => {
    const f = fakeSchemes({ usedBy: ["TEST"] });
    const byName = await run("jira_set_workflow_scheme_mapping", { scheme_id: "Ops scheme", issue_type: "7", workflow: "Story WF" }, f.responder);
    const byId = await run("jira_set_workflow_scheme_mapping", { scheme_id: 100, issue_type: "7", workflow: "Story WF" }, f.responder);
    assert.equal(byName.value.request.url, byId.value.request.url, JSON.stringify(byName.value ?? byName));
  });

  it("creates a scheme, then maps an issue type in it by name, without drift", async () => {
    const f = fakeSchemes();
    const file = join(mkdtempSync(join(tmpdir(), "ws-chain-")), "plan.json");
    const create = { name: "Release scheme", default_workflow: "jira" };
    addResultToPlan(file, "jira_create_workflow_scheme", create, (await run("jira_create_workflow_scheme", create, f.responder)).value);
    const map = { scheme_id: "Release scheme", issue_type: "7", workflow: "Story WF" };
    const dry = await run("jira_set_workflow_scheme_mapping", map, f.responder);
    assert.ok(dry.value?.dry_run, JSON.stringify(dry));
    assert.match(dry.value.request.url, /%3Cworkflow%20scheme%20%22Release%20scheme%22%3E|<workflow scheme "Release scheme">/);
    addResultToPlan(file, "jira_set_workflow_scheme_mapping", map, dry.value);
    const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    const created = Object.values(f.schemes).find((s: any) => s.name === "Release scheme") as any;
    assert.equal(created.issueTypeMappings["7"], "Story WF");
  });

  it("fails without sending when the scheme name is unknown at apply time", async () => {
    const f = fakeSchemes();
    const file = join(mkdtempSync(join(tmpdir(), "ws-chain-")), "plan.json");
    const map = { scheme_id: "Nowhere scheme", issue_type: "7", workflow: "Story WF" };
    addResultToPlan(file, "jira_set_workflow_scheme_mapping", map, (await run("jira_set_workflow_scheme_mapping", map, f.responder)).value);
    const { ctx, calls } = testContext(f.responder);
    const out = await applyPlan(ctx, readPlan(file), undefined, file);
    assert.equal(out[0]!.status, "failed");
    assert.match(out[0]!.detail ?? "", /No workflow scheme 'Nowhere scheme'/);
    assert.ok(!calls.some((c) => c.method !== "GET"));
  });
});

describe("mapping an issue type created earlier in the plan (unify 4.2)", () => {
  it("plans the mapping by name and applies it once the type exists", async () => {
    const f = fakeSchemes();
    const types = [{ id: "1", name: "Bug" }, { id: "5", name: "Task" }, { id: "7", name: "Story" }];
    const responder = (c: Call) => {
      const p = path(c);
      if (p === "/rest/api/2/issuetype" && c.method === "POST") {
        const t = { id: "30", name: c.body.name, subtask: false, description: "" };
        types.push(t);
        return { status: 201, body: t };
      }
      if (p === "/rest/api/2/issuetype") return { body: types };
      return f.responder(c);
    };
    const file = join(mkdtempSync(join(tmpdir(), "ws-it-")), "plan.json");
    const create = { name: "Change Request" };
    addResultToPlan(file, "jira_create_issue_type", create, (await run("jira_create_issue_type", create, responder)).value);
    const map = { scheme_id: 100, issue_type: "Change Request", workflow: "CR WF" };
    addResultToPlan(file, "jira_set_workflow_scheme_mapping", map, (await run("jira_set_workflow_scheme_mapping", map, responder)).value);
    const out = await applyPlan(testContext(responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    assert.equal(f.schemes["100"].issueTypeMappings["30"], "CR WF");
  });
});

describe("unknown scheme names and schemes created earlier in a plan (review fixes)", () => {
  it("refuses to delete an unknown scheme name instead of reporting it already gone", async () => {
    const f = fakeSchemes();
    for (const dry of [true, false]) {
      const r = await run("jira_delete_workflow_scheme", { scheme_id: "Old Scheme", dry_run: !dry ? false : undefined }, f.responder);
      assert.equal(r.r.ok, false, JSON.stringify(r.value));
      assert.match(r.error.message, /No workflow scheme 'Old Scheme'/);
      assert.equal(r.writes.length, 0);
    }
  });

  it("read tools refuse an unknown scheme name instead of reading a placeholder", async () => {
    const f = fakeSchemes();
    for (const tool of ["jira_get_workflow_scheme", "jira_compare_workflow_scheme_draft"]) {
      const { ctx, calls } = testContext(f.responder);
      const r: any = await runToolByName(tool, { scheme_id: "Typo" }, ctx);
      assert.equal(r.ok, false, `${tool}: ${JSON.stringify(r.value)}`);
      assert.match(r.error.message, /No workflow scheme 'Typo'/);
      assert.ok(!calls.some((c) => path(c).startsWith(`${BASE}/`)), tool);
    }
  });

  it("applies a mapping change to a scheme an earlier item creates with that mapping, without drift", async () => {
    const f = fakeSchemes();
    const file = join(mkdtempSync(join(tmpdir(), "ws-chain-")), "plan.json");
    const create = { name: "Release scheme", issue_type_mappings: { "7": "A WF" } };
    addResultToPlan(file, "jira_create_workflow_scheme", create, (await run("jira_create_workflow_scheme", create, f.responder)).value);
    const map = { scheme_id: "Release scheme", issue_type: "7", workflow: "B WF" };
    addResultToPlan(file, "jira_set_workflow_scheme_mapping", map, (await run("jira_set_workflow_scheme_mapping", map, f.responder)).value);
    const dflt = { scheme_id: "Release scheme", workflow: "Ops WF" };
    addResultToPlan(file, "jira_set_workflow_scheme_default", dflt, (await run("jira_set_workflow_scheme_default", dflt, f.responder)).value);
    const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done", "done"], JSON.stringify(out));
    const created = Object.values(f.schemes).find((s: any) => s.name === "Release scheme") as any;
    assert.equal(created.issueTypeMappings["7"], "B WF");
    assert.equal(created.defaultWorkflow, "Ops WF");
  });

  it("applies a mapping for an issue type created earlier in the plan and named in another case, without drift", async () => {
    const f = fakeSchemes();
    const types = [{ id: "1", name: "Bug" }, { id: "5", name: "Task" }, { id: "7", name: "Story" }];
    const responder = (c: Call) => {
      const p = path(c);
      if (p === "/rest/api/2/issuetype" && c.method === "POST") {
        const t = { id: "30", name: c.body.name, subtask: false, description: "" };
        types.push(t);
        return { status: 201, body: t };
      }
      if (p === "/rest/api/2/issuetype") return { body: types };
      return f.responder(c);
    };
    const file = join(mkdtempSync(join(tmpdir(), "ws-it-")), "plan.json");
    addResultToPlan(file, "jira_create_issue_type", { name: "Incident" }, (await run("jira_create_issue_type", { name: "Incident" }, responder)).value);
    const map = { scheme_id: 100, issue_type: "incident", workflow: "Inc WF" };
    addResultToPlan(file, "jira_set_workflow_scheme_mapping", map, (await run("jira_set_workflow_scheme_mapping", map, responder)).value);
    const out = await applyPlan(testContext(responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    assert.equal(f.schemes["100"].issueTypeMappings["30"], "Inc WF");
  });
});
