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
export { SYSTEM_TOOL_NAMES } from './system/index.js';

// Verb tools
export { registerVerbTools, VERB_TOOL_NAMES } from '../handlers/index.js';
