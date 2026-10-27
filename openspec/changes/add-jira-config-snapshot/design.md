# Design

## Context

`adapters/workflow-xml/` already ships server-side ScriptRunner code for what REST cannot do. The snapshot follows the same model: a file endpoint in the Script Root, deployed and owned by the administrator, read-only.

## Findings (Jira DC 11.3.8, ScriptRunner 10.17.0, JSM 11.3.8, Automation 11.3.8)

- Jira 11 resolves only `jakarta.ws.rs` and `jakarta.servlet`; a `javax` import fails the compile.
- The third closure parameter of `CustomEndpointDelegate` (`HttpServletRequest`) gives the caller's `Cookie`/`Authorization`, and `request.localPort` the Tomcat connector, so REST can be called from inside the server without a proxy round trip (`http://127.0.0.1:<port><contextPath>`, `baseUrl` as fallback).
- ScriptRunner report: `GET /rest/scriptrunner/latest/script/export/` (`ScriptExportEndpoint.generateReport`, `application/zip`), the same archive as the UI export. Without parameters it holds only enabled items; `?isActive=false` adds disabled workflow functions and behaviours, so a disabled item in the snapshot is not mistaken for a deleted one. Behaviours configuration is also at `GET /rest/scriptrunner/behaviours/latest/admin/behaviour`, but the report already contains it.
- Automation: `GET /rest/cb-automation/latest/project/{projectId}/rule/export` (`RuleResource.export`); `GLOBAL` exports every rule.
- JSM forms: `GET /rest/servicedesk/1/servicedesk/{requestTypeId}/request-type-fields/{visible|hidden}` (internal; hidden rows carry the preset values); SLAs: `GET /rest/servicedesk/1/servicedesk/agent/{projectKey}/sla/metrics`.
- After a redeploy that does not compile, ScriptRunner keeps serving the old class and answers `Cannot open URL: bundle://…/<file>.groovy`; pressing Update on the endpoint shows the compile error.

## Decisions

- One zip, one JSON per object plus TSV indexes, so an agent greps one index and opens one file. Field configurations keep only exception items (hidden, required, non-default renderer).
- Every object and every REST part is wrapped: a failure is appended to `errors.json` and the export continues. `skip` leaves out slow or absent sections.
- The ScriptRunner report and the Automation export are embedded as `scriptrunner-report.zip` and `automation-rules.json`; `unpack.py` extracts the report into `jira-config/scriptrunner/` so the cache is replaced as a whole on every unpack.
- The local instance folder is resolved from `meta.baseUrl` through `instances.json`; an unknown host is refused unless `--instance` is given, so a test instance cannot overwrite production by accident.
- Objects of Assets are not exported (data, not configuration).

## Risks

- Internal JSM and ScriptRunner/Automation URLs may move between versions: the probe script lists the current ones.
- The snapshot holds script code, internal URLs and role members; the README and SKILL.md say to keep it local.
