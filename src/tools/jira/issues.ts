/**
 * Jira DC issue tools: get, search, create, update, assign, delete, comments, transitions, field options.
 *
 * Ported from sooperset/mcp-atlassian (MIT, servers/jira.py + jira/issues.py, search.py, comments.py,
 * transitions.py, field_options.py) for the DC REST API v2, with the upstream bugs listed in the port
 * inventory fixed: transitions report `to`, DC assignees are `{name}`, `status` in an update is a
 * transition instead of an early return, batch create handles epic/parent like single create.
 * Paths checked against jira-rest-plugin 11.3.2 (IssueResource, SearchResource).
 */

import { z } from "zod";
import { isJiraUserKey, seg, type AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";
import { jiraWikiToMarkdown, markdownToJiraWiki } from "../../markup.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, listArg, pageShape, paginate, pick, serverPage, type WriteRequest } from "../util.js";
import { API, compactIssue, DEFAULT_ISSUE_FIELDS, discoverEpicFields, userRef } from "./shape.js";

const SEARCH_MAX = 100;

// -- markup ---------------------------------------------------------------------

const markupShape = {
  markup: z.enum(["markdown", "wiki"]).optional().describe("Format of text arguments (default markdown, converted to wiki markup)"),
};

function toWiki(text: string | undefined, markup?: string): string | undefined {
  if (text === undefined || text === null) return text;
  return markup === "wiki" ? text : markdownToJiraWiki(text);
}

/** Accept a JSON object or a JSON string of one. */
const jsonObjectArg = z.preprocess((v) => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}, z.record(z.string(), z.any()));

// -- users ------------------------------------------------------------------------

/**
 * Resolve a DC username from a username, user key (JIRAUSER…), e-mail or display name.
 * Plain usernames are used as given (no lookup) to avoid needing Browse Users permission.
 */
export async function resolveUsername(client: AtlassianClient, input: string): Promise<string> {
  const value = input.trim();
  if (isJiraUserKey(value)) {
    const u = await client.get(`${API}/user`, { key: value });
    return u?.name ?? value;
  }
  if (!value.includes("@") && !value.includes(" ")) return value;
  const found: any[] =
    (await client.get(`${API}/user/search`, { username: value, includeActive: true, includeInactive: false, maxResults: 20 })) ?? [];
  const needle = value.toLowerCase();
  const exact = found.find((u) =>
    [u.name, u.emailAddress, u.displayName].some((x) => String(x ?? "").toLowerCase() === needle),
  );
  const pickUser = exact ?? (found.length === 1 ? found[0] : undefined);
  if (!pickUser) {
    throw new ValidationError(
      found.length
        ? `'${value}' matches ${found.length} users (${found.slice(0, 5).map((u) => u.name).join(", ")}…); pass the username`
        : `No user matches '${value}'`,
    );
  }
  return pickUser.name;
}

// -- field formatting ---------------------------------------------------------------

interface FieldDef {
  id: string;
  name: string;
  schema?: { type?: string; items?: string; custom?: string; system?: string };
}

const fieldCache = new WeakMap<AtlassianClient, Promise<FieldDef[]>>();
function allFields(client: AtlassianClient): Promise<FieldDef[]> {
  let p = fieldCache.get(client);
  if (!p) {
    p = client.get(`${API}/field`).then((f: any) => f ?? []);
    fieldCache.set(client, p);
  }
  return p;
}

const EPIC_LINK_ALIASES = ["epickey", "epic_link", "epiclink", "epic link", "epic"];
const EPIC_NAME_ALIASES = ["epic_name", "epicname", "epic name"];
const EPIC_COLOR_ALIASES = ["epic_color", "epiccolor", "epic_colour", "epic colour"];

function csv(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return String(v).split(",").map((s) => s.trim()).filter(Boolean);
}

/** Format one value for the REST write shape of its field (subset of mcp-atlassian `_format_field_value_for_write`). */
async function formatValue(client: AtlassianClient, def: FieldDef | undefined, id: string, value: unknown, markup?: string): Promise<unknown> {
  if (value === null) return null;
  const type = def?.schema?.type;
  const items = def?.schema?.items;
  const custom = def?.schema?.custom ?? "";
  if (id === "priority" || id === "resolution" || id === "security") return typeof value === "string" ? { name: value } : value;
  if (id === "labels") return typeof value === "string" ? csv(value) : value;
  if (["components", "fixVersions", "versions"].includes(id) || (type === "array" && (items === "version" || items === "component"))) {
    return Array.isArray(value) || typeof value === "string" ? csv(value).map((name) => ({ name })) : value;
  }
  if (id === "parent") return typeof value === "string" ? { key: value } : value;
  if (id === "reporter" || id === "assignee" || type === "user") {
    return typeof value === "string" ? { name: await resolveUsername(client, value) } : value;
  }
  if (type === "array" && items === "user") {
    return Array.isArray(value) || typeof value === "string"
      ? await Promise.all(csv(value).map(async (u) => ({ name: await resolveUsername(client, u) })))
      : value;
  }
  if (type === "option" && typeof value === "string") return { value };
  if (type === "option-with-child" && typeof value === "string") {
    const [parent, child] = value.split(/\s*->\s*/);
    return child ? { value: parent, child: { value: child } } : { value: parent };
  }
  if (type === "array" && items === "option" && (Array.isArray(value) || typeof value === "string")) {
    return csv(value).map((v) => ({ value: v }));
  }
  if (type === "array" && items === "string" && typeof value === "string") return csv(value);
  if (id === "description" || (type === "string" && custom.endsWith(":textarea"))) {
    return typeof value === "string" ? toWiki(value, markup) : value;
  }
  return value;
}

/**
 * Build `fields` for create/edit: field names or ids as keys (case-insensitive names),
 * epic aliases mapped to the discovered custom fields, values formatted per schema.
 */
export async function buildFields(client: AtlassianClient, input: Record<string, unknown>, markup?: string): Promise<Record<string, unknown>> {
  const defs = await allFields(client);
  const byId = new Map(defs.map((d) => [d.id, d]));
  const byName = new Map(defs.map((d) => [String(d.name).toLowerCase(), d]));
  const epic = await discoverEpicFields(client);
  const out: Record<string, unknown> = {};
  for (const [rawKey, value] of Object.entries(input)) {
    const lower = rawKey.toLowerCase();
    let id: string | undefined;
    if (EPIC_LINK_ALIASES.includes(lower)) id = epic.epicLink;
    else if (EPIC_NAME_ALIASES.includes(lower)) id = epic.epicName;
    else if (EPIC_COLOR_ALIASES.includes(lower)) id = epic.epicColor;
    else if (byId.has(rawKey)) id = rawKey;
    else if (byName.has(lower)) id = byName.get(lower)!.id;
    else if (/^customfield_\d+$/.test(rawKey) || ["project", "issuetype", "summary", "description", "parent", "assignee"].includes(rawKey)) id = rawKey;
    if (!id) throw new ValidationError(`Unknown field '${rawKey}' (see jira_list_fields)`);
    out[id] = await formatValue(client, byId.get(id), id, value, markup);
  }
  return out;
}

// -- multi-step writes ---------------------------------------------------------------

/**
 * A write made of several requests (create + follow-up updates). Steps may depend on the
 * key returned by the first one; in dry run the placeholder `{key}` is shown instead.
 */
interface PlanStep {
  label: string;
  build: (key: string) => WriteRequest;
}

async function runPlan(client: AtlassianClient, args: { dry_run?: boolean }, summary: string, first: WriteRequest, rest: PlanStep[], keyOf: (r: any) => string) {
  const head = await guardedWrite(client, args, { ...first, summary: rest.length ? `${summary} (+ ${rest.map((s) => s.label).join(", ")})` : summary });
  if (head.dry_run) {
    return {
      ...head,
      followUps: rest.map((s) => {
        const r = s.build("{key}");
        return { label: s.label, method: r.method, url: client.url(r.path, r.params), body: r.json };
      }),
    };
  }
  const key = keyOf((head as any).result);
  const done: string[] = [];
  const failed: Array<{ step: string; error: string }> = [];
  for (const step of rest) {
    try {
      await guardedWrite(client, { dry_run: false }, { ...step.build(key), summary: step.label });
      done.push(step.label);
    } catch (e: any) {
      failed.push({ step: step.label, error: String(e?.message ?? e) });
    }
  }
  return { ...head, result: { key, ...pick((head as any).result, ["id"]), followUpsDone: done, followUpsFailed: failed } };
}

// -- issue type resolution (localized Epic / Sub-task) ---------------------------------

/** Caps for create metadata: all issue types / all create-screen fields are needed to resolve names. */
const CREATEMETA_MAX_TYPES = 200;
const CREATEMETA_MAX_FIELDS = 500;

async function createMetaIssueTypes(client: AtlassianClient, projectKey: string): Promise<any[]> {
  return client.getPaged(`${API}/issue/createmeta/${seg(projectKey)}/issuetypes`, "values", {}, 50, CREATEMETA_MAX_TYPES);
}

async function createMetaFields(client: AtlassianClient, projectKey: string, typeId: string): Promise<any[]> {
  return client.getPaged(`${API}/issue/createmeta/${seg(projectKey)}/issuetypes/${seg(typeId)}`, "values", {}, 50, CREATEMETA_MAX_FIELDS);
}

/** Page through the create-screen fields only until `fieldId` shows up (stops early, capped). */
async function findCreateMetaField(client: AtlassianClient, projectKey: string, typeId: string, fieldId: string): Promise<any | undefined> {
  const path = `${API}/issue/createmeta/${seg(projectKey)}/issuetypes/${seg(typeId)}`;
  for (let start = 0; start < CREATEMETA_MAX_FIELDS; ) {
    const data = await client.get(path, { startAt: start, maxResults: 50 });
    const batch: any[] = data?.values ?? [];
    const hit = batch.find((f: any) => f.fieldId === fieldId || f.key === fieldId);
    if (hit) return hit;
    if (batch.length === 0 || data?.isLast === true || (data?.total !== undefined && start + batch.length >= data.total)) return undefined;
    start += batch.length;
  }
  return undefined;
}

/** Newest-first rows of issue histories/worklogs shown inside jira_get_issue. */
const ISSUE_EXTRA_DEFAULT = 20;

// -- shapes -------------------------------------------------------------------------------

function compactComment(c: any, markdown = true): Record<string, unknown> {
  return {
    id: c.id,
    author: c.author?.name,
    created: c.created,
    updated: c.updated !== c.created ? c.updated : undefined,
    visibility: c.visibility ? `${c.visibility.type}:${c.visibility.value}` : undefined,
    body: markdown ? jiraWikiToMarkdown(String(c.body ?? "")) : c.body,
  };
}

function jqlWithProjects(jql: string, projects?: string[]): string {
  if (!projects?.length) return jql;
  const quote = (k: string) => (/^[A-Z][A-Z0-9_]*$/.test(k) ? k : `"${k}"`);
  const clause = projects.length === 1 ? `project = ${quote(projects[0])}` : `project IN (${projects.map(quote).join(", ")})`;
  const m = /\s+ORDER\s+BY\s+[\s\S]*$/i.exec(` ${jql}`);
  const order = m ? m[0].trim() : "";
  const where = (m ? ` ${jql}`.slice(0, m.index) : jql).trim();
  if (!where) return `${clause}${order ? ` ${order}` : ""}`;
  return `(${where}) AND (${clause})${order ? ` ${order}` : ""}`;
}

async function search(client: AtlassianClient, args: Record<string, any>, jql: string) {
  const offset = args.offset ?? 0;
  const limit = Math.min(args.limit ?? 20, SEARCH_MAX);
  const extra = args.fields ? `,${args.fields}` : "";
  const fields = args.include_description ? `${DEFAULT_ISSUE_FIELDS},description${extra}` : `${DEFAULT_ISSUE_FIELDS}${extra}`;
  const data = await client.get(`${API}/search`, {
    jql,
    startAt: offset,
    maxResults: limit,
    fields: args.fields === "*all" ? "*all" : fields,
    expand: args.expand,
  });
  const issues = (data?.issues ?? []).map((i: any) => compactIssue(i, { body: !!args.include_description }));
  return serverPage(issues, offset, limit, data?.total);
}

const searchShape = {
  ...pageShape(20),
  fields: z.string().optional().describe("Extra fields to return (e.g. customfield_10100) or *all"),
  include_description: boolArg.optional().describe("Include the description (as Markdown); off by default to save tokens"),
  expand: z.string().optional(),
};

// -- tools ----------------------------------------------------------------------------------

export const jiraIssueTools: ToolDef[] = [
  {
    name: "jira_get_issue",
    product: "jira",
    description:
      "One issue: key, type, status, priority, people, dates, labels, epic, description as Markdown. " +
      "Optional: comments=N newest comments, include=transitions,watchers,remote_links,worklogs,changelog,links,subtasks, fields=extra ids.",
    inputShape: {
      issue_key: z.string(),
      fields: z.string().optional().describe("Extra fields (e.g. customfield_10100) or *all"),
      comments: z.coerce.number().int().min(0).max(100).optional().describe("Newest N comments (default 0)"),
      include: listArg.optional().describe("transitions, watchers, remote_links, worklogs, changelog, links, subtasks, attachments"),
      expand: z.string().optional(),
      markup: z.enum(["markdown", "wiki"]).optional().describe("Description format in the result (default markdown)"),
      history_limit: z.coerce.number().int().min(1).max(500).optional()
        .describe(`include=changelog/worklogs: newest N entries (default ${ISSUE_EXTRA_DEFAULT}); totals are reported`),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const key = seg(args.issue_key);
      const extraLimit = args.history_limit ?? ISSUE_EXTRA_DEFAULT;
      const include = new Set<string>((args.include ?? []).map((s: string) => s.toLowerCase().replace(/s$/, "")));
      const epic = await discoverEpicFields(c);
      const fieldList = [DEFAULT_ISSUE_FIELDS, "description", "environment", "timetracking"];
      if (epic.epicLink) fieldList.push(epic.epicLink);
      if (include.has("link")) fieldList.push("issuelinks");
      if (include.has("subtask")) fieldList.push("subtasks");
      if (include.has("attachment")) fieldList.push("attachment");
      if (args.fields) fieldList.push(args.fields);
      const expand = [args.expand, include.has("changelog") ? "changelog" : undefined].filter(Boolean).join(",") || undefined;
      const issue = await c.get(`${API}/issue/${key}`, {
        fields: args.fields === "*all" ? "*all" : fieldList.join(","),
        expand,
      });
      const out = compactIssue(issue, { body: true, markdown: args.markup !== "wiki" });
      const f = issue?.fields ?? {};
      if (epic.epicLink && f[epic.epicLink]) {
        out.epic = f[epic.epicLink];
        if (out.fields && typeof out.fields === "object") delete (out.fields as any)[epic.epicLink];
      }
      if (f.environment) out.environment = jiraWikiToMarkdown(String(f.environment));
      if (f.timetracking && Object.keys(f.timetracking).length) out.timetracking = pick(f.timetracking, ["originalEstimate", "remainingEstimate", "timeSpent"]);
      for (const k of ["environment", "timetracking", "issuelinks", "subtasks", "attachment"]) {
        if (out.fields && typeof out.fields === "object") delete (out.fields as any)[k];
      }
      if (out.fields && Object.keys(out.fields as object).length === 0) delete out.fields;
      if (include.has("link")) {
        out.links = (f.issuelinks ?? []).map((l: any) => ({
          id: l.id,
          type: l.outwardIssue ? l.type?.outward : l.type?.inward,
          issue: (l.outwardIssue ?? l.inwardIssue)?.key,
          status: (l.outwardIssue ?? l.inwardIssue)?.fields?.status?.name,
          summary: (l.outwardIssue ?? l.inwardIssue)?.fields?.summary,
        }));
      }
      if (include.has("subtask")) {
        out.subtasks = (f.subtasks ?? []).map((s: any) => ({ key: s.key, status: s.fields?.status?.name, summary: s.fields?.summary }));
      }
      if (include.has("attachment")) {
        out.attachments = (f.attachment ?? []).map((a: any) => ({ id: a.id, filename: a.filename, size: a.size, mimeType: a.mimeType, created: a.created }));
      }
      if (include.has("changelog")) {
        // DC has no paged changelog endpoint: expand=changelog returns every history; keep the newest N
        const histories: any[] = issue?.changelog?.histories ?? [];
        out.changelogTotal = issue?.changelog?.total ?? histories.length;
        out.changelog = histories.slice(-extraLimit).reverse().map((h: any) => ({
          author: h.author?.name,
          created: h.created,
          changes: (h.items ?? []).map((i: any) => `${i.field}: ${i.fromString ?? ""} → ${i.toString ?? ""}`),
        }));
      }
      if (args.comments) {
        const data = await c.get(`${API}/issue/${key}/comment`, { startAt: 0, maxResults: args.comments, orderBy: "-created" });
        out.comments = (data?.comments ?? []).map((cm: any) => compactComment(cm, args.markup !== "wiki"));
        out.commentTotal = data?.total;
      }
      const extras: Array<Promise<void>> = [];
      if (include.has("transition")) {
        extras.push(c.get(`${API}/issue/${key}/transitions`).then((d: any) => {
          out.transitions = (d?.transitions ?? []).map((t: any) => ({ id: t.id, name: t.name, to: t.to?.name }));
        }));
      }
      if (include.has("watcher")) {
        extras.push(c.get(`${API}/issue/${key}/watchers`).then((d: any) => {
          out.watchers = (d?.watchers ?? []).map((w: any) => w.name);
        }));
      }
      if (include.has("remote_link")) {
        extras.push(c.get(`${API}/issue/${key}/remotelink`).then((d: any) => {
          out.remoteLinks = (d ?? []).map((r: any) => ({ id: r.id, title: r.object?.title, url: r.object?.url, relationship: r.relationship }));
        }));
      }
      if (include.has("worklog")) {
        // GET /issue/{key}/worklog has no paging params on DC: one call, newest N kept
        extras.push(c.get(`${API}/issue/${key}/worklog`).then((d: any) => {
          const w: any[] = d?.worklogs ?? [];
          out.worklogTotal = d?.total ?? w.length;
          out.worklogs = [...w]
            .sort((a, b) => String(b.started ?? "").localeCompare(String(a.started ?? "")))
            .slice(0, extraLimit)
            .map((x) => ({ id: x.id, author: x.author?.name, started: x.started, timeSpent: x.timeSpent, comment: x.comment }));
        }));
      }
      await Promise.all(extras);
      return out;
    },
  },
  {
    name: "jira_search",
    product: "jira",
    description:
      "Search issues with JQL (server-side paging, max 100 per page). Rows: key, type, status, priority, assignee, summary, dates. " +
      "Description only with include_description=true. projects narrows the JQL to project keys.",
    inputShape: {
      jql: z.string(),
      projects: listArg.optional().describe("Project keys ANDed into the JQL"),
      ...searchShape,
    },
    async handler({ client }, args) {
      return search(client("jira"), args, jqlWithProjects(args.jql, args.projects));
    },
  },
  {
    name: "jira_get_project_issues",
    product: "jira",
    description: "Issues of one project, newest updated first (same rows as jira_search).",
    inputShape: { project_key: z.string(), ...searchShape },
    async handler({ client }, args) {
      return search(client("jira"), args, jqlWithProjects("ORDER BY updated DESC", [args.project_key]));
    },
  },
  {
    name: "jira_create_issue",
    product: "jira",
    write: true,
    description:
      "Create an issue. description is Markdown (markup=wiki to send wiki markup). fields: other fields by name or id, " +
      "e.g. {\"priority\":\"High\",\"labels\":\"a,b\",\"Epic Link\":\"FDP-1\",\"parent\":\"FDP-2\",\"customfield_10100\":\"x\"}. " +
      "Epics get Epic Name = summary unless given; localized Epic/Sub-task type names are resolved.",
    inputShape: {
      project_key: z.string(),
      summary: z.string(),
      issue_type: z.string().describe("Name, e.g. Task, Bug, Story, Epic, Sub-task"),
      description: z.string().optional(),
      assignee: z.string().optional().describe("Username, user key, e-mail or display name"),
      components: listArg.optional(),
      fields: jsonObjectArg.optional(),
      ...markupShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const { body, followUps } = await buildCreate(c, args);
      const summary = `Create ${args.issue_type} in ${args.project_key}: ${args.summary}`;
      return runPlan(c, args, summary, { method: "POST", path: `${API}/issue`, json: body, summary }, followUps, (r) => r?.key);
    },
  },
  {
    name: "jira_batch_create_issues",
    product: "jira",
    write: true,
    description:
      "Create several issues in one bulk request. issues: JSON array of {project_key, summary, issue_type, description?, assignee?, components?, fields?}.",
    inputShape: {
      issues: z.preprocess((v) => (typeof v === "string" ? JSON.parse(v) : v), z.array(z.record(z.string(), z.any())).min(1)),
      ...markupShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const updates = [];
      for (const [i, item] of (args.issues as any[]).entries()) {
        for (const req of ["project_key", "summary", "issue_type"]) {
          if (!item[req]) throw new ValidationError(`issues[${i}].${req} is required`);
        }
        const { body } = await buildCreate(c, { ...item, markup: item.markup ?? args.markup });
        updates.push(body);
      }
      return guardedWrite(c, args, {
        method: "POST",
        path: `${API}/issue/bulk`,
        json: { issueUpdates: updates },
        summary: `Create ${updates.length} issues (${[...new Set((args.issues as any[]).map((x) => x.project_key))].join(", ")})`,
      });
    },
  },
  {
    name: "jira_update_issue",
    product: "jira",
    write: true,
    description:
      "Update an issue in one call: fields (by name or id; description Markdown; {\"status\":\"Done\"} transitions), " +
      "components, transition (name or id), comment (Markdown), worklog (e.g. '1h 30m'), attachments (local file paths).",
    inputShape: {
      issue_key: z.string(),
      fields: jsonObjectArg.optional(),
      components: listArg.optional(),
      transition: z.string().optional().describe("Transition name (case-insensitive) or id"),
      comment: z.string().optional(),
      comment_visibility: jsonObjectArg.optional().describe('{"type":"group","value":"jira-users"} or {"type":"role","value":"Developers"}'),
      worklog: z.string().optional().describe("Time spent, e.g. 1h 30m"),
      worklog_started: z.string().optional().describe("ISO datetime, e.g. 2026-10-05T10:00:00.000+0300"),
      attachments: listArg.optional().describe("Local file paths to attach"),
      notify: boolArg.optional().describe("Send notifications for the field update (default true)"),
      ...markupShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const key = args.issue_key;
      const input: Record<string, unknown> = { ...(args.fields ?? {}) };
      let transition: string | undefined = args.transition;
      if ("status" in input) {
        transition ??= String(input.status);
        delete input.status;
      }
      if (args.components) input.components = args.components;
      const steps: WriteRequest[] = [];
      const labels: string[] = [];
      if (Object.keys(input).length) {
        steps.push({
          method: "PUT",
          path: `${API}/issue/${seg(key)}`,
          params: { notifyUsers: args.notify === false ? false : undefined },
          json: { fields: await buildFields(c, input, args.markup) },
          summary: `update ${Object.keys(input).join(", ")}`,
        });
      }
      if (transition) {
        const t = await resolveTransition(c, key, transition);
        steps.push({
          method: "POST",
          path: `${API}/issue/${seg(key)}/transitions`,
          json: { transition: { id: t.id } },
          summary: `transition '${t.name}' → ${t.to ?? "?"}`,
        });
      }
      if (args.comment) {
        const body: Record<string, unknown> = { body: toWiki(args.comment, args.markup) };
        if (args.comment_visibility) body.visibility = args.comment_visibility;
        steps.push({ method: "POST", path: `${API}/issue/${seg(key)}/comment`, json: body, summary: "add comment" });
      }
      if (args.worklog) {
        const body: Record<string, unknown> = { timeSpent: args.worklog };
        if (args.worklog_started) body.started = args.worklog_started;
        steps.push({ method: "POST", path: `${API}/issue/${seg(key)}/worklog`, json: body, summary: `log ${args.worklog}` });
      }
      if (args.attachments?.length) {
        steps.push({
          method: "POST",
          path: `${API}/issue/${seg(key)}/attachments`,
          files: { field: "file", paths: args.attachments },
          summary: `attach ${args.attachments.length} file(s)`,
        });
      }
      if (steps.length === 0) throw new ValidationError("Nothing to update");
      labels.push(...steps.map((s) => s.summary));
      const summary = `Update ${key}: ${labels.join("; ")}`;
      const [first, ...rest] = steps;
      return runPlan(c, args, summary, { ...first, summary }, rest.map((s) => ({ label: s.summary, build: () => s })), () => key);
    },
  },
  {
    name: "jira_assign_issue",
    product: "jira",
    write: true,
    description: "Assign an issue (username, user key, e-mail or display name); omit assignee to unassign.",
    inputShape: { issue_key: z.string(), assignee: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const name = args.assignee ? await resolveUsername(c, args.assignee) : null;
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/issue/${seg(args.issue_key)}/assignee`,
        json: { name },
        summary: name ? `Assign ${args.issue_key} to ${name}` : `Unassign ${args.issue_key}`,
      });
    },
  },
  {
    name: "jira_delete_issue",
    product: "jira",
    write: true,
    description: "Permanently delete an issue. With subtasks it fails unless delete_subtasks=true. Irreversible.",
    inputShape: { issue_key: z.string(), delete_subtasks: boolArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/issue/${seg(args.issue_key)}`,
        params: { deleteSubtasks: args.delete_subtasks ? true : undefined },
        summary: `PERMANENTLY delete ${args.issue_key}${args.delete_subtasks ? " and its subtasks" : ""}`,
      });
    },
  },
  {
    name: "jira_get_field_options",
    product: "jira",
    description:
      "Allowed values of a select/multi-select/cascading field for a project + issue type (from create metadata). " +
      "contains filters values (also children); values_only returns plain strings.",
    inputShape: {
      field_id: z.string().describe("e.g. customfield_10100, priority"),
      project_key: z.string(),
      issue_type: z.string().describe("Issue type name or id"),
      contains: z.string().optional(),
      values_only: boolArg.optional(),
      ...pageShape(100),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const types = await createMetaIssueTypes(c, args.project_key);
      const want = String(args.issue_type).toLowerCase();
      const type = types.find((t: any) => String(t.id) === args.issue_type || String(t.name).toLowerCase() === want || String(t.untranslatedName ?? "").toLowerCase() === want);
      if (!type) throw new ValidationError(`Issue type '${args.issue_type}' not available in ${args.project_key}: ${types.map((t: any) => t.name).join(", ")}`);
      const field = await findCreateMetaField(c, args.project_key, String(type.id), args.field_id);
      if (!field) throw new ValidationError(`Field ${args.field_id} is not on the create screen of ${args.project_key}/${type.name}`);
      const needle = args.contains?.toLowerCase();
      const label = (o: any) => String(o.value ?? o.name ?? "");
      let options = (field.allowedValues ?? []).map((o: any) => ({
        id: o.id,
        value: label(o),
        disabled: o.disabled ? true : undefined,
        children: o.children?.map((ch: any) => ({ id: ch.id, value: label(ch) })),
      }));
      if (needle) {
        options = options
          .map((o: any) => {
            if (o.value.toLowerCase().includes(needle)) return o;
            const kids = (o.children ?? []).filter((ch: any) => ch.value.toLowerCase().includes(needle));
            return kids.length ? { ...o, children: kids } : null;
          })
          .filter(Boolean);
      }
      // allowedValues arrive in one response (no server paging); page them for the caller
      const page = paginate(options, args, 100);
      if (args.values_only) {
        return {
          ...page,
          items: page.items.map((o: any) => (o.children?.length ? { value: o.value, children: o.children.map((ch: any) => ch.value) } : o.value)),
        };
      }
      return { field: args.field_id, name: field.name, issueType: type.name, ...page };
    },
  },
  {
    name: "jira_get_comments",
    product: "jira",
    description: "Comments of an issue as Markdown, newest first (server-side paging).",
    inputShape: { issue_key: z.string(), oldest_first: boolArg.optional(), ...pageShape(20), markup: z.enum(["markdown", "wiki"]).optional() },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 20;
      const data = await client("jira").get(`${API}/issue/${seg(args.issue_key)}/comment`, {
        startAt: offset,
        maxResults: limit,
        orderBy: args.oldest_first ? "created" : "-created",
      });
      return serverPage((data?.comments ?? []).map((cm: any) => compactComment(cm, args.markup !== "wiki")), offset, limit, data?.total);
    },
  },
  {
    name: "jira_add_comment",
    product: "jira",
    write: true,
    description: "Add a comment (Markdown, or markup=wiki). visibility restricts it to a group or project role.",
    inputShape: {
      issue_key: z.string(),
      body: z.string(),
      visibility: jsonObjectArg.optional().describe('{"type":"group","value":"jira-users"} or {"type":"role","value":"Developers"}'),
      ...markupShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const json: Record<string, unknown> = { body: toWiki(args.body, args.markup) };
      if (args.visibility) json.visibility = args.visibility;
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/issue/${seg(args.issue_key)}/comment`,
        json,
        summary: `Comment on ${args.issue_key}`,
      });
    },
  },
  {
    name: "jira_edit_comment",
    product: "jira",
    write: true,
    description: "Replace the text of a comment (Markdown, or markup=wiki).",
    inputShape: {
      issue_key: z.string(),
      comment_id: z.coerce.string(),
      body: z.string(),
      visibility: jsonObjectArg.optional(),
      ...markupShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const json: Record<string, unknown> = { body: toWiki(args.body, args.markup) };
      if (args.visibility) json.visibility = args.visibility;
      return guardedWrite(client("jira"), args, {
        method: "PUT",
        path: `${API}/issue/${seg(args.issue_key)}/comment/${seg(args.comment_id)}`,
        json,
        summary: `Edit comment ${args.comment_id} on ${args.issue_key}`,
      });
    },
  },
  {
    name: "jira_get_transitions",
    product: "jira",
    description: "Transitions available for an issue now: id, name, target status; with_fields adds the fields of its screen.",
    inputShape: { issue_key: z.string(), with_fields: boolArg.optional() },
    async handler({ client }, args) {
      const data = await client("jira").get(`${API}/issue/${seg(args.issue_key)}/transitions`, {
        expand: args.with_fields ? "transitions.fields" : undefined,
      });
      return (data?.transitions ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        to: t.to?.name,
        fields: args.with_fields
          ? Object.entries<any>(t.fields ?? {}).map(([id, f]) => `${id}${f.required ? "*" : ""}:${f.name}`)
          : undefined,
      }));
    },
  },
  {
    name: "jira_transition_issue",
    product: "jira",
    write: true,
    description:
      "Move an issue through its workflow by transition id or name (case-insensitive). fields for the transition screen " +
      '(e.g. {"resolution":"Fixed","assignee":"ivan"}), comment as Markdown.',
    inputShape: {
      issue_key: z.string(),
      transition: z.string().describe("Transition id or name"),
      fields: jsonObjectArg.optional(),
      comment: z.string().optional(),
      ...markupShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const t = await resolveTransition(c, args.issue_key, args.transition);
      const json: Record<string, unknown> = { transition: { id: t.id } };
      if (args.fields && Object.keys(args.fields).length) {
        const clean = Object.fromEntries(Object.entries(args.fields as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined));
        json.fields = await buildFields(c, clean, args.markup);
      }
      if (args.comment) json.update = { comment: [{ add: { body: toWiki(args.comment, args.markup) } }] };
      return guardedWrite(c, args, {
        method: "POST",
        path: `${API}/issue/${seg(args.issue_key)}/transitions`,
        json,
        summary: `Transition ${args.issue_key} via '${t.name}' → ${t.to ?? "?"}`,
      });
    },
  },
];

async function resolveTransition(c: AtlassianClient, issueKey: string, wanted: string): Promise<{ id: string; name: string; to?: string }> {
  const data = await c.get(`${API}/issue/${seg(issueKey)}/transitions`);
  const list: any[] = data?.transitions ?? [];
  const w = wanted.trim().toLowerCase();
  const t =
    list.find((x) => String(x.id) === wanted.trim()) ??
    list.find((x) => String(x.name).toLowerCase() === w) ??
    list.find((x) => String(x.to?.name ?? "").toLowerCase() === w);
  if (!t) {
    throw new ValidationError(
      `No transition '${wanted}' for ${issueKey}. Available: ${list.map((x) => `${x.id}:${x.name}→${x.to?.name}`).join(", ") || "none"}`,
    );
  }
  return { id: String(t.id), name: t.name, to: t.to?.name };
}

/** Create body for one issue plus the follow-up steps (epic fields not on the create screen, assignee safety net). */
async function buildCreate(c: AtlassianClient, args: Record<string, any>): Promise<{ body: Record<string, unknown>; followUps: PlanStep[] }> {
  const epic = await discoverEpicFields(c);
  const requested = String(args.issue_type);
  const lower = requested.toLowerCase();
  let issuetype: Record<string, unknown> = { name: requested };
  let createScreen: Set<string> | undefined;
  const isEpic = lower === "epic";
  const isSubtask = ["subtask", "sub-task", "sub task"].includes(lower);

  if (isEpic || isSubtask) {
    const types = await createMetaIssueTypes(c, args.project_key);
    let type = types.find((t: any) => String(t.name).toLowerCase() === lower || String(t.untranslatedName ?? "").toLowerCase() === lower);
    if (!type && isSubtask) type = types.find((t: any) => t.subtask);
    if (!type && isEpic && epic.epicName) {
      for (const t of types.filter((x: any) => !x.subtask)) {
        const fields = await createMetaFields(c, args.project_key, String(t.id));
        if (fields.some((f: any) => f.fieldId === epic.epicName)) {
          type = t;
          break;
        }
      }
    }
    if (type) {
      issuetype = { id: String(type.id) };
      if (isEpic) createScreen = new Set((await createMetaFields(c, args.project_key, String(type.id))).map((f: any) => f.fieldId));
    }
  }

  const extra: Record<string, unknown> = { ...(args.fields ?? {}) };
  if (args.components) extra.components = args.components;
  const fields: Record<string, unknown> = {
    project: { key: args.project_key },
    summary: args.summary,
    issuetype,
    ...(await buildFields(c, extra, args.markup)),
  };
  if (args.description) fields.description = toWiki(args.description, args.markup);
  let assignee: string | undefined;
  if (args.assignee) {
    assignee = await resolveUsername(c, args.assignee);
    fields.assignee = userRef(assignee);
  }
  if (isSubtask && !fields.parent) throw new ValidationError("A sub-task needs fields.parent (the parent issue key)");

  const followUps: PlanStep[] = [];
  if (isEpic && epic.epicName) {
    const late: Record<string, unknown> = {};
    if (fields[epic.epicName] === undefined) fields[epic.epicName] = args.summary;
    // Epic Name / Colour that are not on the create screen are set right after creation.
    for (const id of [epic.epicName, epic.epicColor]) {
      if (id && fields[id] !== undefined && createScreen && !createScreen.has(id)) {
        late[id] = fields[id];
        delete fields[id];
      }
    }
    if (Object.keys(late).length) {
      followUps.push({ label: "set epic fields", build: (key) => ({ method: "PUT", path: `${API}/issue/${seg(key)}`, json: { fields: late }, summary: "set epic fields" }) });
    }
  }
  if (assignee) {
    // DC sometimes ignores the assignee on create (mcp-atlassian safety net).
    followUps.push({ label: `assign ${assignee}`, build: (key) => ({ method: "PUT", path: `${API}/issue/${seg(key)}/assignee`, json: { name: assignee }, summary: `assign ${assignee}` }) });
  }
  return { body: { fields }, followUps };
}
