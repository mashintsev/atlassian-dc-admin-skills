---
name: jira-change-verification
description: Verify changes to Jira, JSM, ScriptRunner, workflows, Automation, Assets, screens, permissions, and eazyBI before and after applying them. Use this skill whenever the user asks to check, test, simulate, roll out, or confirm a configuration change in a Jira Data Center instance, even when the change looks small. The skill separates read-only simulation from a real Jira test and requires evidence for transitions, fields, permissions, notifications, linked issues, and Assets.
compatibility: Requires the project instructions, jira-config, atlassian-dc-admin, and access to the target Jira Data Center instance. Choose test data and test issues separately for each scenario.
---

# Jira change verification

Verify the observable result in live Jira, not only the code or plan: what the user can do, which transition succeeds, which fields change, which objects are created, and which notifications are delivered. A read-only simulation exercises logic but does not prove workflow, permissions, events, notifications, or side effects.

## 1. Define the verification boundary

Before the change, record:

- instance and environment;
- project, issue type/request type, and exact configuration point;
- the expected business rule in one sentence;
- fields, statuses, transitions, Assets, linked issues, emails, and notifications that may change;
- what must not be touched: working issues, user permissions, production data, and external notifications without separate approval.

For workflows, screens, fields, behaviours, listeners, Automation, and ScriptRunner, inspect local `jira-config` first. Confirm current IDs, Assets values, groups, roles, and users in live Jira. A snapshot is a cache, not proof of the current state.

## 2. Build the scenario matrix before running anything

Prepare at least these three rows for every change:

| Scenario | Input | Expected result | Read back |
|---|---|---|---|
| Success | normal data and an allowed user | action succeeds and required fields/objects are created | issue, transition, fields, linked objects |
| Boundary | empty, minimum, maximum, or boundary value | explicitly allowed or blocked by the rule | validation/error and final state |
| Failure | invalid value or user without permission | action is blocked without an unwanted partial side effect | message, audit, absence of extra changes |

Add focused checks when the change affects:

- permissions: an allowed and a denied user;
- notifications: recipient, event type, and duplicate delivery;
- Assets: object key, object type, attributes, and issue relation;
- post-functions/listeners/jobs: rerun after a partial failure;
- linked issue creation: count, type, parent, fields, and assignee;
- portal behaviour: field visibility, requiredness, value format, and request type.

## 3. Select the verification level

Use the levels in order. Never claim a higher level without its evidence.

### Level A — local checks

Inspect the diff, imports, helpers, refs, conflict markers, whitespace, script standards, and `tools/verify-change.ps1`. Inspect workflow XML when applicable. This validates files, not Jira runtime behaviour.

### Level B — read-only simulation or dry-run

Show inputs and expected results for success, boundary, and failure cases. If a dry-run exists, retain its request body and result. State explicitly that simulation did not test transitions, listeners, events, permissions, notifications, or side effects.

### Level C — real Jira verification

Run this level only when the user explicitly requests a live Jira check or explicitly authorizes the required external action. A change being production-relevant is not permission to create a test issue or execute a transition.

When live verification is authorized:

1. Select a test issue or create a separate test issue after checking side effects.
2. Save a full before-snapshot: key, issue/request type, status, resolution, all fields in scope, participants, watchers, links, attachments, Assets and their relevant attributes, comments, assignee, reporter, security level, workflow context, and notification-relevant state.
3. Perform exactly the required transition or action.
4. Read the issue and every expected effect back.
5. Record the actual test identity and permission context; do not use an administrator if the scenario is meant to test an ordinary user.
6. Run a negative case with a separate user/input when the change concerns permissions or conditions.
7. Do not delete or close the test issue unless the user asks.

If live verification cannot be run, record why, which effects remain unverified, and the exact action or test data needed to finish it. Use `Partially confirmed` only with that information.

### Level D — production confirmation

For every external mutation use this protocol: read current state → prepare a dry-run/plan → show the exact change list → obtain the user's Apply/Cancel confirmation → apply → reread live state. Do not publish workflows, change permissions, update Assets, mass-edit legacy issues, or delete/archive data by treating the existence of a plan as permission.

Before any destructive or difficult-to-reverse operation, save an export or full snapshot that can restore the affected state. If no backup/export is possible, state that limitation and obtain separate confirmation for the irreversible action. After applying the change, compare the running script/configuration with the local file, reread live Jira, and run the real business scenario. If the live scenario was not run, say so explicitly and do not call the change confirmed.

## 4. Checks by change type

### Workflows, validators, and post-functions

- check transition availability from each stated source status;
- run a successful transition and reread status, fields, comments, participants, and linked issues;
- test the validator with boundary and invalid input;
- check post-function order, events, and reruns;
- check for duplicate issues, comments, and emails;
- for XML changes, export before editing, import a draft, reread the draft, publish, and reread live;
- use the external-mutation protocol and preserve the pre-change export; do not delete the old workflow/XML until the applied version and rollback path are verified.

### ScriptRunner jobs, listeners, and behaviours

- record the exact trigger and the guard against repeated execution;
- compare the issue before and after the event;
- use a bounded issue set for jobs and handle element-level errors;
- test partial failure and rerun behaviour;
- do not treat a log line as proof of a Jira mutation; reread the Jira object.

### Assets and JSM portals

- obtain the live request form and allowed values;
- verify object type, key, and field format, not only the displayed label;
- check field requiredness, visibility, and editability;
- reread the issue and the Assets object after saving, including untouched attributes;
- never move Assets IDs between separate Jira instances.

### Permissions and security

- run a positive case with an allowed user;
- run a negative case with a denied user;
- reread project roles, permission scheme, issue security, and effective access;
- check existing issues separately when the change affects legacy data;
- record the test user's identity and effective role; an admin result is not evidence of ordinary-user access.

### eazyBI and reports

- save the export definition before editing;
- change one measurable thing at a time;
- verify numbers, statuses, empty combinations, and row order visually;
- restore the last confirmed definition after an error and reread the result;
- do not treat valid JSON as proof that eazyBI renders correctly.

## 5. Lessons from solved project-script cases

Use these cases as verification templates:

- **AM-21011 / exit date:** the validator simulation blocked empty, today, and tomorrow and allowed `today + 2`, but a successful portal creation was not proven. Date rules need both a blocking test and a real successful creation.
- **JC-506 / approvals and issue security:** after a rule change, test the new route and existing legacy requests separately. New configuration does not migrate legacy state automatically.
- **MP-2156 / Move:** the operation cleared fields, so a full snapshot was needed before Move and a post-operation comparison was needed to restore only confirmed values.
- **JC-497 / eazyBI:** a definition change removed numbers or merged statuses. The safe pattern is export-before, visual comparison, and a reversible rollback.
- **SR-4621 / approval flow:** removing a step from a new route did not repair already-created issues. Define the legacy-request strategy separately.
- **AM Revocation / XML workflow:** importing a corrected draft did not prove the runtime post-function. Run the actual transition or record the runtime check as unverified.
- **JSM request form:** the displayed service field was an Assets field and the local snapshot differed from the live catalog. Check the live form, Assets object type/key, API format, and readback before creating requests.

## 6. Verification report format

Always separate the result into four blocks:

1. **Local checks:** files and configuration inspected.
2. **Simulation/dry-run:** inputs, expected results, and actual results.
3. **Live Jira verification:** test issue, users, permission context, steps, transitions, and final fields/effects; or the reason and remaining gaps when live testing was not possible.
4. **Git check:** target repository, diff, commit, and confirmation that snapshots/secrets/unrelated files are absent; write `Not applicable` for a read-only audit with no local changes.

Use one of these statuses:

- `Confirmed` — the real scenario ran and all stated effects were reread;
- `Partially confirmed` — local checks and simulation passed, but one or more runtime effects were not verified;
- `Not confirmed` — an error, mismatch, or required evidence is missing.

Never turn “dry-run passed” into “the change works.” Those are different claims.
