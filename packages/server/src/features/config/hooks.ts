/**
 * Hook storage — reads/writes config/hooks.json.
 *
 * Hooks are event-driven config entries that fire interactions
 * or commands on specific triggers (e.g., session launch).
 */

import type { OSAction } from '@yaar/shared';
import { configRead, configWrite } from '../../storage/storage-manager.js';

export type HookAction =
  | { type: 'interaction'; payload: string }
  | { type: 'os_action'; payload: OSAction | OSAction[] };

export interface HookFilter {
  /** Legacy tool name filter (for non-verb tools like web_search). */
  toolName?: string | string[];
  /** Verb filter: 'invoke', 'read', 'list', 'delete'. */
  verb?: string | string[];
  /** URI prefix/glob pattern: 'yaar://sandbox/*', 'yaar://apps/my-app'. */
  uri?: string | string[];
  /** Payload action filter: 'compile', 'deploy', 'write', etc. */
  action?: string | string[];
}

export interface Hook {
  id: string;
  event: string;
  filter?: HookFilter;
  action: HookAction;
  label: string;
  enabled: boolean;
  createdAt: string;
}

interface HooksFile {
  hooks: Hook[];
  idCounter: number;
}

const HOOKS_PATH = 'hooks.json';

let cachedHooksFile: HooksFile | null = null;

async function loadHooksFile(): Promise<HooksFile> {
  if (cachedHooksFile) return cachedHooksFile;

  const result = await configRead(HOOKS_PATH);
  if (result.success && result.content) {
    try {
      cachedHooksFile = JSON.parse(result.content) as HooksFile;
      return cachedHooksFile;
    } catch {
      // Corrupted file, start fresh
    }
  }
  cachedHooksFile = { hooks: [], idCounter: 0 };
  return cachedHooksFile;
}

async function saveHooksFile(data: HooksFile): Promise<void> {
  await configWrite(HOOKS_PATH, JSON.stringify(data, null, 2));
  cachedHooksFile = data;
}

/** Reset the in-memory cache (for testing). */
export function _resetHooksCache(): void {
  cachedHooksFile = null;
}

/**
 * Load all hooks.
 */
export async function loadHooks(): Promise<Hook[]> {
  const data = await loadHooksFile();
  return data.hooks;
}

/**
 * Get hooks filtered by event type.
 */
export async function getHooksByEvent(event: string): Promise<Hook[]> {
  const hooks = await loadHooks();
  return hooks.filter((h) => h.event === event && h.enabled);
}

/**
 * Add a new hook. Returns the created hook.
 */
export async function addHook(
  event: string,
  action: HookAction,
  label: string,
  filter?: HookFilter,
): Promise<Hook> {
  const data = await loadHooksFile();
  data.idCounter += 1;

  const hook: Hook = {
    id: `hook-${data.idCounter}`,
    event,
    ...(filter && { filter }),
    action,
    label,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  data.hooks.push(hook);
  await saveHooksFile(data);
  return hook;
}

/** Check if a value matches a single-or-array filter. */
function matchesFilter(value: string, filter: string | string[]): boolean {
  const patterns = Array.isArray(filter) ? filter : [filter];
  return patterns.some((p) => {
    // Support trailing wildcard: 'yaar://sandbox/*' matches 'yaar://sandbox/abc/file.ts'
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -1); // 'yaar://sandbox/'
      return value.startsWith(prefix) || value === p.slice(0, -2); // exact base match too
    }
    return value === p;
  });
}

export interface ToolUseContext {
  toolName: string;
  verb?: string;
  uri?: string;
  action?: string;
}

/**
 * Get enabled tool_use hooks that match a given tool use context.
 *
 * For verb tools (invoke/read/list/delete), pass verb + uri + action.
 * For non-verb tools (web_search, etc.), pass just toolName.
 */
export async function getToolUseHooks(ctx: ToolUseContext): Promise<Hook[]> {
  const hooks = await getHooksByEvent('tool_use');
  return hooks.filter((h) => {
    const f = h.filter;
    if (!f) return true; // no filter = matches everything

    // If hook has verb/uri/action filters, use those (verb-style matching)
    if (f.verb || f.uri || f.action) {
      if (f.verb && (!ctx.verb || !matchesFilter(ctx.verb, f.verb))) return false;
      if (f.uri && (!ctx.uri || !matchesFilter(ctx.uri, f.uri))) return false;
      if (f.action && (!ctx.action || !matchesFilter(ctx.action, f.action))) return false;
      return true;
    }

    // Legacy: toolName-based matching
    if (f.toolName) {
      return matchesFilter(ctx.toolName, f.toolName);
    }

    return true;
  });
}

/**
 * Remove a hook by ID. Returns true if found and removed.
 */
export async function removeHook(hookId: string): Promise<boolean> {
  const data = await loadHooksFile();
  const idx = data.hooks.findIndex((h) => h.id === hookId);
  if (idx === -1) return false;

  data.hooks.splice(idx, 1);
  await saveHooksFile(data);
  return true;
}
