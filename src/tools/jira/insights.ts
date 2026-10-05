/**
 * Jira issue metrics, development info and project analysis, ported from sooperset/mcp-atlassian
 * (MIT, jira/metrics.py, jira/sla.py, jira/development.py, jira/project_analysis.py).
 *
 * Metrics are computed client-side from GET /issue/{key}?expand=changelog (no JSM SLA fields).
 * Development info uses the dev-status plugin API (/rest/dev-status/1.0, not verified against a jar).
 * Project analysis pages /rest/api/2/search and is capped by `max_issues` / `max_epics`.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, listArg } from "../util.js";
import { API } from "./shape.js";

const DEV = "/rest/dev-status/1.0";

// -- status timeline ----------------------------------------------------------------

export interface StatusPeriod {
  status: string;
  from: string;
  to: string | null;
  minutes: number;
  by?: string;
}

function minutesBetween(a: string | Date, b: string | Date): number {
  return Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
}

export function formatMinutes(total: number): string {
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [d ? `${d}d` : "", h ? `${h}h` : "", m || (!d && !h) ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** Periods spent in each status, from creation to now, out of the issue changelog. */
export function statusTimeline(issue: any, now: Date = new Date()): StatusPeriod[] {
  const f = issue?.fields ?? {};
  const changes = (issue?.changelog?.histories ?? [])
    .flatMap((h: any) =>
      (h.items ?? [])
        .filter((i: any) => String(i.field).toLowerCase() === "status")
        .map((i: any) => ({ at: h.created, from: i.fromString, to: i.toString, by: h.author?.name ?? h.author?.displayName })),
    )
    .sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));

  const periods: StatusPeriod[] = [];
  let status = changes[0]?.from ?? f.status?.name ?? "?";
  let since = f.created;
  let by: string | undefined;
  for (const c of changes) {
    periods.push({ status, from: since, to: c.at, minutes: minutesBetween(since, c.at), by });
    status = c.to;
    since = c.at;
    by = c.by;
  }
  periods.push({ status, from: since, to: null, minutes: minutesBetween(since, now), by });
  return periods;
}

function summarise(periods: StatusPeriod[]) {
  const byStatus = new Map<string, { minutes: number; visits: number }>();
  for (const p of periods) {
    const s = byStatus.get(p.status) ?? { minutes: 0, visits: 0 };
    s.minutes += p.minutes;
    s.visits += 1;
    byStatus.set(p.status, s);
  }
  const total = [...byStatus.values()].reduce((a, s) => a + s.minutes, 0) || 1;
  return [...byStatus.entries()]
    .sort((a, b) => b[1].minutes - a[1].minutes)
    .map(([status, s]) => ({
      status,
      time: formatMinutes(s.minutes),
      minutes: s.minutes,
      percent: Math.round((s.minutes / total) * 1000) / 10,
      visits: s.visits,
    }));
}

async function issueWithChangelog(client: AtlassianClient, key: string) {
  return client.get(`${API}/issue/${seg(key)}`, {
    fields: "status,created,updated,duedate,resolutiondate",
    expand: "changelog",
  });
}

// -- working hours ---------------------------------------------------------------------

interface WorkingHours {
  start: number; // minutes from midnight
  end: number;
  days: Set<number>; // ISO weekday 1..7
  timeZone: string;
}

function localParts(d: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", weekday: "short", hour: "2-digit", minute: "2-digit",
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday) + 1;
  return { weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Working minutes between two instants, stepping one minute at a time in chunks of whole hours outside work. */
export function workingMinutes(from: string | Date, to: string | Date, wh: WorkingHours): number {
  let t = new Date(from).getTime();
  const end = new Date(to).getTime();
  let total = 0;
  const MAX_STEPS = 2_000_000; // ~3.8 years of minutes; guards runaway loops
  for (let i = 0; t < end && i < MAX_STEPS; i++) {
    const { weekday, minute } = localParts(new Date(t), wh.timeZone);
    if (wh.days.has(weekday) && minute >= wh.start && minute < wh.end) {
      const step = Math.min(wh.end - minute, Math.ceil((end - t) / 60000));
      total += step;
      t += step * 60000;
    } else {
      t += 60000 * (minute < wh.start && wh.days.has(weekday) ? Math.max(1, wh.start - minute) : Math.max(1, 60 - (minute % 60)));
    }
  }
  return total;
}

function parseClock(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new ValidationError(`Expected HH:MM, got ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

function parseDays(s: string): Set<number> {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    for (let d = a; d <= (b ?? a); d++) if (d >= 1 && d <= 7) out.add(d);
  }
  return out;
}

const METRICS = ["cycle_time", "lead_time", "time_in_status", "due_date_compliance", "resolution_time", "first_response_time"] as const;

// -- dev-status ------------------------------------------------------------------------

const DATA_TYPES = ["pullrequest", "branch", "repository"] as const;

async function devInfo(client: AtlassianClient, key: string, appType?: string, dataType?: string, maxCommits = 20) {
  const issue = await client.get(`${API}/issue/${seg(key)}`, { fields: "id" });
  const issueId = issue?.id;
  let apps: string[] = appType ? [appType] : [];
  if (!appType) {
    try {
      const summary = await client.get(`${DEV}/issue/summary`, { issueId });
      const found = new Set<string>();
      for (const dt of DATA_TYPES) {
        for (const [inst, v] of Object.entries<any>(summary?.summary?.[dt]?.byInstanceType ?? {})) {
          if ((v?.count ?? 0) > 0) found.add(inst === "github" ? "GitHub" : inst === "gitlab" ? "GitLab" : inst);
        }
      }
      apps = [...found];
    } catch (e) {
      if (!isHttpStatusError(e)) throw e;
      apps = ["stash", "bitbucket", "GitHub", "GitLab"];
    }
  }
  const out = {
    issue: key,
    pullRequests: [] as any[],
    branches: [] as any[],
    commits: [] as any[],
    repositories: [] as string[],
    error: undefined as string | undefined,
  };
  const repos = new Set<string>();
  for (const app of apps) {
    for (const dt of dataType ? [dataType] : DATA_TYPES) {
      let data: any;
      try {
        data = await client.get(`${DEV}/issue/detail`, { issueId, applicationType: app, dataType: dt });
      } catch (e) {
        if (isHttpStatusError(e) && (e.status === 404 || e.status === 403)) {
          out.error = e.status === 404 ? "dev-status plugin may not be installed" : "access denied to development info";
          return out;
        }
        throw e;
      }
      for (const d of data?.detail ?? []) {
        for (const pr of d.pullRequests ?? []) {
          out.pullRequests.push({
            id: pr.id, name: pr.name, status: pr.status, url: pr.url,
            source: pr.source?.branch, destination: pr.destination?.branch,
            author: pr.author?.name, reviewers: (pr.reviewers ?? []).map((r: any) => r.name),
            updated: pr.lastUpdate, repository: pr.repositoryName,
          });
        }
        for (const b of d.branches ?? []) out.branches.push({ name: b.name, url: b.url, repository: b.repository?.name });
        for (const r of d.repositories ?? []) {
          if (r.name) repos.add(r.name);
          for (const c of r.commits ?? []) {
            if (out.commits.length < maxCommits) {
              out.commits.push({ id: c.displayId ?? c.id, message: String(c.message ?? "").split("\n")[0], author: c.author?.name, at: c.authorTimestamp, repository: r.name });
            }
          }
        }
      }
    }
  }
  out.repositories = [...repos];
  return out;
}

// -- search paging for analysis -------------------------------------------------------

async function searchAll(client: AtlassianClient, jql: string, fields: string, max: number): Promise<{ issues: any[]; total: number }> {
  const issues: any[] = [];
  let total = 0;
  while (issues.length < max) {
    const data = await client.get(`${API}/search`, { jql, fields, startAt: issues.length, maxResults: Math.min(50, max - issues.length) });
    total = data?.total ?? 0;
    const batch: any[] = data?.issues ?? [];
    issues.push(...batch);
    if (batch.length === 0 || issues.length >= total) break;
  }
  return { issues, total };
}

function quoteKey(key: string): string {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new ValidationError(`Invalid project key: ${key}`);
  return `"${key}"`;
}

const CHILD_OF = new Set(["is child of", "is contained by", "split from"]);

// -- tools ----------------------------------------------------------------------------

export const jiraInsightTools: ToolDef[] = [
  {
    name: "jira_get_issue_dates",
    product: "jira",
    description: "Key dates of an issue plus time spent in each status (from the changelog).",
    inputShape: {
      issue_key: z.string(),
      include_status_changes: boolArg.optional().describe("Default true: list every status period"),
      include_status_summary: boolArg.optional().describe("Default true: total time per status"),
    },
    async handler({ client }, args) {
      const issue = await issueWithChangelog(client("jira"), args.issue_key);
      const f = issue?.fields ?? {};
      const periods = statusTimeline(issue);
      return {
        issue: args.issue_key,
        created: f.created,
        updated: f.updated,
        due: f.duedate,
        resolved: f.resolutiondate,
        status: f.status?.name,
        statusChanges:
          args.include_status_changes === false
            ? undefined
            : periods.map((p) => ({ status: p.status, from: p.from, to: p.to, time: formatMinutes(p.minutes), by: p.by })),
        statusSummary: args.include_status_summary === false ? undefined : summarise(periods),
      };
    },
  },
  {
    name: "jira_get_issue_sla",
    product: "jira",
    description:
      "Client-side SLA metrics from the changelog (not JSM SLA fields): cycle_time, lead_time, time_in_status, " +
      "due_date_compliance, resolution_time, first_response_time. Optionally count working hours only.",
    inputShape: {
      issue_key: z.string(),
      metrics: listArg.optional().describe(`Default cycle_time,time_in_status; any of ${METRICS.join(", ")}`),
      working_hours_only: boolArg.optional(),
      work_start: z.string().optional().describe("HH:MM, default 09:00"),
      work_end: z.string().optional().describe("HH:MM, default 17:00"),
      work_days: z.string().optional().describe("ISO weekdays, default 1-5"),
      time_zone: z.string().optional().describe("IANA zone, default UTC"),
      include_raw_dates: boolArg.optional(),
    },
    async handler({ client }, args) {
      const c = client("jira");
      const wanted = new Set<string>((args.metrics ?? ["cycle_time", "time_in_status"]).filter((m: string) => (METRICS as readonly string[]).includes(m)));
      if (wanted.size === 0) throw new ValidationError(`metrics must include one of ${METRICS.join(", ")}`);
      const issue = await issueWithChangelog(c, args.issue_key);
      const f = issue?.fields ?? {};
      const now = new Date();
      const wh: WorkingHours | undefined = args.working_hours_only
        ? {
            start: parseClock(args.work_start ?? "09:00"),
            end: parseClock(args.work_end ?? "17:00"),
            days: parseDays(args.work_days ?? "1-5"),
            timeZone: args.time_zone ?? "UTC",
          }
        : undefined;
      const span = (a: string, b: string | Date) => (wh ? workingMinutes(a, b, wh) : minutesBetween(a, b));
      const periods = statusTimeline(issue, now).map((p) => ({ ...p, minutes: span(p.from, p.to ?? now) }));
      const metrics: Record<string, unknown> = {};
      const val = (m: number) => ({ minutes: m, time: formatMinutes(m) });

      if (wanted.has("cycle_time")) metrics.cycle_time = f.resolutiondate ? val(span(f.created, f.resolutiondate)) : { calculated: false, reason: "not resolved" };
      if (wanted.has("lead_time")) metrics.lead_time = { ...val(span(f.created, f.resolutiondate ?? now)), resolved: !!f.resolutiondate };
      if (wanted.has("time_in_status")) metrics.time_in_status = summarise(periods);
      if (wanted.has("due_date_compliance")) {
        if (!f.duedate) metrics.due_date_compliance = "no_due_date";
        else if (!f.resolutiondate) metrics.due_date_compliance = "not_resolved";
        else {
          const due = new Date(`${String(f.duedate).slice(0, 10)}T23:59:59Z`);
          const margin = Math.round((due.getTime() - Date.parse(f.resolutiondate)) / 60000);
          metrics.due_date_compliance = { result: margin >= 0 ? "met" : "missed", margin: formatMinutes(Math.abs(margin)) };
        }
      }
      if (wanted.has("resolution_time")) {
        const statuses: any[] = (await c.get(`${API}/status`)) ?? [];
        const inProgress = new Set(statuses.filter((s) => s.statusCategory?.key === "indeterminate").map((s) => s.name));
        const start = periods.find((p) => inProgress.has(p.status));
        metrics.resolution_time =
          start && f.resolutiondate ? val(span(start.from, f.resolutiondate)) : { calculated: false, reason: start ? "not resolved" : "never in progress" };
      }
      if (wanted.has("first_response_time")) {
        metrics.first_response_time = periods.length > 1 ? val(span(f.created, periods[1].from)) : { calculated: false, reason: "no status change" };
      }
      return {
        issue: args.issue_key,
        workingHours: wh ? `${args.work_start ?? "09:00"}-${args.work_end ?? "17:00"} days ${args.work_days ?? "1-5"} ${wh.timeZone}` : undefined,
        metrics,
        raw: args.include_raw_dates
          ? { created: f.created, resolved: f.resolutiondate, due: f.duedate, status: f.status?.name, periods: periods.map((p) => ({ status: p.status, from: p.from, to: p.to })) }
          : undefined,
      };
    },
  },
  {
    name: "jira_get_issue_development_info",
    product: "jira",
    description:
      "Pull requests, branches, commits and repositories linked to an issue (dev-status API; Bitbucket Server " +
      "application_type is 'stash'). Commits are capped by max_commits.",
    inputShape: {
      issue_key: z.string(),
      application_type: z.string().optional().describe("stash | bitbucket | GitHub | GitLab (case-sensitive)"),
      data_type: z.enum(DATA_TYPES).optional(),
      max_commits: z.coerce.number().int().min(0).optional().describe("Default 20"),
    },
    async handler({ client }, args) {
      return devInfo(client("jira"), args.issue_key, args.application_type, args.data_type, args.max_commits ?? 20);
    },
  },
  {
    name: "jira_get_issues_development_info",
    product: "jira",
    description: "Development info for several issues (one after another; at most 20 keys).",
    inputShape: {
      issue_keys: listArg,
      application_type: z.string().optional(),
      data_type: z.enum(DATA_TYPES).optional(),
      max_commits: z.coerce.number().int().min(0).optional().describe("Per issue, default 5"),
    },
    async handler({ client }, args) {
      if (args.issue_keys.length > 20) throw new ValidationError("At most 20 issue keys per call");
      const out = [];
      for (const key of args.issue_keys) {
        try {
          out.push(await devInfo(client("jira"), key, args.application_type, args.data_type, args.max_commits ?? 5));
        } catch (e: any) {
          out.push({ issue: key, error: String(e?.message ?? e) });
        }
      }
      return out;
    },
  },
  {
    name: "jira_get_project_epic_hierarchy",
    product: "jira",
    description:
      "Epics of a project grouped by their parent in another project (parent field or 'is child of'-style links). " +
      "Scans at most max_epics epics (default 200).",
    inputShape: { project_key: z.string(), max_epics: z.coerce.number().int().min(1).max(500).optional() },
    async handler({ client }, args) {
      const c = client("jira");
      const { issues, total } = await searchAll(
        c,
        `project = ${quoteKey(args.project_key)} AND issuetype = Epic ORDER BY updated DESC`,
        "summary,status,issuetype,issuelinks,parent",
        args.max_epics ?? 200,
      );
      const project = (k?: string) => k?.split("-")[0];
      const groups = new Map<string, any[]>();
      for (const e of issues) {
        let parent: string | undefined = e.fields?.parent?.key;
        if (!parent || project(parent) === args.project_key) {
          parent = undefined;
          for (const l of e.fields?.issuelinks ?? []) {
            const other = l.outwardIssue ?? l.inwardIssue;
            const label = String(l.outwardIssue ? l.type?.outward : l.type?.inward).toLowerCase();
            if (other && project(other.key) !== args.project_key && CHILD_OF.has(label)) {
              parent = other.key;
              break;
            }
          }
        }
        const k = parent ?? "(unlinked)";
        groups.set(k, [...(groups.get(k) ?? []), { key: e.key, summary: e.fields?.summary, status: e.fields?.status?.name }]);
      }
      const parentKeys = [...groups.keys()].filter((k) => k !== "(unlinked)");
      const parents = new Map<string, string>();
      for (let i = 0; i < parentKeys.length; i += 50) {
        const chunk = parentKeys.slice(i, i + 50);
        const data = await c.get(`${API}/search`, { jql: `key in (${chunk.join(",")})`, fields: "summary", maxResults: chunk.length });
        for (const p of data?.issues ?? []) parents.set(p.key, p.fields?.summary);
      }
      return {
        project: args.project_key,
        epicsScanned: issues.length,
        epicsTotal: total,
        groups: [...groups.entries()]
          .sort(([a], [b]) => (a === "(unlinked)" ? 1 : b === "(unlinked)" ? -1 : a.localeCompare(b)))
          .map(([parent, epics]) => ({ parent, parentSummary: parents.get(parent), epics })),
      };
    },
  },
  {
    name: "jira_get_cross_project_dependencies",
    product: "jira",
    description:
      "Links from a project's issues to issues in other projects, grouped by project and link type. " +
      "Scans at most max_issues issues (default 200), newest first.",
    inputShape: { project_key: z.string(), max_issues: z.coerce.number().int().min(1).max(500).optional() },
    async handler({ client }, args) {
      const { issues, total } = await searchAll(
        client("jira"),
        `project = ${quoteKey(args.project_key)} ORDER BY updated DESC`,
        "issuelinks",
        args.max_issues ?? 200,
      );
      const byProject: Record<string, { links: number; byType: Record<string, string[]> }> = {};
      let count = 0;
      for (const i of issues) {
        for (const l of i.fields?.issuelinks ?? []) {
          const other = l.outwardIssue ?? l.inwardIssue;
          const proj = other?.key?.split("-")[0];
          if (!proj || proj === args.project_key) continue;
          const wording = l.outwardIssue ? l.type?.outward : l.type?.inward;
          const entry = (byProject[proj] ??= { links: 0, byType: {} });
          entry.links++;
          (entry.byType[l.type?.name ?? "?"] ??= []).push(`${i.key} ${wording} ${other.key}`);
          count++;
        }
      }
      return { project: args.project_key, issuesScanned: issues.length, issuesTotal: total, crossProjectLinks: count, byProject };
    },
  },
];
