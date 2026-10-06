# Design

## Context

See [proposal.md](proposal.md) for motivation and scope. The repository currently has no main capability specs. It uses TypeScript, Zod tool definitions, a bundled Node.js CLI, an injectable REST client, compact output, native confirmation and version-1 JSON plans.

Observed source constraints:

- `spaces.ts` lists one server page and reads permissions for a space or subject; group discovery currently requires orchestration outside the shipped CLI.
- `labels.ts` targets `/content/{id}/label`, while `confluence_get_space` intentionally avoids label expansion. Neither exposes space categories.
- `users.ts` maps prototype search results using `name`, `displayName`, `displayableEmail`. A fresh read of the operational server returned `result` entries with `username`, `userKey`, `title` instead. The shipped tool consequently returned `items:[{}]` in full mode; JSON pruning removed the empty list. This is an observed mapper mismatch, not evidence that the account was missing.
- `plan.ts` fingerprints exact dry-run requests. For grants with static bodies, that detects request changes but not a lost source-group grant, changed identity or already-satisfied state. `applyPlan` has no persistent read-back report and continues after item failures.
- `cli.ts` already presents one native checklist for generic plans. Its `--plan` path appends a human notification to JSON stdout, which broke parsing in the preparation script.
- `client.ts` already provides bounded concurrency (default eight), finite paging, same-target URL construction and retry handling. New scans should use a conservative four-worker limit.

### Operational evidence and its limits

The completed operation on Confluence 10.2.18 scanned 67 spaces (including personal scope), found no archived spaces, and selected 52 current global spaces with explicit group `read:space`. The server metric independently matched 67. Two spaces already had the requested team category. One account already had direct read/admin grants in one space, direct read in two, and no direct grants in the other 49. The applied delta was 50 category requests plus 51 permission requests; all 52 final states and preservation of previous assignments were read back successfully.

Private local execution evidence was read to reconcile these counts. Do not copy its hostnames, email addresses, user keys, space names, response bodies or temporary scripts into the product repository. The category/permission operation was live-tested through a temporary orchestration script using the shared REST/confirmation infrastructure; the proposed shipped workflow has not yet been implemented or live-tested. Archived-space behavior and older platform responses remain fixture/reference validation boundaries.

## Goals / Non-Goals

**Goals:**

- Reuse existing tool definitions, native plan review, confirmation and REST transport.
- Make the operational workflow available through the bundled CLI and an on-demand guide.
- Make completeness, desired direct grants, already-satisfied work and verification outcomes explicit.
- Preserve generic version-1 plans and the current page-label contract.

**Non-Goals:**

- Introduce arbitrary HTTP execution, browser automation, additional MCP services or new dependencies.
- Change group membership, remove categories, revoke permissions, grant every possible operation or resolve nested group/effective access.
- Automatically roll back a partly applied administrative batch.
- Re-execute the customer operation during implementation or copy private artifacts as fixtures.

## Decisions

### 1. Separate space categories from content labels

Register `confluence_get_space_categories(space_key)` and `confluence_add_space_category(space_key, name, dry_run?)` in a new category module. Read `GET /rest/api/space/{spaceKey}?expand=metadata.labels`; retain only `prefix=team` categories and follow the server envelope's opaque continuation until completion or the existing safety bound. Verify continuation origin/path before following it; do not invent nested paging parameters. Expose paging/completeness metadata. A category page that cannot prove termination is incomplete, not empty.

Add with `POST /rest/api/space/{spaceKey}/category/{labelName}`, with no replacement body. Use the shared guarded write helper and the existing dry-run/confirmation/plan pathway. The supported input contract is 1–255 characters comprising lowercase letters, combining marks, digits, underscores or hyphens. Reject spaces, empty names, uppercase names and unsupported punctuation without trimming or rewriting them. This is the proposed client-supported naming subset, not a claim to accept every server-specific label spelling.

Source: [official Category API](https://developer.atlassian.com/server/confluence/rest/v1010/api-group-category/). The same endpoint succeeded on 10.2.18 in the completed operation. `/space/{key}/labels` is a different resource for labels of content within a space and is not the selected category read API.

Alternatives considered: reusing content labels on the homepage would change the wrong entity; replacing `metadata.labels` through a space update risks losing existing categories. Both are excluded.

### 2. Provide exact group discovery as a read tool

Add `confluence_find_spaces_by_group(group, type?, status?)`. No filters means both current/archived status requests and both space types. Enumerate server pages, deduplicate by id/key, and call the exact subject permission endpoint per space. Require explicit `read:space`; report any other group grants separately. Do not use a space-name search or assume user membership proves space access.

Return a compact summary and projected matches: space identity/type/status, group operations, inspected/selected counts, declared filters, `completeForCaller`, unknown reads and optional site-count cross-check. Output files retain full audit evidence without printing the entire inventory. Repeated cursors, client safety caps and malformed permission records mark the scan incomplete and block workflow preparation. A comparable count mismatch also blocks unfiltered full-site preparation; an unavailable metric remains an explicit visibility limitation in the reviewable plan.

Reuse the existing bounded client and small server page sizes. HTTP 403/404 on a permission read is unknown unless the API explicitly establishes an empty grant list. Distinguish a nonexistent group from an existing group with zero selected spaces using an exact group lookup.

Alternatives considered: a guessed CQL group-permission filter has no verified contract; unbounded sequential subprocesses waste startup work and hide failure aggregation. Neither is necessary.

### 3. Resolve stable user identities and repair output

Normalize modern search rows from `username`, `userKey`, `title` and legacy rows from `name`, `displayName`, `displayableEmail`. Treat title only as available display information. Preserve identifiers in full/JSON output, and diagnose rows that lack identifiers. Keep absent email values absent.

The preparation resolver first attempts exact username lookup (including email-shaped usernames). Verify any available email against the supplied email intent. For an email that is not a username, search narrowly, hydrate candidate account details, and require exactly one exact email match. A truncated candidate set or missing email evidence cannot establish uniqueness. Verify status and stable key with `GET /rest/api/user` before recording grants. Existing membership can explain inherited read access, but the intended administrative assignment is explicitly direct `read:space` plus `administer:space`.

For existing JSON/full dry-run-with-plan output, keep the dry-run JSON document on stdout and move the human plan-save notification to stderr. The new workflow commands likewise emit one JSON document. Compact output can retain its human summary. This fixes the observed two-line JSON parsing problem without removing useful request fields.

Alternatives considered: accepting the first fuzzy result or writing grants to an unverified email string would risk targeting the wrong user.

### 4. Add a native prepare and verify workflow

Add top-level commands handled before ordinary tool dispatch:

```sh
node <skill-dir>/scripts/atlassian-admin.mjs prepare-space-updates group=example-team category=example-category username=admin@example.invalid --plan=/tmp/space-updates.json
node <skill-dir>/scripts/atlassian-admin.mjs plan /tmp/space-updates.json
node <skill-dir>/scripts/atlassian-admin.mjs apply /tmp/space-updates.json
node <skill-dir>/scripts/atlassian-admin.mjs verify /tmp/space-updates.json
```

These are proposed commands, not currently implemented commands. Preparation requires a new output file and explicit inputs; it never applies changes. Optional `type`/`status` filters match discovery. The workflow helper lives in a new module, while the discovery/category tools remain independently callable and registered normally.

Preparation combines complete discovery, resolved identity, current categories and direct user permissions. It records two item kinds using existing/new write tools: category addition and permission grant. Add only missing direct operations. Satisfied spaces still remain in the plan's objective/verification inventory, even when they contribute no mutation items. Persist current categories/direct grants for preservation checks. An empty selection or fully satisfied objective produces an explicit no-change plan, not an error or a write.

Alternatives considered: teaching agents to generate production write scripts repeats the gap this change addresses; manually appending hundreds of tool calls leaves preconditions and verification outside the product.

### 5. Version workflow plans and add state-aware execution

Keep the version-1 plan reader/executor behavior for existing generic plans. Add an explicit version-2 workflow plan with a discriminator, normalized target URL, selector/scope, completeness metadata, resolved identity, desired category/direct operations, baseline state and fingerprinted native tool items. Validate both formats and reject unknown versions before confirmation or mutation. Items cannot redirect requests or reference arbitrary tool names outside the workflow allowlist. Bind mutation items and baseline state to the immutable selection.

Before applying version-2 plans, validate target/identity and re-read selected state. Remove already-satisfied requests from the checklist. Present the remaining mixed items through the existing `confirmChanges` policy, including selected-subset behavior and exits 12/13. Never modify confirmation settings or answer the user's dialog. Repeat relevant checks before each selected item; preserve the reviewed request fingerprint, exact user key and group-view selector. Do not expand selection if new spaces acquire group access.

Execute serially for predictable journal ordering. Persist each result atomically in a sibling outcome file with restrictive permissions; fail fast on a mutation failure. Keep all original plan items and record unselected/unattempted states explicitly. Plan editing requires a fresh preparation/confirmation; it is not a resumable execution override. The small unavoidable interval between precondition read and additive mutation is documented because the permission/category APIs do not offer a transaction or compare-and-set for this workflow.

Alternative considered: overloading version 1 with hidden extra semantics would blur compatibility. Generic version-1 fingerprint behavior remains available, while the safer workflow has a distinct contract.

### 6. Verify desired state and preserve evidence

`verify` performs reads only, including all selected objective spaces and unchanged/no-op spaces. Check `team` category presence, direct read/admin grants, preservation of recorded categories/direct user grants and continued group access. Serialize per-space checks and read errors. Applying a selected subset verifies selected-item postconditions and separately reports incomplete all-space objectives.

Persist outcomes and verification separately from the immutable plan. Full verified success requires every selected space's desired state and preservation checks to pass. HTTP success with forbidden or inconsistent read-back remains applied-but-unverified. A retry uses fresh preparation against current state, excluding satisfied work and confirming only the remaining delta. Do not automatically undo successful grants if a later item fails.

Alternative considered: mutation-only summaries cannot prove the requested end state and were insufficient in the completed operation.

### 7. Keep skill routing concise and evidence private

Add a short dispatcher pointer to `SPACE_WORKFLOWS.md` for group-based space audits, categories and administrator batches. Put detailed syntax, scope, direct/inherited permission distinctions, confirmation, partial failures and retry guidance in that guide. If the user has already chosen batch execution, proceed to the native checklist without repeating a conversational choice prompt. Otherwise retain the existing per-item/batch choice guidance. Subagents can perform reads/planning; execution stays with the main agent.

Regenerate the reference and bundle through the existing build, update README compatibility/evidence wording, and use synthetic fixtures that preserve only response shapes and aggregate cardinalities. No production user/space identifiers or credentials enter committed artifacts.

## Risks / Trade-offs

- Large installations require many permission reads → use four workers, small pages, explicit caps/completeness and file output; never convert a capped scan into a full-site claim.
- Categories and user responses vary by platform → include modern/legacy and malformed envelopes in fixtures; report observed 10.2.18 live evidence separately from older-version assumptions.
- Partial success cannot be transactional → durable outcomes, additive operations, fail-fast execution and state-based retry; no automatic rollback.
- Requests can race after state checks → re-read immediately before each item, verify afterward, and document the lack of server-side transactions.
- Existing scripts may consume plan-save stdout as text → preserve compact behavior, document the JSON/full notification-channel correction and test JSON parsing.
- Version-2 metadata can contain customer identities → write files with restrictive permissions, omit auth material, and sanitize any examples/fixtures.

## Migration Plan

1. Add tools/workflow and version-aware plan handling with synthetic regression tests.
2. Keep existing version-1 plans and tool names usable; unknown plan versions fail closed.
3. Build the bundled CLI, generated reference and on-demand documentation. The locally installed symlink already follows this repository's skill directory.
4. Verify the complete workflow against a fake server. Any live mutation smoke test requires a separate user-authorized target and reviewable plan; do not reuse the completed customer batch as a test.
5. If a release must be reverted, restore the previous bundle/source; keep execution evidence and require review for any compensating remote changes. Removing successful category/grant additions is not an automatic software rollback step.
