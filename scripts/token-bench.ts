/**
 * Token benchmark: MCP-shaped responses (fixtures captured by eunsanMountain/atlassian-skills from
 * mcp-atlassian on a DC instance) vs this CLI's generic `--format=json` and `compact` output.
 * Tokenizer: cl100k_base, the same approximation used in their docs/mcp-analysis.md.
 *
 *   npx tsx scripts/token-bench.ts
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { render } from "../src/format.js";

const enc = getEncoding("cl100k_base");
const tokens = (s: string) => enc.encode(s).length;
const dir = "test/fixtures/mcp";

const rows: string[][] = [];
let sumMcp = 0;
let sumJson = 0;
let sumCompact = 0;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const raw = readFileSync(join(dir, file), "utf8");
  const data = JSON.parse(raw);
  const mcp = tokens(JSON.stringify(data, null, 2)); // MCP servers return indented JSON
  const json = tokens(render(data, "json"));
  const compact = tokens(render(data, "compact"));
  sumMcp += mcp;
  sumJson += json;
  sumCompact += compact;
  rows.push([file.replace(".json", ""), String(mcp), String(json), String(compact), `${Math.round((1 - compact / mcp) * 100)}%`]);
}
rows.push(["TOTAL", String(sumMcp), String(sumJson), String(sumCompact), `${Math.round((1 - sumCompact / sumMcp) * 100)}%`]);

const header = ["fixture", "MCP json", "--format=json", "compact", "saved"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
console.log([line(header), ...rows.map(line)].join("\n"));
