# Spec Delta

## Purpose

Lets Jira Data Center administrators build and change workflows (copy, statuses, transitions) and manage drafts of active workflows, with dry runs, plans and read-back.

## ADDED Requirements

### Requirement: Copy a workflow
The system SHALL provide `jira_copy_workflow` ✎ with a source workflow and a new name, plus an optional description. A workflow with the new name that has the same statuses and transitions as the source SHALL be reported as already-satisfied. A workflow with that name and a different structure SHALL stop the operation.

#### Scenario: Copy for a new project
- **WHEN** an administrator copies "Incident WF" as "Bank Incident WF"
- **THEN** after confirmation "Bank Incident WF" exists with the same statuses and transitions

### Requirement: Edit statuses and transitions
The system SHALL provide these tools for a workflow:
- statuses: `jira_add_workflow_status` ✎ (an existing status, or a new one with name and category), `jira_update_workflow_status` ✎, `jira_remove_workflow_status` ✎;
- transitions: `jira_add_workflow_transition` ✎, `jira_update_workflow_transition` ✎ (name, description, target), `jira_remove_workflow_transition` ✎;
- global transitions: `jira_add_workflow_global_transition` ✎ and `jira_remove_workflow_global_transition` ✎.

Statuses and transitions SHALL be accepted by id or exact name, and transitions also by source and target status. For an active workflow (one used by a workflow scheme) every change SHALL go to the workflow's draft, which is created when needed, and the dry run SHALL say so. A status that is already present, a transition that already exists with the same source, target and name, or a removed item that is already absent SHALL be reported as already-satisfied. Removing a status SHALL first check with Jira whether it can be removed and SHALL refuse it otherwise, naming the reason. After a confirmed change the system SHALL read the workflow (or draft) back and verify the change.

#### Scenario: Add a transition to an active workflow
- **WHEN** an administrator adds the transition "Escalate" from "In Progress" to "Escalated" in an active workflow
- **THEN** the dry run says the change goes to the draft
- **AND** after confirmation the draft contains the transition and the published workflow is unchanged

#### Scenario: New status
- **WHEN** an administrator adds a new status "Escalated" in category "In Progress"
- **THEN** after confirmation the status exists and is part of the workflow

#### Scenario: Status cannot be removed
- **WHEN** Jira reports that a status cannot be removed from the workflow
- **THEN** the system refuses the removal and gives Jira's reason

### Requirement: Publish and discard drafts
The system SHALL provide `jira_publish_workflow_draft` ✎, with an optional backup copy name for the published version, and `jira_discard_workflow_draft` ✎. The dry run of a publish SHALL show the differences between the draft and the published workflow (same format as `jira_compare_workflows`) and the projects that use the workflow. A workflow without a draft SHALL be reported as already-satisfied for both tools.

#### Scenario: Publish
- **WHEN** an administrator publishes a draft that adds one transition
- **THEN** the dry run lists that transition and the affected projects
- **AND** after confirmation the published workflow contains it and no draft remains

### Requirement: Version gate
Workflow writes SHALL be refused before any request on Jira versions other than the verified ones (11.3.x), naming the observed version.

#### Scenario: Other Jira version
- **WHEN** Jira reports version 10.3.4 and an administrator adds a status
- **THEN** the system refuses with `Unsupported` and sends nothing
