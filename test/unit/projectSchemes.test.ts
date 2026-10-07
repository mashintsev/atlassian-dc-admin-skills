import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraProjectSchemeTools } from "../../src/tools/jira/projectSchemes.js";
import { testContext, type Call } from "./helpers.js";

const tool = jiraProjectSchemeTools.find((t) => t.name === "jira_assign_project_scheme")!;
const fx = (dir: string, name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${dir}/${name}.json`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

/** A Jira with project TEST (id 10000) whose schemes can be changed; `ignore` drops writes, `foreign` counts issues of other types. */
function fakeJira(opts: { ignore?: boolean; foreign?: number } = {}) {
  const state = { notification: 10000 as number | null, issueTypeSchemeProjects: { "10300": [] as string[], "10301": ["TEST"] } as Record<string, string[]> };
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    if (p === "/rest/api/2/project/TEST" && c.method === "GET") return { body: { id: "10000", key: "TEST", issueTypes: [{ id: "3", name: "Task" }, { id: "10004", name: "Incident" }] } };
    if (p === "/rest/api/2/project/TEST" && c.method === "PUT") {
      if (!opts.ignore && c.body?.notificationScheme !== undefined) state.notification = Number(c.body.notificationScheme);
      return { body: { key: "TEST" } };
    }
    if (p === "/rest/api/2/project/TEST/notificationscheme") return state.notification === null ? { status: 404, body: {} } : { body: { id: state.notification, name: `Notifications ${state.notification}` } };
    if (/^\/rest\/api\/2\/notificationscheme\/\d+$/.test(p)) return { body: { id: Number(p.split("/").pop()), name: `Notifications ${p.split("/").pop()}` } };
    if (p === "/rest/api/2/project/TEST/workflowscheme") return { body: { id: 200, name: "TEST workflows" } };
    if (/^\/rest\/api\/2\/workflowscheme\/\d+$/.test(p)) return { body: { id: Number(p.split("/").pop()), name: `Workflow scheme ${p.split("/").pop()}` } };
    if (/^\/rest\/api\/2\/issuetypescheme\/\d+$/.test(p)) {
      const id = p.split("/").pop()!;
      return { body: { ...fx("admin-ops", "issue-type-scheme"), id, name: `Scheme ${id}` } };
    }
    const assoc = /^\/rest\/api\/2\/issuetypescheme\/(\d+)\/associations$/.exec(p);
    if (assoc && c.method === "GET") return { body: (state.issueTypeSchemeProjects[assoc[1]!] ?? []).map((key) => ({ key, id: "10000" })) };
    if (assoc && c.method === "POST") {
      if (!opts.ignore) {
        for (const ids of Object.values(state.issueTypeSchemeProjects)) ids.splice(0, ids.length, ...ids.filter((k) => k !== "TEST"));
        (state.issueTypeSchemeProjects[assoc[1]!] ??= []).push(...c.body.idsOrKeys);
      }
      return { status: 204, body: "" };
    }
    if (p === "/rest/api/2/search") return { body: { total: opts.foreign ?? 0, issues: [], jql: q.get("jql") } };
    if (p === "/rest/api/2/customFields") return { body: { values: [{ id: "customfield_10101", name: "Probe" }], total: 1 } };
    if (p.startsWith("/rest/whereismycf/1.0/fields/")) return { body: fx("jira11", "whereismycf-red") };
    if (/^\/rest\/api\/2\/issuetypescreenscheme\/\d+$/.test(p)) return { status: 404, body: {} };
    return undefined;
  };
  return { responder, state };
}

async function run(args: Record<string, unknown>, j = fakeJira()) {
  const { ctx, calls } = testContext(j.responder);
  const r: any = await runTool(tool, args, ctx);
  return { r, calls, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error };
}

describe("jira_assign_project_scheme (2.1)", () => {
  it("assigns a notification scheme through REST and reads it back", async () => {
    const j = fakeJira();
    const dry = await run({ project_key: "TEST", scheme_type: "notification", scheme_id: 10100 }, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "PUT");
    assert.deepEqual(dry.value.request.body, { notificationScheme: 10100 });
    assert.deepEqual(dry.value.before, { id: 10000, name: "Notifications 10000" });
    assert.equal(writes(dry.calls).length, 0);
    const ex = await run({ project_key: "TEST", scheme_type: "notification", scheme_id: 10100, dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.equal(j.state.notification, 10100);
    assert.equal(writes(ex.calls).length, 1);
  });

  it("reports an assignment already in effect as already-satisfied, sending nothing", async () => {
    const r = await run({ project_key: "TEST", scheme_type: "notification", scheme_id: 10000, dry_run: false });
    assert.equal(r.value?.already_satisfied, true, JSON.stringify(r.error ?? r.value));
    assert.equal(writes(r.calls).length, 0);
    const w = await run({ project_key: "TEST", scheme_type: "workflow", scheme_id: 200 });
    assert.equal(w.value?.already_satisfied, true, "a manual assignment made in the UI verifies on re-run");
  });

  it("fails verification when the notification scheme does not read back", async () => {
    const r = await run({ project_key: "TEST", scheme_type: "notification", scheme_id: 10100, dry_run: false }, fakeJira({ ignore: true }));
    assert.equal(r.error?.type, "VerificationError");
  });

  it("assigns an issue type scheme through its associations when no migration is needed", async () => {
    const j = fakeJira();
    const dry = await run({ project_key: "TEST", scheme_type: "issue_type", scheme_id: 10300 }, j);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.method, "POST");
    assert.match(new URL(dry.value.request.url).pathname, /\/issuetypescheme\/10300\/associations$/);
    assert.deepEqual(dry.value.request.body, { idsOrKeys: ["TEST"] });
    const ex = await run({ project_key: "TEST", scheme_type: "issue_type", scheme_id: 10300, dry_run: false }, j);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.deepEqual(j.state.issueTypeSchemeProjects["10300"], ["TEST"]);
    assert.equal((await run({ project_key: "TEST", scheme_type: "issue_type", scheme_id: 10300 }, j)).value.already_satisfied, true);
  });

  it("returns a manual change when the issue type scheme would need a migration", async () => {
    const r = await run({ project_key: "TEST", scheme_type: "issue_type", scheme_id: 10300 }, fakeJira({ foreign: 4 }));
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.manual.reason, /4 issues/);
    assert.match(r.value.manual.editUrl, /SelectIssueTypeSchemeForProject/);
    assert.equal(writes(r.calls).length, 0);
    const ex = await run({ project_key: "TEST", scheme_type: "issue_type", scheme_id: 10300, dry_run: false }, fakeJira({ foreign: 4 }));
    assert.equal(ex.error?.type, "Unsupported");
    assert.equal(writes(ex.calls).length, 0);
  });

  it("returns manual changes for workflow, issue type screen and field configuration schemes", async () => {
    for (const [type, page] of [["workflow", /SelectProjectWorkflowScheme/], ["issue_type_screen", /SelectIssueTypeScreenScheme/], ["field_configuration", /SelectFieldLayoutScheme/]] as const) {
      const r = await run({ project_key: "TEST", scheme_type: type, scheme_id: 20500 });
      assert.ok(r.r.ok, `${type}: ${JSON.stringify(r.error)}`);
      assert.equal(r.value.request.method, "MANUAL", type);
      assert.match(r.value.manual.editUrl, page);
      assert.match(r.value.manual.editUrl, /projectId=10000/);
      assert.equal(writes(r.calls).length, 0, type);
    }
  });

  it("verifies an issue type screen scheme assignment on re-run through Where is my field", async () => {
    // the fixture places the project's issue types in issue type screen scheme 10503
    const r = await run({ project_key: "TEST", scheme_type: "issue_type_screen", scheme_id: 10503 });
    assert.equal(r.value?.already_satisfied, true, JSON.stringify(r.error ?? r.value));
  });
});
