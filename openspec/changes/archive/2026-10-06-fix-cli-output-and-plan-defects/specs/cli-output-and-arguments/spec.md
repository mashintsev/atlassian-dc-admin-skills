# Spec Delta

## Purpose

Defines how the CLI renders write results for the agent and how it turns `key=value` arguments into tool input, so dry runs carry the evidence needed for a decision and argument values reach tools as their schemas expect.

## ADDED Requirements

### Requirement: Compact dry runs show the evidence a tool provides
In the default compact format, a dry run SHALL show:
- the summary and the request (method, URL, bounded body, follow-up steps);
- every other field the tool returned, such as `before`, `after`, `target`, `differences`, `affectedProjects`, `note`, `precheck`, `change`, `warning` and `manual`.

Plan internals (`identity`, `state`, `dry_run`, `product`) SHALL NOT be shown. Each field SHALL be rendered on its own line or as a short indented block. Output SHALL be bounded:
- a field longer than a fixed character cap is cut with a pointer to `--format=json`;
- lists longer than a fixed item cap show the first items and "+N more".

Empty fields SHALL be omitted. `--format=json` SHALL keep returning the complete result.

#### Scenario: Publishing a workflow draft
- **WHEN** an administrator dry-runs a draft publish whose result contains the differences and the affected projects
- **THEN** the compact output lists the transitions only in the draft and the affected projects, along with the request

#### Scenario: Update with before and after values
- **WHEN** a write dry run returns `before` and `after`
- **THEN** both appear in the compact output, and `identity` and `state` do not

#### Scenario: Large list
- **WHEN** a dry-run field holds 300 items
- **THEN** the compact output shows the first items and "+N more" and stays within the cap

### Requirement: Arguments are converted by the parameter's schema
The CLI SHALL pass a `key=value` value as text when the tool's parameter expects a string, including text that looks like a number, boolean or null (`name=2025`, `title=true`, `name=null`). It SHALL convert a value to a number, boolean, array or object only when the parameter's schema expects that type. Boolean parameters SHALL accept `true/false`, `yes/no` and `1/0`. Inline JSON objects and arrays SHALL keep working for parameters that expect them.

#### Scenario: Numeric-looking name
- **WHEN** an administrator creates a version with `name=2025`
- **THEN** the tool receives the string "2025" and validation succeeds

#### Scenario: Boolean spelling
- **WHEN** `atlassian_audit_events raw=yes` is called
- **THEN** the tool receives `true`

### Requirement: Malformed JSON arguments are validation errors
A parameter that takes JSON (for example SLA calendar holidays or a version batch) SHALL report invalid JSON as a `ValidationError`. The error SHALL name the parameter and the parse problem, and include a hint with the expected shape. It SHALL NOT report an internal error.

#### Scenario: Broken holidays JSON
- **WHEN** `holidays=[{"date":"2026-01-01"` is passed
- **THEN** the CLI exits with the validation exit code and names `holidays` as invalid JSON
