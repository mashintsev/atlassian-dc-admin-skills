/**
 * Jira DC project administration: config chain, roles, scheme assignment, archiving.
 *
 * The scheme-chain resolution is adapted from mcp-atlassian-for-admins
 * (src/tools/projects.ts, MIT) without its ScriptRunner-backed parts.
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, contains, dryRunShape, guardedWrite, listArg, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";

function compactProject(p: any): Record<string, unknown> {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    type: p.projectTypeKey,
    lead: p.lead?.name ?? null,
    category: p.projectCategory?.name ?? null,
    archived: p.archived ?? false,
  };
}

async function tryGet(client: AtlassianClient, path: string): Promise<any> {
  try {
    return await client.get(path);
  } catch (e) {
    if (isHttpStatusError(e)) return null;
    throw e;
  }
}

/** Resolve the schemes a project uses (DC 10+ endpoints; missing ones resolve to null/Default). */
export async function resolveProjectConfig(client: AtlassianClient, projectKey: string): Promise<Record<string, any>> {
  const key = seg(projectKey);
  const project = await client.get(`${API}/project/${key}`, { expand: "lead,projectCategory,issueTypes" });
  const [wf, notif, perm, sec] = await Promise.all([
    tryGet(client, `${API}/project/${key}/workflowscheme`),
    tryGet(client, `${API}/project/${key}/notificationscheme`),
    tryGet(client, `${API}/project/${key}/permissionscheme`),
    tryGet(client, `${API}/project/${key}/issuesecuritylevelscheme`),
  ]);

  // DC has no per-project endpoint for the issue type scheme: scan scheme associations.
  const issueTypeScheme = await (async () => {
    try {
      const data = await client.get(`${API}/issuetypescheme`);
      const schemes: any[] = Array.isArray(data) ? data : (data?.schemes ?? []);
      const associations = await boundedAll(
        schemes.map((s) => () => tryGet(client, `${API}/issuetypescheme/${s.id}/associations`)),
      );
      const i = associations.findIndex((projects) => (projects ?? []).some((p: any) => String(p?.key) === project.key));
      return i >= 0 ? { id: Number(schemes[i].id), name: schemes[i].name } : { id: null, name: "Default Issue Type Scheme" };
    } catch (e: any) {
      return { id: null, name: null, error: String(e?.message ?? e) };
    }
  })();

  return {
    ...compactProject(project),
    issueTypes: (project.issueTypes ?? []).map((t: any) => ({ id: t.id, name: t.name, subtask: t.subtask ?? false })),
    schemes: {
      workflowScheme: {
        id: wf?.id ?? null,
        name: wf ? wf.name : "Default",
        defaultWorkflow: wf?.defaultWorkflow ?? null,
        issueTypeMappings: wf?.issueTypeMappings ?? {},
      },
      issueTypeScheme,
      permissionScheme: { id: perm?.id ?? null, name: perm ? perm.name : "Default" },
      notificationScheme: { id: notif?.id ?? null, name: notif ? notif.name : "Default" },
      issueSecurityScheme: { id: sec?.id ?? null, name: sec?.name ?? null },
    },
  };
}

export const jiraProjectTools: ToolDef[] = [
  {
    name: "jira_list_projects",
    product: "jira",
    description: "Projects with key, name, type, lead and category. Filter by name/key fragment or category.",
    inputShape: {
      name_contains: z.string().optional().describe("Matches project name or key"),
      category: z.string().optional().describe("Exact category name"),
      include_archived: boolArg.optional(),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      // endpoint has no paging or name search: filter and page locally
      const projects: any[] =
        (await client("jira").get(`${API}/project`, {
          expand: "lead,projectCategory",
          includeArchived: args.include_archived ?? false,
        })) ?? [];
      const items = projects
        .map(compactProject)
        .filter((p) => contains(p.name, args.name_contains) || contains(p.key, args.name_contains))
        .filter((p) => !args.category || String(p.category ?? "").toLowerCase() === args.category.toLowerCase());
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_get_project_config",
    product: "jira",
    description:
      "A project's admin picture: lead, category, issue types, and its workflow (with issue type mappings), " +
      "issue type, permission, notification and issue security schemes.",
    inputShape: { project_key: z.string() },
    async handler({ client }, args) {
      return resolveProjectConfig(client("jira"), args.project_key);
    },
  },
  {
    name: "jira_list_roles",
    product: "jira",
    description: "Global project roles (id, name, description).",
    inputShape: {},
    async handler({ client }) {
      const roles: any[] = (await client("jira").get(`${API}/role`)) ?? [];
      return roles.map((r) => ({ id: r.id, name: r.name, description: r.description }));
    },
  },
  {
    name: "jira_get_project_roles",
    product: "jira",
    description: "Users and groups in every role of a project, or in one role when role_id is given.",
    inputShape: { project_key: z.string(), role_id: z.coerce.number().int().optional() },
    async handler({ client }, args) {
      const c = client("jira");
      const key = seg(args.project_key);
      let roleIds: Array<string | number>;
      if (args.role_id !== undefined) {
        roleIds = [args.role_id];
      } else {
        const links: Record<string, string> = (await c.get(`${API}/project/${key}/role`)) ?? {};
        roleIds = Object.values(links).map((url) => url.replace(/\/+$/, "").split("/").pop()!);
      }
      // one call per role (a handful per project), bounded concurrency
      const roles = await boundedAll(roleIds.map((id) => () => c.get(`${API}/project/${key}/role/${id}`)));
      return roles
        .map((role: any) => {
          const actors: any[] = role?.actors ?? [];
          return {
            id: role?.id,
            name: role?.name,
            users: actors.filter((a) => a.type === "atlassian-user-role-actor").map((a) => a.name).sort(),
            groups: actors.filter((a) => a.type === "atlassian-group-role-actor").map((a) => a.name).sort(),
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
  },
  {
    name: "jira_add_project_role_actors",
    product: "jira",
    write: true,
    description: "Add users and/or groups to a project role (existing members are kept).",
    inputShape: {
      project_key: z.string(),
      role_id: z.coerce.number().int(),
      users: listArg.optional(),
      groups: listArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const users: string[] = args.users ?? [];
      const groups: string[] = args.groups ?? [];
      if (users.length === 0 && groups.length === 0) throw new ValidationError("Pass users and/or groups");
      const body: Record<string, string[]> = {};
      if (users.length) body.user = users;
      if (groups.length) body.group = groups;
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/project/${seg(args.project_key)}/role/${args.role_id}`,
        json: body,
        summary: `Add ${[...users, ...groups].join(", ")} to role ${args.role_id} in ${args.project_key}`,
      });
    },
  },
  {
    name: "jira_remove_project_role_actor",
    product: "jira",
    write: true,
    description: "Remove one user or one group from a project role.",
    inputShape: {
      project_key: z.string(),
      role_id: z.coerce.number().int(),
      user: z.string().optional(),
      group: z.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (!args.user === !args.group) throw new ValidationError("Pass exactly one of user or group");
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/project/${seg(args.project_key)}/role/${args.role_id}`,
        params: { user: args.user, group: args.group },
        summary: `Remove ${args.user ?? args.group} from role ${args.role_id} in ${args.project_key}`,
      });
    },
  },
  {
    name: "jira_set_project_permission_scheme",
    product: "jira",
    write: true,
    description: "Assign a permission scheme to a project.",
    inputShape: { project_key: z.string(), scheme_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/project/${seg(args.project_key)}/permissionscheme`,
        json: { id: args.scheme_id },
        summary: `Assign permission scheme ${args.scheme_id} to ${args.project_key}`,
      });
    },
  },
  {
    name: "jira_archive_project",
    product: "jira",
    write: true,
    description: "Archive a project (read-only and hidden; reversible with jira_restore_project).",
    inputShape: { project_key: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/project/${seg(args.project_key)}/archive`,
        summary: `Archive project ${args.project_key}`,
      });
    },
  },
  {
    name: "jira_restore_project",
    product: "jira",
    write: true,
    description: "Restore an archived project.",
    inputShape: { project_key: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/project/${seg(args.project_key)}/restore`,
        summary: `Restore project ${args.project_key}`,
      });
    },
  },
];
