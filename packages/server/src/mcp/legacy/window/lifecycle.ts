/**
 * Window lifecycle tools - manage (close/lock/unlock), list, view, info.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OSAction } from '@yaar/shared';
import { parseWindowKey, buildWindowUri } from '@yaar/shared';
import { actionEmitter } from '../../action-emitter.js';
import type { WindowStateRegistry } from '../../window-state.js';
import { ok, okWithImages, error } from '../../utils.js';
import { getAgentId } from '../../../agents/session.js';
import { resolveWindowId } from '../../../features/window/resolve-window.js';
import { formatWindowRef } from './helpers.js';

export function registerLifecycleTools(
  server: McpServer,
  getWindowState: () => WindowStateRegistry,
): void {
  // manage — close, lock, or unlock a window
  server.registerTool(
    'manage',
    {
      description:
        'Manage a window: close it, lock it (prevent other agents from modifying), or unlock it (only the locking agent can unlock).',
      inputSchema: {
        uri: z.string(),
        action: z.enum(['close', 'lock', 'unlock']).describe('Action to perform on the window'),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);
      const agentId = getAgentId();

      if (!getWindowState().hasWindow(windowId)) {
        return error(`Window "${windowId}" does not exist.`);
      }

      const lockedBy = getWindowState().isLockedByOther(windowId, agentId);

      switch (args.action) {
        case 'close': {
          if (lockedBy) {
            return error(
              `Window "${windowId}" is locked by agent "${lockedBy}". Cannot close until unlocked.`,
            );
          }
          const feedback = await actionEmitter.emitActionWithFeedback(
            { type: 'window.close', windowId } satisfies OSAction,
            500,
          );
          if (feedback && !feedback.success) {
            return error(`Failed to close window "${windowId}": ${feedback.error}`);
          }
          return ok(`Closed window "${formatWindowRef(windowId)}"`);
        }

        case 'lock': {
          if (!agentId) {
            return error('Cannot determine agent identity. Lock requires an agent context.');
          }
          if (lockedBy) {
            return error(`Window "${windowId}" is already locked by agent "${lockedBy}".`);
          }
          actionEmitter.emitAction({
            type: 'window.lock',
            windowId,
            agentId,
          } satisfies OSAction);
          return ok(`Locked window "${formatWindowRef(windowId)}"`);
        }

        case 'unlock': {
          if (!agentId) {
            return error('Cannot determine agent identity. Unlock requires an agent context.');
          }
          if (lockedBy) {
            return error(
              `Window "${windowId}" is locked by agent "${lockedBy}". Only the locking agent can unlock.`,
            );
          }
          actionEmitter.emitAction({
            type: 'window.unlock',
            windowId,
            agentId,
          } satisfies OSAction);
          return ok(`Unlocked window "${formatWindowRef(windowId)}"`);
        }
      }
    },
  );

  // list_windows
  server.registerTool(
    'list',
    {
      description:
        'List all windows currently open on the YAAR desktop. Returns window IDs, titles, positions, sizes, and lock status.',
    },
    async () => {
      const windows = getWindowState().listWindows();

      if (windows.length === 0) {
        return ok('No windows are currently open.');
      }

      const windowList = windows.map((win) => {
        const parsed = parseWindowKey(win.id);
        return {
          id: win.id,
          ...(parsed ? { uri: buildWindowUri(parsed.monitorId, parsed.windowId) } : {}),
          title: win.title,
          position: `(${win.bounds.x}, ${win.bounds.y})`,
          size: `${win.bounds.w}x${win.bounds.h}`,
          renderer: win.content.renderer,
          locked: win.locked,
          lockedBy: win.lockedBy,
          ...(win.appProtocol ? { appProtocol: true } : {}),
          ...(win.variant && win.variant !== 'standard' ? { variant: win.variant } : {}),
          ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
        };
      });

      return ok(JSON.stringify(windowList, null, 2));
    },
  );

  // view_window
  server.registerTool(
    'view',
    {
      description: "View a window's content and metadata.",
      inputSchema: {
        uri: z.string(),
        includeImage: z
          .boolean()
          .optional()
          .describe('Capture a screenshot of the rendered window and return it as an image'),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);
      const win = getWindowState().getWindow(windowId);

      if (!win) {
        return error(`Window "${windowId}" not found. Use list to see available windows.`);
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
        ...(win.variant && win.variant !== 'standard' ? { variant: win.variant } : {}),
        ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
      };

      if (args.includeImage) {
        const osAction: OSAction = {
          type: 'window.capture',
          windowId,
        };

        const feedback = await actionEmitter.emitActionWithFeedback(osAction, 5000);

        if (feedback?.success && feedback.imageData) {
          return okWithImages(JSON.stringify(windowInfo, null, 2), [
            { data: feedback.imageData, mimeType: 'image/webp' },
          ]);
        }

        const errorMsg = feedback?.error ?? 'Capture timed out or no image returned';
        return ok(JSON.stringify({ ...windowInfo, captureError: errorMsg }, null, 2));
      }

      return ok(JSON.stringify(windowInfo, null, 2));
    },
  );

  // info — lightweight lock/ownership check
  server.registerTool(
    'info',
    {
      description:
        'Get quick info about a window: lock status, which agent locked it, and whether you are the lock owner.',
      inputSchema: {
        uri: z.string(),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);
      const win = getWindowState().getWindow(windowId);

      if (!win) {
        return error(`Window "${windowId}" not found. Use list to see available windows.`);
      }

      const agentId = getAgentId();
      const info = {
        id: win.id,
        title: win.title,
        renderer: win.content.renderer,
        ...(win.appProtocol ? { appProtocol: true } : {}),
        locked: win.locked,
        lockedBy: win.lockedBy ?? null,
        isOwner: win.locked && agentId ? win.lockedBy === agentId : false,
      };

      return ok(JSON.stringify(info, null, 2));
    },
  );
}
