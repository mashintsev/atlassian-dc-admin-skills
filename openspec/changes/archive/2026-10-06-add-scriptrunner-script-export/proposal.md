# Proposal

## Why

`jira_list_scriptrunner_items type=registry` lists Script Root files by name and path, but source is deliberately filtered out. Administrators therefore cannot ask the agent to "restore all ScriptRunner scripts from the server folder project-a into the local project folder project-a". Source cannot pass through the existing `redact` either, because redacting would corrupt the restored files. The tools need a path that copies files byte for byte to local disk and shows the model only metadata.

## What Changes

- New read tool `jira_get_scriptrunner_script` (`path`, `out`):
  - reads one file by its path relative to the Script Root and writes it to the required local file `out`;
  - returns only path, size, SHA-256 and status;
  - refuses absolute paths, `..`, paths outside the Script Root and directories.
- New read tool `jira_export_scriptrunner_scripts` (`root`, `output_dir`, `overwrite?`, `manifest?`):
  - takes the current Script Root file tree, selects the files under the folder `root`, and recreates their nested structure in `output_dir`;
  - keeps the exact bytes (UTF-8 text, Unicode names, line endings);
  - existing local files are kept: identical ones are `ALREADY-SATISFIED`, different ones are `CONFLICT` unless `overwrite=true`, which backs up the local file before replacing it;
  - writes a manifest (path, size, SHA-256, outcome) and enforces a file-count and total-size limit per export.
- Both tools use the ScriptRunner Script Editor's read endpoint, found in ScriptRunner's own web resources:
  - `GET /rest/scriptrunner/latest/idea/file?filePath=…&rootPath=…` returns `{result:{content:<base64>}}`;
  - the file tree comes from `GET …/idea/scriptroots`.
  - The same file URL saves (`PUT`) and deletes (`DELETE`) files, so the tools send `GET` only.
  - The endpoint is added to the verified Jira/ScriptRunner support matrix (Jira 11.3.7 + ScriptRunner 10.14.0) after a read-only check on the instance; other pairs answer `Unsupported`.
- File contents never appear in tool output, errors, logs, plans or the manifest. They are written only to the local files the caller named, and never sent anywhere else. Exported Groovy is never executed.

## Capabilities

### New Capabilities
- `jira-scriptrunner-script-export`: reading single Script Root files and exporting a Script Root folder to local disk, byte-exact and metadata-only toward the model, behind the ScriptRunner version gate.

### Modified Capabilities
- `jira-scriptrunner-script-management`: the requirement "Protect ScriptRunner script contents" gains an explicit exception. Source may be written unredacted to local files that the caller named, through the export tools only, and it still never appears in any tool output.

## Impact

- **Code:**
  - `src/tools/jira/scriptrunner.ts`: support-matrix entry, Script Editor tree and file reads.
  - A new module for path validation, local writes, backups and the manifest.
  - Tool registration in `src/tools/index.ts`.
- **Docs:** `SKILL.md`, `REFERENCE.md` (generated tool list plus a hand-written note).
- **Tests:** new unit tests with synthetic fixtures (tree and base64 file bodies), path traversal, conflicts, backups, limits, Unicode names and CRLF files.
- **Jira:** read-only GETs only, using the PAT from the existing configuration (`.atlassian-dc-admin.env`).
- **Local disk:** files under the caller's `out` / `output_dir`, `.bak` backups when `overwrite=true`, and the manifest.
