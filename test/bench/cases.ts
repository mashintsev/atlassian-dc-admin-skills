/**
 * Read-token benchmark cases and their budgets (compact cl100k tokens). Raising a budget means editing
 * this file; readBudgets.test.ts fails when a case grows more than 10 % over its budget, and when any
 * default call renders past the response guard.
 */

export interface BenchCase {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  note: string;
  /** Compact tokens allowed (measured after optimize-read-token-usage, plus headroom). */
  budget: number;
  jsonBudget: number;
  /** Explicit expanded reads may require --out in JSON. */
  expanded?: boolean;
}

export const CASES: BenchCase[] = [
  { id: "search-default", tool: "jira_search", args: { jql: "project = PRJ1" }, note: "20 issues", budget: 1519, jsonBudget: 2048 },
  { id: "search-desc", expanded: true, tool: "jira_search", args: { jql: "project = PRJ1", include_description: true }, note: "20 issues with descriptions", budget: 2292, jsonBudget: 8495 },
  { id: "search-cf", tool: "jira_search", args: { jql: "project = PRJ1", fields: "customfield_10000,customfield_10005" }, note: "two custom field columns", budget: 1708, jsonBudget: 2467 },
  { id: "issue-default", tool: "jira_get_issue", args: { issue_key: "PRJ1-1" }, note: "long description", budget: 888, jsonBudget: 964 },
  { id: "issue-comments", expanded: true, tool: "jira_get_issue", args: { issue_key: "PRJ1-1", comments: 30 }, note: "30 comments", budget: 2545, jsonBudget: 7078 },
  { id: "issue-changelog", tool: "jira_get_issue", args: { issue_key: "PRJ1-1", include: "changelog" }, note: "20 description edits", budget: 2192, jsonBudget: 2382 },
  { id: "comments", tool: "jira_get_comments", args: { issue_key: "PRJ1-1" }, note: "150-word comments", budget: 1081, jsonBudget: 4094 },
  { id: "projects", tool: "jira_list_projects", args: {}, note: "800 projects", budget: 2008, jsonBudget: 3434 },
  { id: "fields", tool: "jira_list_fields", args: {}, note: "900 fields", budget: 2884, jsonBudget: 3764 },
  { id: "custom-fields", tool: "jira_list_custom_fields", args: {}, note: "900 custom fields", budget: 1907, jsonBudget: 3214 },
  { id: "users", tool: "jira_find_users", args: { query: "user" }, note: "50 users", budget: 1457, jsonBudget: 2219 },
  { id: "group-members", tool: "jira_get_group_members", args: { group: "jira-users" }, note: "600 members", budget: 1458, jsonBudget: 2224 },
  { id: "workflows", tool: "jira_list_workflows", args: {}, note: "300 workflows", budget: 4651, jsonBudget: 6074 },
  { id: "workflow-shared", tool: "jira_get_workflow", args: { project_key: "PRJ1", issue_type: "Task", properties: false }, note: "shared by 1,200 projects", budget: 366, jsonBudget: 391 },
  { id: "plugins", tool: "atlassian_list_plugins", args: { product: "jira" }, note: "400 apps", budget: 2669, jsonBudget: 3984 },
  { id: "audit", tool: "atlassian_audit_events", args: { product: "jira" }, note: "default limit, some workflow XML", budget: 3944, jsonBudget: 5659 },
  { id: "queue-issues", tool: "jira_get_queue_issues", args: { service_desk: "3", queue_id: "65" }, note: "50 requests with SLA", budget: 4848, jsonBudget: 7059 },
  { id: "assets-search", tool: "assets_search", args: { aql: 'objectType = "Laptop"' }, note: "20 objects × 60 attributes", budget: 1557, jsonBudget: 6327 },
  { id: "cf-search", tool: "confluence_search", args: { query: "request" }, note: "25 results", budget: 830, jsonBudget: 1074 },
  { id: "cf-page", tool: "confluence_get_page", args: { page: "5001" }, note: "12 sections", budget: 2323, jsonBudget: 2943 },
  { id: "cf-page-long", tool: "confluence_get_page", args: { page: "5999" }, note: "80-section runbook", budget: 2357, jsonBudget: 6059 },
  { id: "cf-children", tool: "confluence_get_page_children", args: { page: "5001" }, note: "children", budget: 1505, jsonBudget: 1829 },
  { id: "cf-spaces", tool: "confluence_list_spaces", args: {}, note: "spaces", budget: 1565, jsonBudget: 2659 },
];
