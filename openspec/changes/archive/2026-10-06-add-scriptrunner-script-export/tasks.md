# Tasks

## 1. Verify the Script Editor read API (read-only)

- [x] 1.1 On the instance (Jira 11.3.7 + ScriptRunner 10.14.0), call only `GET idea/scriptroots` (with `groovyFilesOnly` true and false) and `GET idea/file` for one small file, a missing file and a directory. Record in `design.md` the node shape, whether sizes are reported, the error answers, and that the decoded length equals the stored size. Verify that no PUT/DELETE was sent (the script uses GET only) and that no content was printed.
- [x] 1.2 Write synthetic fixtures under `test/fixtures/scriptrunner/`: a tree with two roots, nested folders, a Unicode name, a CRLF file and a non-Groovy file, plus base64 file bodies. Verify that no instance data or real script content is present.
- [x] 1.3 Add the `operations` list to `SUPPORT_MATRIX`, with `script-root-read` for 11.3.7 + 10.14.0, and an operation check in the gate. Verify with tests that an unverified pair answers `Unsupported` and sends no ScriptRunner request.

## 2. Reading and safety

- [x] 2.1 Implement the GET-only Script Root helper: tree loading, matching across roots (ambiguity error, optional `script_root`), and a file read that decodes base64 to a Buffer and reports errors with the HTTP status only. Verify with tests that every request is a GET and that error messages contain no body.
- [x] 2.2 Implement path validation for `path`/`root` and target resolution under `output_dir` (realpath check against symbolic links). Verify with tests for absolute paths, `..`, `.`, NUL, escape through a symbolic link, and directories.
- [x] 2.3 Implement the atomic local write with SHA-256 comparison (`WRITTEN`, `ALREADY-SATISFIED`, `CONFLICT`, `REPLACED` with a `.bak-<timestamp>` backup). Verify with tests that bytes are identical for the CRLF, BOM and Unicode-name fixtures and that a conflicting file stays untouched.

## 3. Tools

- [x] 3.1 Implement `jira_get_scriptrunner_script` (required `out`, metadata-only result). Verify with tests: a read to a new file, an identical file, a conflicting file, and that no content appears in the result or the error.
- [x] 3.2 Implement `jira_export_scriptrunner_scripts` (root selection, nested directories, limits checked before content reads, per-file outcomes, `FAILED` without content, and the default manifest path). Verify with tests: restore, re-run all `ALREADY-SATISFIED`, conflict, overwrite with backup, limit refusal, and a manifest free of content.
- [x] 3.3 Update the ScriptRunner redaction and no-leak tests so they cover the new tools: a serialized result, error and manifest must never contain fixture source markers. Verify that `pnpm test` passes.

## 4. Integration

- [x] 4.1 Register the tools and update `SKILL.md` and the `REFERENCE.md` notes: local-only content, secrets warning, limits, backups, and the GET-only gate. Verify `list`/`describe` and the bounded-reads test.
- [x] 4.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`. Then export one small folder from the instance into a temporary directory. Verify that the SHA-256 values match a second run (all `ALREADY-SATISFIED`), that nothing was printed beyond metadata, and that Jira received only GETs.
