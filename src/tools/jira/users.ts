/**
 * Jira DC user and group administration.
 *
 * Read tools follow mcp-atlassian-for-admins (src/tools/users.ts, MIT);
 * write tools are dry-run guarded.
 */

import { z } from "zod";
import { isJiraUserKey, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, capList, dryRunShape, fullListsShape, guardedWrite, listArg, MAX_PAGE, pageShape, pick, serverPage, type WriteRequest } from "../util.js";

const API = "/rest/api/2";
const USER_FIELDS = ["key", "name", "displayName", "emailAddress", "active", "deleted", "timeZone", "locale", "lastLoginTime"];

function compactUser(u: any): Record<string, unknown> {
  const out = pick(u, USER_FIELDS);
  if (u?.groups?.items) out.groups = u.groups.items.map((g: any) => g.name).sort();
  if (u?.applicationRoles?.items) out.applications = u.applicationRoles.items.map((r: any) => r.key).sort();
  return out;
}

const userIdShape = {
  user: z.string().describe("Username, or user key (JIRAUSER10000)"),
};

function userParams(user: string): Record<string, string> {
  if (!user) throw new ValidationError("user is required");
  return isJiraUserKey(user) ? { key: user } : { username: user };
}

/** The user (with `expand`), or null when Jira answers 404. */
async function readUser(client: AtlassianClient, user: string, expand?: string): Promise<any | null> {
  try {
    return await client.get(`${API}/user`, { ...userParams(user), expand });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

async function requireUser(client: AtlassianClient, user: string, expand?: string): Promise<any> {
  const u = await readUser(client, user, expand);
  if (!u) throw new ValidationError(`No Jira user '${user}'`);
  return u;
}

/** The group, or null when Jira answers 404. */
async function readGroup(client: AtlassianClient, name: string): Promise<any | null> {
  try {
    return await client.get(`${API}/group`, { groupname: name });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

/** Group names of a user read with expand=groups; `complete` is false when Jira listed only part of them. */
function groupsOf(u: any): { names: Set<string>; complete: boolean } {
  const items: any[] = u?.groups?.items ?? [];
  const names = new Set(items.map((g) => String(g.name).toLowerCase()));
  return { names, complete: u?.groups?.size === undefined || items.length >= Number(u.groups.size) };
}

const appsOf = (u: any) => new Set<string>((u?.applicationRoles?.items ?? []).map((r: any) => String(r.key)));
const sameText = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();

/**
 * Dry run, or execute and read the target back: `check` returns the observed state and whether it shows
 * the change; a change that is not visible afterwards is a VerificationError carrying the observed state.
 */
async function verifiedWrite(
  client: AtlassianClient,
  args: { dry_run?: boolean },
  req: WriteRequest,
  check: () => Promise<{ ok: boolean; observed: unknown }>,
) {
  const result = await guardedWrite(client, args, req);
  if (args.dry_run !== false) return result;
  const back = await check();
  if (!back.ok) throw new VerificationError(`${req.summary}: Jira does not show the change afterwards`, back.observed);
  return result;
}

export const jiraUserTools: ToolDef[] = [
  {
    name: "jira_find_users",
    product: "jira",
    description: "Find users by username, display name or e-mail fragment ('.' matches everyone).",
    inputShape: {
      query: z.string().describe("Search text"),
      include_inactive: boolArg.optional(),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const users: any[] =
        (await client("jira").get(`${API}/user/search`, {
          username: args.query,
          includeActive: true,
          includeInactive: args.include_inactive ?? false,
          startAt: offset,
          maxResults: limit,
        })) ?? [];
      return serverPage(users.map(compactUser), offset, limit);
    },
  },
  {
    name: "jira_get_user",
    product: "jira",
    description: "One user with groups and application access (licenses). Works for deactivated users too.",
    inputShape: { ...userIdShape, include_deleted: boolArg.optional(), ...fullListsShape },
    async handler({ client }, args) {
      const user = await client("jira").get(`${API}/user`, {
        ...userParams(args.user),
        expand: "groups,applicationRoles",
        includeDeleted: args.include_deleted ?? false,
      });
      const out = compactUser(user);
      if (Array.isArray(out.groups)) capList(out, "groups", out.groups, args.full_lists);
      return out;
    },
  },
  {
    name: "jira_create_user",
    product: "jira",
    write: true,
    description:
      "Create a user in the internal directory. Without password and with notify=true Jira e-mails a set-password link. " +
      "The same username with the same e-mail and display name → already-satisfied; with other details → error.",
    inputShape: {
      username: z.string(),
      email: z.string(),
      display_name: z.string(),
      password: z.string().optional(),
      notify: boolArg.optional().describe("Default true"),
      application_keys: listArg.optional().describe("e.g. jira-software; omitted = default applications"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body: Record<string, unknown> = {
        name: args.username,
        emailAddress: args.email,
        displayName: args.display_name,
        notification: String(args.notify ?? true),
      };
      if (args.password) body.password = args.password;
      if (args.application_keys) body.applicationKeys = args.application_keys;
      const c = client("jira");
      const summary = `Create user ${args.username}`;
      const existing = await readUser(c, args.username);
      if (existing) {
        if (sameText(existing.emailAddress, args.email) && existing.displayName === args.display_name) {
          return alreadySatisfied(summary, "a user with this username, e-mail and display name exists");
        }
        throw new ValidationError(`User ${args.username} already exists with other details; use jira_update_user`);
      }
      return verifiedWrite(c, args, { method: "POST", path: `${API}/user`, json: body, secretKeys: ["password"], summary }, async () => {
        const u = await readUser(c, args.username);
        return { ok: !!u, observed: u ? pick(u, USER_FIELDS) : null };
      });
    },
  },
  {
    name: "jira_update_user",
    product: "jira",
    write: true,
    description: "Change e-mail, display name or username (rename) of a user in a writable directory.",
    inputShape: {
      ...userIdShape,
      email: z.string().optional(),
      display_name: z.string().optional(),
      new_username: z.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body = Object.fromEntries(
        Object.entries({ emailAddress: args.email, displayName: args.display_name, name: args.new_username }).filter(
          ([, v]) => v,
        ),
      );
      if (Object.keys(body).length === 0) throw new ValidationError("Pass email, display_name or new_username");
      const c = client("jira");
      const summary = `Update user ${args.user}: ${Object.keys(body).join(", ")}`;
      const current = await requireUser(c, args.user);
      const differs = (u: any) =>
        Object.entries(body).filter(([k, v]) => (k === "emailAddress" ? !sameText(u?.[k], v) : u?.[k] !== v)).map(([k]) => k);
      if (!differs(current).length) return alreadySatisfied(summary, "the user already has these values");
      // a rename changes the username; the key stays
      const readBack = isJiraUserKey(args.user) ? args.user : (args.new_username ?? args.user);
      return verifiedWrite(c, args, { method: "PUT", path: `${API}/user`, params: userParams(args.user), json: body, summary }, async () => {
        const u = await readUser(c, readBack);
        return { ok: !!u && !differs(u).length, observed: u ? pick(u, USER_FIELDS) : null };
      });
    },
  },
  {
    name: "jira_set_user_active",
    product: "jira",
    write: true,
    description: "Activate or deactivate a user. Deactivation frees the license seat and keeps history; prefer it over delete.",
    inputShape: { ...userIdShape, active: boolArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `${args.active ? "Activate" : "Deactivate"} user ${args.user}`;
      const current = await requireUser(c, args.user);
      if (current.active === args.active) return alreadySatisfied(summary, `the user is already ${args.active ? "active" : "inactive"}`);
      return verifiedWrite(c, args, { method: "PUT", path: `${API}/user`, params: userParams(args.user), json: { active: args.active }, summary }, async () => {
        const u = await readUser(c, args.user);
        return { ok: u?.active === args.active, observed: u ? { active: u.active } : null };
      });
    },
  },
  {
    name: "jira_delete_user",
    product: "jira",
    write: true,
    description: "Delete a user. Jira refuses if the user has issues, comments or other history; deactivate instead.",
    inputShape: { ...userIdShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `DELETE user ${args.user}`;
      if (!(await readUser(c, args.user))) return alreadySatisfied(summary, "no such user");
      return verifiedWrite(c, args, { method: "DELETE", path: `${API}/user`, params: userParams(args.user), summary }, async () => {
        const u = await readUser(c, args.user);
        return { ok: !u, observed: u ? pick(u, USER_FIELDS) : null };
      });
    },
  },
  {
    name: "jira_set_user_application",
    aliases: { username: "user" },
    product: "jira",
    write: true,
    description: "Grant or revoke application access (license seat), e.g. application_key=jira-servicedesk.",
    inputShape: {
      user: z.string(),
      application_key: z.string(),
      grant: boolArg.optional().describe("Default true; false revokes"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const grant = args.grant ?? true;
      const c = client("jira");
      const summary = `${grant ? "Grant" : "Revoke"} ${args.application_key} for ${args.user}`;
      const current = await requireUser(c, args.user, "applicationRoles");
      if (appsOf(current).has(args.application_key) === grant) {
        return alreadySatisfied(summary, grant ? "the user already has this application" : "the user does not have this application");
      }
      const req: WriteRequest = { method: grant ? "POST" : "DELETE", path: `${API}/user/application`, params: { username: args.user, applicationKey: args.application_key }, summary };
      return verifiedWrite(c, args, req, async () => {
        const apps = appsOf(await readUser(c, args.user, "applicationRoles"));
        return { ok: apps.has(args.application_key) === grant, observed: { applications: [...apps].sort() } };
      });
    },
  },
  {
    name: "jira_kill_user_sessions",
    aliases: { username: "user" },
    product: "jira",
    write: true,
    description: "Invalidate all web sessions of a user (forced logout).",
    unverifiable: "Jira does not report a user's sessions, so neither the state before nor the effect can be read",
    inputShape: { user: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/user/session/${seg(args.user)}`,
        summary: `Kill sessions of ${args.user}`,
      });
    },
  },
  {
    name: "jira_find_groups",
    product: "jira",
    description: "Groups whose name contains the query (empty query lists the first `limit` groups).",
    inputShape: {
      query: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional().describe(`Default 100, max ${MAX_PAGE}`),
    },
    async handler({ client }, args) {
      const data = (await client("jira").get(`${API}/groups/picker`, {
        query: args.query ?? "",
        maxResults: args.limit ?? 100,
      })) ?? {};
      const groups = (data.groups ?? []).map((g: any) => g.name);
      return { total: data.total ?? null, returned: groups.length, items: groups };
    },
  },
  {
    name: "jira_get_group_members",
    product: "jira",
    description: "Members of a group (server-side paging).",
    inputShape: { group: z.string(), include_inactive: boolArg.optional(), ...pageShape(50) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = (await client("jira").get(`${API}/group/member`, {
        groupname: args.group,
        includeInactiveUsers: args.include_inactive ?? false,
        startAt: offset,
        maxResults: limit,
      })) ?? {};
      return serverPage((data.values ?? []).map(compactUser), offset, limit, data.total, data.isLast);
    },
  },
  {
    name: "jira_create_group",
    product: "jira",
    write: true,
    description: "Create a group in the internal directory.",
    inputShape: { name: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create group ${args.name}`;
      if (await readGroup(c, args.name)) return alreadySatisfied(summary, "the group exists");
      return verifiedWrite(c, args, { method: "POST", path: `${API}/group`, json: { name: args.name }, summary }, async () => {
        const g = await readGroup(c, args.name);
        return { ok: !!g, observed: g ? { name: g.name } : null };
      });
    },
  },
  {
    name: "jira_delete_group",
    product: "jira",
    write: true,
    description: "Delete a group. swap_group moves comment/worklog visibility restrictions to another group.",
    inputShape: { name: z.string(), swap_group: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `DELETE group ${args.name}${args.swap_group ? ` (swap to ${args.swap_group})` : ""}`;
      if (!(await readGroup(c, args.name))) return alreadySatisfied(summary, "no such group");
      const req: WriteRequest = { method: "DELETE", path: `${API}/group`, params: { groupname: args.name, swapGroup: args.swap_group }, summary };
      return verifiedWrite(c, args, req, async () => {
        const g = await readGroup(c, args.name);
        return { ok: !g, observed: g ? { name: g.name } : null };
      });
    },
  },
  {
    name: "jira_add_user_to_group",
    aliases: { username: "user" },
    product: "jira",
    write: true,
    description: "Add a user to a group.",
    inputShape: { group: z.string(), user: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Add ${args.user} to ${args.group}`;
      const member = groupsOf(await requireUser(c, args.user, "groups"));
      if (member.names.has(args.group.toLowerCase())) return alreadySatisfied(summary, "the user is already a member");
      const req: WriteRequest = { method: "POST", path: `${API}/group/user`, params: { groupname: args.group }, json: { name: args.user }, summary };
      return verifiedWrite(c, args, req, async () => {
        const back = groupsOf(await readUser(c, args.user, "groups"));
        // a partial group list that lacks the group proves nothing either way
        return { ok: back.names.has(args.group.toLowerCase()) || !back.complete, observed: { groups: [...back.names].sort(), complete: back.complete } };
      });
    },
  },
  {
    name: "jira_remove_user_from_group",
    aliases: { username: "user" },
    product: "jira",
    write: true,
    description: "Remove a user from a group.",
    inputShape: { group: z.string(), user: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Remove ${args.user} from ${args.group}`;
      const member = groupsOf(await requireUser(c, args.user, "groups"));
      if (member.complete && !member.names.has(args.group.toLowerCase())) return alreadySatisfied(summary, "the user is not a member");
      const req: WriteRequest = { method: "DELETE", path: `${API}/group/user`, params: { groupname: args.group, username: args.user }, summary };
      return verifiedWrite(c, args, req, async () => {
        const back = groupsOf(await readUser(c, args.user, "groups"));
        return { ok: !back.names.has(args.group.toLowerCase()), observed: { groups: [...back.names].sort(), complete: back.complete } };
      });
    },
  },
];
