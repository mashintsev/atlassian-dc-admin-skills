# Design

## Context

See proposal.md. Current code:
- **`src/client.ts`:**
  - `send` (around l.140–165) retries only 429, at most 4 times (`RATE_LIMIT_RETRIES`). It caps waits at 10 s (`RATE_LIMIT_MAX_WAIT_MS`, l.22) and reads `Retry-After` as seconds only, with no jitter.
  - `boundedAll` (l.77) limits concurrency per call (`MAX_CONCURRENCY = 8`, l.20) and keeps scheduling after a rejection.
  - `getPaged`/`getPagedConfluence` (l.201, l.216) slice results to `maxItems` without a flag.
  - `parse` (l.230) returns any non-JSON text as a string.
  - `xsrfToken` (l.177) sends its own `serverInfo` request.
- **`src/errors.ts:17`:** `errorDetail` drops HTML bodies, so HTML errors carry an empty detail.
- **Scans:**
  - `scanSchemesInUse` (`workflowSchemes.ts:77`) is called through `workflowUsage` (l.127) from `workflows.ts:234, 426, 809`. It is deliberately uncached since the previous review, so it runs on every edit.
  - `screenUsageScan` (`screens.ts:204`) is cached per client and cap (l.201) and never invalidated. `allScreens` (`screens.ts:34`), `jiraVersion` and `jsmVersion` (`jiraVersion.ts:13, 41`) cache promises, including rejected ones.
- **Project summary:** `projects.ts:28` `tryGet` maps every HTTP error to `null`, which then becomes "Default" (l.69, l.74).
- **Plan execution:** `applyPlan` (`plan.ts:163`) runs every item as a dry run and then executes it, through the same `ToolContext`. The clients are created once per `apply`.

## Goals / Non-Goals

**Goals:**
- Fewer requests and resilient long reads without changing tool contracts, apart from the new `truncated`/`incomplete` markers and error types.
- Correct scan results across the items of a plan.

**Non-Goals:**
- Persisting caches across CLI processes.
- Retrying writes after they may have reached the server.
- New endpoints, apart from bulk reads verified on the instance.

## Findings (task 1.1, on the instance, Jira 11.3.7; GET only, nothing written)

- **No bulk issue-type read:** `GET /rest/api/2/project?expand=issueTypes` answers 200 for all 45 projects, but none carries `issueTypes`. The screen scan keeps one project read per project and relies on its request budget.
- **Websudo page:** a websudo-protected admin page answers HTTP 200 `text/html`, with `X-Seraph-LoginReason: OK`. It contains `WebSudo` and `WebSudoAuthenticate`, which the markers catch.
- **REST without a token:** `401` with a JSON body (not HTML), already an authentication error (exit 6).
- **Page without a token:** a `302` to `/login.jsp`, then a redirect to the company's single sign-on (an OAuth2 `…/authorize` URL on another host, with SAML markers). Added after the check:
  - a REST call whose final URL is on another host or at `/login.jsp` is `AuthenticationRequired`;
  - the login markers include `oauth2/…/authorize` and `SAMLRequest`.

  Fixtures are synthetic: `test/fixtures/html/sso.html`, `login.html`, `websudo.html` and `proxy-502.html`.

## Decisions

### Retry policy in `send`
- **Retryable:** 429, 502, 503, 504, `ECONNRESET`/`fetch failed`, and `AbortSignal.timeout`.
  - These are retried only for GET/HEAD, except 429, which is retried for any method. Jira rejects a throttled request before processing it, as current behaviour already assumes.
- **Backoff:** `base × 2^attempt × (0.5 + random)`, at most 5 attempts.
- **`Retry-After`:** parsed as seconds or as an HTTP date. A wait longer than 60 s ends retrying with the throttling error.
- **Testing:** the injectable `FetchLike` already allows fake responses. Time is injected through a small `sleep`/`now` seam, so the tests do not wait.
- **Alternative:** a retry library. Rejected to keep the bundle dependency-free.

### One limiter per client
`AtlassianClient` owns an async semaphore. `send` acquires it per attempt and releases it on the response (or after the body has been read).
- **`boundedAll`** keeps its signature, but it no longer limits concurrency itself: the client limiter does.
- **Fail-fast:** a shared `failed` flag stops workers from taking new thunks once one rejects. Thunks already in flight finish, and their results are dropped.
- **Adaptive limit:**
  - on a 429 it becomes `max(2, floor(limit/2))`;
  - after every 20 consecutive successes it grows by 1, up to the configured maximum;
  - the maximum comes from `MAX_CONCURRENCY`, which becomes configurable via `ATLASSIAN_MAX_CONCURRENCY`, default 8.
- **Alternative considered:** a global module-level semaphore. Rejected, because tests create many clients.

### Truncation flag
- **Helpers:** `getPagedResult` and `getPagedConfluenceResult` return `{items, truncated, cap}`. The existing helpers stay as wrappers, so call sites migrate one by one.
- **Tools that pass on the flag:** versions (`projectMeta.ts:159`), createmeta (`issues.ts:204, 208`; `projectMeta.ts:47, 86, 109`), `allScreens` and the Confluence space-scan fallback (`spaces.ts:90`) add `truncated: true` and the cap to their output.

### HTML classification
`send` checks `content-type` (and a leading `<`) on JSON reads.
- **Classification by markers:**
  - login: `login.jsp`, `X-Seraph-LoginReason` header, `os_destination`;
  - websudo: `WebSudo`, `secure/admin/WebSudoAuthenticate`;
  - anything else: upstream.
- **Errors:** new classes `AuthenticationRequiredError` (exit 6), `WebSudoRequiredError` (exit 3, hint: the operation needs the UI) and `UpstreamError` (exit 10, retryable when 502/503/504).
- **Exempt endpoints:** endpoints that intentionally return HTML or text (attachments, exports, `getBytes`) are not checked.
- **Testing:** fixtures are small synthetic HTML snippets.

### Scan caching with invalidation
- **Cache:** a per-client `ScanCache` keyed by kind (`workflow-usage`, `screen-usage`) and cap. It holds promises and deletes an entry when the promise rejects.
- **Invalidation:**
  - a write tool declares `invalidates: ["workflow-usage"]` (or screens) in its `ToolDef`;
  - the runner clears those kinds after any executed write (`dry_run=false`) of that tool, whether it succeeded or failed;
  - dry runs do not invalidate.
- **Effect on plans:** one `apply` scans once per kind, until an item writes something relevant. Reuse between an item's dry run and its execution follows automatically.
- **Writes that invalidate:**
  - `workflow-usage`: workflow scheme tools, `jira_set_project_permission_scheme`-like assignment tools (if any affect workflow schemes), and project create/archive/restore;
  - `screen-usage`: screen, screen scheme, issue type screen scheme, and screen field tools that change usage.
- **Alternative rejected:** time-based expiry. It is not correct inside a plan.

### Scan budgets and bulk reads
- **Budget:** each scan counts its requests against a budget (default: the project cap × the expected requests per project, overridable by an argument).
- **Incomplete results:** on budget or cap exhaustion the result carries `incomplete: {reason, coveredProjects, totalProjects}`. The existing `truncatedScan`/`forbiddenProjects` fields map into it.
- **Bulk read:** `GET /rest/api/2/project?expand=issueTypes` is a candidate. Task 1.1 verifies it read-only on the instance (and in the WADL). The scan uses it only if it is confirmed.

### Project summary
`tryGet` returns `{status: 404}` as absent. Any other `HttpStatusError` becomes `{error: "HTTP <status>"}` for that field. The summary shows the error instead of "Default".

## Risks / Trade-offs

- **[Retries lengthen failures]** → Attempts and the total wait are bounded, and the output names the retries in the error detail.
- **[Adaptive limiter makes runs slower under throttling]** → That is the intent, because throttling means Jira is overloaded. The configured maximum is unchanged.
- **[Invalidation lists can miss a write tool]** → A test asserts that every write tool in the scheme, screen and project groups declares its invalidations, or explicitly declares none.
- **[HTML heuristics misclassify]** → Unknown HTML falls back to `UpstreamError`, which is still an error and never data.
- **[Bulk read not available]** → Scans keep the per-project path. Only the budget changes.

## Migration Plan

Internal changes with additive output fields. Rollback reverts the client and scan modules. No configuration changes are required. `ATLASSIAN_MAX_CONCURRENCY` is optional.

## Live check (task 5.2, GET only)

One context was run as an `apply` would: `jira_list_workflow_schemes`, `jira_find_workflow_usage`, two `jira_add_workflow_status` dry runs and two `jira_get_screen_usage` calls (`scan_projects=10`).
- **Workflow scheme scan:** one scan for all of them, 45 per-project reads; the project list was read once per scan kind. The first run showed three scans, because the list and find tools bypassed the cache; they now share it.
- **Screen usage:** returned `incomplete: {reason: "project cap", coveredProjects: 10, totalProjects: 45}`.
- **Methods:** only GET.
- **Also found and fixed:** compact rows of plain values were cut by their position (the same index bug as `inline`, in `rows`).
