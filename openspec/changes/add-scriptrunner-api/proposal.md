# Proposal

## Why

Jira Data Center administrators cannot manage ScriptRunner configuration through this skill's existing Jira REST tools. Adding a ScriptRunner integration will make its administrative resources discoverable and manageable from the same CLI while preserving the project's guarded-write and explicit-confirmation model.

## What Changes

- Add Jira Data Center ScriptRunner tools for the script registry, jobs, listeners, fields, Behaviours, UI Fragments, REST Endpoints, Resources, and Mail Handler.
- Support read and management operations only where the installed ScriptRunner version exposes a verified API; do not guess undocumented endpoints or silently report unsupported operations as successful.
- Route configuration mutations through the existing dry-run and confirmation safeguards. Do not execute arbitrary Groovy scripts or trigger jobs as part of this management API.
- Document supported version and operation coverage, add regression tests, and update the skill's generated reference and dispatcher as needed.

## Capabilities

### New Capabilities

- `jira-scriptrunner-script-management`: Manage the ScriptRunner script registry, REST Endpoints, and Resources.
- `jira-scriptrunner-automation-management`: Manage ScriptRunner jobs, listeners, and Mail Handler configuration.
- `jira-scriptrunner-ui-management`: Manage ScriptRunner fields, Behaviours, and UI Fragments.

### Modified Capabilities

None. The repository currently has no main capability specifications.

## Impact

Expected areas include new Jira ScriptRunner tool modules and registration in `src/tools/index.ts`, tests under `test/unit/`, and `atlassian-dc-admin/SKILL.md` plus generated `REFERENCE.md`. The ScriptRunner REST contract and supported plugin versions must be verified before implementation; no new dependency is expected.
