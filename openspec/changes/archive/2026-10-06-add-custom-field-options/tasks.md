# Tasks

## 1. Capture the options request (read-only)

- [x] 1.1 Find the JavaScript that calls `customfieldoptions/{id}/setOptions` (project settings field dialogs) and record the request body, whether it replaces the list or applies changes, how disabled options and option ids are expressed, and whether a context or field configuration can be addressed; record the result in `design.md` and adjust the spec if a requirement cannot be met; verify the design names the body fields used by the tool.
- [x] 1.2 Capture option responses (`customFields/{numericId}/options`, `customFieldOption/{id}`) for a select field with several contexts and a disabled option, as synthetic fixtures under `test/fixtures/jira11/`; verify no instance data remains.

## 2. Reading

- [x] 2.1 Implement `jira_get_custom_field_options` (per context, order, disabled, field type check, numeric id handling); verify with fixture-based tests including an empty field and a text field.

## 3. Writing

- [x] 3.1 Implement the manual-change plan (steps to add, rename, reorder, disable or enable against the stored options; options not in the target are kept; duplicate checks) as a pure function; verify with unit tests for each spec scenario.
- [x] 3.2 Implement `jira_set_custom_field_options`: context addressing by scope with the more-specific-context check, the empty-context write with the captured body behind the Jira gate, field references (pending in dry runs), already-satisfied, `identity`/`state`, read-back, and the manual-change dry run with link and `Unsupported` on execution; verify with fake-client tests including Severity 1–4 created in the same plan as the field, a retired value, and an execution that sends only GET requests.

## 4. Integration

- [x] 4.1 Register the tools, update `SKILL.md` and `REFERENCE.md` (no-delete rule, context limits); verify `list`/`describe` and the bounded-reads test.
- [x] 4.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`; check the read tool and a dry run on the instance (no write executed).
