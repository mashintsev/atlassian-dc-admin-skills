# read-token-benchmark Specification

## Purpose

Measures the token cost of read tools on realistic Data Center payloads and keeps it from growing unnoticed, so output-size regressions fail a test instead of reaching agents.

## Requirements

### Requirement: Realistic payload generators
The test suite SHALL provide generators of Data Center REST responses in the shapes Jira, Jira Service Management and Confluence return. The payloads SHALL include the waste the formatter must remove:
- self links, avatar URLs and expand strings;
- null custom fields, `_links` and `_expandable`;
- profile pictures and nested status categories.

The fake server SHALL honor the `fields`, `maxResults`/`limit` and `expand` parameters the way the products do, so a tool is measured on what it actually requests. The generated data SHALL use abstract names only.

#### Scenario: Requested fields only
- **WHEN** a tool requests `fields=summary,status`
- **THEN** the generated issues hold only those fields

### Requirement: Read-token report
`pnpm bench:reads` SHALL run a fixed set of read-tool cases on the generators and print one row per case. Each row SHALL show:
- the tool and the case;
- raw REST tokens, compact tokens, JSON tokens and compact characters;
- whether the output exceeds the response guard.

Tokens SHALL be counted with cl100k_base. The cases SHALL cover the audit's heavy cases:
- issue search with and without descriptions, one issue with comments and with changelog;
- comments, projects, fields, custom fields, users, group members, workflows;
- apps, audit events;
- Confluence search, a short and a long page, page children, spaces;
- Assets search, queue issues;
- a workflow shared by many projects.

#### Scenario: Running the report
- **WHEN** a developer runs `pnpm bench:reads`
- **THEN** the table lists every case with its token and character counts and flags cases above the guard

### Requirement: Budget regression test
A unit test SHALL run the same cases. It SHALL fail when:
- compact or JSON tokens exceed their separate recorded budgets (post-change measurements plus 10 % headroom);
- any default benchmark call exceeds the response guard in compact or JSON.

Budgets SHALL live in one file next to the cases. Raising a budget SHALL require editing that file.

#### Scenario: Output grows
- **WHEN** a change makes `jira_search`'s default output 20 % larger
- **THEN** the budget test fails and names the case, the budget and the measured tokens
