# Spec Delta

## Purpose

Lets Jira Data Center administrators keep a local project folder and a ScriptRunner Script Root folder in sync in both directions. Each change is confirmed per file, deletions are never propagated, and the model never sees file content.

## ADDED Requirements

### Requirement: Three-way comparison of a local folder and a Script Root folder
The system SHALL provide `jira_sync_scriptrunner_scripts` with:
- `root`: a folder relative to the Script Root, validated like the export's `root`;
- `local_dir`: a local directory, resolved against the invocation working directory;
- an optional `manifest`, the baseline, defaulting to `<local_dir>/scriptrunner-export-manifest.json`;
- an optional `script_root`, `max_files` and `max_total_bytes` with the export's defaults and caps;
- `dry_run`.

It SHALL compare:
- the SHA-256 of each server file under `root`;
- the SHA-256 of each local file under `local_dir`, matched by its path relative to `local_dir`;
- the baseline SHA-256 recorded for that path in the manifest.

The baseline SHA-256 of a file is the last content known to be identical on both sides. A manifest entry whose outcome is `CONFLICT` or `FAILED` SHALL NOT count as a baseline.

Local selection SHALL skip:
- the manifest file;
- backups made by these tools or by the export (`*.bak-<timestamp>`);
- temporary files of these tools;
- files and directories whose name starts with `.`.

A local symbolic link SHALL be reported as `FAILED` and never followed.

Each path SHALL be classified as:
- `IN-SYNC`: local and server are identical;
- `PUSH`: the server equals the baseline and the local file differs, or the file exists only locally and has no baseline;
- `PULL`: the local file equals the baseline and the server differs, or the file exists only on the server and has no baseline;
- `CONFLICT`: local and server differ from each other and both differ from the baseline, or they differ and there is no baseline;
- `DELETED-LOCALLY`: the file is on the server and in the baseline, but missing locally;
- `DELETED-ON-SERVER`: the file is local and in the baseline, but missing on the server;
- `FAILED`: a read or path error, named without content.

#### Scenario: Local edit
- **WHEN** `project-a/jobs/close.groovy` was exported and then edited locally, while the server copy is unchanged
- **THEN** the file is classified `PUSH`

#### Scenario: Server edit
- **WHEN** the server copy changed after the export and the local copy is unchanged
- **THEN** the file is classified `PULL`

#### Scenario: Both sides edited
- **WHEN** both copies changed after the export, to different content
- **THEN** the file is classified `CONFLICT` and no action is offered for it

#### Scenario: Both sides edited identically
- **WHEN** both copies changed after the export to the same content
- **THEN** the file is classified `IN-SYNC`

#### Scenario: No baseline
- **WHEN** no manifest exists and a file differs between local and server
- **THEN** the file is classified `CONFLICT`

#### Scenario: New files on either side
- **WHEN** a file exists only locally, or only on the server, and has no baseline entry
- **THEN** it is classified `PUSH` or `PULL` respectively

### Requirement: Deletions are reported, never propagated
The system SHALL NOT delete a server file or a local file and SHALL NOT recreate a deleted file on the other side. `DELETED-LOCALLY` and `DELETED-ON-SERVER` paths SHALL be listed in the result with no action offered. The system SHALL never send `DELETE` to the Script Editor's file resource.

#### Scenario: File removed locally
- **WHEN** a file with a baseline entry was deleted from `local_dir` but still exists on the server
- **THEN** the result lists it as `DELETED-LOCALLY`
- **AND** the server file stays unchanged and no batch item is created for it

#### Scenario: File removed on the server
- **WHEN** a file with a baseline entry was deleted on the server but still exists locally
- **THEN** the result lists it as `DELETED-ON-SERVER`
- **AND** it is not uploaded again

### Requirement: Dry run and per-file confirmation
With `dry_run` not set to false, the sync SHALL send only GET requests and SHALL write no local file, directory or manifest. Its result SHALL contain:
- the counts per classification;
- up to 50 paths per non-`IN-SYNC` classification;
- the manifest path.

With `dry_run=false`, the sync SHALL return a batch with one item per `PUSH` path (a `jira_push_scriptrunner_script` call) and one item per `PULL` path (a `jira_pull_scriptrunner_script` call).
- Each item SHALL carry the expected SHA-256 values it was computed from.
- The user SHALL confirm the items in the interactive checklist, and each approved item SHALL then run on its own.
- `CONFLICT`, deletion and `FAILED` paths SHALL produce no item.
- Recorded with `--plan`, the batch SHALL become one plan item per file.

When nothing is to push or pull, the result SHALL be already-satisfied and SHALL need no confirmation.

#### Scenario: Preview
- **WHEN** an administrator runs the sync without `dry_run=false`
- **THEN** the result lists the counts and paths per classification
- **AND** Jira receives only GET requests and no local file changes

#### Scenario: Partial approval
- **WHEN** the checklist offers two pushes and one pull and the user unticks one push
- **THEN** only the other push and the pull run, and the unticked push is reported as declined

#### Scenario: Everything in sync
- **WHEN** every file is `IN-SYNC`
- **THEN** the sync reports already-satisfied and shows no confirmation dialog

### Requirement: Push one file to the Script Root
The system SHALL provide the write tool `jira_push_scriptrunner_script` with:
- `path`, relative to the Script Root and validated before any request;
- `local`, the local file to upload;
- `expect_server_sha256`: either the SHA-256 the server file must still have, or `absent` for a file that must not exist yet;
- optional `manifest` and `script_root`;
- `dry_run`.

Before sending, it SHALL read the current server state of `path`:
- **Identical to the local file:** it SHALL report already-satisfied.
- **Different from `expect_server_sha256`:** it SHALL refuse with a conflict that names both SHA-256 values, and SHALL send nothing.

The dry run SHALL show:
- the method and URL;
- the path, local size and SHA-256, and the server SHA-256 it replaces;
- that the file is executable code that Jira uses at once.

It SHALL NOT show the content. After a confirmed upload, it SHALL read the file back. When the SHA-256 read back differs from the local file, it SHALL fail with a verification error. When it matches, it SHALL record that SHA-256 as the file's baseline in the manifest.

#### Scenario: Upload a changed script
- **WHEN** an administrator pushes `project-a/jobs/close.groovy`, the user confirms, and the server still has the expected SHA-256
- **THEN** the server file holds exactly the local bytes, the read-back SHA-256 matches, and the manifest baseline is updated

#### Scenario: Server changed after the preview
- **WHEN** the server file changed between the sync preview and the push
- **THEN** the push is refused as a conflict naming both SHA-256 values, and nothing is sent

#### Scenario: New file
- **WHEN** `expect_server_sha256=absent` and no server file exists at `path`
- **THEN** the push creates it and verifies it by reading it back

### Requirement: Pull one file to the local folder
The system SHALL provide `jira_pull_scriptrunner_script` with:
- `path`;
- `local`;
- `expect_local_sha256`: either the SHA-256 the local file must still have, or `absent`;
- optional `manifest` and `script_root`;
- `dry_run`.

It SHALL send only GET requests to Jira.
- **Local file differs from `expect_local_sha256`:** it SHALL refuse with a conflict and leave the file unchanged.
- **Otherwise:** it SHALL back up an existing local file to `<file>.bak-<UTC timestamp>`, write the server bytes atomically, and record the new SHA-256 as the baseline in the manifest.
- **Local file already identical:** it SHALL report already-satisfied.

Local targets SHALL stay inside `local_dir` under the same symbolic-link checks as the export.

#### Scenario: Pull a server change
- **WHEN** the local file still has the expected SHA-256 and the user approves the pull
- **THEN** the old local file is kept as a backup, the new bytes are written, and the manifest baseline is updated

#### Scenario: Local file edited after the preview
- **WHEN** the local file changed after the sync preview
- **THEN** the pull is refused as a conflict and the local file stays unchanged

### Requirement: Write gating and content-free output
Push SHALL be allowed on all Jira 10.x/11.x + ScriptRunner 9.x/10.x combinations for which the support matrix records `script-root-write`. Range allowance SHALL NOT imply live verification of every combination. On any other pair, it SHALL answer `Unsupported` before any ScriptRunner request. Sync and pull SHALL require `script-root-read`.

File content SHALL NOT appear in:
- tool results, dry runs, batch items or plans;
- the confirmation dialog, error messages or the manifest.

Push errors SHALL report the HTTP status without the response body. These tools SHALL NOT execute, validate or compile scripts through any ScriptRunner endpoint.

#### Scenario: Write operation disabled
- **WHEN** the matching support entry does not record `script-root-write`
- **THEN** a push answers `Unsupported`, naming the `script-root-write` operation, and sends no ScriptRunner request
- **AND** sync previews and pulls still work

#### Scenario: Upload rejected
- **WHEN** Jira answers an error to the upload
- **THEN** the push fails with the HTTP status only, and no response body or content appears in the output
