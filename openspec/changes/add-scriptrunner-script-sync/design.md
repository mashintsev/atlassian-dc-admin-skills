# Design

## Context

See proposal.md for the motivation. `src/tools/jira/scriptRoot.ts` already provides the read side: Script Root tree, file read, path validation, local target checks, atomic writes with backups, the export manifest and the limits. The archived change `2026-10-06-add-scriptrunner-script-export` (design.md) describes them.

`requireScriptRunnerOperation` gates each operation per allowed Jira/ScriptRunner range (`SUPPORT_MATRIX[].operations`).

The CLI already handles a write tool whose dry run returns `batch: [{tool, args, value}]` (`src/cli.ts`):
- one checklist, then each approved item runs on its own with `dry_run=false`;
- `addResultToPlan` turns a batch into one plan item per entry.

**Live-checked on 2026-10-07 (Jira 11.3.7 + ScriptRunner 10.14.0):**
- `PUT /rest/scriptrunner/latest/idea/file?filePath=&rootPath=` with base64 text and `application/octet-stream` stores the bytes; independent read-back matches.
- Missing parent folders are created, BOM/CRLF are preserved, and invalid Groovy syntax can be stored.
- Exact successful HTTP status/body and compilation-on-save behavior remain uncaptured or unknown. No DELETE endpoint was tested or used.

## Goals / Non-Goals

**Goals:**
- Bidirectional sync with optimistic concurrency per file. Each item carries the SHA-256 it expects on the side it overwrites.
- The same safety envelope as the export: path checks, no content toward the model, limits and the version gate.

**Non-Goals:**
- Deleting or renaming files on either side, or moving folders.
- Merging conflicting edits. Conflicts are reported, and the user resolves them locally and runs the sync again.
- Creating empty server folders, or syncing ScriptRunner item configuration (listeners, jobs and so on).
- Validating, compiling or running scripts.

## Decisions

### Three tools, one batch
`jira_sync_scriptrunner_scripts` only compares and plans. `jira_push_scriptrunner_script` and `jira_pull_scriptrunner_script` each change one file.

The sync's `dry_run=false` result is a `batch` of push and pull calls. This reuses the CLI's existing checklist, per-item execution, declined handling and `--plan` support.

The sync is marked `write: true`, so `dry_run=false` goes through the batch path. Following the CLI's existing batch pattern (as in `jira_add_field_to_screens`), the sync's dry run already carries the `batch`. A CLI call with `dry_run=false` turns it into the checklist and runs each approved item. A direct handler call with `dry_run=false` (outside the CLI) runs the items in order. Its preview stays GET-only.

The batch item values are built by the same functions as the push and pull dry runs, so a planned item's digest matches when `apply` repeats that dry run. When `script-root-write` is not allowed for the pair, PUSH paths are listed with a `pushNote` and get no batch item, so pulls still work.

The code lives in `src/tools/jira/scriptSync.ts`. The only `PUT` helper is there too, so `scriptRoot.ts` stays GET-only.

Pull is also `write: true`, because it overwrites local files: a direct `dry_run=false` call is confirmed.

- **Alternative rejected:** one tool that pushes and pulls everything after a single Apply. It would give no per-file approval and no per-file drift check. A failure halfway would also leave an unclear state.

### Baseline manifest
The baseline is the export manifest file (default `<local_dir>/scriptrunner-export-manifest.json`), extended rather than replaced.
- **Export entries:** `files[].sha256` with outcome `WRITTEN`, `ALREADY-SATISFIED` or `REPLACED` means both sides held that content.
- **Updates:** push and pull update only their own entry, by reading, modifying and atomically rewriting the manifest. They set `sha256`, `size`, `outcome: "PUSHED" | "PULLED"` and `syncedAt`. Batch items run one after another, so concurrent updates within one batch do not occur.
- **IN-SYNC files:** the sync records no baseline for them, because its dry run writes nothing and the CLI never runs the sync itself with `dry_run=false` (it runs the batch items). The result instead counts the in-sync files that have no baseline, and hints to re-run the export into the folder, which records them as `ALREADY-SATISFIED`.
- **Missing manifest:** every differing pair is a `CONFLICT`. Pushes and pulls of one-sided new files still work. The result hints to run the export first for a clean baseline.
- **Alternative rejected:** a separate sync-state file. It would duplicate the export manifest and confuse which one is authoritative.

### Classification
The classification is computed from three SHA-256 values per path (see the spec table).
- **Server content:** server files are downloaded into memory, as in the export, with the same all-or-nothing `max_total_bytes` check, because the tree reports no sizes.
- **Local files:** read from disk, skipping the manifest, `*.bak-*`, the tools' temporary files and dot-entries. The paths are converted to POSIX and validated with `validateRelative`.
- **Limits:** `max_files` applies to the union of local and server paths.

### Optimistic concurrency per item
- **Push:** `expect_server_sha256` holds the server SHA-256 seen at planning time, or `absent`.
- **Pull:** `expect_local_sha256` holds the local SHA-256 seen at planning time, or `absent`.
- **Re-check:** each item re-reads its side right before it writes, and refuses with a conflict on a mismatch.
- **Plan drift:** the dry run's `identity` holds `{op, path, scriptRoot, localSha256, expect}` and its `state` holds the server SHA-256. Plan drift detection then works without content.
- **Already-satisfied:** when the target already equals the source, the item reports already-satisfied, which covers re-runs after a partial apply.

### Write endpoint and verification
A dedicated `writeScriptFile(client, rootPath, relativePath, bytes)` helper sends `PUT idea/file`, with base64 text as the body and `application/octet-stream`. `readScriptFile` and the export stay GET-only.

On 2026-10-07 the user requested verification in `temp` and unblocking the operation. CLI probes on Jira 11.3.7 + ScriptRunner 10.14.0 confirmed:
- a new file under missing `temp/codex-sr-check-20261007` parent folders was stored;
- 68 bytes, including a UTF-8 BOM and CRLF, survived the upload and independent read-back unchanged;
- a 7-byte Groovy file with invalid syntax was stored and read back unchanged;
- no script execution, validation or DELETE endpoint was called.

Sanitized metadata is in `test/fixtures/scriptrunner/write-live-triniti.json`. The CLI does not expose the exact successful HTTP status or response body, so neither is claimed as captured. Whether saving triggers compilation remains unknown. Both probe files remain in the requested `temp` folder.

`script-root-write` is allowed on every Jira 10.x/11.x + ScriptRunner 9.x/10.x combination, per user instruction. Only the exact checked pair receives a verification date. Other ranges remain policy allowances without live evidence. Dry-run, interactive confirmation, expected server SHA-256 checks and post-upload byte verification remain required.

### Content-free output
Push builds its own dry-run description; it does not use `guardedWrite`, which echoes request bodies. The body is shown as a placeholder: `"(N bytes from <local>, sha256 …; not shown)"`.

The confirmation line carries the summary only, for example `Push project-a/jobs/close.groovy (1.2 KB, sha256 ab12…) — replaces executable code in Jira`.

The rest follows the export's practice:
- HTTP errors are reduced to their status;
- file system errors are reduced to their code.

## Risks / Trade-offs

- [A push deploys live code: listeners and jobs referencing the file run the new version immediately] → Per-file interactive confirmation, a summary that says the file is executable, and no bulk "apply all" without the checklist. The SKILL.md workflow recommends pushing to a staging instance first.
- [The internal endpoint is unverified and might change between versions] → The `script-root-write` gate allows the requested major ranges; only the recorded exact pair has live evidence. The read-back SHA-256 check catches silent transformations, for example of line endings.
- [Concurrent edits in the Script Editor between preview and push] → The `expect_server_sha256` re-check right before the PUT. A small window remains between that check and the PUT, because the endpoint offers no conditional write. A server edit in that window is overwritten; the user can recover it from the Script Editor's history, if they have one, or from a local export.
- [The baseline is lost or edited by hand] → It only degrades to `CONFLICT`, never to an overwrite. Re-running the export restores a clean baseline.
- [Secrets in scripts end up in the project repo] → Pulls carry the same `SECRETS_NOTE` as the export. Backups are written next to the file; `.gitignore` guidance for `*.bak-*` goes into SKILL.md.

## Migration Plan

The tools are additive. The manifest stays backward-compatible: the new outcomes and the `syncedAt` field are additions. Rollback removes the tools and the `script-root-write` matrix operation.

## Open Questions

- Whether saving triggers compilation or static type checking is unknown. Invalid syntax was stored successfully; storage verification is not a compilation check.
