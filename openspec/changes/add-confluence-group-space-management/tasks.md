# Tasks

## 1. Regression fixtures and user identity

- [x] 1.1 Add synthetic modern/legacy user-search and space-category/permission fixtures, including the 67/52/50/51 cardinality dataset; verify no production hosts, emails, user keys, space names or authentication material appear in fixtures.
- [x] 1.2 Correct `confluence_find_users` mapping in `users.ts` for modern and legacy fields, retaining actionable identifiers and reporting unknown identity shapes; verify modern results no longer produce empty full/JSON items and legacy results still work.
- [x] 1.3 Add exact active user resolution for the preparation workflow, including email-shaped usernames and exact-email fallback; verify ambiguous, truncated, email-mismatched, unavailable and inactive cases block grants in fake-server tests.
- [ ] 1.4 Move JSON/full plan-save notifications off stdout in `cli.ts`; verify dry-run-with-plan stdout parses as one JSON document and compact output remains readable.

## 2. Space categories and group discovery

- [x] 2.1 Add and register the complete space-category read tool using `metadata.labels`, team-prefix filtering and opaque server continuations; verify page-label separation, empty/malformed responses, multi-page results and capped or unsafe-continuation outcomes.
- [x] 2.2 Add and register the additive category write tool with exact supported name validation, dry-run default and native plan integration; verify POST path encoding, no replacement body, no dry-run mutation, invalid-input rejection and preservation of existing categories after read-back.
- [x] 2.3 Add exact group discovery across current/archived and global/personal scopes with bounded permission reads; verify exact group matching, stable-key casing, group existence, all-page enumeration, deduplication and grants without view access.
- [x] 2.4 Add audit completeness and visibility/count-cross-check output; verify read failures, unknown shapes, repeated cursors and scan caps cannot become complete results, and optional filters do not produce invalid site-count comparisons.

## 3. Native mixed-plan preparation

- [x] 3.1 Define and validate the version-2 space workflow plan contract in the plan/workflow modules, including target, immutable selector, stable identities, desired state, baseline preservation state and allowed native tool items; verify malformed, unknown-version and cross-target plans fail before mutation while existing version-1 tests pass.
- [x] 3.2 Implement read-only reconciliation that collects complete state, retains satisfied objective spaces and creates only missing category/direct-grant items; verify the synthetic dataset produces 50 category items and 51 grants (two admin-only, 49 read-plus-admin), with no writes.
- [x] 3.3 Add `prepare-space-updates` CLI parsing, explicit required inputs, optional scope filters, fresh-file protection, restrictive file permissions and machine-readable summaries; verify empty selection, already-satisfied objectives and incomplete audits yield explicit results without accidental execution or plan overwrite.
- [x] 3.4 Extend native `plan` rendering to show workflow target, scope, identity, completeness and mixed item counts; verify a reviewer can identify the affected spaces and exact requests without loading unrelated content.

## 4. Confirmed execution and durable outcomes

- [x] 4.1 Add version-2 preflight validation of configured target, active stable user and group-view preconditions, excluding already-satisfied items from the checklist; verify target/identity/access drift causes zero affected mutations and does not expand the approved selection.
- [x] 4.2 Route mixed workflow plans through the existing native confirmation policy and subset selection; verify cancellation/unavailable outcomes preserve exits 12/13 and send no writes, and selected subsets execute only approved category/grant items.
- [x] 4.3 Add per-item state/fingerprint rechecks and serial additive execution through registered write handlers; verify already-satisfied work is skipped and existing categories, user permissions and group membership are not replaced or revoked.
- [x] 4.4 Persist atomic restrictive-permission outcome files after each item and fail fast on workflow mutation errors; verify completed/failed/unselected/unattempted states survive a mid-batch failure and existing generic version-1 behavior remains unchanged.
- [x] 4.5 Support fresh preparation after partial execution rather than blind replay; verify state-based retry excludes successful/satisfied work, retains previous evidence and confirms only remaining mutations.

## 5. Verification and skill guidance

- [x] 5.1 Add a read-only `verify` command and post-apply verification covering all objective spaces, desired team category/direct read/admin grants, group access and baseline preservation; verify unknown reads, missing desired state and lost prior assignments prevent overall verified success.
- [x] 5.2 Add compact and JSON summaries distinguishing executed, already satisfied, failed, drifted, unselected, unattempted and verification-failed states; verify partial subsets cannot be presented as a completed all-space objective.
- [ ] 5.3 Add the on-demand `SPACE_WORKFLOWS.md` guide and a short `SKILL.md` dispatcher pointer, with synthetic prepare/review/apply/verify examples, direct versus inherited permissions, completeness limits, native confirmation and retry instructions; verify examples require no custom production write scripts and honor an already expressed batch-execution choice.
- [ ] 5.4 Update README evidence/compatibility wording and regenerate the reference and bundled CLI; verify new tools and commands are discoverable, the guide ships inside the skill directory, English project instructions are followed and observed 10.2.18 operation evidence is distinguished from the new workflow's test status.

## 6. Integration validation

- [ ] 6.1 Run the complete synthetic prepare/review/apply/verify flow with injected confirmation and fake REST transport; verify exactly 101 intended requests, 52 satisfied verified spaces, preserved prior assignments and zero remote mutations during prepare/verify.
- [ ] 6.2 Run integrated negative-path cases for incomplete discovery, category pagination limits, user ambiguity, target/access drift, declined/unavailable confirmation, partial selection, request failure and forbidden read-back; verify each expected exit/state and absence of unauthorized mutations.
- [ ] 6.3 Run `npm run typecheck`, `npm test`, `npm run build`, bundled `list`/`describe` smoke checks, machine-readable output parsing, and `git diff --check`; verify existing suites pass and generated documentation/bundle match source.
- [ ] 6.4 Run strict OpenSpec validation and review delivered artifact links/privacy boundaries; document any untested platform behavior and keep live mutation testing optional until a separate target and concrete plan are authorized.
