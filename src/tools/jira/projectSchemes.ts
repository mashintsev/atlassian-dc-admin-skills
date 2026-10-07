/**
 * Assign a scheme to a Jira project.
 *
 * Only two scheme types have a REST path on Jira DC 11.3 (checked in the WADL): the notification
 * scheme (`PUT /project/{key}` with `notificationScheme`) and the issue type scheme
 * (`POST /issuetypescheme/{id}/associations`). Workflow, issue type screen and field configuration
 * schemes are assigned through admin forms behind websudo, which a token cannot pass, so they are
 * manual changes: a link to the project's admin page, nothing sent, and a re-run that verifies the
 * assignment where Jira lets us read it. An issue type scheme that would need an issue migration is
 * a manual change too: this tool never migrates issues.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, UnsupportedError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, guardedWrite } from "../util.js";
import { parseWhereIsMyField, probeField, whereIsMyField } from "./screens.js";

const API = "/rest/api/2";

const SCHEME_TYPES = ["workflow", "issue_type", "issue_type_screen", "field_configuration", "notification"] as const;
type SchemeType = (typeof SCHEME_TYPES)[number];

/** The admin page where Jira assigns each scheme type to a project (relative to the base URL). */
const ADMIN_PAGES: Record<Exclude<SchemeType, "notification">, string> = {
  workflow: "/secure/admin/SelectProjectWorkflowScheme!default.jspa",
  issue_type: "/secure/admin/SelectIssueTypeSchemeForProject!default.jspa",
  issue_type_screen: "/secure/admin/SelectIssueTypeScreenScheme!default.jspa",
  field_configuration: "/secure/admin/SelectFieldLayoutScheme!default.jspa",
};

const WEBSUDO = "Jira assigns this scheme type only through an admin form behind websudo re-authentication, which a personal access token cannot pass";

/**
 * A dry run for a change entered in the Jira UI: nothing is sent (the CLI asks no confirmation for it);
 * executing it is refused. Re-running the tool afterwards verifies the change.
 */
export function manualChange(
  client: AtlassianClient,
  args: { dry_run?: boolean },
  m: { summary: string; reason: string; editUrl: string; identity: Record<string, unknown>; state: unknown; extra?: Record<string, unknown> },
) {
  if (args.dry_run === false) {
    throw new UnsupportedError(`${m.summary} cannot be done through the API: ${m.reason}. Do it at ${m.editUrl}, then re-run to verify`, { editUrl: m.editUrl });
  }
  return {
    dry_run: true,
    product: client.product,
    summary: `${m.summary} (in the Jira UI)`,
    request: { method: "MANUAL", url: m.editUrl },
    manual: { reason: m.reason, editUrl: m.editUrl },
    ...m.extra,
    identity: m.identity,
    state: m.state,
    note: "Nothing is sent. Make the change at the link, then run the tool again to verify.",
  };
}

async function project(client: AtlassianClient, key: string): Promise<{ id: string; key: string; issueTypes: any[] }> {
  const p = await client.get(`${API}/project/${seg(key)}`);
  return { id: String(p.id), key: String(p.key ?? key), issueTypes: p.issueTypes ?? [] };
}

/** The current scheme of a type as {id, name}, null when there is none, or undefined when Jira does not tell. */
async function currentScheme(client: AtlassianClient, type: SchemeType, proj: { key: string; issueTypes: any[] }): Promise<{ id: number; name?: string } | null | undefined> {
  const read = async (path: string) => {
    try {
      const s = await client.get(path);
      return s?.id !== undefined && s?.id !== null ? { id: Number(s.id), name: s.name } : null;
    } catch (e) {
      if (isHttpStatusError(e) && e.status === 404) return null;
      throw e;
    }
  };
  if (type === "notification") return read(`${API}/project/${seg(proj.key)}/notificationscheme`);
  if (type === "workflow") return read(`${API}/project/${seg(proj.key)}/workflowscheme`);
  if (type === "issue_type_screen") {
    // "Where is my field" names the issue type screen scheme of a project's issue type
    const probe = await probeField(client);
    const it = proj.issueTypes[0];
    if (!probe || !it) return undefined;
    // the scheme link appears in the create or the edit answer, depending on where the probe field sits
    for (const op of [0, 1] as const) {
      const w = parseWhereIsMyField(await whereIsMyField(client, probe, proj.key, String(it.id), op));
      if (w.issueTypeScreenSchemeId) return { id: Number(w.issueTypeScreenSchemeId) };
    }
    return undefined;
  }
  // issue_type is checked through the target's associations; field_configuration has no read
  return undefined;
}

async function issueTypeSchemeProjects(client: AtlassianClient, schemeId: number): Promise<string[]> {
  const list: any[] = (await client.get(`${API}/issuetypescheme/${schemeId}/associations`)) ?? [];
  return list.map((p) => String(p?.key ?? p));
}

export const jiraProjectSchemeTools: ToolDef[] = [
  {
    name: "jira_assign_project_scheme",
    product: "jira",
    write: true,
    invalidates: ["workflow-usage", "screen-usage"],
    description:
      "Assign a scheme to a project: scheme_type notification or issue_type through REST (read back); workflow, " +
      "issue_type_screen and field_configuration as a manual change with the project's admin link (Jira does them only " +
      "in the UI; re-run to verify). An issue type scheme that would need an issue migration is a manual change too. " +
      "Already assigned → already-satisfied.",
    inputShape: {
      project_key: z.string().min(1),
      scheme_type: z.enum(SCHEME_TYPES),
      scheme_id: z.coerce.number().int().min(0).describe("Id of the scheme to assign"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const type = args.scheme_type as SchemeType;
      const proj = await project(c, args.project_key);
      const summary = `Assign ${type.replace(/_/g, " ")} scheme ${args.scheme_id} to project ${proj.key}`;
      const identity = { op: "assign-project-scheme", project: proj.key, type, scheme: args.scheme_id };

      if (type === "issue_type") {
        const scheme = await c.get(`${API}/issuetypescheme/${args.scheme_id}`, { expand: "issueTypes" });
        if ((await issueTypeSchemeProjects(c, args.scheme_id)).includes(proj.key)) {
          return alreadySatisfied(summary, `project ${proj.key} already uses issue type scheme '${scheme?.name ?? args.scheme_id}'`);
        }
        const ids: string[] = (scheme?.issueTypes ?? []).map((t: any) => String(t.id));
        const jql = `project = ${proj.key}${ids.length ? ` AND issuetype not in (${ids.join(",")})` : ""}`;
        const foreign = Number((await c.get(`${API}/search`, { jql, maxResults: 0, fields: "none" }))?.total ?? 0);
        if (foreign > 0) {
          return manualChange(c, args, {
            summary,
            reason: `${foreign} issues of ${proj.key} have issue types that '${scheme?.name ?? args.scheme_id}' lacks, so Jira would migrate them; this tool never migrates issues`,
            editUrl: `${ADMIN_PAGES.issue_type}?projectId=${proj.id}`,
            identity,
            state: { foreign },
          });
        }
        const req = { method: "POST" as const, path: `${API}/issuetypescheme/${args.scheme_id}/associations`, json: { idsOrKeys: [proj.key] }, summary };
        if (args.dry_run !== false) return { ...(await guardedWrite(c, args, req)), target: { id: args.scheme_id, name: scheme?.name }, identity, state: { assigned: false } };
        const result = await guardedWrite(c, args, req);
        const now = await issueTypeSchemeProjects(c, args.scheme_id);
        if (!now.includes(proj.key)) throw new VerificationError(`${summary}: the scheme's projects do not include ${proj.key} afterwards`, { projects: now });
        return { ...result, result: { project: proj.key, scheme: args.scheme_id } };
      }

      const current = await currentScheme(c, type, proj);
      if (current && current.id === args.scheme_id) {
        return alreadySatisfied(summary, `project ${proj.key} already uses ${type.replace(/_/g, " ")} scheme ${args.scheme_id}${current.name ? ` '${current.name}'` : ""}`);
      }

      if (type === "notification") {
        const target = await c.get(`${API}/notificationscheme/${args.scheme_id}`);
        const req = { method: "PUT" as const, path: `${API}/project/${seg(proj.key)}`, json: { notificationScheme: args.scheme_id }, summary };
        if (args.dry_run !== false) {
          return { ...(await guardedWrite(c, args, req)), before: current ?? null, after: { id: args.scheme_id, name: target?.name }, identity, state: { current: current?.id ?? null } };
        }
        const result = await guardedWrite(c, args, req);
        const back = await currentScheme(c, type, proj);
        if (back?.id !== args.scheme_id) throw new VerificationError(`${summary}: the project reads back with scheme ${back?.id ?? "(none)"}`, back);
        return { ...result, result: back };
      }

      const verifiable = type !== "field_configuration";
      return manualChange(c, args, {
        summary,
        reason: WEBSUDO + (verifiable ? "" : "; Jira offers no REST read of a project's field configuration scheme, so a re-run cannot verify it"),
        editUrl: `${ADMIN_PAGES[type]}?projectId=${proj.id}`,
        identity,
        state: { current: current?.id ?? null },
        extra: { before: current ?? null },
      });
    },
  },
];
