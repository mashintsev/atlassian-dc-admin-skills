/**
 * Jira DC project metadata for content work: issue types, create fields, versions, components.
 *
 * Ported from sooperset/mcp-atlassian (MIT, jira/projects.py). Uses the paged Jira 9+
 * create-metadata endpoints `/issue/createmeta/{project}/issuetypes[/{typeId}]`
 * (checked against jira-rest-plugin 11.3.2 IssueResource; VersionResource for versions).
 */

import { z } from "zod";
import { boundedAll, seg } from "../../client.js";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, contains, dryRunShape, guardedWrite, listArg, pageShape, paginate, pick, serverPage } from "../util.js";
import { API } from "./shape.js";

const VERSION_KEYS = ["id", "name", "description", "released", "archived", "startDate", "releaseDate", "overdue"];

function versionBody(v: Record<string, any>, projectKey?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (projectKey) body.project = projectKey;
  if (v.name !== undefined) body.name = v.name;
  if (v.description !== undefined) body.description = v.description;
  const start = v.start_date ?? v.startDate;
  const release = v.release_date ?? v.releaseDate;
  if (start !== undefined) body.startDate = start;
  if (release !== undefined) body.releaseDate = release;
  if (v.archived !== undefined) body.archived = v.archived;
  if (v.released !== undefined) body.released = v.released;
  return body;
}

/** Create metadata is fetched whole to resolve names; caps keep a misconfigured project bounded. */
const MAX_TYPES = 200;
const MAX_FIELDS = 500;
/** jira_get_project_fields fans out one call per issue type; never more than this many types. */
const MAX_FANOUT_TYPES = 20;

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD").optional();

export const jiraProjectMetaTools: ToolDef[] = [
  {
    name: "jira_get_project_issue_types",
    product: "jira",
    description: "Issue types you can create in a project: id, name, subtask flag (localized names included).",
    inputShape: { project_key: z.string() },
    async handler({ client }, args) {
      const types = await client("jira").getPaged(`${API}/issue/createmeta/${seg(args.project_key)}/issuetypes`, "values", {}, 50, MAX_TYPES);
      return types.map((t: any) => ({
        id: t.id,
        name: t.name,
        subtask: t.subtask ?? false,
        untranslatedName: t.untranslatedName && t.untranslatedName !== t.name ? t.untranslatedName : undefined,
        description: t.description,
      }));
    },
  },
  {
    name: "jira_get_create_fields",
    product: "jira",
    description:
      "Fields on the create screen of a project + issue type: id, name, required, type. Use jira_get_field_options for allowed values.",
    inputShape: {
      project_key: z.string(),
      issue_type_id: z.coerce.string(),
      required_only: boolArg.optional(),
      name_contains: z.string().optional(),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      const path = `${API}/issue/createmeta/${seg(args.project_key)}/issuetypes/${seg(args.issue_type_id)}`;
      const map = (f: any) => ({
        id: f.fieldId ?? f.key,
        name: f.name,
        required: f.required ?? false,
        type: f.schema?.custom ? f.schema.custom.split(":").pop() : f.schema?.items ? `${f.schema.type}<${f.schema.items}>` : f.schema?.type,
        hasOptions: Array.isArray(f.allowedValues) && f.allowedValues.length > 0 ? true : undefined,
      });
      if (!args.required_only && !args.name_contains) {
        // plain listing: one server page
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 100;
        const data = await client("jira").get(path, { startAt: offset, maxResults: limit });
        return serverPage((data?.values ?? []).map(map), offset, limit, data?.total, data?.isLast);
      }
      // filters have no server-side equivalent: fetch the (capped) field list once, then page
      const fields = await client("jira").getPaged(path, "values", {}, 50, MAX_FIELDS);
      const items = fields
        .filter((f: any) => !args.required_only || f.required)
        .filter((f: any) => contains(f.name, args.name_contains) || contains(f.fieldId, args.name_contains))
        .map(map);
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_get_project_fields",
    product: "jira",
    description:
      "All create-screen fields of a project merged across issue types: required for any type, and which types have it. " +
      `Makes one call per issue type: narrow with issue_types (names or ids); at most ${MAX_FANOUT_TYPES} types are read.`,
    inputShape: {
      project_key: z.string(),
      issue_types: listArg.optional().describe("Only these issue types (names or ids)"),
      required_only: boolArg.optional(),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const key = seg(args.project_key);
      let types: any[] = await c.getPaged(`${API}/issue/createmeta/${key}/issuetypes`, "values", {}, 50, MAX_TYPES);
      if (args.issue_types?.length) {
        const want = new Set(args.issue_types.map((t: string) => t.toLowerCase()));
        types = types.filter((t) => want.has(String(t.id)) || want.has(String(t.name).toLowerCase()));
      }
      const skipped = types.length > MAX_FANOUT_TYPES ? types.slice(MAX_FANOUT_TYPES).map((t) => t.name) : [];
      types = types.slice(0, MAX_FANOUT_TYPES);
      const perType = await boundedAll(types.map((t) => () => c.getPaged(`${API}/issue/createmeta/${key}/issuetypes/${seg(t.id)}`, "values", {}, 50, MAX_FIELDS)));
      const merged = new Map<string, { id: string; name: string; required: boolean; custom: boolean; type?: string; issueTypes: string[] }>();
      perType.forEach((fields, i) => {
        for (const f of fields) {
          const id = f.fieldId ?? f.key;
          const entry = merged.get(id) ?? { id, name: f.name, required: false, custom: !!f.schema?.custom, type: f.schema?.type, issueTypes: [] as string[] };
          entry.required ||= !!f.required;
          entry.issueTypes.push(types[i].name);
          merged.set(id, entry);
        }
      });
      const items = [...merged.values()]
        .filter((f) => !args.required_only || f.required)
        .map((f) => ({
          ...f,
          issueTypes: f.issueTypes.length === types.length ? "all" : f.issueTypes.join(","),
        }));
      const page = paginate(items, args, 100);
      return skipped.length ? { ...page, skippedIssueTypes: skipped.join(",") } : page;
    },
  },
  {
    name: "jira_get_project_versions",
    product: "jira",
    description:
      "Versions (releases) of a project, newest first (server-side paging): id, name, released, archived, dates. " +
      "unreleased_only hides released/archived; name_contains filters by name.",
    inputShape: {
      project_key: z.string(),
      unreleased_only: boolArg.optional(),
      name_contains: z.string().optional(),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${API}/project/${seg(args.project_key)}/version`;
      if (!args.unreleased_only && !args.name_contains) {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 50;
        const data = await c.get(path, { startAt: offset, maxResults: limit, orderBy: "-sequence" });
        return serverPage((data?.values ?? []).map((v: any) => pick(v, VERSION_KEYS)), offset, limit, data?.total, data?.isLast);
      }
      // no server-side status/name filter on DC: read the (capped) list once, filter, then page
      const all = await c.getPaged(path, "values", { orderBy: "-sequence" }, 100, 2000);
      const items = all
        .filter((v: any) => !args.unreleased_only || (!v.released && !v.archived))
        .filter((v: any) => contains(v.name, args.name_contains))
        .map((v: any) => pick(v, VERSION_KEYS));
      return paginate(items, args, 50);
    },
  },
  {
    name: "jira_get_project_components",
    product: "jira",
    description: "Components of a project: id, name, lead, default assignee type, description.",
    inputShape: { project_key: z.string(), name_contains: z.string().optional(), ...pageShape(100) },
    async handler({ client }, args) {
      // GET /project/{key}/components has no paging or filter params on DC: one call, paged here
      const comps: any[] = (await client("jira").get(`${API}/project/${seg(args.project_key)}/components`)) ?? [];
      const items = comps
        .filter((cp) => contains(cp.name, args.name_contains))
        .map((cp) => ({
          id: cp.id,
          name: cp.name,
          lead: cp.lead?.name,
          assigneeType: cp.assigneeType,
          description: cp.description,
        }));
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_create_version",
    product: "jira",
    write: true,
    description: "Create a version (release) in a project. Dates are YYYY-MM-DD.",
    inputShape: {
      project_key: z.string(),
      name: z.string(),
      start_date: dateArg,
      release_date: dateArg,
      description: z.string().optional(),
      released: boolArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/version`,
        json: versionBody(args, args.project_key),
        summary: `Create version ${args.name} in ${args.project_key}`,
      });
    },
  },
  {
    name: "jira_batch_create_versions",
    product: "jira",
    write: true,
    description:
      "Create several versions in a project (one request each). versions: JSON array of {name, startDate?, releaseDate?, description?, released?}.",
    inputShape: {
      project_key: z.string(),
      versions: z.preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.array(z.record(z.string(), z.any())).min(1)),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const items = args.versions as Array<Record<string, any>>;
      items.forEach((v, i) => {
        if (!v.name) throw new ValidationError(`versions[${i}].name is required`);
      });
      const bodies = items.map((v) => versionBody(v, args.project_key));
      const summary = `Create ${bodies.length} versions in ${args.project_key}: ${bodies.map((b) => b.name).join(", ")}`;
      if (args.dry_run !== false) {
        const first = await guardedWrite(c, args, { method: "POST", path: `${API}/version`, json: bodies[0], summary });
        return { ...first, followUps: bodies.slice(1).map((b) => ({ method: "POST", url: c.url(`${API}/version`), body: b })) };
      }
      const results: Array<Record<string, unknown>> = [];
      for (const body of bodies) {
        try {
          const r: any = await guardedWrite(c, { dry_run: false }, { method: "POST", path: `${API}/version`, json: body, summary: `Create version ${body.name}` });
          results.push({ name: body.name, id: r.result?.id, ok: true });
        } catch (e: any) {
          results.push({ name: body.name, ok: false, error: String(e?.message ?? e) });
        }
      }
      return {
        dry_run: false,
        product: "jira",
        summary,
        request: { method: "POST", url: c.url(`${API}/version`), body: `${bodies.length} bodies` },
        result: { created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, items: results },
      };
    },
  },
  {
    name: "jira_update_version",
    product: "jira",
    write: true,
    description: "Rename a version, change its dates or description, or mark it released/archived.",
    inputShape: {
      version_id: z.coerce.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      start_date: dateArg,
      release_date: dateArg,
      released: boolArg.optional(),
      archived: boolArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body = versionBody(args);
      if (Object.keys(body).length === 0) throw new ValidationError("Pass at least one of name, description, start_date, release_date, released, archived");
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/version/${seg(args.version_id)}`,
        json: body,
        summary: `Update version ${args.version_id}: ${Object.keys(body).join(", ")}`,
      });
    },
  },
];
