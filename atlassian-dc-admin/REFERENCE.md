# Atlassian DC Admin — reference

## Configuration

Sources, highest priority first: the environment → `$ATLASSIAN_ENV_FILE` → the project's
`.atlassian-dc-admin.env` (nearest one from the working directory upwards) → `./.env` →
`<skill dir>/.env` → `~/.config/atlassian-dc-admin/.env` (machine-wide default).

Each project can point at its own Jira / Confluence: run `init [--jira-url=…] [--confluence-url=…]` in the
project to create `.atlassian-dc-admin.env` in its git root (mode 600, added to `.gitignore`), then fill in
the tokens. All `JIRA_*` (and `ASSETS_API_BASE`) settings come from the first source that sets `JIRA_URL`,
all `CONFLUENCE_*` from the first that sets `CONFLUENCE_URL` — never mixed, so a token is never sent to a URL
from another file. `check` shows which file configures each product and warns when it is not git-ignored.
Never print or echo tokens.

| Variable | Meaning |
|---|---|
| `JIRA_URL`, `CONFLUENCE_URL` | Base URL, e.g. `https://jira.example.com` |
| `JIRA_PAT_TOKEN`, `CONFLUENCE_PAT_TOKEN` | Personal access token of an administrator (preferred) |
| `<P>_USERNAME` + `<P>_PASSWORD` | Basic auth instead of a PAT |
| `<P>_SSL_VERIFY` | `true` by default; `false` only for self-signed test instances |
| `<P>_CA_FILE` | PEM file with extra trusted root certificates (a company CA in the TLS chain); verification stays on — prefer it over `SSL_VERIFY=false` |
| `<P>_TIMEOUT` | Seconds, default 60 |
| `<P>_PROXY_USER`/`<P>_PROXY_PASS` (or `<P>_PROXY_BASIC`), `<P>_TOKEN_HEADER` | Reverse-proxy gateway mode: the proxy takes `Authorization`, the PAT goes in `X-Atlassian-Pat` |
| `ATLASSIAN_MAX_RESPONSE_CHARS` | Max printed output, default 60000 (`0` disables) |

## CLI

```bash
node scripts/atlassian-admin.mjs list [jira|confluence|<text>] [--writes|--reads] [--long]
node scripts/atlassian-admin.mjs describe <tool>
node scripts/atlassian-admin.mjs check [--ping]
node scripts/atlassian-admin.mjs <tool> [key=value ...] ['{"json": "args"}'] [--format=compact|json|full] [--fields=a,b|-c] [--out=FILE]
```

Options starting with `--` are global; everything else is a tool argument (values are parsed as JSON
when possible). Compact output:

```text
total:3 offset:0 returned:3 last
# id | key | name | type | lead | category
10100 | FDP | Finance | business | ivan | Finance
...
DRY-RUN | Deactivate user ivan
PUT https://jira.example.com/rest/api/2/user?username=ivan
body: {"active":false}
OK | Add ivan to jira-admins
ERROR HTTP403 403 | GET https://… failed with HTTP 403: … 
hint: the account lacks administrator rights for this action
```

Compact and json output drop fields an agent does not use (`self`, avatar URLs, `expand`, `_links`,
empty values), flatten `{name: …}` wrappers of nested fields and shorten timestamps to minutes.
`--format=full` returns the tool result untouched.

## Typical tasks

| Question | Tools |
|---|---|
| Who can do X in project P? | `jira_get_project_config` → `jira_get_permission_scheme scheme_id=… permission=X` → `jira_get_project_roles` / `jira_get_group_members` |
| Offboard a user | `jira_get_user` → `jira_set_user_active active=false` (+ `jira_kill_user_sessions`); `confluence_set_user_enabled enabled=false` |
| New issue type in a project's workflow | `jira_list_issue_types` → `jira_create_issue_type` → `jira_get_project_config` (issue type and workflow scheme ids) → `jira_add_issue_types_to_scheme` → `jira_list_workflows name=…` → `jira_set_workflow_scheme_mapping` |
| Change a project's workflow scheme | `jira_get_project_config` → `jira_get_workflow_scheme` → `jira_set_workflow_scheme_mapping` / `jira_delete_workflow_scheme_mapping` / `jira_set_workflow_scheme_default` |
| Workflow schemes in use / where a workflow is used | `jira_list_workflow_schemes --out=…`; `jira_find_workflow_usage workflow=…` (delegate on large instances) |
| Swap a workflow in a scheme | `jira_find_workflow_usage` → `jira_replace_workflow_in_scheme` (active scheme: `update_draft_if_needed=true` → `jira_compare_workflow_scheme_draft` → publish in the UI) |
| New workflow scheme for a project | `jira_create_workflow_scheme copy_from_scheme_id=…` → mappings → assign to the project in the Jira UI |
| Where is a screen used | `jira_get_screen_usage screen_id=…` (scan; `--out` or a subagent on large instances) |
| Remove or add fields on a screen | `jira_get_screen` → `jira_get_screen_usage` → `jira_remove_screen_field` / `jira_add_screen_field` / `jira_move_screen_field` (one plan item each) |
| New custom field for a project | `jira_create_custom_field` → `jira_update_field_context context_id=default project_ids=…` → `jira_add_field_to_screens` — all with `--plan`, the field by name, then `apply` |
| New JSM request type on the portal | `jira_create_request_type` → `jira_add_request_type_to_group` → `jira_add_request_type_field` / `jira_hide_request_type_field preset=…` (one plan; the request type by name) → `jira_get_request_type_form` |
| JSM SLA with a 24×7 calendar | `jira_get_sla_conditions` → (`jira_create_sla_calendar working_hours=24x7` or use `calendar=24x7`, the built-in default) → `jira_create_sla goals=[…]` → `jira_get_sla_configuration` |
| JSM queues | `jira_get_service_desk_queues` → `jira_create_queue` / `jira_update_queue` / `jira_delete_queue` / `jira_move_queue` (full order of ids, read back) |
| Select options (e.g. Severity 1–4) | `jira_create_custom_field field_type=…:select` → `jira_set_custom_field_options field=… options=1,2,3,4` (one plan; the field by name) → `jira_get_custom_field_options` |
| Field descriptions in a project | `jira_get_field_configuration project_key=… issue_type_id=…` → `jira_update_field_description` (dry run; entered in the UI via the edit link, re-run verifies) |
| Board Detail View | `jira_get_board_configuration` → `jira_set_board_detail_fields remove_fields=… add_fields=…` |
| JC-83-style rollout | field descriptions (manual) → screen removals per tab → custom fields + contexts + placements → board Detail View; plan everything, `apply`, then `plan FILE` for what remains |
| License seats | `jira_application_roles`, `jira_set_user_application` |
| Unused custom fields | `jira_list_custom_fields unused_only=true --out=…` → `jira_get_field_screens` / `jira_get_field_contexts` |
| Space access review | `confluence_list_spaces --out=…` → `confluence_get_space_permissions` per space (delegate to a subagent) |
| What changed and who did it | `atlassian_audit_events product=jira from=… search=…` |
| App inventory / licenses | `atlassian_list_plugins product=confluence with_licenses=true` |
| Index or cluster problems | `jira_index_summary`, `jira_cluster_nodes`, `jira_reindex_status`; `confluence_cluster_nodes` |

## Tools

<!-- tools:start -->
265 tools, 137 of them write tools (✎). Write tools also take `dry_run` (default true).

### Jira admin — system

| Tool | Arguments | Description |
|---|---|---|
| `jira_server_info` | — | Jira version, build number, base URL, deployment type and server time. |
| `jira_cluster_nodes` | — | Data Center cluster nodes: node id, state (ACTIVE/OFFLINE), alive flag, IP, cache port, version. |
| `jira_index_summary` | — | Index health: issue counts in database vs index, last indexed time, per-node replication queues. |
| `jira_reindex_status` | `task_id?`: integer | Current (or given) reindex task: progress percent, type, submitted/started/finished time. |
| `jira_start_reindex` ✎ | `type?`: FOREGROUND\|BACKGROUND\|BACKGROUND_PREFERRED, `index_comments?`: boolean, `index_change_history?`: boolean, `index_worklogs?`: boolean | Start a full reindex. FOREGROUND locks Jira for all users; BACKGROUND_PREFERRED (default) keeps it usable. Follow progress with jira_reindex_status. |
| `jira_get_application_properties` | `key?`: string, `key_contains?`: string, `offset?`: integer, `limit?`: integer | Application properties (General configuration): one by exact key, or a list filtered by key fragment. |
| `jira_get_advanced_settings` | — | The 'Advanced settings' admin page: key, current value, default, type and description. |
| `jira_set_application_property` ✎ | `id`: string, `value`: string | Change one application / advanced setting property by key. |
| `jira_application_roles` | — | Applications (Software, Service Management, Core): groups, default groups, licensed seats used/available. |

### Jira admin — users and groups

| Tool | Arguments | Description |
|---|---|---|
| `jira_find_users` | `query`: string, `include_inactive?`: boolean, `offset?`: integer, `limit?`: integer | Find users by username, display name or e-mail fragment ('.' matches everyone). |
| `jira_get_user` | `user`: string, `include_deleted?`: boolean | One user with groups and application access (licenses). Works for deactivated users too. |
| `jira_create_user` ✎ | `username`: string, `email`: string, `display_name`: string, `password?`: string, `notify?`: boolean, `application_keys?`: list\|string | Create a user in the internal directory. Without password and with notify=true Jira e-mails a set-password link. |
| `jira_update_user` ✎ | `user`: string, `email?`: string, `display_name?`: string, `new_username?`: string | Change e-mail, display name or username (rename) of a user in a writable directory. |
| `jira_set_user_active` ✎ | `user`: string, `active`: boolean | Activate or deactivate a user. Deactivation frees the license seat and keeps history; prefer it over delete. |
| `jira_delete_user` ✎ | `user`: string | Delete a user. Jira refuses if the user has issues, comments or other history; deactivate instead. |
| `jira_set_user_application` ✎ | `username`: string, `application_key`: string, `grant?`: boolean | Grant or revoke application access (license seat), e.g. application_key=jira-servicedesk. |
| `jira_kill_user_sessions` ✎ | `username`: string | Invalidate all web sessions of a user (forced logout). |
| `jira_find_groups` | `query?`: string, `limit?`: integer | Groups whose name contains the query (empty query lists the first `limit` groups). |
| `jira_get_group_members` | `group`: string, `include_inactive?`: boolean, `offset?`: integer, `limit?`: integer | Members of a group (server-side paging). |
| `jira_create_group` ✎ | `name`: string | Create a group in the internal directory. |
| `jira_delete_group` ✎ | `name`: string, `swap_group?`: string | Delete a group. swap_group moves comment/worklog visibility restrictions to another group. |
| `jira_add_user_to_group` ✎ | `group`: string, `username`: string | Add a user to a group. |
| `jira_remove_user_from_group` ✎ | `group`: string, `username`: string | Remove a user from a group. |

### Jira admin — projects and roles

| Tool | Arguments | Description |
|---|---|---|
| `jira_list_projects` | `name_contains?`: string, `category?`: string, `include_archived?`: boolean, `offset?`: integer, `limit?`: integer | Projects with key, name, type, lead and category. Filter by name/key fragment or category. |
| `jira_get_project_config` | `project_key`: string | A project's admin picture: lead, category, issue types, and its workflow (with issue type mappings), issue type, permission, notification and issue security schemes. |
| `jira_list_roles` | — | Global project roles (id, name, description). |
| `jira_get_project_roles` | `project_key`: string, `role_id?`: integer | Users and groups in every role of a project, or in one role when role_id is given. |
| `jira_add_project_role_actors` ✎ | `project_key`: string, `role_id`: integer, `users?`: list\|string, `groups?`: list\|string | Add users and/or groups to a project role (existing members are kept). |
| `jira_remove_project_role_actor` ✎ | `project_key`: string, `role_id`: integer, `user?`: string, `group?`: string | Remove one user or one group from a project role. |
| `jira_set_project_permission_scheme` ✎ | `project_key`: string, `scheme_id`: integer | Assign a permission scheme to a project. |
| `jira_archive_project` ✎ | `project_key`: string | Archive a project (read-only and hidden; reversible with jira_restore_project). |
| `jira_restore_project` ✎ | `project_key`: string | Restore an archived project. |

### Jira admin — schemes and workflows

| Tool | Arguments | Description |
|---|---|---|
| `jira_list_permission_schemes` | `name_contains?`: string, `with_grant_counts?`: boolean | Permission schemes with id, name and description (with_grant_counts=true also counts grants, a much larger response). |
| `jira_get_permission_scheme` | `scheme_id`: integer, `permission?`: string | Grants of a permission scheme grouped by permission key (optionally one permission, e.g. DELETE_ISSUES). Each grant carries the id needed by jira_delete_permission_grant. |
| `jira_add_permission_grant` ✎ | `scheme_id`: integer, `permission`: string, `holder_type`: anyone\|applicationRole\|assignee\|group\|groupCustomField\|projectLead\|projectRole\|reporter\|user\|userCustomField, `holder_parameter?`: string | Grant a permission in a scheme. holder_type/holder_parameter: group/<group name>, projectRole/<role id>, user/<username>, applicationRole/<app key or empty = any logged-in user>, userCustomField\|groupCustomField/<customfield_N>, projectLead, reporter, assignee, anyone. permission: e.g. BROWSE_PROJECTS, ADMINISTER_PROJECTS. |
| `jira_delete_permission_grant` ✎ | `scheme_id`: integer, `grant_id`: integer | Remove one grant (id from jira_get_permission_scheme) from a permission scheme. |
| `jira_list_notification_schemes` | `offset?`: integer, `limit?`: integer | Notification schemes (server-side paging). |
| `jira_get_notification_scheme` | `scheme_id`: integer | Who is notified on each event of a notification scheme. |
| `jira_list_issue_security_schemes` | — | Issue security schemes with their default level. |
| `jira_get_issue_security_scheme` | `scheme_id`: integer | Security levels of an issue security scheme. |
| `jira_list_workflows` | `name_contains?`: string, `name?`: string, `offset?`: integer, `limit?`: integer | Workflows with description, step count and last modification. |
| `jira_list_issue_types` | `name_contains?`: string, `offset?`: integer, `limit?`: integer | All issue types with id, name and sub-task flag. |
| `jira_create_issue_type` ✎ | `name`: string, `description?`: string, `subtask?`: boolean, `avatar_id?`: integer | Create a global issue type (subtask=true for a sub-task type). It is not in any project until added to the project's issue type scheme (jira_add_issue_types_to_scheme); map it in the workflow scheme with jira_set_workflow_scheme_mapping. |
| `jira_list_issue_type_schemes` | `name_contains?`: string, `offset?`: integer, `limit?`: integer | Issue type schemes with id, name and description (jira_get_project_config shows a project's scheme). |
| `jira_get_issue_type_scheme` | `scheme_id`: integer, `max_projects?`: integer | An issue type scheme: its issue types, default issue type and the projects that use it (up to max_projects keys). |
| `jira_add_issue_types_to_scheme` ✎ | `scheme_id`: integer, `issue_type_ids`: list\|string, `default_issue_type_id?`: string | Add issue types (ids from jira_list_issue_types) to an issue type scheme, keeping its current types; default_issue_type_id optionally changes the default. Projects using the scheme can then create these types. |

### Jira admin — workflow schemes

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_workflow_scheme` | `scheme_id`: integer, `draft?`: boolean | Workflow scheme: default workflow and issue type id -> workflow mappings (draft=true reads the unpublished draft). |
| `jira_set_workflow_scheme_mapping` ✎ | `scheme_id`: integer, `issue_type_id`: string, `workflow`: string, `update_draft_if_needed?`: boolean | Map an issue type (id from jira_list_issue_types) to a workflow (exact name from jira_list_workflows) in a workflow scheme. |
| `jira_delete_workflow_scheme_mapping` ✎ | `scheme_id`: integer, `issue_type_id`: string, `update_draft_if_needed?`: boolean | Remove an issue type mapping from a workflow scheme; the issue type then uses the scheme's default workflow. |
| `jira_set_workflow_scheme_default` ✎ | `scheme_id`: integer, `workflow`: string, `update_draft_if_needed?`: boolean | Set the default workflow of a workflow scheme (used by issue types without their own mapping). |
| `jira_list_workflow_schemes` | `name_contains?`: string, `scan_projects?`: integer, `offset?`: integer, `limit?`: integer | Workflow schemes in use, with their projects, found by scanning each project's scheme (Jira DC cannot list all schemes; unused ones are not shown). Large instances: raise scan_projects or use --out. |
| `jira_find_workflow_usage` | `workflow`: string, `scan_projects?`: integer, `offset?`: integer, `limit?`: integer | Where a workflow (exact name) is used: the workflow schemes that map it, as default or per issue type id, and their projects. Scans projects like jira_list_workflow_schemes; drafts and unused schemes are not covered. |
| `jira_create_workflow_scheme` ✎ | `name`: string, `description?`: string, `default_workflow?`: string, `issue_type_mappings?`: object, `copy_from_scheme_id?`: integer | Create a workflow scheme. copy_from_scheme_id copies another scheme's description, default workflow and mappings; default_workflow and issue_type_mappings ({"<issue type id>":"<workflow>"}) set or override them. Assigning it to a project is done in the Jira UI. |
| `jira_update_workflow_scheme` ✎ | `scheme_id`: integer, `name?`: string, `description?`: string, `update_draft_if_needed?`: boolean | Rename a workflow scheme or change its description (mappings: jira_set_workflow_scheme_mapping, jira_replace_workflow_in_scheme). |
| `jira_delete_workflow_scheme` ✎ | `scheme_id`: integer | Delete a workflow scheme (irreversible). Jira refuses while a project uses it. |
| `jira_create_workflow_scheme_draft` ✎ | `scheme_id`: integer | Create a draft of an active workflow scheme (a copy to edit before publishing it in the Jira UI). |
| `jira_delete_workflow_scheme_draft` ✎ | `scheme_id`: integer | Discard the draft of a workflow scheme (its unpublished changes are lost); the published scheme is unchanged. |
| `jira_compare_workflow_scheme_draft` | `scheme_id`: integer | What the draft of a workflow scheme changes compared with the published scheme (default workflow and per issue type id). |
| `jira_replace_workflow_in_scheme` ✎ | `scheme_id`: integer, `from_workflow`: string, `to_workflow`: string, `update_draft_if_needed?`: boolean | Replace one workflow with another everywhere in a workflow scheme (its default and every issue type mapped to it), in one request. With update_draft_if_needed=true the change is computed from and written to the draft. |

### Jira admin — custom fields

| Tool | Arguments | Description |
|---|---|---|
| `jira_list_custom_fields` | `search?`: string, `unused_only?`: boolean, `project_key?`: string, `min_issues?`: integer, `sort_by_usage?`: boolean, `max_scan?`: integer, `offset?`: integer, `limit?`: integer | Custom fields with usage stats (issuesWithValue, projects, screensCount, lastValueUpdate). search and project_key are filtered by Jira and paged server-side. unused_only / min_issues / sort_by_usage need usage numbers Jira cannot filter on: they scan at most max_scan fields (default 2000) and say if the scan was cut. Use it to audit dead fields before jira_delete_custom_fields. |
| `jira_get_field_contexts` | `field_id`: string | Contexts of a custom field: which projects and issue types each context applies to. |
| `jira_get_field_screens` | `field_id`: string, `offset?`: integer, `limit?`: integer | Screens (and tabs) a field is placed on. |
| `jira_delete_custom_fields` ✎ | `ids`: list\|string | Permanently delete custom fields and all their values. Irreversible; check usage first. |
| `jira_list_fields` | `search?`: string, `offset?`: integer, `limit?`: integer | All system and custom fields with id, name, custom flag and schema type (no usage stats). |
| `jira_create_custom_field` ✎ | `name`: string, `description?`: string, `field_type`: string, `searcher_key?`: string, `context_scope?`: global | Create a custom field. field_type: text-single-line, url, date-picker, or a full type key Jira lists; the searcher defaults to the type's first one. Looks for fields of the same name (case-insensitive) first: same type → already-satisfied with its id; other type or several matches → error. Jira gives the field a global default context; scope it with jira_update_field_context context_id=default. |
| `jira_create_field_context` ✎ | `field_id`: string, `name`: string, `description?`: string, `project_ids?`: list\|string, `issue_type_ids?`: list\|string, `global?`: boolean | Add a context to a custom field: global=true or project_ids, and issue_type_ids (omit for all). An identical context (same name and scope) → already-satisfied. Internal Jira API; Jira 11.3.x only. |
| `jira_update_field_context` ✎ | `field_id`: string, `context_id`: string, `name?`: string, `description?`: string, `project_ids?`: list\|string, `issue_type_ids?`: list\|string, `global?`: boolean, `all_issue_types?`: boolean | Change a custom field context's name, description or scope. context_id is the id or `default` (the field's only context, as Jira creates it with the field). The complete context is sent; attributes not given keep their stored values. Internal Jira API; Jira 11.3.x only. |
| `jira_delete_field_context` ✎ | `field_id`: string, `context_id`: string | Remove a context from a custom field (its option values and default go with it). Already gone → already-satisfied. Internal Jira API; Jira 11.3.x only. |
| `jira_add_field_to_screens` ✎ | `field_id`: string, `placements`: list | Place a field on several screen tabs: placements = [{screen_id, tab_id, position?}] (JSON). Each placement is its own change (jira_add_screen_field): the dry run lists them, --plan records each as a separate item, placements already in place are reported as satisfied. |
| `jira_get_custom_field_options` | `field`: string, `context?`: string | Options of a select-type custom field per context (or one context): id, value, disabled, in stored order, with the projects and issue types each context covers. |
| `jira_set_custom_field_options` ✎ | `field`: string, `context?`: string, `options`: list | Set the options of a select-type field's context: options = comma list of values or JSON [{value, id?, disabled?}] in order. A context without options gets them through the API (Severity 1–4 on a new field). For a context that already has options nothing is sent: the dry run is a manual change with the steps (add, rename by id, order, disable, enable) and the options page link; running again verifies. Options are never deleted. Jira 11.3.x only. |

### Jira admin — field configurations

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_field_configuration` | `project_key`: string, `issue_type_id?`: string, `field_configuration_id?`: integer, `name_contains?`: string, `offset?`: integer, `limit?`: integer | The field configuration a project uses (per issue type, or field_configuration_id): its fields with description, hidden/visible and required/optional (paged, name_contains), and the projects that share it. Without issue_type_id, issue types are grouped by configuration (fields only when there is one). Field configuration schemes are not readable through REST. Internal and plugin APIs, verified on Jira 11.3. |
| `jira_update_field_description` ✎ | `field_configuration_id`: integer, `field_id`: string, `description`: string | Prepare a change of one field's description in one field configuration (never the field's global name or description): the dry run shows old and new value, the projects sharing the configuration and the edit link. Jira serves that form only after websudo re-authentication, which a token cannot pass, so the change is entered in the UI; running the tool again verifies it (already-satisfied). |

### Jira admin — screens

| Tool | Arguments | Description |
|---|---|---|
| `jira_list_screens` | `search?`: string, `offset?`: integer, `limit?`: integer | Screens with id and name (server-side search and paging). |
| `jira_get_screen` | `screen_id`: integer | A screen's tabs with their fields in order. |
| `jira_get_screen_usage` | `screen_id`: integer, `scan_projects?`: integer, `offset?`: integer, `limit?`: integer | Where a screen is used: projects, issue types and operations (create/edit/view), the screen schemes and issue type screen schemes when Jira names them, and a sharing warning. Scans projects through the bundled 'Where is my field' and project-config plugins (internal APIs, verified on Jira 11.3); `complete` is false when the scan was cut or some projects could not be read. Large instances: --out or a subagent. |
| `jira_add_screen_field` ✎ | `screen_id`: integer, `tab_id`: integer, `field_id`: string, `position?`: integer | Add a field to a screen tab, optionally at a 1-based position. Already on the tab → already-satisfied; on another tab of the screen → error. The dry run shows the order before/after and the projects using the screen; after the change the screen is read back. |
| `jira_remove_screen_field` ✎ | `screen_id`: integer, `tab_id`: integer, `field_id`: string | Remove a field from a screen tab. Not on the tab → already-satisfied. The screen is read back after the change. |
| `jira_move_screen_field` ✎ | `screen_id`: integer, `tab_id`: integer, `field_id`: string, `position?`: integer, `after_field_id?`: string | Move a field on a screen tab to a 1-based position or right after another field (after_field_id). Already there → already-satisfied. |

### Jira — issues, search, comments, transitions

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_issue` | `issue_key`: string, `fields?`: string, `comments?`: integer, `include?`: list\|string, `expand?`: string, `markup?`: markdown\|wiki, `history_limit?`: integer | One issue: key, type, status, priority, people, dates, labels, epic, description as Markdown. Optional: comments=N newest comments, include=transitions,watchers,remote_links,worklogs,changelog,links,subtasks, fields=extra ids. |
| `jira_search` | `jql`: string, `projects?`: list\|string, `offset?`: integer, `limit?`: integer, `fields?`: string, `include_description?`: boolean, `expand?`: string | Search issues with JQL (server-side paging, max 100 per page). Rows: key, type, status, priority, assignee, summary, dates. Description only with include_description=true. projects narrows the JQL to project keys. |
| `jira_get_project_issues` | `project_key`: string, `offset?`: integer, `limit?`: integer, `fields?`: string, `include_description?`: boolean, `expand?`: string | Issues of one project, newest updated first (same rows as jira_search). |
| `jira_create_issue` ✎ | `project_key`: string, `summary`: string, `issue_type`: string, `description?`: string, `assignee?`: string, `components?`: list\|string, `fields?`: object, `markup?`: markdown\|wiki | Create an issue. description is Markdown (markup=wiki to send wiki markup). fields: other fields by name or id, e.g. {"priority":"High","labels":"a,b","Epic Link":"FDP-1","parent":"FDP-2","customfield_10100":"x"}. Epics get Epic Name = summary unless given; localized Epic/Sub-task type names are resolved. |
| `jira_batch_create_issues` ✎ | `issues`: list, `markup?`: markdown\|wiki | Create several issues in one bulk request. issues: JSON array of {project_key, summary, issue_type, description?, assignee?, components?, fields?}. |
| `jira_update_issue` ✎ | `issue_key`: string, `fields?`: object, `components?`: list\|string, `transition?`: string, `comment?`: string, `comment_visibility?`: object, `worklog?`: string, `worklog_started?`: string, `attachments?`: list\|string, `notify?`: boolean, `markup?`: markdown\|wiki | Update an issue in one call: fields (by name or id; description Markdown; {"status":"Done"} transitions), components, transition (name or id), comment (Markdown), worklog (e.g. '1h 30m'), attachments (local file paths). |
| `jira_assign_issue` ✎ | `issue_key`: string, `assignee?`: string | Assign an issue (username, user key, e-mail or display name); omit assignee to unassign. |
| `jira_delete_issue` ✎ | `issue_key`: string, `delete_subtasks?`: boolean | Permanently delete an issue. With subtasks it fails unless delete_subtasks=true. Irreversible. |
| `jira_get_field_options` | `field_id`: string, `project_key`: string, `issue_type`: string, `contains?`: string, `values_only?`: boolean, `offset?`: integer, `limit?`: integer | Allowed values of a select/multi-select/cascading field for a project + issue type (from create metadata). contains filters values (also children); values_only returns plain strings. |
| `jira_get_comments` | `issue_key`: string, `oldest_first?`: boolean, `offset?`: integer, `limit?`: integer, `markup?`: markdown\|wiki | Comments of an issue as Markdown, newest first (server-side paging). |
| `jira_add_comment` ✎ | `issue_key`: string, `body`: string, `visibility?`: object, `markup?`: markdown\|wiki | Add a comment (Markdown, or markup=wiki). visibility restricts it to a group or project role. |
| `jira_edit_comment` ✎ | `issue_key`: string, `comment_id`: string, `body`: string, `visibility?`: object, `markup?`: markdown\|wiki | Replace the text of a comment (Markdown, or markup=wiki). |
| `jira_get_transitions` | `issue_key`: string, `with_fields?`: boolean | Transitions available for an issue now: id, name, target status; with_fields adds the fields of its screen. |
| `jira_transition_issue` ✎ | `issue_key`: string, `transition`: string, `fields?`: object, `comment?`: string, `markup?`: markdown\|wiki | Move an issue through its workflow by transition id or name (case-insensitive). fields for the transition screen (e.g. {"resolution":"Fixed","assignee":"ivan"}), comment as Markdown. |

### Jira — project metadata and versions

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_project_issue_types` | `project_key`: string | Issue types you can create in a project: id, name, subtask flag (localized names included). |
| `jira_get_create_fields` | `project_key`: string, `issue_type_id`: string, `required_only?`: boolean, `name_contains?`: string, `offset?`: integer, `limit?`: integer | Fields on the create screen of a project + issue type: id, name, required, type. Use jira_get_field_options for allowed values. |
| `jira_get_project_fields` | `project_key`: string, `issue_types?`: list\|string, `required_only?`: boolean, `offset?`: integer, `limit?`: integer | All create-screen fields of a project merged across issue types: required for any type, and which types have it. Makes one call per issue type: narrow with issue_types (names or ids); at most 20 types are read. |
| `jira_get_project_versions` | `project_key`: string, `unreleased_only?`: boolean, `name_contains?`: string, `offset?`: integer, `limit?`: integer | Versions (releases) of a project, newest first (server-side paging): id, name, released, archived, dates. unreleased_only hides released/archived; name_contains filters by name. |
| `jira_get_project_components` | `project_key`: string, `name_contains?`: string, `offset?`: integer, `limit?`: integer | Components of a project: id, name, lead, default assignee type, description. |
| `jira_create_version` ✎ | `project_key`: string, `name`: string, `start_date?`: string, `release_date?`: string, `description?`: string, `released?`: boolean | Create a version (release) in a project. Dates are YYYY-MM-DD. |
| `jira_batch_create_versions` ✎ | `project_key`: string, `versions`: list | Create several versions in a project (one request each). versions: JSON array of {name, startDate?, releaseDate?, description?, released?}. |
| `jira_update_version` ✎ | `version_id`: string, `name?`: string, `description?`: string, `start_date?`: string, `release_date?`: string, `released?`: boolean, `archived?`: boolean | Rename a version, change its dates or description, or mark it released/archived. |

### Jira — boards and sprints

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_agile_boards` | `board_name?`: string, `project_key?`: string, `board_type?`: scrum\|kanban, `offset?`: integer, `limit?`: integer | Agile boards (scrum/kanban) filtered by name fragment, project or type. |
| `jira_get_board_issues` | `board_id`: integer, `jql?`: string, `fields?`: string, `offset?`: integer, `limit?`: integer | Issues on a board (respects the board filter), optionally narrowed by JQL. |
| `jira_get_sprints_from_board` | `board_id`: integer, `state?`: string, `offset?`: integer, `limit?`: integer | Sprints of a board, optionally by state (future, active, closed; comma list allowed). |
| `jira_get_sprint_issues` | `sprint_id`: integer, `jql?`: string, `fields?`: string, `offset?`: integer, `limit?`: integer | Issues in a sprint, optionally narrowed by JQL. |
| `jira_create_sprint` ✎ | `board_id`: integer, `name`: string, `start_date?`: string, `end_date?`: string, `goal?`: string | Create a future sprint on a board. Dates are ISO 8601, e.g. 2026-10-06T09:00:00.000+03:00. |
| `jira_update_sprint` ✎ | `sprint_id`: integer, `name?`: string, `state?`: future\|active\|closed, `start_date?`: string, `end_date?`: string, `goal?`: string | Partially update a sprint. Start it with state=active (needs dates), close it with state=closed. |
| `jira_add_issues_to_sprint` ✎ | `sprint_id`: integer, `issue_keys`: list\|string | Move issues into a sprint (up to 50 per call). |
| `jira_move_issues_to_backlog` ✎ | `issue_keys`: list\|string | Move issues out of their sprints into the backlog (up to 50 per call). |

### Jira — board configuration

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_board_configuration` | `board_id`: integer | A Jira Software board's configuration: saved filter (name, JQL), columns with their statuses, unmapped statuses, quick filters, card layout, Detail View fields in order, estimation, sub-filter, swimlanes, administrators and whether this account can edit it. Parts that cannot be read are listed under `unavailable`. Uses the internal board edit model (verified on Jira 11.3) besides the public agile API. |
| `jira_set_board_detail_fields` ✎ | `board_id`: integer, `fields?`: list\|string, `add_fields?`: list\|string, `remove_fields?`: list\|string | Change a board's Detail View fields: `fields` = the complete target list in order, or add_fields / remove_fields (fields not named keep their place and order; added ones go last). Fields are ids or exact names the Detail View offers. Needs board admin rights; internal Jira Software API, Jira 11.3.x only. The Detail View is read back after the change. |
| `jira_add_board_detail_field` ✎ | `board_id`: integer, `field`: string | Add one field to the end of a board's Detail View (already shown → already-satisfied). Board admin; Jira 11.3.x only. |
| `jira_remove_board_detail_field` ✎ | `board_id`: integer, `field`: string | Remove one field from a board's Detail View; other fields keep their order (not shown → already-satisfied). Board admin; Jira 11.3.x only. |

### Jira — links and epics

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_link_types` | `name_contains?`: string | Issue link types with inward/outward wording (e.g. Blocks: 'is blocked by' / 'blocks'). |
| `jira_link_to_epic` ✎ | `issue_key`: string, `epic_key`: string | Link an issue to an epic via the Epic Link field (discovered from /field). Falls back to the parent field when the instance has no Epic Link field. |
| `jira_create_issue_link` ✎ | `link_type`: string, `inward_issue_key`: string, `outward_issue_key`: string, `comment?`: string, `comment_visibility?`: object | Link two issues. link_type is the type name (jira_get_link_types); outward_issue_key <outward wording> inward_issue_key, e.g. Blocks: outward blocks inward. Optional Markdown comment on the outward issue. |
| `jira_create_remote_issue_link` ✎ | `issue_key`: string, `url`: string, `title`: string, `summary?`: string, `relationship?`: string, `icon_url?`: string | Add a web link (remote link) to an issue: URL, title, optional summary, relationship and 16x16 icon. |
| `jira_remove_issue_link` ✎ | `link_id`: string | Delete an issue link by id (the id of an entry in the issue's issuelinks field). |
| `jira_get_issue_links` | `issue_key`: string, `include_remote?`: boolean | Links of one issue: id (for jira_remove_issue_link), type wording, other issue key/status/summary, plus remote links. |

### Jira — worklog

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_worklog` | `issue_key`: string, `oldest_first?`: boolean, `offset?`: integer, `limit?`: integer | Worklogs of an issue, newest first: author, started, time spent, comment (Markdown). totalHours covers all worklogs. |
| `jira_add_worklog` ✎ | `issue_key`: string, `time_spent`: string, `comment?`: string, `started?`: string, `remaining_estimate?`: string | Log work on an issue. time_spent uses Jira duration syntax (1w 2d 3h 30m) and the instance's time tracking settings. remaining_estimate sets the new remaining estimate; otherwise Jira reduces it automatically. Change the original estimate with an issue field update (timetracking). |

### Jira — attachments

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_attachments` | `issue_key`: string | List an issue's attachments (id, name, type, size, author, created) without downloading them. |
| `jira_download_attachments` | `issue_key`: string, `output_dir`: string, `attachment_ids?`: list\|string, `name_contains?`: string, `max_bytes?`: integer, `max_files?`: integer | Download an issue's attachments into output_dir and return their local paths (contents are not printed). Filter by ids or name; files above max_bytes are skipped. |
| `jira_get_issue_images` | `issue_key`: string, `output_dir`: string, `attachment_ids?`: list\|string, `name_contains?`: string, `max_bytes?`: integer, `max_files?`: integer | Download only the image attachments of an issue into output_dir and return their local paths. |
| `jira_upload_attachments` ✎ | `issue_key`: string, `paths`: list\|string | Attach local files to an issue (multipart upload). |
| `jira_delete_attachment` ✎ | `attachment_id`: string | Delete one attachment by id (irreversible). |

### Jira — assignable users and watchers

| Tool | Arguments | Description |
|---|---|---|
| `jira_search_assignable_users` | `query`: string, `project_key?`: string, `issue_key?`: string, `limit?`: integer | Users who can be assigned in a project or on an issue, by name/username/e-mail fragment. Needs only browse/assign permission (unlike jira_find_users, which needs Browse Users). |
| `jira_get_issue_watchers` | `issue_key`: string | Watchers of an issue and the watch count. |
| `jira_add_watcher` ✎ | `issue_key`: string, `username`: string | Add a user (username) as watcher of an issue. |
| `jira_remove_watcher` ✎ | `issue_key`: string, `username`: string | Remove a watcher (username) from an issue. |

### Jira — dates, SLA, development info, project analysis

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_issue_dates` | `issue_key`: string, `include_status_changes?`: boolean, `include_status_summary?`: boolean | Key dates of an issue plus time spent in each status (from the changelog). |
| `jira_get_issue_sla` | `issue_key`: string, `metrics?`: list\|string, `working_hours_only?`: boolean, `work_start?`: string, `work_end?`: string, `work_days?`: string, `time_zone?`: string, `include_raw_dates?`: boolean | Client-side SLA metrics from the changelog (not JSM SLA fields): cycle_time, lead_time, time_in_status, due_date_compliance, resolution_time, first_response_time. Optionally count working hours only. |
| `jira_get_issue_development_info` | `issue_key`: string, `application_type?`: string, `data_type?`: pullrequest\|branch\|repository, `max_commits?`: integer | Pull requests, branches, commits and repositories linked to an issue (dev-status API; Bitbucket Server application_type is 'stash'). Commits are capped by max_commits. |
| `jira_get_issues_development_info` | `issue_keys`: list\|string, `application_type?`: string, `data_type?`: pullrequest\|branch\|repository, `max_commits?`: integer | Development info for several issues (one after another; at most 20 keys). |
| `jira_get_project_epic_hierarchy` | `project_key`: string, `max_epics?`: integer | Epics of a project grouped by their parent in another project (parent field or 'is child of'-style links). Scans at most max_epics epics (default 200). |
| `jira_get_cross_project_dependencies` | `project_key`: string, `max_issues?`: integer | Links from a project's issues to issues in other projects, grouped by project and link type. Scans at most max_issues issues (default 200), newest first. |

### Jira Service Management

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_service_desk_for_project` | `project_key`: string | Service desk (id, name) behind a Jira project key; null when the project is not a service project. |
| `jira_get_service_desk_queues` | `service_desk_id`: string, `include_count?`: boolean, `offset?`: integer, `limit?`: integer | Queues of a service desk with their JQL; include_count=true adds issue counts (runs one JQL count per queue). |
| `jira_get_queue_issues` | `service_desk_id`: string, `queue_id`: string, `include_count?`: boolean, `offset?`: integer, `limit?`: integer | Issues in a service desk queue (compact issue rows). include_count=true also reports the queue total. |
| `jira_get_request_types` | `service_desk_id`: string, `group_id?`: string, `offset?`: integer, `limit?`: integer | Request types of a service desk (id, name, issue type, groups); group_id narrows to one portal group. |
| `jira_get_request_type_fields` | `service_desk_id`: string, `request_type_id`: string | Fields of a request type: id, required, type, valid values. Call before jira_create_customer_request. |
| `jira_create_customer_request` ✎ | `service_desk_id`: string, `request_type_id`: string, `request_field_values`: object\|string, `raise_on_behalf_of?`: string, `request_participants?`: list\|string, `attachments?`: list\|string, `attachments_public?`: boolean, `allow_agent_fallback?`: boolean | Raise a customer request. request_field_values: object keyed by field id (summary, description, customfield_N); select fields accept option labels. Required fields are validated first. attachments: local file paths, attached publicly after creation. raise_on_behalf_of: username (fails when rejected; allow_agent_fallback=true retries once as the calling agent, which is a different request than the dry run showed). |

### Jira Service Management — request types and forms

| Tool | Arguments | Description |
|---|---|---|
| `jira_create_request_type` ✎ | `service_desk`: string, `name`: string, `issue_type`: string, `description?`: string, `help_text?`: string | Create a JSM request type for an issue type (id or name). Same name and issue type → already-satisfied; same name with another issue type → error. New request types are not in a portal group (hidden) until added to one. |
| `jira_update_request_type` ✎ | `service_desk`: string, `request_type`: string, `name?`: string, `description?`: string, `help_text?`: string, `issue_type?`: string | Change a request type's name, description, help text and/or issue type. Internal JSM API, JSM 11.3.x only; read back after the change. |
| `jira_delete_request_type` ✎ | `service_desk`: string, `request_type`: string | Delete a request type (irreversible: requests created from it keep their issue type but lose the request type). Already gone → already-satisfied. |
| `jira_set_request_type_hidden` ✎ | `service_desk`: string, `request_type`: string, `hidden`: boolean, `group?`: string | Hide a request type from the portal (hidden=true removes it from all portal groups) or show it (hidden=false, needs group). Internal JSM API, JSM 11.3.x only. |
| `jira_add_request_type_to_group` ✎ | `service_desk`: string, `request_type`: string, `group`: string, `position?`: integer | Add a request type to a portal group, optionally at a 1-based position. Internal JSM API, JSM 11.3.x only. |
| `jira_remove_request_type_from_group` ✎ | `service_desk`: string, `request_type`: string, `group`: string | Remove a request type from a portal group (no groups left → hidden from the portal). Internal JSM API, JSM 11.3.x only. |
| `jira_move_request_type_in_group` ✎ | `service_desk`: string, `request_type`: string, `group`: string, `position?`: integer, `after?`: string | Move a request type within a portal group to a 1-based position or right after another request type. Internal JSM API, JSM 11.3.x only. |
| `jira_get_request_type_form` | `service_desk`: string, `request_type`: string | A request type's form: visible fields in order (label, description, required), hidden fields with their preset values, and fields that can still be added. Internal JSM API. |
| `jira_add_request_type_field` ✎ | `service_desk`: string, `request_type`: string, `field`: string, `label?`: string, `description?`: string, `required?`: boolean, `position?`: integer | Add a field to a request type's form (optionally label, description, required, 1-based position). Already visible there → already-satisfied. Internal JSM API, JSM 11.3.x only. |
| `jira_remove_request_type_field` ✎ | `service_desk`: string, `request_type`: string, `field`: string | Remove a field (visible or hidden) from a request type's form. Not on the form → already-satisfied. Internal JSM API, JSM 11.3.x only. |
| `jira_move_request_type_field` ✎ | `service_desk`: string, `request_type`: string, `field`: string, `position?`: integer, `after?`: string | Move a visible field of a request type's form to a 1-based position or right after another field. Internal JSM API, JSM 11.3.x only. |
| `jira_update_request_type_field` ✎ | `service_desk`: string, `request_type`: string, `field`: string, `label?`: string, `description?`: string, `required?`: boolean | Change a visible form field's label, description and/or required flag. Internal JSM API, JSM 11.3.x only. |
| `jira_hide_request_type_field` ✎ | `service_desk`: string, `request_type`: string, `field`: string, `preset?`: string | Hide a form field from customers, optionally with a preset value (preset = value or comma list). A field Jira requires needs a preset. Internal JSM API, JSM 11.3.x only. |
| `jira_show_request_type_field` ✎ | `service_desk`: string, `request_type`: string, `field`: string | Show a hidden form field to customers again. Already visible → already-satisfied. Internal JSM API, JSM 11.3.x only. |

### Jira Service Management — queues

| Tool | Arguments | Description |
|---|---|---|
| `jira_create_queue` ✎ | `service_desk`: string, `name`: string, `jql`: string, `columns`: list\|string | Create a service desk queue with JQL and ordered columns. Same name and settings → already-satisfied; same name otherwise → error. |
| `jira_update_queue` ✎ | `service_desk`: string, `queue`: string, `name?`: string, `jql?`: string, `columns?`: list\|string | Change a queue's name, JQL and/or columns. The dry run shows old and new values. |
| `jira_delete_queue` ✎ | `service_desk`: string, `queue`: string | Delete a queue. Already gone → already-satisfied. |
| `jira_move_queue` ✎ | `service_desk`: string, `queue`: string, `position?`: integer, `after?`: string | Move a queue to a 1-based position or right after another queue. Sends the full order of queue ids to POST …/queue/reorder and reads the order back. |

### Jira Service Management — SLAs and calendars

| Tool | Arguments | Description |
|---|---|---|
| `jira_get_sla_configuration` | `service_desk`: string, `offset?`: integer, `limit?`: integer | SLA metrics of a service desk: start, pause and stop conditions, and goals in order (JQL, target, calendar). Internal JSM API. |
| `jira_get_sla_conditions` | `service_desk`: string | Conditions an SLA can use in this service desk: start/stop events and pause conditions, by name. Internal JSM API. |
| `jira_list_sla_calendars` | `service_desk`: string | SLA calendars of a service desk with time zone, working hours, holidays and the SLAs that use them (the built-in Default 24/7 calendar included). Internal JSM API. |
| `jira_create_sla` ✎ | `service_desk`: string, `name`: string, `start`: list\|string, `pause?`: list\|string, `stop`: list\|string, `goals`: list, `customer_visible?`: boolean | Create an SLA metric: start/pause/stop conditions by name and goals in order. Same name and settings → already-satisfied; same name otherwise → error. Calendars by name (also one planned earlier), id, or 24x7. Internal JSM API, JSM 11.3.x only. |
| `jira_update_sla` ✎ | `service_desk`: string, `sla`: string, `name?`: string, `start?`: list\|string, `pause?`: list\|string, `stop?`: list\|string, `goals?`: list, `customer_visible?`: boolean | Change an SLA metric's name, conditions, goals or customer visibility (given parts replace the stored ones). JSM recalculates the SLA on existing requests. Internal JSM API, JSM 11.3.x only. |
| `jira_delete_sla` ✎ | `service_desk`: string, `sla`: string | Delete an SLA metric (irreversible: the SLA values recorded on requests are lost). Already gone → already-satisfied. Internal JSM API, JSM 11.3.x only. |
| `jira_create_sla_calendar` ✎ | `service_desk`: string, `name`: string, `time_zone`: string, `working_hours`: string, `description?`: string, `holidays?`: list | Create an SLA calendar: name, time_zone (e.g. Europe/Moscow), working_hours (24x7, or e.g. 'mon-fri 09:00-18:00'), optional holidays (JSON list as JSM stores them). Same name and settings → already-satisfied. Internal JSM API, JSM 11.3.x only. |
| `jira_update_sla_calendar` ✎ | `service_desk`: string, `calendar`: string, `name?`: string, `time_zone?`: string, `working_hours?`: string, `description?`: string, `holidays?`: list | Change an SLA calendar's name, description, time zone, working hours or holidays. SLAs using it are recalculated. Internal JSM API, JSM 11.3.x only. |
| `jira_delete_sla_calendar` ✎ | `service_desk`: string, `calendar`: string | Delete an SLA calendar. Refused while SLA goals use it. Already gone → already-satisfied. Internal JSM API, JSM 11.3.x only. |

### Jira Assets — schemas, object types, attributes, statuses

| Tool | Arguments | Description |
|---|---|---|
| `assets_list_schemas` | `name_contains?`: string, `offset?`: integer, `limit?`: integer | Object schemas with id, key, name, object and object type counts. |
| `assets_get_schema` | `schema_id`: integer, `include_abstract?`: boolean | One schema plus its object type tree (id, name, parent, object count). Start here to learn a schema. |
| `assets_create_schema` ✎ | `name`: string, `key`: string, `description?`: string | Create an object schema. key: 2–10 uppercase letters, used as the object key prefix (e.g. ITAM → ITAM-123). |
| `assets_update_schema` ✎ | `schema_id`: integer, `name?`: string, `description?`: string | Rename a schema or change its description (the key cannot change once objects exist). |
| `assets_delete_schema` ✎ | `schema_id`: integer | PERMANENTLY delete a schema with all its object types, attributes and objects. |
| `assets_get_schema_attributes` | `schema_id`: integer, `query?`: string, `only_editable?`: boolean, `offset?`: integer, `limit?`: integer | All attribute definitions across a schema (which type each belongs to), filterable by name. |
| `assets_get_reference_types` | `schema_id`: integer | Reference types (e.g. Depends on, Installed, Owner) usable for reference attributes in a schema. |
| `assets_get_object_type` | `object_type_id`: integer | One object type with its attribute definitions (own and inherited). |
| `assets_create_object_type` ✎ | `schema_id`: integer, `name`: string, `description?`: string, `parent_id?`: integer, `icon_id?`: integer, `inherited?`: boolean, `abstract?`: boolean | Create an object type in a schema (optionally under a parent; inherited=true makes children inherit attributes). New types get the system attributes Key, Name, Created, Updated. |
| `assets_update_object_type` ✎ | `object_type_id`: integer, `name?`: string, `description?`: string, `parent_id?`: integer, `icon_id?`: integer, `inherited?`: boolean, `abstract?`: boolean | Rename, re-describe, move under another parent or change icon/inheritance of an object type. |
| `assets_delete_object_type` ✎ | `object_type_id`: integer | PERMANENTLY delete an object type together with its objects and attribute definitions. |
| `assets_list_attributes` | `object_type_id`: integer, `name_contains?`: string, `only_editable?`: boolean, `exclude_inherited?`: boolean, `offset?`: integer, `limit?`: integer | Attribute definitions of an object type (own and inherited): id, name, type, required, multiple, reference target. |
| `assets_create_attribute` ✎ | `object_type_id`: integer, `name`: string, `type`: string, `label?`: boolean, `description?`: string, `required?`: boolean, `multiple?`: boolean, `unique?`: boolean, `hidden?`: boolean, `options?`: list\|string, `reference_object_type_id?`: integer, `reference_type_id?`: integer, `aql_filter?`: string, `groups?`: list\|string, `regex?`: string, `suffix?`: string, `summable?`: boolean, `include_child_types?`: boolean | Add an attribute to an object type. type: text, integer, boolean, double, date, time, datetime, url, email, textarea, select, ipaddress, reference, user, confluence, group, version, project, status. reference needs reference_object_type_id (+ reference_type_id); select takes options. |
| `assets_update_attribute` ✎ | `object_type_id`: integer, `attribute_id`: integer, `name?`: string, `type?`: string, `label?`: boolean, `description?`: string, `required?`: boolean, `multiple?`: boolean, `unique?`: boolean, `hidden?`: boolean, `options?`: list\|string, `reference_object_type_id?`: integer, `reference_type_id?`: integer, `aql_filter?`: string, `groups?`: list\|string, `regex?`: string, `suffix?`: string, `summable?`: boolean, `include_child_types?`: boolean | Change an attribute definition (name, cardinality, options, reference filter...). Unmentioned settings are kept. |
| `assets_delete_attribute` ✎ | `attribute_id`: integer | PERMANENTLY delete an attribute definition and its values on every object. |
| `assets_list_statuses` | `schema_id?`: integer, `name_contains?`: string, `offset?`: integer, `limit?`: integer | Object statuses (global ones, plus schema-specific when schema_id is given) with category active/inactive/pending. |
| `assets_create_status` ✎ | `name`: string, `category`: active\|inactive\|pending, `schema_id?`: integer, `description?`: string | Create an object status, global or for one schema. |
| `assets_update_status` ✎ | `status_id`: integer, `name?`: string, `category?`: active\|inactive\|pending, `description?`: string | Rename or recategorise an object status. |
| `assets_delete_status` ✎ | `status_id`: integer | Delete an object status (objects using it lose that status value). |

### Jira Assets — objects, AQL, history

| Tool | Arguments | Description |
|---|---|---|
| `assets_search` | `aql`: string, `schema_id?`: integer, `attributes?`: list\|string, `page?`: integer, `limit?`: integer, `order_by_attribute_id?`: integer, `descending?`: boolean | Search objects with AQL, e.g. objectType = "Laptop" AND Owner = ivan, or objectSchemaId = 3 AND Status = Active. Rows show key, label, type and attributes (pass `attributes` to show only some, or attributes=[] for none). Paged with page/limit; total = all matches. |
| `assets_validate_aql` | `aql`: string | Check an AQL query for syntax errors without running it. |
| `assets_get_object` | `object`: integer\|string | One object with all attribute values by name (references shown as object keys). |
| `assets_create_object` ✎ | `object_type`: integer\|string, `schema_id?`: integer, `attributes`: object\|string | Create an object. object_type: id, or name together with schema_id. attributes by name; required attributes (see assets_list_attributes) must be set. |
| `assets_update_object` ✎ | `object`: integer\|string, `attributes`: object\|string | Set attribute values of an object (only the attributes given change; null clears one). |
| `assets_delete_object` ✎ | `object`: integer\|string | PERMANENTLY delete an object (references to it are removed). Consider assets_archive_object instead. |
| `assets_archive_object` ✎ | `object`: integer\|string, `archived?`: boolean | Archive (archived=true) or restore (archived=false) an object. Assets 10.x+ (JSM 5.x+). |
| `assets_object_history` | `object`: integer\|string, `limit?`: integer | Change history of an object: when, who, which attribute, old → new. |
| `assets_object_references` | `object`: integer\|string | How many objects reference this object and which it references, per reference type. |
| `assets_object_issues` | `object`: integer\|string, `limit?`: integer | Jira issues connected to an object (via Assets custom fields). |
| `assets_object_comments` | `object`: integer\|string, `oldest?`: boolean, `offset?`: integer, `limit?`: integer | Comments on an object, newest first (oldest=true for chronological order). |
| `assets_add_object_comment` ✎ | `object`: integer\|string, `comment`: string, `role?`: integer | Add a comment to an object (role 0 = visible to all users with object access). |
| `assets_object_attachments` | `object`: integer\|string, `offset?`: integer, `limit?`: integer | Attachments of an object: id, filename, size, author, created. |
| `assets_bulk_update` ✎ | `aql`: string, `attributes`: object\|string, `max_objects?`: integer | Apply the same attribute changes to every object matching an AQL query (max `max_objects`, default 50). The dry run lists the matched objects; nothing is changed until dry_run=false. |

### Confluence admin — system

| Tool | Arguments | Description |
|---|---|---|
| `confluence_server_info` | — | Confluence version, build number, base URL and server time. |
| `confluence_instance_metrics` | — | Instance size: number of spaces, pages, users and other content counts. |
| `confluence_cluster_nodes` | — | Data Center cluster nodes and their status. |
| `confluence_access_mode` | — | Read-only mode status (READ_WRITE or READ_ONLY, e.g. during maintenance). |
| `confluence_list_long_tasks` | `offset?`: integer, `limit?`: integer | Long-running tasks (space deletion/export, reindex, ...) with progress and status. |
| `confluence_get_long_task` | `task_id`: string | One long-running task: percentage complete, elapsed time, messages, success flag. |
| `confluence_reindex_status` | — | Status of the site reindex (legacy prototype API, still shipped in Confluence 9). |
| `confluence_start_reindex` ✎ | — | Rebuild the whole search index. Search results are incomplete until it finishes. |

### Confluence admin — users and groups

| Tool | Arguments | Description |
|---|---|---|
| `confluence_find_users` | `query`: string, `limit?`: integer | Search users by name or username fragment. |
| `confluence_get_user` | `username`: string, `include_groups?`: boolean | One user (username, key, display name, e-mail, status) with group memberships. |
| `confluence_list_groups` | `offset?`: integer, `limit?`: integer | Groups (server-side paging). |
| `confluence_get_group_members` | `group`: string, `offset?`: integer, `limit?`: integer | Members of a group (server-side paging). |
| `confluence_create_user` ✎ | `username`: string, `full_name`: string, `email`: string, `password?`: string, `notify?`: boolean | Create a user in the internal directory. |
| `confluence_set_user_enabled` ✎ | `username`: string, `enabled`: boolean | Enable or disable a user (disabled users cannot log in and do not use a license). |
| `confluence_create_group` ✎ | `name`: string | Create a group. |
| `confluence_delete_group` ✎ | `name`: string | Delete a group (space permissions granted to it are removed). |
| `confluence_add_user_to_group` ✎ | `username`: string, `group`: string | Add a user to a group. |
| `confluence_remove_user_from_group` ✎ | `username`: string, `group`: string | Remove a user from a group. |

### Confluence admin — spaces and permissions

| Tool | Arguments | Description |
|---|---|---|
| `confluence_list_spaces` | `type?`: global\|personal, `status?`: current\|archived, `name_contains?`: string, `offset?`: integer, `limit?`: integer | Spaces with key, name, type (global/personal) and status (current/archived). |
| `confluence_get_space` | `space_key`: string | One space with description, homepage and creator. |
| `confluence_get_space_permissions` | `space_key`: string, `subject_type?`: user\|group\|anonymous, `subject?`: string | Space permissions as operation:target per subject (all subjects, or one user/group/anonymous). Use it to answer 'who can administer / delete in space X'. |
| `confluence_grant_space_permissions` ✎ | `space_key`: string, `subject_type`: user\|group\|anonymous, `subject?`: string, `operations`: list\|string | Grant space permissions to a user, group or anonymous. operations: list of 'operation:target', e.g. read:space, create:page, delete:attachment, administer:space. Operations: read, create, delete, export, administer, restrict, delete_own, delete_mail, purge, restore. |
| `confluence_revoke_space_permissions` ✎ | `space_key`: string, `subject_type`: user\|group\|anonymous, `subject?`: string, `operations`: list\|string | Revoke space permissions ('operation:target' list) from a user, group or anonymous. |
| `confluence_get_global_permissions` | `subject_type`: user\|group\|anonymous\|unlicensed, `subject?`: string | Global permissions (use / create space / administer / system administer...) of a user, group, anonymous or unlicensed users. |
| `confluence_archive_space` ✎ | `space_key`: string | Archive a space (hidden from navigation and search by default; reversible in Space tools). |
| `confluence_delete_space` ✎ | `space_key`: string | Permanently delete a space and all its content. Runs as a long task: follow it with confluence_get_long_task. |
| `confluence_get_space_categories` | `space_key`: string, `max_categories?`: integer | Read team-prefixed categories attached to a Confluence space, with explicit paging completeness. |
| `confluence_add_space_category` ✎ | `space_key`: string, `name`: string | Add a team-prefixed category to a space without replacing existing categories. |
| `confluence_find_spaces_by_group` | `group`: string, `type?`: global\|personal, `status?`: current\|archived, `max_spaces?`: integer | Audit spaces for exact direct group permissions; only explicit read:space grants are selected. |

### Confluence — pages and search

| Tool | Arguments | Description |
|---|---|---|
| `confluence_search` | `query`: string, `spaces?`: list\|string, `include_excerpt?`: boolean, `offset?`: integer, `limit?`: integer | Search content with plain text (siteSearch) or CQL (e.g. type=page AND space=DOC AND title~"plan"). Rows: id \| title \| type \| space \| updated. Excerpts only with include_excerpt=true. |
| `confluence_get_page` | `page?`: string, `title?`: string, `space_key?`: string, `body_format?`: markdown\|storage\|none | One page by id, URL or tiny link (page), or by exact title + space_key. Metadata plus the body as Markdown (body_format=storage for raw XHTML, none for metadata only). |
| `confluence_get_page_children` | `page`: string, `offset?`: integer, `limit?`: integer | Direct child pages of a page: id \| title \| version \| updated (server-side paging). |
| `confluence_get_space_page_tree` | `space_key`: string, `limit?`: integer | All pages of a space as an indented tree (`id title`, two spaces per level), up to `limit` pages. |
| `confluence_create_page` ✎ | `space_key`: string, `title`: string, `parent?`: string, `content?`: string, `content_file?`: string, `content_format?`: markdown\|storage | Create a page from Markdown (or storage XHTML) in a space, optionally under a parent page. |
| `confluence_update_page` ✎ | `page`: string, `title?`: string, `parent?`: string, `if_version?`: integer, `minor_edit?`: boolean, `version_comment?`: string, `content?`: string, `content_file?`: string, `content_format?`: markdown\|storage | Replace a page body (Markdown or storage). Pass if_version from the last read to refuse overwriting a newer edit (error StaleVersion, exit 5). title/parent are optional and keep the current values by default. |
| `confluence_update_page_section` ✎ | `page`: string, `heading`: string, `new_content`: string, `content_format?`: markdown\|storage, `if_version?`: integer, `minor_edit?`: boolean, `version_comment?`: string | Replace the content under one heading (up to the next heading of the same or higher level) and keep the rest of the page untouched. heading matches the heading text exactly. |
| `confluence_delete_page` ✎ | `page`: string | Move a page to the space trash (restorable by a space admin; children are not deleted). |
| `confluence_move_page` ✎ | `page`: string, `target?`: string, `target_space_key?`: string, `position?`: append\|above\|below | Move a page under another page (position=append), next to it (above/below), or to a space root. DC has no REST endpoint for this: it calls the legacy /pages/movepage.action. |
| `confluence_get_page_history` | `page`: string, `version?`: integer, `body_format?`: markdown\|storage\|none, `offset?`: integer, `limit?`: integer | Without version: the version list (number \| when \| by \| message \| minor). With version: that historical version (metadata and body as Markdown, or body_format=storage\|none). |
| `confluence_get_page_diff` | `page`: string, `from_version`: integer, `to_version`: integer | Unified diff of two page versions, computed on their Markdown renderings (changed hunks only). |
| `confluence_get_page_restrictions` | `page`: string | View (read) and edit (update) restrictions of a page: users and groups; empty = not restricted. |
| `confluence_set_page_restrictions` ✎ | `page`: string, `read_users?`: list\|string, `read_groups?`: list\|string, `edit_users?`: list\|string, `edit_groups?`: list\|string | REPLACE all view/edit restrictions of a page with the given users (usernames) and groups. Omitting everything removes all restrictions. Read the current ones first with confluence_get_page_restrictions. |
| `confluence_copy_page` ✎ | `page`: string, `space_key`: string, `title`: string, `parent?`: string | Copy a page body to a new page (DC has no copy API: attachments, labels, properties and restrictions are not copied). |

### Confluence — comments

| Tool | Arguments | Description |
|---|---|---|
| `confluence_get_comments` | `page_id`: string, `location?`: footer\|inline\|resolved, `offset?`: integer, `limit?`: integer | Comments of a page (footer and inline, with replies) as Markdown: author, date, parent, inline selection, resolution. Server-side paging (offset/limit). |
| `confluence_get_inline_comments` | `page_id`: string, `offset?`: integer, `limit?`: integer | Inline comments of a page with the highlighted text they are anchored to (server-side paging). |
| `confluence_add_comment` ✎ | `page_id`: string, `body`: string, `body_format?`: markdown\|storage | Add a footer comment to a page or blog post. |
| `confluence_reply_to_comment` ✎ | `comment_id`: string, `body`: string, `body_format?`: markdown\|storage | Reply to an existing comment (threaded under it). |
| `confluence_add_inline_comment` ✎ | `page_id`: string, `body`: string, `body_format?`: markdown\|storage, `text_selection`: string, `match_count?`: integer, `match_index?`: integer | Add an inline comment anchored to text on the page. text_selection must match the page text exactly; when it occurs several times give match_count and the 0-based match_index. Server acceptance of inline properties over REST is not verified on every Confluence version — read back with confluence_get_inline_comments. |

### Confluence — labels

| Tool | Arguments | Description |
|---|---|---|
| `confluence_get_labels` | `content_id`: string, `prefix?`: global\|my\|team, `offset?`: integer, `limit?`: integer | Labels of a page, blog post or attachment (att… id). |
| `confluence_add_label` ✎ | `content_id`: string, `names`: list\|string, `prefix?`: global\|my\|team | Add one or more labels to a page, blog post or attachment (lowercase, no spaces). |

### Confluence — attachments

| Tool | Arguments | Description |
|---|---|---|
| `confluence_get_attachments` | `content_id`: string, `filename?`: string, `media_type?`: string, `offset?`: integer, `limit?`: integer | Attachments of a page: id, title, media type, size, version. Filters run server-side. |
| `confluence_upload_attachment` ✎ | `content_id`: string, `comment?`: string, `minor_edit?`: boolean, `file_path`: string | Upload a local file to a page. An existing attachment with the same name gets a new version. |
| `confluence_upload_attachments` ✎ | `content_id`: string, `comment?`: string, `minor_edit?`: boolean, `file_paths`: list\|string | Upload several local files to a page (same name → new version). Per-file failures are reported. |
| `confluence_download_attachment` | `attachment_id`: string, `output_dir`: string | Download one attachment (att… id) into output_dir; returns the local path (max 50 MiB). |
| `confluence_download_content_attachments` | `content_id`: string, `output_dir`: string, `media_type?`: string, `limit?`: integer | Download all (or one media type of) attachments of a page into output_dir; returns local paths. |
| `confluence_get_page_images` | `content_id`: string, `output_dir`: string, `limit?`: integer | Download the image attachments of a page into output_dir (to view them with the Read tool). Stops after `limit` images; scans at most 1000 attachments (image types cannot be filtered server-side). |
| `confluence_delete_attachment` ✎ | `attachment_id`: string | Delete an attachment (att… id) from its page. |

### Both products — apps (UPM)

| Tool | Arguments | Description |
|---|---|---|
| `atlassian_list_plugins` | `product`: jira\|confluence, `include_system?`: boolean, `with_licenses?`: boolean, `name_contains?`: string, `offset?`: integer, `limit?`: integer | Installed apps: key, name, version, enabled, vendor. Marketplace/admin-installed only by default (include_system=true adds bundled plugins); with_licenses=true adds license validity, type and maintenance expiry. |
| `atlassian_get_plugin` | `product`: jira\|confluence, `plugin_key`: string | One app with its modules (enabled state per module) and license. |
| `atlassian_set_plugin_enabled` ✎ | `product`: jira\|confluence, `plugin_key`: string, `enabled`: boolean | Enable or disable an app. Disabling a system plugin can break the instance. |
| `atlassian_get_safe_mode` | `product`: jira\|confluence | Whether UPM safe mode (all user-installed apps disabled) is on. |

### Both products — audit log

| Tool | Arguments | Description |
|---|---|---|
| `atlassian_audit_events` | `product`: jira\|confluence, `from?`: string, `to?`: string, `search?`: string, `categories?`: list\|string, `actions?`: list\|string, `user_ids?`: list\|string, `affected_object?`: string, `limit?`: integer, `page_cursor?`: string, `raw?`: boolean | Audit log events, newest first: who changed what (users, groups, permissions, schemes, apps, settings). Filter by time range (ISO 8601), free-text search, categories, actions, author user ids, affected object. Page with page_cursor from the previous result. |
| `atlassian_audit_settings` | `product`: jira\|confluence | Audit configuration: retention period, coverage level per area, excluded (denylisted) actions. |

<!-- tools:end -->

## Argument notes

- **Jira users** are identified by username or by user key (`JIRAUSER10000`); the key is detected automatically.
- **Jira permission holders** (`jira_add_permission_grant`): `holder_type` + `holder_parameter` —
  `group`/group name, `projectRole`/role id (from `jira_list_roles`), `user`/username,
  `applicationRole`/application key (empty = any logged-in user), `userCustomField`/`groupCustomField`/`customfield_N`,
  and `projectLead`, `reporter`, `assignee`, `anyone` without a parameter.
- **Confluence space permissions** take `operations` as `operation:target` items, e.g.
  `read:space`, `administer:space`, `create:page`, `create:blogpost`, `create:comment`, `create:attachment`,
  `delete:page`, `delete_own:space`, `restrict:page`, `export:space`, `delete_mail:space`.
  `subject_type=user` takes a user key or username, `group` a group name, `anonymous` no subject.
- **Workflow scheme changes** (`jira_set_workflow_scheme_mapping`, `jira_delete_workflow_scheme_mapping`,
  `jira_set_workflow_scheme_default`): `issue_type_id` is the id from `jira_list_issue_types`, `workflow` the exact
  name from `jira_list_workflows`. A scheme used by projects cannot be edited directly: pass `update_draft_if_needed=true`
  to write the change to its draft (`jira_get_workflow_scheme draft=true` shows it), then publish the draft in the Jira
  UI, which migrates issue statuses; the REST API does not publish drafts.
- **Workflow scheme limits in Jira DC REST**: there is no endpoint to list every scheme, to assign a scheme to a
  project, or to publish a draft. `jira_list_workflow_schemes` and `jira_find_workflow_usage` therefore scan each
  project's scheme (one request per project, `scan_projects` caps it and `truncatedScan` reports a partial scan), so
  schemes no project uses and drafts are not seen. Projects on Jira's default scheme show it with id null.
  `forbiddenProjects` counts 403s (no access, or Jira throttling the burst); a 404 for every project means the
  endpoint is not available on this Jira version.
- **Issue type schemes** (`jira_add_issue_types_to_scheme`): Jira replaces the whole scheme on update, so the tool
  reads it and sends the current issue types plus the new ones, keeping name, description and default type. A plan built
  from it drifts if someone changes the scheme before `apply`; re-plan then.
- **Reindex types** (`jira_start_reindex`): `BACKGROUND_PREFERRED` (default), `BACKGROUND`, `FOREGROUND` (locks Jira).
- **Audit log** (`atlassian_audit_events`): `from`/`to` are ISO-8601 timestamps; page with `page_cursor`
  (the `nextPageCursor` of the previous result) until `lastPage` is true.

- **Internal and plugin APIs** (verified on Jira 11.3.6; changes refused on other versions with `Unsupported`):
  `jira_create_field_context` / `jira_update_field_context` / `jira_delete_field_context` (`/rest/internal/2/field/*/context`),
  `jira_set_board_detail_fields` / `jira_add_board_detail_field` / `jira_remove_board_detail_field` (Jira Software
  `/rest/greenhopper/1.0/detailviewfield`). Reads that use them: `jira_get_field_configuration`
  (`/rest/internal/2/fieldConfiguration`, "Where is my field"), `jira_get_screen_usage` ("Where is my field",
  `/rest/projectconfig/1`), `jira_get_board_configuration` (`rapidviewconfig/editmodel`). Screen field changes and
  custom field creation use the public REST API.
- **Field references**: `field_id` in screen, context and placement tools takes `customfield_N`, a system field id or the
  exact field name, also of a field that an earlier item of the same plan creates. Context changes for a field given by
  name do not include the stored context in drift detection.
- **JSM request types**: create and delete use the public Service Desk API. Changes, portal groups and forms use JSM's
  internal API (JSM 11.3.x only). Portal visibility is group membership: a request type in no group is hidden;
  `jira_set_request_type_hidden hidden=false` needs `group`. A field Jira requires can be hidden only with a `preset`
  (the preset call carries Jira's XSRF token).
- **JSM SLAs** (`jira_create_sla`, `jira_update_sla`): conditions by name (`jira_get_sla_conditions`: start/stop
  events, pause conditions); `goals` is a JSON list in order `[{jql?, target, calendar?}]`, target like `4h`, `2d 4h`
  (a day is 24 h) or minutes; the goal without `jql` (all remaining issues) goes last; `calendar` is a name, an id, or
  `24x7` (the built-in Default 24/7 calendar). Changing conditions or goals makes JSM recalculate the SLA on existing
  requests; deleting an SLA loses its recorded values. Calendars: `working_hours=24x7` or e.g. `mon-fri 09:00-18:00`;
  a calendar used by goals cannot be deleted. Internal JSM API, JSM 11.3.x only.
- **Select options** (`jira_set_custom_field_options`): `options` is a comma list or JSON `[{value, id?, disabled?}]` in
  order. Only a context without options is written through the API (Jira's options resource sets names for a new
  field's context, chosen by project + issue type). For a context that has options the dry run is a manual change: steps
  (add, rename by id, order, disable, enable) and the options page link; re-running verifies. Options are never deleted;
  options marked disabled are created enabled and must be disabled in the UI.
- **Screen positions** are 1-based within the tab. Adding a field already on another tab of the screen is an error.
- **Board Detail View**: `fields` is the complete ordered list; `add_fields` go last, `remove_fields` leave the others in
  place. Fields must be ones the board's Detail View offers (`jira_get_board_configuration` → detailView).
- **Field descriptions in a field configuration** are prepared, not sent: Jira serves that admin form only after websudo
  re-authentication, which a token cannot pass. The dry run gives the edit link; re-running reports `ALREADY-SATISFIED`
  once the description was entered.
- **Plans**: `apply` saves each item's outcome in the plan file; `plan FILE` shows them with a "remaining" count, and a
  second `apply FILE` runs only items that are not done or already satisfied. `jira_add_field_to_screens --plan` adds one
  item per placement.

## Where the endpoints come from

The REST paths, HTTP methods, query parameters and request bodies were read from the compiled
JAX-RS resources and REST clients of these versions:

| Area | Source |
|---|---|
| Jira `/rest/api/2/*` | `jira-rest-plugin` 11.3.2 (`@Path`, `@QueryParam`, request beans such as `UserWriteBean`, `ActorInputBean`, `ReindexBean`) |
| Confluence `/rest/api/*` | `confluence-rest-client` 10.2.17 (`RemotePersonServiceImpl`, `RemoteGroupServiceImpl`, `RemoteSpacePermissionServiceImpl`, `RemoteGlobalPermissionServiceImpl`, ...) and `confluence-java-api` 9.2.16 (`UserDetailsForCreation`, `OperationDescription`, `OperationKey`) |
| Confluence `/rest/prototype/1/*` | `confluence-rest-plugin-jackson2` 9.2.16 (`IndexResource`, `PrototypeSearchService`) |
| Assets `/rest/insight/1.0/*` | `insight-rest-api` / `insight` 21.3.2 (`ObjectResource`, `AQLResource`, `ObjectSchemaResource`, `ObjectTypeResource`, `ObjectTypeAttributeResource`, `StatusTypeResource`; beans `ObjectInEntry`, `ObjectTypeAttributeInEntry`, enums `ObjectTypeAttributeBean.Type/DefaultType`); `/iql/objects` fallback from `insight` 11.0 |
| `/rest/auditing/1.0/*` | `atlassian-audit-plugin` 3.1.19 |
| `/rest/plugins/1.0/*` | `atlassian-universal-plugin-manager-plugin` 8.0.25 (`PluginResource`, `MediaTypes`) |

Older Data Center versions may lack some endpoints, for example Jira `/customFields` usage stats,
`/issuetypescheme` (Jira 10+) and Confluence `/rest/api/admin/*` (Confluence 7.x+). A tool then
returns `HTTP404`.
