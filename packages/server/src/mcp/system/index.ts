/**
 * Always-on system-namespace MCP tools (active in both verb and legacy modes).
 *
 * - Reload: reload_cached, list_reload_options
 * - Wait: wait (bounded, abortable sleep)
 */

export { registerReloadTools } from './reload.js';
export { registerWaitTool } from './wait.js';

export { SYSTEM_TOOL_NAMES } from './tool-names.js';
