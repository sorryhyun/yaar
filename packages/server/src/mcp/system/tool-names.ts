/**
 * System-namespace tool names — a leaf module with no imports.
 *
 * Kept separate from `system/index.ts` because that barrel also exports
 * `registerReloadTools`, which drags in handlers → session → context-pool →
 * profiles. Profile modules only need the names, and importing them through the
 * barrel closed a cycle that threw "Cannot access 'SYSTEM_TOOL_NAMES' before
 * initialization" depending on which module the process loaded first.
 */

export const SYSTEM_TOOL_NAMES = [
  'mcp__system__reload_cached',
  'mcp__system__list_reload_options',
] as const;
