# Spec Delta

## Purpose

Gives Jira Data Center administrators a controlled way to inspect and manage ScriptRunner custom fields, Behaviours, and UI Fragments.

## ADDED Requirements

### Requirement: Manage ScriptRunner UI configuration
The system SHALL expose ScriptRunner field, Behaviour, and UI Fragment operations only through APIs verified for the discovered Jira and ScriptRunner version pair. Before a resource request, a centralized resolver SHALL discover Jira's version and ScriptRunner's version and enabled state from UPM using the canonical plugin key recorded in the verified support matrix; callers SHALL NOT supply the key or versions. Missing, disabled, malformed, inaccessible, or unsupported runtime information SHALL fail closed without calling a ScriptRunner resource endpoint. Only a verified app absence or unsupported version pair SHALL be reported as unsupported; other discovery failures SHALL remain explicit errors.
An operation is verified for a version pair only when the support matrix records it with sanitized captured evidence from a ScriptRunner instance running exactly that pair; Adaptavist documents no public management API, so vendor documentation is not required. The system SHALL identify these operations as using unofficial ScriptRunner endpoints.

#### Scenario: Inspect UI resources
- **WHEN** an administrator requests ScriptRunner fields, Behaviours, or UI Fragments
- **THEN** the system returns supported resource metadata and configuration
- **AND** reports unsupported resources or Jira/ScriptRunner version pairs explicitly

#### Scenario: Runtime discovery fails closed
- **WHEN** ScriptRunner is absent or disabled, Jira or ScriptRunner version data is malformed or missing, discovery is otherwise inaccessible, or the Jira/ScriptRunner version pair is not in the verified support matrix
- **THEN** the system does not call a ScriptRunner resource endpoint
- **AND** it reports the applicable unavailable or unsupported condition

#### Scenario: Uncaptured version pair
- **WHEN** the observed Jira/ScriptRunner version pair is not recorded in the support matrix, including a newer patch release of a recorded version
- **THEN** the system does not call a ScriptRunner resource endpoint
- **AND** the error names the observed pair and states that a new capture is needed to support it

#### Scenario: Unsupported API operation
- **WHEN** the discovered Jira/ScriptRunner version pair does not expose a verified operation for a requested resource
- **THEN** the system reports that operation as unsupported
- **AND** it does not guess an endpoint or claim that the operation succeeded

#### Scenario: Permission denied
- **WHEN** version discovery or a field, Behaviour, or UI Fragment endpoint returns HTTP 401 or 403
- **THEN** the system preserves and reports the authentication or authorization failure
- **AND** it does not report the app or operation as unsupported

All UI configuration list/detail output SHALL use an explicit field allowlist and recursively redact nested script/source/code and credential, password, secret, or token fields.

### Requirement: UI coverage
The system SHALL read script fields (name, description, custom field, searcher, scope) and UI fragments (name, type, location, key, section, weight, disabled, notes, link destination). It SHALL allow enabling or disabling fragments and changing the notes of fragments. Behaviours SHALL be reported as unsupported, because ScriptRunner exposes only their runtime resources through REST.

#### Scenario: Disable a fragment
- **WHEN** an administrator disables a web fragment
- **THEN** after confirmation it reads back disabled, with its condition and class unchanged

#### Scenario: Behaviours
- **WHEN** a caller asks for Behaviour configuration
- **THEN** the system reports it as unsupported and sends nothing

### Requirement: Guard UI configuration writes
The system SHALL route supported field, Behaviour, and UI Fragment configuration mutations through the existing dry-run and explicit-confirmation safeguards. Each operation SHALL change only the allowlisted non-executable keys (`disabled` where the item has it, and the notes field), by sending ScriptRunner's stored item back unchanged except for that key. Before sending, it SHALL verify that every other key equals the stored item. After sending, it SHALL read the item back and verify that no executable or other key changed. It SHALL reject requests for any other field and SHALL NOT create, delete, duplicate, validate or run items.

#### Scenario: Dry-run mutation
- **WHEN** a supported UI configuration mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** the preview and confirmation prompt apply the same allowlisting and recursive sensitive-field redaction as read output
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected UI resource
- **AND** the mutation result uses allowlisted fields and recursively redacts nested sensitive fields rather than returning raw request or response bodies
