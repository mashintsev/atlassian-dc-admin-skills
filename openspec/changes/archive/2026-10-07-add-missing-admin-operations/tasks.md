# Tasks

## 1. Verify availability (read-only)

- [x] 1.1 On the Jira instance, check the WADL and GET responses for:
  - the notification scheme field of `PUT /project/{key}`;
  - `issuetypescheme/{id}/associations` POST;
  - version delete and `relatedIssueCounts`;
  - `permissionscheme` POST;
  - filter endpoints, including any search over all filters;
  - dashboards;
  - any screen creation path.

  Verify that the confirmed paths and bodies are recorded in `design.md` and that no write was sent.
- [x] 1.2 Load the project config and admin web-resource JavaScript by key (GET only, throttled) and look for internal paths that assign workflow, issue type screen and field configuration schemes. Record each path or "none" in `design.md`. Revise the spec for each operation that becomes a manual change or is dropped, and verify that `openspec validate add-missing-admin-operations` passes.
- [x] 1.3 On the Confluence instance, check the WADL for removing a space category and a content label. Record the result, and verify that the spec still matches what was found.
- [x] 1.4 Write synthetic fixtures under `test/fixtures/` for:
  - project schemes;
  - an issue type scheme;
  - versions with issue counts;
  - a permission scheme with grants;
  - filters with shares;
  - dashboards;
  - Confluence labels and categories.

  Verify that no instance names or data remain.

## 2. Project scheme assignment

- [x] 2.1 Write failing tests for `jira_assign_project_scheme`: already-satisfied, notification scheme via REST with read-back, issue type scheme via associations, a manual change for types without a path, and a manual change when a migration would be needed. Verify that they fail.
- [x] 2.2 Implement the tool (version gate for internal paths, migration check, manual change result) and verify that the tests from 2.1 pass.

## 3. Admin object lifecycle

- [x] 3.1 Implement `jira_remove_issue_types_from_scheme` with presence-only plan state. Verify with tests: default type refused, last type refused, Jira refusal passed on, and an addition plus a removal on one scheme applied in one plan without drift.
- [x] 3.2 Implement `jira_delete_version` with move targets and issue counts in the dry run. Verify with tests: counts shown, move parameters sent, already deleted is satisfied, and read-back shows the version gone.
- [x] 3.3 Implement `jira_create_permission_scheme` (with `copy_from`) and `jira_create_screen` (REST or manual change as found in task 1). Verify with tests: grants copied and compared on read-back, same name with same content satisfied, same name with other content an error.

## 4. Filters and dashboards

- [x] 4.1 Implement filter reads (list with the source flag and truncation, get) and dashboard reads. Verify with fixture tests and the bounded-reads test.
- [x] 4.2 Implement filter create, update and delete, and share add/remove, with the JQL check, favourite count on delete and read-back. Verify with tests: invalid JQL refused, share already present satisfied, and delete shows the favourite count.

## 5. Confluence

- [x] 5.1 Implement `confluence_remove_label` (one plan item per label, `team:` refused) and verify with tests that the other labels remain on read-back.
- [x] 5.2 Implement `confluence_remove_space_category` with read-back (or `Unsupported` if task 1.3 found no path) and verify with tests.

## 6. Integration

- [x] 6.1 Register the tools and update `SKILL.md` and `REFERENCE.md`: typical-task rows that today end in "assign in the Jira UI", manual change hand-offs, irreversible deletes, and UI check plan hints. Verify `list`/`describe` and the bounded-reads test.
- [x] 6.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`. Then run reads and dry runs of every new write tool on the instances. Verify that nothing was executed (no `dry_run=false`).
