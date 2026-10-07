/**
 * Options of select-type custom fields, per context.
 *
 * Reading uses the public `/rest/api/2/customFields/{numericId}/options` with the project and
 * issue type pair that selects a context. Writing uses the bundled
 * `/rest/globalconfig/1/customfieldoptions/{fieldId}/setOptions`, the call Jira's own "add
 * custom field" wizard makes for a field it has just created:
 * `{options: [{name}], issueContext: {projectId, issueTypeId}}` (verified on Jira 11.3.6).
 * It carries names only, and whether it replaces or appends existing options is not
 * documented, so options are written only to a context that has none. Every other change
 * (add, rename, reorder, disable, enable) is prepared for the admin options page, which is
 * behind websudo, and verified by running the tool again. Options are never deleted.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { UnsupportedError, ValidationError, VerificationError } from "../../errors.js";
import { requireJiraVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, fullListsShape, guardedWrite, pageShape, serverPage } from "../util.js";
import { fieldPlaceholder, resolveField, type FieldRef } from "./fieldRefs.js";

const TYPE_PREFIX = "com.atlassian.jira.plugin.system.customfieldtypes";
/** Field types whose values are options (the cascading select only on its parent level). */
const OPTION_TYPES = ["select", "multiselect", "radiobuttons", "multicheckboxes", "cascadingselect"].map((t) => `${TYPE_PREFIX}:${t}`);
const MAX_OPTIONS = 1000;

export interface StoredOption {
  id: number;
  value: string;
  disabled: boolean;
}

export interface TargetOption {
  /** an existing option's id: renames it to `value` */
  id?: number;
  value: string;
  disabled?: boolean;
}

/**
 * What an administrator has to do in the UI to turn `stored` into `target`: rename, add,
 * disable/enable, reorder. Options not in the target are kept after the listed ones.
 * An empty `steps` list means the stored options already match.
 */
export function manualOptionSteps(stored: StoredOption[], target: TargetOption[]): { steps: string[]; kept: string[]; order: string[] } {
  const values = target.map((t) => t.value);
  const dup = values.find((v, i) => values.indexOf(v) !== i);
  if (dup !== undefined) throw new ValidationError(`Option '${dup}' appears more than once in the target list`);

  const matched = new Map<TargetOption, StoredOption | undefined>();
  for (const t of target) {
    let s: StoredOption | undefined;
    if (t.id !== undefined) {
      s = stored.find((o) => o.id === t.id);
      if (!s) throw new ValidationError(`Option id ${t.id} does not exist in this context`);
      const clash = stored.find((o) => o.value === t.value && o.id !== t.id);
      if (clash) throw new ValidationError(`Option '${t.value}' already exists (id ${clash.id}); it cannot be the new name of option ${t.id}`);
    } else {
      s = stored.find((o) => o.value === t.value);
    }
    matched.set(t, s);
  }
  const used = new Set([...matched.values()].filter(Boolean).map((s) => s!.id));
  const kept = stored.filter((o) => !used.has(o.id)).map((o) => o.value);

  const steps: string[] = [];
  for (const [t, s] of matched) if (s && s.value !== t.value) steps.push(`rename '${s.value}' to '${t.value}'`);
  for (const [t, s] of matched) if (!s) steps.push(`add '${t.value}'`);
  for (const [t, s] of matched) {
    const want = !!t.disabled;
    if (s && s.disabled !== want) steps.push(`${want ? "disable" : "enable"} '${t.value}'`);
  }
  // order: listed options first (in target order), then the kept ones in their stored order
  const order = [...values, ...kept];
  // the UI keeps existing options in place and appends new ones; reorder unless that already gives `order`
  const renamed = stored.map((o) => [...matched].find(([, s]) => s?.id === o.id)?.[0].value ?? o.value);
  const afterAdd = [...renamed, ...values.filter((v) => !renamed.includes(v))];
  if (JSON.stringify(afterAdd) !== JSON.stringify(order)) {
    steps.push(`order: ${values.map((v) => `'${v}'`).join(", ")}${kept.length ? `, then ${kept.map((v) => `'${v}'`).join(", ")}` : ""}`);
  }
  return { steps, kept, order };
}

// -- contexts and their project/issue type pair ------------------------------------------

interface RawContext {
  id: number;
  name: string;
  allProjects: boolean;
  projects: string[];
  allIssueTypes: boolean;
  issueTypes: string[];
  fieldConfigId?: number;
}

async function contextsOf(client: AtlassianClient, fieldId: string): Promise<RawContext[]> {
  const data: any = await client.get(`/rest/internal/2/field/${seg(fieldId)}/context`);
  return (Array.isArray(data) ? data : []).map((c: any) => ({
    id: Number(c.id),
    name: String(c.name ?? ""),
    allProjects: !!c.allProjects,
    projects: (c.projects ?? []).map((p: any) => String(p.id)),
    allIssueTypes: !!c.allIssueTypes,
    issueTypes: (c.issueTypes ?? []).map((t: any) => String(t.id)),
    fieldConfigId: c.fieldConfigIds?.[0] !== undefined ? Number(c.fieldConfigIds[0]) : undefined,
  }));
}

interface Pair {
  projectId: string | null;
  issueTypeId: string | null;
}

/** The pair that selects a context: its first project and issue type, or none where it covers all. */
function pairOf(c: RawContext): Pair {
  return { projectId: c.allProjects ? null : (c.projects[0] ?? null), issueTypeId: c.allIssueTypes ? null : (c.issueTypes[0] ?? null) };
}

/** How specifically a context covers a pair (project beats issue type beats global), or -1. */
function specificity(c: RawContext, pair: Pair): number {
  const p = c.allProjects ? 0 : pair.projectId !== null && c.projects.includes(pair.projectId) ? 2 : -1;
  const t = c.allIssueTypes ? 0 : pair.issueTypeId !== null && c.issueTypes.includes(pair.issueTypeId) ? 1 : -1;
  return p < 0 || t < 0 ? -1 : p + t;
}

function scopeLabel(c: RawContext, full = true): string {
  const labels = (items: string[]) => full || items.length <= 10 ? items.join(",") : `${items.slice(0, 10).join(",")} (+${items.length - 10} more; total ${items.length}; full_lists=true)`;
  return `${c.allProjects ? "all projects" : `projects ${labels(c.projects)}`}; ${c.allIssueTypes ? "all issue types" : `issue types ${labels(c.issueTypes)}`}`;
}

function pickContext(contexts: RawContext[], given: string | undefined): RawContext {
  if (given === undefined || given === "default") {
    if (contexts.length !== 1) {
      throw new ValidationError(`The field has ${contexts.length} contexts; pass context: ${contexts.map((c) => `${c.id} (${c.name})`).join(", ")}`);
    }
    return contexts[0];
  }
  const c = contexts.find((x) => String(x.id) === given);
  if (!c) throw new ValidationError(`The field has no context ${given}; contexts: ${contexts.map((x) => `${x.id} (${x.name})`).join(", ")}`);
  return c;
}

const numericId = (fieldId: string) => fieldId.replace(/^customfield_/, "");

async function readOptions(client: AtlassianClient, fieldId: string, pair: Pair): Promise<StoredOption[]> {
  const data: any = await client.get(`/rest/api/2/customFields/${numericId(fieldId)}/options`, {
    projectIds: pair.projectId ?? undefined,
    issueTypeIds: pair.issueTypeId ?? undefined,
    maxResults: MAX_OPTIONS,
  });
  return (data?.options ?? []).map((o: any) => ({ id: Number(o.id), value: String(o.value), disabled: !!o.disabled }));
}

function requireOptionType(field: FieldRef): void {
  if (!field.custom || !OPTION_TYPES.includes(String(field.type))) {
    throw new ValidationError(`${field.name} (${field.id}) is of type ${field.type ?? "system"}, which has no options`);
  }
}

// -- arguments --------------------------------------------------------------------------

const optionList = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const text = v.trim();
    if (text.startsWith("[")) return JSON.parse(text);
    return text.split(",").map((s) => s.trim()).filter(Boolean);
  },
  z.array(z.union([
    z.object({ id: z.coerce.number().int().optional(), value: z.coerce.string().min(1), disabled: z.boolean().optional() }).strict(),
    z.union([z.string().min(1), z.number()]).transform((v) => ({ value: String(v) })),
  ])),
);

const fieldArg = z.coerce.string().min(1).describe("customfield_N or the exact field name (also of a field created earlier in the same plan)");
const contextArg = z.coerce.string().optional().describe("Context id, or `default`: the field's only context (also when omitted)");

/** Stored options only take part in drift detection when the field was given by id (see customFields.ts). */
const stateFor = (field: FieldRef, state: unknown) => (typeof field.ref === "string" ? state : undefined);

export const jiraFieldOptionTools: ToolDef[] = [
  {
    name: "jira_get_custom_field_options",
    product: "jira",
    description:
      "Option counts per context of a select-type custom field; give context to page its options (id, value, disabled) " +
      "in stored order, with its project and issue type scope (first 10 labels; full_lists=true for all).",
    narrowing: ["context", "limit", "offset", "full_lists"],
    inputShape: { field: fieldArg, context: contextArg, ...fullListsShape, ...pageShape(100, MAX_OPTIONS) },
    async handler({ client }, args) {
      const c = client("jira");
      const field = await resolveField(c, args.field);
      requireOptionType(field);
      const all = await contextsOf(c, field.id!);
      const fieldView = { id: field.id, name: field.name, type: field.type };
      const request = async (ctx: RawContext, offset: number, limit: number) => {
        const pair = pairOf(ctx);
        return c.get(`/rest/api/2/customFields/${numericId(field.id!)}/options`, {
          projectIds: pair.projectId ?? undefined,
          issueTypeIds: pair.issueTypeId ?? undefined,
          startAt: offset,
          // Older endpoints ignore startAt: request enough entries to slice locally.
          maxResults: offset + limit,
        });
      };
      if (args.context === undefined) {
        const contexts = [];
        for (const ctx of all) {
          const data = await request(ctx, 0, 1);
          const count = data?.total !== undefined
            ? { optionCount: data.total }
            : {
              optionCount: null,
              optionCountLowerBound: (await readOptions(c, field.id!, pairOf(ctx))).length,
              optionCountComplete: false,
              hint: "The endpoint did not report a total; pass context to page its options.",
            };
          contexts.push({ id: ctx.id, name: ctx.name, scope: scopeLabel(ctx, !!args.full_lists), ...count });
        }
        return { field: fieldView, contexts };
      }
      const ctx = pickContext(all, args.context);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const data = await request(ctx, offset, limit);
      const options = (data?.options ?? []).map((o: any) => ({ id: Number(o.id), value: String(o.value), disabled: !!o.disabled }));
      const items = data?.startAt !== undefined ? options.slice(0, limit) : options.slice(offset, offset + limit);
      // A legacy prefix limited by maxResults is not evidence of the full total.
      const total = data?.total;
      const page = serverPage(items, offset, limit, total, data?.isLast && options.length <= limit ? true : undefined);
      return { field: fieldView, context: { id: ctx.id, name: ctx.name, scope: scopeLabel(ctx, !!args.full_lists) }, ...page };
    },
  },
  {
    name: "jira_set_custom_field_options",
    product: "jira",
    write: true,
    description:
      "Set the options of a select-type field's context: options = comma list of values or JSON [{value, id?, disabled?}] " +
      "in order. A context without options gets them through the API (Severity 1–4 on a new field). For a context that " +
      "already has options nothing is sent: the dry run is a manual change with the steps (add, rename by id, order, " +
      "disable, enable) and the options page link; running again verifies. Options are never deleted. Jira 11.3.x only.",
    inputShape: { field: fieldArg, context: contextArg, options: optionList, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJiraVersion(c, "Custom field option changes");
      const target: TargetOption[] = args.options;
      if (!target.length) throw new ValidationError("Pass at least one option");
      manualOptionSteps([], target.filter((t) => t.id === undefined)); // duplicate check before any lookup
      const dryRun = args.dry_run !== false;
      const field = await resolveField(c, args.field, { allowPending: dryRun });
      const identity = { op: "set-options", field: field.ref, context: args.context ?? "default", options: target };
      const disabledNote = (opts: TargetOption[]) => {
        const off = opts.filter((t) => t.disabled).map((t) => `'${t.value}'`);
        return off.length ? `${off.join(", ")} cannot be created disabled; disable ${off.length === 1 ? "it" : "them"} in the UI afterwards` : undefined;
      };

      if (!field.id) {
        // created by an earlier plan item: Jira gives a new field one global context, which is empty
        return {
          ...(await guardedWrite(c, { dry_run: true }, {
            method: "POST",
            path: `/rest/globalconfig/1/customfieldoptions/${seg(fieldPlaceholder(field))}/setOptions`,
            json: { options: target.map((t) => ({ name: t.value })), issueContext: { projectId: null, issueTypeId: null } },
            summary: `Set options of ${field.name} (created earlier in the plan): ${target.map((t) => t.value).join(", ")}`,
          })),
          warning: disabledNote(target),
          identity,
        };
      }

      requireOptionType(field);
      const contexts = await contextsOf(c, field.id);
      const ctx = pickContext(contexts, args.context);
      const pair = pairOf(ctx);
      const mine = specificity(ctx, pair);
      const rival = contexts.find((x) => x.id !== ctx.id && specificity(x, pair) >= mine);
      if (rival) {
        throw new UnsupportedError(
          `Context ${ctx.id} (${ctx.name}) cannot be addressed: the options resource selects a context by project and issue type, and that pair also selects context ${rival.id} (${rival.name})`,
        );
      }
      const stored = await readOptions(c, field.id, pair);
      const label = `${field.name} in context ${ctx.id} '${ctx.name}' (${scopeLabel(ctx)})`;
      const plan = manualOptionSteps(stored, target);
      if (!plan.steps.length) return alreadySatisfied(`Options of ${label}`, "the stored options already match");
      const before = stored.map((o) => `${o.value}${o.disabled ? " (disabled)" : ""}`);
      const after = plan.order.map((v) => `${v}${target.find((t) => t.value === v)?.disabled ? " (disabled)" : ""}`);

      if (stored.length) {
        const editUrl = c.url("/secure/admin/EditCustomFieldOptions!default.jspa", { fieldConfigId: ctx.fieldConfigId });
        const reason = "Jira's options API only sets the options of an empty context; changes to existing options are made on the options page (behind websudo)";
        if (!dryRun) {
          throw new UnsupportedError(`Options of ${label} cannot be changed through the API: ${reason}. At ${editUrl}: ${plan.steps.join("; ")}`, { editUrl, steps: plan.steps });
        }
        return {
          dry_run: true,
          product: c.product,
          summary: `Options of ${label}: ${plan.steps.join("; ")} (enter manually)`,
          request: { method: "MANUAL", url: editUrl, body: { steps: plan.steps } },
          manual: { reason, editUrl },
          before,
          after,
          kept: plan.kept,
          warning: plan.kept.length ? `kept (not in the target list): ${plan.kept.join(", ")}` : undefined,
          identity,
          state: stateFor(field, stored),
        };
      }

      const req = {
        method: "POST" as const,
        path: `/rest/globalconfig/1/customfieldoptions/${seg(field.id)}/setOptions`,
        json: { options: target.map((t) => ({ name: t.value })), issueContext: pair },
        summary: `Set options of ${label}: ${target.map((t) => t.value).join(", ")}`,
      };
      if (dryRun) return { ...(await guardedWrite(c, args, req)), before, after, warning: disabledNote(target), identity, state: stateFor(field, stored) };
      await c.request(req.method, req.path, { json: req.json });
      const back = await readOptions(c, field.id, pair);
      if (JSON.stringify(back.map((o) => o.value)) !== JSON.stringify(target.map((t) => t.value))) {
        throw new VerificationError(`The options of ${label} do not read back as set`, { expected: target.map((t) => t.value), actual: back });
      }
      return { dry_run: false, product: c.product, summary: req.summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { options: back, note: disabledNote(target) } };
    },
  },
];
