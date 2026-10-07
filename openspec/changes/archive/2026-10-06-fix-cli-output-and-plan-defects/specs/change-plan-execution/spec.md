# Spec Delta

## ADDED Requirements

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
