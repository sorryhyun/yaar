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

import { parseWindowKey } from '@yaar/shared';
import type { ResourceRegistry, VerbResult, ResourceHandler } from './uri-registry.js';
import type { ResolvedUri, ResolvedWindow } from './uri-resolve.js';
import type { WindowStateRegistry } from '../session/window-state.js';
import { ok, okJson, error, getActiveSession, assertUri, requireAction } from './utils.js';
import { formatWindowFlags } from '../features/window/helpers.js';
import { handleCreate } from '../features/window/create.js';
import { handleUpdate } from '../features/window/update.js';
import { handleManage } from '../features/window/manage.js';
import { handleAppQuery, handleAppCommand } from '../features/window/app-protocol.js';
import { handleSubscribe, handleUnsubscribe } from '../features/window/subscribe.js';
import { getMonitorId } from '../agents/session.js';

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
      if (windows.length === 0) return okJson([]);

      const windowList = windows.map((win) => {
        const parsed = parseWindowKey(win.id);
        const windowId = parsed?.windowId ?? win.id;
        return {
          id: windowId,
          uri: `yaar://windows/${windowId}`,
          title: win.title,
          position: `(${win.bounds.x}, ${win.bounds.y})`,
          size: `${win.bounds.w}x${win.bounds.h}`,
          renderer: win.content.renderer,
          locked: win.locked,
          lockedBy: win.lockedBy,
          ...formatWindowFlags(win),
        };
      });

      return okJson(windowList);
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
        appId: { type: 'string' },
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

        const monitorId = resolved.monitorId;
        const stats = pool.getStats();
        const windows = getWindowState()
          .listWindows()
          .filter((w) => {
            const parsed = parseWindowKey(w.id);
            return parsed?.monitorId === monitorId;
          });

        return okJson({
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

      return okJson(windowInfo);
    },

    async invoke(resolved: ResolvedUri, payload?: Record<string, unknown>): Promise<VerbResult> {
      const actionErr = requireAction(payload);
      if (actionErr) return actionErr;

      // payload is guaranteed non-undefined after requireAction
      const p = payload!;
      const action = p.action as string;

      // Collection-level invoke: only create (windowId derived from payload)
      if (isWindowCollection(resolved)) {
        if (action === 'create' || action === 'create_component')
          return handleCreate(
            '',
            action === 'create_component' ? { ...p, renderer: 'component' } : p,
          );
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
        case 'create_component': // deprecated alias
          return handleCreate(windowId, { ...p, renderer: 'component' });
        case 'update':
          return handleUpdate(getWindowState(), windowId, p);
        case 'update_component': // deprecated alias
          return handleUpdate(getWindowState(), windowId, {
            ...p,
            operation: 'replace',
            renderer: 'component',
            content: { components: p.components, cols: p.cols, gap: p.gap },
          });
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
          pool
            .handleTask({
              type: 'window',
              messageId,
              windowId,
              content: p.message as string,
              monitorId: getMonitorId() ?? undefined,
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
