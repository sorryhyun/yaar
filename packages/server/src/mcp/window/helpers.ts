/**
 * Shared helpers for MCP window tools.
 */

import { buildWindowUri } from '@yaar/shared';
import { getAgentId, getMonitorId } from '../../agents/session.js';
import type { WindowStateRegistry } from '../window-state.js';
import { error } from '../utils.js';

/** Format a window identifier for tool feedback — full URI when monitor context is available. */
export function formatWindowRef(windowId: string): string {
  const monitorId = getMonitorId();
  return monitorId ? buildWindowUri(monitorId, windowId) : windowId;
}

/**
 * Check that a window exists and is not locked by another agent.
 * Returns an error response if the check fails, or null if the window is accessible.
 */
export function checkWindowAccess(
  windowState: WindowStateRegistry,
  windowId: string,
): ReturnType<typeof error> | null {
  if (!windowState.hasWindow(windowId)) {
    return error(
      `Window "${windowId}" does not exist. It may have been removed by a reset. Use list to see available windows, or create a new one.`,
    );
  }

  const lockedBy = windowState.isLockedByOther(windowId, getAgentId());
  if (lockedBy) {
    return error(
      `Window "${windowId}" is locked by agent "${lockedBy}". Cannot update until unlocked.`,
    );
  }

  return null;
}
