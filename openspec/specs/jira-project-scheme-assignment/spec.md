# jira-project-scheme-assignment Specification

## Purpose

Lets Jira Data Center administrators assign workflow, issue type, issue type screen, field configuration and notification schemes to a project, through REST where Jira offers it and through a verified manual change where it does not.

## Requirements

### Requirement: Assign a scheme to a project
The system SHALL provide `jira_assign_project_scheme` with `project_key`, `scheme_type` (`workflow`, `issue_type`, `issue_type_screen`, `field_configuration`, `notification`) and `scheme_id`.

Before building a request, it SHALL:
- read the project's current scheme of that type;
- report already-satisfied when it is the target.

For each scheme type, the tool SHALL use only a REST path verified on the supported Jira versions. Internal paths SHALL be refused on other versions with `Unsupported` before any request.

A scheme type SHALL be handled as a manual change when either:
- no REST path is verified for it; or
- the assignment would require Jira to migrate issues (statuses or issue types that the target scheme lacks).

A manual change SHALL return:
- the project's admin page link for that scheme type;
- the target scheme's id and name;
- the instruction to re-run the tool, which then verifies the assignment.

It SHALL NOT send anything.

After a confirmed REST assignment, the system SHALL read the project's scheme back and verify it. A scheme type whose current assignment cannot be read through REST (the field configuration scheme on the supported Jira versions) SHALL say in its manual change that a re-run cannot verify the assignment.

#### Scenario: Notification scheme
- **WHEN** an administrator assigns notification scheme 10100 to project TEST, which uses the default scheme
- **THEN** the dry run shows the current and the target scheme
- **AND** after confirmation the project reads back with scheme 10100

#### Scenario: Already assigned
- **WHEN** the project already uses the target scheme
- **THEN** the result is already-satisfied and nothing is sent

#### Scenario: Assignment needs a migration
- **WHEN** the target workflow scheme lacks statuses that the project's issues use
- **THEN** the result is a manual change with the project's workflow scheme page and nothing is sent

#### Scenario: Manual change verified
- **WHEN** the administrator made a manual assignment in the UI and re-runs the tool
- **THEN** the result is already-satisfied
