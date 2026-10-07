/** Regenerates the tool catalogue in atlassian-dc-admin/REFERENCE.md from the registry. */

import { readFileSync, writeFileSync } from "node:fs";
import { ALL_TOOLS, TOOL_GROUPS } from "../src/tools/index.js";
import type { ToolDef } from "../src/tools/types.js";

const FILE = "atlassian-dc-admin/REFERENCE.md";
const START = "<!-- tools:start -->";
const END = "<!-- tools:end -->";

// one line of names per group: arguments and descriptions come from `describe <tool>`, never duplicated here
const sections = TOOL_GROUPS.map(([title, tools]) => `### ${title}\n\n${tools.map((t: ToolDef) => `\`${t.name}\`${t.write ? " ✎" : ""}`).join(", ")}`);

const writes = ALL_TOOLS.filter((t) => t.write).length;
const body = [
  START,
  `${ALL_TOOLS.length} tools, ${writes} of them write tools (✎; they also take \`dry_run\`, default true). ` +
    "Arguments and descriptions: run `describe <tool>`; search by concept with `list <text>`.",
  "",
  ...sections.flatMap((s) => [s, ""]),
  END,
].join("\n");

const current = readFileSync(FILE, "utf8");
const next = current.replace(new RegExp(`${START}[\\s\\S]*${END}`), body);
writeFileSync(FILE, next);
console.log(`REFERENCE.md: ${ALL_TOOLS.length} tools`);
