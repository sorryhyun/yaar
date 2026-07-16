/**
 * Server configuration — constants, paths, MIME types.
 */

import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

/** Read an integer from an environment variable with a default. */
export function getEnvInt(key: string, defaultValue: number): number {
  return parseInt(process.env[key] ?? String(defaultValue), 10);
}

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

/**
 * Directory holding the onnxruntime-web runtime artifacts (`.wasm`/`.mjs`),
 * served to app iframes at `/api/ml-runtime/` for the @bundled/yaar-ml SDK.
 *
 * - Environment override: `YAAR_ML_RUNTIME_DIR`
 * - Bundled exe: `./ml-runtime/` alongside the executable (shipped at build time)
 * - Development: resolved from the installed `onnxruntime-web` package's `dist/`
 *
 * Returns `null` when the runtime can't be located (route then 404s cleanly).
 */
let _mlRuntimeDir: string | null | undefined;
export function getMlRuntimeDir(): string | null {
  if (_mlRuntimeDir !== undefined) return _mlRuntimeDir;

  if (process.env.YAAR_ML_RUNTIME_DIR) {
    _mlRuntimeDir = process.env.YAAR_ML_RUNTIME_DIR;
    return _mlRuntimeDir;
  }
  if (IS_BUNDLED_EXE) {
    const dir = join(dirname(process.execPath), 'ml-runtime');
    _mlRuntimeDir = existsSync(dir) ? dir : null;
    return _mlRuntimeDir;
  }
  // Dev: locate the onnxruntime-web package and point at its dist/.
  for (const from of [__dirname, PROJECT_ROOT, join(PROJECT_ROOT, 'packages', 'server')]) {
    try {
      const pkgJson = Bun.resolveSync('onnxruntime-web/package.json', from);
      const dist = join(dirname(pkgJson), 'dist');
      if (existsSync(dist)) {
        _mlRuntimeDir = dist;
        return _mlRuntimeDir;
      }
    } catch {
      /* try next base dir */
    }
  }
  _mlRuntimeDir = null;
  return _mlRuntimeDir;
}

const DEFAULT_PORT = getEnvInt('PORT', 8000);

/** Current server port (may differ from default if the default was in use). */
export function getPort(): number {
  return getEnvInt('PORT', DEFAULT_PORT);
}

/** Update the port after the server has bound to a free port. */
export function setPort(p: number): void {
  process.env.PORT = String(p);
}

export const IS_REMOTE = process.env.REMOTE === '1' || IS_BUNDLED_EXE;

/** Dev mode: local development with live reload (not remote, not bundled). */
export const IS_DEV = !IS_REMOTE && !IS_BUNDLED_EXE;

/** Marketplace base URL. */
export const MARKET_URL = process.env.MARKET_URL ?? 'https://yaarmarket.vercel.app';

// ── Deadlines ────────────────────────────────────────────────────────
//
// One budget, and every inner deadline is derived from it.
//
// A tool call that waits on the user or on an app holds an HTTP request open the whole
// time it waits, and the transport has a deadline of its own: Bun closes a connection
// idle for longer than `idleTimeout`, whose maximum is 255s. Deadlines were previously
// chosen per call site, and two of them (a user prompt, an external MCP call) sat at
// 300s — *past* the transport's. The connection died 45s before the inner timer fired,
// so the result was written to a socket nobody was reading, and the timer kept ticking
// against a request that no longer existed. An inner deadline that outlives its
// transport cannot report anything, not even its own expiry.
//
// So: the transport bound is the outer one, and every deadline that holds a request
// open fits strictly inside it, leaving room to serialize and flush the answer.

/** `Bun.serve`'s idle timeout, in seconds. 255 is the protocol maximum — a ceiling, not a choice. */
export const TRANSPORT_IDLE_TIMEOUT_S = 255;

/**
 * The longest a server-side deadline may hold an inbound request open.
 * Strictly below the transport bound, so expiry always reaches the caller.
 */
export const MAX_REQUEST_DEADLINE_MS = 240_000;

/** Clamp a caller-supplied deadline into the budget. */
export function clampDeadline(timeoutMs: number): number {
  return Math.min(Math.max(timeoutMs, 0), MAX_REQUEST_DEADLINE_MS);
}

/**
 * The deadlines a server→client wait runs on — one object, read at call time.
 *
 * These were `const QUERY_TIMEOUT_MS = 5_000` and friends, scattered across the call sites
 * that used them. That is fine until something has to *prove* the waits are alive, which
 * is what the loopback harness does: a deadlocked turn is indistinguishable from a slow
 * one except by how long it takes to end, so the test has to be able to make "how long"
 * small. At production values a deadlock test would spend 30 seconds finding out, per
 * scenario, and nobody runs that per commit. With these shrunk to tens of milliseconds,
 * the same test goes red in a quarter of a second.
 *
 * Injectable, not merely configurable: `setDeadlinesForTest()` mutates this object and
 * hands back the restore, and every call site reads the field rather than closing over a
 * constant. Callers that take an explicit `timeoutMs` still win — these are the defaults
 * and the floor beneath them.
 */
export interface Deadlines {
  /** Reading app state is expected to be near-instant. `handleAppQuery`. */
  appQueryMs: number;
  /** Commands do real work (devtools compile/deploy shells out). `handleAppCommand`. */
  appCommandMs: number;
  /** Floor under a caller-supplied command timeout — a command needs *some* room. */
  appCommandMinMs: number;
  /** How long a command waits for the iframe to call `app.register()`. `waitForAppReady`. */
  appReadyMs: number;
  /** Default life of a confirm/permission dialog before it is withdrawn and denied. */
  dialogMs: number;
  /** Default life of a user prompt. Production value is the whole request budget. */
  userPromptMs: number;
  /** Default wait for the frontend to report on a rendered action. */
  renderFeedbackMs: number;
}

const PRODUCTION_DEADLINES: Readonly<Deadlines> = Object.freeze({
  appQueryMs: 5_000,
  appCommandMs: 30_000,
  appCommandMinMs: 1_000,
  appReadyMs: 5_000,
  dialogMs: 60_000,
  userPromptMs: MAX_REQUEST_DEADLINE_MS,
  renderFeedbackMs: 3_000,
});

export const deadlines: Deadlines = { ...PRODUCTION_DEADLINES };

/**
 * Shrink deadlines for a test. Returns the restore — call it in `afterEach`, or the next
 * file in the same Bun process inherits a 50ms app-command timeout and fails for reasons
 * that have nothing to do with it.
 */
export function setDeadlinesForTest(overrides: Partial<Deadlines>): () => void {
  const previous = { ...deadlines };
  Object.assign(deadlines, overrides);
  return () => Object.assign(deadlines, previous);
}

// ── Monitor budget limits ────────────────────────────────────────────
/**
 * How many tasks may wait on a monitor's queue before new ones are refused.
 *
 * Single-sourced: `context-pool.ts` sizes the queue with it and
 * `monitor-task-processor.ts` reports it in the refusal, so two copies could
 * disagree about the number in the error the user actually reads.
 */
export const MAX_QUEUE_SIZE = 10;
export const MONITOR_MAX_CONCURRENT = getEnvInt('MONITOR_MAX_CONCURRENT', 2);
export const MONITOR_MAX_ACTIONS_PER_MIN = getEnvInt('MONITOR_MAX_ACTIONS_PER_MIN', 30);
export const MONITOR_MAX_OUTPUT_PER_MIN = getEnvInt('MONITOR_MAX_OUTPUT_PER_MIN', 50000);

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

// ── Codex app-server configuration ────────────────────────────────────

/** Default port for the codex app-server WebSocket listener. */
export const CODEX_WS_PORT = getEnvInt('CODEX_WS_PORT', 4510);

/**
 * DevTools debug port of the user's own Chrome, used by `LocalUserBrowser`
 * (the local-browser BrowserProvider). The user launches Chrome with
 * `--remote-debugging-port=<port>`; YAAR attaches to it over CDP instead of
 * spawning a private headless Chrome.
 */
export const CHROME_DEBUG_PORT = getEnvInt('CHROME_DEBUG_PORT', 9222);

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
  args.push('-c', 'features.personality=false');
  args.push('-c', 'features.fast_mode=false');
  args.push('-c', 'features.skill_mcp_dependency_install=false');
  args.push('-c', 'apps._default.enabled=false');
  // Disable native memory: it injects a large `## Memory` developer message
  // (the full MEMORY_SUMMARY + lookup instructions from ~/.codex/memories) into
  // every thread. That cross-project history is irrelevant noise for YAAR's
  // short-lived, app-scoped agents.
  args.push('-c', 'features.memories=false');
  // Enable native collaboration/subagent system for task delegation
  args.push('-c', 'features.collaboration_modes=true');

  // Configure YAAR MCP servers
  for (const ns of mcpNamespaces) {
    args.push(
      '-c',
      `mcp_servers.${ns}.url=http://127.0.0.1:${getPort()}/mcp/${ns}`,
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
    // YAAR auto-runs agents (mirrors Claude's bypassPermissions). With
    // shell_tool/apply_patch disabled, codex can only call YAAR's first-party
    // MCP tools (app/verbs/system) — those must never prompt. `on-request`
    // instead gated MCP calls through an approval the provider doesn't handle,
    // so codex declined them ("user rejected MCP tool call").
    'approval_policy=never',
    '-c',
    'project_doc_max_bytes=0',
    // Enable web search (mirrors Claude's WebSearch builtin tool). The Codex
    // message-mapper already maps webSearch items; this turns the tool on.
    '-c',
    'web_search=live',
  );

  return args;
}
