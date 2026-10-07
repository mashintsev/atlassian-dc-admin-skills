# Proposal

## Why

Administrators keep ScriptRunner scripts in a project folder under version control. Today the skill can only restore a Script Root folder to local disk (`jira_export_scriptrunner_scripts`). Local edits still have to be copied into the Script Editor by hand, and nothing tells which side changed since the last export. A synchronization between a local project folder and a Script Root folder closes that loop. It does so without exposing source to the model and without silently overwriting either side.

## What Changes

- New tool `jira_sync_scriptrunner_scripts`: a three-way comparison of a local folder (default: a subfolder of the current project directory), a Script Root folder and a baseline manifest, by SHA-256.
  - Each file is classified as `IN-SYNC`, `PUSH` (changed or new locally), `PULL` (changed or new on Jira), `CONFLICT` (changed on both sides, or different with no baseline), `DELETED-LOCALLY` or `DELETED-ON-SERVER`.
  - The dry run sends only GETs and writes nothing.
  - With `dry_run=false`, it returns a batch: one checklist item per push and per pull, confirmed interactively by the user like every other change. Each approved item then runs on its own. The batch can also be recorded in a change plan with `--plan`.
- New write tool `jira_push_scriptrunner_script`: uploads one local file to the Script Root (`PUT idea/file`).
  - It runs only when the server file still has the expected SHA-256, or is still absent for a new file. Otherwise it reports a conflict and sends nothing.
  - After the upload, it reads the file back and verifies its SHA-256.
- New tool `jira_pull_scriptrunner_script`: replaces one local file with the server file. It does so only when the local file still has the expected SHA-256, and backs the local file up first. It sends GETs only.
- Push and pull update the baseline manifest entry of their file. An existing export manifest (`scriptrunner-export-manifest.json`) serves as the first baseline.
- Deletions are never propagated: files deleted on one side are only reported. The tools never send `DELETE` and never remove local files.
- New support-matrix operation `script-root-write`. Push is enabled on all Jira 10.x/11.x + ScriptRunner 9.x/10.x combinations at the user's request. PUT and independent byte-preserving read-back were checked on Jira 11.3.7 + ScriptRunner 10.14.0; other combinations are policy allowances, not live verification.
- File content never appears in results, dry runs, plans, the confirmation dialog, errors or the manifest.

## Capabilities

### New Capabilities
- `jira-scriptrunner-script-sync`: three-way synchronization of a local folder with a Script Root folder, including single-file push and pull, the baseline manifest, conflict rules and write gating.

### Modified Capabilities
- `jira-scriptrunner-script-management`: the "Protect ScriptRunner script contents" requirement currently allows only the export tools to read source. The sync tools must also read source, to hash and pull it, and push must send local source to Jira.

## Impact

- **Code:** `src/tools/jira/scriptRoot.ts` gains the comparison, the manifest update, the local tree walk and a dedicated `PUT` helper (the read helper stays GET-only). `SUPPORT_MATRIX` in `src/tools/jira/scriptrunner.ts` allows `script-root-write` within the requested major-version ranges. Tool registration goes in `src/tools/index.ts`.
- **Docs:** `atlassian-dc-admin/SKILL.md`, regenerated `REFERENCE.md` and the bundled `atlassian-admin.mjs`.
- **Tests:** unit tests with fixtures for classification, conflicts, path safety, the batch shape, the content-free output and the push read-back.
- **Risk:** pushing a script deploys executable code to Jira. Listeners, jobs and endpoints that reference the file by path use the new code immediately. Every push therefore needs interactive confirmation per file.
