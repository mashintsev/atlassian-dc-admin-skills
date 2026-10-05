# Proposal

## Why

A completed Confluence Data Center operation required temporary scripts to discover spaces accessible to a group, add space categories, grant direct administrator access, and verify the outcome. The shipped skill should support that workflow through its bundled CLI, with complete discovery, usable user identities, one reviewable plan, and verified execution.

## What Changes

- Add read-only discovery of spaces with direct group `read:space` grants, covering current/archived and global/personal spaces with explicit completeness reporting.
- Add dedicated space-category read/add tools. Space categories are `team` labels attached to the space description; existing page-label tools keep their current meaning.
- Correct Confluence user-search mapping for the observed modern response (`username`, `userKey`, `title`) while retaining legacy response support. Resolve a unique active user before planning grants.
- Add a native space-update planning workflow for a selected group, category and user: reconcile existing state, record only missing additions, and reuse the existing permission-grant tool.
- Extend native plans with target/identity/selection preconditions, mixed category and permission items, read-back verification, durable outcomes, and safe retries. Preserve existing version-1 plan behavior; new workflow plans carry a distinct versioned contract.
- Extend the skill dispatcher, an on-demand workflow guide, generated reference and README with prepare/review/apply/verify instructions and clear native confirmation behavior.
- Add anonymized regression fixtures reflecting the successful operation: 67 spaces scanned, 52 selected, 50 category additions, 51 grant requests, 101 successful requests and 52 verified final states.

## Capabilities

### New Capabilities

- `confluence-group-space-discovery`: Complete, bounded and read-only selection by an exact group's explicit space-view grants.
- `confluence-space-categories`: Paginated category reads and additive, dry-run-first space-category writes.
- `confluence-user-resolution`: Preserve user identities across response variants and resolve exact active grant subjects safely.
- `confluence-space-batch-updates`: Native preparation, confirmation, state-aware execution and verification of mixed space updates.

### Modified Capabilities

None. `openspec list --specs` reports no existing capability specifications; these new contracts extend existing runtime tools without renaming them.

## Impact

Expected areas: `src/tools/confluence/spaces.ts`, `users.ts`, new category/workflow modules and tool registration; `src/plan.ts`, `src/cli.ts`, existing client/paging/confirmation helpers; relevant `test/unit/` suites; `atlassian-dc-admin/SKILL.md`, an on-demand space-workflow guide, generated `REFERENCE.md`, bundled CLI and `README.md`.

Use existing Node.js 20+, TypeScript, Zod, REST client and native confirmation infrastructure; no new runtime dependencies are expected. Category requests use the official `POST /rest/api/space/{spaceKey}/category/{labelName}` endpoint, validated operationally on Confluence 10.2.18. Do not widen the repository's advertised compatibility matrix without further evidence.

This change prepares product improvements only. No additional production mutations, category removal, permission revocation, implicit group-membership changes or embedded customer credentials/data are in scope.
