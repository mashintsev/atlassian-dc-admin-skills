# Spec Delta

## MODIFIED Requirements

### Requirement: Output budget
The default response guard SHALL be 25,000 characters and SHALL remain configurable through `ATLASSIAN_MAX_RESPONSE_CHARS`.

**Default columns and `--fields`:**
- List tools with wide items MAY declare default columns. Compact output SHALL use them.
- `--format=json` SHALL ignore default columns and keep every field unless `--fields` is given.
- `--fields=a,b` SHALL select exactly those fields, in both formats.
- `--fields=+a` SHALL add fields to the default columns.
- `--fields=all` SHALL show every field.

**Dry runs:** a compact dry run SHALL print at most 5 follow-up requests and then the number of further ones.

**Compact output SHALL bound every value it prints:**
- **Table cells:** a cell SHALL be cut to the cell limit (160 characters) whether it holds a scalar, an array or an object. A cell holding an array SHALL show its first items and `+N more`. A cut SHALL be marked with the number of characters left out.
- **Single-object text:** a long text value in a single-object result (a description, a body) SHALL be cut at the text limit (default 8,000 characters, configurable through `ATLASSIAN_MAX_TEXT_CHARS`). The cut SHALL be marked with the number of characters left out and with how to read the rest: the tool's narrowing argument, or `--format=json`.
- **Indentation:** multi-line text SHALL be printed without an extra indent on every line.

**When a response exceeds the guard,** `ResponseTooLarge` SHALL name:
- the largest top-level fields or table columns with their sizes in characters;
- the tool's narrowing arguments, when it has any.

The output SHALL NOT include any of the oversized content.

#### Scenario: Large result
- **WHEN** a result renders to more than 25,000 characters and no other limit is set
- **THEN** the CLI answers `ResponseTooLarge` with the existing hint to narrow, select fields or use `--out`
- **AND** the message names the largest fields or columns and their sizes

#### Scenario: Adding a column
- **WHEN** a list tool has default columns and the agent passes `--fields=+description`
- **THEN** the compact output has the default columns plus `description`

#### Scenario: JSON keeps every field
- **WHEN** a list tool with default columns runs with `--format=json` and no `--fields`
- **THEN** every field of each item is in the output

#### Scenario: Many follow-up requests
- **WHEN** a dry run has 12 follow-up requests
- **THEN** the compact output shows 5 of them and "+7 more (--format=json shows all)"

#### Scenario: Nested cell
- **WHEN** a compact row has a cell holding 40 project keys
- **THEN** the cell shows the first keys within 160 characters and `+N more`

#### Scenario: Long description in compact output
- **WHEN** a single issue's description is 30,000 characters
- **THEN** compact output shows the first 8,000 characters and a marker with the characters left out and the argument that reads more
