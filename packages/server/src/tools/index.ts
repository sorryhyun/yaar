/**
 * ClaudeOS Custom Tools.
 *
 * Combines all tool modules and exports the MCP server.
 */

import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

import { systemTools } from './system.js';
import { windowTools } from './window.js';
import { storageTools } from './storage.js';

// Re-export individual tool modules
export * from './system.js';
export * from './window.js';
export * from './storage.js';
export * from './action-emitter.js';
export * from './window-state.js';

/**
 * All ClaudeOS tools combined.
 */
export const allTools = [
  ...systemTools,
  ...windowTools,
  ...storageTools
];

/**
 * Create the ClaudeOS MCP server with all custom tools.
 */
export const claudeOSTools = createSdkMcpServer({
  name: 'claudeos',
  version: '1.0.0',
  tools: allTools
});

/**
 * Get the allowed tool names for ClaudeOS.
 */
export function getClaudeOSToolNames(): string[] {
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
    'mcp__claudeos__show_toast',
    'mcp__claudeos__lock_window',
    'mcp__claudeos__unlock_window',
    'mcp__claudeos__list_windows',
    'mcp__claudeos__view_window',
    // Storage tools
    'mcp__claudeos__storage_read',
    'mcp__claudeos__storage_write',
    'mcp__claudeos__storage_list',
    'mcp__claudeos__storage_delete'
  ];
}
