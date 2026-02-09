/**
 * MCP module exports.
 */

// Server
export { initMcpServer, handleMcpRequest, getMcpToken, MCP_SERVERS, type McpServerName } from './server.js';

// Tool registration
export { registerAllTools, getToolNames } from './register.js';

// Domain tool registrations
export { registerSystemTools } from './system/index.js';
export { registerWindowTools } from './window/index.js';
export { registerStorageTools } from './storage/index.js';
export { registerAppsTools } from './apps/index.js';
export { registerHttpTools } from './http/index.js';
export { registerAppDevTools } from './app-dev/index.js';
export { registerSandboxTools } from './sandbox/index.js';

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
