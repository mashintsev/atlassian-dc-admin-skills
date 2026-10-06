# Spec Delta

## Purpose

Lets Jira Data Center administrators see which field configuration applies to a project and issue type and change a single field's description in exactly one field configuration, with sharing made visible before the change.

## ADDED Requirements

### Requirement: Read a field configuration
The system SHALL provide `jira_get_field_configuration` with `project_key`, optional `issue_type_id`, and optional `field_configuration_id`. It SHALL return the field configuration scheme name when it can be determined, the selected field configuration (id and name), and its fields with id, name, description, hidden or visible, and required or optional. It SHALL report the projects that use the same field configuration, and whether the configuration is the default one. When `field_configuration_id` is given it SHALL be used as the selected configuration. Otherwise the system SHALL resolve the configuration used by the project and issue type, or by every issue type of the project when `issue_type_id` is omitted. Output SHALL be paged and SHALL accept a field-name filter.

#### Scenario: Configuration for a project and issue type
- **WHEN** an administrator requests the field configuration for a project key and an issue type id
- **THEN** the result names the field configuration that applies to that issue type in that project
- **AND** lists each field with description, hidden/visible and required/optional
- **AND** lists the other projects that use the same field configuration

#### Scenario: Different configurations per issue type
- **WHEN** `issue_type_id` is omitted and the project's issue types use different field configurations
- **THEN** the result groups the issue types by the field configuration they use
- **AND** does not merge fields from different configurations

#### Scenario: Unresolvable configuration
- **WHEN** the field configuration for a project and issue type cannot be determined through the available APIs
- **THEN** the system reports that it could not be resolved and asks for `field_configuration_id`
- **AND** it does not guess a configuration

### Requirement: Change a field description in one field configuration
The system SHALL provide `jira_update_field_description` ✎ with `field_configuration_id`, `field_id`, `description`, and the standard `dry_run`. The change it describes SHALL concern the description of that field only in that field configuration, never the field's global name or description or its hidden, required or renderer settings. The dry run SHALL show the field configuration, the field, the old and the new description, the projects that share the field configuration, and the link to the field's edit form in that configuration. Jira serves that form only after websudo re-authentication, which a personal access token cannot pass, so the system SHALL NOT send the change. Executing it SHALL report it as unsupported, give the reason and the edit link, and leave the change to the administrator in the Jira UI. Running the tool again after the manual edit SHALL verify the stored value.

#### Scenario: Dry run shows old, new and sharing
- **WHEN** an administrator dry-runs a description change for a field in a field configuration used by several projects
- **THEN** the preview shows the old and new description
- **AND** names every project that uses the field configuration and warns that the change affects all of them
- **AND** no change is sent

#### Scenario: Unchanged description
- **WHEN** the requested description equals the stored one
- **THEN** the system reports the change as already satisfied and sends nothing

#### Scenario: Execution is not sent
- **WHEN** the change is executed with `dry_run=false` or applied from a plan
- **THEN** the system sends no request that changes Jira
- **AND** reports the change as unsupported because of websudo, with the edit link and the description to enter

#### Scenario: Verification after a manual edit
- **WHEN** the administrator entered the description in the Jira UI and runs the tool again with the same arguments
- **THEN** the system reads the field configuration and reports already-satisfied when the stored description equals the requested one

### Requirement: Field configuration changes apply to the selected configuration only
The system SHALL treat a field configuration shared by several projects as one object. It SHALL NOT copy, split or reassign field configurations or schemes as a side effect of a description change.

#### Scenario: JC-83 descriptions
- **WHEN** an administrator updates the descriptions of Parent Link (link from an Epic to an Initiative) and Epic Link (choice of the parent Epic of a Story) in the field configuration used by the target project
- **THEN** each change is shown separately with old and new value, the sharing projects and the edit link
- **AND** the global field names stay unchanged
