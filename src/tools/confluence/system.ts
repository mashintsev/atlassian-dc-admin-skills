/**
 * Confluence DC system administration: server, cluster, access mode, long tasks, indexing.
 * Paths checked against confluence-rest-client 10.2.17 and the prototype REST plugin 9.2.16.
 */

import { z } from "zod";
import type { ToolDef } from "../types.js";
import { dryRunShape, guardedWrite, pageShape, pick, serverPage } from "../util.js";

const API = "/rest/api";
const PROTOTYPE = "/rest/prototype/1";

function taskView(task: any): Record<string, unknown> {
  const name = typeof task?.name === "string" ? task.name : task?.name?.translation ?? task?.name?.key;
  return {
    ...pick(task, ["id", "elapsedTime", "percentageComplete", "successful"]),
    ...(typeof name === "string" ? { name } : {}),
  };
}

export const confluenceSystemTools: ToolDef[] = [
  {
    name: "confluence_server_info",
    product: "confluence",
    description: "Confluence version, build number, base URL and server time.",
    inputShape: {},
    async handler({ client }) {
      return client("confluence").get(`${API}/server-information`);
    },
  },
  {
    name: "confluence_instance_metrics",
    product: "confluence",
    description: "Instance size: number of spaces, pages, users and other content counts.",
    inputShape: {},
    async handler({ client }) {
      return client("confluence").get(`${API}/instance-metrics`);
    },
  },
  {
    name: "confluence_cluster_nodes",
    product: "confluence",
    description: "Data Center cluster nodes and their status.",
    inputShape: {},
    async handler({ client }) {
      const data = await client("confluence").get(`${API}/cluster/nodes`);
      return (Array.isArray(data) ? data : data?.results ?? []).map((node: any) =>
        pick(node, ["id", "name", "state", "version", "buildNumber", "address"]));
    },
  },
  {
    name: "confluence_access_mode",
    product: "confluence",
    description: "Read-only mode status (READ_WRITE or READ_ONLY, e.g. during maintenance).",
    inputShape: {},
    async handler({ client }) {
      return client("confluence").get(`${API}/accessmode`);
    },
  },
  {
    name: "confluence_list_long_tasks",
    product: "confluence",
    description: "Long-running tasks (space deletion/export, reindex, ...) with progress and status.",
    inputShape: { ...pageShape(50) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = await client("confluence").get(`${API}/longtask`, { start: offset, limit, expand: "status" });
      return serverPage((data?.results ?? []).map(taskView), offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_get_long_task",
    product: "confluence",
    description: "One long-running task: percentage complete, elapsed time, messages, success flag.",
    inputShape: { task_id: z.string() },
    async handler({ client }, args) {
      const data = await client("confluence").get(`${API}/longtask/${encodeURIComponent(args.task_id)}`);
      const messages: any[] = data?.messages ?? [];
      return {
        ...taskView(data),
        messages: messages.slice(-20).reverse().map((message) => message?.translation ?? message?.key ?? String(message)),
        ...(messages.length > 20 ? { messagesTotal: messages.length } : {}),
      };
    },
  },
  {
    name: "confluence_reindex_status",
    product: "confluence",
    description: "Status of the site reindex (legacy prototype API, still shipped in Confluence 9).",
    inputShape: {},
    async handler({ client }) {
      return client("confluence").get(`${PROTOTYPE}/index/reindex`);
    },
  },
  {
    name: "confluence_start_reindex",
    product: "confluence",
    write: true,
    unverifiable: "Confluence starts a rebuild each time; there is no target state to compare",
    description: "Rebuild the whole search index. Search results are incomplete until it finishes.",
    inputShape: { ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "POST",
        path: `${PROTOTYPE}/index/reindex`,
        summary: "Start full Confluence reindex",
      });
    },
  },
];
