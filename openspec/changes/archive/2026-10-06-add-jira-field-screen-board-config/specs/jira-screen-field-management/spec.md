# Spec Delta

## Purpose

Lets Jira Data Center administrators see where a screen is used and add, remove or move fields on a screen tab safely, with idempotent results and drift checks that cover the tab's field order.

## ADDED Requirements

### Requirement: Report screen usage
The system SHALL provide `jira_get_screen_usage` with `screen_id`. It SHALL return the projects, issue types and operations (create, edit, view) that use the screen. It SHALL also return the screen schemes and issue type screen schemes involved, whenever the available APIs name them. It SHALL warn when the screen is shared by more than one project or issue type. The scan SHALL be bounded and SHALL report when it was cut short or when some projects could not be read.

#### Scenario: Shared screen
- **WHEN** an administrator requests usage for a screen used by two projects for create and edit
- **THEN** the result lists both projects with their issue types and operations
- **AND** includes a sharing warning

#### Scenario: Partial scan
- **WHEN** the number of projects exceeds the scan limit or some projects cannot be read
- **THEN** the result says the usage is incomplete and how many projects were skipped

### Requirement: Change fields on a screen tab
The system SHALL provide `jira_add_screen_field` ✎ (`screen_id`, `tab_id`, `field_id`, optional `position`), `jira_remove_screen_field` ✎ (`screen_id`, `tab_id`, `field_id`), and `jira_move_screen_field` ✎ (`screen_id`, `tab_id`, `field_id`, and either `position` or `after_field_id`). Positions SHALL be 1-based within the tab. The dry run SHALL show the screen, the tab, the field, the resulting field order on the tab, and the projects affected according to screen usage. After a confirmed change the system SHALL read the screen again and return its tabs and fields.

#### Scenario: Add a field at a position
- **WHEN** an administrator adds a field to a tab at position 3
- **THEN** the field is added and moved so that it is third on the tab
- **AND** the result shows the screen as read back after the change

#### Scenario: Idempotent add and remove
- **WHEN** the field is already on the tab for an add, or already absent for a remove
- **THEN** the system reports already-satisfied and sends nothing

#### Scenario: Field on another tab
- **WHEN** an add targets a tab but the field is already on a different tab of the same screen
- **THEN** the system stops with an error naming that tab instead of adding a duplicate or moving it silently

#### Scenario: Drift detection covers what the change depends on
- **WHEN** a planned screen change is applied after the field's presence on the tab or the field its target position follows changed
- **THEN** the item is reported as drifted and not executed

#### Scenario: JC-83 removals
- **WHEN** an administrator removes Components and Fix Version/s from tab 10633 of screen 10433, and Components, Affects Version/s and Fix Version/s from tab 10634 of screen 10434
- **THEN** each removal is a separate change showing the affected projects
- **AND** a field already absent is reported as already-satisfied

### Requirement: Screen listing on Jira 11
The system SHALL list screens on Jira 11, which returns them under a different response key than earlier versions.

#### Scenario: Jira 11 screen list
- **WHEN** an administrator lists screens on Jira 11.3
- **THEN** the result contains the screens with id, name and description and the reported total
