/**
 * Server configuration — constants, paths, MIME types.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// Detect if running as bundled executable
// __YAAR_BUNDLED is injected at compile time via bun build --define
declare const __YAAR_BUNDLED: boolean | undefined;
export const IS_BUNDLED_EXE = typeof __YAAR_BUNDLED !== 'undefined' && __YAAR_BUNDLED;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Project root directory.
 * - Bundled exe: directory containing the executable
 * - Development: 3 levels up from src/ (packages/server/src → project root)
 */
export const PROJECT_ROOT = IS_BUNDLED_EXE
  ? dirname(process.execPath)
  : join(__dirname, '..', '..', '..');

/**
 * Get the storage directory path.
 * - Environment variable override
 * - Otherwise: PROJECT_ROOT/storage/ (works for both bundled and dev)
 */
export function getStorageDir(): string {
  if (process.env.YAAR_STORAGE) {
    return process.env.YAAR_STORAGE;
  }
  return join(PROJECT_ROOT, 'storage');
}

export const STORAGE_DIR = getStorageDir();

/**
 * Get the config directory path.
 * - Environment variable override
 * - Always relative to PROJECT_ROOT
 */
export function getConfigDir(): string {
  if (process.env.YAAR_CONFIG) {
    return process.env.YAAR_CONFIG;
  }
  return join(PROJECT_ROOT, 'config');
}

/**
 * Get the frontend dist directory path.
 * - Environment variable override
 * - Bundled exe: ./public/ alongside executable
 * - Development: packages/frontend/dist/
 */
export function getFrontendDist(): string {
  if (process.env.FRONTEND_DIST) {
    return process.env.FRONTEND_DIST;
  }
  if (IS_BUNDLED_EXE) {
    return join(dirname(process.execPath), 'public');
  }
  return join(PROJECT_ROOT, 'packages', 'frontend', 'dist');
}

export const FRONTEND_DIST = getFrontendDist();

export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

export const PORT = parseInt(process.env.PORT ?? '8000', 10);

export const IS_REMOTE = process.env.REMOTE === '1' || IS_BUNDLED_EXE;

// ── Monitor budget limits ────────────────────────────────────────────
export const MONITOR_MAX_CONCURRENT = parseInt(process.env.MONITOR_MAX_CONCURRENT ?? '2', 10);
export const MONITOR_MAX_ACTIONS_PER_MIN = parseInt(
  process.env.MONITOR_MAX_ACTIONS_PER_MIN ?? '30',
  10,
);
export const MONITOR_MAX_OUTPUT_PER_MIN = parseInt(
  process.env.MONITOR_MAX_OUTPUT_PER_MIN ?? '50000',
  10,
);

/**
 * Get the claude CLI spawn args.
 * When running as a bundled exe, looks for claude next to the executable first,
 * then checks common install locations (Windows: ~/.local/bin, npm global).
 * Falls back to 'claude' from PATH.
 *
 * Returns `[cmd, ...prefixArgs]` — callers should spread this before their own args:
 *   `Bun.spawn([...getClaudeSpawnArgs(), '--version', ...])`
 */
export function getClaudeSpawnArgs(): string[] {
  if (IS_BUNDLED_EXE) {
    const ext = process.platform === 'win32' ? '.exe' : '';

    // 1. Check next to the executable
    const localBin = join(dirname(process.execPath), `claude${ext}`);
    if (existsSync(localBin)) return [localBin];

    // 2. Check ~/.local/bin/ (standard install location on Windows and Linux)
    const home = process.env.USERPROFILE || process.env.HOME;
    if (home) {
      const dotLocalBin = join(home, '.local', 'bin', `claude${ext}`);
      if (existsSync(dotLocalBin)) return [dotLocalBin];
    }

    // 3. On Windows, resolve npm global bin (claude.cmd wrapper)
    if (process.platform === 'win32') {
      const npmPrefix = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null;
      if (npmPrefix) {
        const cmdPath = join(npmPrefix, 'claude.cmd');
        if (existsSync(cmdPath)) return ['cmd', '/c', cmdPath];
      }
    }
  }
  return ['claude'];
}

/**
 * Get the codex CLI spawn args (command + prefix args).
 * When running as a bundled exe, looks for codex next to the executable first,
 * then resolves the npm global bin directory (handles Windows .cmd wrappers).
 * Falls back to 'codex' from PATH.
 *
 * Returns `[cmd, ...prefixArgs]` — callers should spread this before their own args:
 *   `Bun.spawn([...getCodexSpawnArgs(), 'app-server', ...])`
 */
export function getCodexSpawnArgs(): string[] {
  if (IS_BUNDLED_EXE) {
    // 1. Check next to the executable
    const ext = process.platform === 'win32' ? '.exe' : '';
    const localBin = join(dirname(process.execPath), `codex${ext}`);
    if (existsSync(localBin)) return [localBin];

    // 2. On Windows, resolve npm global bin (codex.cmd wrapper)
    //    .cmd files need `cmd /c` to execute via uv_spawn
    if (process.platform === 'win32') {
      const npmPrefix = process.env.APPDATA ? join(process.env.APPDATA, 'npm') : null;
      if (npmPrefix) {
        const cmdPath = join(npmPrefix, 'codex.cmd');
        if (existsSync(cmdPath)) return ['cmd', '/c', cmdPath];
      }
    }
  }
  return ['codex'];
}

/** @deprecated Use getCodexSpawnArgs() instead */
export function getCodexBin(): string {
  return getCodexSpawnArgs()[0];
}

// ── Codex app-server configuration ────────────────────────────────────

/** Default port for the codex app-server WebSocket listener. */
export const CODEX_WS_PORT = parseInt(process.env.CODEX_WS_PORT ?? '4510', 10);

/** Get the codex app-server WebSocket port (env override or default). */
export function getCodexWsPort(): number {
  return CODEX_WS_PORT;
}

/**
 * Build the CLI args for `codex app-server`.
 * Separates config from process management so it's easy to review/change.
 */
export function getCodexAppServerArgs(mcpNamespaces: readonly string[]): string[] {
  const args = ['app-server'];

  // Disable shell tool and apply_patch (apps use clone-revise-compile-deploy flow)
  args.push('-c', 'features.shell_tool=false');
  args.push('-c', 'features.apply_patch_freeform=false');
  args.push('-c', 'features.multi_agent=true');
  // Enable native collaboration/subagent system for task delegation
  args.push('-c', 'features.collaboration_modes=true');

  // Configure YAAR MCP servers
  for (const ns of mcpNamespaces) {
    args.push(
      '-c',
      `mcp_servers.${ns}.url=http://127.0.0.1:${PORT}/mcp/${ns}`,
      '-c',
      `mcp_servers.${ns}.bearer_token_env_var=YAAR_MCP_TOKEN`,
    );
  }

  // Model behavior
  args.push(
    '-c',
    'model_reasoning_effort=medium',
    '-c',
    'personality=none',
    '-c',
    'sandbox_mode=danger-full-access',
    '-c',
    'approval_policy=on-request',
    '-c',
    'project_doc_max_bytes=0',
  );

  return args;
}
