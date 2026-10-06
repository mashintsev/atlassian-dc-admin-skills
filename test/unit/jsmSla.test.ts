import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { formatTarget, parseTarget, parseWorkingHours } from "../../src/tools/jira/sla.js";
import { testContext, type Call } from "./helpers.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/jsm11/${name}`, import.meta.url), "utf8"));
const path = (c: Call) => new URL(c.url).pathname;
const IJ = "/rest/servicedesk/1/servicedesk";

/** Stateful fake JSM for SLA metrics and calendars of service desk 3 / project BANK. */
function fakeJsm(opts: { jsm?: string } = {}) {
  const metrics: any[] = fx("sla-metrics.json").timeMetrics;
  const calendars: any[] = [fx("sla-calendar.json")];
  let nextMetric = 20, nextCal = 10;
  const refs = () => ({ calendars: [...calendars.map((c) => ({ id: c.id, name: c.name, default: false })), { id: -1, name: "Default 24/7 calendar", default: true }] });
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/servicedeskapi/info") return { body: { version: opts.jsm ?? "11.3.5-QR-0008" } };
    if (p === "/rest/servicedeskapi/servicedesk") return { body: { isLastPage: true, values: [{ id: "3", projectId: "10100", projectKey: "BANK", projectName: "Bank" }] } };
    if (p === `${IJ}/BANK/sla/conditions/available`) return { body: fx("sla-conditions-available.json") };
    if (p === `${IJ}/agent/BANK/sla/metrics/calendar-refs`) return { body: refs() };
    if (p === `${IJ}/agent/BANK/sla/metrics`) {
      if (c.method === "GET") return { body: { timeMetrics: metrics } };
      const m = { ...c.body, id: nextMetric++, projectKey: "BANK", customFieldId: 13000 };
      metrics.push(m);
      return { body: m };
    }
    let m = new RegExp(`^${IJ}/agent/BANK/sla/metrics/(\\d+)$`).exec(p);
    if (m) {
      const i = metrics.findIndex((x) => x.id === Number(m![1]));
      if (c.method === "GET") return { body: metrics[i] };
      if (c.method === "PUT") { metrics[i] = { ...metrics[i], ...c.body }; return { body: metrics[i] }; }
      if (c.method === "DELETE") { metrics.splice(i, 1); return { status: 204 }; }
    }
    if (p === `${IJ}/3/sla/calendars`) {
      if (c.method === "GET") return { body: [{ name: "Default 24/7 calendar", inherentlyEditable: false, inherentlyDeletable: false, dependentMetrics: [] }, ...calendars.map((x) => ({ id: x.id, name: x.name, description: x.description, inherentlyEditable: true, inherentlyDeletable: true, dependentMetrics: metrics.filter((mm) => mm.config.goals.some((g: any) => g.calendarId === x.id)).map((mm) => ({ metricId: mm.id, metricName: mm.name })) }))] };
      const cal = { ...c.body, id: nextCal++, workingTimes: c.body.workingTimes.map((w: any, k: number) => ({ ...w, id: 100 + k })) };
      calendars.push(cal);
      return { body: cal };
    }
    m = new RegExp(`^${IJ}/3/sla/calendars/(\\d+)$`).exec(p);
    if (m) {
      const i = calendars.findIndex((x) => x.id === Number(m![1]));
      if (c.method === "GET") return { body: calendars[i] };
      if (c.method === "PUT") { calendars[i] = { ...calendars[i], ...c.body }; return { body: calendars[i] }; }
      if (c.method === "DELETE") { calendars.splice(i, 1); return { status: 204 }; }
    }
    return undefined;
  };
  return { responder, metrics, calendars };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

describe("target and working hours (3.2)", () => {
  it("parses and formats goal targets", () => {
    assert.equal(parseTarget("4h"), 4 * 3600000);
    assert.equal(parseTarget("2d 4h"), 52 * 3600000);
    assert.equal(parseTarget("1h 30m"), 90 * 60000);
    assert.equal(parseTarget("90"), 90 * 60000);
    assert.throws(() => parseTarget("soon"), /soon/);
    assert.equal(formatTarget(52 * 3600000), "2d 4h");
    assert.equal(formatTarget(90 * 60000), "1h 30m");
  });

  it("expands 24x7 and day ranges", () => {
    const all = parseWorkingHours("24x7");
    assert.equal(all.length, 7);
    assert.deepEqual(all[0], { day: "monday", start: 0, end: 86400000, disabled: false });
    const office = parseWorkingHours("mon-fri 09:00-18:00");
    assert.deepEqual(office.map((w) => w.day), ["monday", "tuesday", "wednesday", "thursday", "friday"]);
    assert.equal(office[0].start, 9 * 3600000);
    assert.throws(() => parseWorkingHours("someday"), /someday/);
  });
});

describe("SLA reads (3.1)", () => {
  it("reads metrics with condition names and goals with targets and calendars", async () => {
    const r = await run("jira_get_sla_configuration", { service_desk: "BANK" }, fakeJsm().responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    const ttr = r.value.items.find((m: any) => m.name === "Time to resolution");
    assert.deepEqual(ttr.stop, ["Resolution: Set"]);
    assert.deepEqual(ttr.goals, [{ jql: "priority = Highest", target: "4h", calendar: "Office hours" }, { jql: "All remaining issues", target: "2d", calendar: "Default 24/7 calendar" }]);
  });

  it("lists conditions by kind and calendars with their users", async () => {
    const c = await run("jira_get_sla_conditions", { service_desk: "BANK" }, fakeJsm().responder);
    assert.ok(c.value.startStop.includes("Resolution: Set"));
    assert.ok(c.value.pause.includes("Status: In Review"));
    const cal = await run("jira_list_sla_calendars", { service_desk: "BANK" }, fakeJsm().responder);
    const office = cal.value.find((x: any) => x.name === "Office hours");
    assert.equal(office.timeZone, "Europe/Moscow");
    assert.equal(office.workingHours, "monday–friday 09:00–17:00");
    assert.deepEqual(office.usedBy, ["Time to resolution"]);
  });
});

describe("SLA writes (3.3)", () => {
  const goals = JSON.stringify([{ jql: "priority = Highest", target: "4h", calendar: "24x7" }, { target: "2d" }]);

  it("creates an SLA with conditions and goals, and is satisfied on re-run", async () => {
    const jsm = fakeJsm();
    const args = { service_desk: "BANK", name: "Bank resolution", start: "Issue Created", pause: "Status: Waiting for customer", stop: "Resolution: Set", goals };
    const dry = await run("jira_create_sla", args, jsm.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    const body = dry.value.request.body;
    assert.equal(body.config.definition.stop[0].conditionId, "resolution-set-hit-condition");
    assert.equal(body.config.definition.pause[0].conditionId, "10002");
    assert.deepEqual(body.config.goals, [{ jqlQuery: "priority = Highest", duration: 14400000, calendarId: -1, defaultGoal: false }, { jqlQuery: "", duration: 172800000, defaultGoal: true }]);
    assert.ok((await run("jira_create_sla", { ...args, dry_run: false }, jsm.responder)).res.ok);
    const again = await run("jira_create_sla", args, jsm.responder);
    assert.equal(again.value.already_satisfied, true);
  });

  it("rejects unknown conditions with the available ones, and a default goal that is not last", async () => {
    const bad = await run("jira_create_sla", { service_desk: "BANK", name: "X", start: "Moon phase", stop: "Resolution: Set", goals }, fakeJsm().responder);
    assert.match(bad.error.message, /Moon phase.*Issue Created/);
    const order = await run("jira_create_sla", { service_desk: "BANK", name: "X", start: "Issue Created", stop: "Resolution: Set", goals: JSON.stringify([{ target: "2d" }, { jql: "priority = High", target: "4h" }]) }, fakeJsm().responder);
    assert.match(order.error.message, /last/);
  });

  it("warns about recalculation on update and about lost values on delete", async () => {
    const jsm = fakeJsm();
    const up = await run("jira_update_sla", { service_desk: "BANK", sla: "Time to resolution", goals: JSON.stringify([{ jql: "priority = Highest", target: "2h", calendar: "Office hours" }, { target: "2d" }]) }, jsm.responder);
    assert.match(up.value.warning, /recalculat/);
    const del = await run("jira_delete_sla", { service_desk: "BANK", sla: 6 }, jsm.responder);
    assert.match(del.value.summary, /irreversible|lost/i);
    const old = await run("jira_delete_sla", { service_desk: "BANK", sla: 6 }, fakeJsm({ jsm: "10.3.4" }).responder);
    assert.equal(old.error.type, "Unsupported");
  });
});

describe("calendars (3.4)", () => {
  it("creates a 24x7 calendar, refuses deleting one in use, and plans calendar + SLA using it by name", async () => {
    const jsm = fakeJsm();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    const cal = { service_desk: "BANK", name: "24x7 Moscow", time_zone: "Europe/Moscow", working_hours: "24x7" };
    const dry = await run("jira_create_sla_calendar", cal, jsm.responder);
    assert.ok(dry.res.ok, JSON.stringify(dry.error));
    assert.equal(dry.value.request.body.workingTimes.length, 7);
    addResultToPlan(file, "jira_create_sla_calendar", cal, dry.value);
    const sla = { service_desk: "BANK", name: "Bank incidents TTR", start: "Issue Created", stop: "Resolution: Set", goals: JSON.stringify([{ target: "4h", calendar: "24x7 Moscow" }]) };
    const planned = await run("jira_create_sla", sla, jsm.responder);
    assert.ok(planned.res.ok, JSON.stringify(planned.error));
    addResultToPlan(file, "jira_create_sla", sla, planned.value);
    const out = await applyPlan(testContext(jsm.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"]);
    const created = jsm.metrics.find((m) => m.name === "Bank incidents TTR");
    assert.equal(created.config.goals[0].calendarId, jsm.calendars.find((c) => c.name === "24x7 Moscow").id);
    const inUse = await run("jira_delete_sla_calendar", { service_desk: "BANK", calendar: "24x7 Moscow" }, jsm.responder);
    assert.match(inUse.error.message, /Bank incidents TTR/);
    const again = await run("jira_create_sla_calendar", cal, jsm.responder);
    assert.equal(again.value.already_satisfied, true);
  });
});
