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
    // System tools
    'mcp__claudeos__get_system_time',
    'mcp__claudeos__calculate',
    'mcp__claudeos__get_system_info',
    'mcp__claudeos__get_env_var',
    'mcp__claudeos__generate_random',
    // Window tools
    'mcp__claudeos__show_window',
    'mcp__claudeos__close_window',
    'mcp__claudeos__show_toast',
    // Storage tools
    'mcp__claudeos__storage_read',
    'mcp__claudeos__storage_write',
    'mcp__claudeos__storage_list',
    'mcp__claudeos__storage_delete'
  ];
}
