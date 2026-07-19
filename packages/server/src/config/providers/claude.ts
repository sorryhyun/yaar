/**
 * Locating and spawning the `claude` CLI.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { IS_BUNDLED_EXE } from '../env.js';

/**
 * Resolve the absolute path to the claude binary (exe/binary only, not .cmd wrappers).
 * Returns null if no binary is found on disk.
 *
 * Used by the Agent SDK's `pathToClaudeCodeExecutable` option so the SDK doesn't
 * need to locate its own bundled binary (which is inaccessible in a compiled exe).
 */
export function resolveClaudeBinPath(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';

  // 1. Honor CLAUDE_CODE_PATH override (.env or shell)
  const override = process.env.CLAUDE_CODE_PATH;
  if (override && existsSync(override)) return override;

  // 2. Check next to the executable (bundled exe ships claude alongside)
  if (IS_BUNDLED_EXE) {
    const localBin = join(dirname(process.execPath), `claude${ext}`);
    if (existsSync(localBin)) return localBin;
  }

  // 3. Check ~/.local/bin/ (standard install location on Windows and Linux)
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const dotLocalBin = join(home, '.local', 'bin', `claude${ext}`);
    if (existsSync(dotLocalBin)) return dotLocalBin;
  }

  return null;
}

/**
 * Get the claude CLI spawn args (command + prefix args).
 * Uses resolveClaudeBinPath() first, then falls back to .cmd wrappers on Windows,
 * then bare 'claude' from PATH.
 *
 * Returns `[cmd, ...prefixArgs]` — callers should spread this before their own args:
 *   `Bun.spawn([...getClaudeSpawnArgs(), '--version', ...])`
 */
export function getClaudeSpawnArgs(): string[] {
  const binPath = resolveClaudeBinPath();
  if (binPath) return [binPath];

  if (IS_BUNDLED_EXE && process.platform === 'win32') {
    // .cmd wrappers need `cmd /c` to execute via uv_spawn
    const npmPrefix = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null;
    if (npmPrefix) {
      const cmdPath = join(npmPrefix, 'claude.cmd');
      if (existsSync(cmdPath)) return ['cmd', '/c', cmdPath];
    }
  }

  return ['claude'];
}
