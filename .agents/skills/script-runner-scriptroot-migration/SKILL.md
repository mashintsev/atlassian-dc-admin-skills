---
name: script-runner-scriptroot-migration
description: Migrate Jira ScriptRunner inline Groovy to ScriptRoot files without changing behavior, with rollback, live read-back, hash verification, and an updated inventory. Use for Behaviours, workflow scripts, fragments, jobs, listeners, REST endpoints, and Script Fields.
compatibility: Requires the project instructions, jira-config, atlassian-dc-admin, and access to the target Jira Data Center instance.
---

# ScriptRunner Inline to ScriptRoot migration

Use this skill for a bounded migration from ScriptRunner Inline Groovy to a ScriptRoot file. The migration is a storage and binding change, not a refactor or bug fix.

## Invariants

- Treat live Jira production as the source of truth for the running binding and code location.
- Preserve the Inline source verbatim: comments, logging, unused expressions, names, types, whitespace, line endings, and control flow.
- Change only the binding from Inline to File and the file location required by ScriptRunner.
- Do not rename variables, modernize APIs, fix warnings, normalize line endings, or combine scripts during this migration.
- Keep refactoring, bug fixes, and universalisation as separate changes with separate tests and rollback.

## Inventory before editing

Create a dated prod snapshot and inspect the matching ScriptRunner report. Count script slots, not only feature configurations. Check each of these independently where present:

- Behaviour field scripts;
- Behaviour Initialisers;
- workflow conditions, validators, and post-functions;
- fragments, jobs, listeners, REST endpoints, and Script Fields.

For every candidate record the feature ID, slot, field or transition, mapping, method, enabled state, current scriptPath, Inline source, and intended file path. A scriptPath=null value is not automatically an Inline Groovy slot: inspect the feature schema because Database Picker and other non-Groovy configuration components may use the same shape.

## Risk and stopping rules

Stop and record a skip instead of overwriting state when:

- another administrator owns an unpublished workflow draft;
- the workflow is inactive and the available adapter cannot safely create a draft;
- the feature contains a secret or token;
- the file path is ambiguous or already used by different logic;
- the candidate includes business behavior that would need a refactor to share a file.

Do not include tokens, credentials, snapshots, reports, or rollback packages in Git.

## Rollback package

Before each change, save the original Inline source and enough configuration to restore the binding: feature ID, slot, mapping, method, enabled state, original scriptPath, and timestamp. The rollback procedure must restore Inline, paste the exact source, remove the file binding, save, reload, and perform a live read-back.

## Apply and verify

1. Create the ScriptRoot file from the saved Inline source without edits.
2. Compare the source and file using SHA-256. If line endings are intentionally preserved, hash the exact byte representation.
3. Upload the file to the target ScriptRoot and switch only the selected slot from Inline to File.
4. Save through the supported Jira path.
5. Reload the configuration page and read back the actual scriptPath, method, mappings, and enabled state.
6. Download or read back the server ScriptRoot file and compare it with the source hash.
7. Run the appropriate local verification and a bounded simulation. A simulation does not prove workflow transitions, notifications, permissions, events, or side effects.
8. After a batch, take a new prod snapshot and recount remaining Inline slots. Never use a pre-change snapshot as the final count.

## Git handoff

Compare the active prod file bindings with a clean checkout of the target repository. Report missing files, hash differences, orphaned files, secrets excluded from Git, and unrelated changes separately. Inspect the target diff before committing. Push only after the user explicitly confirms the code result and the exact commit scope.

## Report

Separate the result into:

1. local checks;
2. simulation or dry-run;
3. live Jira read-back and runtime test status;
4. Git comparison, commit, and push status.

Use Confirmed only when the stated live effects were actually reread. Use Partially confirmed when binding and file integrity are verified but runtime behavior was not executed.
