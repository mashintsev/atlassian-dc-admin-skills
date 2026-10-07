import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseArgs } from "../../src/cli.js";
import { runToolByName } from "../../src/runner.js";
import { testContext } from "./helpers.js";

const BROKEN = '[{"date":"2026-01-01"';

async function run(tool: string, ...argv: string[]) {
  const { ctx, calls } = testContext(() => ({ body: {} }));
  const r = await runToolByName(tool, parseArgs(argv).args, ctx);
  return { r, calls };
}

describe("malformed JSON arguments (fix-cli-output 3.3)", () => {
  for (const [tool, args] of [
    ["jira_create_sla_calendar", ["service_desk=TEST", "name=Cal", "time_zone=UTC", "working_hours=24x7", `holidays=${BROKEN}`]],
    ["jira_update_sla_calendar", ["service_desk=TEST", "calendar=Cal", `holidays=${BROKEN}`]],
    ["jira_batch_create_versions", ["project_key=TEST", `versions=${BROKEN}`]],
    ["jira_create_sla", ["service_desk=TEST", "name=TTR", "start=Issue created", "stop=Resolution: Set", `goals=${BROKEN}`]],
  ] as const) {
    it(`${tool}: a ValidationError naming the parameter, before any request`, async () => {
      const { r, calls } = await run(tool, ...args);
      assert.equal(r.ok, false);
      const err = (r as any).error;
      assert.equal(err.type, "ValidationError", JSON.stringify(err));
      const param = args.at(-1)!.split("=")[0];
      assert.ok(err.issues.some((i: string) => i.startsWith(`${param}:`) && /invalid JSON/.test(i) && /expected e\.g\./.test(i)), JSON.stringify(err.issues));
      assert.equal(calls.length, 0);
    });
  }
});
