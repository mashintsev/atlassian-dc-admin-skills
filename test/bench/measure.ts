/** Runs one benchmark case on the payload server and counts raw, compact and JSON tokens (cl100k_base). */

import { getEncoding } from "js-tiktoken";
import { maxResponseChars } from "../../src/json.js";
import { render } from "../../src/format.js";
import { runToolByName } from "../../src/runner.js";
import { findTool } from "../../src/tools/index.js";
import { testContext } from "../unit/helpers.js";
import type { BenchCase } from "./cases.js";
import { benchResponder } from "./payloads.js";

const enc = getEncoding("cl100k_base");
export const tokens = (s: string) => enc.encode(s).length;

export interface Measurement {
  id: string;
  raw: number;
  compact: number;
  json: number;
  chars: number;
  jsonChars: number;
  tooLarge: boolean;
  error?: string;
  unrouted: string[];
}

export async function measure(c: BenchCase): Promise<Measurement> {
  let raw = 0;
  const { responder, unrouted } = benchResponder((body) => (raw += tokens(JSON.stringify(body))));
  const { ctx } = testContext(responder);
  const res = await runToolByName(c.tool, c.args, ctx);
  if (!res.ok) return { id: c.id, raw, compact: 0, json: 0, chars: 0, jsonChars: 0, tooLarge: false, error: `${res.error.type}: ${res.error.message}`, unrouted: [...unrouted] };
  const tool = findTool(c.tool);
  const compact = render(res.value, "compact", undefined, tool?.defaultFields, tool?.narrowing);
  const json = render(res.value, "json", undefined, tool?.defaultFields);
  return { id: c.id, raw, compact: tokens(compact), json: tokens(json), chars: compact.length, jsonChars: json.length, tooLarge: Math.max(compact.length, json.length) > maxResponseChars(), unrouted: [...unrouted] };
}
