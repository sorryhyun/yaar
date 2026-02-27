/**
 * Native directory picker — opens a folder selection dialog on the host OS.
 *
 * Platform strategy:
 * - Windows (native exe): PowerShell FolderBrowserDialog via temp .ps1 file
 *   (stdout piping is broken in Bun compiled exe, so results go through temp files)
 * - WSL: PowerShell FolderBrowserDialog + wslpath conversion
 * - Linux/macOS: zenity or kdialog (direct spawn with stdout)
 *
 * Returns the selected absolute path, or null if cancelled.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const isWSL = process.platform === 'linux' && process.env.WSL_DISTRO_NAME != null;
const isWin32 = process.platform === 'win32';

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
$f = New-Object System.Windows.Forms.Form
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.MinimizeBox = $false
$f.Size = New-Object System.Drawing.Size(0,0)
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(-9999,-9999)
$f.Show()
$f.Activate()
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
 * Open a native directory picker dialog. Returns the absolute path or null if cancelled.
 */
export async function pickDirectory(): Promise<string | null> {
  const pickers =
    isWin32 || isWSL
      ? [tryPowerShell, tryZenity, tryKdialog]
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
