# tool-argument-conventions Specification

## Purpose

Gives every tool argument for the same concept one canonical name and one resolution rule, so agents can call tools without guessing names, while existing argument names keep working.

## Requirements

### Requirement: Canonical argument names with aliases
The system SHALL use one canonical argument name per concept across all tools:
- `field`: a custom or system field, by id or exact name;
- `user`: an existing user, by username, or user key in Jira;
- `project_key`: a Jira project;
- `issue_type` / `issue_types`: issue types, by id or exact name;
- `service_desk`: a service desk, by id or project key;
- `key`: a property key.

Each previous name for the same concept SHALL be accepted as an alias of the canonical name:
- `field_id`;
- `username`, where it names an existing user;
- `project`, in `jira_get_workflow`;
- `issue_type_id`, `issue_type_ids`;
- `service_desk_id`;
- `id`, in `jira_set_application_property`.

An alias SHALL produce the same request as the canonical name. When a call gives both an alias and its canonical name with different values, the system SHALL refuse with a validation error that names both. Arguments that name a new object, such as the username of a user being created, are not aliases and keep their names. `describe` SHALL show each argument's canonical name and its accepted aliases.

#### Scenario: Old name still works
- **WHEN** an agent calls `jira_add_user_to_group group=jira-admins username=alice`
- **THEN** the call behaves exactly as with `user=alice`

#### Scenario: Conflicting alias
- **WHEN** an agent passes `field=Severity field_id=customfield_10700` and they name different fields
- **THEN** the system refuses with a validation error naming `field` and `field_id`, and sends nothing

### Requirement: Consistent id-or-name resolution
Tools that take a field or an issue type SHALL accept either its id or its exact name, case-insensitively:
- an ambiguous name SHALL be refused, listing the matching ids;
- an unknown id or name SHALL be refused with a validation error;
- a service desk SHALL be accepted by id or by project key.

#### Scenario: Field options by name
- **WHEN** an agent calls `jira_get_field_options field=Severity project_key=TEST issue_type=Incident`
- **THEN** the field name and the issue type name are resolved to their ids and the allowed values are returned

#### Scenario: Ambiguous field name
- **WHEN** two custom fields are both named "Team"
- **THEN** the call is refused and the message lists both field ids

### Requirement: Suggestions for unknown names
For an unknown tool name, the system SHALL suggest up to three similar tool names. For an unknown argument, it SHALL suggest the closest accepted argument name or alias. The suggestions SHALL appear in the error's hint.

#### Scenario: Misspelled tool
- **WHEN** an agent runs `jira_get_workflows`
- **THEN** the error hint suggests `jira_get_workflow` (and other close names)

#### Scenario: Misspelled argument
- **WHEN** an agent passes `projectkey=TEST`
- **THEN** the error hint suggests `project_key`

### Requirement: Actionable error hints
Errors SHALL carry a hint for:
- HTTP 400: check the arguments with `describe <tool>`;
- HTTP 429: Jira or Confluence is throttling; retry later or narrow the call;
- HTTP 5xx: a server-side failure; retry, and check the application's health if it repeats.

A drifted plan item SHALL be reported with the command that re-plans it: the tool and its arguments with `--plan=<file>`.

#### Scenario: Throttled
- **WHEN** a call fails with HTTP 429 after the client's retries
- **THEN** the error hint says that the server is throttling and suggests retrying later or narrowing the call

#### Scenario: Drifted item
- **WHEN** `apply` reports item 3 as drifted
- **THEN** the output includes the command that re-plans item 3
