# jira-scriptrunner-automation-management Specification

## Purpose

Lets Jira Data Center administrators inspect and safely manage ScriptRunner automation configuration for jobs, listeners, and Mail Handlers.

## Requirements

### Requirement: Manage ScriptRunner automation configuration
The system SHALL expose ScriptRunner job, listener, and Mail Handler configuration operations through the allowlisted internal APIs on all Jira 10.x/11.x and ScriptRunner 9.x/10.x combinations. Before a resource request, a centralized resolver SHALL discover Jira's version and ScriptRunner's version and enabled state from UPM using the canonical plugin key recorded in the support matrix; callers SHALL NOT supply the key or versions. Missing, disabled, malformed, inaccessible, or unsupported runtime information SHALL fail closed without calling a ScriptRunner resource endpoint. Only a verified app absence or unsupported version pair SHALL be reported as unsupported; other discovery failures SHALL remain explicit errors.
The support matrix SHALL allow all minor and patch releases within Jira majors 10 and 11 and ScriptRunner majors 9 and 10. This policy allowance SHALL remain distinct from runtime verification: exact captured pairs MAY retain their evidence date, but ranges SHALL NOT be marked verified without captured evidence. Existing operation-specific restrictions SHALL remain in force. The system SHALL identify these operations as using unofficial ScriptRunner endpoints.

#### Scenario: Inspect automation resources
- **WHEN** an administrator requests jobs, listeners, or Mail Handler configuration
- **THEN** the system returns the supported resource metadata and configuration
- **AND** reports unsupported resources or Jira/ScriptRunner version pairs explicitly

#### Scenario: Runtime discovery fails closed
- **WHEN** ScriptRunner is absent or disabled, Jira or ScriptRunner version data is malformed or missing, discovery is otherwise inaccessible, or the Jira/ScriptRunner version pair is outside the allowed major-version ranges
- **THEN** the system does not call a ScriptRunner resource endpoint
- **AND** it reports the applicable unavailable or unsupported condition

#### Scenario: Version pair outside allowed major versions
- **WHEN** Jira is outside majors 10 and 11 or ScriptRunner is outside majors 9 and 10
- **THEN** the system does not call a ScriptRunner resource endpoint
- **AND** the error names the observed pair and the allowed major-version ranges

#### Scenario: Allowed minor and patch releases
- **WHEN** Jira 10.3.6 runs ScriptRunner 9.99.0, or Jira 11.3.7 runs ScriptRunner 10.13.2
- **THEN** version discovery allows the existing item operations without requiring evidence for that exact pair
- **AND** operation-specific restrictions and write safeguards remain in force

#### Scenario: Unsupported API operation
- **WHEN** the discovered Jira/ScriptRunner version pair does not allow the requested operation in the support matrix
- **THEN** the system reports that operation as unsupported
- **AND** it does not guess an endpoint or claim that the operation succeeded

#### Scenario: Permission denied
- **WHEN** version discovery or a job, listener, or Mail Handler endpoint returns HTTP 401 or 403
- **THEN** the system preserves and reports the authentication or authorization failure
- **AND** it does not report the app or operation as unsupported

All automation list/detail output SHALL use an explicit field allowlist and recursively redact nested script/source/code and credential, password, secret, or token fields.

### Requirement: Automation coverage
The system SHALL read scheduled jobs (name, type, schedule, run-as user, disabled, next run time, notes) and listeners (name, events, projects, notes). It SHALL allow enabling or disabling jobs and changing the notes of jobs and listeners. Mail Handler configuration SHALL be reported as unsupported, because ScriptRunner exposes only an execution endpoint for it.

#### Scenario: Disable a job
- **WHEN** an administrator disables a scheduled job
- **THEN** after confirmation the job reads back disabled, with its code and schedule unchanged, and the job did not run

#### Scenario: Mail Handler
- **WHEN** a caller asks for Mail Handler configuration
- **THEN** the system reports it as unsupported and sends nothing

### Requirement: Do not trigger ScriptRunner jobs
The system SHALL NOT start, run, or otherwise trigger a ScriptRunner job through an automation-configuration operation.

#### Scenario: Job configuration request
- **WHEN** a caller requests a job-management operation
- **THEN** the system may inspect or change supported job configuration
- **AND** it does not trigger a job execution

### Requirement: Guard automation configuration writes
The system SHALL route supported job, listener, and Mail Handler configuration mutations through the existing dry-run and explicit-confirmation safeguards. Each operation SHALL change only the allowlisted non-executable keys (`disabled` where the item has it, and the notes field), by sending ScriptRunner's stored item back unchanged except for that key. Before sending, it SHALL verify that every other key equals the stored item. After sending, it SHALL read the item back and verify that no executable or other key changed. It SHALL reject requests for any other field and SHALL NOT create, delete, duplicate, validate or run items.

#### Scenario: Dry-run mutation
- **WHEN** a supported automation mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** the preview and confirmation prompt apply the same allowlisting and recursive sensitive-field redaction as read output
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected automation resource
- **AND** the mutation result uses allowlisted fields and recursively redacts nested sensitive fields rather than returning raw request or response bodies
