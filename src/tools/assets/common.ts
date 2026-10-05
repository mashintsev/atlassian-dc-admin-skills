/**
 * Shared helpers for Jira Assets (formerly Insight) on Data Center.
 *
 * Endpoints, request beans and enum codes were read from insight-rest-api / insight 21.3.2
 * (ObjectResource, AQLResource, ObjectSchemaResource, ObjectTypeResource,
 * ObjectTypeAttributeResource, StatusTypeResource; ObjectInEntry, ObjectTypeAttributeInEntry,
 * ObjectTypeAttributeBean.Type/DefaultType, StatusTypeBean). Compact shapes follow
 * mcp-atlassian-for-admins (src/tools/assets.ts, MIT).
 */

import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";

/**
 * `/rest/insight/1.0` exists on every version (Insight 8.x … Assets 21.x, deprecated alias there);
 * `/rest/assets/1.0` only from Assets 10.x / JSM 5.x. Override with ASSETS_API_BASE.
 */
export function assetsBase(): string {
  return (process.env.ASSETS_API_BASE ?? "/rest/insight/1.0").replace(/\/+$/, "");
}

/** ObjectTypeAttributeBean.Type */
export const ATTRIBUTE_KINDS: Record<string, number> = {
  default: 0, reference: 1, user: 2, confluence: 3, group: 4, version: 5, project: 6, status: 7,
};
/** ObjectTypeAttributeBean.DefaultType (for kind=default) */
export const DEFAULT_TYPES: Record<string, number> = {
  text: 0, integer: 1, boolean: 2, double: 3, date: 4, time: 5, datetime: 6, url: 7, email: 8,
  textarea: 9, select: 10, ipaddress: 11,
};
/** User-facing attribute type: a DEFAULT_TYPES name, or one of the non-default kinds. */
export const ATTRIBUTE_TYPE_NAMES = [...Object.keys(DEFAULT_TYPES), ...Object.keys(ATTRIBUTE_KINDS).filter((k) => k !== "default")];

/** StatusTypeBean.STATUS_CATEGORY_* */
export const STATUS_CATEGORIES: Record<string, number> = { inactive: 0, active: 1, pending: 2 };

const KIND_BY_CODE = Object.fromEntries(Object.entries(ATTRIBUTE_KINDS).map(([k, v]) => [v, k]));
const DEFAULT_BY_CODE = Object.fromEntries(Object.entries(DEFAULT_TYPES).map(([k, v]) => [v, k]));

/** "text", "select", "reference", "user"… from an attribute bean. */
export function attributeTypeName(a: any): string {
  const kind = KIND_BY_CODE[a?.type] ?? String(a?.type);
  if (kind !== "default") return kind;
  return a?.defaultType?.name?.toLowerCase().replace(/[^a-z]/g, "") ?? DEFAULT_BY_CODE[a?.defaultTypeId] ?? "text";
}

export function compactAttributeDef(a: any): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    type: attributeTypeName(a),
    label: a.label || undefined,
    required: (a.minimumCardinality ?? 0) > 0 || undefined,
    multiple: a.maximumCardinality === -1 || (a.maximumCardinality ?? 1) > 1 || undefined,
    unique: a.uniqueAttribute || undefined,
    hidden: a.hidden || undefined,
    editable: a.editable === false ? false : undefined,
    system: a.system || undefined,
    referenceObjectTypeId: a.referenceObjectTypeId,
    referenceType: a.referenceType?.name,
    options: a.options || undefined,
    inherited: a.objectType && a.objectType.id !== undefined && a.objectTypeId !== undefined && a.objectType.id !== a.objectTypeId ? true : undefined,
    description: a.description || undefined,
  };
}

export function compactObjectType(t: any): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    parent: t.parentObjectTypeId,
    objects: t.objectCount,
    abstract: t.abstractObjectType || undefined,
    inherited: t.inherited || undefined,
    schema: t.objectSchemaId,
    description: t.description || undefined,
  };
}

export function compactSchema(s: any): Record<string, unknown> {
  return {
    id: s.id,
    key: s.objectSchemaKey,
    name: s.name,
    objects: s.objectCount,
    objectTypes: s.objectTypeCount,
    status: s.status,
    description: s.description || undefined,
  };
}

/** One attribute value as an agent reads it: display value, or the referenced object's key. */
function valueOf(v: any): unknown {
  if (v?.referencedObject) return v.referencedObject.objectKey ?? v.referencedObject.label;
  if (v?.user) return v.user.name ?? v.user.key ?? v.displayValue;
  if (v?.status) return v.status.name ?? v.displayValue;
  return v?.displayValue ?? v?.value ?? null;
}

/**
 * Compact object: identity plus `attributes: {Name: value | [values]}`.
 * `names` maps objectTypeAttributeId → name when the response does not embed the definition.
 * `only` keeps just those attribute names (case-insensitive).
 */
export function compactObject(o: any, names?: Map<number, string>, only?: string[]): Record<string, unknown> {
  const wanted = only?.length ? new Set(only.map((n) => n.toLowerCase())) : undefined;
  const attributes: Record<string, unknown> = {};
  for (const a of o?.attributes ?? []) {
    const name = a.objectTypeAttribute?.name ?? names?.get(a.objectTypeAttributeId) ?? `#${a.objectTypeAttributeId}`;
    if (["Key", "Created", "Updated"].includes(name) && !wanted) continue; // already in the identity / noise
    if (wanted && !wanted.has(name.toLowerCase())) continue;
    const values = (a.objectAttributeValues ?? []).map(valueOf).filter((v: unknown) => v !== null && v !== "");
    if (values.length === 0) continue;
    attributes[name] = values.length === 1 ? values[0] : values;
  }
  return {
    id: o?.id,
    key: o?.objectKey,
    label: o?.label,
    type: o?.objectType?.name,
    updated: o?.updated,
    attributes,
  };
}

// -- attribute definitions and name resolution --------------------------------

const attrCache = new WeakMap<AtlassianClient, Map<number, Promise<any[]>>>();

/** All attribute definitions of an object type (including inherited ones), cached per client. */
export function typeAttributes(client: AtlassianClient, objectTypeId: number): Promise<any[]> {
  let byType = attrCache.get(client);
  if (!byType) attrCache.set(client, (byType = new Map()));
  let p = byType.get(objectTypeId);
  if (!p) {
    p = client.get(`${assetsBase()}/objecttype/${objectTypeId}/attributes`).then((r: any) => r ?? []);
    byType.set(objectTypeId, p);
  }
  return p;
}

export async function attributeNames(client: AtlassianClient, objectTypeIds: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  const lists = await boundedAll([...new Set(objectTypeIds)].map((id) => () => typeAttributes(client, id)));
  for (const list of lists) for (const a of list) names.set(a.id, a.name);
  return names;
}

/**
 * {"Name": "x", "Owner": ["a","b"], "123": "by id"} → ObjectAttributeInEntry[].
 * Values are passed through as Assets expects them: text/number/date as strings,
 * references as object keys (or ids), users as usernames/keys, select as option text.
 * `null` or [] clears the attribute.
 */
export async function buildAttributes(
  client: AtlassianClient,
  objectTypeId: number,
  values: Record<string, unknown>,
): Promise<Array<{ objectTypeAttributeId: number; objectAttributeValues: Array<{ value: string }> }>> {
  const defs = await typeAttributes(client, objectTypeId);
  const byName = new Map(defs.map((a: any) => [String(a.name).toLowerCase(), a]));
  const byId = new Map(defs.map((a: any) => [String(a.id), a]));
  const unknown: string[] = [];
  const out = [];
  for (const [name, raw] of Object.entries(values)) {
    const def = byName.get(name.toLowerCase()) ?? byId.get(name);
    if (!def) {
      unknown.push(name);
      continue;
    }
    if (def.editable === false || ["Key", "Created", "Updated"].includes(def.name)) {
      throw new ValidationError(`Attribute '${def.name}' is not editable`);
    }
    const list = raw === null || raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    out.push({ objectTypeAttributeId: def.id, objectAttributeValues: list.map((v) => ({ value: String(v) })) });
  }
  if (unknown.length) {
    throw new ValidationError(
      `Unknown attribute(s) for object type ${objectTypeId}: ${unknown.join(", ")}. ` +
        `Known: ${defs.filter((a: any) => a.editable !== false).map((a: any) => a.name).join(", ")}`,
    );
  }
  return out;
}

/** Resolve an object type id from an id or "Name" within a schema. */
export async function resolveObjectTypeId(client: AtlassianClient, objectType: string | number, schemaId?: number): Promise<number> {
  if (typeof objectType === "number" || /^\d+$/.test(String(objectType))) return Number(objectType);
  if (schemaId === undefined) throw new ValidationError("object_type given by name needs schema_id (or pass the numeric id)");
  const types: any[] = (await client.get(`${assetsBase()}/objectschema/${schemaId}/objecttypes/flat`)) ?? [];
  const match = types.filter((t) => String(t.name).toLowerCase() === String(objectType).toLowerCase());
  if (match.length !== 1) {
    throw new ValidationError(
      match.length === 0
        ? `No object type '${objectType}' in schema ${schemaId}`
        : `Object type name '${objectType}' is ambiguous in schema ${schemaId}: ids ${match.map((t) => t.id).join(", ")}`,
    );
  }
  return match[0].id;
}

/** Load an object (id or key) without its attributes. */
export async function loadObject(client: AtlassianClient, idOrKey: string | number, withAttributes = false): Promise<any> {
  return client.get(`${assetsBase()}/object/${seg(idOrKey)}`, { includeAttributes: withAttributes, includeExtendedInfo: false });
}
