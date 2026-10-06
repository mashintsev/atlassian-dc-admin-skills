# Proposal

## Why

Setting up a Jira Service Management project for a new request flow means creating request types, tying them to issue types, arranging them on the portal and shaping their forms. The skill can only read request types and their fields, so all of this is done by hand in the project settings, without dry runs or reviewable plans. On Jira 11.3.6 with JSM 11.3.5 these operations are exposed through REST (verified from the instance's WADL), partly public and partly internal.

## What Changes

- **Request types:** create a request type for an issue type, change its name, description, help text and issue type, hide or show it on the portal, and delete it. Creating is idempotent by name; deleting asks for the irreversible-change warning.
- **Portal groups:** add a request type to a portal group, remove it from a group, and change its position within the group.
- **Forms:** read a request type's form (visible and hidden fields, labels, descriptions, required, presets). Add, remove and reorder visible fields; change a field's label, description and required flag; hide a field with a preset value or show it again.
- **Writes:** all writes follow the change-plan rules (dry run, already-satisfied, drift detection on what the change depends on, read-back after applying). Internal JSM APIs are used only on verified JSM versions.

## Capabilities

### New Capabilities

- `jsm-request-type-management`: Create, change, hide, delete request types and arrange them in portal groups.
- `jsm-request-type-form`: Read and change the fields of a request type's form, including hidden fields and presets.

### Modified Capabilities

None.

## Impact

- **Code:** a new `src/tools/jira/requestTypes.ts` (and tests). The JSM version gate goes in `src/jiraVersion.ts` and is shared with `add-jsm-queue-sla-management`. Existing reads in `servicedesk.ts` are reused where they fit.
- **APIs:**
  - public `/rest/servicedeskapi/servicedesk/{id}/requesttype` (POST, PUT, DELETE);
  - internal `/rest/servicedesk/1/servicedesk/{projectId}/request-type-groups/*` and `/rest/servicedesk/1/servicedesk/{requestTypeId}/request-type-fields/*`.
- **Docs:** `SKILL.md` and `REFERENCE.md`.
- **Dependencies:** no new dependency.
