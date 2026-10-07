# Spec Delta

## Purpose

Provides Jira Data Center administrators with bounded, explicit management of ScriptRunner scripts and extension resources through supported REST APIs.

## ADDED Requirements

### Requirement: Manage ScriptRunner scripts and extensions
The system SHALL expose ScriptRunner script-registry, REST Endpoint, and Resource operations only when supported by a verified API for the discovered Jira and ScriptRunner version pair. Before a resource request, a centralized resolver SHALL discover Jira's version and ScriptRunner's version and enabled state from UPM using the canonical plugin key recorded in the verified support matrix; callers SHALL NOT supply the key or versions. Missing, disabled, malformed, inaccessible, or unsupported runtime information SHALL fail closed without calling a ScriptRunner resource endpoint. Only a verified app absence or unsupported version pair SHALL be reported as unsupported; other discovery failures SHALL remain explicit errors.
An operation is verified for a version pair only when the support matrix records it with sanitized captured evidence from a ScriptRunner instance running exactly that pair; Adaptavist documents no public management API, so vendor documentation is not required. The system SHALL identify these operations as using unofficial ScriptRunner endpoints.

#### Scenario: List supported registry entries
- **WHEN** an administrator requests ScriptRunner script or extension entries
- **THEN** the system returns the supported metadata and identifies the resource type
- **AND** unsupported resource types or Jira/ScriptRunner version pairs are reported explicitly

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
- **WHEN** version discovery or a script/extension resource endpoint returns HTTP 401 or 403
- **THEN** the system preserves and reports the authentication or authorization failure
- **AND** it does not report the app or operation as unsupported

### Requirement: Script and extension coverage
The system SHALL read the script registry as a file list (name, path, type, no content), REST endpoints (path, methods, groups, disabled, notes), and resources (pool name, driver, read-only, disabled). It SHALL allow enabling or disabling REST endpoints and changing their notes. Resources SHALL be read-only, because their stored item carries a data source password that an upsert could overwrite.

#### Scenario: Disable a REST endpoint
- **WHEN** an administrator disables a REST endpoint
- **THEN** the dry run shows the endpoint and `disabled: false → true` without its script
- **AND** after confirmation the endpoint reads back disabled with its script unchanged

#### Scenario: Resource change requested
- **WHEN** a caller asks to change a resource
- **THEN** the system reports the operation as unsupported and sends nothing

### Requirement: Protect ScriptRunner script contents
The system SHALL omit script source from default listing output and SHALL NOT execute arbitrary script content as part of management operations.
All script and extension list/detail output SHALL use an explicit field allowlist and recursively redact nested script/source/code and credential, password, secret, or token fields.

#### Scenario: Default listing
- **WHEN** an administrator lists ScriptRunner scripts or extensions
- **THEN** the result contains metadata without source code

#### Scenario: Script execution is not a management operation
- **WHEN** a caller requests a script-management operation
- **THEN** the system does not execute Groovy source or invoke an arbitrary script execution endpoint

### Requirement: Guard script and extension configuration writes
The system SHALL route supported ScriptRunner script and extension configuration mutations through the existing dry-run and explicit-confirmation safeguards. Each operation SHALL change only the allowlisted non-executable keys (`disabled` where the item has it, and the notes field), by sending ScriptRunner's stored item back unchanged except for that key. Before sending, it SHALL verify that every other key equals the stored item. After sending, it SHALL read the item back and verify that no executable or other key changed. It SHALL reject requests for any other field and SHALL NOT create, delete, duplicate, validate or run items.

#### Scenario: Dry-run mutation
- **WHEN** a supported mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** the preview and confirmation prompt apply the same allowlisting and recursive sensitive-field redaction as read output
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected ScriptRunner resource
- **AND** the mutation result uses allowlisted fields and recursively redacts nested sensitive fields rather than returning raw request or response bodies
