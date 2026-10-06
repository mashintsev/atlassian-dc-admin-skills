# confluence-group-space-discovery Specification

## Purpose

Select Confluence spaces by an exact group's explicit view permissions, with enough completeness evidence to support administrative batch planning.

## Requirements

### Requirement: Exact group access selection
The system SHALL provide read-only space discovery for an exact group name. It SHALL include a space only when that group has an explicit `read:space` grant, preserve the space key's case, and distinguish direct group grants from user, anonymous and global access.

#### Scenario: Exact group matching
- **WHEN** spaces grant access to `example-team`, `example-team-other`, individual users and anonymous visitors
- **THEN** only spaces with an explicit `example-team` `read:space` grant appear in the selected set
- **AND** a grant to the group without `read:space` is reported separately and is not selected

### Requirement: Complete enumeration within declared scope
The system SHALL enumerate all server pages within the selected type/status scope. Without filters, it SHALL cover global and personal spaces in both current and archived status. It SHALL return inspected/selected counts, filters, pagination completion, permission-read failures and a completeness flag. A scan cap, repeated cursor, failed read or unknown permission shape MUST prevent a complete result and MUST prevent batch preparation from accepting that scan.

#### Scenario: Multiple statuses and pages
- **WHEN** current and archived spaces span several server pages
- **THEN** discovery processes every page and deduplicates spaces by stable identity
- **AND** returns each space with its key, name, type, status and group operations

#### Scenario: Incomplete permission audit
- **WHEN** one space returns forbidden access or an unrecognized permission envelope
- **THEN** discovery reports that space as unknown and marks the audit incomplete instead of treating it as no access
- **AND** batch preparation writes no executable update plan from that audit

### Requirement: Honest visibility and bounded output
The system SHALL bound concurrent reads and output size while preserving complete results in an output file. It SHALL describe discovery as complete for the authenticated caller and requested scope. A site-wide completeness claim SHALL require a comparable server count; unavailable or mismatched counts SHALL be reported explicitly.

#### Scenario: Complete operational-sized audit
- **WHEN** 67 visible spaces are fully inspected, the comparable server count is 67, and 52 have the group's view grant
- **THEN** the result reports 67 inspected, 52 selected and a confirmed count cross-check

#### Scenario: Count cannot establish site-wide completeness
- **WHEN** pagination completes but the server metric is unavailable or is larger than the unfiltered enumeration
- **THEN** discovery reports the visibility limitation and does not claim to have enumerated every space on the site
