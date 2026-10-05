import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { boundedAll } from "./client.js";
import { confirmChanges } from "./confirm.js";
import type { ToolContext } from "./tools/types.js";
import { ValidationError } from "./errors.js";
import { digestOf } from "./plan.js";
import { runToolByName } from "./runner.js";
import { resolveConfluenceGrantUser } from "./tools/confluence/users.js";
import { spaceCategoryNameSchema } from "./tools/confluence/spaceCategories.js";

const spaceSchema = z.object({
  id: z.union([z.string(), z.number()]),
  key: z.string().min(1),
  name: z.string(),
  type: z.enum(["global", "personal"]),
  status: z.enum(["current", "archived"]),
  groupOperations: z.array(z.string()),
  baselineCategories: z.array(z.string()),
  baselineUserOperations: z.array(z.string()),
}).strict();

const itemSchema = z.object({
  n: z.number().int().positive(),
  kind: z.enum(["category", "grant"]),
  tool: z.enum(["confluence_add_space_category", "confluence_grant_space_permissions"]),
  args: z.record(z.string(), z.unknown()),
  summary: z.string(),
  request: z.object({
    method: z.enum(["POST", "PUT"]),
    url: z.string().url(),
    body: z.unknown().optional(),
  }).strict(),
  digest: z.string().regex(/^[a-f0-9]{16}$/),
  plannedAt: z.string().datetime(),
}).strict();

const outcomeItemSchema = z.object({
  n: z.number().int().positive(),
  status: z.enum(["executed", "already-satisfied", "failed", "drifted", "unselected", "unattempted", "verification-failed"]),
  detail: z.string().optional(),
  mutationStatus: z.enum(["executed", "already-satisfied", "failed", "drifted", "unselected", "unattempted"]).optional(),
}).strict();

const workflowPlanSchema = z.object({
  version: z.literal(2),
  workflow: z.literal("confluence-space-updates"),
  preparedAt: z.string().datetime(),
  target: z.string().url(),
  selector: z.object({
    group: z.string().min(1),
    type: z.enum(["global", "personal"]).nullable(),
    status: z.enum(["current", "archived"]).nullable(),
  }).strict(),
  identity: z.object({
    username: z.string().min(1),
    userKey: z.string().min(1),
  }).strict(),
  desired: z.object({
    category: z.string().min(1),
    userOperations: z.tuple([z.literal("read:space"), z.literal("administer:space")]),
  }).strict(),
  completeness: z.object({
    enumerationComplete: z.boolean(),
    permissionReadsComplete: z.boolean(),
    completeForCaller: z.boolean(),
    siteWideComplete: z.boolean(),
    siteCountCrossCheck: z.object({
      status: z.enum(["matched", "mismatch", "unavailable", "not-applicable-for-filtered-scope"]),
      serverCount: z.number().int().nonnegative().optional(),
      inspectedCount: z.number().int().nonnegative(),
    }).strict(),
    issues: z.array(z.string()),
  }).strict(),
  spaces: z.array(spaceSchema),
  items: z.array(itemSchema),
  previousEvidence: z.object({
    planFile: z.string().min(1),
    outcomeFile: z.string().min(1),
    target: z.string().url(),
    planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string().datetime(),
    items: z.array(outcomeItemSchema),
  }).strict().optional(),
}).strict();

export type SpaceWorkflowPlan = z.infer<typeof workflowPlanSchema>;
type WorkflowItem = SpaceWorkflowPlan["items"][number];
type WorkflowSpace = SpaceWorkflowPlan["spaces"][number];

const workflowOutcomeSchema = z.object({
  version: z.literal(1),
  workflow: z.literal("confluence-space-updates-outcomes"),
  planFile: z.string().min(1),
  target: z.string().url(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  updatedAt: z.string().datetime(),
  items: z.array(outcomeItemSchema),
  verification: z.unknown().optional(),
}).strict();

export type SpaceWorkflowOutcome = z.infer<typeof workflowOutcomeSchema>;

export interface SpaceWorkflowApplyPreview {
  plan: SpaceWorkflowPlan;
  planFile: string;
  statuses: SpaceWorkflowOutcome["items"];
  activeItems: Array<{ item: WorkflowItem; args: Record<string, unknown>; request: WorkflowItem["request"]; digest: string }>;
}

interface SpaceState {
  categories: string[];
  userOperations: string[];
  groupOperations: string[];
}

export interface PrepareSpaceUpdatesInput {
  group: string;
  category: string;
  username?: string;
  email?: string;
  type?: "global" | "personal";
  status?: "current" | "archived";
  previousOutcomes?: string;
}

function safeTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("Configured Confluence target is not a valid URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new ValidationError("Configured Confluence target must use HTTP or HTTPS");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function validateWorkflowPlan(input: unknown): SpaceWorkflowPlan {
  const parsed = workflowPlanSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`Invalid version-2 space workflow plan: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  const plan = parsed.data;
  const target = new URL(plan.target);
  if (target.username || target.password || target.search || target.hash) {
    throw new ValidationError("Workflow plan target must not contain credentials, query parameters, or fragments");
  }
  const basePath = target.pathname.replace(/\/+$/, "");
  if (!spaceCategoryNameSchema.safeParse(plan.desired.category).success) {
    throw new ValidationError("Workflow plan contains an unsupported category name");
  }
  if (!plan.completeness.enumerationComplete || !plan.completeness.permissionReadsComplete ||
      !plan.completeness.completeForCaller || plan.completeness.siteCountCrossCheck.status === "mismatch") {
    throw new ValidationError("Workflow plan is based on incomplete space or permission discovery");
  }
  if (plan.previousEvidence && plan.previousEvidence.target !== plan.target) {
    throw new ValidationError("Previous workflow evidence belongs to a different Confluence target");
  }
  const keySet = new Set<string>();
  const idSet = new Set<string>();
  const itemNumbers = new Set<number>();
  for (const space of plan.spaces) {
    if (keySet.has(space.key) || idSet.has(String(space.id))) {
      throw new ValidationError(`Workflow plan repeats a space identity '${space.key}'`);
    }
    if ((plan.selector.type && space.type !== plan.selector.type) ||
        (plan.selector.status && space.status !== plan.selector.status) ||
        !space.groupOperations.includes("read:space")) {
      throw new ValidationError(`Workflow space '${space.key}' does not satisfy its immutable selector`);
    }
    keySet.add(space.key);
    idSet.add(String(space.id));
  }
  const itemKindsBySpace = new Map<string, Set<string>>();
  for (const item of plan.items) {
    if (itemNumbers.has(item.n)) throw new ValidationError(`Workflow plan repeats item number ${item.n}`);
    itemNumbers.add(item.n);
    if (item.n !== itemNumbers.size) throw new ValidationError("Workflow plan item numbers must be sequential");
    const spaceKey = item.args.space_key;
    if (typeof spaceKey !== "string" || !keySet.has(spaceKey)) {
      throw new ValidationError(`Workflow item ${item.n} is outside the immutable space selection`);
    }
    const kinds = itemKindsBySpace.get(spaceKey) ?? new Set<string>();
    if (kinds.has(item.kind)) throw new ValidationError(`Workflow repeats ${item.kind} work for space '${spaceKey}'`);
    kinds.add(item.kind);
    itemKindsBySpace.set(spaceKey, kinds);
    const requestUrl = new URL(item.request.url);
    if (requestUrl.origin !== target.origin || requestUrl.username || requestUrl.password || requestUrl.search || requestUrl.hash ||
        !requestUrl.pathname.startsWith(`${basePath}/rest/api/space/`)) {
      throw new ValidationError(`Workflow item ${item.n} targets a different Confluence instance or resource`);
    }
    if (item.kind === "category") {
      if (Object.keys(item.args).sort().join(",") !== "name,space_key") {
        throw new ValidationError(`Workflow category item ${item.n} contains unsupported arguments`);
      }
      if (item.tool !== "confluence_add_space_category" || item.args.name !== plan.desired.category ||
          item.request.method !== "POST" || item.request.body !== undefined) {
        throw new ValidationError(`Workflow category item ${item.n} is not an allowed additive request`);
      }
      const expectedPath = `${basePath}/rest/api/space/${encodeURIComponent(spaceKey)}/category/${encodeURIComponent(plan.desired.category)}`;
      if (requestUrl.pathname !== expectedPath) throw new ValidationError(`Workflow category item ${item.n} has an unexpected request path`);
    } else {
      const operations = item.args.operations;
      if (Object.keys(item.args).sort().join(",") !== "operations,space_key,subject,subject_type") {
        throw new ValidationError(`Workflow grant item ${item.n} contains unsupported arguments`);
      }
      if (item.tool !== "confluence_grant_space_permissions" || item.request.method !== "PUT" ||
          item.args.subject_type !== "user" || item.args.subject !== plan.identity.userKey ||
          !Array.isArray(operations) || operations.length === 0 ||
          operations.some((operation) => !plan.desired.userOperations.includes(String(operation) as any)) ||
          !Array.isArray(item.request.body)) {
        throw new ValidationError(`Workflow grant item ${item.n} is not an allowed direct user grant`);
      }
      const expectedPath = `${basePath}/rest/api/space/${encodeURIComponent(spaceKey)}/permissions/user/${encodeURIComponent(plan.identity.userKey)}/grant`;
      if (requestUrl.pathname !== expectedPath) throw new ValidationError(`Workflow grant item ${item.n} has an unexpected request path`);
      const bodyOperations = (item.request.body as any[]).map((operation) =>
        `${operation?.operationKey}:${operation?.targetType}`,
      );
      if ((item.request.body as any[]).some((operation) =>
        !operation || typeof operation !== "object" ||
        Object.keys(operation).sort().join(",") !== "operationKey,targetType",
      ) || bodyOperations.length !== operations.length ||
          bodyOperations.some((operation) => !operations.includes(operation)) ||
          operations.some((operation) => !bodyOperations.includes(String(operation)))) {
        throw new ValidationError(`Workflow grant item ${item.n} body does not match its approved operations`);
      }
    }
    if (digestOf({ request: item.request }) !== item.digest) {
      throw new ValidationError(`Workflow item ${item.n} request fingerprint is invalid`);
    }
  }
  for (const space of plan.spaces) {
    const kinds = itemKindsBySpace.get(space.key) ?? new Set<string>();
    const categoryMissing = !space.baselineCategories.includes(plan.desired.category);
    const grantMissing = plan.desired.userOperations.filter((operation) => !space.baselineUserOperations.includes(operation));
    if (kinds.has("category") !== categoryMissing || kinds.has("grant") !== (grantMissing.length > 0)) {
      throw new ValidationError(`Workflow items for '${space.key}' do not match the reconciled desired state`);
    }
    const grant = plan.items.find((item) => item.kind === "grant" && item.args.space_key === space.key);
    if (grant && JSON.stringify(grant.args.operations) !== JSON.stringify(grantMissing)) {
      throw new ValidationError(`Workflow grant operations for '${space.key}' differ from the reconciled delta`);
    }
  }
  return plan;
}

export function readSpaceWorkflowPlan(file: string): SpaceWorkflowPlan {
  const data = JSON.parse(readFileSync(resolve(file), "utf8"));
  return validateWorkflowPlan(data);
}

export function writeSpaceWorkflowPlan(file: string, input: unknown): SpaceWorkflowPlan {
  const path = resolve(file);
  const plan = validateWorkflowPlan(input);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify(plan, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (created) {
      try { unlinkSync(path); } catch {}
    }
    throw error;
  }
  return plan;
}

export function renderSpaceWorkflowPlan(planInput: unknown, file: string): string {
  const plan = validateWorkflowPlan(planInput);
  const countCategories = plan.items.filter((item) => item.kind === "category").length;
  const countGrants = plan.items.filter((item) => item.kind === "grant").length;
  const lines = [
    `space workflow plan ${file}`,
    `target: ${plan.target}`,
    `group: ${plan.selector.group}`,
    `scope: type=${plan.selector.type ?? "all"} status=${plan.selector.status ?? "all"}`,
    `user: ${plan.identity.username} (${plan.identity.userKey})`,
    `category: ${plan.desired.category}`,
    `spaces: ${plan.spaces.length} | discovery complete: ${plan.completeness.completeForCaller} | site-wide: ${plan.completeness.siteWideComplete}`,
    `items: ${plan.items.length} total | ${countCategories} categories | ${countGrants} permission grants`,
  ];
  for (const item of plan.items) {
    const body = item.request.body === undefined ? "" : ` body=${JSON.stringify(item.request.body)}`;
    lines.push(`${item.n}. ${item.summary} | ${item.request.method} ${item.request.url}${body}`);
  }
  return lines.join("\n");
}

function requireToolValue<T>(result: any, label: string): T {
  if (result?.ok) return result.value as T;
  throw new ValidationError(`${label}: ${result?.error?.message ?? "unknown read failure"}`);
}

async function readUserOperations(ctx: ToolContext, spaceKey: string, userKey: string, username: string): Promise<string[]> {
  const client = ctx.client("confluence");
  const data = await client.get(`/rest/api/space/${encodeURIComponent(spaceKey)}/permissions/user/${encodeURIComponent(userKey)}`);
  const records = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(records)) throw new ValidationError(`User permission read for '${spaceKey}' returned an unknown response shape`);
  const operations: string[] = [];
  for (const permission of records) {
    const subject = permission?.subject;
    const subjectType = subject?.type ?? (subject?.userKey || subject?.username ? "user" : undefined);
    const subjectKey = subject?.userKey ?? subject?.username ?? subject?.name;
    const op = permission?.operation?.operationKey ?? permission?.operation?.key;
    const target = permission?.operation?.targetType;
    if (subjectType !== "user" || (subjectKey !== userKey && subjectKey !== username) ||
        typeof op !== "string" || typeof target !== "string") {
      throw new ValidationError(`User permission read for '${spaceKey}' returned an unknown permission record`);
    }
    operations.push(`${op}:${target}`);
  }
  return [...new Set(operations)].sort();
}

async function readCategories(ctx: ToolContext, spaceKey: string): Promise<string[]> {
  const result = await runToolByName("confluence_get_space_categories", { space_key: spaceKey }, ctx);
  const value = requireToolValue<any>(result, `Could not read categories for '${spaceKey}'`);
  if (value.complete !== true) {
    throw new ValidationError(`Category read for '${spaceKey}' is incomplete: ${(value.issues ?? []).join("; ")}`);
  }
  return value.categories.map((category: any) => category.name);
}

async function addItem(
  items: WorkflowItem[],
  kind: WorkflowItem["kind"],
  tool: WorkflowItem["tool"],
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<void> {
  const result = await runToolByName(tool, { ...args, dry_run: true }, ctx);
  const dry = requireToolValue<any>(result, `Could not prepare ${kind} request`);
  if (dry.dry_run !== true || !dry.request?.url || !dry.request?.method) {
    throw new ValidationError(`The ${tool} tool did not return a dry-run request`);
  }
  const item: WorkflowItem = {
    n: items.length + 1,
    kind,
    tool,
    args,
    summary: dry.summary,
    request: {
      method: dry.request.method,
      url: dry.request.url,
      ...(dry.request.body !== undefined ? { body: dry.request.body } : {}),
    },
    digest: digestOf(dry),
    plannedAt: new Date().toISOString(),
  };
  items.push(item);
}

export async function prepareSpaceUpdates(
  ctx: ToolContext,
  input: PrepareSpaceUpdatesInput,
  outputFile: string,
): Promise<{ plan: SpaceWorkflowPlan; summary: Record<string, unknown> }> {
  if (!input.group || !input.category || (!!input.username === !!input.email)) {
    throw new ValidationError("Preparation requires group, category, and exactly one of username or email");
  }
  if (existsSync(resolve(outputFile))) throw new ValidationError(`Refusing to overwrite existing plan file '${resolve(outputFile)}'`);
  const discoveryResult = await runToolByName("confluence_find_spaces_by_group", {
    group: input.group, type: input.type, status: input.status,
  }, ctx);
  const discovery = requireToolValue<any>(discoveryResult, "Group-space discovery failed");
  if (discovery.completeForCaller !== true) {
    throw new ValidationError(`Group-space discovery is incomplete; no update plan was written: ${(discovery.issues ?? []).join("; ")}`);
  }

  const client = ctx.client("confluence");
  const identity = await resolveConfluenceGrantUser(client, {
    ...(input.username ? { username: input.username } : {}),
    ...(input.email ? { email: input.email } : {}),
  });
  let previousEvidence: SpaceWorkflowPlan["previousEvidence"];
  if (input.previousOutcomes) {
    const outcomeFile = resolve(input.previousOutcomes);
    const parsedOutcome = workflowOutcomeSchema.safeParse(JSON.parse(readFileSync(outcomeFile, "utf8")));
    if (!parsedOutcome.success) throw new ValidationError("Previous workflow outcome file is malformed");
    const previous = parsedOutcome.data;
    const previousPlanFile = resolve(previous.planFile);
    if (outcomeFile !== outcomePath(previousPlanFile)) {
      throw new ValidationError("Previous outcome file does not match its recorded immutable plan path");
    }
    const previousPlan = readSpaceWorkflowPlan(previousPlanFile);
    const verifiedPrevious = readWorkflowOutcome(previousPlanFile, previousPlan);
    if (!verifiedPrevious || previous.target !== safeTarget(client.config.baseUrl)) {
      throw new ValidationError("Previous workflow outcome does not match this Confluence target or its original plan");
    }
    if (previousPlan.selector.group !== input.group ||
        previousPlan.selector.type !== (input.type ?? null) ||
        previousPlan.selector.status !== (input.status ?? null) ||
        previousPlan.desired.category !== input.category ||
        previousPlan.identity.username !== identity.username ||
        previousPlan.identity.userKey !== identity.userKey) {
      throw new ValidationError("Previous workflow evidence does not match the requested group, scope, category, or user");
    }
    previousEvidence = {
      planFile: previousPlanFile,
      outcomeFile,
      target: verifiedPrevious.target,
      planDigest: verifiedPrevious.planDigest,
      updatedAt: verifiedPrevious.updatedAt,
      items: verifiedPrevious.items,
    };
  }
  const selected: any[] = discovery.matches;
  const spaces: WorkflowSpace[] = [];
  const items: WorkflowItem[] = [];

  for (const discovered of selected) {
    const [categories, userOperations] = await Promise.all([
      readCategories(ctx, discovered.key),
      readUserOperations(ctx, discovered.key, identity.userKey, identity.username),
    ]);
    const groupOperations = [...discovered.groupOperations].sort();
    const baselineCategories = [...new Set(categories)].sort();
    const baselineUserOperations = [...new Set(userOperations)].sort();
    spaces.push({
      id: discovered.id,
      key: discovered.key,
      name: discovered.name,
      type: discovered.type,
      status: discovered.status,
      groupOperations,
      baselineCategories,
      baselineUserOperations,
    });
    if (!baselineCategories.includes(input.category)) {
      await addItem(items, "category", "confluence_add_space_category", {
        space_key: discovered.key,
        name: input.category,
      }, ctx);
    }
    const missingOperations = (["read:space", "administer:space"] as const)
      .filter((operation) => !baselineUserOperations.includes(operation));
    if (missingOperations.length) {
      await addItem(items, "grant", "confluence_grant_space_permissions", {
        space_key: discovered.key,
        subject_type: "user",
        subject: identity.userKey,
        operations: missingOperations,
      }, ctx);
    }
  }

  const plan = validateWorkflowPlan({
    version: 2,
    workflow: "confluence-space-updates",
    preparedAt: new Date().toISOString(),
    target: safeTarget(client.config.baseUrl),
    selector: { group: input.group, type: input.type ?? null, status: input.status ?? null },
    identity: { username: identity.username, userKey: identity.userKey },
    desired: { category: input.category, userOperations: ["read:space", "administer:space"] },
    completeness: {
      enumerationComplete: discovery.enumerationComplete,
      permissionReadsComplete: discovery.permissionReadsComplete,
      completeForCaller: discovery.completeForCaller,
      siteWideComplete: discovery.siteWideComplete,
      siteCountCrossCheck: discovery.siteCountCrossCheck,
      issues: discovery.issues,
    },
    spaces,
    items,
    ...(previousEvidence ? { previousEvidence } : {}),
  });
  writeSpaceWorkflowPlan(outputFile, plan);
  return {
    plan,
    summary: {
      file: resolve(outputFile),
      target: plan.target,
      group: plan.selector.group,
      identity: plan.identity,
      inspected: discovery.inspected,
      selected: spaces.length,
      categoryItems: items.filter((item) => item.kind === "category").length,
      permissionItems: items.filter((item) => item.kind === "grant").length,
      totalItems: items.length,
      siteCountCrossCheck: plan.completeness.siteCountCrossCheck,
      completeForCaller: plan.completeness.completeForCaller,
      siteWideComplete: plan.completeness.siteWideComplete,
      previousOutcomeFile: plan.previousEvidence?.outcomeFile ?? null,
    },
  };
}

function workflowPlanDigest(plan: SpaceWorkflowPlan): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function outcomePath(planFile: string): string {
  return `${resolve(planFile)}.outcomes.json`;
}

function verificationPath(planFile: string): string {
  return `${resolve(planFile)}.verification.json`;
}

function readWorkflowOutcome(planFile: string, plan: SpaceWorkflowPlan): SpaceWorkflowOutcome | undefined {
  const path = outcomePath(planFile);
  if (!existsSync(path)) return undefined;
  const parsed = workflowOutcomeSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new ValidationError(`Invalid workflow outcome file '${path}'`);
  const outcome = parsed.data;
  if (outcome.planDigest !== workflowPlanDigest(plan) || outcome.target !== plan.target) {
    throw new ValidationError("Workflow outcome file does not match this immutable plan");
  }
  if (resolve(outcome.planFile) !== resolve(planFile)) {
    throw new ValidationError("Workflow outcome file references a different plan path");
  }
  const numbers = outcome.items.map((item) => item.n).sort((a, b) => a - b);
  if (numbers.length !== plan.items.length || numbers.some((number, index) => number !== index + 1)) {
    throw new ValidationError("Workflow outcome file does not account for every plan item");
  }
  return outcome;
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

function writeWorkflowOutcome(
  planFile: string,
  plan: SpaceWorkflowPlan,
  items: SpaceWorkflowOutcome["items"],
  verification?: unknown,
): SpaceWorkflowOutcome {
  const value: SpaceWorkflowOutcome = {
    version: 1,
    workflow: "confluence-space-updates-outcomes",
    planFile: resolve(planFile),
    target: plan.target,
    planDigest: workflowPlanDigest(plan),
    updatedAt: new Date().toISOString(),
    items: [...items].sort((a, b) => a.n - b.n),
    ...(verification !== undefined ? { verification } : {}),
  };
  const validated = workflowOutcomeSchema.parse(value);
  atomicWriteJson(outcomePath(planFile), validated);
  return validated;
}

async function readGroupOperations(ctx: ToolContext, spaceKey: string, group: string): Promise<string[]> {
  const data = await ctx.client("confluence").get(
    `/rest/api/space/${encodeURIComponent(spaceKey)}/permissions/group/${encodeURIComponent(group)}`,
  );
  const records = Array.isArray(data) ? data : data?.results;
  if (!Array.isArray(records)) throw new ValidationError(`Group permission read for '${spaceKey}' returned an unknown response shape`);
  const operations: string[] = [];
  for (const permission of records) {
    const subject = permission?.subject;
    const subjectType = subject?.type ?? (subject?.name ? "group" : undefined);
    const subjectName = subject?.name ?? subject?.group;
    const operationKey = permission?.operation?.operationKey ?? permission?.operation?.key;
    const targetType = permission?.operation?.targetType;
    if (subjectType !== "group" || subjectName !== group ||
        typeof operationKey !== "string" || typeof targetType !== "string") {
      throw new ValidationError(`Group permission read for '${spaceKey}' returned an unknown permission record`);
    }
    operations.push(`${operationKey}:${targetType}`);
  }
  return [...new Set(operations)].sort();
}

async function readSpaceState(ctx: ToolContext, space: WorkflowSpace, plan: SpaceWorkflowPlan): Promise<SpaceState> {
  const [categories, userOperations, groupOperations] = await Promise.all([
    readCategories(ctx, space.key),
    readUserOperations(ctx, space.key, plan.identity.userKey, plan.identity.username),
    readGroupOperations(ctx, space.key, plan.selector.group),
  ]);
  return {
    categories: [...new Set(categories)].sort(),
    userOperations: [...new Set(userOperations)].sort(),
    groupOperations: [...new Set(groupOperations)].sort(),
  };
}

function spaceByKey(plan: SpaceWorkflowPlan, key: string): WorkflowSpace {
  const space = plan.spaces.find((candidate) => candidate.key === key);
  if (!space) throw new ValidationError(`Workflow item refers to space '${key}' outside the plan`);
  return space;
}

function preserved(space: WorkflowSpace, state: SpaceState): boolean {
  return space.baselineCategories.every((category) => state.categories.includes(category)) &&
    space.baselineUserOperations.every((operation) => state.userOperations.includes(operation));
}

function outcomeItem(
  n: number,
  status: SpaceWorkflowOutcome["items"][number]["status"],
  detail?: string,
): SpaceWorkflowOutcome["items"][number] {
  return { n, status, ...(detail ? { detail } : {}) };
}

export async function prepareSpaceWorkflowApply(
  ctx: ToolContext,
  plan: SpaceWorkflowPlan,
  planFile: string,
  only?: number[],
): Promise<SpaceWorkflowApplyPreview> {
  if (safeTarget(ctx.client("confluence").config.baseUrl) !== plan.target) {
    throw new ValidationError("Configured Confluence target differs from the prepared workflow plan");
  }
  if (existsSync(outcomePath(planFile))) {
    throw new ValidationError("This workflow plan already has execution outcomes; prepare a fresh plan to retry safely");
  }
  const identity = await resolveConfluenceGrantUser(ctx.client("confluence"), { username: plan.identity.username });
  if (identity.userKey !== plan.identity.userKey) {
    throw new ValidationError("Resolved active user key differs from the immutable workflow plan");
  }

  const allowed = only?.length ? new Set(only) : new Set(plan.items.map((item) => item.n));
  const candidates = plan.items.filter((item) => allowed.has(item.n));
  const spacesToRead = [...new Set(candidates.map((item) => String(item.args.space_key)))];
  const states = new Map<string, { state?: SpaceState; error?: string }>();
  const readRows = await boundedAll(spacesToRead.map((key) => async () => {
    const space = spaceByKey(plan, key);
    try {
      return { key, state: await readSpaceState(ctx, space, plan) };
    } catch (error) {
      return { key, error: String((error as Error)?.message ?? error) };
    }
  }), 4);
  for (const row of readRows) states.set(row.key, row);

  const statuses: SpaceWorkflowOutcome["items"] = plan.items.map((item) =>
    outcomeItem(item.n, allowed.has(item.n) ? "unattempted" : "unselected"),
  );
  const activeItems: SpaceWorkflowApplyPreview["activeItems"] = [];
  for (const item of candidates) {
    const key = String(item.args.space_key);
    const current = states.get(key);
    if (!current?.state) {
      statuses[item.n - 1] = outcomeItem(item.n, "drifted", current?.error ?? "preflight state is unavailable");
      continue;
    }
    const space = spaceByKey(plan, key);
    const state = current.state;
    if (!state.groupOperations.includes("read:space")) {
      statuses[item.n - 1] = outcomeItem(item.n, "drifted", "the selected group no longer has direct read:space");
      continue;
    }
    if (!preserved(space, state)) {
      statuses[item.n - 1] = outcomeItem(item.n, "drifted", "recorded baseline categories or direct user permissions are no longer present");
      continue;
    }

    let args: Record<string, unknown> = { ...item.args };
    if (item.kind === "category") {
      if (state.categories.includes(plan.desired.category)) {
        statuses[item.n - 1] = outcomeItem(item.n, "already-satisfied");
        continue;
      }
    } else {
      const approvedOperations = item.args.operations as string[];
      const missingOperations = approvedOperations.filter((operation) => !state.userOperations.includes(operation));
      if (missingOperations.length === 0) {
        statuses[item.n - 1] = outcomeItem(item.n, "already-satisfied");
        continue;
      }
      args = { ...args, operations: missingOperations };
    }
    const dryResult = await runToolByName(item.tool, { ...args, dry_run: true }, ctx);
    if (!dryResult.ok) {
      statuses[item.n - 1] = outcomeItem(item.n, "drifted", dryResult.error.message);
      continue;
    }
    const dry: any = dryResult.value;
    activeItems.push({
      item,
      args,
      request: {
        method: dry.request.method,
        url: dry.request.url,
        ...(dry.request.body !== undefined ? { body: dry.request.body } : {}),
      },
      digest: digestOf(dry),
    });
  }
  return { plan, planFile: resolve(planFile), statuses, activeItems };
}

export function workflowConfirmationItems(preview: SpaceWorkflowApplyPreview) {
  return preview.activeItems.map(({ item, request }) => ({
    n: item.n,
    summary: item.summary,
    detail: `${request.method} ${request.url}${request.body === undefined ? "" : ` body=${JSON.stringify(request.body)}`}`,
  }));
}

export async function applySpaceWorkflowWithConfirmation(
  ctx: ToolContext,
  preview: SpaceWorkflowApplyPreview,
  confirm: typeof confirmChanges = confirmChanges,
) {
  const selected = confirm(workflowConfirmationItems(preview), "Confluence space workflow — confirm updates");
  return applySpaceWorkflow(ctx, preview, selected);
}

export async function verifySpaceWorkflow(
  ctx: ToolContext,
  plan: SpaceWorkflowPlan,
  planFile: string,
): Promise<Record<string, any>> {
  if (safeTarget(ctx.client("confluence").config.baseUrl) !== plan.target) {
    throw new ValidationError("Configured Confluence target differs from the prepared workflow plan");
  }
  let identityError: string | undefined;
  try {
    const identity = await resolveConfluenceGrantUser(ctx.client("confluence"), { username: plan.identity.username });
    if (identity.userKey !== plan.identity.userKey) {
      identityError = "Resolved active user key differs from the immutable workflow plan";
    }
  } catch (error) {
    identityError = String((error as Error)?.message ?? error);
  }
  const rows = identityError ? plan.spaces.map((space) => ({
    spaceKey: space.key,
    categoriesPresent: false,
    operationsPresent: false,
    baselineCategoriesPreserved: false,
    baselineUserPermissionsPreserved: false,
    groupAccessPresent: false,
    verified: false,
    error: identityError,
  })) : await boundedAll(plan.spaces.map((space) => async () => {
    try {
      const state = await readSpaceState(ctx, space, plan);
      const categoriesPresent = state.categories.includes(plan.desired.category);
      const operationsPresent = plan.desired.userOperations.every((operation) => state.userOperations.includes(operation));
      const baselineCategoriesPreserved = space.baselineCategories.every((category) => state.categories.includes(category));
      const baselineUserPermissionsPreserved = space.baselineUserOperations.every((operation) => state.userOperations.includes(operation));
      const groupAccessPresent = state.groupOperations.includes("read:space");
      return {
        spaceKey: space.key,
        categoriesPresent,
        operationsPresent,
        baselineCategoriesPreserved,
        baselineUserPermissionsPreserved,
        groupAccessPresent,
        verified: categoriesPresent && operationsPresent && baselineCategoriesPreserved &&
          baselineUserPermissionsPreserved && groupAccessPresent,
      };
    } catch (error) {
      return {
        spaceKey: space.key,
        categoriesPresent: false,
        operationsPresent: false,
        baselineCategoriesPreserved: false,
        baselineUserPermissionsPreserved: false,
        groupAccessPresent: false,
        verified: false,
        error: String((error as Error)?.message ?? error),
      };
    }
  }), 4);

  const outcome = readWorkflowOutcome(planFile, plan);
  const incompleteOutcome = outcome?.items.some((item) =>
    ["failed", "drifted", "unselected", "unattempted"].includes(item.status),
  ) ?? false;
  const verified = !identityError && rows.every((row) => row.verified) && !incompleteOutcome;
  const verifiedCount = rows.filter((row) => row.verified).length;
  const itemStatuses = outcome?.items ?? plan.items.map((item) => outcomeItem(item.n, "unattempted", "not applied"));
  const counts = {
    executed: itemStatuses.filter((item) => item.status === "executed").length,
    alreadySatisfied: itemStatuses.filter((item) => item.status === "already-satisfied").length,
    failed: itemStatuses.filter((item) => item.status === "failed").length,
    drifted: itemStatuses.filter((item) => item.status === "drifted").length,
    unselected: itemStatuses.filter((item) => item.status === "unselected").length,
    unattempted: itemStatuses.filter((item) => item.status === "unattempted").length,
    verificationFailed: itemStatuses.filter((item) => item.status === "verification-failed").length,
  };
  return {
    target: plan.target,
    identityVerified: !identityError,
    ...(identityError ? { identityError } : {}),
    checkedSpaces: rows.length,
    verifiedSpaces: verifiedCount,
    overallVerified: verified,
    itemCounts: counts,
    spaces: rows,
  };
}

export function saveSpaceWorkflowVerification(planFile: string, verification: unknown): void {
  atomicWriteJson(verificationPath(planFile), verification);
}

export async function applySpaceWorkflow(
  ctx: ToolContext,
  preview: SpaceWorkflowApplyPreview,
  selected: number[],
): Promise<{ outcome: SpaceWorkflowOutcome; verification: Record<string, any>; summary: Record<string, number | boolean> }> {
  const { plan, planFile } = preview;
  const lockPath = `${planFile}.lock`;
  let lockFd: number | undefined;
  let lockCreated = false;
  try {
    lockFd = openSync(lockPath, "wx", 0o600);
    lockCreated = true;
    closeSync(lockFd);
    lockFd = undefined;
    if (existsSync(outcomePath(planFile))) {
      throw new ValidationError("This workflow plan already has execution outcomes; prepare a fresh plan to retry safely");
    }

    const approved = new Set(selected);
    const activeByNumber = new Map(preview.activeItems.map((active) => [active.item.n, active]));
    const statuses = preview.statuses.map((item) => ({ ...item }));
    for (const active of preview.activeItems) {
      if (!approved.has(active.item.n)) statuses[active.item.n - 1] = outcomeItem(active.item.n, "unselected");
      else statuses[active.item.n - 1] = outcomeItem(active.item.n, "unattempted");
    }
    writeWorkflowOutcome(planFile, plan, statuses);

    for (const number of [...approved].sort((a, b) => a - b)) {
      const active = activeByNumber.get(number);
      if (!active) continue;
      const item = active.item;
      const space = spaceByKey(plan, String(item.args.space_key));
      try {
        const identity = await resolveConfluenceGrantUser(ctx.client("confluence"), { username: plan.identity.username });
        if (identity.userKey !== plan.identity.userKey) {
          statuses[number - 1] = outcomeItem(number, "drifted", "active user key changed after confirmation");
          writeWorkflowOutcome(planFile, plan, statuses);
          continue;
        }
      } catch (error) {
        statuses[number - 1] = outcomeItem(number, "drifted", `active user could not be revalidated: ${String((error as Error)?.message ?? error)}`);
        writeWorkflowOutcome(planFile, plan, statuses);
        continue;
      }
      let state: SpaceState;
      try {
        state = await readSpaceState(ctx, space, plan);
      } catch (error) {
        statuses[number - 1] = outcomeItem(number, "drifted", `pre-mutation state recheck failed: ${String((error as Error)?.message ?? error)}`);
        writeWorkflowOutcome(planFile, plan, statuses);
        continue;
      }
      if (!state.groupOperations.includes("read:space") || !preserved(space, state)) {
        statuses[number - 1] = outcomeItem(number, "drifted", "group access or recorded baseline changed after confirmation");
        writeWorkflowOutcome(planFile, plan, statuses);
        continue;
      }
      if (item.kind === "category" && state.categories.includes(plan.desired.category)) {
        statuses[number - 1] = outcomeItem(number, "already-satisfied");
        writeWorkflowOutcome(planFile, plan, statuses);
        continue;
      }
      if (item.kind === "grant") {
        const approvedOperations = active.args.operations as string[];
        const missingOperations = approvedOperations.filter((operation) => !state.userOperations.includes(operation));
        if (missingOperations.length === 0) {
          statuses[number - 1] = outcomeItem(number, "already-satisfied");
          writeWorkflowOutcome(planFile, plan, statuses);
          continue;
        }
        if (missingOperations.length !== approvedOperations.length) {
          statuses[number - 1] = outcomeItem(number, "drifted", "the approved grant operations changed after confirmation");
          writeWorkflowOutcome(planFile, plan, statuses);
          continue;
        }
      }
      const dryResult = await runToolByName(item.tool, { ...active.args, dry_run: true }, ctx);
      if (!dryResult.ok || digestOf(dryResult.value) !== active.digest) {
        statuses[number - 1] = outcomeItem(number, "drifted", dryResult.ok ? "request changed after confirmation" : dryResult.error.message);
        writeWorkflowOutcome(planFile, plan, statuses);
        continue;
      }
      const writeResult = await runToolByName(item.tool, { ...active.args, dry_run: false }, ctx);
      if (!writeResult.ok) {
        statuses[number - 1] = outcomeItem(number, "failed", writeResult.error.message);
        writeWorkflowOutcome(planFile, plan, statuses);
        break;
      }
      statuses[number - 1] = outcomeItem(number, "executed");
      writeWorkflowOutcome(planFile, plan, statuses);
    }

    writeWorkflowOutcome(planFile, plan, statuses);
    let verification: Record<string, any>;
    try {
      verification = await verifySpaceWorkflow(ctx, plan, planFile);
    } catch (error) {
      verification = {
        target: plan.target,
        identityVerified: false,
        checkedSpaces: plan.spaces.length,
        verifiedSpaces: 0,
        overallVerified: false,
        itemCounts: {},
        spaces: plan.spaces.map((space) => ({
          spaceKey: space.key,
          verified: false,
          error: String((error as Error)?.message ?? error),
        })),
      };
    }
    const verificationByKey = new Map(verification.spaces.map((space: any) => [space.spaceKey, space]));
    for (const item of plan.items) {
      const current = statuses[item.n - 1];
      if (current.status !== "executed" && current.status !== "already-satisfied") continue;
      const space = verificationByKey.get(String(item.args.space_key)) as any;
      const passes = space && space.groupAccessPresent &&
        (item.kind === "category"
          ? space.categoriesPresent && space.baselineCategoriesPreserved
          : space.operationsPresent && space.baselineUserPermissionsPreserved);
      if (!passes) {
        statuses[item.n - 1] = {
          ...outcomeItem(item.n, "verification-failed", space?.error ?? "post-apply state did not satisfy the plan"),
          mutationStatus: current.status as "executed" | "already-satisfied",
        };
      }
    }
    const outcome = writeWorkflowOutcome(planFile, plan, statuses, verification);
    const summary = {
      executed: statuses.filter((item) => item.status === "executed").length,
      alreadySatisfied: statuses.filter((item) => item.status === "already-satisfied").length,
      failed: statuses.filter((item) => item.status === "failed").length,
      drifted: statuses.filter((item) => item.status === "drifted").length,
      unselected: statuses.filter((item) => item.status === "unselected").length,
      unattempted: statuses.filter((item) => item.status === "unattempted").length,
      verificationFailed: statuses.filter((item) => item.status === "verification-failed").length,
      overallVerified: verification.overallVerified,
    };
    return { outcome, verification, summary };
  } finally {
    if (lockFd !== undefined) closeSync(lockFd);
    if (lockCreated) {
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

export function renderSpaceWorkflowOutcomes(result: {
  outcome: SpaceWorkflowOutcome;
  verification: Record<string, any>;
  summary: Record<string, number | boolean>;
}): string {
  const summary = result.summary;
  return [
    `space workflow outcomes | executed:${summary.executed} satisfied:${summary.alreadySatisfied} failed:${summary.failed} drifted:${summary.drifted}`,
    `unselected:${summary.unselected} unattempted:${summary.unattempted} verification-failed:${summary.verificationFailed}`,
    `verified:${summary.overallVerified} spaces:${result.verification.verifiedSpaces}/${result.verification.checkedSpaces}`,
    ...result.outcome.items.map((item) => `${item.n}. ${item.status.toUpperCase()}${item.detail ? ` | ${item.detail}` : ""}`),
  ].join("\n");
}
