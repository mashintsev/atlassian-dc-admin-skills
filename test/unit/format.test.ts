import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { output } from "../../src/cli.js";
import { exitCodeFor, projectFields, prune, render, toCompact } from "../../src/format.js";
import { runToolByName } from "../../src/runner.js";
import { testContext } from "./helpers.js";

const opts = (o: Partial<Parameters<typeof output>[1]> = {}) => ({ format: "compact" as const, flags: new Set<string>(), ...o });

describe("prune", () => {
  it("drops self/avatar/expand/_links and empty values, shortens timestamps", () => {
    assert.deepEqual(
      prune({
        self: "https://jira/rest/api/2/user?username=a",
        expand: "groups",
        avatarUrls: { "48x48": "x" },
        name: "a",
        emailAddress: "",
        groups: [],
        created: "2026-04-06T11:52:21.445+0900",
        due: "2026-04-07T00:00:00.000+0000",
        _links: { next: "/n" },
      }),
      { name: "a", created: "2026-04-06 11:52", due: "2026-04-07" },
    );
  });

  it("flattens identity objects nested in fields but keeps ids of list items", () => {
    assert.deepEqual(prune({ status: { id: "3", name: "In Progress", self: "u" }, lead: { name: "ivan", key: "JIRAUSER1" } }), {
      status: "In Progress",
      lead: "ivan",
    });
    assert.deepEqual(prune([{ id: 10000, name: "Default" }]), [{ id: 10000, name: "Default" }]);
  });
});

describe("compact", () => {
  it("renders pages as a header plus pipe rows", () => {
    const text = toCompact({ total: 2, offset: 0, returned: 2, nextOffset: null, items: [{ key: "FDP", name: "Finance" }, { key: "HR", name: "People", lead: "a" }] });
    assert.equal(text, "total:2 offset:0 returned:2 last\n# key | name | lead\nFDP | Finance | \nHR | People | a");
  });

  it("renders objects as key: value lines with nested rows", () => {
    const text = toCompact({ id: 1, name: "Scheme", permissions: { BROWSE_PROJECTS: [{ id: 1, holder: "group:jira-users" }] } });
    assert.equal(text, "id: 1\nname: Scheme\npermissions:\n  BROWSE_PROJECTS (1):\n    # id | holder\n    1 | group:jira-users");
  });

  it("renders write results in one or a few lines", () => {
    const dry = { dry_run: true, summary: "Deactivate user ivan", request: { method: "PUT", url: "https://j/rest/api/2/user?username=ivan", body: { active: false } } };
    assert.equal(toCompact(dry).split("\n")[0], "DRY-RUN | Deactivate user ivan");
    const done = { dry_run: false, summary: "Create group x", request: {}, result: { name: "x", self: "u", users: { size: 0 } } };
    assert.equal(toCompact(done), "OK | Create group x | x");
  });
});

describe("fields", () => {
  it("keeps or removes fields on rows and objects", () => {
    const page = { total: 1, items: [{ key: "A", name: "n", lead: "l" }] };
    assert.deepEqual((projectFields(page, "key,name") as any).items, [{ key: "A", name: "n" }]);
    assert.deepEqual(projectFields({ a: 1, description: "long" }, "-description"), { a: 1 });
  });

  it("applies in json format after pruning", () => {
    assert.equal(render({ items: [{ key: "A", self: "u", name: "n" }], total: 1 }, "json", "key"), '{"items":[{"key":"A"}],"total":1}');
  });
});

describe("output", () => {
  it("writes the full result to --out and prints one summary line", async () => {
    const { ctx } = testContext(() => ({ body: [{ id: 1, key: "A", name: "Alpha", avatarUrls: { x: 1 } }] }));
    const res = await runToolByName("jira_list_projects", {}, ctx);
    const file = join(mkdtempSync(join(tmpdir(), "adm-")), "projects.json");
    const line = output(res, opts({ out: file }));
    assert.match(line, /^saved \| jira_list_projects \| 1 of 1 items \| \d+ chars → /);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).items[0].key, "A");
  });

  it("maps errors to compact lines and exit codes", async () => {
    const { ctx } = testContext(() => ({ status: 403, body: { errorMessages: ["no"] } }));
    const res = await runToolByName("jira_server_info", {}, ctx);
    assert.equal(res.exitCode, 3);
    assert.match(output(res, opts()), /^ERROR HTTP403 403 \| .*no/);
    assert.equal(exitCodeFor({ type: "ValidationError", message: "" }), 7);
    assert.equal(exitCodeFor({ type: "HTTP404", message: "", status: 404 }), 2);
  });
});

describe("compact dry runs show tool evidence (fix-cli-output 1.1)", () => {
  const base = {
    dry_run: true,
    product: "jira",
    summary: "Publish the draft of workflow 'Incident WF'",
    request: { method: "POST", url: "https://jira.example.com/rest/x", body: { a: 1 } },
    note: "Nothing was changed. Confirm with the user, then re-run with dry_run=false.",
  };

  it("renders before/after, target, nested differences and affected projects, but not identity/state", () => {
    const out = toCompact({
      ...base,
      target: "the draft of 'Incident WF'",
      before: { name: "Start progress" },
      after: { name: "Start" },
      differences: { identical: false, transitions: { onlyInSecond: [{ from: "In Progress", to: "Open", names: ["Back"] }] } },
      affectedProjects: ["DEMO", "OPS"],
      identity: { op: "secret-identity" },
      state: { present: "secret-state" },
    });
    assert.match(out, /target: the draft of 'Incident WF'/);
    assert.match(out, /before: Start progress/);
    assert.match(out, /after: Start$/m);
    assert.match(out, /In Progress \| Open \| Back/);
    assert.match(out, /affectedProjects: DEMO,OPS/);
    assert.ok(!/secret-identity|secret-state/.test(out), out);
    assert.equal(out.split("\n").filter((l) => l.includes("Nothing was changed")).length, 0, "generic note replaced by the final line");
  });

  it("does not cut list cells by their position (inline array regression)", () => {
    assert.match(toCompact([{ key: "A", labels: ["alpha", "beta", "gamma"] }]), /alpha,beta,gamma/);
  });

  it("keeps a tool's own note and caps long lists and lines", () => {
    const out = toCompact({ ...base, note: "Statuses are global.", affectedProjects: Array.from({ length: 300 }, (_, i) => `P${i}`), long: "x".repeat(2000) });
    assert.match(out, /note: Statuses are global\./);
    assert.match(out, /\+280 more/);
    for (const line of out.split("\n")) assert.ok(line.length <= 400, `line too long: ${line.length}`);
  });
});

describe("follow-up cap (reduce-agent-context 3.4)", () => {
  it("prints at most 5 follow-up requests and the number of the rest", () => {
    const followUps = Array.from({ length: 12 }, (_, i) => ({ method: "POST", url: `https://jira.example.com/rest/x/${i}` }));
    const out = toCompact({ dry_run: true, product: "jira", summary: "Many steps", request: { method: "POST", url: "https://jira.example.com/rest/x" }, followUps });
    assert.equal(out.split("\n").filter((l) => l.startsWith("then")).length, 5);
    assert.match(out, /\+7 more \(--format=json shows all\)/);
  });
});

describe("rows of plain values", () => {
  it("do not cut values by their position (rows/inline index regression)", () => {
    assert.equal(toCompact(["Workflow one", "Another workflow", "Third"]), "Workflow one\nAnother workflow\nThird");
  });
});

describe("bounded compact rendering (optimize-read-token-usage 2.x)", () => {
  const keys = Array.from({ length: 40 }, (_, i) => `PROJECT${i}`);

  it("cuts a cell holding an array to the cell limit and counts the rest (2.1)", () => {
    const text = toCompact([{ name: "WF", projects: keys }, { name: "WF2", projects: ["A"] }]);
    const row = text.split("\n")[1]!;
    const cell = row.split(" | ")[1]!;
    assert.ok(cell.length <= 175, cell);
    assert.match(cell, /^PROJECT0,PROJECT1,.*,\+\d+ more$/);
  });

  it("cuts a cell holding an object, also nested ones (2.1)", () => {
    const text = toCompact([{ id: 1, fields: { a: "x".repeat(300), b: { c: keys } } }, { id: 2 }]);
    const cell = text.split("\n")[1]!.split(" | ")[1]!;
    assert.ok(cell.length <= 175, `${cell.length}: ${cell}`);
    assert.match(cell, /…\(\+\d+\)$/);
  });

  it("cuts long single-object text at a line boundary and prints it without the per-line indent (2.2)", () => {
    const line = "word ".repeat(19) + "end";
    const description = Array.from({ length: 400 }, () => line).join("\n"); // ~40,000 characters
    const text = toCompact({ key: "PRJ-1", description });
    const lines = text.split("\n");
    assert.equal(lines[1], "description:");
    assert.equal(lines[2], line, "no extra indent");
    assert.ok(text.length < 8_300, String(text.length));
    assert.match(lines.at(-1)!, /^…\(\+\d+ chars; --format=json shows all\)$/);
    assert.ok(!lines.slice(2, -1).some((l) => l !== line), "cut at a line boundary");
  });

  it("honours ATLASSIAN_MAX_TEXT_CHARS", () => {
    process.env.ATLASSIAN_MAX_TEXT_CHARS = "100";
    try {
      assert.match(toCompact({ body: "y".repeat(500) }), /…\(\+400 chars/);
    } finally {
      delete process.env.ATLASSIAN_MAX_TEXT_CHARS;
    }
  });

  it("names the tool's narrowing arguments in the cut marker (2.3)", () => {
    const text = render({ body: "z".repeat(20_000) }, "compact", undefined, undefined, ["section", "outline"]);
    assert.match(text, /…\(\+12000 chars; narrow with section\|outline or --format=json\)/);
  });

  it("names the largest fields and the narrowing arguments when a response is too large, without content (2.4)", () => {
    const res: any = {
      ok: true,
      tool: { name: "confluence_get_page", narrowing: ["section", "outline", "max_chars"] },
      value: { id: "1", title: "T", body: Array.from({ length: 3000 }, (_, i) => `SECRET line ${i} of the page body`).join("\n"), labels: keys },
    };
    process.env.ATLASSIAN_MAX_TEXT_CHARS = "100000";
    try {
      const text = output(res, opts());
      assert.match(text, /^ERROR ResponseTooLarge/);
      assert.match(text, /largest: body \d+/);
      assert.match(text, /section\|outline\|max_chars/);
      assert.ok(!text.includes("SECRET"), text);
      const json = JSON.parse(output(res, opts({ format: "json" })));
      assert.match(json.error, /largest: body/);
    } finally {
      delete process.env.ATLASSIAN_MAX_TEXT_CHARS;
    }
  });

  it("shows nested summary fields of a page result (2.5)", () => {
    const page = { total: 2, offset: 0, returned: 2, nextOffset: null, screen: { id: 1, name: "Default" }, schemes: ["A", "B"], items: [{ project: "P1" }, { project: "P2" }] };
    const text = toCompact(page);
    assert.match(text, /screen:Default/, "a {id, name} reference collapses to its name");
    assert.match(text, /schemes: A,B/);
    assert.match(text, /^P2$/m);
  });
});

it("bounds long scalar page summaries and includes the cut marker", () => {
  const text = render({ items: [{ id: 1 }], description: "x".repeat(30000) }, "compact");
  assert.ok(text.length < 25000);
  assert.match(text, /…\(\+22000 chars/);
});

it("reserves the array cut marker inside the 160-character cell budget", () => {
  const text = render([{ projects: Array.from({ length: 40 }, (_, i) => `PROJECT_${String(i).padStart(3, "0")}`) }], "compact");
  const cell = text.split("\n")[1]!;
  assert.ok(cell.length <= 160, `${cell.length} characters`);
  assert.match(cell, /\+\d+ more/);
});
