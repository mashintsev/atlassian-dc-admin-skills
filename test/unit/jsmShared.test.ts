import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { requireJsmVersion } from "../../src/jiraVersion.js";
import { resolveRequestType, resolveServiceDesk } from "../../src/tools/jira/requestTypes.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => new URL(c.url).pathname;
const DESKS = { size: 2, isLastPage: true, values: [{ id: "3", projectId: "10503", projectKey: "BANK", projectName: "Bank" }, { id: "4", projectId: "10504", projectKey: "OPS", projectName: "Ops" }] };
const RTS = { size: 3, isLastPage: true, values: [{ id: "83", name: "Bank incident", issueTypeId: "10004" }, { id: "84", name: "Access", issueTypeId: "10001" }, { id: "85", name: "access", issueTypeId: "10001" }] };
const responder = (c: Call) => {
  const p = path(c);
  if (p === "/rest/servicedeskapi/servicedesk") return { body: DESKS };
  if (p === "/rest/servicedeskapi/servicedesk/3") return { body: DESKS.values[0] };
  if (p === "/rest/servicedeskapi/servicedesk/3/requesttype") return { body: RTS };
  return undefined;
};

describe("JSM version gate (2.1)", () => {
  it("accepts JSM 11.3.x once per client and refuses other versions with nothing else sent", async () => {
    const ok = testContext(() => ({ body: { version: "11.3.5-QR-0008", platformVersion: "11.3.6" } }));
    await requireJsmVersion(ok.ctx.client("jira"), "Request type group changes");
    await requireJsmVersion(ok.ctx.client("jira"), "Request type group changes");
    assert.equal(ok.calls.length, 1);
    assert.equal(path(ok.calls[0]), "/rest/servicedeskapi/info");
    const old = testContext(() => ({ body: { version: "10.3.4" } }));
    await assert.rejects(requireJsmVersion(old.ctx.client("jira"), "Request type group changes"), /JSM 11\.3\.x.*10\.3\.4/);
    assert.equal(old.calls.length, 1);
  });
});

describe("service desk and request type references (2.2)", () => {
  it("resolves a service desk by id or project key", async () => {
    const c = testContext(responder).ctx.client("jira");
    assert.equal((await resolveServiceDesk(c, "3")).projectKey, "BANK");
    const byKey = await resolveServiceDesk(c, "ops");
    assert.equal(byKey.id, "4");
    await assert.rejects(resolveServiceDesk(c, "NOPE"), /NOPE/);
  });

  it("resolves request types by id or exact name, pending only in dry runs, ambiguous names fail", async () => {
    const c = testContext(responder).ctx.client("jira");
    const sd = await resolveServiceDesk(c, "BANK");
    assert.equal((await resolveRequestType(c, sd, "83")).name, "Bank incident");
    const byName = await resolveRequestType(c, sd, "bank INCIDENT");
    assert.equal(byName.id, "83");
    assert.deepEqual(byName.ref, { requestType: "bank INCIDENT" });
    const pending = await resolveRequestType(c, sd, "Escalation", { allowPending: true });
    assert.equal(pending.pending, true);
    await assert.rejects(resolveRequestType(c, sd, "Escalation"), /not found/);
    await assert.rejects(resolveRequestType(c, sd, "Access"), /ambiguous/i);
  });
});
