/**
 * Native directory picker — opens a folder selection dialog on the host OS.
 *
 * Tries (in order): zenity, kdialog, PowerShell (for WSL2).
 * Returns the selected absolute path, or null if cancelled.
 */

import { execFile } from 'child_process';

function exec(
  cmd: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 60_000, encoding: 'utf-8', env: { ...process.env, ...env } },
      (err, stdout) => {
        resolve({ stdout: (stdout ?? '').trim(), code: err ? ((err as any).code ?? 1) : 0 });
      },
    );
  });
}

async function tryZenity(): Promise<string | null> {
  const { stdout, code } = await exec('zenity', [
    '--file-selection',
    '--directory',
    '--title=Select folder to mount',
  ]);
  return code === 0 && stdout ? stdout : null;
}

async function tryKdialog(): Promise<string | null> {
  const { stdout, code } = await exec('kdialog', [
    '--getexistingdirectory',
    '.',
    '--title',
    'Select folder to mount',
  ]);
  return code === 0 && stdout ? stdout : null;
}

async function tryPowerShell(): Promise<string | null> {
  // Write the selected path to a temp file as UTF-8 to avoid encoding issues
  // with non-ASCII characters (e.g. Korean folder names) on stdout.
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select folder to mount'
$d.ShowNewFolderButton = $false
if ($d.ShowDialog() -eq 'OK') {
  $tmp = [System.IO.Path]::GetTempFileName()
  [System.IO.File]::WriteAllText($tmp, $d.SelectedPath, [System.Text.Encoding]::UTF8)
  Write-Output $tmp
} else { Write-Output '' }
`.trim();

  const { stdout, code } = await exec('powershell.exe', ['-NoProfile', '-Command', script]);
  if (code !== 0 || !stdout) return null;

  // stdout is a Windows temp file path containing the real selected path
  const tmpFile = stdout.trim();
  if (!tmpFile) return null;

  // Read the temp file from WSL, then clean up
  const { readFile, unlink } = await import('fs/promises');
  let winPath: string;
  try {
    // Convert the Windows temp path to WSL to read it
    const { stdout: wslTmp } = await exec('wslpath', ['-u', tmpFile]);
    winPath = (await readFile(wslTmp, 'utf-8')).trim();
    // Remove BOM if present
    if (winPath.charCodeAt(0) === 0xfeff) winPath = winPath.slice(1);
    await unlink(wslTmp).catch(() => {});
  } catch {
    return null;
  }

  if (!winPath) return null;

  // Convert Windows path (C:\Users\...) to WSL path (/mnt/c/Users/...)
  if (/^[A-Za-z]:\\/.test(winPath)) {
    const { stdout: wslPath, code: wslCode } = await exec('wslpath', ['-u', winPath]);
    return wslCode === 0 && wslPath ? wslPath : null;
  }
  return winPath;
}

/**
 * Open a native directory picker dialog. Returns the absolute path or null if cancelled.
 */
export async function pickDirectory(): Promise<string | null> {
  // Try each method in order of preference
  for (const picker of [tryZenity, tryKdialog, tryPowerShell]) {
    try {
      const result = await picker();
      if (result !== null) return result;
    } catch {
      // Command not found — try next
    }
  }
  return null;
}
