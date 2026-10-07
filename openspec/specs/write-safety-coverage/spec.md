# write-safety-coverage Specification

## Purpose

Extends the already-satisfied, read-back and plan-drift guarantees to the administration write tools that still re-send changes blindly. Writes that cannot be checked say so.

## Requirements

### Requirement: Already-satisfied for checkable admin writes
The following write tools SHALL read the target state first and report already-satisfied, sending nothing, when the change is already in effect:
- **Jira users and groups:** create user or group, set user active, set user application, add or remove a user from a group, delete user or group;
- **Jira projects:** role actors, permission scheme assignment, archive and restore;
- **Jira permission grants:** add and delete;
- **Jira workflow schemes:** mapping, default, create, update, delete, drafts, replace workflow;
- **Confluence:** users, groups and memberships; space permissions grant and revoke; archive and delete a space; labels;
- **Assets:** schemas, object types, attributes and statuses (create when the same name exists with the same settings, update with no difference, delete when absent); archive object.

#### Scenario: Member already in group
- **WHEN** `jira_add_user_to_group group=jira-admins user=alice` runs and alice is already a member
- **THEN** the result is already-satisfied and nothing is sent

#### Scenario: Space permission already granted
- **WHEN** a space permission grant asks for permissions the group already has
- **THEN** the result is already-satisfied and nothing is sent

### Requirement: Read-back verification
After a confirmed change, each tool in the already-satisfied list SHALL read the target back. When the read-back does not show the change, it SHALL fail with a verification error that carries the observed state.

#### Scenario: Grant not visible afterwards
- **WHEN** a permission grant is added but the scheme does not list it afterwards
- **THEN** the tool fails with a verification error showing the scheme's grants for that permission

### Requirement: Drift identity for list-replacing writes
Write tools whose request carries a whole list or object read from the server SHALL give their dry run an identity and a state that hold only what the change depends on. Several such items in one plan SHALL then apply without drifting each other. This applies, for example, to a workflow scheme's mappings and to Assets object type attributes. A write whose request carries only the requested entries (such as a space permission grant, which sends only the requested operations) needs no extra state; several such items for one space SHALL still apply without drift.

#### Scenario: Two mappings of one scheme in one plan
- **WHEN** a plan sets the workflow of two different issue types in the same workflow scheme
- **THEN** applying the plan executes both items without reporting drift

### Requirement: Unverifiable writes are marked
A write tool that cannot detect an existing target state or read its result back SHALL say so in its description, together with the reason. Examples are a reindex start, session kills, or creating a comment. Its dry run SHALL say that a repeated apply sends the change again.

#### Scenario: Comment creation
- **WHEN** an agent describes `confluence_add_comment`
- **THEN** the description says that repeating the call adds another comment
