/**
 * Environment-driven configuration for Jira and Confluence Data Center.
 *
 * Adapted from mcp-atlassian-for-admins (src/config.ts, MIT): same PAT / Basic /
 * reverse-proxy gateway modes, generalised from JIRA_* to a per-product prefix.
 * Sources (see configSources): environment, $ATLASSIAN_ENV_FILE, the project's
 * .atlassian-dc-admin.env, ./.env, the skill's .env, ~/.config/atlassian-dc-admin/.env.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PRODUCTS = ["jira", "confluence"] as const;
export type Product = (typeof PRODUCTS)[number];

export interface ProductConfig {
  product: Product;
  baseUrl: string;
  verifySsl: boolean;
  /** PEM file with extra trusted root certificates (e.g. a company CA); verification stays on. */
  caFile?: string;
  timeoutMs: number;
  headers: Record<string, string>;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Per-project config file, looked up from the working directory upwards. */
export const PROJECT_CONFIG_FILE = ".atlassian-dc-admin.env";

/** Keys that belong to one product instance and must come from a single source. */
function productOf(key: string): Product | undefined {
  if (key.startsWith("JIRA_") || key === "ASSETS_API_BASE") return "jira";
  if (key.startsWith("CONFLUENCE_")) return "confluence";
  return undefined;
}

export interface ConfigSource {
  /** "environment", or the file path */
  label: string;
  path?: string;
  /** fixed locations outside any repository; only they may weaken safety settings */
  trusted: boolean;
  values: Record<string, string>;
}

function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).replace(/^export\s+/, "").trim();
    const value = line.slice(idx + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (value !== "") values[key] = value;
  }
  return values;
}

/** Nearest PROJECT_CONFIG_FILE from `dir` upwards (stops at the filesystem root). */
export function findProjectConfig(dir: string = process.cwd()): string | undefined {
  let cur = resolve(dir);
  for (;;) {
    const candidate = join(cur, PROJECT_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

let sourcesCache: ConfigSource[] | undefined;
const realEnv: Record<string, string | undefined> = { ...process.env };

/**
 * Configuration sources, highest priority first:
 *   1. the process environment
 *   2. $ATLASSIAN_ENV_FILE
 *   3. <project>/.atlassian-dc-admin.env — nearest one from the working directory upwards,
 *      so each project can point at its own Jira / Confluence
 *   4. ./.env of the working directory (legacy)
 *   5. <skill dir>/.env                       (trusted)
 *   6. ~/.config/atlassian-dc-admin/.env      (trusted; machine-wide default)
 *
 * Product settings (JIRA_*, ASSETS_API_BASE / CONFLUENCE_*) are taken as a whole from the first
 * source that defines <PRODUCT>_URL, never mixed across sources: a token from one file is never
 * sent to the URL from another. Other settings (ATLASSIAN_*) are merged, first source wins.
 */
export interface SourceOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  home?: string;
  skillDir?: string;
}

export function configSources(opts?: SourceOptions): ConfigSource[] {
  if (!opts && sourcesCache) return sourcesCache;
  const cwd = opts?.cwd ?? process.cwd();
  const env = opts?.env ?? realEnv;
  // bundled CLI lives in <skill>/scripts/, the skill's .env is one level up
  const skillDir = opts?.skillDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files: Array<[string | undefined, boolean]> = [
    [env.ATLASSIAN_ENV_FILE, false],
    [findProjectConfig(cwd), false],
    [join(cwd, ".env"), false],
    [join(skillDir, ".env"), true],
    [join(opts?.home ?? homedir(), ".config", "atlassian-dc-admin", ".env"), true],
  ];
  const envValues = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""));
  const sources: ConfigSource[] = [{ label: "environment", trusted: false, values: envValues }];
  const seen = new Set<string>();
  for (const [file, trusted] of files) {
    if (!file) continue;
    const path = resolve(file);
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    sources.push({ label: path, path, trusted, values: parseEnvText(readFileSync(path, "utf8")) });
  }
  if (!opts) sourcesCache = sources;
  return sources;
}

/** Forget cached sources (tests, or after the working directory changed). */
export function resetConfigSources(): void {
  sourcesCache = undefined;
  dotenvLoaded = false;
}

/** The source that configures `product` (the first one defining <PRODUCT>_URL). */
export function productSource(product: Product, opts?: SourceOptions): ConfigSource | undefined {
  const key = `${product.toUpperCase()}_URL`;
  return configSources(opts).find((s) => s.values[key]);
}

/** <PRODUCT>_* values of one product, all from its source. */
export function productValues(product: Product, opts?: SourceOptions): Record<string, string | undefined> {
  const src = productSource(product, opts);
  if (!src) return {};
  return Object.fromEntries(Object.entries(src.values).filter(([k]) => productOf(k) === product));
}

let dotenvLoaded = false;

/**
 * Make non-product settings from config files visible in process.env (first source wins) and
 * export the Jira source's ASSETS_API_BASE. Product credentials stay out of process.env.
 */
export function loadDotenv(): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  for (const src of configSources().slice(1)) {
    for (const [k, v] of Object.entries(src.values)) {
      if (!productOf(k) && process.env[k] === undefined) process.env[k] = v;
    }
  }
  const assets = productValues("jira").ASSETS_API_BASE;
  if (assets && process.env.ASSETS_API_BASE === undefined) process.env.ASSETS_API_BASE = assets;
}

/** A value from a trusted config file only (never from the environment or a project file). */
export function configFileValue(key: string): string | undefined {
  for (const src of configSources()) if (src.trusted && src.values[key] !== undefined) return src.values[key];
  return undefined;
}

function truthy(value: string | undefined, def: boolean): boolean {
  if (value === undefined || value === "") return def;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Build the connection config for one product from <PRODUCT>_* variables:
 *
 *   <P>_URL                    base URL (required)
 *   <P>_PAT_TOKEN              personal access token (preferred), or
 *   <P>_USERNAME/<P>_PASSWORD  Basic auth
 *   <P>_SSL_VERIFY             default true
 *   <P>_CA_FILE                PEM file with extra trusted root certificates (company CA)
 *   <P>_TIMEOUT                seconds, default 60
 *   <P>_PROXY_BASIC | <P>_PROXY_USER/<P>_PROXY_PASS, <P>_TOKEN_HEADER
 *                              gateway mode: the proxy takes Authorization, the PAT
 *                              travels in <P>_TOKEN_HEADER (default X-Atlassian-Pat)
 */
export function loadConfig(product: Product, env?: NodeJS.ProcessEnv): ProductConfig {
  // explicit env (tests, callers) is used as is; otherwise the product's single config source
  const values: Record<string, string | undefined> = env ?? productValues(product);
  const P = product.toUpperCase();
  const get = (name: string) => {
    const v = values[`${P}_${name}`];
    return v === undefined || v === "" ? undefined : v;
  };

  const url = get("URL");
  if (!url) throw new ConfigurationError(`${P}_URL is not set`);
  const baseUrl = url.replace(/\/+$/, "");

  const headers: Record<string, string> = {
    Accept: "application/json",
    // Jira and Confluence reject non-GET REST calls without it (XSRF check).
    "X-Atlassian-Token": "no-check",
    "User-Agent": "atlassian-dc-admin-skills",
  };

  const pat = get("PAT_TOKEN");
  const proxyBasic =
    get("PROXY_BASIC") ??
    (get("PROXY_USER") !== undefined
      ? Buffer.from(`${get("PROXY_USER")}:${get("PROXY_PASS") ?? ""}`).toString("base64")
      : undefined);

  if (proxyBasic) {
    if (!pat) throw new ConfigurationError(`${P}_PAT_TOKEN is required in proxy gateway mode`);
    headers.Authorization = `Basic ${proxyBasic}`;
    headers[get("TOKEN_HEADER") ?? "X-Atlassian-Pat"] = pat;
  } else if (pat) {
    headers.Authorization = `Bearer ${pat}`;
  } else if (get("USERNAME") && get("PASSWORD")) {
    headers.Authorization = `Basic ${Buffer.from(`${get("USERNAME")}:${get("PASSWORD")}`).toString("base64")}`;
  } else {
    throw new ConfigurationError(`Set ${P}_PAT_TOKEN, or ${P}_USERNAME and ${P}_PASSWORD`);
  }

  const caFile = get("CA_FILE");
  if (caFile !== undefined && !existsSync(caFile)) throw new ConfigurationError(`${P}_CA_FILE points to a missing file: ${caFile}`);

  const timeoutS = Number(get("TIMEOUT") ?? 60);
  return {
    product,
    baseUrl,
    verifySsl: truthy(get("SSL_VERIFY"), true),
    caFile,
    timeoutMs: (Number.isFinite(timeoutS) && timeoutS > 0 ? timeoutS : 60) * 1000,
    headers,
  };
}

/** Which products are configured, without contacting the servers. */
export function checkAvailableServices(env?: NodeJS.ProcessEnv): {
  available_services: Product[];
  unavailable_services: Partial<Record<Product, string>>;
} {
  const available: Product[] = [];
  const unavailable: Partial<Record<Product, string>> = {};
  for (const product of PRODUCTS) {
    try {
      const cfg = loadConfig(product, env);
      available.push(product);
      void cfg;
    } catch (e) {
      unavailable[product] = e instanceof Error ? e.message : String(e);
    }
  }
  return { available_services: available, unavailable_services: unavailable };
}
