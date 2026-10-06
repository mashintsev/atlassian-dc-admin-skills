/**
 * Jira Software board configuration: one read that combines the public agile configuration
 * with the board's edit model, and changes of the board's Detail View fields.
 *
 * The edit model (`/rest/greenhopper/1.0/rapidviewconfig/editmodel`) and the Detail View
 * resource (`/rest/greenhopper/1.0/detailviewfield/{board}`) are Jira Software internal APIs,
 * verified on Jira 11.3.6, so changes are gated to verified versions. The Detail View tab is an
 * AJS.RestfulTable: rows are added with POST {fieldId}, removed with DELETE, and moved with
 * POST {row}/move and {"position": "First"} or {"after": "<absolute url of the previous row>"}.
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, PermissionError, ValidationError, VerificationError } from "../../errors.js";
import { requireJiraVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, listArg } from "../util.js";

const GH = "/rest/greenhopper/1.0";

async function settlePart<T>(p: Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await p };
  } catch (e) {
    if (isHttpStatusError(e)) return { error: `HTTP ${e.status}` };
    throw e;
  }
}

const num = (v: unknown) => (v === "" || v === null || v === undefined ? null : Number(v));

// -- Detail View ------------------------------------------------------------------

interface Row {
  id: number;
  fieldId: string;
  name: string;
}

interface DetailView {
  canEdit: boolean;
  rows: Row[];
  available: Array<{ fieldId: string; name: string }>;
}

async function readDetailView(client: AtlassianClient, board: number): Promise<DetailView> {
  const d: any = await client.get(`${GH}/detailviewfield/${board}/configured`);
  return {
    canEdit: !!d?.canEdit,
    rows: (d?.currentFields ?? []).map((f: any) => ({ id: Number(f.id), fieldId: String(f.fieldId), name: String(f.name) })),
    available: (d?.availableFields ?? []).map((f: any) => ({ fieldId: String(f.fieldId), name: String(f.name) })),
  };
}

/** Field ids for ids or exact names, among the board's current and available Detail View fields. */
function resolveDetailFields(view: DetailView, given: string[]): string[] {
  const known = [...view.rows, ...view.available];
  return given.map((g) => {
    const v = g.trim();
    const byName = [...new Map(known.filter((f) => f.name.toLowerCase() === v.toLowerCase()).map((f) => [f.fieldId, f])).values()];
    if (!known.some((f) => f.fieldId === v) && byName.length > 1) {
      throw new ValidationError(`Field name '${v}' is ambiguous in the Detail View: ${byName.map((f) => `${f.fieldId} (${f.name})`).join(", ")}; pass the id`);
    }
    const hit = known.find((f) => f.fieldId === v) ?? byName[0];
    if (!hit) throw new ValidationError(`'${v}' is not a field the board's Detail View can show (not in its available fields)`);
    return hit.fieldId;
  });
}

const rowUrl = (client: AtlassianClient, board: number, id: number) => client.url(`${GH}/detailviewfield/${board}/field/${id}`);

/** Moves that turn `current` into `target` (both field id lists with the same members). */
function plannedMoves(current: string[], target: string[]): Array<{ fieldId: string; after: string | null }> {
  const sim = [...current];
  const moves: Array<{ fieldId: string; after: string | null }> = [];
  target.forEach((fieldId, i) => {
    if (sim[i] === fieldId) return;
    sim.splice(sim.indexOf(fieldId), 1);
    sim.splice(i, 0, fieldId);
    moves.push({ fieldId, after: i === 0 ? null : target[i - 1] });
  });
  return moves;
}

async function changeDetailView(
  client: AtlassianClient,
  board: number,
  dryRun: boolean,
  /** target order, plus what the change depends on: identity (the request) and state (drift check) */
  plan: (view: DetailView) => { target: string[]; identity: Record<string, unknown>; state: unknown },
) {
  await requireJiraVersion(client, "Board Detail View changes");
  const view = await readDetailView(client, board);
  if (!view.canEdit) throw new PermissionError(`This account cannot edit board ${board} (not a board administrator)`);
  const current = view.rows.map((r) => r.fieldId);
  const { target, identity, state } = plan(view);
  if (new Set(target).size !== target.length) throw new ValidationError("A field appears more than once in the target list");
  const nameOf = (id: string) => [...view.rows, ...view.available].find((f) => f.fieldId === id)?.name ?? id;
  const summary = `Detail View of board ${board}: ${current.map(nameOf).join(", ")} → ${target.map(nameOf).join(", ")}`;
  if (JSON.stringify(current) === JSON.stringify(target)) return alreadySatisfied(`Detail View of board ${board}`, "the Detail View already shows these fields in this order");

  const removed = view.rows.filter((r) => !target.includes(r.fieldId));
  const added = target.filter((id) => !current.includes(id));
  const afterAdd = [...current.filter((id) => target.includes(id)), ...added];
  const moves = plannedMoves(afterAdd, target);
  const steps = [
    ...removed.map((r) => ({ method: "DELETE", url: rowUrl(client, board, r.id), label: `remove ${r.name}` })),
    ...added.map((id) => ({ method: "POST", url: client.url(`${GH}/detailviewfield/${board}/field`), body: { fieldId: id }, label: `add ${nameOf(id)}` })),
    ...moves.map((m) => ({ method: "POST", url: `${client.url(`${GH}/detailviewfield/${board}/field`)}/{${m.fieldId}}/move`, body: m.after ? { after: `{${m.after}}` } : { position: "First" }, label: `move ${nameOf(m.fieldId)} ${m.after ? `after ${nameOf(m.after)}` : "first"}` })),
  ];
  if (dryRun) {
    return {
      dry_run: true,
      product: client.product,
      summary,
      request: steps[0],
      followUps: steps.slice(1),
      before: current.map(nameOf),
      after: target.map(nameOf),
      identity: { ...identity, board },
      state,
      note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
    };
  }

  for (const r of removed) await client.request("DELETE", `${GH}/detailviewfield/${board}/field/${r.id}`);
  for (const id of added) await client.request("POST", `${GH}/detailviewfield/${board}/field`, { json: { fieldId: id } });
  // new rows get their ids only now: compute the moves from a fresh read
  let rows = (await readDetailView(client, board)).rows;
  for (const m of plannedMoves(rows.map((r) => r.fieldId), target)) {
    const row = rows.find((r) => r.fieldId === m.fieldId);
    const after = m.after ? rows.find((r) => r.fieldId === m.after) : undefined;
    if (!row || (m.after && !after)) break;
    await client.request("POST", `${GH}/detailviewfield/${board}/field/${row.id}/move`, { json: after ? { after: rowUrl(client, board, after.id) } : { position: "First" } });
    rows = (await readDetailView(client, board)).rows;
  }
  const final = (await readDetailView(client, board)).rows;
  const actual = final.map((r) => r.fieldId);
  if (JSON.stringify(actual) !== JSON.stringify(target)) {
    throw new VerificationError(`The Detail View of board ${board} does not show the intended fields after the change`, { expected: target, actual });
  }
  return { dry_run: false, product: client.product, summary, request: steps[0], result: { detailView: final.map((r) => ({ fieldId: r.fieldId, name: r.name })) } };
}

const boardShape = { board_id: z.coerce.number().int() };
const fieldArg = z.coerce.string().min(1).describe("Field id or exact name as the Detail View lists it");

export const jiraBoardConfigTools: ToolDef[] = [
  {
    name: "jira_get_board_configuration",
    product: "jira",
    description:
      "A Jira Software board's configuration: saved filter (name, JQL), columns with their statuses, unmapped statuses, " +
      "quick filters, card layout, Detail View fields in order, estimation, sub-filter, swimlanes, administrators and " +
      "whether this account can edit it. Parts that cannot be read are listed under `unavailable`. Uses the internal " +
      "board edit model (verified on Jira 11.3) besides the public agile API.",
    inputShape: boardShape,
    async handler({ client }, args) {
      const c = client("jira");
      const [agile, model] = await Promise.all([
        settlePart(c.get(`/rest/agile/1.0/board/${args.board_id}/configuration`)),
        settlePart(c.get(`${GH}/rapidviewconfig/editmodel`, { rapidViewId: args.board_id })),
      ]);
      const a: any = agile.value;
      const m: any = model.value;
      const unavailable: Record<string, string> = {};
      if (!m) for (const part of ["filterJql", "quickFilters", "cardLayout", "detailView", "subFilter", "administrators", "swimlanes", "canEdit"]) unavailable[part] = `board edit model: ${model.error}`;
      if (!a && !m) throw new ValidationError(`Board ${args.board_id} cannot be read: agile ${agile.error}, edit model ${model.error}`);

      const columns = m?.rapidListConfig?.mappedColumns
        ? m.rapidListConfig.mappedColumns.map((col: any) => ({ name: col.name, statuses: (col.mappedStatuses ?? []).map((s: any) => s.name), min: num(col.min), max: num(col.max) }))
        : (a?.columnConfig?.columns ?? []).map((col: any) => ({ name: col.name, statuses: (col.statuses ?? []).map((s: any) => s.id), min: num(col.min), max: num(col.max) }));
      const est = m?.estimationStatisticConfig?.currentEstimationStatistic;
      return {
        board: { id: args.board_id, name: m?.name ?? a?.name, type: a?.type },
        canEdit: m ? !!m.canEdit : undefined,
        filter: m?.filterConfig
          ? { id: m.filterConfig.id, name: m.filterConfig.name, jql: m.filterConfig.query, owner: m.filterConfig.owner?.userName }
          : { id: Number(a?.filter?.id) },
        subFilter: m ? (m.subqueryConfig?.subqueries ?? []).map((s: any) => s.query).join(" AND ") || null : undefined,
        columns,
        constraint: a?.columnConfig?.constraintType,
        unmappedStatuses: m ? (m.rapidListConfig?.unmappedStatuses ?? []).map((s: any) => s.name) : undefined,
        quickFilters: m ? (m.quickFilterConfig?.quickFilters ?? []).map((q: any) => ({ id: q.id, name: q.name, query: q.query })) : undefined,
        swimlanes: m ? { strategy: m.swimlanesConfig?.swimlaneStrategy, lanes: (m.swimlanesConfig?.swimlanes ?? []).map((l: any) => l.name) } : undefined,
        cardLayout: m ? (m.cardLayoutConfig?.currentFields ?? []).map((f: any) => f.name) : undefined,
        detailView: m ? (m.detailViewFieldConfig?.currentFields ?? []).map((f: any) => ({ fieldId: f.fieldId, name: f.name })) : undefined,
        estimation: est
          ? { field: est.fieldId ?? est.id, name: est.name, tracking: m.estimationStatisticConfig?.currentTrackingStatistic?.name }
          : a?.estimation ? { field: a.estimation.field?.fieldId, name: a.estimation.field?.displayName } : undefined,
        administrators: m
          ? { users: (m.boardAdmins?.userKeys ?? []).map((u: any) => u.displayName ?? u.key), groups: (m.boardAdmins?.groupKeys ?? []).map((g: any) => g.displayName ?? g.key) }
          : undefined,
        unavailable: Object.keys(unavailable).length ? unavailable : undefined,
      };
    },
  },
  {
    name: "jira_set_board_detail_fields",
    product: "jira",
    write: true,
    description:
      "Change a board's Detail View fields: `fields` = the complete target list in order, or add_fields / remove_fields " +
      "(fields not named keep their place and order; added ones go last). Fields are ids or exact names the Detail View " +
      "offers. Needs board admin rights; internal Jira Software API, Jira 11.3.x only. The Detail View is read back after the change.",
    inputShape: {
      ...boardShape,
      fields: listArg.optional().describe("Complete ordered target list"),
      add_fields: listArg.optional(),
      remove_fields: listArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const partial = !!(args.add_fields?.length || args.remove_fields?.length);
      if (args.fields?.length && partial) throw new ValidationError("Pass either fields or add_fields/remove_fields");
      if (!args.fields?.length && !partial) throw new ValidationError("Pass fields, or add_fields and/or remove_fields");
      return changeDetailView(client("jira"), args.board_id, args.dry_run !== false, (view) => {
        const current = view.rows.map((r) => r.fieldId);
        if (args.fields?.length) {
          // an absolute list: any other change of the Detail View changes what this does
          const target = resolveDetailFields(view, args.fields);
          return { target, identity: { op: "detail-view-set", target }, state: current };
        }
        const remove = resolveDetailFields(view, args.remove_fields ?? []);
        const add = resolveDetailFields(view, args.add_fields ?? []);
        const kept = current.filter((id) => !remove.includes(id));
        const named = [...remove, ...add];
        return {
          target: [...kept, ...add.filter((id) => !kept.includes(id))],
          identity: { op: "detail-view-edit", add, remove },
          state: Object.fromEntries(named.map((id) => [id, current.includes(id)])),
        };
      });
    },
  },
  {
    name: "jira_add_board_detail_field",
    product: "jira",
    write: true,
    description: "Add one field to the end of a board's Detail View (already shown → already-satisfied). Board admin; Jira 11.3.x only.",
    inputShape: { ...boardShape, field: fieldArg, ...dryRunShape },
    async handler({ client }, args) {
      return changeDetailView(client("jira"), args.board_id, args.dry_run !== false, (view) => {
        const [id] = resolveDetailFields(view, [args.field]);
        const current = view.rows.map((r) => r.fieldId);
        return { target: current.includes(id) ? current : [...current, id], identity: { op: "detail-view-add", field: id }, state: { present: current.includes(id) } };
      });
    },
  },
  {
    name: "jira_remove_board_detail_field",
    product: "jira",
    write: true,
    description: "Remove one field from a board's Detail View; other fields keep their order (not shown → already-satisfied). Board admin; Jira 11.3.x only.",
    inputShape: { ...boardShape, field: fieldArg, ...dryRunShape },
    async handler({ client }, args) {
      return changeDetailView(client("jira"), args.board_id, args.dry_run !== false, (view) => {
        const [id] = resolveDetailFields(view, [args.field]);
        const current = view.rows.map((r) => r.fieldId);
        return { target: current.filter((x) => x !== id), identity: { op: "detail-view-remove", field: id }, state: { present: current.includes(id) } };
      });
    },
  },
];
