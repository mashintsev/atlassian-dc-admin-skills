# Proposal

## Why

JC-83 needs Jira Data Center configuration changes that the skill cannot make today: field descriptions in a field configuration, fields on screens, the Detail View of a Jira Software board, and new custom fields with their contexts. The skill can only read screens and contexts, so every one of these changes is done by hand in the admin UI, without dry runs, sharing checks or a reviewable plan.

Jira DC 11.3 exposes only part of this through public REST (verified against the instance's WADL on Jira 11.3.6). Contexts, field configurations and board configuration are available only through internal or bundled-plugin REST, and a field's description in a field configuration only through an admin form. This change adds the tools with that boundary made explicit.

## What Changes

- **Field configurations:** `jira_get_field_configuration` reads the field configuration a project and issue type use (or one given by id): its fields with description, hidden/visible and required/optional, and the projects that share it. `jira_update_field_description` ✎ prepares a change of one field's description in one field configuration. It shows the old and new value, the sharing projects and the edit link, and verifies the stored value on a later run. Jira serves the edit form only after websudo re-authentication, which a personal access token cannot pass, so the change itself is entered in the Jira UI.
- **Screens:**
  - `jira_get_screen_usage` reports the projects, issue types and operations (create/edit/view) that use a screen, with a sharing warning.
  - `jira_add_screen_field`, `jira_remove_screen_field` and `jira_move_screen_field` ✎ are idempotent. Their dry run shows the screen, tab, field and affected projects, and their drift check covers the tab's fields and their order.
  - `jira_list_screens` is fixed to read the Jira 11 response key.
- **Boards:** `jira_get_board_configuration` combines the board's saved filter, columns and status mappings, quick filters, card layout, Detail View fields, estimation, sub-filter, administrators and the edit right. `jira_set_board_detail_fields`, `jira_add_board_detail_field` and `jira_remove_board_detail_field` ✎ change the Detail View through the internal Jira Software API, only on Jira 11.3.x. They keep fields that are not targeted (Labels in particular) and their order.
- **Custom fields:**
  - `jira_create_custom_field` ✎ supports at least single-line text, URL and date picker. It looks for fields with the same name first: it reuses an exact name and type match, and stops when the match is ambiguous or of a different type.
  - `jira_create_field_context`, `jira_update_field_context` and `jira_delete_field_context` ✎ manage contexts.
  - `jira_add_field_to_screens` ✎ places a field on several screen tabs.
- **Change plans:**
  - A write whose target state already holds reports `already-satisfied` instead of a change.
  - `apply` records each item's outcome in the plan file, and `plan` shows what remains.
  - Plan items can refer to a custom field by name before it exists, so creating a field, its context and its screen placements can be planned as separate changes that are each confirmed.
- **No rollback deletes:** deleting a custom field is never part of an automatic rollback.

## Capabilities

### New Capabilities

- `jira-field-configuration-management`: Read field configurations used by a project and issue type and change one field's description in one field configuration.
- `jira-screen-field-management`: Report where a screen is used and add, remove or move fields on a screen tab idempotently.
- `jira-board-configuration-management`: Read a Jira Software board's configuration and manage its Detail View fields.
- `jira-custom-field-provisioning`: Create custom fields without duplicates, manage their contexts, and place them on screens.
- `change-plan-execution`: Already-satisfied outcomes, per-item outcome tracking and remaining work in change plans, and references to fields created earlier in the same plan.

### Modified Capabilities

None. The repository has no main capability specifications yet.

## Impact

- **Code:** `src/tools/jira/fields.ts` (screen fix; new modules for field configurations, screens, custom fields and boards), `src/tools/index.ts`, `src/plan.ts`, `src/cli.ts` (already-satisfied handling, outcome tracking), and a version check shared by internal-API tools.
- **APIs:** public `/rest/api/2/field`, `/rest/api/2/screens/*`, `/rest/agile/1.0/board/*`. Internal and bundled-plugin endpoints:
  - `/rest/internal/2/field/*/context*` and `/rest/internal/2/fieldConfiguration/*`;
  - `/rest/whereismycf/1.0/fields/*` and `/rest/projectconfig/1/issuetype/*/*/fields`;
  - `/rest/globalconfig/1/customfieldtypes`;
  - `/rest/greenhopper/1.0/rapidviewconfig/editmodel`, `/rest/greenhopper/1.0/detailviewfield/*`, `/rest/greenhopper/1.0/cardlayout/*`, `/rest/greenhopper/1.0/quickfilters/*`.
- **Admin form:** `/secure/admin/EditFieldLayoutItem!default.jspa` is only linked for a manual edit, never called.
- **Docs:** `atlassian-dc-admin/SKILL.md` and the generated `REFERENCE.md`, which must state which tools depend on internal APIs and which Jira versions they accept.
- **Dependencies:** no new dependency. Applying JC-83 itself is out of scope; it targets a different Jira instance and is a separate, confirmed run of these tools.
