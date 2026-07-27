/**
 * Window domain handlers for the verb layer.
 *
 * Maps window operations to the verb layer:
 *
 *   list('yaar://windows/')               → list all windows
 *   invoke('yaar://windows/', ...)        → create window (windowId auto-derived from payload)
 *   read('yaar://windows/{w}')            → view window content/metadata
 *   invoke('yaar://windows/{w}', ...)     → update, manage, app_query, app_command, app_eval, protocol_log, message
 *   delete('yaar://windows/{w}')          → close window
 */

import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri, ResolvedWindow } from './uri-resolve.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import {
  ok,
  okJsonResource,
  okLinks,
  error,
  getActiveSession,
  assertUri,
  requireAction,
} from './utils.js';
import { formatWindowFlags } from '../features/window/helpers.js';
import { handleCreate } from '../features/window/create.js';
import { handleUpdate } from '../features/window/update.js';
import { handleManage, handleGeometry } from '../features/window/manage.js';
import {
  handleAppQuery,
  handleAppCommand,
  handleAppEval,
} from '../features/window/app-protocol.js';
import { readLog } from '../features/window/protocol-log.js';
import {
  handleSubscribe,
  handleUnsubscribe,
  handleAppSubscribe,
} from '../features/window/subscribe.js';
import { getMonitorId, requireMonitorId } from '../agents/agent-context.js';
import { actionEmitter } from '../session/action-emitter.js';
import { genId } from '../lib/ids.js';
import { valueOf } from '../session/pending-store.js';
import { defineActions } from './define-actions.js';

function isWindowCollection(resolved: ResolvedUri): resolved is ResolvedWindow & { windowId: '' } {
  return resolved.kind === 'window' && (resolved as ResolvedWindow).windowId === '';
}

export function registerWindowHandlers(
  registry: ResourceRegistry,
  getWindowState: () => WindowStateRegistry,
): void {
  const listHandler: ResourceHandler = {
    description: 'List the open windows on your monitor.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      // The caller's monitor, not the session: an agent may only address windows on
      // the monitor it runs on, so listing another desktop's windows offers it URIs
      // that resolve to nothing. Outside a turn (no monitor in context) list them all.
      const windows = getWindowState().listWindows(getMonitorId());
      if (windows.length === 0) return okLinks([]);

      return okLinks(
        windows.map((win) => {
          const windowId = getWindowState().handleMap.getRawWindowId(win.id);
          const parts = [win.content.renderer, `${win.bounds.w}x${win.bounds.h}`];
          if (win.locked) parts.push('locked');
          if (win.minimized) parts.push('minimized');
          if (win.appId) parts.push(`app:${win.appId}`);
          return {
            uri: `yaar://windows/${windowId}`,
            name: win.title || windowId,
            description: parts.join(', '),
          };
        }),
      );
    },
  };
  registry.register('yaar://windows', listHandler);

  // The window actions. The `enum` the model sees is derived from these keys
  // (see invokeSchema below), so a case cannot exist undeclared and a declaration
  // cannot exist without a case.
  const windowActions = defineActions<{ windowId: string; p: Record<string, unknown> }>({
    create: ({ windowId, p }) => handleCreate(windowId, p),
    update: ({ windowId, p }) => handleUpdate(getWindowState(), windowId, p),
    close: ({ windowId }) => handleManage(getWindowState(), windowId, 'close'),
    lock: ({ windowId }) => handleManage(getWindowState(), windowId, 'lock'),
    unlock: ({ windowId }) => handleManage(getWindowState(), windowId, 'unlock'),
    move: ({ windowId, p }) => handleGeometry(getWindowState(), windowId, 'move', p),
    resize: ({ windowId, p }) => handleGeometry(getWindowState(), windowId, 'resize', p),
    app_query: ({ windowId, p }) => handleAppQuery(getWindowState(), windowId, p),
    app_command: ({ windowId, p }) => handleAppCommand(getWindowState(), windowId, p),
    app_eval: ({ windowId, p }) => handleAppEval(getWindowState(), windowId, p),
    protocol_log: ({ windowId, p }) => {
      // Address by the monitor-scoped key, as app_query/app_command do — the log is
      // keyed the same way.
      const win = getWindowState().getWindow(windowId);
      if (!win) return error(`Window "${windowId}" not found.`);
      const limit = typeof p.limit === 'number' ? p.limit : undefined;
      return ok(JSON.stringify(readLog({ windowKey: win.id, limit }), null, 2));
    },
    message: ({ windowId, p }) => {
      const appId = getWindowState().getAppIdForWindow(windowId);
      if (!appId) return error(`Window "${windowId}" is not an app window.`);
      if (typeof p.message !== 'string' || !p.message)
        return error('"message" (string) is required for message action.');

      const session = getActiveSession();
      const pool = session.getPool();
      if (!pool) return error('Session not initialized.');

      const messageId = genId('agent-msg');
      const monitorId = requireMonitorId();
      const taggedContent = `<monitor:${monitorId}>\n${p.message}\n</monitor:${monitorId}>`;
      const hook = p.hook === 'response' ? ('response' as const) : undefined;
      pool
        .handleTask({
          type: 'app',
          messageId,
          windowId,
          content: taggedContent,
          monitorId,
          hook,
        })
        .catch((err: unknown) => console.error('[window.message] Failed:', err));

      return ok(
        `Message sent to app "${appId}" via window "${windowId}" (messageId: ${messageId}).`,
      );
    },
    subscribe: ({ windowId, p }) => handleSubscribe(getWindowState(), windowId, p),
    unsubscribe: ({ p }) => handleUnsubscribe(p),
    app_subscribe: ({ windowId, p }) => handleAppSubscribe(getWindowState(), windowId, p),
    app_unsubscribe: ({ p }) => handleUnsubscribe(p),
  });

  // ── yaar://windows/{windowId} — window operations ──
  const windowHandler: ResourceHandler = {
    description:
      'Window resource. Use yaar://windows/{windowId} to address windows (monitor is automatic). ' +
      'Invoke to create (on bare yaar://windows/), update, manage; read to view content; delete to close. ' +
      'Invoke actions: create, update (requires operation), close, lock, unlock, move (x, y), resize (width, height), app_query, app_command, app_eval (devtools previews only), protocol_log, message.',
    verbs: ['describe', 'list', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: windowActions.schema,
        // create fields
        title: { type: 'string' },
        renderer: {
          type: 'string',
          enum: ['markdown', 'html', 'text', 'table', 'iframe', 'component'],
        },
        content: {},
        x: {
          type: 'number',
          description:
            'Optional. Omit both x and y (the normal case) to get centered, cascaded placement that avoids burying existing windows. Only set these to position a window deliberately.',
        },
        y: { type: 'number', description: 'Optional. See x — omit unless positioning on purpose.' },
        width: {
          type: 'number',
          description: 'Optional. Defaults to 640, or the app’s declared defaultWidth.',
        },
        height: {
          type: 'number',
          description: 'Optional. Defaults to 480, or the app’s declared defaultHeight.',
        },
        minimized: { type: 'boolean' },
        jsonfile: { type: 'string' },
        // update fields
        operation: {
          type: 'string',
          enum: ['append', 'prepend', 'replace', 'insertAt', 'clear'],
          description: 'Required for "update" action.',
        },
        position: { type: 'number' },
        // app_command fields
        command: { type: 'string' },
        params: { type: 'object' },
        stateKey: { type: 'string' },
        // app_eval fields
        expression: {
          type: 'string',
          description:
            'app_eval only. JS expression evaluated in the iframe. Devtools preview ' +
            'windows only — refused elsewhere. Result is JSON-serialized, capped at 16KB.',
        },
        timeoutMs: {
          type: 'number',
          description:
            'app_command and app_eval. How long to wait for the app (max 180s; default 30s ' +
            'for app_command, 5s for app_eval). Raise it for slow commands like compile or ' +
            'deploy, and for an expression that awaits a promise or sleeps.',
        },
        // protocol_log fields
        limit: {
          type: 'number',
          description: 'protocol_log only. Max entries to return, newest last (default 100).',
        },
        // message fields
        message: {
          type: 'string',
          description: 'Message to send to the app agent (for message action)',
        },
        // subscribe fields
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['content', 'interaction', 'close', 'lock', 'unlock', 'move', 'resize', 'title'],
          },
          description: 'Event types to subscribe to (default: content, interaction, close).',
        },
        debounceMs: { type: 'number', description: 'Debounce interval in ms (default: 500).' },
        subscriptionId: { type: 'string', description: 'Subscription ID for unsubscribe.' },
        // app_subscribe fields (declarative app event channels)
        channels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'App event channels to subscribe to (app_subscribe). Use ["*"] for all declared channels. Discover channels via app_query manifest "events".',
        },
        mode: {
          type: 'string',
          enum: ['wake', 'buffer'],
          description:
            'app_subscribe delivery: "wake" (default, notify agent when event fires) or "buffer" (fold into next turn).',
        },
        hook: {
          type: 'string',
          enum: ['response'],
          description: 'Set to "response" to receive a notification when the app agent responds.',
        },
      },
    },

    async list(): Promise<VerbResult> {
      return listHandler.list!({} as ResolvedUri);
    },

    async read(resolved: ResolvedUri): Promise<VerbResult> {
      // Collection-level: yaar://windows/ (bare, no windowId)
      if (isWindowCollection(resolved)) {
        const session = getActiveSession();
        const pool = session.getPool();
        if (!pool) return error('Session not initialized.');

        const monitorId = requireMonitorId();
        const stats = pool.getStats();
        const monitorHandles = new Set(getWindowState().handleMap.listByMonitor(monitorId));
        const windows = getWindowState()
          .listWindows()
          .filter((w) => monitorHandles.has(w.id));

        return okJsonResource('yaar://windows/', {
          monitorId,
          hasMonitorAgent: pool.hasMonitorAgent(monitorId),
          windows: windows.map((w) => ({
            id: w.id,
            title: w.title,
          })),
          stats: {
            totalAgents: stats.totalAgents,
            monitorQueueSize: stats.monitorQueueSize,
          },
        });
      }

      // Window resource: yaar://windows/{windowId}
      assertUri(resolved, 'window');
      const win = getWindowState().getWindow(resolved.windowId);
      if (!win) {
        return error(`Window "${resolved.windowId}" not found. Use list to see available windows.`);
      }

      const windowInfo: Record<string, unknown> & { captureFailure?: string } = {
        id: win.id,
        title: win.title,
        renderer: win.content.renderer,
        content: win.content.data,
        position: { x: win.bounds.x, y: win.bounds.y },
        size: { width: win.bounds.w, height: win.bounds.h },
        locked: win.locked,
        lockedBy: win.lockedBy,
        ...formatWindowFlags(win),
      };

      // For iframe windows, capture a screenshot so the agent can see what's rendered.
      //
      // This used to be skipped for iframe-SDK reads (agentId `iframe:*`, e.g. devtools'
      // viewPreview) because such a read carries no monitor of its own, so the capture went
      // out unaddressed and its feedback never came back — leaving the one tool that builds
      // a window as the only tool that could not look at it. But the caller's monitor was
      // never the right one to ask: the window's own monitor is. Address the window by its
      // resolved, monitor-scoped key and deliver the capture there, exactly as handleAppQuery
      // does. The image itself already survives the trip — POST /api/verb lifts image blocks
      // into `envelope.images` and the iframe SDK hands them back (verb-sdk.ts).
      if (win.content.renderer === 'iframe') {
        const outcome = await actionEmitter.emitActionWithFeedback(
          { type: 'window.capture', windowId: win.id },
          5000,
          undefined,
          getWindowState().getMonitorForWindow(win.id),
        );
        const feedback = valueOf(outcome);
        if (feedback?.success && feedback.imageData) {
          // Omit raw content (compiled HTML blob) — the screenshot is more useful
          const { content: _content, ...infoWithoutContent } = windowInfo;
          return {
            content: [
              {
                type: 'resource',
                resource: {
                  uri: resolved.sourceUri,
                  text: JSON.stringify(infoWithoutContent, null, 2),
                  mimeType: 'application/json',
                },
              },
              { type: 'image', data: feedback.imageData, mimeType: 'image/webp' },
            ],
          };
        }
        // No image. Say why, in the metadata the caller gets anyway: a capture that
        // failed because the canvas was tainted is unfixable by retrying, and one
        // that timed out may well succeed on the next call. Reported as the same
        // empty result, both looked like "it may not have painted yet".
        if (feedback?.captureFailure) {
          windowInfo.captureFailure = feedback.captureFailure;
        }
      }

      return okJsonResource(resolved.sourceUri, windowInfo);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;

      // payload is guaranteed non-undefined after requireAction
      const p = payload!;
      const action = p.action as string;

      // Collection-level invoke: only create (windowId derived from payload)
      if (isWindowCollection(resolved)) {
        if (action === 'create') return handleCreate('', p);
        return error(
          `Action "${action}" requires a window URI (yaar://windows/{windowId}). ` +
            'Only "create" can be invoked on a bare windows URI.',
        );
      }

      assertUri(resolved, 'window');
      return windowActions.dispatch(action, { windowId: resolved.windowId, p });
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'window');
      return handleManage(getWindowState(), resolved.windowId, 'close');
    },
  };
  registry.register('yaar://windows/*', windowHandler);
}
