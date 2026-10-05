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
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runToolByName } from "./runner.js";
import type { ToolContext } from "./tools/types.js";

export interface PlanItem {
  n: number;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  request: { method?: string; url?: string; body?: unknown };
  /** Fingerprint of the dry-run request (method, url, body, follow-up steps). */
  digest: string;
  plannedAt: string;
}

export interface Plan {
  version: 1;
  items: PlanItem[];
}

export function digestOf(dry: any): string {
  const material = JSON.stringify({ request: dry?.request, followUps: dry?.followUps ?? null, objects: dry?.objects ?? null });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
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
  writeFileSync(resolve(file), JSON.stringify(plan, null, 2));
  return item;
}

export function renderPlan(plan: Plan, file: string): string {
  if (plan.items.length === 0) return `plan ${file}: empty`;
  const lines = [`plan ${file}: ${plan.items.length} change(s). Approve each, or all at once with: apply ${file}`];
  for (const it of plan.items) lines.push(`${it.n}. ${it.summary} | ${it.request.method} ${it.request.url}`);
  return lines.join("\n");
}

export interface ApplyOutcome {
  n: number;
  summary: string;
  status: "done" | "failed" | "drifted";
  detail?: string;
}

export async function applyPlan(ctx: ToolContext, plan: Plan, only?: number[]): Promise<ApplyOutcome[]> {
  const out: ApplyOutcome[] = [];
  for (const it of plan.items.filter((i) => !only?.length || only.includes(i.n))) {
    const again = await runToolByName(it.tool, { ...it.args, dry_run: true }, ctx);
    if (!again.ok) {
      out.push({ n: it.n, summary: it.summary, status: "failed", detail: again.error.message });
      continue;
    }
    if (digestOf(again.value) !== it.digest) {
      out.push({ n: it.n, summary: it.summary, status: "drifted", detail: "the request differs from the approved one; re-plan it" });
      continue;
    }
    const res = await runToolByName(it.tool, { ...it.args, dry_run: false }, ctx);
    out.push(
      res.ok
        ? { n: it.n, summary: it.summary, status: "done" }
        : { n: it.n, summary: it.summary, status: "failed", detail: res.error.message },
    );
  }
  return out;
}

export function renderOutcomes(outcomes: ApplyOutcome[]): string {
  const done = outcomes.filter((o) => o.status === "done").length;
  const lines = [`applied ${done}/${outcomes.length}`];
  for (const o of outcomes) lines.push(`${o.n}. ${o.status.toUpperCase()} | ${o.summary}${o.detail ? ` | ${o.detail}` : ""}`);
  return lines.join("\n");
}
