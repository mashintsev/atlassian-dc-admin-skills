/**
 * Jira DC workflow schemes: read, create/edit/delete, drafts, issue type mappings,
 * and discovery through projects.
 *
 * DC has no endpoint that lists all workflow schemes, assigns one to a project or
 * publishes a draft: the list is built from the schemes projects use, and assigning
 * and publishing stay in the Jira UI. Every change is dry-run guarded.
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { cached } from "../../scanCache.js";
import { issueTypePlaceholder, resolveIssueType } from "./issueTypeRefs.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolContext, ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite, jsonArg, type WriteRequest, nameFilterShape, contains, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";

/** Upper bound for project scans (one request per project). */
const MAX_PROJECT_SCAN = 2000;

const updateDraftShape = {
  update_draft_if_needed: boolArg.optional().describe(
    "Default false. A scheme used by projects cannot be edited directly; true writes the change to its draft " +
      "(publish the draft in the Jira UI, which migrates issues).",
  ),
};

/** Placeholder id of a workflow scheme an earlier plan item creates (dry runs only). */
const schemePlaceholder = (name: string) => `<workflow scheme "${name}">`;
const isPending = (schemeId: number | string) => typeof schemeId === "string" && schemeId.startsWith("<");

/**
 * A workflow scheme by id or exact name. Names are found among the schemes projects use (the cached
 * scan), then among schemes that earlier items of the running plan created. In a dry run an unknown
 * name gives a pending placeholder; otherwise it is an error and nothing is sent.
 */
async function resolveSchemeRef(ctx: ToolContext, client: AtlassianClient, given: string, dryRun: boolean): Promise<number | string> {
  return (await resolveScheme(ctx, client, given, dryRun)).id;
}

/** Like resolveSchemeRef; `planned` is true for a scheme an earlier item of the plan creates (pending or just created). */
async function resolveScheme(ctx: ToolContext, client: AtlassianClient, given: string, allowPending: boolean): Promise<{ id: number | string; planned: boolean }> {
  const v = String(given).trim();
  if (/^\d+$/.test(v)) return { id: Number(v), planned: false };
  const scan = await cachedSchemeScan(client);
  const used = scan.schemes.find((x) => x.id !== null && x.name === v);
  if (used) return { id: used.id!, planned: false };
  const created = ctx.created?.("workflow-scheme").find((x) => x.name === v);
  if (created) return { id: Number(created.id), planned: true };
  if (allowPending) return { id: schemePlaceholder(v), planned: true };
  throw new ValidationError(
    `No workflow scheme '${v}': names resolve only for schemes a project uses or that an earlier item of this plan created; pass the id`,
  );
}

/**
 * Resolve `args.scheme_id` in place, keeping the name (or id) as given in `args.scheme_ref` for the plan identity.
 * `allowPending`: a dry run may refer to a scheme an earlier plan item creates. Reads and deletes never do.
 */
async function resolveSchemeArg(ctx: ToolContext, args: Record<string, any>, allowPending: boolean): Promise<void> {
  args.scheme_ref = args.scheme_id;
  const r = await resolveScheme(ctx, ctx.client("jira"), args.scheme_id, allowPending);
  args.scheme_id = r.id;
  args.scheme_planned = r.planned;
}

/**
 * Drift state of a change to a scheme an earlier plan item creates: its content is unknown at planning time
 * (a placeholder) and only known at apply, so the state cannot hold it without always drifting.
 */
const PLANNED_STATE = { scheme: "created earlier in this plan" };

async function getWorkflowScheme(client: AtlassianClient, schemeId: number | string): Promise<any> {
  // a scheme an earlier plan item will create: empty for now
  if (isPending(schemeId)) return { id: schemeId, name: String(schemeId), issueTypeMappings: {}, draft: false };
  return client.get(`${API}/workflowscheme/${schemeId}`);
}

/** The scheme's draft, or null when it has none (404). */
async function getDraft(client: AtlassianClient, schemeId: number | string): Promise<any | null> {
  if (isPending(schemeId)) return null;
  try {
    return await client.get(`${API}/workflowscheme/${schemeId}/draft`);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

/**
 * The version of the scheme a change lands in: its draft when the change may go to the draft and one exists,
 * otherwise the published scheme (which also fails for a missing scheme).
 */
async function editTarget(client: AtlassianClient, schemeId: number | string, updateDraftIfNeeded: boolean): Promise<any> {
  return (updateDraftIfNeeded ? await getDraft(client, schemeId) : null) ?? (await getWorkflowScheme(client, schemeId));
}

/** What a read-back reports: the parts of a scheme (or draft) these tools change. */
function schemeView(s: any) {
  return s ? { id: s.id, name: s.name, description: s.description, defaultWorkflow: s.defaultWorkflow, issueTypeMappings: s.issueTypeMappings ?? {}, draft: s.draft ?? false } : null;
}

/**
 * Dry run with drift data, or: execute, read the target back and fail with a VerificationError when the
 * change is not visible. `state` holds only what this change depends on (one mapping, the default...).
 */
async function applyWrite(
  c: AtlassianClient,
  args: { dry_run?: boolean },
  req: WriteRequest,
  drift: { identity: Record<string, unknown>; state: unknown },
  readBack: () => Promise<any>,
  problem: (back: any) => string | null,
) {
  if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: drift.identity, state: drift.state };
  const result = await guardedWrite(c, args, req);
  const back = await readBack();
  const issue = problem(back);
  if (issue) throw new VerificationError(`${req.summary}: ${issue}`, schemeView(back));
  return { ...result, readBack: schemeView(back) };
}

/** The scheme, or null when it does not exist (404). */
async function findScheme(client: AtlassianClient, schemeId: number | string): Promise<any | null> {
  if (isPending(schemeId)) return null;
  try {
    return await getWorkflowScheme(client, schemeId);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

/** Accept a JSON object of issue type id -> workflow name, or a JSON string of one. */
const mappingsArg = jsonArg(z.record(z.string(), z.string()), '{"10004":"Incident WF"}');

const projectScanShape = {
  scan_projects: z.coerce.number().int().min(1).max(MAX_PROJECT_SCAN).optional()
    .describe(`Projects to scan, one request each (default 500, max ${MAX_PROJECT_SCAN})`),
};

interface SchemeUse {
  id: number | null;
  name: string;
  defaultWorkflow: string | null;
  issueTypeMappings: Record<string, string>;
  projects: string[];
}

/**
 * Workflow schemes in use, found through each project's scheme (schemes no project uses are not seen).
 * Projects without their own scheme report Jira's default scheme, which has no id.
 */
export async function scanSchemesInUse(client: AtlassianClient, maxProjects = 500) {
  const list = await client.get(`${API}/project`);
  const projects: any[] = Array.isArray(list) ? list : [];
  const scanned = projects.slice(0, maxProjects);
  const failures = { 403: 0, 404: 0 };
  const found = await boundedAll(scanned.map((p) => async () => {
    try {
      return await client.get(`${API}/project/${seg(p.key)}/workflowscheme`);
    } catch (e) {
      if (isHttpStatusError(e) && (e.status === 403 || e.status === 404)) {
        failures[e.status]++;
        return null;
      }
      throw e;
    }
  }));
  if (scanned.length && failures[404] === scanned.length) {
    // an endpoint missing for every project is the Jira version, not the projects
    throw new ValidationError(`GET ${API}/project/{key}/workflowscheme is not available on this Jira (404 for every project)`);
  }
  const schemes = new Map<string, SchemeUse>();
  scanned.forEach((p, i) => {
    const s = found[i];
    if (!s) return;
    const key = s.id != null ? String(s.id) : `default:${s.name}`;
    const entry: SchemeUse = schemes.get(key) ?? {
      id: s.id ?? null,
      name: s.name,
      defaultWorkflow: s.defaultWorkflow ?? null,
      issueTypeMappings: s.issueTypeMappings ?? {},
      projects: [],
    };
    entry.projects.push(p.key);
    schemes.set(key, entry);
  });
  return {
    schemes: [...schemes.values()].sort((a, b) => b.projects.length - a.projects.length || a.name.localeCompare(b.name)),
    scannedProjects: scanned.length,
    totalProjects: projects.length,
    truncatedScan: projects.length > scanned.length || undefined,
    // 403 can also mean Jira throttled the burst; re-run with fewer projects if it is high
    forbiddenProjects: failures[403] || undefined,
    notFoundProjects: failures[404] || undefined,
  };
}

/**
 * The schemes and projects that use a workflow (as default or for issue types). Used to tell active
 * workflows (edited through a draft) from inactive ones. The project scan is cached per client, so one
 * `apply` scans once; workflow scheme and project writes clear it (ToolDef.invalidates), so a scheme
 * changed earlier in the same plan is seen.
 */
export async function workflowUsage(client: AtlassianClient, workflow: string, maxProjects = 500) {
  const { schemes, ...meta } = await cachedSchemeScan(client, maxProjects);
  const usedBy = schemes
    .map((s) => ({
      schemeId: s.id,
      scheme: s.name,
      asDefault: s.defaultWorkflow === workflow,
      issueTypes: Object.entries(s.issueTypeMappings).filter(([, wf]) => wf === workflow).map(([id]) => id),
      projects: s.projects,
    }))
    .filter((u) => u.asDefault || u.issueTypes.length);
  return { usedBy, projects: [...new Set(usedBy.flatMap((u) => u.projects))].sort(), ...meta };
}

/** The project scan behind scheme lists and workflow usage, shared by every tool of one run. */
function cachedSchemeScan(client: AtlassianClient, maxProjects = 500) {
  return cached(client, "workflow-usage", String(maxProjects), () => scanSchemesInUse(client, maxProjects));
}

const PROJECT_KEYS_SHOWN = 10;
function projectList(keys: string[]): string {
  return keys.length > PROJECT_KEYS_SHOWN ? `${keys.slice(0, PROJECT_KEYS_SHOWN).join(",")},…` : keys.join(",");
}

function mappingLabel(mappings: Record<string, string>, defaultWorkflow: string | undefined, issueType: string): string {
  return mappings[issueType] ?? `(default ${defaultWorkflow ?? "?"})`;
}

export const jiraWorkflowSchemeTools: ToolDef[] = [
  {
    name: "jira_get_workflow_scheme",
    product: "jira",
    description: "Workflow scheme: default workflow and issue type id -> workflow mappings (draft=true reads the unpublished draft).",
    inputShape: { scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"), draft: boolArg.optional() },
    async handler(ctx, args) {
      const { client } = ctx;
      // a read needs an existing scheme: an unknown name is an error, never a placeholder
      await resolveSchemeArg(ctx, args, false);
      const s = await client("jira").get(`${API}/workflowscheme/${args.scheme_id}${args.draft ? "/draft" : ""}`);
      return {
        id: s?.id,
        name: s?.name,
        description: s?.description ?? "",
        defaultWorkflow: s?.defaultWorkflow,
        issueTypeMappings: s?.issueTypeMappings ?? {},
        draft: s?.draft ?? false,
      };
    },
  },
  {
    name: "jira_set_workflow_scheme_mapping",
    aliases: { issue_type_id: "issue_type" },
    product: "jira",
    write: true,
    invalidates: ["workflow-usage"],
    description:
      "Map an issue type (id from jira_list_issue_types) to a workflow (exact name from jira_list_workflows) in a workflow scheme.",
    inputShape: {
      scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"),
      issue_type: z.coerce.string().min(1).describe("Issue type id or exact name"),
      workflow: z.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      const c = client("jira");
      // an issue type an earlier plan item creates is pending in the dry run and resolved on apply
      const issueType = await resolveIssueType(c, args.issue_type, { allowPending: args.dry_run !== false });
      const issueTypeId = issueType.id ?? issueTypePlaceholder(issueType.name!);
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      const scheme = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const mappings = scheme?.issueTypeMappings ?? {};
      const current = mappingLabel(mappings, scheme?.defaultWorkflow, issueTypeId);
      const summary = `Workflow scheme '${scheme?.name ?? args.scheme_id}': issue type ${issueTypeId} ${current} → ${args.workflow}`;
      if (mappings[issueTypeId] === args.workflow) {
        return alreadySatisfied(summary, `issue type ${issueTypeId} already uses ${args.workflow}${scheme?.draft ? " in the draft" : ""}`);
      }
      return applyWrite(c, args, {
        method: "PUT",
        path: `${API}/workflowscheme/${args.scheme_id}/issuetype/${seg(issueTypeId)}`,
        json: { issueType: issueTypeId, workflow: args.workflow, updateDraftIfNeeded },
        summary,
      }, {
        identity: { op: "set-workflow-scheme-mapping", scheme: args.scheme_ref, issueType: issueType.ref, workflow: args.workflow, draft: updateDraftIfNeeded },
        // only this issue type's mapping: other items of the plan may change the others
        state: args.scheme_planned ? PLANNED_STATE : { mapping: mappings[issueTypeId] ?? null },
      }, () => editTarget(c, args.scheme_id, updateDraftIfNeeded), (back) => {
        const now = back?.issueTypeMappings?.[issueTypeId];
        return now === args.workflow ? null : `issue type ${issueTypeId} maps to ${now ?? "(default)"} afterwards`;
      });
    },
  },
  {
    name: "jira_delete_workflow_scheme_mapping",
    aliases: { issue_type_id: "issue_type" },
    product: "jira",
    write: true,
    invalidates: ["workflow-usage"],
    description: "Remove an issue type mapping from a workflow scheme; the issue type then uses the scheme's default workflow.",
    inputShape: {
      scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"),
      issue_type: z.coerce.string().min(1).describe("Issue type id or exact name"),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      const c = client("jira");
      const issueType = await resolveIssueType(c, args.issue_type);
      const issueTypeId = issueType.id!;
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      const scheme = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const current = scheme?.issueTypeMappings?.[issueTypeId];
      const summary = `Workflow scheme '${scheme?.name ?? args.scheme_id}': issue type ${issueTypeId} ${current ?? "(default)"} → (default ${scheme?.defaultWorkflow ?? "?"})`;
      if (current === undefined) return alreadySatisfied(summary, `issue type ${issueTypeId} has no own mapping${scheme?.draft ? " in the draft" : ""}`);
      return applyWrite(c, args, {
        method: "DELETE",
        path: `${API}/workflowscheme/${args.scheme_id}/issuetype/${seg(issueTypeId)}`,
        params: { updateDraftIfNeeded: String(updateDraftIfNeeded) },
        summary,
      }, {
        identity: { op: "delete-workflow-scheme-mapping", scheme: args.scheme_ref, issueType: issueType.ref, draft: updateDraftIfNeeded },
        state: { mapping: current },
      }, () => editTarget(c, args.scheme_id, updateDraftIfNeeded), (back) => {
        const now = back?.issueTypeMappings?.[issueTypeId];
        return now === undefined ? null : `issue type ${issueTypeId} still maps to ${now}`;
      });
    },
  },
  {
    name: "jira_set_workflow_scheme_default",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage"],
    description: "Set the default workflow of a workflow scheme (used by issue types without their own mapping).",
    inputShape: {
      scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"),
      workflow: z.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      const c = client("jira");
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      const scheme = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const summary = `Workflow scheme '${scheme?.name ?? args.scheme_id}': default workflow ${scheme?.defaultWorkflow ?? "?"} → ${args.workflow}`;
      if (scheme?.defaultWorkflow === args.workflow) return alreadySatisfied(summary, `the default workflow is already ${args.workflow}`);
      return applyWrite(c, args, {
        method: "PUT",
        path: `${API}/workflowscheme/${args.scheme_id}/default`,
        json: { workflow: args.workflow, updateDraftIfNeeded },
        summary,
      }, {
        identity: { op: "set-workflow-scheme-default", scheme: args.scheme_ref, workflow: args.workflow, draft: updateDraftIfNeeded },
        state: args.scheme_planned ? PLANNED_STATE : { defaultWorkflow: scheme?.defaultWorkflow ?? null },
      }, () => editTarget(c, args.scheme_id, updateDraftIfNeeded), (back) =>
        back?.defaultWorkflow === args.workflow ? null : `the default workflow is ${back?.defaultWorkflow ?? "?"} afterwards`);
    },
  },
  {
    name: "jira_list_workflow_schemes",
    product: "jira",
    description:
      "Workflow schemes in use, with their projects, found by scanning each project's scheme " +
      "(Jira DC cannot list all schemes; unused ones are not shown). Large instances: raise scan_projects or use --out.",
    inputShape: { ...nameFilterShape, ...projectScanShape, ...pageShape(100) },
    async handler({ client }, args) {
      const scan = await cachedSchemeScan(client("jira"), args.scan_projects);
      const items = scan.schemes
        .filter((s) => contains(s.name, args.name_contains))
        .map((s) => ({
          id: s.id,
          name: s.name,
          defaultWorkflow: s.defaultWorkflow,
          mappings: Object.keys(s.issueTypeMappings).length,
          projectCount: s.projects.length,
          projects: projectList(s.projects),
        }));
      const { schemes: _schemes, ...meta } = scan;
      return { ...paginate(items, args, 100), ...meta };
    },
  },
  {
    name: "jira_find_workflow_usage",
    product: "jira",
    description:
      "Where a workflow (exact name) is used: the workflow schemes that map it, as default or per issue type id, and their " +
      "projects. Scans projects like jira_list_workflow_schemes; drafts and unused schemes are not covered.",
    inputShape: { workflow: z.string().min(1), ...projectScanShape, ...pageShape(100) },
    async handler({ client }, args) {
      const scan = await cachedSchemeScan(client("jira"), args.scan_projects);
      const items = scan.schemes
        .map((s) => ({
          schemeId: s.id,
          scheme: s.name,
          asDefault: s.defaultWorkflow === args.workflow,
          issueTypes: Object.entries(s.issueTypeMappings).filter(([, wf]) => wf === args.workflow).map(([id]) => id).join(","),
          projectCount: s.projects.length,
          projects: projectList(s.projects),
        }))
        .filter((u) => u.asDefault || u.issueTypes);
      const { schemes: _schemes, ...meta } = scan;
      return { ...paginate(items, args, 100), workflow: args.workflow, ...meta };
    },
  },
  {
    name: "jira_create_workflow_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a workflow scheme. copy_from_scheme_id copies another scheme's description, default workflow and mappings; " +
      "default_workflow and issue_type_mappings ({\"<issue type id>\":\"<workflow>\"}) set or override them. " +
      "Assigning it to a project is done in the Jira UI.",
    inputShape: {
      name: z.string().trim().min(1),
      description: z.string().optional(),
      default_workflow: z.string().optional(),
      issue_type_mappings: mappingsArg.optional(),
      copy_from_scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name").optional(),
      ...dryRunShape,
    },
    async handler(ctx, args) {
      const { client } = ctx;
      // the scheme to copy, by id or exact name (it must exist: copying needs its content)
      if (args.copy_from_scheme_id !== undefined) args.copy_from_scheme_id = await resolveSchemeRef(ctx, client("jira"), args.copy_from_scheme_id, false);

      const c = client("jira");
      const source = args.copy_from_scheme_id !== undefined ? await getWorkflowScheme(c, args.copy_from_scheme_id) : undefined;
      const json: Record<string, unknown> = { name: args.name };
      const description = args.description ?? source?.description;
      if (description) json.description = description;
      const defaultWorkflow = args.default_workflow ?? source?.defaultWorkflow;
      if (defaultWorkflow) json.defaultWorkflow = defaultWorkflow;
      const mappings: Record<string, string> = { ...(source?.issueTypeMappings ?? {}), ...(args.issue_type_mappings ?? {}) };
      if (Object.keys(mappings).length) json.issueTypeMappings = mappings;
      const from = source ? ` as a copy of '${source.name}'` : "";
      const summary = `Create workflow scheme '${args.name}'${from} (default ${defaultWorkflow ?? "jira"}, ${Object.keys(mappings).length} mappings)`;
      // DC lists no schemes: a scheme of the same name is found only when some project uses it
      const scan = await cachedSchemeScan(c);
      const same = scan.schemes.find((x) => x.id !== null && x.name === args.name);
      if (same) {
        const sameSettings = (same.defaultWorkflow ?? "jira") === (defaultWorkflow ?? "jira") &&
          JSON.stringify(Object.entries(same.issueTypeMappings).sort()) === JSON.stringify(Object.entries(mappings).sort());
        if (sameSettings) return alreadySatisfied(summary, `workflow scheme ${same.id} '${same.name}' already exists with these settings`, { created: { type: "workflow-scheme", name: args.name, id: same.id } });
        throw new ValidationError(`Workflow scheme '${args.name}' (${same.id}) already exists with other settings; use jira_update_workflow_scheme or the mapping tools`);
      }
      const req: WriteRequest = { method: "POST", path: `${API}/workflowscheme`, json, summary };
      if (args.dry_run !== false) {
        return { ...(await guardedWrite(c, args, req)), identity: { op: "create-workflow-scheme", ...json }, state: { exists: false } };
      }
      const result = await guardedWrite(c, args, req);
      const id = Number((result.result as any)?.id);
      if (!Number.isFinite(id)) throw new VerificationError(`${summary}: Jira returned no scheme id`, result.result);
      const back = await findScheme(c, id);
      const wrong = !back || back.name !== args.name ||
        (defaultWorkflow !== undefined && back.defaultWorkflow !== defaultWorkflow) ||
        Object.entries(mappings).some(([t, wf]) => back.issueTypeMappings?.[t] !== wf);
      if (wrong) throw new VerificationError(`${summary}: scheme ${id} does not read back with these settings`, schemeView(back));
      return { ...result, readBack: schemeView(back), created: { type: "workflow-scheme", name: args.name, id } };
    },
  },
  {
    name: "jira_update_workflow_scheme",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage"],
    description: "Rename a workflow scheme or change its description (mappings: jira_set_workflow_scheme_mapping, jira_replace_workflow_in_scheme).",
    inputShape: {
      scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"),
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      if (args.name === undefined && args.description === undefined) throw new ValidationError("Pass name and/or description");
      const c = client("jira");
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      const scheme = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const wanted: Record<string, string> = {};
      if (args.name !== undefined) wanted.name = args.name;
      if (args.description !== undefined) wanted.description = args.description;
      const changed = Object.keys(wanted).filter((k) => (scheme?.[k] ?? "") !== wanted[k]);
      const changes = [
        args.name !== undefined ? `name → '${args.name}'` : "",
        args.description !== undefined ? "new description" : "",
      ].filter(Boolean).join(", ");
      const summary = `Workflow scheme '${scheme?.name ?? args.scheme_id}': ${changes}`;
      if (!changed.length) return alreadySatisfied(summary, "the scheme already has this name and description");
      // Jira merges the given fields, so the mappings are left out and stay as they are
      const json: Record<string, unknown> = { ...wanted, updateDraftIfNeeded };
      return applyWrite(c, args, { method: "PUT", path: `${API}/workflowscheme/${args.scheme_id}`, json, summary }, {
        identity: { op: "update-workflow-scheme", scheme: args.scheme_ref, ...wanted, draft: updateDraftIfNeeded },
        state: args.scheme_planned ? PLANNED_STATE : Object.fromEntries(changed.map((k) => [k, scheme?.[k] ?? null])),
      }, () => editTarget(c, args.scheme_id, updateDraftIfNeeded), (back) => {
        const off = changed.filter((k) => (back?.[k] ?? "") !== wanted[k]);
        return off.length ? `${off.join(", ")} not changed` : null;
      });
    },
  },
  {
    name: "jira_delete_workflow_scheme",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage"],
    description: "Delete a workflow scheme (irreversible). Jira refuses while a project uses it.",
    inputShape: { scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"), ...dryRunShape },
    async handler(ctx, args) {
      const { client } = ctx;
      // deleting needs an existing scheme: an unknown name must not look like an already deleted one
      await resolveSchemeArg(ctx, args, false);

      const c = client("jira");
      const scheme = await findScheme(c, args.scheme_id);
      const summary = `Delete workflow scheme '${scheme?.name ?? args.scheme_id}' (id ${args.scheme_id}) — irreversible`;
      if (!scheme) return alreadySatisfied(summary, `workflow scheme ${args.scheme_id} does not exist`);
      return applyWrite(c, args, { method: "DELETE", path: `${API}/workflowscheme/${args.scheme_id}`, summary }, {
        identity: { op: "delete-workflow-scheme", scheme: args.scheme_ref },
        state: { name: scheme.name },
      }, () => findScheme(c, args.scheme_id), (back) => (back ? "the scheme still exists" : null));
    },
  },
  {
    name: "jira_create_workflow_scheme_draft",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Create a draft of an active workflow scheme (a copy to edit before publishing it in the Jira UI).",
    inputShape: { scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"), ...dryRunShape },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      const c = client("jira");
      const scheme = await getWorkflowScheme(c, args.scheme_id);
      const summary = `Create a draft of workflow scheme '${scheme?.name ?? args.scheme_id}'`;
      if (await getDraft(c, args.scheme_id)) return alreadySatisfied(summary, "the scheme already has a draft");
      return applyWrite(c, args, { method: "POST", path: `${API}/workflowscheme/${args.scheme_id}/createdraft`, summary }, {
        identity: { op: "create-workflow-scheme-draft", scheme: args.scheme_ref },
        state: { draft: false },
      }, () => getDraft(c, args.scheme_id), (back) => (back ? null : "no draft exists afterwards"));
    },
  },
  {
    name: "jira_delete_workflow_scheme_draft",
    product: "jira",
    write: true,
    invalidates: [],
    description: "Discard the draft of a workflow scheme (its unpublished changes are lost); the published scheme is unchanged.",
    inputShape: { scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"), ...dryRunShape },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      const c = client("jira");
      const draft = await getDraft(c, args.scheme_id);
      if (!draft) {
        const scheme = await getWorkflowScheme(c, args.scheme_id); // a 404 here means the scheme itself does not exist
        return alreadySatisfied(`Discard the draft of workflow scheme '${scheme?.name ?? args.scheme_id}'`, "the scheme has no draft");
      }
      const summary = `Discard the draft of workflow scheme '${draft.name ?? args.scheme_id}' — its unpublished changes are lost`;
      return applyWrite(c, args, { method: "DELETE", path: `${API}/workflowscheme/${args.scheme_id}/draft`, summary }, {
        identity: { op: "delete-workflow-scheme-draft", scheme: args.scheme_ref },
        state: { draft: true },
      }, () => getDraft(c, args.scheme_id), (back) => (back ? "the draft still exists" : null));
    },
  },
  {
    name: "jira_compare_workflow_scheme_draft",
    product: "jira",
    description: "What the draft of a workflow scheme changes compared with the published scheme (default workflow and per issue type id).",
    inputShape: { scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name") },
    async handler(ctx, args) {
      const { client } = ctx;
      // a read needs an existing scheme: an unknown name is an error, never a placeholder
      await resolveSchemeArg(ctx, args, false);
      const c = client("jira");
      const [published, draft] = await Promise.all([getWorkflowScheme(c, args.scheme_id), getDraft(c, args.scheme_id)]);
      if (!draft) return { id: published?.id, name: published?.name, hasDraft: false, changes: [] };
      const pub = published?.issueTypeMappings ?? {};
      const drf = draft.issueTypeMappings ?? {};
      const types = [...new Set([...Object.keys(pub), ...Object.keys(drf)])].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
      const changes = types
        .map((t) => ({
          issueType: t,
          published: mappingLabel(pub, published?.defaultWorkflow, t),
          draft: mappingLabel(drf, draft.defaultWorkflow, t),
        }))
        // compare the workflow that applies, so an explicit mapping equal to the default is no change
        .filter((ch) => (pub[ch.issueType] ?? published?.defaultWorkflow) !== (drf[ch.issueType] ?? draft.defaultWorkflow));
      return {
        id: published?.id,
        name: published?.name,
        hasDraft: true,
        defaultWorkflow: published?.defaultWorkflow === draft.defaultWorkflow
          ? undefined
          : { published: published?.defaultWorkflow, draft: draft.defaultWorkflow },
        changes,
      };
    },
  },
  {
    name: "jira_replace_workflow_in_scheme",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage"],
    description:
      "Replace one workflow with another everywhere in a workflow scheme (its default and every issue type mapped to it), " +
      "in one request. With update_draft_if_needed=true the change is computed from and written to the draft.",
    inputShape: {
      scheme_id: z.coerce.string().min(1).describe("Workflow scheme id or exact name"),
      from_workflow: z.string().min(1),
      to_workflow: z.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler(ctx, args) {
      const { client } = ctx;
      // the name (or id) as given stays in the plan identity; requests use the resolved id
      await resolveSchemeArg(ctx, args, args.dry_run !== false);

      if (args.from_workflow === args.to_workflow) throw new ValidationError("from_workflow and to_workflow are the same");
      const c = client("jira");
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      // a change that lands in the draft must build on the draft, not on the published mappings
      const base = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const mappings: Record<string, string> = base?.issueTypeMappings ?? {};
      const moved = Object.entries(mappings).filter(([, wf]) => wf === args.from_workflow).map(([id]) => id).sort();
      const asDefault = base?.defaultWorkflow === args.from_workflow;
      const where = [asDefault ? "default" : "", moved.length ? `issue types ${moved.join(",")}` : ""].filter(Boolean).join(" and ");
      const summary = `Workflow scheme '${base?.name ?? args.scheme_id}'${base?.draft ? " (draft)" : ""}: ${args.from_workflow} → ${args.to_workflow} for ${where || "nothing"}`;
      if (!moved.length && !asDefault) {
        const usesTarget = base?.defaultWorkflow === args.to_workflow || Object.values(mappings).includes(args.to_workflow);
        if (usesTarget) return alreadySatisfied(summary, `'${args.from_workflow}' is not used and '${args.to_workflow}' is`);
        throw new ValidationError(`Workflow '${args.from_workflow}' is not used in workflow scheme ${args.scheme_id}`);
      }
      const json: Record<string, unknown> = {};
      // the default is always sent with the mappings: Jira stores it as one of them, so a mappings-only update could reset it
      json.defaultWorkflow = asDefault ? args.to_workflow : base?.defaultWorkflow;
      if (moved.length) {
        json.issueTypeMappings = Object.fromEntries(
          Object.entries(mappings).map(([id, wf]) => [id, wf === args.from_workflow ? args.to_workflow : wf]),
        );
      }
      json.updateDraftIfNeeded = updateDraftIfNeeded;
      return applyWrite(c, args, { method: "PUT", path: `${API}/workflowscheme/${args.scheme_id}`, json, summary }, {
        identity: { op: "replace-workflow-in-scheme", scheme: args.scheme_ref, from: args.from_workflow, to: args.to_workflow, draft: updateDraftIfNeeded },
        state: { moved, asDefault },
      }, () => editTarget(c, args.scheme_id, updateDraftIfNeeded), (back) => {
        const left = moved.filter((id) => back?.issueTypeMappings?.[id] !== args.to_workflow);
        if (left.length) return `issue types ${left.join(",")} do not use ${args.to_workflow} afterwards`;
        return asDefault && back?.defaultWorkflow !== args.to_workflow ? `the default is ${back?.defaultWorkflow ?? "?"} afterwards` : null;
      });
    },
  },
];
