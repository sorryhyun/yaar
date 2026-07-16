/**
 * Permission storage for remembering user decisions.
 *
 * Stores permission decisions (allow/deny) for tools with optional context.
 * Decisions are persisted to config/permissions.json.
 */

import { createPersistedStore } from './persisted-store.js';

/**
 * Permission decision types.
 */
export type PermissionDecision = 'allow' | 'deny' | 'ask';

/**
 * Stored permission entry.
 */
interface PermissionEntry {
  decision: PermissionDecision;
  timestamp: string;
  context?: string;
}

/**
 * Permissions file structure.
 * Key format: toolName or toolName:context
 */
interface PermissionsFile {
  [key: string]: PermissionEntry;
}

/**
 * Generate a key for the permissions map.
 */
function getPermissionKey(toolName: string, context?: string): string {
  return context ? `${toolName}:${context}` : toolName;
}

const store = createPersistedStore<PermissionsFile>('permissions.json', () => ({}));

/**
 * Check if there's a saved permission for a tool.
 *
 * @param toolName - The name of the tool
 * @param context - Optional context (e.g., specific resource)
 * @returns The saved decision, or null if none exists
 */
export async function checkPermission(
  toolName: string,
  context?: string
): Promise<PermissionDecision | null> {
  const permissions = await store.read();

  // First check for context-specific permission
  if (context) {
    const contextKey = getPermissionKey(toolName, context);
    const contextEntry = permissions[contextKey];
    if (contextEntry && contextEntry.decision !== 'ask') {
      return contextEntry.decision;
    }
  }

  // Fall back to tool-level permission
  const toolKey = getPermissionKey(toolName);
  const toolEntry = permissions[toolKey];
  if (toolEntry && toolEntry.decision !== 'ask') {
    return toolEntry.decision;
  }

  return null;
}

/**
 * Save a permission decision.
 *
 * @param toolName - The name of the tool
 * @param decision - The permission decision
 * @param context - Optional context (e.g., specific resource)
 */
export async function savePermission(
  toolName: string,
  decision: PermissionDecision,
  context?: string
): Promise<void> {
  const key = getPermissionKey(toolName, context);
  await store.update((permissions) => {
    permissions[key] = {
      decision,
      timestamp: new Date().toISOString(),
      ...(context && { context }),
    };
  });
}

/**
 * Clear a specific permission.
 *
 * @param toolName - The name of the tool
 * @param context - Optional context
 */
export async function clearPermission(
  toolName: string,
  context?: string
): Promise<void> {
  const key = getPermissionKey(toolName, context);
  await store.update((permissions) => {
    delete permissions[key];
  });
}

/**
 * Clear all saved permissions.
 */
export async function clearAllPermissions(): Promise<void> {
  await store.write({});
}
