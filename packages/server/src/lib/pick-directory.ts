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

const isWSL = process.platform === 'linux' && process.env.WSL_DISTRO_NAME != null;

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

  const tmpFile = stdout.trim();
  if (!tmpFile) return null;

  const { readFile, unlink } = await import('fs/promises');
  let winPath: string;
  try {
    if (isWSL) {
      // On WSL: convert Windows temp path → WSL path, then read
      const { stdout: wslTmp } = await exec('wslpath', ['-u', tmpFile]);
      winPath = (await readFile(wslTmp, 'utf-8')).trim();
      await unlink(wslTmp).catch(() => {});
    } else {
      // On native Windows: read the temp file directly
      winPath = (await readFile(tmpFile, 'utf-8')).trim();
      await unlink(tmpFile).catch(() => {});
    }
    // Remove BOM if present
    if (winPath.charCodeAt(0) === 0xfeff) winPath = winPath.slice(1);
  } catch {
    return null;
  }

  if (!winPath) return null;

  if (isWSL && /^[A-Za-z]:\\/.test(winPath)) {
    // On WSL: convert Windows path → WSL path
    const { stdout: wslPath, code: wslCode } = await exec('wslpath', ['-u', winPath]);
    return wslCode === 0 && wslPath ? wslPath : null;
  }
  // On native Windows: return the Windows path as-is
  return winPath;
}

/**
 * Open a native directory picker dialog. Returns the absolute path or null if cancelled.
 */
export async function pickDirectory(): Promise<string | null> {
  // On Windows (native or WSL), prefer PowerShell; on Linux, prefer zenity/kdialog
  const pickers =
    process.platform === 'win32' || isWSL
      ? [tryPowerShell, tryZenity, tryKdialog]
      : [tryZenity, tryKdialog, tryPowerShell];

  for (const picker of pickers) {
    try {
      const result = await picker();
      if (result !== null) return result;
    } catch {
      // Command not found — try next
    }
  }
  return null;
}
