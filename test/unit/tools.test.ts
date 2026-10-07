import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { output, parseArgs } from "../../src/cli.js";
import { runToolByName } from "../../src/runner.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { testContext } from "./helpers.js";

async function run(name: string, args: Record<string, unknown>, responder?: Parameters<typeof testContext>[0]) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  const json: any = res.ok ? res.value : { success: false, error: res.error.message, error_type: res.error.type, ...res.error };
  return { ...res, json, calls };
}

describe("registry", () => {
  it("has unique names prefixed by product", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const t of ALL_TOOLS) {
      const prefixes = t.product === "both" ? ["atlassian_"] : t.product === "jira" ? ["jira_", "assets_"] : [`${t.product}_`];
      assert.ok(prefixes.some((p) => t.name.startsWith(p)), `${t.name} should start with ${prefixes.join(" or ")}`);
    }
  });

  it("every write tool takes dry_run and no read tool does", () => {
    for (const t of ALL_TOOLS) assert.equal("dry_run" in t.inputShape, !!t.write, t.name);
  });

  it("every write tool sends nothing by default", async () => {
    for (const t of ALL_TOOLS.filter((x) => x.write)) {
      const { ctx, calls } = testContext();
      // minimal args are tool-specific; a validation error or a dry run must never call the server
      const res = await runToolByName(t.name, {}, ctx);
      assert.equal(calls.length, 0, t.name);
      assert.equal(res.ok && (res.value as any).dry_run === false, false, t.name);
    }
  });
});

describe("guarded writes", () => {
  /** A Jira that keeps one user's group memberships, so writes are checked before and read back after. */
  function membership() {
    const groups: string[] = [];
    return (c: any) => {
      const u = new URL(c.url);
      if (c.method === "POST" && u.pathname === "/rest/api/2/group/user") {
        groups.push(u.searchParams.get("groupname")!);
        return { status: 201, body: {} };
      }
      if (u.pathname === "/rest/api/2/user") return { body: { name: "ivan", key: "ivan", groups: { size: groups.length, items: groups.map((name) => ({ name })) } } };
      return undefined;
    };
  }
  const writes = (calls: any[]) => calls.filter((c) => c.method !== "GET");

  it("dry run describes the request and sends no write (reads only)", async () => {
    const r = await run("jira_add_user_to_group", { group: "jira-admins", user: "ivan" }, membership());
    assert.equal(r.ok, true, JSON.stringify(r.json));
    assert.equal(writes(r.calls).length, 0);
    assert.equal(r.json.dry_run, true);
    assert.equal(r.json.request.method, "POST");
    assert.equal(r.json.request.url, "https://jira.example.com/rest/api/2/group/user?groupname=jira-admins");
    assert.deepEqual(r.json.request.body, { name: "ivan" });
  });

  it("dry_run=false sends exactly the described write", async () => {
    const r = await run("jira_add_user_to_group", { group: "jira-admins", user: "ivan", dry_run: false }, membership());
    assert.equal(r.json.dry_run, false, JSON.stringify(r.json));
    const w = writes(r.calls);
    assert.equal(w.length, 1);
    assert.equal(w[0].method, "POST");
    assert.equal(w[0].url, r.json.request.url);
    assert.deepEqual(w[0].body, { name: "ivan" });
  });

  it("accepts dry_run as the string 'false' from the CLI", async () => {
    const r = await run("jira_kill_user_sessions", parseArgs(["username=ivan", "dry_run=false"]).args);
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].method, "DELETE");
    assert.equal(r.calls[0].url, "https://jira.example.com/rest/api/2/user/session/ivan");
  });

  it("masks passwords in the echoed request but sends them", async () => {
    let created = false;
    const r = await run("jira_create_user", {
      username: "new.user", email: "n@example.com", display_name: "New User", password: "p@ss", dry_run: false,
    }, (c: any) => {
      if (c.method === "POST") { created = true; return { status: 201, body: {} }; }
      if (new URL(c.url).pathname === "/rest/api/2/user") {
        return created ? { body: { name: "new.user", emailAddress: "n@example.com", displayName: "New User" } } : { status: 404, body: {} };
      }
      return undefined;
    });
    assert.equal(r.json.request.body.password, "***", JSON.stringify(r.json));
    assert.equal(writes(r.calls)[0].body.password, "p@ss");
  });

  it("uses user key or username for Jira user writes", async () => {
    const r = await run("jira_set_user_active", { user: "JIRAUSER10100", active: false });
    assert.equal(r.json.request.url, "https://jira.example.com/rest/api/2/user?key=JIRAUSER10100");
    assert.deepEqual(r.json.request.body, { active: false });
  });

  it("disables an app through UPM with its media type", async () => {
    const r = await run("atlassian_set_plugin_enabled", { product: "confluence", plugin_key: "com.example.app", enabled: false, dry_run: false });
    assert.equal(r.calls[0].url, "https://wiki.example.com/rest/plugins/1.0/com.example.app-key");
    assert.equal(r.calls[0].headers["Content-Type"], "application/vnd.atl.plugins.plugin+json");
    assert.deepEqual(r.calls[0].body, { enabled: false });
  });

  it("builds Confluence space permission grants", async () => {
    const r = await run("confluence_grant_space_permissions", {
      space_key: "DOC", subject_type: "group", subject: "doc writers", operations: "read:space,create:page",
    });
    assert.equal(r.json.request.method, "PUT");
    assert.equal(r.json.request.url, "https://wiki.example.com/rest/api/space/DOC/permissions/group/doc%20writers/grant");
    assert.deepEqual(r.json.request.body, [
      { operationKey: "read", targetType: "space" },
      { operationKey: "create", targetType: "page" },
    ]);
  });

  it("rejects unknown permission targets", async () => {
    const r = await run("confluence_grant_space_permissions", {
      space_key: "DOC", subject_type: "anonymous", operations: ["read:galaxy"],
    });
    assert.equal(r.ok, false);
    assert.equal(r.json.error_type, "ValidationError");
  });

  it("requires exactly one of user or group when removing a role actor", async () => {
    const r = await run("jira_remove_project_role_actor", { project_key: "FDP", role_id: 10002, user: "a", group: "b" });
    assert.equal(r.ok, false);
    assert.match(r.json.error, /exactly one/);
  });
});

describe("read tools", () => {
  it("rejects unknown arguments", async () => {
    const r = await run("jira_server_info", { bogus: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.json.error_type, "ValidationError");
  });

  it("groups permission scheme grants by permission", async () => {
    const r = await run("jira_get_permission_scheme", { scheme_id: 10000 }, () => ({
      body: {
        id: 10000,
        name: "Default",
        permissions: [
          { id: 1, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "jira-users" } },
          { id: 2, permission: "BROWSE_PROJECTS", holder: { type: "projectRole", parameter: "10002", projectRole: { name: "Developers" } } },
          { id: 3, permission: "ADMINISTER_PROJECTS", holder: { type: "projectLead" } },
        ],
      },
    }));
    assert.deepEqual(r.json.permissions, {
      ADMINISTER_PROJECTS: [{ id: 3, holder: "projectLead" }],
      BROWSE_PROJECTS: [
        { id: 1, holder: "group:jira-users" },
        { id: 2, holder: "projectRole:Developers" },
      ],
    });
  });

  it("pages and filters projects client-side", async () => {
    const projects = Array.from({ length: 5 }, (_, i) => ({ id: String(i), key: `P${i}`, name: i % 2 ? "Finance" : "HR" }));
    const r = await run("jira_list_projects", { name_contains: "fin", limit: 1 }, () => ({ body: projects }));
    assert.equal(r.json.total, 2);
    assert.equal(r.json.returned, 1);
    assert.equal(r.json.nextOffset, 1);
    assert.equal(r.json.items[0].key, "P1");
  });

  it("maps HTTP errors to JSON errors", async () => {
    const r = await run("confluence_get_space", { space_key: "NOPE" }, () => ({ status: 404, body: { message: "No space with key : NOPE" } }));
    assert.equal(r.ok, false);
    assert.equal(r.json.error_type, "HTTP404");
    assert.match(r.json.error, /No space with key/);
  });

  it("replaces oversized output with a narrowing hint", async () => {
    const before = process.env.ATLASSIAN_MAX_RESPONSE_CHARS;
    process.env.ATLASSIAN_MAX_RESPONSE_CHARS = "200";
    try {
      const r = await run("jira_list_workflows", {}, () => ({
        body: Array.from({ length: 50 }, (_, i) => ({ name: `Workflow ${i}`, description: "x".repeat(20) })),
      }));
      const text = output(r, { format: "compact", flags: new Set() });
      assert.match(text, /^ERROR ResponseTooLarge/);
      assert.match(text, /--out=FILE/);
    } finally {
      if (before === undefined) delete process.env.ATLASSIAN_MAX_RESPONSE_CHARS;
      else process.env.ATLASSIAN_MAX_RESPONSE_CHARS = before;
    }
  });

  it("reads audit events with the verified paging fields", async () => {
    const r = await run("atlassian_audit_events", { product: "jira", search: "group", limit: 2 }, (call) => {
      assert.match(call.url, /\/rest\/auditing\/1\.0\/events\?search=group&limit=2$/);
      return {
        body: {
          entities: [{ timestamp: "t", author: { name: "admin" }, type: { category: "Users and groups", action: "User added to group" } }],
          pagingInfo: { lastPage: false, nextPageCursor: "abc" },
        },
      };
    });
    assert.equal(r.json.nextPageCursor, "abc");
    assert.equal(r.json.items[0].action, "User added to group");
  });
});

describe("parseArgs", () => {
  it("separates global options from tool arguments", () => {
    const { args, options } = parseArgs(['{"a":1}', "b=true", "c=[1,2]", "d=text", "--dry-run=false", "id=00123", "fields=summary", "--format=json", "--fields=-description", "--out=x.json"]);
    // values stay text; the runner converts them by each tool's schema (coerceArgs)
    assert.deepEqual(args, { a: 1, b: "true", c: "[1,2]", d: "text", dry_run: "false", id: "00123", fields: "summary" });
    assert.equal(options.format, "json");
    assert.equal(options.fields, "-description");
    assert.equal(options.out, "x.json");
  });

  it("rejects an unknown format", () => {
    assert.throws(() => parseArgs(["--format=xml"]), /--format must be one of/);
  });
});
