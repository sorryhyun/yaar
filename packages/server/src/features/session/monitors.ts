/**
 * Monitor operations extracted from session handler.
 *
 * Pure business logic — returns plain data objects, never VerbResult.
 */

import { DEFAULT_MONITOR_ID } from '@yaar/shared';
import type { LiveSession } from '../../session/live-session.js';
import type { ContextPool } from '../../agents/context-pool.js';

export interface MonitorSummary {
  monitorId: string;
  hasMonitorAgent: boolean;
  windowCount: number;
}

export interface MonitorStatus {
  monitorId: string;
  agent: {
    instanceId: string;
    busy: boolean;
    currentRole: string | null;
  } | null;
  suspended: boolean;
  windowCount: number;
  windows: { id: string; title: string | undefined }[];
}

export interface ControlResult {
  success: boolean;
  message: string;
}

/** List all monitors with basic stats. */
export function listMonitors(session: LiveSession, pool: ContextPool): MonitorSummary[] {
  const monitorIds = pool.getMonitorAgentIds();
  const allWindows = session.windowState.listWindows();

  const handleMap = session.windowState.handleMap;
  return monitorIds.map((id) => {
    const monitorHandles = new Set(handleMap.listByMonitor(id));
    const windowCount = allWindows.filter((w) => monitorHandles.has(w.id)).length;
    return {
      monitorId: id,
      hasMonitorAgent: pool.hasMonitorAgent(id),
      windowCount,
    };
  });
}

/** Get detailed status for a single monitor. Returns null if the monitor does not exist. */
export function getMonitorStatus(
  session: LiveSession,
  pool: ContextPool,
  monitorId: string,
): MonitorStatus | null {
  if (!pool.hasMonitorAgent(monitorId)) return null;

  const monitorHandles = new Set(session.windowState.handleMap.listByMonitor(monitorId));
  const allWindows = session.windowState.listWindows();
  const windows = allWindows.filter((w) => monitorHandles.has(w.id));

  const agentPool = pool.agentPool;
  const agent = agentPool.getMonitorAgent(monitorId);
  const isBusy = agentPool.isMonitorAgentBusy(monitorId);
  const isSuspended = pool.isMonitorSuspended(monitorId);

  return {
    monitorId,
    agent: agent
      ? {
          instanceId: agent.instanceId,
          busy: isBusy,
          currentRole: agent.currentRole,
        }
      : null,
    suspended: isSuspended,
    windowCount: windows.length,
    windows: windows.map((w) => ({ id: w.id, title: w.title })),
  };
}

/** Suspend, resume, or interrupt a monitor agent. */
export async function controlMonitor(
  pool: ContextPool,
  monitorId: string,
  action: 'suspend' | 'resume' | 'interrupt',
): Promise<ControlResult> {
  if (action === 'suspend') {
    const success = pool.suspendMonitor(monitorId);
    return success
      ? { success: true, message: `Monitor "${monitorId}" suspended.` }
      : { success: false, message: 'Failed to suspend.' };
  }

  if (action === 'resume') {
    const success = pool.resumeMonitor(monitorId);
    return success
      ? { success: true, message: `Monitor "${monitorId}" resumed.` }
      : { success: false, message: `Monitor "${monitorId}" is not suspended.` };
  }

  // interrupt
  const agent = pool.agentPool.getMonitorAgent(monitorId);
  if (!agent || !agent.session.isRunning()) {
    return { success: false, message: `Monitor "${monitorId}" is not running.` };
  }
  await agent.session.interrupt();
  return { success: true, message: `Monitor "${monitorId}" interrupted.` };
}

/**
 * Delete a monitor — the whole deletion, not just its agent.
 *
 * Deliberately routed through the session rather than the pool. Removing the agent alone
 * left the monitor in the session's authoritative list, so the frontend kept rendering the
 * desktop and the next message on it lazily minted a new agent; `MonitorRegistry.remove`
 * is the one place that also drops the id, detaches its watchers, clears its layout, and
 * broadcasts the new list. The registry answers "does this monitor exist", not the pool: a
 * monitor that has not been messaged yet has no agent and is still perfectly real.
 */
export async function disposeMonitor(
  session: LiveSession,
  monitorId: string,
): Promise<ControlResult> {
  if (monitorId === DEFAULT_MONITOR_ID) {
    return { success: false, message: `Monitor "${monitorId}" is the session's primary desktop.` };
  }
  if (!session.hasMonitor(monitorId)) {
    return { success: false, message: `Monitor "${monitorId}" not found.` };
  }
  await session.removeMonitor(monitorId);
  return { success: true, message: `Monitor "${monitorId}" deleted.` };
}
