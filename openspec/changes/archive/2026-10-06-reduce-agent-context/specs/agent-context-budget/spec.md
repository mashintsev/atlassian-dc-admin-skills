# Spec Delta

## Purpose

Keeps the context an AI agent spends on the atlassian-dc-admin skill small: always-loaded text, reference reading, tool discovery and tool output.

## ADDED Requirements

### Requirement: Size of always-loaded skill text
The skill's frontmatter description SHALL be at most 500 characters and SHALL name the covered products and areas and the trigger terms. The SKILL.md body SHALL be at most 6,000 characters. It SHALL keep, unchanged in meaning:
- the write-confirmation rules (dry run first, how to confirm, exit 12 and 13, never bypassing the dialog);
- the rule to give a UI check plan after applied changes;
- the output token-budget rules.

Content needed only in some environments or on errors (Codex notes, the full exit-code table) SHALL live in REFERENCE.md, and SKILL.md SHALL point to it. A rule SHALL be stated in one document and referenced from the others.

#### Scenario: Description size
- **WHEN** the skill is packaged
- **THEN** its description is at most 500 characters and still names Jira, Confluence, Service Management, ScriptRunner and Assets with their trigger terms

#### Scenario: Codex user
- **WHEN** an agent runs in Codex and needs sandbox guidance
- **THEN** SKILL.md points to the Codex section in REFERENCE.md, which holds that guidance

### Requirement: Reference without duplicated tool tables
REFERENCE.md SHALL NOT repeat each tool's arguments and description. It SHALL list tool names per group as a compact index, and SHALL state that `describe <tool>` is the source for arguments. It SHALL keep configuration, typical tasks, argument notes and endpoint sources. Argument notes SHALL NOT repeat a tool's own description. REFERENCE.md SHALL be at most 40,000 characters.

#### Scenario: Looking up arguments
- **WHEN** an agent needs a tool's arguments
- **THEN** REFERENCE.md directs it to `describe <tool>`, and the generated index lists every registered tool name exactly once

#### Scenario: Two kinds of drafts
- **WHEN** an agent reads about drafts in REFERENCE.md
- **THEN** it can tell workflow drafts (published with `jira_publish_workflow_draft`) from workflow scheme drafts (published in the Jira UI)

### Requirement: Discovery by concept
`list <text>` SHALL match tool names and descriptions case-insensitively. When the text has several words, a tool SHALL match only if every word appears in its name or description. Each match SHALL be printed with its name, the write marker and the first clause of its description, at most 100 characters. `list jira`, `list confluence`, `list both`, `--writes`, `--reads` and `--long` SHALL keep their current meaning.

#### Scenario: Search by concept
- **WHEN** an agent runs `list detail view`
- **THEN** the board Detail View tools are listed with a short description, although their names do not contain "detail view"

#### Scenario: No match
- **WHEN** no tool matches
- **THEN** the output says so and suggests `list jira`, `list confluence` or a shorter term

### Requirement: Output budget
The default response guard SHALL be 25,000 characters and SHALL remain configurable through `ATLASSIAN_MAX_RESPONSE_CHARS`. List tools with wide items MAY declare default columns, which compact and JSON output then use. `--fields=a,b` SHALL select exactly those fields. `--fields=+a` SHALL add fields to the default columns. `--fields=all` SHALL show every field. A compact dry run SHALL print at most 5 follow-up requests and then the number of further ones.

#### Scenario: Large result
- **WHEN** a result renders to more than 25,000 characters and no other limit is set
- **THEN** the CLI answers `ResponseTooLarge` with the existing hint to narrow, select fields or use `--out`

#### Scenario: Adding a column
- **WHEN** a list tool has default columns and the agent passes `--fields=+description`
- **THEN** the output has the default columns plus `description`

#### Scenario: Many follow-up requests
- **WHEN** a dry run has 12 follow-up requests
- **THEN** the compact output shows 5 of them and "+7 more (--format=json shows all)"
