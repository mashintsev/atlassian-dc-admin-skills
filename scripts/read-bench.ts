/**
 * Read-token report: every case of test/bench/cases.ts on realistic Data Center payloads, with raw REST,
 * compact and JSON tokens (cl100k_base), compact characters and whether the response guard would refuse it.
 *
 *   pnpm bench:reads
 */

import { CASES } from "../test/bench/cases.js";
import { measure } from "../test/bench/measure.js";

const rows: string[][] = [];
for (const c of CASES) {
  const m = await measure(c);
  const note = m.error ?? (m.unrouted.length ? `unrouted: ${m.unrouted.join(" ")}` : c.note);
  rows.push([c.id, c.tool, String(m.raw), m.error ? "-" : String(m.compact), m.error ? "-" : String(m.json), m.error ? "-" : String(m.chars), String(m.jsonChars), m.tooLarge ? "TOO-LARGE" : "", note]);
}
const header = ["case", "tool", "raw", "compact", "json", "chars", "json-chars", "guard", "note"];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
const line = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : i < 2 || i === 7 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
console.log([line(header), ...rows.map(line)].join("\n"));
