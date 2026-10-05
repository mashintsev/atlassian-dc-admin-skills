/** Regenerates the tool catalogue in atlassian-dc-admin/REFERENCE.md from the registry. */

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { argsSchema } from "../src/runner.js";
import { ALL_TOOLS, TOOL_GROUPS } from "../src/tools/index.js";
import type { ToolDef } from "../src/tools/types.js";

const FILE = "atlassian-dc-admin/REFERENCE.md";
const START = "<!-- tools:start -->";
const END = "<!-- tools:end -->";

/** Readable JSON-schema type: enum values, a union as "a|b", arrays as "list". */
function schemaType(p: any, sep: string): string {
  if (p?.enum) return p.enum.join(sep);
  if (p?.anyOf) return [...new Set(p.anyOf.map((x: any) => schemaType(x, sep)))].join(sep);
  if (p?.type === "array") return "list";
  return p?.type ?? "any";
}

function argsLine(tool: ToolDef): string {
  const schema: any = z.toJSONSchema(argsSchema(tool), { io: "input", unrepresentable: "any" });
  const required = new Set<string>(schema.required ?? []);
  return Object.entries<any>(schema.properties ?? {})
    .filter(([name]) => name !== "dry_run")
    .map(([name, p]) => {
      const type = schemaType(p, "\\|");
      return required.has(name) ? `\`${name}\`: ${type}` : `\`${name}?\`: ${type}`;
    })
    .join(", ");
}

const sections = TOOL_GROUPS.map(([title, tools]) => {
  const rows = tools.map(
    (t) => `| \`${t.name}\`${t.write ? " ✎" : ""} | ${argsLine(t) || "—"} | ${t.description.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
  );
  return `### ${title}\n\n| Tool | Arguments | Description |\n|---|---|---|\n${rows.join("\n")}`;
});

const writes = ALL_TOOLS.filter((t) => t.write).length;
const body = [
  START,
  `${ALL_TOOLS.length} tools, ${writes} of them write tools (✎). Write tools also take \`dry_run\` (default true).`,
  "",
  ...sections.flatMap((s) => [s, ""]),
  END,
].join("\n");

const current = readFileSync(FILE, "utf8");
const next = current.replace(new RegExp(`${START}[\\s\\S]*${END}`), body);
writeFileSync(FILE, next);
console.log(`REFERENCE.md: ${ALL_TOOLS.length} tools`);
