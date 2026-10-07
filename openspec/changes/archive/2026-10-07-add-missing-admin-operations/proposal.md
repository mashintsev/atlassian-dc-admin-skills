# Proposal

## Why

The CLI review found common admin tasks the tools cannot finish. Examples: assigning a workflow, issue type, screen, field configuration or notification scheme to a project; removing an issue type from a scheme; deleting a version; creating a screen or permission scheme; removing a Confluence label or space category; managing Jira filters and reading dashboards. Today the agent stops at "do it in the Jira UI" even where Jira's REST API supports the change. Where no API exists, the agent has no structured hand-off.

## What Changes

- **Project scheme assignment (Jira):**
  - New `jira_assign_project_scheme` with `project_key` and `scheme_type` (`workflow`, `issue_type`, `issue_type_screen`, `field_configuration`, `notification`) plus `scheme_id`.
  - The existing permission scheme tool is unchanged.
  - Types with a verified REST path are applied and read back.
  - Types without one, or that need an issue migration (workflow and issue type schemes when issues would change), return a manual change: the admin page link for the project, the target scheme, and a re-run that verifies.
- **Admin object lifecycle (Jira):**
  - `jira_remove_issue_types_from_scheme`: refuses to remove the default issue type or the last one. Jira's refusal for types still in use is passed on.
  - `jira_delete_version`, with optional `move_fix_issues_to` / `move_affected_issues_to`.
  - `jira_create_screen`: a manual change if no REST path exists.
  - `jira_create_permission_scheme`, optionally copying the grants of a source scheme.
- **Filters and dashboards (Jira):**
  - Filters: `jira_list_filters`, `jira_get_filter`, `jira_create_filter`, `jira_update_filter`, `jira_delete_filter`, and share permission tools (`jira_add_filter_share`, `jira_remove_filter_share`).
  - Dashboards: `jira_list_dashboards`, `jira_get_dashboard`.
  - Copying a dashboard is a manual change unless a REST path is verified.
- **Confluence:** `confluence_remove_label` for page labels, and `confluence_remove_space_category`.
- Every write follows the existing contracts: dry run by default, user confirmation, already-satisfied, identity/state for plans, read-back verification and the admin UI check plan. Internal endpoints run only behind the version gate.

## Capabilities

### New Capabilities
- `jira-project-scheme-assignment`: assigning schemes of each type to a project, with a REST path or a verified manual change.
- `jira-admin-object-lifecycle`: removing issue types from an issue type scheme, deleting versions, creating screens and permission schemes, and copying permission scheme grants.
- `jira-filters-and-dashboards`: filter CRUD with share permissions, and dashboard reads.
- `confluence-page-labels`: removing labels from pages. Labels have no spec today, and removal is the first label rule worth stating.

### Modified Capabilities
- `confluence-space-categories`: a requirement is added for removing a category; additions and reads stay as they are. This is an ADDED requirement, because the existing requirements only cover additions.

## Impact

- **Code:**
  - `src/tools/jira/` (project scheme assignment, a new `filters.ts`, version/screen/permission scheme additions in `projectMeta.ts`, `screens.ts`, `schemes.ts`);
  - `src/tools/confluence/labels.ts`, `spaceCategories.ts`;
  - tool registration.
- **Tests:** fixture-based tests under `test/unit/` with synthetic fixtures.
- **Docs:** `SKILL.md` and `REFERENCE.md`, including the typical-task rows that today end in "assign in the Jira UI".
- **Jira/Confluence:** the read-only verification in task 1 uses WADL, web-resource JavaScript and GET requests only. Live checks are dry runs only.
