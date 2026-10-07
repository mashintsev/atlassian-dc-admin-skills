/**
 * Jira admin object lifecycle: remove issue types from an issue type scheme, delete a version,
 * create a permission scheme (optionally copying another one's grants), and create a screen.
 *
 * Paths checked in the Jira DC 11.3 WADL: issue type schemes are replaced whole
 * (`PUT /issuetypescheme/{id}`), versions are deleted with `POST /version/{id}/removeAndSwap`, and
 * permission schemes are created with `POST /permissionscheme`. Jira has no REST path that creates a
 * screen, so `jira_create_screen` is a manual change verified on re-run.
 */

import { z } from "zod";
import { seg, type AtlassianClient } from "../../client.js";
import { isHttpStatusError, ValidationError, VerificationError } from "../../errors.js";
import type { ToolDef } from "../types.js";
import { alreadySatisfied, dryRunShape, guardedWrite, listArg } from "../util.js";
import { resolveIssueType } from "./issueTypeRefs.js";
import { manualChange } from "./projectSchemes.js";

const API = "/rest/api/2";

async function getIssueTypeScheme(client: AtlassianClient, id: number): Promise<any> {
  return client.get(`${API}/issuetypescheme/${id}`, { expand: "issueTypes,defaultIssueType" });
}

/** A version by id, or null when it does not exist (404). */
async function findVersionById(client: AtlassianClient, id: string): Promise<any | null> {
  try {
    return await client.get(`${API}/version/${seg(id)}`);
  } catch (e) {
    if (isHttpStatusError(e) && e.status === 404) return null;
    throw e;
  }
}

const grantKey = (g: any) => `${g.permission}\u0000${g.holder?.type ?? ""}\u0000${g.holder?.parameter ?? ""}`;
const grantLabel = (g: any) => `${g.permission}: ${g.holder?.type}${g.holder?.parameter ? `/${g.holder.parameter}` : ""}`;
const grantSet = (grants: any[]) => [...new Set(grants.map(grantKey))].sort();

async function permissionSchemes(client: AtlassianClient): Promise<any[]> {
  const data = await client.get(`${API}/permissionscheme`);
  return Array.isArray(data) ? data : (data?.permissionSchemes ?? []);
}

async function permissionSchemeGrants(client: AtlassianClient, id: number | string): Promise<{ scheme: any; grants: any[] }> {
  const scheme = await client.get(`${API}/permissionscheme/${seg(id)}`, { expand: "permissions" });
  return { scheme, grants: scheme?.permissions ?? [] };
}

export const jiraAdminLifecycleTools: ToolDef[] = [
  {
    name: "jira_remove_issue_types_from_scheme",
    aliases: { issue_type_ids: "issue_types" },
    product: "jira",
    write: true,
    invalidates: ["screen-usage"],
    description:
      "Remove issue types (ids or exact names) from an issue type scheme, keeping the others. Types not in the scheme → " +
      "already-satisfied; the default type or every type is refused. Jira refuses types still used by issues of the " +
      "scheme's projects (its message is passed on). The scheme is read back.",
    inputShape: {
      scheme_id: z.coerce.number().int(),
      issue_types: listArg.describe("Issue type ids or exact names, comma-separated or array"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const [scheme, allTypes] = await Promise.all([getIssueTypeScheme(c, args.scheme_id), c.get(`${API}/issuetype`)]);
      const types: any[] = Array.isArray(allTypes) ? allTypes : [];
      const refs = [];
      for (const given of args.issue_types) refs.push(await resolveIssueType(c, given, { within: types }));
      const current: string[] = (scheme?.issueTypes ?? []).map((t: any) => String(t.id));
      const requested = [...new Set(refs.map((r) => r.id!))];
      const present = requested.filter((id) => current.includes(id));
      const nameOf = (id: string) => types.find((t) => String(t.id) === id)?.name ?? id;
      const summary = `Issue type scheme '${scheme?.name ?? args.scheme_id}': remove ${requested.map(nameOf).join(", ")}`;
      if (!present.length) return alreadySatisfied(summary, "the scheme has none of these issue types");
      const defaultId = scheme?.defaultIssueType?.id !== undefined ? String(scheme.defaultIssueType.id) : undefined;
      if (defaultId && present.includes(defaultId)) {
        throw new ValidationError(`${nameOf(defaultId)} is the default issue type of '${scheme?.name}'; change the default first`);
      }
      const remaining = current.filter((id) => !present.includes(id));
      if (!remaining.length) throw new ValidationError(`Removing ${present.map(nameOf).join(", ")} would leave '${scheme?.name}' without issue types`);
      const json: Record<string, unknown> = { name: scheme?.name, description: scheme?.description ?? "" };
      if (defaultId) json.defaultIssueTypeId = defaultId;
      json.issueTypeIds = remaining;
      const req = { method: "PUT" as const, path: `${API}/issuetypescheme/${args.scheme_id}`, json, summary };
      if (args.dry_run !== false) {
        return {
          ...(await guardedWrite(c, args, req)),
          // only whether these types are present: other items may add or remove other types of the scheme
          identity: { op: "remove-issue-types-from-scheme", scheme: args.scheme_id, issueTypes: refs.map((r) => JSON.stringify(r.ref)).sort() },
          state: { present: [...present].sort() },
        };
      }
      const result = await guardedWrite(c, args, req);
      const back = await getIssueTypeScheme(c, args.scheme_id);
      const backIds: string[] = (back?.issueTypes ?? []).map((t: any) => String(t.id));
      const left = present.filter((id) => backIds.includes(id));
      const lost = remaining.filter((id) => !backIds.includes(id));
      if (left.length || lost.length) {
        throw new VerificationError(`${summary}: the scheme reads back differently`, { issueTypeIds: backIds, stillPresent: left, missing: lost });
      }
      return { ...result, result: { issueTypes: backIds.map(nameOf) } };
    },
  },
  {
    name: "jira_delete_version",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Delete a project version (id, or exact name with project_key). Irreversible. Optionally move its fix-version and " +
      "affected-version issues to another version of the project (move_fix_issues_to, move_affected_issues_to: id or " +
      "name); the dry run shows the issue counts. Already deleted → already-satisfied.",
    inputShape: {
      version: z.coerce.string().min(1).describe("Version id, or exact name with project_key"),
      project_key: z.string().min(1).optional(),
      move_fix_issues_to: z.coerce.string().min(1).optional(),
      move_affected_issues_to: z.coerce.string().min(1).optional(),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const byId = /^\d+$/.test(args.version);
      if (!byId && !args.project_key) throw new ValidationError("Pass project_key with a version name, or the version id");
      let version: any | null;
      let versions: any[] | undefined;
      if (byId) {
        version = await findVersionById(c, args.version);
      } else {
        versions = (await c.get(`${API}/project/${seg(args.project_key)}/versions`)) ?? [];
        version = versions!.find((v) => v.name === args.version) ?? null;
      }
      const summary = `Delete version '${version?.name ?? args.version}'${args.project_key ? ` of ${args.project_key}` : ""}`;
      if (!version) return alreadySatisfied(summary, "no such version");
      versions ??= (await c.get(`${API}/project/${seg(args.project_key ?? version.projectId)}/versions`)) ?? [];
      const target = (given: string | undefined, label: string) => {
        if (given === undefined) return undefined;
        const t = versions!.find((v) => String(v.id) === given) ?? versions!.find((v) => v.name === given);
        if (!t) throw new ValidationError(`${label}: no version '${given}' in the project`);
        if (String(t.id) === String(version.id)) throw new ValidationError(`${label}: issues cannot move to the version being deleted`);
        return t;
      };
      const fixTo = target(args.move_fix_issues_to, "move_fix_issues_to");
      const affectedTo = target(args.move_affected_issues_to, "move_affected_issues_to");
      const counts = await c.get(`${API}/version/${seg(version.id)}/relatedIssueCounts`);
      const json: Record<string, unknown> = {};
      if (fixTo) json.moveFixIssuesTo = Number(fixTo.id);
      if (affectedTo) json.moveAffectedIssuesTo = Number(affectedTo.id);
      const moves = [
        fixTo ? `fix version issues → ${fixTo.name}` : "fix version issues lose the version",
        affectedTo ? `affected version issues → ${affectedTo.name}` : "affected version issues lose the version",
      ].join("; ");
      const req = { method: "POST" as const, path: `${API}/version/${seg(version.id)}/removeAndSwap`, json, summary };
      if (args.dry_run !== false) {
        return {
          ...(await guardedWrite(c, args, req)),
          issues: { fixVersion: Number(counts?.issuesFixedCount ?? 0), affectsVersion: Number(counts?.issuesAffectedCount ?? 0) },
          moves,
          warning: "Deleting a version is irreversible.",
          identity: { op: "delete-version", version: args.version, project: args.project_key ?? null, fixTo: fixTo?.name ?? null, affectedTo: affectedTo?.name ?? null },
          state: { exists: true },
        };
      }
      const result = await guardedWrite(c, args, req);
      const back = await findVersionById(c, String(version.id));
      if (back) throw new VerificationError(`${summary}: the version still exists`, { id: back.id, name: back.name });
      return { ...result, result: { deleted: { id: String(version.id), name: version.name }, moves } };
    },
  },
  {
    name: "jira_create_permission_scheme",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a permission scheme, optionally with every grant of another scheme (copy_from: id or exact name; the dry " +
      "run lists them). Same name and content → already-satisfied; same name, other content → error. Read back, grants " +
      "included. Assign it to projects with jira_set_project_permission_scheme.",
    inputShape: {
      name: z.string().trim().min(1),
      description: z.string().optional(),
      copy_from: z.coerce.string().min(1).optional().describe("Permission scheme id or exact name whose grants are copied"),
      ...dryRunShape,
    },
    async handler({ client }, args) {
      const c = client("jira");
      const schemes = await permissionSchemes(c);
      let grants: any[] = [];
      let sourceName: string | undefined;
      if (args.copy_from !== undefined) {
        const src = schemes.find((s) => String(s.id) === args.copy_from) ?? schemes.find((s) => s.name === args.copy_from);
        if (!src) throw new ValidationError(`copy_from: no permission scheme '${args.copy_from}'`);
        const read = await permissionSchemeGrants(c, src.id);
        grants = read.grants.map((g: any) => ({ permission: g.permission, holder: { type: g.holder?.type, ...(g.holder?.parameter !== undefined ? { parameter: g.holder.parameter } : {}) } }));
        sourceName = src.name;
      }
      const description = args.description ?? "";
      const summary = `Create permission scheme '${args.name}'${sourceName ? ` with the ${grants.length} grants of '${sourceName}'` : ""}`;
      const existing = schemes.find((s) => s.name === args.name);
      if (existing) {
        const { scheme, grants: have } = await permissionSchemeGrants(c, existing.id);
        const same = (scheme?.description ?? "") === description && JSON.stringify(grantSet(have)) === JSON.stringify(grantSet(grants));
        if (same) return alreadySatisfied(summary, `permission scheme ${existing.id} already exists with this content`, { created: { type: "permission-scheme", name: args.name, id: String(existing.id) } });
        throw new ValidationError(`Permission scheme '${args.name}' (${existing.id}) already exists with other content (${have.length} grants)`);
      }
      const json = { name: args.name, description, permissions: grants };
      const req = { method: "POST" as const, path: `${API}/permissionscheme`, json, summary };
      if (args.dry_run !== false) {
        return {
          ...(await guardedWrite(c, args, req)),
          grants: grants.map(grantLabel),
          identity: { op: "create-permission-scheme", name: args.name, description, copyFrom: args.copy_from ?? null },
          state: { exists: false, grants: grantSet(grants) },
        };
      }
      const created = await c.request("POST", req.path, { json });
      const id = created?.id;
      if (id === undefined || id === null) throw new VerificationError(`${summary}: Jira returned no id`, created);
      const back = await permissionSchemeGrants(c, id);
      const missing = grantSet(grants).filter((k) => !grantSet(back.grants).includes(k));
      if (back.scheme?.name !== args.name || missing.length) {
        throw new VerificationError(`${summary}: the new scheme reads back without ${missing.length} grant(s)`, { name: back.scheme?.name, missing: missing.map((k) => k.split("\u0000").join(" ")) });
      }
      return {
        dry_run: false,
        product: c.product,
        summary,
        request: (await guardedWrite(c, { dry_run: true }, req)).request,
        result: { id: String(id), name: args.name, grants: back.grants.length },
        created: { type: "permission-scheme", name: args.name, id: String(id) },
      };
    },
  },
  {
    name: "jira_create_screen",
    product: "jira",
    write: true,
    invalidates: [],
    description:
      "Create a screen. Jira's REST API has no screen creation, so this is a manual change with the admin link; re-run " +
      "to verify. Same name and description → already-satisfied; same name with another description → error.",
    inputShape: { name: z.string().trim().min(1), description: z.string().optional(), ...dryRunShape },
    async handler({ client }, args) {
      const c = client("jira");
      // Jira DC requires startAt together with maxResults here (HTTP 400 otherwise)
      const data = await c.get(`${API}/screens`, { search: args.name, startAt: 0, maxResults: 100 });
      const list: any[] = Array.isArray(data) ? data : (data?.values ?? data?.screens ?? []);
      const existing = list.find((s) => s.name === args.name);
      const summary = `Create screen '${args.name}'`;
      if (existing) {
        if ((existing.description ?? "") === (args.description ?? "")) {
          return alreadySatisfied(summary, `screen ${existing.id} already exists`, { created: { type: "screen", name: args.name, id: String(existing.id) } });
        }
        throw new ValidationError(`Screen '${args.name}' (${existing.id}) already exists with another description`);
      }
      return manualChange(c, args, {
        summary,
        reason: "Jira's REST API has no screen creation (checked in the WADL)",
        editUrl: "/secure/admin/ViewFieldScreens.jspa",
        identity: { op: "create-screen", name: args.name, description: args.description ?? "" },
        state: { exists: false },
        extra: { enter: { name: args.name, description: args.description ?? "" } },
      });
    },
  },
];
