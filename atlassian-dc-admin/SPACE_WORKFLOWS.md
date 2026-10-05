# Confluence space workflows

Use this guide for exact-group space audits, team categories, and reviewable administrator batches. The workflow uses the bundled CLI and registered Confluence tools; do not write temporary scripts that mutate a production instance.

## Discover and prepare

The group audit is read-only. It checks current and archived global and personal spaces unless `type` or `status` narrows the requested scope. Only an exact direct group `read:space` grant selects a space; user access, inherited access, global permissions, and other group operations do not count as a match.

```bash
A="node <skill dir>/scripts/atlassian-admin.mjs"
$A confluence_find_spaces_by_group group=sample-team --out=/tmp/sample-space-audit.json
$A prepare-space-updates group=sample-team category=sample-category username=sample-admin --plan=/tmp/sample-space-plan.json
```

Use exactly one of `username=` or `email=`. Email resolution requires a complete search result, exact email evidence, one matching active account, and a stable user key. Ambiguous, truncated, unavailable, inactive, or mismatched accounts stop preparation. Category names must use the supported lowercase letters, combining marks, digits, underscores, or hyphens.

Preparation is read-only. It stores the configured target, exact group and scope, resolved username/key, selected spaces, baseline categories/direct user permissions, and only the missing additive requests. The plan file is created with mode `0600` and is never overwritten. An empty delta is a valid no-change plan.

Review the plan before execution:

```bash
$A plan /tmp/sample-space-plan.json
```

The plan lists the target, group, scope, identity, completeness evidence, and exact request for every category/grant item. Review `completeForCaller` and the site-count cross-check. A mismatch blocks preparation; an unavailable cross-check is an explicit visibility limitation, not a site-wide completeness claim. Filtered audits are scoped to their declared filters and do not make a site-wide count claim.

## Confirm, apply, and verify

```bash
$A apply /tmp/sample-space-plan.json
$A verify /tmp/sample-space-plan.json
```

`apply` rechecks the target, active stable user, group view grants, baselines, and current requested state before showing the native checklist. Already-satisfied work is excluded; only the checked category/grant items execute. The checklist is the confirmation gate—never bypass it or change confirmation settings. If the user has already chosen batch execution, proceed to this checklist without asking that choice again. If confirmation is declined or unavailable, no writes are sent.

Updates are additive: category writes use the space-category endpoint, not page labels; permission writes target direct user `read:space` and `administer:space` grants. Existing categories and direct user grants are preserved. Inherited access is not converted into a direct grant and group membership is not changed.

The workflow writes per-item results atomically to `<plan>.outcomes.json` with mode `0600`. `verify` performs remote reads only and writes its report to `<plan>.verification.json`; it checks all objective spaces, desired category/direct permissions, group view access, and recorded baseline preservation. A successful HTTP response without successful read-back is not verified success. Partial selection, unknown reads, lost baselines, or unverified desired state prevent an all-space success report.

## Partial failure and retry

Do not replay a plan that already has outcomes. Prepare a fresh delta from current state and retain the previous execution evidence:

```bash
$A prepare-space-updates group=sample-team category=sample-category username=sample-admin \
  previous_outcomes=/tmp/sample-space-plan.json.outcomes.json \
  --plan=/tmp/sample-space-retry.json
$A plan /tmp/sample-space-retry.json
$A apply /tmp/sample-space-retry.json
$A verify /tmp/sample-space-retry.json
```

Fresh preparation excludes state that is already satisfied and includes a reference to the prior item outcomes. A failed request stops the current batch; later selected items are recorded as unattempted. The workflow does not automatically roll back or revoke successful additions.

All examples use synthetic identifiers. Live mutation testing requires a separate user-authorized target and a reviewed plan.
