# change-plan-execution Specification

## Purpose

Makes change plans safe to re-run and resume: writes that are already in effect are recognised, each item's outcome is kept in the plan, and later items can refer to objects that earlier items create.

## Requirements

### Requirement: Already-satisfied outcomes
A write tool whose target state already holds SHALL report already-satisfied with the reason and SHALL NOT send a change. Such a result SHALL NOT be added to a plan as a change and SHALL NOT require user confirmation. During `apply`, an item that has become already-satisfied SHALL be reported as already-satisfied, not as drifted or failed.

#### Scenario: Direct call
- **WHEN** a write tool is called with `dry_run=false` and its target state already holds
- **THEN** no confirmation dialog is shown and nothing is sent
- **AND** the output states already-satisfied

#### Scenario: Apply after the change was made elsewhere
- **WHEN** an item is applied whose target state was reached after planning
- **THEN** the item is reported as already-satisfied

### Requirement: Outcome tracking and remaining work
`apply` SHALL record each item's outcome (done, already-satisfied, failed, drifted, declined) and its time in the plan file. `plan` SHALL show each item's recorded outcome and the number of items still to do. A later `apply` of the same plan SHALL skip items recorded as done or already-satisfied, and SHALL say that it skipped them.

#### Scenario: Partially applied plan
- **WHEN** a plan of five items was applied and items 1–3 succeeded, item 4 failed and item 5 was declined
- **THEN** `plan` shows items 1–3 as done, item 4 as failed, item 5 as declined, and two items remaining
- **AND** the next `apply` runs only items 4 and 5

### Requirement: References to objects created earlier in the plan
A plan item SHALL be able to name a custom field, an issue type or a workflow scheme by its exact name instead of its id. When the object does not exist yet, the dry run SHALL describe the request with the name in place of the id. When the item is applied, the name SHALL be resolved to the id, and drift detection SHALL compare the request with the name in place of the id. A name that is still unresolved when the item is applied SHALL fail the item without sending anything.

#### Scenario: Context for a field created by an earlier item
- **WHEN** item 1 creates field "Release URL" and item 2 creates a context for field "Release URL"
- **THEN** applying the plan executes item 1, then resolves the name and executes item 2 without reporting drift

#### Scenario: Field still missing
- **WHEN** item 2 is applied alone and the field does not exist
- **THEN** item 2 fails with a message that the field was not found and nothing is sent

#### Scenario: Issue type created earlier in the plan
- **WHEN** item 1 creates issue type "Change Request" and item 2 adds "Change Request" to an issue type scheme
- **THEN** applying the plan executes item 1, then resolves the issue type name and executes item 2 without reporting drift

#### Scenario: Workflow scheme created earlier in the plan
- **WHEN** item 1 creates workflow scheme "Ops scheme" and item 2 maps an issue type to a workflow in scheme "Ops scheme"
- **THEN** applying the plan executes item 1, then resolves the scheme name and executes item 2 without reporting drift

### Requirement: Drift detection includes the state a change depends on
For writes whose effect depends on the current state of a list, such as screen tab fields or board Detail View fields, drift detection SHALL include the part of that state the change depends on, as it was at planning time: whether the named fields are present, the field a target position follows, or the whole list when the change sets a complete list. Changes that earlier items of the same plan made to other fields of the list SHALL NOT cause drift.

#### Scenario: Anchor changed after planning
- **WHEN** a field was planned to be added at position 2 after Summary, and Summary moved before the item is applied
- **THEN** applying the addition reports drift

#### Scenario: Several changes to one list in one plan
- **WHEN** a plan removes Components and then Fix Version/s from the same tab
- **THEN** applying it executes both items without reporting drift

### Requirement: Apply exit code reflects the outcomes
`apply` SHALL exit with:
- 0 when every item it ran is done or already-satisfied, and when nothing was left to apply;
- 1 when any item failed;
- 5 (stale) when no item failed but at least one drifted;
- 12 when the user declined the confirmation, as before.

Items declined by unticking them in the checklist SHALL NOT, by themselves, make the exit code non-zero.

#### Scenario: Already satisfied items
- **WHEN** a plan of three items is applied and two are done and one is already-satisfied
- **THEN** `apply` exits with 0

#### Scenario: Drift without failure
- **WHEN** one item drifted and the others are done
- **THEN** `apply` exits with 5 and the output names the drifted item

#### Scenario: Failure
- **WHEN** one item failed and another drifted
- **THEN** `apply` exits with 1

### Requirement: Adding issue types to a scheme is plan-safe
`jira_add_issue_types_to_scheme` SHALL report already-satisfied when every requested issue type is already in the scheme, and the default issue type already matches when one is given. The planned state SHALL record only the presence of the requested types and the requested default. So several items that add different types to the same scheme in one plan SHALL apply without drift. After a confirmed change, the system SHALL read the scheme back and SHALL report a verification error if a requested type is missing.

#### Scenario: Two items on one scheme
- **WHEN** a plan adds issue type A and then issue type B to the same scheme
- **THEN** applying it adds both without reporting drift

#### Scenario: Types already present
- **WHEN** every requested type is already in the scheme
- **THEN** the tool reports already-satisfied and no plan item is recorded
