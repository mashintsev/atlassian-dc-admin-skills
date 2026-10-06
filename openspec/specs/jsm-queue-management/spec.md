# jsm-queue-management Specification

## Purpose

Lets Jira Service Management administrators create, change, delete and reorder service desk queues with dry runs and reviewable plans.

## Requirements

### Requirement: Create, change and delete queues
The system SHALL provide `jira_create_queue` ✎ (service desk or project key, `name`, `jql`, ordered `columns`), `jira_update_queue` ✎ (queue id or exact name; any of `name`, `jql`, `columns`) and `jira_delete_queue` ✎. Columns SHALL be accepted by field id or exact name. Creating SHALL report already-satisfied when a queue with that name exists with the same JQL and columns, and SHALL stop when it exists with different ones. Updating SHALL report already-satisfied when nothing differs. The dry run SHALL show old and new JQL and columns. After a confirmed change the system SHALL read the queue back.

#### Scenario: Create a queue
- **WHEN** an administrator creates queue "Bank incidents — open" with JQL `project = BANK AND resolution = EMPTY` and columns Key, Summary, Severity, SLA
- **THEN** after confirmation the queue exists with that JQL and those columns in that order

#### Scenario: Unknown column
- **WHEN** a column names a field that does not exist
- **THEN** the system rejects the request and names the column

### Requirement: Queue order
The system SHALL provide `jira_move_queue` ✎ with a queue and a 1-based position or `after` another queue. A queue already in place SHALL be reported as already-satisfied. A move SHALL depend only on the queue's anchor, so several moves in one plan do not drift each other.

#### Scenario: Move to the top
- **WHEN** an administrator moves "Bank incidents — open" to position 1
- **THEN** after confirmation it is the first queue of the service desk
