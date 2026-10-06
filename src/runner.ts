/**
 * Runs one tool: validates arguments with the tool's Zod shape and calls the handler.
 * Errors never escape: they become a ToolError with an exit code. Rendering
 * (compact / json / full) and the response-size guard live in the CLI.
 */

import { z } from "zod";
import { AtlassianClient, type FetchLike } from "./client.js";
import { ConfigurationError, loadConfig, type Product } from "./config.js";
import { isHttpStatusError, PermissionError, UnsupportedError, ValidationError, VerificationError } from "./errors.js";
import { exitCodeFor, type ToolError } from "./format.js";
import { findTool } from "./tools/index.js";
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

export function argsSchema(tool: ToolDef) {
  return z.object(tool.inputShape).strict();
}

const HINTS: Record<number, string> = {
  401: "check the PAT or username/password (run: check --ping)",
  403: "the account lacks administrator rights for this action",
  404: "wrong key/id, or not visible to this account",
  409: "conflict with the current state; re-read and retry",
};

export function toToolError(e: any, tool?: ToolDef): ToolError {
  if (isHttpStatusError(e)) {
    return { type: `HTTP${e.status}`, message: e.message, status: e.status, hint: HINTS[e.status] };
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

export async function runTool(tool: ToolDef, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<RunResult> {
  const parsed = argsSchema(tool).safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`);
    return fail({ type: "ValidationError", message: `Invalid arguments for ${tool.name}`, issues, hint: `run: describe ${tool.name}` }, tool);
  }
  try {
    return { ok: true, value: await tool.handler(ctx, parsed.data), tool, exitCode: 0 };
  } catch (e) {
    return fail(toToolError(e, tool), tool);
  }
}

export async function runToolByName(name: string, rawArgs: Record<string, unknown>, ctx: ToolContext): Promise<RunResult> {
  const tool = findTool(name);
  if (!tool) return fail({ type: "UsageError", message: `Unknown tool: ${name}`, hint: "run: list <filter>" });
  return runTool(tool, rawArgs, ctx);
}
