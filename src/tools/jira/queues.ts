/**
 * Jira Service Management queues: create, change, delete and order them.
 *
 * Create, change and delete use the public Service Desk API
 * (`/rest/servicedeskapi/servicedesk/{id}/queue[/{queueId}]`, `{name, jql, fields}` as the
 * queue reads back). Columns are field ids or exact field names.
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, guardedWrite, listArg } from "../util.js";
import { resolveServiceDesk, type ServiceDesk } from "./requestTypes.js";
import { OPT_IN, SD, sdGet } from "./servicedesk.js";

export async function listQueues(client: AtlassianClient, sd: ServiceDesk): Promise<any[]> {
  const out: any[] = [];
  for (let start = 0; out.length < 500; ) {
    const data = await sdGet(client, `/servicedesk/${sd.id}/queue`, { start, limit: 50 });
    const values: any[] = data?.values ?? [];
    out.push(...values);
    if (!values.length || data?.isLastPage !== false) break;
    start += values.length;
  }
  return out;
}

export function pickQueue(queues: any[], given: string) {
  const v = String(given).trim();
  const byId = queues.find((q) => String(q.id) === v);
  if (byId) return byId;
  const byName = queues.filter((q) => String(q.name).toLowerCase() === v.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`Queue name '${v}' is ambiguous; pass the id`);
  return byName[0];
}

/** Column field ids for ids or exact names (case-insensitive). */
async function resolveColumns(client: AtlassianClient, given: string[]): Promise<string[]> {
  const fields: any[] = ((await client.get("/rest/api/2/field")) as any[]) ?? [];
  return given.map((g) => {
    const v = g.trim();
    const hit = fields.find((f) => f.id === v) ?? fields.find((f) => String(f.name).toLowerCase() === v.toLowerCase());
    if (!hit) throw new ValidationError(`Column '${v}' is not a field`);
    return String(hit.id);
  });
}

const sdArg = z.coerce.string().min(1).describe("Service desk id or project key");
const queueArg = z.coerce.string().min(1).describe("Queue id or exact name");
const columnsArg = listArg.describe("Columns in order: field ids or exact names, comma-separated");

const view = (q: any) => ({ name: q.name, jql: q.jql, fields: q.fields ?? [] });
const same = (a: any, b: any) => JSON.stringify(view(a)) === JSON.stringify(view(b));

export const jiraQueueTools: ToolDef[] = [
  {
    name: "jira_create_queue",
    product: "jira",
    write: true,
    description: "Create a service desk queue with JQL and ordered columns. Same name and settings → already-satisfied; same name otherwise → error.",
    inputShape: { service_desk: sdArg, name: z.string().trim().min(1), jql: z.string().trim().min(1), columns: columnsArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const [queues, fields] = await Promise.all([listQueues(c, sd), resolveColumns(c, args.columns)]);
      const body = { name: args.name, jql: args.jql, fields };
      const summary = `Create queue '${args.name}' in ${sd.projectKey}`;
      const existing = queues.find((q) => String(q.name).toLowerCase() === args.name.toLowerCase());
      if (existing && same(existing, body)) return alreadySatisfied(summary, `queue ${existing.id} already has this JQL and these columns`);
      if (existing) throw new ValidationError(`Queue ${existing.id} '${existing.name}' already exists with other settings; use jira_update_queue`);
      const req = { method: "POST" as const, path: `${SD}/servicedesk/${sd.id}/queue`, json: body, headers: OPT_IN, summary };
      if (args.dry_run !== false) return guardedWrite(c, args, req);
      await c.request("POST", req.path, { json: body, headers: OPT_IN });
      const back = (await listQueues(c, sd)).find((q) => q.name === args.name);
      if (!back || !same(back, body)) throw new VerificationError(`${summary}: the queue does not read back as created`, back);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: back.id, ...view(back) } };
    },
  },
  {
    name: "jira_update_queue",
    product: "jira",
    write: true,
    description: "Change a queue's name, JQL and/or columns. The dry run shows old and new values.",
    inputShape: { service_desk: sdArg, queue: queueArg, name: z.string().trim().min(1).optional(), jql: z.string().trim().min(1).optional(), columns: columnsArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const q = pickQueue(await listQueues(c, sd), args.queue);
      if (!q) throw new ValidationError(`No queue '${args.queue}' in ${sd.projectKey}`);
      const body = { name: args.name ?? q.name, jql: args.jql ?? q.jql, fields: args.columns ? await resolveColumns(c, args.columns) : (q.fields ?? []) };
      const summary = `Update queue ${q.id} '${q.name}' in ${sd.projectKey}`;
      if (same(q, body)) return alreadySatisfied(summary, "it already has these settings");
      const req = { method: "POST" as const, path: `${SD}/servicedesk/${sd.id}/queue/${q.id}`, json: body, headers: OPT_IN, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), before: view(q), after: body, identity: { op: "update-queue", sd: sd.id, queue: args.queue, ...body }, state: view(q) };
      await c.request("POST", req.path, { json: body, headers: OPT_IN });
      const back = await sdGet(c, `/servicedesk/${sd.id}/queue/${q.id}`);
      if (!same(back, body)) throw new VerificationError(`${summary}: the queue does not read back as updated`, back);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: back.id, ...view(back) } };
    },
  },
  {
    name: "jira_delete_queue",
    product: "jira",
    write: true,
    description: "Delete a queue. Already gone → already-satisfied.",
    inputShape: { service_desk: sdArg, queue: queueArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const q = pickQueue(await listQueues(c, sd), args.queue);
      if (!q) return alreadySatisfied(`Delete queue '${args.queue}'`, "no such queue");
      return guardedWrite(c, args, { method: "DELETE", path: `${SD}/servicedesk/${sd.id}/queue/${q.id}`, headers: OPT_IN, summary: `Delete queue ${q.id} '${q.name}' in ${sd.projectKey}` });
    },
  },
  {
    name: "jira_move_queue",
    product: "jira",
    write: true,
    description:
      "Move a queue to a 1-based position or right after another queue. Sends the full order of queue ids to " +
      "POST …/queue/reorder and reads the order back.",
    inputShape: { service_desk: sdArg, queue: queueArg, position: z.coerce.number().int().min(1).optional(), after: queueArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      if ((args.position === undefined) === (args.after === undefined)) throw new ValidationError("Pass exactly one of position or after");
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const queues = await listQueues(c, sd);
      const q = pickQueue(queues, args.queue);
      if (!q) throw new ValidationError(`No queue '${args.queue}' in ${sd.projectKey}`);
      const after = args.after !== undefined ? pickQueue(queues, args.after) : undefined;
      if (args.after !== undefined && !after) throw new ValidationError(`No queue '${args.after}' in ${sd.projectKey}`);
      if (after && after.id === q.id) throw new ValidationError("after is the queue itself");
      const order = queues.map((x) => String(x.id));
      const rest = order.filter((id) => id !== String(q.id));
      const i = after ? rest.indexOf(String(after.id)) + 1 : Math.min(args.position - 1, rest.length);
      const desired = [...rest.slice(0, i), String(q.id), ...rest.slice(i)];
      const nameOf = (id: string) => queues.find((x) => String(x.id) === id)?.name ?? id;
      const target = after ? `after '${after.name}'` : `position ${args.position}`;
      const summary = `Move queue '${q.name}' in ${sd.projectKey} to ${target}`;
      if (JSON.stringify(desired) === JSON.stringify(order)) return alreadySatisfied(summary, "it is already there");
      const req = { method: "POST" as const, path: `${SD}/servicedesk/${sd.id}/queue/reorder`, json: desired.map(Number), headers: OPT_IN, summary };
      // the move depends only on the queue it follows, so several moves in one plan do not drift each other
      const anchor = i === 0 ? "first" : desired[i - 1];
      const extra = { before: order.map(nameOf), after: desired.map(nameOf), identity: { op: "move-queue", sd: sd.id, queue: args.queue, position: args.position ?? null, after: args.after ?? null }, state: { anchor: after ? null : anchor } };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...extra };
      await c.request("POST", req.path, { json: req.json, headers: OPT_IN });
      const back = (await listQueues(c, sd)).map((x) => String(x.id));
      if (JSON.stringify(back) !== JSON.stringify(desired)) {
        throw new VerificationError(`${summary}: Jira reports another order after the change`, { expected: desired.map(nameOf), actual: back.map(nameOf) });
      }
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { order: back.map(nameOf) } };
    },
  },
];
