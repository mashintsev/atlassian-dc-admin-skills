/**
 * Jira DC schemes and workflows.
 *
 * Read tools follow mcp-atlassian-for-admins (src/tools/schemes.ts, MIT);
 * permission grant, issue type and issue type scheme changes are dry-run guarded;
 * workflow schemes live in workflowSchemes.ts.
 */

import { z } from "zod";
import { ValidationError, VerificationError } from "../../errors.js";
import type { AtlassianClient } from "../../client.js";
import type { ToolDef } from "../types.js";
import { issueTypePlaceholder, resolveIssueType } from "./issueTypeRefs.js";
import { alreadySatisfied, boolArg, dryRunShape, filterByName, guardedWrite, listArg, MAX_PAGE, nameFilterShape, pageShape, paginate, serverPage } from "../util.js";

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

/** A holder as sent in a grant: `type:parameter`, or the bare type when it takes no parameter. */
const holderKey = (h: any) => (h?.parameter !== undefined && h?.parameter !== null && h?.parameter !== "" ? `${h.type}:${h.parameter}` : String(h?.type));

/** The grants of a permission scheme (raw, with their ids and holders). */
async function schemeGrants(client: AtlassianClient, schemeId: number): Promise<any[]> {
  const s = await client.get(`${API}/permissionscheme/${schemeId}`, { expand: "permissions" });
  return s?.permissions ?? [];
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
      const c = client("jira");
      const holder: Record<string, string> = { type: args.holder_type };
      if (args.holder_parameter !== undefined) holder.parameter = args.holder_parameter;
      const summary = `Grant ${args.permission} to ${holderLabel(holder)} in permission scheme ${args.scheme_id}`;
      const holdersOf = (grants: any[]) => grants.filter((g) => g.permission === args.permission).map((g) => holderKey(g.holder)).sort();
      const before = holdersOf(await schemeGrants(c, args.scheme_id));
      const wanted = holderKey(holder);
      if (before.includes(wanted)) return alreadySatisfied(summary, "the scheme already grants this permission to this holder");
      const req = { method: "POST" as const, path: `${API}/permissionscheme/${args.scheme_id}/permission`, json: { holder, permission: args.permission }, summary };
      if (args.dry_run !== false) {
        // drift covers this permission's holders only, so grants of other permissions in the same plan do not count
        return { ...(await guardedWrite(c, args, req)), identity: { op: "add-permission-grant", scheme: args.scheme_id, permission: args.permission, holder: wanted }, state: { holders: before } };
      }
      const result = await guardedWrite(c, args, req);
      const after = holdersOf(await schemeGrants(c, args.scheme_id));
      if (!after.includes(wanted)) throw new VerificationError(`${summary}: the scheme does not list the grant afterwards`, { permission: args.permission, holders: after });
      return result;
    },
  },
  {
    name: "jira_delete_permission_grant",
    product: "jira",
    write: true,
    description: "Remove one grant (id from jira_get_permission_scheme) from a permission scheme.",
    inputShape: { scheme_id: z.coerce.number().int(), grant_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Delete grant ${args.grant_id} from permission scheme ${args.scheme_id}`;
      const grant = (await schemeGrants(c, args.scheme_id)).find((g) => Number(g.id) === args.grant_id);
      if (!grant) return alreadySatisfied(summary, "the scheme has no such grant");
      const req = { method: "DELETE" as const, path: `${API}/permissionscheme/${args.scheme_id}/permission/${args.grant_id}`, summary: `${summary} (${grant.permission} → ${holderLabel(grant.holder)})` };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "delete-permission-grant", scheme: args.scheme_id, grant: args.grant_id }, state: { permission: grant.permission, holder: holderKey(grant.holder) } };
      const result = await guardedWrite(c, args, req);
      const after = await schemeGrants(c, args.scheme_id);
      if (after.some((g) => Number(g.id) === args.grant_id)) {
        throw new VerificationError(`${summary}: the grant is still listed`, { permission: grant.permission, holders: after.filter((g) => g.permission === grant.permission).map((g) => holderKey(g.holder)).sort() });
      }
      return result;
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
      const summary = `Create ${args.subtask ? "sub-task " : ""}issue type '${args.name}'`;
      if (clash) {
        // the same type already exists (exact name, kind, description when given): nothing to do
        const sameKind = Boolean(clash.subtask) === Boolean(args.subtask);
        const sameDescription = args.description === undefined || (clash.description ?? "") === args.description;
        if (clash.name === args.name && sameKind && sameDescription) return alreadySatisfied(summary, `issue type ${clash.id} already exists with these settings`, { id: String(clash.id) });
        throw new ValidationError(`Issue type '${clash.name}' already exists (id ${clash.id}) with other settings`);
      }
      const json: Record<string, unknown> = { name: args.name };
      if (args.description !== undefined) json.description = args.description;
      json.type = args.subtask ? "subtask" : "standard";
      if (args.avatar_id !== undefined) json.avatarId = args.avatar_id;
      const req = { method: "POST" as const, path: `${API}/issuetype`, json, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const result = await guardedWrite(c, args, req);
      const back: any[] = (await c.get(`${API}/issuetype`)) ?? [];
      const created = back.find((t) => t.name === args.name);
      if (!created) throw new VerificationError(`${summary}: Jira does not list the issue type afterwards`, { names: back.map((t) => t.name) });
      return { ...result, result: { id: String(created.id), name: created.name, subtask: Boolean(created.subtask) }, created: { type: "issue-type", name: created.name, id: String(created.id) } };
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
    aliases: { issue_type_ids: "issue_types", default_issue_type_id: "default_issue_type" },
    product: "jira",
    write: true,
    description:
      "Add issue types (ids from jira_list_issue_types) to an issue type scheme, keeping its current types; " +
      "default_issue_type optionally changes the default. Projects using the scheme can then create these types.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      issue_types: listArg.describe("Issue type ids or exact names, comma-separated or array"),
      default_issue_type: z.coerce.string().optional().describe("Issue type id or exact name"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [scheme, allTypes] = await Promise.all([getIssueTypeScheme(c, args.scheme_id), c.get(`${API}/issuetype`)]);
      const byId = new Map<string, any>((Array.isArray(allTypes) ? allTypes : []).map((t: any) => [String(t.id), t]));
      const types = Array.isArray(allTypes) ? allTypes : [];
      // a name may refer to an issue type an earlier plan item creates: pending in the dry run, resolved on apply
      const dryRun = args.dry_run !== false;
      const resolve = (given: string) => resolveIssueType(c, given, { within: types, allowPending: dryRun });
      const refs = [];
      for (const given of args.issue_types) refs.push(await resolve(given));
      const defaultRef = args.default_issue_type !== undefined ? await resolve(args.default_issue_type) : undefined;
      const idOf = (r: { id?: string; name?: string }) => r.id ?? issueTypePlaceholder(r.name!);
      const requestedIds: string[] = refs.map(idOf);
      const defaultId = defaultRef ? idOf(defaultRef) : undefined;

      const current: string[] = (scheme?.issueTypes ?? []).map((t: any) => String(t.id));
      const requested = [...new Set<string>(requestedIds)];
      const added = requested.filter((id) => !current.includes(id));
      const currentDefault = scheme?.defaultIssueType?.id !== undefined ? String(scheme.defaultIssueType.id) : undefined;
      const defaultChange = defaultId !== undefined && String(defaultId) !== currentDefault;
      const summaryBase = `Issue type scheme '${scheme?.name ?? args.scheme_id}'`;
      if (!added.length && !defaultChange) {
        return alreadySatisfied(`${summaryBase}: add ${requested.join(", ")}`, "the scheme already contains these issue types and default");
      }
      // built from the scheme as it is now, so additions by earlier plan items are kept
      const issueTypeIds = [...current, ...added];
      const defaultIssueTypeId = defaultId ?? currentDefault;
      if (defaultIssueTypeId !== undefined && !issueTypeIds.includes(String(defaultIssueTypeId))) {
        throw new ValidationError(`Default issue type ${defaultIssueTypeId} is not in the scheme`);
      }

      // PUT replaces the whole scheme, so name, description and default are sent back unchanged
      const json: Record<string, unknown> = { name: scheme?.name, description: scheme?.description ?? "" };
      if (defaultIssueTypeId !== undefined) json.defaultIssueTypeId = String(defaultIssueTypeId);
      json.issueTypeIds = issueTypeIds;
      const names = added.map((id) => (byId.has(id) ? `${byId.get(id)?.name} (${id})` : id)).join(", ");
      const defaultNote = defaultChange ? `; default → ${byId.get(String(defaultId))?.name}` : "";
      const req = {
        method: "PUT" as const,
        path: `${API}/issuetypescheme/${args.scheme_id}`,
        json,
        summary: `${summaryBase}: add ${names || "(none)"}${defaultNote}`,
      };
      if (args.dry_run !== false) {
        return {
          ...(await guardedWrite(c, args, req)),
          // drift covers only what this item depends on: other items' additions to the same scheme don't count
          // names stay names (also once resolved), so a type created by an earlier item does not look like drift
          identity: {
            op: "add-issue-types-to-scheme",
            scheme: args.scheme_id,
            issueTypes: refs.map((r) => JSON.stringify(r.ref)).sort(),
            default: defaultRef ? defaultRef.ref : null,
          },
          state: { present: requested.filter((id) => current.includes(id)).sort(), ...(defaultChange ? { default: currentDefault ?? null } : {}) },
        };
      }
      const result = await guardedWrite(c, args, req);
      const back = await getIssueTypeScheme(c, args.scheme_id);
      const backIds: string[] = (back?.issueTypes ?? []).map((t: any) => String(t.id));
      const missing = requested.filter((id) => !backIds.includes(id));
      const backDefault = back?.defaultIssueType?.id !== undefined ? String(back.defaultIssueType.id) : undefined;
      if (missing.length || (defaultId !== undefined && backDefault !== String(defaultId))) {
        throw new VerificationError(`${req.summary}: the scheme does not show the change afterwards`, { issueTypeIds: backIds, defaultIssueTypeId: backDefault ?? null, missing });
      }
      return { ...result, result: { issueTypeIds: backIds, defaultIssueTypeId: backDefault ?? null } };
    },
  },
];
