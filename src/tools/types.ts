import type { z } from "zod";
import type { ScanKind } from "../scanCache.js";
import type { AtlassianClient } from "../client.js";
import type { Product } from "../config.js";

/** Shared dependencies passed to every tool handler; clients are created lazily per product. */
export interface ToolContext {
  client(product: Product): AtlassianClient;
  /** During `apply`: objects of this type that earlier items of the plan created (name → id), newest first. */
  created?(type: string): Array<{ name: string; id: string }>;
}

/**
 * One tool: name, description, Zod input shape and handler (pattern from
 * mcp-atlassian-for-admins). `product` is the product the tool talks to, or
 * "both" for platform tools that take a `product` argument. `write` marks
 * tools that can change the instance; they are dry-run by default.
 * The handler returns a plain value; the runner serialises it.
 */
export interface ToolDef {
  name: string;
  product: Product | "both";
  write?: boolean;
  description: string;
  inputShape: z.ZodRawShape;
  /**
   * Cached scans an executed write of this tool can make stale; the runner clears them afterwards
   * (also when the write failed). Dry runs never clear anything. `[]` states that nothing is affected.
   */
  invalidates?: readonly ScanKind[];
  /**
   * Why this write cannot detect an existing target state or read its result back (session kills, reindex
   * starts, new comments...). `describe` shows it and dry runs warn that a repeated apply sends it again.
   */
  unverifiable?: string;
  /** Old argument names still accepted: alias → canonical name. Resolved before validation. */
  aliases?: Record<string, string>;
  /** Arguments that read less of a large result (section, max_chars...); cut markers and ResponseTooLarge name them. */
  narrowing?: string[];
  /** Columns shown when the caller passes no --fields (wide list tools); --fields=+x adds, --fields=all shows all. */
  defaultFields?: string[];
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
}
