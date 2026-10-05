import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, calls };
}
const q = (c: Call) => new URL(c.url).searchParams;

describe("confluence read tools page and filter server-side", () => {
  it("list_spaces with name_contains uses CQL search, one page", async () => {
    const r = await run("confluence_list_spaces", { name_contains: "doc", limit: 10 }, () => ({
      body: { results: [{ space: { id: 1, key: "DOC", name: "Docs", type: "global", status: "current" } }], totalSize: 1, _links: {} },
    }));
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0].url, /\/rest\/api\/search\?/);
    assert.match(q(r.calls[0]).get("cql")!, /^type = space AND \(space\.title ~ "doc" OR space\.key = "DOC"\)$/);
    assert.equal(q(r.calls[0]).get("limit"), "10");
    assert.equal(r.value.items[0].key, "DOC");
  });

  it("list_spaces falls back to a capped scan when CQL is rejected", async () => {
    const r = await run("confluence_list_spaces", { name_contains: "doc" }, (c) =>
      c.url.includes("/search") ? { status: 400, body: { message: "bad cql" } } : { body: { results: [{ key: "DOC", name: "Docs" }], _links: {} } },
    );
    assert.match(r.value.fallback, /scanned 1 spaces/);
  });

  it("get_labels pages server-side", async () => {
    const r = await run("confluence_get_labels", { content_id: 5, prefix: "global", limit: 20, offset: 40 }, () => ({ body: { results: [{ name: "a", prefix: "global" }], _links: {} } }));
    assert.equal(r.calls.length, 1);
    assert.deepEqual([q(r.calls[0]).get("start"), q(r.calls[0]).get("limit"), q(r.calls[0]).get("prefix")], ["40", "20", "global"]);
  });

  it("inline comments: one page, no container expand", async () => {
    const r = await run("confluence_get_inline_comments", { page_id: 9 }, () => ({ body: { results: [], _links: {} } }));
    const p = q(r.calls[0]);
    assert.deepEqual([p.get("location"), p.get("start"), p.get("limit")], ["inline", "0", "25"]);
    assert.doesNotMatch(p.get("expand")!, /container/);
  });

  it("download_content_attachments filters mediaType server-side and stops at limit", async () => {
    const r = await run("confluence_download_content_attachments", { content_id: 7, output_dir: "/tmp/x-none", media_type: "image/png", limit: 1 }, (c) =>
      c.url.includes("/child/attachment")
        ? { body: { results: [{ id: "a1", title: "big.png", extensions: { mediaType: "image/png", fileSize: 999999999 } }], _links: { next: "/n" } } }
        : undefined,
    );
    assert.equal(r.calls.length, 1); // no further pages once `limit` matches are found
    assert.equal(q(r.calls[0]).get("mediaType"), "image/png");
    assert.equal(q(r.calls[0]).get("limit"), "100");
  });

  it("get_space does not expand labels", async () => {
    const r = await run("confluence_get_space", { space_key: "DOC" }, () => ({ body: { key: "DOC" } }));
    assert.equal(q(r.calls[0]).get("expand"), "description.plain,homepage,history");
  });
});
