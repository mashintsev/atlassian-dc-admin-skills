# Tasks

## 1. Verification (read-only)

- [x] 1.1 On the instance, verify read-only (a few throttled GETs) whether `GET /rest/api/2/project?expand=issueTypes` returns the issue types of every project. Capture the HTML returned for a websudo-protected admin page and for an unauthenticated request as small synthetic fixtures (markers only, no instance data). Record the results in `design.md`; verify that no write was sent and that the fixtures contain no instance names.

## 2. Client resilience

- [x] 2.1 Write failing tests for retries:
  - 503 then 200 on a GET succeeds;
  - a reset POST is not retried;
  - `Retry-After` given in seconds and as an HTTP date is honoured;
  - a wait above 60 s fails.

  Implement the retry policy with injected sleep and time in `src/client.ts`, and verify that the tests pass.
- [x] 2.2 Write failing tests for the per-client limiter:
  - nested `boundedAll` plus paged reads never exceed the limit;
  - a 429 halves the limit, which recovers after successes;
  - `boundedAll` starts no new thunks after a failure.

  Implement the limiter and `ATLASSIAN_MAX_CONCURRENCY`, and verify that the tests pass.
- [x] 2.3 Write failing tests for HTML classification:
  - login page gives `AuthenticationRequiredError`;
  - websudo page served with 200 gives `WebSudoRequiredError`;
  - a 502 HTML page gives `UpstreamError` after retries;
  - no HTML appears in any message;
  - downloads are not affected.

  Implement the classification, the error types, the exit codes and the runner hints, and verify.
- [x] 2.4 Make `xsrfToken` reuse the cached `serverInfo` read where the cookie is available. Verify with a test counting `serverInfo` requests.

## 3. Truncation reporting

Tasks 3.x and 4.x follow test-driven development: write the named test first, see it fail, then implement it.

- [x] 3.1 Add `getPagedResult`/`getPagedConfluenceResult` returning `{items, truncated, cap}`, with unit tests.
- [x] 3.2 Migrate the capped callers (versions, createmeta readers, `allScreens`, the Confluence space-scan fallback) to show `truncated` and the cap in their output. Verify each with a fixture-based test that exceeds the cap.

## 4. Usage scans


- [x] 4.1 Add a per-client `ScanCache` (promise-valued, deleting entries on rejection). Make `jiraVersion`, `jsmVersion` and `allScreens` drop rejected promises. Verify with tests in which a first failure is followed by a successful retry in the same run.
- [x] 4.2 Add `invalidates` to `ToolDef` and clear it in the runner after executed writes. Declare it on the workflow scheme, project and screen-related write tools. Verify with a test that every write tool in those groups declares it, or declares none explicitly.
- [x] 4.3 Cache the workflow-usage scan through `ScanCache`. Verify with tests:
  - a five-edit plan scans once;
  - a plan that maps the workflow in item 1 sees it as active in item 2.
- [x] 4.4 Cache the screen-usage scan through `ScanCache` with invalidation. Add a request budget and an `incomplete` result. Use the bulk issue-type read if 1.1 confirmed it. Verify with tests for budget exhaustion and invalidation after a screen write.
- [x] 4.5 Fix the project summary so that only a 404 means the default, and other errors are reported per field. Verify with a test where the scheme read answers 429 or 500.

## 5. Integration

- [x] 5.1 Update `SKILL.md`/`REFERENCE.md`: the new error types and hints, `truncated`/`incomplete` markers and `ATLASSIAN_MAX_CONCURRENCY`. Verify `describe` and the bounded-reads test.
- [x] 5.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`. Then on the instance, run read-only `jira_find_workflow_usage` and `jira_get_screen_usage` and a workflow dry run. Verify the request counts (one scan per run) and that no write was sent.
