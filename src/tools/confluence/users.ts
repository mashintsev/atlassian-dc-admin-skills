/**
 * Confluence DC user and group administration.
 * Paths and bodies checked against confluence-rest-client 10.2.17 (RemotePersonServiceImpl,
 * RemoteGroupServiceImpl) and confluence-java-api 9.2.16 (UserDetailsForCreation).
 */

import { z } from "zod";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import { seg, type AtlassianClient } from "../../client.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite, pageShape, pick, serverPage, type WriteRequest } from "../util.js";

const API = "/rest/api";
const PROTOTYPE = "/rest/prototype/1";
const MAX_GROUPS = 200;
const USER_FIELDS = ["type", "username", "userKey", "displayName", "email", "status"];

function compactUser(u: any): Record<string, unknown> {
  return pick(u, USER_FIELDS);
}

export interface ResolvedConfluenceUser {
  username: string;
  userKey: string;
  displayName?: string;
  email?: string;
}

function userEmail(user: any): string | undefined {
  const email = user?.email ?? user?.displayableEmail;
  return typeof email === "string" && email.length > 0 ? email : undefined;
}

function requireActiveUser(user: any, email?: string): ResolvedConfluenceUser {
  const username = user?.username ?? user?.name;
  const userKey = user?.userKey ?? user?.key;
  if (typeof username !== "string" || !username || typeof userKey !== "string" || !userKey) {
    throw new ValidationError("Resolved Confluence user has no stable username and user key");
  }
  const status = typeof user?.status === "string" ? user.status.toLowerCase() : undefined;
  const active = status === "active" || (status === undefined && (user?.status?.active === true || user?.active === true));
  if (!active) {
    throw new ValidationError(`Confluence user '${username}' is inactive or its status is unavailable`);
  }
  const actualEmail = userEmail(user);
  if (email && (!actualEmail || actualEmail.toLowerCase() !== email.toLowerCase())) {
    throw new ValidationError(`Confluence user '${username}' does not have the exact requested email`);
  }
  return {
    username,
    userKey,
    ...(typeof (user?.title ?? user?.displayName) === "string" ? { displayName: user.title ?? user.displayName } : {}),
    ...(actualEmail ? { email: actualEmail } : {}),
  };
}

function usernameFromSearchResult(user: any): string | undefined {
  const username = user?.username ?? user?.name;
  return typeof username === "string" && username.length > 0 ? username : undefined;
}

/** Resolve exactly one active account for permission grants; fail closed on incomplete evidence. */
export async function resolveConfluenceGrantUser(
  client: AtlassianClient,
  identity: { username?: string; email?: string },
): Promise<ResolvedConfluenceUser> {
  const username = identity.username;
  const email = identity.email;
  if (!!username === !!email) throw new ValidationError("provide exactly one username or email for user resolution");
  const query = username ?? email!;
  let direct: any;
  try {
    direct = await client.get(`${API}/user`, { username: query, expand: "status" });
  } catch (error) {
    if (!isHttpStatusError(error) || error.status !== 404 || !email) {
      throw new ValidationError(`Could not verify the requested Confluence user: ${String((error as Error)?.message ?? error)}`);
    }
  }
  if (direct) {
    const directUsername = direct?.username ?? direct?.name;
    if (directUsername === query) return requireActiveUser(direct, email);
    if (!email) throw new ValidationError("Exact username lookup returned a different account");
  }
  if (!email) throw new ValidationError(`Confluence username '${query}' was not found`);

  const maxResults = 100;
  let search: any;
  try {
    search = await client.get(`${PROTOTYPE}/search/user`, { query: email, "max-results": maxResults });
  } catch (error) {
    throw new ValidationError(`Could not search Confluence users by exact email: ${String((error as Error)?.message ?? error)}`);
  }
  if (!Array.isArray(search?.result)) throw new ValidationError("Confluence user search returned an unknown response shape");
  const results: any[] = search.result;
  if (!Number.isFinite(search.totalSize)) {
    throw new ValidationError("Confluence user search did not report a total; exact email uniqueness cannot be established");
  }
  if (search.totalSize > results.length) {
    throw new ValidationError("Confluence user search was truncated; exact email uniqueness cannot be established");
  }
  if (search.totalSize < results.length || search.totalSize > maxResults) {
    throw new ValidationError("Confluence user search returned inconsistent or capped results; exact email uniqueness cannot be established");
  }

  if (results.some((candidate) => !userEmail(candidate))) {
    throw new ValidationError("A user search result has no email evidence; exact uniqueness cannot be established");
  }
  const emailCandidates = results.filter((candidate) => userEmail(candidate)!.toLowerCase() === email.toLowerCase());
  const matching: ResolvedConfluenceUser[] = [];
  for (const candidate of emailCandidates) {
    const candidateUsername = usernameFromSearchResult(candidate);
    if (!candidateUsername) throw new ValidationError("An exact-email search match has no usable username");
    let hydrated: any;
    try {
      hydrated = await client.get(`${API}/user`, { username: candidateUsername, expand: "status" });
    } catch (error) {
      throw new ValidationError(`Could not verify exact-email match '${candidateUsername}': ${String((error as Error)?.message ?? error)}`);
    }
    if ((hydrated?.username ?? hydrated?.name) !== candidateUsername) {
      throw new ValidationError("An exact-email search match resolved to a different username");
    }
    matching.push(requireActiveUser(hydrated, email));
  }
  if (matching.length !== 1) {
    throw new ValidationError(matching.length === 0
      ? "No active Confluence user has the exact requested email"
      : "Multiple active Confluence users have the exact requested email");
  }
  return matching[0];
}

const userShape = { user: z.string().describe("Username of an existing user") };

// -- target-state reads for the write tools ------------------------------------------------

/** The user, or null when Confluence answers 404. */
async function findUser(client: AtlassianClient, username: string): Promise<any | null> {
  try {
    return await client.get(`${API}/user`, { username, expand: "status" });
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

/** true/false for an active or disabled user; undefined when Confluence reports no status. */
function isActive(user: any): boolean | undefined {
  const status = typeof user?.status === "string" ? user.status.toLowerCase() : undefined;
  if (status === "active" || status === "current") return true;
  if (status) return false;
  if (typeof user?.status?.active === "boolean") return user.status.active;
  return typeof user?.active === "boolean" ? user.active : undefined;
}

async function groupExists(client: AtlassianClient, name: string): Promise<boolean> {
  try {
    await client.get(`${API}/group/${seg(name)}`);
    return true;
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return false;
    throw e;
  }
}

/** Whether the user is a member of the group (memberof is read up to 2,000 groups). */
async function isMember(client: AtlassianClient, username: string, group: string): Promise<boolean> {
  const groups = await client.getPagedConfluence(`${API}/user/memberof`, { username }, 200, 2000);
  return groups.some((g: any) => String(g?.name).toLowerCase() === group.toLowerCase());
}

/**
 * Write unless the check says the target state holds; after the write, read back and fail with a
 * VerificationError carrying the observed state when the change is not visible.
 */
async function checkedWrite(
  client: AtlassianClient,
  args: { dry_run?: boolean },
  req: WriteRequest,
  check: () => Promise<{ done: boolean; observed: unknown }>,
  satisfiedReason: string,
  extra: Record<string, unknown> = {},
) {
  if ((await check()).done) return alreadySatisfied(req.summary, satisfiedReason);
  if (args.dry_run !== false) return { ...(await guardedWrite(client, args, req)), ...extra };
  const result = await guardedWrite(client, args, req);
  const after = await check();
  if (!after.done) throw new VerificationError(`${req.summary}: the change is not visible afterwards`, after.observed);
  return result;
}

export const confluenceUserTools: ToolDef[] = [
  {
    name: "confluence_find_users",
    product: "confluence",
    description: "Search users by name or username fragment.",
    inputShape: { query: z.string(), limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 50, maximum 500") },
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
    aliases: { username: "user" },
    product: "confluence",
    description: "One user (username, key, display name, e-mail, status) with group memberships.",
    inputShape: { ...userShape, include_groups: boolArg.optional().describe("Default true") },
    async handler({ client }, args) {
      const c = client("confluence");
      const user = compactUser(await c.get(`${API}/user`, { username: args.user, expand: "status" }));
      if (args.include_groups !== false) {
        // memberof is paged by the server; read at most MAX_GROUPS names and say when there are more
        const groups = await c.getPagedConfluence(`${API}/user/memberof`, { username: args.user }, 200, MAX_GROUPS + 1);
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
      username: z.string(),
      full_name: z.string(),
      email: z.string(),
      password: z.string().optional(),
      notify: boolArg.optional().describe("E-mail the user (default true)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const body: Record<string, unknown> = {
        userName: args.username,
        fullName: args.full_name,
        email: args.email,
        notifyViaEmail: args.notify ?? true,
      };
      if (args.password) body.password = args.password;
      const req: WriteRequest = { method: "POST", path: `${API}/admin/user`, json: body, secretKeys: ["password"], summary: `Create user ${args.username}` };
      return checkedWrite(c, args, req, async () => {
        const u = await findUser(c, args.username);
        return { done: !!u, observed: u ? compactUser(u) : null };
      }, "a user with this username already exists");
    },
  },
  {
    name: "confluence_set_user_enabled",
    aliases: { username: "user" },
    product: "confluence",
    write: true,
    description: "Enable or disable a user (disabled users cannot log in and do not use a license).",
    inputShape: { ...userShape, enabled: boolArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const enabled = Boolean(args.enabled);
      const req: WriteRequest = {
        method: "PUT",
        path: `${API}/admin/user/${seg(args.user)}/${enabled ? "enable" : "disable"}`,
        summary: `${enabled ? "Enable" : "Disable"} user ${args.user}`,
      };
      return checkedWrite(c, args, req, async () => {
        const u = await findUser(c, args.user);
        if (!u) throw new ValidationError(`No Confluence user '${args.user}'`);
        return { done: isActive(u) === enabled, observed: compactUser(u) };
      }, `the user is already ${enabled ? "enabled" : "disabled"}`);
    },
  },
  {
    name: "confluence_create_group",
    product: "confluence",
    write: true,
    description: "Create a group.",
    inputShape: { name: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const req: WriteRequest = { method: "POST", path: `${API}/admin/group`, json: { type: "group", name: args.name }, summary: `Create group ${args.name}` };
      return checkedWrite(c, args, req, async () => {
        const exists = await groupExists(c, args.name);
        return { done: exists, observed: { group: args.name, exists } };
      }, "the group already exists");
    },
  },
  {
    name: "confluence_delete_group",
    product: "confluence",
    write: true,
    description: "Delete a group (space permissions granted to it are removed).",
    inputShape: { name: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const req: WriteRequest = { method: "DELETE", path: `${API}/admin/group/${seg(args.name)}`, summary: `DELETE group ${args.name}` };
      return checkedWrite(c, args, req, async () => {
        const exists = await groupExists(c, args.name);
        return { done: !exists, observed: { group: args.name, exists } };
      }, "no such group");
    },
  },
  {
    name: "confluence_add_user_to_group",
    aliases: { username: "user" },
    product: "confluence",
    write: true,
    description: "Add a user to a group.",
    inputShape: { ...userShape, group: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const req: WriteRequest = { method: "PUT", path: `${API}/user/${seg(args.user)}/group/${seg(args.group)}`, summary: `Add ${args.user} to ${args.group}` };
      return checkedWrite(c, args, req, async () => {
        const member = await isMember(c, args.user, args.group);
        return { done: member, observed: { user: args.user, group: args.group, member } };
      }, "the user is already a member of the group");
    },
  },
  {
    name: "confluence_remove_user_from_group",
    aliases: { username: "user" },
    product: "confluence",
    write: true,
    description: "Remove a user from a group.",
    inputShape: { ...userShape, group: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const req: WriteRequest = { method: "DELETE", path: `${API}/user/${seg(args.user)}/group/${seg(args.group)}`, summary: `Remove ${args.user} from ${args.group}` };
      return checkedWrite(c, args, req, async () => {
        const member = await isMember(c, args.user, args.group);
        return { done: !member, observed: { user: args.user, group: args.group, member } };
      }, "the user is not a member of the group");
    },
  },
];
