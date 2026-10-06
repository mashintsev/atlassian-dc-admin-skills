/** Aggregated registry of all tools, grouped by area (the groups also drive REFERENCE.md). */

import type { ToolDef } from "./types.js";
import { jiraSystemTools } from "./jira/system.js";
import { jiraUserTools } from "./jira/users.js";
import { jiraProjectTools } from "./jira/projects.js";
import { jiraSchemeTools } from "./jira/schemes.js";
import { jiraWorkflowSchemeTools } from "./jira/workflowSchemes.js";
import { jiraFieldTools } from "./jira/fields.js";
import { jiraScreenTools } from "./jira/screens.js";
import { jiraCustomFieldTools } from "./jira/customFields.js";
import { jiraFieldOptionTools } from "./jira/fieldOptions.js";
import { jiraFieldConfigurationTools } from "./jira/fieldConfigurations.js";
import { jiraIssueTools } from "./jira/issues.js";
import { jiraProjectMetaTools } from "./jira/projectMeta.js";
import { jiraAgileTools } from "./jira/agile.js";
import { jiraBoardConfigTools } from "./jira/boardConfig.js";
import { jiraLinkTools } from "./jira/links.js";
import { jiraWorklogTools } from "./jira/worklog.js";
import { jiraAttachmentTools } from "./jira/attachments.js";
import { jiraCollabTools } from "./jira/collab.js";
import { jiraInsightTools } from "./jira/insights.js";
import { jiraServiceDeskTools } from "./jira/servicedesk.js";
import { jiraRequestTypeTools } from "./jira/requestTypes.js";
import { jiraSlaTools } from "./jira/sla.js";
import { jiraQueueTools } from "./jira/queues.js";
import { confluenceSystemTools } from "./confluence/system.js";
import { confluenceUserTools } from "./confluence/users.js";
import { confluenceSpaceTools } from "./confluence/spaces.js";
import { confluenceSpaceCategoryTools } from "./confluence/spaceCategories.js";
import { confluenceSpaceDiscoveryTools } from "./confluence/spaceDiscovery.js";
import { confluencePageTools } from "./confluence/pages.js";
import { confluenceCommentTools } from "./confluence/comments.js";
import { confluenceLabelTools } from "./confluence/labels.js";
import { confluenceAttachmentTools } from "./confluence/attachments.js";
import { assetsStructureTools } from "./assets/structure.js";
import { assetsObjectTools } from "./assets/objects.js";
import { pluginTools } from "./platform/plugins.js";
import { auditTools } from "./platform/audit.js";

export const TOOL_GROUPS: Array<[string, ToolDef[]]> = [
  ["Jira admin — system", jiraSystemTools],
  ["Jira admin — users and groups", jiraUserTools],
  ["Jira admin — projects and roles", jiraProjectTools],
  ["Jira admin — schemes and workflows", jiraSchemeTools],
  ["Jira admin — workflow schemes", jiraWorkflowSchemeTools],
  ["Jira admin — custom fields", [...jiraFieldTools, ...jiraCustomFieldTools, ...jiraFieldOptionTools]],
  ["Jira admin — field configurations", jiraFieldConfigurationTools],
  ["Jira admin — screens", jiraScreenTools],
  ["Jira — issues, search, comments, transitions", jiraIssueTools],
  ["Jira — project metadata and versions", jiraProjectMetaTools],
  ["Jira — boards and sprints", jiraAgileTools],
  ["Jira — board configuration", jiraBoardConfigTools],
  ["Jira — links and epics", jiraLinkTools],
  ["Jira — worklog", jiraWorklogTools],
  ["Jira — attachments", jiraAttachmentTools],
  ["Jira — assignable users and watchers", jiraCollabTools],
  ["Jira — dates, SLA, development info, project analysis", jiraInsightTools],
  ["Jira Service Management", jiraServiceDeskTools],
  ["Jira Service Management — request types and forms", jiraRequestTypeTools],
  ["Jira Service Management — queues", jiraQueueTools],
  ["Jira Service Management — SLAs and calendars", jiraSlaTools],
  ["Jira Assets — schemas, object types, attributes, statuses", assetsStructureTools],
  ["Jira Assets — objects, AQL, history", assetsObjectTools],
  ["Confluence admin — system", confluenceSystemTools],
  ["Confluence admin — users and groups", confluenceUserTools],
  ["Confluence admin — spaces and permissions", [...confluenceSpaceTools, ...confluenceSpaceCategoryTools, ...confluenceSpaceDiscoveryTools]],
  ["Confluence — pages and search", confluencePageTools],
  ["Confluence — comments", confluenceCommentTools],
  ["Confluence — labels", confluenceLabelTools],
  ["Confluence — attachments", confluenceAttachmentTools],
  ["Both products — apps (UPM)", pluginTools],
  ["Both products — audit log", auditTools],
];

export const ALL_TOOLS: ToolDef[] = TOOL_GROUPS.flatMap(([, tools]) => tools);

export function findTool(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

export type { ToolDef, ToolContext } from "./types.js";
