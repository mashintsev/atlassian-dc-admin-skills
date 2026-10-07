# jira-scriptrunner-script-export Specification

## Purpose

Lets Jira Data Center administrators restore ScriptRunner Script Root files to local disk byte for byte, while the model sees only metadata and Jira is only read.

## Requirements

### Requirement: Read one Script Root file to a local file
The system SHALL provide `jira_get_scriptrunner_script` with `path` (relative to the Script Root) and a required `out` (local file path). It SHALL read the file's content from Jira and write it to `out` byte for byte. Its result SHALL contain only the path, size in bytes, SHA-256 of the content and the outcome.

Before any request, the system SHALL refuse:
- an absolute `path`;
- a `path` with a `..` segment;
- a `path` that normalizes to a location outside the Script Root.

It SHALL also refuse a `path` that names a directory or no file in the current Script Root tree.

When `out` already exists:
- with identical content (same SHA-256), the outcome SHALL be `ALREADY-SATISFIED`;
- with different content, the outcome SHALL be `CONFLICT` and the local file SHALL stay unchanged.

#### Scenario: Read one file
- **WHEN** an administrator reads `project-a/jobs/close.groovy` to `./project-a/jobs/close.groovy`
- **THEN** the local file holds exactly the bytes ScriptRunner stores
- **AND** the result shows the path, size, SHA-256 and `WRITTEN`, without any file content

#### Scenario: Path traversal
- **WHEN** `path` is `../etc/passwd`, `/opt/scripts/a.groovy` or `project-a/../../x.groovy`
- **THEN** the system refuses before any request to Jira

#### Scenario: Directory
- **WHEN** `path` names a directory of the Script Root
- **THEN** the system refuses and names the directory

### Requirement: Export a Script Root folder
The system SHALL provide `jira_export_scriptrunner_scripts` with `root` (a folder relative to the Script Root, validated like `path`), `output_dir`, an optional `overwrite` (default false) and an optional `manifest` (default `<output_dir>/scriptrunner-export-manifest.json`).

The export SHALL:
- read the current Script Root file tree and select files and directories inside `root`;
- recreate every registry directory under `output_dir` relative to `root`, including empty directories;
- keep exact bytes, including UTF-8 text, Unicode file names and line endings.

Each file's outcome SHALL be one of:
- `WRITTEN`: the local file was new;
- `ALREADY-SATISFIED`: an identical local file exists;
- `CONFLICT`: a different local file exists and `overwrite` is false, so it is kept unchanged;
- `REPLACED`: with `overwrite=true`, after the previous local file was first copied to a backup that the manifest names;
- `FAILED`: a read or write error, named without content.

The manifest SHALL list every selected directory with its Script Root path, local path and outcome (`CREATED`, `ALREADY-SATISFIED` or `FAILED`), and every selected file with the Script Root path, local path, size, SHA-256, outcome and any backup path. `outputDir`, directory paths, local file paths and backup paths in the manifest SHALL be relative to the invocation working directory so the manifest remains portable inside a project. The tool result SHALL summarize directory and file counts per outcome and the manifest path. The manifest and the result SHALL contain no file content. A server path whose local name would leave `output_dir` (for example through a symbolic link already present locally) SHALL be refused with outcome `FAILED` while the other directories and files continue.

#### Scenario: Restore a folder
- **WHEN** an administrator exports `root=project-a` to `output_dir=./project-a`
- **THEN** every directory and file under the Script Root folder `project-a`, including empty directories, exists under `./project-a` with the same relative path and bytes
- **AND** a manifest lists each file with size, SHA-256 and `WRITTEN`

#### Scenario: Re-run without changes
- **WHEN** the same export runs again and nothing changed on either side
- **THEN** every file is `ALREADY-SATISFIED` and no local file is modified

#### Scenario: Local file differs
- **WHEN** a local file differs from the server file and `overwrite` is false
- **THEN** that file is `CONFLICT`, stays unchanged, and the other files are exported

#### Scenario: Overwrite with backup
- **WHEN** the same export runs with `overwrite=true`
- **THEN** the differing local file is first copied to a backup, then replaced, and the manifest names the backup

### Requirement: Bounded, read-only and content-free toward the model
The tools SHALL send only GET requests to Jira and SHALL use the Script Editor's file read on all Jira 10.x/11.x + ScriptRunner 9.x/10.x combinations. The broader policy allowance SHALL NOT be described as runtime verification of every pair. Outside those major versions, they SHALL answer `Unsupported` before any ScriptRunner request.

An export SHALL refuse before reading any file content when the selection has more files than the file-count limit. Jira reports no file sizes, so the total-size limit is checked while the selected files are downloaded into memory, before anything is written. When the total passes the limit, the export SHALL stop downloading and write nothing: no file, no output directory and no manifest. Both limits have defaults and caps and are reported in the refusal.

File content SHALL NOT appear in:
- tool results, error messages or diagnostic output;
- change plans or the manifest.

Authorization headers SHALL NOT appear in any output. Content SHALL be sent nowhere except the named local files, and exported scripts SHALL NOT be executed.

#### Scenario: Unsupported major version pair
- **WHEN** Jira 12.0.0 runs ScriptRunner 10.13.2 and an administrator exports a folder
- **THEN** the system answers `Unsupported` and sends no ScriptRunner request

#### Scenario: Too many files
- **WHEN** the selected folder has more files than the file-count limit
- **THEN** the system refuses before reading any file content and reports the count and the limit

#### Scenario: Too many bytes
- **WHEN** the selected files together are larger than the total-size limit
- **THEN** the system refuses without writing any local file, directory or manifest, and reports the limit

#### Scenario: Error while reading
- **WHEN** Jira answers an error for one file
- **THEN** that file's outcome is `FAILED` with the HTTP status, and no response body or content appears in the output
