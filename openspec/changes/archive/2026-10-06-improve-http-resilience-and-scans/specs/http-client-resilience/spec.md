# Spec Delta

## Purpose

Makes every request the CLI sends to Jira and Confluence resilient to throttling and transient failures, gentle on the server, and honest about incomplete or non-JSON answers.

## ADDED Requirements

### Requirement: Retry transient failures of reads
The system SHALL retry idempotent requests (GET, HEAD) after HTTP 429, 502, 503 or 504, a connection reset, or a timeout. It SHALL use exponential backoff with random jitter and a bounded number of attempts.

When a response carries `Retry-After` (in seconds or as an HTTP date), the system SHALL wait at least that long, up to 60 seconds. If the requested wait is longer, the system SHALL fail with the throttling error instead of retrying early.

The system SHALL NOT automatically retry POST, PUT or DELETE requests after the request may have reached the server. A write that fails with 429 before processing MAY be retried, because Jira does not apply throttled requests.

#### Scenario: Gateway error during a scan
- **WHEN** one of 500 project reads answers 503 once and then succeeds
- **THEN** the scan completes with that project included and reports no error

#### Scenario: Retry-After as an HTTP date
- **WHEN** Jira answers 429 with `Retry-After` set to a date 20 seconds ahead
- **THEN** the next attempt is sent no earlier than that date

#### Scenario: Write is not repeated
- **WHEN** a PUT fails with a connection reset after the request was sent
- **THEN** the system reports the failure and does not resend the PUT

### Requirement: Process-wide adaptive request limit
All requests of one CLI process to one product SHALL share one concurrency limit, including requests issued from nested parallel reads. After a 429, the limit SHALL drop (to at least 2). It SHALL recover gradually after successful requests, never above its configured maximum.

When one task of a parallel read fails, the system SHALL stop starting new tasks of that read and SHALL report the first failure.

#### Scenario: Nested parallel reads
- **WHEN** a tool reads create metadata for 20 issue types in parallel and each read pages through results
- **THEN** no more requests than the shared limit are in flight at any time

#### Scenario: Failure stops the fan-out
- **WHEN** the third of 500 parallel project reads fails with a non-retryable error
- **THEN** no further project reads are started and the error is reported

### Requirement: Report truncated reads
Paged reads SHALL report whether they stopped at their item cap. A tool whose result was cut by such a cap SHALL state it in its output, with a `truncated` marker and the cap, and SHALL NOT present the partial list as complete.

#### Scenario: Many versions
- **WHEN** a project has 2,500 versions and the tool reads at most 2,000
- **THEN** the output contains 2,000 versions, marks the result as truncated and names the cap

### Requirement: HTML responses are errors, not data
A response with an HTML body from an endpoint that is read as JSON SHALL NOT be returned as data, whatever its status code. The system SHALL classify it as one of:
- a login or authentication page, including a redirect to the login page or to a single sign-on provider on another host (authentication required; check the token);
- a websudo page (an administrator re-authentication is required; the operation is not possible with a token);
- other HTML with status 200 or 502/503/504 (an upstream or proxy error, with the status code).

Other HTML error pages (for example an HTML 404) SHALL keep their HTTP status error, because callers rely on the status. Each classification SHALL produce its own error type and hint. Error messages SHALL NOT include the HTML body.

#### Scenario: Websudo page with status 200
- **WHEN** an admin endpoint answers 200 with the websudo authentication page
- **THEN** the tool fails with the websudo error and a hint, and returns no data

#### Scenario: Proxy error page
- **WHEN** a reverse proxy answers 502 with an HTML error page
- **THEN** the read is retried. If it still fails, the error names an upstream failure with status 502 and contains no HTML

#### Scenario: Redirect to single sign-on
- **WHEN** a REST call is redirected to the company's sign-on page on another host
- **THEN** the tool fails with the authentication error and returns no data
