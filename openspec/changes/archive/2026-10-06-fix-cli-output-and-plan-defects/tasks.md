# Tasks

## 1. Compact dry-run output

- [x] 1.1 Write failing tests in `test/unit/format.test.ts`:
  - a dry run with `before`/`after`, `target`, `differences` (nested lists) and `affectedProjects` renders those fields;
  - `identity`/`state` are not rendered;
  - a 300-item list shows "+N more";
  - every line respects the cap.

  Verify they fail.
- [x] 1.2 Render the remaining dry-run fields in `writeResult` (`src/format.ts`) with the caps. Verify that the 1.1 tests and the existing format tests pass.

## 2. Apply exit code

- [x] 2.1 Write failing CLI tests for `apply`:
  - done plus already-satisfied gives 0;
  - done plus drifted gives 5;
  - failed plus drifted gives 1;
  - all declined gives 12;
  - nothing left gives 0.

  Verify they fail where the current code returns 1.
- [x] 2.2 Implement the exit-code rule in `src/cli.ts` and the drift hint in `renderOutcomes`. Update the exit codes in `SKILL.md`/`REFERENCE.md`. Verify the tests pass.

## 3. Argument conversion

- [x] 3.1 Write failing tests:
  - `jira_create_version name=2025` reaches the tool as "2025";
  - `title=true` and `name=null` stay strings for string parameters;
  - number parameters still get numbers, and leading zeros stay strings;
  - `listArg` comma lists and JSON arrays still work;
  - `raw=yes` gives `true`;
  - an inline JSON object as the whole argument still works.

  Verify they fail.
- [x] 3.2 Implement `coerceArgs` in `src/runner.ts` (unwrapping Zod wrappers), make `parseArgs` keep raw strings, and switch `audit.ts raw` to `boolArg`. Verify the 3.1 tests and the full suite pass.
- [x] 3.3 Write failing tests: malformed JSON for `holidays` (both SLA calendar tools) and for `versions` gives `ValidationError` naming the parameter, with an example. Then add `jsonArg` to `src/tools/util.ts`, use it in `sla.ts`, `projectMeta.ts` and `workflowSchemes.ts`, and verify the tests pass.

## 4. Already-satisfied fixes

- [x] 4.1 Write failing tests for `confluence_add_space_category`:
  - a dry run for an existing category returns `already_satisfied`, and `addResultToPlan` records nothing;
  - executing with an existing category sends no POST;
  - a read-back without the category gives `VerificationError`.

  Then implement them and verify they pass.
- [x] 4.2 Write failing tests for `jira_add_issue_types_to_scheme`:
  - every requested type already present gives already-satisfied;
  - a plan adding type A and then type B to one scheme applies both without drift, and the final PUT contains both;
  - a read-back without a requested type gives `VerificationError`.

  Then implement `identity`/`state`, the rebuild on apply and the read-back, and verify they pass.

## 5. Integration

- [x] 5.1 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`. Then run `describe` for the touched tools and one compact dry run of `jira_publish_workflow_draft` against a fake responder (from a test) to confirm the differences are shown. Verify everything is green.
