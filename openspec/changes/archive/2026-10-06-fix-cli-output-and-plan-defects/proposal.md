# Proposal

## Why

A project review found defects that make the agent act on wrong or missing information:
- **Dry-run evidence is hidden.** Compact dry runs show only the request, so differences, before/after values and the change target are lost.
- **`apply` reports failure on success.** It exits with 1 when items are already satisfied.
- **Numeric strings are rejected.** Values like `name=2025` fail validation.
- **Bad JSON crashes.** Invalid JSON in JSON-typed arguments surfaces as an internal error.
- **Two writes break plans.** Their already-satisfied handling is broken, so plan items are planned needlessly or drift.

## What Changes

- **Compact dry runs:** print every result field a tool adds beyond the request, such as `before`/`after`, `target`, `differences`, `affectedProjects`, `note`, `precheck` and `change`. Output stays bounded with per-field and per-list caps ("+N more"). Plan internals (`identity`, `state`) stay out of compact output.
- **`apply` exit code:**
  - 0 when every applied item is done or already-satisfied;
  - 5 when any item drifted and none failed;
  - 1 when any item failed;
  - 12 when the user declined, as today.
- **Argument parsing follows each tool's schema:**
  - a string parameter keeps the literal text (`name=2025`, `title=true`, `name=null`);
  - numbers, booleans and JSON values are converted only where the schema expects them;
  - invalid JSON in a JSON-typed argument is a `ValidationError` naming the argument, with a hint;
  - `atlassian_audit_events raw` accepts the usual boolean spellings.
- **`confluence_add_space_category`:** reports `already_satisfied` in its dry run when the category exists, so no plan item is recorded. A failed read-back after the change is a `VerificationError`.
- **`jira_add_issue_types_to_scheme`:**
  - reports already-satisfied when every requested type is in the scheme, instead of a `ValidationError`;
  - records in its dry run only the presence of the requested types, so several items on one scheme in one plan don't drift;
  - reads the scheme back after the change.

## Capabilities

### New Capabilities
- `cli-output-and-arguments`: compact rendering of dry-run results, schema-driven argument conversion, and errors for malformed JSON arguments.

### Modified Capabilities
- `change-plan-execution`: adds the `apply` exit-code contract and already-satisfied/drift-safe behaviour for adding issue types to a scheme.
- `confluence-space-categories`: the dry run reports an existing category as already satisfied, and a read-back mismatch is a verification error.

## Impact

- **Code:**
  - `src/format.ts` (`writeResult`, `EXIT`);
  - `src/cli.ts` (`parseArgs`, `apply` exit code);
  - `src/runner.ts` (argument conversion before Zod);
  - `src/tools/jira/sla.ts`, `src/tools/jira/projectMeta.ts`, `src/tools/jira/workflowSchemes.ts` (JSON arguments);
  - `src/tools/platform/audit.ts`;
  - `src/tools/confluence/spaceCategories.ts`;
  - `src/tools/jira/schemes.ts`.
- **Tests:** unit tests for formatting, argument parsing, `apply` exit codes and both tools.
- **Docs:** the exit codes in `SKILL.md` and `REFERENCE.md`.
- **Compatibility:**
  - Scripts that treated any non-zero `apply` exit as failure now see 0 for already-satisfied items.
  - Callers that relied on the CLI turning `name=2025` into a number for a string field now get the string.
