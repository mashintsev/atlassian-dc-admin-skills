# Spec Delta

## Purpose

Lets Jira Service Management administrators read and change the form of a request type: which fields customers see, in which order, under which label and description, whether they are required, and which hidden fields carry a preset value.

## ADDED Requirements

### Requirement: Read a request type form
The system SHALL provide `jira_get_request_type_form` (request type id or exact name, with service desk or project key). It SHALL return the visible fields in order (field id, Jira name, label, description, required), the hidden fields with their preset values, and the fields that could still be added.

#### Scenario: Form with hidden preset
- **WHEN** an administrator reads a form that hides Priority with the preset "High"
- **THEN** the result lists Priority among the hidden fields with the preset "High"

### Requirement: Change form fields
The system SHALL provide these tools:
- `jira_add_request_type_field` ✎: field, optional label, description, required and 1-based position;
- `jira_remove_request_type_field` ✎;
- `jira_move_request_type_field` ✎: position or `after` another field;
- `jira_update_request_type_field` ✎: label, description and/or required;
- `jira_hide_request_type_field` ✎: optional `preset` value;
- `jira_show_request_type_field` ✎.

Fields SHALL be accepted by id or exact name. A field that is already present (add) or absent (remove), already at the target position, or already has the requested values SHALL be reported as already-satisfied. A field that Jira requires and that has no preset SHALL NOT be hidden. Each change SHALL depend only on the state it acts on: the field's presence, its anchor, or its stored values. Several changes to one form in a plan therefore do not drift each other. After a confirmed change the system SHALL read the form back and verify it.

#### Scenario: Required field with a description
- **WHEN** an administrator adds "Severity" at position 2 as required, with the description "1 = critical … 4 = low"
- **THEN** after confirmation the form shows Severity second, required, with that description

#### Scenario: Hide a required field without preset
- **WHEN** an administrator hides a field Jira requires and gives no preset
- **THEN** the system rejects the change and names the field

#### Scenario: Preset on a hidden field
- **WHEN** an administrator hides Priority with preset "High"
- **THEN** after confirmation the form lists Priority as hidden with preset "High"

#### Scenario: Several form changes in one plan
- **WHEN** a plan removes two fields and adds one to the same form
- **THEN** applying it executes all three without reporting drift
