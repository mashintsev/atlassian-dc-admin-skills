# Spec Delta

## Purpose

Makes change plans safe to re-run and resume: writes that are already in effect are recognised, each item's outcome is kept in the plan, and later items can refer to objects that earlier items create.

## ADDED Requirements

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
A plan item SHALL be able to name a custom field by its exact name instead of its id. When the field does not exist yet, the dry run SHALL describe the request with the name in place of the id. When the item is applied, the name SHALL be resolved to the id, and drift detection SHALL compare the request with the name in place of the id. A name that is still unresolved when the item is applied SHALL fail the item without sending anything.

#### Scenario: Context for a field created by an earlier item
- **WHEN** item 1 creates field "Release URL" and item 2 creates a context for field "Release URL"
- **THEN** applying the plan executes item 1, then resolves the name and executes item 2 without reporting drift

#### Scenario: Field still missing
- **WHEN** item 2 is applied alone and the field does not exist
- **THEN** item 2 fails with a message that the field was not found and nothing is sent

### Requirement: Drift detection includes the state a change depends on
For writes whose effect depends on the current state of a list, such as screen tab fields or board Detail View fields, drift detection SHALL include the part of that state the change depends on, as it was at planning time: whether the named fields are present, the field a target position follows, or the whole list when the change sets a complete list. Changes that earlier items of the same plan made to other fields of the list SHALL NOT cause drift.

#### Scenario: Anchor changed after planning
- **WHEN** a field was planned to be added at position 2 after Summary, and Summary moved before the item is applied
- **THEN** applying the addition reports drift

#### Scenario: Several changes to one list in one plan
- **WHEN** a plan removes Components and then Fix Version/s from the same tab
- **THEN** applying it executes both items without reporting drift
