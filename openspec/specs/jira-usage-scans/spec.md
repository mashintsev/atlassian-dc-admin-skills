# jira-usage-scans Specification

## Purpose

Keeps the project-wide usage scans behind workflow and screen tools cheap and correct: one scan per run while nothing changes, a fresh scan after relevant writes, bounded cost, and explicit completeness.

## Requirements

### Requirement: Scan caching with invalidation
Within one CLI run (a single tool call or one `apply`), the workflow-usage scan and the screen-usage scan SHALL each be performed at most once per scan size, while no write that can change their result has been executed. The following writes SHALL invalidate the cached scans of the affected kind before the next read:
- workflow scheme writes (mappings, defaults, drafts, create, delete);
- changes to a project's scheme assignment;
- screen, screen scheme and issue type screen scheme writes.

A scan that failed SHALL NOT be cached.

#### Scenario: Several workflow edits in one plan
- **WHEN** a plan with five workflow edits is applied and no item writes a workflow scheme
- **THEN** the workflow-usage scan runs once for the whole apply

#### Scenario: Scheme changed earlier in the plan
- **WHEN** item 1 maps a workflow in a workflow scheme used by a project and item 2 edits that workflow
- **THEN** item 2 sees the workflow as active and changes its draft

#### Scenario: Transient scan failure
- **WHEN** the first scan in a run fails and a later item needs the scan
- **THEN** the later item runs a new scan instead of reusing the failure

### Requirement: Bounded scan cost and completeness
Each usage scan SHALL have a request budget in addition to its project limit. When the budget or the limit is reached, or when some projects cannot be read, the scan result SHALL be marked incomplete and SHALL name the reason and the number of projects covered. Tools SHALL NOT present an incomplete scan as complete.

Where Jira offers a verified bulk read that replaces per-project requests (for example, issue types of all projects in one request), the scan SHALL use it.

#### Scenario: Budget reached
- **WHEN** the screen-usage scan reaches its request budget after 80 of 300 projects
- **THEN** the result is marked incomplete, says 80 of 300 projects were covered, and names the budget

### Requirement: Accurate project scheme summary
When the project summary reads the schemes a project uses, only HTTP 404 SHALL mean that the project has no such scheme (the default applies). Any other failure (403, 429, 5xx, authentication) SHALL be reported for that scheme as an error with its status, not as the default scheme.

#### Scenario: Throttled scheme read
- **WHEN** reading a project's workflow scheme answers 429 until retries are exhausted
- **THEN** the summary reports an error for the workflow scheme, not "Default"
