# read-output-bounds Specification

## Purpose

Bounds what each read tool returns on large Data Center instances: bodies can be read in parts, lists have consistent defaults and caps, and long nested values, membership lists and raw server objects never reach the agent unbounded.

## Requirements

### Requirement: Page bodies can be read in parts
`confluence_get_page`, and `confluence_get_page_history` when it returns a version body, SHALL accept:
- `outline=true`: return the page's heading tree (level, heading text, character size of each section) instead of the body;
- `section=<heading text>`: return only that section, from the heading down to the next heading of the same or a higher level. Headings match case-insensitively. An ambiguous or unknown heading SHALL fail and list the matching or available headings;
- `max_chars=<n>`: default 20,000 and maximum 100,000. A longer body SHALL be cut at a block boundary at or before `n`. The result SHALL carry `truncated: {shown, total}` and a hint to use `outline` and `section`.

These arguments SHALL apply in both output formats.

#### Scenario: Long runbook
- **WHEN** an agent reads an 80-section page of 70,000 characters without arguments
- **THEN** it gets the first 20,000 characters, cut at a block boundary, with `truncated` and the outline hint, and no `ResponseTooLarge`

#### Scenario: One section
- **WHEN** the agent asks for `section="Rollback"`
- **THEN** only that section and its subsections are returned

#### Scenario: Outline
- **WHEN** the agent asks for `outline=true`
- **THEN** it gets the heading tree with each section's size and no body text

### Requirement: Issue text is bounded
`jira_get_issue` SHALL accept `max_description_chars`: default 8,000, maximum 100,000 and 0 to omit the description. A longer description SHALL be cut and marked with the total length.

A changelog entry whose old or new value is longer than 120 characters or spans several lines SHALL show:
- the field;
- the old and new length in characters;
- the first 120 characters of the new value.

Such values come typically from the description, the environment or textarea custom fields. The entry SHALL NOT show both full texts. Other changelog entries SHALL keep their from and to values.

#### Scenario: Changelog with description edits
- **WHEN** an issue with 20 description edits is read with `include=changelog`
- **THEN** each description change shows its old and new lengths and a 120-character preview, and the result stays below the response guard

### Requirement: Issue lists do not return raw field dumps
Issue list tools SHALL refuse `fields=*all` with a hint to name the fields or read one issue with `jira_get_issue`. The list tools are `jira_search`, `jira_get_project_issues`, the agile board and sprint issue lists and `jira_get_queue_issues`.

Extra fields in list rows SHALL be flattened to readable values:
- options to their value;
- users to their name;
- objects to a name or key when they have one;
- SLA fields to remaining time and breached state.

Each extra field SHALL be its own column, cut to the cell limit.

Agile issue lists SHALL default to 20 rows with a maximum of 100, like `jira_search`. `jira_get_comments`, `jira_get_worklog` and the agile issue lists SHALL cap `limit` at 100.

#### Scenario: All fields in a list
- **WHEN** an agent runs `jira_search jql=... fields=*all`
- **THEN** the call fails with a ValidationError that suggests naming the fields or using `jira_get_issue`

#### Scenario: Custom field column
- **WHEN** `jira_search` is called with `fields=customfield_10100` for a select field
- **THEN** each row has a `customfield_10100` column with the option value only

### Requirement: Audit and history values are bounded
`atlassian_audit_events`:
- SHALL cap `limit` at 200;
- SHALL cut each changed value (`from`, `to`) to 120 characters, marked with the length left out;
- SHALL allow `raw=true` only with `limit` at most 50.

`assets_object_history` SHALL cut old and new values the same way and SHALL accept `offset`.

#### Scenario: Workflow change in the audit log
- **WHEN** an audit event's changed value holds 30,000 characters of workflow XML
- **THEN** the row shows the first 120 characters and the length left out

### Requirement: Assets and service desk rows are bounded
`assets_search` and `assets_get_object`:
- SHALL default search to 20 objects per page, with explicit paging available;
- SHALL cut each attribute value to 120 characters;
- SHALL show at most 20 attributes per object in search rows, plus `+N more`, unless `attributes` names the wanted ones.

Further bounds:
- `assets_get_object_type` SHALL return attribute counts and point to `assets_list_attributes` instead of listing every definition.
- `jira_get_request_type_fields` SHALL show at most 50 valid values per field, plus `+N more`.
- `jira_get_request_type_form` SHALL list addable fields only with `include_addable=true`.

#### Scenario: Wide CMDB type
- **WHEN** `assets_search` returns 25 objects with 60 attributes each
- **THEN** each row shows 20 attributes with values of at most 120 characters and `+40 more`

### Requirement: Membership and sharing lists are truncated
Lists of members or users of another object SHALL show the first 10 entries and a total count by default. This applies to:
- a workflow's projects, field configuration `sharedWith`;
- application role groups and default groups, a user's groups;
- project role actors;
- `jira_get_screen_usage` projects and schemes;
- custom field option scope labels;
- Confluence space permission subjects.

Each such tool SHALL offer an argument that returns the complete list, or pages it.

`jira_get_custom_field_options` without a context SHALL return option counts per context. When the server omits a total, counts SHALL be unknown with an explicit lower bound and incomplete flag; full pages SHALL retain a continuation offset. With a context, it SHALL page options with `limit` (default 100, maximum 1,000).

`jira_get_screen_usage` compact output SHALL show its usage summary as well as its rows.

#### Scenario: Workflow shared by many projects
- **WHEN** `jira_get_workflow` reads a workflow used by 1,200 projects
- **THEN** `sharing` shows 10 project keys and `projects: 1200`

#### Scenario: Full list on request
- **WHEN** the agent passes the tool's full-list argument
- **THEN** every entry is returned, within the response guard or with `--out`

### Requirement: No raw passthrough and consistent caps
Every read tool SHALL build its output from an explicit field allowlist. These tools currently pass server objects through and SHALL get allowlists:
- `jira_get_field_contexts`, `jira_get_field_screens`;
- `jira_get_advanced_settings`, `atlassian_audit_settings`;
- `assets_object_references`;
- `confluence_cluster_nodes`, `confluence_list_long_tasks`, `confluence_get_long_task` (the newest 20 messages);
- `confluence_get_global_permissions`.

Further caps:
- Every `limit` argument SHALL declare a maximum, and that advertised maximum SHALL be the one applied. This covers `jira_find_groups`, `confluence_find_users`, and `confluence_search` (100).
- Fixed explanatory notes repeated on every call SHALL be at most one sentence. Examples are the workflow rules gap note, the filter favourites note and the field configuration note.

#### Scenario: Schema matches behavior
- **WHEN** `describe confluence_search` shows the `limit` maximum
- **THEN** it is 100, the value the tool applies

### Requirement: Group space discovery returns matches by default
`confluence_find_spaces_by_group` SHALL return, by default:
- the matching spaces;
- every space whose permissions could not be read, reported as unknown;
- the counts, the completeness flag and the visibility notes that discovery already reports.

The per-space audit rows of spaces without the group's access SHALL be included only with `include_audit=true`. Batch preparation (`prepare-space-updates`) SHALL keep using the complete audit internally. The completeness rules of `confluence-group-space-discovery` are unchanged.

#### Scenario: Default call
- **WHEN** a group is checked across 2,000 spaces, has access to 12 and one space cannot be read
- **THEN** the result lists the 12 spaces, the unreadable space as unknown, the counts and the incomplete flag, without 1,987 audit rows

#### Scenario: Batch preparation is unaffected
- **WHEN** `prepare-space-updates` runs after this change
- **THEN** it reads the complete audit and refuses incomplete scans exactly as before
