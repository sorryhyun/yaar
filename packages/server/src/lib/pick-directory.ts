/**
 * Native directory picker — opens a folder selection dialog on the host OS.
 *
 * Tries (in order): zenity, kdialog, PowerShell (for WSL2).
 * Returns the selected absolute path, or null if cancelled.
 *
 * On Windows (Bun compiled exe), stdout piping from child processes is broken.
 * We work around this by writing results to a temp file and polling for it,
 * using detached + stdio:'ignore' spawn (proven to work from exe-entry.ts).
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { randomBytes } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const isWSL = process.platform === 'linux' && process.env.WSL_DISTRO_NAME != null;
const isWin32 = process.platform === 'win32';

/** Sleep for ms. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Spawn a command detached with no stdio, have it write result to a temp file, poll for it.
 * This is the only reliable way to run child processes in Bun compiled exe on Windows.
 */
async function execViaFile(
  cmd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ stdout: string; code: number }> {
  const id = randomBytes(4).toString('hex');
  const resultFile = join(tmpdir(), `yaar-exec-${id}.txt`);
  const doneFile = join(tmpdir(), `yaar-done-${id}.txt`);

  // Wrap command: run the real command, capture output to resultFile, write exit code to doneFile
  const escapedArgs = args.map((a) => "'" + a.replace(/'/g, "''") + "'").join(' ');
  const wrappedScript = [
    'try {',
    `  $out = & '${cmd}' ${escapedArgs} 2>&1`,
    `  [System.IO.File]::WriteAllText('${resultFile.replace(/\\/g, '\\\\')}', ($out -join [char]10), [System.Text.Encoding]::UTF8)`,
    `  [System.IO.File]::WriteAllText('${doneFile.replace(/\\/g, '\\\\')}', '0', [System.Text.Encoding]::UTF8)`,
    '} catch {',
    `  [System.IO.File]::WriteAllText('${doneFile.replace(/\\/g, '\\\\')}', '1', [System.Text.Encoding]::UTF8)`,
    '}',
  ].join('\n');

  const child = spawn('powershell.exe', ['-NoProfile', '-Command', wrappedScript], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Poll for done file
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);
    if (existsSync(doneFile)) {
      const code = parseInt(readFileSync(doneFile, 'utf-8').trim(), 10) || 0;
      const stdout = existsSync(resultFile) ? readFileSync(resultFile, 'utf-8').trim() : '';
      try {
        unlinkSync(resultFile);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(doneFile);
      } catch {
        /* ignore */
      }
      return { stdout, code };
    }
  }
  // Timeout — clean up
  try {
    unlinkSync(resultFile);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(doneFile);
  } catch {
    /* ignore */
  }
  return { stdout: '', code: 1 };
}

async function tryZenity(): Promise<string | null> {
  const { stdout, code } = await execViaFile('zenity', [
    '--file-selection',
    '--directory',
    '--title=Select folder to mount',
  ]);
  return code === 0 && stdout ? stdout : null;
}

async function tryKdialog(): Promise<string | null> {
  const { stdout, code } = await execViaFile('kdialog', [
    '--getexistingdirectory',
    '.',
    '--title',
    'Select folder to mount',
  ]);
  return code === 0 && stdout ? stdout : null;
}

async function tryPowerShell(): Promise<string | null> {
  const id = randomBytes(4).toString('hex');
  const resultFile = join(tmpdir(), `yaar-pick-${id}.txt`);
  const doneFile = join(tmpdir(), `yaar-pick-done-${id}.txt`);

  // PowerShell script that opens folder dialog and writes result to temp files.
  // The result file contains the selected path (empty if cancelled).
  // The done file signals completion.
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
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Select folder to mount'
$d.ShowNewFolderButton = $false
$result = ''
if ($d.ShowDialog($f) -eq 'OK') { $result = $d.SelectedPath }
$f.Dispose()
[System.IO.File]::WriteAllText('${resultFile.replace(/\\/g, '\\\\')}', $result, [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText('${doneFile.replace(/\\/g, '\\\\')}', '0', [System.Text.Encoding]::UTF8)
`.trim();

  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // Poll for done file (up to 60s)
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (existsSync(doneFile)) {
      let winPath = existsSync(resultFile) ? readFileSync(resultFile, 'utf-8').trim() : '';
      try {
        unlinkSync(resultFile);
      } catch {
        /* ignore */
      }
      try {
        unlinkSync(doneFile);
      } catch {
        /* ignore */
      }

      // Remove BOM if present
      if (winPath.charCodeAt(0) === 0xfeff) winPath = winPath.slice(1);
      if (!winPath) return null;

      if (isWSL && /^[A-Za-z]:\\/.test(winPath)) {
        const { stdout: wslPath, code: wslCode } = await execViaFile('wslpath', ['-u', winPath]);
        return wslCode === 0 && wslPath ? wslPath : null;
      }
      return winPath;
    }
  }

  // Timeout — clean up
  try {
    unlinkSync(resultFile);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(doneFile);
  } catch {
    /* ignore */
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
    } catch {
      // Command not found — try next
    }
  }
  return null;
}
