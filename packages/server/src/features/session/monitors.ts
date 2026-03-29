/**
 * Monitor operations extracted from session handler.
 *
 * Pure business logic — returns plain data objects, never VerbResult.
 */

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

/** Dispose a monitor agent and clean up its resources. */
export async function disposeMonitor(pool: ContextPool, monitorId: string): Promise<void> {
  await pool.removeMonitorAgent(monitorId);
}
