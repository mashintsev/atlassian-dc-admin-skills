/**
 * Advanced auditing (atlassian-audit-plugin), shared by Jira 8.8+ and Confluence 7.5+.
 * Parameters checked against atlassian-audit-plugin 3.1.19 AuditRestResource.
 */

import { z } from "zod";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, listArg } from "../util.js";
import { productShape } from "./plugins.js";

const AUDIT = "/rest/auditing/1.0";
/** Longest changed value shown; workflow XML or scheme dumps are cut and the rest counted. */
const MAX_VALUE = 120;
/** Most events per page, and most with raw=true (full event objects). */
const MAX_LIMIT = 200;
const MAX_RAW_LIMIT = 50;

const cutValue = (v: unknown) => (typeof v === "string" && v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…(+${v.length - MAX_VALUE})` : v);

function compactEvent(e: any): Record<string, unknown> {
  return {
    timestamp: e.timestamp,
    author: e.author?.name ?? e.author?.id ?? null,
    authorType: e.author?.type ?? null,
    category: e.type?.category ?? null,
    action: e.type?.action ?? null,
    affected: (e.affectedObjects ?? []).map((o: any) => `${o.type}:${o.name ?? o.id}`),
    changes: (e.changedValues ?? []).map((v: any) => ({ key: v.key, from: cutValue(v.from), to: cutValue(v.to) })),
    source: e.source ?? null,
    node: e.node ?? null,
    method: e.method ?? null,
  };
}

/** The retention period (e.g. P3Y) from the retention configuration. */
function retentionPeriod(r: any): unknown {
  if (typeof r === "string") return r;
  return r?.period ?? r?.retentionPeriod ?? null;
}

/** Coverage as `area=level` entries, from a map of area → level or a list of {area, level}. */
function coverageLevels(c: any): string[] {
  const src = c?.levelByArea ?? c?.areas ?? c;
  if (Array.isArray(src)) return src.map((x: any) => `${x?.area ?? x?.key}=${x?.level ?? x?.value}`);
  if (!src || typeof src !== "object") return [];
  return Object.entries(src).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}=${v}`);
}

/** Names of the excluded (denylisted) actions. */
function denylistNames(d: any): string[] {
  const src = Array.isArray(d) ? d : d?.actions ?? d?.denyList ?? d?.denylist ?? [];
  return (Array.isArray(src) ? src : []).map((x: any) => (typeof x === "string" ? x : x?.name ?? x?.key ?? x?.action)).filter(Boolean);
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
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional().describe(`Default 50, max ${MAX_LIMIT}`),
      page_cursor: z.string().optional(),
      raw: boolArg.optional().describe(`Return full event objects (limit at most ${MAX_RAW_LIMIT})`),
    },
    async handler({ client }, args) {
      if (args.raw && (args.limit ?? 50) > MAX_RAW_LIMIT) {
        throw new ValidationError(`raw=true returns full event objects: use limit at most ${MAX_RAW_LIMIT}`);
      }
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
      return { retention: retentionPeriod(retention), coverage: coverageLevels(coverage), denylist: denylistNames(denylist) };
    },
  },
];
