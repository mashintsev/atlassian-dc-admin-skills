/**
 * Confluence DC page tools, ported from sooperset/mcp-atlassian (MIT, toolset confluence_pages)
 * with the token-efficient shapes of eunsanMountain/atlassian-skills (MIT): search rows without
 * excerpts or highlight markers, page bodies as Markdown on request, compact tree/history/diff.
 *
 * Paths checked against confluence-rest-client 10.2.17 (RemoteCQLSearchServiceImpl,
 * RemoteContentServiceImpl, RemoteChildContentServiceImpl, RemoteContentRestrictionServiceImpl,
 * RemoteContentVersionServiceImpl). Page move has no REST endpoint on DC: it uses movepage.action.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { ValidationError } from "../../errors.js";
import { CODE_CUT_MARKER, markdownToStorage, storageToMarkdown } from "../../markup.js";
import type { ToolDef } from "../types.js";
import { boolArg, dryRunShape, guardedWrite, listArg, pageShape, serverPage } from "../util.js";

const API = "/rest/api";

// -- helpers ------------------------------------------------------------------------

export class StaleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVersion";
  }
}

/** Accept a numeric id, a page URL (/pages/123, ?pageId=123) or a tiny link (/x/AbCd). */
export function resolvePageId(input: string): string {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const byPath = /\/pages\/(\d+)/.exec(s);
  if (byPath) return byPath[1];
  const byQuery = /[?&]pageId=(\d+)/.exec(s);
  if (byQuery) return byQuery[1];
  const tiny = /\/x\/([A-Za-z0-9_-]+)/.exec(s);
  if (tiny) {
    const b64 = tiny[1].replace(/-/g, "/").replace(/_/g, "+").padEnd(11, "A") + "=";
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length >= 8) return bytes.readBigUInt64LE(0).toString();
  }
  throw new ValidationError(`Cannot resolve a page id from '${input}'`);
}

function stripHighlight(s: unknown): string {
  return String(s ?? "").replace(/@@@hl@@@|@@@endhl@@@/g, "");
}

function pageUrl(client: AtlassianClient, id: string | number): string {
  return `${client.config.baseUrl}/pages/viewpage.action?pageId=${id}`;
}

/** CQL from plain text or pass-through CQL, with an optional space filter before ORDER BY. */
export function buildCql(query: string, spaces: string[] = []): string {
  const q = query.trim();
  const isCql = /[=~<>]|\bAND\b|\bOR\b|currentUser\(\)/.test(q);
  let cql = isCql ? q : `siteSearch ~ "${q.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (spaces.length) {
    const order = /\s+ORDER\s+BY\s+.*$/i.exec(cql);
    const base = order ? cql.slice(0, order.index) : cql;
    const filter = spaces.map((k) => `space = "${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(" OR ");
    cql = `(${base}) AND (${filter})${order ? order[0] : ""}`;
  }
  return cql;
}

/** Read `content` or `content_file` (exactly one) and convert it to storage format. */
function bodyFrom(args: { content?: string; content_file?: string; content_format?: string }): string {
  if ((args.content === undefined) === (args.content_file === undefined)) {
    throw new ValidationError("Pass exactly one of content or content_file");
  }
  let text = args.content;
  if (args.content_file !== undefined) {
    const file = resolve(args.content_file);
    if (!existsSync(file) || !statSync(file).isFile()) throw new ValidationError(`File not found: ${args.content_file}`);
    text = readFileSync(file, "utf8");
  }
  return writeBody(String(text), args.content_format);
}

/** Refuse a Markdown read's cut-code marker before any write preparation or request. */
function writeBody(text: string, format?: string): string {
  if (format === "storage") return text;
  if (text.includes(CODE_CUT_MARKER)) {
    throw new ValidationError("This code block was cut in a read; fetch the complete body with body_format=storage before editing and submitting it");
  }
  return markdownToStorage(text);
}

const contentShape = {
  content: z.string().optional().describe("Page body (Markdown by default)"),
  content_file: z.string().optional().describe("Read the body from this local file instead of content"),
  content_format: z.enum(["markdown", "storage"]).optional().describe("Default markdown; storage = XHTML sent as is"),
};

async function getPage(client: AtlassianClient, id: string, expand: string, extra: Record<string, string | number> = {}) {
  return client.get(`${API}/content/${seg(id)}`, { expand, ...extra });
}

/** How much of a body a read returns: the outline, one section, and the character limit. */
export interface BodyRead {
  outline?: boolean;
  section?: string;
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS_CAP = 100_000;
const BODY_NARROWING = ["section", "outline", "max_chars"];

const bodyReadShape = {
  outline: boolArg.optional().describe("Return the heading tree with each section's size instead of the body"),
  section: z.string().min(1).optional().describe("Return only the section under this heading (case-insensitive) and its subsections"),
  max_chars: z.coerce.number().int().min(1).max(MAX_CHARS_CAP).optional().describe(`Longest body returned, cut at a block boundary (default ${DEFAULT_MAX_CHARS})`),
};

/** Cut a body at the last block boundary at or before `max`: a blank line (Markdown) or a closing block tag (storage). */
function cutBody(body: string, max: number, format: "markdown" | "storage"): string {
  if (body.length <= max) return body;
  const head = body.slice(0, max);
  let end = -1;
  if (format === "markdown") {
    end = head.lastIndexOf("\n\n");
  } else {
    const re = /<\/(p|h[1-6]|table|ul|ol|pre|blockquote|div|ac:structured-macro|ac:image|ac:layout)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(head))) end = m.index + m[0].length;
  }
  return (end > 0 ? head.slice(0, end) : head).trimEnd();
}

function compactPage(client: AtlassianClient, p: any, bodyFormat: "markdown" | "storage" | "none" = "none", read: BodyRead = {}) {
  const ancestors: any[] = p?.ancestors ?? [];
  const parent = ancestors.length ? ancestors[ancestors.length - 1] : undefined;
  const out: Record<string, unknown> = {
    id: p?.id,
    title: p?.title,
    type: p?.type,
    status: p?.status !== "current" ? p?.status : undefined,
    space: p?.space?.key,
    version: p?.version?.number,
    updated: p?.version?.when,
    by: p?.version?.by?.username ?? p?.version?.by?.displayName,
    parent: parent ? `${parent.id} ${parent.title ?? ""}`.trim() : undefined,
    url: p?.id ? pageUrl(client, p.id) : undefined,
  };
  const storage = p?.body?.storage?.value;
  if (bodyFormat === "none" || typeof storage !== "string") return out;
  const convert = (xhtml: string) => (bodyFormat === "storage" ? xhtml : storageToMarkdown(xhtml, { baseUrl: client.config.baseUrl, pageId: String(p.id) }));
  const sections = read.outline || read.section !== undefined ? splitSections(storage) : [];
  if (read.outline) {
    out.outline = sections.map((s) => ({ level: s.level, heading: s.heading, chars: convert(storage.slice(s.start, s.end)).length }));
    return out;
  }
  let selected = storage;
  if (read.section !== undefined) {
    const want = read.section.trim().toLowerCase();
    const hits = sections.filter((s) => s.heading.toLowerCase() === want);
    const names = () => sections.slice(0, 30).map((s) => s.heading).join(", ") + (sections.length > 30 ? `, +${sections.length - 30} more` : "");
    if (!hits.length) throw new ValidationError(`No section '${read.section}'; headings: ${names() || "(none)"}`);
    if (hits.length > 1) throw new ValidationError(`Section '${read.section}' is ambiguous (${hits.length} headings); headings: ${names()}`);
    selected = storage.slice(hits[0]!.start, hits[0]!.end);
  }
  const body = convert(selected);
  if (bodyFormat === "markdown") {
    out.note = "Bare image names are attachments of this page; download them with confluence_download_content_attachments";
  }
  const max = read.maxChars ?? DEFAULT_MAX_CHARS;
  out.body = cutBody(body, max, bodyFormat);
  if ((out.body as string).length < body.length) {
    out.truncated = { shown: (out.body as string).length, total: body.length };
    out.hint = "Read the rest with outline=true and section=<heading>, or a larger max_chars";
  }
  return out;
}

/** Minimal line diff (LCS over the changed middle) rendered as unified hunks with 1 line of context. */
export function unifiedDiff(a: string[], b: string[], fromLabel: string, toLabel: string, context = 1): string {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  if (am.length === 0 && bm.length === 0) return "(no changes)";

  type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  if (am.length * bm.length <= 4_000_000) {
    const n = am.length, m = bm.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = am[i] === bm[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) ops.push({ t: " ", s: am[i], ai: pre + i++, bi: pre + j++ });
      else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) ops.push({ t: "-", s: am[i], ai: pre + i++, bi: pre + j });
      else ops.push({ t: "+", s: bm[j], ai: pre + i, bi: pre + j++ });
    }
  } else {
    am.forEach((s, k) => ops.push({ t: "-", s, ai: pre + k, bi: pre }));
    bm.forEach((s, k) => ops.push({ t: "+", s, ai: pre + am.length, bi: pre + k }));
  }
  // add context around the changed middle, then cut into hunks
  const full: Op[] = [
    ...a.slice(Math.max(0, pre - context), pre).map((s, k) => ({ t: " " as const, s, ai: Math.max(0, pre - context) + k, bi: Math.max(0, pre - context) + k })),
    ...ops,
    ...a.slice(a.length - suf, Math.min(a.length, a.length - suf + context)).map((s, k) => ({ t: " " as const, s, ai: a.length - suf + k, bi: b.length - suf + k })),
  ];
  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  let k = 0;
  while (k < full.length) {
    while (k < full.length && full[k].t === " " && !full.slice(k, k + context + 1).some((o) => o.t !== " ")) k++;
    if (k >= full.length) break;
    const start = k;
    let lastChange = k;
    while (k < full.length && (full[k].t !== " " || k - lastChange <= context * 2)) {
      if (full[k].t !== " ") lastChange = k;
      k++;
    }
    const end = Math.min(full.length, lastChange + context + 1);
    const hunk = full.slice(start, end);
    const aCount = hunk.filter((o) => o.t !== "+").length;
    const bCount = hunk.filter((o) => o.t !== "-").length;
    lines.push(`@@ -${hunk[0].ai + 1},${aCount} +${hunk[0].bi + 1},${bCount} @@`, ...hunk.map((o) => `${o.t}${o.s}`));
    k = end;
  }
  return lines.join("\n");
}

export interface Section {
  level: number;
  heading: string;
  /** Offset of the heading tag. */
  start: number;
  /** Offset right after the heading tag. */
  bodyStart: number;
  /** Offset of the next heading of the same or a higher level, or the end. */
  end: number;
}

/** The headings (h1–h6) of a storage body with the extent of each section. */
export function splitSections(storage: string): Section[] {
  const re = /<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g;
  const found: Array<Omit<Section, "end">> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(storage))) {
    const heading = m[3]!.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
    found.push({ level: Number(m[1]), heading, start: m.index, bodyStart: m.index + m[0].length });
  }
  return found.map((h, i) => ({ ...h, end: found.slice(i + 1).find((n) => n.level <= h.level)?.start ?? storage.length }));
}

/** Replace the body of the section under the first heading whose text equals `heading`. */
export function replaceSection(storage: string, heading: string, fragment: string): string {
  const target = heading.trim();
  const s = splitSections(storage).find((x) => x.heading === target);
  if (!s) throw new ValidationError(`Heading not found: '${heading}'`);
  return storage.slice(0, s.bodyStart) + fragment + storage.slice(s.end);
}

/** Load the current page for an update and enforce if_version. */
async function currentForUpdate(client: AtlassianClient, id: string, ifVersion?: number) {
  const page = await getPage(client, id, "body.storage,version,space,ancestors");
  const current = Number(page?.version?.number);
  if (ifVersion !== undefined && current !== ifVersion) {
    throw new StaleVersionError(`Page ${id} is at version ${current}, expected ${ifVersion}. Re-read it before updating.`);
  }
  return { page, current };
}

/** After an executed write, replace the raw server echo with a compact page and note the new version. */
async function finalizeWrite(client: AtlassianClient, res: any, id: string | undefined) {
  if (res.dry_run) return res;
  const pageId = id ?? res.result?.id;
  if (pageId) {
    try {
      const p = compactPage(client, await getPage(client, String(pageId), "version,space,ancestors"));
      res.result = p;
      if (p.version !== undefined) res.summary = `${res.summary} → v${p.version}`;
    } catch {
      res.result = { id: pageId };
    }
  } else if (typeof res.result === "string") {
    res.result = null; // e.g. the HTML of movepage.action
  }
  return res;
}

const versionArg = z.coerce.number().int().min(1);

// -- tools ----------------------------------------------------------------------------

export const confluencePageTools: ToolDef[] = [
  {
    name: "confluence_search",
    product: "confluence",
    description:
      "Search content with plain text (siteSearch) or CQL (e.g. type=page AND space=DOC AND title~\"plan\"). " +
      "Rows: id | title | type | space | updated. Excerpts only with include_excerpt=true.",
    inputShape: {
      query: z.string().describe("Plain text or CQL"),
      spaces: listArg.optional().describe("Limit to these space keys"),
      include_excerpt: boolArg.optional(),
      ...pageShape(25, 100),
    },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = Math.min(args.limit ?? 25, 100);
      const c = client("confluence");
      const call = (cql: string) =>
        c.get(`${API}/search`, {
          cql,
          start: offset,
          limit,
          excerpt: args.include_excerpt ? "highlight" : "none",
          expand: "content.space,content.version",
        });
      let cql = buildCql(args.query, args.spaces ?? []);
      let data: any;
      try {
        data = await call(cql);
      } catch (e) {
        if (cql.startsWith("siteSearch") || cql.startsWith("(siteSearch")) {
          cql = cql.replace("siteSearch ~", "text ~");
          data = await call(cql);
        } else throw e;
      }
      const items = (data?.results ?? []).map((r: any) => ({
        id: r.content?.id ?? r.space?.key,
        title: stripHighlight(r.content?.title ?? r.title),
        type: r.content?.type ?? r.entityType,
        space: r.content?.space?.key ?? r.resultGlobalContainer?.title,
        updated: r.content?.version?.when ?? r.lastModified,
        excerpt: args.include_excerpt ? stripHighlight(r.excerpt) : undefined,
      }));
      return { cql, ...serverPage(items, offset, limit, data?.totalSize, !data?._links?.next) };
    },
  },
  {
    name: "confluence_get_page",
    product: "confluence",
    description:
      "One page by id, URL or tiny link (page), or by exact title + space_key. Metadata plus the body as Markdown " +
      "(body_format=storage for raw XHTML, none for metadata only). Long bodies are cut at max_chars (default 20,000); " +
      "outline=true lists the headings, section=<heading> reads one section.",
    inputShape: {
      page: z.string().optional().describe("Page id, page URL or tiny link"),
      title: z.string().optional(),
      space_key: z.string().optional(),
      body_format: z.enum(["markdown", "storage", "none"]).optional().describe("Default markdown"),
      ...bodyReadShape,
    },
    narrowing: BODY_NARROWING,
    async handler({ client }, args) {
      const c = client("confluence");
      const bodyFormat = args.body_format ?? "markdown";
      const expand = `${bodyFormat === "none" ? "" : "body.storage,"}version,space,ancestors`;
      let p: any;
      if (args.page) {
        p = await getPage(c, resolvePageId(args.page), expand);
      } else if (args.title && args.space_key) {
        const data = await c.get(`${API}/content`, { type: "page", spaceKey: args.space_key, title: args.title, limit: 1, expand });
        p = data?.results?.[0];
        if (!p) throw new ValidationError(`No page '${args.title}' in space ${args.space_key}`);
      } else {
        throw new ValidationError("Pass page, or title and space_key");
      }
      return compactPage(c, p, bodyFormat, { outline: args.outline, section: args.section, maxChars: args.max_chars });
    },
  },
  {
    name: "confluence_get_page_children",
    product: "confluence",
    description: "Direct child pages of a page: id | title | version | updated (server-side paging).",
    inputShape: { page: z.string().describe("Parent page id, URL or tiny link"), ...pageShape(50) },
    async handler({ client }, args) {
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const data = await client("confluence").get(`${API}/content/${seg(resolvePageId(args.page))}/child/page`, {
        start: offset,
        limit,
        expand: "version",
      });
      const items = (data?.results ?? []).map((p: any) => ({ id: p.id, title: p.title, version: p.version?.number, updated: p.version?.when }));
      return serverPage(items, offset, limit, null, !data?._links?.next);
    },
  },
  {
    name: "confluence_get_space_page_tree",
    product: "confluence",
    description: "All pages of a space as an indented tree (`id title`, two spaces per level), up to `limit` pages.",
    inputShape: { space_key: z.string(), limit: z.coerce.number().int().min(1).max(5000).optional().describe("Default 500") },
    async handler({ client }, args) {
      const c = client("confluence");
      const max = args.limit ?? 500;
      const pages: any[] = [];
      let start = 0;
      let more = false;
      for (;;) {
        const data = await c.get(`${API}/content`, { spaceKey: args.space_key, type: "page", start, limit: Math.min(200, max - pages.length), expand: "ancestors" });
        const batch: any[] = data?.results ?? [];
        pages.push(...batch);
        more = !!data?._links?.next;
        if (!more || batch.length === 0 || pages.length >= max) break;
        start += batch.length;
      }
      const byParent = new Map<string, any[]>();
      for (const p of pages) {
        const anc: any[] = p.ancestors ?? [];
        const parent = anc.length ? String(anc[anc.length - 1].id) : "";
        if (!byParent.has(parent)) byParent.set(parent, []);
        byParent.get(parent)!.push(p);
      }
      const ids = new Set(pages.map((p) => String(p.id)));
      const lines: string[] = [];
      const walk = (parent: string, depth: number) => {
        for (const p of (byParent.get(parent) ?? []).sort((x, y) => String(x.title).localeCompare(String(y.title)))) {
          lines.push(`${"  ".repeat(depth)}${p.id} ${p.title}`);
          walk(String(p.id), depth + 1);
        }
      };
      walk("", 0);
      // pages whose parent was not fetched (limit reached) become roots
      for (const [parent] of byParent) if (parent && !ids.has(parent)) walk(parent, 0);
      return {
        space: args.space_key,
        pages: pages.length,
        truncated: pages.length >= max && more ? `stopped at ${max}; raise limit` : undefined,
        tree: lines.join("\n"),
      };
    },
  },
  {
    name: "confluence_create_page",
    unverifiable: "not checked: an existing page with the title is not compared (Confluence refuses a duplicate title in a space)",
    product: "confluence",
    write: true,
    description: "Create a page from Markdown (or storage XHTML) in a space, optionally under a parent page.",
    inputShape: { space_key: z.string(), title: z.string(), parent: z.string().optional().describe("Parent page id or URL"), ...contentShape, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const body: Record<string, unknown> = {
        type: "page",
        title: args.title,
        space: { key: args.space_key },
        body: { storage: { value: bodyFrom(args), representation: "storage" } },
      };
      if (args.parent) body.ancestors = [{ id: resolvePageId(args.parent) }];
      const res = await guardedWrite(c, args, {
        method: "POST",
        path: `${API}/content`,
        json: body,
        summary: `Create page '${args.title}' in ${args.space_key}`,
      });
      return finalizeWrite(c, res, undefined);
    },
  },
  {
    name: "confluence_update_page",
    unverifiable: "not checked beyond if_version: the body is not compared before writing",
    product: "confluence",
    write: true,
    description:
      "Replace a page body (Markdown or storage). Pass if_version from the last read to refuse overwriting a newer " +
      "edit (error StaleVersion, exit 5). title/parent are optional and keep the current values by default.",
    inputShape: {
      page: z.string().describe("Page id, URL or tiny link"),
      title: z.string().optional(),
      parent: z.string().optional().describe("Move under this parent page"),
      if_version: versionArg.optional(),
      minor_edit: boolArg.optional(),
      version_comment: z.string().optional(),
      ...contentShape,
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const id = resolvePageId(args.page);
      const storage = bodyFrom(args);
      const { page, current } = await currentForUpdate(c, id, args.if_version);
      const body: Record<string, unknown> = {
        id,
        type: page?.type ?? "page",
        title: args.title ?? page?.title,
        version: { number: current + 1, minorEdit: args.minor_edit ?? false, ...(args.version_comment ? { message: args.version_comment } : {}) },
        body: { storage: { value: storage, representation: "storage" } },
      };
      if (args.parent) body.ancestors = [{ id: resolvePageId(args.parent) }];
      const res = await guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/content/${seg(id)}`,
        json: body,
        summary: `Update page ${id} '${body.title}' v${current} → v${current + 1}`,
      });
      return finalizeWrite(c, res, id);
    },
  },
  {
    name: "confluence_update_page_section",
    unverifiable: "not checked beyond the page version: the section is not compared before writing",
    product: "confluence",
    write: true,
    description:
      "Replace the content under one heading (up to the next heading of the same or higher level) and keep the rest " +
      "of the page untouched. heading matches the heading text exactly.",
    inputShape: {
      page: z.string(),
      heading: z.string(),
      new_content: z.string().describe("Section body without the heading"),
      content_format: z.enum(["markdown", "storage"]).optional(),
      if_version: versionArg.optional(),
      minor_edit: boolArg.optional(),
      version_comment: z.string().optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const id = resolvePageId(args.page);
      const fragment = writeBody(args.new_content, args.content_format);
      const { page, current } = await currentForUpdate(c, id, args.if_version);
      const storage = replaceSection(String(page?.body?.storage?.value ?? ""), args.heading, fragment);
      const res = await guardedWrite(c, args, {
        method: "PUT",
        path: `${API}/content/${seg(id)}`,
        json: {
          id,
          type: page?.type ?? "page",
          title: page?.title,
          version: { number: current + 1, minorEdit: args.minor_edit ?? false, ...(args.version_comment ? { message: args.version_comment } : {}) },
          body: { storage: { value: storage, representation: "storage" } },
        },
        summary: `Update section '${args.heading}' of page ${id} v${current} → v${current + 1}`,
      });
      return finalizeWrite(c, res, id);
    },
  },
  {
    name: "confluence_delete_page",
    unverifiable: "not checked: the page is not read before or after",
    product: "confluence",
    write: true,
    description: "Move a page to the space trash (restorable by a space admin; children are not deleted).",
    inputShape: { page: z.string(), ...dryRunShape },
    async handler({ client }, args) {
      const id = resolvePageId(args.page);
      return guardedWrite(client("confluence"), args, {
        method: "DELETE",
        path: `${API}/content/${seg(id)}`,
        summary: `Move page ${id} to trash`,
      });
    },
  },
  {
    name: "confluence_move_page",
    unverifiable: "not checked: the current parent is not compared",
    product: "confluence",
    write: true,
    description:
      "Move a page under another page (position=append), next to it (above/below), or to a space root. " +
      "DC has no REST endpoint for this: it calls the legacy /pages/movepage.action.",
    inputShape: {
      page: z.string(),
      target: z.string().optional().describe("Target page id or URL"),
      target_space_key: z.string().optional().describe("Required when moving to a space root"),
      position: z.enum(["append", "above", "below"]).optional().describe("Default append (become a child of target)"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const id = resolvePageId(args.page);
      if (!args.target && !args.target_space_key) throw new ValidationError("Pass target and/or target_space_key");
      const targetId = args.target ? resolvePageId(args.target) : undefined;
      const spaceKey = args.target_space_key ?? (await c.get(`${API}/content/${seg(targetId!)}`, { expand: "space" }))?.space?.key;
      const res = await guardedWrite(c, args, {
        method: "POST",
        path: "/pages/movepage.action",
        params: { spaceKey, pageId: id, targetId, position: args.position ?? "append" },
        summary: `Move page ${id} ${args.position ?? "append"} ${targetId ? `page ${targetId}` : `root of ${spaceKey}`}`,
      });
      return finalizeWrite(c, res, id);
    },
  },
  {
    name: "confluence_get_page_history",
    product: "confluence",
    description:
      "Without version: the version list (number | when | by | message | minor). With version: that historical " +
      "version (metadata and body as Markdown, or body_format=storage|none).",
    inputShape: {
      page: z.string(),
      version: versionArg.optional(),
      body_format: z.enum(["markdown", "storage", "none"]).optional(),
      ...bodyReadShape,
      ...pageShape(25),
    },
    narrowing: BODY_NARROWING,
    async handler({ client }, args) {
      const c = client("confluence");
      const id = resolvePageId(args.page);
      if (args.version === undefined) {
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 25;
        const data = await c.get(`${API}/content/${seg(id)}/version`, { start: offset, limit });
        const items = (data?.results ?? []).map((v: any) => ({
          number: v.number,
          when: v.when,
          by: v.by?.username ?? v.by?.displayName,
          message: v.message,
          minor: v.minorEdit || undefined,
        }));
        return serverPage(items, offset, limit, null, !data?._links?.next);
      }
      const bodyFormat = args.body_format ?? "markdown";
      const p = await getPage(c, id, `${bodyFormat === "none" ? "" : "body.storage,"}version,space`, { status: "historical", version: args.version });
      return compactPage(c, p, bodyFormat, { outline: args.outline, section: args.section, maxChars: args.max_chars });
    },
  },
  {
    name: "confluence_get_page_diff",
    product: "confluence",
    description: "Unified diff of two page versions, computed on their Markdown renderings (changed hunks only).",
    inputShape: { page: z.string(), from_version: versionArg, to_version: versionArg },
    async handler({ client }, args) {
      const c = client("confluence");
      const id = resolvePageId(args.page);
      const load = async (v: number) => {
        const p = await getPage(c, id, "body.storage,version", { status: "historical", version: v });
        return { title: p?.title, md: storageToMarkdown(String(p?.body?.storage?.value ?? ""), { baseUrl: c.config.baseUrl, pageId: id, maxCodeLines: Infinity }) };
      };
      const [from, to] = await Promise.all([load(args.from_version), load(args.to_version)]);
      return {
        page: id,
        title: to.title,
        diff: unifiedDiff(from.md.split("\n"), to.md.split("\n"), `v${args.from_version}`, `v${args.to_version}`),
      };
    },
  },
  {
    name: "confluence_get_page_restrictions",
    product: "confluence",
    description: "View (read) and edit (update) restrictions of a page: users and groups; empty = not restricted.",
    inputShape: { page: z.string() },
    async handler({ client }, args) {
      const data = await client("confluence").get(`${API}/content/${seg(resolvePageId(args.page))}/restriction/byOperation`, {
        expand: "restrictions.user,restrictions.group",
      });
      const op = (key: string) => ({
        users: (data?.[key]?.restrictions?.user?.results ?? []).map((u: any) => u.username ?? u.userKey ?? u.displayName),
        groups: (data?.[key]?.restrictions?.group?.results ?? []).map((g: any) => g.name),
      });
      return { read: op("read"), update: op("update") };
    },
  },
  {
    name: "confluence_set_page_restrictions",
    unverifiable: "not checked: current restrictions are not compared",
    product: "confluence",
    write: true,
    description:
      "REPLACE all view/edit restrictions of a page with the given users (usernames) and groups. Omitting everything " +
      "removes all restrictions. Read the current ones first with confluence_get_page_restrictions.",
    inputShape: {
      page: z.string(),
      read_users: listArg.optional(),
      read_groups: listArg.optional(),
      edit_users: listArg.optional(),
      edit_groups: listArg.optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const id = resolvePageId(args.page);
      const entry = (operation: string, users: string[] = [], groups: string[] = []) => ({
        operation,
        restrictions: {
          user: users.map((username) => ({ type: "known", username })),
          group: groups.map((name) => ({ type: "group", name })),
        },
      });
      const body = [entry("read", args.read_users, args.read_groups), entry("update", args.edit_users, args.edit_groups)];
      const count = body.reduce((n, e) => n + e.restrictions.user.length + e.restrictions.group.length, 0);
      return guardedWrite(client("confluence"), args, {
        method: "PUT",
        path: `${API}/content/${seg(id)}/restriction`,
        json: body,
        summary: count ? `Replace restrictions of page ${id} (${count} entries)` : `Remove all restrictions of page ${id}`,
      });
    },
  },
  {
    name: "confluence_copy_page",
    unverifiable: "each call creates another copy",
    product: "confluence",
    write: true,
    description:
      "Copy a page body to a new page (DC has no copy API: attachments, labels, properties and restrictions are not copied).",
    inputShape: {
      page: z.string().describe("Source page id or URL"),
      space_key: z.string().describe("Destination space"),
      title: z.string().describe("New title"),
      parent: z.string().optional().describe("Destination parent page; default space root"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const src = await getPage(c, resolvePageId(args.page), "body.storage,space");
      const body: Record<string, unknown> = {
        type: "page",
        title: args.title,
        space: { key: args.space_key },
        body: { storage: { value: String(src?.body?.storage?.value ?? ""), representation: "storage" } },
      };
      if (args.parent) body.ancestors = [{ id: resolvePageId(args.parent) }];
      const res = await guardedWrite(c, args, {
        method: "POST",
        path: `${API}/content`,
        json: body,
        summary: `Copy page ${src?.id} '${src?.title}' to '${args.title}' in ${args.space_key}`,
      });
      return finalizeWrite(c, res, undefined);
    },
  },
];
