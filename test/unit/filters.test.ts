import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraFilterTools } from "../../src/tools/jira/filters.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/filters/${name}.json`, import.meta.url), "utf8"));
const tool = (name: string) => jiraFilterTools.find((t) => t.name === name)!;
const path = (c: Call) => new URL(c.url).pathname;
const F = "/rest/api/2/filter";

/** Stateful fake: one filter, favourites, shares, a group and a project, JQL validation. */
function fakeJira(opts: { ignoreWrites?: boolean } = {}) {
  const filters: Record<string, any> = { "10200": fx("filter") };
  let nextId = 10300;
  let nextShare = 600;
  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    const write = c.method !== "GET" && !opts.ignoreWrites;
    if (p === "/rest/api/2/search") {
      return /=\s*$/.test(q.get("jql") ?? "") ? { status: 400, body: { errorMessages: ["Error in the JQL Query: Expecting a value"], errors: {} } } : { body: { total: 0, issues: [] } };
    }
    if (p === "/rest/api/2/project/TEST") return { body: { id: "10100", key: "TEST", name: "Test" } };
    if (p === "/rest/api/2/group/member") return { body: { values: [], isLast: true } };
    if (p === `${F}/favourite`) return { body: Object.values(filters).filter((f) => f.favourite) };
    if (p === F && c.method === "POST") {
      const id = String(nextId++);
      const f = { ...c.body, id, owner: { name: "alice" }, viewUrl: `https://jira.example.com/issues/?filter=${id}`, sharePermissions: [] };
      if (write) filters[id] = f;
      return { body: f };
    }
    const m = /^\/rest\/api\/2\/filter\/(\d+)(\/permission(?:\/(\d+))?)?$/.exec(p);
    if (!m) return undefined;
    const f = filters[m[1]!];
    if (!f) return { status: 404, body: { errorMessages: ["The selected filter is not available to you"] } };
    if (!m[2]) {
      if (c.method === "GET") return { body: f };
      if (c.method === "PUT") { if (write) Object.assign(f, c.body); return { body: f }; }
      if (c.method === "DELETE") { if (write) delete filters[m[1]!]; return { status: 204, body: "" }; }
    }
    if (c.method === "GET") return { body: f.sharePermissions };
    if (c.method === "POST") {
      const b = c.body;
      const share = { id: nextShare++, type: b.type, ...(b.groupname ? { group: { name: b.groupname } } : {}), ...(b.projectId ? { project: { id: b.projectId, key: "TEST" } } : {}), ...(b.projectRoleId ? { role: { id: Number(b.projectRoleId) } } : {}), view: true, edit: false };
      if (write) f.sharePermissions.push(share);
      return { status: 201, body: f.sharePermissions };
    }
    if (c.method === "DELETE") { if (write) f.sharePermissions = f.sharePermissions.filter((s: any) => String(s.id) !== m[3]); return { status: 204, body: "" }; }
    return undefined;
  };
  return { responder, filters };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runTool(tool(name), args, ctx);
  return { r, value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error, calls };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("filter reads (add-missing 4.1)", () => {
  it("lists the caller's favourites and says that is the source", async () => {
    const { value } = await run("jira_list_filters", {}, fakeJira().responder);
    assert.equal(value.source, "favourites");
    assert.match(value.note, /Only favourite/);
    assert.deepEqual(value.items.map((f: any) => f.name), ["Open incidents"]);
  });

  it("reads a filter with JQL, owner and shares, and reports a filter it cannot see as not found", async () => {
    const { value } = await run("jira_get_filter", { filter: "10200" }, fakeJira().responder);
    assert.equal(value.jql, "project = TEST AND status = Open");
    assert.equal(value.owner, "alice");
    assert.deepEqual(value.shares, [{ id: 501, type: "project", project: "TEST", view: true, edit: false }]);
    const missing = await run("jira_get_filter", { filter: "999" }, fakeJira().responder);
    assert.equal(missing.error.status, 404);
  });

  it("lists dashboards with paging", async () => {
    const { value } = await run("jira_list_dashboards", { limit: 2 }, () => ({ body: fx("dashboards") }));
    assert.deepEqual(value.items.map((d: any) => d.name), ["System Dashboard", "Ops board"]);
    assert.equal(value.total, 3);
    assert.equal(value.nextOffset, 2);
    const one = await run("jira_get_dashboard", { dashboard: "10100" }, () => ({ body: fx("dashboards").dashboards[1] }));
    assert.equal(one.value.name, "Ops board");
  });
});

describe("filter changes and shares (add-missing 4.2)", () => {
  it("refuses invalid JQL with Jira's message and plans nothing", async () => {
    const r = await run("jira_create_filter", { name: "Bad", jql: "project = " }, fakeJira().responder);
    assert.equal(r.error.type, "ValidationError");
    assert.match(r.error.message, /Expecting a value/);
    assert.equal(writes(r.calls).length, 0);
  });

  it("creates a filter and reads it back; the same name and JQL is already satisfied", async () => {
    const j = fakeJira();
    const dry = await run("jira_create_filter", { name: "Mine", jql: "assignee = currentUser()" }, j.responder);
    assert.equal(dry.value.request.method, "POST");
    assert.equal(writes(dry.calls).length, 0);
    const r = await run("jira_create_filter", { name: "Mine", jql: "assignee = currentUser()", favourite: true, dry_run: false }, j.responder);
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.name, "Mine");
    const again = await run("jira_create_filter", { name: "Mine", jql: "assignee = currentUser()" }, j.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("updates the JQL, with already-satisfied and a read-back check", async () => {
    const j = fakeJira();
    const same = await run("jira_update_filter", { filter: "10200", jql: "project = TEST AND status = Open" }, j.responder);
    assert.equal(same.value.already_satisfied, true);
    const r = await run("jira_update_filter", { filter: "10200", jql: "project = TEST", dry_run: false }, j.responder);
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(j.filters["10200"].jql, "project = TEST");
    const lost = await run("jira_update_filter", { filter: "10200", jql: "project = OPS", dry_run: false }, fakeJira({ ignoreWrites: true }).responder);
    assert.equal(lost.error.type, "VerificationError");
  });

  it("shares with a group, then reports the same share as already satisfied", async () => {
    const j = fakeJira();
    const r = await run("jira_add_filter_share", { filter: "10200", share_type: "group", group: "ops", dry_run: false }, j.responder);
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.deepEqual(writes(r.calls)[0]!.body, { type: "group", groupname: "ops" });
    assert.ok(j.filters["10200"].sharePermissions.some((s: any) => s.group?.name === "ops"));
    const again = await run("jira_add_filter_share", { filter: "10200", share_type: "group", group: "ops" }, j.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("removes a share by its kind; an absent share is already satisfied", async () => {
    const j = fakeJira();
    const r = await run("jira_remove_filter_share", { filter: "10200", share_type: "project", project_key: "TEST", dry_run: false }, j.responder);
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(j.filters["10200"].sharePermissions.length, 0);
    const again = await run("jira_remove_filter_share", { filter: "10200", share_type: "project", project_key: "TEST" }, j.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("deletes a filter: the dry run says irreversible, favourite count where reported; gone is satisfied", async () => {
    const j = fakeJira();
    const dry = await run("jira_delete_filter", { filter: "10200" }, j.responder);
    assert.match(dry.value.warning, /irreversible/i);
    assert.ok("favourites" in dry.value);
    const r = await run("jira_delete_filter", { filter: "10200", dry_run: false }, j.responder);
    assert.ok(r.r.ok, JSON.stringify(r.error));
    assert.equal(j.filters["10200"], undefined);
    const again = await run("jira_delete_filter", { filter: "10200" }, j.responder);
    assert.equal(again.value.already_satisfied, true);
  });
});
