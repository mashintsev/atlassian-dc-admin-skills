# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The repository implements Jira operations as TypeScript `ToolDef` modules with Zod inputs, shared REST transport, dry-run writes through `guardedWrite()`, centralized registration, and generated tool reference documentation. It currently has no ScriptRunner tool module or main capability specs.

The Jira endpoint contract, supported plugin versions, and which of the requested resource types expose REST management operations are not established by this repository. Implementation must verify these before promising coverage.

Research for task 1.1 found that Adaptavist documents no public REST API for managing listeners, jobs, Behaviours, Fragments, fields, REST Endpoints, Resources, or Mail Handlers in ScriptRunner for Jira Data Center (features and release notes 8.x–10.x). The only documented programmatic Script Registry access is `POST /rest/scriptrunner/latest/canned/com.onresolve.scriptrunner.canned.jira.admin.ScriptRegistry`, which runs a built-in script and returns script source, so it is excluded. `/rest/scriptrunner-jira/1.0/fields` returns Jira field metadata for pickers and is not a ScriptRunner field-management API. References: https://docs.adaptavist.com/sr4js/latest/features/script-registry, https://docs.adaptavist.com/sr4js/latest/release-notes/release-9.x, https://docs.adaptavist.com/sr4js/8.x/features.

**Findings (task 1.1).** Evidence: the instances' WADL; read-only GETs, of which only key names and types were recorded; and ScriptRunner's own admin JavaScript (web resources of `com.onresolve.jira.groovy.groovyrunner`).
- **Verified pair:** Jira 11.3.7 + ScriptRunner 10.14.0 (the project instance). ScriptRunner 10.7.0 on Jira 11.3.6 showed the same resources.
- **Reads:**

| Area | Resource | Notes |
|---|---|---|
| Scheduled jobs | `GET /rest/scriptrunner/latest/scheduled-jobs[/{id}]` | `FIELD_JOB_CODE`, `FIELD_ADDITIONAL_SCRIPT` are executable |
| Listeners | `GET /rest/scriptrunner-jira/latest/listeners` | `FIELD_SCRIPT_FILE_OR_SCRIPT` is executable; no `disabled` flag |
| Script fields | `GET /rest/scriptrunner-jira/latest/scriptfields[/{id}]` | `CONFIGURATION_SCRIPT` is executable; no `disabled` flag |
| Fragments | `GET /rest/scriptrunner/latest/fragments[/{id}]` | `FIELD_LINK_CONDITION`, `FIELD_CLASS_NAME`, `FIELD_DO_WHAT` are executable or code references |
| REST endpoints | `GET /rest/scriptrunner/latest/custom/customadmin[/{id}]` | `FIELD_SCRIPT_FILE_OR_SCRIPT` is executable |
| Resources | `GET /rest/scriptrunner/latest/resources[/{id}]` | `dataSourcePassword`, `dataSourceUser`, `jdbcUrl`, `previewSql`, `poolPropertyOverrides` are credentials or SQL |
| Script registry | `GET /rest/scriptrunner/latest/scriptSearch` | file list `{filename, filepath, filetype}`, no content |

- **Writes:** there is no separate enable/disable or notes call. The admin UI copies the stored item, with its `id` and `version`, into its edit state, and saves it with `POST {restUrl}/{canned-script}` (body: the whole item). It deletes with `DELETE {restUrl}/{id}`. `POST …/{canned-script}/validate` validates, and `…/params` and `…/preview` render. Job execution (`…/{scriptName}` built-in runs), `user/exec`, `mail-handler/run` and `canned/*` run code and are excluded.
- **Not available:** the Mail Handler has only `POST /rest/scriptrunner-jira/latest/mail-handler/run` (execution). Behaviours have only runtime resources (`/rest/scriptrunner/behaviours/latest/validators*.json`, `runvalidator.json`); their administration is not exposed through REST.

## Goals / Non-Goals

**Goals:**

- Keep ScriptRunner support within the existing Jira product, tool-registry, output, and confirmation models.
- Make verified coverage and unsupported operations visible to callers.
- Ensure the administrative API cannot become an arbitrary Groovy execution path or a job trigger.

**Non-Goals:**

- Manage ScriptRunner for Confluence or other products.
- Execute scripts, trigger jobs, or introduce arbitrary HTTP access.
- Invent endpoints or broaden compatibility claims without evidence.
- Use the canned Script Registry endpoint or any endpoint that runs a script.

## Decisions

### Verify endpoint coverage before defining tool contracts

Because no public management API is documented, the evidence for an operation is a capture, not vendor documentation. Build a resource-by-resource support matrix from sanitized captures taken on the user's instance. Each entry records the HTTP method, path, request and response shapes, the exact Jira and ScriptRunner version pair, the capture date, and the permission required. Read endpoints are captured from read-only GET requests or from a HAR of ScriptRunner's admin UI. For mutations, the evidence is ScriptRunner's own admin code (the save call above) plus read-back verification on every change; the first live write of each type is confirmed by the user like any change. Support is recorded for exact version pairs only, never ranges. The matrix is typed in source and mirrored in `REFERENCE.md`. Implement only operations in the matrix; explicitly return unsupported for anything else rather than emulating it through guessed routes or UI automation.

This allows useful partial coverage without falsely implying that every ScriptRunner module has a public REST API. These internal endpoints may change in any release, so the contract is treated as version-specific. Alternative: assume a single stable API surface for every edition/version; rejected because the vendor publishes no such contract.

### Discover and validate runtime versions centrally

Before any ScriptRunner resource request, a centralized resolver MUST obtain the Jira version from Jira server information and discover ScriptRunner by its verified canonical plugin key through UPM, including its enabled state and version. The canonical key and supported Jira/ScriptRunner version pairs MUST be recorded in the verified support matrix; handlers MUST NOT accept caller-supplied keys or versions. The resolver MUST validate the observed pair against that matrix before any resource request. An absent or disabled app, malformed or missing Jira or ScriptRunner version data, or inaccessible discovery MUST fail closed without making a ScriptRunner resource request. A 401 or 403 from discovery or a resource endpoint MUST remain an authentication or authorization error, never be translated into unsupported; other discovery failures MUST remain explicit discovery errors. Only a verified app absence or unsupported version pair is reported as unsupported.

### Organize tools by management domain

Use separate tool modules corresponding to the three capabilities: scripts and extensions (script registry, REST Endpoints, Resources), automation (jobs, listeners, Mail Handler), and UI configuration (fields, Behaviours, UI Fragments). Register these in the existing `TOOL_GROUPS` structure so the CLI's area listing and generated reference remain consistent. Alternative: one large ScriptRunner module; rejected because the resource types have different data models and operation coverage.

### Writes as unchanged-executable upserts (decision with the user)

ScriptRunner accepts changes only as an upsert of the whole stored item. The user chose to allow two changes:
- `disabled`, on jobs, fragments and REST endpoints;
- the notes field (`FIELD_NOTES`, or `FIELD_LISTENER_NOTES` for listeners).

Each change is sent as that upsert. The handler reads the stored item and copies it unchanged, then changes only the one allowed key, and posts it to `{restUrl}/{canned-script}`. Before sending, it checks that every key other than the allowed one is identical to the stored item. After sending, it reads the item back. It reports a `VerificationError` if any executable key (script, file, parameters, class, condition, code, SQL) or any other key differs, or if the target value is not stored. The request preview and every output are redacted; the body sent is the stored item and is never shown raw. Creating, deleting, duplicating, validating or running items is not offered.

Resources are read-only, even though they have `disabled`: their stored item carries `dataSourcePassword`. A read may return it masked, and sending it back could overwrite the password. Inputs identify an item by id or exact name, never an arbitrary path, method or body. Alternative: a generic ScriptRunner REST proxy; rejected because it would bypass the typed tool contract.

### Minimize source disclosure

Apply a field allowlist and recursive sensitive-field redaction to every list/detail response and every write-facing output, including dry-run previews, confirmation prompts, and mutation results. Never return raw request or response bodies. The sanitizer MUST remove nested script/source/code and credential, password, secret, or token fields, and script source MUST be omitted from default listings. Do not add source retrieval as part of this capability. Use fake REST responses for tests and keep examples synthetic; do not place customer scripts, credentials, or instance data in fixtures. Fixtures derived from captures keep the captured structure but replace every value with a synthetic one.

### Validate contract and safety with isolated tests

Use the existing injectable REST client and unit test conventions to cover paths, encoding, request shapes, response variants, unsupported Jira/ScriptRunner version pairs and resources, discovery fail-closed behavior, permission failures, non-executable mutation allowlists, nested sensitive-field redaction in reads and all write outputs, dry runs, and confirmed requests. Verify each supported endpoint against vendor documentation and captured/synthetic fixtures; do not require a live Jira instance or perform live mutations as part of tests.

## Risks / Trade-offs

- ScriptRunner endpoint behavior may vary by Jira and app version → discover both versions centrally, document verified pairs, and fail closed on unknown or unsupported pairs and operations.
- Script source and configuration may contain secrets → allowlist and redact outputs across reads and writes, avoid real-instance fixtures, and prohibit executable-definition mutations.
- Configuration writes can change instance behavior → use existing dry-run and explicit-confirmation safeguards, narrowly typed inputs, and exact request previews.
- Some requested areas may have no supported REST API → expose supported reads/actions only and report the gap clearly rather than promising full CRUD.
- Internal endpoints are unofficial and an upgrade can break them → support exact captured pairs only, fail closed on any other pair with a message that names the observed pair and says a new capture is needed, and label these operations as unofficial.

## Migration Plan

1. Add the new tools as optional CLI capabilities; preserve existing Jira tools and behavior.
2. Update the skill routing instructions and generated reference to describe verified coverage and safety constraints.
3. Run the existing test, typecheck, and build commands; no live mutation is required.
4. To roll back, remove the ScriptRunner registration and modules and regenerate the reference; no existing plans or stored data should require migration.
