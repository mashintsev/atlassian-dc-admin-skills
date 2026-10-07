/**
 * Result serialisation and the response-size guard.
 *
 * Adapted from mcp-atlassian-for-admins (src/json.ts, MIT). Claude Code drops
 * tool output over ~25k tokens, so results are compact JSON and an oversized
 * result is replaced by an error telling the model how to narrow the call.
 */

export function maxResponseChars(): number {
  const raw = Number(process.env.ATLASSIAN_MAX_RESPONSE_CHARS ?? 25_000);
  return Number.isFinite(raw) ? raw : 25_000;
}

/** Compact JSON; `undefined` properties are omitted. */
export function dumps(value: unknown): string {
  return JSON.stringify(value);
}

export function exceedsResponseLimit(text: string): boolean {
  const limit = maxResponseChars();
  return limit > 0 && text.length > limit;
}


