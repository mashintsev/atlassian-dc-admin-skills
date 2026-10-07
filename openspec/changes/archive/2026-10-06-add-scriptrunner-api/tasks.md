# Tasks

## 1. Establish the ScriptRunner API contract

- [x] 1.1 Record, with vendor references, that Adaptavist documents no public management API; collect read-only evidence on the project instance (WADL, key names and types of every list resource, ScriptRunner's admin JavaScript for the save/delete calls) for the exact pair Jira 11.3.7 + ScriptRunner 10.14.0, and record each resource, its executable and credential keys, the upsert mechanism, and the unsupported areas (Mail Handler, Behaviours) in `design.md`; exclude canned and script-running endpoints.
- [x] 1.2 Add the typed support matrix (verified pair, resources, allowed operations, executable and credential keys per type) and centralized discovery (Jira serverInfo version, ScriptRunner key/version/enabled via UPM); verify absent, disabled, malformed, inaccessible and unsupported states fail closed before any ScriptRunner request and 401/403 stay authorization errors.
- [x] 1.3 Add the per-type output allowlists and the recursive redaction of script/source/code/class/condition/SQL and credential/password/secret/token/user/jdbc keys; verify with unit tests on nested structures that none of them reach any output.
- [x] 1.4 Turn the captured structures into fixtures with synthetic values; verify the repository contains no real scripts, names, or credentials from the instance.

## 2. Reads

- [x] 2.1 Implement the read tools: script registry (file list), REST endpoints, resources, scheduled jobs, listeners, script fields and fragments, each behind discovery and the matrix; verify paths, response mapping and redaction with fake-client tests.
- [x] 2.2 Implement explicit unsupported answers for Mail Handler, Behaviours, resource changes and any operation outside the matrix; verify no ScriptRunner request is sent for them.

## 3. Enable/disable and notes

- [x] 3.1 Implement the unchanged-executable upsert: read the stored item, change only the allowed key, compare every other key before sending, post to `{restUrl}/{canned-script}`, read back and compare executable and other keys, redact every output; verify with fake-client tests including a server that alters the script (VerificationError) and a request for a disallowed key (rejected).
- [x] 3.2 Implement `disabled` for jobs, fragments and REST endpoints and notes for jobs, listeners, fragments and REST endpoints on top of 3.1; verify already-satisfied, dry run without script content, and that no job is triggered.

## 4. Integrate and validate

- [x] 4.1 Register the tools in their own groups, label them as unofficial ScriptRunner endpoints, update `SKILL.md` and `REFERENCE.md` (verified pair, coverage, unsupported areas, redaction); verify `list`/`describe` and the bounded-reads test.
- [x] 4.2 Run `pnpm test`, `pnpm run typecheck`, `pnpm run build` and `git diff --check`; check every read tool and the dry runs of the write tools on the project instance (no write executed) and confirm no script content or credential appears in any output.
