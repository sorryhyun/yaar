/**
 * Server configuration — compatibility barrel over `config/`.
 *
 * Every consumer imports `../config.js` and gets the same names it always did; the
 * implementation lives in focused modules beside this file:
 *
 *   config/env.ts               .env bootstrap, PROJECT_ROOT, port, mode flags
 *   config/paths.ts             storage / config / frontend-dist locations
 *   config/assets.ts            MIME table, upload ceiling, ML runtime artifacts
 *   config/deadlines.ts         the request budget and the mutable `deadlines` object
 *   config/limits.ts            queue and monitor budget limits
 *   config/providers/claude.ts  claude binary discovery + spawn args + SDK env/options
 *   config/providers/codex.ts   codex binary discovery + app-server args
 *   config/browser.ts           CDP debug port, clipboard pre-grant
 *
 * **Ordering rule.** `config/env.ts` loads the root `.env` at module evaluation and
 * every other submodule imports it, so `process.env` is fully populated before any
 * environment-derived constant is computed — no matter which consumer imports this
 * barrel first, and no matter whether it reaches a submodule directly. Do not read
 * `process.env` at module scope in a config submodule that does not import `env.js`.
 *
 * Re-exports are explicit rather than `export *` so the public surface of this module
 * is reviewable in one place, and so internals (e.g. `CONFIG_MODULE_DIR`) stay internal.
 */

// Must come first: loading .env is a side effect of importing this module.
export {
  getEnvInt,
  IS_BUNDLED_EXE,
  YAAR_VERSION,
  PROJECT_ROOT,
  getPort,
  setPort,
  IS_REMOTE,
  IS_DEV,
  APP_ORIGIN_ISOLATION,
  isAppOriginIsolationEnabled,
  isAppOriginIsolationRequested,
  DESKTOP_ORIGIN_HOST,
  APP_ORIGIN_HOST,
  MARKET_URL,
  GOOGLE_CLIENT_ID,
  shouldPruneEmptySessions,
} from './config/env.js';

export {
  getStorageDir,
  STORAGE_DIR,
  getConfigDir,
  getSessionLogsDir,
  getFrontendDist,
  FRONTEND_DIST,
} from './config/paths.js';

export {
  MIME_TYPES,
  MAX_UPLOAD_SIZE,
  getFrontendAsset,
  getMlRuntimeDir,
  getMlRuntimeArtifact,
} from './config/assets.js';

export {
  TRANSPORT_IDLE_TIMEOUT_S,
  MCP_TOOL_CALL_TIMEOUT_MS,
  MAX_REQUEST_DEADLINE_MS,
  clampDeadline,
  deadlines,
  setDeadlinesForTest,
} from './config/deadlines.js';
export type { Deadlines } from './config/deadlines.js';

export {
  MAX_QUEUE_SIZE,
  MONITOR_MAX_CONCURRENT,
  MONITOR_MAX_ACTIONS_PER_MIN,
  MONITOR_MAX_OUTPUT_PER_MIN,
  APP_AGENT_IDLE_MS,
  APP_AGENT_SWEEP_MS,
} from './config/limits.js';

export {
  resolveClaudeBinPath,
  getClaudeSpawnArgs,
  buildClaudeEnv,
  CLAUDE_STATIC_SDK_OPTIONS,
} from './config/providers/claude.js';

export {
  getCodexSpawnArgs,
  CODEX_WS_PORT,
  getCodexWsPort,
  getCodexAppServerArgs,
  getModelCatalogPath,
  detectUserMcpServers,
  DISABLED_FEATURES,
  ENABLED_FEATURES,
} from './config/providers/codex.js';

export { CHROME_DEBUG_PORT, isClipboardGrantEnabled } from './config/browser.js';
