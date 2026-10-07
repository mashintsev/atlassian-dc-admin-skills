# Proposal

## Why

The same concept is spelled differently across the 282 tools: `field` vs `field_id`, `user` vs `username`, `project` vs `project_key`, `issue_type` vs `issue_type_id`, `service_desk` vs `service_desk_id`, `id` vs `key`. Some tools take only ids where their neighbours also take names. Agents guess wrong names and spend calls on `describe`.

About 100 of the 148 write tools re-send their request even when the change is already in effect, and do not read the result back:
- users and groups;
- workflow schemes;
- projects;
- permission grants;
- Confluence spaces, pages and permissions;
- Assets.

These tools cannot be planned and re-applied safely. Plans also cannot chain a created issue type or workflow scheme into the next item.

Error output has hints only for 401/403/404/409. Unknown tool or argument names give no suggestion. 61 tools are not referenced by any unit test.

## What Changes

- **Canonical argument names:**
  - one canonical name per concept, with the old names still accepted as aliases (non-breaking);
  - an error when an alias and its canonical name are both given with different values;
  - id-or-exact-name resolution for fields and issue types in the tools that take ids only today;
  - `describe` shows the canonical name and its aliases.
- **Write safety for the remaining admin write tools**, module by module:
  - already-satisfied where the target state can be read;
  - read-back verification where a read exists;
  - `identity`/`state` for plan drift where the request carries a whole list;
  - descriptions that say so for the tools that cannot be checked.
- **Chained plan references:** a plan item can name an issue type or a workflow scheme created by an earlier item, the same way it can already name a custom field.
- **Error usability:**
  - hints for HTTP 400, 429 and 5xx, and the re-plan command for drifted items;
  - "did you mean" suggestions for unknown tool names and unknown arguments.
- **Tests:** a unit test for every tool that has none, with at least the dry-run request shape for each write tool and a happy-path read for each read tool.

## Capabilities

### New Capabilities
- `tool-argument-conventions`: canonical argument names, aliases, id-or-name resolution and suggestions for unknown names.
- `write-safety-coverage`: already-satisfied, read-back verification and drift identity for the admin write tools that lack them, and how unverifiable writes are marked.

### Modified Capabilities
- `change-plan-execution`: "References to objects created earlier in the plan" is extended from custom fields to issue types and workflow schemes.

## Impact

- **CLI and runner:**
  - `src/runner.ts`: alias resolution before validation, hints, suggestions;
  - `src/cli.ts`: unknown arguments;
  - `src/tools/types.ts`: optional `aliases` on a tool;
  - `src/plan.ts` / `src/format.ts`: drift hint.
- **Tool modules:**
  - `src/tools/jira/{users,projects,schemes,workflowSchemes,fields,issues,projectMeta,servicedesk,system,collab,customFields,screens,fieldConfigurations}.ts`
  - `src/tools/confluence/{users,spaces,pages,labels}.ts`
  - `src/tools/assets/{structure,objects}.ts`
- **Name references:** a new shared resolver for issue types, and the existing field resolver.
- **Tests:** many new unit tests under `test/unit/`.
- **Docs:** `atlassian-dc-admin/REFERENCE.md` (argument notes, regenerated tool list) and `SKILL.md` (one line on aliases).
- **Overlap with the other changes:** the issue type scheme drift fix, the space category `already_satisfied` key and number-like string arguments belong to the separate change for CLI output and plan defects. This change builds on them and does not repeat them.
- **Compatibility:** no breaking changes; every current argument name keeps working.
