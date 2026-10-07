# Live read verification

Date: 2026-10-07. Build: local checkout including optimize-read-token-usage and its search limit correction.

Targets: Jira 11.3.7 (build 11030008), Confluence 10.2.18 (build 9424), configured instances.

Status: PARTIAL. 63 of 65 checks passed. Server operations were read-only. The Markdown write protection check rejected input before any request; no changes were sent.

## Findings

- Jira field contexts and field screens returned HTTP404 for a discovered custom field. These endpoints are not verified on this instance; the read optimizations cannot establish API compatibility.
- Jira search originally accepted limit=101 despite applying 100 internally. Corrected shared search/project issue schema to max100; live calls now reject 101 with ValidationError. Regression tests cover rejection before requests.
- Custom field option counts and two pages worked on the discovered select field.
- Page Markdown, outline, section, max_chars, version outline, comments, inline comments and permissions worked on four existing pages.
- Default Jira/Confluence searches and audit reads, roles, advanced settings and workflow read passed.

## Limits of evidence

- Existing live content does not reproduce the synthetic 80-section runbook, 1200-project sharing or 30000-character XML benchmarks.
- Assets search returned an empty result; real attribute truncation and object history remain unverified.
- Cluster read was empty; nested-table and attachment image round trips were tested locally, not through a live write.
- No live page or issue writes were performed. The cut-code validation test is a local pre-request rejection, not a server write test.
- This is a selected smoke test, not exhaustive verification of all read tools or user visibility.

## Sanitized results

Only tool names, status, error type and output sizes are recorded; no issue/page bodies, user names, credentials or object identifiers are saved.

| Tool | Format | Status | Error | Characters |
|---|---|---|---|---:|
| jira_search | json | PASS |  | 1013 |
| confluence_search | json | PASS |  | 1110 |
| jira_list_custom_fields | json | PASS |  | 8618 |
| jira_search | json | PASS | ValidationError | 203 |
| atlassian_audit_events | json | PASS | ValidationError | 117 |
| atlassian_audit_events | json | PASS |  | 13461 |
| confluence_cluster_nodes | json | PASS |  | 3 |
| confluence_list_long_tasks | json | PASS |  | 3395 |
| jira_application_roles | json | PASS |  | 488 |
| jira_get_advanced_settings | json | PASS |  | 17847 |
| jira_search | json | PASS |  | 6652 |
| atlassian_audit_events | json | PASS |  | 11975 |
| confluence_search | json | PASS |  | 3161 |
| jira_get_worklog | json | PASS |  | 51 |
| jira_get_comments | json | PASS |  | 188 |
| jira_get_issue | json | PASS |  | 385 |
| jira_get_issue | json | PASS |  | 300 |
| jira_get_issue | compact | PASS |  | 564 |
| jira_get_issue | json | PASS |  | 1792 |
| jira_get_project_roles | json | PASS |  | 418 |
| jira_get_project_roles | json | PASS |  | 418 |
| jira_get_field_configuration | json | PASS |  | 803 |
| confluence_get_page | json | PASS |  | 2850 |
| confluence_get_page | json | PASS |  | 533 |
| confluence_get_page | json | PASS |  | 575 |
| confluence_get_page | json | PASS |  | 1212 |
| confluence_get_inline_comments | json | PASS |  | 512 |
| confluence_get_comments | json | PASS |  | 512 |
| confluence_get_page_history | json | PASS |  | 541 |
| confluence_get_space_permissions | json | PASS |  | 471 |
| confluence_get_page | json | PASS |  | 3448 |
| confluence_get_page | json | PASS |  | 582 |
| confluence_get_page | json | PASS |  | 482 |
| confluence_get_page | json | PASS |  | 2708 |
| confluence_get_comments | json | PASS |  | 47 |
| confluence_get_page_history | json | PASS |  | 447 |
| confluence_get_inline_comments | json | PASS |  | 47 |
| confluence_get_space_permissions | json | PASS |  | 471 |
| confluence_get_page | json | PASS |  | 5323 |
| confluence_get_page | json | PASS |  | 614 |
| confluence_get_page | json | PASS |  | 668 |
| confluence_get_page | json | PASS |  | 732 |
| confluence_get_page_history | json | PASS |  | 606 |
| confluence_get_comments | json | PASS |  | 494 |
| confluence_get_inline_comments | json | PASS |  | 494 |
| confluence_get_space_permissions | json | PASS |  | 471 |
| confluence_get_page | json | PASS |  | 8404 |
| confluence_get_page | json | PASS |  | 591 |
| confluence_get_page | json | PASS |  | 754 |
| confluence_get_page | json | PASS |  | 608 |
| confluence_get_inline_comments | json | PASS |  | 624 |
| confluence_get_comments | json | PASS |  | 624 |
| confluence_get_page_history | json | PASS |  | 692 |
| confluence_get_space_permissions | json | PASS |  | 471 |
| jira_get_custom_field_options | json | PASS |  | 151 |
| jira_get_field_contexts | json | FAIL | HTTP404 | 295 |
| jira_get_field_screens | json | FAIL | HTTP404 | 319 |
| jira_get_custom_field_options | json | PASS |  | 286 |
| jira_get_custom_field_options | json | PASS |  | 301 |
| assets_search | json | PASS |  | 45 |
| confluence_search | json | PASS | ValidationError | 197 |
| jira_search | json | PASS | ValidationError | 185 |
| confluence_update_page | json | PASS | ValidationError | 176 |
| jira_get_project_issue_types | json | PASS |  | 356 |
| jira_get_workflow | json | PASS |  | 1748 |
