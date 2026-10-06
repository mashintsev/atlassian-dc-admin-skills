---
name: atlassian-dc-admin
description: Jira and Confluence Data Center over REST — admin (users, groups, licenses, roles, permission/notification/security schemes, workflow schemes (create, drafts, mappings, where a workflow is used), issue types and issue type schemes, custom fields with their contexts and select options, field configurations, screens and where they are used, board configuration and Detail View, spaces and space permissions, apps, reindex, cluster, audit log) and content (issues, JQL search, comments, transitions, sprints and boards, worklogs, links, attachments, Service Management requests, request types, portal groups and request forms, queues, SLAs and SLA calendars, Confluence pages, CQL search, comments, labels, attachments, restrictions) and Jira Assets / Insight CMDB (AQL search, objects, schemas, object types, attributes, statuses). Load before the first atlassian-admin command. TRIGGER: Jira, Confluence, Assets, Insight, CMDB, JQL, CQL, AQL, PROJ-123 keys, page ids, "who can…", deactivate user, permission scheme, workflow scheme, issue type, space permissions, reindex, audit log.
---

# atlassian-admin — dispatcher

```bash
A="node <skill dir>/scripts/atlassian-admin.mjs"
$A list jira | list confluence | list <text>   # names only; ✎ = write
$A describe <tool>                             # args + description; never guess args
$A <tool> key=value ...                        # e.g. jira_search jql="project=FDP AND status=Open" limit=20
$A check --ping                                # which config file, connectivity
$A init --jira-url=https://jira.x               # per-project config (.atlassian-dc-admin.env) for another Jira/Confluence
```

## Output (token budget)

- Default `compact`: `# col | col` header then one row per item; paging line `total:N offset:O next:K|last`.
- Ask narrowly: filter on the server (`jql`, `cql`, `aql`, `query`/`search`/`name_contains`, project/space/schema ids) and keep `limit` small; page with `offset` → `nextOffset` (or `page`/cursor) only when the answer needs more rows. Never fetch everything to look for one item.
- `--format=json` for decisions on exact values, `--format=full` only to debug a field that compact dropped.
- `--fields=key,name` or `--fields=-description` trims columns.
- Big or bulk results: `--out=/tmp/x.json` writes the full JSON and prints one `saved | …` line; then grep/jq the file instead of printing it.
- `ResponseTooLarge` means narrow (filters, `limit`, `--fields`) or use `--out`; never raise the limit.
- Lists never carry bodies (descriptions, page bodies); fetch one item with its `get_*` tool. Bodies come as Markdown; writes take Markdown and convert it.
- Attachments and images are saved to `output_dir`, never inlined; read the saved files only if needed.

## Writes (✎) — the user confirms every change

Every write is a dry run unless `dry_run=false`; the dry run prints `DRY-RUN | summary` + request and sends nothing.
Executing is gated by the CLI itself: it shows the change to the user in a desktop dialog (or their terminal) and
only proceeds on their click. You never see or answer that dialog.

1. Read the current state, then dry-run every intended change and show the user the list.
2. Ask the user how to confirm (AskUserQuestion in Claude Code, a direct question in Codex): **each change separately** or **all at once**.
   - Each: run each call again with `dry_run=false`; the user gets Apply/Cancel per change.
   - All at once: dry-run each call with `--plan=/tmp/<task>.json`, show `plan /tmp/<task>.json`, then run
     `apply /tmp/<task>.json`; the user gets one checklist with every change ticked and can untick some.
3. Give these commands a timeout of at least 150 s (Claude Code: Bash `timeout` 150000; Codex: the default is fine) — the dialog waits for the user.
4. Exit 12 = the user declined: stop, change nothing else, ask what to do. Exit 13 = no dialog/terminal
   available: ask the user to run the printed command themselves. Never try to bypass the confirmation.
5. `apply` reports `DONE`, `ALREADY-SATISFIED`, `FAILED` or `DRIFTED` per change (drifted = the target changed after approval; re-plan it).
   Outcomes are saved in the plan: `plan FILE` shows them and what remains, and a second `apply FILE` runs only the
   remaining items. Read back and report what changed.
6. `ALREADY-SATISFIED` from a write means its target state already holds: nothing is sent and no confirmation is asked.
   A dry run marked `manual change` (field descriptions in a field configuration) is never sent: give the user the edit
   link and the value, then re-run the tool to verify.
7. After changes were applied (`DONE` items, including partial applies), end with a short **UI check plan for admins**:
   one line per changed object with where to look in Jira/Confluence (admin page path or the URL the tools returned)
   and what should be visible there now, plus who is affected (shared schemes, screens, configurations, portals).
   Keep it to a few lines, list skipped/failed items separately, and write it in the user's language.

Prefer reversible actions (deactivate/disable, archive) over delete. Say "irreversible" before deleting users, groups, custom fields, issues, pages or spaces.
Never delete a custom field to undo a partly applied plan: re-run `apply` for the remaining items instead.
Page updates take `if_version`; `StaleVersion` (exit 5) means someone else edited it: re-read, never overwrite blindly.

## Working through agents

- Delegate broad reads (audits across all projects/spaces/users, "where is X used") to a subagent when your agent has them: give it this CLI, ask for compact output or `--out` files, and require only the conclusion back.
- Run independent reads in parallel (one agent per product or per area).
- Subagents never pass `dry_run=false` or run `apply`; they may build a `--plan` file and return its path, and confirmation plus execution happen in the main conversation.

## Codex

The CLI needs network access to Jira/Confluence: in Codex's default sandbox (no network) the call fails with
`NetworkError`; re-run it with sandbox escalation / approval, or the user enables network for the workspace. If the
confirmation dialog cannot open inside the sandbox (exit 13), run the write outside the sandbox (approval) or ask the
user to run the printed command. The Claude Code hook does not exist in Codex; the CLI dialog is the gate there.

## Exit codes

0 ok · 1 error · 2 not found · 3 permission · 4 conflict · 5 stale version · 6 auth · 7 validation/usage · 10 network · 11 rate limited · 12 declined by user · 13 cannot ask user.
Errors print `ERROR <type> | message` and a `hint:` line.

Jira Assets (objects, schemas, attributes, AQL): read [ASSETS.md](ASSETS.md) before the first `assets_*` call (`list assets`).
Confluence group space audits, categories and mixed administrator batches: read [SPACE_WORKFLOWS.md](SPACE_WORKFLOWS.md) before preparing the workflow. Honor an already stated batch choice and use its native confirmation checklist.
Configuration, all tools by area and typical task recipes: [REFERENCE.md](REFERENCE.md) (read only when needed).
