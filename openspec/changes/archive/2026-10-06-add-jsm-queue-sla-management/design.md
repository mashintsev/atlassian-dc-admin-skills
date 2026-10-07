# Design

## Context

See proposal.md and specs/. `servicedesk.ts` already reads queues (`jira_get_service_desk_queues`, `jira_get_queue_issues`) and a request's SLA (`jira_get_issue_sla`). The change-plan contract exists. The JSM version gate is introduced by `add-jsm-request-type-management`.

Verified on Jira 11.3.6 / JSM 11.3.5 (WADL plus read-only calls on a test service desk):
- **Queues (public):** `GET/POST /rest/servicedeskapi/servicedesk/{sd}/queue`, `GET/POST/DELETE …/queue/{queueId}`, `POST …/queue/reorder`. A queue reads as `{id, name, jql, fields[]}`.
- **SLA metrics (internal):**
  - `GET /rest/servicedesk/1/servicedesk/{projectKey}/sla/metric/all` returns `{metrics: [{id, name, customFieldId}]}`;
  - `GET/POST/PUT/DELETE …/sla/metric/{id}/definition` and `…/threshold`;
  - `GET/PUT …/sla/goals/metric/{id}`, `POST …/sla/metric`;
  - a second family under `…/servicedesk/agent/{projectKey}/sla/metrics[/{id}]` (GET, POST, PUT, DELETE, `validate`).
- **Conditions (internal):** `GET …/{projectKey}/sla/conditions/available` returns `{hitConditions[20], matchConditions[15]}` of `{pluginKey, factoryKey, conditionId, name}`.
- **Calendars (internal):** `GET/POST …/servicedesk/{sd}/sla/calendars`, `GET/PUT/DELETE …/calendars/{id}`, `…/calendars/configuration`. Calendars read with `name, description, inherentlyEditable, inherentlyDeletable, dependentMetrics`.

**Findings (tasks 1.1–1.2, JSM 11.3.5).** Sources: the web resources of `com.atlassian.servicedesk.frontend-webpack-plugin`: chunk 852 (SLA settings), 847 (calendars), and module 994 in chunk 856 (queues API). Plus read-only responses from service desk 3.
- **SLA API family:** the SLA settings page uses `…/servicedesk/agent/{projectKey}/sla/metrics[/{id}]`. `GET` returns `{timeMetrics: [...]}`; `POST` creates and `PUT` updates the whole model; `DELETE` removes it. Goals are validated with `PUT /rest/servicedesk/1/agent/sla/metric/goal/validate {jqlQuery, defaultGoal}`, and calendar names come from `…/sla/metrics/calendar-refs`.
- **Metric model:** `{id, name, customerVisible, customFieldId, config: {definition: {start[], pause[], stop[], inconsistent}, goals[]}}`.
  - A condition is `{pluginKey, factoryKey, conditionId, type, name, missing}`.
  - A goal is `{id?, jqlQuery, duration (ms), calendarId?, defaultGoal}`.
  - The UI builds goals as `{id (existing only), jqlQuery, duration, calendarId, defaultGoal}`.
  - Start and stop conditions come from `hitConditions`; pause conditions from `matchConditions` ("Status: X").
- **Calendars:**
  - A calendar is `{id, name, description, timeZone, holidays[], workingTimes[{id, day, start, end, disabled}]}`, with times in ms from midnight.
  - The list (`GET …/{sd}/sla/calendars`) carries `dependentMetrics`, `inherentlyEditable` and `inherentlyDeletable`, and includes the built-in "Default 24/7 calendar" (no id in the list, id `-1` in `calendar-refs`).
  - The UI saves a calendar as its model without `dependentMetrics`, `inherentlyDeletable` and `inherentlyEditable`: `POST …/calendars` to create, `PUT …/calendars/{id}` to update, `DELETE …/calendars/{id}`.
- **24×7:** a goal without `calendarId`, or with `-1`, uses the built-in 24/7 calendar. Binding a goal to 24×7 needs no new calendar. A custom 24×7 calendar is every day from 0 to 86 400 000 ms.
- **Queues:** create, change and delete use the public `servicedeskapi` (`{name, jql, fields}`). The UI's own queue module uses `…/servicedesk/{projectKey}/queues/page` (read), `POST …/{projectKey}/queues` (create) and `PUT …/{projectKey}/queues` (reorder). The UI module has `reorderQueues`, but no frontend chunk on the instance calls it (a full scan of the 1050 modules found no caller). The public `POST /rest/servicedeskapi/servicedesk/{id}/queue/reorder` is listed in Atlassian's JSM 11.3 REST documentation, without a schema on the rendered page. The Java `QueueService.reorderQueues(user, serviceDeskId, List<Integer> newQueueOrderId)` takes the full order of queue ids.
- **Decision (user):** `jira_move_queue` sends that full order as a JSON array of ids and reads the order back. A rejected or different result raises `VerificationError`. The body format is not confirmed by a live call yet.

## Goals / Non-Goals

**Goals:**
- Queue and SLA management that follows the change-plan contract, with explicit warnings for recalculation and data loss.

**Non-Goals:**
- SLA recalculation and reconstruction tasks (`sla/admin/task/destructive/*`), SLA custom field clean-up, global SLA settings, queue groups and starred queues.

## Decisions

### Which SLA API family
The `agent/{projectKey}/sla/metrics` family reads and writes a whole metric (name, conditions, goals) and has a `validate` call, so one change is one request. The older `{projectKey}/sla/metric/*` family splits definition and goals. Task 1 captures which one the JSM 11.3 SLA settings page uses and its bodies. The tools use that family. If it is the split family, a create runs metric → definition → goals as follow-up steps of one change, with read-back after the last.

### Condition and goal model
Conditions are given by name and mapped to `{pluginKey, factoryKey, conditionId}` from `conditions/available`. "Hit" conditions are start/pause/stop events, and "match" conditions are "while in status" style pause conditions. Targets are parsed from `4h`, `2d 4h` or minutes, and are shown in the dry run in the same form. Goals are compared in order. The goal without JQL is the "All remaining issues" goal and must be last.

### Calendars and 24×7
A 24×7 calendar is a calendar whose working time covers every day for 24 hours. The tool accepts `working_hours=24x7` and expands it into the stored form captured in task 1. Calendars are matched by name for already-satisfied. Deleting checks `dependentMetrics` first.

### Queue order
Reordering uses the public `queue/reorder` call. Its body (task 1) decides whether a single move or the full order is sent. With a full order, the tool sends the current order with only the moved queue changed. Its `state` holds only the anchor, following `change-plan-execution`.

### Warnings
SLA condition and goal changes warn about recalculation on existing requests. SLA deletes warn about lost SLA values. Both are never part of an automatic rollback.

## Risks / Trade-offs

- [Internal SLA resources change between JSM releases] → JSM 11.3.x gate and fixtures captured on 11.3.5.
- [SLA changes recalculate many requests and load the instance] → Warning in the dry run; one confirmed change per metric.
- [Unknown request bodies] → Task 1. Operations without a confirmed body are not implemented, and the spec is revised.

## Migration Plan

Additive tools. Rollback: remove the modules.
