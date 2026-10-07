/**
 * Confluence content labels.
 *
 * Ported from sooperset/mcp-atlassian (MIT, toolset confluence_labels). `GET /content/{id}/label`
 * with `prefix` checked against confluence-rest-client 10.2.17 (RemoteContentLabelServiceImpl).
 * Labels are added with the documented array body `[{prefix, name}]`.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, guardedWrite, listArg, pageShape, serverPage } from "../util.js";

const API = "/rest/api";

const TOOL_REMOVE = "confluence_remove_label";

/** Every label on the content (all prefixes), as `name` and `prefix:name`. */
async function labelsOf(client: AtlassianClient, contentId: string): Promise<Set<string>> {
  const all = await client.getPagedConfluence(`${API}/content/${seg(contentId)}/label`, {}, 200, 2000);
  return new Set(all.flatMap((l: any) => [String(l.name), `${l.prefix}:${l.name}`]));
}

/** The content must exist: a space id or key is not content, and categories are space labels. */
async function requireContent(client: AtlassianClient, contentId: string): Promise<void> {
  if (!/^(att)?\d+$/.test(contentId)) {
    throw new ValidationError(`'${contentId}' is not a content id (page, blog post or att… attachment id); space categories: confluence_remove_space_category`);
  }
  try {
    await client.get(`${API}/content/${seg(contentId)}`);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) {
      throw new ValidationError(`No page, blog post or attachment ${contentId} (a space id is not content; space categories: confluence_remove_space_category)`);
    }
    throw e;
  }
}

/** One label removal: already-satisfied, dry run with drift data, or execute and read back. */
async function removeOne(client: AtlassianClient, contentId: string, name: string, dryRun: boolean, before?: Set<string>) {
  const present = before ?? (await labelsOf(client, contentId));
  const summary = `Remove label ${name} from ${contentId}`;
  if (!present.has(name)) return alreadySatisfied(summary, "the content does not have this label");
  const req = { method: "DELETE" as const, path: `${API}/content/${seg(contentId)}/label/${seg(name)}`, summary };
  if (dryRun) {
    return {
      ...(await guardedWrite(client, { dry_run: true }, req)),
      // only this label: removals of other labels by earlier plan items do not drift this one
      identity: { op: "remove-label", content: contentId, name },
      state: { present: true },
    };
  }
  const result = await guardedWrite(client, { dry_run: false }, req);
  const after = await labelsOf(client, contentId);
  const others = [...present].filter((l) => l !== name && !l.endsWith(`:${name}`));
  const lost = others.filter((l) => !after.has(l));
  if (after.has(name) || lost.length) {
    throw new VerificationError(`${summary}: ${after.has(name) ? "the label is still there" : `other labels disappeared: ${lost.join(", ")}`}`, { labels: [...after].filter((l) => !l.includes(":")).sort() });
  }
  return result;
}

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
    description: "Add one or more labels to a page, blog post or attachment (lowercase, no spaces). Labels already there → already-satisfied.",
    inputShape: {
      content_id: z.coerce.string(),
      names: listArg.describe("Label names, e.g. 'release-notes,q3'"),
      prefix: z.enum(["global", "my", "team"]).optional().describe("Default global"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const prefix = args.prefix ?? "global";
      const wanted = [...new Set<string>(args.names.map((name: string) => name.trim().toLowerCase().replace(/\s+/g, "-")))];
      const present = async () => new Set((await c.getPagedConfluence(`${API}/content/${seg(args.content_id)}/label`, { prefix }, 200, 2000)).map((l: any) => String(l.name)));
      const before = await present();
      const missing = wanted.filter((n) => !before.has(n));
      const summary = `Add label(s) ${args.names.join(", ")} to ${args.content_id}`;
      if (!missing.length) return alreadySatisfied(summary, "the content already has these labels");
      const req = { method: "POST" as const, path: `${API}/content/${seg(args.content_id)}/label`, json: missing.map((name) => ({ prefix, name })), summary };
      if (args.dry_run !== false) {
        return {
          ...(await guardedWrite(c, args, req)),
          // other labels added by earlier plan items do not drift this one
          identity: { op: "add-label", content: args.content_id, prefix, names: wanted.sort() },
          state: { present: wanted.filter((n) => before.has(n)).sort() },
        };
      }
      const result = await guardedWrite(c, args, req);
      const after = await present();
      const absent = wanted.filter((n) => !after.has(n));
      if (absent.length) throw new VerificationError(`${summary}: not visible afterwards: ${absent.join(", ")}`, { labels: [...after].sort() });
      return result;
    },
  },
  {
    name: TOOL_REMOVE,
    product: "confluence",
    write: true,
    description:
      "Remove one or more labels from a page, blog post or attachment (att… id); other labels stay. Labels not there → " +
      "already-satisfied. Several labels: one change per label (--plan records each). team: names are space categories: " +
      "use confluence_remove_space_category.",
    inputShape: {
      content_id: z.coerce.string(),
      names: listArg.describe("Label names, e.g. 'draft,old'"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const names = [...new Set<string>(args.names.map((n: string) => n.trim()).filter(Boolean))];
      const team = names.filter((n) => n.toLowerCase().startsWith("team:"));
      if (team.length) throw new ValidationError(`${team.join(", ")}: team: labels are space categories; use confluence_remove_space_category`);
      if (!names.length) throw new ValidationError("Pass at least one label name");
      await requireContent(c, args.content_id);
      const dryRun = args.dry_run !== false;
      const before = await labelsOf(c, args.content_id);
      if (names.length === 1) return removeOne(c, args.content_id, names[0]!, dryRun, before);
      const summary = `Remove ${names.length} label(s) from ${args.content_id}`;
      const batch: Array<{ tool: string; args: Record<string, unknown>; value: any }> = [];
      const satisfied: string[] = [];
      for (const name of names) {
        const value: any = await removeOne(c, args.content_id, name, true, before);
        if (value.already_satisfied) satisfied.push(`${value.summary}: ${value.reason}`);
        else batch.push({ tool: TOOL_REMOVE, args: { content_id: args.content_id, names: [name] }, value });
      }
      if (!batch.length) return alreadySatisfied(summary, satisfied.join("; "));
      if (dryRun) return { dry_run: true, product: c.product, summary, batch, satisfied, request: batch[0]!.value.request };
      // executed directly: one removal after another, each read back
      const results = [];
      for (const b of batch) {
        try {
          await removeOne(c, args.content_id, (b.args.names as string[])[0]!, false);
          results.push({ summary: b.value.summary, status: "done" });
        } catch (e) {
          results.push({ summary: b.value.summary, status: "failed", error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { dry_run: false, product: c.product, summary, request: batch[0]!.value.request, result: { removals: results, satisfied } };
    },
  },
];
