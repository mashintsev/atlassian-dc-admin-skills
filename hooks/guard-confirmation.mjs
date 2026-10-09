#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for the atlassian-dc-admin skill.
 *
 * The CLI itself asks the user to confirm every change in a dialog or terminal. This hook
 * keeps an agent from switching that off: it denies (in every permission mode) tool calls that
 * set ATLASSIAN_CONFIRM_*, touch the trusted config files or read them (they hold the token),
 * and asks before any `dry_run=false` / `apply` command when the permission mode still allows asking.
 * Shell commands are checked for both the Bash and the PowerShell tool; Windows paths are normalised.
 *
 * Install in ~/.claude/settings.json (or a project .claude/settings.json):
 *   "hooks": { "PreToolUse": [ { "matcher": "Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Read|Grep",
 *     "hooks": [ { "type": "command", "command": "node /path/to/hooks/guard-confirmation.mjs" } ] } ] }
 */

import { readFileSync } from "node:fs";

const decide = (permissionDecision, permissionDecisionReason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }));
  process.exit(0);
};

// A crashing hook is a non-blocking error (the call goes through), so unreadable input is denied instead.
let input;
try {
  input = JSON.parse(readFileSync(0, "utf8").replace(/^﻿/, "") || "{}");
} catch {
  decide("deny", "guard-confirmation: could not parse the hook input.");
}
const tool = input.tool_name;
const ti = input.tool_input ?? {};
const isShell = tool === "Bash" || tool === "PowerShell";
// Windows: `\` → `/` so one set of patterns covers both; file paths are compared case-insensitively.
const slash = (s) => String(s ?? "").replace(/\\/g, "/");
const text = isShell ? slash(ti.command) : "";
const paths = [ti.file_path, ti.path, ti.notebook_path].filter(Boolean).map((p) => slash(p).toLowerCase());

// Only *setting* the variable is blocked (VAR=…, export VAR=…, env VAR=…); mentioning it is fine.
const setsConfirmVar = /(^|[\s;&|(`])(export\s+|env\s+(-\S+\s+)*)?ATLASSIAN_CONFIRM_[A-Z_]+=/;
// PowerShell: $env:VAR = …, Set-Item / New-Item env:VAR, [Environment]::SetEnvironmentVariable('VAR', …).
const pwshSetsConfirmVar = /\$env:ATLASSIAN_CONFIRM_\w+\s*[+]?=|\b(set|new)-item\b[^|;]*env:[/\\]?ATLASSIAN_CONFIRM_|SetEnvironmentVariable\(\s*['"]ATLASSIAN_CONFIRM_/i;
const CONFIG = String.raw`[^\s'"]*atlassian-dc-admin/\.env\b`;
// A shell command that *writes to* a config file: redirection, tee, in-place sed, cp/mv/ln/rm onto it,
// or the PowerShell cmdlets and aliases that write, copy, move or delete files.
const shellWritesConfig = new RegExp(
  String.raw`(>>?|\btee(\s+-a)?)\s*['"]?` + CONFIG +
    "|" + String.raw`\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b[^|;&]*` + CONFIG +
    "|" + String.raw`\b(cp|mv|ln|rm|truncate|install)\b[^|;&]*` + CONFIG +
    "|" + String.raw`\b(set-content|add-content|clear-content|out-file|copy-item|move-item|remove-item|rename-item|new-item|sc|ac|copy|move|del|ren)\b[^|;&]*` + CONFIG,
  "i",
);
// Reading the config would put the token into the agent transcript.
const shellReadsConfig = new RegExp(String.raw`\b(cat|less|more|head|tail|type|gc|get-content|select-string|sls|grep|rg)\b[^|;&]*` + CONFIG, "i");
// Also the ~/.config folder itself, so Grep cannot search it as a whole.
const configPath = new RegExp(CONFIG + "$|\\.config/atlassian-dc-admin/?$", "i");

if (isShell && (setsConfirmVar.test(text) || pwshSetsConfirmVar.test(text))) {
  decide("deny", "Changing ATLASSIAN_CONFIRM_* is reserved for the user: every Atlassian change must be confirmed interactively.");
}
if ((!isShell && paths.some((p) => configPath.test(p))) || (isShell && (shellWritesConfig.test(text) || shellReadsConfig.test(text)))) {
  decide("deny", "The atlassian-dc-admin config files hold the token and confirmation settings: they are read and edited by the user only.");
}
if (isShell && /atlassian-admin\.mjs/.test(text) && /(dry[_-]run=["']?(false|0|no|off)\b|"dry_run"\s*:\s*(false|0|"(false|0|no|off)")|\sapply\s)/i.test(text)) {
  decide("ask", "This applies changes to Jira/Confluence. The CLI will also ask you to confirm in a dialog.");
}
process.exit(0);
