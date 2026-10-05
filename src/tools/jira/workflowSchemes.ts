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
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, nameFilterShape, contains, pageShape, paginate } from "../util.js";

const API = "/rest/api/2";

/** Upper bound for project scans (one request per project). */
const MAX_PROJECT_SCAN = 2000;

const updateDraftShape = {
  update_draft_if_needed: boolArg.optional().describe(
    "Default false. A scheme used by projects cannot be edited directly; true writes the change to its draft " +
      "(publish the draft in the Jira UI, which migrates issues).",
  ),
};

async function getWorkflowScheme(client: AtlassianClient, schemeId: number): Promise<any> {
  return client.get(`${API}/workflowscheme/${schemeId}`);
}

/** The scheme's draft, or null when it has none (404). */
async function getDraft(client: AtlassianClient, schemeId: number): Promise<any | null> {
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
async function editTarget(client: AtlassianClient, schemeId: number, updateDraftIfNeeded: boolean): Promise<any> {
  return (updateDraftIfNeeded ? await getDraft(client, schemeId) : null) ?? (await getWorkflowScheme(client, schemeId));
}

/** Accept a JSON object of issue type id -> workflow name, or a JSON string of one. */
const mappingsArg = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}, z.record(z.string(), z.string()));

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
async function scanSchemesInUse(client: AtlassianClient, maxProjects = 500) {
  const projects: any[] = (await client.get(`${API}/project`)) ?? [];
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
    inputShape: { scheme_id: z.coerce.number().int(), draft: boolArg.optional() },
    async handler({ client }, args) {
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
    product: "jira",
    write: true,
    description:
      "Map an issue type (id from jira_list_issue_types) to a workflow (exact name from jira_list_workflows) in a workflow scheme.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      issue_type_id: z.coerce.string().min(1),
      workflow: z.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      const scheme = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const current = mappingLabel(scheme?.issueTypeMappings ?? {}, scheme?.defaultWorkflow, args.issue_type_id);
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/workflowscheme/${args.scheme_id}/issuetype/${seg(args.issue_type_id)}`,
        json: { issueType: args.issue_type_id, workflow: args.workflow, updateDraftIfNeeded },
        summary: `Workflow scheme '${scheme?.name ?? args.scheme_id}': issue type ${args.issue_type_id} ${current} → ${args.workflow}`,
      });
    },
  },
  {
    name: "jira_delete_workflow_scheme_mapping",
    product: "jira",
    write: true,
    description: "Remove an issue type mapping from a workflow scheme; the issue type then uses the scheme's default workflow.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      issue_type_id: z.coerce.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const scheme = await editTarget(c, args.scheme_id, args.update_draft_if_needed ?? false);
      const current = scheme?.issueTypeMappings?.[args.issue_type_id];
      if (current === undefined) {
        throw new ValidationError(`Workflow scheme ${args.scheme_id} has no mapping for issue type ${args.issue_type_id}`);
      }
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${API}/workflowscheme/${args.scheme_id}/issuetype/${seg(args.issue_type_id)}`,
        params: { updateDraftIfNeeded: String(args.update_draft_if_needed ?? false) },
        summary: `Workflow scheme '${scheme?.name ?? args.scheme_id}': issue type ${args.issue_type_id} ${current} → (default ${scheme?.defaultWorkflow ?? "?"})`,
      });
    },
  },
  {
    name: "jira_set_workflow_scheme_default",
    product: "jira",
    write: true,
    description: "Set the default workflow of a workflow scheme (used by issue types without their own mapping).",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      workflow: z.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const scheme = await editTarget(c, args.scheme_id, args.update_draft_if_needed ?? false);
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/workflowscheme/${args.scheme_id}/default`,
        json: { workflow: args.workflow, updateDraftIfNeeded: args.update_draft_if_needed ?? false },
        summary: `Workflow scheme '${scheme?.name ?? args.scheme_id}': default workflow ${scheme?.defaultWorkflow ?? "?"} → ${args.workflow}`,
      });
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
      const scan = await scanSchemesInUse(client("jira"), args.scan_projects);
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
      const scan = await scanSchemesInUse(client("jira"), args.scan_projects);
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
    description:
      "Create a workflow scheme. copy_from_scheme_id copies another scheme's description, default workflow and mappings; " +
      "default_workflow and issue_type_mappings ({\"<issue type id>\":\"<workflow>\"}) set or override them. " +
      "Assigning it to a project is done in the Jira UI.",
    inputShape: {
      name: z.string().trim().min(1),
      description: z.string().optional(),
      default_workflow: z.string().optional(),
      issue_type_mappings: mappingsArg.optional(),
      copy_from_scheme_id: z.coerce.number().int().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const source = args.copy_from_scheme_id !== undefined ? await getWorkflowScheme(c, args.copy_from_scheme_id) : undefined;
      const json: Record<string, unknown> = { name: args.name };
      const description = args.description ?? source?.description;
      if (description) json.description = description;
      const defaultWorkflow = args.default_workflow ?? source?.defaultWorkflow;
      if (defaultWorkflow) json.defaultWorkflow = defaultWorkflow;
      const mappings = { ...(source?.issueTypeMappings ?? {}), ...(args.issue_type_mappings ?? {}) };
      if (Object.keys(mappings).length) json.issueTypeMappings = mappings;
      const from = source ? ` as a copy of '${source.name}'` : "";
      return guardedWrite(c, args, {
        method: "POST",
        path: `${API}/workflowscheme`,
        json,
        summary: `Create workflow scheme '${args.name}'${from} (default ${defaultWorkflow ?? "jira"}, ${Object.keys(mappings).length} mappings)`,
      });
    },
  },
  {
    name: "jira_update_workflow_scheme",
    product: "jira",
    write: true,
    description: "Rename a workflow scheme or change its description (mappings: jira_set_workflow_scheme_mapping, jira_replace_workflow_in_scheme).",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (args.name === undefined && args.description === undefined) throw new ValidationError("Pass name and/or description");
      const c = client("jira");
      const scheme = await getWorkflowScheme(c, args.scheme_id);
      // Jira merges the given fields, so the mappings are left out and stay as they are
      const json: Record<string, unknown> = {};
      if (args.name !== undefined) json.name = args.name;
      if (args.description !== undefined) json.description = args.description;
      json.updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      const changes = [
        args.name !== undefined ? `name → '${args.name}'` : "",
        args.description !== undefined ? "new description" : "",
      ].filter(Boolean).join(", ");
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/workflowscheme/${args.scheme_id}`,
        json,
        summary: `Workflow scheme '${scheme?.name ?? args.scheme_id}': ${changes}`,
      });
    },
  },
  {
    name: "jira_delete_workflow_scheme",
    product: "jira",
    write: true,
    description: "Delete a workflow scheme (irreversible). Jira refuses while a project uses it.",
    inputShape: { scheme_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const scheme = await getWorkflowScheme(c, args.scheme_id);
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${API}/workflowscheme/${args.scheme_id}`,
        summary: `Delete workflow scheme '${scheme?.name ?? args.scheme_id}' (id ${args.scheme_id}) — irreversible`,
      });
    },
  },
  {
    name: "jira_create_workflow_scheme_draft",
    product: "jira",
    write: true,
    description: "Create a draft of an active workflow scheme (a copy to edit before publishing it in the Jira UI).",
    inputShape: { scheme_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const scheme = await getWorkflowScheme(c, args.scheme_id);
      return guardedWrite(c, args, {
        method: "POST",
        path: `${API}/workflowscheme/${args.scheme_id}/createdraft`,
        summary: `Create a draft of workflow scheme '${scheme?.name ?? args.scheme_id}'`,
      });
    },
  },
  {
    name: "jira_delete_workflow_scheme_draft",
    product: "jira",
    write: true,
    description: "Discard the draft of a workflow scheme (its unpublished changes are lost); the published scheme is unchanged.",
    inputShape: { scheme_id: z.coerce.number().int(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const draft = await getDraft(c, args.scheme_id);
      if (!draft) {
        await getWorkflowScheme(c, args.scheme_id); // a 404 here means the scheme itself does not exist
        throw new ValidationError(`Workflow scheme ${args.scheme_id} has no draft`);
      }
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${API}/workflowscheme/${args.scheme_id}/draft`,
        summary: `Discard the draft of workflow scheme '${draft.name ?? args.scheme_id}' — its unpublished changes are lost`,
      });
    },
  },
  {
    name: "jira_compare_workflow_scheme_draft",
    product: "jira",
    description: "What the draft of a workflow scheme changes compared with the published scheme (default workflow and per issue type id).",
    inputShape: { scheme_id: z.coerce.number().int() },
    async handler({ client }, args) {
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
    description:
      "Replace one workflow with another everywhere in a workflow scheme (its default and every issue type mapped to it), " +
      "in one request. With update_draft_if_needed=true the change is computed from and written to the draft.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      from_workflow: z.string().min(1),
      to_workflow: z.string().min(1),
      ...updateDraftShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (args.from_workflow === args.to_workflow) throw new ValidationError("from_workflow and to_workflow are the same");
      const c = client("jira");
      const updateDraftIfNeeded = args.update_draft_if_needed ?? false;
      // a change that lands in the draft must build on the draft, not on the published mappings
      const base = await editTarget(c, args.scheme_id, updateDraftIfNeeded);
      const mappings: Record<string, string> = base?.issueTypeMappings ?? {};
      const moved = Object.entries(mappings).filter(([, wf]) => wf === args.from_workflow).map(([id]) => id);
      const asDefault = base?.defaultWorkflow === args.from_workflow;
      if (!moved.length && !asDefault) {
        throw new ValidationError(`Workflow '${args.from_workflow}' is not used in workflow scheme ${args.scheme_id}`);
      }
      const json: Record<string, unknown> = {};
      // the default is always sent with the mappings: Jira stores it as one of them, so a mappings-only update could reset it
      if (asDefault || moved.length) json.defaultWorkflow = asDefault ? args.to_workflow : base?.defaultWorkflow;
      if (moved.length) {
        json.issueTypeMappings = Object.fromEntries(
          Object.entries(mappings).map(([id, wf]) => [id, wf === args.from_workflow ? args.to_workflow : wf]),
        );
      }
      json.updateDraftIfNeeded = updateDraftIfNeeded;
      const where = [asDefault ? "default" : "", moved.length ? `issue types ${moved.join(",")}` : ""].filter(Boolean).join(" and ");
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/workflowscheme/${args.scheme_id}`,
        json,
        summary: `Workflow scheme '${base?.name ?? args.scheme_id}'${base?.draft ? " (draft)" : ""}: ${args.from_workflow} → ${args.to_workflow} for ${where}`,
      });
    },
  },
];
