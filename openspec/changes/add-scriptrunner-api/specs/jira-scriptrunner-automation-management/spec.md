# Spec Delta

## Purpose

Lets Jira Data Center administrators inspect and safely manage ScriptRunner automation configuration for jobs, listeners, and Mail Handlers.

## ADDED Requirements

### Requirement: Manage ScriptRunner automation configuration
The system SHALL expose ScriptRunner job, listener, and Mail Handler configuration operations only through APIs verified for the installed plugin version.

#### Scenario: Inspect automation resources
- **WHEN** an administrator requests jobs, listeners, or Mail Handler configuration
- **THEN** the system returns the supported resource metadata and configuration
- **AND** reports unsupported resources or plugin versions explicitly

#### Scenario: Unsupported API operation
- **WHEN** the installed ScriptRunner version does not expose a verified operation for a requested resource
- **THEN** the system reports that operation as unsupported
- **AND** it does not guess an endpoint or claim that the operation succeeded

### Requirement: Do not trigger ScriptRunner jobs
The system SHALL NOT start, run, or otherwise trigger a ScriptRunner job through an automation-configuration operation.

#### Scenario: Job configuration request
- **WHEN** a caller requests a job-management operation
- **THEN** the system may inspect or change supported job configuration
- **AND** it does not trigger a job execution

### Requirement: Guard automation configuration writes
The system SHALL route supported job, listener, and Mail Handler configuration mutations through the existing dry-run and explicit-confirmation safeguards.

#### Scenario: Dry-run mutation
- **WHEN** a supported automation mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected automation resource
