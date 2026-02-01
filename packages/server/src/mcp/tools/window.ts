/**
 * Window tools - create, update, close, toast, lock/unlock, list, view.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  WINDOW_PRESETS,
  type WindowPreset,
  type OSAction,
  type ContentUpdateOperation,
  type ComponentNode,
} from '@claudeos/shared';
import { actionEmitter } from '../action-emitter.js';
import { windowState } from '../window-state.js';
import { ok } from '../utils.js';

export function registerWindowTools(server: McpServer): void {
  // create_window
  server.registerTool(
    'create_window',
    {
      description:
        'Create a new window. For interactive UI, set renderer="component" and use "components" parameter.',
      inputSchema: {
        windowId: z.string().describe('Unique identifier for the window'),
        title: z.string().describe('Window title'),
        content: z
          .string()
          .optional()
          .describe('String content for markdown/text/html/iframe renderers.'),
        components: z
          .any()
          .optional()
          .describe(
            'Component tree for renderer="component". Valid types: stack (layout with children), grid (columns), card (title/content), button (action), text, markdown, image, alert, badge, progress, list, divider, spacer, form, input, textarea, select.'
          ),
        preset: z
          .enum(['default', 'info', 'alert', 'document', 'sidebar', 'dialog'])
          .optional()
          .describe('Window preset for consistent styling. Defaults to "default"'),
        renderer: z
          .enum(['markdown', 'text', 'html', 'iframe', 'component'])
          .optional()
          .describe('Content renderer. Use "component" for interactive UI with buttons. Defaults to "markdown"'),
        x: z.number().optional().describe('X position (overrides preset)'),
        y: z.number().optional().describe('Y position (overrides preset)'),
        width: z.number().optional().describe('Width (overrides preset)'),
        height: z.number().optional().describe('Height (overrides preset)'),
      },
    },
    async (args) => {
      const presetName = (args.preset || 'default') as WindowPreset;
      const preset = WINDOW_PRESETS[presetName];
      const renderer = args.renderer || 'markdown';

      const contentData =
        renderer === 'component' && args.components
          ? (args.components as ComponentNode)
          : (args.content ?? '');

      const osAction: OSAction = {
        type: 'window.create',
        windowId: args.windowId,
        title: args.title,
        bounds: {
          x: args.x ?? preset.x ?? 100,
          y: args.y ?? preset.y ?? 100,
          w: args.width ?? preset.width,
          h: args.height ?? preset.height,
        },
        content: {
          renderer,
          data: contentData,
        },
      };

      if (renderer === 'iframe' && args.content) {
        const feedback = await actionEmitter.emitActionWithFeedback(osAction, 2000);

        if (feedback && !feedback.success) {
          return ok(
            `Created window "${args.windowId}" but iframe embedding failed: ${feedback.error}. The site likely blocks embedding via CSP or X-Frame-Options. Consider showing content differently (e.g., markdown summary with a link).`
          );
        }

        return ok(`Created window "${args.windowId}" with embedded iframe`);
      }

      actionEmitter.emitAction(osAction);
      return ok(`Created window "${args.windowId}"`);
    }
  );

  // update_window
  server.registerTool(
    'update_window',
    {
      description: 'Update window content.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to update'),
        operation: z
          .enum(['append', 'prepend', 'replace', 'insertAt', 'clear'])
          .describe('The operation to perform on the content'),
        content: z
          .string()
          .optional()
          .describe('String content for markdown/text/html/iframe renderers.'),
        components: z
          .any()
          .optional()
          .describe(
            'Component tree for renderer="component". Valid types: stack, grid, card, button, text, markdown, image, alert, badge, progress, list, divider, spacer, form, input, textarea, select.'
          ),
        position: z.number().optional().describe('Character position for insertAt operation'),
        renderer: z
          .enum(['markdown', 'text', 'html', 'iframe', 'component'])
          .optional()
          .describe('Change the renderer type. Use "component" for interactive UI with buttons'),
      },
    },
    async (args) => {
      const contentData =
        args.renderer === 'component' && args.components
          ? args.components
          : (args.content ?? '');

      let operation: ContentUpdateOperation;
      switch (args.operation) {
        case 'append':
          operation = { op: 'append', data: contentData };
          break;
        case 'prepend':
          operation = { op: 'prepend', data: contentData };
          break;
        case 'replace':
          operation = { op: 'replace', data: contentData };
          break;
        case 'insertAt':
          if (args.position === undefined) {
            return ok('Error: position is required for insertAt operation');
          }
          operation = { op: 'insertAt', position: args.position, data: contentData };
          break;
        case 'clear':
          operation = { op: 'clear' };
          break;
      }

      const osAction = {
        type: 'window.updateContent' as const,
        windowId: args.windowId,
        operation,
        renderer: args.renderer,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return ok(`Window "${args.windowId}" is locked by another agent. Cannot update until unlocked.`);
      }

      if (feedback?.locked) {
        return ok(`Updated window "${args.windowId}". Window is currently locked - use unlock_window when done.`);
      }

      return ok(
        `Updated window "${args.windowId}" (${args.operation}${args.renderer ? `, renderer: ${args.renderer}` : ''})`
      );
    }
  );

  // close_window
  server.registerTool(
    'close_window',
    {
      description: 'Close a window on the ClaudeOS desktop',
      inputSchema: {
        windowId: z.string().describe('ID of the window to close'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'window.close',
        windowId: args.windowId,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return ok(`Failed to close window "${args.windowId}": ${feedback.error}`);
      }

      return ok(`Closed window "${args.windowId}"`);
    }
  );


  // lock_window
  server.registerTool(
    'lock_window',
    {
      description:
        'Lock a window to prevent other agents from modifying its content. Only the locking agent can modify or unlock the window.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to lock'),
        agentId: z.string().describe('Unique identifier for the agent acquiring the lock'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'window.lock',
        windowId: args.windowId,
        agentId: args.agentId,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Locked window "${args.windowId}"`);
    }
  );

  // unlock_window
  server.registerTool(
    'unlock_window',
    {
      description: 'Unlock a previously locked window. Only the agent that locked the window can unlock it.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to unlock'),
        agentId: z
          .string()
          .describe('Unique identifier for the agent releasing the lock (must match the locking agent)'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'window.unlock',
        windowId: args.windowId,
        agentId: args.agentId,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Unlocked window "${args.windowId}"`);
    }
  );

  // list_windows
  server.registerTool(
    'list_windows',
    {
      description:
        'List all windows currently open on the ClaudeOS desktop. Returns window IDs, titles, positions, sizes, and lock status.',
    },
    async () => {
      const windows = windowState.listWindows();

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
      }));

      return ok(JSON.stringify(windowList, null, 2));
    }
  );

  // view_window
  server.registerTool(
    'view_window',
    {
      description:
        'View the content of a specific window by its ID. Returns the window title, content renderer type, and current content.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to view'),
      },
    },
    async (args) => {
      const win = windowState.getWindow(args.windowId);

      if (!win) {
        return ok(`Window "${args.windowId}" not found. Use list_windows to see available windows.`);
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
      };

      return ok(JSON.stringify(windowInfo, null, 2));
    }
  );

  // show_notification
  server.registerTool(
    'show_notification',
    {
      description:
        'Show a persistent notification that requires manual dismissal. Use for important alerts that should stay visible.',
      inputSchema: {
        id: z.string().describe('Unique notification ID'),
        title: z.string().describe('Notification title'),
        body: z.string().describe('Notification body text'),
        icon: z.string().optional().describe('Optional icon name'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'notification.show',
        id: args.id,
        title: args.title,
        body: args.body,
        icon: args.icon,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Notification "${args.title}" shown`);
    }
  );

  // dismiss_notification
  server.registerTool(
    'dismiss_notification',
    {
      description: 'Dismiss a notification by ID',
      inputSchema: {
        id: z.string().describe('Notification ID to dismiss'),
      },
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'notification.dismiss',
        id: args.id,
      };

      actionEmitter.emitAction(osAction);
      return ok(`Notification ${args.id} dismissed`);
    }
  );
}
