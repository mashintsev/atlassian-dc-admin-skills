/**
 * Token-efficient output for agents.
 *
 * The approach follows eunsanMountain/atlassian-skills (MIT, docs/mcp-analysis.md):
 * a `compact` text format by default (pipe-separated rows, flattened values,
 * date-only/minute timestamps, one-line write results) and a pruned JSON format,
 * both dropping fields an LLM never uses — the waste catalogue P1–P11 there:
 * self/avatar URLs, expand hints, `_links`, empty values, `{name}` wrappers,
 * millisecond/timezone timestamps, full resources echoed back on writes.
 */

export type OutputFormat = "compact" | "json" | "full";
export const OUTPUT_FORMATS: OutputFormat[] = ["compact", "json", "full"];

/** Keys that never help reasoning (P1, P7, P9, P11). */
const DROP_KEYS = new Set([
  "self", "avatarUrls", "avatarUrl", "avatar_url", "avatarId", "iconUrl", "icon_url", "expand", "_links", "_expandable",
  "profilePicture", "links",
]);

/**
 * Descriptive metadata that rides along with a name in nested references (users, statuses,
 * priorities...). A nested object made only of a name plus these keys is replaced by its name.
 */
const REF_METADATA = new Set([
  "id", "key", "display_name", "displayName", "email", "emailAddress", "active", "timeZone", "locale",
  "category", "color", "colorName", "statusCategory", "description", "subtask", "hierarchyLevel", "type", "accountType",
]);

/** Longest cell kept in list rows; the full value stays available with --format=json or a get_* tool. */
const MAX_CELL = 160;
/** Longest request body echoed by a compact dry run. */
const MAX_BODY = 500;

/** Keys whose object value is replaced by its human name (P2). */
const NAME_KEYS = ["name", "displayName", "value", "title", "key"];

const ISO_TS = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function shortTimestamp(s: string): string {
  const m = ISO_TS.exec(s);
  if (!m) return s;
  return m[2] === "00:00" ? m[1] : `${m[1]} ${m[2]}`; // P8
}

function isEmpty(v: unknown): boolean {
  return (
    v === null || v === undefined || v === "" ||
    (Array.isArray(v) && v.length === 0) ||
    (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0)
  );
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Remove LLM-irrelevant data recursively: drop keys, empty values (P4), shorten timestamps (P8),
 * and flatten identity-only objects to their name (P2). An object that carries an `id`/`key`
 * is flattened only when it is a field of a parent object (status, author, lead...), never when
 * it is a list element or the root, because those ids are what the next call needs.
 */
export function prune(value: unknown, asField = false): unknown {
  if (typeof value === "string") return shortTimestamp(value);
  if (Array.isArray(value)) return value.map((v) => prune(v, false)).filter((v) => !isEmpty(v));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue;
    const pv = prune(v, true);
    if (isEmpty(pv)) continue;
    out[k] = pv;
  }
  const keys = Object.keys(out);
  const nameKey = NAME_KEYS.find((k) => typeof out[k] === "string" && k !== "key" && k !== "value");
  // username beats display name for people: it is what the next call needs
  const label = typeof out.name === "string" ? out.name : nameKey ? (out[nameKey] as string) : undefined;
  const nameOnly = keys.length > 0 && keys.every((k) => ["name", "displayName", "value", "title"].includes(k));
  const reference = asField && label !== undefined && keys.every((k) => k === nameKey || k === "name" || REF_METADATA.has(k));
  if (nameOnly || reference) {
    for (const nk of NAME_KEYS) if (typeof out[nk] === "string") return out[nk];
  }
  return out;
}

// -- field projection -----------------------------------------------------------

/**
 * `--fields=a,b` keeps only those fields, `--fields=-a,-b` removes them,
 * `--fields=+a` is accepted as "keep the defaults" (fields come from the pruned result).
 * Applies to rows (`items` of a page or a top-level array) and to single objects.
 */
export function projectFields(value: unknown, spec?: string): unknown {
  if (!spec) return value;
  const parts = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const exclude = new Set(parts.filter((p) => p.startsWith("-")).map((p) => p.slice(1)));
  const include = parts.filter((p) => !p.startsWith("-") && !p.startsWith("+")).map((p) => p.replace(/^\+/, ""));
  const apply = (o: unknown) => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return o;
    const entries = Object.entries(o as Record<string, unknown>);
    return Object.fromEntries(
      entries.filter(([k]) => (include.length === 0 || include.includes(k)) && !exclude.has(k)),
    );
  };
  if (Array.isArray(value)) return value.map(apply);
  if (isPage(value)) return { ...value, items: value.items.map(apply) };
  return apply(value);
}

// -- compact text ---------------------------------------------------------------

interface PageLike {
  items: unknown[];
  total?: unknown;
  offset?: unknown;
  returned?: unknown;
  nextOffset?: unknown;
  [k: string]: unknown;
}

function isPage(v: unknown): v is PageLike {
  return !!v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as any).items);
}

function inline(v: unknown, max = Infinity): string {
  if (v === undefined || v === null) return "";
  if (isScalar(v)) {
    const text = String(v).replace(/\s*\n\s*/g, " ⏎ ");
    return text.length > max ? `${text.slice(0, max)}…(+${text.length - max})` : text;
  }
  if (Array.isArray(v)) return v.map(inline).join(",");
  // nested object in a cell: k=v pairs
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${inline(x)}`).join(" ");
}

/** Rows with a shared header: `# key | name | type` then `FDP | Finance | software`. */
function rows(items: unknown[]): string[] {
  if (items.length === 0) return ["(none)"];
  if (items.every((i) => !i || typeof i !== "object" || Array.isArray(i))) return items.map(inline);
  const columns: string[] = [];
  for (const item of items as Record<string, unknown>[]) {
    for (const k of Object.keys(item ?? {})) if (!columns.includes(k)) columns.push(k);
  }
  const lines = [`# ${columns.join(" | ")}`];
  for (const item of items as Record<string, unknown>[]) lines.push(columns.map((c) => inline(item?.[c], MAX_CELL)).join(" | "));
  return lines;
}

function objectLines(obj: Record<string, unknown>, indent = ""): string[] {
  const lines: string[] = [];
  const entries = Object.entries(obj);
  // a wrapper like {total, start_at, issues:[...]}: scalars on one line, then the rows
  const hasRows = entries.some(([, v]) => Array.isArray(v) && v.some((x) => x && typeof x === "object"));
  if (hasRows) {
    const scalars = entries.filter(([, v]) => isScalar(v) && !(typeof v === "string" && v.includes("\n")));
    if (scalars.length) lines.push(`${indent}${scalars.map(([k, v]) => `${k}:${inline(v)}`).join(" ")}`);
    obj = Object.fromEntries(entries.filter(([k]) => !scalars.some(([sk]) => sk === k)));
  }
  for (const [k, v] of Object.entries(obj)) {
    if (isScalar(v) && typeof v === "string" && v.includes("\n")) {
      lines.push(`${indent}${k}:`, ...v.split("\n").map((l) => `${indent}  ${l}`));
    } else if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) {
      lines.push(`${indent}${k}: ${inline(v)}`);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${k} (${v.length}):`, ...rows(v).map((l) => `${indent}  ${l}`));
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.every(([, x]) => isScalar(x) || (Array.isArray(x) && x.every(isScalar)))) {
        lines.push(`${indent}${k}: ${entries.map(([a, b]) => `${a}=${inline(b)}`).join(" | ")}`);
      } else {
        lines.push(`${indent}${k}:`, ...objectLines(v as Record<string, unknown>, `${indent}  `));
      }
    }
  }
  return lines;
}

function pageHeader(p: PageLike): string {
  const parts = [`total:${p.total ?? "?"}`, `offset:${p.offset ?? 0}`, `returned:${p.returned ?? p.items.length}`];
  parts.push(p.nextOffset === null || p.nextOffset === undefined ? "last" : `next:${p.nextOffset}`);
  for (const [k, v] of Object.entries(p)) {
    if (["items", "total", "offset", "returned", "nextOffset"].includes(k) || !isScalar(v)) continue;
    parts.push(`${k}:${v}`);
  }
  return parts.join(" ");
}

/** Write results: one line (P10). */
function writeResult(r: Record<string, any>): string {
  const req = r.request ?? {};
  if (r.dry_run) {
    const lines = [`DRY-RUN | ${r.summary}`, `${req.method} ${req.url}`];
    if (req.body !== undefined) {
      const body = JSON.stringify(req.body);
      lines.push(body.length > MAX_BODY ? `body: ${body.slice(0, MAX_BODY)}…(+${body.length - MAX_BODY} chars; --format=json shows all)` : `body: ${body}`);
    }
    if (req.files) lines.push(`files: ${req.files.map((f: any) => `${f.name} (${f.bytes} B)`).join(", ")}`);
    for (const step of r.followUps ?? []) {
      const body = step.body === undefined ? "" : ` ${JSON.stringify(step.body)}`;
      lines.push(`then${step.label ? ` (${step.label})` : ""}: ${step.method} ${step.url}${body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body}`);
    }
    lines.push("Nothing changed. After user approval re-run with dry_run=false.");
    return lines.join("\n");
  }
  const result = prune(r.result);
  const id = result && typeof result === "object" && !Array.isArray(result)
    ? ["key", "id", "name", "taskId"].map((k) => (result as any)[k]).find((x) => isScalar(x))
    : isScalar(result) ? result : undefined;
  return `OK | ${r.summary}${id !== undefined ? ` | ${id}` : ""}`;
}

function isWriteResult(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && "dry_run" in (v as object) && "request" in (v as object);
}

export function toCompact(value: unknown): string {
  if (isWriteResult(value)) return writeResult(value);
  const v = prune(value);
  if (v === undefined || v === null || (typeof v === "object" && isEmpty(v))) return "(empty)";
  if (isScalar(v)) return String(v);
  if (Array.isArray(v)) return rows(v).join("\n");
  if (isPage(v)) return [pageHeader(v), ...rows(v.items)].join("\n");
  return objectLines(v as Record<string, unknown>).join("\n");
}

/** Render a successful result in the chosen format. */
export function render(value: unknown, format: OutputFormat, fields?: string): string {
  if (format === "full") return JSON.stringify(value ?? null);
  if (isWriteResult(value)) return format === "json" ? JSON.stringify(prune(value)) : writeResult(value);
  const projected = projectFields(prune(value), fields);
  return format === "json" ? JSON.stringify(projected ?? null) : toCompact(projected);
}

// -- errors and exit codes --------------------------------------------------------

/** Exit codes, as in eunsanMountain/atlassian-skills (core/errors.py ExitCode). */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  NOT_FOUND: 2,
  PERMISSION: 3,
  CONFLICT: 4,
  STALE: 5,
  AUTH: 6,
  VALIDATION: 7,
  NETWORK: 10,
  RATE_LIMITED: 11,
  DECLINED: 12,
  CONFIRMATION_UNAVAILABLE: 13,
} as const;

export interface ToolError {
  type: string;
  message: string;
  status?: number;
  hint?: string;
  [k: string]: unknown;
}

export function exitCodeFor(err: ToolError): number {
  switch (err.status) {
    case 401: return EXIT.AUTH;
    case 403: return EXIT.PERMISSION;
    case 404: return EXIT.NOT_FOUND;
    case 409: return EXIT.CONFLICT;
    case 429: return EXIT.RATE_LIMITED;
  }
  if (err.type === "ValidationError" || err.type === "ConfigurationError" || err.type === "UsageError") return EXIT.VALIDATION;
  if (err.type === "NetworkError") return EXIT.NETWORK;
  if (err.type === "StaleVersion") return EXIT.STALE;
  if (err.type === "ConfirmationDeclined") return EXIT.DECLINED;
  if (err.type === "ConfirmationUnavailable") return EXIT.CONFIRMATION_UNAVAILABLE;
  return EXIT.GENERIC;
}

export function renderError(err: ToolError, format: OutputFormat): string {
  if (format !== "compact") return JSON.stringify({ success: false, error: err.message, error_type: err.type, ...omit(err, ["type", "message"]) });
  const lines = [`ERROR ${err.type}${err.status ? ` ${err.status}` : ""} | ${err.message}`];
  if (Array.isArray(err.issues)) lines.push(...(err.issues as string[]).map((i) => `  ${i}`));
  if (err.hint) lines.push(`hint: ${err.hint}`);
  return lines.join("\n");
}

function omit(o: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));
}
