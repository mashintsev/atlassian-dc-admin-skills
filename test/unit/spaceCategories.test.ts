import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan } from "../../src/plan.js";
import { runTool } from "../../src/runner.js";
import { confluenceSpaceCategoryTools } from "../../src/tools/confluence/spaceCategories.js";
import { testContext } from "./helpers.js";

const readTool = confluenceSpaceCategoryTools[0];
const writeTool = confluenceSpaceCategoryTools[1];

describe("Confluence space categories", () => {
  it("follows opaque same-resource continuations and returns only team categories", async () => {
    const { ctx, calls } = testContext((call) => {
      const url = new URL(call.url);
      if (!url.searchParams.has("cursor")) {
        return { body: { metadata: { labels: {
          results: [{ prefix: "team", name: "sample-team" }, { prefix: "global", name: "page-label" }],
          _links: { next: "?expand=metadata.labels&cursor=opaque%2Fvalue" },
        } } } };
      }
      return { body: { metadata: { labels: {
        results: [{ prefix: "team", name: "another-category" }],
        _links: {},
      } } } };
    });
    const result = await runTool(readTool, { space_key: "SAMPLE" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.value as any).categories, [
      { name: "sample-team", prefix: "team" },
      { name: "another-category", prefix: "team" },
    ]);
    assert.equal((result.value as any).complete, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /cursor=opaque%2Fvalue/);
  });

  it("distinguishes an empty complete response from malformed response data", async () => {
    const empty = testContext(() => ({ body: { metadata: { labels: { results: [], _links: {} } } } }));
    const emptyResult = await runTool(readTool, { space_key: "EMPTY" }, empty.ctx);
    assert.equal((emptyResult as any).value.complete, true);
    assert.deepEqual((emptyResult as any).value.categories, []);

    const malformed = testContext(() => ({ body: { metadata: { labels: {} } } }));
    const malformedResult = await runTool(readTool, { space_key: "UNKNOWN" }, malformed.ctx);
    assert.equal((malformedResult as any).value.complete, false);
    assert.match((malformedResult as any).value.issues[0], /unknown metadata.labels/);
  });

  it("blocks unsafe and repeated continuations", async () => {
    const unsafe = testContext(() => ({ body: {
      metadata: { labels: { results: [], _links: { next: "https://elsewhere.invalid/rest/api/space/SAMPLE?cursor=x" } } },
    } }));
    const unsafeResult = await runTool(readTool, { space_key: "SAMPLE" }, unsafe.ctx);
    assert.equal((unsafeResult as any).value.complete, false);
    assert.equal(unsafe.calls.length, 1);

    const repeated = testContext(() => ({ body: {
      metadata: { labels: { results: [], _links: { next: "?cursor=repeat" } } },
    } }));
    const repeatedResult = await runTool(readTool, { space_key: "SAMPLE" }, repeated.ctx);
    assert.equal((repeatedResult as any).value.complete, false);
    assert.match((repeatedResult as any).value.issues[0], /repeated/);
  });

  it("reports pagination safety caps as incomplete", async () => {
    let page = 0;
    const { ctx, calls } = testContext(() => {
      page++;
      return { body: { metadata: { labels: {
        results: [],
        _links: { next: `?cursor=${page}` },
      } } } };
    });
    const result = await runTool(readTool, { space_key: "SAMPLE" }, ctx);

    assert.equal((result as any).value.complete, false);
    assert.match((result as any).value.issues[0], /safety limit/);
    assert.equal(calls.length, 50);
  });

  it("enforces the caller category bound and marks truncated results incomplete", async () => {
    const { ctx } = testContext(() => ({ body: { metadata: { labels: {
      results: [
        { prefix: "team", name: "first" },
        { prefix: "team", name: "second" },
      ],
      _links: {},
    } } } }));
    const result = await runTool(readTool, { space_key: "SAMPLE", max_categories: 1 }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.value as any).categories, [{ name: "first", prefix: "team" }]);
    assert.equal((result.value as any).complete, false);
  });

  it("dry-runs an additive category POST and rejects invalid names", async () => {
    const { ctx, calls } = testContext(() => ({ body: { metadata: { labels: { results: [], _links: {} } } } }));
    const result = await runTool(writeTool, { space_key: "SAMPLE/KEY", name: "naïve" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.value as any).dry_run, true);
    assert.equal((result.value as any).request.method, "POST");
    assert.equal((result.value as any).request.url, "https://wiki.example.com/rest/api/space/SAMPLE%2FKEY/category/na%C3%AFve");
    assert.equal((result.value as any).request.body, undefined);
    assert.deepEqual(calls.map((call) => call.method), ["GET"], "the dry run only reads the categories");

    for (const name of ["", "Upper", "white space", "bad/name"]) {
      const invalid = await runTool(writeTool, { space_key: "SAMPLE", name }, ctx);
      assert.equal(invalid.ok, false, name);
    }
  });

  it("reads before and after execution, preserving existing team categories", async () => {
    const { ctx, calls } = testContext((call) => {
      if (call.method === "POST") return { body: {} };
      return { body: { metadata: { labels: { results: [
        { prefix: "team", name: "existing-category" },
        ...(calls.filter((c) => c.method === "POST").length ? [{ prefix: "team", name: "new-category" }] : []),
      ], _links: {} } } } };
    });
    const result = await runTool(writeTool, { space_key: "SAMPLE", name: "new-category", dry_run: false }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
    assert.equal((result.value as any).verification.previousCategoriesPreserved, true);
    assert.equal((result.value as any).verification.categoryPresent, true);
  });

  it("reports an existing category as already satisfied in the dry run and the execution, sending nothing", async () => {
    assert.equal(writeTool.name, "confluence_add_space_category");
    const existing = () => ({ body: { metadata: { labels: { results: [{ prefix: "team", name: "ops" }], _links: {} } } } });
    const dry = testContext(existing);
    const d = await runTool(writeTool, { space_key: "SAMPLE", name: "ops" }, dry.ctx);
    assert.equal((d as any).value.already_satisfied, true, JSON.stringify(d));
    const file = join(mkdtempSync(join(tmpdir(), "cat-")), "plan.json");
    assert.deepEqual(addResultToPlan(file, writeTool.name, { space_key: "SAMPLE", name: "ops" }, (d as any).value), []);
    const run = testContext(existing);
    const r = await runTool(writeTool, { space_key: "SAMPLE", name: "ops", dry_run: false }, run.ctx);
    assert.equal((r as any).value.already_satisfied, true);
    assert.ok(!run.calls.some((c) => c.method === "POST"));
  });

  it("reports a read-back without the category as a VerificationError", async () => {
    const { ctx } = testContext((call) => (call.method === "POST" ? { body: {} } : { body: { metadata: { labels: { results: [], _links: {} } } } }));
    const result = await runTool(writeTool, { space_key: "SAMPLE", name: "new-category", dry_run: false }, ctx);
    assert.equal(result.ok, false);
    assert.equal((result as any).error.type, "VerificationError");
  });

  it("does not report success when category read-back is forbidden", async () => {
    let categoryReads = 0;
    const { ctx, calls } = testContext((call) => {
      if (call.method === "POST") return { body: {} };
      categoryReads++;
      if (categoryReads === 2) return { status: 403 };
      return { body: { metadata: { labels: { results: [], _links: {} } } } };
    });
    const result = await runTool(writeTool, { space_key: "SAMPLE", name: "new-category", dry_run: false }, ctx);

    assert.equal(result.ok, false);
    assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET"]);
  });
});

describe("category reads on Confluence versions without _links (live finding)", () => {
  it("treats a short page without _links as complete, and a full one as incomplete", async () => {
    const short = testContext(() => ({ body: { metadata: { labels: { results: [{ prefix: "team", name: "ops" }], start: 0, limit: 200, size: 1 } } } }));
    const r: any = await runTool(readTool, { space_key: "SAMPLE" }, short.ctx);
    assert.equal(r.value.complete, true, JSON.stringify(r.value));
    assert.deepEqual(r.value.categories, [{ name: "ops", prefix: "team" }]);
    const full = testContext(() => ({ body: { metadata: { labels: { results: [{ prefix: "team", name: "ops" }], start: 0, limit: 1, size: 1 } } } }));
    const f: any = await runTool(readTool, { space_key: "SAMPLE" }, full.ctx);
    assert.equal(f.value.complete, false);
  });
});
