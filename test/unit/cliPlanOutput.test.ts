import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { TEST_ENV } from "./helpers.js";

function runPlan(format: string) {
  const dir = mkdtempSync(join(tmpdir(), "cli-plan-output-"));
  const plan = join(dir, "plan.json");
  return spawnSync(process.execPath, [
    "--import", "tsx", "src/cli.ts", "jira_add_user_to_group",
    "group=sample-team", "username=sample-user", `--plan=${plan}`, `--format=${format}`,
  ], { encoding: "utf8", env: { ...process.env, ...TEST_ENV } });
}

describe("CLI plan-save output", () => {
  it("keeps JSON stdout to one parseable document", () => {
    const result = runPlan("json");
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.match(result.stderr, /planned #1/);
  });

  it("keeps compact plan output readable", () => {
    const result = runPlan("compact");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /DRY-RUN/);
    assert.match(result.stdout, /planned #1/);
  });
});
