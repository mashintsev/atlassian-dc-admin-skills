/**
 * REST client for Jira and Confluence Data Center.
 *
 * Adapted from mcp-atlassian-for-admins (src/client.ts, MIT): undici agent with
 * configurable TLS verification, 429 Retry-After handling, startAt/maxResults
 * auto-paging and bounded concurrency. Generalised to both products, with
 * custom Content-Type/Accept per call (UPM speaks only its vnd.atl media types)
 * and an injectable fetch for tests.
 */

import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig, type Product, type ProductConfig } from "./config.js";
import { HttpStatusError, ValidationError } from "./errors.js";

const PAGINATION_MAX = 1000; // safety cap so paging never loops forever
/** Default cap of items an auto-paging helper collects; callers that need more must say so. */
export const DEFAULT_MAX_ITEMS = 1000;
const MAX_CONCURRENCY = 8; // DC answers 403/429 to bursts of parallel requests
const RATE_LIMIT_RETRIES = 4;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

/** JSON value shorthand — REST responses are untyped at the boundary. */
export type Json = any;

/** Query params; null/undefined are dropped, arrays repeat the key. */
export type Params = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

export interface RequestOptions {
  params?: Params;
  json?: Json;
  /** multipart/form-data body (attachments); the boundary header is set by fetch */
  form?: FormData;
  contentType?: string;
  accept?: string;
  /** Extra headers for this call only (e.g. X-ExperimentalApi: opt-in for Service Desk). */
  headers?: Record<string, string>;
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type FetchLike = (url: string, init: Record<string, any>) => Promise<FetchResponse>;

export interface Download {
  bytes: Buffer;
  contentType: string | null;
}

export function buildQuery(params?: Params): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => sp.append(k, String(item)));
    else sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** Encode one path segment (user names, group names and plugin keys may contain spaces or slashes). */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** Run thunks with at most `limit` in flight; results keep input order. */
export async function boundedAll<T>(thunks: Array<() => Promise<T>>, limit = MAX_CONCURRENCY): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= thunks.length) return;
      results[i] = await thunks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, () => worker()));
  return results;
}

/** Jira user keys look like JIRAUSER10000. */
export function isJiraUserKey(input: string): boolean {
  return /^JIRAUSER\d+$/i.test(input);
}

export class AtlassianClient {
  readonly product: Product;
  readonly config: ProductConfig;
  private readonly agent?: Agent;
  private readonly fetchImpl: FetchLike;

  constructor(config: ProductConfig, fetchImpl?: FetchLike) {
    this.product = config.product;
    this.config = config;
    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    } else {
      this.agent = new Agent({ keepAliveTimeout: 30_000, connect: { rejectUnauthorized: config.verifySsl } });
      this.fetchImpl = undiciFetch as unknown as FetchLike;
    }
  }

  static fromEnv(product: Product): AtlassianClient {
    return new AtlassianClient(loadConfig(product));
  }

  async close(): Promise<void> {
    await this.agent?.close();
  }

  url(path: string, params?: Params): string {
    return this.config.baseUrl + (path.startsWith("/") ? path : `/${path}`) + buildQuery(params);
  }

  /** Send with 429 retry; throws HttpStatusError on >= 400 (body read as text for the message). */
  private async send(method: string, url: string, opts: RequestOptions): Promise<FetchResponse> {
    const headers: Record<string, string> = { ...this.config.headers, ...(opts.headers ?? {}) };
    if (opts.accept) headers.Accept = opts.accept;
    const init: Record<string, any> = { method, headers };
    if (this.agent) init.dispatcher = this.agent;
    if (opts.form !== undefined) {
      init.body = opts.form;
    } else if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      headers["Content-Type"] = opts.contentType ?? "application/json";
    }

    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
      if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
        await res.text();
        const retryAfterS = Number(res.headers.get("retry-after"));
        const waitMs = Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.min(waitMs, RATE_LIMIT_MAX_WAIT_MS)));
        continue;
      }
      if (res.status >= 400) throw new HttpStatusError(res.status, await res.text(), url, method);
      return res;
    }
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Json> {
    const res = await this.send(method, this.url(path, opts.params), opts);
    return parse(await res.text());
  }

  /** GET a binary body (attachments, exports). `path` may be an absolute URL on the same host. */
  async getBytes(pathOrUrl: string, params?: Params): Promise<Download> {
    const url = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl + buildQuery(params) : this.url(pathOrUrl, params);
    if (!url.startsWith(this.config.baseUrl)) {
      // never send the PAT to another host
      throw new ValidationError(`Refusing to download from outside ${this.config.baseUrl}: ${url}`);
    }
    const res = await this.send("GET", url, { accept: "*/*" });
    const buf = res.arrayBuffer ? Buffer.from(await res.arrayBuffer()) : Buffer.from(await res.text());
    return { bytes: buf, contentType: res.headers.get("content-type") };
  }

  get(path: string, params?: Params, accept?: string, headers?: Record<string, string>): Promise<Json> {
    return this.request("GET", path, { params, accept, headers });
  }

  /** Auto-page endpoints returning `{startAt, maxResults, total, <key>}` (Jira style). */
  async getPaged(path: string, key = "values", params: Params = {}, pageSize = 50, maxItems = DEFAULT_MAX_ITEMS): Promise<Json[]> {
    const results: Json[] = [];
    let start = 0;
    for (let i = 0; i < PAGINATION_MAX && results.length < maxItems; i++) {
      const data = await this.get(path, { ...params, startAt: start, maxResults: pageSize });
      const batch: Json[] = (data && data[key]) || [];
      results.push(...batch);
      const total: number = data?.total ?? (data?.isLast ? results.length : Infinity);
      if (batch.length === 0 || results.length >= total || data?.isLast === true) break;
      start += batch.length;
    }
    return results.slice(0, maxItems);
  }

  /** Auto-page Confluence `{results, start, limit, size, _links.next}` responses. */
  async getPagedConfluence(path: string, params: Params = {}, pageSize = 100, maxItems = DEFAULT_MAX_ITEMS): Promise<Json[]> {
    const results: Json[] = [];
    let start = 0;
    for (let i = 0; i < PAGINATION_MAX && results.length < maxItems; i++) {
      const data = await this.get(path, { ...params, start, limit: pageSize });
      const batch: Json[] = data?.results ?? [];
      results.push(...batch);
      if (batch.length === 0 || !data?._links?.next) break;
      start += batch.length;
    }
    return results.slice(0, maxItems);
  }
}

function parse(text: string): Json {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
