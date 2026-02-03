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
  type DisplayContent,
  type ComponentLayout,
  displayContentSchema,
  componentSchema,
} from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import { windowState } from '../window-state.js';
import { ok } from '../utils.js';

const gapEnum = z.enum(['none', 'sm', 'md', 'lg']);
const colsSchema = z.union([
  z.coerce.number().int().min(1),
  z.array(z.number().min(0)),
]);

export function registerWindowTools(server: McpServer): void {
  // create_window - for display content (markdown, html, text, iframe)
  server.registerTool(
    'create',
    {
      description:
        'Create a window for displaying content (markdown, HTML, text, or iframe). For interactive UI with buttons/forms, use create_component instead.',
      inputSchema: {
        windowId: z.string().describe('Unique identifier for the window'),
        title: z.string().describe('Window title'),
        content: displayContentSchema.describe('Display content (markdown, html, text, or iframe)'),
        preset: z
          .enum(['default', 'info', 'alert', 'document', 'sidebar', 'dialog'])
          .optional()
          .describe('Window preset for consistent styling. Defaults to "default"'),
        x: z.number().optional().describe('X position (overrides preset)'),
        y: z.number().optional().describe('Y position (overrides preset)'),
        width: z.number().optional().describe('Width (overrides preset)'),
        height: z.number().optional().describe('Height (overrides preset)'),
      },
    },
    async (args) => {
      const presetName = (args.preset || 'default') as WindowPreset;
      const preset = WINDOW_PRESETS[presetName];

      const content = args.content as DisplayContent;
      const renderer = content.renderer;
      const data = content.content;

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
          data,
        },
      };

      if (renderer === 'iframe') {
        const feedback = await actionEmitter.emitActionWithFeedback(osAction, 2000);

        if (feedback && !feedback.success) {
          return ok(
            `Created window "${args.windowId}" but iframe embedding failed: ${feedback.error}. The site likely blocks embedding.`
          );
        }

        return ok(`Created window "${args.windowId}" with embedded iframe`);
      }

      actionEmitter.emitAction(osAction);
      return ok(`Created window "${args.windowId}"`);
    }
  );

  // create_component_window - for interactive UI components
  server.registerTool(
    'create_component',
    {
      description:
        'Create a window with interactive UI components (buttons, forms, inputs, ... etc). Components are a flat array laid out with CSS grid.',
      inputSchema: {
        windowId: z.string().describe('Unique identifier for the window'),
        title: z.string().describe('Window title'),
        components: z.array(componentSchema).describe('Flat array of UI components'),
        cols: colsSchema.optional()
          .describe('Columns: number for equal cols (e.g. 2), array for ratio (e.g. [8,2] = 80/20 split). Default: 1'),
        gap: gapEnum.optional().describe('Spacing between components (default: md)'),
        preset: z
          .enum(['default', 'info', 'alert', 'document', 'sidebar', 'dialog'])
          .optional()
          .describe('Window preset for consistent styling. Defaults to "default"'),
        x: z.number().optional().describe('X position (overrides preset)'),
        y: z.number().optional().describe('Y position (overrides preset)'),
        width: z.number().optional().describe('Width (overrides preset)'),
        height: z.number().optional().describe('Height (overrides preset)'),
      },
    },
    async (args) => {
      const presetName = (args.preset || 'default') as WindowPreset;
      const preset = WINDOW_PRESETS[presetName];

      const layoutData: ComponentLayout = {
        components: args.components as ComponentLayout['components'],
        cols: args.cols as ComponentLayout['cols'],
        gap: args.gap as ComponentLayout['gap'],
      };

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
          renderer: 'component',
          data: layoutData,
        },
      };

      actionEmitter.emitAction(osAction);
      return ok(`Created component window "${args.windowId}"`);
    }
  );

  // update_window - for display content (markdown, html, text, iframe)
  server.registerTool(
    'update',
    {
      description:
        'Update display window content with text operations. For component windows, use update_component instead.',
      inputSchema: {
        windowId: z.string().describe('ID of the window to update'),
        operation: z
          .enum(['append', 'prepend', 'replace', 'insertAt', 'clear'])
          .describe('The operation to perform on the content'),
        content: displayContentSchema
          .optional()
          .describe('Display content (markdown, html, text, or iframe)'),
        position: z.number().optional().describe('Character position for insertAt operation'),
      },
    },
    async (args) => {
      const content = args.content as DisplayContent | undefined;
      const renderer = content?.renderer;
      const data = content?.content ?? '';

      let operation: ContentUpdateOperation;
      switch (args.operation) {
        case 'append':
          operation = { op: 'append', data };
          break;
        case 'prepend':
          operation = { op: 'prepend', data };
          break;
        case 'replace':
          operation = { op: 'replace', data };
          break;
        case 'insertAt':
          if (args.position === undefined) {
            return ok('Error: position is required for insertAt operation');
          }
          operation = { op: 'insertAt', position: args.position, data };
          break;
        case 'clear':
          operation = { op: 'clear' };
          break;
      }

      const osAction = {
        type: 'window.updateContent' as const,
        windowId: args.windowId,
        operation,
        renderer,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return ok(`Window "${args.windowId}" is locked by another agent. Cannot update until unlocked.`);
      }

      if (feedback?.locked) {
        return ok(`Updated window "${args.windowId}". Window is currently locked - use unlock when done.`);
      }

      return ok(`Updated window "${args.windowId}" (${args.operation})`);
    }
  );

  // update_component_window - replace component layout
  server.registerTool(
    'update_component',
    {
      description: 'Replace the components in a component window.',
      inputSchema: {
        windowId: z.string().describe('ID of the component window to update'),
        components: z.array(componentSchema).describe('New flat array of UI components'),
        cols: colsSchema.optional()
          .describe('Columns: number for equal cols (e.g. 2), array for ratio (e.g. [8,2] = 80/20 split). Default: 1'),
        gap: gapEnum.optional().describe('Spacing between components (default: md)'),
      },
    },
    async (args) => {
      const layoutData: ComponentLayout = {
        components: args.components as ComponentLayout['components'],
        cols: args.cols as ComponentLayout['cols'],
        gap: args.gap as ComponentLayout['gap'],
      };

      const osAction = {
        type: 'window.updateContent' as const,
        windowId: args.windowId,
        operation: { op: 'replace' as const, data: layoutData },
        renderer: 'component' as const,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return ok(`Window "${args.windowId}" is locked by another agent. Cannot update until unlocked.`);
      }

      if (feedback?.locked) {
        return ok(
          `Updated component window "${args.windowId}". Window is currently locked - use unlock when done.`
        );
      }

      return ok(`Updated component window "${args.windowId}"`);
    }
  );

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
    'unlock',
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
    'list',
    {
      description:
        'List all windows currently open on the YAAR desktop. Returns window IDs, titles, positions, sizes, and lock status.',
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
    'view',
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
        return ok(`Window "${args.windowId}" not found. Use list to see available windows.`);
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
