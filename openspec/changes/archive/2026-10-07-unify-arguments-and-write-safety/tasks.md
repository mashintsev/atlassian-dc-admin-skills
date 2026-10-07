# Tasks

## 1. Argument conventions

- [x] 1.1 Add `aliases` to `ToolDef` and resolve them in `runTool` before validation, refusing an alias plus a canonical name with different values. Write failing tests first, for an alias-only call, a conflicting call and an identical duplicate. Verify that `pnpm test` passes.
- [x] 1.2 Show aliases in `describe` and in the generated `REFERENCE.md` tool list (`name (alias: old)`). Verify with a `describe` snapshot test and `pnpm run build`.
- [x] 1.3 Apply the field and issue type mapping from design.md:
  - `field`, `issue_type`, `issue_types` and `default_issue_type`, with the aliases;
  - id-or-name resolution in `jira_get_field_contexts`, `jira_get_field_screens`, `jira_get_field_options`, the workflow scheme mapping tools, `jira_get_field_configuration` and `jira_get_create_fields`;
  - a new shared issue type resolver.

  Verify with tests by id, by name, ambiguous and unknown, and that the old names produce identical requests.
- [x] 1.4 Apply the user, project, service desk and property mapping:
  - `user` (with the alias `username` only where it names an existing user);
  - `project_key`, including the renamed `jira_compare_workflows` arguments;
  - `service_desk`, with project-key resolution in the 5 read tools;
  - `key` for `jira_set_application_property`.

  Verify with tests that each old name still works and gives the same request.
- [x] 1.5 Add suggestions for unknown tool names and arguments (edit distance, up to three, in `hint`) and the new HTTP hints (400, 429, 5xx). Verify with tests for a misspelled tool, a misspelled argument, and each status code.

## 2. Write safety: Jira administration

- [x] 2.1 `jira/users.ts` (10 tools): already-satisfied, read-back, and an unverifiable note for `jira_kill_user_sessions`. Test first for each tool: already-satisfied with nothing sent, execute plus read-back, and a read-back mismatch giving `VerificationError`.
- [x] 2.2 `jira/projects.ts` (5 tools) and `jira/schemes.ts` permission grants plus `jira_create_issue_type`: the same pattern and tests.
- [x] 2.3 `jira/workflowSchemes.ts` (9 tools): already-satisfied, read-back on the scheme or its draft, and an identity/state that holds only the touched mapping. Verify with tests, including two mappings of one scheme in one plan applied without drift.
- [x] 2.4 System and reindex writes: an already-satisfied plus read-back for `jira_set_application_property`, and unverifiable notes for both reindex starts. Verify with tests and the `describe` text.

## 3. Write safety: Confluence and Assets

- [x] 3.1 `confluence/users.ts` (6 tools) and `confluence/labels.ts`: already-satisfied and read-back. Verify with tests per tool, including membership already present.
- [x] 3.2 `confluence/spaces.ts` (grant, revoke, archive, delete): already-satisfied, read-back and a state holding only the touched permissions; delete is described as polled-only. Verify with tests, including a grant that is already present and two grants for one space in one plan without drift.
- [x] 3.3 `assets/structure.ts` (12 tools): create when the same name has the same settings → already-satisfied, and with other settings → error; update without difference → already-satisfied; delete when absent → already-satisfied; read-back for each. Verify with tests per object kind.
- [x] 3.4 `assets/objects.ts`: update, delete, archive and bulk update get already-satisfied and read-back; create object and add comment are described as unverifiable. Verify with tests.
- [x] 3.5 Mark the remaining content writes as unverifiable where repeats duplicate data, and say so in their dry runs: comments, worklog, attachments, issue and page creation. Verify with a test that every write tool either has an already-satisfied path covered by a test or carries the unverifiable note.

## 4. Chained plan references

- [x] 4.1 Record `created: {type, name, id}` in an item's outcome when the tool creates an object (custom field, issue type, workflow scheme). Verify with a plan test that the plan file holds the ids after `apply`.
- [x] 4.2 Resolve issue type names in `jira_add_issue_types_to_scheme` and the mapping tools, with a pending placeholder in dry runs. Verify with a plan test: create "Change Request", then add it to a scheme, both applied without drift; applied alone with the type missing, the item fails and nothing is sent.
- [x] 4.3 Resolve workflow scheme names from the project scan, then from the ids that earlier items of the plan created. Verify with a plan test: create "Ops scheme", then set a mapping in "Ops scheme", without drift; an unknown name fails without sending.
- [x] 4.4 Print the re-plan command under each drifted item in `renderOutcomes`. Verify with a test.

## 5. Test coverage

- [x] 5.1 Recompute the tools that no test references by name (`list` output against `test/unit/**`), and record the list in a comment at the top of a new `test/unit/coverage.test.ts`. That test fails while any tool is missing (allowlist empty at the end). Verify that the test fails at first.
- [x] 5.2 Add tests until 5.1 passes: for each write tool, the dry-run request shape (method, path, body); for each read tool, a happy-path read on a synthetic fixture. Verify that `pnpm test` passes with an empty allowlist.

## 6. Docs and verification

- [x] 6.1 Update `REFERENCE.md` (argument notes: canonical names and aliases, write-safety coverage, unverifiable writes, chained references) and add one line on aliases to `SKILL.md`. Verify with `pnpm run build` and a review that the regenerated tool list shows the aliases.
- [x] 6.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`. Then dry-run, read-only, against the test instance: one alias call per concept and the already-satisfied path of a group membership, a permission grant and a workflow scheme mapping. Verify that nothing is sent.
