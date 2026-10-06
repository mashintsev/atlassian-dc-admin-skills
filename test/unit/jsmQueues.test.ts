import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jsm11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const FIELDS = [
  { id: "issuekey", name: "Key" }, { id: "summary", name: "Summary" }, { id: "status", name: "Status" },
  { id: "customfield_10700", name: "Severity" }, { id: "customfield_10120", name: "Time to first response" },
];

export function fakeQueues(opts: { ignoreReorder?: boolean } = {}) {
  const queues: any[] = fx("queues.json").values;
  let next = 70;
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/servicedeskapi/servicedesk") return { body: { isLastPage: true, values: [{ id: "3", projectId: "10100", projectKey: "BANK", projectName: "Bank" }] } };
    if (p === "/rest/api/2/field") return { body: FIELDS };
    if (p === "/rest/servicedeskapi/servicedesk/3/queue") {
      if (c.method === "GET") return { body: { isLastPage: true, values: queues } };
      const q = { id: String(next++), ...c.body };
      queues.push(q);
      return { body: q };
    }
    if (p === "/rest/servicedeskapi/servicedesk/3/queue/reorder") {
      if (opts.ignoreReorder) return { body: queues };
      const ids: number[] = c.body;
      queues.sort((x, y) => ids.indexOf(Number(x.id)) - ids.indexOf(Number(y.id)));
      return { body: queues };
    }
    const m = /^\/rest\/servicedeskapi\/servicedesk\/3\/queue\/(\d+)$/.exec(p);
    if (m) {
      const i = queues.findIndex((q) => q.id === m[1]);
      if (c.method === "GET") return { body: queues[i] };
      if (c.method === "POST") { queues[i] = { ...queues[i], ...c.body }; return { body: queues[i] }; }
      if (c.method === "DELETE") { queues.splice(i, 1); return { status: 204 }; }
    }
    return undefined;
  };
  return { responder, queues };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("queues (2.1)", () => {
  const create = { service_desk: "BANK", name: "Bank incidents — open", jql: "project = BANK AND resolution = EMPTY", columns: "Key,Summary,Severity,Time to first response" };

  it("creates a queue with columns resolved by name and reads it back; re-run is satisfied", async () => {
    const q = fakeQueues();
    const dry = await run("jira_create_queue", create, q.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, { name: create.name, jql: create.jql, fields: ["issuekey", "summary", "customfield_10700", "customfield_10120"] });
    const r = await run("jira_create_queue", { ...create, dry_run: false }, q.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(r.value.result.fields, ["issuekey", "summary", "customfield_10700", "customfield_10120"]);
    assert.equal((await run("jira_create_queue", create, q.responder)).value.already_satisfied, true);
  });

  it("stops on an unknown column and on a name with other settings", async () => {
    const bad = await run("jira_create_queue", { ...create, columns: "Key,Moon" }, fakeQueues().responder);
    assert.match(bad.error.message, /Moon/);
    const clash = await run("jira_create_queue", { ...create, name: "Unassigned" }, fakeQueues().responder);
    assert.match(clash.error.message, /jira_update_queue/);
  });

  it("updates JQL and columns with old and new values, and deletes", async () => {
    const q = fakeQueues();
    const dry = await run("jira_update_queue", { service_desk: "BANK", queue: "Unassigned", jql: "project = BANK AND assignee is EMPTY", columns: "Key,Summary" }, q.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.before.jql, "project = BANK AND resolution is EMPTY AND assignee is EMPTY");
    assert.deepEqual(dry.value.after.fields, ["issuekey", "summary"]);
    assert.ok((await run("jira_update_queue", { service_desk: "BANK", queue: 66, jql: "project = BANK AND assignee is EMPTY", dry_run: false }, q.responder)).res.ok);
    assert.equal(q.queues.find((x) => x.id === "66").jql, "project = BANK AND assignee is EMPTY");
    assert.ok((await run("jira_delete_queue", { service_desk: "BANK", queue: "Unassigned", dry_run: false }, q.responder)).res.ok);
    assert.equal((await run("jira_delete_queue", { service_desk: "BANK", queue: "Unassigned" }, q.responder)).value.already_satisfied, true);
  });
});

describe("queue order (2.2)", () => {
  it("moves a queue to a position or after another, sending the full order of ids", async () => {
    const q = fakeQueues();
    const dry = await run("jira_move_queue", { service_desk: "BANK", queue: "All open", position: 1 }, q.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.request.body, [67, 65, 66]);
    assert.deepEqual(dry.value.after, ["All open", "Assigned to me", "Unassigned"]);
    assert.ok((await run("jira_move_queue", { service_desk: "BANK", queue: "All open", position: 1, dry_run: false }, q.responder)).res.ok);
    assert.deepEqual(q.queues.map((x) => x.id), ["67", "65", "66"]);
    assert.equal((await run("jira_move_queue", { service_desk: "BANK", queue: 67, position: 1 }, q.responder)).value.already_satisfied, true);
  });

  it("applies two moves in one plan without drift", async () => {
    const q = fakeQueues();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    for (const a of [{ queue: "All open", position: 1 }, { queue: "Assigned to me", after: "Unassigned" }]) {
      const args = { service_desk: "BANK", ...a };
      const r = await run("jira_move_queue", args, q.responder);
      addResultToPlan(file, "jira_move_queue", args, r.value);
    }
    const out = await applyPlan(testContext(q.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"]);
    assert.deepEqual(q.queues.map((x) => x.name), ["All open", "Unassigned", "Assigned to me"]);
  });

  it("fails verification when Jira does not apply the order", async () => {
    const r = await run("jira_move_queue", { service_desk: "BANK", queue: "All open", position: 1, dry_run: false }, fakeQueues({ ignoreReorder: true }).responder);
    assert.equal(r.error.type, "VerificationError");
  });
});
