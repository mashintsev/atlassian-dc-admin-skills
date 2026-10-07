# Design

## Context

See proposal.md for the motivation. Relevant current state:
- **Validation:** arguments are checked by `argsSchema(tool)` = `z.object(tool.inputShape).strict()` (`src/runner.ts:40-42`), so unknown keys fail with a Zod message and no suggestion. `runToolByName` answers an unknown tool with `hint: "run: list <filter>"` (`src/runner.ts:94`).
- **Hints:** `HINTS` covers only 401, 403, 404 and 409 (`src/runner.ts:44-49`). The outcomes of `apply` are printed by `renderOutcomes` (`src/plan.ts`).
- **Field names:** `resolveField` (`src/tools/jira/fieldRefs.ts:34`) already resolves a field by id or exact name and is pending in dry runs. Issue types and workflow schemes have no such resolver.
- **Write-safety coverage**, counted by grep per module (writes / `alreadySatisfied(` / `VerificationError`):
  - **No already-satisfied and no read-back:**
    - `jira/users.ts` 10/0/0
    - `jira/projects.ts` 5/0/0
    - `jira/schemes.ts` 4/0/0
    - `jira/workflowSchemes.ts` 9/0/0
    - `confluence/users.ts` 6/0/0
    - `confluence/spaces.ts` 4/0/0
    - `confluence/spaceCategories.ts` 1/0/0
    - `confluence/labels.ts` 1/0/0
    - `assets/structure.ts` 12/0/0
    - `assets/objects.ts` 6/0/0
  - **Already covered:** workflows, screens, custom fields, field options, board config, queues, SLA, request types, ScriptRunner.
- **Tests:** 61 of 282 tools are not referenced by name in `test/unit/**` (recomputed in task 5.1).

## Goals / Non-Goals

**Goals:**
- One canonical name per concept, with aliases resolved in one place before validation.
- Already-satisfied, read-back and drift identity for the admin write modules listed above.
- Chained plan references for issue types and workflow schemes.

**Non-Goals:**
- Content writes (issues, comments, worklogs, attachments, links, sprints, Confluence pages and comments). Creating them is not idempotent; they only get the "unverifiable" description note where it applies.
- Renaming or removing any current argument name (non-breaking change).
- Defects owned by the separate CLI output and plan defects change:
  - the issue type scheme drift fix;
  - the space category `already_satisfied` key;
  - number-like string parsing;
  - the `apply` exit code.

## Decisions

### Parameter-name mapping (from the code)

**`field` (id or exact name).**
- Canonical `field` today: `jira_get_custom_field_options`, `jira_set_custom_field_options`, `jira_add_board_detail_field`, `jira_remove_board_detail_field`, `jira_add/remove/move/update/hide/show_request_type_field`.
- Alias `field_id`:
  - `jira_get_field_contexts` and `jira_get_field_screens` take ids only today (`fields.ts:99,108`), and gain name resolution;
  - `jira_create_field_context`, `jira_update_field_context`, `jira_delete_field_context`, `jira_add_field_to_screens`, `jira_update_field_description`, `jira_add_screen_field`, `jira_remove_screen_field`, `jira_move_screen_field`;
  - `jira_get_field_options` takes ids only today (`issues.ts:578`), and gains name resolution.
- Kept as is: `after_field_id` (`screens.ts:492`). A new alias `after_field` is added.

**`user` (existing user: username, or Jira user key).**
- Canonical `user` today: `jira_get_user`, `jira_update_user`, `jira_set_user_active`, `jira_delete_user`, `jira_remove_project_role_actor`.
- Alias `username`: `jira_set_user_application`, `jira_kill_user_sessions`, `jira_add_user_to_group`, `jira_remove_user_from_group`, `jira_add_watcher`, `jira_remove_watcher`, `confluence_get_user`, `confluence_set_user_enabled`, `confluence_add_user_to_group`, `confluence_remove_user_from_group`.
- Not aliased: `username` in `jira_create_user` and `confluence_create_user` (the new account name), `new_username` in `jira_update_user`, and `users` (a list) in `jira_add_project_role_actors`.

**`project_key`.**
- Canonical: 24 tools already use it.
- Alias `project`: `jira_get_workflow`, and `first_project`/`second_project` in `jira_compare_workflows`, which become `first_project_key`/`second_project_key` with the old names as aliases.

**`issue_type` (id or exact name).**
- Canonical: `jira_get_workflow`, `jira_create_issue` (name only today; gains ids), `jira_get_field_options`, `jira_create_request_type`, `jira_update_request_type`.
- Alias `issue_type_id`: `jira_set_workflow_scheme_mapping`, `jira_delete_workflow_scheme_mapping`, `jira_get_field_configuration`, `jira_get_create_fields`. All four take ids only today and gain name resolution.

**`issue_types` (list).**
- Alias `issue_type_ids`: `jira_add_issue_types_to_scheme`, `jira_create_field_context`, `jira_update_field_context`.
- `default_issue_type_id` becomes `default_issue_type`, with the old name as an alias.

**`service_desk` (id or project key).**
- Canonical: 27 JSM tools already use it.
- Alias `service_desk_id`: `jira_get_service_desk_queues`, `jira_get_queue_issues`, `jira_get_request_types`, `jira_get_request_type_fields`, `jira_create_customer_request`. All five take ids only today and gain project-key resolution through `resolveServiceDesk`.

**`key` (property key).**
- Canonical: `jira_get_application_properties`.
- Alias `id`: `jira_set_application_property` (`system.ts:112`).
- `assets_create_schema key` is an Assets object key, not a property key: unchanged.

**Workflow scheme reference.**
- `scheme_id` in the 9 workflow scheme tools accepts an id or an exact scheme name (see chained references).
- Other `scheme_id` arguments (permission, notification, issue security, issue type schemes) stay ids.

`group`, `workflow`, `space_key` and `scheme_id` are already consistent and stay as they are.

### Where aliases are resolved
- `ToolDef` gets an optional `aliases: Record<alias, canonical>`.
- `runTool` renames alias keys before `argsSchema` validation and refuses when both the alias and the canonical key are present with different values.
- `describe` and `REFERENCE.md` generation print `name (alias: old)`. `list` output does not change.
- **Alternative rejected:** one Zod `preprocess` per tool. It is scattered, and the schema would not know about the aliases, so `describe` could not show them.

### Suggestions
A Damerau-Levenshtein distance of at most 3, or a shared prefix, over the tool names (for an unknown tool) and over the argument names plus aliases (for an unknown argument). Up to three suggestions are put in `hint`. No dependency is added.

### Write-safety patterns per module
Each write tool follows this pattern:
1. **Read the target state.** `alreadySatisfied(summary, reason)` when it holds.
2. **Dry run with drift data.** Include `identity` (names, never resolved ids) and `state` (only what the change depends on).
3. **Execute.**
4. **Read back.** `VerificationError(message, observed)` when the change is not visible.

| Module | Tools | Target-state read | Unverifiable (described as such) |
|---|---|---|---|
| `jira/users.ts` | create/update/set_active/delete user, set_user_application, create/delete group, add/remove user to group | `GET user`, `GET group/member`, `GET user?expand=groups,applicationRoles` | `jira_kill_user_sessions` |
| `jira/projects.ts` | role actors add/remove, set permission scheme, archive/restore | `GET project/{key}/role/{id}`, `GET project/{key}/permissionscheme`, `GET project/{key}` (`archived`) | — |
| `jira/schemes.ts` | permission grant add/delete, create issue type | `GET permissionscheme/{id}?expand=permissions`, `GET issuetype` | — |
| `jira/workflowSchemes.ts` | mapping set/delete, default, create/update/delete, draft create/delete, replace | `GET workflowscheme/{id}[/draft]` | — |
| `confluence/users.ts` | create user/group, enable, membership add/remove | existing user/group/member reads | — |
| `confluence/spaces.ts` | grant/revoke permissions, archive, delete | space permission read, `GET space/{key}` status | delete: the long task is only polled |
| `confluence/labels.ts` | add label | `GET content/{id}/label` | — |
| `assets/structure.ts` | schema/object type/attribute/status create/update/delete | existing `get_*` reads | — |
| `assets/objects.ts` | update/delete/archive object, bulk update | `GET object/{id}` | `assets_add_object_comment`, create object (no natural key) |
| system, reindex | `jira_start_reindex`, `confluence_start_reindex`, `jira_set_application_property` | property read for set | reindex starts |

For lists sent back whole (workflow scheme mappings, permission sets, Assets attributes), `state` holds only the entries the change touches, following `change-plan-execution`.

### Chained references for issue types and workflow schemes
- **Issue types** get a resolver like `resolveField`. It accepts an id or an exact name, against `GET issuetype`. In a dry run, when the type does not exist, it gives a pending placeholder (`<issue type "Change Request">`) and `identity` holds the name.
- **Workflow schemes:** DC has no endpoint that lists all workflow schemes, and a newly created scheme is used by no project. So it cannot be found through the project scan.
  - **Decision:** `apply` records the id of each object an item creates in that item's outcome (`created: {type, name, id}`). Name resolution checks the server first (an id, or a scheme found by the project scan), then the ids created by earlier items of the same plan.
  - A workflow scheme name that neither source knows fails the item without sending anything.
  - **Alternative rejected:** a full id scan (`GET workflowscheme/{1..N}`). It costs unbounded requests and creates load.

### Error hints
`HINTS` gains these entries:
- 400: "check the arguments: describe <tool>";
- 429: "the server is throttling; retry later or narrow the call";
- 500–599: "server-side failure; retry, and check the application's health if it repeats".

`renderOutcomes` prints `re-plan: <tool> <args…> --plan=<file>` under each drifted item.

## Risks / Trade-offs

- **[Silent alias mistakes]** → An alias plus a canonical name with different values is refused, and `describe` shows the aliases.
- **[More reads per write]** → One extra GET per write (two with read-back), the same as the tools that already have this. Scans are never added for the check.
- **[Plan-recorded ids depend on the plan file]** → The ids live in the plan file, which is written atomically. An item applied alone in a new plan cannot see them, and it fails without sending anything.
- **[Assets "already-satisfied" for create]** → Only when the same name exists with identical settings. A same-name object with other settings is an error, as for queues.
- **[Large test addition]** → Tasks are grouped per module. The fakes reuse the existing helpers (`testContext`, fixtures).

## Migration Plan

Non-breaking. Aliases keep every current name. Rollback is a revert of each module's task, independently.

## Live check (task 6.2, dry runs and reads only)

Run on the instance (Jira 11.3.7) in one context; 0 of 78 requests were writes.
- **Already-satisfied paths:** `jira_add_user_to_group` (alias `username`, a group the account is in), `jira_add_permission_grant` (an existing group grant), `jira_set_workflow_scheme_mapping` (an existing mapping, by `scheme_id` + `issue_type_id`, and by scheme name + `issue_type`) and `jira_set_application_property` (alias `id`, the current value) all answered ALREADY-SATISFIED.
- **Aliases on reads:** `jira_get_create_fields issue_type_id=`, `jira_get_workflow project=`, `jira_get_request_types service_desk_id=` succeeded. `jira_get_field_contexts` gives the same request with `field_id` and with `field` (a name resolves to the same id).
- **Found, not caused by this change:** `jira_get_field_contexts` calls `GET /rest/api/2/field/{id}/contexts`, which answers 404 on this Jira. The committed version had the same URL. A follow-up should read contexts through the resource that `jira_create_field_context` already uses (`/rest/internal/2/field/{id}/context`).
