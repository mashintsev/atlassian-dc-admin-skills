import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { buildCql, confluencePageTools, replaceSection, resolvePageId, unifiedDiff } from "../../src/tools/confluence/pages.js";
import { exitCodeFor } from "../../src/format.js";
import { testContext, type Call } from "./helpers.js";
import { CODE_CUT_MARKER, storageToMarkdown } from "../../src/markup.js";

const tool = (name: string) => confluencePageTools.find((t) => t.name === name)!;

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runTool(tool(name), args, ctx);
  return { res, calls, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : res.error };
}

const PAGE = {
  id: "123",
  type: "page",
  title: "Plan",
  status: "current",
  space: { key: "DOC" },
  version: { number: 4, when: "2026-10-01T10:00:00.000+0300", by: { username: "ivan" } },
  ancestors: [{ id: "100", title: "Home" }],
  body: { storage: { value: "<h1>Intro</h1><p>a</p><h2>Goals</h2><p>old</p><h2>Risks</h2><p>r</p>" } },
};

describe("helpers", () => {
  it("resolves ids from numbers, URLs and tiny links", () => {
    assert.equal(resolvePageId("123"), "123");
    assert.equal(resolvePageId("https://wiki/spaces/DOC/pages/456/Title"), "456");
    assert.equal(resolvePageId("https://wiki/pages/viewpage.action?pageId=789"), "789");
    // tiny link for page id 1234567: little-endian bytes base64 → "h9YSAA"
    const tiny = Buffer.alloc(8);
    tiny.writeBigUInt64LE(1234567n);
    const code = tiny.toString("base64").replace(/=+$/, "").replace(/A+$/, "").replace(/\//g, "-").replace(/\+/g, "_");
    assert.equal(resolvePageId(`https://wiki/x/${code}`), "1234567");
    assert.throws(() => resolvePageId("nope"));
  });

  it("builds CQL from text and keeps ORDER BY after the space filter", () => {
    assert.equal(buildCql('release "plan"'), 'siteSearch ~ "release \\"plan\\""');
    assert.equal(buildCql("type=page ORDER BY lastmodified desc", ["DOC", "HR"]), '(type=page) AND (space = "DOC" OR space = "HR") ORDER BY lastmodified desc');
    assert.equal(buildCql("type=page", [String.raw`A\ "B"`]), String.raw`(type=page) AND (space = "A\\ \"B\"")`);
  });

  it("replaces one section up to the next heading of the same level", () => {
    assert.equal(replaceSection(PAGE.body.storage.value, "Goals", "<p>new</p>"), "<h1>Intro</h1><p>a</p><h2>Goals</h2><p>new</p><h2>Risks</h2><p>r</p>");
    assert.throws(() => replaceSection(PAGE.body.storage.value, "Missing", "x"), /Heading not found/);
  });

  it("renders a unified diff with hunks only", () => {
    const d = unifiedDiff(["a", "b", "c", "d"], ["a", "B", "c", "d"], "v1", "v2");
    assert.equal(d, "--- v1\n+++ v2\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c");
    assert.equal(unifiedDiff(["x"], ["x"], "v1", "v2"), "(no changes)");
  });
});

describe("read tools", () => {
  it("notes attachments once on page and historical Markdown bodies", async () => {
    const attachmentPage = { ...PAGE, body: { storage: { value: '<p>Before</p><ac:image><ri:attachment ri:filename="diagram.png" /></ac:image><ac:image><ri:attachment ri:filename="details.png" /></ac:image>' } } };
    for (const [name, args] of [
      ["confluence_get_page", { page: "123" }],
      ["confluence_get_page_history", { page: "123", version: 4 }],
    ] as const) {
      const { value } = await run(name, args, () => ({ body: attachmentPage }));
      assert.equal(value.note.match(/confluence_download_content_attachments/g).length, 1);
      assert.match(value.body, /!\[\]\(diagram\.png\)/);
    }
    const outline = await run("confluence_get_page", { page: "123", outline: true }, () => ({ body: PAGE }));
    assert.equal(outline.value.note, undefined);
  });

  it("reads an attachment image, edits text and writes the image back as ri:attachment", async () => {
    let current = { ...PAGE, body: { storage: { value: '<p>Before</p><ac:image ac:alt="Diagram"><ri:attachment ri:filename="diagram (v2) 100%.png" /></ac:image>' } } };
    const responder = (call: Call) => {
      if (call.method === "PUT") {
        current = { ...current, version: { ...current.version, number: 5 }, body: call.body.body };
        return { body: { id: current.id } };
      }
      return { body: current };
    };
    const read = await run("confluence_get_page", { page: "123" }, responder);
    const update = await run("confluence_update_page", { page: "123", content: read.value.body.replace("Before", "After"), if_version: 4, dry_run: false }, responder);
    assert.equal(update.error, undefined);
    assert.match(current.body.storage.value, /<p>After<\/p>/);
    assert.match(current.body.storage.value, /<ri:attachment ri:filename="diagram \(v2\) 100%\.png" \/>/);
    assert.doesNotMatch(current.body.storage.value, /ri:url/);
  });

  it("search strips highlight markers and asks for no excerpts", async () => {
    const { value, calls } = await run("confluence_search", { query: "plan", limit: 2 }, () => ({
      body: {
        totalSize: 3,
        results: [{ content: { id: "1", type: "page", title: "@@@hl@@@Plan@@@endhl@@@ 2026", space: { key: "DOC" }, version: { when: "2026-10-01" } } }],
        _links: { next: "/n" },
      },
    }));
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/rest/api/search");
    assert.equal(url.searchParams.get("excerpt"), "none");
    assert.equal(url.searchParams.get("cql"), 'siteSearch ~ "plan"');
    assert.deepEqual(value.items[0], { id: "1", title: "Plan 2026", type: "page", space: "DOC", updated: "2026-10-01", excerpt: undefined });
    assert.equal(value.nextOffset, 1);
  });

  it("get_page by title returns metadata only with body_format=none", async () => {
    const { value, calls } = await run("confluence_get_page", { title: "Plan", space_key: "DOC", body_format: "none" }, () => ({ body: { results: [PAGE] } }));
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, "/rest/api/content");
    assert.equal(url.searchParams.get("expand"), "version,space,ancestors");
    assert.equal(value.version, 4);
    assert.equal(value.parent, "100 Home");
    assert.equal(value.body, undefined);
    assert.equal(value.url, "https://wiki.example.com/pages/viewpage.action?pageId=123");
  });

  it("page tree is an indented list", async () => {
    const { value } = await run("confluence_get_space_page_tree", { space_key: "DOC" }, () => ({
      body: { results: [{ id: "1", title: "Home", ancestors: [] }, { id: "2", title: "Child", ancestors: [{ id: "1" }] }] },
    }));
    assert.equal(value.tree, "1 Home\n  2 Child");
  });

  it("history without version lists versions", async () => {
    const { value, calls } = await run("confluence_get_page_history", { page: "123" }, () => ({
      body: { results: [{ number: 4, when: "t", by: { username: "ivan" }, message: "fix", minorEdit: false }] },
    }));
    assert.equal(new URL(calls[0].url).pathname, "/rest/api/content/123/version");
    assert.deepEqual(value.items[0], { number: 4, when: "t", by: "ivan", message: "fix", minor: undefined });
  });

  it("restrictions are users and groups per operation", async () => {
    const { value } = await run("confluence_get_page_restrictions", { page: "123" }, () => ({
      body: { read: { restrictions: { user: { results: [{ username: "a" }] }, group: { results: [] } } }, update: { restrictions: { group: { results: [{ name: "g" }] } } } },
    }));
    assert.deepEqual(value, { read: { users: ["a"], groups: [] }, update: { users: [], groups: ["g"] } });
  });
});

describe("write tools", () => {
  it("refuses Markdown code cut markers before requests for create, update and section writes", async () => {
    const code = Array.from({ length: 201 }, (_, i) => `line ${i}`).join("\n");
    const content = storageToMarkdown(`<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`);
    for (const [name, args] of [
      ["confluence_create_page", { space_key: "DOC", title: "T", content }],
      ["confluence_update_page", { page: "123", content }],
      ["confluence_update_page_section", { page: "123", heading: "Goals", new_content: content }],
    ] as const) {
      const result = await run(name, args, () => ({ body: PAGE }));
      assert.equal(result.error?.type, "ValidationError", name);
      assert.match(result.error?.message ?? "", /cut in a read/);
      assert.match(result.error?.message ?? "", /body_format=storage/);
      assert.equal(result.calls.length, 0, name);
    }
  });

  it("applies code cut protection to Markdown content files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-cut-"));
    const file = join(dir, "body.md");
    writeFileSync(file, `*(+1 lines: ${CODE_CUT_MARKER}; read it with body_format=storage or section before editing)*`);
    const result = await run("confluence_update_page", { page: "123", content_file: file });
    assert.equal(result.error?.type, "ValidationError");
    assert.equal(result.calls.length, 0);
  });

  it("keeps explicit storage bodies containing marker text available", async () => {
    const storage = `<p>${CODE_CUT_MARKER}</p>`;
    const result = await run("confluence_update_page", { page: "123", content: storage, content_format: "storage" }, () => ({ body: PAGE }));
    assert.equal(result.error, undefined);
    assert.equal(result.value.request.body.body.storage.value, storage);
  });

  it("allows a complete Markdown code block at the 200-line read boundary", async () => {
    const code = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    const content = storageToMarkdown(`<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[${code}]]></ac:plain-text-body></ac:structured-macro>`);
    const result = await run("confluence_update_page", { page: "123", content }, () => ({ body: PAGE }));
    assert.equal(result.error, undefined);
    assert.match(result.value.request.body.body.storage.value, /line 199/);
  });

  it("update dry run reads the page, bumps the version and sends nothing", async () => {
    const { value, calls } = await run("confluence_update_page", { page: "123", content: "<p>x</p>", content_format: "storage" }, () => ({ body: PAGE }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(value.dry_run, true);
    assert.equal(value.request.method, "PUT");
    assert.deepEqual(value.request.body.version, { number: 5, minorEdit: false });
    assert.equal(value.request.body.title, "Plan");
  });

  it("update refuses a stale if_version with exit code 5", async () => {
    const { error } = await run("confluence_update_page", { page: "123", content: "x", content_format: "storage", if_version: 3 }, () => ({ body: PAGE }));
    assert.equal(error!.type, "StaleVersion");
    assert.equal(exitCodeFor(error!), 5);
  });

  it("update executes and reports the new version", async () => {
    let n = 0;
    const { value, calls } = await run("confluence_update_page", { page: "123", content: "x", content_format: "storage", if_version: 4, dry_run: false }, (c) => {
      n++;
      if (c.method === "PUT") return { body: { id: "123" } };
      return { body: n > 2 ? { ...PAGE, version: { number: 5 } } : PAGE };
    });
    assert.deepEqual(calls.map((c) => c.method), ["GET", "PUT", "GET"]);
    assert.match(value.summary, /→ v5$/);
    assert.equal(value.result.version, 5);
  });

  it("reads content_file and validates exactly one body source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pg-"));
    writeFileSync(join(dir, "b.xml"), "<p>from file</p>");
    const { value } = await run("confluence_create_page", { space_key: "DOC", title: "T", content_file: join(dir, "b.xml"), content_format: "storage", parent: "100" });
    assert.equal(value.request.body.body.storage.value, "<p>from file</p>");
    assert.deepEqual(value.request.body.ancestors, [{ id: "100" }]);
    const both = await run("confluence_create_page", { space_key: "DOC", title: "T", content: "a", content_file: "b" });
    assert.equal(both.error!.type, "ValidationError");
  });

  it("section update keeps the rest of the page", async () => {
    const { value } = await run("confluence_update_page_section", { page: "123", heading: "Goals", new_content: "<p>new</p>", content_format: "storage" }, () => ({ body: PAGE }));
    assert.equal(value.request.body.body.storage.value, "<h1>Intro</h1><p>a</p><h2>Goals</h2><p>new</p><h2>Risks</h2><p>r</p>");
  });

  it("restrictions are replaced with DC usernames", async () => {
    const { value } = await run("confluence_set_page_restrictions", { page: "123", read_users: "ivan", edit_groups: ["doc-editors"] });
    assert.deepEqual(value.request.body, [
      { operation: "read", restrictions: { user: [{ type: "known", username: "ivan" }], group: [] } },
      { operation: "update", restrictions: { user: [], group: [{ type: "group", name: "doc-editors" }] } },
    ]);
  });

  it("move looks up the target space and calls movepage.action", async () => {
    const { value } = await run("confluence_move_page", { page: "123", target: "200" }, () => ({ body: { id: "200", space: { key: "HR" } } }));
    assert.equal(value.request.url, "https://wiki.example.com/pages/movepage.action?spaceKey=HR&pageId=123&targetId=200&position=append");
  });

  it("copy posts the source body as a new page", async () => {
    const { value } = await run("confluence_copy_page", { page: "123", space_key: "HR", title: "Plan copy" }, () => ({ body: PAGE }));
    assert.equal(value.request.method, "POST");
    assert.equal(value.request.body.body.storage.value, PAGE.body.storage.value);
    assert.deepEqual(value.request.body.space, { key: "HR" });
  });

  it("delete moves to trash", async () => {
    const { value } = await run("confluence_delete_page", { page: "123" });
    assert.equal(value.request.url, "https://wiki.example.com/rest/api/content/123");
    assert.equal(value.request.method, "DELETE");
  });
});
