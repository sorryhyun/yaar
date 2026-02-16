/**
 * Window create tools - create and create_component.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'fs/promises';
import { join } from 'path';
import {
  type OSAction,
  type DisplayContent,
  type ComponentLayout,
  type WindowVariant,
  displayContentSchema,
  componentSchema,
  componentLayoutSchema,
} from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import { ok, error } from '../utils.js';
import { PROJECT_ROOT } from '../../config.js';

const gapEnum = z.enum(['none', 'sm', 'md', 'lg']);
const colsInner = z.union([z.array(z.number().min(0)).min(1), z.coerce.number().int().min(1)]);
// Handle stringified JSON from AI (e.g., "[7,3]" instead of [7,3])
const colsSchema = z.union([
  colsInner,
  z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid JSON' });
        return z.NEVER;
      }
    })
    .pipe(colsInner),
]);

export { gapEnum, colsSchema };

export function registerCreateTools(server: McpServer): void {
  // create_window - for display content (markdown, html, text, iframe)
  server.registerTool(
    'create',
    {
      description:
        'Create a window for displaying content (markdown, HTML, text, or iframe). For interactive UI with buttons/forms, use create_component instead. For PDF files, use iframe renderer with src="/api/storage/<path>" to leverage the browser\'s built-in PDF viewer.',
      inputSchema: {
        windowId: z.string().describe('Unique identifier for the window'),
        title: z.string().describe('Window title'),
        content: displayContentSchema.describe('Display content (markdown, html, text, or iframe)'),
        x: z.number().optional().describe('X position (default: 100)'),
        y: z.number().optional().describe('Y position (default: 100)'),
        width: z.number().optional().describe('Width (default: 500)'),
        height: z.number().optional().describe('Height (default: 400)'),
        variant: z
          .enum(['standard', 'widget', 'panel'])
          .optional()
          .describe(
            'Window style: standard (default), widget (chromeless desktop widget), panel (docked bar)',
          ),
        dockEdge: z
          .enum(['top', 'bottom'])
          .optional()
          .describe('Dock edge for panel variant (default: bottom)'),
      },
    },
    async (args) => {
      const content = args.content as DisplayContent;
      const renderer = content.renderer;
      const data = content.content;

      const osAction: OSAction = {
        type: 'window.create',
        windowId: args.windowId,
        title: args.title,
        bounds: {
          x: args.x ?? 100,
          y: args.y ?? 100,
          w: args.width ?? 500,
          h: args.height ?? 400,
        },
        content: {
          renderer,
          data,
        },
        ...(args.variant ? { variant: args.variant as WindowVariant } : {}),
        ...(args.dockEdge ? { dockEdge: args.dockEdge as 'top' | 'bottom' } : {}),
      };

      if (renderer === 'iframe') {
        const feedback = await actionEmitter.emitActionWithFeedback(osAction, 2000);

        if (feedback && !feedback.success) {
          return error(
            `Failed to embed iframe in window "${args.windowId}": ${feedback.error}. The site likely blocks embedding.`,
          );
        }

        return ok(`Created window "${args.windowId}" with embedded iframe`);
      }

      actionEmitter.emitAction(osAction);
      return ok(`Created window "${args.windowId}"`);
    },
  );

  // create_component_window - for interactive UI components
  server.registerTool(
    'create_component',
    {
      description:
        'Create a window with interactive UI components (buttons, forms, inputs, etc). Components are a flat array laid out with CSS grid. Use guideline("components") for layout patterns and examples.',
      inputSchema: {
        windowId: z.string().describe('Unique identifier for the window'),
        title: z.string().describe('Window title'),
        jsonfile: z
          .string()
          .optional()
          .describe(
            'Path to a .yaarcomponent.json file (relative to apps/). If provided, components/cols/gap are loaded from the file.',
          ),
        components: z
          .array(componentSchema)
          .optional()
          .describe('Flat array of UI components (required if jsonfile is not provided)'),
        cols: colsSchema
          .optional()
          .describe(
            'Columns: number for equal cols (e.g. 2), array for ratio (e.g. [8,2] = 80/20 split). Default: 1',
          ),
        gap: gapEnum.optional().describe('Spacing between components (default: md)'),
        x: z.number().optional().describe('X position (default: 100)'),
        y: z.number().optional().describe('Y position (default: 100)'),
        width: z.number().optional().describe('Width (default: 500)'),
        height: z.number().optional().describe('Height (default: 400)'),
        variant: z
          .enum(['standard', 'widget', 'panel'])
          .optional()
          .describe(
            'Window style: standard (default), widget (chromeless desktop widget), panel (docked bar)',
          ),
        dockEdge: z
          .enum(['top', 'bottom'])
          .optional()
          .describe('Dock edge for panel variant (default: bottom)'),
      },
    },
    async (args) => {
      let layoutData: ComponentLayout;

      if (args.jsonfile) {
        // Load from .yaarcomponent.json file
        const filePath = args.jsonfile as string;
        if (!filePath.endsWith('.yaarcomponent.json')) {
          return error('jsonfile must end with .yaarcomponent.json');
        }
        if (filePath.includes('..') || filePath.startsWith('/')) {
          return error('Invalid jsonfile path. Use relative paths without ".." or leading "/".');
        }

        const fullPath = join(PROJECT_ROOT, 'apps', filePath);
        try {
          const raw = await readFile(fullPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const result = componentLayoutSchema.safeParse(parsed);
          if (!result.success) {
            return error(`Invalid .yaarcomponent.json: ${result.error.message}`);
          }
          layoutData = result.data;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return error(`Error reading jsonfile: ${msg}`);
        }
      } else if (args.components) {
        // Inline components
        layoutData = {
          components: args.components as ComponentLayout['components'],
          cols: args.cols as ComponentLayout['cols'],
          gap: args.gap as ComponentLayout['gap'],
        };
      } else {
        return error('Provide either jsonfile or components.');
      }

      const osAction: OSAction = {
        type: 'window.create',
        windowId: args.windowId,
        title: args.title,
        bounds: {
          x: args.x ?? 100,
          y: args.y ?? 100,
          w: args.width ?? 500,
          h: args.height ?? 400,
        },
        content: {
          renderer: 'component',
          data: layoutData,
        },
        ...(args.variant ? { variant: args.variant as WindowVariant } : {}),
        ...(args.dockEdge ? { dockEdge: args.dockEdge as 'top' | 'bottom' } : {}),
      };

      actionEmitter.emitAction(osAction);
      return ok(`Created component window "${args.windowId}"`);
    },
  );
}
