/**
 * Jira Assets structure: object schemas, object types, attribute definitions, statuses.
 * Updates read the current definition and send it merged with the changes, so fields that
 * are not mentioned keep their value.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, contains, dryRunShape, guardedWrite, listArg, pageShape, paginate, type WriteRequest } from "../util.js";
import {
  assetsBase,
  ATTRIBUTE_KINDS,
  ATTRIBUTE_TYPE_NAMES,
  compactAttributeDef,
  compactObjectType,
  compactSchema,
  DEFAULT_TYPES,
  STATUS_CATEGORIES,
  typeAttributes,
} from "./common.js";

const id = z.coerce.number().int();

/** GET, or null when the object does not exist (404). */
async function readOrNull(c: AtlassianClient, path: string): Promise<any | null> {
  try {
    return await c.get(path);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

const listOf = (data: any, key?: string): any[] => (Array.isArray(data) ? data : (key && Array.isArray(data?.[key]) ? data[key] : []));
const sameText = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const norm = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const differing = (want: Record<string, unknown>, have: Record<string, unknown>) =>
  Object.keys(want).filter((k) => want[k] !== undefined && norm(want[k]) !== norm(have[k]));

/**
 * Dry run (with identity/state), or execute and read back: `verify` returns the observed state and
 * whether it shows the change; a mismatch is a VerificationError carrying that state.
 */
async function verifiedWrite(
  c: AtlassianClient,
  args: { dry_run?: boolean },
  req: WriteRequest,
  plan: { identity: Record<string, unknown>; state: unknown },
  verify: () => Promise<{ ok: boolean; observed: unknown }>,
) {
  if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), ...plan };
  const res = await guardedWrite(c, args, req);
  const back = await verify();
  if (!back.ok) throw new VerificationError(`${req.summary}: the change does not read back`, back.observed);
  return { ...res, verification: back.observed };
}

// -- schemas ----------------------------------------------------------------------

const schemaTools: ToolDef[] = [
  {
    name: "assets_list_schemas",
    product: "jira",
    description: "Object schemas with id, key, name, object and object type counts.",
    inputShape: { name_contains: z.string().optional().describe("Server-side name search"), ...pageShape(100) },
    async handler({ client }, args) {
      // objectschema/list has a server-side `query` but no paging: slice locally.
      const data = await client("jira").get(`${assetsBase()}/objectschema/list`, { query: args.name_contains });
      const list: any[] = data?.objectschemas ?? data?.values ?? (Array.isArray(data) ? data : []);
      // the key is matched locally too, the server query looks at names
      const items = list.filter((s) => contains(s.name, args.name_contains) || contains(s.objectSchemaKey, args.name_contains)).map(compactSchema);
      return paginate(items, args, 100);
    },
  },
  {
    name: "assets_get_schema",
    product: "jira",
    description: "One schema plus its object type tree (id, name, parent, object count). Start here to learn a schema.",
    inputShape: { schema_id: id, include_abstract: boolArg.optional().describe("Default true") },
    async handler({ client }, args) {
      const c = client("jira");
      const [schema, types] = await Promise.all([
        c.get(`${assetsBase()}/objectschema/${args.schema_id}`),
        c.get(`${assetsBase()}/objectschema/${args.schema_id}/objecttypes/flat`),
      ]);
      const all: any[] = (types ?? []).filter((t: any) => args.include_abstract !== false || !t.abstractObjectType);
      // depth-first tree as indented names, cheap to read
      const children = new Map<number | undefined, any[]>();
      for (const t of all) {
        const parent = all.some((p) => p.id === t.parentObjectTypeId) ? t.parentObjectTypeId : undefined;
        children.set(parent, [...(children.get(parent) ?? []), t]);
      }
      const tree: string[] = [];
      const walk = (parent: number | undefined, depth: number) => {
        for (const t of (children.get(parent) ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
          tree.push(`${"  ".repeat(depth)}${t.name} [${t.id}]${t.objectCount !== undefined ? ` ${t.objectCount}` : ""}${t.abstractObjectType ? " abstract" : ""}`);
          walk(t.id, depth + 1);
        }
      };
      walk(undefined, 0);
      return { ...compactSchema(schema), objectTypeTree: tree.join("\n") };
    },
  },
  {
    name: "assets_create_schema",
    product: "jira",
    write: true,
    description: "Create an object schema. key: 2–10 uppercase letters, used as the object key prefix (e.g. ITAM → ITAM-123).",
    inputShape: { name: z.string(), key: z.string(), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      if (!/^[A-Z][A-Z0-9]{1,9}$/.test(args.key)) throw new ValidationError("key must be 2–10 characters A-Z0-9, starting with a letter");
      const c = client("jira");
      const summary = `Create Assets schema ${args.key} "${args.name}"`;
      const all = async () => listOf(await c.get(`${assetsBase()}/objectschema/list`), "objectschemas");
      const existing = (await all()).find((x) => x.objectSchemaKey === args.key || sameText(x.name, args.name));
      if (existing) {
        const same = existing.objectSchemaKey === args.key && sameText(existing.name, args.name) && (args.description === undefined || norm(existing.description) === args.description);
        if (same) return alreadySatisfied(summary, `schema ${existing.objectSchemaKey} [${existing.id}] already exists with these settings`);
        throw new ValidationError(`A schema ${existing.objectSchemaKey} "${existing.name}" [${existing.id}] already exists with other settings`);
      }
      return verifiedWrite(c, args, {
        method: "POST",
        path: `${assetsBase()}/objectschema/create`,
        json: { name: args.name, objectSchemaKey: args.key, description: args.description },
        summary,
      }, { identity: { op: "assets-create-schema", key: args.key, name: args.name, description: args.description ?? null }, state: { present: false } }, async () => {
        const back = (await all()).find((x) => x.objectSchemaKey === args.key);
        return { ok: !!back && sameText(back.name, args.name), observed: back ? compactSchema(back) : null };
      });
    },
  },
  {
    name: "assets_update_schema",
    product: "jira",
    write: true,
    description: "Rename a schema or change its description (the key cannot change once objects exist).",
    inputShape: { schema_id: id, name: z.string().optional(), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/objectschema/${args.schema_id}`;
      const cur = await c.get(path);
      const want = { name: args.name, description: args.description };
      const changed = differing(want, cur);
      const summary = `Update Assets schema ${cur.objectSchemaKey}`;
      if (!changed.length) return alreadySatisfied(summary, "the schema already has these values");
      return verifiedWrite(c, args, {
        method: "PUT",
        path,
        json: {
          id: cur.id,
          name: args.name ?? cur.name,
          objectSchemaKey: cur.objectSchemaKey,
          description: args.description ?? cur.description,
        },
        summary,
      }, { identity: { op: "assets-update-schema", schema: args.schema_id, ...want }, state: Object.fromEntries(changed.map((k) => [k, cur[k] ?? null])) }, async () => {
        const back = await c.get(path);
        return { ok: !differing(want, back).length, observed: compactSchema(back) };
      });
    },
  },
  {
    name: "assets_delete_schema",
    product: "jira",
    write: true,
    description: "PERMANENTLY delete a schema with all its object types, attributes and objects.",
    inputShape: { schema_id: id, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/objectschema/${args.schema_id}`;
      const cur = await readOrNull(c, path);
      if (!cur) return alreadySatisfied(`Delete Assets schema ${args.schema_id}`, "no such schema");
      return verifiedWrite(c, args, {
        method: "DELETE",
        path,
        summary: `PERMANENTLY delete Assets schema ${cur.objectSchemaKey} "${cur.name}" with ${cur.objectCount ?? "?"} objects`,
      }, { identity: { op: "assets-delete-schema", schema: args.schema_id }, state: { present: true } }, async () => {
        const back = await readOrNull(c, path);
        return { ok: !back, observed: back ? compactSchema(back) : null };
      });
    },
  },
  {
    name: "assets_get_schema_attributes",
    product: "jira",
    description: "All attribute definitions across a schema (which type each belongs to), filterable by name.",
    inputShape: {
      schema_id: id,
      query: z.string().optional().describe("Server-side name search"),
      only_editable: boolArg.optional().describe("Only attributes whose values can be edited"),
      ...pageShape(200),
    },
    async handler({ client }, args) {
      // Server-side filters (query, onlyValueEditable); the endpoint has no paging, so it is sliced locally.
      const list: any[] = (await client("jira").get(`${assetsBase()}/objectschema/${args.schema_id}/attributes`, {
        query: args.query,
        onlyValueEditable: args.only_editable,
      })) ?? [];
      return paginate(list.map((a) => ({ objectType: a.objectType?.name, ...compactAttributeDef(a) })), args, 200);
    },
  },
  {
    name: "assets_get_reference_types",
    product: "jira",
    description: "Reference types (e.g. Depends on, Installed, Owner) usable for reference attributes in a schema.",
    inputShape: { schema_id: id },
    async handler({ client }, args) {
      const list: any[] = (await client("jira").get(`${assetsBase()}/objectschema/${args.schema_id}/referencetypes`)) ?? [];
      return list.map((r) => ({ id: r.id, name: r.name, description: r.description || undefined }));
    },
  },
];

// -- object types -------------------------------------------------------------

async function defaultIconId(c: AtlassianClient): Promise<number> {
  const icons: any[] = (await c.get(`${assetsBase()}/icon/global`)) ?? [];
  if (!icons.length) throw new ValidationError("No global icons found; pass icon_id");
  return icons[0].id;
}

const objectTypeTools: ToolDef[] = [
  {
    name: "assets_get_object_type",
    product: "jira",
    description: "One object type with its attribute counts (own and inherited); assets_list_attributes lists the definitions.",
    inputShape: { object_type_id: id },
    async handler({ client }, args) {
      const c = client("jira");
      const [t, attrs] = await Promise.all([
        c.get(`${assetsBase()}/objecttype/${args.object_type_id}`),
        typeAttributes(c, args.object_type_id),
      ]);
      const inherited = attrs.filter((a) => compactAttributeDef(a).inherited).length;
      return {
        ...compactObjectType(t),
        icon: t?.icon?.id,
        attributeCount: { total: attrs.length, inherited },
        hint: `assets_list_attributes object_type_id=${args.object_type_id} lists the attribute definitions (paged, filterable)`,
      };
    },
  },
  {
    name: "assets_create_object_type",
    product: "jira",
    write: true,
    description:
      "Create an object type in a schema (optionally under a parent; inherited=true makes children inherit attributes). " +
      "New types get the system attributes Key, Name, Created, Updated.",
    inputShape: {
      schema_id: id,
      name: z.string(),
      description: z.string().optional(),
      parent_id: id.optional(),
      icon_id: id.optional().describe("Default: first global icon"),
      inherited: boolArg.optional(),
      abstract: boolArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create object type "${args.name}" in schema ${args.schema_id}${args.parent_id ? ` under ${args.parent_id}` : ""}`;
      const find = async () => listOf(await c.get(`${assetsBase()}/objectschema/${args.schema_id}/objecttypes/flat`))
        .find((t) => sameText(t.name, args.name) && norm(t.parentObjectTypeId) === norm(args.parent_id));
      const existing = await find();
      if (existing) {
        const want = { description: args.description, inherited: args.inherited, abstractObjectType: args.abstract };
        const have = { ...existing, inherited: existing.inherited ?? false, abstractObjectType: existing.abstractObjectType ?? false };
        const iconDiffers = args.icon_id !== undefined && norm(existing.icon?.id) !== norm(args.icon_id);
        if (!differing(want, have).length && !iconDiffers) return alreadySatisfied(summary, `object type ${existing.name} [${existing.id}] already exists with these settings`);
        throw new ValidationError(`Object type "${existing.name}" [${existing.id}] already exists there with other settings; use assets_update_object_type`);
      }
      return verifiedWrite(c, args, {
        method: "POST",
        path: `${assetsBase()}/objecttype/create`,
        json: {
          name: args.name,
          description: args.description,
          objectSchemaId: args.schema_id,
          parentObjectTypeId: args.parent_id,
          iconId: args.icon_id ?? (await defaultIconId(c)),
          inherited: args.inherited ?? false,
          abstractObjectType: args.abstract ?? false,
        },
        summary,
      }, { identity: { op: "assets-create-object-type", schema: args.schema_id, name: args.name, parent: args.parent_id ?? null }, state: { present: false } }, async () => {
        const back = await find();
        return { ok: !!back, observed: back ? compactObjectType(back) : null };
      });
    },
  },
  {
    name: "assets_update_object_type",
    product: "jira",
    write: true,
    description: "Rename, re-describe, move under another parent or change icon/inheritance of an object type.",
    inputShape: {
      object_type_id: id,
      name: z.string().optional(),
      description: z.string().optional(),
      parent_id: id.optional(),
      icon_id: id.optional(),
      inherited: boolArg.optional(),
      abstract: boolArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/objecttype/${args.object_type_id}`;
      const cur = await c.get(path);
      const view = (t: any) => ({ name: t.name, description: t.description, parentObjectTypeId: t.parentObjectTypeId, iconId: t.icon?.id, inherited: t.inherited ?? false, abstractObjectType: t.abstractObjectType ?? false });
      const want = { name: args.name, description: args.description, parentObjectTypeId: args.parent_id, iconId: args.icon_id, inherited: args.inherited, abstractObjectType: args.abstract };
      const changed = differing(want, view(cur));
      const summary = `Update object type ${cur.name} [${cur.id}]`;
      if (!changed.length) return alreadySatisfied(summary, "the object type already has these settings");
      return verifiedWrite(c, args, {
        method: "PUT",
        path,
        json: {
          id: cur.id,
          name: args.name ?? cur.name,
          description: args.description ?? cur.description,
          objectSchemaId: cur.objectSchemaId,
          parentObjectTypeId: args.parent_id ?? cur.parentObjectTypeId,
          iconId: args.icon_id ?? cur.icon?.id,
          inherited: args.inherited ?? cur.inherited,
          abstractObjectType: args.abstract ?? cur.abstractObjectType,
        },
        summary,
      }, { identity: { op: "assets-update-object-type", objectType: args.object_type_id, ...want }, state: Object.fromEntries(changed.map((k) => [k, (view(cur) as any)[k] ?? null])) }, async () => {
        const back = await c.get(path);
        return { ok: !differing(want, view(back)).length, observed: compactObjectType(back) };
      });
    },
  },
  {
    name: "assets_delete_object_type",
    product: "jira",
    write: true,
    description: "PERMANENTLY delete an object type together with its objects and attribute definitions.",
    inputShape: { object_type_id: id, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/objecttype/${args.object_type_id}`;
      const cur = await readOrNull(c, path);
      if (!cur) return alreadySatisfied(`Delete object type ${args.object_type_id}`, "no such object type");
      return verifiedWrite(c, args, {
        method: "DELETE",
        path,
        summary: `PERMANENTLY delete object type ${cur.name} [${cur.id}] with ${cur.objectCount ?? "?"} objects`,
      }, { identity: { op: "assets-delete-object-type", objectType: args.object_type_id }, state: { present: true } }, async () => {
        const back = await readOrNull(c, path);
        return { ok: !back, observed: back ? compactObjectType(back) : null };
      });
    },
  },
];

// -- attribute definitions ------------------------------------------------------

const attributeShape = {
  label: boolArg.optional().describe("Use as the object's label (one per type)"),
  description: z.string().optional(),
  required: boolArg.optional().describe("minimumCardinality 1"),
  multiple: boolArg.optional().describe("maximumCardinality unlimited"),
  unique: boolArg.optional(),
  hidden: boolArg.optional(),
  options: listArg.optional().describe("select: the option values"),
  reference_object_type_id: id.optional().describe("reference: the referenced object type"),
  reference_type_id: id.optional().describe("reference: reference type id (assets_get_reference_types)"),
  aql_filter: z.string().optional().describe("reference: AQL that limits selectable objects"),
  groups: listArg.optional().describe("user/group: restrict to these groups"),
  regex: z.string().optional().describe("text: validation regex"),
  suffix: z.string().optional().describe("integer/double: unit suffix"),
  summable: boolArg.optional(),
  include_child_types: boolArg.optional().describe("reference: also allow child types of the referenced type"),
};

/** Merge user arguments into an ObjectTypeAttributeInEntry (on top of `base` for updates). */
function attributeEntry(args: Record<string, any>, base: Record<string, any> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  if (args.name !== undefined) out.name = args.name;
  if (args.type !== undefined) {
    const t = String(args.type).toLowerCase();
    if (t in DEFAULT_TYPES) {
      out.type = ATTRIBUTE_KINDS.default;
      out.defaultTypeId = DEFAULT_TYPES[t];
    } else if (t in ATTRIBUTE_KINDS) {
      out.type = ATTRIBUTE_KINDS[t];
      delete out.defaultTypeId;
    } else {
      throw new ValidationError(`type must be one of ${ATTRIBUTE_TYPE_NAMES.join(", ")}`);
    }
    if (t === "reference" && args.reference_object_type_id === undefined && base.typeValue === undefined) {
      throw new ValidationError("type=reference needs reference_object_type_id");
    }
  }
  if (args.label !== undefined) out.label = args.label;
  if (args.description !== undefined) out.description = args.description;
  if (args.required !== undefined) out.minimumCardinality = args.required ? 1 : 0;
  if (args.multiple !== undefined) out.maximumCardinality = args.multiple ? -1 : 1;
  if (args.unique !== undefined) out.uniqueAttribute = args.unique;
  if (args.hidden !== undefined) out.hidden = args.hidden;
  if (args.options !== undefined) out.options = args.options.join(",");
  if (args.reference_object_type_id !== undefined) out.typeValue = String(args.reference_object_type_id);
  if (args.reference_type_id !== undefined) out.additionalValue = String(args.reference_type_id);
  if (args.aql_filter !== undefined) {
    out.qlQuery = args.aql_filter;
    out.iql = args.aql_filter;
  }
  if (args.groups !== undefined) out.typeValueMulti = args.groups;
  if (args.regex !== undefined) out.regexValidation = args.regex;
  if (args.suffix !== undefined) out.suffix = args.suffix;
  if (args.summable !== undefined) out.summable = args.summable;
  if (args.include_child_types !== undefined) out.includeChildObjectTypes = args.include_child_types;
  return out;
}

/** Current attribute bean → ObjectTypeAttributeInEntry fields. */
function entryFromBean(a: any): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: a.id,
    name: a.name,
    label: a.label,
    description: a.description,
    type: a.type,
    minimumCardinality: a.minimumCardinality,
    maximumCardinality: a.maximumCardinality,
    uniqueAttribute: a.uniqueAttribute,
    hidden: a.hidden,
    summable: a.summable,
    indexed: a.indexed,
    includeChildObjectTypes: a.includeChildObjectTypes,
    regexValidation: a.regexValidation,
    suffix: a.suffix,
    options: a.options,
    typeValueMulti: a.typeValueMulti,
  };
  if (a.type === ATTRIBUTE_KINDS.default) out.defaultTypeId = a.defaultType?.id;
  if (a.referenceObjectTypeId !== undefined) out.typeValue = String(a.referenceObjectTypeId);
  if (a.referenceType?.id !== undefined) out.additionalValue = String(a.referenceType.id);
  if (a.iql ?? a.qlQuery) {
    out.qlQuery = a.qlQuery ?? a.iql;
    out.iql = a.qlQuery ?? a.iql;
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== null));
}

const attributeTools: ToolDef[] = [
  {
    name: "assets_list_attributes",
    product: "jira",
    description: "Attribute definitions of an object type (own and inherited): id, name, type, required, multiple, reference target.",
    inputShape: {
      object_type_id: id,
      name_contains: z.string().optional().describe("Server-side name search"),
      only_editable: boolArg.optional(),
      exclude_inherited: boolArg.optional().describe("Leave out attributes inherited from parent types"),
      ...pageShape(200),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const filtered = args.name_contains !== undefined || args.only_editable || args.exclude_inherited;
      // Unfiltered calls reuse the cached full list (also used for name resolution);
      // filters go to the server. No paging on this endpoint: sliced locally.
      const attrs: any[] = filtered
        ? ((await c.get(`${assetsBase()}/objecttype/${args.object_type_id}/attributes`, {
            query: args.name_contains,
            onlyValueEditable: args.only_editable,
            excludeParentAttributes: args.exclude_inherited,
          })) ?? [])
        : await typeAttributes(c, args.object_type_id);
      return paginate(attrs.map(compactAttributeDef), args, 200);
    },
  },
  {
    name: "assets_create_attribute",
    product: "jira",
    write: true,
    description:
      `Add an attribute to an object type. type: ${ATTRIBUTE_TYPE_NAMES.join(", ")}. ` +
      "reference needs reference_object_type_id (+ reference_type_id); select takes options.",
    inputShape: { object_type_id: id, name: z.string(), type: z.string(), ...attributeShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const entry = attributeEntry(args);
      const summary = `Add ${args.type} attribute "${args.name}" to object type ${args.object_type_id}`;
      // fresh read (not the per-run attribute cache), so the read-back sees the new attribute
      const find = async () => listOf(await c.get(`${assetsBase()}/objecttype/${args.object_type_id}/attributes`)).find((a) => sameText(a.name, args.name));
      const existing = await find();
      if (existing) {
        const { name: _name, ...settings } = entry;
        if (!differing(settings, entryFromBean(existing)).length) {
          return alreadySatisfied(summary, `attribute "${existing.name}" [${existing.id}] already exists with these settings`);
        }
        throw new ValidationError(`Attribute "${existing.name}" [${existing.id}] already exists on object type ${args.object_type_id} with other settings; use assets_update_attribute`);
      }
      return verifiedWrite(c, args, {
        method: "POST",
        path: `${assetsBase()}/objecttypeattribute/${args.object_type_id}`,
        json: entry,
        summary,
      }, { identity: { op: "assets-create-attribute", objectType: args.object_type_id, entry }, state: { attribute: args.name, present: false } }, async () => {
        const back = await find();
        return { ok: !!back, observed: back ? compactAttributeDef(back) : null };
      });
    },
  },
  {
    name: "assets_update_attribute",
    product: "jira",
    write: true,
    description: "Change an attribute definition (name, cardinality, options, reference filter...). Unmentioned settings are kept.",
    inputShape: { object_type_id: id, attribute_id: id, name: z.string().optional(), type: z.string().optional(), ...attributeShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const read = () => c.get(`${assetsBase()}/objecttypeattribute/${args.attribute_id}`);
      const cur = await read();
      const base = entryFromBean(cur);
      const json = attributeEntry(args, base);
      const changed = differing(json, base);
      const summary = `Update attribute "${cur.name}" [${cur.id}] of object type ${args.object_type_id}`;
      if (!changed.length) return alreadySatisfied(summary, "the attribute already has these settings");
      const pick = (o: Record<string, unknown>) => Object.fromEntries(changed.map((k) => [k, o[k] ?? null]));
      // the plan depends only on this attribute's changed settings, not on the type's other attributes
      return verifiedWrite(c, args, {
        method: "PUT",
        path: `${assetsBase()}/objecttypeattribute/${args.object_type_id}/${args.attribute_id}`,
        json,
        summary,
      }, { identity: { op: "assets-update-attribute", attribute: args.attribute_id, changes: pick(json) }, state: { attribute: args.attribute_id, before: pick(base) } }, async () => {
        const back = await read();
        return { ok: !differing(pick(json), entryFromBean(back)).length, observed: compactAttributeDef(back) };
      });
    },
  },
  {
    name: "assets_delete_attribute",
    product: "jira",
    write: true,
    description: "PERMANENTLY delete an attribute definition and its values on every object.",
    inputShape: { attribute_id: id, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/objecttypeattribute/${args.attribute_id}`;
      const cur = await readOrNull(c, path);
      if (!cur) return alreadySatisfied(`Delete attribute ${args.attribute_id}`, "no such attribute");
      return verifiedWrite(c, args, {
        method: "DELETE",
        path,
        summary: `PERMANENTLY delete attribute "${cur.name}" [${cur.id}] and all its values`,
      }, { identity: { op: "assets-delete-attribute", attribute: args.attribute_id }, state: { present: true } }, async () => {
        const back = await readOrNull(c, path);
        return { ok: !back, observed: back ? compactAttributeDef(back) : null };
      });
    },
  },
];

// -- statuses ---------------------------------------------------------------------

const statusTools: ToolDef[] = [
  {
    name: "assets_list_statuses",
    product: "jira",
    description: "Object statuses (global ones, plus schema-specific when schema_id is given) with category active/inactive/pending.",
    inputShape: { schema_id: id.optional(), name_contains: z.string().optional(), ...pageShape(200) },
    async handler({ client }, args) {
      // config/statustype filters by schema server-side but has no paging or name search: sliced locally.
      const list: any[] = (await client("jira").get(`${assetsBase()}/config/statustype`, { objectSchemaId: args.schema_id })) ?? [];
      const names = Object.fromEntries(Object.entries(STATUS_CATEGORIES).map(([k, v]) => [v, k]));
      const items = list
        .filter((s) => contains(s.name, args.name_contains))
        .map((s) => ({ id: s.id, name: s.name, category: names[s.category] ?? s.category, schema: s.objectSchemaId, description: s.description || undefined }));
      return paginate(items, args, 200);
    },
  },
  {
    name: "assets_create_status",
    product: "jira",
    write: true,
    description: "Create an object status, global or for one schema.",
    inputShape: { name: z.string(), category: z.enum(["active", "inactive", "pending"]), schema_id: id.optional(), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const summary = `Create ${args.category} status "${args.name}"${args.schema_id ? ` in schema ${args.schema_id}` : " (global)"}`;
      const find = async () => listOf(await c.get(`${assetsBase()}/config/statustype`, { objectSchemaId: args.schema_id }))
        .find((x) => sameText(x.name, args.name) && norm(x.objectSchemaId) === norm(args.schema_id));
      const existing = await find();
      if (existing) {
        const same = existing.category === STATUS_CATEGORIES[args.category] && (args.description === undefined || norm(existing.description) === args.description);
        if (same) return alreadySatisfied(summary, `status "${existing.name}" [${existing.id}] already exists with these settings`);
        throw new ValidationError(`Status "${existing.name}" [${existing.id}] already exists there with other settings; use assets_update_status`);
      }
      return verifiedWrite(c, args, {
        method: "POST",
        path: `${assetsBase()}/config/statustype`,
        json: { name: args.name, description: args.description, category: STATUS_CATEGORIES[args.category], objectSchemaId: args.schema_id },
        summary,
      }, { identity: { op: "assets-create-status", name: args.name, schema: args.schema_id ?? null, category: args.category }, state: { present: false } }, async () => {
        const back = await find();
        return { ok: !!back && back.category === STATUS_CATEGORIES[args.category], observed: back ?? null };
      });
    },
  },
  {
    name: "assets_update_status",
    product: "jira",
    write: true,
    description: "Rename or recategorise an object status.",
    inputShape: { status_id: id, name: z.string().optional(), category: z.enum(["active", "inactive", "pending"]).optional(), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/config/statustype/${args.status_id}`;
      const cur = await c.get(path);
      const want = { name: args.name, description: args.description, category: args.category ? STATUS_CATEGORIES[args.category] : undefined };
      const changed = differing(want, cur);
      const summary = `Update status "${cur.name}" [${cur.id}]`;
      if (!changed.length) return alreadySatisfied(summary, "the status already has these values");
      return verifiedWrite(c, args, {
        method: "PUT",
        path,
        json: {
          id: cur.id,
          name: args.name ?? cur.name,
          description: args.description ?? cur.description,
          category: args.category ? STATUS_CATEGORIES[args.category] : cur.category,
          objectSchemaId: cur.objectSchemaId,
        },
        summary,
      }, { identity: { op: "assets-update-status", status: args.status_id, ...want }, state: Object.fromEntries(changed.map((k) => [k, cur[k] ?? null])) }, async () => {
        const back = await c.get(path);
        return { ok: !differing(want, back).length, observed: back };
      });
    },
  },
  {
    name: "assets_delete_status",
    product: "jira",
    write: true,
    description: "Delete an object status (objects using it lose that status value).",
    inputShape: { status_id: id, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const path = `${assetsBase()}/config/statustype/${seg(args.status_id)}`;
      const cur = await readOrNull(c, path);
      if (!cur) return alreadySatisfied(`Delete Assets status ${args.status_id}`, "no such status");
      return verifiedWrite(c, args, {
        method: "DELETE",
        path,
        summary: `Delete Assets status "${cur.name}" [${args.status_id}]`,
      }, { identity: { op: "assets-delete-status", status: args.status_id }, state: { present: true } }, async () => {
        const back = await readOrNull(c, path);
        return { ok: !back, observed: back };
      });
    },
  },
];

export const assetsStructureTools: ToolDef[] = [...schemaTools, ...objectTypeTools, ...attributeTools, ...statusTools];
