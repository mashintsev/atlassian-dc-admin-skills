import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { describeTool } from "../../src/cli.js";
import { testContext, type Call } from "./helpers.js";

const API = "/rest/api/2";

interface FakeUser {
  key: string;
  name: string;
  emailAddress: string;
  displayName: string;
  active: boolean;
  groups: Set<string>;
  apps: Set<string>;
}

/** A small Jira user directory; `ignoreWrites` accepts writes but changes nothing (read-back mismatch). */
function fakeDirectory(opts: { ignoreWrites?: boolean } = {}) {
  const users = new Map<string, FakeUser>();
  const groups = new Set<string>(["jira-admins"]);
  const add = (name: string, extra: Partial<FakeUser> = {}) =>
    users.set(name, { key: `JIRAUSER${10000 + users.size}`, name, emailAddress: `${name}@example.com`, displayName: name, active: true, groups: new Set(), apps: new Set(), ...extra });
  add("alice", { groups: new Set(["jira-admins"]), apps: new Set(["jira-software"]) });
  add("bob");

  const find = (q: URLSearchParams) => {
    if (q.get("key")) return [...users.values()].find((u) => u.key === q.get("key"));
    return users.get(q.get("username") ?? "");
  };
  const view = (u: FakeUser) => ({
    key: u.key, name: u.name, emailAddress: u.emailAddress, displayName: u.displayName, active: u.active,
    groups: { size: u.groups.size, items: [...u.groups].map((name) => ({ name })) },
    applicationRoles: { size: u.apps.size, items: [...u.apps].map((key) => ({ key })) },
  });
  const notFound = { status: 404, body: { errorMessages: ["not found"] } };
  const write = (fn: () => void) => {
    if (!opts.ignoreWrites) fn();
    return { status: 201, body: {} };
  };

  const responder = (c: Call) => {
    const url = new URL(c.url);
    const p = url.pathname;
    const q = url.searchParams;
    if (p === `${API}/user` && c.method === "GET") {
      const u = find(q);
      return u ? { body: view(u) } : notFound;
    }
    if (p === `${API}/user` && c.method === "POST") return write(() => add(c.body.name, { emailAddress: c.body.emailAddress, displayName: c.body.displayName }));
    if (p === `${API}/user` && c.method === "PUT") {
      const u = find(q);
      if (!u) return notFound;
      return write(() => {
        if (c.body.emailAddress) u.emailAddress = c.body.emailAddress;
        if (c.body.displayName) u.displayName = c.body.displayName;
        if (typeof c.body.active === "boolean") u.active = c.body.active;
        if (c.body.name && c.body.name !== u.name) {
          users.delete(u.name);
          u.name = c.body.name;
          users.set(u.name, u);
        }
      });
    }
    if (p === `${API}/user` && c.method === "DELETE") {
      const u = find(q);
      if (!u) return notFound;
      return write(() => users.delete(u.name));
    }
    if (p === `${API}/user/application`) {
      const u = users.get(q.get("username") ?? "");
      if (!u) return notFound;
      return write(() => (c.method === "POST" ? u.apps.add(q.get("applicationKey")!) : u.apps.delete(q.get("applicationKey")!)));
    }
    if (p.startsWith(`${API}/user/session/`)) return { status: 204, body: "" };
    if (p === `${API}/group` && c.method === "GET") return groups.has(q.get("groupname") ?? "") ? { body: { name: q.get("groupname") } } : notFound;
    if (p === `${API}/group` && c.method === "POST") return write(() => groups.add(c.body.name));
    if (p === `${API}/group` && c.method === "DELETE") {
      if (!groups.has(q.get("groupname") ?? "")) return notFound;
      return write(() => groups.delete(q.get("groupname")!));
    }
    if (p === `${API}/group/user` && c.method === "POST") {
      const u = users.get(c.body.name);
      if (!u) return notFound;
      return write(() => u.groups.add(q.get("groupname")!));
    }
    if (p === `${API}/group/user` && c.method === "DELETE") {
      const u = users.get(q.get("username") ?? "");
      if (!u) return notFound;
      return write(() => u.groups.delete(q.get("groupname")!));
    }
    return undefined;
  };
  return { responder, users, groups };
}

async function run(tool: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const r = await runToolByName(tool, args, ctx);
  return { r, value: r.ok ? (r.value as any) : undefined, error: r.ok ? undefined : (r as any).error, calls };
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

/** For one tool: the satisfied args send nothing, the change executes and reads back, a lost write fails verification. */
async function checkTool(tool: string, satisfied: Record<string, unknown>, change: Record<string, unknown>, verify: (d: ReturnType<typeof fakeDirectory>) => void) {
  const done = await run(tool, satisfied, fakeDirectory().responder);
  assert.equal(done.value?.already_satisfied, true, `${tool} satisfied: ${JSON.stringify(done.error ?? done.value)}`);
  assert.equal(writes(done.calls).length, 0, `${tool}: nothing sent when satisfied`);
  const doneExec = await run(tool, { ...satisfied, dry_run: false }, fakeDirectory().responder);
  assert.equal(doneExec.value?.already_satisfied, true, `${tool} satisfied on execute`);
  assert.equal(writes(doneExec.calls).length, 0, `${tool}: nothing sent on execute`);

  const dir = fakeDirectory();
  const dry = await run(tool, change, dir.responder);
  assert.equal(dry.value?.dry_run, true, `${tool} dry run: ${JSON.stringify(dry.error)}`);
  assert.equal(writes(dry.calls).length, 0, `${tool}: dry run sends no write`);
  const exec = await run(tool, { ...change, dry_run: false }, dir.responder);
  assert.equal(exec.value?.dry_run, false, `${tool} execute: ${JSON.stringify(exec.error)}`);
  assert.equal(writes(exec.calls).length, 1, `${tool}: one write`);
  verify(dir);

  const lost = await run(tool, { ...change, dry_run: false }, fakeDirectory({ ignoreWrites: true }).responder);
  assert.equal(lost.error?.type, "VerificationError", `${tool} lost write: ${JSON.stringify(lost.error ?? lost.value)}`);
}

describe("write safety: Jira users and groups (unify 2.1)", () => {
  it("jira_create_user", async () => {
    await checkTool(
      "jira_create_user",
      { username: "alice", email: "alice@example.com", display_name: "alice" },
      { username: "carol", email: "carol@example.com", display_name: "Carol" },
      (d) => assert.equal(d.users.get("carol")?.displayName, "Carol"),
    );
    const clash = await run("jira_create_user", { username: "alice", email: "other@example.com", display_name: "alice" }, fakeDirectory().responder);
    assert.equal(clash.error?.type, "ValidationError", "an existing user with other details is an error");
  });

  it("jira_update_user", async () => {
    await checkTool(
      "jira_update_user",
      { user: "alice", display_name: "alice" },
      { user: "alice", display_name: "Alice A." },
      (d) => assert.equal(d.users.get("alice")?.displayName, "Alice A."),
    );
  });

  it("jira_set_user_active", async () => {
    await checkTool(
      "jira_set_user_active",
      { user: "alice", active: true },
      { user: "alice", active: false },
      (d) => assert.equal(d.users.get("alice")?.active, false),
    );
  });

  it("jira_delete_user", async () => {
    await checkTool("jira_delete_user", { user: "nobody" }, { user: "bob" }, (d) => assert.equal(d.users.has("bob"), false));
  });

  it("jira_set_user_application (grant and revoke)", async () => {
    await checkTool(
      "jira_set_user_application",
      { user: "alice", application_key: "jira-software" },
      { user: "bob", application_key: "jira-software" },
      (d) => assert.ok(d.users.get("bob")?.apps.has("jira-software")),
    );
    await checkTool(
      "jira_set_user_application",
      { user: "bob", application_key: "jira-software", grant: false },
      { user: "alice", application_key: "jira-software", grant: false },
      (d) => assert.ok(!d.users.get("alice")?.apps.has("jira-software")),
    );
  });

  it("jira_create_group and jira_delete_group", async () => {
    await checkTool("jira_create_group", { name: "jira-admins" }, { name: "ops" }, (d) => assert.ok(d.groups.has("ops")));
    await checkTool("jira_delete_group", { name: "ops" }, { name: "jira-admins" }, (d) => assert.ok(!d.groups.has("jira-admins")));
  });

  it("jira_add_user_to_group and jira_remove_user_from_group", async () => {
    await checkTool(
      "jira_add_user_to_group",
      { group: "jira-admins", user: "alice" },
      { group: "jira-admins", user: "bob" },
      (d) => assert.ok(d.users.get("bob")?.groups.has("jira-admins")),
    );
    await checkTool(
      "jira_remove_user_from_group",
      { group: "jira-admins", user: "bob" },
      { group: "jira-admins", user: "alice" },
      (d) => assert.ok(!d.users.get("alice")?.groups.has("jira-admins")),
    );
  });

  it("jira_kill_user_sessions is marked unverifiable", async () => {
    assert.match(describeTool("jira_kill_user_sessions", false)!, /not verifiable/);
    const dry = await run("jira_kill_user_sessions", { user: "alice" }, fakeDirectory().responder);
    assert.match(dry.value.warning, /repeated apply sends it again/);
  });
});
