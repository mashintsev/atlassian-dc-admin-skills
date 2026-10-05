/**
 * Jira assignable-user search and watchers, ported from sooperset/mcp-atlassian (MIT, jira/users.py, jira/watchers.py).
 * Checked against jira-rest-plugin 11.3.2: GET /user/assignable/search (username, project, issueKey, maxResults),
 * GET/POST/DELETE /issue/{key}/watchers (POST body is a JSON string with the username; DELETE takes ?username=).
 */

import { z } from "zod";
import { seg } from "../../client.js";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { dryRunShape, guardedWrite, MAX_PAGE } from "../util.js";
import { API } from "./shape.js";

function compactUser(u: any) {
  return { name: u?.name, displayName: u?.displayName, email: u?.emailAddress, active: u?.active, key: u?.key };
}

export const jiraCollabTools: ToolDef[] = [
  {
    name: "jira_search_assignable_users",
    product: "jira",
    description:
      "Users who can be assigned in a project or on an issue, by name/username/e-mail fragment. Needs only " +
      "browse/assign permission (unlike jira_find_users, which needs Browse Users).",
    inputShape: {
      query: z.string(),
      project_key: z.string().optional(),
      issue_key: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional().describe(`Default 20, max ${MAX_PAGE} (the endpoint has no offset)`),
    },
    async handler({ client }, args) {
      if (!args.project_key === !args.issue_key) throw new ValidationError("Pass exactly one of project_key or issue_key");
      const users: any[] =
        (await client("jira").get(`${API}/user/assignable/search`, {
          username: args.query,
          project: args.project_key,
          issueKey: args.issue_key,
          maxResults: args.limit ?? 20,
        })) ?? [];
      return { returned: users.length, items: users.map(compactUser) };
    },
  },
  {
    name: "jira_get_issue_watchers",
    product: "jira",
    description: "Watchers of an issue and the watch count.",
    inputShape: { issue_key: z.string() },
    async handler({ client }, args) {
      const data = await client("jira").get(`${API}/issue/${seg(args.issue_key)}/watchers`);
      return {
        issue: args.issue_key,
        watchCount: data?.watchCount,
        isWatching: data?.isWatching,
        watchers: (data?.watchers ?? []).map(compactUser),
      };
    },
  },
  {
    name: "jira_add_watcher",
    product: "jira",
    write: true,
    description: "Add a user (username) as watcher of an issue.",
    inputShape: { issue_key: z.string(), username: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/issue/${seg(args.issue_key)}/watchers`,
        json: args.username,
        summary: `Add watcher ${args.username} to ${args.issue_key}`,
      });
    },
  },
  {
    name: "jira_remove_watcher",
    product: "jira",
    write: true,
    description: "Remove a watcher (username) from an issue.",
    inputShape: { issue_key: z.string(), username: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/issue/${seg(args.issue_key)}/watchers`,
        params: { username: args.username },
        summary: `Remove watcher ${args.username} from ${args.issue_key}`,
      });
    },
  },
];
