import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { findTool } from "../../src/tools/index.js";
import { benchResponder } from "../bench/payloads.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jira11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runToolByName(name, args, ctx);
  return { value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error, calls };
}

const many = (n: number, f: (i: number) => any) => Array.from({ length: n }, (_, i) => f(i));

describe("membership and sharing lists (optimize-read-token-usage 4.3, Jira)", () => {
  it("jira_get_workflow shows 10 of 1,200 sharing projects and a total; full_lists returns all", async () => {
    const args = { project_key: "PRJ1", issue_type: "Task", properties: false };
    const r = await run("jira_get_workflow", args, benchResponder().responder);
    assert.equal(r.value.sharing.projects.length, 10);
    assert.equal(r.value.sharing.projectsTotal, 1200);
    const full = await run("jira_get_workflow", { ...args, full_lists: true }, benchResponder().responder);
    assert.equal(full.value.sharing.projects.length, 1200);
    assert.equal(full.value.sharing.projectsTotal, undefined);
  });

  it("jira_application_roles cuts groups and default groups", async () => {
    const roles = [{ key: "jira-software", name: "Jira Software", groups: many(40, (i) => `group-${i}`), defaultGroups: many(12, (i) => `default-${i}`), numberOfSeats: 100 }];
    const r = await run("jira_application_roles", {}, () => ({ body: roles }));
    assert.equal(r.value[0].groups.length, 10);
    assert.equal(r.value[0].groupsTotal, 40);
    assert.equal(r.value[0].defaultGroupsTotal, 12);
    const full = await run("jira_application_roles", { full_lists: true }, () => ({ body: roles }));
    assert.equal(full.value[0].groups.length, 40);
  });

  it("jira_get_user cuts groups", async () => {
    const user = { name: "user1", key: "JIRAUSER1", displayName: "User 1", active: true, groups: { size: 30, items: many(30, (i) => ({ name: `g${String(i).padStart(2, "0")}` })) } };
    const r = await run("jira_get_user", { user: "user1" }, () => ({ body: user }));
    assert.equal(r.value.groups.length, 10);
    assert.equal(r.value.groupsTotal, 30);
    assert.equal((await run("jira_get_user", { user: "user1", full_lists: true }, () => ({ body: user }))).value.groups.length, 30);
  });

  it("jira_get_project_roles cuts users and groups per role", async () => {
    const responder = (c: Call) => {
      if (path(c).endsWith("/role")) return { body: { Developers: "https://jira.example.com/rest/api/2/project/PRJ1/role/10001" } };
      return { body: { id: 10001, name: "Developers", actors: [...many(25, (i) => ({ type: "atlassian-user-role-actor", name: `u${String(i).padStart(2, "0")}` })), { type: "atlassian-group-role-actor", name: "devs" }] } };
    };
    const r = await run("jira_get_project_roles", { project_key: "PRJ1" }, responder);
    assert.equal(r.value[0].users.length, 10);
    assert.equal(r.value[0].usersTotal, 25);
    assert.deepEqual(r.value[0].groups, ["devs"]);
    assert.equal((await run("jira_get_project_roles", { project_key: "PRJ1", full_lists: true }, responder)).value[0].users.length, 25);
  });

  it("field configuration sharing and field context scopes keep counts and allow full lists", async () => {
    const responder = (c: Call) => path(c).endsWith("/projects")
      ? { body: { associatedProjects: many(30, (i) => ({ key: `P${i}` })) } }
      : { body: { configName: "Default Field Configuration", fields: [], total: 0 } };
    const args = { project_key: "P1", field_configuration_id: -1 };
    const r = await run("jira_get_field_configuration", args, responder);
    assert.equal(r.value.configurations[0].sharedWith.length, 10);
    assert.equal(r.value.configurations[0].sharedWithTotal, 30);
    assert.equal((await run("jira_get_field_configuration", { ...args, full_lists: true }, responder)).value.configurations[0].sharedWith.length, 30);
    assert.equal(r.value.fieldConfigurationSchemeNote.split(/(?<=[.!?])\s+/).length, 1);
    const contexts = [{ id: 1, name: "Scoped", allProjects: false, allIssueTypes: false, projects: many(30, (i) => ({ id: i, key: `P${i}`, self: "hidden" })), issueTypes: many(20, (i) => ({ id: i, name: `T${i}`, self: "hidden" })) }];
    const bounded = await run("jira_get_field_contexts", { field: "customfield_10700" }, () => ({ body: contexts }));
    assert.equal(bounded.value[0].projects.length, 10);
    assert.equal(bounded.value[0].projectsTotal, 30);
    assert.equal(bounded.value[0].issueTypesTotal, 20);
    assert.equal(bounded.value[0].projects[0].self, undefined);
    const full = await run("jira_get_field_contexts", { field: "customfield_10700", full_lists: true }, () => ({ body: contexts }));
    assert.equal(full.value[0].projects.length, 30);
  });

  it("jira_get_field_configuration and jira_get_screen_usage accept full_lists", () => {
    for (const name of ["jira_get_field_configuration", "jira_get_screen_usage", "jira_get_custom_field_options", "jira_get_field_contexts"]) {
      assert.ok("full_lists" in findTool(name)!.inputShape, name);
    }
  });
});

describe("custom field options (optimize-read-token-usage 4.4)", () => {
  const options = many(250, (i) => ({ id: 20000 + i, value: `Option ${i}`, disabled: false }));
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/field") return { body: [{ id: "customfield_10700", name: "Severity", custom: true, schema: { custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } }] };
    if (/\/field\/customfield_10700\/contexts?$/.test(p) || /\/context$/.test(p)) return { body: fx("field-contexts-severity.json") };
    if (p === "/rest/api/2/customFields/10700/options") return { body: { options, total: options.length } };
    return undefined;
  };

  it("returns option counts per context without a context", async () => {
    const r = await run("jira_get_custom_field_options", { field: "customfield_10700" }, responder);
    assert.ok(r.value, JSON.stringify(r.error));
    assert.ok(r.value.contexts.length >= 2);
    for (const ctx of r.value.contexts) {
      assert.equal(ctx.options, undefined);
      assert.equal(ctx.optionCount, 250);
    }
  });

  it("counts and pages contexts above 1,000 options and caps scope labels", async () => {
    const wide = many(1500, (i) => ({ id: i, value: `Option ${i}` }));
    const scoped = (c: Call) => {
      if (path(c).endsWith("/context")) return { body: [{ id: 10801, name: "Wide", allProjects: false, allIssueTypes: false, projects: many(30, (i) => ({ id: i })), issueTypes: many(20, (i) => ({ id: i })) }] };
      if (path(c).endsWith("/options")) {
        const q = new URL(c.url).searchParams;
        const offset = Number(q.get("startAt"));
        const limit = Number(q.get("maxResults"));
        return { body: { options: wide.slice(offset, offset + limit), total: wide.length, startAt: offset } };
      }
      return responder(c);
    };
    const counts = await run("jira_get_custom_field_options", { field: "customfield_10700" }, scoped);
    assert.equal(counts.value.contexts[0].optionCount, 1500);
    assert.match(counts.value.contexts[0].scope, /\+20 more; total 30/);
    assert.match(counts.value.contexts[0].scope, /\+10 more; total 20/);
    const page = await run("jira_get_custom_field_options", { field: "customfield_10700", context: 10801, offset: 1100, limit: 100 }, scoped);
    assert.equal(page.value.items.length, 100);
    assert.equal(page.value.items[0].value, "Option 1100");
    assert.equal(page.value.total, 1500);
    assert.equal(page.value.nextOffset, 1200);
    const full = await run("jira_get_custom_field_options", { field: "customfield_10700", full_lists: true }, scoped);
    assert.doesNotMatch(full.value.contexts[0].scope, /more/);
  });

  it("keeps legacy option pages navigable and counts unknown without metadata", async () => {
    const legacy = (list: any[]) => (c: Call) => {
      if (path(c).endsWith("/options")) {
        const max = Number(new URL(c.url).searchParams.get("maxResults"));
        return { body: { options: list.slice(0, max) } };
      }
      return responder(c);
    };
    const first = await run("jira_get_custom_field_options", { field: "customfield_10700", context: 10801 }, legacy(options));
    assert.equal(first.value.items.length, 100);
    assert.equal(first.value.total, null);
    assert.equal(first.value.nextOffset, 100);
    const last = await run("jira_get_custom_field_options", { field: "customfield_10700", context: 10801, offset: 200 }, legacy(options));
    assert.equal(last.value.items.length, 50);
    assert.equal(last.value.total, null);
    assert.equal(last.value.nextOffset, null);
    const wide = many(1500, (i) => ({ id: i, value: `Option ${i}` }));
    const counts = await run("jira_get_custom_field_options", { field: "customfield_10700" }, legacy(wide));
    assert.equal(counts.value.contexts[0].optionCount, null);
    assert.equal(counts.value.contexts[0].optionCountLowerBound, 1000);
    assert.equal(counts.value.contexts[0].optionCountComplete, false);
    assert.match(counts.value.contexts[0].hint, /context/);
  });

  it("pages the options of one context (default 100, max 1000)", async () => {
    const r = await run("jira_get_custom_field_options", { field: "customfield_10700", context: 10801 }, responder);
    assert.equal(r.value.items.length, 100);
    assert.equal(r.value.total, 250);
    assert.equal(r.value.nextOffset, 100);
    const last = await run("jira_get_custom_field_options", { field: "customfield_10700", context: 10801, offset: 200, limit: 100 }, responder);
    assert.equal(last.value.items.length, 50);
    assert.equal(last.value.items[0].value, "Option 200");
    const limit: any = findTool("jira_get_custom_field_options")!.inputShape.limit;
    assert.equal(limit.safeParse(1001).success, false);
    assert.equal(limit.safeParse(1000).success, true);
  });
});

describe("allowlists instead of raw passthrough (optimize-read-token-usage 4.5, Jira)", () => {
  it("jira_get_field_contexts", async () => {
    const r = await run("jira_get_field_contexts", { field: "customfield_10700" }, () => ({ body: fx("field-contexts-severity.json") }));
    for (const ctx of r.value) {
      for (const k of Object.keys(ctx)) assert.ok(["id", "name", "description", "allProjects", "projects", "projectsTotal", "allIssueTypes", "issueTypes", "issueTypesTotal"].includes(k), k);
      assert.equal(ctx.self, undefined);
      assert.equal(ctx.field, undefined);
    }
  });

  it("jira_get_field_screens", async () => {
    const body = { startAt: 0, maxResults: 100, total: 1, isLast: true, values: [{ id: 1, name: "Default Screen", description: "d", self: "https://x", tab: { id: 10, name: "Field Tab", self: "https://y" }, expand: "x" }] };
    const r = await run("jira_get_field_screens", { field: "customfield_10700" }, () => ({ body }));
    assert.deepEqual(r.value.items, [{ id: 1, name: "Default Screen", tab: "Field Tab" }]);
  });

  it("jira_get_advanced_settings", async () => {
    const body = [
      { id: "jira.title", key: "jira.title", value: "Example", name: "Title", desc: "The title of this installation.", type: "string", defaultValue: "Jira", allowedValues: [] , example: "x" },
      { id: "jira.clone.prefix", key: "jira.clone.prefix", value: "CLONE -", name: "Clone prefix", desc: "", type: "string", defaultValue: "CLONE -" },
    ];
    const r = await run("jira_get_advanced_settings", {}, () => ({ body }));
    assert.deepEqual(r.value.items[0], { key: "jira.title", value: "Example", default: "Jira", type: "string", description: "The title of this installation." });
    assert.equal(r.value.items[1].default, undefined, "a default equal to the value is left out");
  });
});

describe("declared caps (optimize-read-token-usage 4.6, Jira)", () => {
  it("jira_find_groups caps limit at the value it applies", async () => {
    const limit: any = findTool("jira_find_groups")!.inputShape.limit;
    assert.equal(limit.safeParse(501).success, false);
    assert.equal(limit.safeParse(500).success, true);
  });
});

describe("short repeated notes (optimize-read-token-usage 4.7)", () => {
  it("workflow rules gap, filter favourites and field configuration notes are one sentence", async () => {
    const wf = await run("jira_get_workflow", { project_key: "PRJ1", issue_type: "Task", properties: false }, benchResponder().responder);
    const sentences = (s: string) => s.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.equal(sentences(wf.value.rules.reason), 1, wf.value.rules.reason);
    const filters = await run("jira_list_filters", {}, () => ({ body: [] }));
    assert.equal(sentences(filters.value.note), 1, filters.value.note);
  });
});
