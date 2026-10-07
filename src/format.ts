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
/** Longest text value of a single-object result (descriptions, bodies) unless ATLASSIAN_MAX_TEXT_CHARS says otherwise. */
const DEFAULT_MAX_TEXT = 8_000;
/** Follow-up requests listed by a compact dry run; the rest are counted. */
const MAX_FOLLOW_UPS = 5;
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
 * Field projection for rows (`items` of a page or a top-level array) and single objects:
 * - no `--fields`: the tool's default columns when it declares them, otherwise everything;
 * - `--fields=a,b`: exactly those fields; `--fields=-a`: everything (or the defaults) without a;
 * - `--fields=+a`: the default columns plus a; `--fields=all`: every field.
 */
export function projectFields(value: unknown, spec?: string, defaults?: string[]): unknown {
  if (spec?.trim() === "all") return value;
  const parts = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const exclude = new Set(parts.filter((p) => p.startsWith("-")).map((p) => p.slice(1)));
  const exact = parts.filter((p) => !p.startsWith("-") && !p.startsWith("+"));
  const plus = parts.filter((p) => p.startsWith("+")).map((p) => p.slice(1));
  // exact fields win; otherwise the defaults (if any) plus the added ones
  const include = exact.length ? exact : defaults?.length ? [...defaults, ...plus] : [];
  if (!include.length && !exclude.size) return value;
  const apply = (o: unknown) => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) return o;
    const entries = Object.entries(o as Record<string, unknown>);
    return Object.fromEntries(entries.filter(([k]) => (include.length === 0 || include.includes(k)) && !exclude.has(k)));
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

function maxText(): number {
  const n = Number(process.env.ATLASSIAN_MAX_TEXT_CHARS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_TEXT;
}

/** Narrowing arguments of the tool being rendered; cut markers name them. */
let narrowingArgs: string[] | undefined;
const moreHint = () => (narrowingArgs?.length ? `narrow with ${narrowingArgs.join("|")} or --format=json` : "--format=json shows all");

const cut = (text: string, max: number) => {
  if (text.length <= max) return text;
  let end = max;
  while (end > 0 && end + `…(+${text.length - end})`.length > max) end--;
  return `${text.slice(0, end)}…(+${text.length - end})`;
};

/** Long text of a single object: cut at the last line break before `max` (or at `max`), with what was left out. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const nl = text.lastIndexOf("\n", max);
  const end = nl > max / 2 ? nl : max;
  return `${text.slice(0, end)}\n…(+${text.length - end} chars; ${moreHint()})`;
}

/** One value on one line, at most `max` characters: arrays end with `+N more`, other cuts with `…(+N)`. */
function inline(v: unknown, max = Infinity): string {
  if (v === undefined || v === null) return "";
  if (isScalar(v)) return cut(String(v).replace(/\s*\n\s*/g, " ⏎ "), max);
  if (Array.isArray(v)) {
    let out = "";
    for (let i = 0; i < v.length; i++) {
      const part = inline(v[i], max);
      const next = out ? `${out},${part}` : part;
      const suffix = i < v.length - 1 ? `,+${v.length - i - 1} more` : "";
      if (next.length + suffix.length > max) {
        const marker = `${out ? "," : ""}+${v.length - i} more`;
        return out ? `${out}${marker}` : `${cut(part, Math.max(0, max - marker.length))}${marker}`;
      }
      out = next;
    }
    return cut(out, max);
  }
  // nested object in a cell: k=v pairs
  return cut(Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}=${inline(x, max)}`).join(" "), max);
}

/** Rows with a shared header: `# key | name | type` then `FDP | Finance | software`. */
function rows(items: unknown[]): string[] {
  if (items.length === 0) return ["(none)"];
  if (items.every((i) => !i || typeof i !== "object" || Array.isArray(i))) return items.map((i) => inline(i, maxText())); // map's index must not become `max`
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
    if (scalars.length) lines.push(`${indent}${scalars.map(([k, v]) => `${k}:${inline(v, maxText())}`).join(" ")}`);
    obj = Object.fromEntries(entries.filter(([k]) => !scalars.some(([sk]) => sk === k)));
  }
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && (v.includes("\n") || v.length > maxText())) {
      // a text block: bounded, and without an extra indent on every line
      lines.push(`${indent}${k}:`, ...cutText(v, maxText()).split("\n").map((l) => `${indent}${l}`));
    } else if (isScalar(v) || (Array.isArray(v) && v.every(isScalar))) {
      lines.push(`${indent}${k}: ${inline(v, maxText())}`);
    } else if (Array.isArray(v)) {
      lines.push(`${indent}${k} (${v.length}):`, ...rows(v).map((l) => `${indent}  ${l}`));
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v as Record<string, unknown>);
      if (entries.every(([, x]) => isScalar(x) || (Array.isArray(x) && x.every(isScalar)))) {
        lines.push(`${indent}${k}: ${entries.map(([a, b]) => `${a}=${inline(b, maxText())}`).join(" | ")}`);
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
    parts.push(`${k}:${typeof v === "string" ? cutText(v, maxText()) : v}`);
  }
  return parts.join(" ");
}

/** Dry-run keys that are rendered elsewhere or are plan internals (digest material). */
const DRY_RUN_SKIP = new Set(["dry_run", "product", "summary", "request", "followUps", "identity", "state", "warning", "manual"]);
/** Longest line and longest list a compact dry run shows for a tool-provided field. */
const MAX_EVIDENCE_LINE = 300;
const MAX_EVIDENCE_ITEMS = 20;
const GENERIC_NOTE = /^Nothing (was )?changed\b/;

/** Shorten lists (recursively) to MAX_EVIDENCE_ITEMS; reports how many items each cut list lost. */
function capLists(v: unknown, path: string, cuts: string[]): unknown {
  if (Array.isArray(v)) {
    if (v.length > MAX_EVIDENCE_ITEMS) cuts.push(`+${v.length - MAX_EVIDENCE_ITEMS} more in ${path}`);
    return v.slice(0, MAX_EVIDENCE_ITEMS).map((x) => capLists(x, path, cuts));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, capLists(x, `${path}.${k}`, cuts)]));
  }
  return v;
}

/** The tool's own dry-run evidence (before/after, target, differences...), bounded per line and per list. */
function evidenceLines(r: Record<string, any>): string[] {
  const lines: string[] = [];
  for (const [k, raw] of Object.entries(r)) {
    if (DRY_RUN_SKIP.has(k)) continue;
    if (k === "note" && typeof raw === "string" && GENERIC_NOTE.test(raw)) continue;
    const v = prune(raw, true);
    if (isEmpty(v)) continue;
    const cuts: string[] = [];
    const capped = capLists(v, k, cuts);
    for (const line of objectLines({ [k]: capped })) {
      lines.push(line.length > MAX_EVIDENCE_LINE ? `${line.slice(0, MAX_EVIDENCE_LINE)}…(--format=json)` : line);
    }
    for (const cut of cuts) lines.push(`  ${cut} (--format=json)`);
  }
  return lines;
}

/** Write results: one line (P10); dry runs add the request and the tool's evidence. */
function writeResult(r: Record<string, any>): string {
  const req = r.request ?? {};
  if (r.dry_run) {
    const lines = [`DRY-RUN | ${r.summary}`, `${req.method} ${req.url}`];
    if (req.body !== undefined) {
      const body = JSON.stringify(req.body);
      lines.push(body.length > MAX_BODY ? `body: ${body.slice(0, MAX_BODY)}…(+${body.length - MAX_BODY} chars; --format=json shows all)` : `body: ${body}`);
    }
    if (req.files) lines.push(`files: ${req.files.map((f: any) => `${f.name} (${f.bytes} B)`).join(", ")}`);
    const followUps: any[] = r.followUps ?? [];
    for (const step of followUps.slice(0, MAX_FOLLOW_UPS)) {
      const body = step.body === undefined ? "" : ` ${JSON.stringify(step.body)}`;
      lines.push(`then${step.label ? ` (${step.label})` : ""}: ${step.method} ${step.url}${body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body}`);
    }
    if (followUps.length > MAX_FOLLOW_UPS) lines.push(`+${followUps.length - MAX_FOLLOW_UPS} more (--format=json shows all)`);
    if (r.warning) lines.push(`warning: ${r.warning}`);
    lines.push(...evidenceLines(r));
    if (r.manual) {
      lines.push(`manual change: ${r.manual.reason}`);
      lines.push("Nothing is sent. Enter the change in the Jira UI, then re-run to verify.");
      return lines.join("\n");
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

function isAlreadySatisfiedResult(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && (v as any).already_satisfied === true;
}

export function toCompact(value: unknown): string {
  if (isAlreadySatisfiedResult(value)) return `ALREADY-SATISFIED | ${value.summary} | ${value.reason}`;
  if (isWriteResult(value)) return writeResult(value);
  const v = prune(value);
  if (v === undefined || v === null || (typeof v === "object" && isEmpty(v))) return "(empty)";
  if (isScalar(v)) return String(v);
  if (Array.isArray(v)) return rows(v).join("\n");
  if (isPage(v)) {
    // summary fields of a page that are not scalars (a usage summary, a parent object) come before the rows
    const extras = Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== "items" && !isScalar(x)));
    return [pageHeader(v), ...(isEmpty(extras) ? [] : objectLines(extras)), ...rows(v.items)].join("\n");
  }
  return objectLines(v as Record<string, unknown>).join("\n");
}

/**
 * Render a successful result in the chosen format. `narrowing` names the tool's arguments that read less
 * (section, max_chars...); compact cut markers point to them.
 */
export function render(value: unknown, format: OutputFormat, fields?: string, defaultFields?: string[], narrowing?: string[]): string {
  if (format === "full") return JSON.stringify(value ?? null);
  if (isAlreadySatisfiedResult(value)) return format === "json" ? JSON.stringify(prune(value)) : toCompact(value);
  if (isWriteResult(value)) return format === "json" ? JSON.stringify(prune(value)) : writeResult(value);
  // default columns trim compact text only: JSON is for exact values and keeps every field unless --fields narrows it
  const projected = projectFields(prune(value), fields, format === "json" ? undefined : defaultFields);
  if (format === "json") return JSON.stringify(projected ?? null);
  narrowingArgs = narrowing;
  try {
    return toCompact(projected);
  } finally {
    narrowingArgs = undefined;
  }
}

/**
 * The three largest parts of a rendered result, for the ResponseTooLarge message: top-level fields of an
 * object, or columns of a list. Sizes only, never content.
 */
export function largestParts(value: unknown, format: OutputFormat, fields?: string, defaultFields?: string[]): Array<{ part: string; chars: number }> {
  const v = projectFields(prune(value), fields, format === "json" ? undefined : defaultFields);
  if (!v || typeof v !== "object") return [];
  const sizeOf = (x: unknown) => (format === "compact" ? inline(x, MAX_CELL).length : JSON.stringify(x ?? null).length);
  let parts: Array<{ part: string; chars: number }>;
  if (Array.isArray(v) || isPage(v)) {
    const columns = new Map<string, number>();
    for (const item of Array.isArray(v) ? v : v.items) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      for (const [k, x] of Object.entries(item)) columns.set(k, (columns.get(k) ?? 0) + sizeOf(x));
    }
    parts = [...columns].map(([part, chars]) => ({ part, chars }));
  } else {
    const whole = (x: unknown, k: string) => (format === "compact" ? objectLines({ [k]: x }).join("\n").length : JSON.stringify(x ?? null).length);
    parts = Object.entries(v as Record<string, unknown>).map(([part, x]) => ({ part, chars: whole(x, part) }));
  }
  return parts.sort((a, b) => b.chars - a.chars).slice(0, 3);
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
  if (err.type === "AuthenticationRequired") return EXIT.AUTH;
  if (err.type === "WebSudoRequired") return EXIT.PERMISSION;
  if (err.type === "NetworkError" || err.type === "UpstreamError") return EXIT.NETWORK;
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
