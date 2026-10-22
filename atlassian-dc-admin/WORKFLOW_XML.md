# Complete workflow XML and same-workflow draft import

`jira_export_workflow_xml` exports one exact workflow name to a local XML/manifest generation. `jira_import_workflow_xml_draft` validates an edited file and, after the CLI's Apply/Cancel confirmation, writes only the draft of that same workflow on the source instance. Publishing remains a separate `jira_publish_workflow_draft` operation. Inactive/system workflow imports, cloning and cross-instance transfer are refused.

## Separate adapter installation

The tools require a repository-owned ScriptRunner custom endpoint. They do not install it automatically. Initial allowed policy: Jira 11.3.x / ScriptRunner 10.x, Jakarta endpoints. Local compilation evidence uses Jira 11.3.6 / ScriptRunner 10.11.1. Deployed and verified on Jira 11.3.7 / ScriptRunner 10.14.0: export, validation, draft write and publish of one active workflow. Also deployed on Jira 11.3.8 / ScriptRunner 10.17.0: export and validation verified.

Only after selecting a target instance and reviewing a concrete deployment change:

1. Compile the trusted files under `scripts/workflow-xml/` against that instance's jars. Keep every file except `WorkflowXmlEndpoints.groovy` under the `workflowxml/` package directory of its Script Root, one class per file: ScriptRunner resolves Script Root classes by file name, so a class declared inside another file fails with `unable to resolve class workflowxml.…`. `jira_push_scriptrunner_script` (expect `absent`) uploads them.
2. Set `adminGroup` in `WorkflowXmlEndpoints.groovy` to an existing administrator group. The empty default refuses registration. Register that file as a ScriptRunner REST endpoint in the Jira UI (the CLI cannot create registrations): Custom endpoint, Script = File with the path relative to the Script Root including folders, e.g. `common/rest/WorkflowXmlEndpoints.groovy`. A bare file name compiles but every call returns HTTP 500 `Cannot open URL: bundle://…`. Registration groups restrict access; each operation also checks the authenticated user's Jira ADMINISTER permission.
3. Verify authenticated GET metadata/export first. Installation and draft mutation require separate administrator authorization; fixture success does not grant it.

The adapter parses XML with the JDK parser (`DocumentBuilderFactory.newDefaultInstance()`): `newInstance()` returns the Apache Xerces bundled with Jira, which rejects the JAXP `accessExternalDTD`/`accessExternalSchema` properties. An empty `jira.fieldscreen.id` (a transition without a screen, as Jira exports it) is accepted; a non-empty one must name an existing screen.

Protocol v1 routes under `/rest/scriptrunner/latest/custom/`:

| Route | Method | Behavior |
| --- | --- | --- |
| `jiraWorkflowXml` | GET | Exact workflow metadata; `include_xml=true` exports selected live/draft XML |
| `jiraWorkflowXmlValidate` | POST | Structural/reference validation and normalization only; no draft creation or script execution |
| `jiraWorkflowXmlDraft` | PUT | Fingerprint-guarded draft creation/replacement; no publishing |

Every response declares protocol and product versions. GET requires `protocol=1`, `workflow`, optional `mode=live|draft` and `include_xml=true|false`. POST takes `{protocol:1,workflow,xml}`; PUT also takes `expectedLiveHash` and `expectedDraftHash` (explicit null for no draft). Bodies are bounded; XML hard cap is 20 MiB, request JSON 22 MiB.

Rollback removes/disables the registered endpoint and reverts the CLI/package revision. It does not publish, delete drafts or remove exported evidence.

## Export, edit, preview and apply

```sh
mkdir -p .scratch/workflow-before
node atlassian-dc-admin/scripts/atlassian-admin.mjs jira_export_workflow_xml workflow="Exact Workflow Name" output_dir=.scratch/workflow-before
```

The result returns `xml_file` and `manifest_file`. Default mode is live. Explicit draft export fails if no draft exists and never creates one. A SHA-derived generation directory publishes XML and manifest together. Identical bytes are already satisfied; different existing data is a conflict unless `overwrite=true` backs up and replaces the generation. Symlinks and non-regular artifacts are refused. On conflict, returned hashes describe proposed bytes rather than the retained old generation.

Keep the manifest and edit a UTF-8 copy of the XML. It records source/name, versions and original descriptor/file hashes. The original exported-file hash does not prohibit deliberate edits; current XML/manifest hashes bind the reviewed import. This provenance protects against an accidental target change, not deliberate manifest forgery.

```sh
node atlassian-dc-admin/scripts/atlassian-admin.mjs jira_import_workflow_xml_draft workflow="Exact Workflow Name" xml_file=.scratch/edited.xml manifest_file=.scratch/workflow-before/workflow-HASH/manifest.json
```

Substitute the actual returned manifest path. Default preview performs metadata GET and non-mutating validation POST. It returns draft creation/replacement, affected project ids/counts and file/live/draft hashes. It contains no XML or embedded scripts. Add `--plan=/tmp/workflow-draft.json` to save the preview, then use `apply /tmp/workflow-draft.json` for native confirmation, or repeat the tool with `dry_run=false` for Apply/Cancel. Exit 12 means Cancel: stop. Do not bypass confirmation.

Arrange an exclusive editing window before draft replacement. The Beehive lock serializes this adapter's writes across nodes; native Jira edits do not share it. Fingerprints reject observed drift, but there is no general Jira compare-and-swap guarantee for another administrator's edit in the final check/save window.

## Validation and failure states

Input DOCTYPE declarations, entities and external resolution are refused. Legacy XML with a DOCTYPE must be converted to the adapter's exported no-DOCTYPE format locally; never fetch its system URL. Source grammar is checked against Jira's bundled workflow DTD, resolved only from its jar, before OSWorkflow can discard unknown elements. This trusted internal validation does not enable caller-supplied DTDs or network resolution. Descriptor validation checks status/screen references without running rules. It does not prove publishability or runtime correctness. Rejections return a fixed reason, such as `Invalid XML at line N, column M` or `Workflow XML does not match Jira's workflow grammar at line N, column M`; line numbers refer to the submitted file. The CLI shows only reasons on its allowlist and withholds any other error text, which could quote XML or scripts.

Read-back compares normalized functional content, ignoring only Jira's root update-author/date metadata, and separately checks the unchanged live fingerprint. All rules, scripts, description metadata, steps and transitions participate. Already-satisfied drafts require no write. PUT has no automatic retries, including HTTP 429 or an ambiguous network result. A failed/ambiguous PUT attempts GET observation and reports bounded observed fingerprints, a newly observed draft, or unavailable observation. Draft creation followed by save failure can leave a draft; reread and prepare a new approved attempt. There is no automatic delete/publish rollback.

The administration link is a constructed candidate with `verified:false` until checked on the target instance. Full XML may contain sensitive scripts; keep it in ignored local storage and do not print it into agent output or plan files.

## Local verification

```sh
python3 test/workflow-xml/run.py --jar-root /path/to/maven/repository --java /path/to/java21/bin/java
node --import tsx --test test/unit/workflowXml.test.ts test/unit/clientResilience.test.ts
```

The compile runner's explicit `test/workflow-xml/classpath.json` selects jars and emits their SHA-256 hashes. Missing jars report UNAVAILABLE with a nonzero exit, never PASS. It removes Jira credentials from the child environment and compiles only the trusted repository adapter, not arbitrary uploaded scripts. Fixtures use inert descriptors and stores. Compilation/fixtures, deployed compatibility and live confirmation/read-back are distinct evidence categories; this is not the general Groovy preflight tool from the roadmap.
