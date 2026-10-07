/**
 * Jira DC workflows: read the structure REST exposes, compare status models, and change statuses,
 * transitions and drafts through the workflow designer's resources (the ones the Jira UI uses,
 * `/rest/workflowDesigner/1.0`, form parameters plus `X-Atlassian-Token: no-check`).
 *
 * Conditions, validators and post-functions are not readable through REST; only their counts are.
 * A workflow used by a workflow scheme is active: its changes go to its draft, which is created
 * on the first confirmed change and published or discarded as a separate change.
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { errorDetail, isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import { requireJiraVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, capList, dryRunShape, fullListsShape, guardedWrite, type WriteRequest } from "../util.js";
import { allScreens } from "./screens.js";
import { workflowUsage } from "./workflowSchemes.js";

const WD = "/rest/workflowDesigner/1.0";
const API = "/rest/api/2";
const NO_CHECK = { "X-Atlassian-Token": "no-check" };
const RULES_GAP = "Conditions, validators and post-functions are not readable over REST (only their counts are shown); check them in the Jira UI.";

export interface WfStatus {
  ref: string;
  statusId: string;
  stepId: number;
  name: string;
  description: string;
  categoryId: number | null;
}

export interface WfTransition {
  ref: string;
  actionId: number;
  name: string;
  description: string;
  /** Source status name; "any" for global and looped transitions, "(create)" for the initial one. */
  source: string;
  /** Target status name; "(itself)" for looped transitions. */
  target: string;
  sourceStepId: number | null;
  global: boolean;
  looped: boolean;
  initial: boolean;
  screenId: number | null;
  screenName: string | null;
  rules: Record<string, number>;
}

export interface WfModel {
  name: string;
  isDraft: boolean;
  statuses: WfStatus[];
  transitions: WfTransition[];
  initialStatus: string | null;
  raw: any;
}

/** Counts of the rule tabs the designer reports per transition (contents are not exposed). */
function ruleCounts(options: any[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of options ?? []) {
    const key = String(o?.name ?? "").replace(/\s+(\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toLowerCase());
    if (key && key !== "properties") out[key] = Number(o.count ?? 0);
  }
  return out;
}

/** The designer layout as statuses and transitions with status names (the initial pseudo-status is left out). */
export function toModel(name: string, raw: any): WfModel {
  const layout = raw?.layout ?? {};
  const statuses: WfStatus[] = (layout.statuses ?? [])
    .filter((s: any) => s.statusId != null && !String(s.id).startsWith("I<"))
    .map((s: any) => ({
      ref: String(s.id),
      statusId: String(s.statusId),
      stepId: Number(s.stepId),
      name: String(s.name),
      description: s.description ?? "",
      categoryId: s.statusCategory?.id ?? null,
    }));
  const byRef = new Map(statuses.map((s) => [s.ref, s]));
  const nameOf = (ref: string) => byRef.get(String(ref))?.name ?? String(ref);
  const transitions: WfTransition[] = (layout.transitions ?? []).map((t: any) => {
    const initial = Boolean(t.initial) || String(t.sourceId ?? "").startsWith("I<");
    const looped = Boolean(t.loopedTransition);
    const global = Boolean(t.globalTransition) && !looped;
    return {
      ref: String(t.id),
      actionId: Number(t.actionId),
      name: String(t.name),
      description: t.description ?? "",
      source: initial ? "(create)" : global || looped ? "any" : nameOf(t.sourceId),
      target: looped ? "(itself)" : nameOf(t.targetId),
      sourceStepId: initial || global || looped ? null : (byRef.get(String(t.sourceId))?.stepId ?? null),
      global,
      looped,
      initial,
      screenId: t.screenId ?? null,
      screenName: t.screenName ?? null,
      rules: ruleCounts(t.transitionOptions),
    };
  });
  const initialStatus = transitions.find((t) => t.initial)?.target ?? null;
  return { name, isDraft: Boolean(raw?.isDraft), statuses, transitions, initialStatus, raw };
}

/** The live workflow, or with preferDraft its draft when one exists (never creates a draft). */
export async function loadModel(client: AtlassianClient, name: string, preferDraft = false): Promise<WfModel> {
  try {
    const raw = await client.get(`${WD}/workflows`, { name, preferDraft: preferDraft || undefined });
    return toModel(name, raw);
  } catch (e) {
    if (isHttpStatusError(e) && (e.status === 404 || e.status === 400)) {
      throw new ValidationError(`No workflow '${name}'${errorDetail(e.body) ? `: ${errorDetail(e.body)}` : ""}`);
    }
    throw e;
  }
}

export interface Comparison {
  identical: boolean;
  statuses: { onlyInFirst: string[]; onlyInSecond: string[]; inBoth: string[] };
  transitions: {
    onlyInFirst: Array<{ from: string; to: string; names: string[] }>;
    onlyInSecond: Array<{ from: string; to: string; names: string[] }>;
    nameDiffers: Array<{ from: string; to: string; first: string[]; second: string[] }>;
  };
}

/**
 * Compare two status models by names: statuses by name, transitions by "source → target" (status ids are
 * shared between workflows, step and action ids are not).
 */
export function compareModels(a: WfModel, b: WfModel): Comparison {
  const sa = new Set(a.statuses.map((s) => s.name));
  const sb = new Set(b.statuses.map((s) => s.name));
  const byKey = (m: WfModel) => {
    const map = new Map<string, { from: string; to: string; names: string[] }>();
    for (const t of m.transitions) {
      const key = `${t.source}\u0000${t.target}`;
      const entry = map.get(key) ?? { from: t.source, to: t.target, names: [] };
      entry.names.push(t.name);
      map.set(key, entry);
    }
    for (const e of map.values()) e.names.sort();
    return map;
  };
  const ta = byKey(a);
  const tb = byKey(b);
  const onlyIn = (x: typeof ta, y: typeof ta) => [...x].filter(([k]) => !y.has(k)).map(([, v]) => v);
  const nameDiffers = [...ta]
    .filter(([k, v]) => tb.has(k) && JSON.stringify(v.names) !== JSON.stringify(tb.get(k)!.names))
    .map(([k, v]) => ({ from: v.from, to: v.to, first: v.names, second: tb.get(k)!.names }));
  const result: Comparison = {
    identical: false,
    statuses: {
      onlyInFirst: [...sa].filter((s) => !sb.has(s)).sort(),
      onlyInSecond: [...sb].filter((s) => !sa.has(s)).sort(),
      inBoth: [...sa].filter((s) => sb.has(s)).sort(),
    },
    transitions: { onlyInFirst: onlyIn(ta, tb), onlyInSecond: onlyIn(tb, ta), nameDiffers },
  };
  result.identical =
    !result.statuses.onlyInFirst.length && !result.statuses.onlyInSecond.length &&
    !result.transitions.onlyInFirst.length && !result.transitions.onlyInSecond.length && !nameDiffers.length;
  return result;
}

/** The project's issue type by id or exact name (case-insensitive). */
async function projectIssueType(client: AtlassianClient, project: string, issueType: string): Promise<{ id: string; name: string }> {
  const p = await client.get(`${API}/project/${seg(project)}`);
  const types: any[] = p?.issueTypes ?? [];
  const v = issueType.trim();
  const hit = types.find((t) => String(t.id) === v) ?? types.find((t) => String(t.name).toLowerCase() === v.toLowerCase());
  if (!hit) throw new ValidationError(`Project ${project} has no issue type '${issueType}'`);
  return { id: String(hit.id), name: String(hit.name) };
}

/** Workflow name plus project-config sharing data when a project and issue type are given. */
async function resolveWorkflow(client: AtlassianClient, ref: { workflow?: string; project?: string; issue_type?: string }, label = "") {
  if (ref.workflow && (ref.project || ref.issue_type)) throw new ValidationError(`Pass ${label}workflow or ${label}project_key with ${label}issue_type, not both`);
  if (ref.workflow) return { name: ref.workflow, config: null as any };
  if (!ref.project || !ref.issue_type) throw new ValidationError(`Pass ${label}workflow, or ${label}project_key with ${label}issue_type`);
  const it = await projectIssueType(client, ref.project, ref.issue_type);
  const config = await client.get(`/rest/projectconfig/1/issuetype/${seg(ref.project)}/${seg(it.id)}/workflow`);
  if (!config?.name) throw new ValidationError(`No workflow found for ${ref.project} / ${it.name}`);
  return { name: String(config.name), config };
}

const statusCategories = (client: AtlassianClient): Promise<any[]> => client.get(`${WD}/statusCategories`).then((x: any) => x ?? []);

async function transitionProperties(client: AtlassianClient, name: string, draft: boolean, actionIds: number[]) {
  const ids = [...new Set(actionIds)];
  const read = await boundedAll(ids.map((id) => async () => {
    try {
      const props: any[] = (await client.get(`${API}/workflow/transitions/${id}/properties`, { workflowName: name, workflowMode: draft ? "draft" : "live" })) ?? [];
      return Object.fromEntries(props.map((p) => [String(p.key), p.value]));
    } catch (e) {
      if (isHttpStatusError(e)) return { error: `HTTP ${e.status}` };
      throw e;
    }
  }));
  return new Map(ids.map((id, i) => [id, read[i]]));
}

const projectScanArg = z.coerce.number().int().min(1).max(2000).optional()
  .describe("Projects scanned to find the workflow schemes that use the workflow (default 500)");

const refShape = (prefix: string, what: string) => ({
  [`${prefix}workflow`]: z.string().min(1).optional().describe(`${what}: exact workflow name`),
  [`${prefix}project_key`]: z.string().min(1).optional().describe(`${what}: project key (with ${prefix}issue_type) instead of a name`),
  [`${prefix}issue_type`]: z.string().min(1).optional().describe(`${what}: issue type id or exact name in that project`),
});

const pickRef = (args: any, prefix: string) => ({ workflow: args[`${prefix}workflow`], project: args[`${prefix}project_key`], issue_type: args[`${prefix}issue_type`] });

// ---- editing ----

interface EditContext {
  name: string;
  active: boolean;
  model: WfModel;
  projects: string[];
}

/** Gate, activity (used by a scheme → edits go to the draft) and the version a change applies to. */
async function editContext(client: AtlassianClient, workflow: string, scanProjects?: number): Promise<EditContext> {
  await requireJiraVersion(client, "Workflow changes");
  const usage = await workflowUsage(client, workflow, scanProjects);
  const active = usage.projects.length > 0;
  if (!active && (usage.truncatedScan || usage.forbiddenProjects)) {
    // an unscanned project may use the workflow; editing it as inactive would change the published workflow
    throw new ValidationError(
      `Cannot tell whether '${workflow}' is active: the scan covered ${usage.scannedProjects} of ${usage.totalProjects} projects` +
        `${usage.forbiddenProjects ? ` (${usage.forbiddenProjects} answered 403)` : ""}. Re-run with a higher scan_projects or fewer throttled requests.`,
    );
  }
  const model = await loadModel(client, workflow, active);
  return { name: workflow, active, model, projects: usage.projects };
}

function targetNote(ctx: EditContext, global = false): string {
  if (global) return "the status itself (statuses are global; no workflow draft is involved)";
  if (!ctx.active) return `the workflow itself (no scanned workflow scheme uses '${ctx.name}')`;
  const shown = ctx.projects.slice(0, 10).join(", ") + (ctx.projects.length > 10 ? ", …" : "");
  return `the draft of '${ctx.name}' (active in ${shown}; ${ctx.model.isDraft ? "the draft exists" : "the draft is created on apply"}). ` +
    "Publish with jira_publish_workflow_draft.";
}

function findStatus(model: WfModel, given: string): WfStatus | undefined {
  const v = String(given).trim();
  return model.statuses.find((s) => s.statusId === v) ?? model.statuses.find((s) => s.name.toLowerCase() === v.toLowerCase());
}

function requireStatus(model: WfModel, given: string): WfStatus {
  const s = findStatus(model, given);
  if (!s) throw new ValidationError(`Status '${given}' is not in workflow '${model.name}'${model.isDraft ? " (draft)" : ""}`);
  return s;
}

/** Transitions by action id or exact name, optionally narrowed by source status; ambiguity is an error. */
function findTransition(model: WfModel, given: string, filter: (t: WfTransition) => boolean, from?: string): WfTransition | undefined {
  const v = String(given).trim();
  let hits = model.transitions.filter((t) => !t.initial && filter(t) && (String(t.actionId) === v || t.name.toLowerCase() === v.toLowerCase()));
  if (from !== undefined) {
    const source = requireStatus(model, from).name;
    hits = hits.filter((t) => t.source === source);
  }
  const ids = new Set(hits.map((t) => `${t.actionId}:${t.source}`));
  if (ids.size > 1) {
    const list = hits.map((t) => `${t.actionId} '${t.name}' ${t.source} → ${t.target}`).join("; ");
    throw new ValidationError(`Transition '${given}' is ambiguous in '${model.name}': ${list}. Pass the id or from`);
  }
  return hits[0];
}

async function resolveCategory(client: AtlassianClient, given: string): Promise<{ id: number; name: string }> {
  const cats = await statusCategories(client);
  const v = given.trim().toLowerCase();
  const hit = cats.find((c) => String(c.id) === v) ?? cats.find((c) => String(c.key).toLowerCase() === v || String(c.name).toLowerCase() === v);
  if (!hit) throw new ValidationError(`No status category '${given}'; use one of ${cats.map((c) => c.name).join(", ")}`);
  return { id: Number(hit.id), name: String(hit.name) };
}

/** Screen id for "none", an id or an exact name (0 means no screen, as the designer sends it). */
async function resolveScreen(client: AtlassianClient, given: string): Promise<{ id: number; name: string | null }> {
  const v = given.trim();
  if (v.toLowerCase() === "none") return { id: 0, name: null };
  const screens = await allScreens(client);
  const hit = screens.find((s) => String(s.id) === v) ?? screens.find((s) => s.name.toLowerCase() === v.toLowerCase());
  if (!hit) throw new ValidationError(`No screen '${given}'${screens.truncated ? " (only the first 5000 screens were read; pass the screen id)" : ""}`);
  return { id: hit.id, name: hit.name };
}

interface DesignerChange {
  summary: string;
  requests: WriteRequest[];
  identity: Record<string, unknown>;
  state: unknown;
  extra?: Record<string, unknown>;
  /** Problem with the read-back version, or null when it shows the change. */
  verify: (back: WfModel) => string | null;
  /** What to report after the change, from the read-back version. */
  result: (back: WfModel) => unknown;
  /** The change is not part of the workflow (a global status): no draft is created or required. */
  global?: boolean;
  /** Check run before sending (also in dry runs when it cannot touch a draft); throws to refuse. */
  precheck?: () => Promise<void>;
}

const form = (path: string, method: WriteRequest["method"], fields: Record<string, string | number | boolean>, summary: string): WriteRequest =>
  ({ method, path: `${WD}${path}`, urlencoded: fields, headers: NO_CHECK, summary });

/** Dry run, or: create the draft when needed, send the requests, read the version back and verify. */
async function applyChange(client: AtlassianClient, args: { dry_run?: boolean }, ctx: EditContext, change: DesignerChange) {
  const [first, ...rest] = await Promise.all(change.requests.map((r) => guardedWrite(client, { dry_run: true }, r)));
  const echo = {
    product: client.product,
    summary: change.summary,
    target: targetNote(ctx, change.global),
    request: first.request,
    ...(rest.length ? { followUps: rest.map((r) => r.request) } : {}),
    ...change.extra,
  };
  const viaDraft = ctx.active && !change.global;
  if (args.dry_run !== false) {
    // without a draft the check would run against the live workflow (or make Jira create the draft): it runs on apply
    const deferred = Boolean(change.precheck) && viaDraft && !ctx.model.isDraft;
    if (change.precheck && !deferred) await change.precheck();
    return {
      dry_run: true,
      ...echo,
      ...(deferred ? { precheck: "Jira validates the change against the draft when it is applied" } : {}),
      identity: change.identity,
      state: change.state,
      note: first.note,
    };
  }
  // loading the draft with draft=true creates it when the active workflow has none
  if (viaDraft) await client.get(`${WD}/workflows`, { name: ctx.name, draft: true });
  if (change.precheck) await change.precheck();
  for (const [i, r] of change.requests.entries()) {
    try {
      await client.request(r.method, r.path, { urlencoded: r.urlencoded, json: r.json, body: r.body, contentType: r.contentType, headers: r.headers });
    } catch (e) {
      if (i === 0) throw e;
      const partial = await loadModel(client, ctx.name, ctx.active).catch(() => null);
      throw new VerificationError(
        `${change.summary}: partly applied, request ${i + 1} of ${change.requests.length} failed (${(e as Error).message})`,
        partial ? change.result(partial) : undefined,
      );
    }
  }
  const back = await loadModel(client, ctx.name, ctx.active);
  if (viaDraft && !back.isDraft) throw new VerificationError(`${change.summary}: '${ctx.name}' has no draft after the change`);
  const problem = change.verify(back);
  if (problem) throw new VerificationError(`${change.summary}: ${problem}`, change.result(back));
  return { dry_run: false, ...echo, result: change.result(back) };
}

const statusView = (s: WfStatus | undefined) => (s ? { id: s.statusId, name: s.name, description: s.description, categoryId: s.categoryId } : null);
const transitionView = (t: WfTransition | undefined) =>
  t ? { id: t.actionId, name: t.name, from: t.source, to: t.target, description: t.description, screen: t.screenName ?? (t.screenId ? t.screenId : null), global: t.global } : null;

const workflowArg = z.string().min(1).describe("Exact workflow name");
const scanShape = { scan_projects: projectScanArg };

/** Layout of the version as the designer writes it when publishing (JS WorkflowDataWriter). */
function publishBody(model: WfModel) {
  const layout = model.raw?.layout ?? {};
  const statuses = (layout.statuses ?? []).map((s: any) => ({ id: s.id, x: s.x, y: s.y }));
  const transitions = (layout.transitions ?? []).map((t: any) => {
    const base = { id: t.id, sourceAngle: t.sourceAngle, targetAngle: t.targetAngle };
    if (t.loopedTransition) return base;
    return { ...base, sourceId: t.globalTransition ? t.targetId : t.sourceId, targetId: t.targetId };
  });
  const container = layout.loopedTransitionContainer;
  return {
    draft: model.isDraft,
    name: model.name,
    layout: { statuses, transitions, ...(container ? { loopedTransitionContainer: { x: container.x, y: container.y } } : {}) },
  };
}

export const jiraWorkflowTools: ToolDef[] = [
  {
    name: "jira_get_workflow",
    aliases: { project: "project_key" },
    product: "jira",
    description:
      "A workflow's structure: statuses (id, name, category, initial), transitions with directions (global = from any status, " +
      "looped = to itself), screens, transition properties, rule counts, draft state and sharing. Give a workflow name, or a " +
      "project and issue type. draft=true reads the draft. Conditions, validators and post-functions are not readable via REST.",
    inputShape: {
      ...refShape("", "Workflow"),
      draft: boolArg.optional().describe("Read the workflow's draft (error when it has none)"),
      properties: boolArg.optional().describe("Default true: read transition properties (one request per transition)"),
      ...scanShape,
      ...fullListsShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const { name, config } = await resolveWorkflow(c, pickRef(args, ""));
      const model = await loadModel(c, name, Boolean(args.draft));
      if (args.draft && !model.isDraft) throw new ValidationError(`Workflow '${name}' has no draft`);
      const [cats, info, hasDraft, props] = await Promise.all([
        statusCategories(c),
        c.get(`${API}/workflow`, { workflowName: name }).catch(() => null),
        args.draft ? true : config ? Boolean(config.isDraftWithChanges) : loadModel(c, name, true).then((m) => m.isDraft),
        args.properties === false ? null : transitionProperties(c, name, model.isDraft, model.transitions.map((t) => t.actionId)),
      ]);
      const catName = (id: number | null) => cats.find((x) => Number(x.id) === id)?.name ?? id;
      const described = Array.isArray(info) ? info.find((w: any) => w.name === name) : info;
      let sharing: Record<string, unknown>;
      if (config) {
        const types: any[] = (await c.get(`${API}/issuetype`)) ?? [];
        sharing = {};
        capList(sharing, "projects", (config.sharedWithProjects ?? []).map((p: any) => p.key), args.full_lists);
        sharing.hiddenProjects = config.hiddenProjectsCount || undefined;
        sharing.issueTypes = (config.sharedWithIssueTypes ?? []).map((id: string) => types.find((t) => String(t.id) === String(id))?.name ?? id);
      } else {
        const usage = await workflowUsage(c, name, args.scan_projects);
        sharing = {};
        capList(sharing, "projects", usage.projects, args.full_lists);
        capList(sharing, "schemes", usage.usedBy.map((u) => ({ scheme: u.scheme, schemeId: u.schemeId, asDefault: u.asDefault, issueTypes: u.issueTypes })), args.full_lists);
        sharing.scannedProjects = usage.scannedProjects;
        sharing.truncatedScan = usage.truncatedScan;
      }
      return {
        name,
        description: described?.description ?? null,
        isDraft: model.isDraft,
        hasDraft,
        initialStatus: model.initialStatus,
        statuses: model.statuses.map((s) => ({ id: s.statusId, name: s.name, category: catName(s.categoryId), initial: s.name === model.initialStatus || undefined })),
        transitions: model.transitions.map((t) => ({
          id: t.actionId,
          name: t.name,
          from: t.source,
          to: t.target,
          global: t.global || undefined,
          looped: t.looped || undefined,
          initial: t.initial || undefined,
          screen: t.screenName ?? undefined,
          description: t.description || undefined,
          ruleCounts: t.rules,
          properties: props?.get(t.actionId),
        })),
        sharing,
        rules: { available: false, reason: RULES_GAP },
      };
    },
  },
  {
    name: "jira_compare_workflows",
    aliases: { first_project: "first_project_key", second_project: "second_project_key" },
    product: "jira",
    description:
      "Compare the status models of two workflows (each by name, or project and issue type): statuses only in one or in " +
      "both, transitions (by source → target status names) only in one, and transitions whose name differs. Rules are not compared.",
    inputShape: { ...refShape("first_", "First workflow"), ...refShape("second_", "Second workflow") },
    async handler({ client }, args) {
      const c = client("jira");
      const [a, b] = await Promise.all([resolveWorkflow(c, pickRef(args, "first_"), "first_"), resolveWorkflow(c, pickRef(args, "second_"), "second_")]);
      const [ma, mb] = await Promise.all([loadModel(c, a.name), loadModel(c, b.name)]);
      return { first: a.name, second: b.name, ...compareModels(ma, mb), rules: { compared: false, reason: RULES_GAP } };
    },
  },
  {
    name: "jira_add_workflow_status",
    product: "jira",
    write: true,
    description:
      "Add a status to a workflow: an existing status (id or exact name), or a new one when no status has that name " +
      "(category required: To Do / In Progress / Done, id or key). Already in the workflow → already-satisfied. " +
      "Active workflows are changed through their draft.",
    inputShape: {
      workflow: workflowArg,
      status: z.string().trim().min(1).describe("Status id or exact name"),
      category: z.string().trim().min(1).optional().describe("Status category for a new status (name, key or id)"),
      description: z.string().optional().describe("Description of a new status"),
      global_transition: boolArg.optional().describe("Also create a transition from any status to this one (default false)"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const summary = `Add status '${args.status}' to workflow '${ctx.name}'`;
      if (findStatus(ctx.model, args.status)) return alreadySatisfied(summary, "the status is already in the workflow");
      const all: any[] = (await c.get(`${WD}/statuses`)) ?? [];
      const v = args.status.trim();
      const existing = all.find((s) => String(s.id) === v) ?? all.find((s) => String(s.name).toLowerCase() === v.toLowerCase());
      const createGlobalTransition = Boolean(args.global_transition);
      let req: WriteRequest;
      if (existing) {
        if (args.category || args.description !== undefined) {
          throw new ValidationError(`Status '${existing.name}' (${existing.id}) already exists; omit category/description to add it, or use jira_update_workflow_status`);
        }
        req = form("/workflows/statuses", "POST", { statusId: String(existing.id), workflowName: ctx.name, createGlobalTransition }, summary);
      } else {
        if (!args.category) throw new ValidationError(`No status '${args.status}' exists; pass category to create it`);
        const cat = await resolveCategory(c, args.category);
        req = form("/workflows/statuses/create", "POST", { name: v, description: args.description ?? "", statusCategoryId: cat.id, workflowName: ctx.name, createGlobalTransition }, `${summary} (new status, category ${cat.name})`);
      }
      const wanted = existing ? String(existing.id) : v;
      return applyChange(c, args, ctx, {
        summary: req.summary,
        requests: [req],
        identity: { op: "add-workflow-status", workflow: ctx.name, status: v, category: args.category ?? null, description: args.description ?? null, createGlobalTransition },
        state: { present: false },
        extra: { newStatus: !existing },
        verify: (back) => (findStatus(back, wanted) ? null : "the status is not in the workflow after the change"),
        result: (back) => statusView(findStatus(back, wanted)),
      });
    },
  },
  {
    name: "jira_update_workflow_status",
    product: "jira",
    write: true,
    description:
      "Change a status of a workflow: name, description and/or category. Statuses are global, so the change shows in every " +
      "workflow that uses the status. Same values → already-satisfied.",
    inputShape: {
      workflow: workflowArg,
      status: z.string().trim().min(1).describe("Status id or exact name in the workflow"),
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      category: z.string().trim().min(1).optional().describe("Status category name, key or id"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (args.name === undefined && args.description === undefined && args.category === undefined) throw new ValidationError("Pass name, description or category");
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const s = requireStatus(ctx.model, args.status);
      const cat = args.category ? await resolveCategory(c, args.category) : null;
      const after = { name: args.name ?? s.name, description: args.description ?? s.description, categoryId: cat ? cat.id : s.categoryId };
      const before = { name: s.name, description: s.description, categoryId: s.categoryId };
      const changed = (Object.keys(after) as Array<keyof typeof after>).filter((k) => after[k] !== before[k]);
      const summary = `Update status '${s.name}' (${s.statusId}) of workflow '${ctx.name}'`;
      if (!changed.length) return alreadySatisfied(summary, "the status already has these values");
      const req = form("/workflows/statuses", "PUT", { statusId: s.statusId, name: after.name, description: after.description, statusCategoryId: after.categoryId ?? "", workflowName: ctx.name }, summary);
      return applyChange(c, args, ctx, {
        summary,
        requests: [req],
        identity: { op: "update-workflow-status", workflow: ctx.name, status: args.status, ...Object.fromEntries(changed.map((k) => [k, after[k]])) },
        state: Object.fromEntries(changed.map((k) => [k, before[k]])),
        global: true,
        extra: { before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])), note: "Statuses are global: every workflow using this status shows the change." },
        verify: (back) => {
          const b = back.statuses.find((x) => x.statusId === s.statusId);
          if (!b) return "the status is no longer in the workflow";
          const bad = changed.filter((k) => (k === "categoryId" ? b.categoryId : b[k]) !== after[k]);
          return bad.length ? `Jira reports other values for ${bad.join(", ")}` : null;
        },
        result: (back) => statusView(back.statuses.find((x) => x.statusId === s.statusId)),
      });
    },
  },
  {
    name: "jira_remove_workflow_status",
    product: "jira",
    write: true,
    description:
      "Remove a status from a workflow. Jira first validates the removal (it refuses e.g. the initial status); a refusal is " +
      "an error with Jira's reason. Not in the workflow → already-satisfied.",
    inputShape: { workflow: workflowArg, status: z.string().trim().min(1).describe("Status id or exact name"), ...scanShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const s = findStatus(ctx.model, args.status);
      const summary = `Remove status '${s?.name ?? args.status}' from workflow '${ctx.name}'`;
      if (!s) return alreadySatisfied(summary, "the status is not in the workflow");
      if (s.name === ctx.model.initialStatus) throw new ValidationError(`'${s.name}' is the initial status of '${ctx.name}' and cannot be removed`);
      const fields = { statusId: s.statusId, workflowName: ctx.name };
      const precheck = async () => {
        try {
          const check = await c.request("POST", `${WD}/workflows/statuses/validateRemove`, { urlencoded: fields, headers: NO_CHECK });
          const messages: string[] = [...(check?.errorMessages ?? []), ...Object.values(check?.errors ?? {}).map(String)];
          if (messages.length) throw new ValidationError(`Jira refuses to remove '${s.name}' from '${ctx.name}': ${messages.join("; ")}`);
        } catch (e) {
          if (isHttpStatusError(e) && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403) {
            throw new ValidationError(`Jira refuses to remove '${s.name}' from '${ctx.name}': ${errorDetail(e.body) || `HTTP ${e.status}`}`);
          }
          throw e;
        }
      };
      return applyChange(c, args, ctx, {
        summary,
        requests: [form("/workflows/statuses", "DELETE", fields, summary)],
        precheck,
        identity: { op: "remove-workflow-status", workflow: ctx.name, status: args.status },
        state: { present: true },
        verify: (back) => (back.statuses.some((x) => x.statusId === s.statusId) ? "the status is still in the workflow" : null),
        result: () => ({ removed: { id: s.statusId, name: s.name } }),
      });
    },
  },
  {
    name: "jira_add_workflow_transition",
    product: "jira",
    write: true,
    description:
      "Add a transition between two statuses of a workflow (status ids or exact names), with an optional screen. The same " +
      "name between the same statuses → already-satisfied.",
    inputShape: {
      workflow: workflowArg,
      name: z.string().trim().min(1),
      from: z.string().trim().min(1).describe("Source status (id or exact name)"),
      to: z.string().trim().min(1).describe("Target status (id or exact name)"),
      description: z.string().optional(),
      screen: z.string().trim().min(1).optional().describe("Screen id or exact name (default: none)"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const from = requireStatus(ctx.model, args.from);
      const to = requireStatus(ctx.model, args.to);
      const summary = `Add transition '${args.name}' ${from.name} → ${to.name} to workflow '${ctx.name}'`;
      const same = (m: WfModel) => m.transitions.find((t) => !t.global && !t.looped && !t.initial && t.source === from.name && t.target === to.name && t.name.toLowerCase() === args.name.toLowerCase());
      if (same(ctx.model)) return alreadySatisfied(summary, "a transition with this name already connects these statuses");
      const screen = args.screen ? await resolveScreen(c, args.screen) : { id: 0, name: null };
      return applyChange(c, args, ctx, {
        summary,
        requests: [form("/workflows/transitions", "POST", { name: args.name, description: args.description ?? "", screenId: screen.id, sourceStepId: from.stepId, targetStepId: to.stepId, workflowName: ctx.name }, summary)],
        identity: { op: "add-workflow-transition", workflow: ctx.name, name: args.name, from: from.name, to: to.name, description: args.description ?? null, screen: screen.name },
        state: { present: false },
        verify: (back) => (same(back) ? null : "the transition is not in the workflow after the change"),
        result: (back) => transitionView(same(back)),
      });
    },
  },
  {
    name: "jira_update_workflow_transition",
    product: "jira",
    write: true,
    description:
      "Change a transition (action id or exact name; from narrows a name used by several transitions): name, description, " +
      "screen ('none' removes it) and/or target status. Global transitions: remove and re-add them.",
    inputShape: {
      workflow: workflowArg,
      transition: z.string().trim().min(1).describe("Transition action id or exact name"),
      from: z.string().trim().min(1).optional().describe("Source status (id or exact name), when the name is ambiguous"),
      name: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      screen: z.string().trim().min(1).optional().describe("Screen id or exact name, or 'none'"),
      to: z.string().trim().min(1).optional().describe("New target status (id or exact name)"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if ([args.name, args.description, args.screen, args.to].every((v) => v === undefined)) throw new ValidationError("Pass name, description, screen or to");
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const t = findTransition(ctx.model, args.transition, (x) => !x.global && !x.looped, args.from);
      if (!t) throw new ValidationError(`No transition '${args.transition}'${args.from ? ` from '${args.from}'` : ""} in '${ctx.name}' (global transitions: remove and re-add)`);
      const screen = args.screen ? await resolveScreen(c, args.screen) : { id: t.screenId ?? 0, name: t.screenName };
      const to = args.to ? requireStatus(ctx.model, args.to) : null;
      const before = { name: t.name, description: t.description, screen: t.screenName, to: t.target };
      const after = { name: args.name ?? t.name, description: args.description ?? t.description, screen: screen.name, to: to?.name ?? t.target };
      const changed = (Object.keys(after) as Array<keyof typeof after>).filter((k) => after[k] !== before[k]);
      const summary = `Update transition ${t.actionId} '${t.name}' (${t.source} → ${t.target}) of workflow '${ctx.name}'`;
      if (!changed.length) return alreadySatisfied(summary, "the transition already has these values");
      const requests: WriteRequest[] = [];
      if (changed.some((k) => k !== "to")) {
        requests.push(form("/workflows/transitions", "PUT", { transitionId: t.actionId, sourceStepId: t.sourceStepId ?? "", name: after.name, description: after.description, screenId: screen.id, workflowName: ctx.name }, summary));
      }
      if (to && changed.includes("to")) {
        requests.push(form("/workflows/transitions/target", "POST", { transitionId: t.actionId, targetStatusId: to.statusId, workflowName: ctx.name }, `${summary}: target → ${to.name}`));
      }
      const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k]]));
      const find = (m: WfModel) => m.transitions.find((x) => x.actionId === t.actionId && x.source === t.source);
      const sharedFrom = ctx.model.transitions.filter((x) => x.actionId === t.actionId).map((x) => x.source);
      return applyChange(c, args, ctx, {
        summary,
        requests,
        identity: { op: "update-workflow-transition", workflow: ctx.name, transition: args.transition, from: args.from ?? null, ...pick(after) },
        state: pick(before),
        extra: {
          before: pick(before),
          after: pick(after),
          ...(sharedFrom.length > 1 ? { note: `Transition ${t.actionId} is shared by ${sharedFrom.join(", ")}: the change applies from every one of them.` } : {}),
        },
        verify: (back) => {
          const b = find(back);
          if (!b) return "the transition is no longer in the workflow";
          const now = { name: b.name, description: b.description, screen: b.screenName, to: b.target };
          const bad = changed.filter((k) => now[k] !== after[k]);
          return bad.length ? `Jira reports other values for ${bad.join(", ")}` : null;
        },
        result: (back) => transitionView(find(back)),
      });
    },
  },
  {
    name: "jira_remove_workflow_transition",
    product: "jira",
    write: true,
    description: "Remove a transition (action id or exact name; from narrows it). Global transitions: jira_remove_workflow_global_transition. Absent → already-satisfied.",
    inputShape: {
      workflow: workflowArg,
      transition: z.string().trim().min(1).describe("Transition action id or exact name"),
      from: z.string().trim().min(1).optional().describe("Source status (id or exact name), when the name is ambiguous"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const t = findTransition(ctx.model, args.transition, (x) => !x.global && !x.looped, args.from);
      const summary = `Remove transition '${t?.name ?? args.transition}'${t ? ` (${t.source} → ${t.target})` : ""} from workflow '${ctx.name}'`;
      if (!t) return alreadySatisfied(summary, "no such transition in the workflow");
      const gone = (m: WfModel) => !m.transitions.some((x) => x.actionId === t.actionId && x.source === t.source);
      return applyChange(c, args, ctx, {
        summary,
        requests: [form("/workflows/transitions", "DELETE", { transitionId: t.actionId, sourceStepId: t.sourceStepId ?? "", workflowName: ctx.name }, summary)],
        identity: { op: "remove-workflow-transition", workflow: ctx.name, transition: args.transition, from: args.from ?? null },
        state: { present: true },
        verify: (back) => (gone(back) ? null : "the transition is still in the workflow"),
        result: () => ({ removed: transitionView(t) }),
      });
    },
  },
  {
    name: "jira_add_workflow_global_transition",
    product: "jira",
    write: true,
    description: "Add a global transition (from any status) to a status of the workflow. Same name to the same status → already-satisfied.",
    inputShape: {
      workflow: workflowArg,
      name: z.string().trim().min(1),
      to: z.string().trim().min(1).describe("Target status (id or exact name)"),
      description: z.string().optional(),
      screen: z.string().trim().min(1).optional().describe("Screen id or exact name (default: none)"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const to = requireStatus(ctx.model, args.to);
      const summary = `Add global transition '${args.name}' (any → ${to.name}) to workflow '${ctx.name}'`;
      const same = (m: WfModel) => m.transitions.find((t) => t.global && t.target === to.name && t.name.toLowerCase() === args.name.toLowerCase());
      if (same(ctx.model)) return alreadySatisfied(summary, "a global transition with this name already leads to this status");
      const screen = args.screen ? await resolveScreen(c, args.screen) : { id: 0, name: null };
      return applyChange(c, args, ctx, {
        summary,
        requests: [form("/workflows/globalTransitions/simple", "POST", { statusId: to.statusId, workflowName: ctx.name, name: args.name, description: args.description ?? "", screenId: screen.id }, summary)],
        identity: { op: "add-workflow-global-transition", workflow: ctx.name, name: args.name, to: to.name, description: args.description ?? null, screen: screen.name },
        state: { present: false },
        verify: (back) => (same(back) ? null : "the global transition is not in the workflow after the change"),
        result: (back) => transitionView(same(back)),
      });
    },
  },
  {
    name: "jira_remove_workflow_global_transition",
    product: "jira",
    write: true,
    description: "Remove a global transition (action id or exact name; to narrows it by target status). Absent → already-satisfied.",
    inputShape: {
      workflow: workflowArg,
      transition: z.string().trim().min(1).describe("Global transition action id or exact name"),
      to: z.string().trim().min(1).optional().describe("Target status (id or exact name), when the name is ambiguous"),
      ...scanShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const ctx = await editContext(c, args.workflow, args.scan_projects);
      const toName = args.to === undefined ? undefined : requireStatus(ctx.model, args.to).name;
      const t = findTransition(ctx.model, args.transition, (x) => x.global && (toName === undefined || x.target === toName));
      const summary = `Remove global transition '${t?.name ?? args.transition}'${t ? ` (any → ${t.target})` : ""} from workflow '${ctx.name}'`;
      if (!t) return alreadySatisfied(summary, "no such global transition in the workflow");
      return applyChange(c, args, ctx, {
        summary,
        requests: [form("/workflows/globalTransitions", "DELETE", { transitionId: t.actionId, workflowName: ctx.name }, summary)],
        identity: { op: "remove-workflow-global-transition", workflow: ctx.name, transition: args.transition, to: args.to ?? null },
        state: { present: true },
        verify: (back) => (back.transitions.some((x) => x.global && x.actionId === t.actionId) ? "the global transition is still in the workflow" : null),
        result: () => ({ removed: transitionView(t) }),
      });
    },
  },
  {
    name: "jira_publish_workflow_draft",
    product: "jira",
    write: true,
    description:
      "Publish the draft of an active workflow. The dry run lists the differences between the published workflow and the " +
      "draft and the projects that use it. No issue migration: if Jira requires one, the publish fails and is done in the UI. " +
      "No draft → already-satisfied, so plan the publish after the edits were applied (a second plan).",
    inputShape: { workflow: workflowArg, ...scanShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJiraVersion(c, "Workflow changes");
      const [draft, live] = await Promise.all([loadModel(c, args.workflow, true), loadModel(c, args.workflow)]);
      const summary = `Publish the draft of workflow '${args.workflow}'`;
      if (!draft.isDraft) return alreadySatisfied(summary, "the workflow has no draft");
      const usage = await workflowUsage(c, args.workflow, args.scan_projects);
      const differences = compareModels(live, draft);
      const req: WriteRequest = { method: "POST", path: `${WD}/workflows/publishDraft`, json: publishBody(draft), headers: NO_CHECK, summary };
      const extra = { differences: { first: "published", second: "draft", ...differences }, affectedProjects: usage.projects, rules: { compared: false, reason: RULES_GAP } };
      if (args.dry_run !== false) {
        return { ...(await guardedWrite(c, args, req)), ...extra, identity: { op: "publish-workflow-draft", workflow: args.workflow }, state: { hasDraft: true } };
      }
      await c.request("POST", req.path, { json: req.json, headers: NO_CHECK });
      const [after, published] = await Promise.all([loadModel(c, args.workflow, true), loadModel(c, args.workflow)]);
      if (after.isDraft) throw new VerificationError(`${summary}: the draft still exists after publishing`);
      if (!compareModels(draft, published).identical) throw new VerificationError(`${summary}: the published workflow differs from the draft`, compareModels(draft, published));
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, ...extra, result: { published: true } };
    },
  },
  {
    name: "jira_discard_workflow_draft",
    product: "jira",
    write: true,
    description: "Discard the draft of a workflow; the published workflow stays as it is. No draft → already-satisfied.",
    inputShape: { workflow: workflowArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJiraVersion(c, "Workflow changes");
      const [draft, live] = await Promise.all([loadModel(c, args.workflow, true), loadModel(c, args.workflow)]);
      const summary = `Discard the draft of workflow '${args.workflow}'`;
      if (!draft.isDraft) return alreadySatisfied(summary, "the workflow has no draft");
      const req: WriteRequest = { method: "POST", path: `${WD}/workflows/discardDraft`, body: args.workflow, contentType: "application/json", headers: NO_CHECK, summary };
      const differences = compareModels(live, draft);
      if (args.dry_run !== false) {
        return { ...(await guardedWrite(c, args, req)), discarded: { first: "published", second: "draft", ...differences }, identity: { op: "discard-workflow-draft", workflow: args.workflow }, state: { hasDraft: true } };
      }
      await c.request("POST", req.path, { body: req.body, contentType: req.contentType, headers: NO_CHECK });
      if ((await loadModel(c, args.workflow, true)).isDraft) throw new VerificationError(`${summary}: the draft still exists`);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { discarded: true } };
    },
  },
];
