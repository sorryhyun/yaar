/**
 * Claude Remote Control — put a monitor agent's conversation on claude.ai, so it can be
 * driven from claude.ai/code or the Claude mobile app.
 *
 * It is not a second agent. The monitor agent's own CLI is bridged (the SDK's Remote
 * Control request), so claude.ai sees the desktop's conversation and talks to the agent
 * that holds it: a claude.ai message runs as a turn of that agent, and whatever it starts
 * — an app agent's `hook: "response"` answer, a relay — comes back to that same
 * conversation, where claude.ai can see it. See `ContextPool.enableRemoteControl`.
 *
 * One monitor at a time. Anyone signed in to the claude.ai account can then act as that
 * monitor agent, so `start` always asks the user first.
 *
 * Reached only through `/api/remote-control` (http/routes/remote-control.ts), by the
 * desktop and the bundled Remote Control app. There is deliberately no `yaar://` verb: the
 * agent's door is the app's `start` command, so turning it on always leaves a window on
 * screen that shows it is on. The confirm dialog below is the gate either way.
 */

import type { ContextPool } from '../agents/context-pool.js';
import { actionEmitter } from '../session/action-emitter.js';
import type { LiveSession } from '../session/live-session.js';

export interface RemoteControlStatus {
  running: boolean;
  state: 'ready' | null;
  /** The monitor whose agent is on claude.ai. */
  monitorId: string | null;
  sessionUrl: string | null;
  name: string | null;
}

export type StartOutcome =
  | { ok: true; status: RemoteControlStatus }
  | { ok: false; status: number; error: string };

export function remoteControlStatus(pool: ContextPool | null): RemoteControlStatus {
  const current = pool?.listRemoteControl()[0];
  return {
    running: !!current,
    state: current ? 'ready' : null,
    monitorId: current?.monitorId ?? null,
    sessionUrl: current?.sessionUrl ?? null,
    name: current?.name ?? null,
  };
}

/** Put `monitorId`'s agent on claude.ai, after the user confirms. */
export async function startRemoteControl(
  session: LiveSession,
  monitorId: string,
  name?: string,
): Promise<StartOutcome> {
  const pool = session.getPool();
  if (!pool) return { ok: false, status: 409, error: 'Session not initialized.' };

  const current = remoteControlStatus(pool);
  if (current.running) {
    return current.monitorId === monitorId
      ? { ok: true, status: current }
      : {
          ok: false,
          status: 409,
          error: `Remote Control is on for monitor ${current.monitorId}. Stop it before starting it here.`,
        };
  }

  const approved = await actionEmitter.showPermissionDialogToSession(session.sessionId, {
    title: 'Remote Control',
    message:
      'Start Claude Remote Control? Anyone signed in to your claude.ai account will be ' +
      `able to talk to the agent on monitor ${monitorId} from a browser or phone.`,
    toolName: 'remote_control_start',
    context: monitorId,
    confirmText: 'Start',
  });
  if (!approved) return { ok: false, status: 403, error: 'User denied starting Remote Control.' };

  try {
    await pool.enableRemoteControl(monitorId, name || `YAAR monitor ${monitorId}`);
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Could not start Remote Control: ${(err as Error).message}`,
    };
  }
  return { ok: true, status: remoteControlStatus(pool) };
}

/** Take whichever monitor is on claude.ai off it. False when nothing was running. */
export async function stopRemoteControl(pool: ContextPool | null): Promise<boolean> {
  const { running, monitorId } = remoteControlStatus(pool);
  if (!running || monitorId === null || !pool) return false;
  await pool.disableRemoteControl(monitorId);
  return true;
}
