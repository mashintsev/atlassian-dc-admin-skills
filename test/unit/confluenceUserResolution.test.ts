import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveConfluenceGrantUser } from "../../src/tools/confluence/users.js";
import { testContext } from "./helpers.js";

describe("Confluence grant user resolution", () => {
  it("accepts an email-shaped username only after exact active-user verification", async () => {
    const { ctx, calls } = testContext(() => ({
      body: { username: "operator@example.invalid", userKey: "USER-KEY-1", email: "operator@example.invalid", status: "active" },
    }));
    const result = await resolveConfluenceGrantUser(ctx.client("confluence"), { email: "operator@example.invalid" });

    assert.deepEqual(result, {
      username: "operator@example.invalid",
      userKey: "USER-KEY-1",
      email: "operator@example.invalid",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/rest\/api\/user\?username=operator%40example.invalid&expand=status$/);
  });

  it("falls back to one exact hydrated email match", async () => {
    const { ctx } = testContext((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/rest/api/user" && url.searchParams.get("username") === "person@example.invalid") return { status: 404 };
      if (url.pathname === "/rest/prototype/1/search/user") {
        return { body: { totalSize: 1, result: [{ username: "person", userKey: "SEARCH-KEY", displayableEmail: "person@example.invalid" }] } };
      }
      return { body: { username: "person", userKey: "USER-KEY-2", email: "person@example.invalid", status: "active" } };
    });
    const result = await resolveConfluenceGrantUser(ctx.client("confluence"), { email: "person@example.invalid" });
    assert.deepEqual(result, { username: "person", userKey: "USER-KEY-2", email: "person@example.invalid" });
  });

  it("blocks truncated exact-email searches", async () => {
    const { ctx } = testContext((call) => {
      if (call.url.includes("/rest/api/user")) return { status: 404 };
      return { body: { totalSize: 101, result: [{ username: "person", displayableEmail: "person@example.invalid" }] } };
    });
    await assert.rejects(
      resolveConfluenceGrantUser(ctx.client("confluence"), { email: "person@example.invalid" }),
      /truncated/,
    );
  });

  it("blocks exact-email results with incomplete identity or email evidence", async () => {
    const missingTotal = testContext((call) => {
      if (call.url.includes("/rest/api/user")) return { status: 404 };
      return { body: { result: [{ username: "person", displayableEmail: "person@example.invalid" }] } };
    });
    await assert.rejects(
      resolveConfluenceGrantUser(missingTotal.ctx.client("confluence"), { email: "person@example.invalid" }),
      /did not report a total/,
    );

    const missingEmail = testContext((call) => {
      if (call.url.includes("/rest/api/user")) return { status: 404 };
      return { body: { totalSize: 2, result: [
        { username: "person", displayableEmail: "person@example.invalid" },
        { username: "possible-match" },
      ] } };
    });
    await assert.rejects(
      resolveConfluenceGrantUser(missingEmail.ctx.client("confluence"), { email: "person@example.invalid" }),
      /no email evidence/,
    );
  });

  it("blocks ambiguous exact-email matches", async () => {
    const { ctx } = testContext((call) => {
      const url = new URL(call.url);
      if (url.pathname === "/rest/api/user" && url.searchParams.get("username") === "person@example.invalid") return { status: 404 };
      if (url.pathname === "/rest/prototype/1/search/user") {
        return { body: { totalSize: 2, result: [
          { username: "person-a", displayableEmail: "person@example.invalid" },
          { username: "person-b", displayableEmail: "person@example.invalid" },
        ] } };
      }
      return { body: { username: url.searchParams.get("username"), userKey: "USER-KEY", email: "person@example.invalid", status: "active" } };
    });
    await assert.rejects(
      resolveConfluenceGrantUser(ctx.client("confluence"), { email: "person@example.invalid" }),
      /Multiple active/,
    );
  });

  it("blocks unavailable, email-mismatched, and inactive accounts", async () => {
    const unavailable = testContext((call) =>
      call.url.includes("/rest/api/user") ? { status: 403 } : { body: {} },
    );
    await assert.rejects(
      resolveConfluenceGrantUser(unavailable.ctx.client("confluence"), { username: "person" }),
      /Could not verify/,
    );

    const mismatch = testContext((call) => {
      if (call.url.includes("/rest/api/user?username=person%40example.invalid")) return { status: 404 };
      if (call.url.includes("/rest/prototype/1/search/user")) {
        return { body: { totalSize: 1, result: [{ username: "person", displayableEmail: "person@example.invalid" }] } };
      }
      return { body: { username: "person", userKey: "USER-KEY", email: "other@example.invalid", status: "active" } };
    });
    await assert.rejects(
      resolveConfluenceGrantUser(mismatch.ctx.client("confluence"), { email: "person@example.invalid" }),
      /exact requested email/,
    );

    const inactive = testContext(() => ({
      body: { username: "person", userKey: "USER-KEY", email: "person@example.invalid", status: "inactive" },
    }));
    await assert.rejects(
      resolveConfluenceGrantUser(inactive.ctx.client("confluence"), { username: "person" }),
      /inactive/,
    );

    const contradictory = testContext(() => ({
      body: { username: "person", userKey: "USER-KEY", status: "inactive", active: true },
    }));
    await assert.rejects(
      resolveConfluenceGrantUser(contradictory.ctx.client("confluence"), { username: "person" }),
      /inactive/,
    );
  });
});
