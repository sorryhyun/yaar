/**
 * MCP tool registration aggregator.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSystemTools } from './system.js';
import { registerWindowTools } from './window.js';
import { registerStorageTools } from './storage.js';
import { registerAppsTools } from './apps.js';

export { registerSystemTools } from './system.js';
export { registerWindowTools } from './window.js';
export { registerStorageTools } from './storage.js';
export { registerAppsTools } from './apps.js';

/**
 * Register all ClaudeOS tools on the MCP server.
 */
export function registerAllTools(server: McpServer): void {
  registerSystemTools(server);
  registerWindowTools(server);
  registerStorageTools(server);
  registerAppsTools(server);
}

/**
 * Get the list of MCP tool names for ClaudeOS.
 */
export function getToolNames(): string[] {
  return [
    // Built-in Claude tools
    'WebFetch',
    'WebSearch',
    // System tools
    'mcp__claudeos__get_system_time',
    'mcp__claudeos__calculate',
    'mcp__claudeos__get_system_info',
    'mcp__claudeos__get_env_var',
    'mcp__claudeos__generate_random',
    // Window tools
    'mcp__claudeos__create_window',
    'mcp__claudeos__update_window',
    'mcp__claudeos__close_window',
    'mcp__claudeos__lock_window',
    'mcp__claudeos__unlock_window',
    'mcp__claudeos__list_windows',
    'mcp__claudeos__view_window',
    'mcp__claudeos__show_notification',
    'mcp__claudeos__dismiss_notification',
    // Storage tools
    'mcp__claudeos__storage_read',
    'mcp__claudeos__storage_write',
    'mcp__claudeos__storage_list',
    'mcp__claudeos__storage_delete',
    // Apps tools
    'mcp__claudeos__apps_list',
    'mcp__claudeos__apps_load_skill',
    'mcp__claudeos__apps_read_config',
    'mcp__claudeos__apps_write_config',
  ];
}
