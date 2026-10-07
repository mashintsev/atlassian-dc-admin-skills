# Design

## Context

See proposal.md. Existing parts this change builds on:
- **Project reads and the permission scheme:** `jira_set_project_permission_scheme` (`PUT /rest/api/2/project/{key}/permissionscheme`) and the project summary, which reads `…/project/{key}/workflowscheme`, `…/notificationscheme` and `…/permissionscheme`.
- **Issue type schemes:** read (`/rest/api/2/issuetypescheme`, `…/associations`), and additions through `PUT /issuetypescheme/{id}` with the full list.
- **Versions:** create and update.
- **Screens:** list and read.
- **Permission schemes:** list, read and per-grant writes.
- **Confluence:** `confluence_add_label` (`POST /rest/api/content/{id}/label`) and `confluence_add_space_category` (`…/space/{key}/category/{name}`).
- **Shared contracts:** the change plan contract, `alreadySatisfied`, the manual change result (`MANUAL`), and the Jira 11.3.x version gate for internal APIs.

Earlier changes found that admin `.jspa` forms are behind websudo for token authentication, so they are not an alternative to REST.

## Goals / Non-Goals

**Goals:**
- Finish the typical tasks end to end where REST allows it, and hand off with a verified manual change where it does not.
- Every write follows the existing contracts (dry run, confirmation, already-satisfied, identity/state, read-back, UI check plan).

**Non-Goals:**
- Issue migration on workflow or issue type scheme changes. Migration stays in the Jira UI.
- Creating workflow, issue type screen or field configuration schemes. Assignment uses existing ones.
- Dashboard gadget editing, and filter ownership transfer beyond what is verified.

## Findings (tasks 1.1–1.3, read-only on the instances: GETs and WADL, nothing written)

**Jira 11.3.7, from the WADL `/rest/api/2/application.wadl` plus GETs:**
- **Notification scheme:** `PUT /project/{projectIdOrKey}` exists, and the project input takes `notificationScheme` (an id). Read back with `GET /project/{key}/notificationscheme`.
- **Issue type scheme:** `POST /issuetypescheme/{schemeId}/associations` exists (body `{"idsOrKeys": [...]}`), together with `GET`, `PUT`, `DELETE` and per-project `DELETE`. Removing types uses the same full-list `PUT /issuetypescheme/{id}` as additions.
- **Versions:** there is no `DELETE /version/{id}`. Deletion is `POST /version/{id}/removeAndSwap` with optional `moveFixIssuesTo` and `moveAffectedIssuesTo`. `GET /version/{id}/relatedIssueCounts` answers 200 with `issuesFixedCount`, `issuesAffectedCount` and `issueCountWithCustomFieldsShowingVersion`.
- **Permission schemes:** `POST /permissionscheme`, and `GET`/`PUT`/`DELETE /permissionscheme/{id}`. Grants are under `/permission`.
- **Screens:** only `GET /screens` and `POST /screens/addToDefault/{fieldId}` exist. There is no creation path, so `jira_create_screen` is a manual change with the admin link (`/secure/admin/AddNewFieldScreen!default.jspa`), verified on re-run by name.
- **Filters:** `POST /filter`, `GET`/`PUT`/`DELETE /filter/{id}`, `/filter/{id}/permission` (`GET`, `POST`, `DELETE /{permission-id}`), and `GET /filter/favourite` (answers 200). `GET /filter/search` answers 404, so the filter list covers favourites only and says so.
- **Dashboards:** `GET /dashboard` (`startAt`, `maxResults`, `total`, `dashboards`) and `GET /dashboard/{id}`. There is no copy path, so copying is a manual change.

**Task 1.2, project-config web resources.** The modules matching scheme/workflow/screen/field in `com.atlassian.jira.jira-project-config-plugin` call only `POST /rest/projectconfig/latest/workflow` (copy the default workflow and switch the scheme, which starts a migration) and `migrationStatus`. No internal path assigns a workflow, issue type screen or field configuration scheme. Jira does that through admin forms (`SelectProjectWorkflowScheme`, `SelectIssueTypeScreenScheme`, `SelectFieldLayoutScheme`), which are behind websudo for tokens. Those three assignments are therefore manual changes with the project admin link, verified on re-run. No internal path and no version gate is needed.

**Task 1.3, Confluence 10.2.18.** It publishes no REST WADL: `/rest/api/application.wadl` answers 500 and `/rest/application.wadl` returns an HTML page. `OPTIONS` answers 500 as well, so neither path can be confirmed read-only.
- **Content labels:** removal uses `DELETE /rest/api/content/{id}/label/{label}`, part of Confluence's documented public REST API, verified by reading the labels back.
- **Space categories:** no removal request could be verified, so `confluence_remove_space_category` answers `Unsupported` and sends nothing, as the spec allows.

## Decisions

### Expected availability (verified in task 1 before implementation)

| Operation | Expected path | Expected status |
|---|---|---|
| Notification scheme → project | `PUT /rest/api/2/project/{key}` with `notificationScheme` | public, confirm in WADL |
| Issue type scheme → project | `POST /rest/api/2/issuetypescheme/{id}/associations` (`idsOrKeys`) | public, confirm in WADL |
| Workflow scheme → project | none known (earlier change: "no endpoint assigns a scheme") | unknown → internal (project config JS) or manual change |
| Issue type screen scheme → project | none known | unknown → internal or manual change |
| Field configuration scheme → project | none known | unknown → internal or manual change |
| Remove issue types from scheme | `PUT /rest/api/2/issuetypescheme/{id}` with the remaining ids | public (same call as additions) |
| Delete version | `DELETE /rest/api/2/version/{id}?moveFixIssuesTo=&moveAffectedIssuesTo=`; counts via `…/version/{id}/relatedIssueCounts` | public |
| Create screen | `POST /rest/api/2/screens` not known on DC | unknown → manual change |
| Create permission scheme | `POST /rest/api/2/permissionscheme` (with `permissions`) | public |
| Filters | `/rest/api/2/filter`, `/filter/{id}`, `/filter/favourite`, `/filter/{id}/permission[/{permissionId}]` | public; a search over all filters is unknown on DC |
| Dashboards | `GET /rest/api/2/dashboard`, `/dashboard/{id}` | public; copy unknown → manual change |
| Remove page label | `DELETE /rest/api/content/{id}/label/{label}` (or `?name=`) | public |
| Remove space category | `DELETE …/space/{key}/category/{name}` (mirror of the add call) | confirm in WADL |

**Task 1** records the confirmed paths and bodies in this file. It checks the WADL (`/rest/application.wadl` style listings already used by earlier changes), the project config and admin web-resource JavaScript for internal paths, and GET responses for shapes.
- An internal path is used only on the verified Jira 11.3.x versions.
- An operation with no path becomes a manual change (spec) or is dropped, and the spec is revised if a stated behavior cannot be met.

### One assignment tool, typed by scheme
`jira_assign_project_scheme` takes `scheme_type` rather than five tools. Every type shares one flow: read the current scheme, already-satisfied, path or manual change, read-back. The permission scheme keeps its existing tool, and the description points to it.

For workflow and issue type schemes, the dry run checks whether a migration would be needed and returns a manual change if so:
- **Workflow schemes:** the statuses used by the project's issues (JQL counts per status) compared with the statuses the target scheme's workflows contain.
- **Issue type schemes:** the issue types used by the project's issues, compared with the target scheme.

The manual change gives the project admin page (`/plugins/servlet/project-config/{key}/…`) and is verified by re-running.

### Removing issue types from a scheme
The tool reuses the full-list `PUT`, as additions do. Its plan `state` is only "are the named types present", following the change-plan contract, so additions and removals on one scheme in one plan do not drift each other. The list is rebuilt from the scheme as read at apply time.

### Permission scheme copy
Grants are read from the source scheme with `expand=permissions,user,group,projectRole,field`. They are sent as the new scheme's `permissions` and compared on read-back by `(permission, holder type, parameter)`. Copy is creation with grants; there is no separate copy call.

### Filters
- **Listing:** the tool tries the verified search path. If DC has none, it lists the favourites and says that only favourites are listed (a filter by id stays readable).
- **JQL:** checked with `POST /rest/api/2/jql/parse` (or the search validation already used by `jira_search`) before planning.
- **Shares:** compared by `(type, group | project | role)`.
- **Deleting:** the dry run carries the favourite count.

### Confluence
- **`confluence_remove_label`:** sends one DELETE per label as the batch result, so each label is a plan item.
- **`confluence_remove_space_category`:** mirrors the add tool's verification (read the categories back).

## Risks / Trade-offs

- **[Assignment endpoints may not exist on DC]** → Manual change with links and re-run verification. No websudo form automation.
- **[Assigning workflow or issue type schemes migrates issues]** → Detected in the dry run, so the tool hands off to the UI and never triggers a migration through REST.
- **[Filter visibility depends on the caller]** → Not-found and partial-list wording in results, and favourites flagged as the source.
- **[Deleting versions or filters is destructive]** → Dry run with counts. The docs say "irreversible", and the UI check plan follows.

## Migration Plan

Additive tools; rollback removes them.

## Open Questions

- Whether Jira DC 11.3 offers a filter search over all filters. This only changes the listing source, not behavior.

## Live check (task 6.2, dry runs and reads only, no write sent)

One context on both instances.
- **`jira_assign_project_scheme`:** notification, issue type and workflow came back already-satisfied; field configuration gave a manual change.
- **Dry runs:**
  - `jira_remove_issue_types_from_scheme`: PUT;
  - `jira_delete_version`: POST removeAndSwap, with issue counts;
  - `jira_create_permission_scheme` with `copy_from`: POST;
  - `jira_create_filter`: POST, and invalid JQL is refused with Jira's message.
- **Manual change:** `jira_create_screen`.
- **Reads:** `jira_list_filters` and `jira_list_dashboards`.
- **Already-satisfied:** `confluence_remove_label` for a label the page lacks, and `confluence_remove_space_category` for a category the space lacks.

**Fixed after the live run:**
- `GET /rest/api/2/screens` requires `startAt` together with `maxResults` on this Jira; `jira_create_screen` now sends both.
- Confluence 10.2 returns a space's `metadata.labels` without `_links`. The category reader treated that as an unknown shape and every read as incomplete, which also blocked `confluence_add_space_category`. A page shorter than its limit now counts as the last page; a full page still counts as incomplete.

**Known gaps (data this Jira does not offer):**
- **Field configuration schemes:** a project's field configuration scheme cannot be read over REST, so a re-run after the manual change cannot verify it and stays a manual change, which says so.
- **Issue type screen schemes:** verification depends on "Where is my field" naming the scheme.
- **Filters:** no favourite count, so the delete dry run says the count is unavailable and shows the subscription count instead.
- **Dashboards:** only id, name and links, so owner and shares are shown when present.
- **Filter list:** favourites only.
- **`scheme_id`** in `jira_assign_project_scheme` takes ids only.
