/**
 * Window lifecycle tools - close, lock, unlock, list, view.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OSAction } from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import type { WindowStateRegistry } from '../window-state.js';
import { ok, okWithImages, error } from '../utils.js';

export function registerLifecycleTools(
  server: McpServer,
  getWindowState: () => WindowStateRegistry,
): void {
  // close_window
  server.registerTool(
    'close',
    {
      description: 'Close a window on the YAAR desktop',
      inputSchema: {
        windowId: z.string().describe('ID of the window to close'),
      },
    },
    async (args) => {
      if (!getWindowState().hasWindow(args.windowId)) {
        return error(`Window "${args.windowId}" does not exist or was already closed.`);
      }

      const osAction: OSAction = {
        type: 'window.close',
        windowId: args.windowId,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return error(`Failed to close window "${args.windowId}": ${feedback.error}`);
      }

      return ok(`Closed window "${args.windowId}"`);
    },
  );

  // lock_window
  server.registerTool(
    'lock',
    {
      description:
        'Lock a window to prevent other agents from modifying its content. Only the locking agent can modify or unlock the window.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to lock'),
        agentId: z.string().describe('Unique identifier for the agent acquiring the lock'),
      },
    },
    async (args) => {
      if (!getWindowState().hasWindow(args.windowId)) {
        return error(
          `Window "${args.windowId}" does not exist. Cannot lock a non-existent window.`,
        );
      }

      const osAction: OSAction = {
        type: 'window.lock',
        windowId: args.windowId,
        agentId: args.agentId,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Locked window "${args.windowId}"`);
    },
  );

  // unlock_window
  server.registerTool(
    'unlock',
    {
      description:
        'Unlock a previously locked window. Only the agent that locked the window can unlock it.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to unlock'),
        agentId: z
          .string()
          .describe(
            'Unique identifier for the agent releasing the lock (must match the locking agent)',
          ),
      },
    },
    async (args) => {
      if (!getWindowState().hasWindow(args.windowId)) {
        return error(
          `Window "${args.windowId}" does not exist. Cannot unlock a non-existent window.`,
        );
      }

      const osAction: OSAction = {
        type: 'window.unlock',
        windowId: args.windowId,
        agentId: args.agentId,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Unlocked window "${args.windowId}"`);
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

      const windowList = windows.map((win) => ({
        id: win.id,
        title: win.title,
        position: `(${win.bounds.x}, ${win.bounds.y})`,
        size: `${win.bounds.w}x${win.bounds.h}`,
        renderer: win.content.renderer,
        locked: win.locked,
        lockedBy: win.lockedBy,
        ...(win.appProtocol ? { appProtocol: true } : {}),
        ...(win.variant && win.variant !== 'standard' ? { variant: win.variant } : {}),
        ...(win.dockEdge ? { dockEdge: win.dockEdge } : {}),
      }));

      return ok(JSON.stringify(windowList, null, 2));
    },
  );

  // view_window
  server.registerTool(
    'view',
    {
      description:
        'View the content of a specific window by its ID. Returns the window title, content renderer type, and current content. Optionally capture a screenshot of the rendered window.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to view'),
        includeImage: z
          .boolean()
          .optional()
          .describe('Capture a screenshot of the rendered window and return it as an image'),
      },
    },
    async (args) => {
      const win = getWindowState().getWindow(args.windowId);

      if (!win) {
        return error(`Window "${args.windowId}" not found. Use list to see available windows.`);
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
          windowId: args.windowId,
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
}
