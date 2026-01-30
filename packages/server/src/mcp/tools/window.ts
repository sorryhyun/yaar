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
  server.tool(
    'create_window',
    'Create a new window on the ClaudeOS desktop. Use presets for consistent styling. Content is optional and defaults to empty. Use renderer: "component" with components parameter for interactive UI with buttons.',
    {
      windowId: z.string().describe('Unique identifier for the window'),
      title: z.string().describe('Window title'),
      content: z
        .string()
        .optional()
        .describe(
          'Initial content to display in the window (for markdown/text/html/iframe renderers). Defaults to empty string'
        ),
      components: z
        .any()
        .optional()
        .describe('Component tree for component renderer. Use this for interactive UI with buttons, cards, etc.'),
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
    async (args) => {
      const presetName = (args.preset || 'default') as WindowPreset;
      const preset = WINDOW_PRESETS[presetName];
      const renderer = args.renderer || 'markdown';

      let contentData: unknown;
      if (renderer === 'component' && args.components) {
        contentData = args.components as ComponentNode;
      } else {
        contentData = args.content ?? '';
      }

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
  server.tool(
    'update_window',
    'Update the content of an existing window using diff-based operations: append, prepend, replace, insertAt, or clear. Can also change the renderer type (e.g., to "iframe" with a URL, or "component" for interactive UI).',
    {
      windowId: z.string().describe('ID of the window to update'),
      operation: z
        .enum(['append', 'prepend', 'replace', 'insertAt', 'clear'])
        .describe('The operation to perform on the content'),
      content: z
        .string()
        .optional()
        .describe('Content for the operation (not needed for clear). For iframe renderer, this should be a URL'),
      components: z
        .any()
        .optional()
        .describe(
          'Component tree for component renderer (use with operation: "replace"). Use this for interactive UI with buttons, cards, etc.'
        ),
      position: z.number().optional().describe('Character position for insertAt operation'),
      renderer: z
        .enum(['markdown', 'text', 'html', 'iframe', 'component'])
        .optional()
        .describe('Change the renderer type. Use "component" for interactive UI with buttons'),
    },
    async (args) => {
      let operation: ContentUpdateOperation;
      const contentData =
        args.renderer === 'component' && args.components ? args.components : (args.content ?? '');

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
  server.tool(
    'close_window',
    'Close a window on the ClaudeOS desktop',
    {
      windowId: z.string().describe('ID of the window to close'),
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

  // show_toast
  server.tool(
    'show_toast',
    'Display a toast notification on the ClaudeOS desktop',
    {
      id: z
        .string()
        .optional()
        .describe('Optional unique identifier for the toast. Auto-generated if not provided'),
      message: z.string().describe('Toast message to display'),
      variant: z
        .enum(['info', 'success', 'warning', 'error'])
        .optional()
        .describe('Toast variant. Defaults to "info"'),
    },
    async (args) => {
      const osAction: OSAction = {
        type: 'toast.show',
        id: args.id || `toast-${Date.now()}`,
        message: args.message,
        variant: args.variant || 'info',
      };

      actionEmitter.emitAction(osAction);
      return ok('Toast displayed');
    }
  );

  // lock_window
  server.tool(
    'lock_window',
    'Lock a window to prevent other agents from modifying its content. Only the locking agent can modify or unlock the window.',
    {
      windowId: z.string().describe('ID of the window to lock'),
      agentId: z.string().describe('Unique identifier for the agent acquiring the lock'),
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
  server.tool(
    'unlock_window',
    'Unlock a previously locked window. Only the agent that locked the window can unlock it.',
    {
      windowId: z.string().describe('ID of the window to unlock'),
      agentId: z
        .string()
        .describe('Unique identifier for the agent releasing the lock (must match the locking agent)'),
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
  server.tool(
    'list_windows',
    'List all windows currently open on the ClaudeOS desktop. Returns window IDs, titles, positions, sizes, and lock status.',
    {},
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
  server.tool(
    'view_window',
    'View the content of a specific window by its ID. Returns the window title, content renderer type, and current content.',
    {
      windowId: z.string().describe('ID of the window to view'),
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
}
