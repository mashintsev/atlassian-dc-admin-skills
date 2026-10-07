/**
 * Confluence page comments (footer and inline).
 *
 * Ported from sooperset/mcp-atlassian (MIT, toolset confluence_comments). Child-comment paging with
 * `depth` and `location` query parameters checked against confluence-rest-client 10.2.17
 * (RemoteChildContentFinderImpl). Inline-comment creation through public REST
 * (`extensions.inlineProperties`) follows mcp-atlassian and is not verified against a server.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";
import { markdownToStorage, storageToMarkdown } from "../../markup.js";
import type { ToolDef } from "../types.js";
import { dryRunShape, guardedWrite, pageShape, serverPage } from "../util.js";

const API = "/rest/api";
/** Only what compactComment reads: body, author/date, thread parent, inline anchor and resolution. */
const COMMENT_EXPAND = "body.storage,version,ancestors,extensions.inlineProperties,extensions.resolution";

/** Markdown unless it already looks like storage XHTML (same rule as mcp-atlassian). */
export function toStorage(body: string, format?: "markdown" | "storage"): string {
  if (format === "storage") return body;
  if (format === "markdown") return markdownToStorage(body);
  return body.trim().startsWith("<") ? body : markdownToStorage(body);
}

const readBodyShape = {
  max_body_chars: z.coerce.number().int().min(1).max(20000).optional().describe("Maximum comment body characters (default 2000, maximum 20000)"),
};

const bodyShape = {
  body: z.string().describe("Markdown (default) or storage XHTML"),
  body_format: z.enum(["markdown", "storage"]).optional().describe("Default: storage when the body starts with '<', else markdown"),
};

export function compactComment(c: any, baseUrl?: string, maxBodyChars = 2000): Record<string, unknown> {
  const ancestors: any[] = c.ancestors ?? [];
  const parent =
    c.container?.type === "comment" ? c.container.id : [...ancestors].reverse().find((a) => a.type === "comment")?.id;
  const storage = c.body?.storage?.value ?? "";
  const markdown = storage ? storageToMarkdown(storage, { baseUrl, pageId: c.container?.id }) : "";
  const body = markdown.length <= maxBodyChars ? markdown
    : `${markdown.slice(0, maxBodyChars)}…(+${markdown.length - maxBodyChars} chars)`;
  return {
    id: c.id,
    author: c.version?.by?.username ?? c.version?.by?.displayName,
    created: c.version?.when,
    parent,
    location: c.extensions?.location,
    selection: c.extensions?.inlineProperties?.originalSelection,
    resolution: c.extensions?.resolution?.status,
    body,
  };
}

/** One server page of comments (start/limit, `_links.next`). */
async function commentPage(client: AtlassianClient, pageId: string, offset: number, limit: number, location?: string) {
  const data = await client.get(`${API}/content/${seg(pageId)}/child/comment`, {
    expand: COMMENT_EXPAND,
    depth: "all",
    location,
    start: offset,
    limit,
  });
  return { results: (data?.results ?? []) as any[], last: !data?._links?.next };
}

/** The page a comment belongs to: its container, or the nearest page ancestor. */
async function pageOfComment(client: AtlassianClient, commentId: string): Promise<string> {
  const c = await client.get(`${API}/content/${seg(commentId)}`, { expand: "container,ancestors" });
  if (c?.type && c.type !== "comment") throw new ValidationError(`${commentId} is a ${c.type}, not a comment`);
  if (c?.container?.type === "page" || c?.container?.type === "blogpost") return String(c.container.id);
  const page = [...(c?.ancestors ?? [])].reverse().find((a: any) => a.type === "page" || a.type === "blogpost");
  if (!page) throw new ValidationError(`Cannot find the page of comment ${commentId}`);
  return String(page.id);
}

export const confluenceCommentTools: ToolDef[] = [
  {
    name: "confluence_get_comments",
    product: "confluence",
    description:
      "Comments of a page (footer and inline, with replies) as Markdown: author, date, parent, inline selection, " +
      "resolution. Server-side paging (offset/limit).",
    inputShape: {
      page_id: z.coerce.string(),
      location: z.enum(["footer", "inline", "resolved"]).optional().describe("Default: all locations"),
      ...pageShape(25),
      ...readBodyShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 25;
      const { results, last } = await commentPage(c, args.page_id, offset, limit, args.location);
      const items = results.map((x) => compactComment({ ...x, container: x.container ?? { id: args.page_id, type: "page" } }, c.config.baseUrl, args.max_body_chars));
      return { page_id: args.page_id, ...serverPage(items, offset, limit, null, last) };
    },
  },
  {
    name: "confluence_get_inline_comments",
    product: "confluence",
    description: "Inline comments of a page with the highlighted text they are anchored to (server-side paging).",
    inputShape: { page_id: z.coerce.string(), ...pageShape(25), ...readBodyShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 25;
      const { results, last } = await commentPage(c, args.page_id, offset, limit, "inline");
      const items = results
        .filter((x) => !x.extensions?.location || x.extensions.location === "inline")
        .map((x) => compactComment({ ...x, container: x.container ?? { id: args.page_id, type: "page" } }, c.config.baseUrl, args.max_body_chars));
      return { page_id: args.page_id, ...serverPage(items, offset, limit, null, last) };
    },
  },
  {
    name: "confluence_add_comment",
    unverifiable: "each call adds another comment",
    product: "confluence",
    write: true,
    description: "Add a footer comment to a page or blog post.",
    inputShape: { page_id: z.coerce.string(), ...bodyShape, ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "POST",
        path: `${API}/content`,
        json: {
          type: "comment",
          container: { id: args.page_id, type: "page", status: "current" },
          body: { storage: { value: toStorage(args.body, args.body_format), representation: "storage" } },
        },
        summary: `Add comment to page ${args.page_id}`,
      });
    },
  },
  {
    name: "confluence_reply_to_comment",
    unverifiable: "each call adds another reply",
    product: "confluence",
    write: true,
    description: "Reply to an existing comment (threaded under it).",
    inputShape: { comment_id: z.coerce.string(), ...bodyShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const pageId = await pageOfComment(c, args.comment_id);
      return guardedWrite(c, args, {
        method: "POST",
        path: `${API}/content`,
        json: {
          type: "comment",
          container: { id: pageId, type: "page", status: "current" },
          ancestors: [{ id: args.comment_id }],
          body: { storage: { value: toStorage(args.body, args.body_format), representation: "storage" } },
        },
        summary: `Reply to comment ${args.comment_id} on page ${pageId}`,
      });
    },
  },
  {
    name: "confluence_add_inline_comment",
    unverifiable: "each call adds another inline comment",
    product: "confluence",
    write: true,
    description:
      "Add an inline comment anchored to text on the page. text_selection must match the page text exactly; " +
      "when it occurs several times give match_count and the 0-based match_index. Server acceptance of " +
      "inline properties over REST is not verified on every Confluence version — read back with confluence_get_inline_comments.",
    inputShape: {
      page_id: z.coerce.string(),
      ...bodyShape,
      text_selection: z.string(),
      match_count: z.coerce.number().int().min(1).optional().describe("Default 1"),
      match_index: z.coerce.number().int().min(0).optional().describe("Default 0"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const count = args.match_count ?? 1;
      const index = args.match_index ?? 0;
      if (index >= count) throw new ValidationError("match_index must be smaller than match_count");
      return guardedWrite(client("confluence"), args, {
        method: "POST",
        path: `${API}/content`,
        json: {
          type: "comment",
          container: { id: args.page_id, type: "page", status: "current" },
          body: { storage: { value: toStorage(args.body, args.body_format), representation: "storage" } },
          extensions: {
            location: "inline",
            inlineProperties: {
              originalSelection: args.text_selection,
              numMatches: count,
              matchIndex: index,
              lastFetchTime: String(Date.now()),
              serializedHighlights: JSON.stringify([[args.text_selection]]),
            },
          },
        },
        summary: `Add inline comment on "${args.text_selection.slice(0, 40)}" in page ${args.page_id}`,
      });
    },
  },
];
