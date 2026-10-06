# Design

## Context

See proposal.md for motivation and specs/ for the required behavior. Tools are `ToolDef` modules (Zod inputs, handler, `guardedWrite()` for writes) registered by area in `src/tools/index.ts`. Plans (`src/plan.ts`) store dry runs and, on `apply`, repeat each dry run and compare a digest of `request`, `followUps` and `objects` to detect drift. Plans have no notion of an already-satisfied write, do not record outcomes, and cannot refer to an object that an earlier item creates.

API surface, verified on Jira 11.3.6 (build 11030007) from the instance's `application.wadl` files and read-only sample responses:

| Need | Endpoint | Kind |
|---|---|---|
| Create custom field | `POST /rest/api/2/field`; types/searchers `GET /rest/globalconfig/1/customfieldtypes` | public / bundled plugin |
| Field contexts | `GET,POST /rest/internal/2/field/{f}/context`, `GET,PUT,DELETE …/context/{ctx}` | internal (Atlassian KB: "not officially supported") |
| Field configuration contents | `GET /rest/internal/2/fieldConfiguration/{id}?page&maxResults&query` (fields: id, name, description, hidden, required, …; `configName`, `default`), `GET …/{id}/projects` (`associatedProjects`) | internal |
| Field configuration in effect | `GET /rest/whereismycf/1.0/fields/{customfield_N}?projectKey&issueTypeId&issueOperation=0\|1` (create/edit; `2` returns HTTP 500): status lines name the field configuration and the screen, and include screen, screen scheme and issue type screen scheme ids when the field is missing from the screen | bundled plugin ("Where is my field") |
| View screen of an issue type | `GET /rest/projectconfig/1/issuetype/{project}/{issueTypeId}/fields` → `viewScreen{screenId, screenName, sharedWithProjects, sharedWithIssueTypes, totalProjectsCount, hiddenProjectsCount}` | bundled plugin |
| Screen tabs/fields | `GET /rest/api/2/screens` (Jira 11 key `screens`), `…/{s}/tabs`, `…/tabs/{t}/fields`, `POST …/fields`, `DELETE …/fields/{f}`, `POST …/fields/{f}/move` | public |
| Field description in a field configuration | none in REST; admin form `EditFieldLayoutItem!default.jspa?id={config}&fieldId={f}` (link returned by the internal field configuration resource) | admin UI form |
| Board | `GET /rest/agile/1.0/board/{b}/configuration`; `GET /rest/greenhopper/1.0/rapidviewconfig/editmodel?rapidViewId`; `GET …/detailviewfield/{b}/configured\|available`, `POST …/detailviewfield/{b}/field`, `DELETE …/field/{id}`, `POST …/field/{id}/move`; `GET …/cardlayout/{b}/{mode}/field`; `GET …/quickfilters/{b}` | public / Jira Software internal |

There is no REST for listing field configurations, field configuration schemes, screen schemes or issue type screen schemes.

## Goals / Non-Goals

**Goals:**

- Use internal APIs only where public REST has no equivalent, behind one version gate, and label those tools in their descriptions and in `REFERENCE.md`.
- Make writes re-runnable: already-satisfied instead of duplicate changes, outcomes kept in the plan, read-back after each confirmed change.

**Non-Goals:**

- Editing field configuration schemes, screen schemes or issue type screen schemes, copying shared configurations, or other admin forms besides the description edit.
- Parsing admin HTML pages for usage data (decided: REST scans only).
- Applying JC-83 on its instance; that is a later, confirmed run of the tools.
- Deleting custom fields as part of a rollback.

## Decisions

### One version gate for internal APIs

A shared helper reads `serverInfo.version` once per client and compares it to an allowed pattern (`11.3.x`). Context writes, the description form, and Detail View writes call it before building their request, so a refused version sends nothing, not even the dry-run reads that only a write needs. Reads through internal APIs are not gated. If they fail on another version, the error names the endpoint and the version. Alternative: gate per tool with its own check; rejected because the version rule must be identical everywhere and easy to extend to new verified versions.

### Already-satisfied as a tool result

A write handler that finds its target state already in effect returns `{ already_satisfied: true, summary, reason }` instead of a dry run. The CLI shows it without a confirmation dialog, does not add it to a plan, and exits 0. `applyPlan` records such an item as `already-satisfied`. Alternative: return a dry run with an empty request; rejected because it would still ask for confirmation and would be planned.

### Plan outcomes in the plan file

`applyPlan` writes `outcome: { status, at, detail }` into each item and saves the plan after every item, so an interrupted apply keeps what finished. Items whose outcome is `done` or `already-satisfied` are skipped on the next `apply`. Items unticked in the confirmation checklist are recorded as `declined`. `renderPlan` shows the outcome per item and a "remaining N" line. The file stays version 1, and the new fields are optional, so older plans still load.

### Field references and plan identity

Field arguments accept `customfield_N`, a system field id, or the exact field name. A resolver returns the id, or, in a dry run only, a pending reference when the name does not exist yet. Write handlers put an `identity` object in their dry run: the request with each field id replaced by the reference as given (`{field: "Release URL"}` when given by name). `digestOf` uses `identity` when present instead of `request`. So a context planned before its field existed does not drift once item 1 created the field, while a change to the target state still does. Executing with an unresolved name fails before sending. Alternative: one composite tool with follow-up steps (like `jira_create_issue`); rejected because each step must be confirmed separately and resumable.

### Target state in the drift digest

Screen and Detail View writes include in their dry run (`state`) the part of the current list the change depends on, and the digest covers it:
- **Removal:** whether the field is present.
- **Addition or move to a position:** whether the field is present, plus the field the target position follows (its anchor).
- **Board `add_fields`/`remove_fields`:** whether each named field is present.
- **Complete `fields` list:** the whole current list.

A first version used the whole list in every case. Review showed that a plan with several changes to one tab or board (the JC-83 removals) then drifted itself, because each executed item changed the list the next one was planned against. Alternative: compare only the request; rejected because a positional change means something else once its anchor moved.

### Read-back after confirmed changes

Write handlers that change configuration read the target again after the request and compare it with the intended state. A mismatch raises a verification error (exit 1) carrying the stored state. A match returns the read-back state, for example the screen's tabs and fields as `jira_get_screen` returns them. This replaces the raw response, which for these endpoints is empty or not meaningful.

### Field configuration in effect via "Where is my field"

There is no REST for field configuration schemes. For a project and an issue type, the tool asks the bundled "Where is my field" resource for the create operation, using any custom field as a probe: a field outside the project's scope still gets the field configuration and screen lines (verified on 11.3.6). The status line names the field configuration in effect. Its id is found by reading `fieldConfiguration/{id}` from 10000 and matching `configName`. Jira allocates entity ids in blocks of 100, and a restart starts a new block, so ids are read block by block: consecutive ids from each block start until three are missing, then the next block, until ten blocks in a row are empty (at most 2000 reads, cached per run). The system default field configuration is served as id `-1` (`default: true`), and its `/projects` lists the projects that have no field configuration scheme; the same configuration also answers under its database id (10000 on the instance), which is what its edit links use, but there its `/projects` list is empty. The default is therefore read through `-1` for sharing and identified for writes by the id in its `actions.edit` link. Jira enforces unique names, so a name identifies one configuration. The scheme name is reported only when an API names it. Otherwise it is reported as not available. Alternative: parse `ViewFieldLayoutSchemes.jspa`; rejected by the user in favour of REST only.

### Screen usage by bounded scan

For each project (up to `scan_projects`) and each of its issue types:
- **Create and edit:** the screen comes from "Where is my field" with the same probe field. The screen name is mapped to an id through the screen list; Jira screen names are unique.
- **View:** the screen comes from the project-config resource, which gives its id and sharing directly.

Screen scheme and issue type screen scheme ids and names are included when a status line provides them. Requests run through `boundedAll`; 403/404 projects are counted and reported. Alternative: HTML parsing of screen scheme pages; rejected by the user.

### Description change prepared, entered manually

The handler loads `EditFieldLayoutItem!default.jspa` for the field configuration and field, reads the form's XSRF token and current description, and posts the form with the new description. It keeps the session cookies of that GET for the POST. Every other form value is sent back unchanged. The dry run reports the old value from the internal field configuration resource and does not load the form. Exact form field names and the websudo behaviour with a personal access token are captured from the instance before implementation. If websudo blocks token-authenticated form posts, the tool stays read-only on that path and the spec is revisited.

**Decision after task 1.2:** the user chose to keep the tool to a dry run. Executing it returns an unsupported result that carries the edit link (`actions.edit` of the field configuration item) and the description to enter, and it sends nothing. A later run of the same arguments reports already-satisfied once the stored description matches, which verifies the manual edit. The form is never loaded or posted.

**Finding (task 1.2, Jira 11.3.6):** a token-authenticated GET of `EditFieldLayoutItem!default.jspa?id=10000&fieldId=…` returns HTTP 200 with the "Administrator Access" websudo page instead of the form. Jira sets `JSESSIONID` and `atlassian.xsrf.token` cookies, but the form itself is only served after websudo authentication, which needs the user's password. A personal access token cannot pass websudo, so the description write is blocked as long as websudo is enabled on the instance; this is the case where the spec must be revisited.

### Detail View changes as add/remove/move steps

`set`, `add` and `remove` compute an ordered target list from the configured list. They map field ids or names through the board's `available` and `configured` lists, then emit the minimal sequence of internal calls: removals, additions, moves. Untouched fields keep their relative order. The move request body is taken from the board configuration page's own JavaScript on the instance before implementation.

**Finding (task 1.2, Jira 11.3.6):** the Detail View tab is an `AJS.RestfulTable` over `detailviewfield/{board}/field/`. Its move call is `POST {row url}/move` with JSON `{"after": "<absolute url of the previous row>"}` or `{"position": "First"}`. The row url is `…/rest/greenhopper/1.0/detailviewfield/{board}/field/{detailViewFieldId}`. `rapidviewconfig/editmodel` already contains `detailViewFieldConfig` (configured and available fields, `canEdit`) and `cardLayoutConfig`, so the board read uses `editmodel` and the separate card layout resource is not needed; that resource also requires a mode value the page does not expose. The edit right comes from `editmodel` (`canEdit`) and is checked before any change.

### Custom field types

`text-single-line`, `url` and `date-picker` map to Jira's `com.atlassian.jira.plugin.system.customfieldtypes:textfield`, `:url` and `:datepicker`, with their default searchers taken from `/rest/globalconfig/1/customfieldtypes`. Full type keys are accepted when that resource lists them. Duplicate detection reads `/rest/api/2/field`, matches names ignoring case, and compares `schema.custom`.

### Modules

- `fieldConfigurations.ts`: read and the description write.
- `screens.ts`: list, get, usage and field changes. The list/get tools move from `fields.ts`, and the list response key is fixed.
- `customFields.ts`: create, contexts and screen placement.
- `boardConfig.ts`: board configuration read and Detail View changes.

Shared helpers: the version gate, the field resolver, already-satisfied, and the probe-field lookup. Each area gets its own `TOOL_GROUPS` entry.

## Risks / Trade-offs

- [Internal and plugin APIs change without notice] → Writes are gated to 11.3.x; reads fail with the endpoint and version named; `REFERENCE.md` lists which tools use which API kind.
- ["Where is my field" disabled or its message format changes] → The tool reports the field configuration or the create/edit screens as unresolved and asks for ids. It never guesses. Message parsing is covered by fixtures captured on 11.3.6.
- [Screen usage scan is slow on large instances (projects × issue types × 2 requests)] → `scan_projects` cap, bounded concurrency, `--out`, and a truncation flag. Delegate to a subagent.
- [Field configuration id scan may miss ids beyond the cap] → Cap and gap limit are reported. `field_configuration_id` can always be given directly.
- [Admin form is behind websudo for token auth (confirmed on 11.3.6)] → The description change is prepared and verified by the tool but entered manually in the UI.
- [Name references resolve to the wrong field when names change between plan and apply] → Resolution is exact and fails on ambiguity. The identity digest includes the name, so a renamed field leaves the reference unresolved instead of silently matching another.

## Migration Plan

1. Add the tools and plan extensions; the plan format stays compatible (new optional fields).
2. Regenerate `REFERENCE.md`, update `SKILL.md`.
3. Rollback: remove the new modules and registry entries. Plans written with outcomes still load in the previous version, which ignores the extra fields.

## Open Questions

- Whether "Where is my field" names the field configuration and screen the same way for sub-task issue types. A fixture captured during implementation answers this; it does not change the approach.
