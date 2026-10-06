# Spec Delta

## Purpose

Lets Jira Data Center administrators inspect and safely manage ScriptRunner automation configuration for jobs, listeners, and Mail Handlers.

## ADDED Requirements

### Requirement: Manage ScriptRunner automation configuration
The system SHALL expose ScriptRunner job, listener, and Mail Handler configuration operations only through APIs verified for the discovered Jira and ScriptRunner version pair. Before a resource request, a centralized resolver SHALL discover Jira's version and ScriptRunner's version and enabled state from UPM using the canonical plugin key recorded in the verified support matrix; callers SHALL NOT supply the key or versions. Missing, disabled, malformed, inaccessible, or unsupported runtime information SHALL fail closed without calling a ScriptRunner resource endpoint. Only a verified app absence or unsupported version pair SHALL be reported as unsupported; other discovery failures SHALL remain explicit errors.
An operation is verified for a version pair only when the support matrix records it with sanitized captured evidence from a ScriptRunner instance running exactly that pair; Adaptavist documents no public management API, so vendor documentation is not required. The system SHALL identify these operations as using unofficial ScriptRunner endpoints.

#### Scenario: Inspect automation resources
- **WHEN** an administrator requests jobs, listeners, or Mail Handler configuration
- **THEN** the system returns the supported resource metadata and configuration
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
- **WHEN** version discovery or a job, listener, or Mail Handler endpoint returns HTTP 401 or 403
- **THEN** the system preserves and reports the authentication or authorization failure
- **AND** it does not report the app or operation as unsupported

All automation list/detail output SHALL use an explicit field allowlist and recursively redact nested script/source/code and credential, password, secret, or token fields.

### Requirement: Do not trigger ScriptRunner jobs
The system SHALL NOT start, run, or otherwise trigger a ScriptRunner job through an automation-configuration operation.

#### Scenario: Job configuration request
- **WHEN** a caller requests a job-management operation
- **THEN** the system may inspect or change supported job configuration
- **AND** it does not trigger a job execution

### Requirement: Guard automation configuration writes
The system SHALL route supported job, listener, and Mail Handler configuration mutations through the existing dry-run and explicit-confirmation safeguards. Each operation SHALL accept only explicitly allowlisted, vendor-verified non-executable mutable fields and SHALL reject source, script, Groovy, code, class, and path fields, arbitrary nested objects, and creation or upsert of executable definitions.

#### Scenario: Dry-run mutation
- **WHEN** a supported automation mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** the preview and confirmation prompt apply the same allowlisting and recursive sensitive-field redaction as read output
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected automation resource
- **AND** the mutation result uses allowlisted fields and recursively redacts nested sensitive fields rather than returning raw request or response bodies
