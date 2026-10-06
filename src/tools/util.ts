/**
 * Shared helpers for tool handlers.
 *
 * Filters and pagination are adapted from mcp-atlassian-for-admins
 * (src/tools/util.ts, MIT); the dry-run write guard is new.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type { AtlassianClient, Json, Params } from "../client.js";
import { ValidationError } from "../errors.js";

// -- filters and pagination ---------------------------------------------------

export const nameFilterShape = {
  name_contains: z.string().optional().describe("Only items whose name contains this text (case-insensitive)"),
};

export function contains(value: unknown, needle?: string): boolean {
  return !needle || String(value ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function filterByName<T extends { name?: unknown }>(items: T[], needle?: string): T[] {
  return needle ? items.filter((it) => contains(it.name, needle)) : items;
}

/** Upper bound for any page size a tool requests from the server or returns. */
export const MAX_PAGE = 500;

export function pageShape(defaultLimit: number) {
  return {
    offset: z.coerce.number().int().min(0).optional()
      .describe("Number of items to skip (default 0). Use nextOffset from the previous page."),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional()
      .describe(`Maximum number of items to return (default ${defaultLimit}, max ${MAX_PAGE})`),
  };
}

/** One page of a listing. `nextOffset` is null on the last page; `total` is null when the server does not report it. */
export interface Page<T> {
  total: number | null;
  offset: number;
  returned: number;
  nextOffset: number | null;
  items: T[];
}

/** Slice an already-fetched list into a Page. */
export function paginate<T>(items: T[], args: { offset?: number; limit?: number }, defaultLimit: number): Page<T> {
  const offset = Math.max(0, args.offset ?? 0);
  const limit = Math.max(1, args.limit ?? defaultLimit);
  const slice = items.slice(offset, offset + limit);
  const end = offset + slice.length;
  return { total: items.length, offset, returned: slice.length, nextOffset: end < items.length ? end : null, items: slice };
}

/** Wrap a page the server already sliced. */
export function serverPage<T>(items: T[], offset: number, limit: number, total?: number | null, isLast?: boolean): Page<T> {
  const end = offset + items.length;
  const last = isLast ?? (total != null ? end >= total : items.length < limit);
  return { total: total ?? null, offset, returned: items.length, nextOffset: last || items.length === 0 ? null : end, items };
}

// -- argument helpers ---------------------------------------------------------

/** Accepts an array or a comma-separated string. */
export const listArg = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean)));

/** Lenient boolean: true/false, "true"/"false", 1/0, "yes"/"no". */
export const boolArg = z.preprocess((v) => {
  if (typeof v === "string") return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
  if (typeof v === "number") return v !== 0;
  return v;
}, z.boolean());

// -- guarded writes -----------------------------------------------------------

export const dryRunShape = {
  dry_run: boolArg.optional().describe(
    "Default true: only describe the request. Set false to actually change the instance (after the user confirmed).",
  ),
};

export interface WriteRequest {
  method: "POST" | "PUT" | "DELETE";
  path: string;
  params?: Params;
  json?: Json;
  contentType?: string;
  summary: string;
  /** Body keys to mask in the echoed request (e.g. password). */
  secretKeys?: string[];
  /** Extra headers for this request only. */
  headers?: Record<string, string>;
  /** Local files sent as multipart/form-data (attachments), all under one field name. */
  files?: { field: string; paths: string[] };
}

/** Resolve local files for upload; fails early (also in dry run) when one is missing. */
function describeFiles(files: { field: string; paths: string[] }) {
  return files.paths.map((p) => {
    const full = resolve(p);
    if (!existsSync(full) || !statSync(full).isFile()) throw new ValidationError(`File not found: ${p}`);
    return { field: files.field, path: full, name: basename(full), bytes: statSync(full).size };
  });
}

/**
 * Execute a state-changing request, or only describe it when dry_run is not
 * explicitly false. Every write tool goes through here.
 */
export async function guardedWrite(client: AtlassianClient, args: { dry_run?: boolean }, req: WriteRequest) {
  const echoedBody =
    req.json && typeof req.json === "object" && !Array.isArray(req.json) && req.secretKeys?.length
      ? Object.fromEntries(Object.entries(req.json).map(([k, v]) => [k, req.secretKeys!.includes(k) ? "***" : v]))
      : req.json;
  const fileList = req.files ? describeFiles(req.files) : undefined;
  const request: Record<string, unknown> = { method: req.method, url: client.url(req.path, req.params), body: echoedBody };
  if (fileList) request.files = fileList.map(({ name, bytes }) => ({ name, bytes }));

  if (args.dry_run !== false) {
    return {
      dry_run: true,
      product: client.product,
      summary: req.summary,
      request,
      note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
    };
  }
  let form: FormData | undefined;
  if (fileList) {
    form = new FormData();
    for (const f of fileList) form.append(f.field, new Blob([readFileSync(f.path)]), f.name);
  }
  const result = await client.request(req.method, req.path, {
    params: req.params,
    json: form ? undefined : req.json,
    form,
    contentType: req.contentType,
    headers: req.headers,
  });
  return { dry_run: false, product: client.product, summary: req.summary, request, result: result ?? null };
}

/** Result of a write whose target state already holds: nothing to send, nothing to approve. */
export interface AlreadySatisfied {
  already_satisfied: true;
  summary: string;
  reason: string;
  [k: string]: unknown;
}

export function alreadySatisfied(summary: string, reason: string, extra: Record<string, unknown> = {}): AlreadySatisfied {
  return { already_satisfied: true, summary, reason, ...extra };
}

export function isAlreadySatisfied(v: unknown): v is AlreadySatisfied {
  return !!v && typeof v === "object" && (v as any).already_satisfied === true;
}

/** Pick a subset of keys, skipping missing ones. */
export function pick<T extends Record<string, any>>(obj: T | undefined | null, keys: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  if (!obj) return out;
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/** Run a promise, returning `{error}` instead of throwing (for multi-part reports). */
export async function settle<T>(p: Promise<T>): Promise<T | { error: string }> {
  try {
    return await p;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
