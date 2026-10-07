/**
 * Jira Software (agile) boards and sprints, ported from sooperset/mcp-atlassian (MIT, jira/boards.py, jira/sprints.py).
 * Paths and query params checked against jira-greenhopper-plugin 10.3.0 (BoardResource, BoardSprintResource,
 * SprintResource, BacklogResource).
 */

import { z } from "zod";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { dryRunShape, guardedWrite, listArg, pageShape, serverPage } from "../util.js";
import { AGILE, compactIssue, DEFAULT_ISSUE_FIELDS, refuseAllFields } from "./shape.js";

const SPRINT_STATES = ["future", "active", "closed"] as const;

function compactSprint(s: any): Record<string, unknown> {
  return {
    id: s?.id,
    name: s?.name,
    state: s?.state,
    goal: s?.goal,
    start: s?.startDate,
    end: s?.endDate,
    completed: s?.completeDate,
    board: s?.originBoardId,
  };
}

const issueListShape = {
  jql: z.string().optional().describe("Extra JQL filter, e.g. status = 'In Progress'"),
  fields: z.string().optional().describe(`Comma list of issue fields (default: ${DEFAULT_ISSUE_FIELDS}); extra fields become columns`),
  ...pageShape(20, 100),
};

async function issuePage(get: () => Promise<any>, offset: number, limit: number) {
  const data = await get();
  return serverPage((data?.issues ?? []).map((i: any) => compactIssue(i, { flatten: true })), offset, limit, data?.total);
}

export const jiraAgileTools: ToolDef[] = [
  {
    name: "jira_get_agile_boards",
    product: "jira",
    description: "Agile boards (scrum/kanban) filtered by name fragment, project or type.",
    inputShape: {
      board_name: z.string().optional(),
      project_key: z.string().optional(),
      board_type: z.enum(["scrum", "kanban"]).optional(),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = await client("jira").get(`${AGILE}/board`, {
        name: args.board_name,
        projectKeyOrId: args.project_key,
        type: args.board_type,
        startAt: offset,
        maxResults: limit,
      });
      const items = (data?.values ?? []).map((b: any) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        project: b.location?.projectKey,
      }));
      return serverPage(items, offset, limit, data?.total, data?.isLast);
    },
  },
  {
    name: "jira_get_board_issues",
    product: "jira",
    description: "Issues on a board (respects the board filter), optionally narrowed by JQL.",
    inputShape: { board_id: z.coerce.number().int(), ...issueListShape },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      refuseAllFields(args.fields);
      const limit = args.limit ?? 20;
      return issuePage(
        () =>
          client("jira").get(`${AGILE}/board/${args.board_id}/issue`, {
            jql: args.jql,
            fields: args.fields ?? DEFAULT_ISSUE_FIELDS,
            startAt: offset,
            maxResults: limit,
          }),
        offset,
        limit,
      );
    },
  },
  {
    name: "jira_get_sprints_from_board",
    product: "jira",
    description: "Sprints of a board, optionally by state (future, active, closed; comma list allowed).",
    inputShape: {
      board_id: z.coerce.number().int(),
      state: z.string().optional().describe("future | active | closed, comma-separated"),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = await client("jira").get(`${AGILE}/board/${args.board_id}/sprint`, {
        state: args.state,
        startAt: offset,
        maxResults: limit,
      });
      return serverPage((data?.values ?? []).map(compactSprint), offset, limit, data?.total, data?.isLast);
    },
  },
  {
    name: "jira_get_sprint_issues",
    product: "jira",
    description: "Issues in a sprint, optionally narrowed by JQL.",
    inputShape: { sprint_id: z.coerce.number().int(), ...issueListShape },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      refuseAllFields(args.fields);
      const limit = args.limit ?? 20;
      return issuePage(
        () =>
          client("jira").get(`${AGILE}/sprint/${args.sprint_id}/issue`, {
            jql: args.jql,
            fields: args.fields ?? DEFAULT_ISSUE_FIELDS,
            startAt: offset,
            maxResults: limit,
          }),
        offset,
        limit,
      );
    },
  },
  {
    name: "jira_create_sprint",
    unverifiable: "Jira allows several sprints with one name; each call creates one",
    product: "jira",
    write: true,
    description: "Create a future sprint on a board. Dates are ISO 8601, e.g. 2026-10-06T09:00:00.000+03:00.",
    inputShape: {
      board_id: z.coerce.number().int(),
      name: z.string(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      goal: z.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      if (args.start_date && args.end_date && Date.parse(args.start_date) >= Date.parse(args.end_date)) {
        throw new ValidationError("start_date must be before end_date");
      }
      const body: Record<string, unknown> = { name: args.name, originBoardId: args.board_id };
      if (args.start_date) body.startDate = args.start_date;
      if (args.end_date) body.endDate = args.end_date;
      if (args.goal) body.goal = args.goal;
      const res: any = await guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${AGILE}/sprint`,
        json: body,
        summary: `Create sprint '${args.name}' on board ${args.board_id}`,
      });
      if (!res.dry_run && res.result) res.result = compactSprint(res.result);
      return res;
    },
  },
  {
    name: "jira_update_sprint",
    unverifiable: "not checked: current values are not compared",
    product: "jira",
    write: true,
    description:
      "Partially update a sprint. Start it with state=active (needs dates), close it with state=closed.",
    inputShape: {
      sprint_id: z.coerce.number().int(),
      name: z.string().optional(),
      state: z.enum(SPRINT_STATES).optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),
      goal: z.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const body = Object.fromEntries(
        Object.entries({
          name: args.name,
          state: args.state,
          startDate: args.start_date,
          endDate: args.end_date,
          goal: args.goal,
        }).filter(([, v]) => v !== undefined && v !== ""),
      );
      if (Object.keys(body).length === 0) throw new ValidationError("Nothing to update");
      const res: any = await guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${AGILE}/sprint/${args.sprint_id}`,
        json: body,
        summary: `Update sprint ${args.sprint_id}: ${Object.keys(body).join(", ")}`,
      });
      if (!res.dry_run && res.result) res.result = compactSprint(res.result);
      return res;
    },
  },
  {
    name: "jira_add_issues_to_sprint",
    unverifiable: "not checked: current sprint membership is not compared",
    product: "jira",
    write: true,
    description: "Move issues into a sprint (up to 50 per call).",
    inputShape: { sprint_id: z.coerce.number().int(), issue_keys: listArg, ...dryRunShape },
    async handler({ client }, args) {
      if (args.issue_keys.length === 0) throw new ValidationError("issue_keys is empty");
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${AGILE}/sprint/${args.sprint_id}/issue`,
        json: { issues: args.issue_keys },
        summary: `Add ${args.issue_keys.join(", ")} to sprint ${args.sprint_id}`,
      });
    },
  },
  {
    name: "jira_move_issues_to_backlog",
    unverifiable: "not checked: current sprint membership is not compared",
    product: "jira",
    write: true,
    description: "Move issues out of their sprints into the backlog (up to 50 per call).",
    inputShape: { issue_keys: listArg, ...dryRunShape },
    async handler({ client }, args) {
      if (args.issue_keys.length === 0) throw new ValidationError("issue_keys is empty");
      return guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${AGILE}/backlog/issue`,
        json: { issues: args.issue_keys },
        summary: `Move ${args.issue_keys.join(", ")} to the backlog`,
      });
    },
  },
];

