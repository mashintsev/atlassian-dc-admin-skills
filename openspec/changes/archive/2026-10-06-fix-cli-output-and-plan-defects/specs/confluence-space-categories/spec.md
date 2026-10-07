# Spec Delta

## MODIFIED Requirements

### Requirement: Additive dry-run-first category changes
The system SHALL expose an additive space-category write tool that defaults to dry run, displays the exact target request, supports native plan recording, and preserves every existing category. It MUST NOT apply page-label writes to a homepage as a substitute. Invalid category names SHALL be rejected without silently changing the requested name. When the category already exists, both the dry run and the execution SHALL report `already_satisfied` with the reason, send nothing, and record no plan item.

#### Scenario: Dry-run addition
- **WHEN** the user prepares a valid missing category for a space
- **THEN** the tool returns the exact addition request and performs no remote mutation
- **AND** the request can be recorded alongside permission grants in a native plan

#### Scenario: Existing category
- **WHEN** the requested team category already exists
- **THEN** reconciliation reports it as already satisfied and records no addition item

#### Scenario: Existing category in a direct dry run
- **WHEN** `confluence_add_space_category` is dry-run for a category the space already has
- **THEN** the result is `already_satisfied` and adding it to a plan records nothing

#### Scenario: Invalid category
- **WHEN** the requested name is empty or invalid under the supported category naming rules
- **THEN** the tool reports a validation error and sends no mutation

### Requirement: Category result verification
The system SHALL verify category additions by reading space categories after execution. A successful HTTP response alone MUST NOT be reported as a verified final state. A read-back that cannot confirm the addition, or that shows a previous category missing, SHALL be reported as a verification error (`VerificationError`), not as an argument validation error.

#### Scenario: Addition returns success but read-back differs
- **WHEN** the server accepts the request but the requested team category is absent on read-back
- **THEN** the result reports verification failure rather than verified success
- **AND** the error type is `VerificationError`
