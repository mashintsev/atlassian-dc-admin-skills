# Tasks

## 1. Capture request shapes (read-only)

- [x] 1.1 Capture, with GET requests only, the responses of the request type, group, hidden request type and form resources for one service desk, and store them as fixtures with synthetic values under `test/fixtures/jsm11/`; verify by grepping the fixtures for the instance host, project keys and user names.
- [x] 1.2 Read the request bodies of public request type PUT and of the internal group membership, move, hidden, form field add/update/move, hide/show and preset calls from the project settings pages' JavaScript; record them in `design.md` and decide whether an issue type change is possible (update the spec if not); verify the design lists every body used by a tool.

## 2. Shared pieces

- [x] 2.1 Add `requireJsmVersion` (servicedeskapi `info`, cached per client, `11.3.x`) next to `requireJiraVersion`; verify with unit tests that a refused version sends no further request.
- [x] 2.2 Add request type references (id or exact name within a service desk, pending in dry runs, ambiguous names fail) and service desk resolution by id or project key; verify with unit tests for each case.

## 3. Request types and groups

- [x] 3.1 Implement `jira_create_request_type`, `jira_update_request_type` and `jira_delete_request_type` with issue type validation, already-satisfied, name conflict error, irreversible warning on delete and read-back; verify with fake-client tests for each scenario in `jsm-request-type-management`.
- [x] 3.2 Implement `jira_set_request_type_hidden`, `jira_add_request_type_to_group`, `jira_remove_request_type_from_group` and `jira_move_request_type_in_group` behind the JSM gate, with group names, anchors in `state` and read-back; verify with tests including a plan of several moves in one group applied without drift.

## 4. Forms

- [x] 4.1 Implement `jira_get_request_type_form` (visible in order, hidden with presets, unused fields); verify with fixture-based tests.
- [x] 4.2 Implement `jira_add_request_type_field`, `jira_remove_request_type_field`, `jira_move_request_type_field`, `jira_update_request_type_field`, `jira_hide_request_type_field` and `jira_show_request_type_field` behind the JSM gate, with the required-without-preset rule, already-satisfied, per-operation `state` and read-back; verify with tests for each scenario in `jsm-request-type-form`, including a three-change plan on one form.

## 5. Integration

- [x] 5.1 Register the tools in their own group, mark internal-API tools in their descriptions, update `SKILL.md` and the hand-written `REFERENCE.md` sections; verify `list`/`describe` show every tool and the bounded-reads test passes.
- [x] 5.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`; then check the read tool and the dry runs of every write tool on the instance (no write executed); verify the outputs and record the commands in the final report.
