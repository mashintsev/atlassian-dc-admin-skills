# Spec Delta

## Purpose

Provides Jira Data Center administrators with bounded, explicit management of ScriptRunner scripts and extension resources through supported REST APIs.

## ADDED Requirements

### Requirement: Manage ScriptRunner scripts and extensions
The system SHALL expose ScriptRunner script-registry, REST Endpoint, and Resource operations only when supported by a verified API for the installed plugin version.

#### Scenario: List supported registry entries
- **WHEN** an administrator requests ScriptRunner script or extension entries
- **THEN** the system returns the supported metadata and identifies the resource type
- **AND** unsupported resource types or plugin versions are reported explicitly

#### Scenario: Unsupported API operation
- **WHEN** the installed ScriptRunner version does not expose a verified operation for a requested resource
- **THEN** the system reports that operation as unsupported
- **AND** it does not guess an endpoint or claim that the operation succeeded

### Requirement: Protect ScriptRunner script contents
The system SHALL omit script source from default listing output and SHALL NOT execute arbitrary script content as part of management operations.

#### Scenario: Default listing
- **WHEN** an administrator lists ScriptRunner scripts or extensions
- **THEN** the result contains metadata without source code

#### Scenario: Script execution is not a management operation
- **WHEN** a caller requests a script-management operation
- **THEN** the system does not execute Groovy source or invoke an arbitrary script execution endpoint

### Requirement: Guard script and extension configuration writes
The system SHALL route supported ScriptRunner script and extension configuration mutations through the existing dry-run and explicit-confirmation safeguards.

#### Scenario: Dry-run mutation
- **WHEN** a supported mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected ScriptRunner resource
