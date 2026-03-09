/**
 * MCP module exports.
 */

// Server
export {
  initMcpServer,
  handleMcpRequest,
  getMcpToken,
  CORE_SERVERS,
  MCP_SERVERS,
  type McpServerName,
  getActiveServers,
  getToolNames,
  formatToolDisplay,
} from './server.js';

// Domain tool registrations + tool name exports
export { registerSystemTools, SYSTEM_TOOL_NAMES } from './legacy/system/index.js';
/** @deprecated Use verb mode instead. */
export { registerConfigNamespace, CONFIG_TOOL_NAMES } from './legacy/config/index.js';
/** @deprecated Use verb mode instead. */
export { registerWindowTools, WINDOW_TOOL_NAMES } from './legacy/window/index.js';
/** @deprecated Use verb mode instead. */
export { registerAppsTools, APPS_TOOL_NAMES } from './legacy/apps/index.js';
export { registerHttpTools, HTTP_TOOL_NAMES } from './system/index.js';
/** @deprecated Use verb mode instead. */
export { registerAppDevTools, DEV_TOOL_NAMES } from './legacy/dev/index.js';
/** @deprecated Use verb mode instead. */
export { registerUserTools, USER_TOOL_NAMES } from './legacy/user/index.js';

// Verb tools
export { registerVerbTools, VERB_TOOL_NAMES } from '../handlers/index.js';

// Action emitter
export { actionEmitter, type ActionEvent, type RenderingFeedback } from './action-emitter.js';

// Window state
export { WindowStateRegistry, type WindowState } from './window-state.js';

// Utils
export { ok, okWithImages, error } from './utils.js';
