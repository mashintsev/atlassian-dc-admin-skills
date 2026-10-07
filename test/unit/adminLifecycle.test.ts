import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runTool } from "../../src/runner.js";
import { jiraAdminLifecycleTools } from "../../src/tools/jira/adminLifecycle.js";
import { jiraSchemeTools } from "../../src/tools/jira/schemes.js";
import type { ToolDef } from "../../src/tools/types.js";
import { testContext, type Call } from "./helpers.js";

const byName = (name: string): ToolDef => [...jiraAdminLifecycleTools, ...jiraSchemeTools].find((t) => t.name === name)!;
const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/admin-ops/${name}.json`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runTool(byName(tool), args, ctx);
  return { r, calls, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error };
}

const ALL_TYPES = [{ id: "3", name: "Task" }, { id: "10004", name: "Incident" }, { id: "10005", name: "Change" }, { id: "10006", name: "Risk" }];

/** An issue type scheme that keeps PUT changes; `refuse` answers the PUT with Jira's 400. */
function fakeScheme(opts: { refuse?: boolean; ignore?: boolean } = {}) {
  const scheme = fx("issue-type-scheme");
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/issuetype") return { body: ALL_TYPES };
    if (p === "/rest/api/2/issuetypescheme/10300" && c.method === "PUT") {
      if (opts.refuse) return { status: 400, body: { errorMessages: ["Issue types still used by issues: Change"] } };
      if (!opts.ignore) {
        scheme.issueTypes = c.body.issueTypeIds.map((id: string) => ALL_TYPES.find((t) => t.id === id));
        scheme.defaultIssueType = ALL_TYPES.find((t) => t.id === c.body.defaultIssueTypeId);
      }
      return { status: 204, body: "" };
    }
    if (p === "/rest/api/2/issuetypescheme/10300") return { body: scheme };
    return undefined;
  };
  return { responder, scheme };
}

describe("jira_remove_issue_types_from_scheme (3.1)", () => {
  it("removes one issue type and reads the scheme back with the others", async () => {
    const f = fakeScheme();
    const dry = await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Change" }, f.responder);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body.issueTypeIds, ["3", "10004"]);
    assert.equal(writes(dry.calls).length, 0);
    const ex = await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Change", dry_run: false }, f.responder);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.deepEqual(f.scheme.issueTypes.map((t: any) => t.name), ["Task", "Incident"]);
  });

  it("is already-satisfied for types not in the scheme, and refuses the default type and every type", async () => {
    const f = fakeScheme();
    assert.equal((await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Risk" }, f.responder)).value?.already_satisfied, true);
    const def = await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Task" }, f.responder);
    assert.equal(def.error?.type, "ValidationError");
    assert.match(def.error.message, /default/);
    const all = await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Incident,Change,Task" }, f.responder);
    assert.equal(all.error?.type, "ValidationError");
    for (const r of [def, all]) assert.equal(writes(r.calls).length, 0);
  });

  it("passes on Jira's refusal and fails verification when the scheme does not change", async () => {
    const refused = await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Change", dry_run: false }, fakeScheme({ refuse: true }).responder);
    assert.match(refused.error?.message ?? "", /still used by issues/);
    const ignored = await run("jira_remove_issue_types_from_scheme", { scheme_id: 10300, issue_types: "Change", dry_run: false }, fakeScheme({ ignore: true }).responder);
    assert.equal(ignored.error?.type, "VerificationError");
  });

  it("applies an addition and a removal on one scheme in one plan without drift", async () => {
    const f = fakeScheme();
    const file = join(mkdtempSync(join(tmpdir(), "its-rm-")), "plan.json");
    const add = { scheme_id: 10300, issue_types: "Risk" };
    const rm = { scheme_id: 10300, issue_types: "Change" };
    addResultToPlan(file, "jira_add_issue_types_to_scheme", add, (await run("jira_add_issue_types_to_scheme", add, f.responder)).value);
    addResultToPlan(file, "jira_remove_issue_types_from_scheme", rm, (await run("jira_remove_issue_types_from_scheme", rm, f.responder)).value);
    const runner = (name: string, args: any, ctx: any) => runTool(byName(name), args, ctx);
    const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file, runner);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    assert.deepEqual(f.scheme.issueTypes.map((t: any) => t.name).sort(), ["Incident", "Risk", "Task"]);
  });
});

/** Versions of project TEST (id 10000); removeAndSwap deletes and records the move parameters. */
function fakeVersions(opts: { ignore?: boolean } = {}) {
  const versions: any[] = fx("project-versions");
  const swaps: any[] = [];
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/project/TEST/versions" || p === "/rest/api/2/project/10000/versions") return { body: versions };
    const m = /^\/rest\/api\/2\/version\/(\d+)(\/.*)?$/.exec(p);
    if (!m) return undefined;
    const v = versions.find((x) => x.id === m[1]);
    if (!v) return { status: 404, body: { errorMessages: ["no version"] } };
    if (m[2] === "/relatedIssueCounts") return { body: fx("version-related-counts") };
    if (m[2] === "/removeAndSwap" && c.method === "POST") {
      swaps.push(c.body);
      if (!opts.ignore) versions.splice(versions.indexOf(v), 1);
      return { status: 204, body: "" };
    }
    if (!m[2]) return { body: v };
    return undefined;
  };
  return { responder, versions, swaps };
}

describe("jira_delete_version (3.2)", () => {
  it("shows the issue counts and the move target, then deletes and reads back", async () => {
    const f = fakeVersions();
    const dry = await run("jira_delete_version", { version: "1.0", project_key: "TEST", move_fix_issues_to: "1.1" }, f.responder);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.issues, { fixVersion: 12, affectsVersion: 3 });
    assert.match(dry.value.moves, /fix version issues → 1\.1/);
    assert.equal(writes(dry.calls).length, 0);
    const ex = await run("jira_delete_version", { version: "10100", move_fix_issues_to: "1.1", dry_run: false }, f.responder);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.deepEqual(f.swaps, [{ moveFixIssuesTo: 10101 }]);
    assert.ok(!f.versions.some((v) => v.id === "10100"));
  });

  it("is already-satisfied for a deleted version and fails verification when it remains", async () => {
    const gone = await run("jira_delete_version", { version: "99999" }, fakeVersions().responder);
    assert.equal(gone.value?.already_satisfied, true, JSON.stringify(gone.error ?? gone.value));
    const byName = await run("jira_delete_version", { version: "0.9", project_key: "TEST" }, fakeVersions().responder);
    assert.equal(byName.value?.already_satisfied, true);
    const stays = await run("jira_delete_version", { version: "10100", dry_run: false }, fakeVersions({ ignore: true }).responder);
    assert.equal(stays.error?.type, "VerificationError");
  });

  it("refuses a move target that is the version itself or unknown", async () => {
    const self = await run("jira_delete_version", { version: "1.0", project_key: "TEST", move_fix_issues_to: "1.0" }, fakeVersions().responder);
    assert.equal(self.error?.type, "ValidationError");
    const unknown = await run("jira_delete_version", { version: "1.0", project_key: "TEST", move_affected_issues_to: "9.9" }, fakeVersions().responder);
    assert.equal(unknown.error?.type, "ValidationError");
  });
});

/** Permission schemes: scheme 0 from the fixture; POST creates with the given grants. */
function fakePermissionSchemes(opts: { dropGrant?: boolean } = {}) {
  const schemes: any[] = [fx("permission-scheme-0")];
  let next = 10100;
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/permissionscheme" && c.method === "GET") return { body: { permissionSchemes: schemes.map(({ permissions, ...s }) => s) } };
    if (p === "/rest/api/2/permissionscheme" && c.method === "POST") {
      const grants = (c.body.permissions ?? []).map((g: any, i: number) => ({ id: 20000 + i, ...g }));
      const s = { id: next++, name: c.body.name, description: c.body.description ?? "", permissions: opts.dropGrant ? grants.slice(1) : grants };
      schemes.push(s);
      return { status: 201, body: { id: s.id, name: s.name } };
    }
    const m = /^\/rest\/api\/2\/permissionscheme\/(\d+)$/.exec(p);
    if (m) {
      const s = schemes.find((x) => String(x.id) === m[1]);
      return s ? { body: s } : { status: 404, body: {} };
    }
    return undefined;
  };
  return { responder, schemes };
}

describe("jira_create_permission_scheme (3.3)", () => {
  it("copies every grant of the source, lists them in the dry run and compares them on read-back", async () => {
    const f = fakePermissionSchemes();
    const dry = await run("jira_create_permission_scheme", { name: "Ops permissions", copy_from: "0" }, f.responder);
    assert.ok(dry.r.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.body.permissions.length, 3);
    assert.equal(dry.value.grants.length, 3);
    const ex = await run("jira_create_permission_scheme", { name: "Ops permissions", copy_from: "Default Permission Scheme", dry_run: false }, f.responder);
    assert.ok(ex.r.ok, JSON.stringify(ex.error));
    assert.equal(ex.value.created.type, "permission-scheme");
    assert.equal(f.schemes.at(-1).permissions.length, 3);
  });

  it("is already-satisfied for the same name and content, and an error for other content", async () => {
    const f = fakePermissionSchemes();
    await run("jira_create_permission_scheme", { name: "Ops permissions", copy_from: "0", dry_run: false }, f.responder);
    const same = await run("jira_create_permission_scheme", { name: "Ops permissions", copy_from: "0" }, f.responder);
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    const other = await run("jira_create_permission_scheme", { name: "Ops permissions" }, f.responder);
    assert.equal(other.error?.type, "ValidationError");
  });

  it("fails verification when a copied grant is missing afterwards", async () => {
    const r = await run("jira_create_permission_scheme", { name: "Ops permissions", copy_from: "0", dry_run: false }, fakePermissionSchemes({ dropGrant: true }).responder);
    assert.equal(r.error?.type, "VerificationError");
  });
});

describe("jira_create_screen (3.3)", () => {
  const screens = (list: any[]) => (c: Call) => (path(c) === "/rest/api/2/screens" ? { body: { values: list, total: list.length, isLast: true } } : undefined);

  it("returns a manual change with the admin link and sends nothing", async () => {
    const r = await run("jira_create_screen", { name: "Ops Screen", description: "For ops" }, screens([]));
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.request.method, "MANUAL");
    assert.match(r.value.manual.editUrl, /ViewFieldScreens/);
    assert.equal(writes(r.calls).length, 0);
    const ex = await run("jira_create_screen", { name: "Ops Screen", dry_run: false }, screens([]));
    assert.equal(ex.error?.type, "Unsupported");
  });

  it("verifies on re-run: same name and description satisfied, other description an error", async () => {
    const list = [{ id: 10500, name: "Ops Screen", description: "For ops" }];
    const same = await run("jira_create_screen", { name: "Ops Screen", description: "For ops" }, screens(list));
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    const other = await run("jira_create_screen", { name: "Ops Screen", description: "Else" }, screens(list));
    assert.equal(other.error?.type, "ValidationError");
  });
});

describe("screen lookup sends startAt (live finding)", () => {
  it("jira_create_screen pages the screen list with startAt and maxResults", async () => {
    const { runTool } = await import("../../src/runner.js");
    const { jiraAdminLifecycleTools } = await import("../../src/tools/jira/adminLifecycle.js");
    const { testContext } = await import("./helpers.js");
    const tool = jiraAdminLifecycleTools.find((t) => t.name === "jira_create_screen")!;
    const { ctx, calls } = testContext((c) => {
      const q = new URL(c.url).searchParams;
      if (new URL(c.url).pathname === "/rest/api/2/screens") {
        if (!q.has("startAt")) return { status: 400, body: { errorMessages: ['"startAt" and "maxResults" parameters must be numeric'] } };
        return { body: { values: [{ id: 1, name: "Default Screen" }], total: 1, isLast: true } };
      }
      return undefined;
    });
    const r: any = await runTool(tool, { name: "Ops screen" }, ctx);
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.ok(calls.every((c) => new URL(c.url).searchParams.has("startAt")));
  });
});
