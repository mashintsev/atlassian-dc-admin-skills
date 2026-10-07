# Proposal

## Why

Every session pays for the skill's frontmatter description, and every trigger pays for SKILL.md. The agent also often opens REFERENCE.md, whose generated tool tables (about 18k of its ~23k tokens) repeat what `list` and `describe` print.

Discovery is name-only: `list <text>` cannot find a tool by concept, which pushes the agent to `list jira` (~1.5k tokens) or `list --long` (~11k). Outputs may reach 60,000 characters (~15k tokens) before the response guard fires. Wide list tools print every column.

This change cuts that cost without losing guidance the agent needs.

## What Changes

- **SKILL.md description:** shortened from ~1,330 characters to ≤ 500 (domains plus the TRIGGER list). This keeps it well under the Agent Skills 1,024-character limit, which it currently exceeds.
- **SKILL.md body:**
  - the Codex section and the exit-code table move to REFERENCE.md, and SKILL.md keeps the exit 12/13 instructions;
  - rules duplicated in ASSETS.md and REFERENCE.md are kept once and referenced elsewhere;
  - the write-confirmation rules stay unchanged.
- **REFERENCE.md:**
  - the generated per-tool tables are replaced by a compact index of tool names per group (`scripts/gen-reference.ts`);
  - argument notes that repeat tool descriptions are removed;
  - the CLI block that repeats SKILL.md is removed;
  - one sentence separates workflow drafts (publishable through REST) from workflow scheme drafts (published in the UI).
- **`list <text>`:** matches names and descriptions, case-insensitively; with several words, all must match. Each match prints with a short first clause of its description. `list jira|confluence|both` and `--writes`/`--reads` are unchanged.
- **Output budget:**
  - the default `ATLASSIAN_MAX_RESPONSE_CHARS` drops from 60,000 to 25,000 and stays overridable;
  - wide list tools declare default columns, `--fields=+a` adds columns to them (today a no-op), and `--fields=all` shows every column;
  - compact dry runs print at most 5 follow-up lines plus "+N more".
  - Printing the extra fields of dry runs (before/after, differences, target) belongs to the separate change `fix-cli-output-and-plan-defects`; this change only caps the follow-up lines.

## Capabilities

### New Capabilities
- `agent-context-budget`: size limits for the always-loaded skill text and the reference document, discovery search by description, and output budgets (response guard, default columns, capped follow-ups).

### Modified Capabilities
None.

## Impact

- **Docs:** `atlassian-dc-admin/SKILL.md`, `REFERENCE.md` (generated plus hand-written parts), `ASSETS.md`, `SPACE_WORKFLOWS.md`.
- **Code:**
  - `scripts/gen-reference.ts`;
  - `src/cli.ts` (`list`);
  - `src/format.ts` (field projection, follow-up cap), `src/json.ts` (guard default);
  - a `defaultFields` property on `ToolDef` (`src/tools/types.ts`), used by a few wide list tools.
- **Tests:** `list` search, field projection, the guard default, and size checks for SKILL.md and REFERENCE.md.
- **Behavior:** large outputs hit `ResponseTooLarge` sooner; its hint (narrow, `--fields`, `--out`) is unchanged. No tool is renamed or removed.
