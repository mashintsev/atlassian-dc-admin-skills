/**
 * Jira Assets structure: object schemas, object types, attribute definitions, statuses.
 * Updates read the current definition and send it merged with the changes, so fields that
 * are not mentioned keep their value.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, contains, dryRunShape, guardedWrite, listArg, pageShape, paginate } from "../util.js";
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
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${assetsBase()}/objectschema/create`,
        json: { name: args.name, objectSchemaKey: args.key, description: args.description },
        summary: `Create Assets schema ${args.key} "${args.name}"`,
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
      const cur = await c.get(`${assetsBase()}/objectschema/${args.schema_id}`);
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${assetsBase()}/objectschema/${args.schema_id}`,
        json: {
          id: cur.id,
          name: args.name ?? cur.name,
          objectSchemaKey: cur.objectSchemaKey,
          description: args.description ?? cur.description,
        },
        summary: `Update Assets schema ${cur.objectSchemaKey}`,
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
      const cur = await c.get(`${assetsBase()}/objectschema/${args.schema_id}`);
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${assetsBase()}/objectschema/${args.schema_id}`,
        summary: `PERMANENTLY delete Assets schema ${cur.objectSchemaKey} "${cur.name}" with ${cur.objectCount ?? "?"} objects`,
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
    description: "One object type with its attribute definitions (own and inherited).",
    inputShape: { object_type_id: id },
    async handler({ client }, args) {
      const c = client("jira");
      const [t, attrs] = await Promise.all([
        c.get(`${assetsBase()}/objecttype/${args.object_type_id}`),
        typeAttributes(c, args.object_type_id),
      ]);
      return { ...compactObjectType(t), icon: t?.icon?.id, attributes: attrs.map(compactAttributeDef) };
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
      return guardedWrite(c, args, {
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
        summary: `Create object type "${args.name}" in schema ${args.schema_id}${args.parent_id ? ` under ${args.parent_id}` : ""}`,
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
      const cur = await c.get(`${assetsBase()}/objecttype/${args.object_type_id}`);
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${assetsBase()}/objecttype/${args.object_type_id}`,
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
        summary: `Update object type ${cur.name} [${cur.id}]`,
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
      const cur = await c.get(`${assetsBase()}/objecttype/${args.object_type_id}`);
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${assetsBase()}/objecttype/${args.object_type_id}`,
        summary: `PERMANENTLY delete object type ${cur.name} [${cur.id}] with ${cur.objectCount ?? "?"} objects`,
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
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${assetsBase()}/objecttypeattribute/${args.object_type_id}`,
        json: attributeEntry(args),
        summary: `Add ${args.type} attribute "${args.name}" to object type ${args.object_type_id}`,
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
      const cur = await c.get(`${assetsBase()}/objecttypeattribute/${args.attribute_id}`);
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${assetsBase()}/objecttypeattribute/${args.object_type_id}/${args.attribute_id}`,
        json: attributeEntry(args, entryFromBean(cur)),
        summary: `Update attribute "${cur.name}" [${cur.id}] of object type ${args.object_type_id}`,
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
      const cur = await c.get(`${assetsBase()}/objecttypeattribute/${args.attribute_id}`);
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${assetsBase()}/objecttypeattribute/${args.attribute_id}`,
        summary: `PERMANENTLY delete attribute "${cur.name}" [${cur.id}] and all its values`,
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
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${assetsBase()}/config/statustype`,
        json: { name: args.name, description: args.description, category: STATUS_CATEGORIES[args.category], objectSchemaId: args.schema_id },
        summary: `Create ${args.category} status "${args.name}"${args.schema_id ? ` in schema ${args.schema_id}` : " (global)"}`,
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
      const cur = await c.get(`${assetsBase()}/config/statustype/${args.status_id}`);
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${assetsBase()}/config/statustype/${args.status_id}`,
        json: {
          id: cur.id,
          name: args.name ?? cur.name,
          description: args.description ?? cur.description,
          category: args.category ? STATUS_CATEGORIES[args.category] : cur.category,
          objectSchemaId: cur.objectSchemaId,
        },
        summary: `Update status "${cur.name}" [${cur.id}]`,
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
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${assetsBase()}/config/statustype/${seg(args.status_id)}`,
        summary: `Delete Assets status ${args.status_id}`,
      });
    },
  },
];

export const assetsStructureTools: ToolDef[] = [...schemaTools, ...objectTypeTools, ...attributeTools, ...statusTools];
