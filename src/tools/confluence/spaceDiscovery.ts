import { boundedAll, seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { z } from "zod";

const API = "/rest/api";
const PAGE_SIZE = 100;
const MAX_SPACES = 2000;
const MAX_PAGES_PER_SCOPE = Math.ceil(MAX_SPACES / PAGE_SIZE);

interface SpaceRecord {
  id: string | number;
  key: string;
  name: string;
  type: "global" | "personal";
  status: "current" | "archived";
  groupOperations: string[];
  selected: boolean;
  error?: string;
}

function sameResourcePath(client: AtlassianClient, path: string, next: unknown): string | undefined {
  if (typeof next !== "string" || !next) return undefined;
  const base = new URL(client.config.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(next, `${client.config.baseUrl}${path}`);
  if (url.origin !== base.origin || url.username || url.password) return undefined;
  const expected = `${basePath}${path}`;
  if (url.pathname !== expected && url.pathname !== path) return undefined;
  return `${path}${url.search}`;
}

function recordsFromPermissionResponse(data: any): any[] | undefined {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.results)) return data.results;
  return undefined;
}

function groupPermissionOperations(data: any, exactGroup: string): { operations?: string[]; issue?: string } {
  const records = recordsFromPermissionResponse(data);
  if (!records) return { issue: "permission endpoint returned an unknown response shape" };
  const operations: string[] = [];
  for (const permission of records) {
    const subject = permission?.subject;
    const subjectType = subject?.type ?? (subject?.name ? "group" : undefined);
    const subjectName = subject?.name ?? subject?.group;
    const operationKey = permission?.operation?.operationKey ?? permission?.operation?.key;
    const targetType = permission?.operation?.targetType;
    if (subjectType !== "group" || typeof subjectName !== "string" ||
        typeof operationKey !== "string" || typeof targetType !== "string") {
      return { issue: "permission endpoint returned a malformed permission record" };
    }
    if (subjectName !== exactGroup) return { issue: `permission endpoint returned a non-exact group subject '${subjectName}'` };
    operations.push(`${operationKey}:${targetType}`);
  }
  return { operations: [...new Set(operations)].sort() };
}

async function exactGroupExists(client: AtlassianClient, group: string): Promise<void> {
  let data: any;
  try {
    data = await client.get(`${API}/group`, { groupname: group, limit: 2 });
  } catch (error) {
    throw new ValidationError(`Could not verify Confluence group '${group}': ${String((error as Error)?.message ?? error)}`);
  }
  const results = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(results) || (Number.isFinite(data?.totalSize) && data.totalSize > results.length)) {
    throw new ValidationError("Confluence group lookup returned an unknown or incomplete response");
  }
  const exact = results.filter((item: any) => item?.name === group);
  if (exact.length !== 1) {
    throw new ValidationError(exact.length ? `Confluence group '${group}' is ambiguous` : `Confluence group '${group}' does not exist`);
  }
}

async function enumerateScope(
  client: AtlassianClient,
  type: "global" | "personal",
  status: "current" | "archived",
  maxSpaces: number,
): Promise<{ spaces: any[]; count: number | null; issues: string[] }> {
  const path = `${API}/space`;
  const spaces: any[] = [];
  const issues: string[] = [];
  const visited = new Set<string>();
  let cursor: string | undefined;
  let count: number | null = null;
  for (let page = 0; page < MAX_PAGES_PER_SCOPE && spaces.length < maxSpaces; page++) {
    let data: any;
    try {
      data = await client.get(cursor ?? path, cursor ? undefined : { type, status, start: 0, limit: PAGE_SIZE });
    } catch (error) {
      issues.push(`${type}/${status} space listing failed: ${String((error as Error)?.message ?? error)}`);
      break;
    }
    if (!Array.isArray(data?.results) || !data?._links || typeof data._links !== "object" || Array.isArray(data._links)) {
      issues.push(`${type}/${status} space listing returned an unknown response shape`);
      break;
    }
    if (page === 0) {
      count = Number.isFinite(data.totalSize) ? data.totalSize : null;
    } else if (Number.isFinite(data.totalSize) && count !== data.totalSize) {
      issues.push(`${type}/${status} reported inconsistent total sizes across pages`);
      break;
    }
    const remaining = maxSpaces - spaces.length;
    spaces.push(...data.results.slice(0, remaining));
    if (data.results.length > remaining) {
      issues.push(`${type}/${status} space listing exceeded its safety limit`);
      break;
    }
    const next = data?._links?.next;
    if (!next) {
      if (count !== null && spaces.length !== count) {
        issues.push(`${type}/${status} space listing ended at ${spaces.length} of ${count} reported spaces`);
      }
      return { spaces, count, issues };
    }
    const safePath = sameResourcePath(client, path, next);
    if (!safePath) {
      issues.push(`${type}/${status} continuation points outside the space-list resource`);
      break;
    }
    const nextUrl = new URL(safePath, `${client.config.baseUrl}${path}`);
    const nextType = nextUrl.searchParams.get("type");
    const nextStatus = nextUrl.searchParams.get("status");
    if (nextType !== type || nextStatus !== status) {
      issues.push(`${type}/${status} continuation changed the requested scope`);
      break;
    }
    if (visited.has(safePath)) {
      issues.push(`${type}/${status} space listing repeated a continuation`);
      break;
    }
    visited.add(safePath);
    cursor = safePath;
  }
  if (issues.length === 0) issues.push(`${type}/${status} space listing reached its safety limit`);
  return { spaces, count, issues };
}

function compactSpace(space: any): Omit<SpaceRecord, "groupOperations" | "selected" | "error"> | undefined {
  const id = space?.id;
  const key = space?.key;
  const type = space?.type;
  const status = space?.status;
  if ((typeof id !== "string" && typeof id !== "number") || typeof key !== "string" ||
      typeof space?.name !== "string" || (type !== "global" && type !== "personal") ||
      (status !== "current" && status !== "archived")) return undefined;
  return { id, key, name: space.name, type, status };
}

export const confluenceSpaceDiscoveryTools: ToolDef[] = [
  {
    name: "confluence_find_spaces_by_group",
    product: "confluence",
    description: "Audit spaces for exact direct group permissions; only explicit read:space grants are selected.",
    inputShape: {
      group: z.string().min(1),
      type: z.enum(["global", "personal"]).optional(),
      status: z.enum(["current", "archived"]).optional(),
      max_spaces: z.coerce.number().int().min(1).max(MAX_SPACES).optional()
        .describe(`Maximum spaces to inspect (default ${MAX_SPACES})`),
    },
    async handler({ client }, args) {
      const c = client("confluence");
      const maxSpaces = args.max_spaces ?? MAX_SPACES;
      await exactGroupExists(c, args.group);
      const types = args.type ? [args.type] : ["global", "personal"] as const;
      const statuses = args.status ? [args.status] : ["current", "archived"] as const;
      const scopeResults = [];
      let enumeratedCount = 0;
      for (const type of types) {
        for (const status of statuses) {
          const remaining = maxSpaces - enumeratedCount;
          if (remaining <= 0) {
            scopeResults.push({ spaces: [], count: null, issues: ["space enumeration reached its site-wide safety limit"] });
            continue;
          }
          const result = await enumerateScope(c, type, status, remaining);
          scopeResults.push(result);
          enumeratedCount += result.spaces.length;
        }
      }

      const issues = scopeResults.flatMap((scope) => scope.issues);
      const spaceMap = new Map<string, Omit<SpaceRecord, "groupOperations" | "selected" | "error">>();
      for (const scope of scopeResults) {
        for (const raw of scope.spaces) {
          const space = compactSpace(raw);
          if (!space) {
            issues.push("space listing contained a malformed space record");
            continue;
          }
          const key = String(space.id);
          const previous = spaceMap.get(key);
          if (previous && (previous.key !== space.key || previous.type !== space.type || previous.status !== space.status)) {
            issues.push(`space identity '${key}' changed across listing scopes`);
          } else {
            spaceMap.set(key, space);
          }
        }
      }
      const spaces = [...spaceMap.values()];
      if (enumeratedCount >= maxSpaces) issues.push("space enumeration reached the max_spaces limit");

      const permissionRows = await boundedAll<SpaceRecord>(spaces.map((space) => async () => {
        try {
          const data = await c.get(`${API}/space/${seg(space.key)}/permissions/group/${seg(args.group)}`);
          const parsed = groupPermissionOperations(data, args.group);
          return parsed.issue
            ? { ...space, groupOperations: [], selected: false, error: parsed.issue }
            : { ...space, groupOperations: parsed.operations!, selected: parsed.operations!.includes("read:space") };
        } catch (error) {
          return {
            ...space,
            groupOperations: [],
            selected: false,
            error: isHttpStatusError(error)
              ? `HTTP ${error.status} permission read is unknown`
              : String((error as Error)?.message ?? error),
          };
        }
      }), 4);
      const unknownReads = permissionRows.filter((space) => space.error).map((space) => ({
        spaceKey: space.key,
        error: space.error,
      }));
      if (unknownReads.length) issues.push(`${unknownReads.length} permission read(s) were unknown`);

      const filters = { type: args.type ?? null, status: args.status ?? null };
      let siteCountCrossCheck: { status: string; serverCount?: number; inspectedCount: number } = {
        status: "not-applicable-for-filtered-scope",
        inspectedCount: spaces.length,
      };
      if (!args.type && !args.status) {
        const counts = scopeResults.map((scope) => scope.count);
        if (counts.every((count) => count !== null)) {
          const serverCount = counts.reduce((sum, count) => sum + (count ?? 0), 0);
          siteCountCrossCheck = {
            status: serverCount === spaces.length ? "matched" : "mismatch",
            serverCount,
            inspectedCount: spaces.length,
          };
          if (serverCount !== spaces.length) issues.push(`site count mismatch: server reports ${serverCount}, inspected ${spaces.length}`);
        } else {
          siteCountCrossCheck = { status: "unavailable", inspectedCount: spaces.length };
        }
      }

      const enumerationComplete = scopeResults.every((scope) => scope.issues.length === 0) && enumeratedCount < maxSpaces;
      const permissionReadsComplete = unknownReads.length === 0;
      const countMismatch = siteCountCrossCheck.status === "mismatch";
      const completeForCaller = enumerationComplete && permissionReadsComplete && !countMismatch && issues.length === 0;
      const audit = permissionRows.sort((a, b) => a.key.localeCompare(b.key));
      const matches = audit.filter((space) => space.selected);
      return {
        group: args.group,
        filters,
        inspected: audit.length,
        selected: matches.length,
        enumerationComplete,
        permissionReadsComplete,
        completeForCaller,
        siteWideComplete: completeForCaller && siteCountCrossCheck.status === "matched",
        siteCountCrossCheck,
        issues,
        unknownReads,
        matches,
        audit,
      };
    },
  },
];
