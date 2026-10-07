import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runToolByName } from "../../src/runner.js";
import { describeTool } from "../../src/cli.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => new URL(c.url).pathname;
const q = (c: Call) => new URL(c.url).searchParams;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { res, value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}

// ---- project roles ----------------------------------------------------------------------------

function fakeRole(initial: { users?: string[]; groups?: string[] } = {}, opts: { ignore?: boolean } = {}) {
  const role = { users: [...(initial.users ?? [])], groups: [...(initial.groups ?? [])] };
  const responder = (c: Call) => {
    if (path(c) !== "/rest/api/2/project/TEST/role/10002") return undefined;
    if (c.method === "POST" && !opts.ignore) {
      role.users.push(...(c.body.user ?? []));
      role.groups.push(...(c.body.group ?? []));
    }
    if (c.method === "DELETE" && !opts.ignore) {
      role.users = role.users.filter((u) => u !== q(c).get("user"));
      role.groups = role.groups.filter((g) => g !== q(c).get("group"));
    }
    return {
      body: {
        id: 10002, name: "Developers",
        actors: [
          ...role.users.map((name) => ({ type: "atlassian-user-role-actor", name })),
          ...role.groups.map((name) => ({ type: "atlassian-group-role-actor", name })),
        ],
      },
    };
  };
  return { responder, role };
}

describe("project role actors (unify 2.2)", () => {
  it("adding present actors is already satisfied; only missing ones are sent, then read back", async () => {
    const f = fakeRole({ users: ["alice"], groups: ["ops"] });
    const same = await run("jira_add_project_role_actors", { project_key: "TEST", role_id: 10002, users: "alice", groups: "ops", dry_run: false }, f.responder);
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    assert.equal(writes(same.calls).length, 0);
    const dry = await run("jira_add_project_role_actors", { project_key: "TEST", role_id: 10002, users: "alice,bob" }, f.responder);
    assert.deepEqual(dry.value.request.body, { user: ["bob"] });
    assert.deepEqual(dry.value.state, { present: ["user:alice"] });
    const r = await run("jira_add_project_role_actors", { project_key: "TEST", role_id: 10002, users: "alice,bob", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(f.role.users.sort(), ["alice", "bob"]);
  });

  it("fails verification when the role does not show the actors afterwards", async () => {
    const r = await run("jira_add_project_role_actors", { project_key: "TEST", role_id: 10002, groups: "dev", dry_run: false }, fakeRole({}, { ignore: true }).responder);
    assert.equal(r.error?.type, "VerificationError");
  });

  it("removing an absent actor is already satisfied; removal is read back", async () => {
    const f = fakeRole({ users: ["alice"] });
    const gone = await run("jira_remove_project_role_actor", { project_key: "TEST", role_id: 10002, user: "bob", dry_run: false }, f.responder);
    assert.equal(gone.value?.already_satisfied, true);
    assert.equal(writes(gone.calls).length, 0);
    const r = await run("jira_remove_project_role_actor", { project_key: "TEST", role_id: 10002, user: "alice", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.deepEqual(f.role.users, []);
    const stuck = await run("jira_remove_project_role_actor", { project_key: "TEST", role_id: 10002, user: "alice", dry_run: false }, fakeRole({ users: ["alice"] }, { ignore: true }).responder);
    assert.equal(stuck.error?.type, "VerificationError");
  });
});

// ---- permission scheme assignment, archive, restore ----------------------------------------------

function fakeProject(opts: { scheme?: number; archived?: boolean; ignore?: boolean } = {}) {
  const state = { scheme: opts.scheme ?? 0, archived: opts.archived ?? false };
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/project/TEST/permissionscheme") {
      if (c.method === "PUT" && !opts.ignore) state.scheme = Number(c.body.id);
      return { body: { id: state.scheme, name: `Scheme ${state.scheme}` } };
    }
    if (p === "/rest/api/2/project/TEST/archive" && c.method === "PUT") {
      if (!opts.ignore) state.archived = true;
      return { status: 204, body: "" };
    }
    if (p === "/rest/api/2/project/TEST/restore" && c.method === "PUT") {
      if (!opts.ignore) state.archived = false;
      return { status: 204, body: "" };
    }
    if (p === "/rest/api/2/project/TEST") return { body: { key: "TEST", archived: state.archived } };
    return undefined;
  };
  return { responder, state };
}

describe("permission scheme assignment, archive and restore (unify 2.2)", () => {
  it("assigning the current scheme is already satisfied; a new one is read back", async () => {
    const same = await run("jira_set_project_permission_scheme", { project_key: "TEST", scheme_id: 5, dry_run: false }, fakeProject({ scheme: 5 }).responder);
    assert.equal(same.value?.already_satisfied, true);
    assert.equal(writes(same.calls).length, 0);
    const f = fakeProject({ scheme: 5 });
    const r = await run("jira_set_project_permission_scheme", { project_key: "TEST", scheme_id: 7, dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.state.scheme, 7);
    const stuck = await run("jira_set_project_permission_scheme", { project_key: "TEST", scheme_id: 7, dry_run: false }, fakeProject({ scheme: 5, ignore: true }).responder);
    assert.equal(stuck.error?.type, "VerificationError");
  });

  it("archive and restore follow the archived flag", async () => {
    const done = await run("jira_archive_project", { project_key: "TEST", dry_run: false }, fakeProject({ archived: true }).responder);
    assert.equal(done.value?.already_satisfied, true);
    assert.equal(writes(done.calls).length, 0);
    const f = fakeProject();
    assert.ok((await run("jira_archive_project", { project_key: "TEST", dry_run: false }, f.responder)).res.ok);
    assert.equal(f.state.archived, true);
    const stuck = await run("jira_archive_project", { project_key: "TEST", dry_run: false }, fakeProject({ ignore: true }).responder);
    assert.equal(stuck.error?.type, "VerificationError");
    const active = await run("jira_restore_project", { project_key: "TEST", dry_run: false }, fakeProject().responder);
    assert.equal(active.value?.already_satisfied, true);
    const g = fakeProject({ archived: true });
    assert.ok((await run("jira_restore_project", { project_key: "TEST", dry_run: false }, g.responder)).res.ok);
    assert.equal(g.state.archived, false);
    const stuck2 = await run("jira_restore_project", { project_key: "TEST", dry_run: false }, fakeProject({ archived: true, ignore: true }).responder);
    assert.equal(stuck2.error?.type, "VerificationError");
  });
});

// ---- permission grants ----------------------------------------------------------------------

function fakeScheme(grants: Array<{ id: number; permission: string; holder: any }>, opts: { ignore?: boolean } = {}) {
  const state = { grants: [...grants], next: 500 };
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/permissionscheme/10000/permission" && c.method === "POST") {
      const g = { id: state.next++, permission: c.body.permission, holder: c.body.holder };
      if (!opts.ignore) state.grants.push(g);
      return { status: 201, body: g };
    }
    const del = /^\/rest\/api\/2\/permissionscheme\/10000\/permission\/(\d+)$/.exec(p);
    if (del && c.method === "DELETE") {
      if (!opts.ignore) state.grants = state.grants.filter((g) => g.id !== Number(del[1]));
      return { status: 204, body: "" };
    }
    if (p === "/rest/api/2/permissionscheme/10000") return { body: { id: 10000, name: "Default", permissions: state.grants } };
    return undefined;
  };
  return { responder, state };
}

const BROWSE_GROUP = { id: 10, permission: "BROWSE_PROJECTS", holder: { type: "group", parameter: "ops" } };

describe("permission grants (unify 2.2)", () => {
  it("an existing grant is already satisfied; a new grant is read back", async () => {
    const same = await run("jira_add_permission_grant", { scheme_id: 10000, permission: "BROWSE_PROJECTS", holder_type: "group", holder_parameter: "ops", dry_run: false }, fakeScheme([BROWSE_GROUP]).responder);
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    assert.equal(writes(same.calls).length, 0);
    const f = fakeScheme([BROWSE_GROUP]);
    const dry = await run("jira_add_permission_grant", { scheme_id: 10000, permission: "BROWSE_PROJECTS", holder_type: "group", holder_parameter: "dev" }, f.responder);
    assert.deepEqual(dry.value.state, { holders: ["group:ops"] });
    const r = await run("jira_add_permission_grant", { scheme_id: 10000, permission: "BROWSE_PROJECTS", holder_type: "group", holder_parameter: "dev", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(f.state.grants.length, 2);
  });

  it("a grant that does not show afterwards fails with the scheme's grants for that permission", async () => {
    const r = await run("jira_add_permission_grant", { scheme_id: 10000, permission: "BROWSE_PROJECTS", holder_type: "group", holder_parameter: "dev", dry_run: false }, fakeScheme([BROWSE_GROUP], { ignore: true }).responder);
    assert.equal(r.error?.type, "VerificationError");
    assert.deepEqual(r.error.state, { permission: "BROWSE_PROJECTS", holders: ["group:ops"] });
  });

  it("deleting an absent grant is already satisfied; a deletion is read back", async () => {
    const gone = await run("jira_delete_permission_grant", { scheme_id: 10000, grant_id: 99, dry_run: false }, fakeScheme([BROWSE_GROUP]).responder);
    assert.equal(gone.value?.already_satisfied, true);
    assert.equal(writes(gone.calls).length, 0);
    const f = fakeScheme([BROWSE_GROUP]);
    assert.ok((await run("jira_delete_permission_grant", { scheme_id: 10000, grant_id: 10, dry_run: false }, f.responder)).res.ok);
    assert.equal(f.state.grants.length, 0);
    const stuck = await run("jira_delete_permission_grant", { scheme_id: 10000, grant_id: 10, dry_run: false }, fakeScheme([BROWSE_GROUP], { ignore: true }).responder);
    assert.equal(stuck.error?.type, "VerificationError");
  });
});

// ---- issue type creation ----------------------------------------------------------------------

function fakeIssueTypes(opts: { ignore?: boolean } = {}) {
  const types: any[] = [{ id: "1", name: "Bug", subtask: false, description: "A problem" }];
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/issuetype" && c.method === "POST") {
      const t = { id: "10200", name: c.body.name, subtask: c.body.type === "subtask", description: c.body.description ?? "" };
      if (!opts.ignore) types.push(t);
      return { status: 201, body: t };
    }
    if (p === "/rest/api/2/issuetype") return { body: types };
    const one = /^\/rest\/api\/2\/issuetype\/(\d+)$/.exec(p);
    if (one) {
      const t = types.find((x) => x.id === one[1]);
      return t ? { body: t } : { status: 404, body: {} };
    }
    return undefined;
  };
  return { responder, types };
}

describe("issue type creation (unify 2.2)", () => {
  it("the same name and settings is already satisfied; other settings are an error", async () => {
    const same = await run("jira_create_issue_type", { name: "Bug", description: "A problem", dry_run: false }, fakeIssueTypes().responder);
    assert.equal(same.value?.already_satisfied, true, JSON.stringify(same.error ?? same.value));
    assert.equal(writes(same.calls).length, 0);
    const other = await run("jira_create_issue_type", { name: "Bug", subtask: true }, fakeIssueTypes().responder);
    assert.equal(other.res.ok, false);
  });

  it("creates and reads back; a missing type afterwards fails verification", async () => {
    const f = fakeIssueTypes();
    const r = await run("jira_create_issue_type", { name: "Risk", dry_run: false }, f.responder);
    assert.ok(r.res.ok, JSON.stringify(r.error));
    assert.equal(r.value.result.id, "10200");
    const stuck = await run("jira_create_issue_type", { name: "Risk", dry_run: false }, fakeIssueTypes({ ignore: true }).responder);
    assert.equal(stuck.error?.type, "VerificationError");
  });
});

// ---- application property and reindex -----------------------------------------------------------

function fakeProperty(value: string, opts: { ignore?: boolean } = {}) {
  const state = { value };
  const responder = (c: Call) => {
    const p = path(c);
    if (p === "/rest/api/2/application-properties/jira.title" && c.method === "PUT") {
      if (!opts.ignore) state.value = c.body.value;
      return { body: {} };
    }
    if (p === "/rest/api/2/application-properties") return { body: { id: "jira.title", key: "jira.title", value: state.value } };
    return undefined;
  };
  return { responder, state };
}

describe("application property and reindex (unify 2.4)", () => {
  it("setting the current value is already satisfied; a new value is read back", async () => {
    const same = await run("jira_set_application_property", { key: "jira.title", value: "Jira", dry_run: false }, fakeProperty("Jira").responder);
    assert.equal(same.value?.already_satisfied, true);
    assert.equal(writes(same.calls).length, 0);
    const f = fakeProperty("Jira");
    const dry = await run("jira_set_application_property", { key: "jira.title", value: "Tracker" }, f.responder);
    assert.deepEqual(dry.value.state, { value: "Jira" });
    assert.ok((await run("jira_set_application_property", { key: "jira.title", value: "Tracker", dry_run: false }, f.responder)).res.ok);
    assert.equal(f.state.value, "Tracker");
    const stuck = await run("jira_set_application_property", { key: "jira.title", value: "Tracker", dry_run: false }, fakeProperty("Jira", { ignore: true }).responder);
    assert.equal(stuck.error?.type, "VerificationError");
  });

  it("reindex starts are marked unverifiable", async () => {
    for (const tool of ["jira_start_reindex", "confluence_start_reindex"]) {
      assert.match(describeTool(tool, false)!, /not verifiable: /, tool);
      const dry = await run(tool, {}, () => ({ body: {} }));
      assert.match(dry.value.warning, /repeated apply sends it again/, tool);
    }
  });
});
