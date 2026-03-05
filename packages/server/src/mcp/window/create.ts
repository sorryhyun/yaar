/**
 * Window create tools - create and create_component.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { join } from 'path';
import {
  type OSAction,
  type ComponentLayout,
  type WindowVariant,
  displayRendererSchema,
  displayDataSchema,
  componentSchema,
  componentLayoutSchema,
} from '@yaar/shared';
import { actionEmitter } from '../action-emitter.js';
import { ok, error } from '../utils.js';
import { PROJECT_ROOT } from '../../config.js';
import { getAppMeta } from '../apps/discovery.js';
import { resolveContentUri, extractAppId, buildWindowUri } from '@yaar/shared';
import { getMonitorId } from '../../agents/session.js';

/** Derive a window ID from appId, name, or title. */
function deriveWindowId(appId?: string, name?: string, title?: string): string {
  if (appId) return appId;
  const source = name ?? title ?? '';
  // Slugify: lowercase, replace non-alphanumeric with hyphens, collapse, trim
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || `win-${Date.now().toString(36)}`;
}

/** Format a window identifier for tool feedback — full URI when monitor context is available. */
function formatWindowRef(windowId: string): string {
  const monitorId = getMonitorId();
  return monitorId ? buildWindowUri(monitorId, windowId) : windowId;
}

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
        'Create a window for displaying content (markdown, HTML, text, table, or iframe). For interactive UI with buttons/forms, use create_component instead. For PDF files, use iframe renderer with src="/api/storage/<path>" to leverage the browser\'s built-in PDF viewer.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(
            'Window identifier (e.g. "news", "editor"). Auto-derived from appId or title if omitted.',
          ),
        title: z.string().describe('Window title'),
        renderer: displayRendererSchema.describe(
          'Content renderer type: markdown, html, text, table, or iframe',
        ),
        content: displayDataSchema.describe(
          'Content string (markdown text, HTML, plain text, or URL for iframe), or { headers, rows } for table',
        ),
        x: z.number().optional().describe('X position (default: 100)'),
        y: z.number().optional().describe('Y position (default: 100)'),
        width: z.number().optional().describe('Width (default: 500)'),
        height: z.number().optional().describe('Height (default: 400)'),
        appId: z
          .string()
          .optional()
          .describe('App ID — auto-applies window variant and metadata from app.json'),
        minimized: z
          .boolean()
          .optional()
          .describe('Create window in minimized state (taskbar only)'),
      },
    },
    async (args) => {
      const windowId = deriveWindowId(
        args.appId as string | undefined,
        args.name as string | undefined,
        args.title,
      );
      const renderer = args.renderer as string;
      let data = args.content as string | { headers: string[]; rows: string[][] };

      // Resolve yaar:// URIs for iframe content
      if (renderer === 'iframe' && typeof data === 'string') {
        const resolved = resolveContentUri(data);
        if (resolved) {
          data = resolved;
        } else if (data.startsWith('yaar://')) {
          const appId = extractAppId(data);
          return error(
            `Unknown app "${appId || data}". Use list to see available apps, or load_skill to learn how to use one.`,
          );
        }
      }

      // Look up variant/dockEdge from app.json if appId is provided
      const appMeta = args.appId ? await getAppMeta(args.appId as string) : null;

      const osAction: OSAction = {
        type: 'window.create',
        windowId,
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
        ...(appMeta?.variant ? { variant: appMeta.variant as WindowVariant } : {}),
        ...(appMeta?.dockEdge ? { dockEdge: appMeta.dockEdge as 'top' | 'bottom' } : {}),
        ...(appMeta?.frameless ? { frameless: true } : {}),
        ...(appMeta?.windowStyle ? { windowStyle: appMeta.windowStyle } : {}),
        ...(args.minimized ? { minimized: true } : {}),
      };

      if (renderer === 'iframe') {
        const feedback = await actionEmitter.emitActionWithFeedback(osAction, 2000);

        if (feedback && !feedback.success) {
          const isNotFound = feedback.error?.toLowerCase().includes('not found');
          const hint = isNotFound
            ? ' If this is an app, use load_skill to learn how to use it.'
            : ' The site likely blocks embedding.';
          return error(`Failed to embed iframe in window "${windowId}": ${feedback.error}.${hint}`);
        }

        return ok(`Created window "${formatWindowRef(windowId)}" with embedded iframe`);
      }

      actionEmitter.emitAction(osAction);
      return ok(`Created window "${formatWindowRef(windowId)}"`);
    },
  );

  // create_component_window - for interactive UI components
  server.registerTool(
    'create_component',
    {
      description:
        'Create a window with interactive UI components (buttons, forms, inputs, etc). Components are a flat array laid out with CSS grid.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe(
            'Window identifier (e.g. "settings", "dashboard"). Auto-derived from appId or title if omitted.',
          ),
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
        appId: z
          .string()
          .optional()
          .describe('App ID — auto-applies window variant and metadata from app.json'),
        minimized: z
          .boolean()
          .optional()
          .describe('Create window in minimized state (taskbar only)'),
      },
    },
    async (args) => {
      const windowId = deriveWindowId(
        args.appId as string | undefined,
        args.name as string | undefined,
        args.title,
      );
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
          const raw = await Bun.file(fullPath).text();
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

      // Look up variant/dockEdge from app.json if appId is provided
      const appMeta = args.appId ? await getAppMeta(args.appId as string) : null;

      const osAction: OSAction = {
        type: 'window.create',
        windowId,
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
        ...(appMeta?.variant ? { variant: appMeta.variant as WindowVariant } : {}),
        ...(appMeta?.dockEdge ? { dockEdge: appMeta.dockEdge as 'top' | 'bottom' } : {}),
        ...(appMeta?.frameless ? { frameless: true } : {}),
        ...(appMeta?.windowStyle ? { windowStyle: appMeta.windowStyle } : {}),
        ...(args.minimized ? { minimized: true } : {}),
      };

      actionEmitter.emitAction(osAction);
      return ok(`Created component window "${formatWindowRef(windowId)}"`);
    },
  );
}
