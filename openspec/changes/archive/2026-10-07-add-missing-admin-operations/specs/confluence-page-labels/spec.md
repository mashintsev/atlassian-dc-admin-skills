# Spec Delta

## Purpose

Lets Confluence Data Center administrators remove labels from pages, blog posts and attachments with dry runs and read-back, without touching space categories.

## ADDED Requirements

### Requirement: Remove a content label
The system SHALL provide `confluence_remove_label` with a content id and one or more label names. It SHALL refuse:
- `team:` prefixed names (space categories), pointing to `confluence_remove_space_category`;
- a space id given instead of content.

Labels that are not on the content SHALL be reported as already-satisfied. Each removal SHALL be one request in the dry run. After confirmation, the system SHALL read the content's labels back and verify that the labels are gone and the other labels remain.

#### Scenario: Remove one label
- **WHEN** an administrator removes label "draft" from a page that has "draft" and "howto"
- **THEN** after confirmation the page has "howto" only

#### Scenario: Category name
- **WHEN** the label name is "team:ops"
- **THEN** the system refuses and names the category tool
