import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ALL_TOOLS } from "../../src/tools/index.js";

const testsDir = new URL("./", import.meta.url);
const tests = readdirSync(testsDir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(new URL(f, testsDir), "utf8"));

describe("write safety coverage (unify 3.5)", () => {
  it("every write tool has a tested already-satisfied path or says why it cannot be verified", () => {
    const missing = ALL_TOOLS.filter((t) => t.write && !t.unverifiable)
      .filter((t) => !tests.some((s) => s.includes(`"${t.name}"`) && /already_satisfied|already-satisfied|alreadySatisfied/.test(s)))
      .map((t) => t.name);
    assert.deepEqual(missing, []);
  });

  it("unverifiable reasons are short sentences", () => {
    for (const t of ALL_TOOLS.filter((x) => x.unverifiable)) {
      assert.ok(t.write, `${t.name} is not a write tool`);
      assert.ok(t.unverifiable!.length >= 10 && t.unverifiable!.length <= 160, t.name);
    }
  });
});
