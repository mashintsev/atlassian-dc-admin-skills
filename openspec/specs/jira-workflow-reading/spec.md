# jira-workflow-reading Specification

## Purpose

Lets Jira Data Center administrators read a workflow's complete structure that REST exposes, find the workflow a project and issue type use, and compare two status models.

## Requirements

### Requirement: Read a workflow
The system SHALL provide `jira_get_workflow` with either a workflow name or a project key plus issue type (id or exact name), and an optional `draft` flag. It SHALL return:
- the workflow name, description, and whether it is a draft or has a draft with changes;
- the projects and issue types that share the workflow;
- the statuses with status id, name, status category and the initial status;
- the transitions with id, name, source status (or "any" for global transitions), target status, and the global and looped flags;
- the transition properties.

For conditions, validators and post-functions it SHALL state that they are not readable through the REST API and SHALL NOT return guessed or empty lists in their place.

#### Scenario: Workflow of a project and issue type
- **WHEN** an administrator requests the workflow for project BANK and issue type "Incident"
- **THEN** the result names the workflow, lists its statuses and transitions with directions, and lists the projects and issue types that share it

#### Scenario: Rules are not readable
- **WHEN** any workflow is read
- **THEN** the result marks conditions, validators and post-functions as not available through REST, with the reason

#### Scenario: Draft
- **WHEN** an administrator reads the draft of a workflow that has one
- **THEN** the result shows the draft's statuses and transitions and says it is a draft

### Requirement: Compare status models
The system SHALL provide `jira_compare_workflows` with two workflows, each given by name or by project and issue type. It SHALL report the statuses only in the first workflow, only in the second, and in both. It SHALL also report the transitions, identified by source and target status names, that are only in one of them, and the transitions whose name differs.

#### Scenario: Identical models
- **WHEN** two workflows have the same statuses and transitions under different workflow names
- **THEN** the comparison reports no differences

#### Scenario: Missing transition
- **WHEN** the second workflow lacks the transition from "In Progress" to "Resolved"
- **THEN** the comparison lists that transition as only in the first workflow
