import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOLS } from "../../src/tools/index.js";

/**
 * Every read tool must bound what it returns: a `limit` (paging) or a `max_*` cap.
 * Exceptions return one entity or a short, fixed-size list; adding a tool here needs that reason.
 */
const SINGLE_OR_SMALL = new Set([
  // one entity / status
  "jira_server_info", "jira_cluster_nodes", "jira_index_summary", "jira_reindex_status", "jira_get_advanced_settings",
  "jira_application_roles", "jira_get_user", "jira_get_project_config", "jira_get_permission_scheme",
  "jira_get_notification_scheme", "jira_get_issue_security_scheme", "jira_get_workflow_scheme", "jira_get_field_contexts",
  "jira_get_screen", "jira_get_issue", "jira_get_issue_dates", "jira_get_issue_sla", "jira_get_issue_development_info",
  "jira_get_service_desk_for_project", "jira_get_request_type_fields",
  "assets_get_schema", "assets_get_object_type", "assets_validate_aql", "assets_get_object", "assets_object_references",
  "confluence_server_info", "confluence_instance_metrics", "confluence_cluster_nodes", "confluence_access_mode",
  "confluence_get_long_task", "confluence_reindex_status", "confluence_get_user", "confluence_get_space",
  "confluence_get_global_permissions", "confluence_get_page", "confluence_get_page_diff", "confluence_get_page_restrictions",
  "confluence_download_attachment", "atlassian_get_plugin", "atlassian_get_safe_mode", "atlassian_audit_settings",
  "confluence_get_space_categories", "confluence_find_spaces_by_group",
  // short fixed lists (per issue / per project / instance-wide config with tens of rows)
  "jira_list_roles", "jira_get_project_roles", "jira_list_permission_schemes", "jira_list_issue_security_schemes",
  "jira_get_transitions", "jira_get_project_issue_types", "jira_get_link_types", "jira_get_issue_links",
  "jira_get_attachments", "jira_get_issue_watchers", "assets_get_reference_types", "confluence_get_space_permissions",
]);

describe("read tools are bounded", () => {
  it("expose limit or a max_* cap unless they return one entity or a short list", () => {
    const unbounded = ALL_TOOLS.filter((t) => !t.write)
      .filter((t) => !Object.keys(t.inputShape).some((k) => k === "limit" || k.startsWith("max_")))
      .filter((t) => !SINGLE_OR_SMALL.has(t.name))
      .map((t) => t.name);
    assert.deepEqual(unbounded, []);
  });

  it("the exception list only names existing read tools", () => {
    for (const name of SINGLE_OR_SMALL) {
      const t = ALL_TOOLS.find((x) => x.name === name);
      assert.ok(t && !t.write, name);
    }
  });
});
