# Tasks

## 1. Establish the ScriptRunner API contract

- [ ] 1.1 Verify the official ScriptRunner REST API by Jira and ScriptRunner version for the script registry, jobs, listeners, fields, Behaviours, UI Fragments, REST Endpoints, Resources, and Mail Handler; record supported reads, mutations, permissions, and unsupported operations in a versioned support matrix with vendor references.
- [ ] 1.2 Define typed inputs and compact response shapes for each verified operation; verify that unknown plugin versions and unsupported resource operations fail explicitly in tests rather than using guessed routes.

## 2. Implement script and extension management

- [ ] 2.1 Add Jira tools for verified script-registry, REST Endpoint, and Resource operations and register them by area; verify documented request paths, encoding, and response mapping with fake-client tests.
- [ ] 2.2 Add only verified configuration mutations through `guardedWrite()`; verify dry-run sends no request and confirmed tests send only the validated request.
- [ ] 2.3 Omit script source from default output and exclude script execution operations; verify source is absent from default list results and no handler invokes script execution.
- [ ] 2.4 Document this area's supported resources, version limits, and operations in the dispatcher/reference; verify examples match registered tool names and arguments.

## 3. Implement automation management

- [ ] 3.1 Add Jira tools for verified job, listener, and Mail Handler inspection and configuration; verify request mapping and version-specific responses with fake-client tests.
- [ ] 3.2 Add supported automation configuration mutations through `guardedWrite()` and exclude job-trigger operations; verify dry-run, confirmed requests, and absence of job execution in tests.
- [ ] 3.3 Document supported automation operations and the no-job-trigger boundary; verify CLI `list` and `describe` expose the documented tools.

## 4. Implement UI configuration management

- [ ] 4.1 Add Jira tools for verified ScriptRunner field, Behaviour, and UI Fragment operations; verify request mapping, resource identity, and unsupported cases with fake-client tests.
- [ ] 4.2 Add supported UI configuration mutations through `guardedWrite()`; verify dry-run sends no request and confirmed tests target only the selected resource.
- [ ] 4.3 Document supported UI resources and version limits; verify the generated reference describes the implemented inputs and outputs.

## 5. Integrate and validate

- [ ] 5.1 Register all tools in the existing area-grouped registry and update the skill dispatcher and generated `REFERENCE.md`; verify every documented tool is discoverable through `list` and `describe`.
- [ ] 5.2 Verify tests cover unsupported versions, permission errors, safe source handling, and guarded writes across all three domains; run `pnpm test` and confirm existing Jira tools remain unchanged.
- [ ] 5.3 Run `pnpm run typecheck`, `pnpm run build`, and `git diff --check`; verify generated artifacts match source and no live ScriptRunner mutations were used for validation.
