import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { render } from "../../src/format.js";
import { runToolByName } from "../../src/runner.js";
import { replaceSection, splitSections } from "../../src/tools/confluence/pages.js";
import { benchResponder } from "../bench/payloads.js";
import { testContext } from "./helpers.js";

async function page(args: Record<string, unknown>, tool = "confluence_get_page") {
  const { ctx } = testContext(benchResponder().responder);
  const r: any = await runToolByName(tool, args, ctx);
  return r.ok ? { value: r.value } : { error: r.error };
}

describe("page sections (optimize-read-token-usage 3.1, 3.2)", () => {
  it("splits storage into headings with their extent, and replaceSection still matches exactly (3.1)", () => {
    const s = "<p>intro</p><h1>A</h1><p>a</p><h2>A.1</h2><p>a1</p><h1>B &amp; C</h1><p>b</p>";
    assert.deepEqual(splitSections(s).map((x) => [x.level, x.heading, s.slice(x.start, x.end)]), [
      [1, "A", "<h1>A</h1><p>a</p><h2>A.1</h2><p>a1</p>"],
      [2, "A.1", "<h2>A.1</h2><p>a1</p>"],
      [1, "B & C", "<h1>B &amp; C</h1><p>b</p>"],
    ]);
    assert.equal(replaceSection(s, "A.1", "<p>new</p>"), "<p>intro</p><h1>A</h1><p>a</p><h2>A.1</h2><p>new</p><h1>B &amp; C</h1><p>b</p>");
    assert.throws(() => replaceSection(s, "a.1", "x"), /Heading not found/);
  });

  it("cuts a long page at max_chars (default 20,000) on a block boundary and stays under the guard (3.2)", async () => {
    const { value } = await page({ page: "5999" });
    assert.ok(value.body.length <= 20_000, String(value.body.length));
    assert.equal(value.truncated.shown, value.body.length);
    assert.ok(value.truncated.total > 60_000);
    assert.match(value.hint, /outline=true.*section=/);
    assert.ok(render(value, "compact", undefined, undefined, ["section"]).length < 25_000);
    const small = await page({ page: "5999", max_chars: 1000 });
    assert.ok(small.value.body.length <= 1000);
    assert.match(small.value.body, /\S$/, "ends with a whole block, not mid-word or in a blank");
  });

  it("returns the outline without body text (3.2)", async () => {
    const { value } = await page({ page: "5999", outline: true });
    assert.equal(value.body, undefined);
    assert.equal(value.outline.length, 80);
    assert.deepEqual(Object.keys(value.outline[0]).sort(), ["chars", "heading", "level"]);
    assert.equal(value.outline[3].heading, "Section 3");
  });

  it("returns one section, matching the heading case-insensitively, and lists headings for an unknown one (3.2)", async () => {
    const { value } = await page({ page: "5999", section: "section 7" });
    assert.match(value.body, /^## Section 7\n/);
    assert.ok(!value.body.includes("Section 8"));
    assert.equal(value.truncated, undefined);
    const missing = await page({ page: "5999", section: "Rollback" });
    assert.equal(missing.error.type, "ValidationError");
    assert.match(missing.error.message, /No section 'Rollback'.*Section 0, Section 1/);
  });

  it("applies the same arguments to a historical version (3.2)", async () => {
    const { value } = await page({ page: "5999", version: 3, max_chars: 2000 }, "confluence_get_page_history");
    assert.ok(value.body.length <= 2000);
    assert.ok(value.truncated);
  });
});
