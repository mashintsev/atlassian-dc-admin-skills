/**
 * Jira DC user and group administration.
 *
 * Read tools follow mcp-atlassian-for-admins (src/tools/users.ts, MIT);
 * write tools are dry-run guarded.
 */

import { z } from "zod";
import { isJiraUserKey, seg } from "../../client.js";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, listArg, pageShape, pick, serverPage } from "../util.js";

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
    inputShape: { ...userIdShape, include_deleted: boolArg.optional() },
    async handler({ client }, args) {
      const user = await client("jira").get(`${API}/user`, {
        ...userParams(args.user),
        expand: "groups,applicationRoles",
        includeDeleted: args.include_deleted ?? false,
      });
      return compactUser(user);
    },
  },
  {
    name: "jira_create_user",
    product: "jira",
    write: true,
    description:
      "Create a user in the internal directory. Without password and with notify=true Jira e-mails a set-password link.",
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
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/user`,
        json: body,
        secretKeys: ["password"],
        summary: `Create user ${args.username}`,
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
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/user`,
        params: userParams(args.user),
        json: body,
        summary: `Update user ${args.user}: ${Object.keys(body).join(", ")}`,
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
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/user`,
        params: userParams(args.user),
        json: { active: args.active },
        summary: `${args.active ? "Activate" : "Deactivate"} user ${args.user}`,
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
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/user`,
        params: userParams(args.user),
        summary: `DELETE user ${args.user}`,
      });
    },
  },
  {
    name: "jira_set_user_application",
    product: "jira",
    write: true,
    description: "Grant or revoke application access (license seat), e.g. application_key=jira-servicedesk.",
    inputShape: {
      username: z.string(),
      application_key: z.string(),
      grant: boolArg.optional().describe("Default true; false revokes"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const grant = args.grant ?? true;
      return guardedWrite(client("jira"), args, {
        method: grant ? "POST" : "DELETE",
        path: `${API}/user/application`,
        params: { username: args.username, applicationKey: args.application_key },
        summary: `${grant ? "Grant" : "Revoke"} ${args.application_key} for ${args.username}`,
      });
    },
  },
  {
    name: "jira_kill_user_sessions",
    product: "jira",
    write: true,
    description: "Invalidate all web sessions of a user (forced logout).",
    inputShape: { username: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/user/session/${seg(args.username)}`,
        summary: `Kill sessions of ${args.username}`,
      });
    },
  },
  {
    name: "jira_find_groups",
    product: "jira",
    description: "Groups whose name contains the query (empty query lists the first `limit` groups).",
    inputShape: {
      query: z.string().optional(),
      limit: z.coerce.number().int().min(1).optional().describe("Default 100"),
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
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/group`,
        json: { name: args.name },
        summary: `Create group ${args.name}`,
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
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/group`,
        params: { groupname: args.name, swapGroup: args.swap_group },
        summary: `DELETE group ${args.name}${args.swap_group ? ` (swap to ${args.swap_group})` : ""}`,
      });
    },
  },
  {
    name: "jira_add_user_to_group",
    product: "jira",
    write: true,
    description: "Add a user to a group.",
    inputShape: { group: z.string(), username: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/group/user`,
        params: { groupname: args.group },
        json: { name: args.username },
        summary: `Add ${args.username} to ${args.group}`,
      });
    },
  },
  {
    name: "jira_remove_user_from_group",
    product: "jira",
    write: true,
    description: "Remove a user from a group.",
    inputShape: { group: z.string(), username: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/group/user`,
        params: { groupname: args.group, username: args.username },
        summary: `Remove ${args.username} from ${args.group}`,
      });
    },
  },
];
