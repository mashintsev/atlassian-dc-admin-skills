/**
 * Confluence DC user and group administration.
 * Paths and bodies checked against confluence-rest-client 10.2.17 (RemotePersonServiceImpl,
 * RemoteGroupServiceImpl) and confluence-java-api 9.2.16 (UserDetailsForCreation).
 */

import { z } from "zod";
import { seg } from "../../client.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, pageShape, pick, serverPage } from "../util.js";

const API = "/rest/api";
const PROTOTYPE = "/rest/prototype/1";
const MAX_GROUPS = 200;
const USER_FIELDS = ["type", "username", "userKey", "displayName", "email", "status"];

function compactUser(u: any): Record<string, unknown> {
  return pick(u, USER_FIELDS);
}

const userShape = { username: z.string() };

export const confluenceUserTools: ToolDef[] = [
  {
    name: "confluence_find_users",
    product: "confluence",
    description: "Search users by name or username fragment.",
    inputShape: { query: z.string(), limit: z.coerce.number().int().min(1).optional().describe("Default 50") },
    async handler({ client }, args) {
      const data = await client("confluence").get(`${PROTOTYPE}/search/user`, {
        query: args.query,
        "max-results": args.limit ?? 50,
      });
      const results: any[] = data?.result ?? [];
      const items = results.map((u) => {
        const username = u?.username ?? u?.name;
        const userKey = u?.userKey ?? u?.key;
        const displayName = u?.title ?? u?.displayName;
        const email = u?.displayableEmail ?? u?.email;
        return {
          ...(username !== undefined ? { username } : {}),
          ...(userKey !== undefined ? { userKey } : {}),
          ...(displayName !== undefined ? { displayName } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(!username && !userKey ? { diagnostic: "unrecognized identity shape: no username or user key" } : {}),
        };
      });
      return {
        total: data?.totalSize ?? null,
        returned: results.length,
        items,
        unrecognizedIdentityCount: items.filter((u) => "diagnostic" in u).length,
      };
    },
  },
  {
    name: "confluence_get_user",
    product: "confluence",
    description: "One user (username, key, display name, e-mail, status) with group memberships.",
    inputShape: { ...userShape, include_groups: boolArg.optional().describe("Default true") },
    async handler({ client }, args) {
      const c = client("confluence");
      const user = compactUser(await c.get(`${API}/user`, { username: args.username, expand: "status" }));
      if (args.include_groups !== false) {
        // memberof is paged by the server; read at most MAX_GROUPS names and say when there are more
        const groups = await c.getPagedConfluence(`${API}/user/memberof`, { username: args.username }, 200, MAX_GROUPS + 1);
        user.groups = groups.slice(0, MAX_GROUPS).map((g: any) => g.name).sort();
        if (groups.length > MAX_GROUPS) user.groupsTruncated = `first ${MAX_GROUPS}; use confluence_list_groups / group members for the rest`;
      }
      return user;
    },
  },
  {
    name: "confluence_list_groups",
    product: "confluence",
    description: "Groups (server-side paging).",
    inputShape: { ...pageShape(200) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 200;
      const data = await client("confluence").get(`${API}/group`, { start: offset, limit });
      return serverPage((data?.results ?? []).map((g: any) => g.name), offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_get_group_members",
    product: "confluence",
    description: "Members of a group (server-side paging).",
    inputShape: { group: z.string(), ...pageShape(100) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const data = await client("confluence").get(`${API}/group/${seg(args.group)}/member`, {
        start: offset,
        limit,
        expand: "status",
      });
      return serverPage((data?.results ?? []).map(compactUser), offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_create_user",
    product: "confluence",
    write: true,
    description: "Create a user in the internal directory.",
    inputShape: {
      ...userShape,
      full_name: z.string(),
      email: z.string(),
      password: z.string().optional(),
      notify: boolArg.optional().describe("E-mail the user (default true)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body: Record<string, unknown> = {
        userName: args.username,
        fullName: args.full_name,
        email: args.email,
        notifyViaEmail: args.notify ?? true,
      };
      if (args.password) body.password = args.password;
      return guardedWrite(client("confluence"), args, {
        method: "POST",
        path: `${API}/admin/user`,
        json: body,
        secretKeys: ["password"],
        summary: `Create user ${args.username}`,
      });
    },
  },
  {
    name: "confluence_set_user_enabled",
    product: "confluence",
    write: true,
    description: "Enable or disable a user (disabled users cannot log in and do not use a license).",
    inputShape: { ...userShape, enabled: boolArg, ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "PUT",
        path: `${API}/admin/user/${seg(args.username)}/${args.enabled ? "enable" : "disable"}`,
        summary: `${args.enabled ? "Enable" : "Disable"} user ${args.username}`,
      });
    },
  },
  {
    name: "confluence_create_group",
    product: "confluence",
    write: true,
    description: "Create a group.",
    inputShape: { name: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "POST",
        path: `${API}/admin/group`,
        json: { type: "group", name: args.name },
        summary: `Create group ${args.name}`,
      });
    },
  },
  {
    name: "confluence_delete_group",
    product: "confluence",
    write: true,
    description: "Delete a group (space permissions granted to it are removed).",
    inputShape: { name: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "DELETE",
        path: `${API}/admin/group/${seg(args.name)}`,
        summary: `DELETE group ${args.name}`,
      });
    },
  },
  {
    name: "confluence_add_user_to_group",
    product: "confluence",
    write: true,
    description: "Add a user to a group.",
    inputShape: { ...userShape, group: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "PUT",
        path: `${API}/user/${seg(args.username)}/group/${seg(args.group)}`,
        summary: `Add ${args.username} to ${args.group}`,
      });
    },
  },
  {
    name: "confluence_remove_user_from_group",
    product: "confluence",
    write: true,
    description: "Remove a user from a group.",
    inputShape: { ...userShape, group: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "DELETE",
        path: `${API}/user/${seg(args.username)}/group/${seg(args.group)}`,
        summary: `Remove ${args.username} from ${args.group}`,
      });
    },
  },
];
