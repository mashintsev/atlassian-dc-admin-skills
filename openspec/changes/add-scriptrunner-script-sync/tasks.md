# Tasks

## 1. Verify the write endpoint on the user-selected instance, under temp

- [x] 1.1 Through the CLI, dry-run and confirm a new byte-preservation probe in `temp`; verify PUT with base64 text and `application/octet-stream` using independent file read-back. Record sanitized metadata, BOM/CRLF preservation and exact-pair evidence in `test/fixtures/scriptrunner/write-live-triniti.json` and design.md. Raw successful HTTP status/body are not captured by the CLI and are not claimed.
- [x] 1.2 Verify creation of missing parent folders and storage of a file with invalid Groovy syntax; independently read both probes back and compare bytes. Record that script execution was not requested and compilation-on-save remains unknown.

## 2. Server write helper and gate

- [x] 2.1 Add a `writeScriptFile` helper (in `src/tools/jira/scriptSync.ts`, keeping `scriptRoot.ts` GET-only) that sends only `PUT idea/file`, for now in the encoding assumed from the editor JS (base64 text, `application/octet-stream`); re-check it after 1.1 and reduces errors to the HTTP status. Verify: a new test in `test/unit/scriptRoot.test.ts` first fails, then passes; it asserts the method, URL and body encoding, and that no response body appears in an error.
- [x] 2.2 Initially add the write-operation gate without enabling it; retain the refusal test for an explicitly disabled operation after task 5.2 enables the requested ranges. Verify: a push without `script-root-write` in its matching entry answers `Unsupported` before any ScriptRunner request.

## 3. Comparison and manifest

- [x] 3.1 Implement the local tree walk: POSIX relative paths validated with `validateRelative`; skips the manifest, `*.bak-*`, the tools' temporary files and dot-entries; symbolic links become `FAILED`. Verify: unit tests on a temporary directory, including a Unicode file name and a symbolic link.
- [x] 3.2 Implement baseline loading from the export manifest (outcomes `WRITTEN`, `ALREADY-SATISFIED`, `REPLACED`, `PUSHED` and `PULLED` count as baseline) and the atomic update of one manifest entry. Verify: tests for a missing manifest, a `CONFLICT` entry that is ignored, and an update that keeps the other entries byte-identical.
- [x] 3.3 Implement the three-way classification over the local, server and baseline SHA-256 values. Verify: a table-driven test that covers every spec scenario (local edit, server edit, both edited, identical edits, no baseline, new on each side, deleted on each side).

## 4. Tools

- [x] 4.1 Implement `jira_pull_scriptrunner_script` (`write: true`, GET-only toward Jira): `expect_local_sha256` check, backup, atomic write, local path checks, baseline update, already-satisfied. Verify: tests for pull, the conflict after a local edit, already-satisfied, a symbolic link escaping `local_dir`, and the GET-only assertion.
- [x] 4.2 Implement `jira_push_scriptrunner_script` (`write: true`): validate `path`, check the gate, re-check `expect_server_sha256`/`absent`, build a dry run without content (placeholder body, summary that calls the file executable, `identity`/`state`), PUT, verify the read-back SHA-256, update the baseline. Verify: tests for the dry run without content, the conflict after a server change, already-satisfied, a read-back mismatch raising a verification error, and an HTTP error carrying the status only.
- [x] 4.3 Implement `jira_sync_scriptrunner_scripts` (`write: true`): the dry run returns counts and up to 50 paths per class with GETs only and no local writes. the dry run carries a `batch` of push and pull items carrying the expected SHA-256 values. With nothing to do, it returns already-satisfied. The limits match the export's. Verify: tests for the preview, the batch contents, an empty batch reporting already-satisfied, `CONFLICT` and deletions producing no items, and a refusal over `max_files`/`max_total_bytes` that writes nothing.
- [x] 4.4 Register the three tools in `src/tools/index.ts`. Verify: `test/unit/tools.test.ts` passes with the new names, and every tool's description states the content-free output.
- [x] 4.5 Test the CLI integration: a sync with `dry_run=false` shows one checklist item per file, and unticked items are reported as DECLINED; `--plan` records one plan item per file. Verify: a real CLI run against an HTTP fake (confirmation mode `none` from a config file) reports DONE per file, and a plan test applies the items without drift. Unticking items uses the CLI's generic batch code, which is not changed here.
- [x] 4.6 Add a test that the sync, push and pull outputs, the batch items, the plan file and the manifest never contain the fixture content (a marker string inside the fixture scripts). Verify: the test passes.

## 5. Docs, build and enabling

- [x] 5.1 Document the workflow in `atlassian-dc-admin/SKILL.md`: export for the baseline, sync preview, per-file confirmation, conflicts resolved locally, deletions reported only, push as a live code deploy, a staging-first recommendation and `.gitignore` for `*.bak-*`. Verify: `pnpm build` regenerates `REFERENCE.md` and the bundle without errors, and the new tools appear in `REFERENCE.md`.
- [x] 5.2 Enable `script-root-write` on all requested Jira 10.x/11.x + ScriptRunner 9.x/10.x ranges. Record live verification only for the exact pair (2026-10-07), and test push dry-run, confirmed write, sync checklist and byte-preserving read-back without test-only gate overrides.
- [ ] 5.3 Run `pnpm typecheck`, `pnpm test` and `openspec validate add-scriptrunner-script-sync --strict`. Verify: all of them pass.

Verification on 2026-10-07: 53 SR tests pass; typecheck passes. Full suite: 798/814 pass, 16 failures in unrelated Confluence/Jira/JSM/Assets/filter tests. All 16 reproduce in an isolated source copy with `script-root-write` disabled; task 5.3 stays incomplete until the whole suite passes.
