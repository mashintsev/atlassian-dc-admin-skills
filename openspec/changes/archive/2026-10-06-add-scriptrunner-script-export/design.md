# Design

## Context

See proposal.md for the motivation. `src/tools/jira/scriptrunner.ts` already has these parts:
- **`requireScriptRunner`:** finds the Jira and ScriptRunner versions through UPM and checks the pair against `SUPPORT_MATRIX` (Jira 11.3.7 + ScriptRunner 10.14.0). It fails closed.
- **The `registry` type:** lists `scriptSearch` as `{filename, filepath, filetype}`.
- **`redact()`:** removes source from all outputs.

The client's `request` parses JSON responses; `HttpStatusError` messages include a short detail of the response body.

**Found in ScriptRunner's web resources** (captured JS of the Script Editor, module `editor/file` and `editor/fileTree`). Nothing has been confirmed on the instance yet: the host was unreachable when this change was written.
- **File content:** `GET /rest/scriptrunner/latest/idea/file?filePath=<relativePath>&rootPath=<rootPath>` returns `{result: {content: <base64>}}`. The editor decodes the base64 to text.
- **Writes on the same URL:** `PUT` (body: base64, `application/octet-stream`) saves a file and `DELETE` deletes it.
- **File tree:** `GET /rest/scriptrunner/latest/idea/scriptroots?showDirectories=true&groovyFilesOnly=true`. Its nodes carry `data: {name, isFile, rootPath, relativePath}`.

**Tree shape (from the editor's `LOAD_FILE_TREE` code):** `{result: [{info: {rootPath, defaultRoot}, files: {"<relativePath>": {isFile}}}]}`. Each Script Root has one flat map of relative paths, directories included. File sizes are not part of the shape the editor uses.

**Confirmed on the instance (task 1.1, Jira 11.3.7 + ScriptRunner 10.14.0, GET only, no content printed):**
- **Tree:** `GET idea/scriptroots` returns a bare JSON array (the editor's fetch helper is what adds `result`). Each element is `{info: {rootPath, defaultRoot}, files: {relativePath: {isFile, rootPath, lastModified}}}`.
  - No sizes are reported.
  - There is one Script Root: 26 `.groovy` files in 23 folders, including the folder exported in task 4.2.
  - `groovyFilesOnly=false` returns the same list; the root holds only Groovy files, so listing other file types is unconfirmed.
- **File:** `GET idea/file` returns `{content: <base64>, isDefaultRoot, rootPath}`, not wrapped.
  - The base64 is valid, and two reads of the same file give identical bytes.
  - The tree reports no size, so the decoded length could not be compared with a stored size.
- **Errors:** a missing file answers 404 with an empty body; a directory answers 400 `{error}`.
- **Registry:** `scriptSearch` lists 49 entries (`filename, filepath, filetype`), the same number as the tree's files plus folders.

**Implementation notes:**
- **Conflicts in `jira_get_scriptrunner_script`:** a differing `out` is reported as outcome `CONFLICT` in the result (exit 0, file kept), with a hint to use the export with `overwrite=true`. It is not an error.
- **Byte limit:** all-or-nothing, see Limits (decided with the user after task 1.1 showed that neither the tree nor `HEAD` reports sizes).
- **Version gate:** `SUPPORT_MATRIX` entries carry `operations`. `script-root-read` is verified for 11.3.7 + 10.14.0 (task 1.1); any other pair answers `Unsupported`.

## Goals / Non-Goals

**Goals:**
- Byte-exact local copies of Script Root files, with only metadata reaching the model.
- Strictly read-only toward Jira, gated by the verified version pair.

**Non-Goals:**
- Uploading, editing, moving or deleting server files.
- Exporting resource directories outside the Script Roots, or a ScriptRunner configuration export (`script/export`).
- Comparing local and server trees beyond per-file SHA-256.

## Decisions

### Endpoint and verification
The tools use the Script Editor's own read endpoint (`idea/file`) and tree (`idea/scriptroots`).
- **Request methods:** a dedicated read helper issues `GET` only. Its URL builder accepts no method, so the shared file URL can never be sent as `PUT` or `DELETE`.
- **Verification (task 1):** read-only calls on the instance capture the tree shape and these details:
  - whether `groovyFilesOnly=false` lists non-Groovy files;
  - the error answers for a missing file and for a directory;
  - that the base64 decodes to the stored bytes (checked against a file's size).
- **Support matrix:** each matrix entry gets an `operations` list. `script-root-read` is added for 11.3.7 + 10.14.0 only after the check. A pair without it answers `Unsupported` before any ScriptRunner request.
- **Alternative rejected:** `scriptSearch` gives paths but no content, and `script/export` exports configuration, not files.

### File list
The Script Root tree (`idea/scriptroots`) is the "current registry": it gives each file's `rootPath` and `relativePath`, which the file read needs.
- With several Script Roots, `path`/`root` are matched in every root. A path found in more than one root is an error naming the roots; an optional `script_root` selects one.
- `scriptSearch` is not used, because it lacks `rootPath`.

### Path safety
`path` and `root` are validated as POSIX relative paths before any request:
- not absolute;
- no `..` or `.` segments, no NUL;
- normalized with `path.posix.normalize`;
- matched exactly against tree nodes, never concatenated into a server path by itself.

Local targets are built from the server's `relativePath` minus `root` and resolved with `path.resolve`. The result must stay inside `output_dir`, checked after `realpath` of the existing parent directories, so an existing symbolic link cannot redirect a write.

### Content handling
- **Writing:** the base64 is decoded to a `Buffer` and written with `fs.writeFile` and no encoding conversion. CRLF line endings, UTF-8 without or with a BOM, and Unicode names stay as stored.
- **Atomic writes:** each file is written to a temporary file in the same directory, then renamed, so an interrupted run leaves no partial file.
- **No content in output:**
  - results, errors and the manifest carry only paths, sizes, SHA-256 and outcomes;
  - file-read errors are wrapped to report only the HTTP status (no body detail);
  - the decoded buffer is never returned from a handler.
- **Authorization headers:** they are never echoed. These tools have no dry-run request echo because they are reads.

### Conflicts and overwrite
For an existing local file, the system compares SHA-256: equal means `ALREADY-SATISFIED`, different means `CONFLICT`.
- **With `overwrite=true`:** the previous file is first copied to `<file>.bak-<UTC timestamp>` next to it, then the new content is renamed into place. The outcome is `REPLACED`, with the backup path.
- **`jira_get_scriptrunner_script`** has no `overwrite`: a differing `out` is a `CONFLICT` error. To refresh it, use the export with `overwrite=true`.
- **Alternative considered:** a separate explicit mode (for example `overwrite=replace-without-backup`). It was rejected as unnecessary, because the backup keeps the default safe.

### Limits
`max_files` defaults to 500 (cap 5000) and `max_total_bytes` to 20 MB (cap 200 MB).
- **File count:** checked from the tree before any content is read.
- **Bytes (decision: all-or-nothing):** Jira reports no sizes. The tree has none, and a `HEAD` on `idea/file` answers 200 without `Content-Length` (checked on the instance). So the export first downloads the selected files into memory, sequentially.
  - When the running total passes `max_total_bytes`, it stops and refuses. Nothing is written: no file, no output directory, no manifest.
  - Only after every selected file was downloaded within the limit does the write phase start.
  - Memory use is bounded by `max_total_bytes` (cap 200 MB).
- **Alternatives considered:** writing until the limit and marking the rest `FAILED` (partial exports), and dropping the byte limit.
- **Reads:** sequential, with 429 handling by the client, to stay gentle on Jira.

### Tool classification
Both tools are reads toward Jira, so there is no Jira confirmation dialog. They write only to the caller's local paths, like attachment downloads to `output_dir`. They are not plan items.

## Risks / Trade-offs

- **Internal endpoint, unconfirmed shape:** the endpoint is internal and its shape is not yet confirmed on the instance.
  - Mitigation: task 1 verifies it read-only, the support-matrix operation gate applies, and an unexpected response shape fails without writing.
- **The file URL also accepts PUT/DELETE:** mitigated by the GET-only helper and a test asserting that every request is `GET`.
- **Secrets in restored files:** the files are written as stored.
  - Mitigation: they are written only where the user asked, and the docs remind admins not to commit secrets.
  - The local output folder may be inside a git repository: the result notes that the files may contain credentials.
- **Large Script Roots:** limits with refusal before reading, and sequential reads.
- **Base64 decoding mismatch** (for example, the server re-encodes text): verified on the instance by comparing a file's tree size or `scriptSearch` data with the decoded length.

## Migration Plan

Additive tools; rollback removes them and the matrix operation.

## Open Questions

- Whether the tree reports file sizes (it only affects when the byte limit is checked, not the behavior).
