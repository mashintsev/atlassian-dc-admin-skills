# atlassian-dc-admin-skills

A Claude Code skill for **Jira Data Center** and **Confluence Data Center** over their REST APIs:
administration (users, groups, licenses, project roles, schemes, custom fields, screens, spaces,
space and global permissions, apps, indexing, cluster, audit log) and day-to-day content work
(issues, JQL search, comments, transitions, boards and sprints, worklogs, links, attachments,
Service Management requests, Confluence pages, CQL search, comments, labels, attachments, restrictions),
plus **Jira Assets** (AQL search, objects, schemas, object types, attribute definitions, statuses).

One skill, `atlassian-dc-admin`, covers Jira, Confluence and Assets; Assets details live in `ASSETS.md`, loaded on demand.

- 201 tools, 89 of them change the instance. Write tools are **dry-run by default**: they return
  the exact request and send nothing until called with `dry_run=false`.
- One bundled CLI (`atlassian-dc-admin/scripts/atlassian-admin.mjs`) that needs only Node.js 20+.
- Token-efficient output for agents: compact text by default, `--fields`, `--out=FILE` for bulk
  results, a response-size guard, a ~800-token SKILL.md dispatcher and on-demand `describe`.

## Token efficiency

`pnpm run bench` replays the MCP responses captured by eunsanMountain/atlassian-skills
(`test/fixtures/mcp/`) through this CLI's generic output path (cl100k_base tokens):

| | MCP JSON | `--format=json` | `compact` |
|---|---:|---:|---:|
| 12 Jira/Confluence responses | 4318 | 2235 | 1992 (**−54%**) |

The purpose-built shapes of the tools (for example `jira_search` rows without descriptions) save
more than this generic path. There is also no per-turn tool-schema cost: the agent loads a short
dispatcher once and calls `describe <tool>` only for the tools it uses.

## Layout

```
atlassian-dc-admin/          the skill (copy or symlink this folder)
  SKILL.md                   instructions Claude follows
  ASSETS.md                  Jira Assets reference (AQL, attributes by name), read on demand
  hooks/guard-confirmation.mjs  optional Claude Code hook (see below)
  REFERENCE.md               all tools with arguments (generated) and endpoint sources
  .env.example               configuration template
  scripts/atlassian-admin.mjs  bundled CLI (build output, committed)
src/
  config.ts client.ts errors.ts json.ts runner.ts cli.ts
  format.ts                  compact/json output, pruning, --fields, exit codes
  markup.ts                  Markdown <-> Jira wiki / Confluence storage
  tools/jira/*.ts tools/confluence/*.ts tools/platform/*.ts
test/unit/*.test.ts          node:test suites with a fake fetch (no network)
scripts/gen-reference.ts     regenerates the tool table in REFERENCE.md
```

## Install the skill

```bash
pnpm install --frozen-lockfile && pnpm run build
ln -s "$PWD/atlassian-dc-admin" ~/.claude/skills/atlassian-dc-admin     # all projects
# or: ln -s ... <project>/.claude/skills/<name>
# Codex: the same folder works as a Codex skill
ln -s "$PWD/atlassian-dc-admin" ~/.agents/skills/atlassian-dc-admin      # all projects
# or: ln -s "$PWD/atlassian-dc-admin" <project>/.agents/skills/atlassian-dc-admin
mkdir -p ~/.config/atlassian-dc-admin
cp atlassian-dc-admin/.env.example ~/.config/atlassian-dc-admin/.env   # fill in URL and PAT
node atlassian-dc-admin/scripts/atlassian-admin.mjs check --ping
```

## Per-project Jira / Confluence

`~/.config/atlassian-dc-admin/.env` is the machine-wide default. A project that talks to a different instance
gets its own `.atlassian-dc-admin.env` in its root:

```bash
cd <project> && node .claude/skills/atlassian-dc-admin/scripts/atlassian-admin.mjs init --jira-url=https://jira.other
# fill JIRA_PAT_TOKEN in .atlassian-dc-admin.env (mode 600, already in .gitignore)
node .claude/skills/atlassian-dc-admin/scripts/atlassian-admin.mjs check --ping   # shows the file in use
```

The CLI finds the nearest file from the working directory upwards. Product settings are taken as a whole from
the first source that defines the product URL (no mixing of URL and token across files). Project files are not
trusted for safety settings: turning confirmation off is only read from the skill's or ~/.config's file.

## Codex

The skill folder is agent-neutral: Codex discovers it in `~/.agents/skills/` or `<project>/.agents/skills/`.
Codex's default sandbox has no network, so Jira/Confluence calls need sandbox escalation (approval) or network
enabled for the workspace (`[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml`).
The confirmation dialog of the CLI works the same; if the sandbox prevents it, writes fail closed (exit 13).

## Confirming changes

Every executed change needs the user's interactive confirmation, enforced by the CLI (not by the model):

- `<tool> … dry_run=false` → a dialog (macOS `osascript`, Linux `zenity`) or the terminal shows the change: Apply / Cancel.
- `<tool> … --plan=FILE` collects dry runs; `apply FILE` shows one checklist with all changes ticked, the user
  unticks what they do not want. Before each item `apply` repeats the dry run and skips it as `DRIFTED` if the
  request differs from the approved one.
- No dialog and no terminal → the change is refused (exit 13); declined → exit 12.
- Unattended use (CI): `ATLASSIAN_CONFIRM_MODE=none` in `~/.config/atlassian-dc-admin/.env` or the skill's `.env`
  only; the variable from the environment or the command line is ignored. `ATLASSIAN_CONFIRM_TIMEOUT` (seconds, default 110).

Optional second layer in Claude Code: `atlassian-dc-admin/hooks/guard-confirmation.mjs` as a `PreToolUse` hook
(matcher `Bash|Edit|Write|MultiEdit`). It denies attempts to change `ATLASSIAN_CONFIRM_*` or edit the config files
(in every permission mode) and asks before `dry_run=false` / `apply` commands in modes that still ask
(not in auto / bypass modes, where the CLI dialog is the only gate).

## Develop

```bash
pnpm run typecheck
pnpm test                 # unit tests, no network
pnpm run build            # bundle the CLI into the skill and regenerate REFERENCE.md
pnpm run bench            # token benchmark on captured MCP responses
pnpm run cli -- list jira # run from sources with tsx
```

A new tool is a `ToolDef` (name, product, write flag, description, Zod input shape, handler) in
`src/tools/<area>/*.ts`, registered in `src/tools/index.ts`. Every write goes through
`guardedWrite()` in `src/tools/util.ts`; the registry test fails if a write tool has no `dry_run`.

## Verification status

Endpoint paths, methods, parameters and bodies were checked against the compiled REST resources of
Jira 11.3.2, Jira Software (greenhopper) 10.3.0, JSM public REST 21.3.2, Confluence 9.2.16 / 10.2.17,
Assets (insight-rest-api) 21.3.2 with the Insight 11.0 `/iql` fallback, the audit plugin 3.1.19 and UPM 8.0.25 (see REFERENCE.md). Not verifiable offline: dev-status
(`/rest/dev-status/1.0`) and Confluence `movepage.action`. 149 unit tests check request building,
dry-run behaviour, markup conversion and response mapping against a fake server.
**The tools have not been run against a live Jira or Confluence yet**, so response mapping for
some endpoints (for example Confluence space permission subjects) may need small fixes on first real use.

## Credits

- [mcp-atlassian-for-admins](https://github.com/sergeyopypey/mcp-atlassian-for-admins) (MIT): the
  TypeScript client, configuration modes, error handling, response-size guard, `ToolDef` pattern,
  pagination helpers and several read tools (project scheme chain, permission schemes, custom field
  usage, plugin inventory) are adapted from it.
- [mcp-atlassian](https://github.com/sooperset/mcp-atlassian) (MIT): the Jira and Confluence content
  tools and the Markdown ↔ wiki/storage conversion are ported from it for DC (Cloud-only tools
  skipped, listed upstream bugs fixed).
- [eunsanMountain/atlassian-skills](https://github.com/eunsanMountain/atlassian-skills) (MIT): the
  compact output format, the token-waste pruning rules, exit codes and the benchmark fixtures.
- [langpingxue/atlassian-skills](https://github.com/langpingxue/atlassian-skills): the skill layout
  (`SKILL.md` + `REFERENCE.md` + `.env.example`), per-area modules and the `.env` lookup follow it.
