/**
 * Every tool is exercised by name in at least one unit test (unify 5.1/5.2). This file covers the tools
 * that had no own test: a happy-path read on a small synthetic answer for read tools, and the dry-run
 * request (method and path) for write tools. Tools that this file or another test does not name make
 * the last check fail.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { testContext, type Call } from "./helpers.js";

type Case = { args?: Record<string, unknown>; body?: (c: Call) => unknown; write?: [method: string, path: RegExp] };

const page = (values: unknown[]) => ({ values, total: values.length, isLast: true, startAt: 0, maxResults: 50 });
const results = (r: unknown[]) => ({ results: r, size: r.length, _links: {} });

const READS: Record<string, Case> = {
  jira_cluster_nodes: { body: () => [{ nodeId: "node1", state: "ACTIVE" }] },
  jira_index_summary: { body: () => ({ nodeId: "node1", issueIndex: { indexReadable: true } }) },
  jira_reindex_status: { body: () => ({ progressUrl: "/x", currentProgress: 100, success: true }) },
  jira_get_advanced_settings: { body: () => [{ id: "jira.title", value: "Example" }] },
  jira_application_roles: { body: () => [{ key: "jira-software", name: "Jira Software", groups: ["jira-users"] }] },
  jira_get_user: { args: { user: "alice" }, body: () => ({ name: "alice", key: "alice", displayName: "Alice", active: true, groups: { size: 0, items: [] } }) },
  jira_find_groups: { args: { query: "adm" }, body: () => ({ groups: [{ name: "jira-admins" }], total: 1 }) },
  jira_list_roles: { body: () => [{ id: 10002, name: "Administrators" }] },
  jira_get_project_roles: { args: { project_key: "TEST" }, body: () => ({ Administrators: "https://jira.example.com/rest/api/2/project/TEST/role/10002" }) },
  jira_list_notification_schemes: { body: () => page([{ id: 10000, name: "Default Notification Scheme" }]) },
  jira_list_issue_security_schemes: { body: () => ({ issueSecuritySchemes: [{ id: 10000, name: "Sec" }] }) },
  jira_get_issue_security_scheme: { args: { scheme_id: 10000 }, body: () => ({ id: 10000, name: "Sec", levels: [] }) },
  jira_get_field_contexts: { args: { field: "customfield_10100" }, body: () => [{ id: 1, name: "Default" }] },
  jira_get_field_screens: { args: { field: "customfield_10100" }, body: () => page([{ id: 1, name: "Default Screen" }]) },
  jira_list_fields: { body: () => [{ id: "summary", name: "Summary", custom: false, schema: { type: "string" } }] },
  jira_get_screen: {
    args: { screen_id: 1 },
    body: (c) => (new URL(c.url).pathname.endsWith("/tabs") ? [{ id: 10, name: "Field Tab" }] : new URL(c.url).pathname.endsWith("/fields") ? [{ id: "summary", name: "Summary" }] : [{ id: 1, name: "Default Screen" }]),
  },
  jira_get_project_issues: { args: { project_key: "TEST" }, body: () => ({ issues: [{ key: "TEST-1", fields: { summary: "S" } }], total: 1, startAt: 0, maxResults: 20 }) },
  jira_get_transitions: { args: { issue_key: "TEST-1" }, body: () => ({ transitions: [{ id: "11", name: "Start", to: { name: "In Progress" } }] }) },
  jira_get_project_components: { args: { project_key: "TEST" }, body: () => [{ id: "1", name: "Backend" }] },
  jira_get_link_types: { body: () => ({ issueLinkTypes: [{ id: "1", name: "Blocks", inward: "is blocked by", outward: "blocks" }] }) },
  jira_get_issue_images: { args: { issue_key: "TEST-1", output_dir: "<tmp>" }, body: () => ({ key: "TEST-1", fields: { attachment: [] } }) },
  jira_get_issue_watchers: { args: { issue_key: "TEST-1" }, body: () => ({ watchCount: 1, watchers: [{ name: "alice" }] }) },
  jira_get_issues_development_info: { args: { issue_keys: "TEST-1" }, body: () => ({ key: "TEST-1", id: "10001", summary: {}, detail: [] }) },
  jira_get_request_type_fields: { args: { service_desk: "3", request_type_id: "10" }, body: () => ({ requestTypeFields: [{ fieldId: "summary", name: "Summary", required: true }] }) },
  assets_get_reference_types: { args: { schema_id: 1 }, body: () => [{ id: 1, name: "Depends on" }] },
  assets_get_object_type: { args: { object_type_id: 1 }, body: (c) => (new URL(c.url).pathname.endsWith("/attributes") ? [{ id: 5, name: "Name" }] : { id: 1, name: "Server", objectSchemaId: 1 }) },
  assets_validate_aql: { args: { aql: "objectType = Server" }, body: () => ({ values: [], total: 0, totalFilterCount: 0 }) },
  assets_object_references: { args: { object: 1 }, body: () => [] },
  confluence_server_info: { body: () => ({ version: "9.2.0", buildNumber: "9100" }) },
  confluence_instance_metrics: { body: () => ({ pages: 1, spaces: 1 }) },
  confluence_cluster_nodes: { body: () => [] },
  confluence_access_mode: { body: () => "READ_WRITE" },
  confluence_list_long_tasks: { body: () => results([{ id: "t1", name: { key: "task" }, percentageComplete: 100 }]) },
  confluence_get_long_task: { args: { task_id: "t1" }, body: () => ({ id: "t1", percentageComplete: 100, successful: true }) },
  confluence_reindex_status: { body: () => ({ status: "UNAVAILABLE" }) },
  confluence_find_users: { args: { query: "ali" }, body: () => results([{ user: { username: "alice", userKey: "k1", displayName: "Alice" } }]) },
  confluence_get_user: { args: { user: "alice" }, body: () => ({ username: "alice", userKey: "k1", displayName: "Alice", results: [], _links: {} }) },
  confluence_list_groups: { body: () => results([{ name: "confluence-users" }]) },
  confluence_get_group_members: { args: { group: "confluence-users" }, body: () => results([{ username: "alice", userKey: "k1" }]) },
  confluence_get_space_permissions: { args: { space_key: "DOC" }, body: () => [] },
  confluence_get_global_permissions: { args: { subject_type: "anonymous" }, body: () => [] },
  confluence_get_space_categories: { args: { space_key: "DOC" }, body: () => ({ key: "DOC", metadata: { labels: { results: [], _links: {} } } }) },
  confluence_find_spaces_by_group: { args: { group: "confluence-users" }, body: () => results([]) },
  confluence_get_page_children: { args: { page: "123" }, body: () => results([{ id: "124", title: "Child" }]) },
  confluence_get_page_diff: {
    args: { page: "123", from_version: 1, to_version: 2 },
    body: (c) => ({ id: "123", title: "Page", version: { number: Number(new URL(c.url).searchParams.get("version") ?? 2) }, body: { storage: { value: "<p>text</p>" } } }),
  },
  atlassian_list_plugins: { args: { product: "jira" }, body: () => ({ plugins: [{ key: "com.example.app", name: "App", enabled: true, userInstalled: true, version: "1.0" }] }) },
  atlassian_get_plugin: { args: { product: "jira", plugin_key: "com.example.app" }, body: () => ({ key: "com.example.app", name: "App", enabled: true, version: "1.0" }) },
  atlassian_get_safe_mode: { args: { product: "jira" }, body: () => ({ enabled: false }) },
  atlassian_audit_settings: { args: { product: "jira" }, body: () => ({ retention: { period: "P3Y" } }) },
};

const WRITES: Record<string, Case> = {
  jira_delete_custom_fields: { args: { ids: "customfield_10100" }, body: () => [{ id: "customfield_10100", name: "Old", custom: true }], write: ["DELETE", /\/rest\/api\/2\/customFields/] },
  jira_batch_create_issues: { args: { issues: [{ project_key: "TEST", summary: "S", issue_type: "Task" }] }, body: () => [], write: ["POST", /\/rest\/api\/2\/issue\/bulk/] },
  jira_add_comment: { args: { issue_key: "TEST-1", body: "Hello" }, write: ["POST", /\/rest\/api\/2\/issue\/TEST-1\/comment$/] },
  jira_edit_comment: { args: { issue_key: "TEST-1", comment_id: "5", body: "Edited" }, write: ["PUT", /\/rest\/api\/2\/issue\/TEST-1\/comment\/5$/] },
  jira_delete_attachment: { args: { attachment_id: "77" }, write: ["DELETE", /\/rest\/api\/2\/attachment\/77$/] },
  confluence_add_comment: { args: { page_id: "123", body: "Hello" }, write: ["POST", /\/rest\/api\/content$/] },
  confluence_delete_attachment: { args: { attachment_id: "att9" }, write: ["DELETE", /\/rest\/api\/content\/att9$/] },
  atlassian_set_plugin_enabled: { args: { product: "jira", plugin_key: "com.example.app", enabled: false }, write: ["PUT", /\/rest\/plugins\/1\.0\/com\.example\.app-key$/] },
};

const fill = (args: Record<string, unknown> = {}) =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, v === "<tmp>" ? mkdtempSync(join(tmpdir(), "cov-")) : v]));

describe("read tools without an own test", () => {
  for (const [tool, c] of Object.entries(READS)) {
    it(`${tool} reads and renders a result`, async () => {
      const { ctx, calls } = testContext((call) => ({ body: c.body?.(call) ?? {} }));
      const r: any = await runToolByName(tool, fill(c.args), ctx);
      assert.ok(r.ok, `${tool}: ${JSON.stringify(r.error)}`);
      // AQL searches are POSTs that only read
      const reads = tool === "assets_validate_aql" ? ["GET", "POST"] : ["GET"];
      assert.ok(calls.length > 0 && calls.every((x) => reads.includes(x.method)), `${tool} sent ${calls.map((x) => x.method)}`);
    });
  }
});

describe("write tools without an own test: dry-run request shape", () => {
  for (const [tool, c] of Object.entries(WRITES)) {
    it(`${tool} describes ${c.write![0]} ${c.write![1]}`, async () => {
      const { ctx, calls } = testContext((call) => ({ body: c.body?.(call) ?? {} }));
      const r: any = await runToolByName(tool, fill(c.args), ctx);
      assert.ok(r.ok, `${tool}: ${JSON.stringify(r.error)}`);
      assert.equal(r.value.dry_run, true);
      assert.equal(r.value.request.method, c.write![0]);
      assert.match(new URL(r.value.request.url).pathname, c.write![1]);
      assert.ok(calls.every((x) => x.method === "GET"), "a dry run sends no write");
    });
  }
});

describe("tool coverage", () => {
  it("every registered tool is named by at least one unit test", () => {
    const dir = new URL("./", import.meta.url);
    const text = readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && f !== "tools.test.ts" && f !== "readBounds.test.ts")
      .map((f) => readFileSync(new URL(f, dir), "utf8"))
      .join("\n");
    const missing = ALL_TOOLS.filter((t) => !text.includes(`"${t.name}"`) && !(t.name in READS) && !(t.name in WRITES)).map((t) => t.name);
    assert.deepEqual(missing, []);
  });
});
