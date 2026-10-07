/**
 * Jira Service Management request types: create, change, hide and delete them, arrange them
 * in portal groups, and shape their forms.
 *
 * Request types themselves use the public `/rest/servicedeskapi`; groups, hidden request
 * types and forms use JSM's internal `/rest/servicedesk/1` resources (verified on JSM
 * 11.3.5 / Jira 11.3.6), so those writes are gated to verified JSM versions.
 */

import { z } from "zod";
import { seg as segment, type AtlassianClient } from "../../client.js";
import { ValidationError, VerificationError as Verification } from "../../errors.js";
import { requireJsmVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite } from "../util.js";
import { findInPages, OPT_IN, SD, sdGet } from "./servicedesk.js";

export interface ServiceDesk {
  id: string;
  projectId: string;
  projectKey: string;
  name: string;
}

/** A service desk by its id or its project key. */
export async function resolveServiceDesk(client: AtlassianClient, given: string | number): Promise<ServiceDesk> {
  const value = String(given).trim();
  const hit = /^\d+$/.test(value)
    ? await sdGet(client, `/servicedesk/${value}`)
    : await findInPages(client, "/servicedesk", (d: any) => String(d.projectKey).toLowerCase() === value.toLowerCase());
  if (!hit) throw new ValidationError(`No service desk for '${value}' (pass a service desk id or its project key)`);
  return { id: String(hit.id), projectId: String(hit.projectId), projectKey: String(hit.projectKey), name: String(hit.projectName ?? hit.projectKey) };
}

export interface RequestTypeRef {
  id?: string;
  name: string;
  issueTypeId?: string;
  /** How the request type appears in a plan's identity: the id, or {requestType: name} when given by name. */
  ref: string | { requestType: string };
  pending?: boolean;
  raw?: any;
}

/** All request types of a service desk (public listing, paged). */
export async function listRequestTypes(client: AtlassianClient, sd: ServiceDesk): Promise<any[]> {
  const out: any[] = [];
  for (let start = 0; out.length < 1000; ) {
    const data = await sdGet(client, `/servicedesk/${sd.id}/requesttype`, { start, limit: 50 });
    const values: any[] = data?.values ?? [];
    out.push(...values);
    if (!values.length || data?.isLastPage !== false) break;
    start += values.length;
  }
  return out;
}

/**
 * A request type by id or exact name (case-insensitive) within a service desk. With
 * allowPending (dry runs only) an unknown name yields a pending reference, so a plan can
 * create a request type and then arrange it.
 */
export async function resolveRequestType(
  client: AtlassianClient,
  sd: ServiceDesk,
  given: string | number,
  opts: { allowPending?: boolean; types?: any[] } = {},
): Promise<RequestTypeRef> {
  const value = String(given).trim();
  const types = opts.types ?? (await listRequestTypes(client, sd));
  const describe = (t: any, ref: RequestTypeRef["ref"]): RequestTypeRef => ({ id: String(t.id), name: String(t.name), issueTypeId: t.issueTypeId !== undefined ? String(t.issueTypeId) : undefined, ref, raw: t });
  const byId = types.find((t) => String(t.id) === value);
  if (byId) return describe(byId, value);
  const byName = types.filter((t) => String(t.name).toLowerCase() === value.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`Request type name '${value}' is ambiguous in ${sd.projectKey}: ${byName.map((t) => `${t.id} (${t.name})`).join(", ")}; pass the id`);
  if (byName.length === 1) return describe(byName[0], { requestType: value });
  if (opts.allowPending) return { name: value, ref: { requestType: value }, pending: true };
  throw new ValidationError(`Request type '${value}' not found in ${sd.projectKey}`);
}

// -- internal model, groups -------------------------------------------------------------

const IJ = "/rest/servicedesk/1/servicedesk";

interface Group {
  id: string;
  name: string;
}

async function portalGroups(client: AtlassianClient, sd: ServiceDesk): Promise<Group[]> {
  const data: any = await client.get(`${IJ}/${sd.projectId}/request-type-groups`);
  return (Array.isArray(data) ? data : []).map((g: any) => ({ id: String(g.id), name: String(g.name) }));
}

function pickGroup(groups: Group[], given: string | number): Group {
  const value = String(given).trim();
  const byId = groups.find((g) => g.id === value);
  if (byId) return byId;
  const byName = groups.filter((g) => g.name.toLowerCase() === value.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`Group name '${value}' is ambiguous; pass the id`);
  if (!byName.length) throw new ValidationError(`No portal group '${value}'; groups: ${groups.map((g) => `${g.id} (${g.name})`).join(", ")}`);
  return byName[0];
}

/** The internal request type model, read through one of its groups (or the hidden list). */
async function readModel(client: AtlassianClient, sd: ServiceDesk, rt: RequestTypeRef): Promise<{ model: any; via: string }> {
  const via = rt.raw?.groupIds?.[0] !== undefined ? String(rt.raw.groupIds[0]) : "hidden";
  const model = await client.get(`${IJ}/${sd.projectId}/request-type-groups/${via}/request-types/${rt.id}`);
  return { model, via };
}

const modelPath = (sd: ServiceDesk, group: string, id: string | number) => `${IJ}/${sd.projectId}/request-type-groups/${group}/request-types/${id}`;

async function groupOrder(client: AtlassianClient, sd: ServiceDesk, g: Group): Promise<string[]> {
  const data: any = await client.get(`${IJ}/${sd.projectId}/request-type-groups/${g.id}/request-types`);
  return (Array.isArray(data) ? data : []).map((t: any) => String(t.id));
}

/** Where a 1-based position or an `after` item puts `id` in `list`, and the item it then follows. */
function placement(list: string[], id: string, position?: number, after?: string): { desired: string[]; anchor: string } {
  const rest = list.filter((x) => x !== id);
  let i: number;
  if (after !== undefined) {
    if (!rest.includes(after)) throw new ValidationError(`'${after}' is not in this list`);
    i = rest.indexOf(after) + 1;
  } else {
    i = position === undefined ? rest.length : Math.min(Math.max(position, 1) - 1, rest.length);
  }
  const desired = [...rest.slice(0, i), id, ...rest.slice(i)];
  return { desired, anchor: i === 0 ? "first" : desired[i - 1] };
}

function moveBody(client: AtlassianClient, rowUrl: (id: string) => string, desired: string[], id: string) {
  const i = desired.indexOf(id);
  return i === 0 ? { position: "First" } : { after: client.url(rowUrl(desired[i - 1])) };
}

/** Stored state only drives drift detection for items given by id (names may refer to objects made earlier in the plan). */
const byIdState = (ref: unknown, state: unknown) => (typeof ref === "string" ? state : undefined);

async function projectIssueTypes(client: AtlassianClient, sd: ServiceDesk): Promise<Array<{ id: string; name: string }>> {
  const p: any = await client.get(`/rest/api/2/project/${segment(sd.projectKey)}`);
  return (p?.issueTypes ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name) }));
}

function pickIssueType(types: Array<{ id: string; name: string }>, given: string | number): { id: string; name: string } {
  const value = String(given).trim();
  const hit = types.find((t) => t.id === value) ?? types.find((t) => t.name.toLowerCase() === value.toLowerCase());
  if (!hit) throw new ValidationError(`'${value}' is not an issue type of this project; issue types: ${types.map((t) => `${t.name} (${t.id})`).join(", ")}`);
  return hit;
}

const sdArg = z.coerce.string().min(1).describe("Service desk id or project key");
const rtArg = z.coerce.string().min(1).describe("Request type id or exact name (also of one created earlier in the same plan)");
const groupArg = z.coerce.string().min(1).describe("Portal group id or exact name");

interface WriteStep {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  json?: unknown;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  label?: string;
}

/** Dry run or execution of several steps, then a read-back check. */
async function steps(
  client: AtlassianClient,
  dryRun: boolean,
  summary: string,
  list: WriteStep[],
  extra: Record<string, unknown>,
  verify: () => Promise<{ ok: boolean; result: unknown }>,
) {
  // never echo Jira's XSRF token
  const shown = (p?: Record<string, string>) => (p?.atl_token ? { ...p, atl_token: "***" } : p);
  const described = list.map((s) => ({ method: s.method, url: client.url(s.path, shown(s.params)), body: s.json, label: s.label }));
  if (dryRun) {
    return { dry_run: true, product: client.product, summary, request: described[0], followUps: described.slice(1), ...extra, note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false." };
  }
  for (const s of list) await client.request(s.method, s.path, { json: s.json, params: s.params, headers: s.headers });
  const check = await verify();
  if (!check.ok) throw new Verification(`${summary}: the read-back does not show the change`, check.result);
  return { dry_run: false, product: client.product, summary, request: described[0], result: check.result };
}

// -- form ------------------------------------------------------------------------------------

interface FormRow {
  id: number;
  fieldId: string;
  name: string;
  label: string;
  description: string;
  sdRequired: boolean;
  jiraRequired: boolean;
  values: Record<string, string[]>;
}

// unused rows carry the field name only in `label` (jiraName is empty)
const toRow = (r: any): FormRow => ({
  id: Number(r.id), fieldId: String(r.fieldId), name: String(r.jiraName || r.label || r.fieldId), label: String(r.label ?? ""),
  description: String(r.description ?? ""), sdRequired: !!r.sdRequired, jiraRequired: !!r.jiraRequired, values: r.values ?? {},
});

async function readForm(client: AtlassianClient, rtId: string): Promise<{ visible: FormRow[]; hidden: FormRow[]; unused: FormRow[] }> {
  const [visible, hidden, unused] = await Promise.all(
    ["visible", "hidden", "unused"].map((k) => client.get(`${IJ}/${rtId}/request-type-fields/${k}`)),
  );
  const rows = (v: any): FormRow[] => (Array.isArray(v) ? v : []).map(toRow);
  return { visible: rows(visible), hidden: rows(hidden), unused: rows(unused) };
}

function findField(rows: FormRow[], given: string): FormRow | undefined {
  const v = given.trim().toLowerCase();
  const byId = rows.find((r) => r.fieldId.toLowerCase() === v);
  if (byId) return byId;
  const byName = rows.filter((r) => r.name.toLowerCase() === v || r.label.toLowerCase() === v);
  if (byName.length > 1) throw new ValidationError(`Field name '${given}' is ambiguous on this form; pass the field id`);
  return byName[0];
}

const fieldRowPath = (rtId: string, kind: "visible" | "hidden", id: number | string) => `${IJ}/${rtId}/request-type-fields/${kind}/${id}`;

async function formContext(client: AtlassianClient, args: { service_desk: string; request_type: string; dry_run?: boolean }) {
  await requireJsmVersion(client, "Request type form changes");
  const sd = await resolveServiceDesk(client, args.service_desk);
  const rt = await resolveRequestType(client, sd, args.request_type);
  const form = await readForm(client, rt.id!);
  return { sd, rt, form, dryRun: args.dry_run !== false, where: `form of '${rt.name}' (${sd.projectKey})` };
}

const order = (rows: FormRow[]) => rows.map((r) => r.fieldId);

export const jiraRequestTypeTools: ToolDef[] = [
  {
    name: "jira_create_request_type",
    product: "jira",
    write: true,
    description:
      "Create a JSM request type for an issue type (id or name). Same name and issue type → already-satisfied; same " +
      "name with another issue type → error. New request types are not in a portal group (hidden) until added to one.",
    inputShape: { service_desk: sdArg, name: z.string().trim().min(1), issue_type: z.coerce.string().min(1), description: z.string().optional(), help_text: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const [types, its] = await Promise.all([listRequestTypes(c, sd), projectIssueTypes(c, sd)]);
      const it = pickIssueType(its, args.issue_type);
      const same = types.find((t) => String(t.name).toLowerCase() === args.name.toLowerCase());
      const summary = `Create request type '${args.name}' (${it.name}) in ${sd.projectKey}`;
      if (same && String(same.issueTypeId) === it.id) return alreadySatisfied(summary, `request type ${same.id} '${same.name}' exists with issue type ${it.name}`, { requestTypeId: String(same.id) });
      if (same) throw new ValidationError(`Request type ${same.id} '${same.name}' already exists with issue type ${its.find((t) => t.id === String(same.issueTypeId))?.name ?? same.issueTypeId}`);
      const req = { method: "POST" as const, path: `${SD}/servicedesk/${sd.id}/requesttype`, json: { issueTypeId: it.id, name: args.name, description: args.description ?? "", helpText: args.help_text ?? "" }, headers: OPT_IN, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "create-request-type", sd: sd.id, name: args.name, issueType: it.id } };
      await c.request("POST", req.path, { json: req.json, headers: OPT_IN });
      const back = (await listRequestTypes(c, sd)).find((t) => String(t.name) === args.name);
      if (!back) throw new Verification(`${summary}: the request type is not listed after creation`);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: String(back.id), name: back.name, issueTypeId: String(back.issueTypeId) } };
    },
  },
  {
    name: "jira_update_request_type",
    product: "jira",
    write: true,
    description: "Change a request type's name, description, help text and/or issue type. Internal JSM API, JSM 11.3.x only; read back after the change.",
    inputShape: { service_desk: sdArg, request_type: rtArg, name: z.string().trim().min(1).optional(), description: z.string().optional(), help_text: z.string().optional(), issue_type: z.coerce.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "Request type changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const rt = await resolveRequestType(c, sd, args.request_type);
      const { model, via } = await readModel(c, sd, rt);
      const it = args.issue_type !== undefined ? pickIssueType(await projectIssueTypes(c, sd), args.issue_type) : undefined;
      const changes: Record<string, unknown> = {};
      if (args.name !== undefined && args.name !== model.name) changes.name = args.name;
      if (args.description !== undefined && args.description !== (model.description ?? "")) changes.description = args.description;
      if (it && String(model.issueType?.id) !== it.id) changes.issueType = it.id;
      const helpChange = args.help_text !== undefined && args.help_text !== (model.helpText ?? "");
      const summary = `Update request type ${rt.id} '${model.name}' in ${sd.projectKey}: ${[...Object.keys(changes), ...(helpChange ? ["helpText"] : [])].join(", ") || "nothing"}`;
      if (!Object.keys(changes).length && !helpChange) return alreadySatisfied(`Update request type '${model.name}'`, "it already has these values");
      const list: WriteStep[] = [];
      if (Object.keys(changes).length) {
        const body = { ...model, ...(changes.name !== undefined ? { name: changes.name } : {}), ...(changes.description !== undefined ? { description: changes.description } : {}), ...(it && changes.issueType ? { issueType: { id: it.id, name: it.name } } : {}) };
        list.push({ method: "PUT", path: modelPath(sd, via, rt.id!), json: body, label: "request type" });
      }
      if (helpChange) list.push({ method: "PUT", path: `${IJ}/${sd.projectId}/request-type-groups/help-text/${rt.id}`, json: { helpText: args.help_text }, label: "help text" });
      return steps(c, args.dry_run !== false, summary, list, {
        identity: { op: "update-request-type", sd: sd.id, requestType: rt.ref, ...changes, ...(helpChange ? { helpText: args.help_text } : {}) },
        state: byIdState(rt.ref, { name: model.name, description: model.description, issueType: model.issueType?.id, helpText: model.helpText }),
      }, async () => {
        const back = (await readModel(c, sd, { ...rt, raw: { groupIds: (model.groups ?? []).map((g: any) => g.id) } })).model;
        const ok = (changes.name === undefined || back.name === changes.name) && (changes.description === undefined || back.description === changes.description)
          && (!changes.issueType || String(back.issueType?.id) === changes.issueType) && (!helpChange || back.helpText === args.help_text);
        return { ok, result: { id: back.id, name: back.name, description: back.description, issueType: back.issueType?.name, helpText: back.helpText } };
      });
    },
  },
  {
    name: "jira_delete_request_type",
    product: "jira",
    write: true,
    description: "Delete a request type (irreversible: requests created from it keep their issue type but lose the request type). Already gone → already-satisfied.",
    inputShape: { service_desk: sdArg, request_type: rtArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const rt = await resolveRequestType(c, sd, args.request_type, { allowPending: true });
      const summary = `Delete request type ${rt.id ?? ""} '${rt.name}' in ${sd.projectKey} — irreversible: existing requests lose their request type`;
      if (!rt.id) return alreadySatisfied(`Delete request type '${rt.name}'`, "no such request type");
      return guardedWrite(c, args, { method: "DELETE", path: `${SD}/servicedesk/${sd.id}/requesttype/${rt.id}`, headers: OPT_IN, summary });
    },
  },
  {
    name: "jira_set_request_type_hidden",
    product: "jira",
    write: true,
    description:
      "Hide a request type from the portal (hidden=true removes it from all portal groups) or show it (hidden=false, " +
      "needs group). Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, hidden: boolArg, group: groupArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "Request type portal changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const rt = await resolveRequestType(c, sd, args.request_type);
      const { model, via } = await readModel(c, sd, rt);
      const current: Group[] = (model.groups ?? []).map((g: any) => ({ id: String(g.id), name: g.name }));
      if (args.hidden) {
        if (!current.length) return alreadySatisfied(`Hide request type '${model.name}'`, "it is not in any portal group");
        return steps(c, args.dry_run !== false, `Hide request type '${model.name}' from the portal (remove it from ${current.map((g) => g.name).join(", ")})`,
          [{ method: "PUT", path: modelPath(sd, via, rt.id!), json: { ...model, groups: [] } }],
          { identity: { op: "hide-request-type", sd: sd.id, requestType: rt.ref }, state: { groups: current.map((g) => g.id) } },
          async () => { const back = (await readModel(c, sd, { ...rt, raw: { groupIds: [] } })).model; return { ok: !(back.groups ?? []).length, result: { groups: back.groups } }; });
      }
      if (current.length) return alreadySatisfied(`Show request type '${model.name}'`, `it is in ${current.map((g) => g.name).join(", ")}`);
      if (!args.group) throw new ValidationError("Showing a hidden request type means adding it to a portal group: pass group");
      const g = pickGroup(await portalGroups(c, sd), args.group);
      return steps(c, args.dry_run !== false, `Show request type '${model.name}' in portal group ${g.name}`,
        [{ method: "PUT", path: modelPath(sd, g.id, rt.id!), json: { ...model, groups: [{ id: Number(g.id), name: g.name }] } }],
        { identity: { op: "show-request-type", sd: sd.id, requestType: rt.ref, group: g.id }, state: { groups: [] } },
        async () => ({ ok: (await groupOrder(c, sd, g)).includes(rt.id!), result: { group: g.name } }));
    },
  },
  {
    name: "jira_add_request_type_to_group",
    product: "jira",
    write: true,
    description: "Add a request type to a portal group, optionally at a 1-based position. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, group: groupArg, position: z.coerce.number().int().min(1).optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "Request type portal changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const rt = await resolveRequestType(c, sd, args.request_type);
      const g = pickGroup(await portalGroups(c, sd), args.group);
      const [{ model, via }, members] = await Promise.all([readModel(c, sd, rt), groupOrder(c, sd, g)]);
      const present = members.includes(rt.id!);
      const { desired, anchor } = placement(members, rt.id!, args.position ?? (present ? members.indexOf(rt.id!) + 1 : undefined));
      const where = `portal group ${g.name}${args.position ? ` at position ${args.position}` : ""}`;
      if (present && JSON.stringify(desired) === JSON.stringify(members)) return alreadySatisfied(`Add '${model.name}' to ${where}`, "it is already there");
      const list: WriteStep[] = [];
      if (!present) list.push({ method: "PUT", path: modelPath(sd, via, rt.id!), json: { ...model, groups: [...(model.groups ?? []), { id: Number(g.id), name: g.name }] }, label: "add to group" });
      if (desired.indexOf(rt.id!) !== desired.length - 1 || present) {
        list.push({ method: "POST", path: `${modelPath(sd, g.id, rt.id!)}/move`, json: moveBody(c, (id) => modelPath(sd, g.id, id), desired, rt.id!), label: "position" });
      }
      return steps(c, args.dry_run !== false, `Add request type '${model.name}' to ${where}`, list,
        { identity: { op: "add-to-group", sd: sd.id, requestType: rt.ref, group: g.id, position: args.position ?? null }, state: { present, anchor: args.position ? anchor : null } },
        async () => { const back = await groupOrder(c, sd, g); return { ok: JSON.stringify(back) === JSON.stringify(desired), result: { group: g.name, order: back } }; });
    },
  },
  {
    name: "jira_remove_request_type_from_group",
    product: "jira",
    write: true,
    description: "Remove a request type from a portal group (no groups left → hidden from the portal). Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, group: groupArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "Request type portal changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const rt = await resolveRequestType(c, sd, args.request_type);
      const g = pickGroup(await portalGroups(c, sd), args.group);
      const { model } = await readModel(c, sd, rt);
      const groups = (model.groups ?? []).map((x: any) => String(x.id));
      if (!groups.includes(g.id)) return alreadySatisfied(`Remove '${model.name}' from portal group ${g.name}`, "it is not in that group");
      const last = groups.length === 1;
      const result = await steps(c, args.dry_run !== false, `Remove request type '${model.name}' from portal group ${g.name}`,
        [{ method: "DELETE", path: modelPath(sd, g.id, rt.id!) }],
        { identity: { op: "remove-from-group", sd: sd.id, requestType: rt.ref, group: g.id }, state: { present: true }, warning: last ? "it is in no other group, so it becomes hidden from the portal" : undefined },
        async () => ({ ok: !(await groupOrder(c, sd, g)).includes(rt.id!), result: { group: g.name } }));
      return result;
    },
  },
  {
    name: "jira_move_request_type_in_group",
    product: "jira",
    write: true,
    description: "Move a request type within a portal group to a 1-based position or right after another request type. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, group: groupArg, position: z.coerce.number().int().min(1).optional(), after: rtArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      if ((args.position === undefined) === (args.after === undefined)) throw new ValidationError("Pass exactly one of position or after");
      const c = client("jira");
      await requireJsmVersion(c, "Request type portal changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const types = await listRequestTypes(c, sd);
      const rt = await resolveRequestType(c, sd, args.request_type, { types });
      const after = args.after !== undefined ? await resolveRequestType(c, sd, args.after, { types }) : undefined;
      const g = pickGroup(await portalGroups(c, sd), args.group);
      const members = await groupOrder(c, sd, g);
      if (!members.includes(rt.id!)) throw new ValidationError(`'${rt.name}' is not in portal group ${g.name}`);
      const { desired, anchor } = placement(members, rt.id!, args.position, after?.id);
      const target = after ? `after '${after.name}'` : `position ${args.position}`;
      if (JSON.stringify(desired) === JSON.stringify(members)) return alreadySatisfied(`Move '${rt.name}' in ${g.name} to ${target}`, "it is already there");
      return steps(c, args.dry_run !== false, `Move request type '${rt.name}' in portal group ${g.name} to ${target}`,
        [{ method: "POST", path: `${modelPath(sd, g.id, rt.id!)}/move`, json: moveBody(c, (id) => modelPath(sd, g.id, id), desired, rt.id!) }],
        { identity: { op: "move-in-group", sd: sd.id, requestType: rt.ref, group: g.id, position: args.position ?? null, after: after?.ref ?? null }, state: { anchor: after ? null : anchor } },
        async () => { const back = await groupOrder(c, sd, g); return { ok: back.indexOf(rt.id!) === desired.indexOf(rt.id!) || (after ? back.indexOf(rt.id!) === back.indexOf(after.id!) + 1 : false), result: { group: g.name, order: back } }; });
    },
  },
  // -- form ----------------------------------------------------------------------------------
  {
    name: "jira_get_request_type_form",
    product: "jira",
    description: "A request type's form: visible fields in order (label, description, required) and hidden fields with their preset values; include_addable=true also lists the fields that can still be added. Internal JSM API.",
    inputShape: {
      service_desk: sdArg,
      request_type: rtArg,
      include_addable: boolArg.optional().describe("Default false: only count the fields that can be added (often hundreds)"),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const rt = await resolveRequestType(c, sd, args.request_type);
      const form = await readForm(c, rt.id!);
      return {
        requestType: { id: rt.id, name: rt.name },
        visible: form.visible.map((r) => ({ fieldId: r.fieldId, name: r.name, label: r.label, description: r.description || undefined, required: r.sdRequired || r.jiraRequired })),
        hidden: form.hidden.map((r) => ({ fieldId: r.fieldId, name: r.name, preset: r.values[r.fieldId] ?? [] })),
        ...(args.include_addable
          ? { addable: form.unused.map((r) => ({ fieldId: r.fieldId, name: r.name })) }
          : { addableCount: form.unused.length, hint: "include_addable=true lists the fields that can be added" }),
      };
    },
  },
  {
    name: "jira_add_request_type_field",
    product: "jira",
    write: true,
    description: "Add a field to a request type's form (optionally label, description, required, 1-based position). Already visible there → already-satisfied. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, field: z.coerce.string().min(1), label: z.string().optional(), description: z.string().optional(), required: boolArg.optional(), position: z.coerce.number().int().min(1).optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const { rt, form, dryRun, where } = await formContext(c, args as any);
      const rtId = rt.id!;
      const visible = findField(form.visible, args.field);
      const hidden = findField(form.hidden, args.field);
      if (hidden) throw new ValidationError(`${hidden.name} is a hidden field of this form; use jira_show_request_type_field`);
      const attrs: Record<string, unknown> = {};
      if (args.label !== undefined) attrs.label = args.label;
      if (args.description !== undefined) attrs.description = args.description;
      if (args.required !== undefined) attrs.sdRequired = args.required;
      const cur = order(form.visible);
      if (visible) {
        const { desired } = placement(cur, visible.fieldId, args.position ?? cur.indexOf(visible.fieldId) + 1);
        const same = Object.entries(attrs).every(([k, v]) => (visible as any)[k] === v) && JSON.stringify(desired) === JSON.stringify(cur);
        if (same) return alreadySatisfied(`Add ${visible.name} to the ${where}`, "it is already on the form with these settings");
        throw new ValidationError(`${visible.name} is already on the form; use jira_update_request_type_field or jira_move_request_type_field`);
      }
      const add = findField(form.unused, args.field);
      if (!add) throw new ValidationError(`'${args.field}' cannot be added to the ${where}; addable fields: ${form.unused.map((r) => r.name).join(", ")}`);
      const { desired, anchor } = placement(cur, add.fieldId, args.position);
      const list: WriteStep[] = [{ method: "POST", path: `${IJ}/${rtId}/request-type-fields`, json: { fields: [add.fieldId] }, label: `add ${add.name}` }];
      if (Object.keys(attrs).length) list.push({ method: "PUT", path: fieldRowPath(rtId, "visible", `{${add.fieldId}}`), json: attrs, label: "settings" });
      if (desired.indexOf(add.fieldId) !== desired.length - 1) list.push({ method: "POST", path: `${fieldRowPath(rtId, "visible", `{${add.fieldId}}`)}/move`, json: anchor === "first" ? { position: "First" } : { after: `{${anchor}}` }, label: "position" });
      const summary = `Add ${add.name} to the ${where}${args.position ? ` at position ${args.position}` : ""}`;
      const extra = { identity: { op: "add-form-field", requestType: rt.ref, field: add.fieldId, ...attrs, position: args.position ?? null }, state: { present: false, anchor: args.position ? anchor : null } };
      if (dryRun) return steps(c, true, summary, list, extra, async () => ({ ok: true, result: null }));
      // the new row's id is known only after adding it
      const rows: any[] = (await c.request("POST", list[0].path, { json: list[0].json })) as any[];
      const row = (rows ?? []).find((r) => r.fieldId === add.fieldId);
      if (!row) throw new Verification(`${summary}: Jira did not add the field`, rows);
      if (!row.displayed) throw new Verification(`${summary}: Jira added ${add.name} as a hidden field (the portal cannot show it)`, row);
      if (Object.keys(attrs).length) await c.request("PUT", fieldRowPath(rtId, "visible", row.id), { json: attrs });
      const now = order((await readForm(c, rtId)).visible);
      if (JSON.stringify(now) !== JSON.stringify(desired)) {
        const visibleRows = (await readForm(c, rtId)).visible;
        const idOf = (fid: string) => String(visibleRows.find((r) => r.fieldId === fid)!.id);
        const i = desired.indexOf(add.fieldId);
        await c.request("POST", `${fieldRowPath(rtId, "visible", row.id)}/move`, { json: i === 0 ? { position: "First" } : { after: c.url(fieldRowPath(rtId, "visible", idOf(desired[i - 1]))) } });
      }
      const back = await readForm(c, rtId);
      const added = back.visible.find((r) => r.fieldId === add.fieldId);
      const ok = !!added && JSON.stringify(order(back.visible)) === JSON.stringify(desired) && Object.entries(attrs).every(([k, v]) => (added as any)[k] === v);
      if (!ok) throw new Verification(`${summary}: the read-back does not show the change`, back.visible);
      return { dry_run: false, product: c.product, summary, request: { method: "POST", url: c.url(list[0].path), body: list[0].json }, result: { visible: back.visible.map((r) => r.fieldId) } };
    },
  },
  {
    name: "jira_remove_request_type_field",
    product: "jira",
    write: true,
    description: "Remove a field (visible or hidden) from a request type's form. Not on the form → already-satisfied. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, field: z.coerce.string().min(1), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const { rt, form, dryRun, where } = await formContext(c, args as any);
      const v = findField(form.visible, args.field);
      const h = v ? undefined : findField(form.hidden, args.field);
      const row = v ?? h;
      if (!row) return alreadySatisfied(`Remove ${args.field} from the ${where}`, "it is not on the form");
      return steps(c, dryRun, `Remove ${row.name} from the ${where}`,
        [{ method: "DELETE", path: fieldRowPath(rt.id!, v ? "visible" : "hidden", row.id) }],
        { identity: { op: "remove-form-field", requestType: rt.ref, field: row.fieldId }, state: { present: true } },
        async () => { const back = await readForm(c, rt.id!); return { ok: !back.visible.concat(back.hidden).some((r) => r.fieldId === row.fieldId), result: { visible: order(back.visible), hidden: order(back.hidden) } }; });
    },
  },
  {
    name: "jira_move_request_type_field",
    product: "jira",
    write: true,
    description: "Move a visible field of a request type's form to a 1-based position or right after another field. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, field: z.coerce.string().min(1), position: z.coerce.number().int().min(1).optional(), after: z.coerce.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      if ((args.position === undefined) === (args.after === undefined)) throw new ValidationError("Pass exactly one of position or after");
      const c = client("jira");
      const { rt, form, dryRun, where } = await formContext(c, args as any);
      const row = findField(form.visible, args.field);
      if (!row) throw new ValidationError(`${args.field} is not a visible field of the ${where}`);
      const after = args.after !== undefined ? findField(form.visible, args.after) : undefined;
      if (args.after !== undefined && !after) throw new ValidationError(`${args.after} is not a visible field of the ${where}`);
      const cur = order(form.visible);
      const { desired, anchor } = placement(cur, row.fieldId, args.position, after?.fieldId);
      const target = after ? `after ${after.name}` : `position ${args.position}`;
      if (JSON.stringify(desired) === JSON.stringify(cur)) return alreadySatisfied(`Move ${row.name} on the ${where} to ${target}`, "it is already there");
      const idOf = (fid: string) => String(form.visible.find((r) => r.fieldId === fid)!.id);
      return steps(c, dryRun, `Move ${row.name} on the ${where} to ${target}`,
        [{ method: "POST", path: `${fieldRowPath(rt.id!, "visible", row.id)}/move`, json: moveBody(c, (fid) => fieldRowPath(rt.id!, "visible", idOf(fid)), desired, row.fieldId) }],
        { identity: { op: "move-form-field", requestType: rt.ref, field: row.fieldId, position: args.position ?? null, after: after?.fieldId ?? null }, state: { anchor: after ? null : anchor } },
        async () => { const back = order((await readForm(c, rt.id!)).visible); return { ok: after ? back.indexOf(row.fieldId) === back.indexOf(after.fieldId) + 1 : back.indexOf(row.fieldId) === desired.indexOf(row.fieldId), result: { visible: back } }; });
    },
  },
  {
    name: "jira_update_request_type_field",
    product: "jira",
    write: true,
    description: "Change a visible form field's label, description and/or required flag. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, field: z.coerce.string().min(1), label: z.string().optional(), description: z.string().optional(), required: boolArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const { rt, form, dryRun, where } = await formContext(c, args as any);
      const row = findField(form.visible, args.field);
      if (!row) throw new ValidationError(`${args.field} is not a visible field of the ${where}`);
      const attrs: Record<string, unknown> = {};
      if (args.label !== undefined && args.label !== row.label) attrs.label = args.label;
      if (args.description !== undefined && args.description !== row.description) attrs.description = args.description;
      if (args.required !== undefined && args.required !== row.sdRequired) attrs.sdRequired = args.required;
      if (args.label === undefined && args.description === undefined && args.required === undefined) throw new ValidationError("Pass label, description and/or required");
      const summary = `Update ${row.name} on the ${where}: ${Object.keys(attrs).join(", ")}`;
      if (!Object.keys(attrs).length) return alreadySatisfied(`Update ${row.name} on the ${where}`, "it already has these values");
      return steps(c, dryRun, summary, [{ method: "PUT", path: fieldRowPath(rt.id!, "visible", row.id), json: attrs }],
        { identity: { op: "update-form-field", requestType: rt.ref, field: row.fieldId, ...attrs }, state: Object.fromEntries(Object.keys(attrs).map((k) => [k, (row as any)[k]])) },
        async () => { const back = findField((await readForm(c, rt.id!)).visible, row.fieldId); return { ok: !!back && Object.entries(attrs).every(([k, v]) => (back as any)[k] === v), result: back }; });
    },
  },
  {
    name: "jira_hide_request_type_field",
    product: "jira",
    write: true,
    description:
      "Hide a form field from customers, optionally with a preset value (preset = value or comma list). A field Jira " +
      "requires needs a preset. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, field: z.coerce.string().min(1), preset: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const { rt, form, dryRun, where } = await formContext(c, args as any);
      const preset = args.preset !== undefined ? String(args.preset).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined;
      const hiddenRow = findField(form.hidden, args.field);
      if (hiddenRow) {
        const stored = hiddenRow.values[hiddenRow.fieldId] ?? [];
        if (!preset || JSON.stringify(stored) === JSON.stringify(preset)) return alreadySatisfied(`Hide ${hiddenRow.name} on the ${where}`, "it is already hidden with this preset");
      }
      const row = hiddenRow ?? findField(form.visible, args.field);
      if (!row) throw new ValidationError(`${args.field} is not on the ${where}`);
      if (row.jiraRequired && !(preset?.length) && !(row.values[row.fieldId]?.length)) {
        throw new ValidationError(`${row.name} is required by Jira; hiding it needs a preset value, or creating requests fails`);
      }
      const token = preset ? await c.xsrfToken() : undefined;
      if (preset && !token) throw new ValidationError("Jira did not provide an XSRF token, which the preset call needs");
      const list: WriteStep[] = [];
      if (preset) {
        list.push({ method: "POST", path: `${IJ}/${rt.id}/request-type-fields/${row.id}/preset`, params: { atl_token: token! }, headers: { Cookie: `atlassian.xsrf.token=${token}` }, json: { values: { [row.fieldId]: preset } }, label: "preset" });
      }
      if (!hiddenRow) list.push({ method: "PUT", path: `${IJ}/${rt.id}/request-type-fields/${row.id}/hide`, label: "hide" });
      return steps(c, dryRun, `Hide ${row.name} on the ${where}${preset ? ` with preset ${preset.join(", ")}` : ""}`, list,
        { identity: { op: "hide-form-field", requestType: rt.ref, field: row.fieldId, preset: preset ?? null }, state: { hidden: !!hiddenRow } },
        async () => { const back = findField((await readForm(c, rt.id!)).hidden, row.fieldId); return { ok: !!back && (!preset || JSON.stringify(back.values[row.fieldId] ?? []) === JSON.stringify(preset)), result: back }; });
    },
  },
  {
    name: "jira_show_request_type_field",
    product: "jira",
    write: true,
    description: "Show a hidden form field to customers again. Already visible → already-satisfied. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, request_type: rtArg, field: z.coerce.string().min(1), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const { rt, form, dryRun, where } = await formContext(c, args as any);
      if (findField(form.visible, args.field)) return alreadySatisfied(`Show ${args.field} on the ${where}`, "it is already visible");
      const row = findField(form.hidden, args.field);
      if (!row) throw new ValidationError(`${args.field} is not on the ${where}`);
      return steps(c, dryRun, `Show ${row.name} on the ${where}`, [{ method: "PUT", path: `${IJ}/${rt.id}/request-type-fields/${row.id}/show` }],
        { identity: { op: "show-form-field", requestType: rt.ref, field: row.fieldId }, state: { hidden: true } },
        async () => ({ ok: !!findField((await readForm(c, rt.id!)).visible, row.fieldId), result: { visible: order((await readForm(c, rt.id!)).visible) } }));
    },
  },
];
