import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HOOK = fileURLToPath(new URL("../../hooks/guard-confirmation.mjs", import.meta.url));

function decision(input: unknown): string | undefined {
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const res = spawnSync(process.execPath, [HOOK], { input: raw, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.permissionDecision : undefined;
}
const shell = (tool_name: string, command: string) => decision({ tool_name, tool_input: { command } });

describe("guard-confirmation hook", () => {
  it("denies setting ATLASSIAN_CONFIRM_* in Bash and PowerShell", () => {
    assert.equal(shell("Bash", "ATLASSIAN_CONFIRM_MODE=none node atlassian-admin.mjs x"), "deny");
    assert.equal(shell("PowerShell", "$env:ATLASSIAN_CONFIRM_MODE = 'none'; node atlassian-admin.mjs x"), "deny");
    assert.equal(shell("PowerShell", "Set-Item env:ATLASSIAN_CONFIRM_MODE none"), "deny");
    assert.equal(shell("PowerShell", "[Environment]::SetEnvironmentVariable('ATLASSIAN_CONFIRM_MODE','none','User')"), "deny");
    assert.equal(shell("PowerShell", "echo $env:ATLASSIAN_CONFIRM_TIMEOUT"), undefined);
  });

  it("denies writing and reading the config file from either shell, with Windows paths", () => {
    assert.equal(shell("Bash", "echo X >> ~/.config/atlassian-dc-admin/.env"), "deny");
    assert.equal(shell("PowerShell", "Add-Content C:\\Users\\me\\.config\\atlassian-dc-admin\\.env 'X=1'"), "deny");
    assert.equal(shell("PowerShell", "Get-Content $HOME\\.config\\atlassian-dc-admin\\.env"), "deny");
    assert.equal(shell("Bash", "cat ~/.config/atlassian-dc-admin/.env"), "deny");
  });

  it("denies file tools on the config, including Read and Grep", () => {
    assert.equal(decision({ tool_name: "Edit", tool_input: { file_path: "C:\\Users\\me\\.config\\atlassian-dc-admin\\.env" } }), "deny");
    assert.equal(decision({ tool_name: "Read", tool_input: { file_path: "/home/me/.config/atlassian-dc-admin/.env" } }), "deny");
    assert.equal(decision({ tool_name: "Grep", tool_input: { pattern: "TOKEN", path: "C:\\Users\\me\\.config\\atlassian-dc-admin" } }), "deny");
    assert.equal(decision({ tool_name: "Read", tool_input: { file_path: "C:\\work\\.claude\\skills\\atlassian-dc-admin\\SKILL.md" } }), undefined);
  });

  it("asks before executing changes from either shell", () => {
    assert.equal(shell("Bash", "node atlassian-admin.mjs jira_add_watcher issue_key=X-1 dry_run=false"), "ask");
    assert.equal(shell("PowerShell", "node .\\scripts\\atlassian-admin.mjs apply C:\\tmp\\plan.json"), "ask");
    assert.equal(shell("PowerShell", "node .\\scripts\\atlassian-admin.mjs jira_get_issue issue_key=X-1"), undefined);
  });

  it("strips a UTF-8 BOM and denies input it cannot parse", () => {
    assert.equal(decision("\uFEFF" + JSON.stringify({ tool_name: "Bash", tool_input: { command: "ATLASSIAN_CONFIRM_MODE=none x" } })), "deny");
    assert.equal(decision("{not json"), "deny");
  });
});
