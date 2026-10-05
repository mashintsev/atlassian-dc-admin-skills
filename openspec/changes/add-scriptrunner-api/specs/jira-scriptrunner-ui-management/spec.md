# Spec Delta

## Purpose

Gives Jira Data Center administrators a controlled way to inspect and manage ScriptRunner custom fields, Behaviours, and UI Fragments.

## ADDED Requirements

### Requirement: Manage ScriptRunner UI configuration
The system SHALL expose ScriptRunner field, Behaviour, and UI Fragment operations only through APIs verified for the installed plugin version.

#### Scenario: Inspect UI resources
- **WHEN** an administrator requests ScriptRunner fields, Behaviours, or UI Fragments
- **THEN** the system returns supported resource metadata and configuration
- **AND** reports unsupported resources or plugin versions explicitly

#### Scenario: Unsupported API operation
- **WHEN** the installed ScriptRunner version does not expose a verified operation for a requested resource
- **THEN** the system reports that operation as unsupported
- **AND** it does not guess an endpoint or claim that the operation succeeded

### Requirement: Guard UI configuration writes
The system SHALL route supported field, Behaviour, and UI Fragment configuration mutations through the existing dry-run and explicit-confirmation safeguards.

#### Scenario: Dry-run mutation
- **WHEN** a supported UI configuration mutation is requested without explicit execution authorization
- **THEN** the system describes the exact target and request
- **AND** no remote change is sent

#### Scenario: Confirmed mutation
- **WHEN** a supported mutation is explicitly authorized through the existing confirmation flow
- **THEN** the system sends only the validated request for the selected UI resource
