/**
 * Confluence content labels.
 *
 * Ported from sooperset/mcp-atlassian (MIT, toolset confluence_labels). `GET /content/{id}/label`
 * with `prefix` checked against confluence-rest-client 10.2.17 (RemoteContentLabelServiceImpl).
 * Labels are added with the documented array body `[{prefix, name}]`.
 */

import { z } from "zod";
import { seg } from "../../client.js";
import type { ToolDef } from "../types.js";
import { dryRunShape, guardedWrite, listArg, pageShape, serverPage } from "../util.js";

const API = "/rest/api";

export const confluenceLabelTools: ToolDef[] = [
  {
    name: "confluence_get_labels",
    product: "confluence",
    description: "Labels of a page, blog post or attachment (att… id).",
    inputShape: {
      content_id: z.coerce.string(),
      prefix: z.enum(["global", "my", "team"]).optional(),
      ...pageShape(200),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 200;
      const data = await client("confluence").get(`${API}/content/${seg(args.content_id)}/label`, {
        prefix: args.prefix,
        start: offset,
        limit,
      });
      const items = (data?.results ?? []).map((l: any) => ({ name: l.name, prefix: l.prefix, id: l.id }));
      return serverPage(items, offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_add_label",
    product: "confluence",
    write: true,
    description: "Add one or more labels to a page, blog post or attachment (lowercase, no spaces).",
    inputShape: {
      content_id: z.coerce.string(),
      names: listArg.describe("Label names, e.g. 'release-notes,q3'"),
      prefix: z.enum(["global", "my", "team"]).optional().describe("Default global"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const prefix = args.prefix ?? "global";
      return guardedWrite(client("confluence"), args, {
        method: "POST",
        path: `${API}/content/${seg(args.content_id)}/label`,
        json: args.names.map((name: string) => ({ prefix, name: name.trim().toLowerCase().replace(/\s+/g, "-") })),
        summary: `Add label(s) ${args.names.join(", ")} to ${args.content_id}`,
      });
    },
  },
];
