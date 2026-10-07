/**
 * Jira Assets objects: AQL search, read, create/update/delete, history, references,
 * connected issues, comments, attachments list, archive/restore.
 * Attribute values are given and returned by attribute *name*.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite, listArg, paginate, serverPage } from "../util.js";
import { assetsBase, attributeNames, buildAttributes, compactObject, cutValue, loadObject, MAX_VALUE, resolveObjectTypeId } from "./common.js";

/** Attributes an assets_search row shows unless `attributes` names the wanted ones. */
const SEARCH_ATTRIBUTES = 20;

const objectRef = z.union([z.coerce.number().int(), z.string()]).describe("Object id or key, e.g. 1234 or ITAM-56");
const attributesArg = z
  .union([z.record(z.string(), z.unknown()), z.string()])
  .transform((v, ctx) => {
    if (typeof v !== "string") return v;
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // fall through
    }
    ctx.addIssue({ code: "custom", message: 'attributes must be a JSON object like {"Name":"x","Owner":"ivan"}' });
    return z.NEVER;
  })
  .describe('{"Attribute name": value | [values] | null}; references by object key, users by username, select by option text');

/** AQL search with the Assets 10+ path, falling back to the Insight 8.x/9.x one. */
async function aqlSearch(c: AtlassianClient, params: Record<string, any>): Promise<any> {
  try {
    return await c.get(`${assetsBase()}/aql/objects`, { ...params, qlQuery: params.ql, ql: undefined });
  } catch (e) {
    if (!isHttpStatusError(e) || e.status !== 404) throw e;
    return c.get(`${assetsBase()}/iql/objects`, { ...params, iql: params.ql, ql: undefined });
  }
}

async function objectTypeIdOf(c: AtlassianClient, ref: string | number): Promise<{ id: number; key: string; typeId: number; label: string }> {
  const o = await loadObject(c, ref);
  return { id: o.id, key: o.objectKey, typeId: o.objectType?.id, label: o.label };
}

type Built = Array<{ objectTypeAttributeId: number; objectAttributeValues: Array<{ value: string }> }>;

/** Every way Assets may show one stored value: raw value, display value, referenced object key/id/label, user, status. */
function representations(v: any): string[] {
  return [v?.value, v?.displayValue, v?.referencedObject?.objectKey, v?.referencedObject?.id, v?.referencedObject?.label, v?.user?.name, v?.user?.key, v?.status?.name, v?.status?.id]
    .filter((x) => x !== undefined && x !== null && x !== "")
    .map((x) => String(x).toLowerCase());
}

/** Attribute ids whose stored values differ from the values about to be sent. */
function differingAttributes(object: any, built: Built): number[] {
  return built.filter((b) => {
    const cur = (object?.attributes ?? []).find((a: any) => a.objectTypeAttributeId === b.objectTypeAttributeId)?.objectAttributeValues ?? [];
    if (cur.length !== b.objectAttributeValues.length) return true;
    const pool = cur.map(representations);
    return !b.objectAttributeValues.every((d) => {
      const i = pool.findIndex((r: string[]) => r.includes(String(d.value).toLowerCase()));
      if (i < 0) return false;
      pool.splice(i, 1);
      return true;
    });
  }).map((b) => b.objectTypeAttributeId);
}

/** The object, or null when it does not exist (404). */
async function objectOrNull(c: AtlassianClient, ref: string | number, withAttributes = false): Promise<any | null> {
  try {
    return await loadObject(c, ref, withAttributes);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

export const assetsObjectTools: ToolDef[] = [
  {
    name: "assets_search",
    product: "jira",
    description:
      'Search objects with AQL, e.g. objectType = "Laptop" AND Owner = ivan, or objectSchemaId = 3 AND Status = Active. ' +
      `Rows show key, label, type and up to ${SEARCH_ATTRIBUTES} attributes, values cut to ${MAX_VALUE} characters (pass \`attributes\` to name the wanted ones, or attributes=[] for none). ` +
      "Paged with page/limit; total = all matches.",
    inputShape: {
      aql: z.string(),
      schema_id: z.coerce.number().int().optional(),
      attributes: listArg.optional().describe(`Attribute names to include; [] for none; default the first ${SEARCH_ATTRIBUTES}`),
      page: z.coerce.number().int().min(1).optional().describe("Default 1"),
      limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 20; bounded attribute previews fit compact and JSON output"),
      order_by_attribute_id: z.coerce.number().int().optional(),
      descending: boolArg.optional(),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const page = args.page ?? 1;
      const limit = args.limit ?? 20;
      const withAttrs = !(Array.isArray(args.attributes) && args.attributes.length === 0);
      const data = await aqlSearch(c, {
        ql: args.aql,
        objectSchemaId: args.schema_id,
        page,
        resultPerPage: limit,
        includeAttributes: withAttrs,
        // reference values need depth 1; deeper levels only add referenced objects' own attributes
        includeAttributesDeep: withAttrs ? 1 : 0,
        // attribute names come with the page instead of a lookup per object type
        includeTypeAttributes: withAttrs,
        includeExtendedInfo: false,
        orderByAttributeId: args.order_by_attribute_id,
        orderAsc: args.descending ? false : undefined,
      });
      const names = new Map<number, string>((data?.objectTypeAttributes ?? []).map((a: any) => [a.id, a.name]));
      const entries: any[] = data?.objectEntries ?? [];
      if (withAttrs && names.size === 0 && entries.length) {
        for (const [k, v] of await attributeNames(c, entries.map((o) => o.objectType?.id).filter(Boolean))) names.set(k, v);
      }
      const items = entries.map((o) => {
        // named attributes are shown as asked; otherwise a row keeps the first SEARCH_ATTRIBUTES
        const co = compactObject(o, names, args.attributes, args.attributes?.length ? undefined : SEARCH_ATTRIBUTES);
        if (!withAttrs) delete co.attributes;
        return co;
      });
      const total = data?.totalFilterCount ?? null;
      const env = serverPage(items, (page - 1) * limit, limit, total);
      return { ...env, page, nextPage: env.nextOffset === null ? null : page + 1 };
    },
  },
  {
    name: "assets_validate_aql",
    product: "jira",
    description: "Check an AQL query for syntax errors without running it.",
    inputShape: { aql: z.string() },
    async handler({ client }, args) {
      return client("jira").request("POST", `${assetsBase()}/aql/validate`, { json: { qlQuery: args.aql, iql: args.aql } });
    },
  },
  {
    name: "assets_get_object",
    product: "jira",
    description: "One object with all attribute values by name (references shown as object keys).",
    inputShape: { object: objectRef },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await loadObject(c, args.object, true);
      const names = (o?.attributes ?? []).some((a: any) => !a.objectTypeAttribute?.name) && o?.objectType?.id
        ? await attributeNames(c, [o.objectType.id])
        : undefined;
      return { ...compactObject(o, names), created: o?.created, schema: o?.objectType?.objectSchemaId };
    },
  },
  {
    name: "assets_create_object",
    product: "jira",
    write: true,
    unverifiable: "objects have no natural key, so an existing copy cannot be detected",
    description:
      "Create an object. object_type: id, or name together with schema_id. attributes by name; required attributes " +
      "(see assets_list_attributes) must be set.",
    inputShape: {
      object_type: z.union([z.coerce.number().int(), z.string()]),
      schema_id: z.coerce.number().int().optional(),
      attributes: attributesArg,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const typeId = await resolveObjectTypeId(c, args.object_type, args.schema_id);
      const attributes = await buildAttributes(c, typeId, args.attributes);
      const res = await guardedWrite(c, args, {
        method: "POST",
        path: `${assetsBase()}/object/create`,
        json: { objectTypeId: typeId, attributes },
        summary: `Create Assets object of type ${typeId} (${Object.keys(args.attributes).join(", ")})`,
      });
      if (!res.dry_run) res.result = { id: (res.result as any)?.id, key: (res.result as any)?.objectKey, label: (res.result as any)?.label };
      return res;
    },
  },
  {
    name: "assets_update_object",
    product: "jira",
    write: true,
    description: "Set attribute values of an object (only the attributes given change; null clears one).",
    inputShape: { object: objectRef, attributes: attributesArg, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const obj = await loadObject(c, args.object, true);
      const o = { id: obj.id, key: obj.objectKey, typeId: obj.objectType?.id, label: obj.label };
      const attributes = await buildAttributes(c, o.typeId, args.attributes);
      const summary = `Update ${o.key} "${o.label}": ${Object.keys(args.attributes).join(", ")}`;
      const changed = differingAttributes(obj, attributes);
      if (!changed.length) return alreadySatisfied(summary, "the object already has these values");
      const req = { method: "PUT" as const, path: `${assetsBase()}/object/${o.id}`, json: { objectTypeId: o.typeId, attributes }, summary };
      if (args.dry_run !== false) {
        const before = (obj.attributes ?? []).filter((a: any) => changed.includes(a.objectTypeAttributeId))
          .map((a: any) => ({ id: a.objectTypeAttributeId, values: (a.objectAttributeValues ?? []).map((v: any) => representations(v)[0] ?? null) }));
        return { ...(await guardedWrite(c, args, req)), identity: { op: "assets-update-object", object: o.key, attributes: args.attributes }, state: { before } };
      }
      const res = await guardedWrite(c, args, req);
      const back = await loadObject(c, o.id, true);
      const left = differingAttributes(back, attributes);
      if (left.length) throw new VerificationError(`${summary}: attribute(s) ${left.join(", ")} do not read back as set`, compactObject(back));
      res.result = { id: o.id, key: o.key };
      return res;
    },
  },
  {
    name: "assets_delete_object",
    product: "jira",
    write: true,
    description: "PERMANENTLY delete an object (references to it are removed). Consider assets_archive_object instead.",
    inputShape: { object: objectRef, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const obj = await objectOrNull(c, args.object);
      if (!obj) return alreadySatisfied(`Delete Assets object ${args.object}`, "no such object");
      const req = { method: "DELETE" as const, path: `${assetsBase()}/object/${obj.id}`, summary: `PERMANENTLY delete ${obj.objectKey} "${obj.label}"` };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "assets-delete-object", object: obj.objectKey }, state: { present: true } };
      const res = await guardedWrite(c, args, req);
      const back = await objectOrNull(c, obj.id);
      if (back) throw new VerificationError(`${req.summary}: the object still exists`, compactObject(back));
      return res;
    },
  },
  {
    name: "assets_archive_object",
    product: "jira",
    write: true,
    description: "Archive (archived=true) or restore (archived=false) an object. Assets 10.x+ (JSM 5.x+).",
    inputShape: { object: objectRef, archived: boolArg.optional().describe("Default true"), ...dryRunShape },
    async handler({ client }, args) {
      const archive = args.archived !== false;
      const c = client("jira");
      const summary = `${archive ? "Archive" : "Restore"} Assets object ${args.object}`;
      const cur = await loadObject(c, args.object);
      // older Assets versions do not report `archived`; then neither the pre-check nor the read-back can tell
      if (typeof cur?.archived === "boolean" && cur.archived === archive) {
        return alreadySatisfied(summary, `the object is already ${archive ? "archived" : "active"}`);
      }
      const req = { method: "PUT" as const, path: `${assetsBase()}/object/${archive ? "archive" : "restore"}/${seg(args.object)}`, summary };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity: { op: "assets-archive-object", object: args.object, archived: archive }, state: { archived: cur?.archived ?? null } };
      const res = await guardedWrite(c, args, req);
      const back = await loadObject(c, cur.id);
      if (typeof back?.archived === "boolean" && back.archived !== archive) {
        throw new VerificationError(`${summary}: the object does not read back as ${archive ? "archived" : "restored"}`, { key: back.objectKey, archived: back.archived });
      }
      return { ...res, verification: typeof back?.archived === "boolean" ? { archived: back.archived } : "not reported by this Assets version" };
    },
  },
  {
    name: "assets_object_history",
    product: "jira",
    description: "Change history of an object: when, who, which attribute, old → new.",
    inputShape: {
      object: objectRef,
      offset: z.coerce.number().int().min(0).optional().describe("Entries to skip (default 0)"),
      limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 50, newest first"),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await objectTypeIdOf(c, args.object);
      // No paging on object/{id}/history: newest first from the server, sliced locally.
      const list: any[] = (await c.get(`${assetsBase()}/object/${o.id}/history`, { asc: false, abbreviate: true })) ?? [];
      const offset = args.offset ?? 0;
      return list.slice(offset, offset + (args.limit ?? 50)).map((h) => ({
        created: h.created,
        actor: h.actor?.name ?? h.actor?.key ?? h.actor?.displayName,
        type: h.type,
        attribute: h.affectedAttribute,
        from: cutValue(h.oldValue),
        to: cutValue(h.newValue),
      }));
    },
  },
  {
    name: "assets_object_references",
    product: "jira",
    description: "How many objects reference this object and which it references, per reference type.",
    inputShape: { object: objectRef },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await objectTypeIdOf(c, args.object);
      const data: any = await c.get(`${assetsBase()}/object/${o.id}/referenceinfo`);
      const list: any[] = Array.isArray(data) ? data : data?.objectReferenceInfoBeans ?? data?.referenceInfos ?? [];
      return list.map((e) => ({
        referenceType: (e.referenceTypeBean ?? e.referenceType)?.name,
        objectType: e.objectType?.name,
        objects: e.numberOfReferencedObjects ?? e.count,
      }));
    },
  },
  {
    name: "assets_object_issues",
    product: "jira",
    description: "Jira issues connected to an object (via Assets custom fields).",
    inputShape: { object: objectRef, limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 50") },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await objectTypeIdOf(c, args.object);
      const data = await c.get(`${assetsBase()}/objectconnectedtickets/${o.id}/tickets`, { limit: args.limit ?? 50 });
      const tickets: any[] = data?.tickets ?? (Array.isArray(data) ? data : []);
      return tickets.map((t) => ({ key: t.key, summary: t.title ?? t.summary, status: t.status?.name ?? t.status, type: t.type?.name ?? t.type }));
    },
  },
  {
    name: "assets_object_comments",
    product: "jira",
    description: "Comments on an object, newest first (oldest=true for chronological order).",
    inputShape: { object: objectRef, oldest: boolArg.optional(), offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 20") },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await objectTypeIdOf(c, args.object);
      // comment/object/{id} has no paging: ordered by the server, sliced locally.
      const list: any[] = (await c.get(`${assetsBase()}/comment/object/${o.id}`, { asc: args.oldest === true })) ?? [];
      const items = list.map((cm) => ({ id: cm.id, created: cm.created, author: cm.actor?.name ?? cm.actor?.key, comment: cm.comment }));
      return paginate(items, args, 20);
    },
  },
  {
    name: "assets_add_object_comment",
    product: "jira",
    write: true,
    unverifiable: "a comment has no key to detect an earlier identical one",
    description: "Add a comment to an object (role 0 = visible to all users with object access).",
    inputShape: { object: objectRef, comment: z.string(), role: z.coerce.number().int().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await objectTypeIdOf(c, args.object);
      return guardedWrite(c, args, {
        method: "POST",
        path: `${assetsBase()}/comment/create`,
        json: { objectId: o.id, comment: args.comment, role: args.role ?? 0 },
        summary: `Comment on ${o.key}`,
      });
    },
  },
  {
    name: "assets_object_attachments",
    product: "jira",
    description: "Attachments of an object: id, filename, size, author, created.",
    inputShape: { object: objectRef, offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(500).optional().describe("Default 50") },
    async handler({ client }, args) {
      const c = client("jira");
      const o = await objectTypeIdOf(c, args.object);
      // attachments/object/{id} has no paging: sliced locally.
      const list: any[] = (await c.get(`${assetsBase()}/attachments/object/${o.id}`)) ?? [];
      const items = list.map((a) => ({ id: a.id, filename: a.filename, bytes: a.filesize ?? a.fileSize, mimeType: a.mimeType, author: a.author, created: a.created }));
      return paginate(items, args, 50);
    },
  },
  {
    name: "assets_bulk_update",
    product: "jira",
    write: true,
    description:
      "Apply the same attribute changes to every object matching an AQL query (max `max_objects`, default 50). " +
      "The dry run lists the matched objects; nothing is changed until dry_run=false.",
    inputShape: {
      aql: z.string(),
      attributes: attributesArg,
      max_objects: z.coerce.number().int().min(1).max(500).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const max = args.max_objects ?? 50;
      // attributes are needed to skip objects that already have the values
      const data = await aqlSearch(c, { ql: args.aql, page: 1, resultPerPage: max + 1, includeAttributes: true });
      const objects: any[] = data?.objectEntries ?? [];
      const total = data?.totalFilterCount ?? objects.length;
      if (total > max) throw new ValidationError(`AQL matches ${total} objects, more than max_objects=${max}. Narrow the query or raise max_objects.`);
      const plans = await Promise.all(
        objects.map(async (o) => ({ o, attributes: await buildAttributes(c, o.objectType?.id, args.attributes) })),
      );
      const pending = plans.filter(({ o, attributes }) => differingAttributes(o, attributes).length);
      const summary = `Set ${Object.keys(args.attributes).join(", ")} on ${pending.length} of ${objects.length} objects matching ${args.aql}`;
      if (!pending.length) return alreadySatisfied(summary, "every matching object already has these values");
      if (args.dry_run !== false) {
        return {
          dry_run: true,
          product: "jira",
          summary,
          request: { method: "PUT", url: c.url(`${assetsBase()}/object/{id}`), body: { attributes: plans[0]?.attributes ?? [] } },
          objects: pending.map(({ o }) => `${o.objectKey} ${o.label}`),
          ...(pending.length < objects.length ? { alreadySet: objects.length - pending.length } : {}),
          note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
        };
      }
      const done: string[] = [];
      const failed: Array<{ key: string; error: string }> = [];
      const unverified: Array<{ key: string; attributes: number[] }> = [];
      for (const { o, attributes } of pending) {
        try {
          await c.request("PUT", `${assetsBase()}/object/${o.id}`, { json: { objectTypeId: o.objectType?.id, attributes } });
          done.push(o.objectKey);
          const left = differingAttributes(await loadObject(c, o.id, true), attributes);
          if (left.length) unverified.push({ key: o.objectKey, attributes: left });
        } catch (e: any) {
          failed.push({ key: o.objectKey, error: String(e?.message ?? e) });
        }
      }
      if (unverified.length) throw new VerificationError(`${summary}: ${unverified.length} object(s) do not read back as set`, { unverified, updated: done.length, failed });
      return { dry_run: false, product: "jira", summary, request: { method: "PUT", url: c.url(`${assetsBase()}/object/{id}`) }, result: { updated: done.length, failed } };
    },
  },
];
