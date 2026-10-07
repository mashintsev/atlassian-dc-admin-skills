# Design

## Context

See proposal.md and specs/. `jira_list_workflows` (public `/rest/api/2/workflow`) and the workflow scheme tools exist. The change-plan contract and the Jira version gate exist.

Verified on Jira 11.3.6 (WADL plus read-only calls on a test project):
- **Workflow of a project and issue type:** `GET /rest/projectconfig/1/issuetype/{project}/{issueTypeId}/workflow` returns `{name, displayName, state, isDraftWithChanges, sharedWithProjects, sharedWithIssueTypes, totalProjectsCount, hiddenProjectsCount, updatedDate}`.
- **Structure:** `GET /rest/workflowDesigner/1.0/workflows?name=…` returns `{isDraft, layout: {statuses[], transitions[], …}, workflowPermissions}`.
  - Statuses carry `id, name, initial, stepId, statusId, …`.
  - Transitions carry `id, name, sourceId, targetId, actionId, initial, description, globalTransition, loopedTransition, transitionOptions`.
- **Designer writes:** `POST/PUT/DELETE …/workflows/statuses`, `POST …/workflows/statuses/create`, `POST …/workflows/statuses/validateRemove`, `POST/PUT/DELETE …/workflows/transitions`, `…/globalTransitions`, `…/loopedTransitions`, `POST …/workflows` (create), `POST …/workflows/publishDraft`, `POST …/workflows/discardDraft`, `POST …/workflows/validation`, `GET …/statuses`, `GET …/statusCategories`.
- **Project-config workflows:** `POST /rest/projectconfig/1/workflow` (body unknown, likely a copy for a project) and `GET …/workflow/project/{key}`.
- **Transition properties:** `GET/POST/PUT/DELETE /rest/api/2/workflow/transitions/{id}/properties` (public).
- **Not available:** conditions, validators and post-functions are not in the designer response. The workflow XML export (`ViewWorkflowXml.jspa`) returns the websudo page to a token-authenticated GET.

## Goals / Non-Goals

**Goals:**
- A faithful read of everything REST exposes, with an explicit "not available" for rules.
- Editing through the designer resources the Jira UI itself uses, including drafts.

**Non-Goals:**
- Reading or editing conditions, validators, post-functions, transition screens' field contents, or workflow XML import/export.
- Layout positions beyond what the designer requires for new statuses.

## Decisions

### Read model
`jira_get_workflow` merges three sources:
- **projectconfig:** sharing and draft state, when a project and issue type are given;
- **designer:** statuses and transitions, with ids mapped to status names and categories from `GET /rest/workflowDesigner/1.0/statuses`;
- **public API:** transition properties, one call per transition and bounded.

Global transitions read with source "any". Looped transitions read as from every status to itself. The output names the rule gap explicitly.

### Comparison by names
Workflows are compared by status names and by transitions keyed `source name → target name`, because status ids are shared across workflows but step and action ids are not. The same comparison serves `jira_compare_workflows` and the publish dry run (draft vs live).

### Request bodies from the designer's JavaScript
The designer write bodies, the copy request (`POST /rest/projectconfig/1/workflow`, or the designer `POST workflows` with a source), and how a draft is addressed (a `draft` flag or a separate draft name) are taken from the workflow designer's JavaScript before implementation (task 1). The designer page itself sits behind websudo, but its web resources can be loaded by their resource keys. If they cannot be loaded, the bodies are derived from the WADL parameters and verified with dry runs only, and the risk is recorded.

**Findings (task 1.2, Jira 11.3.6, web resource `com.atlassian.jira.plugins.jira-workflow-designer:workflow-designer-io` and the designer dialogs):**
- **Form parameters:** designer writes send form parameters (`application/x-www-form-urlencoded`) and `X-Atlassian-Token: no-check`:
  - `POST workflows/statuses {statusId, workflowName, createGlobalTransition}`
  - `POST workflows/statuses/create {name, description, statusCategoryId, workflowName, createGlobalTransition}`
  - `PUT workflows/statuses {statusId, name, description, statusCategoryId, workflowName}`
  - `DELETE workflows/statuses {statusId, workflowName}`
  - `POST workflows/statuses/validateRemove {statusId, workflowName}`
  - `POST workflows/transitions {name, description, screenId, sourceStepId, targetStepId, workflowName}`
  - `PUT workflows/transitions {transitionId, sourceStepId, name, description, screenId, workflowName}`
  - `DELETE workflows/transitions {transitionId, sourceStepId, workflowName}`
  - `POST/PUT/DELETE workflows/globalTransitions {statusId | transitionId, name, description, screenId, workflowName}`
  - `…/loopedTransitions` takes the same fields.
- **JSON calls:** `POST workflows/validation {workflowName}`, `POST workflows/publishDraft {name, draft, layout}` (the layout as read), and `POST workflows/discardDraft` with the workflow name as body.
- **Draft creation:** `GET workflows?name=…&draft=true` loads the draft and **creates it** when missing. `preferDraft=true` reads the draft only if it exists. Writes address the workflow by name; for an active workflow they apply to its draft.
- **Websudo:** a token-authenticated `POST workflows/validation` answers 200, so designer writes are not behind websudo for tokens. The UI still wraps calls in its websudo handler.
- **No backup copy:** publishing has no backup option.
- **Copying (decision: dropped from scope):** there is no general copy call. `POST /rest/projectconfig/latest/workflow` (body: a project id) copies the default workflow for a project, switches its scheme and starts an issue migration task. The admin `CloneWorkflow` form is behind websudo.
- **Text view:** `GET /rest/projectconfig/1/workflow?workflowName=…` returns statuses with categories and named transitions, without rules.

**Confirmed on the project instance (Jira 11.3.7, tasks 1.1–1.2):**
- **Same resources and structures:**
  - a designer status is `{id, name, initial, stepId, statusId, x, y, statusCategory{id, colourName}}`;
  - `GET workflowDesigner/1.0/statuses` returns `{id, name, description, iconURL}`;
  - `statusCategories` returns `{id, key, name, colorName}`.
- **Rule counts per transition:** each transition's `transitionOptions` are `{key, name, count, url, weight}` for Properties, Triggers, Conditions, Validators and Post Functions. The read reports these counts and the admin links; the rule contents stay unavailable.
- **Changing a target:** `POST workflows/transitions/target` takes `{transitionId, targetStatusId, workflowName}`; `…/source` takes `{transitionId, newSourceStatusId, originalSourceStatusId, workflowName}`.
- **Active workflows:** no response marks a workflow as active. Project-config `state` is `editable` either way, and the designer permissions are identical. A workflow is therefore treated as active when a workflow scheme of a project uses it (the scan behind `jira_find_workflow_usage`, cached per run). The same list gives the projects a publish affects.

### Drafts are implicit
Edits to an active workflow target its draft. The tool creates the draft when needed, and the dry run says "goes to draft". Publishing is a separate change. Writes put in `state` only what they depend on: the presence of the status or transition, and for an update the stored values it changes. Several edits in one plan therefore do not drift each other, following `change-plan-execution`.

### Review decisions (implementation)
- **Incomplete scans:** a scan that is truncated or saw 403s and finds no scheme using the workflow refuses the edit, so an unscanned active workflow is never edited live. The scan is not cached, so a scheme changed earlier in a plan is seen.
- **Global statuses:** `jira_update_workflow_status` changes a global status. It creates no draft and reads back whichever version exists.
- **Removal check timing:** `validateRemove` runs in the dry run only when it cannot touch a draft (an inactive workflow, or a draft that already exists). Otherwise it runs on apply, after the draft is loaded and before the delete.
- **Partial changes:** when a later request of a multi-request change fails, the error is a `VerificationError` carrying the read-back.
- **Publish/discard in plans:** their `state` is only `{hasDraft: true}`, so edits earlier in the same plan do not drift them. A draft created by those edits does not exist yet when the plan is built, so the publish is planned after `apply` (a second plan).

### Removal safety
Status removal first calls `validateRemove` and refuses with Jira's message when removal is not allowed (status in use by issues, or the initial status). Publishing never migrates issues. If Jira requires a migration to publish (statuses removed while issues use them), the publish fails with Jira's message and the user is pointed to the UI.

## Risks / Trade-offs

- [Designer resources are internal and change between releases] → Jira 11.3.x gate and fixtures captured on 11.3.6.
- [Unknown request bodies] → Task 1. If a body cannot be confirmed, that tool is not implemented and the spec is revised.
- [Rules cannot be read, so comparisons miss rule differences] → Results state the gap explicitly. The comparison is a status-model comparison.
- [Publishing affects every project that uses the workflow] → The dry run lists the projects, and the publish is its own confirmed change.

## Migration Plan

Additive tools. Rollback: remove the module.
