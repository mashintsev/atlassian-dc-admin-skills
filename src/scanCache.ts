/**
 * Per-client cache for expensive scans (workflow usage, screen usage): one promise per kind and key,
 * shared by every tool call on that client, so one `apply` scans once. A rejected promise is dropped,
 * so a transient failure does not stick for the rest of the run. Executed writes that change what a
 * scan reports clear its kind (see ToolDef.invalidates and the runner).
 */

import type { AtlassianClient } from "./client.js";

export type ScanKind = "workflow-usage" | "screen-usage";

const caches = new WeakMap<AtlassianClient, Map<string, Promise<unknown>>>();

export function cached<T>(client: AtlassianClient, kind: ScanKind, key: string, factory: () => Promise<T>): Promise<T> {
  let cache = caches.get(client);
  if (!cache) {
    cache = new Map();
    caches.set(client, cache);
  }
  const id = `${kind}\u0000${key}`;
  let p = cache.get(id) as Promise<T> | undefined;
  if (!p) {
    p = factory();
    cache.set(id, p);
    p.catch(() => {
      if (cache!.get(id) === p) cache!.delete(id);
    });
  }
  return p;
}

/** Forget every cached scan of these kinds for the client. */
export function invalidateScans(client: AtlassianClient, kinds: readonly ScanKind[]): void {
  const cache = caches.get(client);
  if (!cache) return;
  for (const id of [...cache.keys()]) if (kinds.some((k) => id.startsWith(`${k}\u0000`))) cache.delete(id);
}
