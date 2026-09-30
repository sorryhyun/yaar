/**
 * Native directory picker — opens a folder selection dialog on the host OS.
 *
 * Platform strategy:
 * - Windows: the Explorer folder dialog in a helper process, when the caller passes
 *   `helperArgv` (see {@link tryFileDialog}); otherwise, or if the helper gives no answer,
 *   PowerShell FolderBrowserDialog via temp .ps1 file (its stdout never reached us from
 *   the compiled exe, so results go through temp files)
 * - WSL: PowerShell FolderBrowserDialog + wslpath conversion
 * - macOS: osascript `choose folder` (always present; zenity/kdialog are not)
 * - Linux: zenity or kdialog (direct spawn with stdout)
 *
 * Returns the selected absolute path, or null if cancelled.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { allowForeground, killWithParent } from './win32/child-process.js';
import type { FolderDialogResult } from './win32/folder-dialog.js';

const isWSL = process.platform === 'linux' && process.env.WSL_DISTRO_NAME != null;
const isWin32 = process.platform === 'win32';
const isDarwin = process.platform === 'darwin';

/** Sleep for ms. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Execute a command directly with stdout piping.
 * Works on Linux/macOS/WSL where child process stdio is reliable.
 */
async function execDirect(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ stdout: string; code: number }> {
  try {
    const proc = Bun.spawn([cmd, ...args], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const code = await proc.exited;
    clearTimeout(timer);
    const stdout = await new Response(proc.stdout).text();
    return { stdout: stdout.trim(), code };
  } catch {
    return { stdout: '', code: 1 };
  }
}

/**
 * macOS: AppleScript `choose folder`. Stock macOS ships neither zenity nor
 * kdialog, so without this every picker missed and the folder button was a
 * silent no-op.
 *
 * The `choose folder` call is wrapped in a `tell application "System Events"`
 * block so the dialog belongs to an app we just activated — osascript itself is
 * not a foreground app, and its dialog otherwise opens behind the browser.
 * Cancel exits 1 (`User canceled. (-128)` on the ignored stderr) → null.
 */
async function tryOsascript(): Promise<string | null> {
  const script = [
    'tell application "System Events"',
    '  activate',
    '  POSIX path of (choose folder with prompt "Select folder to mount")',
    'end tell',
  ].join('\n');
  const { stdout, code } = await execDirect('osascript', ['-e', script]);
  if (code !== 0 || !stdout) return null;
  // `POSIX path of` appends a trailing slash to directories; keep bare "/".
  return stdout.length > 1 ? stdout.replace(/\/+$/, '') : stdout;
}

async function tryZenity(): Promise<string | null> {
  const { stdout, code } = await execDirect('zenity', [
    '--file-selection',
    '--directory',
    '--title=Select folder to mount',
  ]);
  return code === 0 && stdout ? stdout : null;
}

async function tryKdialog(): Promise<string | null> {
  const { stdout, code } = await execDirect('kdialog', [
    '--getexistingdirectory',
    '.',
    '--title',
    'Select folder to mount',
  ]);
  return code === 0 && stdout ? stdout : null;
}

async function tryPowerShell(): Promise<string | null> {
  const id = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex');
  const resultFile = join(tmpdir(), `yaar-pick-${id}.txt`);
  const doneFile = join(tmpdir(), `yaar-pick-done-${id}.txt`);
  const scriptFile = join(tmpdir(), `yaar-pick-${id}.ps1`);

  // Escape backslashes for embedding in PowerShell single-quoted string literals
  const esc = (p: string) => p.replace(/\\/g, '\\\\');

  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class FocusSteal {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
}
'@
$f = New-Object System.Windows.Forms.Form
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.MinimizeBox = $false
$f.Size = New-Object System.Drawing.Size(0,0)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-9999,-9999)
$f.Show()
$fgHwnd = [FocusSteal]::GetForegroundWindow()
$fgPid = [uint32]0
$fgThread = [FocusSteal]::GetWindowThreadProcessId($fgHwnd, [ref]$fgPid)
$ourThread = [FocusSteal]::GetCurrentThreadId()
[FocusSteal]::AttachThreadInput($ourThread, $fgThread, $true)
[FocusSteal]::SetForegroundWindow($f.Handle)
[FocusSteal]::BringWindowToTop($f.Handle)
$f.Activate()
[FocusSteal]::AttachThreadInput($ourThread, $fgThread, $false)
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select folder to mount'
$d.ShowNewFolderButton = $false
$result = ''
if ($d.ShowDialog($f) -eq 'OK') { $result = $d.SelectedPath }
$f.Dispose()
[System.IO.File]::WriteAllText('${esc(resultFile)}', $result, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText('${esc(doneFile)}', '0', [System.Text.Encoding]::UTF8)
`.trim();

  // Write script to a temp .ps1 file instead of passing via -Command.
  // On Windows, multi-line scripts passed as -Command arguments can get
  // mangled by CreateProcessW argument parsing (especially in Bun compiled exe).
  writeFileSync(scriptFile, script, 'utf-8');

  Bun.spawn(
    [
      'powershell.exe',
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      scriptFile,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  // Poll for done file (up to 60s)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (existsSync(doneFile)) {
      let winPath = existsSync(resultFile) ? readFileSync(resultFile, 'utf-8').trim() : '';
      for (const f of [resultFile, doneFile, scriptFile]) {
        try {
          unlinkSync(f);
        } catch {
          /* ignore */
        }
      }

      // Remove BOM if present
      if (winPath.charCodeAt(0) === 0xfeff) winPath = winPath.slice(1);
      if (!winPath) return null;

      // WSL: convert Windows path (C:\...) to Linux path (/mnt/c/...)
      if (isWSL && /^[A-Za-z]:\\/.test(winPath)) {
        const { stdout: wslPath, code: wslCode } = await execDirect('wslpath', ['-u', winPath]);
        return wslCode === 0 && wslPath ? wslPath : null;
      }
      return winPath;
    }
  }

  // Timeout — clean up
  for (const f of [resultFile, doneFile, scriptFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Windows: the Explorer folder picker, shown by a helper process (`win32/folder-dialog.ts`
 * explains why not in-process). The helper is tied to our lifetime and killed at the deadline,
 * which takes its dialog with it — no dialog outlives the request that asked for it.
 *
 * Returns the picked path, or null for a cancel or the deadline (both are answers), or
 * `undefined` when the helper gave no answer — it failed to start, crashed, or reported an
 * error — so the caller can fall back.
 *
 * Exported for tests: nothing in it is Windows-specific, so a fake helper exercises it anywhere.
 */
export async function tryFileDialog(
  helperArgv: string[],
  deadlineMs: number,
): Promise<string | null | undefined> {
  let proc: ReturnType<typeof Bun.spawn<'ignore', 'pipe', 'ignore'>>;
  try {
    proc = Bun.spawn(helperArgv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (err) {
    console.error('[pickDirectory] folder dialog helper failed to start:', err);
    return undefined;
  }
  killWithParent(proc.pid);
  allowForeground(proc.pid);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, deadlineMs);
  const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) return null;

  const line = stdout.trim().split('\n').pop() ?? '';
  let result: FolderDialogResult;
  try {
    result = JSON.parse(line) as FolderDialogResult;
  } catch {
    console.error('[pickDirectory] folder dialog helper exited without an answer', {
      exitCode: proc.exitCode,
    });
    return undefined;
  }
  if ('path' in result) return result.path;
  if ('cancelled' in result) return null;
  console.error('[pickDirectory] folder dialog failed:', result.error);
  return undefined;
}

export interface PickDirectoryOptions {
  /**
   * Windows: the argv that starts a process running `runFolderDialogProcess()` from
   * `@yaar/lib/win32`. Only the caller knows what that is — its own exe with a flag, or the
   * runtime plus a script. Without it, Windows uses the PowerShell picker.
   */
  helperArgv?: string[];
  /** How long the Windows dialog may stay open before it is closed as a cancel. */
  deadlineMs?: number;
}

/**
 * Open a native directory picker dialog. Returns the absolute path or null if cancelled.
 */
export async function pickDirectory(options: PickDirectoryOptions = {}): Promise<string | null> {
  if (isWin32 && options.helperArgv) {
    const answer = await tryFileDialog(options.helperArgv, options.deadlineMs ?? 60_000);
    if (answer !== undefined) return answer;
  }
  const pickers =
    isWin32 || isWSL
      ? [tryPowerShell, tryZenity, tryKdialog]
      : isDarwin
        ? [tryOsascript, tryZenity, tryKdialog]
        : [tryZenity, tryKdialog, tryPowerShell];

  for (const picker of pickers) {
    try {
      const result = await picker();
      if (result !== null) return result;
    } catch (err) {
      console.error(`[pickDirectory] ${picker.name} failed:`, err);
    }
  }
  return null;
}
