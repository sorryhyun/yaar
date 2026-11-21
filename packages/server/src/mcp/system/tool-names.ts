/**
 * System-namespace tool names — a leaf module with no imports.
 *
 * Kept separate from `system/index.ts` because that barrel also exports
 * `registerReloadTools`, which drags in handlers → session → context-pool →
 * profiles. Profile modules only need the names, and importing them through the
 * barrel closed a cycle that threw "Cannot access 'SYSTEM_TOOL_NAMES' before
 * initialization" depending on which module the process loaded first.
 */

export const SYSTEM_TOOL_NAMES = ['mcp__system__reload_cached'] as const;

/**
 * The self-cache tool (`ENABLE_SELF_CACHE_MANAGEMENT=1`). Registered in two namespaces
 * because a monitor agent connects `system` and an app agent connects `app`; neither
 * connects the other's. Not in `SYSTEM_TOOL_NAMES`: that list is unconditional, and
 * this is added per turn (`agents/profiles/turn-options.ts`) only while the flag is on.
 */
export const REMOVE_CACHE_TOOL = 'remove_cache';
export const REMOVE_CACHE_TOOL_NAMES = {
  system: `mcp__system__${REMOVE_CACHE_TOOL}`,
  app: `mcp__app__${REMOVE_CACHE_TOOL}`,
} as const;
