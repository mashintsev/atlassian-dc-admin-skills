import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectFields, render } from "../../src/format.js";

const page = { total: 2, offset: 0, returned: 2, nextOffset: null, items: [
  { id: "1", name: "A", type: "text", description: "long text", schema: "x" },
  { id: "2", name: "B", type: "select", description: "more", schema: "y" },
] };
const keys = (v: any) => Object.keys(v.items[0]).sort();

describe("default columns and --fields modes (reduce-agent-context 3.3)", () => {
  it("uses the tool's default columns when no --fields is given", () => {
    assert.deepEqual(keys(projectFields(page, undefined, ["id", "name"])), ["id", "name"]);
    assert.deepEqual(keys(projectFields(page, undefined, undefined)), ["description", "id", "name", "schema", "type"]);
  });

  it("adds columns with +x, shows everything with all, and keeps exact and exclude lists", () => {
    assert.deepEqual(keys(projectFields(page, "+description", ["id", "name"])), ["description", "id", "name"]);
    assert.deepEqual(keys(projectFields(page, "all", ["id", "name"])), ["description", "id", "name", "schema", "type"]);
    assert.deepEqual(keys(projectFields(page, "type", ["id", "name"])), ["type"]);
    assert.deepEqual(keys(projectFields(page, "-schema", ["id", "name"])), ["id", "name"]);
    assert.deepEqual(keys(projectFields(page, "-schema", undefined)), ["description", "id", "name", "type"]);
  });

  it("projects single objects the same way and renders through render()", () => {
    assert.deepEqual(Object.keys(projectFields({ id: "1", name: "A", type: "t" }, "+type", ["id"]) as object).sort(), ["id", "type"]);
    assert.match(render(page, "compact", undefined, ["id", "name"]), /^# id \| name$/m);
  });
});

describe("tools with default columns", () => {
  it("jira_list_custom_fields hides the long type column by default and describe names the defaults", async () => {
    const { findTool } = await import("../../src/tools/index.js");
    const tool = findTool("jira_list_custom_fields")!;
    assert.ok(tool.defaultFields && !tool.defaultFields.includes("type"));
    const row = { id: "customfield_1", name: "Severity", type: "com.atlassian.jira.plugin.system.customfieldtypes:select", issuesWithValue: 3 };
    const page = { total: 1, offset: 0, returned: 1, nextOffset: null, items: [row] };
    assert.ok(!render(page, "compact", undefined, tool.defaultFields).includes("customfieldtypes"));
    assert.ok(render(page, "compact", "+type", tool.defaultFields).includes("customfieldtypes"));
  });
});

describe("JSON output keeps every field (review fix)", () => {
  it("applies default columns to compact output only; --format=json shows all fields unless --fields narrows them", () => {
    const json = JSON.parse(render(page, "json", undefined, ["id", "name"]));
    assert.deepEqual(keys(json), ["description", "id", "name", "schema", "type"]);
    assert.deepEqual(keys(JSON.parse(render(page, "json", "id", ["id", "name"]))), ["id"]);
    assert.deepEqual(keys(JSON.parse(render(page, "json", "-schema", ["id", "name"]))), ["description", "id", "name", "type"]);
  });
});
