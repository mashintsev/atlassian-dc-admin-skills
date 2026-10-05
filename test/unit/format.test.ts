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
