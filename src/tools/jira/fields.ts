/**
 * Jira DC custom fields and screens.
 *
 * The usage audit is adapted from mcp-atlassian-for-admins
 * (list_custom_fields_usage in src/tools/fields.ts, MIT); deletion is dry-run guarded.
 */

import { z } from "zod";
import { seg } from "../../client.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, listArg, pageShape, paginate, serverPage } from "../util.js";

const API = "/rest/api/2";
const CF_SCAN_PAGE = 500;
const CF_SCAN_DEFAULT = 2000;

/** Page number (1-based) and in-page skip for an offset on a page-number endpoint. */
function pageFor(offset: number, limit: number): { page: number; skip: number } {
  return { page: Math.floor(offset / limit) + 1, skip: offset % limit };
}

export const jiraFieldTools: ToolDef[] = [
  {
    name: "jira_list_custom_fields",
    product: "jira",
    description:
      "Custom fields with usage stats (issuesWithValue, projects, screensCount, lastValueUpdate). search and project_key " +
      "are filtered by Jira and paged server-side. unused_only / min_issues / sort_by_usage need usage numbers Jira cannot " +
      `filter on: they scan at most max_scan fields (default ${CF_SCAN_DEFAULT}) and say if the scan was cut. ` +
      "Use it to audit dead fields before jira_delete_custom_fields.",
    inputShape: {
      search: z.string().optional().describe("Name filter, applied by Jira"),
      unused_only: boolArg.optional(),
      project_key: z.string().optional().describe("Only fields scoped to this project (or all projects), applied by Jira"),
      min_issues: z.coerce.number().int().optional(),
      sort_by_usage: boolArg.optional().describe("Most used first (needs a scan)"),
      max_scan: z.coerce.number().int().min(1).max(5000).optional(),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      // Resolve one project instead of downloading the project list.
      let projectIds: number[] | undefined;
      if (args.project_key) {
        const p = await c.get(`${API}/project/${seg(args.project_key)}`);
        projectIds = [Number(p.id)];
      }
      const filters = { search: args.search, projectIds };
      const compact = (f: any) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        isAllProjects: f.isAllProjects || undefined,
        projects: f.projectsCount,
        screensCount: f.screensCount,
        issuesWithValue: f.issuesWithValue,
        lastValueUpdate: f.lastValueUpdate ? new Date(f.lastValueUpdate).toISOString() : null,
      });

      const needsScan = args.unused_only || args.min_issues !== undefined || args.sort_by_usage;
      if (!needsScan) {
        // /customFields pages by page number: startAt is 1-based and the offset is (startAt - 1) * maxResults.
        const { page, skip } = pageFor(offset, limit);
        const data = await c.get(`${API}/customFields`, { ...filters, startAt: page, maxResults: limit });
        const items = (data?.values ?? []).slice(skip).map(compact);
        return serverPage(items, offset, limit, data?.total, data?.isLast);
      }

      const maxScan = args.max_scan ?? CF_SCAN_DEFAULT;
      const scanned: any[] = [];
      let total: number | undefined;
      for (let page = 1; scanned.length < maxScan; page++) {
        const data = await c.get(`${API}/customFields`, { ...filters, startAt: page, maxResults: CF_SCAN_PAGE });
        const batch: any[] = data?.values ?? [];
        total = data?.total ?? total;
        scanned.push(...batch);
        if (batch.length < CF_SCAN_PAGE || data?.isLast) break;
      }
      let items = scanned
        .slice(0, maxScan)
        .filter((f) => !args.unused_only || (f.issuesWithValue ?? 0) === 0)
        .filter((f) => args.min_issues === undefined || (f.issuesWithValue ?? 0) >= args.min_issues);
      if (args.sort_by_usage) items = items.sort((a, b) => (b.issuesWithValue ?? 0) - (a.issuesWithValue ?? 0));
      const truncated = total !== undefined && total > Math.min(scanned.length, maxScan);
      return {
        scanned: Math.min(scanned.length, maxScan),
        totalCustomFields: total ?? null,
        truncatedScan: truncated || undefined,
        ...paginate(items.map(compact), args, 50),
      };
    },
  },
  {
    name: "jira_get_field_contexts",
    product: "jira",
    description: "Contexts of a custom field: which projects and issue types each context applies to.",
    inputShape: { field_id: z.string().describe("e.g. customfield_10100") },
    async handler({ client }, args) {
      return client("jira").get(`${API}/field/${seg(args.field_id)}/contexts`);
    },
  },
  {
    name: "jira_get_field_screens",
    product: "jira",
    description: "Screens (and tabs) a field is placed on.",
    inputShape: { field_id: z.string(), ...pageShape(100) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const data = await client("jira").get(`${API}/field/${seg(args.field_id)}/screens`, {
        startAt: offset,
        maxResults: limit,
      });
      const values = Array.isArray(data) ? data : (data?.values ?? []);
      return serverPage(values, offset, limit, data?.total, data?.isLast);
    },
  },
  {
    name: "jira_delete_custom_fields",
    product: "jira",
    write: true,
    description: "Permanently delete custom fields and all their values. Irreversible; check usage first.",
    inputShape: { ids: listArg.describe("customfield_N ids"), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/customFields`,
        params: { ids: args.ids },
        summary: `PERMANENTLY delete custom fields ${args.ids.join(", ")} and their values`,
      });
    },
  },
  {
    name: "jira_list_screens",
    product: "jira",
    description: "Screens with id and name (server-side search and paging).",
    inputShape: { search: z.string().optional(), ...pageShape(100) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const data = await client("jira").get(`${API}/screens`, { startAt: offset, maxResults: limit, search: args.search });
      const values = (Array.isArray(data) ? data : (data?.values ?? [])).map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description ?? "",
      }));
      return serverPage(values, offset, limit, data?.total, data?.isLast);
    },
  },
  {
    name: "jira_get_screen",
    product: "jira",
    description: "A screen's tabs with their fields in order.",
    inputShape: { screen_id: z.coerce.number().int() },
    async handler({ client }, args) {
      const c = client("jira");
      // one call per tab; screens have few tabs
      const tabs: any[] = (await c.get(`${API}/screens/${args.screen_id}/tabs`)) ?? [];
      const fields = await Promise.all(tabs.map((t) => c.get(`${API}/screens/${args.screen_id}/tabs/${t.id}/fields`)));
      return tabs.map((t, i) => ({
        id: t.id,
        name: t.name,
        fields: (fields[i] ?? []).map((f: any) => ({ id: f.id, name: f.name, type: f.type })),
      }));
    },
  },
  {
    name: "jira_list_fields",
    product: "jira",
    description: "All system and custom fields with id, name, custom flag and schema type (no usage stats).",
    inputShape: { search: z.string().optional(), ...pageShape(100) },
    async handler({ client }, args) {
      // endpoint has no paging or search: filter and page locally
      const fields: any[] = (await client("jira").get(`${API}/field`)) ?? [];
      const needle = args.search?.toLowerCase();
      const items = fields
        .filter((f) => !needle || String(f.name).toLowerCase().includes(needle) || String(f.id).includes(needle))
        .map((f) => ({ id: f.id, name: f.name, custom: f.custom, type: f.schema?.custom ?? f.schema?.type ?? null }));
      return paginate(items, args, 100);
    },
  },
];
