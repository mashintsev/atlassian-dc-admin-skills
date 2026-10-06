# jira-custom-field-provisioning Specification

## Purpose

Lets Jira Data Center administrators create custom fields without duplicates, scope them with contexts, and place them on screens as separately confirmable steps of one plan.

## Requirements

### Requirement: Create a custom field without duplicates
The system SHALL provide `jira_create_custom_field` ✎ with `name`, optional `description`, `field_type`, optional `searcher_key`, optional `context_scope`, and the standard `dry_run`. It SHALL support at least the types `text-single-line`, `url` and `date-picker`, and SHALL map each to Jira's type key and a default searcher. Before creating, it SHALL search for fields with the same name, ignoring case. When exactly one field with that name exists and its type matches, the system SHALL report already-satisfied with that field's id. When a field with that name has a different type, or several fields have that name, the system SHALL stop with an error that lists them.

#### Scenario: New field
- **WHEN** no field has the requested name
- **THEN** the dry run describes creating the field with the mapped type and searcher

#### Scenario: Re-run after creation
- **WHEN** the same creation is run again after the field was created
- **THEN** the system reports already-satisfied with the existing field id and creates nothing

#### Scenario: Type conflict or ambiguity
- **WHEN** a field with the same name has a different type, or more than one field has that name
- **THEN** the system stops, lists the matching fields with id and type, and creates nothing

#### Scenario: Unsupported type
- **WHEN** `field_type` is not a supported type and not a full Jira type key that Jira reports as available
- **THEN** the system rejects the request and lists the supported types

### Requirement: Manage custom field contexts
The system SHALL provide `jira_create_field_context` ✎ (`field_id`, `name`, optional `description`, `project_ids`, `issue_type_ids`, `global`), `jira_update_field_context` ✎ and `jira_delete_field_context` ✎. `global` and `project_ids` SHALL be mutually exclusive. An update SHALL send the complete context, keeping the stored values of every attribute not given. Context changes SHALL use the internal context API and SHALL be refused on Jira versions other than 11.3.x.

#### Scenario: Project-scoped context
- **WHEN** an administrator creates a context for two projects and one issue type
- **THEN** the dry run shows the field, the context name, the projects and the issue type

#### Scenario: Context already present
- **WHEN** a context with the same name and the same scope already exists on the field
- **THEN** the system reports already-satisfied

#### Scenario: Conflicting scope
- **WHEN** both `global` and `project_ids` are given
- **THEN** the system rejects the request

### Requirement: Place a field on several screens
The system SHALL provide `jira_add_field_to_screens` ✎ with `field_id` and a list of `{screen_id, tab_id, position?}`. Each placement SHALL follow the screen-field rules of `jira_add_screen_field`, including already-satisfied and drift detection. In a plan, each placement SHALL be a separate confirmable change.

#### Scenario: Mixed placements
- **WHEN** a field is placed on three screens and is already on one of them
- **THEN** two placements are planned as changes and the third is reported as already-satisfied

### Requirement: Provisioning as separate confirmable changes
Creating a field, creating its context and placing it on screens SHALL be planned as separate changes, each confirmed on its own. Later changes SHALL be able to refer to the field by name while it does not exist yet. Deleting a custom field SHALL NOT be part of any automatic rollback.

#### Scenario: Plan before the field exists
- **WHEN** an administrator plans a field creation, a context for it, and two screen placements before the field exists
- **THEN** the plan contains four changes
- **AND** applying it creates the field first and then resolves the field by name for the later changes

#### Scenario: Partial failure
- **WHEN** the field and its context were created but a screen placement failed
- **THEN** the system does not delete the field or the context
- **AND** the plan shows the failed placement as the remaining work
