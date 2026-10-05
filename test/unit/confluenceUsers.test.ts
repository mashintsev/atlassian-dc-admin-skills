import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { confluenceUserTools } from "../../src/tools/confluence/users.js";
import { testContext } from "./helpers.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(`test/fixtures/confluence/${name}.json`, "utf8"));

describe("Confluence user search", () => {
  it("preserves modern usernames and user keys", async () => {
    const data = fixture("user-search-modern");
    const { ctx, calls } = testContext(() => ({ body: data }));
    const result = await runTool(confluenceUserTools[0], { query: "sample" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value, {
      total: 1,
      returned: 1,
      items: [{ username: "sample-admin", userKey: "SYNTHETIC-USER-KEY", displayName: "Sample Administrator" }],
      unrecognizedIdentityCount: 0,
    });
    assert.equal(calls.length, 1);
  });

  it("preserves legacy identity fields and absent identifiers", async () => {
    const data = fixture("user-search-legacy");
    const { ctx } = testContext(() => ({ body: data }));
    const result = await runTool(confluenceUserTools[0], { query: "sample" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.value as any).items, [{
      username: "sample-editor",
      displayName: "Sample Editor",
      email: "sample-editor@example.invalid",
    }]);
  });

  it("reports matches without supported identifiers", async () => {
    const { ctx } = testContext(() => ({ body: { result: [{ title: "Unknown Account" }] } }));
    const result = await runTool(confluenceUserTools[0], { query: "unknown" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual((result.value as any).items, [{
      displayName: "Unknown Account",
      diagnostic: "unrecognized identity shape: no username or user key",
    }]);
    assert.equal((result.value as any).unrecognizedIdentityCount, 1);
  });

  it("keeps the synthetic space workflow cardinalities internally consistent", () => {
    const counts = fixture("space-workflow-cardinalities");
    assert.equal(counts.categoriesAlreadyPresent + counts.categoryAdditions, counts.spacesSelected);
    assert.equal(counts.permissionsAlreadySatisfied + counts.readOnlyPermissions + counts.permissionsAbsent, counts.spacesSelected);
    assert.equal(counts.readOnlyPermissions + counts.permissionsAbsent, counts.permissionRequests);
    assert.equal(counts.adminOnlyRequests + counts.readAndAdminRequests, counts.permissionRequests);
    assert.equal(counts.verifiedSpaces, counts.spacesSelected);

    const sample = fixture("space-state-sample");
    assert.equal(sample.space.metadata.labels.results[0].prefix, "team");
    assert.equal(sample.permissions[0].subject.name, "sample-team");
  });
});
