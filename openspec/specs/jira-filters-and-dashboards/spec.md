# jira-filters-and-dashboards Specification

## Purpose

Lets Jira Data Center administrators find, read, create, change, share and delete saved filters and read dashboards through the public REST API.

## Requirements

### Requirement: Filter reads
The system SHALL provide:
- `jira_list_filters`: the caller's favourite filters, and all filters by name, owner or project where the Jira version offers a search. The result SHALL say which source it used.
- `jira_get_filter` (id): name, owner, JQL, description, share permissions, favourite count (when Jira reports it) and view URL.

Lists SHALL be bounded and report truncation. Filters the caller cannot see SHALL be reported as not found, not as an empty filter.

#### Scenario: Filter by id
- **WHEN** an administrator reads filter 10200
- **THEN** the result shows its JQL, owner and share permissions

### Requirement: Filter changes and shares
The system SHALL provide:
- `jira_create_filter`: name, JQL, description, favourite;
- `jira_update_filter`: name, JQL, description;
- `jira_delete_filter`;
- `jira_add_filter_share` and `jira_remove_filter_share`: a group, a project with an optional role, an authenticated-users share, or the global share.

The JQL SHALL be validated by Jira before the change is planned, and an invalid JQL SHALL be refused with Jira's message. Each write SHALL follow the write contract: already-satisfied, plan identity/state, confirmation, and read-back verification. Deleting a filter SHALL say in the dry run how many users have it as a favourite, or that this Jira version does not report the count.

#### Scenario: Share with a group
- **WHEN** an administrator shares filter 10200 with group "ops"
- **THEN** after confirmation the filter's share permissions include the group
- **AND** sharing it again is already-satisfied

#### Scenario: Invalid JQL
- **WHEN** the new JQL does not parse
- **THEN** the system refuses with Jira's message and plans nothing

### Requirement: Dashboard reads
The system SHALL provide `jira_list_dashboards` (bounded, optional filter favourites or all visible) and `jira_get_dashboard` (id: name, view URL, and owner and share permissions when Jira reports them).

Copying a dashboard SHALL be a manual change with the dashboard's copy page link, unless a REST path is verified for the supported Jira versions.

#### Scenario: List dashboards
- **WHEN** an administrator lists dashboards
- **THEN** the result shows id, name and owner for each, with paging and truncation information
