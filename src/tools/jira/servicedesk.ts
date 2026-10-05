/**
 * Jira Service Management (Service Desk) tools.
 *
 * Ported from sooperset/mcp-atlassian (MIT, toolset jira_service_desk). Paths and query
 * parameters checked against jira-servicedesk-public-rest-api-plugin 21.3.2 (QueueResource,
 * ServiceDeskResource, RequestTypeResource, RequestTypeFieldResource, CustomerRequestResource,
 * TemporaryFileResource, AttachmentResource). The plugin has an ExperimentalOptInInterceptor,
 * so every call sends `X-ExperimentalApi: opt-in`.
 */

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, listArg, pageShape, serverPage } from "../util.js";
import { compactIssue } from "./shape.js";

const SD = "/rest/servicedeskapi";
const OPT_IN = { "X-ExperimentalApi": "opt-in" };
const PAGE_MAX = 50;

function sdGet(client: AtlassianClient, path: string, params?: Record<string, any>) {
  return client.get(`${SD}${path}`, params, undefined, OPT_IN);
}

/**
 * Walk a servicedeskapi `{values, isLastPage}` listing page by page and stop at the first match.
 * GET /servicedesk/{id} only takes the numeric id (ServiceDeskResource 21.3.2), so finding the desk
 * of a project needs the listing; stopping early keeps it to one page on most instances.
 */
async function findInPages(client: AtlassianClient, path: string, match: (v: any) => boolean, maxPages = 20): Promise<any | undefined> {
  for (let start = 0, page = 0; page < maxPages; page++) {
    const data = await sdGet(client, path, { start, limit: PAGE_MAX });
    const values: any[] = data?.values ?? [];
    const hit = values.find(match);
    if (hit) return hit;
    if (values.length === 0 || data?.isLastPage !== false) return undefined;
    start += values.length;
  }
  return undefined;
}

function compactQueue(q: any): Record<string, unknown> {
  return { id: q.id, name: q.name, issueCount: q.issueCount, jql: q.jql, fields: q.fields };
}

function compactField(f: any): Record<string, unknown> {
  return {
    fieldId: f.fieldId,
    name: f.name,
    required: f.required,
    visible: f.visible,
    type: f.jiraSchema?.type,
    custom: f.jiraSchema?.custom,
    multiple: f.jiraSchema?.type === "array",
    validValues: (f.validValues ?? []).map((v: any) => (v.value === v.label || !v.label ? v.value : `${v.value}=${v.label}`)),
    defaultValues: (f.defaultValues ?? []).map((v: any) => v.value ?? v.label),
    description: f.description,
  };
}

function isSelectLike(f: any): boolean {
  const type = String(f.jiraSchema?.type ?? "");
  const items = String(f.jiraSchema?.items ?? "");
  const custom = String(f.jiraSchema?.custom ?? "").toLowerCase();
  return type === "option" || items === "option" || /select|radiobutton|checkbox|multicheckboxes/.test(custom);
}

/** Match a user-supplied select value against validValues (by value or label, case-insensitive) → {id}. */
function selectValue(f: any, raw: unknown): unknown {
  if (raw && typeof raw === "object") return raw; // already {id}/{value}
  const needle = String(raw).trim().toLowerCase();
  const hit = (f.validValues ?? []).find(
    (v: any) => String(v.value).toLowerCase() === needle || String(v.label ?? "").toLowerCase() === needle,
  );
  if (!hit) {
    const options = (f.validValues ?? []).map((v: any) => v.label ?? v.value).join(", ");
    throw new ValidationError(`'${raw}' is not a valid value for ${f.fieldId} (${f.name}). Options: ${options}`);
  }
  return { id: String(hit.value) };
}

/** Validate required fields and normalise select / array values using the request type's field metadata. */
export function prepareFieldValues(fields: any[], values: Record<string, unknown>): Record<string, unknown> {
  const byId = new Map(fields.map((f) => [f.fieldId, f]));
  const out: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(values)) {
    if (raw === null || raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) continue;
    const f = byId.get(id);
    if (!f) {
      out[id] = raw;
      continue;
    }
    const multiple = f.jiraSchema?.type === "array";
    let v: unknown = raw;
    if (multiple && typeof v === "string") v = v.split(",").map((s) => s.trim()).filter(Boolean);
    if (isSelectLike(f)) v = Array.isArray(v) ? v.map((x) => selectValue(f, x)) : selectValue(f, v);
    out[id] = v;
  }
  const missing = fields
    .filter((f) => f.required && f.visible !== false && out[f.fieldId] === undefined)
    .map((f) => `${f.fieldId} (${f.name})`);
  if (missing.length) throw new ValidationError(`Missing required request fields: ${missing.join(", ")}`);
  return out;
}

function isOnBehalfError(e: unknown): boolean {
  if (!isHttpStatusError(e) || ![400, 403].includes(e.status)) return false;
  return /behalf|unknown user|invalid customer|not a customer|does not exist|user.*not found|permission/i.test(e.body ?? e.message);
}

export const jiraServiceDeskTools: ToolDef[] = [
  {
    name: "jira_get_service_desk_for_project",
    product: "jira",
    description: "Service desk (id, name) behind a Jira project key; null when the project is not a service project.",
    inputShape: { project_key: z.string() },
    async handler({ client }, args) {
      const key = args.project_key.toUpperCase();
      const desk = await findInPages(client("jira"), "/servicedesk", (d) => String(d.projectKey ?? "").toUpperCase() === key);
      return {
        project_key: key,
        service_desk: desk ? { id: desk.id, projectId: desk.projectId, projectKey: desk.projectKey, projectName: desk.projectName } : null,
      };
    },
  },
  {
    name: "jira_get_service_desk_queues",
    product: "jira",
    description: "Queues of a service desk with their JQL; include_count=true adds issue counts (runs one JQL count per queue).",
    inputShape: {
      service_desk_id: z.coerce.string(),
      include_count: boolArg.optional().describe("Default false; counting is expensive on large desks"),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, PAGE_MAX);
      const data = await sdGet(client("jira"), `/servicedesk/${seg(args.service_desk_id)}/queue`, {
        includeCount: args.include_count === true,
        start: offset,
        limit,
      });
      return serverPage((data?.values ?? []).map(compactQueue), offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_queue_issues",
    product: "jira",
    description: "Issues in a service desk queue (compact issue rows). include_count=true also reports the queue total.",
    inputShape: {
      service_desk_id: z.coerce.string(),
      queue_id: z.coerce.string(),
      include_count: boolArg.optional().describe("Default false: one extra JQL count for the total"),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, PAGE_MAX);
      const base = `/servicedesk/${seg(args.service_desk_id)}/queue/${seg(args.queue_id)}`;
      const [queue, data] = await Promise.all([
        args.include_count === true ? sdGet(c, base, { includeCount: true }).catch(() => null) : Promise.resolve(null),
        sdGet(c, `${base}/issue`, { start: offset, limit }),
      ]);
      const page = serverPage((data?.values ?? []).map((i: any) => compactIssue(i)), offset, limit, queue?.issueCount ?? null, data?.isLastPage ?? true);
      return { queue: queue ? queue.name : undefined, ...page };
    },
  },
  {
    name: "jira_get_request_types",
    product: "jira",
    description: "Request types of a service desk (id, name, issue type, groups); group_id narrows to one portal group.",
    inputShape: {
      service_desk_id: z.coerce.string(),
      group_id: z.coerce.string().optional().describe("Only request types of this portal group (server-side filter)"),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, PAGE_MAX);
      const data = await sdGet(client("jira"), `/servicedesk/${seg(args.service_desk_id)}/requesttype`, {
        groupId: args.group_id,
        start: offset,
        limit,
      });
      const items = (data?.values ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        issueTypeId: t.issueTypeId,
        groupIds: t.groupIds,
        description: t.description,
        helpText: t.helpText,
      }));
      return serverPage(items, offset, limit, null, data?.isLastPage ?? true);
    },
  },
  {
    name: "jira_get_request_type_fields",
    product: "jira",
    description:
      "Fields of a request type: id, required, type, valid values. Call before jira_create_customer_request.",
    inputShape: { service_desk_id: z.coerce.string(), request_type_id: z.coerce.string() },
    async handler({ client }, args) {
      const data = await sdGet(
        client("jira"),
        `/servicedesk/${seg(args.service_desk_id)}/requesttype/${seg(args.request_type_id)}/field`,
      );
      return {
        canRaiseOnBehalfOf: data?.canRaiseOnBehalfOf,
        canAddRequestParticipants: data?.canAddRequestParticipants,
        fields: (data?.requestTypeFields ?? []).map(compactField),
      };
    },
  },
  {
    name: "jira_create_customer_request",
    product: "jira",
    write: true,
    description:
      "Raise a customer request. request_field_values: object keyed by field id (summary, description, " +
      "customfield_N); select fields accept option labels. Required fields are validated first. " +
      "attachments: local file paths, attached publicly after creation. raise_on_behalf_of: username " +
      "(fails when rejected; allow_agent_fallback=true retries once as the calling agent, which is a different request than the dry run showed).",
    inputShape: {
      service_desk_id: z.coerce.string(),
      request_type_id: z.coerce.string(),
      request_field_values: z.union([z.record(z.string(), z.any()), z.string()]),
      raise_on_behalf_of: z.string().optional(),
      request_participants: listArg.optional(),
      attachments: listArg.optional().describe("Local file paths"),
      attachments_public: boolArg.optional().describe("Default true"),
      allow_agent_fallback: boolArg.optional().describe("Default false. Retry without raiseOnBehalfOf if the server rejects it"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      let values: Record<string, unknown> = args.request_field_values;
      if (typeof values === "string") {
        try {
          values = JSON.parse(values);
        } catch {
          throw new ValidationError("request_field_values must be a JSON object");
        }
      }
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new ValidationError("request_field_values must be an object");

      const meta = await sdGet(c, `/servicedesk/${seg(args.service_desk_id)}/requesttype/${seg(args.request_type_id)}/field`);
      const requestFieldValues = prepareFieldValues(meta?.requestTypeFields ?? [], values);
      const body: Record<string, unknown> = {
        serviceDeskId: args.service_desk_id,
        requestTypeId: args.request_type_id,
        requestFieldValues,
      };
      if (args.raise_on_behalf_of) body.raiseOnBehalfOf = args.raise_on_behalf_of;
      if (args.request_participants?.length) body.requestParticipants = args.request_participants;

      const files: string[] = args.attachments ?? [];
      const summary = `Create request type ${args.request_type_id} in service desk ${args.service_desk_id}` +
        (args.raise_on_behalf_of ? ` on behalf of ${args.raise_on_behalf_of}` : "") +
        (files.length ? ` with ${files.length} attachment(s)` : "");
      const request = { method: "POST" as const, path: `${SD}/request`, json: body, headers: OPT_IN, summary };
      if (args.dry_run !== false) {
        return guardedWrite(c, args, { ...request, files: files.length ? { field: "file", paths: files } : undefined });
      }
      // validate files before creating anything
      if (files.length) await guardedWrite(c, { dry_run: true }, { ...request, files: { field: "file", paths: files } });

      let created: any;
      let mode = args.raise_on_behalf_of ? "created_on_behalf_of" : "created_direct";
      try {
        created = await c.request("POST", `${SD}/request`, { json: body, headers: OPT_IN });
      } catch (e) {
        if (!args.raise_on_behalf_of || args.allow_agent_fallback !== true || !isOnBehalfError(e)) throw e;
        const { raiseOnBehalfOf: _drop, ...fallback } = body;
        created = await c.request("POST", `${SD}/request`, { json: fallback, headers: OPT_IN });
        mode = "created_as_agent_fallback";
      }
      const key = created?.issueKey ?? created?.key;
      const warnings: string[] = [];
      if (files.length && key) {
        try {
          const form = new FormData();
          for (const p of files) form.append("file", new Blob([readFileSync(resolve(p))]), basename(p));
          const tmp = await c.request("POST", `${SD}/servicedesk/${seg(args.service_desk_id)}/attachTemporaryFile`, { form, headers: OPT_IN });
          const ids = (tmp?.temporaryAttachments ?? []).map((t: any) => t.temporaryAttachmentId);
          await c.request("POST", `${SD}/request/${seg(key)}/attachment`, {
            json: { temporaryAttachmentIds: ids, public: args.attachments_public ?? true },
            headers: OPT_IN,
          });
        } catch (e: any) {
          warnings.push(`attachments not added: ${e?.message ?? e}`);
        }
      }
      return {
        dry_run: false,
        product: "jira",
        summary,
        request: { method: "POST", url: c.url(`${SD}/request`), body },
        result: {
          key,
          id: created?.issueId ?? created?.id,
          created_mode: mode,
          portal_url: created?._links?.web ?? `${c.config.baseUrl}/servicedesk/customer/portal/${args.service_desk_id}/${key}`,
          warnings: warnings.length ? warnings : undefined,
        },
      };
    },
  },
];
