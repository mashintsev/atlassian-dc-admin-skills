# Spec Delta

## Purpose

Lets Jira Data Center administrators read the options of select-type custom fields per context, set the options of a context that has none yet (such as Severity 1–4 on a new field), and prepare and verify every other option change, which Jira only accepts in the admin UI.

## ADDED Requirements

### Requirement: Read options
The system SHALL provide `jira_get_custom_field_options` with a field (id or exact name) and an optional context (id or `default`). It SHALL return, per context, the options in their stored order with option id, value and whether the option is disabled. A context without options SHALL return an empty list, and a field type without options SHALL be reported as such.

#### Scenario: Options of a context
- **WHEN** an administrator reads the options of Severity in its project context
- **THEN** the result lists the options in order with id, value and disabled state

### Requirement: Set the options of an empty context
The system SHALL provide `jira_set_custom_field_options` ✎ with:
- a field: id or exact name, also of a field created earlier in the same plan;
- an optional context: id or `default`, the field's only context when omitted;
- the target as an ordered list of options, each a value optionally marked disabled.

When the context has no options, the system SHALL send the values in order. The dry run SHALL show the context, the projects and issue types it covers, and the new list. After a confirmed change the system SHALL read the context's options back and verify values and order. Options marked disabled cannot be created disabled through the API. The system SHALL create them enabled and report that they must be disabled in the UI. The system SHALL NOT send options to a context that already has options.

#### Scenario: Severity 1–4
- **WHEN** an administrator sets the options of a new Severity field to "1", "2", "3", "4"
- **THEN** the dry run shows an empty old list and the four new options
- **AND** after confirmation the options read back are "1", "2", "3", "4" in that order

#### Scenario: Re-run
- **WHEN** the same target is set again and the stored options equal it
- **THEN** the system reports already-satisfied and sends nothing

#### Scenario: Duplicate values
- **WHEN** the target list contains the same value twice
- **THEN** the system rejects the request and names the value

### Requirement: Changes to existing options are prepared, not sent
When the context already has options and they differ from the target, the system SHALL NOT send a request. The tool SHALL instead return a dry run marked as a manual change. That dry run SHALL show:
- the old and the new list;
- what to change in the UI: options to add, rename, reorder, disable or enable, keeping options not in the target list;
- the link to the context's options page.

Executing it SHALL report it as unsupported with the same link and instructions. Running the tool again after the manual change SHALL compare values, order and disabled state, and SHALL report already-satisfied when they match. The system SHALL never delete options.

#### Scenario: Retire a value
- **WHEN** an administrator marks option "4" of an existing context as disabled
- **THEN** the dry run is a manual change that names option "4" to disable and links the options page
- **AND** executing it sends nothing and reports it as unsupported with the link

#### Scenario: Verification after the manual change
- **WHEN** the administrator disabled option "4" in the UI and runs the tool again
- **THEN** the system reports already-satisfied

### Requirement: Supported field types and context addressing
The system SHALL handle only field types that have options (single select, multi select, radio buttons, checkboxes, and the cascading select's parent level), and SHALL reject others, naming the type. A context SHALL be addressed by the scope it covers:
- the first of its projects, or none when it covers all projects;
- the first of its issue types, or none when it covers all issue types.

If another context of the field is more specific for that pair, the system SHALL refuse the write as unsupported instead of writing to that other context.

#### Scenario: Unsupported field type
- **WHEN** an administrator sets options on a text field
- **THEN** the system rejects the request and names the field type

#### Scenario: Context not addressable
- **WHEN** the pair derived from the target context resolves to a more specific context of the field
- **THEN** the system refuses with `Unsupported` and sends nothing
