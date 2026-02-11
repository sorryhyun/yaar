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
  toolName?: string | string[];
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

async function loadHooksFile(): Promise<HooksFile> {
  const result = await configRead(HOOKS_PATH);
  if (result.success && result.content) {
    try {
      return JSON.parse(result.content) as HooksFile;
    } catch {
      // Corrupted file, start fresh
    }
  }
  return { hooks: [], idCounter: 0 };
}

async function saveHooksFile(data: HooksFile): Promise<void> {
  await configWrite(HOOKS_PATH, JSON.stringify(data, null, 2));
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

/**
 * Get enabled tool_use hooks that match a given tool name.
 */
export async function getToolUseHooks(toolName: string): Promise<Hook[]> {
  const hooks = await getHooksByEvent('tool_use');
  return hooks.filter((h) => {
    if (!h.filter?.toolName) return true;
    const names = Array.isArray(h.filter.toolName) ? h.filter.toolName : [h.filter.toolName];
    return names.includes(toolName);
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
