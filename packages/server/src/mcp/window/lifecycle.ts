/**
 * Window lifecycle tools - close, lock, unlock, list, view.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OSAction } from '@yaar/shared';
import { buildWindowUri, parseWindowKey } from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import type { WindowStateRegistry } from '../window-state.js';
import { ok, okWithImages, error } from '../utils.js';
import { getAgentId } from '../../agents/session.js';
import { enrichManifestWithUris } from './manifest-utils.js';
import { resolveWindowId } from './resolve-window.js';

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
        uri: z.string().describe('Window URI or ID (e.g., "yaar://monitor-0/win-id" or "win-id")'),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);

      if (!getWindowState().hasWindow(windowId)) {
        return error(`Window "${windowId}" does not exist or was already closed.`);
      }

      const lockedBy = getWindowState().isLockedByOther(windowId, getAgentId());
      if (lockedBy) {
        return error(
          `Window "${windowId}" is locked by agent "${lockedBy}". Cannot close until unlocked.`,
        );
      }

      const osAction: OSAction = {
        type: 'window.close',
        windowId,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return error(`Failed to close window "${windowId}": ${feedback.error}`);
      }

      return ok(`Closed window "${windowId}"`);
    },
  );

  // lock_window
  server.registerTool(
    'lock',
    {
      description:
        'Lock a window to prevent other agents from modifying its content. Only the locking agent can modify or unlock the window.',
      inputSchema: {
        uri: z.string().describe('Window URI or ID (e.g., "yaar://monitor-0/win-id" or "win-id")'),
        agentId: z.string().describe('Unique identifier for the agent acquiring the lock'),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);

      if (!getWindowState().hasWindow(windowId)) {
        return error(`Window "${windowId}" does not exist. Cannot lock a non-existent window.`);
      }

      const osAction: OSAction = {
        type: 'window.lock',
        windowId,
        agentId: args.agentId,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Locked window "${windowId}"`);
    },
  );

  // unlock_window
  server.registerTool(
    'unlock',
    {
      description:
        'Unlock a previously locked window. Only the agent that locked the window can unlock it.',
      inputSchema: {
        uri: z.string().describe('Window URI or ID (e.g., "yaar://monitor-0/win-id" or "win-id")'),
        agentId: z
          .string()
          .describe(
            'Unique identifier for the agent releasing the lock (must match the locking agent)',
          ),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);

      if (!getWindowState().hasWindow(windowId)) {
        return error(`Window "${windowId}" does not exist. Cannot unlock a non-existent window.`);
      }

      const lockedBy = getWindowState().isLockedByOther(windowId, args.agentId);
      if (lockedBy) {
        return error(
          `Window "${windowId}" is locked by agent "${lockedBy}", not "${args.agentId}". Only the locking agent can unlock.`,
        );
      }

      const osAction: OSAction = {
        type: 'window.unlock',
        windowId,
        agentId: args.agentId,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Unlocked window "${windowId}"`);
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
      description:
        'View a window. Default mode returns content. Use mode "manifest" for app-protocol iframe windows to discover state keys and commands with URIs.',
      inputSchema: {
        uri: z.string().describe('Window URI or ID (e.g., "yaar://monitor-0/win-id" or "win-id")'),
        mode: z
          .enum(['content', 'manifest'])
          .optional()
          .describe(
            '"content" (default): window content and metadata. "manifest": app-protocol manifest with state/command URIs (iframe apps only).',
          ),
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

      // Manifest mode: fetch and return the app-protocol manifest with URIs
      if (args.mode === 'manifest') {
        if (!win.appProtocol || win.content.renderer !== 'iframe') {
          return error(
            `Window "${windowId}" is not an app-protocol iframe. Use default mode instead.`,
          );
        }
        const response = await actionEmitter.emitAppProtocolRequest(
          windowId,
          { kind: 'manifest' },
          5000,
        );
        if (!response || response.kind !== 'manifest')
          return error('App did not respond to manifest request (timeout).');
        if (response.error) return error(response.error);
        const manifest = response.manifest;
        if (manifest) enrichManifestWithUris(manifest, win.id);
        return ok(JSON.stringify({ id: win.id, title: win.title, manifest }, null, 2));
      }

      // Default content mode
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
}
