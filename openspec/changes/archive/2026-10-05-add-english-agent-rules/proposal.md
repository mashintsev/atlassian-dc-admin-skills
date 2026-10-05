# Proposal

## Why

The repository has English source comments and skill instructions but no root-level agent instructions defining their language. Add an explicit English requirement so future agent contributions remain consistent.

## What Changes

- Add a root `AGENTS.md` with the following language rules:
  - Write all code comments, including inline comments, block comments, JSDoc, and TODO notes, in English.
  - Write all agent rules and instructions in English, including `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, and OpenSpec workflow guidance.
- Add a root `CLAUDE.md` containing `@AGENTS.md` so Claude Code loads the same instructions.
- Apply the rule to repository code comments and agent instructions. Conversation language and Jira or Confluence content are outside this change.

## Capabilities

### New Capabilities

None. This is a documentation-only change, marked with `skip_specs: true`.

### Modified Capabilities

None.

## Impact

The implementation adds only the root `AGENTS.md` and `CLAUDE.md`. Existing skill files already use English and require no edits. Runtime code, REST requests, dependencies, generated files, and tests are unchanged.

`design.md` is deliberately omitted: this change has no architectural decisions, dependencies, data model changes, migration, or unresolved technical ambiguity.
