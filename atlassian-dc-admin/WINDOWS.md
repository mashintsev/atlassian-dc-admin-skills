# Windows

## Confirmation dialog

On Windows the CLI confirms changes in a WinForms dialog (`src/confirm.ts`, `winConfirm`). It runs `powershell.exe` (Windows PowerShell 5.1, built into Windows 10/11):

- one change: a read-only text box with **Apply** / **Cancel**;
- several changes (`apply PLAN`): a checklist with every item ticked, **Apply selected** / **Cancel**;
- focus starts on Cancel, so Enter and Esc both decline;
- the dialog closes as declined after `ATLASSIAN_CONFIRM_TIMEOUT` (default 110 s);
- the window is `TopMost`, so it is not hidden behind the editor.

Before this, every write on Windows failed with `ConfirmationUnavailable` (exit 13): there was no dialog branch for win32, the terminal fallback opens `/dev/tty`, and Claude Code runs commands without a TTY anyway.

How it is built:

- The data (title, timeout, items) goes to PowerShell as base64-encoded UTF-8 JSON in the `ATLASSIAN_WIN_CONFIRM` environment variable; the script goes through `-EncodedCommand`. Nothing user-controlled is put on the command line, so quoting and non-ASCII text (Cyrillic summaries) work.
- The dialog prints `APPLY`, `CANCEL`, `TIMEOUT` or `PICKED 1,3`; `winAnswer` maps that to item numbers or `ConfirmationDeclined` (exit 12).
- If PowerShell fails or exits non-zero, the code falls through to `ConfirmationUnavailable` (exit 13): refuse, never apply.
- `spawnSync` gets no `windowsHide: true`: it sets `SW_HIDE` in STARTUPINFO, which can also hide the first window the process shows, i.e. the dialog itself. `-WindowStyle Hidden` hides only the PowerShell console (a short flash is possible).
- `-ExecutionPolicy Bypass` is not strictly needed with `-EncodedCommand`; it keeps a restrictive machine policy from changing the behaviour.

Limits:

- PowerShell 7 (`pwsh`) is not used even when installed. Where `powershell.exe` is missing or blocked (Nano Server, AppLocker/WDAC), the dialog cannot start and writes are refused with exit 13. A `pwsh.exe` fallback would be a small follow-up.
- Terminal mode: in `auto` mode `ttyAvailable()` can be true in a real terminal, but `ttyAsk` cannot open `/dev/tty`, returns `undefined` and falls through to the dialog. `ATLASSIAN_CONFIRM_MODE=tty` refuses with exit 13. A follow-up could use `\\.\CONIN$` / `\\.\CONOUT$` on win32 to keep the terminal prompt.

## Guard hook

`hooks/guard-confirmation.mjs` covers Windows too. Register it with the matcher `Bash|PowerShell|Edit|Write|MultiEdit|NotebookEdit|Read|Grep`:

- the `PowerShell` tool is checked like `Bash`, including `$env:ATLASSIAN_CONFIRM_* = …`, `Set-Item env:…` and `[Environment]::SetEnvironmentVariable(…)`, and the cmdlets and aliases that write, copy, move or delete the config file;
- `\` paths are normalised to `/`, file paths are compared case-insensitively;
- reading the config files (Read, Grep, `cat`, `Get-Content`, …) is denied, so the token does not end up in the agent transcript;
- a UTF-8 BOM in the hook input is stripped; input that cannot be parsed is denied (a crashing hook is a non-blocking error and would fail open).

In Claude Code **auto** permission mode, a hook's `"ask"` decision can be resolved without showing the user a prompt. The real gate for writes is the CLI dialog; the hook's job is to stop the agent from turning that dialog off.

## Building on Windows

`pnpm run build` uses `mkdir -p` and `cp`, which `cmd.exe` does not have. Run its steps directly:

```powershell
pnpm exec tsup
Copy-Item hooks\guard-confirmation.mjs atlassian-dc-admin\hooks\ -Force
pnpm exec tsx scripts/gen-reference.ts
```

Some unit tests that are unrelated to the dialog (symbolic links, POSIX paths, CRLF checkouts, timing in `spaceWorkflow`) fail on Windows on `main` as well.

## Tested

Windows 11 Pro, Windows PowerShell 5.1, Node 24.21, Jira DC 11.3.8, Claude Code VS Code extension (PowerShell tool):

| Case | Result |
|---|---|
| single write → Cancel | `ConfirmationDeclined`, exit 12, nothing sent |
| single write → Apply | request sent, change visible on read-back |
| rollback write → Apply | original state restored |
| Cyrillic text (`Проверка: ёЁ, «кавычки», №`, em dash) in title and item | renders correctly |
| checklist with 3 items, user unticks item 2 → Apply selected | returns `PICKED 1,3` |
| no click, timeout 5 s | dialog closes by itself after ~5.6 s, returns `TIMEOUT` (→ declined) |
| `apply PLAN` with 4 changes (3× `jira_add_screen_field`, 1× `jira_set_board_detail_fields`) → Apply selected | `applied 4/4`, all `DONE`, changes visible on read-back |

Unit tests: `winAnswer` (APPLY / CANCEL / TIMEOUT / PICKED) in `test/unit/confirm.test.ts`; the hook's Bash, PowerShell, Read/Grep, BOM and parse-error cases in `test/unit/guard-hook.test.ts`.

Not tested yet: running the CLI from a terminal (`tty` mode) on Windows.
