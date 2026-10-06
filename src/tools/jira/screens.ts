/**
 * Jira DC screens: list, read, usage, and field changes on a screen tab.
 *
 * Field changes use the public screen REST resource. A move is sent the way Jira's own
 * screen editor (an AJS.RestfulTable) sends it: {"position": "First"} or
 * {"after": "<absolute url of the previous field>"}.
 *
 * Usage has no REST listing (no screen scheme resources), so it is found by scanning
 * projects × issue types: create/edit screens through the bundled "Where is my field"
 * plugin, view screens through the project-config plugin (verified on Jira 11.3.6).
 */

import { z } from "zod";
import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, pageShape, paginate, serverPage } from "../util.js";
import { fieldPlaceholder, resolveField, type FieldRef } from "./fieldRefs.js";

const API = "/rest/api/2";
const SCREEN_PAGE = 100;
const MAX_SCREENS = 5000;
const MAX_PROJECT_SCAN = 2000;
const DEFAULT_PROJECT_SCAN = 100;

// -- reading ------------------------------------------------------------------

/** Screens of one page; Jira 11 returns them under `screens`, older versions under `values`. */
function screensOf(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.screens ?? data?.values ?? [];
}

const screenLists = new WeakMap<AtlassianClient, Promise<Array<{ id: number; name: string }>>>();

/** Every screen (id, name), read once per client; Jira screen names are unique. */
function allScreens(client: AtlassianClient): Promise<Array<{ id: number; name: string }>> {
  let p = screenLists.get(client);
  if (!p) {
    p = (async () => {
      const out: Array<{ id: number; name: string }> = [];
      for (let startAt = 0; out.length < MAX_SCREENS; startAt += SCREEN_PAGE) {
        const data = await client.get(`${API}/screens`, { startAt, maxResults: SCREEN_PAGE });
        const page = screensOf(data);
        out.push(...page.map((s: any) => ({ id: Number(s.id), name: String(s.name) })));
        if (page.length < SCREEN_PAGE || (data?.total != null && out.length >= data.total)) break;
      }
      return out;
    })();
    screenLists.set(client, p);
  }
  return p;
}

interface Tab {
  id: number;
  name: string;
  fields: Array<{ id: string; name: string; type?: string }>;
}

/** A screen's tabs with their fields in order (what jira_get_screen returns). */
export async function readScreen(client: AtlassianClient, screenId: number): Promise<Tab[]> {
  // one call per tab; screens have few tabs
  const tabs: any[] = (await client.get(`${API}/screens/${screenId}/tabs`)) ?? [];
  const fields = await Promise.all(tabs.map((t) => client.get(`${API}/screens/${screenId}/tabs/${t.id}/fields`)));
  return tabs.map((t, i) => ({
    id: Number(t.id),
    name: t.name,
    fields: (fields[i] ?? []).map((f: any) => ({ id: f.id, name: f.name, type: f.type })),
  }));
}

// -- usage scan ---------------------------------------------------------------

export interface ScreenUse {
  project: string;
  issueType: string;
  issueTypeId: string;
  operation: "create" | "edit" | "view";
  screenId: number | null;
  screenName?: string;
  screenSchemeId?: string;
  issueTypeScreenSchemeId?: string;
}

/** What "Where is my field" says about a field for one project, issue type and operation. */
export interface WhereIsMyField {
  fieldConfiguration?: string;
  screenName?: string;
  screenId?: string;
  screenSchemeId?: string;
  issueTypeScreenSchemeId?: string;
}

/** Parse a "Where is my field" answer: the field configuration and screen lines name them in parameter 2. */
export function parseWhereIsMyField(data: any): WhereIsMyField {
  const out: WhereIsMyField = {};
  for (const line of data?.statusLines ?? []) {
    const summary = line?.summary?.[0]?.message;
    const params: any[] = (line?.details ?? []).flatMap((d: any) => d?.parameters ?? []);
    const plain = params.filter((p) => p?.type === "plain").map((p) => String(p.value));
    const links = params.filter((p) => p?.type === "link").map((p) => String(p.href ?? ""));
    const idFrom = (page: string) => links.map((h) => new RegExp(`/${page}\\.jspa\\?id=(\\d+)`).exec(h)?.[1]).find(Boolean);
    if (summary === "Field configuration") out.fieldConfiguration = plain[1];
    if (summary === "Field Screen") {
      out.screenName = plain[1];
      out.screenId = idFrom("ConfigureFieldScreen");
      out.screenSchemeId = idFrom("ConfigureFieldScreenScheme");
      out.issueTypeScreenSchemeId = idFrom("ConfigureIssueTypeScreenScheme");
    }
  }
  return out;
}

/** A custom field to ask "Where is my field" about; any custom field works, also one out of scope. */
export async function probeField(client: AtlassianClient): Promise<string | undefined> {
  const data = await client.get(`${API}/customFields`, { startAt: 1, maxResults: 1 });
  return data?.values?.[0]?.id;
}

export function whereIsMyField(client: AtlassianClient, probe: string, project: string, issueTypeId: string, op: 0 | 1) {
  return client.get(`/rest/whereismycf/1.0/fields/${seg(probe)}`, { projectKey: project, issueTypeId, issueOperation: op });
}

const OPERATIONS = [{ name: "create", id: 0 }, { name: "edit", id: 1 }] as const;

export interface UsageScan {
  uses: ScreenUse[];
  scannedProjects: number;
  totalProjects: number;
  truncatedScan?: true;
  unreadableProjects?: number;
  /** create/edit lookups whose screen could not be determined */
  unresolved?: number;
}

const forbiddenOrMissing = (e: unknown) => isHttpStatusError(e) && (e.status === 403 || e.status === 404);

async function scanUsage(client: AtlassianClient, scanProjects: number): Promise<UsageScan> {
  const [screens, probe, projectList] = await Promise.all([
    allScreens(client),
    probeField(client),
    client.get(`${API}/project`) as Promise<any[]>,
  ]);
  const byName = new Map(screens.map((s) => [s.name, s.id]));
  const projects = (projectList ?? []).slice(0, scanProjects);
  const unreadable = new Set<string>();
  let unresolved = 0;

  const perProject = await boundedAll(projects.map((p) => async () => {
    let issueTypes: any[];
    try {
      issueTypes = (await client.get(`${API}/project/${seg(p.key)}`))?.issueTypes ?? [];
    } catch (e) {
      if (forbiddenOrMissing(e)) { unreadable.add(p.key); return []; }
      throw e;
    }
    const uses: ScreenUse[] = [];
    for (const it of issueTypes) {
      const base = { project: p.key, issueType: it.name, issueTypeId: String(it.id) };
      try {
        const view = await client.get(`/rest/projectconfig/1/issuetype/${seg(p.key)}/${seg(it.id)}/fields`);
        if (view?.viewScreen) uses.push({ ...base, operation: "view", screenId: Number(view.viewScreen.screenId), screenName: view.viewScreen.screenName });
      } catch (e) {
        if (!forbiddenOrMissing(e)) throw e;
        unreadable.add(p.key);
      }
      if (!probe) { unresolved += OPERATIONS.length; continue; }
      for (const op of OPERATIONS) {
        try {
          const w = parseWhereIsMyField(await whereIsMyField(client, probe, p.key, String(it.id), op.id));
          const screenId = w.screenId ? Number(w.screenId) : w.screenName ? byName.get(w.screenName) : undefined;
          if (screenId === undefined) unresolved++;
          uses.push({
            ...base,
            operation: op.name,
            screenId: screenId ?? null,
            screenName: w.screenName,
            screenSchemeId: w.screenSchemeId,
            issueTypeScreenSchemeId: w.issueTypeScreenSchemeId,
          });
        } catch (e) {
          if (!forbiddenOrMissing(e)) throw e;
          unreadable.add(p.key);
        }
      }
    }
    return uses;
  }), 4);

  return {
    uses: perProject.flat(),
    scannedProjects: projects.length,
    totalProjects: (projectList ?? []).length,
    truncatedScan: (projectList ?? []).length > projects.length || undefined,
    unreadableProjects: unreadable.size || undefined,
    unresolved: unresolved || undefined,
  };
}

const usageScans = new WeakMap<AtlassianClient, Map<number, Promise<UsageScan>>>();

/** Usage scan, shared by all tools of one run (a plan apply dry-runs many screen changes). */
export function screenUsageScan(client: AtlassianClient, scanProjects = DEFAULT_PROJECT_SCAN): Promise<UsageScan> {
  let byCap = usageScans.get(client);
  if (!byCap) usageScans.set(client, (byCap = new Map()));
  let p = byCap.get(scanProjects);
  if (!p) byCap.set(scanProjects, (p = scanUsage(client, scanProjects)));
  return p;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function summarizeUsage(scan: UsageScan, screenId: number) {
  const uses = scan.uses.filter((u) => u.screenId === screenId);
  const projects = [...new Set(uses.map((u) => u.project))];
  const issueTypes = new Set(uses.map((u) => u.issueType));
  const combos = new Set(uses.map((u) => `${u.project}/${u.issueTypeId}`));
  const shared = projects.length > 1 || combos.size > 1;
  return {
    uses,
    projects,
    screenSchemes: [...new Set(uses.map((u) => u.screenSchemeId).filter(Boolean))] as string[],
    issueTypeScreenSchemes: [...new Set(uses.map((u) => u.issueTypeScreenSchemeId).filter(Boolean))] as string[],
    warning: shared
      ? `Shared screen: used by ${plural(projects.length, "project")} and ${plural(issueTypes.size, "issue type")}; a change affects all of them`
      : undefined,
    complete: !scan.truncatedScan && !scan.unreadableProjects && !scan.unresolved,
  };
}

const scanShape = {
  scan_projects: z.coerce.number().int().min(1).max(MAX_PROJECT_SCAN).optional()
    .describe(`Projects to scan (default ${DEFAULT_PROJECT_SCAN}, max ${MAX_PROJECT_SCAN}); each costs 1 + 3 requests per issue type`),
};

// -- field changes --------------------------------------------------------------

interface TabState {
  screen: { id: number; name: string };
  tab: Tab;
  tabs: Tab[];
  order: string[];
}

async function loadTab(client: AtlassianClient, screenId: number, tabId: number): Promise<TabState> {
  const [tabs, screens] = await Promise.all([readScreen(client, screenId), allScreens(client)]);
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) throw new ValidationError(`Screen ${screenId} has no tab ${tabId}; tabs: ${tabs.map((t) => `${t.id} (${t.name})`).join(", ")}`);
  const name = screens.find((s) => s.id === screenId)?.name ?? String(screenId);
  return { screen: { id: screenId, name }, tab, tabs, order: tab.fields.map((f) => f.id) };
}

interface Step {
  method: "POST" | "DELETE";
  path: string;
  json?: unknown;
}

const fieldsPath = (s: number, t: number) => `${API}/screens/${s}/tabs/${t}/fields`;

/** The move request that puts `field` at index `i` of `desired`. */
function moveStep(client: AtlassianClient, s: number, t: number, field: string, desired: string[]): Step {
  const i = desired.indexOf(field);
  const json = i === 0 ? { position: "First" } : { after: client.url(`${fieldsPath(s, t)}/${seg(desired[i - 1])}`) };
  return { method: "POST", path: `${fieldsPath(s, t)}/${seg(field)}/move`, json };
}

function insertAt(list: string[], field: string, position?: number): string[] {
  const rest = list.filter((id) => id !== field);
  const i = position === undefined ? rest.length : Math.min(position - 1, rest.length);
  return [...rest.slice(0, i), field, ...rest.slice(i)];
}

async function affectedProjects(client: AtlassianClient, screenId: number) {
  try {
    const s = summarizeUsage(await screenUsageScan(client), screenId);
    return { projects: s.projects, warning: s.warning, complete: s.complete };
  } catch (e) {
    return { unavailable: String((e as Error)?.message ?? e) };
  }
}

/** One line for the dry run: which projects the screen change reaches. */
function affectedLine(a: any): string {
  if (a.unavailable) return `affected projects unknown: ${a.unavailable}`;
  const list = a.projects.length ? a.projects.join(", ") : "none found";
  return `affected projects: ${list}${a.complete ? "" : " (incomplete scan)"}${a.warning ? `; ${a.warning}` : ""}`;
}

interface ChangeSpec {
  op: "add" | "remove" | "move";
  st: TabState;
  field: FieldRef;
  label: string;
  steps: Step[];
  desired: string[];
  summary: string;
  identity: Record<string, unknown>;
  /** What the change depends on (drift check): presence and the anchor field, not the whole tab. */
  state: Record<string, unknown>;
}

/** The field a target position follows ("first" at the top); a change is only valid while it holds. */
function anchorOf(desired: string[], id: string): string {
  const i = desired.indexOf(id);
  return i <= 0 ? "first" : desired[i - 1];
}

/**
 * Describe (dry run) or execute a tab change, then read the screen back and check
 * that the tab holds exactly the intended order.
 */
async function runChange(client: AtlassianClient, dryRun: boolean, c: ChangeSpec) {
  const described = c.steps.map((s) => ({ method: s.method, url: client.url(s.path), body: s.json }));
  if (dryRun) {
    const affected: any = await affectedProjects(client, c.st.screen.id);
    return {
      dry_run: true,
      product: client.product,
      summary: c.summary,
      warning: affectedLine(affected),
      request: described[0],
      followUps: described.slice(1),
      identity: c.identity,
      state: c.state,
      before: c.st.order,
      after: c.desired,
      affectedProjects: affected,
      note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
    };
  }
  for (const s of c.steps) await client.request(s.method, s.path, { json: s.json });
  const screen = await readScreen(client, c.st.screen.id);
  const actual = screen.find((t) => t.id === c.st.tab.id)?.fields.map((f) => f.id) ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(c.desired)) {
    throw new VerificationError(
      `Tab ${c.st.tab.name} of ${c.st.screen.name} does not show the intended order after the change`,
      { expected: c.desired, actual },
    );
  }
  return { dry_run: false, product: client.product, summary: c.summary, request: described[0], result: screen };
}

const tabShape = {
  screen_id: z.coerce.number().int(),
  tab_id: z.coerce.number().int(),
  field_id: z.coerce.string().min(1).describe("Field id (customfield_N, labels...) or exact field name"),
};

const positionArg = z.coerce.number().int().min(1).describe("1-based position on the tab");

function fieldLabel(f: FieldRef): string {
  return f.name ?? f.id ?? "?";
}

/** Shared by jira_add_screen_field and jira_add_field_to_screens. */
export async function addScreenField(
  client: AtlassianClient,
  args: { screen_id: number; tab_id: number; field_id: string; position?: number; dry_run?: boolean },
) {
  const dryRun = args.dry_run !== false;
  const [st, field] = await Promise.all([
    loadTab(client, args.screen_id, args.tab_id),
    resolveField(client, args.field_id, { allowPending: dryRun }),
  ]);
  const label = fieldLabel(field);
  const where = `${st.screen.name} / ${st.tab.name}`;
  if (field.id) {
    const other = st.tabs.find((t) => t.id !== st.tab.id && t.fields.some((f) => f.id === field.id));
    if (other) throw new ValidationError(`${label} is already on tab ${other.name} (${other.id}) of ${st.screen.name}; move or remove it there first`);
  }
  const id = fieldPlaceholder(field);
  if (args.position !== undefined && args.position > st.order.length + 1) {
    throw new ValidationError(`Position ${args.position} is beyond the end of tab ${st.tab.name} (${st.order.length} fields)`);
  }
  const present = !!field.id && st.order.includes(field.id);
  const desired = present && args.position === undefined ? st.order : insertAt(st.order, id, args.position);
  if (present && JSON.stringify(desired) === JSON.stringify(st.order)) {
    return alreadySatisfied(`Add ${label} to ${where}`, `${label} is already on the tab${args.position ? ` at position ${args.position}` : ""}`);
  }
  const steps: Step[] = [];
  if (!present) steps.push({ method: "POST", path: fieldsPath(st.screen.id, st.tab.id), json: { fieldId: id } });
  // Jira appends a new field; move it unless that is where it belongs
  if (desired.indexOf(id) !== desired.length - 1 || present) steps.push(moveStep(client, st.screen.id, st.tab.id, id, desired));
  const at = args.position ? ` at position ${args.position}` : "";
  return runChange(client, dryRun, {
    op: "add", st, field, label, steps, desired,
    summary: `${present ? "Move" : "Add"} ${label} ${present ? "on" : "to"} ${where}${at}`,
    identity: { op: "add", screen: st.screen.id, tab: st.tab.id, field: field.ref, position: args.position ?? null },
    state: { present, anchor: args.position === undefined ? null : anchorOf(desired, id) },
  });
}

export const jiraScreenTools: ToolDef[] = [
  {
    name: "jira_list_screens",
    product: "jira",
    description: "Screens with id and name (server-side search and paging).",
    inputShape: { search: z.coerce.string().optional(), ...pageShape(100) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      const data = await client("jira").get(`${API}/screens`, { startAt: offset, maxResults: limit, search: args.search });
      const values = screensOf(data).map((s: any) => ({ id: s.id, name: s.name, description: s.description ?? "" }));
      return serverPage(values, offset, limit, data?.total, data?.isLast);
    },
  },
  {
    name: "jira_get_screen",
    product: "jira",
    description: "A screen's tabs with their fields in order.",
    inputShape: { screen_id: z.coerce.number().int() },
    async handler({ client }, args) {
      return readScreen(client("jira"), args.screen_id);
    },
  },
  {
    name: "jira_get_screen_usage",
    product: "jira",
    description:
      "Where a screen is used: projects, issue types and operations (create/edit/view), the screen schemes and issue type " +
      "screen schemes when Jira names them, and a sharing warning. Scans projects through the bundled 'Where is my field' " +
      "and project-config plugins (internal APIs, verified on Jira 11.3); `complete` is false when the scan was cut or " +
      "some projects could not be read. Large instances: --out or a subagent.",
    inputShape: { screen_id: z.coerce.number().int(), ...scanShape, ...pageShape(100) },
    async handler({ client }, args) {
      const c = client("jira");
      const [scan, screens] = await Promise.all([screenUsageScan(c, args.scan_projects ?? DEFAULT_PROJECT_SCAN), allScreens(c)]);
      const s = summarizeUsage(scan, args.screen_id);
      const { uses: _uses, ...meta } = scan;
      const items = s.uses.map((u) => ({ project: u.project, issueType: u.issueType, operation: u.operation }));
      return {
        screen: { id: args.screen_id, name: screens.find((x) => x.id === args.screen_id)?.name ?? null },
        ...paginate(items, args, 100),
        projects: s.projects,
        screenSchemes: s.screenSchemes,
        issueTypeScreenSchemes: s.issueTypeScreenSchemes,
        warning: s.warning,
        ...meta,
        complete: s.complete,
      };
    },
  },
  {
    name: "jira_add_screen_field",
    product: "jira",
    write: true,
    description:
      "Add a field to a screen tab, optionally at a 1-based position. Already on the tab → already-satisfied; on another " +
      "tab of the screen → error. The dry run shows the order before/after and the projects using the screen; after the " +
      "change the screen is read back.",
    inputShape: { ...tabShape, position: positionArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      return addScreenField(client("jira"), args as any);
    },
  },
  {
    name: "jira_remove_screen_field",
    product: "jira",
    write: true,
    description: "Remove a field from a screen tab. Not on the tab → already-satisfied. The screen is read back after the change.",
    inputShape: { ...tabShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const dryRun = args.dry_run !== false;
      const [st, field] = await Promise.all([loadTab(c, args.screen_id, args.tab_id), resolveField(c, args.field_id, { allowPending: true })]);
      const label = fieldLabel(field);
      const where = `${st.screen.name} / ${st.tab.name}`;
      if (!field.id || !st.order.includes(field.id)) {
        const other = field.id ? st.tabs.find((t) => t.fields.some((f) => f.id === field.id)) : undefined;
        return alreadySatisfied(`Remove ${label} from ${where}`, `${label} is not on the tab${other ? ` (it is on tab ${other.name})` : ""}`);
      }
      return runChange(c, dryRun, {
        op: "remove", st, field, label,
        steps: [{ method: "DELETE", path: `${fieldsPath(st.screen.id, st.tab.id)}/${seg(field.id)}` }],
        desired: st.order.filter((id) => id !== field.id),
        summary: `Remove ${label} from ${where}`,
        identity: { op: "remove", screen: st.screen.id, tab: st.tab.id, field: field.ref },
        state: { present: true },
      });
    },
  },
  {
    name: "jira_move_screen_field",
    product: "jira",
    write: true,
    description: "Move a field on a screen tab to a 1-based position or right after another field (after_field_id). Already there → already-satisfied.",
    inputShape: {
      ...tabShape,
      position: positionArg.optional(),
      after_field_id: z.coerce.string().optional().describe("Place right after this field (id or exact name)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if ((args.position === undefined) === (args.after_field_id === undefined)) {
        throw new ValidationError("Pass exactly one of position or after_field_id");
      }
      const c = client("jira");
      const dryRun = args.dry_run !== false;
      const [st, field, after] = await Promise.all([
        loadTab(c, args.screen_id, args.tab_id),
        resolveField(c, args.field_id),
        args.after_field_id !== undefined ? resolveField(c, args.after_field_id) : Promise.resolve(undefined),
      ]);
      const label = fieldLabel(field);
      const where = `${st.screen.name} / ${st.tab.name}`;
      if (!st.order.includes(field.id!)) throw new ValidationError(`${label} is not on ${where}`);
      let desired: string[];
      if (after) {
        if (!st.order.includes(after.id!)) throw new ValidationError(`${fieldLabel(after)} is not on ${where}`);
        if (after.id === field.id) throw new ValidationError("after_field_id is the field itself");
        const rest = st.order.filter((id) => id !== field.id);
        desired = insertAt(rest, field.id!, rest.indexOf(after.id!) + 2);
      } else {
        if (args.position > st.order.length) throw new ValidationError(`Position ${args.position} is beyond the end of tab ${st.tab.name} (${st.order.length} fields)`);
        desired = insertAt(st.order, field.id!, args.position);
      }
      const target = after ? `after ${fieldLabel(after)}` : `position ${args.position}`;
      if (JSON.stringify(desired) === JSON.stringify(st.order)) {
        return alreadySatisfied(`Move ${label} on ${where} to ${target}`, `${label} is already there`);
      }
      return runChange(c, dryRun, {
        op: "move", st, field, label, desired,
        steps: [moveStep(c, st.screen.id, st.tab.id, field.id!, desired)],
        summary: `Move ${label} on ${where} to ${target}`,
        identity: { op: "move", screen: st.screen.id, tab: st.tab.id, field: field.ref, position: args.position ?? null, after: after?.ref ?? null },
        state: { present: true, anchor: anchorOf(st.order, field.id!) },
      });
    },
  },
];
