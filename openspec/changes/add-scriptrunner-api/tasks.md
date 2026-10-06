# Tasks

## 1. Establish the ScriptRunner API contract

- [ ] 1.1 Record, with vendor references, that Adaptavist documents no public management API. Collect sanitized captures from the user for their exact Jira/ScriptRunner version pair (read-only GETs or a HAR of the admin UI; mutations only from a non-production instance) covering the script registry, jobs, listeners, fields, Behaviours, UI Fragments, REST Endpoints, Resources, and Mail Handler. Record each endpoint's method, path, request/response shape, permission, and capture evidence in the versioned support matrix; exclude canned and script-running endpoints.
- [ ] 1.2 Add centralized Jira-version and ScriptRunner plugin-key/version/enabled-state discovery; reject caller-supplied versions and verify absent, disabled, malformed, inaccessible, unknown, and unsupported runtime states fail closed before any resource request.
- [ ] 1.3 Define typed inputs and compact response shapes for each verified operation; verify unsupported resource operations fail explicitly rather than using guessed routes, while HTTP 401/403 remain authentication/authorization failures.
- [ ] 1.4 Turn the captures into fixtures that keep the captured structure but use synthetic values; verify the repository contains no real scripts, names, or credentials from the instance.

## 2. Implement script and extension management

- [ ] 2.1 Add Jira tools for verified script-registry, REST Endpoint, and Resource operations and register them by area; verify documented request paths, encoding, and response mapping with fake-client tests.
- [ ] 2.2 Add only verified non-executable configuration mutations through `guardedWrite()` using per-operation allowlists; reject source/script/Groovy/code/class/path fields, arbitrary nested objects, and creation/upsert of executable definitions.
- [ ] 2.3 Allowlist and recursively redact list/detail, dry-run, confirmation, and mutation-result output; verify nested source/code and credential/password/secret/token fields are not exposed, and no handler invokes script execution.
- [ ] 2.4 Document this area's supported resources, version limits, and operations in the dispatcher/reference; verify examples match registered tool names and arguments.

## 3. Implement automation management

- [ ] 3.1 Add Jira tools for verified job, listener, and Mail Handler inspection and configuration; verify request mapping and version-specific responses with fake-client tests.
- [ ] 3.2 Add only allowlisted non-executable automation configuration mutations through `guardedWrite()`, reject executable-definition creation/upsert and job-trigger operations, and verify sanitized dry-run, confirmed requests, and mutation results.
- [ ] 3.3 Document supported automation operations and the no-job-trigger boundary; verify CLI `list` and `describe` expose the documented tools.

## 4. Implement UI configuration management

- [ ] 4.1 Add Jira tools for verified ScriptRunner field, Behaviour, and UI Fragment operations; verify request mapping, resource identity, and unsupported cases with fake-client tests.
- [ ] 4.2 Add only allowlisted non-executable UI configuration mutations through `guardedWrite()`; reject executable source/reference fields and executable-definition creation/upsert, and verify sanitized dry-run, confirmed requests, and mutation results.
- [ ] 4.3 Document supported UI resources and version limits; verify the generated reference describes the implemented inputs and outputs.

## 5. Integrate and validate

- [ ] 5.1 Register all tools in the existing area-grouped registry and update the skill dispatcher and generated `REFERENCE.md`; verify every documented tool is discoverable through `list` and `describe`.
- [ ] 5.2 Verify each domain tests Jira/ScriptRunner version-pair gating, discovery and resource-endpoint 401/403 preservation, executable-field rejection, and nested sensitive-field redaction in list/detail, dry-run/confirmation, and mutation results; run `pnpm test` and confirm existing Jira tools remain unchanged.
- [ ] 5.3 Run `pnpm run typecheck`, `pnpm run build`, and `git diff --check`; verify generated artifacts match source and that no tool or test made a live ScriptRunner mutation; mutation captures come only from the user's own actions on a non-production instance.
