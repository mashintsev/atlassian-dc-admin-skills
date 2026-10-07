# Read-token benchmark

Data Center payloads from `test/bench/payloads.ts`, cases from `test/bench/cases.ts`, cl100k_base tokens. Regenerate with `pnpm bench:reads`. `guard` marks output the 25,000-character response guard refuses.

## Baseline (before optimize-read-token-usage, 2026-10-07)

```
case             tool                             raw  compact   json   chars  guard      note
search-default   jira_search                    16104     1380   1861    3640             20 issues
search-desc      jira_search                    22244     2123   7722    7074             20 issues with descriptions
search-cf        jira_search                    16984     1822   2421    4969             two custom field columns
issue-default    jira_get_issue                 70927      871    876    4237             long description
issue-comments   jira_get_issue                 89305     2376   6434   10442             30 comments
issue-changelog  jira_get_issue                 84468    10155   9605   44753  TOO-LARGE  20 description edits
comments         jira_get_comments              12258      982   3721    4128             150-word comments
projects         jira_list_projects            177602     1825   3121    6467             800 projects
fields           jira_list_fields               69302     2621   3421   10258             900 fields
custom-fields    jira_list_custom_fields         7373     1733   2921    3901             900 custom fields
users            jira_find_users                 9453     1324   2017    4268             50 users
group-members    jira_get_group_members          9488     1325   2021    4270             600 members
workflows        jira_list_workflows            18602     4228   5521   16207             300 workflows
workflow-shared  jira_get_workflow              51900     5302   5325    9545             shared by 1,200 projects
plugins          atlassian_list_plugins         84007     2426   3621    7184             400 apps
audit            atlassian_audit_events         62305    51330  52649  122179  TOO-LARGE  default limit, some workflow XML
queue-issues     jira_get_queue_issues         135172    38140  45466  115196  TOO-LARGE  50 requests with SLA
assets-search    assets_search                 161025    47232  50255  265721  TOO-LARGE  25 objects × 60 attributes
cf-search        confluence_search              20157      754    976    2090             25 results
cf-page          confluence_get_page             6013     2801   2798   10778             12 sections
cf-page-long     confluence_get_page            35933    18237  18234   70754  TOO-LARGE  80-section runbook
cf-children      confluence_get_page_children   34776     1368   1662    3606             children
cf-spaces        confluence_list_spaces         14437     1422   2417    4852             spaces
```

## After optimization (2026-10-07)

Default reads fit both guards. Expanded `search-desc` and `issue-comments` fit compact but need `--out` for JSON at these explicit sizes. Separate token budgets include 10 % headroom.

```
case             tool                             raw  compact  json  chars  json-chars  guard      note
search-default   jira_search                    16104     1380  1861   3640        6205             20 issues
search-desc      jira_search                    22244     2083  7722   6914       35625  TOO-LARGE  20 issues with descriptions
search-cf        jira_search                    16984     1552  2242   4100        7425             two custom field columns
issue-default    jira_get_issue                 70927      807   876   4047        4206             long description
issue-comments   jira_get_issue                 89305     2313  6434  10042       35707  TOO-LARGE  30 comments
issue-changelog  jira_get_issue                 84468     1992  2165   7903        9200             20 description edits
comments         jira_get_comments              12258      982  3721   3988       21043             150-word comments
projects         jira_list_projects            177602     1825  3121   6467       11346             800 projects
fields           jira_list_fields               69302     2621  3421  10258       13256             900 fields
custom-fields    jira_list_custom_fields         7373     1733  2921   3901        9987             900 custom fields
users            jira_find_users                 9453     1324  2017   4268        7422             50 users
group-members    jira_get_group_members          9488     1325  2021   4270        7434             600 members
workflows        jira_list_workflows            18602     4228  5521  16207       23856             300 workflows
workflow-shared  jira_get_workflow              51900      332   355   1044        1258             shared by 1,200 projects
plugins          atlassian_list_plugins         84007     2426  3621   7184       12952             400 apps
audit            atlassian_audit_events         62305     3585  5144  10659       17785             default limit, some workflow XML
queue-issues     jira_get_queue_issues         135172     4407  6417  12009       21982             50 requests with SLA
assets-search    assets_search                 129895     1415  5751   4733       22397             20 objects × 60 attributes
cf-search        confluence_search              20157      754   976   2090        3121             25 results
cf-page          confluence_get_page             6013     2111  2675   8325       10083             12 sections
cf-page-long     confluence_get_page            35933     2142  5508   8446       20784             80-section runbook
cf-children      confluence_get_page_children   34776     1368  1662   3606        5326             children
cf-spaces        confluence_list_spaces         14437     1422  2417   4852        8434             spaces
```

| Case | Compact before | Compact after | Savings |
|---|---:|---:|---:|
| search-default | 1380 | 1380 | 0.0% |
| search-desc | 2123 | 2083 | 1.9% |
| search-cf | 1822 | 1552 | 14.8% |
| issue-default | 871 | 807 | 7.3% |
| issue-comments | 2376 | 2313 | 2.7% |
| issue-changelog | 10155 | 1992 | 80.4% |
| comments | 982 | 982 | 0.0% |
| projects | 1825 | 1825 | 0.0% |
| fields | 2621 | 2621 | 0.0% |
| custom-fields | 1733 | 1733 | 0.0% |
| users | 1324 | 1324 | 0.0% |
| group-members | 1325 | 1325 | 0.0% |
| workflows | 4228 | 4228 | 0.0% |
| workflow-shared | 5302 | 332 | 93.7% |
| plugins | 2426 | 2426 | 0.0% |
| audit | 51330 | 3585 | 93.0% |
| queue-issues | 38140 | 4407 | 88.4% |
| assets-search | 47232 | 1415 | 97.0% |
| cf-search | 754 | 754 | 0.0% |
| cf-page | 2801 | 2111 | 24.6% |
| cf-page-long | 18237 | 2142 | 88.3% |
| cf-children | 1368 | 1368 | 0.0% |
| cf-spaces | 1422 | 1422 | 0.0% |
