/**
 * Jira worklogs, ported from sooperset/mcp-atlassian (MIT, jira/worklog.py).
 * Checked against jira-rest-plugin 11.3.2: GET /issue/{key}/worklog (no paging params on DC),
 * POST /issue/{key}/worklog?adjustEstimate&newEstimate&reduceBy.
 *
 * Upstream converts time_spent to seconds with 1d = 24h and 1w = 7d; here `timeSpent` is sent
 * as text so Jira applies the instance's time tracking settings (e.g. 1d = 8h).
 */

import { z } from "zod";
import { seg } from "../../client.js";
import { jiraWikiToMarkdown, markdownToJiraWiki } from "../../markup.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, pageShape, paginate } from "../util.js";
import { API } from "./shape.js";

const DURATION = /^\s*(\d+(\.\d+)?\s*[wdhm]\s*)+$/i;

export const jiraWorklogTools: ToolDef[] = [
  {
    name: "jira_get_worklog",
    product: "jira",
    description: "Worklogs of an issue, newest first: author, started, time spent, comment (Markdown). totalHours covers all worklogs.",
    inputShape: { issue_key: z.string(), oldest_first: boolArg.optional(), ...pageShape(50) },
    async handler({ client }, args) {
      // GET /issue/{key}/worklog has no paging params on DC (IssueResource#getIssueWorklog): one call, paged here
      const data = await client("jira").get(`${API}/issue/${seg(args.issue_key)}/worklog`);
      const sorted = [...(data?.worklogs ?? [])].sort((a: any, b: any) => String(a.started ?? "").localeCompare(String(b.started ?? "")));
      if (!args.oldest_first) sorted.reverse();
      const items = sorted.map((w: any) => ({
        id: w.id,
        author: w.author?.name ?? w.author?.displayName,
        started: w.started,
        timeSpent: w.timeSpent,
        seconds: w.timeSpentSeconds,
        comment: w.comment ? jiraWikiToMarkdown(String(w.comment)) : undefined,
      }));
      const totalSeconds = items.reduce((s: number, w: any) => s + (w.seconds ?? 0), 0);
      return { totalHours: Math.round((totalSeconds / 3600) * 100) / 100, ...paginate(items, args, 50) };
    },
  },
  {
    name: "jira_add_worklog",
    product: "jira",
    write: true,
    description:
      "Log work on an issue. time_spent uses Jira duration syntax (1w 2d 3h 30m) and the instance's time tracking " +
      "settings. remaining_estimate sets the new remaining estimate; otherwise Jira reduces it automatically. " +
      "Change the original estimate with an issue field update (timetracking).",
    inputShape: {
      issue_key: z.string(),
      time_spent: z.string().regex(DURATION, "Jira duration like '1h 30m', '2d', '45m'"),
      comment: z.string().optional().describe("Markdown"),
      started: z.string().optional().describe("e.g. 2026-10-05T10:00:00.000+0300 (default: now)"),
      remaining_estimate: z.string().regex(DURATION).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body: Record<string, unknown> = { timeSpent: args.time_spent.trim() };
      if (args.comment) body.comment = markdownToJiraWiki(args.comment);
      if (args.started) body.started = args.started;
      const params = args.remaining_estimate
        ? { adjustEstimate: "new", newEstimate: args.remaining_estimate }
        : { adjustEstimate: "auto" };
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/issue/${seg(args.issue_key)}/worklog`,
        params,
        json: body,
        summary: `Log ${args.time_spent} on ${args.issue_key}`,
      });
    },
  },
];
