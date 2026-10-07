/**
 * Jira DC project administration: config chain, roles, scheme assignment, archiving.
 *
 * The scheme-chain resolution is adapted from mcp-atlassian-for-admins
 * (src/tools/projects.ts, MIT) without its ScriptRunner-backed parts.
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, capList, contains, dryRunShape, fullListsShape, guardedWrite, listArg, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";

/** Members of a project role as `user:<name>` / `group:<name>` labels. */
async function roleActors(client: AtlassianClient, projectKey: string, roleId: number): Promise<string[]> {
  const role = await client.get(`${API}/project/${seg(projectKey)}/role/${roleId}`);
  return (role?.actors ?? [])
    .map((a: any) => (a.type === "atlassian-user-role-actor" ? `user:${a.name}` : a.type === "atlassian-group-role-actor" ? `group:${a.name}` : undefined))
    .filter(Boolean);
}

/** Read the target back and throw a VerificationError with what was observed when the check fails. */
async function verify<T>(read: () => Promise<T>, ok: (v: T) => boolean, message: string): Promise<T> {
  const v = await read();
  if (!ok(v)) throw new VerificationError(message, v);
  return v;
}

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

/** A 404 means "none" (the default applies); any other HTTP error is reported, never read as the default. */
async function tryGet(client: AtlassianClient, path: string): Promise<any> {
  try {
    return await client.get(path);
  } catch (e) {
    if (isHttpStatusError(e)) return e.status === 404 ? null : { readError: `HTTP ${e.status}` };
    throw e;
  }
}

/** Summary of one scheme read: its id/name, the default when absent, or the read error. */
function schemeOf(read: any, fallback: string | null, extra: (r: any) => Record<string, unknown> = () => ({})) {
  if (read?.readError) return { id: null, name: null, error: read.readError };
  return { id: read?.id ?? null, name: read ? read.name : fallback, ...extra(read) };
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
      const failed = associations.filter((a) => a?.readError).length;
      const i = associations.findIndex((projects) => Array.isArray(projects) && projects.some((p: any) => String(p?.key) === project.key));
      if (i < 0 && failed) return { id: null, name: null, error: `${failed} scheme association read(s) failed` };
      return i >= 0 ? { id: Number(schemes[i].id), name: schemes[i].name } : { id: null, name: "Default Issue Type Scheme" };
    } catch (e: any) {
      return { id: null, name: null, error: String(e?.message ?? e) };
    }
  })();

  return {
    ...compactProject(project),
    issueTypes: (project.issueTypes ?? []).map((t: any) => ({ id: t.id, name: t.name, subtask: t.subtask ?? false })),
    schemes: {
      workflowScheme: schemeOf(wf, "Default", (r) => ({ defaultWorkflow: r?.defaultWorkflow ?? null, issueTypeMappings: r?.issueTypeMappings ?? {} })),
      issueTypeScheme,
      permissionScheme: schemeOf(perm, "Default"),
      notificationScheme: schemeOf(notif, "Default"),
      issueSecurityScheme: schemeOf(sec, null),
    },
  };
}

/** Archive or restore a project, judged by the project's `archived` flag before and after. */
async function setArchived(client: AtlassianClient, args: Record<string, any>, archived: boolean) {
  const verb = archived ? "archive" : "restore";
  const summary = `${archived ? "Archive" : "Restore"} project ${args.project_key}`;
  const read = () => client.get(`${API}/project/${seg(args.project_key)}`);
  if (Boolean((await read())?.archived) === archived) return alreadySatisfied(summary, archived ? "the project is already archived" : "the project is not archived");
  const req = { method: "PUT" as const, path: `${API}/project/${seg(args.project_key)}/${verb}`, summary };
  if (args.dry_run !== false) return guardedWrite(client, args, req);
  const result = await guardedWrite(client, args, req);
  await verify(read, (p: any) => Boolean(p?.archived) === archived, `${summary}: the project's archived flag did not change`);
  return result;
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
    narrowing: ["role_id", "full_lists"],
    inputShape: { project_key: z.string(), role_id: z.coerce.number().int().optional(), ...fullListsShape },
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
          const out: Record<string, any> = { id: role?.id, name: role?.name };
          capList(out, "users", actors.filter((a) => a.type === "atlassian-user-role-actor").map((a) => a.name).sort(), args.full_lists);
          capList(out, "groups", actors.filter((a) => a.type === "atlassian-group-role-actor").map((a) => a.name).sort(), args.full_lists);
          return out;
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
  },
  {
    name: "jira_add_project_role_actors",
    product: "jira",
    write: true,
    invalidates: [],
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
      const c = client("jira");
      const wanted = [...users.map((u) => `user:${u}`), ...groups.map((g) => `group:${g}`)];
      const summary = `Add ${[...users, ...groups].join(", ")} to role ${args.role_id} in ${args.project_key}`;
      const current = await roleActors(c, args.project_key, args.role_id);
      const missing = wanted.filter((w) => !current.includes(w));
      if (!missing.length) return alreadySatisfied(summary, "the role already has these members");
      // only the missing actors are sent; Jira rejects adding an existing one
      const body: Record<string, string[]> = {};
      const missingUsers = missing.filter((m) => m.startsWith("user:")).map((m) => m.slice(5));
      const missingGroups = missing.filter((m) => m.startsWith("group:")).map((m) => m.slice(6));
      if (missingUsers.length) body.user = missingUsers;
      if (missingGroups.length) body.group = missingGroups;
      const req = { method: "POST" as const, path: `${API}/project/${seg(args.project_key)}/role/${args.role_id}`, json: body, summary };
      if (args.dry_run !== false) {
        return {
          ...(await guardedWrite(c, args, req)),
          identity: { op: "add-role-actors", project: args.project_key, role: args.role_id, actors: [...wanted].sort() },
          state: { present: wanted.filter((w) => current.includes(w)).sort() },
        };
      }
      const result = await guardedWrite(c, args, req);
      const back = await verify(() => roleActors(c, args.project_key, args.role_id), (a) => wanted.every((w) => a.includes(w)), `${summary}: the role does not show every member afterwards`);
      return { ...result, result: { actors: back } };
    },
  },
  {
    name: "jira_remove_project_role_actor",
    product: "jira",
    write: true,
    invalidates: [],
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
      const c = client("jira");
      const actor = args.user ? `user:${args.user}` : `group:${args.group}`;
      const summary = `Remove ${args.user ?? args.group} from role ${args.role_id} in ${args.project_key}`;
      if (!(await roleActors(c, args.project_key, args.role_id)).includes(actor)) return alreadySatisfied(summary, "not a member of the role");
      const req = { method: "DELETE" as const, path: `${API}/project/${seg(args.project_key)}/role/${args.role_id}`, params: { user: args.user, group: args.group }, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "remove-role-actor", project: args.project_key, role: args.role_id, actor }, state: { present: true } };
      const result = await guardedWrite(c, args, req);
      await verify(() => roleActors(c, args.project_key, args.role_id), (a) => !a.includes(actor), `${summary}: still a member afterwards`);
      return result;
    },
  },
  {
    name: "jira_set_project_permission_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Assign a permission scheme to a project.",
    inputShape: { project_key: z.string(), scheme_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Assign permission scheme ${args.scheme_id} to ${args.project_key}`;
      const read = () => c.get(`${API}/project/${seg(args.project_key)}/permissionscheme`);
      const current = await read();
      if (Number(current?.id) === args.scheme_id) return alreadySatisfied(summary, "the project already uses this permission scheme");
      const req = { method: "PUT" as const, path: `${API}/project/${seg(args.project_key)}/permissionscheme`, json: { id: args.scheme_id }, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "set-permission-scheme", project: args.project_key, scheme: args.scheme_id }, state: { scheme: current?.id ?? null } };
      const result = await guardedWrite(c, args, req);
      const back = await verify(read, (s: any) => Number(s?.id) === args.scheme_id, `${summary}: the project reports another scheme afterwards`);
      return { ...result, result: { id: back?.id, name: back?.name } };
    },
  },
  {
    name: "jira_archive_project",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage", "screen-usage"],
    description: "Archive a project (read-only and hidden; reversible with jira_restore_project).",
    inputShape: { project_key: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return setArchived(client("jira"), args, true);
    },
  },
  {
    name: "jira_restore_project",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage", "screen-usage"],
    description: "Restore an archived project.",
    inputShape: { project_key: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return setArchived(client("jira"), args, false);
    },
  },
];
