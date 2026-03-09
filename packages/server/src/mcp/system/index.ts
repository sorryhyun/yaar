/**
 * Always-on system-namespace MCP tools (active in both verb and legacy modes).
 *
 * - HTTP: http_get, http_post, request_allowing_domain
 * - Reload: reload_cached, list_reload_options
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPermissionTools } from './permission.js';
import { registerRequestTools } from './request.js';

export { registerReloadTools, RELOAD_TOOL_NAMES } from './reload.js';

export const HTTP_TOOL_NAMES = [
  'mcp__system__http_get',
  'mcp__system__http_post',
  'mcp__system__request_allowing_domain',
] as const;

export function registerHttpTools(server: McpServer): void {
  registerPermissionTools(server);
  registerRequestTools(server);
}
