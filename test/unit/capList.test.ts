import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capList, LIST_PREVIEW } from "../../src/tools/util.js";

describe("capList (optimize-read-token-usage 4.3)", () => {
  it("keeps short lists, cuts long ones to the preview plus a total, and returns everything when full", () => {
    const keys = Array.from({ length: 1200 }, (_, i) => `PRJ${i}`);
    const out: Record<string, unknown> = {};
    capList(out, "projects", keys);
    assert.deepEqual(out, { projects: keys.slice(0, LIST_PREVIEW), projectsTotal: 1200 });
    const full: Record<string, unknown> = {};
    capList(full, "projects", keys, true);
    assert.equal((full.projects as string[]).length, 1200);
    assert.equal(full.projectsTotal, undefined);
    const short: Record<string, unknown> = {};
    capList(short, "groups", ["a", "b"]);
    assert.deepEqual(short, { groups: ["a", "b"] });
  });
});
