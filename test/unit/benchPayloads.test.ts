import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { benchResponder } from "../bench/payloads.js";
import type { Call } from "./helpers.js";

const call = (url: string): Call => ({ url, method: "GET", headers: {} });

describe("benchmark payloads (read-token-benchmark)", () => {
  it("honor the requested fields, page size and expand like Jira", () => {
    const { responder } = benchResponder();
    const page: any = responder(call("https://jira.example.com/rest/api/2/search?jql=x&fields=summary,status&maxResults=3"))!.body;
    assert.equal(page.issues.length, 3);
    assert.deepEqual(Object.keys(page.issues[0].fields).sort(), ["status", "summary"]);
    const all: any = responder(call("https://jira.example.com/rest/api/2/search?jql=x&fields=*all&maxResults=1"))!.body;
    assert.ok(Object.keys(all.issues[0].fields).length > 40);
    const issue: any = responder(call("https://jira.example.com/rest/api/2/issue/PRJ1-1?expand=changelog"))!.body;
    assert.equal(issue.changelog.histories.length, 20);
    assert.equal((responder(call("https://jira.example.com/rest/api/2/issue/PRJ1-1")) as any).body.changelog, undefined);
  });

  it("are deterministic and report unrouted paths", () => {
    const a = benchResponder().responder(call("https://wiki.example.com/rest/api/content/5999"));
    const b = benchResponder().responder(call("https://wiki.example.com/rest/api/content/5999"));
    assert.deepEqual(a, b);
    const r = benchResponder();
    r.responder(call("https://jira.example.com/rest/nowhere"));
    assert.deepEqual([...r.unrouted], ["/rest/nowhere"]);
  });
});
