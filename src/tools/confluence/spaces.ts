/**
 * Confluence DC spaces, space permissions and global permissions.
 *
 * Permission endpoints (`/space/{key}/permissions/{user|group|anonymous}[/grant|/revoke]`,
 * `/permissions/...`) and the OperationDescription body `{targetType, operationKey}`
 * are checked against confluence-rest-client 10.2.17 and confluence-java-api 9.2.16.
 */

import { z } from "zod";
import { seg } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { contains, dryRunShape, guardedWrite, listArg, pageShape, paginate, serverPage } from "../util.js";

const API = "/rest/api";
/** Upper bound of the client-side space scan used only when CQL is rejected. */
const SPACE_SCAN_MAX = 2000;

/** Space operation keys (OperationKey) usable in space permissions. */
export const SPACE_OPERATIONS = [
  "read", "create", "delete", "export", "administer", "restrict", "delete_own", "delete_mail", "purge", "restore",
] as const;
const TARGET_TYPES = ["space", "page", "blogpost", "comment", "attachment", "application", "user"] as const;

const subjectShape = {
  subject_type: z.enum(["user", "group", "anonymous"]),
  subject: z.string().optional().describe("User key or username for user, group name for group; omit for anonymous"),
};

function subjectPath(base: string, type: string, subject?: string): string {
  if (type === "anonymous") return `${base}/anonymous`;
  if (!subject) throw new ValidationError(`subject is required for subject_type=${type}`);
  return `${base}/${type}/${seg(subject)}`;
}

/** "read:space,create:page" or ["read:space"] -> [{operationKey, targetType}] */
const operationsArg = listArg.transform((items, ctx) =>
  items.map((item) => {
    const [operationKey, targetType = "space"] = item.split(":").map((s) => s.trim());
    if (!(TARGET_TYPES as readonly string[]).includes(targetType)) {
      ctx.addIssue({ code: "custom", message: `Unknown target type '${targetType}' in '${item}'` });
    }
    return { operationKey, targetType };
  }),
);

function compactSpacePermission(p: any): Record<string, unknown> {
  const subj = p.subject ?? {};
  return {
    operation: `${p.operation?.operationKey ?? p.operation?.key}:${p.operation?.targetType}`,
    subjectType: subj.type ?? (subj.username || subj.userKey ? "user" : subj.name ? "group" : "anonymous"),
    subject: subj.username ?? subj.userKey ?? subj.name ?? null,
  };
}

export const confluenceSpaceTools: ToolDef[] = [
  {
    name: "confluence_list_spaces",
    product: "confluence",
    description: "Spaces with key, name, type (global/personal) and status (current/archived).",
    inputShape: {
      type: z.enum(["global", "personal"]).optional(),
      status: z.enum(["current", "archived"]).optional(),
      name_contains: z.string().optional().describe("Space title contains (CQL space.title ~), or an exact space key"),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const params = { type: args.type, status: args.status };
      const compact = (s: any) => ({ id: s.id, key: s.key, name: s.name, type: s.type, status: s.status });
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      if (args.name_contains) {
        // Server-side: CQL over spaces (title contains, or exact key), one page.
        const q = String(args.name_contains).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const clauses = [`space.title ~ "${q}"`];
        if (/^[A-Za-z0-9~]+$/.test(args.name_contains)) clauses.push(`space.key = "${args.name_contains.toUpperCase()}"`);
        let cql = `type = space AND (${clauses.join(" OR ")})`;
        if (args.type) cql += ` AND space.type = ${args.type}`;
        try {
          const data = await c.get(`${API}/search`, { cql, start: offset, limit, expand: "space" });
          const items = (data?.results ?? [])
            .map((r: any) => r.space ?? r)
            .filter((sp: any) => !args.status || !sp.status || sp.status === args.status)
            .map(compact);
          return { cql, ...serverPage(items, offset, limit, data?.totalSize ?? null, !data?._links?.next) };
        } catch (e) {
          if (!isHttpStatusError(e) || e.status !== 400) throw e;
          // Fallback when the instance rejects the CQL: scan at most SPACE_SCAN_MAX spaces.
          const all = await c.getPagedConfluence(`${API}/space`, params, 200, SPACE_SCAN_MAX);
          const items = all.map(compact).filter((sp) => contains(sp.name, args.name_contains) || contains(sp.key, args.name_contains));
          return { fallback: `CQL rejected; scanned ${all.length} spaces`, ...paginate(items, args, 100) };
        }
      }
      const data = await c.get(`${API}/space`, { ...params, start: offset, limit });
      return serverPage((data?.results ?? []).map(compact), offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_get_space",
    product: "confluence",
    description: "One space with description, homepage and creator.",
    inputShape: { space_key: z.string() },
    async handler({ client }, args) {
      const s = await client("confluence").get(`${API}/space/${seg(args.space_key)}`, {
        expand: "description.plain,homepage,history",
      });
      return {
        id: s?.id,
        key: s?.key,
        name: s?.name,
        type: s?.type,
        status: s?.status,
        description: s?.description?.plain?.value ?? "",
        homepage: s?.homepage ? { id: s.homepage.id, title: s.homepage.title } : null,
        createdBy: s?.history?.createdBy?.username ?? null,
        createdDate: s?.history?.createdDate ?? null,
      };
    },
  },
  {
    name: "confluence_get_space_permissions",
    product: "confluence",
    description:
      "Space permissions as operation:target per subject (all subjects, or one user/group/anonymous). " +
      "Use it to answer 'who can administer / delete in space X'.",
    inputShape: {
      space_key: z.string(),
      subject_type: z.enum(["user", "group", "anonymous"]).optional(),
      subject: z.string().optional(),
    },
    async handler({ client }, args) {
      const base = `${API}/space/${seg(args.space_key)}/permissions`;
      const path = args.subject_type ? subjectPath(base, args.subject_type, args.subject) : base;
      const data = await client("confluence").get(path);
      const list: any[] = Array.isArray(data) ? data : (data?.results ?? []);
      const grouped: Record<string, string[]> = {};
      for (const p of list.map(compactSpacePermission)) {
        const who = p.subject ? `${p.subjectType}:${p.subject}` : String(p.subjectType);
        (grouped[who] ??= []).push(String(p.operation));
      }
      for (const ops of Object.values(grouped)) ops.sort();
      return { space: args.space_key, subjects: Object.keys(grouped).length, permissions: grouped };
    },
  },
  {
    name: "confluence_grant_space_permissions",
    product: "confluence",
    write: true,
    description:
      `Grant space permissions to a user, group or anonymous. operations: list of 'operation:target', ` +
      `e.g. read:space, create:page, delete:attachment, administer:space. Operations: ${SPACE_OPERATIONS.join(", ")}.`,
    inputShape: { space_key: z.string(), ...subjectShape, operations: operationsArg, ...dryRunShape },
    async handler({ client }, args) {
      const base = `${API}/space/${seg(args.space_key)}/permissions`;
      return guardedWrite(client("confluence"), args, {
        method: "PUT",
        path: `${subjectPath(base, args.subject_type, args.subject)}/grant`,
        json: args.operations,
        summary: `Grant ${args.operations.map((o: any) => `${o.operationKey}:${o.targetType}`).join(", ")} in ${args.space_key} to ${args.subject_type}${args.subject ? `:${args.subject}` : ""}`,
      });
    },
  },
  {
    name: "confluence_revoke_space_permissions",
    product: "confluence",
    write: true,
    description: "Revoke space permissions ('operation:target' list) from a user, group or anonymous.",
    inputShape: { space_key: z.string(), ...subjectShape, operations: operationsArg, ...dryRunShape },
    async handler({ client }, args) {
      const base = `${API}/space/${seg(args.space_key)}/permissions`;
      return guardedWrite(client("confluence"), args, {
        method: "PUT",
        path: `${subjectPath(base, args.subject_type, args.subject)}/revoke`,
        json: args.operations,
        summary: `Revoke ${args.operations.map((o: any) => `${o.operationKey}:${o.targetType}`).join(", ")} in ${args.space_key} from ${args.subject_type}${args.subject ? `:${args.subject}` : ""}`,
      });
    },
  },
  {
    name: "confluence_get_global_permissions",
    product: "confluence",
    description:
      "Global permissions (use / create space / administer / system administer...) of a user, group, " +
      "anonymous or unlicensed users.",
    inputShape: {
      subject_type: z.enum(["user", "group", "anonymous", "unlicensed"]),
      subject: z.string().optional().describe("User key or username, or group name"),
    },
    async handler({ client }, args) {
      const path =
        args.subject_type === "unlicensed"
          ? `${API}/permissions/unlicensed`
          : subjectPath(`${API}/permissions`, args.subject_type, args.subject);
      return client("confluence").get(path);
    },
  },
  {
    name: "confluence_archive_space",
    product: "confluence",
    write: true,
    description: "Archive a space (hidden from navigation and search by default; reversible in Space tools).",
    inputShape: { space_key: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "PUT",
        path: `${API}/space/${seg(args.space_key)}/archive`,
        summary: `Archive space ${args.space_key}`,
      });
    },
  },
  {
    name: "confluence_delete_space",
    product: "confluence",
    write: true,
    description:
      "Permanently delete a space and all its content. Runs as a long task: follow it with confluence_get_long_task.",
    inputShape: { space_key: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "DELETE",
        path: `${API}/space/${seg(args.space_key)}`,
        summary: `PERMANENTLY delete space ${args.space_key} and all its content`,
      });
    },
  },
];
