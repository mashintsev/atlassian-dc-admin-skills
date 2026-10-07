/**
 * Issue type references: an issue type argument may be its id or its exact name (case-insensitive).
 * Names let a plan refer to an issue type that an earlier plan item creates; until it exists, a dry
 * run may get a pending reference whose plan identity is the name.
 */

import type { AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";

export interface IssueTypeRef {
  /** Resolved id; undefined while the issue type does not exist yet (pending). */
  id?: string;
  name?: string;
  /** How the type appears in a plan's identity: the id as given, or {issueType: name as given} when given by name. */
  ref: string | { issueType: string };
  pending?: boolean;
}

/** Placeholder shown in a dry run for an issue type that an earlier plan item creates. */
export const issueTypePlaceholder = (name: string) => `<issue type "${name}">`;

/**
 * Resolve an issue type by id (digits, no lookup) or exact name against the global list, or against
 * `within` (for example a project's issue types) when given.
 */
export async function resolveIssueType(
  client: AtlassianClient,
  given: string,
  opts: { allowPending?: boolean; within?: any[] } = {},
): Promise<IssueTypeRef> {
  const v = String(given).trim();
  if (/^\d+$/.test(v) && !opts.within) return { id: v, ref: v };
  const types: any[] = opts.within ?? (((await client.get("/rest/api/2/issuetype")) as any[]) ?? []);
  const byId = types.find((t) => String(t.id) === v);
  if (byId) return { id: String(byId.id), name: byId.name, ref: v };
  const byName = types.filter((t) => String(t.name).toLowerCase() === v.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`Issue type name '${v}' is ambiguous (${byName.map((t) => t.id).join(", ")}); pass the id`);
  // the identity keeps the name as typed: a pending reference used it too, and the server's spelling may differ in case
  if (byName.length === 1) return { id: String(byName[0].id), name: byName[0].name, ref: { issueType: v } };
  // only a name can refer to an issue type a later plan item creates; an unknown id is an error
  if (opts.allowPending && !/^\d+$/.test(v)) return { name: v, ref: { issueType: v }, pending: true };
  throw new ValidationError(`No issue type '${v}'${opts.within ? " in this project" : ""}`);
}
