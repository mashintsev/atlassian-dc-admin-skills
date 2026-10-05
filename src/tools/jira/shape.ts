/**
 * Shared Jira helpers for the content tools ported from sooperset/mcp-atlassian (MIT):
 * compact issue shape, epic field discovery and DC user identifiers.
 */

import type { AtlassianClient } from "../../client.js";
import { jiraWikiToMarkdown } from "../../markup.js";

export const API = "/rest/api/2";
export const AGILE = "/rest/agile/1.0";

/** Default fields requested from search/get when the caller does not pass `fields`. */
export const DEFAULT_ISSUE_FIELDS = [
  "summary", "status", "issuetype", "priority", "assignee", "reporter", "created", "updated",
  "labels", "components", "fixVersions", "parent", "resolution", "duedate",
].join(",");

function userName(u: any): string | undefined {
  return u ? (u.name ?? u.key ?? u.displayName) : undefined;
}

/**
 * Compact issue (token waste catalogue of eunsanMountain/atlassian-skills applied):
 * flat names instead of objects, no avatars/self, body only when asked for.
 * Fields that are not in the standard set (custom fields, extra requested fields) are kept
 * under `fields` as returned, so `fields=customfield_10100` still reaches the caller.
 */
export function compactIssue(issue: any, opts: { body?: boolean; markdown?: boolean } = {}): Record<string, unknown> {
  const f = issue?.fields ?? {};
  const out: Record<string, unknown> = {
    key: issue?.key,
    type: f.issuetype?.name,
    status: f.status?.name,
    priority: f.priority?.name,
    assignee: userName(f.assignee),
    summary: f.summary,
    reporter: userName(f.reporter),
    resolution: f.resolution?.name,
    created: f.created,
    updated: f.updated,
    due: f.duedate,
    parent: f.parent?.key,
    labels: f.labels,
    components: (f.components ?? []).map((c: any) => c.name),
    fixVersions: (f.fixVersions ?? []).map((v: any) => v.name),
  };
  if (opts.body && f.description != null) {
    out.description = opts.markdown === false ? f.description : jiraWikiToMarkdown(String(f.description));
  }
  const known = new Set([
    "summary", "status", "issuetype", "priority", "assignee", "reporter", "created", "updated", "labels",
    "components", "fixVersions", "parent", "resolution", "duedate", "description",
  ]);
  const extra = Object.fromEntries(Object.entries(f).filter(([k, v]) => !known.has(k) && v != null));
  if (Object.keys(extra).length) out.fields = extra;
  return out;
}

export interface EpicFields {
  epicLink?: string;
  epicName?: string;
  epicStatus?: string;
  epicColor?: string;
}

const epicCache = new WeakMap<AtlassianClient, Promise<EpicFields>>();

/** Discover Epic Link / Epic Name / Epic Status / Epic Colour custom field ids once per client. */
export function discoverEpicFields(client: AtlassianClient): Promise<EpicFields> {
  let p = epicCache.get(client);
  if (!p) {
    p = (async () => {
      const fields: any[] = (await client.get(`${API}/field`)) ?? [];
      const out: EpicFields = {};
      for (const fld of fields) {
        const custom = String(fld.schema?.custom ?? "");
        const name = String(fld.name ?? "").toLowerCase();
        if (custom.endsWith(":gh-epic-link") || name === "epic link") out.epicLink ??= fld.id;
        else if (custom.endsWith(":gh-epic-label") || name === "epic name" || name === "epic title") out.epicName ??= fld.id;
        else if (custom.endsWith(":gh-epic-status") || name === "epic status") out.epicStatus ??= fld.id;
        else if (custom.endsWith(":gh-epic-color") || name === "epic colour" || name === "epic color") out.epicColor ??= fld.id;
      }
      return out;
    })();
    epicCache.set(client, p);
  }
  return p;
}

/** DC user reference: always `{name: username}` (accountId is Cloud-only). */
export function userRef(username: string | null | undefined): { name: string } | null {
  return username ? { name: username } : null;
}
