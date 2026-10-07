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
| `ATLASSIAN_MAX_RESPONSE_CHARS` | Max printed output, default 25000 (`0` disables) |
| `ATLASSIAN_MAX_CONCURRENCY` | Max requests in flight per product, default 8; halved after a 429 (not below 2), restored after successes |

## CLI

Commands are in SKILL.md. Options starting with `--` are global (`--format=compact|json|full`, `--fields=a,b|-c`,
`--out=FILE`, `--plan=FILE`, `--only=N,M`); everything else is a tool argument, given as text and converted by the
tool's argument types (`name=2025` stays text, `limit=20` becomes a number), or a whole JSON object `'{"key": "value"}'`.
Compact output drops fields an agent does not use (`self`, avatar URLs, `_links`, empty values), flattens `{name: …}`
wrappers and shortens timestamps; `--format=full` returns the tool result untouched.

## Typical tasks

| Question | Tools |
|---|---|
| Who can do X in project P? | `jira_get_project_config` → `jira_get_permission_scheme scheme_id=… permission=X` → `jira_get_project_roles` / `jira_get_group_members` |
| Offboard a user | `jira_get_user` → `jira_set_user_active active=false` (+ `jira_kill_user_sessions`); `confluence_set_user_enabled enabled=false` |
| New issue type in a project's workflow | `jira_list_issue_types` → `jira_create_issue_type` → `jira_get_project_config` (issue type and workflow scheme ids) → `jira_add_issue_types_to_scheme` → `jira_list_workflows name=…` → `jira_set_workflow_scheme_mapping` |
| Change a project's workflow scheme | `jira_get_project_config` → `jira_get_workflow_scheme` → `jira_set_workflow_scheme_mapping` / `jira_delete_workflow_scheme_mapping` / `jira_set_workflow_scheme_default` |
| Workflow schemes in use / where a workflow is used | `jira_list_workflow_schemes --out=…`; `jira_find_workflow_usage workflow=…` (delegate on large instances) |
| Swap a workflow in a scheme | `jira_find_workflow_usage` → `jira_replace_workflow_in_scheme` (active scheme: `update_draft_if_needed=true` → `jira_compare_workflow_scheme_draft` → publish in the UI) |
| Read or compare workflows | `jira_get_workflow project=… issue_type=…` (or `workflow=…`, `draft=true`) → `jira_compare_workflows first_workflow=… second_workflow=…` |
| Change a workflow (statuses, transitions) | `jira_add_workflow_status` / `jira_add_workflow_transition` / `jira_update_workflow_transition` / `jira_remove_workflow_status` … (one plan; active workflows change their draft) → after `apply`, a second plan with `jira_publish_workflow_draft` (dry run shows the differences and projects) or `jira_discard_workflow_draft` |
| New workflow scheme for a project | `jira_create_workflow_scheme copy_from_scheme_id=…` → mappings (scheme by name in the same plan) → `jira_assign_project_scheme scheme_type=workflow` (manual change: link, then re-run to verify) |
| Assign schemes to a project | `jira_assign_project_scheme project_key=… scheme_type=notification\|issue_type\|workflow\|issue_type_screen\|field_configuration scheme_id=…` (notification and issue type via REST; the others, or an issue type change that needs a migration, as a manual change) |
| Remove issue types / delete a version | `jira_remove_issue_types_from_scheme` (default and last type refused); `jira_delete_version` (dry run shows issue counts; `move_fix_to`/`move_affected_to`; irreversible) |
| New permission scheme like another | `jira_create_permission_scheme name=… copy_from=…` (grants copied and read back); screens: `jira_create_screen` (manual change, verified on re-run) |
| Saved filters and dashboards | `jira_list_filters` (favourites only on this Jira) → `jira_get_filter` → `jira_create_filter`/`jira_update_filter` (JQL checked by Jira) / `jira_add_filter_share`; `jira_list_dashboards` |
| Remove page labels | `confluence_remove_label` (one item per label; `team:` categories refused); category removal: `confluence_remove_space_category` answers Unsupported on this Confluence |
| Where is a screen used | `jira_get_screen_usage screen_id=…` (scan; `--out` or a subagent on large instances) |
| Remove or add fields on a screen | `jira_get_screen` → `jira_get_screen_usage` → `jira_remove_screen_field` / `jira_add_screen_field` / `jira_move_screen_field` (one plan item each) |
| New custom field for a project | `jira_create_custom_field` → `jira_update_field_context context_id=default project_ids=…` → `jira_add_field_to_screens` — all with `--plan`, the field by name, then `apply` |
| New JSM request type on the portal | `jira_create_request_type` → `jira_add_request_type_to_group` → `jira_add_request_type_field` / `jira_hide_request_type_field preset=…` (one plan; the request type by name) → `jira_get_request_type_form` |
| ScriptRunner inventory | `jira_list_scriptrunner_items type=job\|listener\|field\|fragment\|endpoint\|resource\|registry` → `jira_get_scriptrunner_item` |
| Pause a ScriptRunner job or fragment | `jira_update_scriptrunner_item type=job item=… disabled=true` (notes: `notes=…`) |
| Restore ScriptRunner scripts locally | `jira_list_scriptrunner_items type=registry` → `jira_export_scriptrunner_scripts root=project-a output_dir=./project-a` (re-run: ALREADY-SATISFIED; CONFLICT → review, then `overwrite=true`) |
| Sync a project folder with ScriptRunner scripts | `jira_export_scriptrunner_scripts root=project-a output_dir=./project-a` (baseline manifest) → `jira_sync_scriptrunner_scripts root=project-a local_dir=./project-a` (preview: PUSH / PULL / CONFLICT / DELETED-*) → `dry_run=false` (checklist, one item per file; pushes on Jira 10.x/11.x + SR 9.x/10.x with `script-root-write` enabled). CONFLICT: make the local file final, then sync again; deletions are reported only; add `*.bak-*` to `.gitignore` |
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

## Read bounds

Compact cells and long text carry cut markers; JSON retains columns but respects tool-level body and list bounds. `ATLASSIAN_MAX_TEXT_CHARS` sets the compact text cap (default 8,000). Use `full_lists=true` for membership/sharing previews. Page reads accept `outline`, `section` and `max_chars` (default 20,000); issue reads accept `max_description_chars` (default 8,000, 0 omits). `fields=*all` is supported only by `jira_get_issue`, not issue lists.

Assets search defaults to 20 objects and previews 20 attributes; name `attributes` to select them. Custom field options without `context` return counts; with `context`, page via `limit`/`offset`. Audit `raw=true` requires `limit<=50`. Request forms show addable fields only with `include_addable=true`; space discovery audit rows require `include_audit=true`. Comments use storage Markdown and `max_body_chars` (default 2,000). Markdown page writes reject code cut markers: read full storage or a smaller section first. Expanded JSON reads can require `--out`.

<!-- tools:start -->
301 tools, 163 of them write tools (✎; they also take `dry_run`, default true). Arguments and descriptions: run `describe <tool>`; search by concept with `list <text>`.

### Jira admin — system

`jira_server_info`, `jira_cluster_nodes`, `jira_index_summary`, `jira_reindex_status`, `jira_start_reindex` ✎, `jira_get_application_properties`, `jira_get_advanced_settings`, `jira_set_application_property` ✎, `jira_application_roles`

### Jira admin — users and groups

`jira_find_users`, `jira_get_user`, `jira_create_user` ✎, `jira_update_user` ✎, `jira_set_user_active` ✎, `jira_delete_user` ✎, `jira_set_user_application` ✎, `jira_kill_user_sessions` ✎, `jira_find_groups`, `jira_get_group_members`, `jira_create_group` ✎, `jira_delete_group` ✎, `jira_add_user_to_group` ✎, `jira_remove_user_from_group` ✎

### Jira admin — projects and roles

`jira_list_projects`, `jira_get_project_config`, `jira_list_roles`, `jira_get_project_roles`, `jira_add_project_role_actors` ✎, `jira_remove_project_role_actor` ✎, `jira_set_project_permission_scheme` ✎, `jira_archive_project` ✎, `jira_restore_project` ✎

### Jira admin — schemes and workflows

`jira_list_permission_schemes`, `jira_get_permission_scheme`, `jira_add_permission_grant` ✎, `jira_delete_permission_grant` ✎, `jira_list_notification_schemes`, `jira_get_notification_scheme`, `jira_list_issue_security_schemes`, `jira_get_issue_security_scheme`, `jira_list_workflows`, `jira_list_issue_types`, `jira_create_issue_type` ✎, `jira_list_issue_type_schemes`, `jira_get_issue_type_scheme`, `jira_add_issue_types_to_scheme` ✎

### Jira admin — workflow schemes

`jira_get_workflow_scheme`, `jira_set_workflow_scheme_mapping` ✎, `jira_delete_workflow_scheme_mapping` ✎, `jira_set_workflow_scheme_default` ✎, `jira_list_workflow_schemes`, `jira_find_workflow_usage`, `jira_create_workflow_scheme` ✎, `jira_update_workflow_scheme` ✎, `jira_delete_workflow_scheme` ✎, `jira_create_workflow_scheme_draft` ✎, `jira_delete_workflow_scheme_draft` ✎, `jira_compare_workflow_scheme_draft`, `jira_replace_workflow_in_scheme` ✎

### Jira admin — workflows (designer, drafts)

`jira_get_workflow`, `jira_compare_workflows`, `jira_add_workflow_status` ✎, `jira_update_workflow_status` ✎, `jira_remove_workflow_status` ✎, `jira_add_workflow_transition` ✎, `jira_update_workflow_transition` ✎, `jira_remove_workflow_transition` ✎, `jira_add_workflow_global_transition` ✎, `jira_remove_workflow_global_transition` ✎, `jira_publish_workflow_draft` ✎, `jira_discard_workflow_draft` ✎

### Jira admin — project scheme assignment

`jira_assign_project_scheme` ✎

### Jira admin — scheme, version, screen and permission scheme lifecycle

`jira_remove_issue_types_from_scheme` ✎, `jira_delete_version` ✎, `jira_create_permission_scheme` ✎, `jira_create_screen` ✎

### Jira — filters and dashboards

`jira_list_filters`, `jira_get_filter`, `jira_create_filter` ✎, `jira_update_filter` ✎, `jira_delete_filter` ✎, `jira_add_filter_share` ✎, `jira_remove_filter_share` ✎, `jira_list_dashboards`, `jira_get_dashboard`

### Jira admin — custom fields

`jira_list_custom_fields`, `jira_get_field_contexts`, `jira_get_field_screens`, `jira_delete_custom_fields` ✎, `jira_list_fields`, `jira_create_custom_field` ✎, `jira_create_field_context` ✎, `jira_update_field_context` ✎, `jira_delete_field_context` ✎, `jira_add_field_to_screens` ✎, `jira_get_custom_field_options`, `jira_set_custom_field_options` ✎

### Jira admin — field configurations

`jira_get_field_configuration`, `jira_update_field_description` ✎

### Jira admin — screens

`jira_list_screens`, `jira_get_screen`, `jira_get_screen_usage`, `jira_add_screen_field` ✎, `jira_remove_screen_field` ✎, `jira_move_screen_field` ✎

### Jira — issues, search, comments, transitions

`jira_get_issue`, `jira_search`, `jira_get_project_issues`, `jira_create_issue` ✎, `jira_batch_create_issues` ✎, `jira_update_issue` ✎, `jira_assign_issue` ✎, `jira_delete_issue` ✎, `jira_get_field_options`, `jira_get_comments`, `jira_add_comment` ✎, `jira_edit_comment` ✎, `jira_get_transitions`, `jira_transition_issue` ✎

### Jira — project metadata and versions

`jira_get_project_issue_types`, `jira_get_create_fields`, `jira_get_project_fields`, `jira_get_project_versions`, `jira_get_project_components`, `jira_create_version` ✎, `jira_batch_create_versions` ✎, `jira_update_version` ✎

### Jira — boards and sprints

`jira_get_agile_boards`, `jira_get_board_issues`, `jira_get_sprints_from_board`, `jira_get_sprint_issues`, `jira_create_sprint` ✎, `jira_update_sprint` ✎, `jira_add_issues_to_sprint` ✎, `jira_move_issues_to_backlog` ✎

### Jira — board configuration

`jira_get_board_configuration`, `jira_set_board_detail_fields` ✎, `jira_add_board_detail_field` ✎, `jira_remove_board_detail_field` ✎

### Jira — links and epics

`jira_get_link_types`, `jira_link_to_epic` ✎, `jira_create_issue_link` ✎, `jira_create_remote_issue_link` ✎, `jira_remove_issue_link` ✎, `jira_get_issue_links`

### Jira — worklog

`jira_get_worklog`, `jira_add_worklog` ✎

### Jira — attachments

`jira_get_attachments`, `jira_download_attachments`, `jira_get_issue_images`, `jira_upload_attachments` ✎, `jira_delete_attachment` ✎

### Jira — assignable users and watchers

`jira_search_assignable_users`, `jira_get_issue_watchers`, `jira_add_watcher` ✎, `jira_remove_watcher` ✎

### Jira — dates, SLA, development info, project analysis

`jira_get_issue_dates`, `jira_get_issue_sla`, `jira_get_issue_development_info`, `jira_get_issues_development_info`, `jira_get_project_epic_hierarchy`, `jira_get_cross_project_dependencies`

### Jira Service Management

`jira_get_service_desk_for_project`, `jira_get_service_desk_queues`, `jira_get_queue_issues`, `jira_get_request_types`, `jira_get_request_type_fields`, `jira_create_customer_request` ✎

### Jira Service Management — request types and forms

`jira_create_request_type` ✎, `jira_update_request_type` ✎, `jira_delete_request_type` ✎, `jira_set_request_type_hidden` ✎, `jira_add_request_type_to_group` ✎, `jira_remove_request_type_from_group` ✎, `jira_move_request_type_in_group` ✎, `jira_get_request_type_form`, `jira_add_request_type_field` ✎, `jira_remove_request_type_field` ✎, `jira_move_request_type_field` ✎, `jira_update_request_type_field` ✎, `jira_hide_request_type_field` ✎, `jira_show_request_type_field` ✎

### Jira Service Management — queues

`jira_create_queue` ✎, `jira_update_queue` ✎, `jira_delete_queue` ✎, `jira_move_queue` ✎

### Jira Service Management — SLAs and calendars

`jira_get_sla_configuration`, `jira_get_sla_conditions`, `jira_list_sla_calendars`, `jira_create_sla` ✎, `jira_update_sla` ✎, `jira_delete_sla` ✎, `jira_create_sla_calendar` ✎, `jira_update_sla_calendar` ✎, `jira_delete_sla_calendar` ✎

### ScriptRunner for Jira (unofficial endpoints)

`jira_list_scriptrunner_items`, `jira_get_scriptrunner_item`, `jira_update_scriptrunner_item` ✎

### ScriptRunner for Jira — Script Root files to local disk

`jira_get_scriptrunner_script`, `jira_export_scriptrunner_scripts`

### ScriptRunner for Jira — Script Root ↔ local folder sync

`jira_sync_scriptrunner_scripts` ✎, `jira_push_scriptrunner_script` ✎, `jira_pull_scriptrunner_script` ✎

### Jira Assets — schemas, object types, attributes, statuses

`assets_list_schemas`, `assets_get_schema`, `assets_create_schema` ✎, `assets_update_schema` ✎, `assets_delete_schema` ✎, `assets_get_schema_attributes`, `assets_get_reference_types`, `assets_get_object_type`, `assets_create_object_type` ✎, `assets_update_object_type` ✎, `assets_delete_object_type` ✎, `assets_list_attributes`, `assets_create_attribute` ✎, `assets_update_attribute` ✎, `assets_delete_attribute` ✎, `assets_list_statuses`, `assets_create_status` ✎, `assets_update_status` ✎, `assets_delete_status` ✎

### Jira Assets — objects, AQL, history

`assets_search`, `assets_validate_aql`, `assets_get_object`, `assets_create_object` ✎, `assets_update_object` ✎, `assets_delete_object` ✎, `assets_archive_object` ✎, `assets_object_history`, `assets_object_references`, `assets_object_issues`, `assets_object_comments`, `assets_add_object_comment` ✎, `assets_object_attachments`, `assets_bulk_update` ✎

### Confluence admin — system

`confluence_server_info`, `confluence_instance_metrics`, `confluence_cluster_nodes`, `confluence_access_mode`, `confluence_list_long_tasks`, `confluence_get_long_task`, `confluence_reindex_status`, `confluence_start_reindex` ✎

### Confluence admin — users and groups

`confluence_find_users`, `confluence_get_user`, `confluence_list_groups`, `confluence_get_group_members`, `confluence_create_user` ✎, `confluence_set_user_enabled` ✎, `confluence_create_group` ✎, `confluence_delete_group` ✎, `confluence_add_user_to_group` ✎, `confluence_remove_user_from_group` ✎

### Confluence admin — spaces and permissions

`confluence_list_spaces`, `confluence_get_space`, `confluence_get_space_permissions`, `confluence_grant_space_permissions` ✎, `confluence_revoke_space_permissions` ✎, `confluence_get_global_permissions`, `confluence_archive_space` ✎, `confluence_delete_space` ✎, `confluence_get_space_categories`, `confluence_add_space_category` ✎, `confluence_remove_space_category` ✎, `confluence_find_spaces_by_group`

### Confluence — pages and search

`confluence_search`, `confluence_get_page`, `confluence_get_page_children`, `confluence_get_space_page_tree`, `confluence_create_page` ✎, `confluence_update_page` ✎, `confluence_update_page_section` ✎, `confluence_delete_page` ✎, `confluence_move_page` ✎, `confluence_get_page_history`, `confluence_get_page_diff`, `confluence_get_page_restrictions`, `confluence_set_page_restrictions` ✎, `confluence_copy_page` ✎

### Confluence — comments

`confluence_get_comments`, `confluence_get_inline_comments`, `confluence_add_comment` ✎, `confluence_reply_to_comment` ✎, `confluence_add_inline_comment` ✎

### Confluence — labels

`confluence_get_labels`, `confluence_add_label` ✎, `confluence_remove_label` ✎

### Confluence — attachments

`confluence_get_attachments`, `confluence_upload_attachment` ✎, `confluence_upload_attachments` ✎, `confluence_download_attachment`, `confluence_download_content_attachments`, `confluence_get_page_images`, `confluence_delete_attachment` ✎

### Both products — apps (UPM)

`atlassian_list_plugins`, `atlassian_get_plugin`, `atlassian_set_plugin_enabled` ✎, `atlassian_get_safe_mode`

### Both products — audit log

`atlassian_audit_events`, `atlassian_audit_settings`

<!-- tools:end -->

## Argument notes

- **Canonical names, old names as aliases:** `field` (alias `field_id`), `issue_type`/`issue_types`/`default_issue_type`
  (aliases `issue_type_id`, `issue_type_ids`, `default_issue_type_id`), `user` for an existing user (alias `username`),
  `project_key` (alias `project`), `service_desk` (alias `service_desk_id`), `key` for an application property (alias `id`).
  `describe` shows the aliases. Passing an alias and its canonical name with different values is an error. Fields,
  issue types and service desks accept an id or an exact name (a project key for a service desk).
- **Workflow schemes by name:** `scheme_id` accepts an id or the exact name of a scheme that a project uses, or that
  an earlier item of the same plan created. An unknown name is pending in a dry run and fails on apply without sending.
  Issue types created earlier in a plan work the same way in `jira_add_issue_types_to_scheme` and
  `jira_set_workflow_scheme_mapping`.
- **Write safety:** user, group, project, permission, workflow scheme, Confluence space/user/label and Assets writes
  read the target first (already satisfied → nothing sent) and read it back afterwards (`VerificationError` with the
  observed state). Dry runs of these tools therefore read the instance. Writes that cannot be checked (comments,
  worklogs, attachments, issue creation, reindex starts, session kills, and writes not checked yet) say so in
  `describe`, and their dry run warns that a repeated apply sends the change again.
- **Drifted plan items** print a `re-plan:` line with the dry-run call that plans them again.
- **Manual changes:** when Jira offers no REST path (screen creation; workflow, issue type screen and field configuration
  scheme assignment; an issue type scheme change that needs an issue migration), the dry run is a `manual change` with
  the admin page link and nothing is sent. Make the change in the UI, then re-run the tool to verify it (already
  satisfied). A project's field configuration scheme cannot be read over REST, so that one stays unverified.
- **Irreversible deletes:** `jira_delete_version`, `jira_delete_filter`, `confluence_remove_label` remove data that the
  tools cannot restore; say "irreversible" before confirming. Filters report no favourite count on this Jira.

- **Jira users** are identified by username or by user key (`JIRAUSER10000`); the key is detected automatically.
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
- **Two kinds of drafts:** workflow drafts are changed by the workflow tools and published or discarded with
  `jira_publish_workflow_draft` / `jira_discard_workflow_draft`; workflow scheme drafts (`update_draft_if_needed=true`)
  are published only in the Jira UI, which migrates issues.
- **Workflows** use the workflow designer's internal resources (`/rest/workflowDesigner/1.0`), verified on Jira 11.3.x
  only (`Unsupported` elsewhere). Conditions, validators and post-functions are not readable through REST (counts only).
  A workflow is active when a scanned workflow scheme uses it; its changes go to its draft, which the first confirmed
  change creates. An incomplete scan (`scan_projects` too low, or 403s) refuses edits instead of guessing. Publishing
  never migrates issues: when Jira requires a migration, finish it in the UI. Statuses are global. Copying workflows
  and backups on publish are not available through REST.
- **Issue type schemes** (`jira_add_issue_types_to_scheme`): Jira replaces the whole scheme on update, so the tool
  sends the current issue types plus the new ones (rebuilt when applied, so several additions to one scheme fit in one
  plan) and reads the scheme back.
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
- **ScriptRunner** (unofficial endpoints of ScriptRunner's own admin UI): allowed on every Jira 10.x/11.x +
  ScriptRunner 9.x/10.x combination. Captured runtime evidence remains limited to exact pairs recorded in the
  support matrix; the broader allowance does not imply runtime verification. Other major versions, a disabled
  or missing ScriptRunner answer `Unsupported` before any
  ScriptRunner request. Outputs are allowlisted per type and redacted: scripts, script files, code references,
  conditions, SQL and credentials are never shown (the script registry shows file names and paths only).
  `jira_update_scriptrunner_item` changes only `disabled` (jobs, fragments, REST endpoints) and notes (jobs,
  listeners, fragments, REST endpoints) by sending the stored item back with that key changed, and fails with a
  `VerificationError` if anything else differs afterwards. Nothing is created, deleted or run; script fields and
  resources (their item carries the DB password) are read-only; Mail Handler and Behaviours are unsupported.
- **ScriptRunner Script Root files** (`jira_get_scriptrunner_script`, `jira_export_scriptrunner_scripts`) read files
  through the Script Editor's internal resources (`GET idea/scriptroots`, `GET idea/file`). They send only GETs and
  allow `script-root-read` on all Jira 10.x/11.x + ScriptRunner 9.x/10.x combinations; other majors answer
  `Unsupported`. Paths are relative to the Script Root. Absolute paths, `..`, `.` segments and directories are
  refused, and local symbolic links never redirect a write out of `output_dir`. Every registry directory is recreated,
  including empty directories. Files are written byte for byte
  (encoding, line endings, Unicode names), atomically. Results and the manifest carry only paths, sizes, SHA-256 and
  outcomes. Outcomes:
  - `WRITTEN`;
  - `ALREADY-SATISFIED`: identical file;
  - `CONFLICT`: differing local file, kept;
  - `REPLACED`: `overwrite=true`, after a `.bak-<timestamp>` backup;
  - `FAILED`: HTTP status or limit only.

  Limits: `max_files` (default 500, max 5000) is checked before any content is read. `max_total_bytes` (default
  20 MB, max 200 MB) is checked while the files are downloaded, before anything is written: over it, the export
  writes nothing (no files, no manifest). Local paths in the manifest are relative to the invocation working directory.
  Handling of restored content: SKILL.md, Writes.
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

## Codex

The CLI needs network access to Jira/Confluence: in Codex's default sandbox (no network) the call fails with
`NetworkError`; re-run it with sandbox escalation / approval, or the user enables network for the workspace. If the
confirmation dialog cannot open inside the sandbox (exit 13), run the write outside the sandbox (approval) or ask the
user to run the printed command. The Claude Code hook does not exist in Codex; the CLI dialog is the gate there.
Ask the user how to confirm (each change or all at once) with a direct question; Codex's default command timeout is long enough for the dialog.

## Exit codes

0 ok · 1 error · 2 not found · 3 permission · 4 conflict · 5 stale version (`apply`: drifted items, none failed) · 6 auth · 7 validation/usage · 10 network · 11 rate limited · 12 declined by user · 13 cannot ask user.
Errors print `ERROR <type> | message` and a `hint:` line. HTML answers on REST calls are errors, never data:
- `AuthenticationRequired` (6): the login page answered, so the token is missing, expired or rejected;
- `WebSudoRequired` (3): the admin page needs a websudo session, which token calls cannot open; do it in the UI;
- `UpstreamError` (10): a proxy or gateway page answered with 502/503/504.

Reads (GET) are retried on 502/503/504, connection resets and timeouts, and every method on 429, up to 5 attempts
with backoff, honouring `Retry-After` up to 60 s. Writes are never repeated after a server or network error.

Results that stop at a cap say so: `truncated: true` with the `cap` (versions, issue types, create fields, the
Confluence space-scan fallback). Usage scans (workflow and screen usage) report `incomplete` with the reason (project
cap or request budget, `max_requests`) and the covered projects. They are cached for the run and cleared by writes
that change usage, such as workflow scheme changes and project archive/restore.

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
