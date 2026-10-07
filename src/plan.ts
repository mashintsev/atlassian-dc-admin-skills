/**
 * Change plans: collect several dry-run writes in a file, show them, then apply them in one
 * command, so the user can approve all changes at once (one confirmation) instead of each one.
 *
 *   <tool> ... --plan=changes.json      dry run + append the change to the plan
 *   plan changes.json                   numbered list of planned changes
 *   apply changes.json [--only=1,3]     execute them (dry_run=false), item by item
 *
 * Before executing an item, apply repeats its dry run and compares the request with the one
 * that was planned (and approved). If the instance changed in between (other page version,
 * other resolved ids...), the item is skipped as `drifted` instead of sending something else.
 * A dry run may carry `identity` (the request with names in place of ids that only exist
 * after an earlier item ran) and `state` (the target state the change was computed from);
 * the comparison then uses them. An item whose target state already holds is recorded as
 * `already-satisfied`. Outcomes are written back into the plan file, so `plan` shows what
 * is left and a later `apply` runs only the remaining items.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runToolByName, type RunResult } from "./runner.js";
import type { ToolContext } from "./tools/types.js";
import { EXIT } from "./format.js";

export type OutcomeStatus = "done" | "already-satisfied" | "failed" | "drifted" | "declined";

/** An object an item created, so later items of the plan can refer to it by name. */
export interface CreatedObject {
  type: string;
  name: string;
  id: string;
}

export interface ItemOutcome {
  status: OutcomeStatus;
  at: string;
  detail?: string;
  created?: CreatedObject;
}

export interface PlanItem {
  n: number;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  request: { method?: string; url?: string; body?: unknown };
  /** Fingerprint of the dry-run request (method, url, body, follow-up steps). */
  digest: string;
  plannedAt: string;
  /** Last recorded outcome of `apply` (absent until the item was applied or declined). */
  outcome?: ItemOutcome;
}

export interface Plan {
  version: 1;
  items: PlanItem[];
}

export function digestOf(dry: any): string {
  // identity/state only take part when a tool provides them, so older plans keep their digests
  const material = JSON.stringify({
    // identity describes the whole operation, follow-up steps included
    request: dry?.identity ?? dry?.request,
    followUps: dry?.identity !== undefined ? null : (dry?.followUps ?? null),
    objects: dry?.objects ?? null,
    ...(dry?.state !== undefined ? { state: dry.state } : {}),
  });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Write the plan through a temporary file, so a crash or a concurrent reader never sees half a plan. */
function writePlan(file: string, plan: Plan): void {
  const path = resolve(file);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2));
  renameSync(tmp, path);
}

export function readPlan(file: string): Plan {
  const path = resolve(file);
  if (!existsSync(path)) return { version: 1, items: [] };
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data || data.version !== 1 || !Array.isArray(data.items)) {
    throw new Error(`${file} is not a version-1 change plan`);
  }
  return data as Plan;
}

export function addToPlan(file: string, tool: string, args: Record<string, unknown>, dry: any): PlanItem {
  const plan = readPlan(file);
  const { dry_run: _ignored, ...rest } = args;
  const item: PlanItem = {
    n: (plan.items.at(-1)?.n ?? 0) + 1,
    tool,
    args: rest,
    summary: dry.summary,
    request: { method: dry.request?.method, url: dry.request?.url, body: dry.request?.body },
    digest: digestOf(dry),
    plannedAt: new Date().toISOString(),
  };
  plan.items.push(item);
  writePlan(file, plan);
  return item;
}

const FINISHED: ReadonlySet<OutcomeStatus> = new Set(["done", "already-satisfied"]);

export function isFinished(item: PlanItem): boolean {
  return !!item.outcome && FINISHED.has(item.outcome.status);
}

/**
 * Add a tool's dry-run result to the plan. A batch (several independent changes from one call)
 * becomes one item per change; already-satisfied results and entries are not planned.
 */
export function addResultToPlan(file: string, tool: string, args: Record<string, unknown>, value: any): PlanItem[] {
  if (value?.already_satisfied) return [];
  if (Array.isArray(value?.batch)) {
    return value.batch.filter((b: any) => !b.value?.already_satisfied).map((b: any) => addToPlan(file, b.tool, b.args, b.value));
  }
  return [addToPlan(file, tool, args, value)];
}

export function renderPlan(plan: Plan, file: string): string {
  if (plan.items.length === 0) return `plan ${file}: empty`;
  const remaining = plan.items.filter((i) => !isFinished(i)).length;
  const lines = [`plan ${file}: ${plan.items.length} change(s), remaining ${remaining}. Approve each, or all at once with: apply ${file}`];
  for (const it of plan.items) {
    const mark = it.outcome ? `[${it.outcome.status}] ` : "";
    const detail = it.outcome?.detail && !FINISHED.has(it.outcome.status) ? ` | ${it.outcome.detail}` : "";
    lines.push(`${it.n}. ${mark}${it.summary} | ${it.request.method} ${it.request.url}${detail}`);
  }
  return lines.join("\n");
}

function saveOutcome(file: string | undefined, n: number, outcome: ItemOutcome): void {
  if (!file) return;
  // re-read so outcomes of other items written meanwhile are kept
  const plan = readPlan(file);
  const item = plan.items.find((i) => i.n === n);
  if (!item) return;
  item.outcome = outcome;
  writePlan(file, plan);
}

/** Record the items the user unticked in the confirmation checklist. */
export function recordDeclined(file: string, numbers: number[]): void {
  const at = new Date().toISOString();
  for (const n of numbers) saveOutcome(file, n, { status: "declined", at });
}

export interface ApplyOutcome {
  n: number;
  summary: string;
  /** `skipped`: finished in an earlier apply, not run again. */
  status: OutcomeStatus | "skipped";
  detail?: string;
  /** For a drifted item: the dry-run call that plans it again. */
  replan?: string;
  created?: CreatedObject;
}

function createdObject(v: any): CreatedObject | undefined {
  return v && typeof v.type === "string" && typeof v.name === "string" && v.id !== undefined && v.id !== null
    ? { type: v.type, name: v.name, id: String(v.id) }
    : undefined;
}

/** Objects created by earlier, applied items of a plan, newest first (for name resolution). */
export function createdInPlan(plan: Plan, type: string): CreatedObject[] {
  return plan.items.map((i) => i.outcome?.created).filter((c): c is CreatedObject => !!c && c.type === type).reverse();
}

/** `tool key=value … --plan=<file>`, shell-quoted, without dry_run. */
export function replanCommand(tool: string, args: Record<string, unknown>): string {
  const quote = (v: string) => (/^[\w.,:@\/-]+$/.test(v) ? v : `'${v.replace(/'/g, "'\\''")}'`);
  const parts = Object.entries(args)
    .filter(([k]) => k !== "dry_run")
    .map(([k, v]) => `${k}=${quote(typeof v === "string" ? v : JSON.stringify(v))}`);
  return [tool, ...parts, "--plan=<file>"].join(" ");
}

type Runner = (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<RunResult>;

/** Items `apply` would run: the selection (or all), minus items finished earlier. */
export function pendingItems(plan: Plan, only?: number[]): PlanItem[] {
  return plan.items.filter((i) => (!only?.length || only.includes(i.n)) && !isFinished(i));
}

/**
 * Execute plan items in order. With `file`, each outcome is saved into the plan as soon as
 * it is known, and items finished in an earlier apply are skipped.
 */
export async function applyPlan(ctx: ToolContext, plan: Plan, only?: number[], file?: string, run: Runner = runToolByName): Promise<ApplyOutcome[]> {
  const out: ApplyOutcome[] = [];
  // later items may refer by name to objects earlier items created (in this apply or an earlier one)
  const createdNow: CreatedObject[] = [];
  const runCtx: ToolContext = {
    ...ctx,
    created: (type) => [...createdNow.filter((c) => c.type === type).reverse(), ...createdInPlan(plan, type)],
  };
  for (const it of plan.items.filter((i) => !only?.length || only.includes(i.n))) {
    if (isFinished(it)) {
      out.push({ n: it.n, summary: it.summary, status: "skipped", detail: `${it.outcome!.status} earlier` });
      continue;
    }
    const outcome = await applyItem(runCtx, it, run);
    if (outcome.created) createdNow.push(outcome.created);
    saveOutcome(file, it.n, {
      status: outcome.status as OutcomeStatus,
      at: new Date().toISOString(),
      detail: outcome.detail,
      ...(outcome.created ? { created: outcome.created } : {}),
    });
    out.push(outcome);
  }
  return out;
}

async function applyItem(ctx: ToolContext, it: PlanItem, run: Runner): Promise<ApplyOutcome> {
  const base = { n: it.n, summary: it.summary };
  const again = await run(it.tool, { ...it.args, dry_run: true }, ctx);
  if (!again.ok) return { ...base, status: "failed", detail: again.error.message };
  if ((again.value as any)?.already_satisfied) return { ...base, status: "already-satisfied", detail: (again.value as any).reason };
  if (digestOf(again.value) !== it.digest) {
    return { ...base, status: "drifted", detail: "the request differs from the approved one; re-plan it", replan: replanCommand(it.tool, it.args) };
  }
  const res = await run(it.tool, { ...it.args, dry_run: false }, ctx);
  if (!res.ok) return { ...base, status: "failed", detail: res.error.message };
  const created = createdObject((res.value as any)?.created);
  return { ...base, status: "done", ...(created ? { created } : {}) };
}

export function renderOutcomes(outcomes: ApplyOutcome[]): string {
  const run = outcomes.filter((o) => o.status !== "skipped");
  const done = run.filter((o) => o.status === "done" || o.status === "already-satisfied").length;
  const skipped = outcomes.length - run.length;
  const lines = [`applied ${done}/${run.length}${skipped ? ` (${skipped} finished earlier, skipped)` : ""}`];
  for (const o of outcomes) {
    lines.push(`${o.n}. ${o.status.toUpperCase()} | ${o.summary}${o.detail ? ` | ${o.detail}` : ""}`);
    if (o.replan) lines.push(`   re-plan: ${o.replan}`);
  }
  if (outcomes.some((o) => o.status === "drifted")) {
    lines.push("drifted: the target changed after approval; re-run the dry run of those items with --plan=<new file>, review, then apply it");
  }
  return lines.join("\n");
}

/** `apply` exit code: failures win, then drift (stale, 5); done, already-satisfied and skipped items are success. */
export function applyExitCode(outcomes: ApplyOutcome[]): number {
  if (outcomes.some((o) => o.status === "failed")) return EXIT.GENERIC;
  if (outcomes.some((o) => o.status === "drifted")) return EXIT.STALE;
  return EXIT.OK;
}
