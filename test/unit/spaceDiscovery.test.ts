import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { confluenceSpaceDiscoveryTools } from "../../src/tools/confluence/spaceDiscovery.js";
import { testContext } from "./helpers.js";

const tool = confluenceSpaceDiscoveryTools[0];

function groupResponse(call: { url: string }) {
  if (call.url.includes("/rest/api/group?")) return { body: { results: [{ name: "sample-team" }], totalSize: 1 } };
  return undefined;
}

describe("Confluence group space discovery", () => {
  it("enumerates all requested scopes and selects only exact explicit read grants", async () => {
    const { ctx, calls } = testContext((call) => {
      const url = new URL(call.url);
      const type = url.searchParams.get("type");
      const status = url.searchParams.get("status");
      if (url.pathname === "/rest/api/group") return groupResponse(call);
      if (url.pathname === "/rest/api/space") {
        if (type === "global" && status === "current" && !url.searchParams.has("cursor")) {
          return { body: {
            totalSize: 2,
            results: [{ id: "1", key: "DoC", name: "Sample Docs", type, status }],
            _links: { next: "?type=global&status=current&limit=100&cursor=second" },
          } };
        }
        if (type === "global" && status === "current") {
          return { body: {
            totalSize: 2,
            results: [{ id: "2", key: "NoView", name: "No View", type, status }],
            _links: {},
          } };
        }
        return { body: { totalSize: 0, results: [], _links: {} } };
      }
      if (call.url.includes("/permissions/group/")) {
        if (call.url.includes("/space/DoC/")) {
          return { body: [{ subject: { type: "group", name: "sample-team" }, operation: { operationKey: "read", targetType: "space" } }] };
        }
        return { body: [{ subject: { type: "group", name: "sample-team" }, operation: { operationKey: "administer", targetType: "space" } }] };
      }
      return undefined;
    });
    const result = await runTool(tool, { group: "sample-team" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.value as any;
    assert.equal(value.inspected, 2);
    assert.equal(value.selected, 1);
    assert.equal(value.completeForCaller, true);
    assert.equal(value.siteWideComplete, true);
    assert.equal(value.siteCountCrossCheck.status, "matched");
    assert.deepEqual(value.matches.map((space: any) => [space.key, space.groupOperations]), [["DoC", ["read:space"]]]);
    assert.deepEqual(value.audit.find((space: any) => space.key === "NoView").groupOperations, ["administer:space"]);
    assert.equal(calls.filter((call) => call.url.includes("/rest/api/space?")).length, 5);
    assert.ok(calls.some((call) => call.url.includes("/space/DoC/permissions/group/sample-team")));
  });

  it("reports permission failures as unknown and blocks complete results", async () => {
    const { ctx } = testContext((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/rest/api/group") return groupResponse(call);
      if (url.pathname === "/rest/api/space") {
        return { body: { totalSize: 1, results: [{ id: "1", key: "FAIL", name: "Failed Read", type: "global", status: "current" }], _links: {} } };
      }
      if (call.url.includes("/permissions/group/")) return { status: 403 };
      return undefined;
    });
    const result = await runTool(tool, { group: "sample-team", type: "global", status: "current" }, ctx);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const value = result.value as any;
    assert.equal(value.permissionReadsComplete, false);
    assert.equal(value.completeForCaller, false);
    assert.equal(value.siteCountCrossCheck.status, "not-applicable-for-filtered-scope");
    assert.equal(value.unknownReads[0].spaceKey, "FAIL");
  });

  it("marks malformed lists, repeated cursors, and site count mismatches incomplete", async () => {
    const malformed = testContext((call) => {
      if (call.url.includes("/rest/api/group?")) return groupResponse(call);
      return { body: { results: "not-an-array" } };
    });
    const malformedResult = await runTool(tool, { group: "sample-team", type: "global", status: "current" }, malformed.ctx);
    assert.equal((malformedResult as any).value.enumerationComplete, false);
    assert.equal((malformedResult as any).value.completeForCaller, false);

    const repeated = testContext((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/rest/api/group") return groupResponse(call);
      return { body: {
        results: [{ id: "1", key: "REPEAT", name: "Repeat", type: "global", status: "current" }],
        _links: { next: "?type=global&status=current&cursor=repeat" },
      } };
    });
    const repeatedResult = await runTool(tool, { group: "sample-team", type: "global", status: "current" }, repeated.ctx);
    assert.equal((repeatedResult as any).value.completeForCaller, false);
    assert.match((repeatedResult as any).value.issues.join(" "), /repeated/);

    const mismatch = testContext((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/rest/api/group") return groupResponse(call);
      if (url.pathname === "/rest/api/space") {
        const type = url.searchParams.get("type");
        const status = url.searchParams.get("status");
        return { body: {
          totalSize: type === "global" && status === "current" ? 5 : 0,
          results: type === "global" && status === "current"
            ? [{ id: "1", key: "COUNT", name: "Count", type, status }]
            : [],
          _links: {},
        } };
      }
      return { body: [] };
    });
    const mismatchResult = await runTool(tool, { group: "sample-team" }, mismatch.ctx);
    assert.equal((mismatchResult as any).value.siteCountCrossCheck.status, "mismatch");
    assert.equal((mismatchResult as any).value.completeForCaller, false);
  });

  it("marks scans that reach the page cap incomplete", async () => {
    let page = 0;
    const { ctx } = testContext((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/rest/api/group") return groupResponse(call);
      page++;
      return { body: {
        totalSize: 10000,
        results: [{ id: String(page), key: `S${page}`, name: `Space ${page}`, type: "global", status: "current" }],
        _links: { next: `?type=global&status=current&cursor=${page}` },
      } };
    });
    const result = await runTool(tool, { group: "sample-team", type: "global", status: "current" }, ctx);

    assert.equal((result as any).value.completeForCaller, false);
    assert.match((result as any).value.issues.join(" "), /safety limit/);
  });

  it("requires exact group existence before starting the space scan", async () => {
    const { ctx, calls } = testContext((call) =>
      call.url.includes("/rest/api/group?")
        ? { body: { results: [{ name: "sample-team-other" }], totalSize: 1 } }
        : { body: { results: [] } },
    );
    const result = await runTool(tool, { group: "sample-team" }, ctx);

    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });
});
