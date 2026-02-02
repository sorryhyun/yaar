/**
 * Permission storage for remembering user decisions.
 *
 * Stores permission decisions (allow/deny) for tools with optional context.
 * Decisions are persisted to storage/permissions.json.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { getStorageDir } from './storage-manager.js';

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
 * Get the path to the permissions file.
 */
function getPermissionsPath(): string {
  return join(getStorageDir(), 'permissions.json');
}

/**
 * Generate a key for the permissions map.
 */
function getPermissionKey(toolName: string, context?: string): string {
  return context ? `${toolName}:${context}` : toolName;
}

/**
 * Load permissions from disk.
 */
async function loadPermissions(): Promise<PermissionsFile> {
  try {
    const content = await readFile(getPermissionsPath(), 'utf-8');
    return JSON.parse(content) as PermissionsFile;
  } catch {
    // File doesn't exist or is invalid, return empty
    return {};
  }
}

/**
 * Save permissions to disk.
 */
async function savePermissions(permissions: PermissionsFile): Promise<void> {
  const filePath = getPermissionsPath();
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(permissions, null, 2), 'utf-8');
}

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
  const permissions = await loadPermissions();

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
  const permissions = await loadPermissions();
  const key = getPermissionKey(toolName, context);

  permissions[key] = {
    decision,
    timestamp: new Date().toISOString(),
    ...(context && { context }),
  };

  await savePermissions(permissions);
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
  const permissions = await loadPermissions();
  const key = getPermissionKey(toolName, context);

  delete permissions[key];

  await savePermissions(permissions);
}

/**
 * Clear all saved permissions.
 */
export async function clearAllPermissions(): Promise<void> {
  await savePermissions({});
}
