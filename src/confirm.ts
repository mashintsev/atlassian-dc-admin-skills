/**
 * Interactive user confirmation for every change the CLI executes.
 *
 * The confirmation goes to the person, not to the calling agent: a native dialog
 * (macOS `osascript`, Windows PowerShell WinForms, Linux `zenity`) or the controlling terminal
 * when the CLI runs in one.
 * The agent only sees the outcome. One change → Apply/Cancel; several changes (a plan) →
 * a checklist where the user ticks each change or keeps all of them selected.
 *
 * If no interactive channel exists the write is refused. Mode `none` (no confirmation, e.g. CI)
 * is honoured only from a .env *file*, never from the process environment or the command line,
 * so a caller cannot switch confirmation off by prefixing the command.
 */

import { spawnSync } from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { configFileValue } from "./config.js";

export interface ConfirmItem {
  n: number;
  summary: string;
  detail?: string;
}

export class ConfirmationError extends Error {
  constructor(name: "ConfirmationDeclined" | "ConfirmationUnavailable", message: string) {
    super(message);
    this.name = name;
  }
}

type Mode = "auto" | "dialog" | "tty" | "none";

function mode(): Mode {
  const fromFile = configFileValue("ATLASSIAN_CONFIRM_MODE");
  const fromEnv = process.env.ATLASSIAN_CONFIRM_MODE;
  // `none` only from a config file; the environment may only make confirmation stricter.
  if (fromFile === "none") return "none";
  const m = (fromEnv === "none" ? undefined : fromEnv) ?? fromFile ?? "auto";
  return (["auto", "dialog", "tty"].includes(m) ? m : "auto") as Mode;
}

function timeoutSeconds(): number {
  const t = Number(process.env.ATLASSIAN_CONFIRM_TIMEOUT ?? configFileValue("ATLASSIAN_CONFIRM_TIMEOUT") ?? 110);
  return Number.isFinite(t) && t > 0 ? t : 110;
}

function line(it: ConfirmItem): string {
  const text = `${it.n}. ${it.summary}${it.detail ? ` — ${it.detail}` : ""}`.replace(/\s+/g, " ");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

// -- macOS ----------------------------------------------------------------------

const APPLESCRIPT_SINGLE = `
on run argv
  set theTitle to item 1 of argv
  set theText to item 2 of argv
  set t to (item 3 of argv) as integer
  try
    set r to display dialog theText with title theTitle buttons {"Cancel", "Apply"} default button "Cancel" cancel button "Cancel" with icon caution giving up after t
    if gave up of r then return "TIMEOUT"
    return button returned of r
  on error number -128
    return "CANCEL"
  end try
end run`;

const APPLESCRIPT_LIST = `
on run argv
  set theTitle to item 1 of argv
  set t to (item 2 of argv) as integer
  set theItems to items 3 thru -1 of argv
  set r to choose from list theItems with title theTitle with prompt "Tick the changes to apply (all are selected; ⌘-click to deselect):" default items theItems OK button name "Apply selected" cancel button name "Cancel" with multiple selections allowed
  if r is false then return "CANCEL"
  set AppleScript's text item delimiters to linefeed
  return r as text
end run`;

function osascript(script: string, args: string[], timeoutS: number): string | undefined {
  const res = spawnSync("osascript", ["-e", script, ...args], { encoding: "utf8", timeout: (timeoutS + 10) * 1000 });
  if (res.error || res.status !== 0) return undefined;
  return res.stdout.trim();
}

// -- Linux ----------------------------------------------------------------------

function hasCommand(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0;
}

function zenitySingle(title: string, text: string, timeoutS: number): boolean | undefined {
  const res = spawnSync("zenity", ["--question", `--title=${title}`, `--text=${text}`, "--ok-label=Apply", "--cancel-label=Cancel", `--timeout=${timeoutS}`], { encoding: "utf8" });
  if (res.error) return undefined;
  return res.status === 0;
}

function zenityList(title: string, items: ConfirmItem[], timeoutS: number): number[] | undefined {
  const rows = items.flatMap((it) => ["TRUE", String(it.n), line(it).replace(/^\d+\.\s*/, "")]);
  const res = spawnSync(
    "zenity",
    ["--list", "--checklist", `--title=${title}`, "--text=Tick the changes to apply", "--column=Apply", "--column=#", "--column=Change", "--separator=,", `--timeout=${timeoutS}`, "--width=900", "--height=500", ...rows],
    { encoding: "utf8" },
  );
  if (res.error) return undefined;
  if (res.status !== 0) return [];
  return res.stdout.trim().split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

// -- Windows --------------------------------------------------------------------

// WinForms dialog run by Windows PowerShell 5.1 (built into Windows 10/11). The data comes as
// base64 UTF-8 JSON in an environment variable and the script as -EncodedCommand, so nothing
// user-controlled reaches the command line and non-ASCII text survives. Focus starts on Cancel.
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

function winConfirm(title: string, items: ConfirmItem[], single: boolean, timeoutS: number): string | undefined {
  const data = Buffer.from(
    JSON.stringify({ title, single, timeout: timeoutS, items: items.map((it) => ({ n: it.n, text: line(it) })) }),
    "utf8",
  ).toString("base64");
  // No windowsHide: SW_HIDE can also hide the dialog itself; -WindowStyle Hidden hides only the console.
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
      "-EncodedCommand", Buffer.from(WIN_CONFIRM_PS, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: (timeoutS + 30) * 1000, env: { ...process.env, ATLASSIAN_WIN_CONFIRM: data } },
  );
  if (res.error || res.status !== 0) return undefined;
  return res.stdout.trim().split(/\r?\n/).pop();
}

/** Map the Windows dialog's answer (APPLY, CANCEL, TIMEOUT, PICKED 1,3) to item numbers. */
export function winAnswer(out: string, items: ConfirmItem[], single: boolean): number[] {
  if (out === "TIMEOUT") return declined("Confirmation timed out");
  if (single) return out === "APPLY" ? [items[0].n] : declined();
  const chosen = out.startsWith("PICKED ")
    ? out.slice(7).split(",").map(Number).filter((n) => items.some((i) => i.n === n))
    : [];
  return chosen.length ? chosen : declined();
}

// -- terminal -------------------------------------------------------------------

function ttyAsk(question: string): string | undefined {
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return undefined;
  }
  try {
    writeSync(fd, question);
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, null);
    return buf.subarray(0, n).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

function ttyAvailable(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

// -- entry point ------------------------------------------------------------------

/**
 * Ask the user which of `items` to apply. Returns the selected item numbers (all of them for a
 * single approved change). Throws ConfirmationError when declined, timed out or impossible.
 */
export function confirmChanges(items: ConfirmItem[], title = "Atlassian DC — confirm changes"): number[] {
  if (items.length === 0) return [];
  const m = mode();
  if (m === "none") return items.map((i) => i.n);
  const t = timeoutSeconds();
  const single = items.length === 1;

  const useTty = m === "tty" || (m === "auto" && ttyAvailable());
  if (useTty) {
    const list = items.map(line).join("\n");
    const answer = ttyAsk(
      single
        ? `\n${list}\nApply this change? [y/N] `
        : `\n${list}\nApply: [a]ll, numbers (e.g. 1,3), or Enter to cancel: `,
    );
    if (answer === undefined && m === "tty") throw new ConfirmationError("ConfirmationUnavailable", "No terminal for confirmation");
    if (answer !== undefined) {
      const a = answer.toLowerCase();
      if (single) return a === "y" || a === "yes" ? [items[0].n] : declined();
      if (a === "a" || a === "all") return items.map((i) => i.n);
      const picked = a.split(/[\s,]+/).map(Number).filter((n) => items.some((i) => i.n === n));
      return picked.length ? picked : declined();
    }
  }

  if (process.platform === "darwin") {
    const out = single
      ? osascript(APPLESCRIPT_SINGLE, [title, `${line(items[0])}\n\nApply this change?`, String(t)], t)
      : osascript(APPLESCRIPT_LIST, [title, String(t), ...items.map(line)], t);
    if (out !== undefined) {
      if (out === "CANCEL") return declined();
      if (out === "TIMEOUT") return declined("Confirmation timed out");
      if (single) return out === "Apply" ? [items[0].n] : declined();
      const chosen = out.split("\n").map((l) => Number(l.split(".")[0])).filter((n) => Number.isInteger(n) && n > 0);
      return chosen.length ? chosen : declined();
    }
  } else if (process.platform === "win32") {
    const out = winConfirm(title, items, single, t);
    if (out !== undefined) return winAnswer(out, items, single);
  } else if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && hasCommand("zenity")) {
    if (single) {
      const ok = zenitySingle(title, `${line(items[0])}\n\nApply this change?`, t);
      if (ok !== undefined) return ok ? [items[0].n] : declined();
    } else {
      const picked = zenityList(title, items, t);
      if (picked !== undefined) return picked.length ? picked : declined();
    }
  }

  throw new ConfirmationError(
    "ConfirmationUnavailable",
    "No interactive confirmation channel (terminal, macOS dialog, Windows dialog or zenity). The change was not applied.",
  );
}

function declined(message = "The user did not approve the change"): never {
  throw new ConfirmationError("ConfirmationDeclined", message);
}
