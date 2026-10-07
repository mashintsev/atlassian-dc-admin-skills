/**
 * Runs one tool: validates arguments with the tool's Zod shape and calls the handler.
 * Errors never escape: they become a ToolError with an exit code. Rendering
 * (compact / json / full) and the response-size guard live in the CLI.
 */

import { z } from "zod";
import { AtlassianClient, type FetchLike } from "./client.js";
import { ConfigurationError, loadConfig, type Product } from "./config.js";
import { AuthenticationRequiredError, isHttpStatusError, PermissionError, UnsupportedError, UpstreamError, ValidationError, VerificationError, WebSudoRequiredError } from "./errors.js";
import { exitCodeFor, type ToolError } from "./format.js";
import { ALL_TOOLS, findTool } from "./tools/index.js";
import { invalidateScans } from "./scanCache.js";
import type { ToolContext, ToolDef } from "./tools/types.js";

export type RunResult =
  | { ok: true; value: unknown; tool: ToolDef; exitCode: 0 }
  | { ok: false; error: ToolError; tool?: ToolDef; exitCode: number };

/** Lazily creates one client per product; reused across tools of one run. */
export function createContext(fetchImpl?: FetchLike, env?: NodeJS.ProcessEnv) {
  const clients = new Map<Product, AtlassianClient>();
  const ctx: ToolContext = {
    client(product) {
      let c = clients.get(product);
      if (!c) {
        c = new AtlassianClient(loadConfig(product, env), fetchImpl);
        clients.set(product, c);
      }
      return c;
    },
  };
  return {
    ctx,
    async close() {
      await Promise.all([...clients.values()].map((c) => c.close()));
    },
  };
}

/** The schema a value is checked against, through optional/default/nullable wrappers and pipes. */
function baseSchema(schema: any): any {
  let s = schema;
  for (let i = 0; i < 12 && s?._zod?.def; i++) {
    const def = s._zod.def;
    if (["optional", "nullable", "default", "prefault", "catch", "readonly", "nonoptional"].includes(def.type)) s = def.innerType;
    // z.preprocess(fn, schema) is a pipe from a transform: the value ends up checked by `out`
    else if (def.type === "pipe") s = def.in?._zod?.def?.type === "transform" ? def.out : def.in;
    else break;
  }
  return s;
}

const TRUE_WORDS = new Set(["true", "yes", "1", "on"]);
const FALSE_WORDS = new Set(["false", "no", "0", "off"]);

/** Old behaviour for parameters of unknown type: JSON when it parses, keeping ids like 00123 as text. */
function looseJson(text: string): unknown {
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    return text;
  }
  return typeof value === "number" && String(value) !== text ? text : value;
}

/** One `key=value` text converted to what the parameter's schema expects; non-text values pass unchanged. */
export function coerceValue(schema: unknown, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const def = baseSchema(schema)?._zod?.def;
  const text = value.trim();
  const json = () => {
    if (!/^[[{]/.test(text)) return value;
    try {
      return JSON.parse(text);
    } catch {
      return value; // the parameter's own validation reports it
    }
  };
  switch (def?.type) {
    case "string":
    case "enum":
      return value;
    case "literal":
      return (def.values ?? []).some((x: unknown) => typeof x === "number") && Number.isFinite(Number(text)) ? Number(text) : value;
    case "number":
    case "bigint":
      return text !== "" && Number.isFinite(Number(text)) ? Number(text) : value;
    case "boolean": {
      const word = text.toLowerCase();
      return TRUE_WORDS.has(word) ? true : FALSE_WORDS.has(word) ? false : value;
    }
    case "array":
    case "object":
    case "record":
    case "tuple":
      return json();
    case "union": {
      const options: any[] = def.options ?? [];
      if (/^[[{]/.test(text)) return json();
      return options.some((o) => baseSchema(o)?._zod?.def?.type === "string") ? value : looseJson(text);
    }
    default:
      return looseJson(text);
  }
}

/** CLI arguments (text) converted per parameter schema: name=2025 stays text, limit=20 becomes a number. */
export function coerceArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const shape = tool.inputShape as Record<string, unknown>;
  // an old name (alias) is converted by its canonical argument's schema
  const schemaOf = (k: string) => (k in shape ? shape[k] : tool.aliases?.[k] !== undefined ? shape[tool.aliases[k]!] : undefined);
  return Object.fromEntries(Object.entries(args).map(([k, v]) => {
    const schema = schemaOf(k);
    return [k, schema !== undefined ? coerceValue(schema, v) : v];
  }));
}

export function argsSchema(tool: ToolDef) {
  return z.object(tool.inputShape).strict();
}

/** Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions). */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** Up to three candidates within edit distance 3, or sharing a prefix, closest first. */
export function suggest(word: string, candidates: string[]): string[] {
  const w = word.toLowerCase();
  return candidates
    .map((c) => ({ c, d: editDistance(w, c.toLowerCase()) }))
    .filter(({ c, d }) => d <= 3 || (w.length >= 4 && c.toLowerCase().startsWith(w)))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, 3)
    .map(({ c }) => c);
}

const HINTS: Record<number, string> = {
  400: "check the arguments: run describe <tool>",
  429: "the server is throttling; retry later or narrow the call",
  401: "check the PAT or username/password (run: check --ping)",
  403: "the account lacks administrator rights for this action",
  404: "wrong key/id, or not visible to this account",
  409: "conflict with the current state; re-read and retry",
};

export function toToolError(e: any, tool?: ToolDef): ToolError {
  if (isHttpStatusError(e)) {
    const hint = HINTS[e.status] ?? (e.status >= 500 ? "server-side failure; retry, and check the application's health if it repeats" : undefined);
    return { type: `HTTP${e.status}`, message: e.message, status: e.status, hint };
  }
  if (e instanceof AuthenticationRequiredError) return { type: e.name, message: e.message, hint: "the token is missing, expired or rejected: check it (run: check --ping)" };
  if (e instanceof WebSudoRequiredError) {
    return { type: e.name, message: e.message, hint: "this admin page needs a websudo session, which token calls cannot open: do it in the Jira UI" };
  }
  if (e instanceof UpstreamError) {
    return { type: e.name, message: e.message, status: undefined, upstreamStatus: e.status, hint: "a proxy or gateway answered (Jira restarting or overloaded?); retry later" };
  }
  if (e instanceof PermissionError) return { type: e.name, message: e.message, status: 403, hint: HINTS[403] };
  if (e instanceof VerificationError) return { type: e.name, message: e.message, state: e.state, hint: "re-read the target; the change may be partly applied" };
  if (e instanceof UnsupportedError) return { type: e.name, message: e.message, ...(e.details ?? {}) };
  if (e instanceof ValidationError || e instanceof ConfigurationError) {
    return { type: e.name, message: e.message, hint: e instanceof ConfigurationError ? "run: check" : undefined };
  }
  const code = e?.cause?.code;
  if (e?.message === "fetch failed" && code) {
    const tls = String(code).startsWith("CERT") || String(code).includes("SELF_SIGNED");
    return {
      type: "NetworkError",
      message: `Cannot reach the ${tool && tool.product !== "both" ? tool.product : ""} server: ${code}`.replace("the  server", "the server"),
      cause: code,
      hint: tls ? "TLS certificate problem; <PRODUCT>_SSL_VERIFY=false only for test instances" : undefined,
    };
  }
  if (e?.name === "TimeoutError") return { type: "NetworkError", message: "Request timed out", hint: "raise <PRODUCT>_TIMEOUT or narrow the call" };
  return { type: e?.name ?? "Error", message: String(e?.message ?? e) };
}

function fail(error: ToolError, tool?: ToolDef): RunResult {
  return { ok: false, error, tool, exitCode: exitCodeFor(error) };
}

/** Old argument names renamed to the canonical ones; an alias and its canonical name with different values is an error. */
export function resolveAliases(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  if (!tool.aliases) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [alias, canonical] of Object.entries(tool.aliases)) {
    if (!(alias in out)) continue;
    const value = out[alias];
    delete out[alias];
    if (canonical in out && JSON.stringify(out[canonical]) !== JSON.stringify(value)) {
      throw new ValidationError(`${alias} is an old name of ${canonical}; pass only one of them (they differ here)`);
    }
    out[canonical] = value;
  }
  return out;
}

export async function runTool(tool: ToolDef, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<RunResult> {
  let named: Record<string, unknown>;
  try {
    named = resolveAliases(tool, rawArgs ?? {});
  } catch (e) {
    return fail({ type: "ValidationError", message: (e as Error).message, hint: `run: describe ${tool.name}` }, tool);
  }
  const parsed = argsSchema(tool).safeParse(coerceArgs(tool, named));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`);
    // a misspelled argument: name the closest argument names (aliases included)
    const known = [...Object.keys(tool.inputShape), ...Object.keys(tool.aliases ?? {})];
    const unknown = parsed.error.issues.flatMap((i: any) => (i.code === "unrecognized_keys" ? (i.keys as string[]) : []));
    const guesses = unknown.map((k) => [k, suggest(k, known)] as const).filter(([, g]) => g.length);
    const hint = guesses.length
      ? `${guesses.map(([k, g]) => `${k}: did you mean ${g.join(", ")}?`).join("; ")} (run: describe ${tool.name})`
      : `run: describe ${tool.name}`;
    return fail({ type: "ValidationError", message: `Invalid arguments for ${tool.name}`, issues, hint }, tool);
  }
  try {
    const value: any = await tool.handler(ctx, parsed.data);
    if (tool.unverifiable && value?.dry_run === true) {
      const note = `not verifiable (${tool.unverifiable}): a repeated apply sends it again`;
      return { ok: true, value: { ...value, warning: value.warning ? `${value.warning}; ${note}` : note }, tool, exitCode: 0 };
    }
    return { ok: true, value, tool, exitCode: 0 };
  } catch (e) {
    return fail(toToolError(e, tool), tool);
  } finally {
    // an executed write (even a failed one) may have changed what cached scans report
    if (tool.write && parsed.data.dry_run === false && tool.invalidates?.length && tool.product !== "both") {
      try {
        invalidateScans(ctx.client(tool.product), tool.invalidates);
      } catch {
        // no client (configuration error): nothing was sent or cached, and the tool's own result stands
      }
    }
  }
}

export async function runToolByName(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<RunResult> {
  const tool = findTool(name);
  if (!tool) {
    const guesses = suggest(name, ALL_TOOLS.map((t) => t.name));
    return fail({ type: "UsageError", message: `Unknown tool: ${name}`, hint: guesses.length ? `did you mean ${guesses.join(", ")}? (or run: list <text>)` : "run: list <text>" });
  }
  return runTool(tool, rawArgs, ctx);
}
