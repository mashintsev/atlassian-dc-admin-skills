# Proposal

## Why

Select fields need their values configured. For example, Severity needs the options 1–4 for the bank incident flow. The skill can create a custom field and read its options, but it cannot write options, so values have to be entered by hand in the admin UI. Jira 11.3.6 exposes a bundled REST resource that sets a custom field's options (`/rest/globalconfig/1/customfieldoptions/{customFieldId}/setOptions`, verified in the instance's WADL).

## What Changes

- **Reading:** a read tool lists a select field's options per context, in order, with their enabled state.
- **Writing:** one write tool sets the options of a context that has none yet, in order (Severity 1–4 on a new field). It follows the change-plan rules (dry run, already-satisfied, drift detection, read-back), and a field created earlier in the same plan can be referenced by name.
- **Manual changes:** Jira's options resource only supports setting option names, as its own "add field" wizard does. So changes to existing options (add, rename, reorder, disable, enable) are prepared as a manual change: a dry run with the steps and the options page link, verified by re-running the tool. Options are never deleted.

## Capabilities

### New Capabilities

- `jira-custom-field-options`: Read and set the options of select-type custom fields per context, including order and disabled options, without deleting options.

### Modified Capabilities

None.

## Impact

- **Code:** `src/tools/jira/customFields.ts`, or a new `fieldOptions.ts`, with tests; it reuses `fieldRefs.ts` and the context reading from `customFields.ts`.
- **APIs:** bundled `POST /rest/globalconfig/1/customfieldoptions/{customFieldId}/setOptions` (`{options: [{name}], issueContext: {projectId, issueTypeId}}`); public `GET /rest/api/2/customFields/{numericId}/options` and `GET /rest/api/2/customFieldOption/{id}`; internal `GET /rest/internal/2/field/{id}/context`.
- **Docs:** `SKILL.md` and `REFERENCE.md`.
