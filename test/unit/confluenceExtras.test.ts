import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { FetchLike } from "../../src/client.js";
import { createContext, runTool } from "../../src/runner.js";
import { confluenceAttachmentTools, isImageAttachment, safeFileName } from "../../src/tools/confluence/attachments.js";
import { confluenceCommentTools } from "../../src/tools/confluence/comments.js";
import { confluenceLabelTools } from "../../src/tools/confluence/labels.js";
import { jiraServiceDeskTools, prepareFieldValues } from "../../src/tools/jira/servicedesk.js";
import type { ToolDef } from "../../src/tools/types.js";
import { TEST_ENV } from "./helpers.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
  form?: Record<string, string>;
}
type Reply = { status?: number; body?: unknown; bytes?: Buffer } | undefined;

/** Fetch double that understands JSON and FormData bodies and binary responses. */
function harness(responder: (c: Call) => Reply = () => undefined) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers };
    if (init.body instanceof FormData) {
      call.form = {};
      for (const [k, v] of init.body.entries()) call.form[k] = typeof v === "string" ? v : `file:${(v as File).name}`;
    } else if (init.body !== undefined) call.body = JSON.parse(init.body);
    calls.push(call);
    const r = responder(call) ?? {};
    const text = r.body === undefined ? "{}" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return {
      status: r.status ?? 200,
      headers: { get: () => null },
      text: async () => text,
      arrayBuffer: async () => {
        const b = r.bytes ?? Buffer.from(text);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    };
  };
  const { ctx } = createContext(fetch, TEST_ENV);
  return { ctx, calls };
}

const all: ToolDef[] = [...jiraServiceDeskTools, ...confluenceCommentTools, ...confluenceLabelTools, ...confluenceAttachmentTools];
const tool = (name: string) => all.find((t) => t.name === name)!;

async function run(name: string, args: Record<string, unknown>, responder?: (c: Call) => Reply) {
  const h = harness(responder);
  const res = await runTool(tool(name), args, h.ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : res.error, calls: h.calls };
}

describe("registry hygiene", () => {
  it("write tools take dry_run, read tools do not; names are prefixed", () => {
    for (const t of all) {
      assert.equal("dry_run" in t.inputShape, !!t.write, t.name);
      assert.ok(t.name.startsWith(`${t.product}_`), t.name);
    }
    assert.equal(all.length, 21);
  });
});

describe("service desk", () => {
  it("finds the service desk of a project across pages with the opt-in header", async () => {
    const r = await run("jira_get_service_desk_for_project", { project_key: "itsm" }, (c) => {
      assert.equal(c.headers["X-ExperimentalApi"], "opt-in");
      const start = Number(new URL(c.url).searchParams.get("start"));
      return start === 0
        ? { body: { values: [{ id: "1", projectKey: "HR" }], isLastPage: false } }
        : { body: { values: [{ id: "7", projectKey: "ITSM", projectName: "IT", projectId: "10200" }], isLastPage: true } };
    });
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.value.service_desk, { id: "7", projectId: "10200", projectKey: "ITSM", projectName: "IT" });
  });

  it("returns queue issues as compact issues", async () => {
    const r = await run("jira_get_queue_issues", { service_desk_id: 7, queue_id: 3, include_count: true }, (c) =>
      c.url.includes("/issue?")
        ? { body: { values: [{ key: "ITSM-1", fields: { summary: "VPN", status: { name: "Open" } } }], isLastPage: true } }
        : { body: { id: "3", name: "Unassigned", issueCount: 1 } },
    );
    assert.equal(r.value.queue, "Unassigned");
    assert.equal(r.value.items[0].key, "ITSM-1");
    assert.equal(r.value.items[0].status, "Open");
    assert.match(r.calls.find((c) => c.url.includes("/issue?"))!.url, /\/rest\/servicedeskapi\/servicedesk\/7\/queue\/3\/issue\?start=0&limit=50$/);
  });

  const fields = [
    { fieldId: "summary", name: "Summary", required: true, jiraSchema: { type: "string" } },
    { fieldId: "customfield_1", name: "Impact", required: true, jiraSchema: { type: "option" }, validValues: [{ value: "10", label: "High" }, { value: "11", label: "Low" }] },
    { fieldId: "customfield_2", name: "Tags", required: false, jiraSchema: { type: "array", items: "option", custom: "multiselect" }, validValues: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
  ];

  it("validates required fields and maps select labels to ids", () => {
    assert.deepEqual(prepareFieldValues(fields, { summary: "Hi", customfield_1: "high", customfield_2: "A,b", description: "" }), {
      summary: "Hi",
      customfield_1: { id: "10" },
      customfield_2: [{ id: "a" }, { id: "b" }],
    });
    assert.throws(() => prepareFieldValues(fields, { summary: "Hi" }), /Missing required request fields: customfield_1/);
    assert.throws(() => prepareFieldValues(fields, { summary: "Hi", customfield_1: "medium" }), /not a valid value/);
  });

  it("dry-runs a customer request without creating it", async () => {
    const r = await run("jira_create_customer_request", {
      service_desk_id: 7, request_type_id: 12, request_field_values: '{"summary":"VPN down","customfield_1":"Low"}',
    }, () => ({ body: { requestTypeFields: fields } }));
    assert.equal(r.value.dry_run, true);
    assert.equal(r.calls.length, 1); // only the field metadata read
    assert.deepEqual(r.value.request.body.requestFieldValues, { summary: "VPN down", customfield_1: { id: "11" } });
  });

  it("fails when the on-behalf customer is rejected, unless the agent fallback is allowed", async () => {
    const responder = (counter: { posts: number }) => (c: any) => {
      if (c.method === "GET") return { body: { requestTypeFields: fields } };
      counter.posts++;
      return c.body.raiseOnBehalfOf
        ? { status: 400, body: { errorMessage: "The user 'ghost' does not exist" } }
        : { body: { issueKey: "ITSM-9", issueId: "100" } };
    };
    const args = {
      service_desk_id: 7, request_type_id: 12, request_field_values: { summary: "X", customfield_1: "High" },
      raise_on_behalf_of: "ghost", dry_run: false,
    };
    const strict = { posts: 0 };
    const denied = await run("jira_create_customer_request", args, responder(strict));
    assert.equal(denied.res.ok, false);
    assert.equal(strict.posts, 1);

    const lenient = { posts: 0 };
    const r = await run("jira_create_customer_request", { ...args, allow_agent_fallback: true }, responder(lenient));
    assert.equal(lenient.posts, 2);
    assert.equal(r.value.result.key, "ITSM-9");
    assert.equal(r.value.result.created_mode, "created_as_agent_fallback");
  });
});

describe("comments", () => {
  it("lists one server page of comments with depth=all; nextOffset when _links.next", async () => {
    const r = await run("confluence_get_comments", { page_id: 42, limit: 2 }, (c) => {
      assert.match(c.url, /\/rest\/api\/content\/42\/child\/comment\?expand=.*&depth=all&start=0&limit=2$/);
      return {
        body: {
          results: [
            { id: "1", body: { storage: { value: "<p>hi</p>" } }, version: { by: { username: "ivan" }, when: "2026-10-01T10:00:00.000+03:00" }, container: { id: "42", type: "page" } },
            { id: "2", body: { storage: { value: "<p>re</p>" } }, container: { id: "1", type: "comment" }, extensions: { location: "footer" } },
          ],
          _links: { next: "/n" },
        },
      };
    });
    assert.equal(r.calls.length, 1);
    assert.equal(r.value.returned, 2);
    assert.equal(r.value.nextOffset, 2);
    assert.equal(r.value.items[0].author, "ivan");
    assert.equal(r.value.items[0].body, "hi");
    assert.equal(r.value.items[1].body, "re");
    assert.equal(r.value.items[1].parent, "1");
  });

  it("replies under the comment's page", async () => {
    const r = await run("confluence_reply_to_comment", { comment_id: 5, body: "<p>ok</p>" }, () => ({
      body: { id: "5", type: "comment", container: { id: "42", type: "page" } },
    }));
    assert.equal(r.value.dry_run, true);
    assert.deepEqual(r.value.request.body.container, { id: "42", type: "page", status: "current" });
    assert.deepEqual(r.value.request.body.ancestors, [{ id: "5" }]);
    assert.equal(r.value.request.body.body.storage.value, "<p>ok</p>");
  });

  it("builds inline comment properties", async () => {
    const r = await run("confluence_add_inline_comment", { page_id: 42, body: "<p>why?</p>", text_selection: "deadline", match_count: 2, match_index: 1 });
    const props = r.value.request.body.extensions.inlineProperties;
    assert.equal(r.value.request.body.extensions.location, "inline");
    assert.deepEqual([props.originalSelection, props.numMatches, props.matchIndex, props.serializedHighlights], ["deadline", 2, 1, '[["deadline"]]']);
    const bad = await run("confluence_add_inline_comment", { page_id: 42, body: "x", text_selection: "a", match_count: 1, match_index: 1 });
    assert.equal(bad.error?.type, "ValidationError");
  });
});

describe("labels", () => {
  it("adds labels with the array body", async () => {
    const r = await run("confluence_add_label", { content_id: 42, names: "Release Notes,q3" });
    assert.equal(r.value.request.url, "https://wiki.example.com/rest/api/content/42/label");
    assert.deepEqual(r.value.request.body, [{ prefix: "global", name: "release-notes" }, { prefix: "global", name: "q3" }]);
  });
});

describe("attachments", () => {
  it("filters media type server-side and reads extensions.mediaType", async () => {
    const r = await run("confluence_get_attachments", { content_id: 42, media_type: "image/png" }, (c) => {
      assert.match(c.url, /mediaType=image%2Fpng/);
      return { body: { results: [{ id: "att1", title: "a.png", extensions: { mediaType: "image/png", fileSize: 3 } }], _links: {} } };
    });
    const { id, title, mediaType, bytes } = r.value.items[0];
    assert.deepEqual({ id, title, mediaType, bytes }, { id: "att1", title: "a.png", mediaType: "image/png", bytes: 3 });
  });

  it("uploads with file/comment/minorEdit and versions a duplicate name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    const file = join(dir, "report.pdf");
    writeFileSync(file, "pdf");
    const r = await run("confluence_upload_attachment", { content_id: 42, file_path: file, comment: "v2", dry_run: false }, (c) => {
      if (c.method === "GET") return { body: { results: [{ id: "att9" }] } };
      if (c.url.endsWith("/child/attachment")) return { status: 400, body: { message: "Cannot add a new attachment with same file name as an existing attachment: report.pdf" } };
      return { body: { results: [{ id: "att9", title: "report.pdf", version: { number: 2 } }] } };
    });
    assert.equal(r.res.ok, true);
    const posts = r.calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts[0].form, { file: "file:report.pdf", comment: "v2", minorEdit: "false" });
    assert.match(posts[1].url, /\/child\/attachment\/att9\/data$/);
    assert.equal(r.value.result.uploaded[0].action, "new version");
  });

  it("reports a failed upload as an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    const file = join(dir, "x.txt");
    writeFileSync(file, "x");
    const r = await run("confluence_upload_attachment", { content_id: 42, file_path: file, dry_run: false }, () => ({ status: 403, body: { message: "no" } }));
    assert.equal(r.res.ok, false);
  });

  it("dry-run fails early on a missing local file", async () => {
    const r = await run("confluence_upload_attachments", { content_id: 42, file_paths: "/nope/missing.txt" });
    assert.equal(r.error?.type, "ValidationError");
    assert.equal(r.calls.length, 0);
  });

  it("downloads images to output_dir with safe names and never inlines bytes", async () => {
    const out = mkdtempSync(join(tmpdir(), "img-"));
    const r = await run("confluence_get_page_images", { content_id: 42, output_dir: out }, (c) => {
      if (c.url.includes("/child/attachment")) {
        return { body: { results: [
          { id: "att1", title: "../evil.png", extensions: { mediaType: "image/png", fileSize: 4 }, _links: { download: "/download/attachments/42/evil.png" } },
          { id: "att2", title: "doc.pdf", extensions: { mediaType: "application/pdf" }, _links: { download: "/download/attachments/42/doc.pdf" } },
          { id: "att3", title: "scan.JPG", extensions: { mediaType: "application/octet-stream" }, _links: { download: "/download/attachments/42/scan.JPG" } },
        ], _links: {} } };
      }
      return { bytes: Buffer.from("IMG!") };
    });
    assert.equal(r.value.downloaded, 2);
    for (const item of r.value.items) {
      assert.ok(item.path.startsWith(out), item.path);
      assert.equal(readFileSync(item.path, "utf8"), "IMG!");
    }
    assert.ok(existsSync(join(out, "evil.png")));
    assert.equal(JSON.stringify(r.value).includes("SU1HIQ"), false); // no base64 of the bytes
  });

  it("skips oversized attachments", async () => {
    const out = mkdtempSync(join(tmpdir(), "big-"));
    const r = await run("confluence_download_attachment", { attachment_id: "att1", output_dir: out }, () => ({
      body: { id: "att1", title: "huge.iso", extensions: { fileSize: 60 * 1024 * 1024 }, _links: { download: "/download/attachments/42/huge.iso" } },
    }));
    assert.equal(r.error?.type, "ValidationError");
    assert.equal(r.calls.length, 1);
  });

  it("helpers", () => {
    assert.equal(safeFileName("a/b\\c:d.png", "x"), "b_c_d.png");
    assert.equal(safeFileName("..", "att1"), "att1");
    assert.equal(isImageAttachment({ title: "x.svg" }), true);
    assert.equal(isImageAttachment({ title: "x.png", extensions: { mediaType: "application/pdf" } }), false);
  });
});
