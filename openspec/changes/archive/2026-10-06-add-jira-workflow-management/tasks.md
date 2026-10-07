# Tasks

## 1. Capture shapes and bodies (read-only)

- [x] 1.1 Capture designer `workflows` (live and draft), `statuses`, `statusCategories`, projectconfig workflow and transition properties responses as synthetic fixtures under `test/fixtures/jira11/`; verify no instance data remains.
- [x] 1.2 Load the workflow designer's web resources by key and record the bodies of status/transition/global transition writes, `statuses/create`, `validateRemove`, `publishDraft` (backup name), `discardDraft`, how a draft is addressed, and the copy request; record them in `design.md` and revise the spec for any operation without a confirmed body; verify the design lists every body a tool uses.

## 2. Reading

- [x] 2.1 Implement `jira_get_workflow` (by name or project + issue type, draft flag, statuses with categories, transitions with directions, global/looped, properties, sharing, explicit rule gap); verify with fixture-based tests for each scenario in `jira-workflow-reading`.
- [x] 2.2 Implement the name-based comparison and `jira_compare_workflows`; verify with unit tests for identical models, missing statuses and missing or renamed transitions.

## 3. Editing

- [x] 3.2 Implement the status tools (add existing/new, update, remove with `validateRemove`) behind the Jira gate, with implicit drafts, per-operation `state` and read-back; verify with tests including a refused removal and two edits in one plan applied without drift.
- [x] 3.3 Implement the transition and global transition tools with already-satisfied, per-operation `state` and read-back; verify with tests including the "Escalate" scenario on an active workflow.
- [x] 3.4 Implement `jira_publish_workflow_draft` (dry run with the draft/live comparison and affected projects) and `jira_discard_workflow_draft`; verify with tests including "no draft → already-satisfied".

## 4. Integration

- [x] 4.1 Register the tools, update `SKILL.md` and `REFERENCE.md` (rule gap, drafts, gate); verify `list`/`describe` and the bounded-reads test.
- [ ] 4.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`; check `jira_get_workflow` and `jira_compare_workflows` and the dry runs of the write tools on the instance (no write executed).
