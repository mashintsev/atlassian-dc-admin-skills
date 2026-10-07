# jira-admin-object-lifecycle Specification

## Purpose

Lets Jira Data Center administrators remove issue types from issue type schemes, delete versions, and create screens and permission schemes, with dry runs, plans and read-back.

## Requirements

### Requirement: Remove issue types from an issue type scheme
The system SHALL provide `jira_remove_issue_types_from_scheme` with `scheme_id` and issue types by id or exact name.

Issue types not in the scheme SHALL be reported as already-satisfied. The system SHALL refuse, before sending, to remove:
- the scheme's default issue type;
- every issue type of the scheme.

Jira's refusal (for example, issue types still used by issues of projects with the scheme) SHALL be returned with Jira's message.

Plan drift SHALL depend only on whether the named issue types are present, so several removals and additions on one scheme in a plan do not drift each other. After a confirmed change, the scheme SHALL be read back and verified.

#### Scenario: Remove one issue type
- **WHEN** an administrator removes "Change" from a scheme that also has "Incident" and "Task"
- **THEN** after confirmation the scheme reads back with "Incident" and "Task" only

#### Scenario: Default issue type
- **WHEN** the issue type to remove is the scheme's default
- **THEN** the system refuses and sends nothing

### Requirement: Delete a version
The system SHALL provide `jira_delete_version` with the version (id, or exact name with `project_key`). It SHALL take optional `move_fix_issues_to` and `move_affected_issues_to` (another version of the same project).

The dry run SHALL report:
- the number of issues with the version as fix version and as affected version;
- where those issues move.

A version that no longer exists SHALL be reported as already-satisfied. After confirmation, the system SHALL verify that the version is gone.

#### Scenario: Delete with move
- **WHEN** an administrator deletes version "1.0" and moves its fix-version issues to "1.1"
- **THEN** the dry run shows the issue counts and the target
- **AND** after confirmation "1.0" no longer exists

### Requirement: Create screens and permission schemes
The system SHALL provide `jira_create_screen` (name, description) and `jira_create_permission_scheme` (name, description, optional `copy_from` scheme). With `copy_from`, the new scheme SHALL receive every grant of the source scheme, read at dry-run time and listed in the dry run.

An object with the same name and the same content SHALL be reported as already-satisfied. The same name with different content SHALL be an error.

If no REST path for creating screens is verified, `jira_create_screen` SHALL return a manual change with the admin page link and SHALL verify the screen on re-run. After a confirmed REST creation, the object SHALL be read back and verified, including every copied grant.

#### Scenario: Copy a permission scheme
- **WHEN** an administrator creates "Ops permissions" copying scheme 0
- **THEN** after confirmation the new scheme reads back with the same grants as scheme 0
