/**
 * Window domain handlers for the verb layer.
 *
 * Maps window operations to the verb layer:
 *
 *   list('yaar://windows/')               → list all windows
 *   invoke('yaar://windows/', ...)        → create window (windowId auto-derived from payload)
 *   read('yaar://windows/{w}')            → view window content/metadata
 *   invoke('yaar://windows/{w}', ...)     → update, manage, app_query, app_command, message
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
import { handleManage } from '../features/window/manage.js';
import { handleAppQuery, handleAppCommand } from '../features/window/app-protocol.js';
import { handleSubscribe, handleUnsubscribe } from '../features/window/subscribe.js';
import { getMonitorId } from '../agents/agent-context.js';
import { actionEmitter } from '../session/action-emitter.js';

function isWindowCollection(resolved: ResolvedUri): resolved is ResolvedWindow & { windowId: '' } {
  return resolved.kind === 'window' && (resolved as ResolvedWindow).windowId === '';
}

export function registerWindowHandlers(
  registry: ResourceRegistry,
  getWindowState: () => WindowStateRegistry,
): void {
  const listHandler: ResourceHandler = {
    description: 'List all open windows.',
    verbs: ['describe', 'list'],

    async list(): Promise<VerbResult> {
      const windows = getWindowState().listWindows();
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

  // ── yaar://windows/{windowId} — window operations ──
  const windowHandler: ResourceHandler = {
    description:
      'Window resource. Use yaar://windows/{windowId} to address windows (monitor is automatic). ' +
      'Invoke to create (on bare yaar://windows/), update, manage; read to view content; delete to close. ' +
      'Invoke actions: create, update (requires operation), close, lock, unlock, app_query, app_command, message.',
    verbs: ['describe', 'list', 'read', 'invoke', 'delete'],
    invokeSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'update',
            'close',
            'lock',
            'unlock',
            'app_query',
            'app_command',
            'message',
            'subscribe',
            'unsubscribe',
          ],
        },
        // create fields
        title: { type: 'string' },
        renderer: {
          type: 'string',
          enum: ['markdown', 'html', 'text', 'table', 'iframe', 'component'],
        },
        content: {},
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
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

        const monitorId = getMonitorId() ?? '0';
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

      const windowInfo = {
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

      // For iframe windows, capture a screenshot so the agent can see what's rendered
      if (win.content.renderer === 'iframe') {
        const feedback = await actionEmitter.emitActionWithFeedback(
          { type: 'window.capture', windowId: resolved.windowId },
          5000,
        );
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
      const windowId = resolved.windowId;

      switch (action) {
        case 'create':
          return handleCreate(windowId, p);
        case 'update':
          return handleUpdate(getWindowState(), windowId, p);
        case 'close':
          return handleManage(getWindowState(), windowId, 'close');
        case 'lock':
          return handleManage(getWindowState(), windowId, 'lock');
        case 'unlock':
          return handleManage(getWindowState(), windowId, 'unlock');
        case 'app_query':
          return handleAppQuery(getWindowState(), windowId, p);
        case 'app_command':
          return handleAppCommand(getWindowState(), windowId, p);
        case 'message': {
          const appId = getWindowState().getAppIdForWindow(windowId);
          if (!appId) return error(`Window "${windowId}" is not an app window.`);
          if (typeof p.message !== 'string' || !p.message)
            return error('"message" (string) is required for message action.');

          const session = getActiveSession();
          const pool = session.getPool();
          if (!pool) return error('Session not initialized.');

          const messageId = `agent-msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          const monitorId = getMonitorId() ?? '0';
          const taggedContent = `<monitor:${monitorId}>\n${p.message as string}\n</monitor:${monitorId}>`;
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
        }
        case 'subscribe':
          return handleSubscribe(getWindowState(), windowId, p);
        case 'unsubscribe':
          return handleUnsubscribe(p);
        default:
          return error(`Unknown action "${action}".`);
      }
    },

    async delete(resolved: ResolvedUri): Promise<VerbResult> {
      assertUri(resolved, 'window');
      return handleManage(getWindowState(), resolved.windowId, 'close');
    },
  };
  registry.register('yaar://windows/*', windowHandler);
}
