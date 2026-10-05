/**
 * Jira issue links, remote links and epic links, ported from sooperset/mcp-atlassian (MIT, jira/links.py, jira/epics.py).
 * Core paths checked against jira-rest-plugin 11.3.2 (/issueLinkType, /issueLink, /issue/{key}/remotelink).
 */

import { z } from "zod";
import { seg } from "../../client.js";
import { ValidationError } from "../../errors.js";
import { markdownToJiraWiki } from "../../markup.js";
import type { ToolDef } from "../types.js";
import { boolArg, contains, dryRunShape, guardedWrite } from "../util.js";
import { API, discoverEpicFields } from "./shape.js";

const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, "expected an issue key like PROJ-123");

export const jiraLinkTools: ToolDef[] = [
  {
    name: "jira_get_link_types",
    product: "jira",
    description: "Issue link types with inward/outward wording (e.g. Blocks: 'is blocked by' / 'blocks').",
    inputShape: { name_contains: z.string().optional() },
    async handler({ client }, args) {
      const data = await client("jira").get(`${API}/issueLinkType`);
      return (data?.issueLinkTypes ?? [])
        .filter((t: any) => contains(t.name, args.name_contains))
        .map((t: any) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward }));
    },
  },
  {
    name: "jira_link_to_epic",
    product: "jira",
    write: true,
    description:
      "Link an issue to an epic via the Epic Link field (discovered from /field). Falls back to the parent field " +
      "when the instance has no Epic Link field.",
    inputShape: { issue_key: issueKey, epic_key: issueKey, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      const epic = await discoverEpicFields(c);
      const fields = epic.epicLink ? { [epic.epicLink]: args.epic_key } : { parent: { key: args.epic_key } };
      return guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/issue/${seg(args.issue_key)}`,
        json: { fields },
        summary: `Link ${args.issue_key} to epic ${args.epic_key} via ${epic.epicLink ?? "parent"}`,
      });
    },
  },
  {
    name: "jira_create_issue_link",
    product: "jira",
    write: true,
    description:
      "Link two issues. link_type is the type name (jira_get_link_types); outward_issue_key <outward wording> " +
      "inward_issue_key, e.g. Blocks: outward blocks inward. Optional Markdown comment on the outward issue.",
    inputShape: {
      link_type: z.string(),
      inward_issue_key: issueKey,
      outward_issue_key: issueKey,
      comment: z.string().optional().describe("Markdown"),
      comment_visibility: z
        .object({ type: z.enum(["group", "role"]), value: z.string() })
        .optional()
        .describe('e.g. {"type":"role","value":"Developers"}'),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body: Record<string, unknown> = {
        type: { name: args.link_type },
        inwardIssue: { key: args.inward_issue_key },
        outwardIssue: { key: args.outward_issue_key },
      };
      if (args.comment) {
        body.comment = {
          body: markdownToJiraWiki(args.comment),
          ...(args.comment_visibility ? { visibility: args.comment_visibility } : {}),
        };
      }
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/issueLink`,
        json: body,
        summary: `Link ${args.outward_issue_key} -[${args.link_type}]-> ${args.inward_issue_key}`,
      });
    },
  },
  {
    name: "jira_create_remote_issue_link",
    product: "jira",
    write: true,
    description: "Add a web link (remote link) to an issue: URL, title, optional summary, relationship and 16x16 icon.",
    inputShape: {
      issue_key: issueKey,
      url: z.string().url(),
      title: z.string(),
      summary: z.string().optional(),
      relationship: z.string().optional().describe("e.g. 'mentioned in'"),
      icon_url: z.string().url().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const object: Record<string, unknown> = { url: args.url, title: args.title };
      if (args.summary) object.summary = args.summary;
      if (args.icon_url) object.icon = { url16x16: args.icon_url, title: args.title };
      const body: Record<string, unknown> = { object };
      if (args.relationship) body.relationship = args.relationship;
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/issue/${seg(args.issue_key)}/remotelink`,
        json: body,
        summary: `Add remote link '${args.title}' to ${args.issue_key}`,
      });
    },
  },
  {
    name: "jira_remove_issue_link",
    product: "jira",
    write: true,
    description: "Delete an issue link by id (the id of an entry in the issue's issuelinks field).",
    inputShape: { link_id: z.coerce.string(), ...dryRunShape },
    async handler({ client }, args) {
      if (!/^\d+$/.test(args.link_id)) throw new ValidationError("link_id must be numeric");
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/issueLink/${args.link_id}`,
        summary: `Delete issue link ${args.link_id}`,
      });
    },
  },
  {
    name: "jira_get_issue_links",
    product: "jira",
    description: "Links of one issue: id (for jira_remove_issue_link), type wording, other issue key/status/summary, plus remote links.",
    inputShape: { issue_key: issueKey, include_remote: boolArg.optional().describe("Default true") },
    async handler({ client }, args) {
      const c = client("jira");
      const issue = await c.get(`${API}/issue/${seg(args.issue_key)}`, { fields: "issuelinks" });
      const links = (issue?.fields?.issuelinks ?? []).map((l: any) => {
        const other = l.outwardIssue ?? l.inwardIssue;
        return {
          id: l.id,
          relation: l.outwardIssue ? l.type?.outward : l.type?.inward,
          issue: other?.key,
          status: other?.fields?.status?.name,
          summary: other?.fields?.summary,
        };
      });
      const out: Record<string, unknown> = { issue: args.issue_key, links };
      if (args.include_remote !== false) {
        const remote: any[] = (await c.get(`${API}/issue/${seg(args.issue_key)}/remotelink`)) ?? [];
        out.remote = remote.map((r) => ({ id: r.id, title: r.object?.title, url: r.object?.url, relationship: r.relationship }));
      }
      return out;
    },
  },
];
