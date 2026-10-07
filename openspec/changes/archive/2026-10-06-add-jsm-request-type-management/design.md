# Design

## Context

See proposal.md and specs/. Current tools in `src/tools/jira/servicedesk.ts` read service desks, queues, request types and request type fields through the public `/rest/servicedeskapi` (with `X-ExperimentalApi: opt-in`). The change-plan infrastructure (`already-satisfied`, `identity`/`state` in dry runs, outcomes in the plan, read-back with `VerificationError`) and the Jira version gate exist (`src/plan.ts`, `src/jiraVersion.ts`).

Verified on Jira 11.3.6 / JSM 11.3.5-QR-0008 (WADL and read-only responses; a test project and service desk):

| Need | Endpoint | Kind |
|---|---|---|
| Request type create/update/delete | `POST/PUT /rest/servicedeskapi/servicedesk/{sd}/requesttype`, `DELETE …/requesttype/{id}` | public |
| Request type groups | `GET/POST/PUT /rest/servicedesk/1/servicedesk/{projectId}/request-type-groups[/{g}]`, `POST/DELETE …/{g}/request-types[/{id}]`, `POST …/{g}/request-types/{id}/move` | internal |
| Hidden request types | `GET/POST …/request-type-groups/hidden/request-types`, `DELETE/PUT …/hidden/request-types/{id}` | internal |
| Form | `GET …/servicedesk/{rt}/request-type-fields/visible\|hidden\|unused`; `POST …/request-type-fields`; `PUT/DELETE …/visible/{id}`; `POST …/visible/{id}/move`; `PUT …/{id}/hide\|show`; `GET/POST …/{id}/preset` | internal |
| JSM version | `GET /rest/servicedeskapi/info` → `version` (11.3.5-QR-0008), `platformVersion` (11.3.6) | public |

A visible form field reads as `{id, fieldId, fieldType, label, description, sdRequired, jiraRequired, displayed, usedByEmail, defaultValue, order, jiraName, values}`. The request bodies of the internal POST/PUT calls and of the public PUT are not in the WADL. They are captured from the project settings pages' JavaScript before implementation (task 1). Those pages are project administration pages, not websudo-protected admin pages.

**Findings (tasks 1.1–1.2, JSM 11.3.5).** Sources: the web resources `com.atlassian.servicedesk.frontend-webpack-plugin` chunks 853 ("Edit request type") and 861 (request types and groups), and read-only responses from project 10503.
- **Request type model** (`GET …/{projectId}/request-type-groups/{g}/request-types[/{id}]`, and `…/hidden/request-types`): `{id, icon, name, issueType{id,name,…}, description, descriptionHtml, groups:[{id,name}], order, projectId, usedByEmailSettings, helpText, helpTextHtml, restrictionStatus, portalId}`.
- **Portal membership is the `groups` attribute.** The UI adds an existing request type to a group by appending to `groups` and saving the model with `PUT …/request-type-groups/{g}/request-types/{id}` (JSON, the model). It removes with `DELETE …/request-type-groups/{g}/request-types/{id}`. A request type with no groups is hidden from the portal: the "hidden" list is exactly those, and the UI's "Edit groups" dialog says so. The same PUT carries name, description and issue type.
- **Order within a group:** `POST …/request-type-groups/{g}/request-types/{id}/move` with `{"position":"First"}` or `{"after": "<absolute url of the previous row>"}` (AJS.RestfulTable).
- **Help text:** `PUT …/{projectId}/request-type-groups/help-text/{rt}` with `{helpText}`.
- **Form reads:** `GET …/{rt}/request-type-fields/editform` returns `{viewportKey, form{id, name, issueTypeId, issueTypeName, …}}`. `…/visible`, `…/hidden` and `…/unused` return rows `{id, fieldId, fieldType, label, description, sdRequired, jiraRequired, displayed, usedByEmail, defaultValue, order, jiraName, descriptionHtml, values}`. `…/unused` rows have id 0. Hidden rows carry their preset in `values` (`{fieldId: [values]}`).
- **Form writes:**
  - `POST …/{rt}/request-type-fields {"fields": [fieldId…]}` adds fields; the response rows say whether each is displayed;
  - `PUT …/visible/{id}` takes the changed row attributes (`label`, `description`, `sdRequired`);
  - `DELETE …/visible/{id}` and `…/hidden/{id}` remove a field;
  - `POST …/visible/{id}/move` and `…/hidden/{id}/move` reorder (RestfulTable body);
  - `PUT …/{id}/hide` and `PUT …/{id}/show` hide and show a field;
  - `POST …/{id}/preset?atl_token=<XSRF token>` sets a preset with `{"values": {fieldId: [values]}}`. It needs Jira's XSRF token (cookie `atlassian.xsrf.token`, sent back as cookie and `atl_token`).
- **Create and delete request types** stay on the public `servicedeskapi` (`POST …/requesttype {issueTypeId, name, description, helpText}`, `DELETE …/requesttype/{id}`). Updates use the internal model PUT above, so an issue type change is possible and verified on read-back.

## Goals / Non-Goals

**Goals:**
- One module for request types and their forms that follows the existing change-plan contract.
- A JSM version gate next to the Jira gate, used for every internal JSM write.

**Non-Goals:**
- Request type permissions (customer restrictions), portal settings, email channel, and request type icons.
- Creating or deleting portal groups. Only membership and order are in scope.

## Decisions

### JSM version gate
`requireJsmVersion(client, feature)` reads `/rest/servicedeskapi/info` once per client and accepts `11.3.x`, like `requireJiraVersion`. Internal JSM writes call it before any other request. Public request type writes do not. Alternative: gate on the Jira version only; rejected because JSM ships separately and its internal resources change with JSM, not with the platform.

### Request type identity
Request types are addressed by id or exact name within the service desk; ambiguous names fail. A name lets a plan create a request type and then place it in a group and shape its form before it exists. This is the same approach as field references (`fieldRefs.ts`). The dry run uses a pending reference, and `identity` carries the name so the digest is stable.

### Drift state per operation
Following `change-plan-execution`, each write puts only what it depends on in `state`:
- **Add/remove:** whether the item is present.
- **Move:** the anchor (the item it follows).
- **Update:** the stored values of the attributes it changes.

Several changes to one form or group in one plan therefore do not drift each other.

### Hidden fields and presets
Hiding a field and setting its preset are one tool (`jira_hide_request_type_field preset=…`) executed as two calls: preset, then hide. The read-back checks both. A field with `jiraRequired` and no preset (stored or given) cannot be hidden, because creating requests would fail. This matches the JSM UI rule.

### Issue type change
Changing a request type's issue type is part of `jira_update_request_type`. If the captured update body has no issue type attribute, the issue type change is reported as unsupported and the spec scenario is revisited (task 1 decides).

## Risks / Trade-offs

- [Internal JSM resources change between JSM releases] → JSM version gate and fixtures captured on 11.3.5. Reads fail with the endpoint and version named.
- [Request bodies not in the WADL] → Captured from the pages' own JavaScript (task 1). Verified with dry runs on the instance. Writes are tested only against fakes.
- [Deleting a request type affects existing requests' portal view] → Irreversible warning in the dry run; never part of an automatic rollback.

## Migration Plan

Additive tools and a new gate; no data or plan format changes. Rollback: remove the module and its registry entry.
