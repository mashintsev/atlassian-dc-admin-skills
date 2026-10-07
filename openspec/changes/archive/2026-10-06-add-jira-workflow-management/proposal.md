# Proposal

## Why

To set up and verify the status model for "bank incidents", an administrator needs to see a workflow completely (its statuses, its transitions and their directions) for a given project and issue type, compare it with another workflow, and build or change workflows. The skill can list workflows and assign them in schemes, but it cannot read their structure or edit them. Jira 11.3.6 exposes the workflow designer's REST resources (`/rest/workflowDesigner/1.0`) and the project-config resources (`/rest/projectconfig/1`), verified in the instance's WADL and with read-only calls.

## What Changes

- **Reading:** read a workflow by name or by project + issue type: statuses with category and initial status, transitions with source, target, global and looped flags, transition properties, draft state, and the projects and issue types that share it.
- **Comparison:** compare two workflows' status models (statuses, and transitions by status names).
- **Not readable:** conditions, validators and post-functions are reported as not readable through REST. The designer does not return them and the workflow XML export is behind websudo (verified). No values are guessed.
- **Editing:** add, change and remove statuses (also creating a new status); add, change and remove transitions, including global transitions. Changes to an active workflow go to its draft. Drafts can be published or discarded. Copying workflows is out of scope (no REST API; decided with the user).
- **Writes:** writes follow the change-plan rules and are gated to Jira 11.3.x.

## Capabilities

### New Capabilities

- `jira-workflow-reading`: Read and compare workflow structure; find the workflow of a project and issue type.
- `jira-workflow-editing`: Copy workflows, edit statuses and transitions, and manage drafts.

### Modified Capabilities

None.

## Impact

- **Code:** a new `src/tools/jira/workflows.ts` with tests. `jira_list_workflows` stays in `schemes.ts`, and the workflow scheme tools are unchanged.
- **APIs:**
  - internal `/rest/workflowDesigner/1.0/workflows*` and `/statuses`;
  - plugin `/rest/projectconfig/1/workflow`, `/workflow/project/{key}` and `/issuetype/{p}/{it}/workflow`;
  - public `/rest/api/2/workflow` and `/workflow/transitions/{id}/properties`.
- **Docs:** `SKILL.md` and `REFERENCE.md`.
