import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { ALL_TOOLS } from "../../src/tools/index.js";

function maximum(schema: z.core.$ZodType): number | undefined {
  const json = z.toJSONSchema(schema, { unrepresentable: "any" }) as { maximum?: number };
  return json.maximum;
}

describe("read-tool limit caps", () => {
  for (const tool of ALL_TOOLS.filter((t) => !t.write && t.inputShape.limit)) {
    it(`${tool.name} declares and enforces its maximum`, () => {
      const schema = tool.inputShape.limit;
      const max = maximum(schema);
      assert.ok(max !== undefined && Number.isFinite(max), "limit must declare a finite maximum");
      assert.equal(z.safeParse(schema, max).success, true);
      assert.equal(z.safeParse(schema, max! + 1).success, false);
      // Literal secondary clamps must not silently impose a smaller cap than the schema.
      const clamps = [...String(tool.handler).matchAll(/Math\.min\(args\.limit\s*\?\?\s*\d+,\s*(\d+)\)/g)];
      for (const [, cap] of clamps) assert.equal(max, Number(cap), "schema maximum differs from applied clamp");
    });
  }
});
