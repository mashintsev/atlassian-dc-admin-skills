# Spec Delta

## Purpose

Provides Jira Data Center administrators with bounded, explicit management of ScriptRunner scripts and extension resources through supported REST APIs.

## ADDED Requirements

### Requirement: Manage ScriptRunner scripts and extensions
The system SHALL expose ScriptRunner script-registry, REST Endpoint, and Resource operations only when supported by a verified API for the discovered Jira and ScriptRunner version pair. Before a resource request, a centralized resolver SHALL discover Jira's version and ScriptRunner's version and enabled state from UPM using the canonical plugin key recorded in the verified support matrix; callers SHALL NOT supply the key or versions. Missing, disabled, malformed, inaccessible, or unsupported runtime information SHALL fail closed without calling a ScriptRunner resource endpoint. Only a verified app absence or unsupported version pair SHALL be reported as unsupported; other discovery failures SHALL remain explicit errors.

#### Scenario: List supported registry entries
- **WHEN** an administrator requests ScriptRunner script or extension entries
- **THEN** the system returns the supported metadata and identifies the resource type
- **AND** unsupported resource types or Jira/ScriptRunner version pairs are reported explicitly

#### Scenario: Runtime discovery fails closed
- **WHEN** ScriptRunner is absent or disabled, Jira or ScriptRunner version data is malformed or missing, discovery is otherwise inaccessible, or the Jira/ScriptRunner version pair is not in the verified support matrix
- **THEN** the system does not call a ScriptRunner resource endpoint
- **AND** it reports the applicable unavailable or unsupported condition

#### Scenario: Unsupported API operation
- **WHEN** the discovered Jira/ScriptRunner version pair does not expose a verified operation for a requested resource
- **THEN** the system reports that operation as unsupported
- **AND** it does not guess an endpoint or claim that the operation succeeded

#### Scenario: Permission denied
- **WHEN** version discovery or a script/extension resource endpoint returns HTTP 401 or 403
- **THEN** the system preserves and reports the authentication or authorization failure
- **AND** it does not report the app or operation as unsupported

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
The system SHALL route supported ScriptRunner script and extension configuration mutations through the existing dry-run and explicit-confirmation safeguards. Each operation SHALL accept only explicitly allowlisted, vendor-verified non-executable mutable fields and SHALL reject source, script, Groovy, code, class, and path fields, arbitrary nested objects, and creation or upsert of executable definitions.

#### Scenario: Dry-run mutation
- **WHEN** a supported mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** the preview and confirmation prompt apply the same allowlisting and recursive sensitive-field redaction as read output
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected ScriptRunner resource
- **AND** the mutation result uses allowlisted fields and recursively redacts nested sensitive fields rather than returning raw request or response bodies
