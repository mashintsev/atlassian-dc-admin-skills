import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listTools } from "../../src/cli.js";

describe("list <text> (reduce-agent-context 3.2)", () => {
  it("finds tools by words in their description, with a short clause", () => {
    const out = listTools(["detail", "view"]);
    assert.match(out, /jira_set_board_detail_fields ✎ \| /);
    for (const line of out.split("\n").slice(1)) assert.ok(line.length <= 100 + 60, line);
  });

  it("requires every word, case-insensitively", () => {
    const out = listTools(["SLA", "calendar"]);
    assert.match(out, /jira_create_sla_calendar/);
    assert.ok(!/jira_create_sla \|/.test(out) || /calendar/i.test(out));
    for (const line of out.split("\n").slice(1)) assert.match(line.toLowerCase(), /sla/);
  });

  it("keeps product filters and flags", () => {
    const jira = listTools(["jira"]);
    assert.ok(!/confluence_/.test(jira));
    assert.ok(!/ \| /.test(jira.split("\n")[1]!), "product listing stays names only");
    assert.ok(listTools(["confluence", "--writes"]).split("\n").slice(1).every((l) => l.includes("✎")));
  });

  it("says so when nothing matches", () => {
    assert.match(listTools(["zzqx", "nothing"]), /no tool matches.*list jira.*list confluence/s);
  });
});
