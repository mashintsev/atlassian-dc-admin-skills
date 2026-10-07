import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName, toToolError } from "../../src/runner.js";
import { HttpStatusError } from "../../src/errors.js";
import { testContext } from "./helpers.js";

describe("suggestions and hints (unify 1.5)", () => {
  const { ctx } = testContext();

  it("suggests close tool names for a misspelled tool", async () => {
    const r: any = await runToolByName("jira_get_isue", {}, ctx);
    assert.equal(r.error.type, "UsageError");
    assert.match(r.error.hint, /jira_get_issue/);
  });

  it("suggests close argument names, including aliases, for a misspelled argument", async () => {
    const r: any = await runToolByName("jira_add_user_to_group", { group: "g", usr: "ivan" }, ctx);
    assert.equal(r.error.type, "ValidationError");
    assert.match(r.error.hint, /did you mean.*user/);
  });

  it("adds hints for 400, 429 and 5xx", () => {
    const hint = (status: number) => toToolError(new HttpStatusError(status, "{}", "https://jira.example.com/x", "GET")).hint ?? "";
    assert.match(hint(400), /describe/);
    assert.match(hint(429), /throttl/);
    for (const s of [500, 502, 503]) assert.match(hint(s), /server-side|retry/);
  });
});
