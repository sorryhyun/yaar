/**
 * MCP module exports.
 */

// Server
export {
  initMcpServer,
  handleMcpRequest,
  getMcpToken,
  MCP_SERVERS,
  type McpServerName,
  getToolNames,
  formatToolDisplay,
} from './server.js';

// Domain tool registrations + tool name exports
export { registerSystemTools, SYSTEM_TOOL_NAMES } from './system/index.js';
export { registerWindowTools, WINDOW_TOOL_NAMES } from './window/index.js';
export { registerAppsTools, APPS_TOOL_NAMES } from './apps/index.js';
export { registerHttpTools, HTTP_TOOL_NAMES } from './http/index.js';
export { registerAppDevTools, DEV_TOOL_NAMES } from './dev/index.js';
export { registerUserTools, USER_TOOL_NAMES } from './user/index.js';

// Action emitter
export { actionEmitter, type ActionEvent, type RenderingFeedback } from './action-emitter.js';

// Window state
export { WindowStateRegistry, type WindowState } from './window-state.js';

// Utils
export { ok, okWithImages, error } from './utils.js';
