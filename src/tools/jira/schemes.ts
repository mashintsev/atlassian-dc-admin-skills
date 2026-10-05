/**
 * Jira DC schemes and workflows.
 *
 * Read tools follow mcp-atlassian-for-admins (src/tools/schemes.ts, MIT);
 * permission grant changes are dry-run guarded.
 */

import { z } from "zod";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, filterByName, guardedWrite, nameFilterShape, pageShape, paginate, serverPage } from "../util.js";

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
    name: "jira_get_workflow_scheme",
    product: "jira",
    description: "Workflow scheme: default workflow and issue type -> workflow mappings.",
    inputShape: { scheme_id: z.coerce.number().int() },
    async handler({ client }, args) {
      const s = await client("jira").get(`${API}/workflowscheme/${args.scheme_id}`);
      return {
        id: s?.id,
        name: s?.name,
        description: s?.description ?? "",
        defaultWorkflow: s?.defaultWorkflow,
        issueTypeMappings: s?.issueTypeMappings ?? {},
        draft: s?.draft ?? false,
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
];
