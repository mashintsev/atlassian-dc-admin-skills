# Proposal

## Why

A read-only review of how the CLI talks to Jira and Confluence found three problems:
- **Scans are expensive and repeated.** A workflow usage scan is 1 + N project requests (N defaults to 500), and it runs on every workflow edit, twice per plan item. A screen usage scan is about 3 + N × (1 + 3×T) requests.
- **The client is fragile.** Only 429 is retried. `Retry-After` is capped at 10 s, and retries have no jitter. Each `boundedAll` call keeps its own concurrency limit and keeps firing after a failure.
- **Some answers are silently wrong.** Paged reads are truncated without saying so. HTML login, websudo or proxy pages are returned as data. A project summary reports "Default" when a scheme read fails.

On a busy Data Center node, these turn into throttling, aborted scans and wrong answers.

## What Changes

- **Retries:** idempotent GETs are retried on 502/503/504, connection resets and timeouts, with exponential backoff and jitter. `Retry-After` is honoured in both its seconds and HTTP-date forms, up to 60 s. Writes are never retried automatically.
- **Concurrency:**
  - one process-wide request limiter replaces the per-call limits;
  - after a 429 it lowers parallelism adaptively, and restores it gradually after successes;
  - `boundedAll` stops scheduling new work after the first failure.
- **Truncation:** paged reads report whether they were cut at their cap. Tools that cap results say so in their output (`truncated`, with the cap). This covers project versions, create metadata, the screen list and the Confluence space-scan fallback.
- **HTML responses:** an HTML page returned by a JSON endpoint is never parsed as data. A login page, a websudo page and a proxy or server error page each become a specific error with a hint. A websudo or login page served with status 200 is also an error.
- **Usage scans** (workflow and screen):
  - **Caching:** they are cached per run and invalidated by any write that can change their result. A rejected scan is never cached.
  - **Reuse:** a plan item reuses the scan between its dry run and its execution.
  - **Budget:** the screen scan gets a request budget; when the budget is spent, it reports itself as incomplete instead of guessing.
  - **Bulk reads:** where Jira offers a bulk read, it replaces per-project requests. Each bulk read is checked on the instance first.
- **Per-client caches:** caches for the screen list and the Jira and JSM version reads drop failed reads, so one transient error does not break the rest of the run.
- **Project summary:** only a 404 means "no scheme". Other errors are reported per field instead of "Default".
- **XSRF token:** the token read reuses the cached `serverInfo` request when possible.

## Capabilities

### New Capabilities
- `http-client-resilience`: retries and backoff for reads, a process-wide adaptive request limiter, fail-fast parallel reads, truncation reporting for paged reads, and recognition of HTML responses (login, websudo, upstream errors).
- `jira-usage-scans`: caching and invalidation of the workflow and screen usage scans, reuse within a plan item, request budgets with completeness reporting, failure-free caches, and accurate project scheme summaries.

### Modified Capabilities
<!-- None: the existing specs (jira-workflow-editing, jira-screen-field-management) already require bounded scans that report incompleteness; this change does not alter their requirements. -->

## Impact

- **Code:**
  - `src/client.ts` (send/retry, limiter, `boundedAll`, paging helpers, parse, `xsrfToken`), `src/errors.ts` and `src/runner.ts` (new error types and hints), `src/jiraVersion.ts`;
  - `src/tools/jira/workflowSchemes.ts`, `src/tools/jira/workflows.ts`, `src/tools/jira/screens.ts`, `src/tools/jira/projects.ts`, `src/tools/jira/projectMeta.ts`, `src/tools/jira/issues.ts`, `src/tools/confluence/spaces.ts`;
  - `src/plan.ts`, for scan reuse within an item.
- **Tests:** client unit tests for retries, the limiter and HTML detection; scan cache and invalidation tests; truncation flags in tool outputs.
- **Behaviour:** fewer requests to Jira, more resilient long scans, and explicit `truncated`/`incomplete` markers in some outputs. No API endpoints are added or removed.
