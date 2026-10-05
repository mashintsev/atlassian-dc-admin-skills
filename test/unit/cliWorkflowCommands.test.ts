import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { TEST_ENV } from "./helpers.js";

const runCli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
  encoding: "utf8",
  env: { ...process.env, ...TEST_ENV },
});

describe("space workflow CLI validation", () => {
  it("rejects incomplete preparation inputs before contacting the instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-space-prepare-"));
    const file = join(dir, "plan.json");
    const result = runCli("prepare-space-updates", "group=sample-team", "username=sample-admin", `--plan=${file}`);

    assert.equal(result.status, 7);
    assert.match(result.stdout, /supported category naming rules/);
    assert.throws(() => readFileSync(file));
  });

  it("rejects malformed --only values instead of applying the whole plan", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-space-apply-"));
    const file = join(dir, "plan.json");
    writeFileSync(file, JSON.stringify({ version: 1, items: [] }));
    const result = runCli("apply", file, "--only=not-a-number");

    assert.equal(result.status, 7);
    assert.match(result.stdout, /--only must be a comma-separated list/);
  });
});
