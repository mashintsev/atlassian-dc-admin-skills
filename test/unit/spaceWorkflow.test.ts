import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { ConfirmationError } from "../../src/confirm.js";
import { createContext } from "../../src/runner.js";
import {
  applySpaceWorkflow,
  applySpaceWorkflowWithConfirmation,
  prepareSpaceUpdates,
  prepareSpaceWorkflowApply,
  readSpaceWorkflowPlan,
  renderSpaceWorkflowPlan,
  verifySpaceWorkflow,
} from "../../src/spaceWorkflow.js";
import { TEST_ENV, testContext } from "./helpers.js";

const counts = JSON.parse(readFileSync("test/fixtures/confluence/space-workflow-cardinalities.json", "utf8"));

function workflowServer(options: { permissionFailure?: boolean; mutationFailure?: boolean; dropGroupReadAfterCategoryMutation?: boolean } = {}) {
  const addedCategories = new Set<string>();
  const addedPermissions = new Map<string, Set<string>>();
  const removedCategories = new Set<string>();
  const removedPermissions = new Map<string, Set<string>>();
  let resolvedUserKey = "SYNTHETIC-ADMIN-KEY";
  let groupHasRead = true;
  const harness = testContext((call) => {
    const url = new URL(call.url);
    if (call.method === "POST" && url.pathname.includes("/category/")) {
      const key = url.pathname.split("/")[4];
      if (options.mutationFailure) return { status: 503 };
      addedCategories.add(key);
      if (options.dropGroupReadAfterCategoryMutation) groupHasRead = false;
      return { body: {} };
    }
    if (call.method === "PUT" && url.pathname.endsWith("/grant")) {
      if (options.mutationFailure) return { status: 503 };
      const key = url.pathname.split("/")[4];
      const granted = addedPermissions.get(key) ?? new Set<string>();
      for (const operation of call.body as Array<{ operationKey: string; targetType: string }>) {
        granted.add(`${operation.operationKey}:${operation.targetType}`);
      }
      addedPermissions.set(key, granted);
      return { body: {} };
    }
    if (url.pathname.startsWith("/rest/api/group/")) {
      return { body: { results: [], size: 0 } };
    }
    if (url.pathname === "/rest/api/user") {
      return { body: {
        username: "sample-admin",
        userKey: resolvedUserKey,
        status: "active",
      } };
    }
    if (url.pathname === "/rest/api/space") {
      if (url.searchParams.get("type") === "global" && url.searchParams.get("status") === "current") {
        const spaces = Array.from({ length: counts.spacesScanned }, (_, index) => ({
          id: `space-id-${index + 1}`,
          key: `S${String(index + 1).padStart(3, "0")}`,
          name: `Synthetic Space ${index + 1}`,
          type: "global",
          status: "current",
        }));
        return { body: { totalSize: spaces.length, results: spaces, _links: {} } };
      }
      return { body: { totalSize: 0, results: [], _links: {} } };
    }
    if (url.pathname.includes("/permissions/group/")) {
      if (options.permissionFailure) return { status: 403 };
      if (!groupHasRead) return { body: [] };
      const key = url.pathname.split("/")[4];
      const index = Number(key.slice(1));
      return {
        body: index <= counts.spacesSelected
          ? [{ subject: { type: "group", name: "sample-team" }, operation: { operationKey: "read", targetType: "space" } }]
          : [],
      };
    }
    if (/\/rest\/api\/space\/S\d{3}$/.test(url.pathname)) {
      const index = Number(url.pathname.split("/").at(-1)!.slice(1));
      const key = url.pathname.split("/").at(-1)!;
      return { body: { metadata: { labels: {
        results: (index <= counts.categoriesAlreadyPresent && !removedCategories.has(key)) || addedCategories.has(key)
          ? [{ prefix: "team", name: "sample-category" }]
          : [],
        _links: {},
      } } } };
    }
    if (url.pathname.includes("/permissions/user/")) {
      const index = Number(url.pathname.split("/")[4].slice(1));
      const operations = new Set(index <= counts.permissionsAlreadySatisfied
        ? ["read:space", "administer:space"]
        : index <= counts.permissionsAlreadySatisfied + counts.readOnlyPermissions
          ? ["read:space"]
          : []);
      for (const operation of addedPermissions.get(`S${String(index).padStart(3, "0")}`) ?? []) operations.add(operation);
      for (const operation of removedPermissions.get(`S${String(index).padStart(3, "0")}`) ?? []) operations.delete(operation);
      return { body: [...operations].map((value) => {
        const [operationKey, targetType] = value.split(":");
        return {
        subject: { type: "user", userKey: resolvedUserKey },
        operation: { operationKey, targetType },
      };
      }) };
    }
    return { body: {} };
  });
  return {
    ...harness,
    setIdentityKey(value: string) { resolvedUserKey = value; },
    setGroupHasRead(value: boolean) { groupHasRead = value; },
    removeCategory(key: string) { removedCategories.add(key); },
    removeUserOperation(key: string, operation: string) {
      const removed = removedPermissions.get(key) ?? new Set<string>();
      removed.add(operation);
      removedPermissions.set(key, removed);
    },
  };
}

describe("Confluence space workflow preparation", () => {
  it("builds a secure read-only plan with the expected synthetic counts", async () => {
    const { ctx, calls } = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-"));
    const file = join(dir, "plan.json");
    const result = await prepareSpaceUpdates(ctx, {
      group: "sample-team",
      category: "sample-category",
      username: "sample-admin",
    }, file);
    const plan = readSpaceWorkflowPlan(file);

    assert.deepEqual([
      result.summary.inspected,
      result.summary.selected,
      result.summary.categoryItems,
      result.summary.permissionItems,
      result.summary.totalItems,
    ], [
      counts.spacesScanned,
      counts.spacesSelected,
      counts.categoryAdditions,
      counts.permissionRequests,
      counts.categoryAdditions + counts.permissionRequests,
    ]);
    assert.equal(plan.spaces.length, counts.verifiedSpaces);
    assert.equal(plan.items.filter((item) => item.kind === "grant" && (item.args.operations as string[]).length === 1).length, counts.adminOnlyRequests);
    assert.equal(plan.items.filter((item) => item.kind === "grant" && (item.args.operations as string[]).length === 2).length, counts.readAndAdminRequests);
    assert.ok(calls.every((call) => call.method === "GET"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(renderSpaceWorkflowPlan(plan, file), /50 categories \| 51 permission grants/);

    const rendered = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "plan", file], {
      encoding: "utf8",
      env: { ...process.env, ...TEST_ENV },
    });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /group: sample-team/);
    assert.match(rendered.stdout, /user: sample-admin \(SYNTHETIC-ADMIN-KEY\)/);
    assert.match(rendered.stdout, /body=\[\{"operationKey":"administer","targetType":"space"\}\]/);
  });

  it("rejects incomplete audits and does not overwrite a fresh plan path", async () => {
    const incomplete = workflowServer({ permissionFailure: true });
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-incomplete-"));
    const absent = join(dir, "incomplete.json");
    await assert.rejects(
      prepareSpaceUpdates(incomplete.ctx, {
        group: "sample-team", category: "sample-category", username: "sample-admin",
      }, absent),
      /discovery is incomplete/,
    );
    assert.equal(incomplete.calls.some((call) => call.method !== "GET"), false);

    const existing = join(dir, "existing.json");
    writeFileSync(existing, "do not replace", { mode: 0o600 });
    const noRead = workflowServer();
    await assert.rejects(
      prepareSpaceUpdates(noRead.ctx, {
        group: "sample-team", category: "sample-category", username: "sample-admin",
      }, existing),
      /Refusing to overwrite/,
    );
    assert.equal(noRead.calls.length, 0);
    assert.equal(readFileSync(existing, "utf8"), "do not replace");
  });

  it("rejects unknown versions and cross-target mutation items", async () => {
    const { ctx } = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-validation-"));
    const planFile = join(dir, "plan.json");
    const { plan } = await prepareSpaceUpdates(ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, planFile);
    const unknownVersion = join(dir, "unknown.json");
    writeFileSync(unknownVersion, JSON.stringify({ ...plan, version: 3 }));
    assert.throws(() => readSpaceWorkflowPlan(unknownVersion), /Invalid version-2/);

    const crossTarget = join(dir, "cross-target.json");
    const changed = structuredClone(plan);
    changed.items[0].request.url = changed.items[0].request.url.replace("wiki.example.com", "elsewhere.invalid");
    writeFileSync(crossTarget, JSON.stringify(changed));
    assert.throws(() => readSpaceWorkflowPlan(crossTarget), /different Confluence instance/);
  });

  it("applies the confirmed 101-item synthetic delta serially and verifies all objective spaces", async () => {
    const { ctx, calls } = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-apply-"));
    const file = join(dir, "plan.json");
    const { plan } = await prepareSpaceUpdates(ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, file);
    const preview = await prepareSpaceWorkflowApply(ctx, plan, file);
    let reviewed = 0;
    const result = await applySpaceWorkflowWithConfirmation(ctx, preview, (items) => {
      reviewed = items.length;
      return items.map((item) => item.n);
    });
    assert.equal(reviewed, 101);

    assert.deepEqual(result.summary, {
      executed: 101,
      alreadySatisfied: 0,
      failed: 0,
      drifted: 0,
      unselected: 0,
      unattempted: 0,
      verificationFailed: 0,
      overallVerified: true,
    });
    assert.equal(result.verification.checkedSpaces, counts.verifiedSpaces);
    assert.equal(result.verification.verifiedSpaces, counts.verifiedSpaces);
    assert.equal(calls.filter((call) => call.method === "POST").length, counts.categoryAdditions);
    assert.equal(calls.filter((call) => call.method === "PUT").length, counts.permissionRequests);
    assert.equal(result.outcome.items.length, counts.categoryAdditions + counts.permissionRequests);
    assert.equal(statSync(`${file}.outcomes.json`).mode & 0o777, 0o600);
    const beforeVerify = calls.length;
    const verification = await verifySpaceWorkflow(ctx, plan, file);
    assert.equal(verification.overallVerified, true);
    assert.equal(calls.slice(beforeVerify).every((call) => call.method === "GET"), true);
  });

  it("records subsets and fail-fast mutation failures without replay", async () => {
    const subset = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-subset-"));
    const file = join(dir, "subset.json");
    const { plan } = await prepareSpaceUpdates(subset.ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, file);
    const preview = await prepareSpaceWorkflowApply(subset.ctx, plan, file, [1]);
    const applied = await applySpaceWorkflow(subset.ctx, preview, [1]);
    assert.equal(applied.summary.executed, 1);
    assert.equal(applied.summary.unselected, 100);
    assert.equal(applied.verification.overallVerified, false);
    assert.equal(subset.calls.filter((call) => call.method === "POST" || call.method === "PUT").length, 1);
    const retryFile = join(dir, "retry.json");
    const retry = await prepareSpaceUpdates(subset.ctx, {
      group: "sample-team",
      category: "sample-category",
      username: "sample-admin",
      previousOutcomes: `${file}.outcomes.json`,
    }, retryFile);
    assert.equal(retry.summary.totalItems, 100);
    assert.equal(retry.plan.previousEvidence?.items.filter((item) => item.status === "executed").length, 1);

    const failing = workflowServer({ mutationFailure: true });
    const failedDir = mkdtempSync(join(tmpdir(), "space-workflow-failure-"));
    const failedFile = join(failedDir, "failed.json");
    const prepared = await prepareSpaceUpdates(failing.ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, failedFile);
    const failedPreview = await prepareSpaceWorkflowApply(failing.ctx, prepared.plan, failedFile);
    const failure = await applySpaceWorkflow(
      failing.ctx,
      failedPreview,
      failedPreview.activeItems.map((active) => active.item.n),
    );
    assert.equal(failure.summary.failed, 1);
    assert.equal(failure.summary.unattempted, 100);
    assert.equal(failing.calls.filter((call) => call.method === "POST" || call.method === "PUT").length, 1);
    await assert.rejects(
      prepareSpaceWorkflowApply(failing.ctx, prepared.plan, failedFile),
      /prepare a fresh plan/,
    );
  });

  it("blocks target, identity, and group-access drift before affected writes", async () => {
    const identity = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-drift-"));
    const file = join(dir, "drift.json");
    const { plan } = await prepareSpaceUpdates(identity.ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, file);
    identity.setIdentityKey("DIFFERENT-USER-KEY");
    await assert.rejects(prepareSpaceWorkflowApply(identity.ctx, plan, file), /immutable workflow plan/);
    assert.equal(identity.calls.filter((call) => call.method === "POST" || call.method === "PUT").length, 0);

    const targetContext = createContext(
      async () => { throw new Error("unexpected request"); },
      { ...TEST_ENV, CONFLUENCE_URL: "https://other.example.invalid" },
    );
    await assert.rejects(prepareSpaceWorkflowApply(targetContext.ctx, plan, file), /target differs/);
    await targetContext.close();

    const group = workflowServer();
    const groupDir = mkdtempSync(join(tmpdir(), "space-workflow-group-drift-"));
    const groupFile = join(groupDir, "group.json");
    const prepared = await prepareSpaceUpdates(group.ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, groupFile);
    group.setGroupHasRead(false);
    const preview = await prepareSpaceWorkflowApply(group.ctx, prepared.plan, groupFile);
    assert.equal(preview.activeItems.length, 0);
    assert.equal(preview.statuses.filter((item) => item.status === "drifted").length, 101);
    const result = await applySpaceWorkflow(group.ctx, preview, []);
    assert.equal(result.summary.executed, 0);
    assert.equal(group.calls.filter((call) => call.method === "POST" || call.method === "PUT").length, 0);
  });

  it("refuses unavailable native confirmation without sending mutations", async () => {
    const { ctx, calls } = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-confirm-"));
    const file = join(dir, "plan.json");
    const { plan } = await prepareSpaceUpdates(ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, file);
    const preview = await prepareSpaceWorkflowApply(ctx, plan, file, [1]);
    const before = process.env.ATLASSIAN_CONFIRM_MODE;
    process.env.ATLASSIAN_CONFIRM_MODE = "tty";
    try {
      await assert.rejects(
        applySpaceWorkflowWithConfirmation(ctx, preview),
        (error: unknown) => error instanceof ConfirmationError && error.name === "ConfirmationUnavailable",
      );
    } finally {
      if (before === undefined) delete process.env.ATLASSIAN_CONFIRM_MODE;
      else process.env.ATLASSIAN_CONFIRM_MODE = before;
    }
    assert.equal(calls.every((call) => call.method === "GET"), true);
  });

  it("fails verification when a desired state or recorded baseline assignment is missing", async () => {
    const { ctx, calls, removeCategory, removeUserOperation } = workflowServer();
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-verify-failure-"));
    const file = join(dir, "plan.json");
    const { plan } = await prepareSpaceUpdates(ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, file);
    removeCategory("S001");
    removeUserOperation("S001", "administer:space");
    const verification = await verifySpaceWorkflow(ctx, plan, file);
    const first = verification.spaces.find((space: any) => space.spaceKey === "S001");

    assert.equal(verification.overallVerified, false);
    assert.equal(first.categoriesPresent, false);
    assert.equal(first.baselineCategoriesPreserved, false);
    assert.equal(first.baselineUserPermissionsPreserved, false);
    assert.equal(calls.every((call) => call.method === "GET"), true);
  });

  it("persists item counts after successful writes fail post-apply verification", async () => {
    const { ctx } = workflowServer({ dropGroupReadAfterCategoryMutation: true });
    const dir = mkdtempSync(join(tmpdir(), "space-workflow-counts-"));
    const file = join(dir, "plan.json");
    const { plan } = await prepareSpaceUpdates(ctx, {
      group: "sample-team", category: "sample-category", username: "sample-admin",
    }, file);
    const preview = await prepareSpaceWorkflowApply(ctx, plan, file);
    const category = preview.activeItems.find((active) => active.item.kind === "category")!;
    const result = await applySpaceWorkflow(ctx, preview, [category.item.n]);
    const persisted = JSON.parse(readFileSync(`${file}.outcomes.json`, "utf8"));

    assert.equal(result.summary.verificationFailed, 1);
    assert.equal(result.verification.itemCounts.verificationFailed, 1);
    assert.equal(persisted.verification.itemCounts.verificationFailed, 1);
  });
});
