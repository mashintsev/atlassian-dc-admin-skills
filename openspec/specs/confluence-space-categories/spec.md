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
The system SHALL expose an additive space-category write tool that defaults to dry run, displays the exact target request, supports native plan recording, and preserves every existing category. It MUST NOT apply page-label writes to a homepage as a substitute. Invalid category names SHALL be rejected without silently changing the requested name.

#### Scenario: Dry-run addition
- **WHEN** the user prepares a valid missing category for a space
- **THEN** the tool returns the exact addition request and performs no remote mutation
- **AND** the request can be recorded alongside permission grants in a native plan

#### Scenario: Existing category
- **WHEN** the requested team category already exists
- **THEN** reconciliation reports it as already satisfied and records no addition item

#### Scenario: Invalid category
- **WHEN** the requested name is empty or invalid under the supported category naming rules
- **THEN** the tool reports a validation error and sends no mutation

### Requirement: Category result verification
The system SHALL verify category additions by reading space categories after execution. A successful HTTP response alone MUST NOT be reported as a verified final state.

#### Scenario: Addition returns success but read-back differs
- **WHEN** the server accepts the request but the requested team category is absent on read-back
- **THEN** the result reports verification failure rather than verified success
