# Tasks

## 1. Skill documents

- [x] 1.1 Rewrite the SKILL.md frontmatter description to at most 500 characters (products, areas, TRIGGER terms); add a unit test that parses the frontmatter and asserts the length and the product names. Verify the test fails before the edit and passes after.
- [x] 1.2 Move the Codex section and the exit-code table from SKILL.md into REFERENCE.md, keep the exit 12/13 line in SKILL.md, keep the UI check plan and ScriptRunner rules only in SKILL.md and reference them from ASSETS.md, SPACE_WORKFLOWS.md and REFERENCE.md. Add a test that asserts a body of at most 6,000 characters and the key phrases (`dry_run=false`, `apply`, `12`, `13`, `UI check plan`). Verify with the test.
- [x] 1.3 Read the old and new SKILL.md side by side and confirm no rule was lost. Record the measured sizes (characters and ≈tokens) before and after in design.md.

## 2. Reference document

- [x] 2.1 Change `scripts/gen-reference.ts` to emit a per-group index (tool names, ✎ for writes) with a pointer to `describe <tool>`. Add a test that every registered tool appears exactly once in the generated index. Verify with `pnpm run docs` and the test.
- [x] 2.2 Remove argument notes that repeat tool descriptions, remove the CLI block that repeats SKILL.md, and add the sentence separating workflow drafts from workflow scheme drafts. Add a test asserting REFERENCE.md is at most 40,000 characters. Verify with the test and record the size before and after.

## 3. Discovery and output

- [x] 3.1 Measure the existing fixtures with `scripts/token-bench.ts` and the guard. Then set the default `ATLASSIAN_MAX_RESPONSE_CHARS` to 25,000 (or at most 30,000 if fixtures of normal reads exceed it, with the reason recorded) and update its tests and the configuration docs. Verify with `pnpm test`.
- [x] 3.2 Implement `list <text>` search over names and descriptions (all words, case-insensitive), with a short first clause per match and a hint on no match. Test it first with `detail view`, `sla calendar`, a product word and no match. Verify with the tests.
- [x] 3.3 Add `ToolDef.defaultFields`, `--fields=+x` and `--fields=all` to the projection and to `describe`. Test that rows and single objects follow each mode. Set default columns for the wide list tools chosen by measuring compact output before and after on fixtures. Verify with the tests and the recorded sizes.
- [x] 3.4 Cap compact dry-run follow-ups at 5 lines plus "+N more". Test with 12 follow-ups. Verify with the test.

## 4. Integration

- [x] 4.1 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`. Re-measure SKILL.md (description and body), REFERENCE.md, `list`, `list jira` and one `list <text>` query, and record the before/after table in design.md. Verify that the description is ≤ 500 characters and REFERENCE.md ≤ 40,000.
