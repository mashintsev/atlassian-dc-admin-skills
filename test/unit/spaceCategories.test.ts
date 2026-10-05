import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

  it("dry-runs an additive category POST and rejects invalid names", async () => {
    const { ctx, calls } = testContext();
    const result = await runTool(writeTool, { space_key: "SAMPLE/KEY", name: "naïve" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal((result.value as any).dry_run, true);
    assert.equal((result.value as any).request.method, "POST");
    assert.equal((result.value as any).request.url, "https://wiki.example.com/rest/api/space/SAMPLE%2FKEY/category/na%C3%AFve");
    assert.equal((result.value as any).request.body, undefined);
    assert.equal(calls.length, 0);

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
});
