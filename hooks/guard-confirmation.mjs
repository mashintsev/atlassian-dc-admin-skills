#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook for the atlassian-dc-admin skill.
 *
 * The CLI itself asks the user to confirm every change in a dialog or terminal. This hook
 * keeps an agent from switching that off: it denies (in every permission mode) tool calls that
 * set ATLASSIAN_CONFIRM_* or touch the trusted config files, and asks before any
 * `dry_run=false` / `apply` command when the permission mode still allows asking.
 *
 * Install in ~/.claude/settings.json (or a project .claude/settings.json):
 *   "hooks": { "PreToolUse": [ { "matcher": "Bash|Edit|Write|MultiEdit",
 *     "hooks": [ { "type": "command", "command": "node /path/to/hooks/guard-confirmation.mjs" } ] } ] }
 */

import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const tool = input.tool_name;
const ti = input.tool_input ?? {};
const text = tool === "Bash" ? String(ti.command ?? "") : String(ti.file_path ?? "");

const decide = (permissionDecision, permissionDecisionReason) => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } }));
  process.exit(0);
};

// Only *setting* the variable is blocked (VAR=…, export VAR=…, env VAR=…); mentioning it is fine.
const setsConfirmVar = /(^|[\s;&|(`])(export\s+|env\s+(-\S+\s+)*)?ATLASSIAN_CONFIRM_[A-Z_]+=/;
const CONFIG = String.raw`[^\s'"]*atlassian-dc-admin/\.env\b`;
// A Bash command that *writes to* a config file: redirection, tee, in-place sed, cp/mv/ln/rm onto it.
const bashWritesConfig = new RegExp(
  String.raw`(>>?|\btee(\s+-a)?)\s*['"]?` + CONFIG +
    "|" + String.raw`\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*|--in-place)\b[^|;&]*` + CONFIG +
    "|" + String.raw`\b(cp|mv|ln|rm|truncate|install)\b[^|;&]*` + CONFIG,
);
if (tool === "Bash" && setsConfirmVar.test(text)) {
  decide("deny", "Changing ATLASSIAN_CONFIRM_* is reserved for the user: every Atlassian change must be confirmed interactively.");
}
if ((tool !== "Bash" && new RegExp(CONFIG + "$").test(text)) || (tool === "Bash" && bashWritesConfig.test(text))) {
  decide("deny", "The atlassian-dc-admin config files are edited by the user only.");
}
if (tool === "Bash" && /atlassian-admin\.mjs/.test(text) && /(dry[_-]run=["']?(false|0|no|off)\b|"dry_run"\s*:\s*(false|0|"(false|0|no|off)")|\sapply\s)/i.test(text)) {
  decide("ask", "This applies changes to Jira/Confluence. The CLI will also ask you to confirm in a dialog.");
}
process.exit(0);
