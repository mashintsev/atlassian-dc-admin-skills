# Spec Delta

## Purpose

Preserve usable Confluence user identities in search results and resolve a unique active account before preparing permission grants.

## ADDED Requirements

### Requirement: User search preserves identifiers
The system SHALL preserve available usernames and user keys from supported modern and legacy user-search responses. It SHALL normalize modern `username`, `userKey`, `title` and legacy `name`, `displayName`, `displayableEmail` fields without inventing missing usernames, keys or email addresses. Unknown identity shapes SHALL produce an explicit diagnostic rather than an apparently successful list of empty users.

#### Scenario: Modern user search response
- **WHEN** search returns a result with `username`, `userKey` and `title`
- **THEN** full and JSON output retain the username and user key and expose the title as available display information

#### Scenario: Legacy response and absent email
- **WHEN** search returns `name` and `displayName` without an email
- **THEN** the username and display name remain usable and the email remains unavailable

#### Scenario: Unsupported response shape
- **WHEN** a search match has no supported user identifier
- **THEN** the result reports an unrecognized identity instead of emitting an empty match as a resolved user

### Requirement: Exact active grant subject
Before planning space grants, the system SHALL resolve the supplied username or email to exactly one active account and retain its stable user key. It SHALL distinguish exact username lookup from email matching; it MUST NOT assume every email is a username or choose a fuzzy match. Ambiguous, disabled, unavailable or mismatched identities MUST block preparation of grant items.

#### Scenario: Email is also a username
- **WHEN** exact lookup of an email-shaped username returns a matching active account and stable key
- **THEN** the workflow uses the stable key as the grant subject and records the resolved username for review

#### Scenario: Email differs from username
- **WHEN** the supplied email is not a username and one exact email match resolves to a different username
- **THEN** the workflow verifies that account and uses its stable key without substituting a display name

#### Scenario: Ambiguous or disabled account
- **WHEN** exact matching is ambiguous or the resolved account is not active
- **THEN** preparation reports the unresolved identity and creates no grant plan

### Requirement: Format preserves actionable identity
Machine-readable user output SHALL retain the identifiers needed by subsequent commands. Machine-readable dry-run output with plan recording SHALL remain a single parseable JSON document; plan-save notifications MUST NOT be appended as non-JSON stdout.

#### Scenario: Dry run records a plan
- **WHEN** a grant dry run uses JSON or full output with plan recording
- **THEN** stdout parses as one JSON value with the original request intact and any human notification uses a separate output channel
