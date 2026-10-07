/**
 * Shared Jira helpers for the content tools ported from sooperset/mcp-atlassian (MIT):
 * compact issue shape, epic field discovery and DC user identifiers.
 */

import { ValidationError } from "../../errors.js";
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
/** List tools refuse `fields=*all`: every field of 20–100 issues is never needed at once. */
export function refuseAllFields(fields: unknown): void {
  if (typeof fields === "string" && fields.split(",").some((f) => f.trim() === "*all")) {
    throw new ValidationError("fields=*all is not supported in issue lists: name the fields (e.g. fields=customfield_10100), or read one issue with jira_get_issue fields=*all");
  }
}

/**
 * A field value reduced to what a reader needs: options to their value (cascading: "parent / child"),
 * users to their name, SLAs to the remaining time or breached state, other references to name/key/title.
 */
export function flattenFieldValue(v: any): unknown {
  if (v === null || v === undefined) return undefined;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) {
    const items = v.map(flattenFieldValue).filter((x) => x !== undefined);
    return items.length ? items : undefined;
  }
  if (v.ongoingCycle || v.completedCycles) {
    const on = v.ongoingCycle;
    if (on) return on.breached ? `breached (${on.remainingTime?.friendly ?? "?"})` : `${on.remainingTime?.friendly ?? "?"} remaining`;
    const last = (v.completedCycles ?? []).at(-1);
    return last ? (last.breached ? "completed, breached" : "completed") : undefined;
  }
  if (typeof v.value === "string") return v.child?.value ? `${v.value} / ${v.child.value}` : v.value;
  for (const k of ["name", "displayName", "key", "title"]) if (typeof v[k] === "string") return v[k];
  return v;
}

const NOISE_FIELDS = ["comment", "worklog", "watches", "votes", "progress", "aggregateprogress"];

export function compactIssue(issue: any, opts: { body?: boolean; markdown?: boolean; flatten?: boolean } = {}): Record<string, unknown> {
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
  const extra = Object.fromEntries(Object.entries(f).filter(([k, v]) => !known.has(k) && !NOISE_FIELDS.includes(k) && v != null));
  if (opts.flatten) {
    // list rows: one readable column per extra field
    for (const [k, v] of Object.entries(extra)) {
      const flat = flattenFieldValue(v);
      if (flat !== undefined) out[k] = flat;
    }
  } else if (Object.keys(extra).length) out.fields = extra;
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
