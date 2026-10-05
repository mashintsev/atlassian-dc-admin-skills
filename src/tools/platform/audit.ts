/**
 * Advanced auditing (atlassian-audit-plugin), shared by Jira 8.8+ and Confluence 7.5+.
 * Parameters checked against atlassian-audit-plugin 3.1.19 AuditRestResource.
 */

import { z } from "zod";
import type { ToolDef } from "../types.js";
import { listArg } from "../util.js";
import { productShape } from "./plugins.js";

const AUDIT = "/rest/auditing/1.0";

function compactEvent(e: any): Record<string, unknown> {
  return {
    timestamp: e.timestamp,
    author: e.author?.name ?? e.author?.id ?? null,
    authorType: e.author?.type ?? null,
    category: e.type?.category ?? null,
    action: e.type?.action ?? null,
    affected: (e.affectedObjects ?? []).map((o: any) => `${o.type}:${o.name ?? o.id}`),
    changes: (e.changedValues ?? []).map((v: any) => ({ key: v.key, from: v.from, to: v.to })),
    source: e.source ?? null,
    node: e.node ?? null,
    method: e.method ?? null,
  };
}

export const auditTools: ToolDef[] = [
  {
    name: "atlassian_audit_events",
    product: "both",
    description:
      "Audit log events, newest first: who changed what (users, groups, permissions, schemes, apps, settings). " +
      "Filter by time range (ISO 8601), free-text search, categories, actions, author user ids, affected object. " +
      "Page with page_cursor from the previous result.",
    inputShape: {
      ...productShape,
      from: z.string().optional().describe("ISO timestamp, e.g. 2026-10-01T00:00:00Z"),
      to: z.string().optional(),
      search: z.string().optional(),
      categories: listArg.optional().describe("e.g. 'Users and groups', 'Permissions'"),
      actions: listArg.optional(),
      user_ids: listArg.optional().describe("Author user keys / ids"),
      affected_object: z.string().optional().describe("type,id e.g. USER,JIRAUSER10000"),
      limit: z.coerce.number().int().min(1).max(1000).optional().describe("Default 50"),
      page_cursor: z.string().optional(),
      raw: z.boolean().optional().describe("Return full event objects"),
    },
    async handler({ client }, args) {
      const data = await client(args.product).get(`${AUDIT}/events`, {
        from: args.from,
        to: args.to,
        search: args.search,
        categories: args.categories?.join(","),
        actions: args.actions?.join(","),
        userIds: args.user_ids?.join(","),
        affectedObject: args.affected_object,
        limit: args.limit ?? 50,
        pageCursor: args.page_cursor,
      });
      const entities: any[] = data?.entities ?? [];
      return {
        returned: entities.length,
        lastPage: data?.pagingInfo?.lastPage ?? null,
        nextPageCursor: data?.pagingInfo?.nextPageCursor ?? null,
        items: args.raw ? entities : entities.map(compactEvent),
      };
    },
  },
  {
    name: "atlassian_audit_settings",
    product: "both",
    description: "Audit configuration: retention period, coverage level per area, excluded (denylisted) actions.",
    inputShape: { ...productShape },
    async handler({ client }, args) {
      const c = client(args.product);
      const [retention, coverage, denylist] = await Promise.all([
        c.get(`${AUDIT}/configuration/retention`),
        c.get(`${AUDIT}/configuration/coverage`),
        c.get(`${AUDIT}/configuration/denylist`),
      ]);
      return { retention, coverage, denylist };
    },
  },
];
