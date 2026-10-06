# Tasks

## 1. Capture the unverified request and response shapes (read-only)

- [x] 1.1 Capture from Jira 11.3.6 with GET requests only: a green and a red "Where is my field" response for create and edit (including a sub-task issue type), `rapidviewconfig/editmodel`, `detailviewfield/{b}/configured` and `/available`, `cardlayout/{b}/{mode}/field`, `quickfilters/{b}`, `/rest/agile/1.0/board/{b}/configuration` and `/rest/globalconfig/1/customfieldtypes`; store them as fixtures with synthetic values under `test/fixtures/jira11/` and verify no real names, keys or emails remain (grep the fixtures for the instance host and user names).
- [x] 1.2 Read the move request body for Detail View fields from the board configuration page's JavaScript on the instance and the `EditFieldLayoutItem!default.jspa` form fields (names, hidden inputs, XSRF token, websudo behaviour for a token-authenticated GET); record the findings in `design.md` under Decisions and verify both are described there.

## 2. Plan and write infrastructure

- [x] 2.1 Add the already-satisfied result helper and CLI handling (no confirmation, not planned, exit 0); verify with CLI tests for direct `dry_run=false` and `--plan` calls.
- [x] 2.2 Record per-item outcomes in the plan file during `apply`, skip done/already-satisfied items on re-apply, record unticked items as declined, and show outcomes plus a remaining count in `plan`; verify with plan tests for a partially applied five-item plan and for loading a plan without outcomes.
- [x] 2.3 Let `digestOf` use a dry run's `identity` and `state`; verify with plan tests that a changed state drifts and that a name reference resolved after an earlier item does not.
- [x] 2.4 Add the Jira version gate (serverInfo, cached per client, `11.3.x`) and the field reference resolver (id, system id, or exact name; pending only in dry runs; ambiguous names fail); verify with unit tests for refused versions sending no request and for each resolver case.
- [x] 2.5 Add a verification error for read-back mismatches (exit 1, carries the stored state); verify with a runner test of the exit code and output.

## 3. Screens

- [x] 3.1 Move `jira_list_screens` and `jira_get_screen` to `screens.ts` and read the Jira 11 `screens` key (keep `values` for older versions); verify with tests for both response shapes and the CLI `list` output.
- [x] 3.2 Implement `jira_get_screen_usage` with the bounded project × issue type scan (create/edit via "Where is my field" with a global probe field, view via project-config), screen name → id mapping, scheme ids when present, sharing warning, and 403/404/truncation counts; verify with fixture-based tests including a shared screen and a truncated scan.
- [x] 3.3 Implement `jira_add_screen_field`, `jira_remove_screen_field` and `jira_move_screen_field` with 1-based positions, `after_field_id`, already-satisfied, the other-tab error, the tab's field list as `state`, affected projects in the dry run, and read-back via the screen; verify with tests for each scenario in the screen spec, including drift on reorder.

## 4. Custom fields and contexts

- [x] 4.1 Implement `jira_create_custom_field` with type mapping, default searchers from `customfieldtypes`, duplicate detection (case-insensitive name, `schema.custom` comparison), already-satisfied and the conflict/ambiguity errors; verify with tests for each scenario in the provisioning spec.
- [x] 4.2 Implement `jira_create_field_context`, `jira_update_field_context` (full context sent, unspecified attributes kept) and `jira_delete_field_context` behind the version gate, with field name references and already-satisfied for an identical context; verify with tests for scope validation, identity digests and refused versions.
- [x] 4.3 Implement `jira_add_field_to_screens` producing one result per placement through the screen-field logic; verify that a mixed list plans only the missing placements and that `--plan` records each as its own item.
- [x] 4.4 Verify the end-to-end provisioning plan with a fake client: plan creation, context and two placements before the field exists, apply, fail one placement, re-apply, and check that no delete request is ever sent.

## 5. Field configurations

- [x] 5.1 Implement `jira_get_field_configuration`: resolution via "Where is my field" and the bounded id scan, grouping by configuration when `issue_type_id` is omitted, paged fields with a name filter, sharing projects, and an explicit unresolved result; verify with fixture-based tests including the per-issue-type grouping.
- [x] 5.2 Implement `jira_update_field_description`: dry run with old/new value, sharing warning and edit link, already-satisfied for an equal value, and an unsupported (websudo) result for execution that sends no changing request; verify with fake-client tests for each scenario in the field configuration spec and that `dry_run=false` and `apply` send only GET requests.

## 6. Board configuration

- [x] 6.1 Implement `jira_get_board_configuration` combining agile `configuration`, `editmodel`, Detail View, card layout and quick filters, with per-part unavailable reasons; verify with fixture-based tests including a part that returns 403.
- [x] 6.2 Implement `jira_set_board_detail_fields`, `jira_add_board_detail_field` and `jira_remove_board_detail_field` behind the version gate and the `canEdit` check: target list computation preserving untouched fields and order, unavailable field error, already-satisfied, old/new list in the dry run, minimal remove/add/move sequence, read-back; verify with tests including the JC-83 case (remove Components, Affects Version/s, Fix Version/s; keep Labels).

## 7. Integration and documentation

- [x] 7.1 Register the new groups in `src/tools/index.ts`, label internal-API tools in their descriptions, update `SKILL.md` triggers and the hand-written `REFERENCE.md` sections (API kinds per tool, 11.3.x gate, JC-83 recipe); verify that `list` and `describe` show every new tool and that the bounded-reads test passes.
- [x] 7.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`; verify that the built bundle lists the tools and that `REFERENCE.md` is regenerated.
- [x] 7.3 Verify the read tools against Jira 11.3.6 with read-only calls (`jira_get_screen_usage`, `jira_get_field_configuration`, `jira_get_board_configuration`) and dry runs of each write tool; no write is executed without the user's explicit confirmation in that session.
