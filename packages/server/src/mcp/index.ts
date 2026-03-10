/**
 * MCP module exports.
 */

// Server
export {
  initMcpServer,
  handleMcpRequest,
  getMcpToken,
  CORE_SERVERS,
  type McpServerName,
  getActiveServers,
  getToolNames,
  formatToolDisplay,
} from './server.js';

// Domain tool registrations
export { registerHttpTools, SYSTEM_TOOL_NAMES } from './system/index.js';

// Verb tools
export { registerVerbTools, VERB_TOOL_NAMES } from '../handlers/index.js';

// Action emitter
export { actionEmitter, type ActionEvent, type RenderingFeedback } from './action-emitter.js';

// Window state
export { WindowStateRegistry, type WindowState } from './window-state.js';

// Utils
export { ok, okWithImages, error } from './utils.js';
