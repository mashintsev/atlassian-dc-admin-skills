/**
 * Command-line entry point used by the skill.
 *
 *   atlassian-admin list [jira|confluence|both|<substring>] [--writes|--reads] [--long]
 *   atlassian-admin describe <tool>
 *   atlassian-admin check [--ping]
 *   atlassian-admin <tool> [key=value ...] ['{"json":"args"}'] [--format=compact|json|full] [--fields=a,b|-c] [--out=FILE]
 *   atlassian-admin <write tool> ... --plan=FILE      dry run and add the change to a plan
 *   atlassian-admin plan FILE                        list planned changes
 *   atlassian-admin apply FILE [--only=1,3]          execute planned changes (one approval for all)
 *
 * Global options start with `--`; everything else is a tool argument. key=value values are
 * parsed as JSON when possible (numbers, true/false, arrays), otherwise taken as strings.
 *
 * Output is compact text by default (see format.ts). `--out=FILE` writes the full JSON result
 * to FILE and prints a one-line summary, keeping big payloads out of the agent's context.
 * Every executed change (dry_run=false, apply) is confirmed by the user interactively first
 * (see confirm.ts): one change → Apply/Cancel, a plan → a checklist of all changes.
 * Exit codes: 0 ok, 1 error, 2 not found, 3 permission, 4 conflict, 5 stale, 6 auth, 7 validation/usage,
 * 10 network, 11 rate limited, 12 declined by the user, 13 no way to ask the user.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { checkAvailableServices, findProjectConfig, loadDotenv, PROJECT_CONFIG_FILE, productSource, PRODUCTS } from "./config.js";
import { EXIT, exitCodeFor, largestParts, OUTPUT_FORMATS, render, renderError, type OutputFormat } from "./format.js";
import { exceedsResponseLimit, maxResponseChars } from "./json.js";
import { ConfirmationError, confirmChanges } from "./confirm.js";
import { addResultToPlan, applyExitCode, applyPlan, pendingItems, readPlan, recordDeclined, renderOutcomes, renderPlan } from "./plan.js";
import {
  applySpaceWorkflowWithConfirmation,
  prepareSpaceUpdates,
  prepareSpaceWorkflowApply,
  readSpaceWorkflowPlan,
  renderSpaceWorkflowOutcomes,
  renderSpaceWorkflowPlan,
  saveSpaceWorkflowVerification,
  verifySpaceWorkflow,
} from "./spaceWorkflow.js";
import { argsSchema, coerceArgs, createContext, runToolByName, suggest, type RunResult } from "./runner.js";
import { ALL_TOOLS, findTool } from "./tools/index.js";
import { spaceCategoryNameSchema } from "./tools/confluence/spaceCategories.js";

const USAGE = `Usage:
  atlassian-admin list [jira|confluence|both|<text>] [--writes|--reads] [--long]
  atlassian-admin describe <tool>
  atlassian-admin check [--ping]
  atlassian-admin init [--jira-url=URL] [--confluence-url=URL]   per-project config in the git root
  atlassian-admin <tool> [key=value ...] [--format=compact|json|full] [--fields=a,b|-c] [--out=FILE]
  atlassian-admin <write tool> [key=value ...] --plan=FILE
  atlassian-admin plan FILE
  atlassian-admin apply FILE [--only=1,3]
  atlassian-admin prepare-space-updates group=GROUP category=NAME username=USER|email=EMAIL --plan=FILE [type=global|personal] [status=current|archived] [previous_outcomes=FILE]
  atlassian-admin verify FILE
Write tools only describe the request unless called with dry_run=false (or applied from a plan).
Every dry_run=false call and every apply needs the user's interactive confirmation.`;

export interface GlobalOptions {
  format: OutputFormat;
  fields?: string;
  out?: string;
  plan?: string;
  only?: number[];
  flags: Set<string>;
}

const GLOBAL_KEYS = new Set(["format", "fields", "out", "plan", "only"]);

/** Split argv into global options (`--format=`, `--fields=`, `--out=`, bare `--flag`) and tool args. */
export function parseArgs(argv: string[]): { args: Record<string, unknown>; options: GlobalOptions } {
  const args: Record<string, unknown> = {};
  const options: GlobalOptions = { format: "compact", flags: new Set() };
  for (const token of argv) {
    if (token.trim().startsWith("{")) {
      Object.assign(args, JSON.parse(token));
      continue;
    }
    if (token.startsWith("--") && !token.includes("=")) {
      options.flags.add(token.slice(2));
      continue;
    }
    const idx = token.indexOf("=");
    if (idx <= 0) throw new Error(`Expected key=value, --option=value or a JSON object, got '${token}'`);
    const rawKey = token.slice(0, idx);
    const raw = token.slice(idx + 1);
    const key = rawKey.replace(/^--/, "").replace(/-/g, "_");
    if (rawKey.startsWith("--") && GLOBAL_KEYS.has(key)) {
      if (key === "format") {
        if (!OUTPUT_FORMATS.includes(raw as OutputFormat)) throw new Error(`--format must be one of ${OUTPUT_FORMATS.join(", ")}`);
        options.format = raw as OutputFormat;
      } else if (key === "fields") options.fields = raw;
      else if (key === "plan") options.plan = raw;
      else if (key === "only") options.only = raw.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0);
      else options.out = raw;
      continue;
    }
    // text as given: the runner converts it by the tool's parameter schema (coerceArgs)
    args[key] = raw;
  }
  return { args, options };
}

const PRODUCT_WORDS = ["jira", "confluence", "both"];

/** The description up to its first sentence or colon break, at most 100 characters. */
function firstClause(description: string): string {
  const cut = description.search(/[.:] /);
  const clause = (cut > 0 ? description.slice(0, cut) : description).trim().replace(/\.$/, "");
  return clause.length > 100 ? `${clause.slice(0, 99)}…` : clause;
}

/**
 * `list [product | words…] [--writes|--reads] [--long]`: a product word filters by product; other words must
 * all appear (case-insensitive) in a tool's name (with `_` as a space) or description.
 */
export function listTools(rest: string[]): string {
  const words = rest.filter((a) => !a.startsWith("--")).map((w) => w.toLowerCase());
  const product = words.length === 1 && PRODUCT_WORDS.includes(words[0]!) ? words[0] : undefined;
  const search = product ? [] : words;
  const tools = ALL_TOOLS.filter((t) => {
    if (product) return t.product === product || t.product === "both";
    const text = `${t.name.replace(/_/g, " ")} ${t.name} ${t.description}`.toLowerCase();
    return search.every((w) => text.includes(w));
  })
    .filter((t) => !rest.includes("--writes") || t.write)
    .filter((t) => !rest.includes("--reads") || !t.write);
  if (!tools.length) {
    return `no tool matches '${words.join(" ")}'; try a shorter term, or browse with list jira / list confluence`;
  }
  const lines = tools.map((t) => {
    const name = `${t.name}${t.write ? " ✎" : ""}`;
    if (rest.includes("--long")) return `${name} | ${t.description}`;
    return search.length ? `${name} | ${firstClause(t.description)}` : name;
  });
  return [`${tools.length} tools (✎ = write, dry-run by default). Details: describe <tool>`, ...lines].join("\n");
}

function print(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function countOf(value: any): string {
  if (Array.isArray(value)) return `${value.length} items`;
  if (value && Array.isArray(value.items)) return `${value.items.length} of ${value.total ?? "?"} items`;
  return "1 object";
}

/** Render a tool result, honouring --out and the response-size guard. */
export function output(res: RunResult, options: GlobalOptions): string {
  if (!res.ok) return renderError(res.error, options.format);
  if (options.out) {
    const file = resolve(options.out);
    mkdirSync(dirname(file), { recursive: true });
    const json = JSON.stringify(res.value ?? null, null, 2);
    writeFileSync(file, json);
    return `saved | ${res.tool.name} | ${countOf(res.value)} | ${json.length} chars → ${file}`;
  }
  const narrowing = res.tool?.narrowing;
  const text = render(res.value, options.format, options.fields, res.tool?.defaultFields, narrowing);
  if (exceedsResponseLimit(text)) {
    // sizes of the largest fields or columns, so one retry can narrow the right part; never content
    const largest = largestParts(res.value, options.format, options.fields, res.tool?.defaultFields).map((p) => `${p.part} ${p.chars}`).join(", ");
    return renderError(
      {
        type: "ResponseTooLarge",
        message: `${text.length} characters, limit ${maxResponseChars()}${largest ? `; largest: ${largest}` : ""}`,
        hint: `${narrowing?.length ? `narrow with ${narrowing.join("|")}` : "narrow it (filters, limit/offset, --fields=...)"}, or save it with --out=FILE and grep the file`,
      },
      options.format,
    );
  }
  return text;
}

/** Readable JSON-schema type: enum values, a union as "a|b", arrays as "list". */
function schemaType(p: any, sep: string): string {
  if (p?.enum) return p.enum.join(sep);
  if (p?.anyOf) return [...new Set(p.anyOf.map((x: any) => schemaType(x, sep)))].join(sep);
  if (p?.type === "array") return "list";
  return p?.type ?? "any";
}

export function describeTool(name: string, long: boolean): string | undefined {
  const tool = findTool(name);
  if (!tool) return undefined;
  const schema: any = z.toJSONSchema(argsSchema(tool), { io: "input", unrepresentable: "any" });
  const required = new Set<string>(schema.required ?? []);
  const args = Object.entries<any>(schema.properties ?? {}).map(([k, p]) => {
    const type = schemaType(p, "|");
    const aliases = Object.entries(tool.aliases ?? {}).filter(([, c]) => c === k).map(([a]) => a);
    const alias = aliases.length ? ` (alias: ${aliases.join(", ")})` : "";
    return `  ${k}${required.has(k) ? "" : "?"}: ${type}${alias}${p.description && long ? ` — ${p.description}` : ""}`;
  });
  const unverifiable = tool.unverifiable ? [`not verifiable: ${tool.unverifiable}; repeating the call sends the change again`] : [];
  const columns = tool.defaultFields?.length ? [`default columns: ${tool.defaultFields.join(", ")} (--fields=+x adds, --fields=all shows all)`] : [];
  return [`${tool.name} | ${tool.product}${tool.write ? " | WRITE (dry-run default)" : ""}`, tool.description, ...unverifiable, ...columns, "args:", ...(args.length ? args : ["  (none)"])].join("\n");
}

async function main(argv: string[]): Promise<number> {
  loadDotenv();
  const [command, ...rest] = argv;

  if (!command || ["help", "--help", "-h"].includes(command)) {
    print(USAGE);
    return command ? EXIT.OK : EXIT.VALIDATION;
  }

  if (command === "list") {
    print(listTools(rest));
    return EXIT.OK;
  }

  if (command === "describe") {
    const text = rest[0] ? describeTool(rest[0], true) : undefined;
    if (!text) {
      const guesses = rest[0] ? suggest(rest[0], ALL_TOOLS.map((t) => t.name)) : [];
      print(`ERROR UsageError | Unknown tool: ${rest[0] ?? ""}\nhint: ${guesses.length ? `did you mean ${guesses.join(", ")}? (or run: list <text>)` : "run: list <text>"}`);
      return EXIT.VALIDATION;
    }
    print(text);
    return EXIT.OK;
  }

  if (command === "check") {
    const status = checkAvailableServices();
    const lines: string[] = [];
    for (const p of PRODUCTS) {
      const src = productSource(p);
      const where = src ? (src.path ? `from ${src.path}` : "from the environment") : "";
      const why = status.unavailable_services[p];
      lines.push(why ? `${p}: not configured (${why})${where ? ` ${where}` : ""}` : `${p}: configured ${where}`);
      if (src?.path && gitTracked(src.path)) lines.push(`  WARNING: ${src.path} is not ignored by git — it holds credentials; add it to .gitignore`);
    }
    if (!findProjectConfig()) lines.push(`project config: none (create one with: init) — ${PROJECT_CONFIG_FILE} in the project root overrides ~/.config/atlassian-dc-admin/.env`);
    if (rest.includes("--ping")) {
      const { ctx, close } = createContext();
      for (const product of status.available_services) {
        const res = await runToolByName(`${product}_server_info`, {}, ctx);
        const v: any = res.ok ? res.value : undefined;
        lines.push(
          res.ok
            ? `${product}: OK | ${v?.version ?? v?.versionNumbers?.join(".") ?? ""} | build ${v?.buildNumber ?? ""} | ${v?.baseUrl ?? ""}`
            : `${product}: ${renderError(res.error, "compact")}`,
        );
      }
      await close();
    }
    print(lines.join("\n"));
    return EXIT.OK;
  }

  if (command === "init") {
    const root = gitRoot(process.cwd()) ?? process.cwd();
    const file = `${root}/${PROJECT_CONFIG_FILE}`;
    if (existsSync(file)) {
      print(`exists | ${file} (edit it to change this project's Jira/Confluence)`);
      return EXIT.OK;
    }
    const url = (name: string) => rest.find((a) => a.startsWith(`--${name}-url=`))?.split("=").slice(1).join("=");
    writeFileSync(file, projectTemplate(url("jira"), url("confluence")), { mode: 0o600 });
    const lines = [`created | ${file} (mode 600) — fill in the tokens`];
    const gi = `${root}/.gitignore`;
    const ignored = existsSync(gi) && readFileSync(gi, "utf8").split(/\r?\n/).some((l) => l.trim() === PROJECT_CONFIG_FILE || l.trim() === `/${PROJECT_CONFIG_FILE}`);
    if (!ignored && gitRoot(root)) {
      appendFileSync(gi, `${existsSync(gi) && !readFileSync(gi, "utf8").endsWith("\n") ? "\n" : ""}${PROJECT_CONFIG_FILE}\n`);
      lines.push(`added ${PROJECT_CONFIG_FILE} to ${gi}`);
    }
    print(lines.join("\n"));
    return EXIT.OK;
  }

  if (command === "prepare-space-updates") {
    let parsed: ReturnType<typeof parseArgs>;
    try {
      parsed = parseArgs(rest);
    } catch (e: any) {
      print(renderError({ type: "UsageError", message: e.message }, "compact"));
      return EXIT.VALIDATION;
    }
    const allowed = new Set(["group", "category", "username", "email", "type", "status", "previous_outcomes"]);
    const unknown = Object.keys(parsed.args).filter((key) => !allowed.has(key));
    const { group, category, username, email, type, status, previous_outcomes } = parsed.args;
    const categoryCheck = spaceCategoryNameSchema.safeParse(category);
    if (unknown.length || !parsed.options.plan || parsed.options.out !== undefined ||
        parsed.options.fields !== undefined || parsed.options.only !== undefined || parsed.options.flags.size > 0 ||
        typeof group !== "string" || !group ||
        !categoryCheck.success || (!!username === !!email) ||
        (username !== undefined && (typeof username !== "string" || !username)) ||
        (email !== undefined && (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))) ||
        (type !== undefined && type !== "global" && type !== "personal") ||
        (status !== undefined && status !== "current" && status !== "archived") ||
        (previous_outcomes !== undefined && (typeof previous_outcomes !== "string" || !previous_outcomes))) {
      const details = [
        ...unknown.map((key) => `unknown argument '${key}'`),
        ...(!parsed.options.plan ? ["--plan=FILE is required"] : []),
        ...(parsed.options.out !== undefined ? ["--out is not supported; the plan file holds the complete workflow"] : []),
        ...(parsed.options.fields !== undefined || parsed.options.only !== undefined || parsed.options.flags.size > 0
          ? ["unsupported CLI options for preparation"] : []),
        ...(!group ? ["group is required"] : []),
        ...(!categoryCheck.success ? ["category is required and must satisfy the supported category naming rules"] : []),
        ...(!!username === !!email ? ["provide exactly one of username or email"] : []),
        ...(email !== undefined && (typeof email !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ? ["email must be a valid email address"] : []),
        ...(type !== undefined && type !== "global" && type !== "personal" ? ["type must be global or personal"] : []),
        ...(status !== undefined && status !== "current" && status !== "archived" ? ["status must be current or archived"] : []),
        ...(previous_outcomes !== undefined && (typeof previous_outcomes !== "string" || !previous_outcomes) ? ["previous_outcomes must be a file path"] : []),
      ];
      print(renderError({ type: "UsageError", message: details.join("; ") }, "compact"));
      return EXIT.VALIDATION;
    }
    const { ctx, close } = createContext();
    try {
      const result = await prepareSpaceUpdates(ctx, {
        group: group as string,
        category: category as string,
        ...(username ? { username } : {}),
        ...(email ? { email } : {}),
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(previous_outcomes ? { previousOutcomes: previous_outcomes as string } : {}),
      }, parsed.options.plan);
      if (parsed.options.format === "compact") {
        const summary = result.summary;
        print([
          `prepared space workflow plan ${summary.file}`,
          `target:${summary.target} group:${summary.group} spaces:${summary.selected}/${summary.inspected}`,
          `items:${summary.totalItems} categories:${summary.categoryItems} permission-grants:${summary.permissionItems}`,
          `complete-for-caller:${summary.completeForCaller} site-wide:${summary.siteWideComplete}`,
        ].join("\n"));
      } else {
        print(JSON.stringify(result.summary, null, parsed.options.format === "full" ? 2 : 0));
      }
      return EXIT.OK;
    } catch (e: any) {
      print(renderError({ type: e?.name ?? "Error", message: String(e?.message ?? e) }, parsed.options.format));
      return EXIT.VALIDATION;
    } finally {
      await close();
    }
  }

  if (command === "plan" || command === "apply") {
    const file = rest.find((a) => !a.startsWith("--"));
    if (!file) {
      print(`ERROR UsageError | ${command} needs a plan file\nhint: <write tool> ... --plan=FILE`);
      return EXIT.VALIDATION;
    }
    let plan: ReturnType<typeof readPlan> | undefined;
    let spacePlan: ReturnType<typeof readSpaceWorkflowPlan> | undefined;
    try {
      const filePath = resolve(file);
      if (existsSync(filePath)) {
        const candidate = JSON.parse(readFileSync(filePath, "utf8"));
        if (candidate?.version === 2) spacePlan = readSpaceWorkflowPlan(file);
        else plan = readPlan(file);
      } else {
        plan = readPlan(file);
      }
    } catch (e: any) {
      print(renderError({ type: "UsageError", message: e.message }, "compact"));
      return EXIT.VALIDATION;
    }
    if (command === "plan") {
      print(spacePlan ? renderSpaceWorkflowPlan(spacePlan, file) : renderPlan(plan!, file));
      return EXIT.OK;
    }
    const { options } = parseArgs(rest.filter((a) => a.startsWith("--")));
    const onlyArg = rest.find((argument) => argument.startsWith("--only="));
    if (onlyArg) {
      const raw = onlyArg.slice("--only=".length).split(",");
      const validValues = raw.length > 0 && raw.every((value) => /^[1-9]\d*$/.test(value));
      const planItems = spacePlan?.items ?? plan?.items ?? [];
      const validItems = options.only?.every((number) => planItems.some((item) => item.n === number));
      if (!validValues || !options.only?.length || !validItems) {
        print("ERROR UsageError | --only must be a comma-separated list of item numbers in the plan");
        return EXIT.VALIDATION;
      }
    }
    const { ctx, close } = createContext();
    try {
      if (spacePlan) {
        try {
          const preview = await prepareSpaceWorkflowApply(ctx, spacePlan, file, options.only);
          let result;
          try {
            result = await applySpaceWorkflowWithConfirmation(ctx, preview);
          } catch (error) {
            if (error instanceof ConfirmationError) return printConfirmError(error);
            throw error;
          }
          if (options.format === "compact") {
            print(renderSpaceWorkflowOutcomes(result));
          } else {
            print(JSON.stringify({
              summary: result.summary,
              outcomes: result.outcome.items,
              verification: result.verification,
            }, null, options.format === "full" ? 2 : 0));
          }
          return result.verification.overallVerified ? EXIT.OK : EXIT.GENERIC;
        } catch (error: any) {
          print(renderError({ type: error?.name ?? "Error", message: String(error?.message ?? error) }, options.format));
          return error?.name === "ValidationError" ? EXIT.VALIDATION : EXIT.GENERIC;
        }
      }
      const genericPlan = plan!;
      // items finished in an earlier apply are neither asked for nor run again
      const candidates = pendingItems(genericPlan, options.only);
      if (candidates.length === 0) {
        print(`${renderPlan(genericPlan, file)}\nnothing left to apply`);
        return EXIT.OK;
      }
      let approved: number[];
      try {
        approved = confirmChanges(candidates.map((i) => ({ n: i.n, summary: i.summary, detail: `${i.request.method} ${i.request.url}` })));
      } catch (e) {
        if (e instanceof ConfirmationError && e.name === "ConfirmationDeclined") recordDeclined(file, candidates.map((i) => i.n));
        return printConfirmError(e);
      }
      recordDeclined(file, candidates.filter((i) => !approved.includes(i.n)).map((i) => i.n));
      const outcomes = await applyPlan(ctx, genericPlan, approved, file);
      print(renderOutcomes(outcomes));
      return applyExitCode(outcomes);
    } finally {
      await close();
    }
  }

  if (command === "verify") {
    const file = rest.find((argument) => !argument.startsWith("--"));
    if (!file) {
      print("ERROR UsageError | verify needs a version-2 space workflow plan file");
      return EXIT.VALIDATION;
    }
    const { options } = parseArgs(rest.filter((argument) => argument.startsWith("--")));
    let workflowPlan;
    try {
      workflowPlan = readSpaceWorkflowPlan(file);
    } catch (error: any) {
      print(renderError({ type: "UsageError", message: String(error?.message ?? error) }, options.format));
      return EXIT.VALIDATION;
    }
    const { ctx, close } = createContext();
    try {
      const verification = await verifySpaceWorkflow(ctx, workflowPlan, file);
      saveSpaceWorkflowVerification(file, verification);
      if (options.format === "compact") {
        print([
          `verified:${verification.overallVerified} spaces:${verification.verifiedSpaces}/${verification.checkedSpaces}`,
          `item states: ${Object.entries(verification.itemCounts).map(([key, value]) => `${key}:${value}`).join(" ")}`,
          `verification report: ${resolve(`${file}.verification.json`)}`,
        ].join("\n"));
      } else {
        print(JSON.stringify({ ...verification, reportFile: resolve(`${file}.verification.json`) }, null, options.format === "full" ? 2 : 0));
      }
      return verification.overallVerified ? EXIT.OK : EXIT.GENERIC;
    } catch (error: any) {
      print(renderError({ type: error?.name ?? "Error", message: String(error?.message ?? error) }, options.format));
      return error?.name === "ValidationError" ? EXIT.VALIDATION : EXIT.GENERIC;
    } finally {
      await close();
    }
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(rest);
  } catch (e: any) {
    print(renderError({ type: "UsageError", message: e.message }, "compact"));
    return EXIT.VALIDATION;
  }
  // convert by schema before any check: dry_run=0/no/off must reach the confirmation gate as false
  const known = findTool(command);
  if (known) parsed.args = coerceArgs(known, parsed.args);
  if (parsed.options.plan) {
    const tool = findTool(command);
    if (!tool?.write) {
      print(`ERROR UsageError | --plan is only for write tools; ${command} ${tool ? "is read-only" : "is unknown"}`);
      return EXIT.VALIDATION;
    }
    if (parsed.args.dry_run === false) {
      print("ERROR UsageError | --plan records a dry run; leave out dry_run=false and run apply after approval");
      return EXIT.VALIDATION;
    }
  }
  const { ctx, close } = createContext();
  try {
    const tool = findTool(command);
    if (tool?.write && parsed.args.dry_run === false) {
      // Describe the change first and let the user approve it interactively.
      const dry = await runToolByName(command, { ...parsed.args, dry_run: true }, ctx);
      if (!dry.ok) {
        print(output(dry, parsed.options));
        return dry.exitCode;
      }
      const d: any = dry.value;
      if (d?.already_satisfied) {
        // nothing would be sent: no approval needed
        print(output(dry, parsed.options));
        return EXIT.OK;
      }
      if (Array.isArray(d?.batch)) {
        // several independent changes: one checklist, then each approved change on its own
        let approved: number[];
        try {
          approved = confirmChanges(d.batch.map((b: any, i: number) => ({ n: i + 1, summary: b.value.summary, detail: `${b.value.request?.method} ${b.value.request?.url}` })));
        } catch (e) {
          return printConfirmError(e);
        }
        const lines: string[] = [];
        let failed = false;
        for (const [i, b] of d.batch.entries()) {
          if (!approved.includes(i + 1)) { lines.push(`${i + 1}. DECLINED | ${b.value.summary}`); continue; }
          const r = await runToolByName(b.tool, { ...b.args, dry_run: false }, ctx);
          failed ||= !r.ok;
          lines.push(r.ok ? `${i + 1}. DONE | ${b.value.summary}` : `${i + 1}. FAILED | ${b.value.summary} | ${r.error.message}`);
        }
        for (const note of d.satisfied ?? []) lines.push(`-. ALREADY-SATISFIED | ${note}`);
        print(lines.join("\n"));
        return failed ? EXIT.GENERIC : EXIT.OK;
      }
      // a manual change sends nothing either; the tool reports what to do in the UI
      if (!(d?.manual && d?.request?.method === "MANUAL")) {
        try {
          confirmChanges([{ n: 1, summary: d.summary, detail: `${d.request?.method} ${d.request?.url}` }]);
        } catch (e) {
          return printConfirmError(e);
        }
      }
    }
    const res = await runToolByName(command, parsed.args, ctx);
    if (res.ok && parsed.options.plan && (res.value as any)?.already_satisfied) {
      print(`${output(res, parsed.options)}`);
      process.stderr.write(`not planned in ${parsed.options.plan}: already satisfied\n`);
      return res.exitCode;
    }
    if (res.ok && parsed.options.plan && (res.value as any)?.dry_run === true) {
      const items = addResultToPlan(parsed.options.plan, command, parsed.args, res.value);
      const notice = `planned ${items.map((i) => `#${i.n}`).join(", ")} in ${parsed.options.plan}`;
      const rendered = output(res, parsed.options);
      if (parsed.options.format === "compact" || parsed.options.out) {
        print(`${rendered}\n${notice}`);
      } else {
        print(rendered);
        process.stderr.write(`${notice}\n`);
      }
      return res.exitCode;
    }
    print(output(res, parsed.options));
    return res.exitCode;
  } finally {
    await close();
  }
}

function gitRoot(dir: string): string | undefined {
  const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** True when `file` is inside a git work tree and not ignored. */
function gitTracked(file: string): boolean {
  const dir = file.replace(/\/[^/]*$/, "") || "/";
  if (!gitRoot(dir)) return false;
  return spawnSync("git", ["-C", dir, "check-ignore", "-q", file]).status === 1;
}

function projectTemplate(jiraUrl?: string, confluenceUrl?: string): string {
  return [
    "# atlassian-dc-admin: Jira / Confluence for THIS project (overrides ~/.config/atlassian-dc-admin/.env).",
    "# All JIRA_* settings are read from one file, all CONFLUENCE_* settings from one file — never mixed.",
    "# Keep this file out of git (init added it to .gitignore).",
    "",
    `JIRA_URL=${jiraUrl ?? "https://jira.example.com"}`,
    "JIRA_PAT_TOKEN=",
    "# JIRA_USERNAME=",
    "# JIRA_PASSWORD=",
    "# ASSETS_API_BASE=/rest/insight/1.0",
    "",
    confluenceUrl ? `CONFLUENCE_URL=${confluenceUrl}` : "# CONFLUENCE_URL=https://confluence.example.com",
    confluenceUrl ? "CONFLUENCE_PAT_TOKEN=" : "# CONFLUENCE_PAT_TOKEN=",
    "",
  ].join("\n");
}

function printConfirmError(e: unknown): number {
  if (!(e instanceof ConfirmationError)) throw e;
  const err = {
    type: e.name,
    message: e.message,
    hint:
      e.name === "ConfirmationDeclined"
        ? "nothing was changed; ask the user what to change"
        : "ask the user to run this exact command in their own terminal; do not try to work around the confirmation",
  };
  print(renderError(err, "compact"));
  return exitCodeFor(err);
}

// Run only when executed directly (tests import parseArgs/output).
const invoked = process.argv[1] ?? "";
if (/atlassian-admin(\.mjs)?$|cli\.ts$/.test(invoked)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      print(`ERROR InternalError | ${String(e?.message ?? e)}`);
      process.exit(EXIT.GENERIC);
    },
  );
}
