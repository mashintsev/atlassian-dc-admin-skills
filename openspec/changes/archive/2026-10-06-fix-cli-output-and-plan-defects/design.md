# Design

## Context

See proposal.md. These are the current behaviours, checked in the code:
- **Compact write output:** `src/format.ts:191-210` (`writeResult`) prints the summary, request, body (capped by `MAX_BODY=500`), follow-ups, `warning` and `manual`. Every other dry-run field is dropped. For example `src/tools/jira/workflows.ts` returns `target`, `differences`, `affectedProjects`, `before`/`after` and `precheck`; `src/tools/jira/queues.ts` returns `before`/`after`; `src/tools/jira/scriptrunner.ts` returns `change`.
- **`apply` exit code:** `src/cli.ts:398` returns `EXIT.OK` only when every outcome is `done`, and `EXIT.GENERIC` otherwise. `EXIT.STALE=5` exists (`src/format.ts:257`) but is unused.
- **Argument parsing:** `src/cli.ts:99-106` JSON-parses every value, so a string parameter gets a number, boolean or null. Validation happens later in `src/runner.ts:41,80` (`z.object(inputShape).strict()`).
- **JSON arguments:** `src/tools/jira/sla.ts:132,369,397` and `src/tools/jira/projectMeta.ts:218` call `JSON.parse` inside `z.preprocess`, which throws outside Zod. `src/tools/jira/workflowSchemes.ts:51-58` already catches the parse error.
- **Audit `raw`:** `src/tools/platform/audit.ts:47` uses `z.boolean()`.
- **`confluence_add_space_category`:** `src/tools/confluence/spaceCategories.ts:113-135` returns a dry run without checking existing categories. Only the execution returns camelCase `alreadySatisfied`, and a read-back failure throws `ValidationError`.
- **`jira_add_issue_types_to_scheme`:** `src/tools/jira/schemes.ts:296-337` throws `ValidationError` when nothing is new, sends the whole `issueTypeIds` list with no `identity`/`state`, and does no read-back.

## Goals / Non-Goals

**Goals:** fix the defects named above, without changing tool names or arguments.

**Non-Goals:**
- Shortening other output (default columns, the response guard): that belongs to the context-reduction change.
- Already-satisfied and read-back for the remaining write tools: that belongs to the write-safety change.

## Decisions

### Compact dry-run rendering
`writeResult` keeps its current lines, then renders the remaining keys of the result in insertion order. It skips a fixed set: `dry_run`, `product`, `summary`, `request`, `followUps`, `identity`, `state`, `note`, `warning`, `manual`. `note` is the generic "Nothing changed…" text; a tool's own note gets a different key or is detected by comparing it with that generic text.
- **Rendering:** scalars as `key: value`; flat arrays as one comma-separated line; objects as an indented `key:` block using the existing `objectLines` helper.
- **Caps:** 300 chars per line and 20 list items, then "+N more (--format=json)". Total extra output is at most about 40 lines.
- **Alternative rejected:** a per-tool allowlist of fields to show. It is easy to forget, and the missing evidence is exactly the bug.

### `apply` exit code
After `applyPlan`, the code computes the outcomes and then picks the code:
- failed → `EXIT.GENERIC` (1);
- otherwise drifted → `EXIT.STALE` (5);
- otherwise `EXIT.OK`.

Unticked items are already recorded as declined and do not change the code. A full decline stays `EXIT.DECLINED` (12) through `printConfirmError`. `renderOutcomes` also prints the re-plan hint for drifted items. `SKILL.md` and `REFERENCE.md` list 5 for `apply`.

### Schema-driven conversion
`parseArgs` stops calling `JSON.parse` and keeps every value as the raw string, while still recognising a whole JSON object passed as the only argument. A new `coerceArgs(tool, raw)` in `src/runner.ts` runs before `safeParse`. For each key it looks at the parameter's Zod type, unwrapping optional, default, effects, preprocess and pipe:
- **string, enum and literal:** keep the text;
- **number:** `Number(text)` when it is finite, otherwise the text, so Zod reports the error;
- **boolean:** left to `boolArg`, or mapped through the same rule when the parameter uses a plain `z.boolean()`;
- **array, object, record and union:** `JSON.parse` when the text starts with `[` or `{`, otherwise the text, so `listArg` keeps splitting comma lists;
- **unknown or `any`:** the old behaviour (JSON when it parses, with the leading-zero rule kept).

Tool calls through the runner API with typed values, for example from tests, pass unchanged. `atlassian_audit_events raw` switches to `boolArg`.
- **Alternative rejected:** changing about 42 string parameters to `z.coerce.string()`. That fixes strings but not booleans, and every new tool would need the same care.

### JSON parameters
A shared `jsonArg(schema, example)` helper in `src/tools/util.ts` replaces the ad-hoc `z.preprocess(JSON.parse)`. It catches the parse error and adds a Zod issue: "invalid JSON: <message>; expected e.g. <example>". `runner.ts` already maps Zod errors to `ValidationError`, so the CLI exits 7 with the hint.

### `confluence_add_space_category`
The dry run reads the categories (bounded, as it does today when executing):
- **Category present:** returns `alreadySatisfied(summary, "space already has the category")`.
- **Incomplete read:** stays an error, as today.
- **Execution:** keeps the pre-check and returns the same `already_satisfied` shape. A read-back mismatch throws `VerificationError` with the read-back state.

### `jira_add_issue_types_to_scheme`
- **Nothing new:** when no type is new and the default matches (or none was given), it returns `alreadySatisfied`.
- **Dry run:** carries `identity: {op, scheme, issueTypeIds: requested, default}` and `state: {present: <requested ids already present>, default: <current default when changed>}`.
- **On apply:** the request is rebuilt from the current scheme, so an earlier item's additions are kept. The digest still compares only `identity` and `state`.
- **After the PUT:** it reads the scheme back and throws `VerificationError` if a requested type or the requested default is missing.
- **Where it belongs:** this behaviour is specified under `change-plan-execution`, because the requirement is about plan safety. There is no issue-type-scheme capability yet.

## Risks / Trade-offs

- **Schema introspection depends on Zod internals.** Mitigation: unwrap through a helper with tests per wrapper kind, and fall back to the old behaviour.
- **A list may also accept a JSON object through a union.** Mitigation: unions JSON-parse only `[`/`{` text, so comma lists stay strings.
- **Longer compact dry runs.** Mitigation: caps per line, per list and overall.
- **Exit-code change for `apply`.** Mitigation: it is documented, and 0 now means success as the plan summary already says.

## Migration Plan

Internal only; release with the next build. Rollback: revert the change.
