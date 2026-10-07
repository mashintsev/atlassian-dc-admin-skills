import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addResultToPlan, applyPlan, readPlan } from "../../src/plan.js";
import { runToolByName } from "../../src/runner.js";
import { testContext, type Call } from "./helpers.js";

const path = (c: Call) => decodeURIComponent(new URL(c.url).pathname);

/**
 * Fake Confluence: users, groups, memberships, labels, space permissions and space status in memory.
 * `ignore` makes the server accept a write without changing anything (for read-back mismatches).
 */
function fakeConfluence(opts: { ignore?: boolean } = {}) {
  const users = new Map<string, { status: string }>([["alice", { status: "active" }], ["bob", { status: "inactive" }]]);
  const groups = new Set(["team-a", "team-b"]);
  const members = new Map<string, Set<string>>([["alice", new Set(["team-a"])], ["bob", new Set()]]);
  const labels = new Map<string, Set<string>>([["42", new Set(["global:existing"])]]);
  const perms = new Map<string, Set<string>>([["DOC|group|team-a", new Set(["read:space"])]]);
  const spaces = new Map<string, string>([["DOC", "current"], ["OLD", "archived"]]);
  const permKey = (space: string, type: string, subject?: string) => `${space}|${type}|${subject ?? ""}`;

  const responder = (c: Call) => {
    const p = path(c);
    const q = new URL(c.url).searchParams;
    let m: RegExpExecArray | null;
    // users
    if (p === "/rest/api/user" && c.method === "GET") {
      const u = users.get(q.get("username") ?? "");
      return u ? { body: { username: q.get("username"), userKey: `key-${q.get("username")}`, status: u.status } } : { status: 404, body: {} };
    }
    if (p === "/rest/api/user/memberof") {
      const g = members.get(q.get("username") ?? "");
      if (!g) return { status: 404, body: {} };
      return { body: { results: [...g].map((name) => ({ name, type: "group" })), _links: {} } };
    }
    if (p === "/rest/api/admin/user" && c.method === "POST") {
      if (!opts.ignore) {
        users.set(c.body.userName, { status: "active" });
        members.set(c.body.userName, new Set());
      }
      return { body: {} };
    }
    if ((m = /^\/rest\/api\/admin\/user\/([^/]+)\/(enable|disable)$/.exec(p))) {
      if (!opts.ignore) users.get(m[1]!)!.status = m[2] === "enable" ? "active" : "inactive";
      return { status: 204, body: "" };
    }
    // groups
    if ((m = /^\/rest\/api\/group\/([^/]+)$/.exec(p)) && c.method === "GET") {
      return groups.has(m[1]!) ? { body: { type: "group", name: m[1] } } : { status: 404, body: {} };
    }
    if (p === "/rest/api/admin/group" && c.method === "POST") {
      if (!opts.ignore) groups.add(c.body.name);
      return { body: {} };
    }
    if ((m = /^\/rest\/api\/admin\/group\/([^/]+)$/.exec(p)) && c.method === "DELETE") {
      if (!opts.ignore) groups.delete(m[1]!);
      return { status: 204, body: "" };
    }
    if ((m = /^\/rest\/api\/user\/([^/]+)\/group\/([^/]+)$/.exec(p))) {
      if (!opts.ignore) {
        const set = members.get(m[1]!)!;
        if (c.method === "PUT") set.add(m[2]!);
        else set.delete(m[2]!);
      }
      return { status: 204, body: "" };
    }
    // labels
    if ((m = /^\/rest\/api\/content\/([^/]+)\/label$/.exec(p))) {
      const set = labels.get(m[1]!) ?? new Set<string>();
      labels.set(m[1]!, set);
      if (c.method === "POST") {
        if (!opts.ignore) for (const l of c.body) set.add(`${l.prefix}:${l.name}`);
        return { body: {} };
      }
      const prefix = q.get("prefix");
      const results = [...set].map((v) => ({ prefix: v.split(":")[0], name: v.split(":")[1] })).filter((l) => !prefix || l.prefix === prefix);
      return { body: { results, _links: {} } };
    }
    // space permissions
    if ((m = /^\/rest\/api\/space\/([^/]+)\/permissions\/(user|group|anonymous)(?:\/([^/]+))?(\/grant|\/revoke)?$/.exec(p))) {
      const [, space, type, subjectOrAction, action] = m;
      const subject = subjectOrAction;
      const key = permKey(space!, type!, type === "anonymous" ? undefined : subject);
      const set = perms.get(key) ?? new Set<string>();
      perms.set(key, set);
      if (c.method === "PUT") {
        if (!opts.ignore) for (const o of c.body) (action === "/grant" ? set.add(`${o.operationKey}:${o.targetType}`) : set.delete(`${o.operationKey}:${o.targetType}`));
        return { body: {} };
      }
      return { body: [...set].map((v) => ({ subject: { type, name: subject }, operation: { operationKey: v.split(":")[0], targetType: v.split(":")[1] } })) };
    }
    // spaces
    if ((m = /^\/rest\/api\/space\/([^/]+)\/archive$/.exec(p)) && c.method === "PUT") {
      if (!opts.ignore) spaces.set(m[1]!, "archived");
      return { body: {} };
    }
    if ((m = /^\/rest\/api\/space\/([^/]+)$/.exec(p))) {
      if (c.method === "DELETE") {
        if (!opts.ignore) spaces.delete(m[1]!);
        return { status: 202, body: { id: "task-1", links: { status: "/rest/api/longtask/task-1" } } };
      }
      const status = spaces.get(m[1]!);
      return status ? { body: { key: m[1], name: m[1], status } } : { status: 404, body: {} };
    }
    return undefined;
  };
  return { responder, users, groups, members, labels, perms, spaces };
}

async function run(name: string, args: Record<string, unknown>, responder: (c: Call) => any) {
  const { ctx, calls } = testContext(responder);
  const res = await runToolByName(name, args, ctx);
  return { value: res.ok ? (res.value as any) : undefined, error: res.ok ? undefined : (res as any).error, calls };
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");

/** For each tool: already-satisfied args (nothing sent), args that change the state, and a check of the new state. */
const CASES: Array<{ tool: string; satisfied: Record<string, unknown>; change: Record<string, unknown>; applied: (f: ReturnType<typeof fakeConfluence>) => boolean }> = [
  { tool: "confluence_create_user", satisfied: { username: "alice", full_name: "Alice", email: "a@example.com" }, change: { username: "carol", full_name: "Carol", email: "c@example.com" }, applied: (f) => f.users.has("carol") },
  { tool: "confluence_set_user_enabled", satisfied: { user: "alice", enabled: true }, change: { user: "bob", enabled: true }, applied: (f) => f.users.get("bob")!.status === "active" },
  { tool: "confluence_create_group", satisfied: { name: "team-a" }, change: { name: "team-c" }, applied: (f) => f.groups.has("team-c") },
  { tool: "confluence_delete_group", satisfied: { name: "team-z" }, change: { name: "team-b" }, applied: (f) => !f.groups.has("team-b") },
  { tool: "confluence_add_user_to_group", satisfied: { user: "alice", group: "team-a" }, change: { user: "alice", group: "team-b" }, applied: (f) => f.members.get("alice")!.has("team-b") },
  { tool: "confluence_remove_user_from_group", satisfied: { user: "alice", group: "team-b" }, change: { user: "alice", group: "team-a" }, applied: (f) => !f.members.get("alice")!.has("team-a") },
  { tool: "confluence_add_label", satisfied: { content_id: "42", names: "existing" }, change: { content_id: "42", names: "existing,Release Notes" }, applied: (f) => f.labels.get("42")!.has("global:release-notes") },
  { tool: "confluence_grant_space_permissions", satisfied: { space_key: "DOC", subject_type: "group", subject: "team-a", operations: "read:space" }, change: { space_key: "DOC", subject_type: "group", subject: "team-a", operations: "read:space,create:page" }, applied: (f) => f.perms.get("DOC|group|team-a")!.has("create:page") },
  { tool: "confluence_revoke_space_permissions", satisfied: { space_key: "DOC", subject_type: "group", subject: "team-a", operations: "delete:space" }, change: { space_key: "DOC", subject_type: "group", subject: "team-a", operations: "read:space" }, applied: (f) => !f.perms.get("DOC|group|team-a")!.has("read:space") },
  { tool: "confluence_archive_space", satisfied: { space_key: "OLD" }, change: { space_key: "DOC" }, applied: (f) => f.spaces.get("DOC") === "archived" },
  { tool: "confluence_delete_space", satisfied: { space_key: "GONE" }, change: { space_key: "DOC" }, applied: (f) => !f.spaces.has("DOC") },
];

describe("Confluence write safety (unify 3.1, 3.2)", () => {
  for (const c of CASES) {
    describe(c.tool, () => {
      it("reports already-satisfied and sends nothing when the target state holds", async () => {
        const f = fakeConfluence();
        for (const dry of [true, false]) {
          const r = await run(c.tool, { ...c.satisfied, dry_run: !dry ? false : undefined }, f.responder);
          assert.equal(r.value?.already_satisfied, true, `${c.tool}: ${JSON.stringify(r.error ?? r.value)}`);
          assert.deepEqual(writes(r.calls), []);
        }
      });

      it("executes and reads the result back", async () => {
        const f = fakeConfluence();
        const r = await run(c.tool, { ...c.change, dry_run: false }, f.responder);
        assert.ok(r.value && !r.error, `${c.tool}: ${JSON.stringify(r.error)}`);
        assert.ok(c.applied(f), `${c.tool}: state not changed`);
        if (c.tool !== "confluence_delete_space") assert.ok(r.calls.filter((x) => x.method === "GET").length >= 2, "read before and after");
      });

      if (c.tool !== "confluence_delete_space") {
        it("fails with VerificationError when the read-back does not show the change", async () => {
          const r = await run(c.tool, { ...c.change, dry_run: false }, fakeConfluence({ ignore: true }).responder);
          assert.equal(r.error?.type, "VerificationError", `${c.tool}: ${JSON.stringify(r.error ?? r.value)}`);
        });
      }
    });
  }

  it("keeps the grant request shape (all requested operations) used by the space workflow", async () => {
    const r = await run("confluence_grant_space_permissions", { space_key: "DOC", subject_type: "group", subject: "team-a", operations: "read:space,create:page" }, fakeConfluence().responder);
    assert.equal(r.value.request.method, "PUT");
    assert.equal(r.value.request.url, "https://wiki.example.com/rest/api/space/DOC/permissions/group/team-a/grant");
    assert.deepEqual(r.value.request.body, [{ operationKey: "read", targetType: "space" }, { operationKey: "create", targetType: "page" }]);
  });

  it("applies two grants for one space in one plan without drift", async () => {
    const f = fakeConfluence();
    const file = join(mkdtempSync(join(tmpdir(), "plan-")), "p.json");
    for (const ops of ["create:page", "create:blogpost"]) {
      const args = { space_key: "DOC", subject_type: "group", subject: "team-a", operations: ops };
      addResultToPlan(file, "confluence_grant_space_permissions", args, (await run("confluence_grant_space_permissions", args, f.responder)).value);
    }
    const out = await applyPlan(testContext(f.responder).ctx, readPlan(file), undefined, file);
    assert.deepEqual(out.map((o) => o.status), ["done", "done"], JSON.stringify(out));
    const set = f.perms.get("DOC|group|team-a")!;
    assert.ok(set.has("create:page") && set.has("create:blogpost"));
  });

  it("describes space deletion as a long task that is only polled", async () => {
    const { findTool } = await import("../../src/tools/index.js");
    assert.match(findTool("confluence_delete_space")!.description, /long task/i);
  });
});
