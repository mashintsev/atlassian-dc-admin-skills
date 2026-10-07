# Design

## Context

See proposal.md for the audit results.

**Rendering (`src/format.ts`):**
- `render()` prunes noise (self, avatar URLs, `_links`, `_expandable`, profile pictures, empty values) and then renders compact text.
- `inline(v, max)` cuts only scalar values. Arrays and objects in a cell are joined in full, and the recursive calls drop `max` on purpose, so that `map`'s index never becomes `max`.
- `objectLines()` prints multi-line strings in full, each line indented by two spaces.
- A page result (`{items, …}`) prints only scalar header fields, so non-scalar summary fields of a page (for example `jira_get_screen_usage`'s `screen`) are lost in compact output.

**Guard (`src/cli.ts:160`):** `output()` renders, then the guard (`src/json.ts`) rejects text over `ATLASSIAN_MAX_RESPONSE_CHARS` with a generic hint.

**Tool shaping:**
- Issues: `compactIssue()` (`src/tools/jira/shape.ts`) keeps unknown fields raw under `fields`.
- Confluence storage → Markdown: `src/markup.ts` (turndown).
  - The table rule uses `querySelectorAll("tr")`.
  - Attachment images become absolute download URLs. The write path (`markdownToStorage`) turns only a bare filename back into `ri:attachment`, so today an image does not survive a read-edit-write round trip.
- Page sections: `replaceSection()` (`pages.ts:170`) finds a heading in storage with an exact match, for writes.

**Measurement harness:** the audit's harness (realistic payloads, a route table, cl100k counts) lives outside the repository. It is the starting point for the benchmark capability.

## Goals / Non-Goals

**Goals:**
- No default read call on a large instance hits `ResponseTooLarge`.
- Every long value has a visible cut marker and a way to read more.
- Compact and JSON output size is measured and guarded by a test; default benchmark reads fit the response guard in both formats.

**Non-Goals:**
- Changing what JSON shows for list items: JSON stays exact, apart from tool arguments that bound bodies.
- Pagination of single bodies by offset (`section` and `outline` cover navigation).
- Reducing request counts (N+1 scans); they cost time, not tokens. A separate change can address them.
- Changing write tools beyond rejecting Markdown containing the read code-cut marker.

## Decisions

### 1. Caps in the renderer, not in every tool
`inline()` gets a budget that applies to the joined text of arrays and objects:
- children are rendered until the budget is used up;
- arrays end with `+N more`;
- other cuts end with `…(+N)`.

`objectLines()` cuts a long string at `MAX_TEXT` (default 8,000 characters, set by `ATLASSIAN_MAX_TEXT_CHARS`), at a line boundary, and prints multi-line text without indentation, after a `key:` line.

This fixes most of the audit findings at once:
- `fields` cells, changelog and audit `changes`;
- Assets attributes, SLA goals and epic groups.

Tool-specific bounds remain where the full value matters semantically, or where JSON also needs a bound (page bodies, descriptions).

- **Alternative:** caps in each tool. Rejected as the primary fix: there are dozens of sites, and new tools would regress.

### 2. Marker and guard name the tool's narrowing arguments
`ToolDef` gets an optional `narrowing: string[]` field, for example `["section", "outline", "max_chars"]` for `confluence_get_page`. `render()` receives the tool.
- **Cut marker:** `…(+N chars; narrow with section|outline|max_chars or --format=json)`.
- **`ResponseTooLarge`:** the guard measures the rendered size of each top-level field (for page results, each column) and names the three largest. The hint lists `narrowing`.

The guard still sends no partial content. That keeps the existing contract that an over-limit answer is an error, not silently truncated data.
- **Alternative rejected:** returning the first 25,000 characters. An agent could take a cut list for the whole answer.

### 3. Default columns: compact only (spec alignment)
The recent review fix already makes `--format=json` ignore default columns, which matches SKILL.md ("`--format=json` for decisions on exact values"). The `agent-context-budget` delta changes the requirement to match. No code change is needed beyond the existing tests.

### 4. Page outline, section and max_chars
Add `splitSections(storage)`: headings `h1`–`h6` with level, text, start and end offsets. It reuses `replaceSection`'s heading regex and text extraction, which then calls it; writes keep exact matching.
- **`outline=true`:** a list of `{level, heading, chars}`, where `chars` is the Markdown size of the section.
- **`section`:** case-insensitive match on the heading text. Zero or several matches fail and list the candidates. The slice of storage is then converted, or returned raw with `body_format=storage`.
- **`max_chars`:** applied to the output body after conversion. The cut is placed at the last blank line, or for storage at the last closing block tag, at or before the limit. The result gets `truncated: {shown, total}` and a hint.

The default of 20,000 keeps a page with metadata below the 25,000-character guard.

### 5. Issues
- **`max_description_chars`:** default 8,000, cut at a line boundary, and applied before rendering, so JSON is bounded too.
- **Changelog:** an item whose `fromString` or `toString` is over 120 characters or multi-line becomes `{field, from: "<n chars>", to: "<n chars>", preview: first 120 chars of to}`. A length/preview rule is used because DC changelog items carry no reliable type.
- **`fields=*all` in lists:** refused with a ValidationError. Flattening every field of 20–100 issues still costs hundreds of tokens per row. `jira_get_issue fields=*all` stays allowed, but `comment`, `worklog`, `watches`, `votes`, `progress` and `aggregateprogress` are removed from its extras, because they duplicate `comments=N` or carry no information.
- **Extra fields:** `flattenFieldValue(v)` reduces a field value to something readable:
  - an option → its value;
  - a user → its name;
  - an object with `name`, `key` or `value` → that;
  - an SLA (`ongoingCycle`/`completedCycles`) → `remaining`/`breached`;
  - an array → the mapped values.

  Each extra field becomes its own row column instead of one `fields` cell.

### 6. Uniform full-list argument
Every tool that truncates a membership or sharing list (to 10 entries plus a count) accepts `full_lists=true`.
- **Alternative rejected:** one argument name per tool. Agents learn one name once.
- `jira_get_custom_field_options` is the exception. Option lists are data, not membership, so it gets real paging (`context` plus `limit`/`offset`, default 100, maximum 1,000).

### 7. Allowlists for raw passthroughs
Each raw passthrough gets a small `view()` that picks documented fields, following the style of `scriptrunner.ts`. Unknown fields are dropped. `--format=full` is the existing escape hatch for debugging.

### 8. Confluence Markdown
- **Table rows:** the table rule collects only direct rows (`:scope > tr`, `:scope > thead > tr`, `:scope > tbody > tr`, `:scope > tfoot > tr`). If the DOM implementation lacks `:scope`, it walks the children.
- **Attachment images:** rendered as a bare filename, which also fixes the round trip.
- **Same-instance links:** the base-URL prefix is removed.
- **Comments:** expanded with `body.storage` instead of `body.view`, and converted with the page rules.
- **Body-less macros** that carry meaning (status, include, toc, children, jira) become short markers.
- **Code macros** are cut at 200 lines in reads.

### 9. Benchmark
- **Files:**
  - `test/bench/payloads.ts`: generators and the fake server that honors `fields`, `maxResults`/`limit` and `expand`;
  - `test/bench/cases.ts`: cases and budgets;
  - `scripts/read-bench.ts` (`pnpm bench:reads`): the report;
  - `test/unit/readBudgets.test.ts`: the regression test.
- **Baseline:** the current numbers are recorded as a baseline before the optimizations, so the change can show its savings.
- **Budgets:** separate compact and JSON token budgets, set to measured values after implementation plus 10 % headroom; both formats must fit the response guard.
- **Tokenizer:** cl100k_base via the existing `js-tiktoken` dev dependency.

## Risks / Trade-offs

- **[Compact output now hides data an agent may need]** → Every cut is marked with the amount left out and how to read it: the narrowing argument, `full_lists`, `--fields` or `--format=json`. Nothing is dropped silently.
- **[Breaking changes for agents with learned habits]** (`fields=*all` refused, agile defaults lower) → The ValidationError text names the alternative. The SKILL.md and REFERENCE.md argument notes are updated.
- **[`section` matching can miss headings with macros or links inside]** → Heading text is extracted the same way as for writes. On no match, the available headings are listed.
- **[Budget test flakiness from generator changes]** → Generators are deterministic, with no random data, and budgets live in one reviewed file.
- **[The table rule's `:scope` support in the DOM library]** → Children are walked as a fallback, and the test covers a nested table.

## Migration Plan

Changes are additive or tightening and ship in one release. Order:
1. benchmark and baseline;
2. renderer caps and guard;
3. tool bounds;
4. Markdown fixes;
5. docs.

Rollback is by reverting. No data or config migration is needed. `ATLASSIAN_MAX_TEXT_CHARS` is new and optional.

## Open Questions

- Exact default limits (8,000 and 20,000 characters, 10 entries, 120-character values) may be tuned once the benchmark runs on the implementation. They do not change the approach or the tasks.

## Approved scope extension

Default Assets search uses 20 objects per page so its 20-attribute previews fit the JSON response guard. Explicit limits and named attributes remain available. Markdown page creation, updates and section updates reject the read code-cut marker before conversion or requests; storage input remains available for complete code. This prevents accidentally publishing truncated code.
