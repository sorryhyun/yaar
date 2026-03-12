/**
 * Always-on system-namespace MCP tools (active in both verb and legacy modes).
 *
 * - Reload: reload_cached, list_reload_options
 */

export { registerReloadTools } from './reload.js';

export const SYSTEM_TOOL_NAMES = [
  'mcp__system__reload_cached',
  'mcp__system__list_reload_options',
] as const;
