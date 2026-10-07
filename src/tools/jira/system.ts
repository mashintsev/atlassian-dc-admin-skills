/** Jira DC system administration: server, cluster, indexing, application properties, licenses. */

import { z } from "zod";
import { ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, capList, contains, dryRunShape, fullListsShape, guardedWrite, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";
const REINDEX_TYPES = ["FOREGROUND", "BACKGROUND", "BACKGROUND_PREFERRED"] as const;

export const jiraSystemTools: ToolDef[] = [
  {
    name: "jira_server_info",
    product: "jira",
    description: "Jira version, build number, base URL, deployment type and server time.",
    inputShape: {},
    async handler({ client }) {
      return client("jira").get(`${API}/serverInfo`);
    },
  },
  {
    name: "jira_cluster_nodes",
    product: "jira",
    description: "Data Center cluster nodes: node id, state (ACTIVE/OFFLINE), alive flag, IP, cache port, version.",
    inputShape: {},
    async handler({ client }) {
      return client("jira").get(`${API}/cluster/nodes`);
    },
  },
  {
    name: "jira_index_summary",
    product: "jira",
    description: "Index health: issue counts in database vs index, last indexed time, per-node replication queues.",
    inputShape: {},
    async handler({ client }) {
      return client("jira").get(`${API}/index/summary`);
    },
  },
  {
    name: "jira_reindex_status",
    product: "jira",
    description: "Current (or given) reindex task: progress percent, type, submitted/started/finished time.",
    inputShape: { task_id: z.coerce.number().int().optional().describe("Reindex task id (default: the latest)") },
    async handler({ client }, args) {
      return client("jira").get(`${API}/reindex`, { taskId: args.task_id });
    },
  },
  {
    name: "jira_start_reindex",
    product: "jira",
    write: true,
    unverifiable: "Jira starts a reindex task each time; a running or finished reindex is not a target state",
    description:
      "Start a full reindex. FOREGROUND locks Jira for all users; BACKGROUND_PREFERRED (default) keeps it usable. " +
      "Follow progress with jira_reindex_status.",
    inputShape: {
      type: z.enum(REINDEX_TYPES).optional().describe("Default BACKGROUND_PREFERRED"),
      index_comments: boolArg.optional(),
      index_change_history: boolArg.optional(),
      index_worklogs: boolArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const type = args.type ?? "BACKGROUND_PREFERRED";
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/reindex`,
        params: {
          type,
          indexComments: args.index_comments ?? false,
          indexChangeHistory: args.index_change_history ?? false,
          indexWorklogs: args.index_worklogs ?? false,
        },
        summary: `Start ${type} reindex`,
      });
    },
  },
  {
    name: "jira_get_application_properties",
    product: "jira",
    description: "Application properties (General configuration): one by exact key, or a list filtered by key fragment.",
    inputShape: {
      key: z.string().optional().describe("Exact property key, e.g. jira.title"),
      key_contains: z.string().optional(),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      if (args.key) return client("jira").get(`${API}/application-properties`, { key: args.key });
      // endpoint has no paging; keyFilter (a regex) narrows the list on the server
      const keyFilter = args.key_contains ? `.*${args.key_contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*` : undefined;
      const all: any[] = (await client("jira").get(`${API}/application-properties`, { keyFilter })) ?? [];
      const items = all
        .filter((p) => contains(p.key, args.key_contains))
        .map((p) => ({ id: p.id, key: p.key, value: p.value, type: p.type, defaultValue: p.defaultValue }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_get_advanced_settings",
    product: "jira",
    description: "The 'Advanced settings' admin page: key, current value, default (when it differs), type and description.",
    inputShape: { ...pageShape(100) },
    async handler({ client }, args) {
      const data: any[] = (await client("jira").get(`${API}/application-properties/advanced-settings`)) ?? [];
      const items = data.map((p: any) => ({
        key: p.key ?? p.id,
        value: p.value,
        default: p.defaultValue !== undefined && String(p.defaultValue) !== String(p.value) ? p.defaultValue : undefined,
        type: p.type,
        description: p.desc || p.description || undefined,
      }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_set_application_property",
    aliases: { id: "key" },
    product: "jira",
    write: true,
    description: "Change one application / advanced setting property by key.",
    inputShape: {
      key: z.string().describe("Property key, e.g. jira.issue.cache.capacity"),
      value: z.coerce.string(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (!args.key) throw new ValidationError("key is required");
      const c = client("jira");
      const summary = `Set application property ${args.key}=${args.value}`;
      const read = async () => {
        const p = await c.get(`${API}/application-properties`, { key: args.key });
        return Array.isArray(p) ? p.find((x: any) => x.key === args.key) : p;
      };
      const before = await read();
      if (before?.value !== undefined && String(before.value) === args.value) return alreadySatisfied(summary, "the property already has this value");
      const req = { method: "PUT" as const, path: `${API}/application-properties/${encodeURIComponent(args.key)}`, json: { id: args.key, value: args.value }, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "set-application-property", key: args.key, value: args.value }, state: { value: before?.value ?? null } };
      const result = await guardedWrite(c, args, req);
      const after = await read();
      if (String(after?.value) !== args.value) throw new VerificationError(`${summary}: Jira reports another value afterwards`, { key: args.key, value: after?.value ?? null });
      return result;
    },
  },
  {
    name: "jira_application_roles",
    product: "jira",
    description: "Applications (Software, Service Management, Core): groups, default groups, licensed seats used/available.",
    inputShape: { ...fullListsShape },
    async handler({ client }, args) {
      const roles: any[] = (await client("jira").get(`${API}/applicationrole`)) ?? [];
      return roles.map((r) => {
        const out: Record<string, unknown> = { key: r.key, name: r.name };
        capList(out, "groups", r.groups, args.full_lists);
        capList(out, "defaultGroups", r.defaultGroups, args.full_lists);
        return {
          ...out,
          numberOfSeats: r.numberOfSeats,
          remainingSeats: r.remainingSeats,
          userCount: r.userCount,
          hasUnlimitedSeats: r.hasUnlimitedSeats,
          platform: r.platform,
        };
      });
    },
  },
];
