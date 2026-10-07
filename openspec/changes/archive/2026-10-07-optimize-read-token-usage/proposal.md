# Proposal

## Why

We audited all 138 read tools in two ways:
- **Measurement:** realistic Data Center payloads (800 projects, 900 custom fields, issues with 60 custom fields and 30 comments, storage pages with macros and tables, 400 apps, audit events) were run through the real tools and counted with cl100k_base.
- **Static review:** a review per area (Jira admin, Jira content, JSM/ScriptRunner/Assets/platform, Confluence).

Typical lists are already cheap. `pnpm bench` shows 54 % saved against MCP output. Measured examples:
- `jira_list_projects`: 177.6k raw tokens → 1.8k compact;
- `atlassian_list_plugins`: 90k → 2.4k;
- `confluence_search`: 20k → 0.75k.

The cost concentrates in a few places that nothing bounds:

| Case (measured) | Raw REST | Compact | Chars | Result |
|---|---|---|---|---|
| `confluence_get_page`, 80-section runbook | 35.9k | 18.2k | 70.8k | `ResponseTooLarge`, nothing usable; no argument narrows it |
| `jira_get_issue include=changelog`, 20 edits | 84.5k | 10.2k | 44.8k | `ResponseTooLarge`; description edits show full before/after text |
| `atlassian_audit_events`, 200 events | 57.4k | 13.4k | 41.2k | `ResponseTooLarge`; about 67 tokens per event, `limit` up to 1000 |
| `jira_search fields=*all`, 20 rows | 49.0k | 7.1k | 22.7k | about 360 tokens per row: one uncapped cell with project, watches, votes and custom fields |
| `jira_get_issue comments=30` (json) | 89.3k | 2.4k | — | 6.4k in `--format=json`: no body cap in JSON |

The audit found these root causes:
1. **Uncapped nested cells.** In compact rows, the 160-character cell limit applies only to scalar values (`format.ts` `inline()`). Arrays and objects inside a cell are printed whole. This is the shared cause behind `fields=*all`, changelog `changes`, audit `changes`, Assets attributes, SLA goals, queue SLA fields and epic groups.
2. **Uncapped long text in single objects.** Descriptions, page bodies and version bodies are printed in full. A page or issue has no way to read part of the body.
3. **All-or-nothing response guard.** Past 25,000 characters the agent gets only `ResponseTooLarge`, with no hint about which field is large. The call is wasted, then repeated with `--out` and grepped.
4. **Unbounded membership and sharing lists in admin reads:** workflow `sharing.projects`, field configuration `sharedWith`, application role groups, user groups, project role users, custom field options across all contexts.
5. **Raw passthroughs and missing caps:**
   - raw passthroughs: field contexts, field screens, advanced settings, audit settings, Assets references, Confluence cluster nodes, long tasks and global permissions;
   - no cap on `limit`: `jira_find_groups`, `confluence_find_users`;
   - `confluence_search` advertises a maximum of 500 but caps at 100.
6. **Confluence Markdown defects and waste:**
   - rows of nested tables are emitted twice;
   - every image and link repeats the absolute base URL;
   - comments are converted from rendered `body.view` instead of storage.

There is also a spec conflict to resolve. `agent-context-budget` says default columns apply to compact **and JSON** output. The recent review fix made `--format=json` show every field, and SKILL.md promises exact values in JSON.

## What Changes

- **Bounded compact rendering:**
  - cells holding arrays or objects are cut to the cell limit; arrays show the first items plus `+N more`;
  - long text in single objects is cut at a text limit with a marker that names how to read the rest;
  - the body indent of compact multi-line text is removed.
- **Diagnostic response guard:** `ResponseTooLarge` names the largest fields or columns with their sizes and the tool's narrowing arguments, so one retry is enough.
- **Narrowing arguments for bodies:**
  - `confluence_get_page` and the version view of `confluence_get_page_history` get `outline`, `section` and `max_chars`;
  - `jira_get_issue` gets `max_description_chars`;
  - changelog entries for text fields show the size of the change instead of the full before and after text.
- **Per-tool bounds:**
  - `fields=*all` in issue lists is refused (see design);
  - agile issue lists default to 20 rows with a cap of 100, as search does;
  - comments and worklogs are capped at 100;
  - audit events are capped at 200 rows, with `changes` values cut;
  - Assets search cuts attribute values and caps attributes per object;
  - queue issues flatten SLA and request type columns;
  - membership and sharing lists show the first 10 entries plus a count, with an argument to page or list them all;
  - raw passthroughs become allowlists;
  - missing `limit` caps are added and advertised caps match the real ones;
  - `confluence_find_spaces_by_group` returns matches plus counts, and the per-space audit only on request.
- **Confluence Markdown fixes:**
  - only direct rows of a table are rendered;
  - same-instance image and link URLs are shortened (attachment filename, page id);
  - comments are converted from storage.
- **Approved extension:** guard both compact and JSON benchmark output; default Assets search pages contain 20 objects; reject Markdown page writes carrying the read code-cut marker.
- **Read-token benchmark as a regression guard:** realistic Data Center payload generators and a `pnpm bench:reads` report, plus a unit test that keeps every measured case under its token and character budget.
- **Spec alignment:** default columns apply to compact output only. `--format=json` keeps every field unless `--fields` narrows it.
- **BREAKING (output only):**
  - compact output of nested cells and long text is now cut, and the full value needs `--format=json` or a narrowing argument;
  - `fields=*all` in issue lists is refused;
  - agile list defaults and caps change.

## Capabilities

### New Capabilities
- `read-output-bounds`: the per-tool output bounds for read tools:
  - body narrowing (outline, section, character limit);
  - changelog and audit value caps;
  - list defaults and caps;
  - membership and sharing list truncation;
  - allowlists instead of raw passthroughs.
- `confluence-markdown-rendering`: how Confluence storage becomes Markdown for reads: tables, images, links, macros and comments.
- `read-token-benchmark`: realistic payload generators, the `bench:reads` report and the budget regression test.

### Modified Capabilities
- `agent-context-budget`: the "Output budget" requirement changes:
  - default columns apply to compact output only;
  - nested cells and long single-object text are capped in compact output;
  - `ResponseTooLarge` names the oversized fields and the narrowing arguments.

## Impact

- **Code:**
  - `src/format.ts`, `src/cli.ts` (guard diagnostics);
  - `src/markup.ts`;
  - `src/tools/jira/{issues,shape,agile,insights,workflows,fieldConfigurations,fieldOptions,screens,fields,system,users,projects}.ts`;
  - `src/tools/jira/servicedesk.ts`, `src/tools/jira/sla.ts`;
  - `src/tools/assets/{objects,structure}.ts`;
  - `src/tools/platform/{audit,plugins}.ts`;
  - `src/tools/confluence/{pages,comments,spaces,system,users,spaceDiscovery}.ts`.
- **Tests:** new budget test and payload generators under `test/`; existing format and tool tests are updated where compact output is cut.
- **Docs:** SKILL.md output rules (still within 6,000 characters) and REFERENCE.md argument notes, regenerated.
- **Compatibility:** compact text is for agents, not machines. JSON keeps exact values except where a tool argument now bounds them by default. Those defaults are documented in each tool's description.
