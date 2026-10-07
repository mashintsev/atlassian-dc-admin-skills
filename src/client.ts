/**
 * REST client for Jira and Confluence Data Center.
 *
 * Adapted from mcp-atlassian-for-admins (src/client.ts, MIT): undici agent with
 * configurable TLS verification, 429 Retry-After handling, startAt/maxResults
 * auto-paging and bounded concurrency. Generalised to both products, with
 * custom Content-Type/Accept per call (UPM speaks only its vnd.atl media types)
 * and an injectable fetch for tests.
 */

import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";
import { loadConfig, type Product, type ProductConfig } from "./config.js";
import { AuthenticationRequiredError, HttpStatusError, UpstreamError, ValidationError, WebSudoRequiredError } from "./errors.js";

const PAGINATION_MAX = 1000; // safety cap so paging never loops forever
/** Default cap of items an auto-paging helper collects; callers that need more must say so. */
export const DEFAULT_MAX_ITEMS = 1000;
const MAX_CONCURRENCY = 8; // DC answers 403/429 to bursts of parallel requests
/** Attempts per request: 429 for any method; 502/503/504, resets and timeouts for reads only. */
const MAX_ATTEMPTS = 5;
/** A server asking to wait longer than this ends the retries with its error. */
const MAX_RETRY_WAIT_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const TRANSIENT_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);

/** Time seam: tests replace these so retries neither wait nor depend on randomness. */
export const timing = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  random: () => Math.random(),
};

/** Wait asked for by `Retry-After` (seconds or HTTP date), or undefined. */
function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - timing.now()) : undefined;
}

/** Exponential backoff with jitter, so parallel workers do not retry in lockstep. */
function backoffMs(attempt: number): number {
  return Math.round(BACKOFF_BASE_MS * 2 ** attempt * (0.5 + timing.random()));
}

const looksLikeHtml = (text: string) => /^\s*(<!doctype html|<html)/i.test(text);

/**
 * The error for an HTML page where JSON was expected (or with an error status): login page, websudo
 * prompt, or a proxy/gateway page. Never includes the HTML itself.
 */
function htmlError(status: number, text: string, loginReason: string | null, method: string, url: string): Error {
  const where = `${method} ${url}`;
  if (/WebSudoAuthenticate|webSudoPassword|websudo/i.test(text)) {
    return new WebSudoRequiredError(`${where}: Jira asks for administrator (websudo) re-authentication`);
  }
  // Jira's own login page, or a single sign-on provider it redirected to (OAuth2/SAML)
  if (loginReason || /login\.jsp|os_destination|id="login-form"|oauth2\/[^"' ]*authorize|SAMLRequest/i.test(text)) {
    return new AuthenticationRequiredError(`${where}: the server answered with its login page${loginReason ? ` (${loginReason})` : ""}`);
  }
  return new UpstreamError(`${where}: HTTP ${status} with an HTML page from a proxy or gateway instead of the application`, status);
}

/**
 * Whether a REST call ended on a login page: Jira's own login.jsp, or another host (a single sign-on
 * provider) that answered something other than JSON. A redirect to the canonical host or port of the same
 * Jira still answers JSON and is data.
 */
function redirectedToLogin(finalUrl: string, baseUrl: string, text: string): boolean {
  try {
    const u = new URL(finalUrl);
    if (/\/login\.jsp$/.test(u.pathname)) return true;
    return u.host !== new URL(baseUrl).host && !isJsonText(text);
  } catch {
    return false;
  }
}

function isJsonText(text: string): boolean {
  if (!text.trim()) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function isTransient(e: any): boolean {
  if (e?.name === "TimeoutError") return true;
  return e?.message === "fetch failed" && TRANSIENT_CODES.has(String(e?.cause?.code ?? ""));
}

/** JSON value shorthand — REST responses are untyped at the boundary. */
export type Json = any;

/** Query params; null/undefined are dropped, arrays repeat the key. */
export type Params = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

export interface RequestOptions {
  params?: Params;
  json?: Json;
  /** multipart/form-data body (attachments); the boundary header is set by fetch */
  form?: FormData;
  /** application/x-www-form-urlencoded body (form parameters of internal resources) */
  urlencoded?: Record<string, string | number | boolean>;
  /** Raw text body, sent as is with `contentType` */
  body?: string;
  contentType?: string;
  accept?: string;
  /** Extra headers for this call only (e.g. X-ExperimentalApi: opt-in for Service Desk). */
  headers?: Record<string, string>;
}

export interface FetchResponse {
  status: number;
  /** Final URL after redirects (a login or SSO redirect ends elsewhere). */
  url?: string;
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

/**
 * Run thunks with at most `limit` in flight; results keep input order. After the first failure no new
 * thunk starts (those in flight finish and are dropped). The client's limiter bounds the actual requests,
 * also when fan-outs are nested.
 */
export async function boundedAll<T>(thunks: Array<() => Promise<T>>, limit = MAX_CONCURRENCY): Promise<T[]> {
  const results = new Array<T>(thunks.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    for (;;) {
      if (failed) return;
      const i = next++;
      if (i >= thunks.length) return;
      try {
        results[i] = await thunks[i]();
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, thunks.length) }, () => worker()));
  return results;
}

/** Jira user keys look like JIRAUSER10000. */
export function isJiraUserKey(input: string): boolean {
  return /^JIRAUSER\d+$/i.test(input);
}

/**
 * TLS options for a product: verification as configured, and with <P>_CA_FILE the standard
 * roots plus the file's certificates (so a company CA is trusted without turning checks off).
 */
export function tlsOptions(config: ProductConfig): { rejectUnauthorized: boolean; ca?: string[] } {
  if (!config.caFile) return { rejectUnauthorized: config.verifySsl };
  return { rejectUnauthorized: config.verifySsl, ca: [...rootCertificates, readFileSync(config.caFile, "utf8")] };
}

/**
 * Requests in flight for one client: at most `limit`, which halves on a 429 (never below 2) and grows by
 * one after every 20 consecutive successes, up to `max` (ATLASSIAN_MAX_CONCURRENCY, default 8).
 */
export class RequestLimiter {
  readonly max: number;
  limit: number;
  private active = 0;
  private successes = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
    this.limit = this.max;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.active <= this.limit ? this.waiting.shift() : undefined;
    if (next) next(); // the slot passes to the waiting request
    else this.active--;
  }

  throttled(): void {
    this.limit = Math.min(this.limit, Math.max(2, Math.floor(this.limit / 2)));
    this.successes = 0;
  }

  succeeded(): void {
    if (++this.successes < 20) return;
    this.successes = 0;
    if (this.limit < this.max) {
      this.limit++;
      // a new slot exists only while fewer requests run than the raised limit (a 429 may have left more in flight)
      const next = this.active < this.limit ? this.waiting.shift() : undefined;
      if (next) {
        this.active++;
        next();
      }
    }
  }
}

function configuredConcurrency(): number {
  const n = Number(process.env.ATLASSIAN_MAX_CONCURRENCY);
  return Number.isInteger(n) && n > 0 ? n : MAX_CONCURRENCY;
}

export class AtlassianClient {
  readonly product: Product;
  readonly config: ProductConfig;
  private readonly agent?: Agent;
  private readonly fetchImpl: FetchLike;
  readonly limiter = new RequestLimiter(configuredConcurrency());
  /** The last `atlassian.xsrf.token` cookie Jira set on any response. */
  private xsrfCookie?: string;

  constructor(config: ProductConfig, fetchImpl?: FetchLike) {
    this.product = config.product;
    this.config = config;
    if (fetchImpl) {
      this.fetchImpl = fetchImpl;
    } else {
      this.agent = new Agent({ keepAliveTimeout: 30_000, connect: tlsOptions(config) });
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

  /**
   * Send with retries: 429 for any method (Jira rejects throttled requests before processing them);
   * 502/503/504, connection resets and timeouts only for GET/HEAD, so a write is never repeated.
   * Throws HttpStatusError on >= 400 (body read as text for the message).
   */
  private async send(method: string, url: string, opts: RequestOptions): Promise<FetchResponse> {
    const headers: Record<string, string> = { ...this.config.headers, ...(opts.headers ?? {}) };
    if (opts.accept) headers.Accept = opts.accept;
    const init: Record<string, any> = { method, headers };
    if (this.agent) init.dispatcher = this.agent;
    if (opts.form !== undefined) {
      init.body = opts.form;
    } else if (opts.urlencoded !== undefined) {
      init.body = new URLSearchParams(Object.entries(opts.urlencoded).map(([k, v]): [string, string] => [k, String(v)])).toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else if (opts.body !== undefined) {
      init.body = opts.body;
      headers["Content-Type"] = opts.contentType ?? "text/plain";
    } else if (opts.json !== undefined) {
      init.body = JSON.stringify(opts.json);
      headers["Content-Type"] = opts.contentType ?? "application/json";
    }
    const read = method === "GET" || method === "HEAD";

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= MAX_ATTEMPTS - 1;
      let res: FetchResponse;
      await this.limiter.acquire();
      try {
        res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.config.timeoutMs) });
      } catch (e) {
        this.limiter.release();
        if (read && !last && isTransient(e)) {
          await timing.sleep(backoffMs(attempt));
          continue;
        }
        throw e;
      }
      this.limiter.release();
      const cookie = /atlassian\.xsrf\.token=([^;,\s]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
      if (cookie) this.xsrfCookie = cookie;
      if (res.status === 429) this.limiter.throttled();
      else if (res.status < 400) this.limiter.succeeded();
      const retryable = res.status === 429 || (read && RETRYABLE_STATUS.has(res.status));
      if (retryable && !last) {
        const asked = retryAfterMs(res.headers.get("retry-after"));
        if (asked === undefined || asked <= MAX_RETRY_WAIT_MS) {
          await res.text();
          await timing.sleep(asked ?? backoffMs(attempt));
          continue;
        }
      }
      if (res.status >= 400) {
        const text = await res.text();
        if (looksLikeHtml(text)) {
          const e = htmlError(res.status, text, res.headers.get("x-seraph-loginreason"), method, url);
          // other HTML error pages (an HTML 404, say) keep their HTTP status; tools rely on it
          if (!(e instanceof UpstreamError) || RETRYABLE_STATUS.has(res.status)) throw e;
        }
        throw new HttpStatusError(res.status, text, url, method);
      }
      return res;
    }
  }

  async request(method: string, path: string, opts: RequestOptions = {}): Promise<Json> {
    const url = this.url(path, opts.params);
    const res = await this.send(method, url, opts);
    const text = await res.text();
    // a REST call that ended on a login page or on another host (SSO redirect) needs authentication
    if (res.url && redirectedToLogin(res.url, this.config.baseUrl, text)) {
      throw new AuthenticationRequiredError(`${method} ${url}: redirected to a login page (${new URL(res.url).host})`);
    }
    // a 200 HTML page (login, websudo, proxy) on a REST call is an error, never data
    if (looksLikeHtml(text) || res.headers.get("x-seraph-loginreason")?.includes("FAILED")) {
      throw htmlError(res.status, text, res.headers.get("x-seraph-loginreason"), method, url);
    }
    return parse(text);
  }

  /**
   * Jira's XSRF token for resources that check `atl_token` (double submit: the token goes back
   * as the `atlassian.xsrf.token` cookie and as the parameter). Read from the cookie Jira sets
   * on any response; undefined when Jira sets none.
   */
  async xsrfToken(): Promise<string | undefined> {
    if (this.xsrfCookie) return this.xsrfCookie;
    const res = await this.send("GET", this.url("/rest/api/2/serverInfo"), {});
    await res.text();
    return this.xsrfCookie;
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
    return (await this.getPagedResult(path, key, params, pageSize, maxItems)).items;
  }

  /** Like getPaged, and says whether items were left behind because of the cap. */
  async getPagedResult(path: string, key = "values", params: Params = {}, pageSize = 50, maxItems = DEFAULT_MAX_ITEMS): Promise<PagedResult> {
    const results: Json[] = [];
    let start = 0;
    let more = false;
    for (let i = 0; i < PAGINATION_MAX; i++) {
      const data = await this.get(path, { ...params, startAt: start, maxResults: pageSize });
      const batch: Json[] = (data && data[key]) || [];
      results.push(...batch);
      const total: number = data?.total ?? (data?.isLast ? results.length : Infinity);
      if (batch.length === 0 || results.length >= total || data?.isLast === true) break;
      if (results.length >= maxItems) {
        more = true;
        break;
      }
      start += batch.length;
    }
    return { items: results.slice(0, maxItems), truncated: more || results.length > maxItems, cap: maxItems };
  }

  /** Auto-page Confluence `{results, start, limit, size, _links.next}` responses. */
  async getPagedConfluence(path: string, params: Params = {}, pageSize = 100, maxItems = DEFAULT_MAX_ITEMS): Promise<Json[]> {
    return (await this.getPagedConfluenceResult(path, params, pageSize, maxItems)).items;
  }

  /** Like getPagedConfluence, and says whether items were left behind because of the cap. */
  async getPagedConfluenceResult(path: string, params: Params = {}, pageSize = 100, maxItems = DEFAULT_MAX_ITEMS): Promise<PagedResult> {
    const results: Json[] = [];
    let start = 0;
    let more = false;
    for (let i = 0; i < PAGINATION_MAX; i++) {
      const data = await this.get(path, { ...params, start, limit: pageSize });
      const batch: Json[] = data?.results ?? [];
      results.push(...batch);
      if (batch.length === 0 || !data?._links?.next) break;
      if (results.length >= maxItems) {
        more = true;
        break;
      }
      start += batch.length;
    }
    return { items: results.slice(0, maxItems), truncated: more || results.length > maxItems, cap: maxItems };
  }
}

/** Items collected by a paging helper; `truncated` when the cap stopped it before the end. */
export interface PagedResult {
  items: Json[];
  truncated: boolean;
  cap: number;
}

function parse(text: string): Json {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
