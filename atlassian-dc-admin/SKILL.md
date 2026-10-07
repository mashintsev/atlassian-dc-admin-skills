---
name: atlassian-dc-admin
description: Jira, Confluence, Service Management, ScriptRunner and Assets on Data Center over REST: admin (users, groups, schemes, workflows, fields, screens, boards, spaces, apps, audit) and content (issues, pages, requests, SLAs, scripts, CMDB objects). Load before the first atlassian-admin call. TRIGGER: Jira, Confluence, JSM, ScriptRunner, Assets, Insight, JQL, CQL, AQL, PROJ-123 keys, page ids, "who can…", deactivate user, permission/workflow scheme, workflow, issue type, space permission, audit log.
---

# atlassian-admin — dispatcher

```bash
A="node <skill dir>/scripts/atlassian-admin.mjs"
$A list jira | list confluence | list <text>   # names only; ✎ = write
$A describe <tool>                             # args (+ old-name aliases); never guess args
$A <tool> key=value ...                        # e.g. jira_search jql="project=FDP AND status=Open" limit=20
$A check --ping                                # which config file, connectivity
$A init --jira-url=https://jira.x               # per-project config (.atlassian-dc-admin.env) for another Jira/Confluence
```

## Output (token budget)

- Default `compact`: `# col | col` header then one row per item; paging line `total:N offset:O next:K|last`.
- Filter on the server (`jql`, `cql`, `aql`, `query`/`search`/`name_contains`, project/space/schema ids), keep `limit` small, page with `offset` → `nextOffset` only when needed. Avoid full scans.
- `--format=json` for exact values, `--format=full` only to debug.
- `--fields=key,name` or `--fields=-description` trims columns.
- Big results: `--out=/tmp/x.json` saves the full JSON (one `saved | …` line); grep/jq the file, don't print it.
- Cut values end with `…(+N)`/`+N more` and name how to read more. `ResponseTooLarge` lists the largest fields: narrow those (`section`/`outline` for pages, `full_lists`, `--fields`) or use `--out`; never raise the limit.
- Markdown page writes reject code cut markers; reread storage or a smaller section first.
- Lists never carry bodies; fetch one item with its `get_*` tool (`fields=*all` only there). Bodies come as Markdown; writes take Markdown.
- Attachments and images are saved to `output_dir`, never inlined; read them only if needed.

## Writes (✎) — the user confirms every change

Every write is a dry run unless `dry_run=false`; the dry run prints `DRY-RUN | summary` + request and sends nothing.
Executing is gated by the CLI itself: it shows the change to the user in a desktop dialog (or their terminal) and
only proceeds on their click. You never see or answer that dialog.

1. Read the current state, then dry-run every intended change and show the user the list.
2. Ask the user how to confirm (AskUserQuestion, or a direct question): **each change separately** or **all at once**.
   - Each: run each call again with `dry_run=false`; the user gets Apply/Cancel per change.
   - All at once: dry-run each call with `--plan=/tmp/<task>.json`, show `plan /tmp/<task>.json`, then run
     `apply /tmp/<task>.json`; the user gets one checklist with every change ticked and can untick some.
3. Give these commands a timeout of at least 150 s (Claude Code: Bash `timeout` 150000) — the dialog waits for the user.
4. Exit 12 = the user declined: stop, change nothing else, ask what to do. Exit 13 = no dialog/terminal
   available: ask the user to run the printed command themselves. Never try to bypass the confirmation.
5. `apply` reports `DONE`, `ALREADY-SATISFIED`, `FAILED` or `DRIFTED` per change (drifted = the target changed after approval; re-plan it). It exits 0 when every item is done or already satisfied, 5 when some drifted and none failed, 1 when any failed.
   Outcomes are saved in the plan: `plan FILE` shows them and what remains, and a second `apply FILE` runs only the
   remaining items. Read back and report what changed.
6. `ALREADY-SATISFIED` from a write means its target state already holds: nothing is sent and no confirmation is asked.
   A `manual change` dry run (no REST path, e.g. screens) is never sent: give the user its link and
   values, then re-run the tool to verify.
7. After changes were applied (`DONE` items, including partial applies), end with a short **UI check plan for admins**:
   one line per changed object with where to look in Jira/Confluence (admin page path or the URL the tools returned)
   and what should be visible there now, plus who is affected (shared schemes, screens, configurations, portals).
   Keep it to a few lines, list skipped/failed items separately, and write it in the user's language.

Prefer reversible actions (deactivate/disable, archive) over delete. Say "irreversible" before deleting users, groups, fields, issues, versions, filters, pages or spaces.
Never delete a custom field to undo a partly applied plan: re-run `apply` for the remaining items instead.
Workflow edits to an active workflow land in its draft: say so, plan `jira_publish_workflow_draft` as a separate change, and say that conditions, validators and post-functions cannot be read or compared over REST.
ScriptRunner (Jira 10/11, SR 9/10) Script Root files (export, sync, push, pull) stay in local files: never print or summarize their content; warn they may hold credentials. Push deploys live code; see REFERENCE.md for sync.
Page updates take `if_version`; `StaleVersion` (exit 5) means someone else edited it: re-read, never overwrite blindly.

## Working through agents

- Delegate broad reads (audits across all projects/spaces/users, "where is X used") to a subagent when your agent has them: give it this CLI, ask for compact output or `--out` files, and require only the conclusion back.
- Run independent reads in parallel (one agent per product or per area).
- Subagents never pass `dry_run=false` or run `apply`; they may build a `--plan` file and return its path, and confirmation plus execution happen in the main conversation.

## Errors

Errors print `ERROR <type> | message` and a `hint:` line; exit 12 = declined, 13 = cannot ask (see Writes). All exit codes and Codex sandbox notes: [REFERENCE.md](REFERENCE.md).

Jira Assets (objects, schemas, attributes, AQL): read [ASSETS.md](ASSETS.md) before the first `assets_*` call (`list assets`).
Confluence group space audits, categories and mixed administrator batches: read [SPACE_WORKFLOWS.md](SPACE_WORKFLOWS.md) before preparing the workflow. Honor an already stated batch choice and use its native confirmation checklist.
Configuration and recipes: [REFERENCE.md](REFERENCE.md) (read only when needed).
