/**
 * Jira attachments, ported from sooperset/mcp-atlassian (MIT, jira/attachments.py).
 * Checked against jira-rest-plugin 11.3.2: GET /issue/{key}?fields=attachment, POST /issue/{key}/attachments
 * (multipart field `file`, X-Atlassian-Token: no-check is a default header), DELETE /attachment/{id}.
 *
 * Unlike upstream, file contents never go into the tool output (no base64): files are written to
 * `output_dir` and the result lists their paths, so an agent opens only what it needs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { contains, dryRunShape, guardedWrite, listArg, MAX_PAGE } from "../util.js";
import { API } from "./shape.js";

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILES = 50;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"]);
const AMBIGUOUS_MIME = new Set(["", "application/octet-stream", "application/binary", "multipart/form-data"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

export function isImageAttachment(a: { mimeType?: string; filename?: string }): boolean {
  const mime = String(a.mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (IMAGE_MIME.has(mime)) return true;
  return AMBIGUOUS_MIME.has(mime) && IMAGE_EXT.has(extname(String(a.filename ?? "")).toLowerCase());
}

/** Server filenames are metadata, not paths: strip directories, control chars and reserved characters. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = basename(String(name ?? "").replace(/\\/g, "/"))
    .replace(/[\x00-\x1f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim();
  return cleaned || fallback;
}

interface Saved {
  id: string;
  name: string;
  mimeType?: string;
  bytes?: number;
  path?: string;
  skipped?: string;
}

async function downloadAll(
  client: AtlassianClient,
  issueKey: string,
  outputDir: string,
  filter: (a: any) => boolean,
  maxBytes: number,
  maxFiles = DEFAULT_MAX_FILES,
): Promise<{ issue: string; dir: string; total: number; saved: number; truncated?: boolean; files: Saved[] }> {
  const issue = await client.get(`${API}/issue/${seg(issueKey)}`, { fields: "attachment" });
  const matching: any[] = (issue?.fields?.attachment ?? []).filter(filter);
  const attachments = matching.slice(0, maxFiles);
  const dir = resolve(outputDir);
  mkdirSync(dir, { recursive: true });
  const files: Saved[] = [];
  for (const a of attachments) {
    const entry: Saved = { id: String(a.id), name: a.filename, mimeType: a.mimeType, bytes: a.size };
    if (!a.content) {
      entry.skipped = "no content URL";
    } else if ((a.size ?? 0) > maxBytes) {
      entry.skipped = `larger than max_bytes (${maxBytes})`;
    } else {
      const target = resolve(dir, `${a.id}_${safeFileName(a.filename, `attachment-${a.id}`)}`);
      if (!target.startsWith(dir + sep)) {
        entry.skipped = "unsafe file name";
      } else {
        try {
          const { bytes } = await client.getBytes(a.content);
          writeFileSync(target, bytes);
          entry.bytes = bytes.length;
          entry.path = target;
        } catch (e: any) {
          entry.skipped = String(e?.message ?? e);
        }
      }
    }
    files.push(entry);
  }
  return {
    issue: issueKey,
    dir,
    total: matching.length,
    saved: files.filter((f) => f.path).length,
    truncated: matching.length > attachments.length || undefined,
    files,
  };
}

const downloadShape = {
  issue_key: z.string(),
  output_dir: z.string().describe("Local directory to save into (created if missing)"),
  attachment_ids: listArg.optional().describe("Only these attachment ids"),
  name_contains: z.string().optional(),
  max_bytes: z.coerce.number().int().min(1).optional().describe(`Skip larger files (default ${DEFAULT_MAX_BYTES})`),
  max_files: z.coerce.number().int().min(1).max(MAX_PAGE).optional().describe(`Download at most this many files (default ${DEFAULT_MAX_FILES})`),
};

export const jiraAttachmentTools: ToolDef[] = [
  {
    name: "jira_get_attachments",
    product: "jira",
    description: "List an issue's attachments (id, name, type, size, author, created) without downloading them.",
    inputShape: { issue_key: z.string() },
    async handler({ client }, args) {
      const issue = await client("jira").get(`${API}/issue/${seg(args.issue_key)}`, { fields: "attachment" });
      return (issue?.fields?.attachment ?? []).map((a: any) => ({
        id: a.id,
        name: a.filename,
        mimeType: a.mimeType,
        bytes: a.size,
        author: a.author?.name,
        created: a.created,
      }));
    },
  },
  {
    name: "jira_download_attachments",
    product: "jira",
    description:
      "Download an issue's attachments into output_dir and return their local paths (contents are not printed). " +
      "Filter by ids or name; files above max_bytes are skipped.",
    inputShape: downloadShape,
    async handler({ client }, args) {
      const ids = new Set<string>(args.attachment_ids ?? []);
      return downloadAll(
        client("jira"),
        args.issue_key,
        args.output_dir,
        (a) => (ids.size === 0 || ids.has(String(a.id))) && contains(a.filename, args.name_contains),
        args.max_bytes ?? DEFAULT_MAX_BYTES,
        args.max_files ?? DEFAULT_MAX_FILES,
      );
    },
  },
  {
    name: "jira_get_issue_images",
    product: "jira",
    description: "Download only the image attachments of an issue into output_dir and return their local paths.",
    inputShape: downloadShape,
    async handler({ client }, args) {
      const ids = new Set<string>(args.attachment_ids ?? []);
      return downloadAll(
        client("jira"),
        args.issue_key,
        args.output_dir,
        (a) => isImageAttachment(a) && (ids.size === 0 || ids.has(String(a.id))) && contains(a.filename, args.name_contains),
        args.max_bytes ?? DEFAULT_MAX_BYTES,
        args.max_files ?? DEFAULT_MAX_FILES,
      );
    },
  },
  {
    name: "jira_upload_attachments",
    unverifiable: "each call attaches the files again",
    product: "jira",
    write: true,
    description: "Attach local files to an issue (multipart upload).",
    inputShape: { issue_key: z.string(), paths: listArg.describe("Local file paths"), ...dryRunShape },
    async handler({ client }, args) {
      if (args.paths.length === 0) throw new ValidationError("paths is empty");
      const res: any = await guardedWrite(client("jira"), args, {
        method: "POST",
        path: `${API}/issue/${seg(args.issue_key)}/attachments`,
        files: { field: "file", paths: args.paths },
        summary: `Attach ${args.paths.map((p: string) => basename(p)).join(", ")} to ${args.issue_key}`,
      });
      if (!res.dry_run && Array.isArray(res.result)) {
        res.result = res.result.map((a: any) => ({ id: a.id, name: a.filename, bytes: a.size }));
      }
      return res;
    },
  },
  {
    name: "jira_delete_attachment",
    unverifiable: "not checked: the attachment is not read before or after",
    product: "jira",
    write: true,
    description: "Delete one attachment by id (irreversible).",
    inputShape: { attachment_id: z.coerce.string(), ...dryRunShape },
    async handler({ client }, args) {
      if (!/^\d+$/.test(args.attachment_id)) throw new ValidationError("attachment_id must be numeric");
      return guardedWrite(client("jira"), args, {
        method: "DELETE",
        path: `${API}/attachment/${args.attachment_id}`,
        summary: `PERMANENTLY delete attachment ${args.attachment_id}`,
      });
    },
  },
];

