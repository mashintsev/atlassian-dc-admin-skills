# jira-board-configuration-management Specification

## Purpose

Lets Jira Data Center administrators read a Jira Software board's full configuration and change its Detail View fields without disturbing fields they did not target.

## Requirements

### Requirement: Read board configuration
The system SHALL provide `jira_get_board_configuration` with `board_id`. It SHALL return the saved filter (id, name, JQL), columns with their status mappings, quick filters, card layout fields, Detail View fields in order, estimation, the sub-filter, board administrators, and whether the caller can edit the board. It SHALL include data about third-party app extensions only when Jira returns it. Parts that cannot be read SHALL be reported as unavailable with the reason, while the rest is still returned.

#### Scenario: Full configuration
- **WHEN** an administrator requests the configuration of a board they can view
- **THEN** the result contains every listed part that Jira returns
- **AND** marks unavailable parts with the reason

### Requirement: Change Detail View fields
The system SHALL provide `jira_set_board_detail_fields` ✎ with `board_id` and either `fields`, the complete ordered target list, or `add_fields` and/or `remove_fields`. It SHALL also provide `jira_add_board_detail_field` ✎ and `jira_remove_board_detail_field` ✎ for single fields. Fields SHALL be identified by field id or exact field name. The system SHALL keep fields that are not targeted, and their relative order. The dry run SHALL show the old and new ordered list. After a confirmed change the system SHALL read the Detail View again and report whether it matches the target.

#### Scenario: Remove fields and keep Labels
- **WHEN** an administrator removes Components, Affects Version/s and Fix Version/s from a board whose Detail View also contains Labels
- **THEN** only those three fields are removed
- **AND** Labels and every other untouched field stay in their previous order

#### Scenario: Full target list
- **WHEN** an administrator gives `fields` as the full ordered list
- **THEN** the resulting Detail View contains exactly those fields in that order

#### Scenario: Field type not supported by Detail View
- **WHEN** a requested field is not in the board's list of available Detail View fields
- **THEN** the system stops before changing anything and names the field

#### Scenario: Nothing to change
- **WHEN** the Detail View already matches the target
- **THEN** the system reports already-satisfied and sends nothing

### Requirement: Board edit rights and version gate
The system SHALL check that the caller can edit the board before any Detail View change and SHALL refuse with an authorization error otherwise. Because Detail View changes use Jira Software's internal API, the system SHALL allow them only on Jira 11.3.x and SHALL refuse other versions before sending anything, naming the observed version.

#### Scenario: Not a board administrator
- **WHEN** the caller cannot edit the board
- **THEN** the system refuses the change with an authorization error and sends nothing

#### Scenario: Other Jira version
- **WHEN** Jira is not 11.3.x
- **THEN** Detail View changes are refused before any request, and reading the configuration still works
