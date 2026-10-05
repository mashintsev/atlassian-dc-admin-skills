/**
 * Jira DC schemes and workflows.
 *
 * Read tools follow mcp-atlassian-for-admins (src/tools/schemes.ts, MIT);
 * permission grant, issue type and issue type scheme changes are dry-run guarded;
 * workflow schemes live in workflowSchemes.ts.
 */

import { z } from "zod";
import { ValidationError } from "../../errors.js";
import type { AtlassianClient } from "../../client.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, filterByName, guardedWrite, listArg, MAX_PAGE, nameFilterShape, pageShape, paginate, serverPage } from "../util.js";

const API = "/rest/api/2";

const HOLDER_TYPES = [
  "anyone", "applicationRole", "assignee", "group", "groupCustomField", "projectLead",
  "projectRole", "reporter", "user", "userCustomField",
] as const;

/** Human-readable holder: "group:jira-admins", "projectRole:Developers", "reporter". */
function holderLabel(h: any): string {
  if (!h) return "";
  const param =
    (h.type === "projectRole" && h.projectRole?.name) ||
    (h.type === "user" && h.user?.name) ||
    ((h.type === "userCustomField" || h.type === "groupCustomField") && h.field?.name) ||
    h.parameter;
  return param ? `${h.type}:${param}` : h.type;
}

async function getIssueTypeScheme(client: AtlassianClient, schemeId: number): Promise<any> {
  return client.get(`${API}/issuetypescheme/${schemeId}`, { expand: "issueTypes,defaultIssueType" });
}

export const jiraSchemeTools: ToolDef[] = [
  {
    name: "jira_list_permission_schemes",
    product: "jira",
    description: "Permission schemes with id, name and description (with_grant_counts=true also counts grants, a much larger response).",
    inputShape: { ...nameFilterShape, with_grant_counts: boolArg.optional() },
    async handler({ client }, args) {
      // endpoint has no paging or name filter; the grants are only expanded when counts are asked for
      const data = await client("jira").get(`${API}/permissionscheme`, args.with_grant_counts ? { expand: "permissions" } : undefined);
      return filterByName<any>(data?.permissionSchemes ?? [], args.name_contains).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description || undefined,
        grantCount: args.with_grant_counts ? (s.permissions ?? []).length : undefined,
      }));
    },
  },
  {
    name: "jira_get_permission_scheme",
    product: "jira",
    description:
      "Grants of a permission scheme grouped by permission key (optionally one permission, e.g. DELETE_ISSUES). " +
      "Each grant carries the id needed by jira_delete_permission_grant.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      permission: z.string().optional().describe("Only this permission key"),
    },
    async handler({ client }, args) {
      // only the expansions the holder labels use (group holders carry their name in `parameter`)
      const s = await client("jira").get(`${API}/permissionscheme/${args.scheme_id}`, { expand: "permissions,user,projectRole,field" });
      const grants: Record<string, Array<{ id: number; holder: string }>> = {};
      for (const g of s?.permissions ?? []) {
        if (args.permission && g.permission !== args.permission) continue;
        (grants[g.permission] ??= []).push({ id: g.id, holder: holderLabel(g.holder) });
      }
      return {
        id: s?.id,
        name: s?.name,
        description: s?.description ?? "",
        permissions: Object.fromEntries(Object.entries(grants).sort(([a], [b]) => a.localeCompare(b))),
      };
    },
  },
  {
    name: "jira_add_permission_grant",
    product: "jira",
    write: true,
    description:
      "Grant a permission in a scheme. holder_type/holder_parameter: group/<group name>, projectRole/<role id>, " +
      "user/<username>, applicationRole/<app key or empty = any logged-in user>, userCustomField|groupCustomField/" +
      "<customfield_N>, projectLead, reporter, assignee, anyone. permission: e.g. BROWSE_PROJECTS, ADMINISTER_PROJECTS.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      permission: z.string(),
      holder_type: z.enum(HOLDER_TYPES),
      holder_parameter: z.coerce.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const holder: Record<string, string> = { type: args.holder_type };
      if (args.holder_parameter !== undefined) holder.parameter = args.holder_parameter;
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/permissionscheme/${args.scheme_id}/permission`,
        json: { holder, permission: args.permission },
        summary: `Grant ${args.permission} to ${holderLabel(holder)} in permission scheme ${args.scheme_id}`,
      });
    },
  },
  {
    name: "jira_delete_permission_grant",
    product: "jira",
    write: true,
    description: "Remove one grant (id from jira_get_permission_scheme) from a permission scheme.",
    inputShape: { scheme_id: z.coerce.number().int(), grant_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/permissionscheme/${args.scheme_id}/permission/${args.grant_id}`,
        summary: `Delete grant ${args.grant_id} from permission scheme ${args.scheme_id}`,
      });
    },
  },
  {
    name: "jira_list_notification_schemes",
    product: "jira",
    description: "Notification schemes (server-side paging).",
    inputShape: { ...pageShape(50) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = await client("jira").get(`${API}/notificationscheme`, { startAt: offset, maxResults: limit });
      const items = (data?.values ?? []).map((s: any) => ({ id: s.id, name: s.name, description: s.description ?? "" }));
      return serverPage(items, offset, limit, data?.total, data?.isLast);
    },
  },
  {
    name: "jira_get_notification_scheme",
    product: "jira",
    description: "Who is notified on each event of a notification scheme.",
    inputShape: { scheme_id: z.coerce.number().int() },
    async handler({ client }, args) {
      // notificationType + parameter are enough; no user/group/role/field expansion
      const s = await client("jira").get(`${API}/notificationscheme/${args.scheme_id}`, { expand: "notificationSchemeEvents" });
      const events: Record<string, string[]> = {};
      for (const e of s?.notificationSchemeEvents ?? []) {
        events[e.event?.name ?? String(e.event?.id)] = (e.notifications ?? []).map((n: any) =>
          n.parameter ? `${n.notificationType}:${n.parameter}` : n.notificationType,
        );
      }
      return { id: s?.id, name: s?.name, events };
    },
  },
  {
    name: "jira_list_issue_security_schemes",
    product: "jira",
    description: "Issue security schemes with their default level.",
    inputShape: {},
    async handler({ client }) {
      const data = await client("jira").get(`${API}/issuesecurityschemes`);
      return (data?.issueSecuritySchemes ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        defaultSecurityLevelId: s.defaultSecurityLevelId ?? null,
      }));
    },
  },
  {
    name: "jira_get_issue_security_scheme",
    product: "jira",
    description: "Security levels of an issue security scheme.",
    inputShape: { scheme_id: z.coerce.number().int() },
    async handler({ client }, args) {
      const s = await client("jira").get(`${API}/issuesecurityschemes/${args.scheme_id}`);
      return {
        id: s?.id,
        name: s?.name,
        defaultSecurityLevelId: s?.defaultSecurityLevelId ?? null,
        levels: (s?.levels ?? []).map((l: any) => ({ id: l.id, name: l.name, description: l.description ?? "" })),
      };
    },
  },
  {
    name: "jira_list_workflows",
    product: "jira",
    description: "Workflows with description, step count and last modification.",
    inputShape: {
      ...nameFilterShape,
      name: z.string().optional().describe("Exact workflow name, filtered by Jira"),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      // endpoint has no paging; it filters only by exact name (workflowName)
      const workflows: any[] = (await client("jira").get(`${API}/workflow`, { workflowName: args.name })) ?? [];
      const items = filterByName(workflows, args.name_contains).map((w) => ({
        name: w.name,
        description: w.description ?? "",
        steps: w.steps,
        lastModifiedDate: w.lastModifiedDate,
        lastModifiedUser: w.lastModifiedUser,
        default: w.default ?? false,
      }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_list_issue_types",
    product: "jira",
    description: "All issue types with id, name and sub-task flag.",
    inputShape: { ...nameFilterShape, ...pageShape(100) },
    async handler({ client }, args) {
      // endpoint has no paging or name filter
      const types: any[] = (await client("jira").get(`${API}/issuetype`)) ?? [];
      const items = filterByName(types, args.name_contains).map((t) => ({
        id: t.id,
        name: t.name,
        subtask: t.subtask ?? false,
        description: t.description || undefined,
      }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_create_issue_type",
    product: "jira",
    write: true,
    description:
      "Create a global issue type (subtask=true for a sub-task type). It is not in any project until added to " +
      "the project's issue type scheme (jira_add_issue_types_to_scheme); map it in the workflow scheme with jira_set_workflow_scheme_mapping.",
    inputShape: {
      name: z.string().trim().min(1).max(60),
      description: z.string().optional(),
      subtask: boolArg.optional(),
      avatar_id: z.coerce.number().int().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      // Jira rejects duplicate names case-insensitively; fail early, also in a dry run
      const existing: any[] = (await c.get(`${API}/issuetype`)) ?? [];
      const clash = existing.find((t) => String(t.name ?? "").toLowerCase() === args.name.toLowerCase());
      if (clash) throw new ValidationError(`Issue type '${clash.name}' already exists (id ${clash.id})`);
      const json: Record<string, unknown> = { name: args.name };
      if (args.description !== undefined) json.description = args.description;
      json.type = args.subtask ? "subtask" : "standard";
      if (args.avatar_id !== undefined) json.avatarId = args.avatar_id;
      return guardedWrite(c, args, {
        method: "POST",
        path: `${API}/issuetype`,
        json,
        summary: `Create ${args.subtask ? "sub-task " : ""}issue type '${args.name}'`,
      });
    },
  },
  {
    name: "jira_list_issue_type_schemes",
    product: "jira",
    description: "Issue type schemes with id, name and description (jira_get_project_config shows a project's scheme).",
    inputShape: { ...nameFilterShape, ...pageShape(100) },
    async handler({ client }, args) {
      // endpoint has no paging or name filter
      const data = await client("jira").get(`${API}/issuetypescheme`);
      const schemes: any[] = Array.isArray(data) ? data : (data?.schemes ?? []);
      const items = filterByName(schemes, args.name_contains).map((s) => ({
        id: String(s.id),
        name: s.name,
        description: s.description || undefined,
      }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_get_issue_type_scheme",
    product: "jira",
    description: "An issue type scheme: its issue types, default issue type and the projects that use it (up to max_projects keys).",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      max_projects: z.coerce.number().int().min(0).max(MAX_PAGE).optional().describe("Project keys to list (default 50); projectCount is always the total"),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [s, projects] = await Promise.all([
        getIssueTypeScheme(c, args.scheme_id),
        c.get(`${API}/issuetypescheme/${args.scheme_id}/associations`),
      ]);
      const keys: string[] = (Array.isArray(projects) ? projects : []).map((p: any) => p.key);
      return {
        id: String(s?.id ?? args.scheme_id),
        name: s?.name,
        description: s?.description ?? "",
        defaultIssueTypeId: s?.defaultIssueType?.id ?? null,
        issueTypes: (s?.issueTypes ?? []).map((t: any) => ({ id: String(t.id), name: t.name, subtask: t.subtask ?? false })),
        projectCount: keys.length,
        projects: keys.slice(0, args.max_projects ?? 50),
      };
    },
  },
  {
    name: "jira_add_issue_types_to_scheme",
    product: "jira",
    write: true,
    description:
      "Add issue types (ids from jira_list_issue_types) to an issue type scheme, keeping its current types; " +
      "default_issue_type_id optionally changes the default. Projects using the scheme can then create these types.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      issue_type_ids: listArg.describe("Issue type ids, comma-separated or array"),
      default_issue_type_id: z.coerce.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [scheme, allTypes] = await Promise.all([getIssueTypeScheme(c, args.scheme_id), c.get(`${API}/issuetype`)]);
      const byId = new Map<string, any>((Array.isArray(allTypes) ? allTypes : []).map((t: any) => [String(t.id), t]));
      const unknown = args.issue_type_ids.filter((id: string) => !byId.has(id));
      if (unknown.length) throw new ValidationError(`Unknown issue type id(s): ${unknown.join(", ")}`);

      const current: string[] = (scheme?.issueTypes ?? []).map((t: any) => String(t.id));
      const added = [...new Set<string>(args.issue_type_ids)].filter((id) => !current.includes(id));
      if (!added.length) {
        throw new ValidationError(`Issue type scheme ${args.scheme_id} already contains ${args.issue_type_ids.join(", ")}`);
      }
      const issueTypeIds = [...current, ...added];
      const defaultIssueTypeId = args.default_issue_type_id ?? scheme?.defaultIssueType?.id;
      if (defaultIssueTypeId !== undefined && !issueTypeIds.includes(String(defaultIssueTypeId))) {
        throw new ValidationError(`Default issue type ${defaultIssueTypeId} is not in the scheme`);
      }

      // PUT replaces the whole scheme, so name, description and default are sent back unchanged
      const json: Record<string, unknown> = { name: scheme?.name, description: scheme?.description ?? "" };
      if (defaultIssueTypeId !== undefined) json.defaultIssueTypeId = String(defaultIssueTypeId);
      json.issueTypeIds = issueTypeIds;
      const names = added.map((id) => `${byId.get(id)?.name} (${id})`).join(", ");
      const defaultNote = args.default_issue_type_id ? `; default → ${byId.get(String(args.default_issue_type_id))?.name}` : "";
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/issuetypescheme/${args.scheme_id}`,
        json,
        summary: `Issue type scheme '${scheme?.name ?? args.scheme_id}': add ${names}${defaultNote}`,
      });
    },
  },
];
