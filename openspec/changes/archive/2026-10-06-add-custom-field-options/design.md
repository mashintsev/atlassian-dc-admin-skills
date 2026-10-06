# Design

## Context

See proposal.md and the spec. Custom fields, contexts and field references exist (`customFields.ts`, `fieldRefs.ts`). The change-plan contract (already-satisfied, `identity`/`state`, outcomes, read-back) and the Jira version gate exist.

Verified on Jira 11.3.6:
- **Reading options:** `GET /rest/api/2/customFields/{numericId}/options` answers with `{options, total}`. It takes the numeric id: `customfield_N` gives 404. `GET /rest/api/2/customFieldOption/{id}` reads one option. Contexts come from `GET /rest/internal/2/field/{id}/context` (with `fieldConfigIds`).
- **Writing options:** `POST /rest/globalconfig/1/customfieldoptions/{customFieldId}/setOptions` takes and returns JSON. Its body is not in the WADL. The resource belongs to the project-config plugin's global configuration, which also creates custom fields with options from the project settings.
- **Admin form:** the options page (`EditCustomFieldOptions.jspa`) is behind websudo, like other admin forms, so it is not an alternative.

## Goals / Non-Goals

**Goals:**
- Set the options of an empty context through REST; prepare and verify every other option change for the UI; never delete.

**Non-Goals:**
- Deleting options; the second level of cascading selects; default values; option-based issue migration.

## Decisions

### Decision after task 1.1
The user chose to write only to contexts without options. A context that has options gets a manual-change dry run with the steps and the options page link (`/secure/admin/EditCustomFieldOptions!default.jspa?fieldConfigId={fieldConfigIds[0]}`). This is the same contract as field descriptions in field configurations: execution reports `Unsupported`, and a re-run verifies.

Reading uses `GET /rest/api/2/customFields/{numericId}/options` with `projectIds` and `issueTypeIds`, set to the same pair as the write's `issueContext`. Options read as `{id, value, disabled, childrenIds}`. Before a write, the tool checks two things: the target context is empty, and no other context of the field covers the pair more specifically. Jira resolves a pair as specific project and issue type, then project, then issue type, then global.

### Request shape from the page that uses it
Task 1 captures the `setOptions` request body from the JavaScript that calls it. It also answers two questions:
1. Does the body carry the complete list (replacing it) or changes?
2. Can it address a specific context or field configuration?

If the body replaces the list, the tool always sends the complete list: the stored options it keeps, with their ids, plus the new ones. Omitting an option would delete it. If it cannot address a context, requests for other contexts are refused (spec: "Context not addressable"). Alternative: post the admin form; rejected because it is behind websudo.

**Finding (task 1.1, Jira 11.3.6):** the only caller is the project settings "add custom field" wizard (web resource `com.atlassian.jira.jira-project-config-plugin:custom-fields-impl`). After creating the field with `POST /rest/api/2/field`, its `addOptions` step sends:

```
POST /rest/globalconfig/1/customfieldoptions/{fieldId}/setOptions
{"options": [{"name": "…"}, …], "issueContext": {"projectId": <id or null>, "issueTypeId": <id or null>}}
```

`options` is the wizard's ordered list mapped to `{name}`. There are no option ids and no disabled flag. The context is not given by id: Jira picks the one that applies to the project and issue type, or the global one when both are null. The wizard only calls it for a field it has just created. Whether a second call on a context that already has options replaces or appends them cannot be seen from the client code. Consequences for the spec:
- renaming by id, disabling, re-enabling and reordering existing options have no REST path (the admin options page is behind websudo);
- writing to a context that already has options risks deleting options in use, if the call replaces them.

### Target list semantics
The list gives the wanted order of the named options. Unnamed existing options are appended in their previous order and reported in the dry run. Values compare exactly. Renames are only by option id, so a value change can never be mistaken for a new option.

### Drift and identity
`identity` holds the field reference as given, the context, and the target list. `state` holds the stored options (id, value, disabled) of that context when the field was given by id. For a field given by name, the stored options take no part, so a plan can create the field and then set its options, as for contexts.

### Version gate
`setOptions` belongs to a bundled plugin of Jira, so writes call `requireJiraVersion` (11.3.x).

## Risks / Trade-offs

- [A replacing body could delete options that issues use] → Always send every stored option. Verify after the write that no option id disappeared. If one did, report it as a `VerificationError` naming the lost options.
- [The resource may not be context-aware] → Refuse other contexts instead of writing to the default one.
- [Request body unknown until captured] → Task 1 is read-only and blocks implementation of the write. If no usable body is found, the spec is revisited.

## Migration Plan

Additive tools; no plan format change. Rollback: remove the tools.
