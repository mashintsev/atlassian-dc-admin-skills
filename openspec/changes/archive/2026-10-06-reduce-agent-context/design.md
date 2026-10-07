# Design

## Context

Measured on the current tree (tokens ≈ characters / 4):

| Text | Characters | ≈Tokens | Loaded |
|---|---|---|---|
| SKILL.md frontmatter description (line 3) | 1,345 | 335 | every session |
| SKILL.md body | ~6,500 | ~1,600 | on trigger |
| REFERENCE.md | 91,889 | ~23,000 | on demand |
| — generated tool tables | ~72,400 | ~18,000 | |
| — argument notes | ~10,100 | ~2,500 | |
| `list` (all tools) | ~7,700 | ~1,900 | per call |
| `list jira` | ~6,100 | ~1,500 | per call |
| `list --long` | ~45,000 | ~11,000 | per call |

Relevant code:
- `src/cli.ts:175-187`: `list` takes only the first non-flag word and matches it against tool names.
- `src/format.ts:91-112`: `projectFields`; `+a` is ignored.
- `src/format.ts:199-202`: every follow-up is printed.
- `src/json.ts:10`: the 60,000-character guard.
- `scripts/gen-reference.ts:33-37`: one table row per tool, with arguments and description.
- `scripts/token-bench.ts` exists, with cl100k counts against MCP fixtures.

## Goals / Non-Goals

**Goals:**
- Cut always-loaded and commonly read text by at least half, without dropping rules the agent must follow.
- Make tool discovery work by concept.
- Make large outputs fail early towards `--out`/`--fields`.

**Non-Goals:**
- Renaming tools or arguments (owned by a separate change on argument conventions).
- Printing the extra fields of dry runs (owned by `fix-cli-output-and-plan-defects`).
- Changing JSON output shapes beyond the default columns.

## Decisions

### Description at most 500 characters
The Agent Skills specification limits `description` to 1,024 characters; the current one (~1,330) is over that, so tooling may cut it. The new text names the products and areas and keeps the TRIGGER list. The detailed feature list is covered by `list` and is dropped.

### SKILL.md body
- **Moves to REFERENCE.md:** "Codex" (sandbox and network notes) and the exit-code table. SKILL.md keeps one line ("Errors print `ERROR <type>` and a hint; exit 12 = declined, 13 = cannot ask: see Writes") and a pointer to REFERENCE.md.
- **The UI check plan rule** stays in SKILL.md only; ASSETS.md and SPACE_WORKFLOWS.md reference it.
- **The ScriptRunner local-content rule** stays in SKILL.md; the REFERENCE.md note links to it rather than repeating it.
- A unit test asserts the body limit and the presence of key phrases: `dry_run=false`, `apply`, exit 12/13, "UI check plan".

### REFERENCE.md index
`gen-reference.ts` writes `### <group>` followed by one line of comma-separated tool names, write tools marked ✎, plus the instruction to use `describe <tool>`. The estimated size of the index is 7–8k characters for 282 tools. The hand-written sections stay.
- **Argument notes:** a pass removes sentences that restate a tool's description (for example permission holders, the workflow paragraph and the CLI block).
- **Drafts:** one sentence separates the two kinds.
- **Tests:** a unit test checks that every registered tool appears exactly once in the index and that the file is at most 40,000 characters.
- **Alternative rejected:** dropping the index entirely. It is cheap and lets an agent that has opened REFERENCE.md find names without another command.

### `list <text>`
All non-flag words form the query. Each word must appear in the tool's name, with `_` read as a space, or in its description, case-insensitively.
- **Product words:** a single word equal to a product keeps the product filter.
- **Output per match:** `name ✎ | first clause`. The first clause is the description up to the first ". " or ": ", cut at 100 characters.
- **No match:** the output gives the hint.
- **Alternative rejected:** fuzzy or ranked search. It adds code, and tool counts are small enough for a substring match.

### Response guard 25,000
Normal pages (`limit` ≤ 50 rows of a few columns) stay below 25,000 characters; issue and page bodies already have their own truncation. Large lists already advise `--out`. `ATLASSIAN_MAX_RESPONSE_CHARS` still overrides the default. The guard's tests and the README/REFERENCE configuration table change accordingly.

### Default columns
`ToolDef.defaultFields?: string[]`. When a tool declares it and no `--fields` is given, rows and single objects are projected to those fields.
- `--fields=+x` means the defaults (or all fields when there are none) plus x.
- `--fields=all` means no projection.
- `--fields=a,b` keeps its exact meaning.
- **Candidates:** `jira_list_custom_fields`, `jira_list_fields`, `jira_list_workflow_schemes`, `jira_list_screens`, `confluence_list_spaces` and `assets_search_objects`. The final set is chosen in task 3.2 by measuring compact output on fixtures with `scripts/token-bench.ts`; tools without wide rows keep printing all columns.

### Follow-up cap
At most 5 `then:` lines in a compact dry run, then `+N more (--format=json shows all)`. Approval dialogs and plans are unaffected, because they show the full request list through their own rendering.

## Risks / Trade-offs

- **[A trimmed SKILL.md loses a rule the agent needed]** → key-phrase tests, and a manual read-through of the old and new text in task 1.3.
- **[25,000 is too tight for some reads]** → the environment variable override, the hint to use `--out`, and measuring the existing fixtures with the bench before choosing the value; if fixtures show normal reads above it, raise it to at most 30,000 in task 3.1.
- **[Default columns hide a field the agent needs]** → `--fields=+x`/`all`, and `describe` names the default columns.
- **[Description search returns too many matches for common words]** → all words must match, and the output is one short line per match.

## Migration Plan

Docs and output changes only; no stored data. Rollback: revert the commit and rebuild (REFERENCE.md is regenerated by `pnpm build`).

## Measured sizes (chars, ≈tokens = chars/4)

| Item | Before | After |
|---|---|---|
| SKILL.md description | 1,327 (≈332) | 498 (≈124) |
| SKILL.md body | 6,637 (≈1,659) | 5,993 (≈1498) |

Task 1.3 read-through: every line removed from SKILL.md is now in REFERENCE.md or rephrased in SKILL.md:
- the Codex notes, plus the Codex parts of the confirmation question and the timeout;
- the full exit-code table;
- the configuration pointer.

The detailed feature list in the description was dropped on purpose; `list` covers it.

Task 3.3 measurements (compact output; tools without wide columns keep printing all columns):
- **`jira_list_custom_fields`:** 50 synthetic rows go from 6,571 characters to 3,614 with default columns. Those columns leave out `type`, a long plugin key; `--fields=+type` brings it back.
- **`jira_list_screens`:** the fixture has no descriptions, so there is no gain and no defaults; descriptions help choose a screen.
- **`jira_list_fields`, `jira_list_workflow_schemes` and `confluence_list_spaces`:** already 4–6 short columns, so no defaults.
- **Assets search:** it has its own `attributes` selector, so no defaults.

## Final measurements (task 4.1, chars; ≈tokens = chars/4)

| Item | Before | After |
|---|---|---|
| SKILL.md description (every session) | 1,327 (≈332) | 498 (≈124) |
| SKILL.md body (on trigger) | 6,637 (≈1,659) | 5,993 (≈1498) |
| REFERENCE.md (on demand) | 91,236 (≈22,809) | 28,296 (≈7074) |
| `list` | 7,705 | 7,407 |
| `list jira` | 6,067 | 5,821 |
| `list detail view` | 168 (1 name-only match) | 458 (4 matches with clauses) |
| Response guard default | 60,000 | 25,000 |
