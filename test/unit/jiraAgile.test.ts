import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runTool } from "../../src/runner.js";
import { jiraAgileTools } from "../../src/tools/jira/agile.js";
import { jiraAttachmentTools, isImageAttachment, safeFileName } from "../../src/tools/jira/attachments.js";
import { jiraCollabTools } from "../../src/tools/jira/collab.js";
import { formatMinutes, jiraInsightTools, statusTimeline, workingMinutes } from "../../src/tools/jira/insights.js";
import { jiraLinkTools } from "../../src/tools/jira/links.js";
import { jiraWorklogTools } from "../../src/tools/jira/worklog.js";
import type { ToolDef } from "../../src/tools/types.js";
import { testContext } from "./helpers.js";

const ALL: ToolDef[] = [
  ...jiraAgileTools, ...jiraLinkTools, ...jiraWorklogTools, ...jiraAttachmentTools, ...jiraCollabTools, ...jiraInsightTools,
];
const tool = (name: string) => ALL.find((t) => t.name === name)!;

async function run(name: string, args: Record<string, unknown>, responder?: Parameters<typeof testContext>[0]) {
  const { ctx, calls } = testContext(responder);
  const res = await runTool(tool(name), args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : res.error, calls };
}

const J = "https://jira.example.com";

describe("registry of F3 tools", () => {
  it("has unique jira_ names and dry_run exactly on write tools", () => {
    const names = ALL.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const t of ALL) {
      assert.ok(t.name.startsWith("jira_"), t.name);
      assert.equal("dry_run" in t.inputShape, !!t.write, t.name);
    }
  });
});

describe("agile", () => {
  it("lists boards with agile query params and a compact page", async () => {
    const r = await run("jira_get_agile_boards", { project_key: "FDP", board_type: "scrum", limit: 2 }, () => ({
      body: { values: [{ id: 7, name: "FDP board", type: "scrum", self: "x", location: { projectKey: "FDP" } }], total: 1, isLast: true },
    }));
    assert.equal(r.calls[0].url, `${J}/rest/agile/1.0/board?projectKeyOrId=FDP&type=scrum&startAt=0&maxResults=2`);
    assert.deepEqual(r.value.items, [{ id: 7, name: "FDP board", type: "scrum", project: "FDP" }]);
    assert.equal(r.value.nextOffset, null);
  });

  it("reads sprint issues through the agile API with default fields", async () => {
    const r = await run("jira_get_sprint_issues", { sprint_id: 12 }, () => ({
      body: { total: 1, issues: [{ key: "FDP-1", fields: { summary: "S", status: { name: "Done" }, issuetype: { name: "Task" } } }] },
    }));
    assert.match(r.calls[0].url, /\/rest\/agile\/1\.0\/sprint\/12\/issue\?fields=summary%2Cstatus/);
    assert.equal(r.value.items[0].key, "FDP-1");
    assert.equal(r.value.items[0].status, "Done");
  });

  it("partially updates a sprint with POST and only the given fields", async () => {
    const r = await run("jira_update_sprint", { sprint_id: 12, state: "active", end_date: "2026-10-20" });
    assert.equal(r.calls.length, 0);
    assert.equal(r.value.request.method, "POST");
    assert.equal(r.value.request.url, `${J}/rest/agile/1.0/sprint/12`);
    assert.deepEqual(r.value.request.body, { state: "active", endDate: "2026-10-20" });
  });

  it("rejects a sprint that ends before it starts", async () => {
    const r = await run("jira_create_sprint", { board_id: 1, name: "S1", start_date: "2026-10-10", end_date: "2026-10-01" });
    assert.equal(r.error?.type, "ValidationError");
  });

  it("moves issues to a sprint and to the backlog", async () => {
    const a = await run("jira_add_issues_to_sprint", { sprint_id: 3, issue_keys: "FDP-1, FDP-2", dry_run: false });
    assert.deepEqual(a.calls[0].body, { issues: ["FDP-1", "FDP-2"] });
    const b = await run("jira_move_issues_to_backlog", { issue_keys: ["FDP-3"] });
    assert.equal(b.value.request.url, `${J}/rest/agile/1.0/backlog/issue`);
  });
});

describe("links", () => {
  it("links to an epic through the discovered Epic Link field", async () => {
    const r = await run("jira_link_to_epic", { issue_key: "FDP-5", epic_key: "FDP-1" }, (call) =>
      call.url.endsWith("/rest/api/2/field")
        ? { body: [{ id: "customfield_10100", name: "Epic Link", schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" } }] }
        : undefined,
    );
    assert.equal(r.calls.length, 1); // only the field discovery, the PUT is a dry run
    assert.deepEqual(r.value.request.body, { fields: { customfield_10100: "FDP-1" } });
  });

  it("creates an issue link with a wiki-markup comment", async () => {
    const r = await run("jira_create_issue_link", {
      link_type: "Blocks", inward_issue_key: "FDP-2", outward_issue_key: "FDP-1", comment: "see **this**",
    });
    assert.equal(r.value.request.url, `${J}/rest/api/2/issueLink`);
    assert.equal(r.value.request.body.type.name, "Blocks");
    assert.equal(typeof r.value.request.body.comment.body, "string");
  });

  it("validates issue keys and numeric link ids", async () => {
    assert.equal((await run("jira_create_remote_issue_link", { issue_key: "bad", url: "https://x.y", title: "t" })).error?.type, "ValidationError");
    assert.equal((await run("jira_remove_issue_link", { link_id: "1;DROP" })).error?.type, "ValidationError");
  });

  it("lists issue links with the ids needed for removal", async () => {
    const r = await run("jira_get_issue_links", { issue_key: "FDP-1" }, (call) =>
      call.url.includes("remotelink")
        ? { body: [{ id: 9, object: { title: "Doc", url: "https://d" } }] }
        : { body: { fields: { issuelinks: [{ id: "100", type: { inward: "is blocked by", outward: "blocks" }, outwardIssue: { key: "HR-2", fields: { summary: "x", status: { name: "Open" } } } }] } } },
    );
    assert.deepEqual(r.value.links, [{ id: "100", relation: "blocks", issue: "HR-2", status: "Open", summary: "x" }]);
    assert.equal(r.value.remote[0].title, "Doc");
  });
});

describe("worklog", () => {
  it("sends timeSpent as Jira duration text and sets the remaining estimate", async () => {
    const r = await run("jira_add_worklog", { issue_key: "FDP-1", time_spent: "1d 2h", remaining_estimate: "3h", dry_run: false });
    assert.equal(r.calls[0].url, `${J}/rest/api/2/issue/FDP-1/worklog?adjustEstimate=new&newEstimate=3h`);
    assert.deepEqual(r.calls[0].body, { timeSpent: "1d 2h" });
  });

  it("rejects malformed durations", async () => {
    assert.equal((await run("jira_add_worklog", { issue_key: "FDP-1", time_spent: "ten minutes" })).error?.type, "ValidationError");
  });

  it("sums worklog hours", async () => {
    const r = await run("jira_get_worklog", { issue_key: "FDP-1" }, () => ({
      body: { worklogs: [{ id: "1", timeSpentSeconds: 3600, timeSpent: "1h", author: { name: "a" } }, { id: "2", timeSpentSeconds: 1800 }] },
    }));
    assert.equal(r.value.totalHours, 1.5);
    assert.equal(r.value.total, 2);
  });
});

describe("attachments", () => {
  it("detects images by mime or by extension for ambiguous mimes", () => {
    assert.equal(isImageAttachment({ mimeType: "image/png", filename: "a" }), true);
    assert.equal(isImageAttachment({ mimeType: "application/octet-stream", filename: "a.JPG" }), true);
    assert.equal(isImageAttachment({ mimeType: "application/pdf", filename: "a.png" }), false);
  });

  it("sanitises server file names", () => {
    assert.equal(safeFileName("../../etc/passwd", "x"), "passwd");
    assert.equal(safeFileName("a:b?.txt", "x"), "a_b_.txt");
    assert.equal(safeFileName("..", "fallback"), "_");
  });

  it("saves files under output_dir, prints no content and refuses foreign hosts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "att-"));
    const r = await run("jira_download_attachments", { issue_key: "FDP-1", output_dir: dir }, (call) => {
      if (call.url.includes("/rest/api/2/issue/")) {
        return {
          body: {
            fields: {
              attachment: [
                { id: 1, filename: "../report.txt", mimeType: "text/plain", size: 5, content: `${J}/secure/attachment/1/report.txt` },
                { id: 2, filename: "evil.txt", mimeType: "text/plain", size: 5, content: "https://evil.example.org/x" },
              ],
            },
          },
        };
      }
      return { body: "hello" };
    });
    assert.equal(r.value.saved, 1);
    const [ok, evil] = r.value.files;
    assert.equal(ok.path, join(dir, "1_report.txt"));
    assert.equal(readFileSync(ok.path, "utf8"), "hello");
    assert.match(evil.skipped, /Refusing to download/);
    assert.equal(r.calls.filter((c) => c.url.startsWith("https://evil")).length, 0);
    assert.ok(!JSON.stringify(r.value).includes("hello"));
  });

  it("dry-runs an upload with file names and sizes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "up-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "abc");
    const r = await run("jira_upload_attachments", { issue_key: "FDP-1", paths: [file] });
    assert.equal(r.value.dry_run, true);
    assert.deepEqual(r.value.request.files, [{ name: "a.txt", bytes: 3 }]);
    assert.ok(existsSync(file));
  });
});

describe("watchers and users", () => {
  it("adds a watcher with a JSON string body and removes by username", async () => {
    const a = await run("jira_add_watcher", { issue_key: "FDP-1", username: "ivan", dry_run: false });
    assert.equal(a.calls[0].body, "ivan");
    const b = await run("jira_remove_watcher", { issue_key: "FDP-1", username: "ivan" });
    assert.equal(b.value.request.url, `${J}/rest/api/2/issue/FDP-1/watchers?username=ivan`);
  });

  it("requires exactly one of project_key / issue_key for assignable search", async () => {
    assert.equal((await run("jira_search_assignable_users", { query: "iv" })).error?.type, "ValidationError");
    const r = await run("jira_search_assignable_users", { query: "iv", project_key: "FDP" }, () => ({ body: [{ name: "ivan", avatarUrls: {} }] }));
    assert.match(r.calls[0].url, /user\/assignable\/search\?username=iv&project=FDP/);
    assert.equal(r.value.items[0].name, "ivan");
  });
});

describe("metrics", () => {
  const issue = {
    fields: { created: "2026-10-01T09:00:00.000+0000", resolutiondate: "2026-10-01T15:00:00.000+0000", status: { name: "Done" }, duedate: "2026-10-02" },
    changelog: {
      histories: [
        { created: "2026-10-01T10:00:00.000+0000", author: { name: "a" }, items: [{ field: "status", fromString: "Open", toString: "In Progress" }] },
        { created: "2026-10-01T15:00:00.000+0000", author: { name: "b" }, items: [{ field: "status", fromString: "In Progress", toString: "Done" }] },
      ],
    },
  };

  it("builds the status timeline from the changelog", () => {
    const t = statusTimeline(issue, new Date("2026-10-01T16:00:00Z"));
    assert.deepEqual(t.map((p) => [p.status, p.minutes]), [["Open", 60], ["In Progress", 300], ["Done", 60]]);
    assert.equal(formatMinutes(1565), "1d 2h 5m");
  });

  it("counts working minutes only inside working hours", () => {
    // Friday 16:00 → Monday 10:00 UTC with 09:00-17:00 Mon-Fri = 60 + 60 minutes
    const m = workingMinutes("2026-10-02T16:00:00Z", "2026-10-05T10:00:00Z", { start: 540, end: 1020, days: new Set([1, 2, 3, 4, 5]), timeZone: "UTC" });
    assert.equal(m, 120);
  });

  it("computes cycle time, due date compliance and resolution time", async () => {
    const r = await run(
      "jira_get_issue_sla",
      { issue_key: "FDP-1", metrics: "cycle_time,due_date_compliance,resolution_time" },
      (call) => (call.url.endsWith("/rest/api/2/status") ? { body: [{ name: "In Progress", statusCategory: { key: "indeterminate" } }] } : { body: issue }),
    );
    assert.deepEqual(r.value.metrics.cycle_time, { minutes: 360, time: "6h" });
    assert.equal(r.value.metrics.due_date_compliance.result, "met");
    assert.deepEqual(r.value.metrics.resolution_time, { minutes: 300, time: "5h" });
  });
});

describe("development info and analysis", () => {
  it("stops with a clear error when the dev-status plugin is missing", async () => {
    const r = await run("jira_get_issue_development_info", { issue_key: "FDP-1", application_type: "stash" }, (call) =>
      call.url.includes("/dev-status/") ? { status: 404, body: "" } : { body: { id: "10001" } },
    );
    assert.equal(r.value.error, "dev-status plugin may not be installed");
  });

  it("groups cross-project links by project and type, bounded by max_issues", async () => {
    const r = await run("jira_get_cross_project_dependencies", { project_key: "FDP", max_issues: 1 }, () => ({
      body: {
        total: 10,
        issues: [{ key: "FDP-1", fields: { issuelinks: [{ type: { name: "Blocks", outward: "blocks" }, outwardIssue: { key: "HR-3" } }, { type: { name: "Relates" }, inwardIssue: { key: "FDP-9" } }] } }],
      },
    }));
    assert.equal(r.calls.length, 1);
    assert.match(r.calls[0].url, /maxResults=1/);
    assert.deepEqual(r.value.byProject, { HR: { links: 1, byType: { Blocks: ["FDP-1 blocks HR-3"] } } });
  });

  it("rejects JQL-unsafe project keys", async () => {
    assert.equal((await run("jira_get_project_epic_hierarchy", { project_key: 'X" OR 1=1' })).error?.type, "ValidationError");
  });
});
