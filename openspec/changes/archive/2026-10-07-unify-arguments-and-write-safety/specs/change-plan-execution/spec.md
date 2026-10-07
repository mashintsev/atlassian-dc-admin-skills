# Spec Delta

## MODIFIED Requirements

### Requirement: References to objects created earlier in the plan
A plan item SHALL be able to name a custom field, an issue type or a workflow scheme by its exact name instead of its id. When the object does not exist yet, the dry run SHALL describe the request with the name in place of the id. When the item is applied, the name SHALL be resolved to the id, and drift detection SHALL compare the request with the name in place of the id. A name that is still unresolved when the item is applied SHALL fail the item without sending anything.

#### Scenario: Context for a field created by an earlier item
- **WHEN** item 1 creates field "Release URL" and item 2 creates a context for field "Release URL"
- **THEN** applying the plan executes item 1, then resolves the name and executes item 2 without reporting drift

#### Scenario: Field still missing
- **WHEN** item 2 is applied alone and the field does not exist
- **THEN** item 2 fails with a message that the field was not found and nothing is sent

#### Scenario: Issue type created earlier in the plan
- **WHEN** item 1 creates issue type "Change Request" and item 2 adds "Change Request" to an issue type scheme
- **THEN** applying the plan executes item 1, then resolves the issue type name and executes item 2 without reporting drift

#### Scenario: Workflow scheme created earlier in the plan
- **WHEN** item 1 creates workflow scheme "Ops scheme" and item 2 maps an issue type to a workflow in scheme "Ops scheme"
- **THEN** applying the plan executes item 1, then resolves the scheme name and executes item 2 without reporting drift
