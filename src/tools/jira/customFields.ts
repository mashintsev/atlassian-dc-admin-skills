/**
 * Jira DC custom field provisioning: create a field without duplicates, manage its contexts,
 * and place it on several screen tabs.
 *
 * Fields are created through the public REST API; type keys and searchers come from the
 * bundled `/rest/globalconfig/1/customfieldtypes`. Contexts use Jira's internal
 * `/rest/internal/2/field/{id}/context` resource (Atlassian KB: not officially supported),
 * so context changes are gated to verified Jira versions.
 *
 * Field arguments accept a name, so one plan can create a field and then scope and place
 * it. Jira gives a new field a global default context; `context_id=default` addresses it.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import { requireJiraVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { resolveIssueType } from "./issueTypeRefs.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite, listArg } from "../util.js";
import { allFields, fieldPlaceholder, resolveField, type FieldRef } from "./fieldRefs.js";
import { addScreenField } from "./screens.js";

const API = "/rest/api/2";
const INTERNAL = "/rest/internal/2";
const TYPE_PREFIX = "com.atlassian.jira.plugin.system.customfieldtypes";

/** Short names for the common types; any type key Jira lists is accepted as well. */
export const FIELD_TYPES: Record<string, string> = {
  "text-single-line": `${TYPE_PREFIX}:textfield`,
  url: `${TYPE_PREFIX}:url`,
  "date-picker": `${TYPE_PREFIX}:datepicker`,
};

async function fieldTypes(client: AtlassianClient): Promise<any[]> {
  const data = await client.get("/rest/globalconfig/1/customfieldtypes");
  return Array.isArray(data) ? data : (data?.types ?? []);
}

// -- contexts -------------------------------------------------------------------

interface Context {
  id: number;
  name: string;
  description: string;
  allProjects: boolean;
  projects: string[];
  allIssueTypes: boolean;
  issueTypes: string[];
}

function normalizeContext(c: any): Context {
  return {
    id: Number(c.id),
    name: String(c.name ?? ""),
    description: String(c.description ?? ""),
    allProjects: !!c.allProjects,
    projects: (c.projects ?? []).map((p: any) => String(p.id)).sort(),
    allIssueTypes: !!c.allIssueTypes,
    issueTypes: (c.issueTypes ?? []).map((t: any) => String(t.id)).sort(),
  };
}

async function readContexts(client: AtlassianClient, fieldId: string): Promise<Context[]> {
  const data = await client.get(`${INTERNAL}/field/${seg(fieldId)}/context`);
  return (Array.isArray(data) ? data : (data?.values ?? [])).map(normalizeContext);
}

/** The request body Jira's context resource takes: the complete context. */
function contextBody(c: Omit<Context, "id">) {
  return {
    name: c.name,
    description: c.description,
    allProjects: c.allProjects,
    projects: c.allProjects ? [] : c.projects.map((id) => ({ id })),
    allIssueTypes: c.allIssueTypes,
    issueTypes: c.allIssueTypes ? [] : c.issueTypes.map((id) => ({ id })),
  };
}

const sameScope = (a: Omit<Context, "id">, b: Omit<Context, "id">) =>
  a.allProjects === b.allProjects &&
  a.allIssueTypes === b.allIssueTypes &&
  JSON.stringify(a.allProjects ? [] : a.projects) === JSON.stringify(b.allProjects ? [] : b.projects) &&
  JSON.stringify(a.allIssueTypes ? [] : a.issueTypes) === JSON.stringify(b.allIssueTypes ? [] : b.issueTypes);

/** Project ids for ids or keys. */
async function projectIds(client: AtlassianClient, given: string[]): Promise<string[]> {
  const ids = await Promise.all(given.map(async (p) => (/^\d+$/.test(p) ? p : String((await client.get(`${API}/project/${seg(p)}`)).id))));
  return [...new Set(ids)].sort();
}

function scopeLabel(c: Omit<Context, "id">): string {
  const projects = c.allProjects ? "all projects" : `projects ${c.projects.join(",")}`;
  const types = c.allIssueTypes ? "all issue types" : `issue types ${c.issueTypes.join(",")}`;
  return `${projects}; ${types}`;
}

function fieldLabel(f: FieldRef): string {
  return f.id && f.name && f.name !== f.id ? `${f.name} (${f.id})` : (f.name ?? f.id ?? "?");
}

/**
 * Stored state only takes part in drift detection when the field was given by id: a field
 * given by name may not exist yet when the plan is made, and its contexts would then differ
 * between planning and applying for reasons the plan itself caused.
 */
const stateFor = (field: FieldRef, state: unknown) => (typeof field.ref === "string" ? state : undefined);

/** Execute a context write and read the contexts back; `check` validates the stored result. */
async function contextWrite(
  client: AtlassianClient,
  args: { dry_run?: boolean },
  field: FieldRef,
  req: { method: "POST" | "PUT" | "DELETE"; path: string; json?: unknown; summary: string },
  identity: Record<string, unknown>,
  state: unknown,
  check: (after: Context[]) => boolean,
) {
  const dry = await guardedWrite(client, { dry_run: true }, req);
  if (args.dry_run !== false) return { ...dry, identity, state: stateFor(field, state) };
  await client.request(req.method, req.path, { json: req.json });
  const after = await readContexts(client, field.id!);
  if (!check(after)) throw new VerificationError(`The contexts of ${fieldLabel(field)} do not show the change`, { contexts: after });
  return { dry_run: false, product: client.product, summary: req.summary, request: dry.request, result: { contexts: after } };
}

const scopeShape = {
  project_ids: listArg.optional().describe("Project ids or keys, comma-separated"),
  issue_types: listArg.optional().describe("Issue type ids or exact names, comma-separated; omit for all issue types"),
  global: boolArg.optional().describe("All projects (cannot be combined with project_ids)"),
};

const fieldArg = z.coerce.string().min(1).describe("customfield_N or the exact field name (also of a field created earlier in the same plan)");

/** context_id is a number or `default`: the field's only context, as Jira creates it with the field. */
async function pickContext(contexts: Context[], given: string): Promise<Context | undefined> {
  if (given === "default") {
    if (contexts.length !== 1) {
      throw new ValidationError(`context_id=default needs a field with exactly one context; it has ${contexts.length}: ${contexts.map((c) => `${c.id} (${c.name})`).join(", ")}`);
    }
    return contexts[0];
  }
  return contexts.find((c) => String(c.id) === given);
}

// -- tools --------------------------------------------------------------------------

/** Issue type ids for ids or exact names (ids need no lookup). */
async function issueTypeIds(client: AtlassianClient, given: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const g of given) out.push((await resolveIssueType(client, g)).id!);
  return out;
}

export const jiraCustomFieldTools: ToolDef[] = [
  {
    name: "jira_create_custom_field",
    product: "jira",
    write: true,
    description:
      "Create a custom field. field_type: text-single-line, url, date-picker, or a full type key Jira lists; the searcher " +
      "defaults to the type's first one. Looks for fields of the same name (case-insensitive) first: same type → " +
      "already-satisfied with its id; other type or several matches → error. Jira gives the field a global default " +
      "context; scope it with jira_update_field_context context_id=default.",
    inputShape: {
      name: z.string().trim().min(1).max(255),
      description: z.string().optional(),
      field_type: z.string().min(1),
      searcher_key: z.string().optional(),
      context_scope: z.enum(["global"]).optional().describe("Jira creates a global default context; narrow it afterwards as its own change"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [types, fields] = await Promise.all([fieldTypes(c), allFields(c)]);
      const key = FIELD_TYPES[args.field_type] ?? args.field_type;
      const type = types.find((t: any) => t.key === key);
      if (!type) {
        throw new ValidationError(`Unsupported field_type '${args.field_type}'. Use ${Object.keys(FIELD_TYPES).join(", ")}, or a type key Jira lists in /rest/globalconfig/1/customfieldtypes`);
      }
      const searchers: string[] = type.searchers ?? [];
      const searcherKey = args.searcher_key ?? searchers[0];
      if (args.searcher_key && !searchers.includes(args.searcher_key)) {
        throw new ValidationError(`searcher_key '${args.searcher_key}' does not fit ${key}; use one of: ${searchers.join(", ") || "(none)"}`);
      }

      const sameName = fields.filter((f) => String(f.name ?? "").toLowerCase() === args.name.toLowerCase());
      const describe = (f: any) => `${f.id} (${f.name}, ${f.schema?.custom ?? f.schema?.type ?? "system"})`;
      if (sameName.length > 1) throw new ValidationError(`Several fields are named '${args.name}': ${sameName.map(describe).join(", ")}; resolve this in Jira first`);
      if (sameName.length === 1) {
        const f = sameName[0];
        if (f.custom && f.schema?.custom === key) {
          return alreadySatisfied(`Create custom field '${args.name}'`, `${f.id} '${f.name}' already exists with type ${key}`, { fieldId: f.id });
        }
        throw new ValidationError(`A field named '${args.name}' already exists with a different type: ${describe(f)}; requested ${key}`);
      }

      const json: Record<string, unknown> = { name: args.name };
      if (args.description !== undefined) json.description = args.description;
      json.type = key;
      if (searcherKey) json.searcherKey = searcherKey;
      const req = { method: "POST" as const, path: `${API}/field`, json, summary: `Create custom field '${args.name}' (${type.name})` };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      const created = await c.request("POST", req.path, { json });
      const stored = (await allFields(c)).find((f) => f.id === created?.id);
      if (!stored) throw new VerificationError(`Jira did not list the new field ${created?.id ?? args.name}`, { created });
      return { dry_run: false, product: c.product, summary: req.summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: stored.id, name: stored.name, type: stored.schema?.custom }, created: { type: "custom-field", name: stored.name, id: stored.id } };
    },
  },
  {
    name: "jira_create_field_context",
    aliases: { field_id: "field", issue_type_ids: "issue_types" },
    product: "jira",
    write: true,
    description:
      "Add a context to a custom field: global=true or project_ids, and issue_types (omit for all). An identical " +
      "context (same name and scope) → already-satisfied. Internal Jira API; Jira 11.3.x only.",
    inputShape: {
      field: fieldArg,
      name: z.string().trim().min(1),
      description: z.string().optional(),
      ...scopeShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      // names become ids before anything else, so the request and the plan compare ids
      if (args.issue_types?.length) args.issue_types = await issueTypeIds(client("jira"), args.issue_types);
      const c = client("jira");
      await requireJiraVersion(c, "Custom field context changes");
      if (args.global && args.project_ids?.length) throw new ValidationError("Pass global=true or project_ids, not both");
      if (!args.global && !args.project_ids?.length) throw new ValidationError("Pass global=true or project_ids");
      const field = await resolveField(c, args.field, { allowPending: args.dry_run !== false });
      const wanted = {
        name: args.name,
        description: args.description ?? "",
        allProjects: !!args.global,
        projects: args.global ? [] : await projectIds(c, args.project_ids),
        allIssueTypes: !args.issue_types?.length,
        issueTypes: [...new Set<string>(args.issue_types ?? [])].sort(),
      };
      const summary = `Add context '${args.name}' to ${fieldLabel(field)}: ${scopeLabel(wanted)}`;
      if (field.id) {
        const existing = (await readContexts(c, field.id)).find((x) => x.name === args.name);
        if (existing && sameScope(existing, wanted)) return alreadySatisfied(summary, `context ${existing.id} '${existing.name}' already has this scope`);
        if (existing) throw new ValidationError(`${fieldLabel(field)} already has a context '${args.name}' (${existing.id}) with ${scopeLabel(existing)}; use jira_update_field_context`);
      }
      return contextWrite(
        c, args, field,
        { method: "POST", path: `${INTERNAL}/field/${seg(fieldPlaceholder(field))}/context`, json: contextBody(wanted), summary },
        { op: "create-context", field: field.ref, ...wanted },
        undefined,
        (after) => after.some((x) => x.name === wanted.name && sameScope(x, wanted)),
      );
    },
  },
  {
    name: "jira_update_field_context",
    aliases: { field_id: "field", issue_type_ids: "issue_types" },
    product: "jira",
    write: true,
    description:
      "Change a custom field context's name, description or scope. context_id is the id or `default` (the field's only " +
      "context, as Jira creates it with the field). The complete context is sent; attributes not given keep their stored " +
      "values. Internal Jira API; Jira 11.3.x only.",
    inputShape: {
      field: fieldArg,
      context_id: z.coerce.string().min(1).describe("Context id, or `default`"),
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      ...scopeShape,
      all_issue_types: boolArg.optional().describe("true: all issue types (clears issue_types)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      // names become ids before anything else, so the request and the plan compare ids
      if (args.issue_types?.length) args.issue_types = await issueTypeIds(client("jira"), args.issue_types);
      const c = client("jira");
      await requireJiraVersion(c, "Custom field context changes");
      if (args.global && args.project_ids?.length) throw new ValidationError("Pass global=true or project_ids, not both");
      if (args.all_issue_types && args.issue_types?.length) throw new ValidationError("Pass all_issue_types=true or issue_types, not both");
      const field = await resolveField(c, args.field, { allowPending: args.dry_run !== false });
      const changes: Record<string, unknown> = {};
      if (args.name !== undefined) changes.name = args.name;
      if (args.description !== undefined) changes.description = args.description;
      if (args.global) Object.assign(changes, { allProjects: true, projects: [] });
      if (args.project_ids?.length) Object.assign(changes, { allProjects: false, projects: await projectIds(c, args.project_ids) });
      if (args.all_issue_types) Object.assign(changes, { allIssueTypes: true, issueTypes: [] });
      if (args.issue_types?.length) Object.assign(changes, { allIssueTypes: false, issueTypes: [...new Set<string>(args.issue_types)].sort() });
      if (!Object.keys(changes).length) throw new ValidationError("Nothing to change: pass name, description, global, project_ids, issue_types or all_issue_types");
      const identity = { op: "update-context", field: field.ref, context: args.context_id, ...changes };

      if (!field.id) {
        // the field is created by an earlier plan item: describe the change, the stored values are filled in when applied
        return {
          ...(await guardedWrite(c, { dry_run: true }, {
            method: "PUT",
            path: `${INTERNAL}/field/${seg(fieldPlaceholder(field))}/context/${seg(args.context_id)}`,
            json: changes,
            summary: `Update context ${args.context_id} of ${fieldLabel(field)} (created earlier in the plan): ${Object.keys(changes).join(", ")}`,
          })),
          identity,
        };
      }
      const contexts = await readContexts(c, field.id);
      const stored = await pickContext(contexts, args.context_id);
      if (!stored) throw new ValidationError(`${fieldLabel(field)} has no context ${args.context_id}`);
      const { id, ...current } = stored;
      const wanted = { ...current, ...changes } as Omit<Context, "id">;
      const summary = `Update context ${id} '${current.name}' of ${fieldLabel(field)}: ${scopeLabel(current)} → ${scopeLabel(wanted)}${wanted.name !== current.name ? `, name '${wanted.name}'` : ""}`;
      if (JSON.stringify(contextBody(wanted)) === JSON.stringify(contextBody(current))) {
        return alreadySatisfied(summary, "the context already has these values");
      }
      return contextWrite(
        c, args, field,
        { method: "PUT", path: `${INTERNAL}/field/${seg(field.id)}/context/${id}`, json: contextBody(wanted), summary },
        identity,
        stored,
        (after) => after.some((x) => x.id === id && JSON.stringify(contextBody(x)) === JSON.stringify(contextBody(wanted))),
      );
    },
  },
  {
    name: "jira_delete_field_context",
    aliases: { field_id: "field" },
    product: "jira",
    write: true,
    description: "Remove a context from a custom field (its option values and default go with it). Already gone → already-satisfied. Internal Jira API; Jira 11.3.x only.",
    inputShape: { field: fieldArg, context_id: z.coerce.string().min(1), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJiraVersion(c, "Custom field context changes");
      // `default` could point at another context by the time a plan is applied; deletes need the id
      if (args.context_id === "default") throw new ValidationError("Deleting needs the context id, not `default`");
      const field = await resolveField(c, args.field);
      const contexts = await readContexts(c, field.id!);
      const stored = await pickContext(contexts, args.context_id);
      const summary = `Delete context ${args.context_id}${stored ? ` '${stored.name}'` : ""} of ${fieldLabel(field)}`;
      if (!stored) return alreadySatisfied(summary, `${fieldLabel(field)} has no context ${args.context_id}`);
      return contextWrite(
        c, args, field,
        { method: "DELETE", path: `${INTERNAL}/field/${seg(field.id!)}/context/${stored.id}`, summary },
        { op: "delete-context", field: field.ref, context: args.context_id },
        stored,
        (after) => !after.some((x) => x.id === stored.id),
      );
    },
  },
  {
    name: "jira_add_field_to_screens",
    aliases: { field_id: "field" },
    product: "jira",
    write: true,
    description:
      "Place a field on several screen tabs: placements = [{screen_id, tab_id, position?}] (JSON). Each placement is its " +
      "own change (jira_add_screen_field): the dry run lists them, --plan records each as a separate item, placements " +
      "already in place are reported as satisfied.",
    inputShape: {
      field: fieldArg,
      placements: z.preprocess(
        (v) => (typeof v === "string" ? JSON.parse(v) : v),
        z.array(z.object({
          screen_id: z.coerce.number().int(),
          tab_id: z.coerce.number().int(),
          position: z.coerce.number().int().min(1).optional(),
        }).strict()).min(1),
      ),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const batch: Array<{ tool: string; args: Record<string, unknown>; value: any }> = [];
      const satisfied: string[] = [];
      for (const p of args.placements) {
        const one = { screen_id: p.screen_id, tab_id: p.tab_id, field: args.field, ...(p.position ? { position: p.position } : {}) };
        const value: any = await addScreenField(c, { ...one, dry_run: true });
        if (value.already_satisfied) satisfied.push(`${value.summary}: ${value.reason}`);
        else batch.push({ tool: "jira_add_screen_field", args: one, value });
      }
      const summary = `Place ${args.field} on ${args.placements.length} screen tab(s): ${batch.length} to add, ${satisfied.length} already in place`;
      if (!batch.length) return alreadySatisfied(summary, satisfied.join("; "));
      if (args.dry_run !== false) return { dry_run: true, product: c.product, summary, batch, satisfied, request: batch[0].value.request };
      // executed directly (not through the CLI's per-placement confirmation): run them in order
      const results = [];
      for (const b of batch) {
        try {
          results.push({ summary: b.value.summary, status: "done", result: await addScreenField(c, { ...(b.args as any), dry_run: false }) });
        } catch (e) {
          results.push({ summary: b.value.summary, status: "failed", error: isHttpStatusError(e) || e instanceof Error ? e.message : String(e) });
        }
      }
      return { dry_run: false, product: c.product, summary, request: batch[0].value.request, result: { placements: results, satisfied } };
    },
  },
];
