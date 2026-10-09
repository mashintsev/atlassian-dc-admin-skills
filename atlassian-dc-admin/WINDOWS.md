# Windows support: confirmation dialog and PowerShell guard hook

## Problem

On Windows every write fails with `ConfirmationUnavailable` (exit 13), even when the user is present:

- `src/confirm.ts` has dialog branches only for macOS (`osascript`) and Linux (`zenity`);
- the terminal fallback opens `/dev/tty`, which does not exist on Windows;
- Claude Code runs commands without a TTY anyway.

The only way to write is `ATLASSIAN_CONFIRM_MODE=none`, which removes confirmation entirely.

A second issue: `hooks/guard-confirmation.mjs` inspects only the `Bash` tool and `/` paths. Claude Code on Windows can use the `PowerShell` tool and `\` paths, so the hook never matches there.

## Fix 1: WinForms confirmation dialog (`src/confirm.ts`)

A `win32` branch next to the macOS and zenity ones. It starts `powershell.exe`, which ships with every Windows, and shows a WinForms dialog:

- one change: a read-only text box with **Apply** / **Cancel**;
- several changes (`apply PLAN`): a checklist with every item ticked, **Apply selected** / **Cancel**;
- focus starts on Cancel, so Enter and Esc both decline;
- the dialog closes as declined after `ATLASSIAN_CONFIRM_TIMEOUT` (default 110 s);
- the window is `TopMost`, so it is not hidden behind the editor.

The data (title, timeout, items) goes to PowerShell as base64-encoded UTF-8 JSON in an environment variable. The script itself goes through `-EncodedCommand`. Nothing user-controlled is put on the command line, so quoting and non-ASCII text (Cyrillic summaries) work.

If PowerShell fails or exits non-zero, `winConfirm` returns `undefined` and the code falls through to the existing `ConfirmationUnavailable`. The failure mode is the same as upstream: refuse, never apply.

Add above `ttyAsk`:

```ts
const WIN_CONFIRM_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:ATLASSIAN_WIN_CONFIRM)) | ConvertFrom-Json
$state = @{ timedOut = $false }
$f = New-Object System.Windows.Forms.Form
$f.Text = $d.title; $f.Width = 960; $f.Height = 460; $f.StartPosition = 'CenterScreen'
$f.TopMost = $true; $f.MinimizeBox = $false; $f.MaximizeBox = $false
$f.Font = New-Object System.Drawing.Font('Segoe UI', 10)
if ($d.single) {
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true; $box.ReadOnly = $true; $box.ScrollBars = 'Vertical'; $box.Text = $d.items[0].text
} else {
  $box = New-Object System.Windows.Forms.CheckedListBox
  $box.CheckOnClick = $true; $box.HorizontalScrollbar = $true
  foreach ($it in $d.items) { [void]$box.Items.Add($it.text, $true) }
}
$box.Dock = 'Fill'
$lbl = New-Object System.Windows.Forms.Label
$lbl.Dock = 'Top'; $lbl.Height = 34; $lbl.Padding = New-Object System.Windows.Forms.Padding(6, 8, 6, 0)
$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Dock = 'Bottom'; $panel.Height = 48; $panel.FlowDirection = 'RightToLeft'; $panel.Padding = New-Object System.Windows.Forms.Padding(6)
$cancel = New-Object System.Windows.Forms.Button
$cancel.Text = 'Cancel'; $cancel.Width = 120; $cancel.Height = 32; $cancel.DialogResult = 'Cancel'
$ok = New-Object System.Windows.Forms.Button
$ok.Width = 160; $ok.Height = 32; $ok.DialogResult = 'OK'
if ($d.single) { $lbl.Text = 'Apply this change?'; $ok.Text = 'Apply' } else { $lbl.Text = 'Tick the changes to apply (all are ticked):'; $ok.Text = 'Apply selected' }
$panel.Controls.Add($cancel); $panel.Controls.Add($ok)
$f.Controls.Add($box); $f.Controls.Add($lbl); $f.Controls.Add($panel)
$f.CancelButton = $cancel
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [int]$d.timeout * 1000
$timer.Add_Tick({ $state.timedOut = $true; $timer.Stop(); $f.Close() })
$f.Add_Shown({ $f.Activate(); $cancel.Focus(); $timer.Start() })
$r = $f.ShowDialog()
$timer.Stop()
if ($state.timedOut) { 'TIMEOUT' }
elseif ($r -ne [System.Windows.Forms.DialogResult]::OK) { 'CANCEL' }
elseif ($d.single) { 'APPLY' }
else {
  $picked = @(foreach ($i in $box.CheckedIndices) { $d.items[$i].n })
  if ($picked.Count -eq 0) { 'CANCEL' } else { 'PICKED ' + ($picked -join ',') }
}
`;

type ConfirmItem = Parameters<typeof line>[0];

function winConfirm(title: string, items: ConfirmItem[], single: boolean, timeoutS: number): string | undefined {
  const data = Buffer.from(
    JSON.stringify({ title, single, timeout: timeoutS, items: items.map((it) => ({ n: it.n, text: line(it) })) }),
    "utf8",
  ).toString("base64");
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(WIN_CONFIRM_PS, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: (timeoutS + 30) * 1000, env: { ...process.env, ATLASSIAN_WIN_CONFIRM: data } },
  );
  if (res.error || res.status !== 0) return undefined;
  return res.stdout.trim().split(/\r?\n/).pop();
}
```

In `confirmChanges`, between the `darwin` branch and the zenity branch:

```ts
  } else if (process.platform === "win32") {
    const out = winConfirm(title, items, single, t);
    if (out !== undefined) {
      if (out === "CANCEL") return declined();
      if (out === "TIMEOUT") return declined("Confirmation timed out");
      if (single) return out === "APPLY" ? [items[0].n] : declined();
      const chosen = out.startsWith("PICKED ")
        ? out.slice(7).split(",").map(Number).filter((n) => items.some((i) => i.n === n))
        : [];
      return chosen.length ? chosen : declined();
    }
  } else if (/* existing zenity condition */) {
```

Notes:

- Do not pass `windowsHide: true` to `spawnSync`. It sets `SW_HIDE` in STARTUPINFO, which can also hide the first window the process shows, i.e. the dialog itself. `-WindowStyle Hidden` hides only the PowerShell console (a short flash is possible).
- `-ExecutionPolicy Bypass` is not strictly needed with `-EncodedCommand`. It is there so that a restrictive machine policy does not change the behaviour.
- In `auto` mode on Windows, `ttyAvailable()` can be true in a real terminal, but `ttyAsk` cannot open `/dev/tty`, returns `undefined` and falls through to the dialog. A follow-up could use `\\.\CONIN$` / `\\.\CONOUT$` on win32 to keep the terminal prompt.

## Fix 2: guard hook for PowerShell and Windows paths

Changes to `hooks/guard-confirmation.mjs`, or a separate Windows variant:

- treat `PowerShell` like `Bash`: read `tool_input.command`;
- normalise paths (`\` → `/`, lowercase) before matching the config regexes. Match the whole `~/.config/atlassian-dc-admin/` folder, not only `.env`;
- check `tool_input.path` too, so that `Grep` cannot read the PAT from the config;
- deny `Read` of the config files: the PAT should not end up in the agent transcript;
- strip a UTF-8 BOM before `JSON.parse`. On a parse error, return `deny` instead of crashing: a crashing hook is a non-blocking error, so it fails open;
- matcher: `PowerShell|Bash|Edit|Write|MultiEdit|NotebookEdit|Read|Grep`.

Caveat worth putting in the README: in Claude Code **auto** permission mode, a hook's `"ask"` decision can be resolved without showing the user a prompt. The real gate for writes is the CLI dialog. The hook's job is to stop the agent from turning that dialog off (config files, `ATLASSIAN_CONFIRM_*`).

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

The Cyrillic and timeout cases ran `winConfirm()` extracted from the built CLI, without a Jira request; single Cancel/Apply and `apply PLAN` ran end to end against Jira.

The dialog always runs `powershell.exe` (Windows PowerShell 5.1, built into Windows 10/11); PowerShell 7 (`pwsh`) is not used even when installed. Where `powershell.exe` is missing or blocked (Nano Server, AppLocker/WDAC), the dialog cannot start and writes are refused with exit 13, as before the patch. A `pwsh.exe` fallback would be a small follow-up if needed.

Not tested yet: running the CLI from a terminal (`tty` mode) on Windows.
