# Spec Delta

## ADDED Requirements

### Requirement: Remove a space category
The system SHALL provide `confluence_remove_space_category` with a space key and a category name. It SHALL default to a dry run, support plan recording, and keep every other category of the space.

A category that the space does not have SHALL be reported as already-satisfied. The system SHALL NOT remove page labels from the space homepage as a substitute.

After confirmation, the system SHALL read the space's categories back and verify that the category is gone and the others remain. If no removal request is verified for the supported Confluence versions, the tool SHALL answer `Unsupported` and send nothing.

#### Scenario: Remove a category where a removal request is verified
- **WHEN** an administrator removes category "legacy" from a space with "legacy" and "ops", on a Confluence version with a verified removal request
- **THEN** after confirmation the space has category "ops" only

#### Scenario: No verified removal request
- **WHEN** the space has the category and no removal request is verified for this Confluence version
- **THEN** the tool answers `Unsupported`, names the space settings in the UI, and sends nothing

#### Scenario: Category missing
- **WHEN** the space does not have the category
- **THEN** the result is already-satisfied and nothing is sent
