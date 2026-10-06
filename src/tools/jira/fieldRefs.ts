/**
 * Field references: a field argument may be a custom field id, a system field id,
 * or the exact field name (case-insensitive). Names let a plan refer to a field that
 * an earlier plan item creates; until it exists, a dry run gets a pending reference.
 */

import type { AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";

export interface FieldRef {
  /** Resolved field id; undefined while the field does not exist yet (pending). */
  id?: string;
  name?: string;
  custom?: boolean;
  /** schema.custom for custom fields (the type key), schema.type otherwise. */
  type?: string;
  /** How the field appears in a plan's identity: the id, or {field: name} when given by name. */
  ref: string | { field: string };
  pending?: boolean;
}

export async function allFields(client: AtlassianClient): Promise<any[]> {
  return ((await client.get("/rest/api/2/field")) as any[]) ?? [];
}

export function describeField(f: any, ref: FieldRef["ref"]): FieldRef {
  return { id: f.id, name: f.name, custom: !!f.custom, type: f.schema?.custom ?? f.schema?.type, ref };
}

/**
 * Resolve a field argument. Ids match first; otherwise the name must match exactly one
 * field. With allowPending (dry runs only) an unknown name yields a pending reference.
 */
export async function resolveField(
  client: AtlassianClient,
  given: string,
  opts: { allowPending?: boolean; fields?: any[] } = {},
): Promise<FieldRef> {
  const value = String(given).trim();
  const fields = opts.fields ?? (await allFields(client));
  const byId = fields.find((f) => f.id === value);
  if (byId) return describeField(byId, value);
  if (/^customfield_\d+$/.test(value)) throw new ValidationError(`Field ${value} does not exist`);
  const byName = fields.filter((f) => String(f.name ?? "").toLowerCase() === value.toLowerCase());
  if (byName.length > 1) {
    throw new ValidationError(`Field name '${value}' is ambiguous: ${byName.map((f) => `${f.id} (${f.name})`).join(", ")}; pass the id`);
  }
  if (byName.length === 1) return describeField(byName[0], { field: value });
  if (opts.allowPending) return { ref: { field: value }, name: value, pending: true };
  throw new ValidationError(`Field '${value}' not found`);
}

/** Placeholder used in dry-run URLs and bodies for a field that does not exist yet. */
export function fieldPlaceholder(f: FieldRef): string {
  return f.id ?? `{${f.name}}`;
}
