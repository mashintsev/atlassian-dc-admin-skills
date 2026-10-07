# Spec Delta

## MODIFIED Requirements

### Requirement: Protect ScriptRunner script contents
The system SHALL omit script source from default listing output and SHALL NOT execute arbitrary script content as part of management operations.
All script and extension list/detail output SHALL use an explicit field allowlist and recursively redact nested script/source/code and credential, password, secret, or token fields.
Only the Script Root export tools (`jira_get_scriptrunner_script`, `jira_export_scriptrunner_scripts`) MAY read script source, and only to write it unredacted, byte for byte, to local files the caller named. Their output SHALL carry only metadata (paths, sizes, SHA-256, outcomes), never source.

#### Scenario: Default listing
- **WHEN** an administrator lists ScriptRunner scripts or extensions
- **THEN** the result contains metadata without source code

#### Scenario: Script execution is not a management operation
- **WHEN** a caller requests a script-management operation
- **THEN** the system does not execute Groovy source or invoke an arbitrary script execution endpoint

#### Scenario: Source restored to local files
- **WHEN** an administrator exports Script Root files
- **THEN** the source is written only to the named local files, unredacted
- **AND** the tool output contains no source
