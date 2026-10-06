# Tasks

## 1. Capture shapes and bodies (read-only)

- [x] 1.1 Capture queue, SLA metric (both API families), goal, condition and calendar responses for one service desk as synthetic fixtures under `test/fixtures/jsm11/`; verify no instance data remains.
- [x] 1.2 Read the request bodies used by the queue settings and the JSM SLA settings page (metric create/update/delete, definition, goals, calendar create/update/delete, 24×7 representation, queue reorder) from their JavaScript; record them and the chosen SLA API family in `design.md`, and revise the specs for any operation without a confirmed body; verify the design lists every body a tool uses.

## 2. Queues

- [x] 2.1 Implement `jira_create_queue`, `jira_update_queue` and `jira_delete_queue` with column resolution, already-satisfied, the conflict stop and read-back; verify with fake-client tests for each scenario in `jsm-queue-management`.
- [x] 2.2 Implement `jira_move_queue` with anchors in `state`; verify with a test of two moves in one plan applied without drift.

## 3. SLA

- [x] 3.1 Implement `jira_get_sla_configuration`, `jira_get_sla_conditions` and `jira_list_sla_calendars`; verify with fixture-based tests.
- [x] 3.2 Implement condition name mapping and the target parser and formatter as pure functions; verify with unit tests (`4h`, `2d 4h`, minutes, unknown condition with the list of available ones).
- [x] 3.3 Implement `jira_create_sla`, `jira_update_sla` and `jira_delete_sla` behind the JSM gate, with already-satisfied, the conflict stop, recalculation and data-loss warnings, the "All remaining issues" goal last, and read-back; verify with tests for each scenario in `jsm-sla-management`.
- [x] 3.4 Implement `jira_create_sla_calendar`, `jira_update_sla_calendar` and `jira_delete_sla_calendar` with `24x7` expansion, already-satisfied and the in-use refusal; verify with tests including a plan that creates a 24×7 calendar and an SLA using it by name.

## 4. Integration

- [x] 4.1 Register the tools, update `SKILL.md` and `REFERENCE.md` (warnings, gate, 24×7); verify `list`/`describe` and the bounded-reads test.
- [x] 4.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`; check the read tools and the dry runs of the write tools on the instance (no write executed).
