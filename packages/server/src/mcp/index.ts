/**
 * MCP module exports.
 */

// Server
export { initMcpServer, handleMcpRequest, getMcpToken, MCP_SERVERS, type McpServerName } from './server.js';

// Tools
export { registerAllTools, getToolNames } from './tools/index.js';
export { registerSystemTools } from './tools/system.js';
export { registerWindowTools } from './tools/window.js';
export { registerStorageTools } from './tools/storage.js';

// Action emitter
export {
  actionEmitter,
  type ActionEvent,
  type RenderingFeedback,
} from './action-emitter.js';

// Window state
export { windowStateRegistryManager, WindowStateRegistry, type WindowState } from './window-state.js';

// Utils
export { ok, okWithImages } from './utils.js';
