import assert from "node:assert/strict";
import { it } from "node:test";
import { CASES } from "../bench/cases.js";
import { measure } from "../bench/measure.js";

for (const c of CASES) {
  it(`read budget: ${c.id}`, async () => {
    const m = await measure(c);
    assert.equal(m.error, undefined, m.error);
    assert.deepEqual(m.unrouted, []);
    assert.ok(m.compact <= c.budget, `${c.id} compact: ${m.compact} tokens, budget ${c.budget}`);
    assert.ok(m.json <= c.jsonBudget, `${c.id} JSON: ${m.json} tokens, budget ${c.jsonBudget}`);
    assert.ok(m.chars <= 25_000, `${c.id} compact: ${m.chars} characters`);
    if (!c.expanded) assert.ok(m.jsonChars <= 25_000, `${c.id} JSON: ${m.jsonChars} characters`);
  });
}
