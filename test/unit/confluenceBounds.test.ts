import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { findTool } from "../../src/tools/index.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => new URL(c.url).pathname;

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r: any = await runToolByName(tool, args, ctx);
  return { value: r.ok ? r.value : undefined, error: r.ok ? undefined : r.error, calls };
}

describe("Confluence read bounds (optimize-read-token-usage 4.x)", () => {
  it("caps space permission subjects at 10 plus a total, and returns all with full_lists (4.3)", async () => {
    const grants = Array.from({ length: 30 }, (_, i) => ({ subject: { type: "user", username: `user${i}` }, operation: { operationKey: "read", targetType: "space" } }));
    const r = await run("confluence_get_space_permissions", { space_key: "SP" }, () => ({ body: grants }));
    assert.equal(r.value.subjects, 30);
    assert.equal(Object.keys(r.value.permissions).length, 10);
    assert.equal(r.value.permissionsTotal, 30);
    const full = await run("confluence_get_space_permissions", { space_key: "SP", full_lists: true }, () => ({ body: grants }));
    assert.equal(Object.keys(full.value.permissions).length, 30);
    assert.equal(full.value.permissionsTotal, undefined);
  });

  it("returns cluster nodes, long tasks and global permissions through allowlists (4.5)", async () => {
    const nodes = await run("confluence_cluster_nodes", {}, () => ({ body: [{ id: "n1", name: "node1", state: "ACTIVE", version: "9.2.1", buildNumber: 9000, jvmStats: { heap: 1 }, address: "10.0.0.1", internal: { x: 1 } }] }));
    assert.deepEqual(Object.keys(nodes.value[0]).sort(), ["address", "buildNumber", "id", "name", "state", "version"]);

    const messages = Array.from({ length: 50 }, (_, i) => ({ translation: `message ${i}`, args: [] }));
    const task = { id: "t1", name: { key: "export", translation: "Space export" }, elapsedTime: 1200, percentageComplete: 40, successful: false, messages, _links: { self: "x" } };
    const list = await run("confluence_list_long_tasks", {}, () => ({ body: { results: [task], _links: {} } }));
    assert.deepEqual(Object.keys(list.value.items[0]).sort(), ["elapsedTime", "id", "name", "percentageComplete", "successful"]);
    const one = await run("confluence_get_long_task", { task_id: "t1" }, () => ({ body: task }));
    assert.equal(one.value.name, "Space export");
    assert.equal(one.value.messages.length, 20);
    assert.equal(one.value.messages[0], "message 49", "newest first");
    assert.equal(one.value.messagesTotal, 50);

    const perms = await run("confluence_get_global_permissions", { subject_type: "group", subject: "admins" }, () => ({
      body: [{ operation: { operationKey: "administer", targetType: "application", _links: {} }, subject: { type: "group", name: "admins", _links: {} } }],
    }));
    assert.deepEqual(perms.value, { subject: "group:admins", operations: ["administer:application"] });
  });

  it("does not leak unknown structured task names through the allowlist", async () => {
    const result = await run("confluence_get_long_task", { task_id: "t2" }, () => ({
      body: { id: "t2", name: { internal: "hidden" }, messages: [] },
    }));
    assert.equal(result.value.name, undefined);
    assert.ok(!JSON.stringify(result.value).includes("hidden"));
  });

  it("advertises the applied attachment page cap (4.6)", async () => {
    const limit = findTool("confluence_get_attachments")!.inputShape.limit as any;
    assert.equal(limit.safeParse(101).success, false);
    assert.equal(limit.safeParse(100).success, true);
    const page = await run("confluence_get_attachments", { content_id: "42", limit: 100 }, (call) => {
      assert.equal(new URL(call.url).searchParams.get("limit"), "100");
      return { body: { results: [], _links: {} } };
    });
    assert.equal(page.error, undefined);
    const invalid = await run("confluence_get_attachments", { content_id: "42", limit: 101 }, () => ({ body: {} }));
    assert.equal(invalid.error?.type, "ValidationError");
    assert.equal(invalid.calls.length, 0);
  });

  it("declares the limit caps it applies (4.6)", () => {
    const limit = (name: string) => findTool(name)!.inputShape.limit as any;
    assert.equal(limit("confluence_find_users").safeParse(501).success, false);
    assert.equal(limit("confluence_find_users").safeParse(500).success, true);
    assert.equal(limit("confluence_search").safeParse(101).success, false);
    assert.equal(limit("confluence_search").safeParse(100).success, true);
  });
});

describe("Confluence comments (optimize-read-token-usage 5.3)", () => {
  it("converts the storage body, never the rendered view, and bounds it with max_body_chars", async () => {
    const storage = '<p>Ping <ac:link><ri:user ri:username="ivan" /></ac:link> <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">DONE</ac:parameter></ac:structured-macro></p>' + `<p>${"long text ".repeat(400)}</p>`;
    const body = { results: [{ id: "c1", type: "comment", body: { storage: { value: storage }, view: { value: '<p>Ping <a class="confluence-userlink" data-username="ivan" href="/display/~ivan">Ivan</a> <span class="status-macro aui-lozenge">DONE</span></p>' } }, version: { by: { username: "ann" }, when: "2026-09-01T10:00:00.000+02:00" } }], _links: {} };
    const r = await run("confluence_get_comments", { page_id: "5001" }, (c) => {
      assert.ok(!new URL(c.url).searchParams.get("expand")?.includes("body.view"), "asks for storage only");
      return { body };
    });
    const text: string = r.value.items[0].body;
    assert.match(text, /^Ping @ivan \[status: DONE\]/);
    assert.ok(!text.includes("lozenge") && !text.includes("confluence-userlink"));
    assert.ok(text.length <= 2_000 + 40, String(text.length));
    assert.match(text, /…\(\+\d+ chars\)$/);
    const more = await run("confluence_get_comments", { page_id: "5001", max_body_chars: 5000 }, () => ({ body }));
    assert.ok(more.value.items[0].body.length > 3000);
    const inline = await run("confluence_get_inline_comments", { page_id: "5001", max_body_chars: 100 }, (c) => {
      assert.equal(new URL(c.url).searchParams.get("location"), "inline");
      assert.match(new URL(c.url).searchParams.get("expand") ?? "", /body\.storage/);
      return { body };
    });
    assert.match(inline.value.items[0].body, /^Ping @ivan \[status: DONE\]/);
    assert.match(inline.value.items[0].body, /…\(\+\d+ chars\)$/);
    for (const tool of ["confluence_get_comments", "confluence_get_inline_comments"]) {
      assert.equal((findTool(tool)!.inputShape.max_body_chars as any).safeParse(20001).success, false);
    }
  });
});

describe("Confluence page reads and writes around cut content (optimize-read-token-usage 5.2, 5.4)", () => {
  const code = Array.from({ length: 250 }, (_, i) => `line ${i}`).join("\n");
  const storage = `<p>Text</p><ac:image><ri:attachment ri:filename="d.png" /></ac:image><ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`;
  const pageBody = { id: "7", title: "P", type: "page", version: { number: 3 }, space: { key: "SP" }, body: { storage: { value: storage } } };

  it("notes once that bare image names are page attachments", async () => {
    const r = await run("confluence_get_page", { page: "7" }, () => ({ body: pageBody }));
    assert.match(r.value.body, /!\[\]\(d\.png\)/);
    assert.match(r.value.note, /attachments of this page/);
    const none = await run("confluence_get_page", { page: "7", body_format: "storage" }, () => ({ body: pageBody }));
    assert.equal(none.value.note, undefined);
  });

  it("refuses to write back a body whose code block was cut in a read", async () => {
    const read = await run("confluence_get_page", { page: "7" }, () => ({ body: pageBody }));
    const w = await run("confluence_update_page", { page: "7", content: read.value.body }, (c) => (c.method === "GET" ? { body: pageBody } : { body: {} }));
    assert.equal(w.error?.type, "ValidationError");
    assert.match(w.error.message, /cut in a read/);
  });

  it("diffs full code blocks", async () => {
    const other = { ...pageBody, body: { storage: { value: storage.replace("line 240", "line 240 changed") } } };
    const r = await run("confluence_get_page_diff", { page: "7", from_version: 2, to_version: 3 }, (c) => ({ body: new URL(c.url).searchParams.get("version") === "2" ? pageBody : other }));
    assert.match(r.value.diff ?? JSON.stringify(r.value), /line 240 changed/);
  });
});
