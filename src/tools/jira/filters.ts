/**
 * Jira DC saved filters and dashboards over the public REST API.
 *
 * Filters: read, create, update, delete, and share permissions (group, project with an optional role,
 * authenticated users, global). Jira DC has no search over all filters (`/filter/search` answers 404),
 * so the list covers the caller's favourites and says so. JQL is checked by Jira before any change is
 * planned. Dashboards are read-only here: DC offers no REST copy.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite, pageShape, paginate, serverPage, type WriteRequest } from "../util.js";

const API = "/rest/api/2";
const FAVOURITES_NOTE = "Only favourite filters are listed (Jira DC cannot search all filters); read any other by id with jira_get_filter.";

const filterArg = z.coerce.string().min(1).describe("Filter id");

/** A share permission as compared and shown: kind plus group, project key/id and role. */
function shareView(s: any) {
  return {
    id: s.id,
    type: String(s.type),
    ...(s.group?.name ? { group: s.group.name } : {}),
    ...(s.project ? { project: s.project.key ?? String(s.project.id) } : {}),
    ...(s.role ? { role: s.role.name ?? s.role.id } : {}),
    view: s.view,
    edit: s.edit,
  };
}

function filterView(f: any) {
  return {
    id: String(f.id),
    name: f.name,
    owner: f.owner?.name ?? f.owner?.displayName ?? null,
    jql: f.jql,
    description: f.description ?? undefined,
    favourite: f.favourite,
    // Jira DC does not report how many users made the filter a favourite
    favourites: f.favouritedCount ?? null,
    shares: (f.sharePermissions ?? []).map(shareView),
    viewUrl: f.viewUrl,
  };
}

async function getFilter(client: AtlassianClient, id: string): Promise<any> {
  return client.get(`${API}/filter/${seg(id)}`);
}

async function findFilter(client: AtlassianClient, id: string): Promise<any | null> {
  try {
    return await getFilter(client, id);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

/** Jira checks the JQL; an invalid query is refused with Jira's own message, before anything is planned. */
async function checkJql(client: AtlassianClient, jql: string): Promise<void> {
  try {
    await client.get(`${API}/search`, { jql, maxResults: 0, validateQuery: "strict", fields: "id" });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 400) {
      let detail = "";
      try {
        const body = JSON.parse(e.body);
        detail = [...(body.errorMessages ?? []), ...Object.values(body.errors ?? {})].join("; ");
      } catch {
        // not JSON: fall back to the status
      }
      throw new ValidationError(`Jira refuses the JQL: ${detail || "HTTP 400"}`);
    }
    throw e;
  }
}

/** Dry run with drift data, or execute and verify with a read-back. */
async function write(
  c: AtlassianClient,
  args: { dry_run?: boolean },
  req: WriteRequest,
  drift: { identity: Record<string, unknown>; state: unknown; extra?: Record<string, unknown> },
  verify: () => Promise<{ problem: string | null; observed: unknown; result?: unknown }>,
) {
  if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...drift.extra, identity: drift.identity, state: drift.state };
  const sent = await guardedWrite(c, args, req);
  const back = await verify();
  if (back.problem) throw new VerificationError(`${req.summary}: ${back.problem}`, back.observed);
  return { ...sent, result: back.result ?? back.observed };
}

const shareShape = {
  share_type: z.enum(["group", "project", "authenticated", "global"]),
  group: z.string().min(1).optional().describe("Group name (share_type=group)"),
  project_key: z.string().min(1).optional().describe("Project key (share_type=project)"),
  role_id: z.coerce.string().optional().describe("Project role id (share_type=project, optional)"),
};

/** The share request body and a predicate matching an existing share of the same kind and target. */
async function shareTarget(client: AtlassianClient, args: any) {
  switch (args.share_type) {
    case "group": {
      if (!args.group) throw new ValidationError("share_type=group needs group");
      return { body: { type: "group", groupname: args.group }, label: `group ${args.group}`, matches: (s: any) => s.type === "group" && s.group?.name === args.group };
    }
    case "project": {
      if (!args.project_key) throw new ValidationError("share_type=project needs project_key");
      const project = await client.get(`${API}/project/${seg(args.project_key)}`);
      const projectId = String(project.id);
      const role = args.role_id ? String(args.role_id) : undefined;
      return {
        body: { type: role ? "projectRole" : "project", projectId, ...(role ? { projectRoleId: role } : {}) },
        label: `project ${project.key ?? args.project_key}${role ? ` role ${role}` : ""}`,
        matches: (s: any) => (s.type === "project" || s.type === "projectRole") && String(s.project?.id) === projectId && (role ? String(s.role?.id) === role : !s.role),
      };
    }
    default:
      return { body: { type: args.share_type }, label: args.share_type, matches: (s: any) => s.type === args.share_type };
  }
}

export const jiraFilterTools: ToolDef[] = [
  {
    name: "jira_list_filters",
    product: "jira",
    description: "The caller's favourite filters (id, name, owner, JQL). Jira DC has no search over all filters; read any visible filter by id with jira_get_filter.",
    inputShape: { name_contains: z.string().optional(), ...pageShape(50) },
    async handler({ client }, args) {
      const data: any[] = (await client("jira").get(`${API}/filter/favourite`)) ?? [];
      const needle = args.name_contains?.toLowerCase();
      const items = data
        .filter((f) => !needle || String(f.name).toLowerCase().includes(needle))
        .map((f) => ({ id: String(f.id), name: f.name, owner: f.owner?.name ?? null, jql: f.jql }));
      return { source: "favourites", note: FAVOURITES_NOTE, ...paginate(items, args, 50) };
    },
  },
  {
    name: "jira_get_filter",
    product: "jira",
    description: "One filter: name, owner, JQL, share permissions and view URL. A filter the caller cannot see answers not found.",
    inputShape: { filter: filterArg },
    async handler({ client }, args) {
      return filterView(await getFilter(client("jira"), args.filter));
    },
  },
  {
    name: "jira_create_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Create a saved filter. Jira checks the JQL first. A filter of yours with the same name and JQL → already-satisfied; same name, other JQL → error.",
    inputShape: {
      name: z.string().trim().min(1),
      jql: z.string().trim().min(1),
      description: z.string().optional(),
      favourite: boolArg.optional().describe("Default true"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      await checkJql(c, args.jql);
      const summary = `Create filter '${args.name}'`;
      const mine: any[] = (await c.get(`${API}/filter/favourite`)) ?? [];
      const same = mine.find((f) => f.name === args.name);
      if (same && same.jql === args.jql) return alreadySatisfied(summary, `filter ${same.id} already has this JQL`, { id: String(same.id) });
      if (same) throw new ValidationError(`Filter ${same.id} '${same.name}' already exists with other JQL; use jira_update_filter`);
      const json = { name: args.name, jql: args.jql, ...(args.description !== undefined ? { description: args.description } : {}), favourite: args.favourite ?? true };
      const req: WriteRequest = { method: "POST", path: `${API}/filter`, json, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "create-filter", ...json }, state: { exists: false } };
      const created = await c.request("POST", req.path, { json });
      const back = created?.id ? await findFilter(c, String(created.id)) : null;
      if (!back || back.jql !== args.jql || back.name !== args.name) throw new VerificationError(`${summary}: the filter does not read back as created`, back && filterView(back));
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: filterView(back) };
    },
  },
  {
    name: "jira_update_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Change a filter's name, JQL and/or description. Jira checks the JQL first. Same values → already-satisfied.",
    inputShape: { filter: filterArg, name: z.string().trim().min(1).optional(), jql: z.string().trim().min(1).optional(), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      if (args.name === undefined && args.jql === undefined && args.description === undefined) throw new ValidationError("Pass name, jql or description");
      const c = client("jira");
      if (args.jql !== undefined) await checkJql(c, args.jql);
      const f = await getFilter(c, args.filter);
      const wanted: Record<string, string> = {};
      for (const k of ["name", "jql", "description"] as const) if (args[k] !== undefined && args[k] !== (f[k] ?? "")) wanted[k] = args[k];
      const summary = `Update filter ${f.id} '${f.name}'`;
      if (!Object.keys(wanted).length) return alreadySatisfied(summary, "the filter already has these values");
      // PUT replaces name and JQL, so unchanged values are sent back as they are
      const json = { name: f.name, jql: f.jql, ...(f.description !== undefined ? { description: f.description } : {}), ...wanted };
      const before = Object.fromEntries(Object.keys(wanted).map((k) => [k, f[k] ?? null]));
      return write(c, args, { method: "PUT", path: `${API}/filter/${seg(f.id)}`, json, summary }, {
        identity: { op: "update-filter", filter: String(f.id), ...wanted },
        state: before,
        extra: { before, after: wanted },
      }, async () => {
        const back = await getFilter(c, String(f.id));
        const bad = Object.keys(wanted).filter((k) => (back[k] ?? "") !== wanted[k]);
        return { problem: bad.length ? `Jira reports other values for ${bad.join(", ")}` : null, observed: filterView(back) };
      });
    },
  },
  {
    name: "jira_delete_filter",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Delete a filter (irreversible; boards and subscriptions using it break). Already gone → already-satisfied.",
    inputShape: { filter: filterArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const f = await findFilter(c, args.filter);
      const summary = `Delete filter ${args.filter}${f ? ` '${f.name}'` : ""}`;
      if (!f) return alreadySatisfied(summary, "no such filter (or not visible to this account)");
      return write(c, args, { method: "DELETE", path: `${API}/filter/${seg(f.id)}`, summary }, {
        identity: { op: "delete-filter", filter: String(f.id) },
        state: { exists: true },
        extra: {
          // Jira DC does not report the favourite count; null says so instead of guessing
          favourites: f.favouritedCount ?? null,
          subscriptions: f.subscriptions?.size ?? 0,
          warning: `Irreversible: boards and subscriptions that use filter ${f.id} stop working${f.favouritedCount === undefined ? "; this Jira does not report how many users have it as a favourite" : ""}`,
        },
      }, async () => {
        const back = await findFilter(c, String(f.id));
        return { problem: back ? "the filter still exists" : null, observed: back && filterView(back), result: { deleted: String(f.id) } };
      });
    },
  },
  {
    name: "jira_add_filter_share",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Share a filter with a group, a project (optionally a role), all logged-in users (authenticated) or everyone (global). Already shared that way → already-satisfied.",
    inputShape: { filter: filterArg, ...shareShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const [f, target] = await Promise.all([getFilter(c, args.filter), shareTarget(c, args)]);
      const summary = `Share filter ${f.id} '${f.name}' with ${target.label}`;
      const present = (f.sharePermissions ?? []).some(target.matches);
      if (present) return alreadySatisfied(summary, "the filter is already shared that way");
      return write(c, args, { method: "POST", path: `${API}/filter/${seg(f.id)}/permission`, json: target.body, summary }, {
        identity: { op: "add-filter-share", filter: String(f.id), ...target.body },
        state: { present: false },
      }, async () => {
        const shares: any[] = (await c.get(`${API}/filter/${seg(f.id)}/permission`)) ?? [];
        return { problem: shares.some(target.matches) ? null : "the share is not listed afterwards", observed: shares.map(shareView) };
      });
    },
  },
  {
    name: "jira_remove_filter_share",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Remove a filter share of one kind and target (group, project/role, authenticated, global). Not shared that way → already-satisfied.",
    inputShape: { filter: filterArg, ...shareShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const [f, target] = await Promise.all([getFilter(c, args.filter), shareTarget(c, args)]);
      const summary = `Remove share of filter ${f.id} '${f.name}' with ${target.label}`;
      const share = (f.sharePermissions ?? []).find(target.matches);
      if (!share) return alreadySatisfied(summary, "the filter is not shared that way");
      return write(c, args, { method: "DELETE", path: `${API}/filter/${seg(f.id)}/permission/${seg(share.id)}`, summary }, {
        identity: { op: "remove-filter-share", filter: String(f.id), ...target.body },
        state: { present: true },
      }, async () => {
        const shares: any[] = (await c.get(`${API}/filter/${seg(f.id)}/permission`)) ?? [];
        return { problem: shares.some(target.matches) ? "the share is still listed" : null, observed: shares.map(shareView) };
      });
    },
  },
  {
    name: "jira_list_dashboards",
    product: "jira",
    description: "Dashboards visible to the caller (id, name, view URL), paged. filter=favourite lists only favourites.",
    inputShape: { filter: z.enum(["favourite", "my"]).optional().describe("Default: all visible"), ...pageShape(50) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = await client("jira").get(`${API}/dashboard`, { filter: args.filter, startAt: offset, maxResults: limit });
      const items = (data?.dashboards ?? []).map((d: any) => ({ id: String(d.id), name: d.name, view: d.view }));
      return serverPage(items, offset, limit, data?.total);
    },
  },
  {
    name: "jira_get_dashboard",
    product: "jira",
    description: "One dashboard: id, name and view URL (Jira DC reports no owner or share permissions here). Copying a dashboard is done in the Jira UI.",
    inputShape: { dashboard: z.coerce.string().min(1).describe("Dashboard id") },
    async handler({ client }, args) {
      const d = await client("jira").get(`${API}/dashboard/${seg(args.dashboard)}`);
      return { id: String(d.id), name: d.name, view: d.view, owner: d.owner?.name ?? null, shares: d.sharePermissions?.map(shareView) ?? null };
    },
  },
];
