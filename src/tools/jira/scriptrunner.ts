/**
 * ScriptRunner for Jira Data Center: read its configured items and enable/disable them or
 * change their notes.
 *
 * Adaptavist documents no public management API. These are the internal resources ScriptRunner's
 * own admin UI uses. The support matrix allows Jira 10.x/11.x with ScriptRunner 9.x/10.x.
 * Every call is preceded by discovery (Jira version, ScriptRunner version and state in UPM) and
 * refused outside those major versions. Outputs are built from per-type allowlists and then redacted
 * recursively, so script sources, code references, SQL and credentials never leave the tool.
 *
 * ScriptRunner saves an item only as a whole: the UI copies the stored item into its form and
 * posts it to `{restUrl}/{canned-script}`. A change therefore sends the stored item back with one
 * allowlisted key changed, and reads it back to prove that nothing else (executable parts above
 * all) changed. Nothing is created, deleted, duplicated, validated or run.
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { isHttpStatusError, UnsupportedError, ValidationError, VerificationError } from "../../errors.js";
import { jiraVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, pageShape, paginate } from "../util.js";

const SR = "/rest/scriptrunner/latest";
const SJ = "/rest/scriptrunner-jira/latest";
const PLUGIN_KEY = "com.onresolve.jira.groovy.groovyrunner";

/** Allowed version ranges and operations; `verified` records exact captured evidence only. */
export const SUPPORT_MATRIX: Array<{ jira: string; scriptrunner: string; verified?: string; operations: string[] }> = [
  // Script Editor reads and PUT/read-back checked on this pair; broader ranges are allowed by policy.
  { jira: "11.3.7", scriptrunner: "10.14.0", verified: "2026-10-07", operations: ["script-root-read", "script-root-write"] },
  ...["10.x", "11.x"].flatMap((jira) => ["9.x", "10.x"].map((scriptrunner) => ({
    jira, scriptrunner, operations: ["script-root-read", "script-root-write"],
  }))),
];

function matchesVersion(version: string, range: string): boolean {
  if (!range.endsWith(".x")) return version === range;
  const match = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  return !!match && `${match[1]}.x` === range;
}

function supportEntry(jira: string, scriptrunner: string) {
  return SUPPORT_MATRIX.find((m) => matchesVersion(jira, m.jira) && matchesVersion(scriptrunner, m.scriptrunner));
}

/** Like requireScriptRunner, and also requires `operation` to be allowed for the discovered pair. */
export async function requireScriptRunnerOperation(client: AtlassianClient, operation: string, label: string) {
  const v = await requireScriptRunner(client);
  const entry = supportEntry(v.jira, v.scriptrunner);
  if (!entry?.operations.includes(operation)) {
    throw new UnsupportedError(
      `${label} is not verified for Jira ${v.jira} + ScriptRunner ${v.scriptrunner}; its internal API needs a verification for this pair first`,
      { observedJira: v.jira, observedScriptRunner: v.scriptrunner, operation },
    );
  }
  return v;
}

/** Whether `operation` is allowed for the discovered pair; discovery failures still throw. */
export async function isScriptRunnerOperationVerified(client: AtlassianClient, operation: string): Promise<boolean> {
  const v = await requireScriptRunner(client);
  return !!supportEntry(v.jira, v.scriptrunner)?.operations.includes(operation);
}

// -- discovery ----------------------------------------------------------------------------

const discovered = new WeakMap<AtlassianClient, Promise<{ jira: string; scriptrunner: string }>>();

/** Jira and ScriptRunner versions, checked against the support matrix; fails closed. */
export function requireScriptRunner(client: AtlassianClient): Promise<{ jira: string; scriptrunner: string }> {
  let p = discovered.get(client);
  if (!p) {
    p = (async () => {
      const jira = await jiraVersion(client);
      let plugin: any;
      try {
        plugin = await client.get(`/rest/plugins/1.0/${PLUGIN_KEY}-key`, undefined, "application/vnd.atl.plugins.plugin+json");
      } catch (e) {
        if (isHttpStatusError(e) && e.status === 404) throw new UnsupportedError("ScriptRunner is not installed on this Jira");
        throw e; // 401/403 stay authorization errors; anything else stays a discovery error
      }
      if (typeof plugin?.version !== "string" || typeof plugin?.enabled !== "boolean") {
        throw new ValidationError("ScriptRunner discovery returned no version or state; refusing to call its resources");
      }
      if (!plugin.enabled) throw new UnsupportedError(`ScriptRunner ${plugin.version} is installed but disabled`);
      const ok = supportEntry(jira, plugin.version);
      if (!ok) {
        const pairs = SUPPORT_MATRIX.map((m) => `Jira ${m.jira} + ScriptRunner ${m.scriptrunner}`).join(", ");
        throw new UnsupportedError(
          `Jira ${jira} + ScriptRunner ${plugin.version} is outside the allowed version ranges (allowed: ${pairs})`,
          { observedJira: jira, observedScriptRunner: plugin.version },
        );
      }
      return { jira, scriptrunner: plugin.version };
    })();
    discovered.set(client, p);
    p.catch(() => discovered.delete(client));
  }
  return p;
}

// -- redaction --------------------------------------------------------------------------------

/** Keys that hold executable parts, code references, SQL or credentials. */
const SENSITIVE = /script|source|code|class_?name|classname|condition|do_?what|sql|password|secret|token|credential|jdbc|datasourceuser|parameters|pooloverrides|poolpropertyoverrides|configuration_script/i;

/** Remove sensitive keys at any depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SENSITIVE.test(k)).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

const shortKind = (c: unknown) => (typeof c === "string" ? c.split(".").pop() : undefined);
const iso = (ms: unknown) => (typeof ms === "number" ? new Date(ms).toISOString() : null);

// -- item types -----------------------------------------------------------------------------------

interface ItemType {
  base: string;
  label: string;
  name: (raw: any) => string;
  view: (raw: any) => Record<string, unknown>;
  /** allowlisted writable keys: logical name → stored key */
  writable: Partial<Record<"disabled" | "notes", string>>;
  readOnlyReason?: string;
}

const TYPES: Record<string, ItemType> = {
  job: {
    base: `${SR}/scheduled-jobs`,
    label: "scheduled job",
    name: (r) => r.name,
    view: (r) => ({ id: r.id, name: r.name, kind: shortKind(r["canned-script"]), schedule: [r.scheduleType, r.FIELD_INTERVAL].filter(Boolean).join(" "), runAs: r.FIELD_USER_ID ?? null, disabled: !!r.disabled, nextRun: iso(r.nextRunTime), notes: r.FIELD_NOTES ?? "" }),
    writable: { disabled: "disabled", notes: "FIELD_NOTES" },
  },
  listener: {
    base: `${SJ}/listeners`,
    label: "listener",
    name: (r) => r.name,
    view: (r) => ({ id: r.id, name: r.name, kind: shortKind(r["canned-script"]), events: r.friendlyEventNames ?? "", projects: (r.relatedProjects ?? []).map((p: any) => p.key ?? p).join(",") || (r.projects ?? []).join(","), notes: r.FIELD_LISTENER_NOTES ?? r.FIELD_NOTES ?? "" }),
    writable: { notes: "FIELD_LISTENER_NOTES" },
  },
  field: {
    base: `${SJ}/scriptfields`,
    label: "script field",
    name: (r) => r.name,
    view: (r) => ({ id: r.id, name: r.name, kind: shortKind(r["canned-script"]), description: r.desc ?? "", customFieldId: r.customFieldId ? `customfield_${r.customFieldId}` : null, searcher: r.searcherName ?? null, allProjects: !!r.isAllProjects }),
    writable: {},
    readOnlyReason: "script fields have neither an enabled flag nor a notes field",
  },
  fragment: {
    base: `${SR}/fragments`,
    label: "UI fragment",
    name: (r) => r.name,
    view: (r) => ({ id: r.id, name: r.name, type: r.type, location: r.locationName ?? r.FIELD_LOCATION ?? null, key: r.FIELD_KEY ?? null, section: r.FIELD_SECTION || null, weight: r.FIELD_WEIGHT ?? null, label: r.FIELD_MENU_LABEL ?? null, link: r.FIELD_LINK_DESTINATION ?? null, disabled: !!r.disabled, notes: r.FIELD_NOTES ?? "" }),
    writable: { disabled: "disabled", notes: "FIELD_NOTES" },
  },
  endpoint: {
    base: `${SR}/custom/customadmin`,
    label: "REST endpoint",
    name: (r) => r.resourcePath ?? r.id,
    view: (r) => ({ id: r.id, name: r.resourcePath ?? r.id, methods: (r.endpoints ?? []).map((e: any) => `${e.method ?? "?"} ${e.name ?? ""}`.trim()).join(", "), groups: [...new Set((r.endpoints ?? []).flatMap((e: any) => e.groups ?? []))].join(","), disabled: !!r.disabled, notes: r.FIELD_NOTES ?? "" }),
    writable: { disabled: "disabled", notes: "FIELD_NOTES" },
  },
  resource: {
    base: `${SR}/resources`,
    label: "resource",
    name: (r) => r.poolName ?? r.id,
    view: (r) => ({ id: r.id, name: r.poolName ?? r.id, kind: shortKind(r["canned-script"]), driver: r.driverClassName ?? null, readOnly: !!r.readOnly, disabled: !!r.disabled }),
    writable: {},
    readOnlyReason: "a resource's stored item carries the data source password, which sending it back could overwrite",
  },
  registry: {
    base: `${SR}/scriptSearch`,
    label: "script file",
    name: (r) => r.filename,
    view: (r) => ({ name: r.filename, path: r.filepath, type: r.filetype }),
    writable: {},
    readOnlyReason: "the script registry is a read-only file list",
  },
};

const UNSUPPORTED: Record<string, string> = {
  "mail-handler": "ScriptRunner exposes only an endpoint that runs a mail handler, not its configuration",
  behaviour: "ScriptRunner exposes only Behaviours' runtime resources through REST, not their configuration",
};

const typeArg = z.enum([...Object.keys(TYPES), ...Object.keys(UNSUPPORTED)] as [string, ...string[]]);

function typeOf(name: string): ItemType {
  if (UNSUPPORTED[name]) throw new UnsupportedError(`${name}: ${UNSUPPORTED[name]}`);
  return TYPES[name];
}

async function listRaw(client: AtlassianClient, t: ItemType): Promise<any[]> {
  const data: any = await client.get(t.base);
  return Array.isArray(data) ? data : [];
}

function pick(t: ItemType, items: any[], given: string): any {
  const v = String(given).trim();
  const byId = items.find((x) => String(x.id) === v);
  if (byId) return byId;
  const byName = items.filter((x) => String(t.name(x)).toLowerCase() === v.toLowerCase());
  if (byName.length > 1) throw new ValidationError(`Several ${t.label}s are named '${v}'; pass the id`);
  if (!byName.length) throw new ValidationError(`No ${t.label} '${v}'`);
  return byName[0];
}

/** Keys that change on every save and are not part of the item's configuration. */
const VOLATILE = new Set(["version", "nextRunTime", "lastModifiedDate", "modifiedByAvatar", "modifiedByDisplayName", "modifiedByUserKey"]);

/** Keys whose values differ between two stored items (redacted names are still reported, values never). */
function changedKeys(a: any, b: any, ignore: Set<string>): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => !ignore.has(k) && JSON.stringify(a?.[k] ?? null) !== JSON.stringify(b?.[k] ?? null)).sort();
}

const desc = "Unofficial ScriptRunner endpoints, allowed on Jira 10.x/11.x with ScriptRunner 9.x/10.x; broader version ranges are not runtime-verified (see REFERENCE.md).";

export const jiraScriptRunnerTools: ToolDef[] = [
  {
    name: "jira_list_scriptrunner_items",
    product: "jira",
    description:
      "ScriptRunner items of one type: job, listener, field, fragment, endpoint (REST endpoints), resource, registry " +
      "(script files). Metadata only: scripts, code references, SQL and credentials are never returned. mail-handler " +
      "and behaviour answer unsupported. " + desc,
    inputShape: { type: typeArg, ...pageShape(100) },
    async handler({ client }, args) {
      const c = client("jira");
      const t = typeOf(args.type);
      await requireScriptRunner(c);
      const items = (await listRaw(c, t)).map((r) => redact(t.view(r)) as Record<string, unknown>);
      return paginate(items, args, 100);
    },
  },
  {
    name: "jira_get_scriptrunner_item",
    product: "jira",
    description: "One ScriptRunner item (by id or exact name) with its allowlisted metadata; scripts, SQL and credentials are never returned. " + desc,
    inputShape: { type: typeArg, item: z.coerce.string().min(1) },
    async handler({ client }, args) {
      const c = client("jira");
      const t = typeOf(args.type);
      await requireScriptRunner(c);
      return redact(t.view(pick(t, await listRaw(c, t), args.item)));
    },
  },
  {
    name: "jira_update_scriptrunner_item",
    product: "jira",
    write: true,
    description:
      "Enable/disable a ScriptRunner job, fragment or REST endpoint (disabled=true|false) and/or change the notes of a " +
      "job, listener, fragment or REST endpoint. The stored item is sent back with only that key changed and read back; " +
      "any other change (script, code, schedule...) is refused or reported as a verification error. Nothing is run. " + desc,
    inputShape: { type: typeArg, item: z.coerce.string().min(1), disabled: boolArg.optional(), notes: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const t = typeOf(args.type);
      if (t.readOnlyReason) throw new UnsupportedError(`${t.label} changes are not offered: ${t.readOnlyReason}`);
      const wanted: Record<string, unknown> = {};
      if (args.disabled !== undefined) {
        if (!t.writable.disabled) throw new ValidationError(`A ${t.label} has no enabled/disabled flag; only notes can change`);
        wanted[t.writable.disabled] = args.disabled;
      }
      if (args.notes !== undefined) wanted[t.writable.notes!] = args.notes;
      if (!Object.keys(wanted).length) throw new ValidationError("Pass disabled and/or notes");
      await requireScriptRunner(c);

      const stored = pick(t, await listRaw(c, t), args.item);
      const canned = stored["canned-script"];
      if (typeof canned !== "string" || !stored.id) throw new ValidationError(`The stored ${t.label} has no id or canned-script; refusing to save it`);
      const change = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => stored[k] !== v).map(([k, v]) => [k === t.writable.disabled ? "disabled" : "notes", { from: stored[k] ?? null, to: v }]));
      const label = `${t.label} '${t.name(stored)}' (${stored.id})`;
      if (!Object.keys(change).length) return alreadySatisfied(`Update ${label}`, "it already has these values");

      // the stored item, unchanged except for the allowlisted keys
      const body = { ...stored, ...wanted };
      const unexpected = changedKeys(stored, body, new Set(Object.keys(wanted)));
      if (unexpected.length) throw new ValidationError(`Refusing to send changes to ${unexpected.join(", ")}`);
      const path = `${t.base}/${encodeURIComponent(canned)}`;
      const summary = `Update ${label}: ${Object.entries(change).map(([k, v]: any) => `${k} ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join(", ")}`;
      const request = { method: "POST", url: c.url(path), body: "(the stored item with only the keys above changed; not shown, it contains scripts)" };
      if (args.dry_run !== false) {
        return {
          dry_run: true,
          product: c.product,
          summary,
          request,
          change,
          identity: { op: "update-scriptrunner-item", type: args.type, item: args.item, ...wanted },
          state: { version: stored.version, values: Object.fromEntries(Object.keys(wanted).map((k) => [k, stored[k] ?? null])) },
          note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
        };
      }
      await c.request("POST", path, { json: body });
      const back = pick(t, await listRaw(c, t), String(stored.id));
      const drift = changedKeys(body, back, VOLATILE);
      if (drift.length) {
        throw new VerificationError(`${summary}: after saving, ScriptRunner stores other values for ${drift.join(", ")}`, { keys: drift });
      }
      return { dry_run: false, product: c.product, summary, request, result: redact(t.view(back)) };
    },
  },
];
