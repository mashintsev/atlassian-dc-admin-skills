# Proposal

## Why

A new service flow needs its queues and SLAs: which requests agents see and in which order, and the time-to-first-response and time-to-resolution goals with their calendars, such as a 24×7 calendar for bank incidents. The skill can read queues and the SLA values of a single request, but it cannot configure either. Jira 11.3.6 / JSM 11.3.5 exposes queue management in the public Service Desk API, and SLA metrics, goals, conditions and calendars through JSM's internal REST resources (verified in the WADL and with read-only calls).

## What Changes

- **Queues:** create, change (name, JQL, columns) and delete queues, and change their order.
- **Reading SLAs:** read a service desk's SLA configuration (metrics with start/pause/stop conditions, goals with JQL, target and calendar) and the available conditions.
- **SLA writes:** create SLA metrics with their conditions and goals, change them, and delete them. Changes that make JSM recalculate SLAs on existing requests carry a warning.
- **Calendars:** read, create, change and delete SLA calendars, including a 24×7 calendar, and use a calendar in goals.
- **Writes:** writes follow the change-plan rules. Internal JSM writes are gated to JSM 11.3.x (gate from `add-jsm-request-type-management`).

## Capabilities

### New Capabilities

- `jsm-queue-management`: Create, change, delete and reorder service desk queues.
- `jsm-sla-management`: Read and manage SLA metrics, their conditions and goals, and SLA calendars.

### Modified Capabilities

None.

## Impact

- **Code:** a new `src/tools/jira/queues.ts` and `src/tools/jira/sla.ts` with tests; the existing queue reads in `servicedesk.ts` are reused. This change depends on `requireJsmVersion` from `add-jsm-request-type-management`, or adds it if that change is not implemented yet.
- **APIs:**
  - public `/rest/servicedeskapi/servicedesk/{id}/queue[/{queueId}]` (POST, DELETE) and `…/queue/reorder`;
  - internal `/rest/servicedesk/1/servicedesk/{projectKey}/sla/*`, `/rest/servicedesk/1/servicedesk/agent/{projectKey}/sla/metrics*` and `/rest/servicedesk/1/servicedesk/{serviceDeskId}/sla/calendars*`.
- **Docs:** `SKILL.md` and `REFERENCE.md`.
