/**
 * Window update tools - update and update_component.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type ContentUpdateOperation,
  type ComponentLayout,
  displayRendererSchema,
  displayDataSchema,
  componentSchema,
} from '@yaar/shared';
import { actionEmitter } from '../../action-emitter.js';
import type { WindowStateRegistry } from '../../window-state.js';
import { ok, error } from '../../utils.js';
import { gapEnum, colsSchema } from './create.js';
import { resolveWindowId } from './resolve-window.js';
import { formatWindowRef, checkWindowAccess } from './helpers.js';

export function registerUpdateTools(
  server: McpServer,
  getWindowState: () => WindowStateRegistry,
): void {
  // update_window - for display content (markdown, html, text, iframe)
  server.registerTool(
    'update',
    {
      description:
        'Update display window content with text operations. For component windows, use update_component instead.',
      inputSchema: {
        uri: z.string(),
        operation: z
          .enum(['append', 'prepend', 'replace', 'insertAt', 'clear'])
          .describe('The operation to perform on the content'),
        renderer: displayRendererSchema
          .optional()
          .describe('Content renderer type (only needed when changing renderer)'),
        content: displayDataSchema
          .optional()
          .describe(
            'Content string (markdown text, HTML, plain text, or URL for iframe), or { headers, rows } for table',
          ),
        position: z.number().optional().describe('Character position for insertAt operation'),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);

      const accessError = checkWindowAccess(getWindowState(), windowId);
      if (accessError) return accessError;

      const renderer = args.renderer as string | undefined;
      const data = (args.content as string | { headers: string[]; rows: string[][] }) ?? '';

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
            return error('position is required for insertAt operation');
          }
          operation = { op: 'insertAt', position: args.position, data };
          break;
        case 'clear':
          operation = { op: 'clear' };
          break;
      }

      const osAction = {
        type: 'window.updateContent' as const,
        windowId,
        operation,
        renderer,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return error(
          `Window "${windowId}" is locked by another agent. Cannot update until unlocked.`,
        );
      }

      if (feedback?.locked) {
        return ok(
          `Updated window "${windowId}". Window is currently locked - use unlock when done.`,
        );
      }

      return ok(`Updated window "${formatWindowRef(windowId)}" (${args.operation})`);
    },
  );

  // update_component_window - replace component layout
  server.registerTool(
    'update_component',
    {
      description: 'Replace the components in a component window.',
      inputSchema: {
        uri: z.string(),
        components: z.array(componentSchema).describe('New flat array of UI components'),
        cols: colsSchema
          .optional()
          .describe(
            'Columns: number for equal cols (e.g. 2), array for ratio (e.g. [8,2] = 80/20 split). Default: 1',
          ),
        gap: gapEnum.optional().describe('Spacing between components (default: md)'),
      },
    },
    async (args) => {
      const windowId = resolveWindowId(args.uri);

      const accessError2 = checkWindowAccess(getWindowState(), windowId);
      if (accessError2) return accessError2;

      const layoutData: ComponentLayout = {
        components: args.components as ComponentLayout['components'],
        cols: args.cols as ComponentLayout['cols'],
        gap: args.gap as ComponentLayout['gap'],
      };

      const osAction = {
        type: 'window.updateContent' as const,
        windowId,
        operation: { op: 'replace' as const, data: layoutData },
        renderer: 'component' as const,
      };

      const feedback = await actionEmitter.emitActionWithFeedback(osAction, 500);

      if (feedback && !feedback.success) {
        return error(
          `Window "${windowId}" is locked by another agent. Cannot update until unlocked.`,
        );
      }

      if (feedback?.locked) {
        return ok(
          `Updated component window "${windowId}". Window is currently locked - use unlock when done.`,
        );
      }

      return ok(`Updated component window "${formatWindowRef(windowId)}"`);
    },
  );
}
