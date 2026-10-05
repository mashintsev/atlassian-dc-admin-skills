import type { z } from "zod";
import type { AtlassianClient } from "../client.js";
import type { Product } from "../config.js";

/** Shared dependencies passed to every tool handler; clients are created lazily per product. */
export interface ToolContext {
  client(product: Product): AtlassianClient;
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
  handler: (ctx: ToolContext, args: Record<string, any>) => Promise<unknown>;
}
