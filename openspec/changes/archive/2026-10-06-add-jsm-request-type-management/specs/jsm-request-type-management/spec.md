# Spec Delta

## Purpose

Lets Jira Service Management administrators create, change, hide and delete request types and arrange them in portal groups, with dry runs and reviewable plans.

## ADDED Requirements

### Requirement: Create and change request types
The system SHALL provide `jira_create_request_type` ✎ (service desk or project key, `name`, `issue_type`, optional `description` and `help_text`), `jira_update_request_type` ✎ (request type id or exact name; any of `name`, `description`, `help_text`, `issue_type`), and `jira_delete_request_type` ✎. Issue types SHALL be accepted by id or exact name and SHALL be validated against the project's issue types. Creating SHALL report already-satisfied when a request type with the same name and issue type exists, and SHALL stop when one with the same name has a different issue type. Updating SHALL report already-satisfied when nothing differs. Deleting SHALL warn that it is irreversible and that requests created from the request type keep their issue type but lose the request type. After a confirmed change, the system SHALL read the request type back.

#### Scenario: Create for an issue type
- **WHEN** an administrator creates request type "Bank incident" for issue type "Incident" in a service desk
- **THEN** the dry run shows the service desk, the name, the issue type and the help text
- **AND** after confirmation the request type exists and is returned as read back

#### Scenario: Re-run of a creation
- **WHEN** the same creation runs again
- **THEN** the system reports already-satisfied with the existing request type id

#### Scenario: Name conflict
- **WHEN** a request type with that name exists with another issue type
- **THEN** the system stops, names the existing request type and its issue type, and creates nothing

#### Scenario: Unknown issue type
- **WHEN** the issue type is not one of the project's issue types
- **THEN** the system rejects the request and lists the project's issue types

### Requirement: Portal visibility and groups
The system SHALL provide `jira_set_request_type_hidden` ✎ to hide a request type from the portal or show it again. It SHALL also provide `jira_add_request_type_to_group` ✎, `jira_remove_request_type_from_group` ✎ and `jira_move_request_type_in_group` ✎ (1-based position or `after` another request type). Groups SHALL be accepted by id or exact name. A request type that is already in the requested state SHALL be reported as already-satisfied. A move SHALL depend only on the request type's presence in the group and on the request type it follows, so several moves in one plan do not drift each other.

#### Scenario: Add to a group at a position
- **WHEN** an administrator adds a request type to group "Incidents" at position 1
- **THEN** after confirmation it is first in that group, read back from the group listing

#### Scenario: Hidden request type
- **WHEN** an administrator hides a request type that is already hidden
- **THEN** the system reports already-satisfied

### Requirement: Internal JSM APIs on verified versions
Writes that use internal JSM resources (groups, hidden request types) SHALL be refused before any request on JSM versions other than the verified ones (11.3.x), naming the observed JSM version. Public request type writes SHALL not be gated.

#### Scenario: Other JSM version
- **WHEN** JSM reports version 10.3.4 and an administrator moves a request type in a group
- **THEN** the system refuses with `Unsupported`, names the version and sends nothing
