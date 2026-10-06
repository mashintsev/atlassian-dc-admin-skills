# confluence-space-batch-updates Specification

## Purpose

Prepare and execute reviewable mixed category and direct-permission updates for group-selected Confluence spaces, with native confirmation, drift detection and verified outcomes.

## Requirements

### Requirement: Reconcile before producing a mixed plan
The system SHALL provide a preparation command accepting an exact group, category and target user with optional space scope filters. Preparation SHALL perform reads only, require complete discovery and category/permission reads, and record a native plan containing only missing team-category additions and missing direct `read:space`/`administer:space` grants. Existing group membership, categories and permissions SHALL remain unchanged.

#### Scenario: Operational regression dataset
- **WHEN** 67 spaces contain 52 group-access matches, two already have the category, one user already has direct read/admin access, two have direct read only, and 49 have neither direct grant
- **THEN** preparation records 50 category additions and 51 permission items, totaling 101 items
- **AND** the 51 permission items contain two administer-only grants and 49 read-plus-administer grants
- **AND** preparation sends no mutation

#### Scenario: Everything already satisfied
- **WHEN** all selected spaces already contain the category and direct read/admin grants
- **THEN** preparation returns a no-change result with an empty plan and the satisfied-space count

### Requirement: Bind plans to reviewed intent and target
New workflow plans SHALL retain the target base URL, exact group, space identities and scope, resolved stable user key, requested category, desired direct operations and per-item preconditions. Apply SHALL validate the plan format and compare configured target and user identity before mutation. It MUST NOT silently rediscover or add new spaces to an approved plan.

#### Scenario: Configuration points at another instance
- **WHEN** apply runs with a base URL different from the prepared plan
- **THEN** it rejects the plan before sending any mutation

#### Scenario: User identity or access drifts
- **WHEN** the user becomes inactive, its resolved key changes, or the selected space loses the required group grant
- **THEN** affected work is reported as drifted and is not executed

### Requirement: Preserve native confirmation and subset selection
Mixed-plan execution SHALL use the same native confirmation policy as existing CLI writes. All approved category and permission items SHALL appear in one reviewable checklist, and only selected items SHALL execute. Cancellation or unavailable confirmation SHALL produce the existing decline/unavailable outcome without mutation; execution MUST NOT weaken confirmation configuration.

#### Scenario: Selected subset
- **WHEN** the user confirms only selected items from a mixed plan
- **THEN** only those requests execute and the final report distinguishes unselected items from completed or satisfied work
- **AND** it does not claim the complete all-space objective succeeded when required items were unselected

#### Scenario: Confirmation unavailable
- **WHEN** the configured confirmation policy requires interaction and no dialog or terminal is available
- **THEN** execution exits with the existing confirmation-unavailable status and sends no mutation

### Requirement: Guard additive execution and retries
Apply SHALL re-read relevant state before each workflow item, preserve unrelated categories and permissions, skip items already satisfied, and reject changes to reviewed requests. Workflow execution SHALL persist per-item outcomes and stop on the first mutation failure; it SHALL make no automatic rollback or revocation. Resuming SHALL re-read actual state and prepare only remaining work for confirmation instead of blindly replaying successful requests.

#### Scenario: State is already satisfied after planning
- **WHEN** another actor adds the requested category or grants the requested direct permissions before execution
- **THEN** apply records that item as already satisfied without issuing a duplicate mutation

#### Scenario: Mid-batch failure and retry
- **WHEN** a mutation fails after earlier items succeeded
- **THEN** the outcome file retains completed and failed items, marks later items unattempted and reports partial completion
- **AND** retry reconciliation excludes actually satisfied work and requires confirmation for remaining mutations

### Requirement: Verify both changes and preserved state
The system SHALL provide read-only verification against a prepared plan and durable execution results. Full success SHALL require the requested team category and direct read/admin grants in every selected space, preservation of recorded previous categories/direct permissions, and no unknown reads. It SHALL distinguish executed, satisfied, failed, drifted, unselected, unattempted and verification-failed results.

#### Scenario: Full verified completion
- **WHEN** all 101 intended requests succeed and read-back confirms both desired properties in all 52 selected spaces
- **THEN** the result reports 50 additions, 51 grant items and 52 verified spaces with previous assignments preserved

#### Scenario: Read-back is forbidden
- **WHEN** a final permission or category read fails
- **THEN** the system retains mutation outcomes but reports verification as incomplete and does not report overall verified success

### Requirement: Preserve existing workflows and confidential data
Existing version-1 generic plans and existing tools SHALL retain their established behavior. Unknown future plan versions SHALL fail before mutation. Workflow outputs and published examples MUST NOT contain authentication material or copied customer evidence; examples and fixtures SHALL use synthetic identities and space names. Skill guidance SHALL teach the bundled prepare/review/apply/verify path without temporary custom write scripts.

#### Scenario: Existing generic plan
- **WHEN** a valid version-1 plan is applied after the extension
- **THEN** its existing item-selection and request-fingerprint behavior remains available without a forced migration

#### Scenario: Published workflow example
- **WHEN** the bundled guide demonstrates group-based administration
- **THEN** it uses synthetic instance/user/group identifiers and documents confirmation and verification without embedding credentials
