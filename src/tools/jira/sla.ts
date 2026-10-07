/**
 * Jira Service Management SLAs and SLA calendars.
 *
 * Uses JSM's internal resources, as its SLA settings pages do (verified on JSM 11.3.5):
 * `/rest/servicedesk/1/servicedesk/agent/{projectKey}/sla/metrics[/{id}]` (GET, POST, PUT, DELETE)
 * with the model `{name, customerVisible, config: {definition: {start, pause, stop}, goals}}`,
 * `…/{projectKey}/sla/conditions/available`, and
 * `…/{serviceDeskId}/sla/calendars[/{id}]` with `{name, description, timeZone, holidays, workingTimes}`.
 * Goals hold `{jqlQuery, duration (ms), calendarId?, defaultGoal}`; a goal without calendar uses
 * the built-in "Default 24/7 calendar" (id -1). Writes are gated to verified JSM versions.
 */

import { z } from "zod";
import type { AtlassianClient } from "../../client.js";
import { ValidationError, VerificationError } from "../../errors.js";
import { requireJsmVersion } from "../../jiraVersion.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, boolArg, dryRunShape, guardedWrite, jsonArg, listArg, pageShape, paginate } from "../util.js";
import { resolveServiceDesk, type ServiceDesk } from "./requestTypes.js";

const IJ = "/rest/servicedesk/1/servicedesk";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const DEFAULT_CALENDAR = { id: -1, name: "Default 24/7 calendar" };

// -- targets and working hours ------------------------------------------------------------

/** "4h", "2d 4h", "1h 30m", or plain minutes → milliseconds (a day is 24 hours). */
export function parseTarget(text: string): number {
  const value = String(text).trim();
  if (/^\d+$/.test(value)) return Number(value) * MINUTE;
  const parts = value.split(/\s+/);
  let total = 0;
  for (const part of parts) {
    const m = /^(\d+)([dhm])$/i.exec(part);
    if (!m) throw new ValidationError(`Goal target '${text}' is not understood; use e.g. 4h, 2d 4h, 1h 30m or minutes`);
    total += Number(m[1]) * { d: DAY, h: HOUR, m: MINUTE }[m[2].toLowerCase() as "d" | "h" | "m"];
  }
  if (!total) throw new ValidationError(`Goal target '${text}' is zero`);
  return total;
}

export function formatTarget(ms: number): string {
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.round((ms % HOUR) / MINUTE);
  return [d ? `${d}d` : "", h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ") || "0m";
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

export interface WorkingTime {
  day: string;
  start: number;
  end: number;
  disabled: boolean;
}

const clock = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m || Number(m[1]) > 24 || Number(m[2]) > 59) throw new ValidationError(`Time '${t}' is not HH:MM`);
  return Number(m[1]) * HOUR + Number(m[2]) * MINUTE;
};

/** "24x7", or ranges like "mon-fri 09:00-18:00; sat 10:00-14:00" → working times. */
export function parseWorkingHours(text: string): WorkingTime[] {
  const value = String(text).trim().toLowerCase();
  if (value === "24x7" || value === "24/7") return DAYS.map((day) => ({ day, start: 0, end: DAY, disabled: false }));
  const out: WorkingTime[] = [];
  for (const part of value.split(/[;,]/).map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z]{3})(?:-([a-z]{3}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(part);
    const from = m ? DAYS.findIndex((d) => d.startsWith(m[1])) : -1;
    const to = m ? (m[2] ? DAYS.findIndex((d) => d.startsWith(m[2])) : from) : -1;
    if (!m || from < 0 || to < from) throw new ValidationError(`Working hours '${part}' are not understood; use 24x7 or e.g. mon-fri 09:00-18:00`);
    for (let i = from; i <= to; i++) out.push({ day: DAYS[i], start: clock(m[3]), end: clock(m[4]), disabled: false });
  }
  return out;
}

const hhmm = (ms: number) => `${String(Math.floor(ms / HOUR)).padStart(2, "0")}:${String(Math.round((ms % HOUR) / MINUTE)).padStart(2, "0")}`;

/** "monday–friday 09:00–17:00" style summary of working times. */
function describeWorkingTimes(times: WorkingTime[]): string {
  const on = times.filter((t) => !t.disabled).sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day));
  if (on.length === 7 && on.every((t) => t.start === 0 && t.end === DAY)) return "24x7";
  const groups: string[] = [];
  for (let i = 0; i < on.length; ) {
    let j = i;
    while (j + 1 < on.length && DAYS.indexOf(on[j + 1].day) === DAYS.indexOf(on[j].day) + 1 && on[j + 1].start === on[i].start && on[j + 1].end === on[i].end) j++;
    groups.push(`${on[i].day}${j > i ? `–${on[j].day}` : ""} ${hhmm(on[i].start)}–${hhmm(on[i].end)}`);
    i = j + 1;
  }
  return groups.join("; ");
}

// -- reads ------------------------------------------------------------------------------------

async function metrics(client: AtlassianClient, sd: ServiceDesk): Promise<any[]> {
  const data: any = await client.get(`${IJ}/agent/${sd.projectKey}/sla/metrics`);
  return data?.timeMetrics ?? (Array.isArray(data) ? data : []);
}

async function calendarRefs(client: AtlassianClient, sd: ServiceDesk): Promise<Array<{ id: number; name: string }>> {
  const data: any = await client.get(`${IJ}/agent/${sd.projectKey}/sla/metrics/calendar-refs`);
  return (data?.calendars ?? []).map((c: any) => ({ id: Number(c.id), name: String(c.name) }));
}

interface ConditionChoice {
  pluginKey: string;
  factoryKey: string;
  conditionId: string;
  name: string;
}

async function conditions(client: AtlassianClient, sd: ServiceDesk): Promise<{ hit: ConditionChoice[]; match: ConditionChoice[] }> {
  const data: any = await client.get(`${IJ}/${sd.projectKey}/sla/conditions/available`);
  return { hit: data?.hitConditions ?? [], match: data?.matchConditions ?? [] };
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function pickConditions(available: ConditionChoice[], names: string[], kind: string, type: "Start" | "Pause" | "Stop") {
  return names.map((n) => {
    const hit = available.find((c) => sameName(c.name, n));
    if (!hit) throw new ValidationError(`${kind} condition '${n}' is not available; ${kind} conditions: ${available.map((c) => c.name).join(", ")}`);
    return { pluginKey: hit.pluginKey, factoryKey: hit.factoryKey, conditionId: hit.conditionId, type, name: hit.name };
  });
}

const goalList = jsonArg(
  z.array(z.object({ jql: z.string().optional(), target: z.coerce.string().min(1), calendar: z.coerce.string().optional() }).strict()).min(1),
  '[{"jql":"priority = Highest","target":"4h"},{"target":"2d"}]',
);

interface GoalInput {
  jql?: string;
  target: string;
  calendar?: string;
}

/**
 * Goals as JSM stores them. Calendars by id, name, or 24x7 (the built-in default). A calendar
 * name that does not exist yet is allowed in dry runs (planned earlier in the same plan).
 */
function buildGoals(goals: GoalInput[], refs: Array<{ id: number; name: string }>, allowPending: boolean) {
  const defaults = goals.filter((g) => !g.jql?.trim());
  if (defaults.length > 1) throw new ValidationError("Only one goal may be for all remaining issues (without jql)");
  if (defaults.length && goals.indexOf(defaults[0]) !== goals.length - 1) throw new ValidationError("The goal for all remaining issues (without jql) must be last");
  return goals.map((g) => {
    const out: Record<string, unknown> = { jqlQuery: g.jql?.trim() ?? "", duration: parseTarget(g.target) };
    if (g.calendar !== undefined) {
      const name = g.calendar.trim();
      const ref = /^(24x7|24\/7)$/i.test(name) ? DEFAULT_CALENDAR : refs.find((c) => String(c.id) === name || sameName(c.name, name));
      if (ref) out.calendarId = ref.id;
      else if (allowPending) out.calendarId = `{${name}}`;
      else throw new ValidationError(`Calendar '${name}' not found; calendars: ${refs.map((c) => c.name).join(", ")}`);
    }
    out.defaultGoal = !g.jql?.trim();
    return out;
  });
}

function goalSummary(goals: any[], refs: Array<{ id: number; name: string }>) {
  return goals.map((g) => ({
    jql: g.jqlQuery ? g.jqlQuery : "All remaining issues",
    target: formatTarget(Number(g.duration)),
    calendar: g.calendarId === undefined || g.calendarId === null || Number(g.calendarId) === -1
      ? DEFAULT_CALENDAR.name
      : (refs.find((c) => c.id === Number(g.calendarId))?.name ?? String(g.calendarId)),
  }));
}

/** The parts of a metric that define it, for comparisons. */
function shapeOf(m: { name: string; customerVisible?: boolean; config: any }) {
  const cond = (list: any[]) => (list ?? []).map((c) => `${c.pluginKey}:${c.factoryKey}:${c.conditionId}`).sort();
  return JSON.stringify({
    name: m.name,
    customerVisible: !!m.customerVisible,
    start: cond(m.config?.definition?.start),
    pause: cond(m.config?.definition?.pause),
    stop: cond(m.config?.definition?.stop),
    goals: (m.config?.goals ?? []).map((g: any) => ({ jql: g.jqlQuery ?? "", duration: Number(g.duration), calendarId: g.calendarId === undefined || Number(g.calendarId) === -1 ? -1 : g.calendarId, defaultGoal: !!g.defaultGoal })),
  });
}

function pickMetric(list: any[], given: string) {
  const v = String(given).trim();
  const hit = list.find((m) => String(m.id) === v) ?? list.filter((m) => sameName(m.name, v))[0];
  return hit;
}

async function calendarDetails(client: AtlassianClient, sd: ServiceDesk) {
  const list: any[] = ((await client.get(`${IJ}/${sd.id}/sla/calendars`)) as any[]) ?? [];
  return Promise.all(list.map(async (c) => ({
    ...c,
    detail: c.id !== undefined ? await client.get(`${IJ}/${sd.id}/sla/calendars/${c.id}`) : undefined,
  })));
}

const sdArg = z.coerce.string().min(1).describe("Service desk id or project key");
const conditionList = listArg.describe("Condition names from jira_get_sla_conditions, comma-separated");
const goalsArg = goalList.describe('JSON list in order: [{jql?, target, calendar?}], e.g. [{"jql":"priority = Highest","target":"4h","calendar":"24x7"},{"target":"2d"}]; the goal without jql (all remaining issues) goes last');

const RECALC = "JSM recalculates this SLA on existing requests, which can take a while on large projects";

export const jiraSlaTools: ToolDef[] = [
  {
    name: "jira_get_sla_configuration",
    product: "jira",
    description: "SLA metrics of a service desk: start, pause and stop conditions, and goals in order (JQL, target, calendar). Internal JSM API.",
    inputShape: { service_desk: sdArg, ...pageShape(50) },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const [list, refs] = await Promise.all([metrics(c, sd), calendarRefs(c, sd)]);
      const items = list.map((m) => ({
        id: m.id,
        name: m.name,
        customerVisible: !!m.customerVisible,
        start: (m.config?.definition?.start ?? []).map((x: any) => x.name),
        pause: (m.config?.definition?.pause ?? []).map((x: any) => x.name),
        stop: (m.config?.definition?.stop ?? []).map((x: any) => x.name),
        goals: goalSummary(m.config?.goals ?? [], refs),
      }));
      return paginate(items, args, 50);
    },
  },
  {
    name: "jira_get_sla_conditions",
    product: "jira",
    description: "Conditions an SLA can use in this service desk: start/stop events and pause conditions, by name. Internal JSM API.",
    inputShape: { service_desk: sdArg },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const { hit, match } = await conditions(c, sd);
      return { startStop: hit.map((x) => x.name), pause: match.map((x) => x.name) };
    },
  },
  {
    name: "jira_list_sla_calendars",
    product: "jira",
    description: "SLA calendars of a service desk with time zone, working hours, holidays and the SLAs that use them (the built-in Default 24/7 calendar included). Internal JSM API.",
    inputShape: { service_desk: sdArg },
    async handler({ client }, args) {
      const c = client("jira");
      const sd = await resolveServiceDesk(c, args.service_desk);
      return (await calendarDetails(c, sd)).map((cal) => ({
        id: cal.id ?? -1,
        name: cal.name,
        timeZone: cal.detail?.timeZone,
        workingHours: cal.detail ? describeWorkingTimes(cal.detail.workingTimes ?? []) : "24x7",
        holidays: (cal.detail?.holidays ?? []).length,
        usedBy: (cal.dependentMetrics ?? []).map((m: any) => m.metricName),
        deletable: !!cal.inherentlyDeletable,
      }));
    },
  },
  {
    name: "jira_create_sla",
    product: "jira",
    write: true,
    description:
      "Create an SLA metric: start/pause/stop conditions by name and goals in order. Same name and settings → " +
      "already-satisfied; same name otherwise → error. Calendars by name (also one planned earlier), id, or 24x7. " +
      "Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, name: z.string().trim().min(1), start: conditionList, pause: conditionList.optional(), stop: conditionList, goals: goalsArg, customer_visible: boolArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "SLA changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const [list, refs, avail] = await Promise.all([metrics(c, sd), calendarRefs(c, sd), conditions(c, sd)]);
      const dryRun = args.dry_run !== false;
      const body = {
        name: args.name,
        customerVisible: !!args.customer_visible,
        config: {
          definition: {
            start: pickConditions(avail.hit, args.start, "start", "Start"),
            pause: pickConditions(avail.match, args.pause ?? [], "pause", "Pause"),
            stop: pickConditions(avail.hit, args.stop, "stop", "Stop"),
          },
          goals: buildGoals(args.goals, refs, dryRun),
        },
      };
      const summary = `Create SLA '${args.name}' in ${sd.projectKey}: ${body.config.goals.length} goal(s)`;
      const existing = list.find((m) => sameName(m.name, args.name));
      if (existing && shapeOf(existing) === shapeOf(body)) return alreadySatisfied(summary, `SLA ${existing.id} '${existing.name}' already has these settings`);
      if (existing) throw new ValidationError(`SLA ${existing.id} '${existing.name}' already exists with other settings; use jira_update_sla`);
      const req = { method: "POST" as const, path: `${IJ}/agent/${sd.projectKey}/sla/metrics`, json: body, summary };
      const identity = { op: "create-sla", sd: sd.id, name: args.name, start: args.start, pause: args.pause ?? [], stop: args.stop, goals: args.goals, customerVisible: !!args.customer_visible };
      if (dryRun) return { ...(await guardedWrite(c, args, req)), identity };
      await c.request("POST", req.path, { json: body });
      const back = (await metrics(c, sd)).find((m) => sameName(m.name, args.name));
      if (!back || shapeOf(back) !== shapeOf(body)) throw new VerificationError(`${summary}: the SLA does not read back as created`, back);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: back.id, name: back.name, goals: goalSummary(back.config.goals, refs) } };
    },
  },
  {
    name: "jira_update_sla",
    product: "jira",
    write: true,
    description: "Change an SLA metric's name, conditions, goals or customer visibility (given parts replace the stored ones). JSM recalculates the SLA on existing requests. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, sla: z.coerce.string().min(1).describe("SLA id or exact name"), name: z.string().trim().min(1).optional(), start: conditionList.optional(), pause: conditionList.optional(), stop: conditionList.optional(), goals: goalsArg.optional(), customer_visible: boolArg.optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "SLA changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const [list, refs, avail] = await Promise.all([metrics(c, sd), calendarRefs(c, sd), conditions(c, sd)]);
      const stored = pickMetric(list, args.sla);
      if (!stored) throw new ValidationError(`No SLA '${args.sla}' in ${sd.projectKey}`);
      const def = stored.config.definition;
      const body = {
        ...stored,
        name: args.name ?? stored.name,
        customerVisible: args.customer_visible ?? stored.customerVisible,
        config: {
          ...stored.config,
          definition: {
            ...def,
            start: args.start ? pickConditions(avail.hit, args.start, "start", "Start") : def.start,
            pause: args.pause ? pickConditions(avail.match, args.pause, "pause", "Pause") : def.pause,
            stop: args.stop ? pickConditions(avail.hit, args.stop, "stop", "Stop") : def.stop,
          },
          goals: args.goals ? buildGoals(args.goals, refs, false) : stored.config.goals,
        },
      };
      const summary = `Update SLA ${stored.id} '${stored.name}' in ${sd.projectKey}`;
      if (shapeOf(body) === shapeOf(stored)) return alreadySatisfied(summary, "it already has these settings");
      const recalc = !!(args.start || args.pause || args.stop || args.goals);
      const req = { method: "PUT" as const, path: `${IJ}/agent/${sd.projectKey}/sla/metrics/${stored.id}`, json: body, summary };
      const identity = { op: "update-sla", sd: sd.id, sla: args.sla, name: args.name, start: args.start, pause: args.pause, stop: args.stop, goals: args.goals, customerVisible: args.customer_visible };
      if (args.dry_run !== false) {
        return { ...(await guardedWrite(c, args, req)), before: goalSummary(stored.config.goals, refs), after: goalSummary(body.config.goals, refs), warning: recalc ? RECALC : undefined, identity, state: shapeOf(stored) };
      }
      await c.request("PUT", req.path, { json: body });
      const back = pickMetric(await metrics(c, sd), String(stored.id));
      if (!back || shapeOf(back) !== shapeOf(body)) throw new VerificationError(`${summary}: the SLA does not read back as updated`, back);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: back.id, name: back.name, goals: goalSummary(back.config.goals, refs) } };
    },
  },
  {
    name: "jira_delete_sla",
    product: "jira",
    write: true,
    description: "Delete an SLA metric (irreversible: the SLA values recorded on requests are lost). Already gone → already-satisfied. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, sla: z.coerce.string().min(1), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "SLA changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const stored = pickMetric(await metrics(c, sd), args.sla);
      if (!stored) return alreadySatisfied(`Delete SLA '${args.sla}'`, "no such SLA");
      return guardedWrite(c, args, {
        method: "DELETE",
        path: `${IJ}/agent/${sd.projectKey}/sla/metrics/${stored.id}`,
        summary: `Delete SLA ${stored.id} '${stored.name}' in ${sd.projectKey} — irreversible: the SLA values recorded on requests are lost`,
      });
    },
  },
  {
    name: "jira_create_sla_calendar",
    product: "jira",
    write: true,
    description:
      "Create an SLA calendar: name, time_zone (e.g. Europe/Moscow), working_hours (24x7, or e.g. 'mon-fri 09:00-18:00'), " +
      "optional holidays (JSON list as JSM stores them). Same name and settings → already-satisfied. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, name: z.string().trim().min(1).max(63), time_zone: z.string().min(1), working_hours: z.string().min(1), description: z.string().optional(), holidays: jsonArg(z.array(z.record(z.string(), z.any())), '[{"name":"New Year","date":"2026-01-01","recurring":true}]').optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "SLA calendar changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const body = { name: args.name, description: args.description ?? "", timeZone: args.time_zone, holidays: args.holidays ?? [], workingTimes: parseWorkingHours(args.working_hours) };
      const summary = `Create SLA calendar '${args.name}' (${args.time_zone}, ${describeWorkingTimes(body.workingTimes)}) in ${sd.projectKey}`;
      const existing = (await calendarDetails(c, sd)).find((x) => sameName(x.name, args.name));
      if (existing) {
        const d = existing.detail ?? {};
        const same = d.timeZone === body.timeZone && describeWorkingTimes(d.workingTimes ?? []) === describeWorkingTimes(body.workingTimes);
        if (same) return alreadySatisfied(summary, `calendar ${existing.id} '${existing.name}' already has these settings`);
        throw new ValidationError(`Calendar '${existing.name}' already exists with other settings; use jira_update_sla_calendar`);
      }
      const req = { method: "POST" as const, path: `${IJ}/${sd.id}/sla/calendars`, json: body, summary };
      const identity = { op: "create-calendar", sd: sd.id, ...body };
      if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), identity };
      await c.request("POST", req.path, { json: body });
      const back = (await calendarDetails(c, sd)).find((x) => x.name === args.name);
      if (!back) throw new VerificationError(`${summary}: the calendar is not listed after creation`);
      return { dry_run: false, product: c.product, summary, request: (await guardedWrite(c, { dry_run: true }, req)).request, result: { id: back.id, name: back.name } };
    },
  },
  {
    name: "jira_update_sla_calendar",
    product: "jira",
    write: true,
    description: "Change an SLA calendar's name, description, time zone, working hours or holidays. SLAs using it are recalculated. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, calendar: z.coerce.string().min(1), name: z.string().trim().min(1).max(63).optional(), time_zone: z.string().optional(), working_hours: z.string().optional(), description: z.string().optional(), holidays: jsonArg(z.array(z.record(z.string(), z.any())), '[{"name":"New Year","date":"2026-01-01","recurring":true}]').optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "SLA calendar changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const cal = (await calendarDetails(c, sd)).find((x) => x.id !== undefined && (String(x.id) === args.calendar || sameName(x.name, args.calendar)));
      if (!cal) throw new ValidationError(`No editable calendar '${args.calendar}' (the Default 24/7 calendar cannot be changed)`);
      const d = cal.detail;
      const body = { ...d, name: args.name ?? d.name, description: args.description ?? d.description, timeZone: args.time_zone ?? d.timeZone, holidays: args.holidays ?? d.holidays, workingTimes: args.working_hours ? parseWorkingHours(args.working_hours) : d.workingTimes };
      const summary = `Update SLA calendar ${cal.id} '${cal.name}' in ${sd.projectKey}`;
      const comparable = (x: any) => JSON.stringify({ n: x.name, d: x.description, t: x.timeZone, h: x.holidays, w: describeWorkingTimes(x.workingTimes ?? []) });
      if (comparable(body) === comparable(d)) return alreadySatisfied(summary, "it already has these settings");
      return { ...(await guardedWrite(c, args, { method: "PUT", path: `${IJ}/${sd.id}/sla/calendars/${cal.id}`, json: body, summary })), warning: (cal.dependentMetrics ?? []).length ? `${RECALC} (used by ${(cal.dependentMetrics ?? []).map((m: any) => m.metricName).join(", ")})` : undefined, identity: { op: "update-calendar", calendar: args.calendar, name: args.name, timeZone: args.time_zone, workingHours: args.working_hours, holidays: args.holidays }, state: comparable(d) };
    },
  },
  {
    name: "jira_delete_sla_calendar",
    product: "jira",
    write: true,
    description: "Delete an SLA calendar. Refused while SLA goals use it. Already gone → already-satisfied. Internal JSM API, JSM 11.3.x only.",
    inputShape: { service_desk: sdArg, calendar: z.coerce.string().min(1), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      await requireJsmVersion(c, "SLA calendar changes");
      const sd = await resolveServiceDesk(c, args.service_desk);
      const cal = (await calendarDetails(c, sd)).find((x) => x.id !== undefined && (String(x.id) === args.calendar || sameName(x.name, args.calendar)));
      if (!cal) return alreadySatisfied(`Delete SLA calendar '${args.calendar}'`, "no such calendar");
      const users = (cal.dependentMetrics ?? []).map((m: any) => m.metricName);
      if (users.length) throw new ValidationError(`Calendar '${cal.name}' is used by SLA goals of: ${users.join(", ")}; change those goals first`);
      return guardedWrite(c, args, { method: "DELETE", path: `${IJ}/${sd.id}/sla/calendars/${cal.id}`, summary: `Delete SLA calendar ${cal.id} '${cal.name}' in ${sd.projectKey}` });
    },
  },
];
