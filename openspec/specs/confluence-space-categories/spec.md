# confluence-space-categories Specification

## Purpose

Read and add Confluence space categories without confusing them with labels on pages, attachments or blog posts, and without replacing existing categories.

## Requirements

### Requirement: Dedicated category reads
The system SHALL expose a read-only tool for categories of an exact space key. It SHALL retain each category's name and `team` prefix, expose paging/completeness, and distinguish a malformed or unavailable category response from an empty category list.

#### Scenario: Space and page labels differ
- **WHEN** a page has a global label `example-category` and its space has a different team category
- **THEN** the space-category tool returns only categories attached to the space description
- **AND** it does not infer a space category from page labels

#### Scenario: Categories span multiple pages
- **WHEN** a category read has a continuation page
- **THEN** the tool exposes the continuation and the planning workflow follows it before deciding whether a category is missing

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

### Requirement: Remove a space category
The system SHALL provide `confluence_remove_space_category` with a space key and a category name. It SHALL default to a dry run, support plan recording, and keep every other category of the space.

A category that the space does not have SHALL be reported as already-satisfied. The system SHALL NOT remove page labels from the space homepage as a substitute.

After confirmation, the system SHALL read the space's categories back and verify that the category is gone and the others remain. If no removal request is verified for the supported Confluence versions, the tool SHALL answer `Unsupported` and send nothing.

#### Scenario: Remove a category where a removal request is verified
- **WHEN** an administrator removes category "legacy" from a space with "legacy" and "ops", on a Confluence version with a verified removal request
- **THEN** after confirmation the space has category "ops" only

#### Scenario: No verified removal request
- **WHEN** the space has the category and no removal request is verified for this Confluence version
- **THEN** the tool answers `Unsupported`, names the space settings in the UI, and sends nothing

#### Scenario: Category missing
- **WHEN** the space does not have the category
- **THEN** the result is already-satisfied and nothing is sent
