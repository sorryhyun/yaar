/**
 * Remote Control domain handler — put a monitor agent's conversation on claude.ai, so it
 * can be driven from claude.ai/code or the Claude mobile app.
 *
 *   read('yaar://system/remote-control')                    → running, monitorId, sessionUrl
 *   invoke('yaar://system/remote-control', { action:'start', name? }) → user-confirmed
 *   delete('yaar://system/remote-control')                  → take it off claude.ai
 *
 * It is not a second agent. The monitor agent's own CLI is bridged (the SDK's Remote
 * Control request), so claude.ai sees the desktop's conversation and talks to the agent
 * that holds it: a claude.ai message runs as a turn of that agent, and whatever it starts
 * — an app agent's `hook: "response"` answer, a relay — comes back to that same
 * conversation, where claude.ai can see it. See `ContextPool.enableRemoteControl`.
 *
 * One monitor at a time, the one the caller is on. Anyone signed in to the claude.ai
 * account can then act as that monitor agent, so `start` always asks the user first.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import { ok, okJson, error, getActivePool } from './utils.js';
import { defineActions } from './define-actions.js';
import { actionEmitter } from '../session/action-emitter.js';
import { getMonitorId } from '../agents/agent-context.js';
import { subscriptionRegistry } from '../http/subscriptions.js';

export const REMOTE_CONTROL_URI = 'yaar://system/remote-control';

interface Payload {
  name?: unknown;
}

function status() {
  const bridged = getActivePool()?.listRemoteControl() ?? [];
  const current = bridged[0];
  return {
    running: !!current,
    state: current ? ('ready' as const) : null,
    /** The monitor whose agent is on claude.ai. */
    monitorId: current?.monitorId ?? null,
    sessionUrl: current?.sessionUrl ?? null,
    name: current?.name ?? null,
  };
}

const ACTIONS = defineActions<Payload>(
  {
    start: {
      description:
        "Put your monitor's agent on claude.ai, after the user confirms. Returns the " +
        '`sessionUrl` to open in claude.ai/code or the Claude app.',
      run: async (payload) => {
        const pool = getActivePool();
        if (!pool) return error('Session not initialized.');
        const monitorId = getMonitorId() ?? '0';
        const current = status();
        if (current.running) {
          return current.monitorId === monitorId
            ? okJson(current)
            : error(
                `Remote Control is on for monitor ${current.monitorId}. Stop it before ` +
                  `starting it here.`,
              );
        }
        const approved = await actionEmitter.showPermissionDialog({
          title: 'Remote Control',
          message:
            'Start Claude Remote Control? Anyone signed in to your claude.ai account will be ' +
            `able to talk to the agent on monitor ${monitorId} from a browser or phone.`,
          toolName: 'remote_control_start',
          context: monitorId,
          confirmText: 'Start',
        });
        if (!approved) return error('User denied starting Remote Control.');

        const name = typeof payload.name === 'string' && payload.name ? payload.name : undefined;
        try {
          await pool.enableRemoteControl(monitorId, name ?? `YAAR monitor ${monitorId}`);
        } catch (err) {
          return error(`Could not start Remote Control: ${(err as Error).message}`);
        }
        subscriptionRegistry.notifyChange(REMOTE_CONTROL_URI);
        return okJson(status());
      },
    },
  },
  { describe: 'Start Remote Control on your monitor. Stop it with delete.' },
);

const INVOKE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: ACTIONS.schema,
    name: { type: 'string', description: 'start: session name shown in claude.ai/code.' },
  },
  required: ['action'],
};

export function registerRemoteControlHandlers(registry: ResourceRegistry): void {
  registry.register(REMOTE_CONTROL_URI, {
    description:
      "Claude Remote Control: a monitor agent's conversation, put on claude.ai so it can be " +
      'driven from claude.ai/code or the Claude mobile app. Read for whether it is on, the ' +
      'monitor and the session URL; invoke to start it; delete to stop it.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: INVOKE_SCHEMA,

    async read(): Promise<VerbResult> {
      // The caller's own monitor beside the bridged one, so an app window can tell "on
      // here" from "on another monitor" — it has no other way to learn its monitor.
      return okJson({ ...status(), callerMonitorId: getMonitorId() ?? null });
    },

    async invoke(_resolved, payload): Promise<VerbResult> {
      const request = (payload ?? {}) as Payload & { action?: unknown };
      return ACTIONS.dispatch(String(request.action ?? ''), request);
    },

    async delete(): Promise<VerbResult> {
      const { running, monitorId } = status();
      if (!running || monitorId === null) return ok('Remote Control was not running.');
      await getActivePool()?.disableRemoteControl(monitorId);
      subscriptionRegistry.notifyChange(REMOTE_CONTROL_URI);
      return ok('Remote Control stopped.');
    },
  });
}
