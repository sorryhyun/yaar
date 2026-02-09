/**
 * HTTP tools - GET and POST requests using curl for cross-platform compatibility.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPermissionTools } from './permission.js';
import { registerRequestTools } from './request.js';

export function registerHttpTools(server: McpServer): void {
  registerPermissionTools(server);
  registerRequestTools(server);
}
