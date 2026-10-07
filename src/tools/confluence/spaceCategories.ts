import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { UnsupportedError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, guardedWrite } from "../util.js";

const API = "/rest/api";
const MAX_CATEGORY_PAGES = 50;
const MAX_CATEGORIES = 1000;
export const spaceCategoryNameSchema = z.string().regex(
  /^[\p{Ll}\p{M}\p{N}_-]{1,255}$/u,
  "Category names must be 1–255 lowercase letters, combining marks, digits, underscores or hyphens",
);

function continuationPath(baseUrl: string, spacePath: string, next: unknown): string | undefined {
  if (typeof next !== "string" || !next) return undefined;
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(next, `${baseUrl}${spacePath}`);
  if (url.origin !== base.origin || url.username || url.password) return undefined;
  const expected = `${basePath}${spacePath}`;
  if (url.pathname !== expected && url.pathname !== spacePath) return undefined;
  return `${spacePath}${url.search}`;
}

async function readSpaceCategories(client: AtlassianClient, spaceKey: string, maxCategories = MAX_CATEGORIES) {
  const spacePath = `${API}/space/${seg(spaceKey)}`;
  const categories: Array<{ name: string; prefix: string }> = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  let path = spacePath;
  let pages = 0;
  let complete = false;

  while (pages < MAX_CATEGORY_PAGES && categories.length < maxCategories) {
    const data = await client.get(path, pages === 0 ? { expand: "metadata.labels" } : undefined);
    pages++;
    const labels = data?.metadata?.labels;
    if (!labels || !Array.isArray(labels.results)) {
      issues.push(`page ${pages} has an unknown metadata.labels response shape`);
      break;
    }
    // some Confluence versions (10.2) send no _links: a page shorter than its limit is then the last one
    if (labels._links === undefined) {
      const limit = Number(labels.limit);
      if (Number.isFinite(limit) && labels.results.length < limit) labels._links = {};
      else {
        issues.push(`page ${pages} has no continuation links and may have more categories`);
        break;
      }
    }
    if (!labels._links || typeof labels._links !== "object" || Array.isArray(labels._links)) {
      issues.push(`page ${pages} has an unknown category continuation shape`);
      break;
    }
    if (labels.results.some((label: any) =>
      !label || typeof label !== "object" || typeof label.prefix !== "string" || typeof label.name !== "string",
    )) {
      issues.push(`page ${pages} contains a malformed category record`);
      break;
    }
    for (const label of labels.results) {
      if (label.prefix !== "team") continue;
      if (categories.length >= maxCategories) {
        issues.push(`category results exceeded max_categories (${maxCategories})`);
        break;
      }
      categories.push({ name: label.name, prefix: label.prefix });
    }
    const next = labels?._links?.next;
    if (issues.length > 0) break;
    if (!next) {
      complete = true;
      break;
    }
    if (categories.length >= maxCategories) {
      issues.push(`category results reached max_categories (${maxCategories})`);
      break;
    }
    const safePath = continuationPath(client.config.baseUrl, spacePath, next);
    if (!safePath) {
      issues.push("server continuation points outside the expected space-category resource");
      break;
    }
    if (seen.has(safePath)) {
      issues.push("server repeated a category continuation");
      break;
    }
    seen.add(safePath);
    path = safePath;
  }

  if (!complete && issues.length === 0) issues.push("category pagination reached its safety limit");
  return { returned: categories.length, pages, complete, truncated: !complete, issues, categories };
}

export const confluenceSpaceCategoryTools: ToolDef[] = [
  {
    name: "confluence_get_space_categories",
    product: "confluence",
    description: "Read team-prefixed categories attached to a Confluence space, with explicit paging completeness.",
    inputShape: {
      space_key: z.string(),
      max_categories: z.coerce.number().int().min(1).max(MAX_CATEGORIES).optional()
        .describe(`Maximum team categories to return (default ${MAX_CATEGORIES})`),
    },
    async handler({ client }, args) {
      return {
        space: args.space_key,
        ...(await readSpaceCategories(client("confluence"), args.space_key, args.max_categories ?? MAX_CATEGORIES)),
      };
    },
  },
  {
    name: "confluence_add_space_category",
    product: "confluence",
    write: true,
    description: "Add a team-prefixed category to a space without replacing existing categories.",
    inputShape: { space_key: z.string(), name: spaceCategoryNameSchema, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const request = {
        method: "POST",
        path: `${API}/space/${seg(args.space_key)}/category/${seg(args.name)}`,
        summary: `Add category ${args.name} to space ${args.space_key}`,
      } as const;
      const before = await readSpaceCategories(c, args.space_key);
      if (before.categories.some((category) => category.name === args.name)) {
        return alreadySatisfied(request.summary, "the space already has this category", { space: args.space_key, category: args.name });
      }
      if (args.dry_run !== false) {
        const dry = await guardedWrite(c, args, request);
        // the execution refuses an incomplete read; the dry run says so instead of failing
        return before.complete ? dry : { ...dry, warning: `existing categories could not be read completely (${before.issues.join("; ")}); the change will be refused until they can` };
      }
      if (!before.complete) throw new ValidationError("Cannot safely add a category when existing categories cannot be read completely");
      const result = await guardedWrite(c, args, request);
      const after = await readSpaceCategories(c, args.space_key);
      const preserved = before.categories.every((category) =>
        after.categories.some((current) => current.name === category.name && current.prefix === category.prefix),
      );
      const present = after.categories.some((category) => category.name === args.name);
      if (!after.complete || !present || !preserved) {
        throw new VerificationError(
          "Category request completed but read-back could not verify the addition and preserve existing categories",
          { complete: after.complete, categoryPresent: present, previousCategoriesPreserved: preserved },
        );
      }
      return { ...result, verification: { complete: true, categoryPresent: present, previousCategoriesPreserved: preserved } };
    },
  },
  {
    name: "confluence_remove_space_category",
    product: "confluence",
    write: true,
    description:
      "Remove a team category from a space, keeping its other categories. A category the space does not have → " +
      "already-satisfied. No removal request is verified for the supported Confluence version yet, so removing a present " +
      "category answers Unsupported and sends nothing; remove it in the space's settings in the UI.",
    inputShape: { space_key: z.string(), name: spaceCategoryNameSchema, ...dryRunShape },
    async handler({ client }, args) {
      const c = client("confluence");
      const summary = `Remove category ${args.name} from space ${args.space_key}`;
      const current = await readSpaceCategories(c, args.space_key);
      if (current.complete && !current.categories.some((category) => category.name === args.name)) {
        return alreadySatisfied(summary, "the space does not have this category");
      }
      // never a substitute: page labels on the homepage are not categories
      throw new UnsupportedError(
        `${summary}: no category removal request is verified for this Confluence version; remove it in the space's settings (Space tools → Overview → Edit space details)`,
        { space: args.space_key, category: args.name, categoriesReadComplete: current.complete },
      );
    },
  },
];
