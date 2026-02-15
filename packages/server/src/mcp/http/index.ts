/**
 * HTTP tools - GET and POST requests using curl for cross-platform compatibility.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPermissionTools } from './permission.js';
import { registerRequestTools } from './request.js';

export const HTTP_TOOL_NAMES = [
  'mcp__system__http_get',
  'mcp__system__http_post',
  'mcp__system__request_allowing_domain',
] as const;

export function registerHttpTools(server: McpServer): void {
  registerPermissionTools(server);
  registerRequestTools(server);
}
