/**
 * Confluence attachments: list, upload (new version on same file name), download to disk, delete.
 *
 * Ported from sooperset/mcp-atlassian (MIT, toolset confluence_attachments) with its DC bugs fixed:
 * the media type filter reads `extensions.mediaType` (passed server-side as `mediaType`), and
 * upload/delete failures are reported instead of being wrapped as success. Paths and the multipart
 * parts (`file`, `comment`, `minorEdit`) are checked against confluence-rest-client 10.2.17
 * (RemoteAttachmentServiceImpl). Files are written to `output_dir`, never inlined as base64.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, listArg, MAX_PAGE, pageShape, serverPage } from "../util.js";

const API = "/rest/api";
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/bmp"]);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;
const AMBIGUOUS_MIME = new Set(["application/octet-stream", "application/binary", "multipart/form-data"]);

function mediaType(a: any): string | undefined {
  return a?.extensions?.mediaType ?? a?.metadata?.mediaType;
}

export function isImageAttachment(a: any): boolean {
  const mime = mediaType(a);
  if (mime && IMAGE_MIME.has(mime)) return true;
  if (!mime || AMBIGUOUS_MIME.has(mime)) return IMAGE_EXT.test(String(a?.title ?? ""));
  return false;
}

function compactAttachment(a: any): Record<string, unknown> {
  return {
    id: a.id,
    title: a.title,
    mediaType: mediaType(a),
    bytes: a.extensions?.fileSize,
    version: a.version?.number,
    comment: a.extensions?.comment,
    created: a.version?.when,
  };
}

/** A file name safe to create inside output_dir: no separators, control chars or dot-only names. */
export function safeFileName(name: string, fallback: string): string {
  let n = basename(String(name ?? "")).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").trim();
  if (!n || /^\.+$/.test(n)) n = fallback;
  return n.slice(0, 200);
}

function targetPath(outputDir: string, name: string, id: string): string {
  const dir = resolve(outputDir);
  let file = join(dir, safeFileName(name, id));
  if (existsSync(file)) {
    const dot = file.lastIndexOf(".");
    file = dot > dir.length ? `${file.slice(0, dot)}-${id}${file.slice(dot)}` : `${file}-${id}`;
  }
  if (!file.startsWith(dir + sep)) throw new ValidationError(`Refusing to write outside ${dir}`);
  return file;
}

async function download(client: AtlassianClient, a: any, outputDir: string) {
  const size = Number(a?.extensions?.fileSize ?? 0);
  const base = compactAttachment(a);
  if (size > MAX_ATTACHMENT_BYTES) return { ...base, error: `larger than ${MAX_ATTACHMENT_BYTES} bytes, skipped` };
  const link = a?._links?.download;
  if (!link) return { ...base, error: "no download link" };
  const { bytes, contentType } = await client.getBytes(link);
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { ...base, error: `larger than ${MAX_ATTACHMENT_BYTES} bytes, skipped` };
  mkdirSync(resolve(outputDir), { recursive: true });
  const path = targetPath(outputDir, a.title, String(a.id));
  writeFileSync(path, bytes);
  return { id: a.id, title: a.title, mediaType: mediaType(a) ?? contentType ?? undefined, bytes: bytes.length, path };
}

/** Max attachments scanned when a filter cannot run server-side (images: no wildcard mediaType). */
const MAX_SCAN = 1000;

async function downloadMany(
  client: AtlassianClient,
  contentId: string,
  outputDir: string,
  filter: (a: any) => boolean,
  max: number,
  serverMediaType?: string,
) {
  // Page through the attachment list and stop as soon as `max` matches are found;
  // an exact media type is filtered by the server.
  const selected: any[] = [];
  let start = 0;
  let scanned = 0;
  for (;;) {
    const data = await client.get(`${API}/content/${seg(contentId)}/child/attachment`, {
      start,
      limit: 100,
      mediaType: serverMediaType,
      expand: "version",
    });
    const batch: any[] = data?.results ?? [];
    scanned += batch.length;
    for (const a of batch) if (filter(a) && selected.length < max) selected.push(a);
    if (selected.length >= max || batch.length === 0 || !data?._links?.next || scanned >= MAX_SCAN) break;
    start += batch.length;
  }
  const results: any[] = [];
  for (const a of selected) {
    try {
      results.push(await download(client, a, outputDir));
    } catch (e: any) {
      results.push({ ...compactAttachment(a), error: e?.message ?? String(e) });
    }
  }
  const failed = results.filter((r) => r.error).length;
  return { content_id: contentId, output_dir: resolve(outputDir), total: selected.length, downloaded: results.length - failed, failed, items: results };
}

function uploadForm(path: string, comment?: string, minorEdit?: boolean): FormData {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(path)]), basename(path));
  if (comment) form.append("comment", comment);
  form.append("minorEdit", String(minorEdit ?? false));
  return form;
}

/** Upload one file; when Confluence rejects a duplicate name, post it as a new version of that attachment. */
async function uploadOne(client: AtlassianClient, contentId: string, path: string, comment?: string, minorEdit?: boolean) {
  const base = `${API}/content/${seg(contentId)}/child/attachment`;
  try {
    const res = await client.request("POST", base, { form: uploadForm(path, comment, minorEdit) });
    const a = res?.results?.[0] ?? res;
    return { ...compactAttachment(a), action: "created" };
  } catch (e) {
    if (!(isHttpStatusError(e) && e.status === 400 && /same file name/i.test(e.body))) throw e;
    const existing = await client.get(base, { filename: basename(path) });
    const id = existing?.results?.[0]?.id;
    if (!id) throw e;
    const res = await client.request("POST", `${base}/${seg(id)}/data`, { form: uploadForm(path, comment, minorEdit) });
    return { ...compactAttachment(res?.results?.[0] ?? res), action: "new version" };
  }
}

async function guardedUpload(client: AtlassianClient, args: any, paths: string[]) {
  const summary = `Upload ${paths.length} file(s) to content ${args.content_id}` + (args.comment ? ` ("${args.comment}")` : "");
  const req = {
    method: "POST" as const,
    path: `${API}/content/${seg(args.content_id)}/child/attachment`,
    json: { comment: args.comment, minorEdit: args.minor_edit ?? false },
    files: { field: "file", paths },
    summary,
  };
  const described = await guardedWrite(client, { dry_run: true }, req); // validates the files exist
  if (args.dry_run !== false) return described;
  const uploaded: any[] = [];
  const failed: any[] = [];
  for (const p of paths) {
    try {
      uploaded.push(await uploadOne(client, args.content_id, resolve(p), args.comment, args.minor_edit));
    } catch (e: any) {
      failed.push({ file: basename(p), error: e?.message ?? String(e) });
    }
  }
  if (uploaded.length === 0 && failed.length) {
    throw new Error(`Upload failed: ${failed.map((f) => `${f.file}: ${f.error}`).join("; ")}`);
  }
  return {
    dry_run: false,
    product: "confluence",
    summary,
    request: described.request,
    result: { id: uploaded[0]?.id, uploaded, failed: failed.length ? failed : undefined },
  };
}

const uploadShape = {
  content_id: z.coerce.string().describe("Page or blog post id"),
  comment: z.string().optional(),
  minor_edit: boolArg.optional().describe("Default false: watchers are notified"),
};

export const confluenceAttachmentTools: ToolDef[] = [
  {
    name: "confluence_get_attachments",
    product: "confluence",
    description: "Attachments of a page: id, title, media type, size, version. Filters run server-side.",
    inputShape: {
      content_id: z.coerce.string(),
      filename: z.string().optional().describe("Exact file name"),
      media_type: z.string().optional().describe("Exact MIME type, e.g. image/png"),
      ...pageShape(50),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 50, 100);
      const data = await client("confluence").get(`${API}/content/${seg(args.content_id)}/child/attachment`, {
        start: offset,
        limit,
        filename: args.filename,
        mediaType: args.media_type,
        expand: "version",
      });
      return serverPage((data?.results ?? []).map(compactAttachment), offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_upload_attachment",
    product: "confluence",
    write: true,
    description: "Upload a local file to a page. An existing attachment with the same name gets a new version.",
    inputShape: { ...uploadShape, file_path: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedUpload(client("confluence"), args, [args.file_path]);
    },
  },
  {
    name: "confluence_upload_attachments",
    product: "confluence",
    write: true,
    description: "Upload several local files to a page (same name → new version). Per-file failures are reported.",
    inputShape: { ...uploadShape, file_paths: listArg, ...dryRunShape },
    async handler({ client }, args) {
      if (!args.file_paths.length) throw new ValidationError("file_paths is empty");
      return guardedUpload(client("confluence"), args, args.file_paths);
    },
  },
  {
    name: "confluence_download_attachment",
    product: "confluence",
    description: "Download one attachment (att… id) into output_dir; returns the local path (max 50 MiB).",
    inputShape: { attachment_id: z.coerce.string(), output_dir: z.string() },
    async handler({ client }, args) {
      const c = client("confluence");
      const a = await c.get(`${API}/content/${seg(args.attachment_id)}`, { expand: "version" });
      const r = await download(c, a, args.output_dir);
      if ((r as any).error) throw new ValidationError(`${args.attachment_id}: ${(r as any).error}`);
      return r;
    },
  },
  {
    name: "confluence_download_content_attachments",
    product: "confluence",
    description: "Download all (or one media type of) attachments of a page into output_dir; returns local paths.",
    inputShape: {
      content_id: z.coerce.string(),
      output_dir: z.string(),
      media_type: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional().describe("Default 50"),
    },
    async handler({ client }, args) {
      return downloadMany(client("confluence"), args.content_id, args.output_dir, (a) => !args.media_type || mediaType(a) === args.media_type, args.limit ?? 50, args.media_type);
    },
  },
  {
    name: "confluence_get_page_images",
    product: "confluence",
    description:
      "Download the image attachments of a page into output_dir (to view them with the Read tool). Stops after `limit` " +
      "images; scans at most 1000 attachments (image types cannot be filtered server-side).",
    inputShape: {
      content_id: z.coerce.string(),
      output_dir: z.string(),
      limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional().describe("Default 50"),
    },
    async handler({ client }, args) {
      return downloadMany(client("confluence"), args.content_id, args.output_dir, isImageAttachment, args.limit ?? 50);
    },
  },
  {
    name: "confluence_delete_attachment",
    product: "confluence",
    write: true,
    description: "Delete an attachment (att… id) from its page.",
    inputShape: { attachment_id: z.coerce.string(), ...dryRunShape },
    async handler({ client }, args) {
      return guardedWrite(client("confluence"), args, {
        method: "DELETE",
        path: `${API}/content/${seg(args.attachment_id)}`,
        summary: `Delete attachment ${args.attachment_id}`,
      });
    },
  },
];
