import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { redact } from "../../src/tools/jira/scriptrunner.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/scriptrunner/${name}.json`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const SR = "/rest/scriptrunner/latest";
const SJ = "/rest/scriptrunner-jira/latest";
const SECRETS = ["log.info", "return true", "return 1", "s3cret", "secret", "select * from", "abc\""];

/** Fake Jira + ScriptRunner keeping items in memory; `tamper` alters the script on save. */
function fakeSr(opts: { jira?: string; sr?: string; enabled?: boolean; upm?: number; tamper?: boolean } = {}) {
  const store: Record<string, any[]> = {
    [`${SR}/scheduled-jobs`]: fx("jobs"),
    [`${SR}/fragments`]: fx("fragments"),
    [`${SR}/resources`]: fx("resources"),
    [`${SJ}/listeners`]: fx("listeners"),
    [`${SR}/custom/customadmin`]: fx("endpoints"),
    [`${SJ}/scriptfields`]: fx("fields"),
    [`${SR}/scriptSearch`]: fx("registry"),
  };
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/serverInfo") return { body: { version: opts.jira ?? "11.3.7" } };
    if (p === "/rest/plugins/1.0/com.onresolve.jira.groovy.groovyrunner-key") {
      if (opts.upm) return { status: opts.upm, body: {} };
      return { body: { key: "com.onresolve.jira.groovy.groovyrunner", version: opts.sr ?? "10.14.0", enabled: opts.enabled ?? true } };
    }
    for (const base of Object.keys(store)) {
      if (p === base && c.method === "GET") return { body: store[base] };
      const m = new RegExp(`^${base}/([^/]+)$`).exec(p);
      if (!m) continue;
      const items = store[base];
      if (c.method === "GET") return { body: items.find((x) => x.id === decodeURIComponent(m[1])) };
      if (c.method === "POST") {
        const body = c.body;
        const i = items.findIndex((x) => x.id === body.id);
        const saved = { ...body, version: (body.version ?? 0) + 1 };
        if (opts.tamper && saved.FIELD_JOB_CODE) saved.FIELD_JOB_CODE = { ...saved.FIELD_JOB_CODE, scriptPath: "other.groovy" };
        items[i] = saved;
        return { body: saved };
      }
    }
    return undefined;
  };
  return { responder, store };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

const noSecrets = (v: unknown) => {
  const text = JSON.stringify(v);
  for (const s of SECRETS) assert.ok(!text.includes(s), `output leaks '${s}': ${text.slice(0, 300)}`);
};

describe("discovery and support matrix (1.2)", () => {
  it("allows all Jira 10/11 and ScriptRunner 9/10 combinations", async () => {
    for (const jira of ["10.0.0", "10.3.6", "10.99.99", "11.0.0", "11.3.6", "11.99.99"]) {
      for (const sr of ["9.0.0", "9.99.99", "10.0.0", "10.13.2", "10.99.99"]) {
        const r = await run("jira_list_scriptrunner_items", { type: "job" }, fakeSr({ jira, sr }).responder);
        assert.ok(r.res.ok, `${jira} + ${sr}: ${JSON.stringify(r.error)}`);
        assert.ok(r.calls.some((c) => path(c).startsWith("/rest/scriptrunner")));
      }
    }
  });

  it("refuses versions outside the allowed majors before any ScriptRunner request", async () => {
    const ok = await run("jira_list_scriptrunner_items", { type: "job" }, fakeSr().responder);
    assert.ok(ok.res.ok, JSON.stringify(ok.error));
    for (const [opts, re] of [[{ sr: "8.99.0" }, /8\.99\.0/], [{ sr: "11.0.0" }, /11\.0\.0/], [{ jira: "9.99.0" }, /9\.99\.0/], [{ jira: "12.0.0" }, /12\.0\.0/], [{ sr: "10.invalid" }, /10\.invalid/], [{ jira: "11.invalid" }, /11\.invalid/], [{ enabled: false }, /disabled/], [{ upm: 404 }, /not installed/]] as const) {
      const r = await run("jira_list_scriptrunner_items", { type: "job" }, fakeSr(opts as any).responder);
      assert.equal(r.error.type, "Unsupported", JSON.stringify(r.error));
      assert.match(r.error.message, re);
      assert.ok(!r.calls.some((c) => path(c).startsWith("/rest/scriptrunner")), "no ScriptRunner request");
    }
  });

  it("keeps 401/403 from discovery as authorization errors", async () => {
    const r = await run("jira_list_scriptrunner_items", { type: "job" }, fakeSr({ upm: 403 }).responder);
    assert.equal(r.error.type, "HTTP403");
  });
});

describe("redaction (1.3)", () => {
  it("removes executable and credential keys at any depth", () => {
    const out = redact({ a: { script: "x", scriptPath: "y", nested: [{ dataSourcePassword: "p", jdbcUrl: "j", keep: 1 }] }, previewSql: "s", FIELD_LINK_CONDITION: {}, name: "n" });
    assert.deepEqual(out, { a: { nested: [{ keep: 1 }] }, name: "n" });
  });
});

describe("reads (2.1, 2.2)", () => {
  it("lists every type with allowlisted fields only", async () => {
    const sr = fakeSr();
    const expect: Record<string, string[]> = {
      job: ["Close stale requests"], listener: ["Notify on create"], field: ["Computed age"], fragment: ["Help link"],
      endpoint: ["doSomething"], resource: ["reporting"], registry: ["sample_job.groovy", "helper.groovy"],
    };
    for (const [type, names] of Object.entries(expect)) {
      const r = await run("jira_list_scriptrunner_items", { type }, sr.responder);
      assert.ok(r.res.ok, `${type}: ${JSON.stringify(r.error)}`);
      assert.deepEqual(r.value.items.map((i: any) => i.name), names, type);
      noSecrets(r.value);
    }
    const job = (await run("jira_list_scriptrunner_items", { type: "job" }, sr.responder)).value.items[0];
    assert.deepEqual(job, { id: "job-1", name: "Close stale requests", kind: "JiraCustomScheduledJob", schedule: "CRON 0 0 2 * * ?", runAs: "automation", disabled: false, nextRun: new Date(1790000000000).toISOString(), notes: "Nightly cleanup" });
    const res = (await run("jira_get_scriptrunner_item", { type: "resource", item: "reporting" }, sr.responder)).value;
    assert.deepEqual(Object.keys(res).sort(), ["disabled", "driver", "id", "kind", "name", "readOnly"]);
  });

  it("answers unsupported for Mail Handler, Behaviours and resource changes without ScriptRunner requests", async () => {
    for (const type of ["mail-handler", "behaviour"]) {
      const r = await run("jira_list_scriptrunner_items", { type }, fakeSr().responder);
      assert.equal(r.error.type, "Unsupported", type);
      assert.ok(!r.calls.some((c) => path(c).startsWith("/rest/scriptrunner")));
    }
    const res = await run("jira_update_scriptrunner_item", { type: "resource", item: "reporting", disabled: true }, fakeSr().responder);
    assert.equal(res.error.type, "Unsupported");
  });
});

describe("enable/disable and notes (3.1, 3.2)", () => {
  it("disables a job by sending the stored item back with only `disabled` changed, and reads it back", async () => {
    const sr = fakeSr();
    const dry = await run("jira_update_scriptrunner_item", { type: "job", item: "Close stale requests", disabled: true }, sr.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.deepEqual(dry.value.change, { disabled: { from: false, to: true } });
    noSecrets(dry.value);
    const r = await run("jira_update_scriptrunner_item", { type: "job", item: "job-1", disabled: true, dry_run: false }, sr.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const post = r.calls.find((c) => c.method === "POST")!;
    assert.equal(path(post), `${SR}/scheduled-jobs/com.onresolve.scriptrunner.canned.jira.jobs.JiraCustomScheduledJob`);
    const original = fx("jobs")[0];
    assert.deepEqual(post.body, { ...original, disabled: true });
    assert.equal(sr.store[`${SR}/scheduled-jobs`][0].disabled, true);
    noSecrets(r.value);
    assert.ok(!r.calls.some((c) => /\/(params|preview|validate)$|user\/exec|canned\//.test(path(c))), "nothing runs");
    assert.equal((await run("jira_update_scriptrunner_item", { type: "job", item: "job-1", disabled: true }, sr.responder)).value.already_satisfied, true);
  });

  it("changes notes of a listener and a fragment", async () => {
    const sr = fakeSr();
    assert.ok((await run("jira_update_scriptrunner_item", { type: "listener", item: "Notify on create", notes: "Owned by ops", dry_run: false }, sr.responder)).res.ok);
    assert.equal(sr.store[`${SJ}/listeners`][0].FIELD_LISTENER_NOTES, "Owned by ops");
    assert.ok((await run("jira_update_scriptrunner_item", { type: "fragment", item: "frag-1", notes: "Temporary", disabled: true, dry_run: false }, sr.responder)).res.ok);
    assert.equal(sr.store[`${SR}/fragments`][0].disabled, true);
  });

  it("fails verification when the server changed an executable part", async () => {
    const r = await run("jira_update_scriptrunner_item", { type: "job", item: "job-1", disabled: true, dry_run: false }, fakeSr({ tamper: true }).responder);
    assert.equal(r.error.type, "VerificationError");
    assert.match(r.error.message, /FIELD_JOB_CODE/);
    noSecrets(r.error);
  });

  it("rejects disabling types without the flag and changes outside the allowlist", async () => {
    const lis = await run("jira_update_scriptrunner_item", { type: "listener", item: "lis-1", disabled: true }, fakeSr().responder);
    assert.equal(lis.res.ok, false);
    const field = await run("jira_update_scriptrunner_item", { type: "field", item: "fld-1", notes: "x" }, fakeSr().responder);
    assert.equal(field.res.ok, false);
    const extra = await run("jira_update_scriptrunner_item", { type: "job", item: "job-1", script: "evil" }, fakeSr().responder);
    assert.equal(extra.res.ok, false);
  });
});
