/**
 * Remote Control domain handler — host `claude remote-control` so this machine can be
 * driven from claude.ai/code or the Claude mobile app.
 *
 *   read('yaar://system/remote-control')                          → state, session URL, terminal tail
 *   invoke('yaar://system/remote-control', { action:'start', … }) → user-confirmed spawn in a PTY
 *   invoke('yaar://system/remote-control', { action:'write', data }) → type into its terminal
 *   delete('yaar://system/remote-control')                        → stop it
 *
 * `start` returns once the process is spawned, before the CLI has printed its URL;
 * poll `read` until `state` is "ready". The remote session runs as a monitor agent on
 * the caller's monitor — it can do anything that agent can, for whoever holds the
 * claude.ai account — so `start` always asks the user first. The process itself lives
 * in features/remote-control/host.ts.
 */

import type { ResourceRegistry, VerbResult } from './uri-registry.js';
import { ok, okJson, error } from './utils.js';
import { defineActions } from './define-actions.js';
import { actionEmitter } from '../session/action-emitter.js';
import { getMonitorId, getSessionId } from '../agents/agent-context.js';
import {
  getRemoteControlStatus,
  prepareStart,
  PERMISSION_MODES,
  RemoteControlRequestError,
  SPAWN_MODES,
  startRemoteControl,
  stopRemoteControl,
  writeRemoteControl,
  type StartOptions,
} from '../features/remote-control/host.js';

type Payload = StartOptions & { data?: unknown };

const ACTIONS = defineActions<Payload>(
  {
    start: {
      description:
        'Start `claude remote-control` as a YAAR agent on your monitor, after the user confirms. ' +
        'Returns at spawn; poll `read` until `state` is "ready" and `sessionUrl` is set.',
      run: async (payload) => {
        const prepared = prepareStart(payload);
        const monitorId = getMonitorId() ?? '0';
        const approved = await actionEmitter.showPermissionDialog({
          title: 'Remote Control',
          message:
            'Start Claude Remote Control? Anyone signed in to your claude.ai account will be ' +
            `able to act as a YAAR agent on monitor ${monitorId} from a browser or phone.`,
          toolName: 'remote_control_start',
          context: monitorId,
          confirmText: 'Start',
        });
        if (!approved) return error('User denied starting Remote Control.');
        return okJson(await startRemoteControl(prepared, { sessionId: getSessionId(), monitorId }));
      },
    },
    write: {
      description:
        'Send `data` to the host terminal, verbatim — e.g. "\\r" to accept a prompt the tail ' +
        'shows it waiting on.',
      run: async (payload) => {
        if (typeof payload.data !== 'string') return error('Provide `data` as a string.');
        writeRemoteControl(payload.data);
        return ok('Sent.');
      },
    },
  },
  { describe: 'Start the host, or type into its terminal. Stop it with delete.' },
);

const INVOKE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: ACTIONS.schema,
    name: { type: 'string', description: 'start: session name shown in claude.ai/code.' },
    permissionMode: {
      type: 'string',
      enum: [...PERMISSION_MODES],
      description: 'start: permission mode for spawned sessions.',
    },
    spawn: {
      type: 'string',
      enum: [...SPAWN_MODES],
      description: 'start: spawn mode.',
    },
    continue: {
      type: 'boolean',
      description: 'start: reattach to the last Remote Control session (~4h window).',
    },
    data: { type: 'string', description: 'write: bytes to type into the terminal.' },
  },
  required: ['action'],
};

export function registerRemoteControlHandlers(registry: ResourceRegistry): void {
  registry.register('yaar://system/remote-control', {
    description:
      'Claude Remote Control hosted by YAAR: a `claude remote-control` process in a PTY whose ' +
      'sessions run as a YAAR agent on the starting monitor, driven from claude.ai/code or the ' +
      'Claude mobile app. Read for its ' +
      'state, the session URL and the terminal tail; invoke to start it or answer a prompt; ' +
      'delete to stop it.',
    verbs: ['describe', 'read', 'invoke', 'delete'],
    invokeSchema: INVOKE_SCHEMA,

    async read(): Promise<VerbResult> {
      return okJson(getRemoteControlStatus());
    },

    async invoke(_resolved, payload): Promise<VerbResult> {
      const request = (payload ?? {}) as Payload & { action?: unknown };
      try {
        return await ACTIONS.dispatch(String(request.action ?? ''), request);
      } catch (err) {
        if (err instanceof RemoteControlRequestError) return error(err.message);
        throw err;
      }
    },

    async delete(): Promise<VerbResult> {
      const stopped = await stopRemoteControl();
      return ok(stopped ? 'Remote Control stopped.' : 'Remote Control was not running.');
    },
  });
}
