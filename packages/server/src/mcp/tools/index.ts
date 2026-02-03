/**
 * MCP tool registration aggregator.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSystemTools } from './system.js';
import { registerWindowTools } from './window.js';
import { registerStorageTools } from './storage.js';
import { registerAppsTools } from './apps.js';
import { registerHttpTools } from './http.js';
import { registerAppDevTools } from './app-dev.js';

export { registerSystemTools } from './system.js';
export { registerWindowTools } from './window.js';
export { registerStorageTools } from './storage.js';
export { registerAppsTools } from './apps.js';
export { registerHttpTools } from './http.js';
export { registerAppDevTools } from './app-dev.js';

/**
 * Register all YAAR tools on the MCP server.
 */
export function registerAllTools(server: McpServer): void {
  registerSystemTools(server);
  registerWindowTools(server);
  registerStorageTools(server);
  registerAppsTools(server);
  registerHttpTools(server);
  registerAppDevTools(server);
}

/**
 * Get the list of MCP tool names for YAAR.
 */
export function getToolNames(): string[] {
  return [
    // Built-in Claude tools
    'WebSearch',
    // System tools
    'mcp__yaar__get_system_time',
    'mcp__yaar__calculate',
    'mcp__yaar__get_system_info',
    'mcp__yaar__get_env_var',
    'mcp__yaar__generate_random',
    // Window tools
    'mcp__yaar__create_window',
    'mcp__yaar__update_window',
    'mcp__yaar__close_window',
    'mcp__yaar__lock_window',
    'mcp__yaar__unlock_window',
    'mcp__yaar__list_windows',
    'mcp__yaar__view_window',
    'mcp__yaar__show_notification',
    'mcp__yaar__dismiss_notification',
    // Storage tools
    'mcp__yaar__storage_read',
    'mcp__yaar__storage_write',
    'mcp__yaar__storage_list',
    'mcp__yaar__storage_delete',
    // Apps tools
    'mcp__yaar__apps_list',
    'mcp__yaar__apps_load_skill',
    'mcp__yaar__apps_read_config',
    'mcp__yaar__apps_write_config',
    // App development tools
    'mcp__yaar__app_write_ts',
    'mcp__yaar__app_compile',
    'mcp__yaar__app_deploy',
    // HTTP tools (curl-based)
    'mcp__yaar__request_allowing_domain',
    'mcp__yaar__http_get',
    'mcp__yaar__http_post',
  ];
}
