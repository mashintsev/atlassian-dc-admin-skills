import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => new URL(c.url).pathname;

/** A page 100 with labels; DELETE removes one (unless `ignore` names it). */
function fakePage(labels: Array<{ prefix: string; name: string }>, opts: { ignore?: string } = {}) {
  const state = labels.map((l) => ({ ...l }));
  const responder = (c: Call) => {
    const p = path(c);
    const del = /^\/rest\/api\/content\/100\/label\/(.+)$/.exec(p);
    if (del && c.method === "DELETE") {
      const name = decodeURIComponent(del[1]!);
      if (name !== opts.ignore) {
        const i = state.findIndex((l) => l.name === name);
        if (i >= 0) state.splice(i, 1);
      }
      return { status: 204, body: "" };
    }
    if (p === "/rest/api/content/100/label") return { body: { results: state.map((l, i) => ({ id: String(i), ...l })), size: state.length, _links: {} } };
    if (p === "/rest/api/content/100") return { body: { id: "100", type: "page", title: "Page" } };
    if (/^\/rest\/api\/content\/\d+/.test(p)) return { status: 404, body: { message: "not found" } };
    return undefined;
  };
  return { responder, state };
}

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(tool, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

describe("confluence_remove_label (5.1)", () => {
  it("removes one label and keeps the others", async () => {
    const page = fakePage([{ prefix: "global", name: "draft" }, { prefix: "global", name: "howto" }]);
    const dry = await run("confluence_remove_label", { content_id: "100", names: "draft" }, page.responder);
    assert.equal(dry.value?.dry_run, true, JSON.stringify(dry.error ?? dry.value));
    assert.equal(dry.value.request.method, "DELETE");
    assert.equal(path({ url: dry.value.request.url } as Call), "/rest/api/content/100/label/draft");
    assert.equal(writes(dry.calls).length, 0);
    const r = await run("confluence_remove_label", { content_id: "100", names: "draft", dry_run: false }, page.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(page.state.map((l) => l.name), ["howto"]);
  });

  it("reports labels that are not there as already satisfied, sending nothing", async () => {
    const page = fakePage([{ prefix: "global", name: "howto" }]);
    const r = await run("confluence_remove_label", { content_id: "100", names: "draft", dry_run: false }, page.responder);
    assert.equal(r.value?.already_satisfied, true, JSON.stringify(r.error ?? r.value));
    assert.equal(writes(r.calls).length, 0);
  });

  it("plans one item per label", async () => {
    const page = fakePage([{ prefix: "global", name: "a" }, { prefix: "global", name: "b" }, { prefix: "global", name: "keep" }]);
    const dry = await run("confluence_remove_label", { content_id: "100", names: "a,b,missing" }, page.responder);
    assert.equal(dry.value?.batch?.length, 2, JSON.stringify(dry.value ?? dry.error));
    const file = join(mkdtempSync(join(tmpdir(), "labels-")), "plan.json");
    addResultToPlan(file, "confluence_remove_label", { content_id: "100", names: "a,b,missing" }, dry.value);
    assert.deepEqual(readPlan(file).items.map((i) => i.args.names), [["a"], ["b"]]);
  });

  it("refuses category names and space keys", async () => {
    const page = fakePage([]);
    const team = await run("confluence_remove_label", { content_id: "100", names: "team:ops" }, page.responder);
    assert.equal(team.error?.type, "ValidationError");
    assert.match(team.error.message, /confluence_remove_space_category/);
    const space = await run("confluence_remove_label", { content_id: "DOC", names: "draft" }, page.responder);
    assert.equal(space.error?.type, "ValidationError");
    assert.equal(space.calls.length, 0);
    const unknown = await run("confluence_remove_label", { content_id: "999", names: "draft" }, page.responder);
    assert.equal(unknown.error?.type, "ValidationError");
    assert.match(unknown.error.message, /No page, blog post or attachment/);
  });

  it("fails verification when the label is still there afterwards", async () => {
    const page = fakePage([{ prefix: "global", name: "draft" }, { prefix: "global", name: "howto" }], { ignore: "draft" });
    const r = await run("confluence_remove_label", { content_id: "100", names: "draft", dry_run: false }, page.responder);
    assert.equal(r.error?.type, "VerificationError");
  });
});

describe("confluence_remove_space_category (5.2)", () => {
  const space = (cats: string[]) => (c: Call) =>
    path(c) === "/rest/api/space/DOC" ? { body: { key: "DOC", metadata: { labels: { results: cats.map((name) => ({ prefix: "team", name })), _links: {} } } } } : undefined;

  it("reports a category the space does not have as already satisfied", async () => {
    const r = await run("confluence_remove_space_category", { space_key: "DOC", name: "legacy" }, space(["ops"]));
    assert.equal(r.value?.already_satisfied, true, JSON.stringify(r.error ?? r.value));
    assert.equal(writes(r.calls).length, 0);
  });

  it("answers Unsupported for a present category and sends nothing, since no removal request is verified", async () => {
    for (const dry_run of [true, false]) {
      const r = await run("confluence_remove_space_category", { space_key: "DOC", name: "legacy", dry_run }, space(["legacy", "ops"]));
      assert.equal(r.error?.type, "Unsupported", JSON.stringify(r.error ?? r.value));
      assert.equal(writes(r.calls).length, 0);
    }
  });
});
