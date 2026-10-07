# Tasks

## 1. Benchmark and baseline

- [x] 1.1 Add `test/bench/payloads.ts`: deterministic generators of Data Center REST responses and a fake server that honors `fields`, `maxResults`/`limit` and `expand`. The generators cover issues, comments, changelog, projects, fields, custom fields, users, workflows, apps, audit events, Confluence content, search and spaces, Assets objects, queue issues, and a workflow shared by 1,200 projects. Abstract names only. Verify: a unit test shows that `fields=summary,status` yields issues with only those fields.
- [x] 1.2 Add `test/bench/cases.ts` with the read-tool cases from the read-token-benchmark spec, and `scripts/read-bench.ts`, registered as `pnpm bench:reads` in package.json. It prints raw, compact and JSON tokens, characters and a TOO-LARGE flag. Verify: `pnpm bench:reads` prints every case.
- [x] 1.3 Record the current numbers as `test/bench/baseline.md`. Verify: the file lists every case, including today's TOO-LARGE cases (long page, changelog, audit events).

## 2. Renderer caps and guard diagnostics (agent-context-budget)

- [x] 2.1 Cap arrays and objects in `inline()` to the cell budget, with `+N more` for arrays and `…(+N)` otherwise. Verify: a new `format.test.ts` case shows a 40-key cell cut within 160 characters, and the existing format tests pass.
- [x] 2.2 Cut long strings in `objectLines()` at `ATLASSIAN_MAX_TEXT_CHARS` (default 8,000), at a line boundary, and print multi-line text without the per-line indent. Verify: tests cover a 30,000-character description (marker with the characters left out) and an unindented body.
- [x] 2.3 Add `narrowing?: string[]` to `ToolDef`, pass the tool into `render()`, and name the narrowing arguments in cut markers. Verify: a test shows the marker for a tool with `narrowing`.
- [x] 2.4 Make `ResponseTooLarge` name the three largest top-level fields or columns, with their sizes, and the tool's `narrowing` arguments, without any content. Verify: a CLI-level test with an oversized result checks the message and that no content leaks.
- [x] 2.5 Show non-scalar summary fields of page results in compact output (for example `jira_get_screen_usage`'s usage summary). Verify: a test renders a page with a nested summary and finds it.
- [x] 2.6 Confirm that JSON ignores default columns (already implemented). Update the agent-context-budget tests' wording to match the delta. Verify: `defaultFields.test.ts` passes.

## 3. Bodies and issues (read-output-bounds)

- [x] 3.1 Extract `splitSections(storage)` from `replaceSection` and keep exact matching for writes. Verify: the existing page-section write tests pass.
- [x] 3.2 Add `outline`, `section` (case-insensitive; ambiguous or unknown headings list the candidates) and `max_chars` (default 20,000, maximum 100,000, cut at a block boundary, `truncated` field) to `confluence_get_page` and to the version view of `confluence_get_page_history`. Set `narrowing`. Verify: tests for the 80-section page (default call under the guard), one section, outline and an unknown heading.
- [x] 3.3 Add `max_description_chars` (default 8,000, 0 to omit) to `jira_get_issue`, and summarize changelog values over 120 characters or multi-line as lengths plus a 120-character preview. Verify: tests show the 20-edit changelog under the guard and a cut description with its total length.
- [x] 3.4 Refuse `fields=*all` in `jira_search`, `jira_get_project_issues`, the agile issue lists and `jira_get_queue_issues`. Add `flattenFieldValue()` with one column per extra field. Drop `comment`, `worklog`, `watches`, `votes` and `progress` extras from `jira_get_issue`. Verify: tests cover the ValidationError, a select custom field column holding its value, and queue SLA fields shown as remaining and breached.
- [x] 3.5 Set agile issue lists to default 20 and maximum 100; cap `jira_get_comments` and `jira_get_worklog` at 100. Verify: tests check the schema maxima and the requested `maxResults`.

## 4. Per-tool bounds (read-output-bounds)

- [x] 4.1 `atlassian_audit_events`: `limit` maximum 200, `from`/`to` cut to 120 characters with the remainder count, `raw=true` only with `limit` ≤ 50. `assets_object_history`: the same value cut, plus `offset`. Verify: tests with a 30,000-character workflow XML change.
- [x] 4.2 `assets_search` and `assets_get_object`: default search pages of 20 objects; values cut to 120 characters, at most 20 attributes per row unless `attributes` is given. `assets_get_object_type`: attribute counts plus a pointer to `assets_list_attributes`. `jira_get_request_type_fields`: at most 50 valid values. `jira_get_request_type_form`: `include_addable`. Verify: a test per tool.
- [x] 4.3 Add a `capList()` helper (10 entries plus a total) and `full_lists=true` for:
  - `jira_get_workflow` sharing;
  - `jira_get_field_configuration` `sharedWith`;
  - `jira_application_roles` groups;
  - `jira_get_user` groups and `jira_get_project_roles` actors;
  - `jira_get_screen_usage` arrays;
  - custom field option scope labels;
  - `confluence_get_space_permissions` subjects.

  Verify: tests show a workflow shared by 1,200 projects with 10 keys and `projects: 1200`, and the full list with `full_lists=true`.
- [x] 4.4 Page `jira_get_custom_field_options`: counts per context without `context`; with a context, `limit` (default 100, maximum 1,000) and `offset`. Verify: tests for both modes.
- [x] 4.5 Replace raw passthroughs with allowlists:
  - `jira_get_field_contexts`, `jira_get_field_screens`;
  - `jira_get_advanced_settings`, `atlassian_audit_settings`;
  - `assets_object_references`;
  - `confluence_cluster_nodes`, `confluence_list_long_tasks`, `confluence_get_long_task` (the newest 20 messages);
  - `confluence_get_global_permissions`.

  Verify: one test per tool shows only allowlisted keys.
- [x] 4.6 Declare and apply `limit` maxima for `jira_find_groups` and `confluence_find_users`, and set `confluence_search`'s advertised maximum to 100. Add a test that every read tool's `limit` schema maximum equals the applied cap. Verify: the new test passes.
- [x] 4.7 Shorten the repeated notes (workflow rules gap, filter favourites, field configuration) to one sentence each. Verify: the affected tool tests pass, with updated text expectations.
- [x] 4.8 `confluence_find_spaces_by_group`: by default return the matches, the unknown spaces, the counts and the completeness information; `include_audit=true` for every audit row. `prepare-space-updates` keeps reading the complete audit. Verify: the existing space discovery and batch preparation tests pass, plus a new default-output test.

## 5. Confluence Markdown (confluence-markdown-rendering)

- [x] 5.1 Render only a table's direct rows. Verify: a nested-table test checks 3 outer rows and inner text that appears once.
- [x] 5.2 Render attachment images as bare filenames and strip the base URL from same-instance links. Add a once-per-read note about attachments. Verify: a test reads a page, edits it, writes it back and gets `ri:attachment` again.
- [x] 5.3 Convert comments from `body.storage`, with `max_body_chars` in JSON (default 2,000, maximum 20,000). Verify: a test with a mention and a status macro shows no rendered HTML attributes.
- [x] 5.4 Reject Markdown page writes with the read code-cut marker; render markers for meaningful body-less macros (status, include, toc, children, jira) and cut code blocks over 200 lines in reads. Verify: tests per macro and for a long code block.

## 6. Budgets, docs and checks

- [x] 6.1 Add `test/unit/readBudgets.test.ts`, with separate compact and JSON budgets equal to the post-change measurements plus 10 %, and fail when either format of a default case exceeds the guard. Verify: the test passes, and it fails when a budget is lowered by hand below the measured value.
- [x] 6.2 Update the SKILL.md output rules: cut markers, `full_lists`, `section`/`outline`, and that `fields=*all` works only for one issue. The body must stay within 6,000 characters. Add argument notes to REFERENCE.md and run `pnpm build`. Verify: the skillDocs tests pass and REFERENCE.md is regenerated.
- [x] 6.3 Run `pnpm bench:reads` and record the post-change table next to the baseline in `test/bench/baseline.md`. Verify: no default case is TOO-LARGE, and the savings for each audited case are visible.
- [x] 6.4 Run `pnpm typecheck`, `pnpm test` and `openspec validate optimize-read-token-usage --strict`. Verify: all of them pass.
