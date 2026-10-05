# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The repository implements Jira operations as TypeScript `ToolDef` modules with Zod inputs, shared REST transport, dry-run writes through `guardedWrite()`, centralized registration, and generated tool reference documentation. It currently has no ScriptRunner tool module or main capability specs.

The Jira endpoint contract, supported plugin versions, and which of the requested resource types expose REST management operations are not established by this repository. Implementation must verify these before promising coverage.

## Goals / Non-Goals

**Goals:**

- Keep ScriptRunner support within the existing Jira product, tool-registry, output, and confirmation models.
- Make verified coverage and unsupported operations visible to callers.
- Ensure the administrative API cannot become an arbitrary Groovy execution path or a job trigger.

**Non-Goals:**

- Manage ScriptRunner for Confluence or other products.
- Execute scripts, trigger jobs, or introduce arbitrary HTTP access.
- Invent endpoints or broaden compatibility claims without evidence.

## Decisions

### Verify endpoint coverage before defining tool contracts

Build a resource-by-resource support matrix from official Adaptavist documentation and the target Jira/ScriptRunner version pairs before implementing tool operations. For each requested resource, record supported reads and mutations, request/response shapes, permissions, and known version bounds. Implement only verified operations; explicitly return unsupported for unavailable operations rather than emulating them through guessed routes or UI automation.

This allows useful partial coverage without falsely implying that every ScriptRunner module has a public REST API. Treat the API contract as version-sensitive and keep supported versions explicit. Alternative: assume a single stable API surface for every edition/version; rejected because the repository contains no evidence for that contract.

### Discover and validate runtime versions centrally

Before any ScriptRunner resource request, a centralized resolver MUST obtain the Jira version from Jira server information and discover ScriptRunner by its verified canonical plugin key through UPM, including its enabled state and version. The canonical key and supported Jira/ScriptRunner version pairs MUST be recorded in the verified support matrix; handlers MUST NOT accept caller-supplied keys or versions. The resolver MUST validate the observed pair against that matrix before any resource request. An absent or disabled app, malformed or missing Jira or ScriptRunner version data, or inaccessible discovery MUST fail closed without making a ScriptRunner resource request. A 401 or 403 from discovery or a resource endpoint MUST remain an authentication or authorization error, never be translated into unsupported; other discovery failures MUST remain explicit discovery errors. Only a verified app absence or unsupported version pair is reported as unsupported.

### Organize tools by management domain

Use separate tool modules corresponding to the three capabilities: scripts and extensions (script registry, REST Endpoints, Resources), automation (jobs, listeners, Mail Handler), and UI configuration (fields, Behaviours, UI Fragments). Register these in the existing `TOOL_GROUPS` structure so the CLI's area listing and generated reference remain consistent. Alternative: one large ScriptRunner module; rejected because the resource types have different data models and operation coverage.

### Reuse guarded writes and restrict operation targets

Implement each supported configuration mutation as a specific `ToolDef` handler routed through `guardedWrite()`. Inputs identify a resource and documented fields, never an arbitrary path or method. Each operation MUST use an explicit allowlist of vendor-verified, non-executable mutable fields; reject source, script, Groovy, code, class, and path fields, arbitrary nested objects, and creation/upsert of executable definitions. No mutation may install or alter executable source or references to executable code. Keep script execution and job triggering outside the tool set, even if an underlying plugin API exposes such endpoints. Alternative: a generic ScriptRunner REST proxy; rejected because it would bypass the typed tool contract and widen the mutation surface.

### Minimize source disclosure

Apply a field allowlist and recursive sensitive-field redaction to every list/detail response and every write-facing output, including dry-run previews, confirmation prompts, and mutation results. Never return raw request or response bodies. The sanitizer MUST remove nested script/source/code and credential, password, secret, or token fields, and script source MUST be omitted from default listings. Do not add source retrieval as part of this capability. Use fake REST responses for tests and keep examples synthetic; do not place customer scripts, credentials, or instance data in fixtures.

### Validate contract and safety with isolated tests

Use the existing injectable REST client and unit test conventions to cover paths, encoding, request shapes, response variants, unsupported Jira/ScriptRunner version pairs and resources, discovery fail-closed behavior, permission failures, non-executable mutation allowlists, nested sensitive-field redaction in reads and all write outputs, dry runs, and confirmed requests. Verify each supported endpoint against vendor documentation and captured/synthetic fixtures; do not require a live Jira instance or perform live mutations as part of tests.

## Risks / Trade-offs

- ScriptRunner endpoint behavior may vary by Jira and app version → discover both versions centrally, document verified pairs, and fail closed on unknown or unsupported pairs and operations.
- Script source and configuration may contain secrets → allowlist and redact outputs across reads and writes, avoid real-instance fixtures, and prohibit executable-definition mutations.
- Configuration writes can change instance behavior → use existing dry-run and explicit-confirmation safeguards, narrowly typed inputs, and exact request previews.
- Some requested areas may have no supported REST API → expose supported reads/actions only and report the gap clearly rather than promising full CRUD.

## Migration Plan

1. Add the new tools as optional CLI capabilities; preserve existing Jira tools and behavior.
2. Update the skill routing instructions and generated reference to describe verified coverage and safety constraints.
3. Run the existing test, typecheck, and build commands; no live mutation is required.
4. To roll back, remove the ScriptRunner registration and modules and regenerate the reference; no existing plans or stored data should require migration.
