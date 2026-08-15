/**
 * Hook storage — reads/writes config/hooks.json.
 *
 * Hooks are event-driven config entries that fire interactions
 * or commands on specific triggers (e.g., session launch).
 */

import type { OSAction } from '@yaar/shared';
import { configRead, configWrite } from '../../storage/storage-manager.js';
import type { HookSchedule } from './hook-schedule.js';

export type HookAction =
  | { type: 'interaction'; payload: string }
  | { type: 'os_action'; payload: OSAction | OSAction[] };

export interface HookFilter {
  /** Verb filter: 'invoke', 'read', 'list', 'delete'. */
  verb?: string | string[];
  /** URI prefix/glob pattern: 'yaar://storage/*', 'yaar://apps/my-app'. */
  uri?: string | string[];
  /** Payload action filter: 'compile', 'deploy', 'write', etc. */
  action?: string | string[];
  /** Non-verb tool name filter: 'WebSearch', etc. */
  toolName?: string | string[];
}

export interface Hook {
  id: string;
  event: string;
  filter?: HookFilter;
  /** When this hook fires, for `schedule` hooks. See `hook-schedule.ts`. */
  schedule?: HookSchedule;
  /** Which desktop a `schedule` hook acts on. Defaults to the first monitor. */
  monitorId?: string;
  action: HookAction;
  label: string;
  enabled: boolean;
  createdAt: string;
  /**
   * The occurrence this hook last fired for — the scheduled slot, not the moment the
   * tick noticed it. Persisted so a restart neither re-fires a daily hook at every
   * boot nor replays the ones it slept through. See `hook-schedule.ts`.
   */
  lastRunAt?: string;
}

/** Fields only some events carry, kept out of `addHook`'s positional arguments. */
export interface HookExtras {
  schedule?: HookSchedule;
  monitorId?: string;
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
  extras?: HookExtras,
): Promise<Hook> {
  const data = await loadHooksFile();
  data.idCounter += 1;

  const hook: Hook = {
    id: `hook-${data.idCounter}`,
    event,
    ...(filter && { filter }),
    ...(extras?.schedule && { schedule: extras.schedule }),
    ...(extras?.monitorId && { monitorId: extras.monitorId }),
    action,
    label,
    enabled: true,
    createdAt: new Date().toISOString(),
  };

  data.hooks.push(hook);
  await saveHooksFile(data);
  return hook;
}

/**
 * Record that a hook fired for the occurrence `slot`.
 *
 * Written through `saveHooksFile` rather than mutating the cache in place, because the
 * scheduler is the one hook consumer that has to survive a restart: a `lastRunAt` that
 * lives only in memory would replay every schedule hook on the next boot.
 */
export async function markHookRun(hookId: string, slot: Date): Promise<void> {
  const data = await loadHooksFile();
  const hook = data.hooks.find((h) => h.id === hookId);
  if (!hook) return;
  hook.lastRunAt = slot.toISOString();
  await saveHooksFile(data);
}

/** Check if a value matches a single-or-array filter. */
function matchesFilter(value: string, filter: string | string[]): boolean {
  const patterns = Array.isArray(filter) ? filter : [filter];
  return patterns.some((p) => {
    // Support trailing wildcard: 'yaar://storage/*' matches 'yaar://storage/docs/readme.md'
    if (p.endsWith('/*')) {
      const prefix = p.slice(0, -1); // 'yaar://storage/'
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

    if (f.toolName && !matchesFilter(ctx.toolName, f.toolName)) return false;
    if (f.verb && (!ctx.verb || !matchesFilter(ctx.verb, f.verb))) return false;
    if (f.uri && (!ctx.uri || !matchesFilter(ctx.uri, f.uri))) return false;
    if (f.action && (!ctx.action || !matchesFilter(ctx.action, f.action))) return false;
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
