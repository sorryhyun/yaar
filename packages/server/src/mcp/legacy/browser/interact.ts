/**
 * Browser tools: click, type, press, hover — element interaction.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../../utils.js';
import { getBrowserPool } from '../../../lib/browser/index.js';
import { resolveSession, formatPageState } from '../../domains/browser/shared.js';

export function registerInteractTools(server: McpServer): void {
  server.registerTool(
    'click',
    {
      description:
        'Click an element on the page by CSS selector, visible text, or x/y coordinates. Returns updated page state.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector of the element to click'),
        text: z
          .string()
          .optional()
          .describe('Visible text of the element to click (for buttons/links)'),
        x: z
          .number()
          .optional()
          .describe('X coordinate to click at (use with y for coordinate-based click)'),
        y: z
          .number()
          .optional()
          .describe('Y coordinate to click at (use with x for coordinate-based click)'),
        index: z
          .number()
          .optional()
          .describe('0-based index when multiple text matches exist (default: 0, first match)'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      if (!args.selector && !args.text && (args.x === undefined || args.y === undefined)) {
        return error('Provide "selector", "text", or both "x" and "y" to identify where to click.');
      }
      const session = resolveSession(args.browserId);
      const state = await session.click(args.selector, args.text, args.x, args.y, args.index);
      // Check for auto-adopted new tabs
      const pool = getBrowserPool();
      const adoptedTabs = pool.consumeAdoptedTabs();
      let result = formatPageState(state);
      if (adoptedTabs.length > 0) {
        for (const tab of adoptedTabs) {
          result += `\nNew tab opened: [browser:${tab.browserId}] ${tab.url}`;
        }
      }
      return ok(result);
    },
  );

  server.registerTool(
    'type',
    {
      description: 'Type text into an input field identified by CSS selector.',
      inputSchema: {
        selector: z.string().describe('CSS selector of the input field'),
        text: z.string().describe('Text to type into the field'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.type(args.selector, args.text);
      return ok(`Typed into ${args.selector}\n\n${formatPageState(state)}`);
    },
  );

  server.registerTool(
    'press',
    {
      description:
        'Press a keyboard key (Enter, Tab, Escape, ArrowDown, etc.). Optionally focus an element first by selector. Returns updated page state.',
      inputSchema: {
        key: z.string().describe('Key to press (e.g., "Enter", "Tab", "Escape", "ArrowDown")'),
        selector: z
          .string()
          .optional()
          .describe('CSS selector of the element to focus before pressing the key'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.press(args.key, args.selector);
      return ok(formatPageState(state));
    },
  );

  server.registerTool(
    'hover',
    {
      description:
        'Hover over an element by CSS selector, visible text, or x/y coordinates. Returns updated page state with screenshot.',
      inputSchema: {
        selector: z.string().optional().describe('CSS selector of the element to hover'),
        text: z.string().optional().describe('Visible text of the element to hover'),
        x: z
          .number()
          .optional()
          .describe('X coordinate to hover at (use with y for coordinate-based hover)'),
        y: z
          .number()
          .optional()
          .describe('Y coordinate to hover at (use with x for coordinate-based hover)'),
        index: z
          .number()
          .optional()
          .describe('0-based index when multiple text matches exist (default: 0, first match)'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      if (!args.selector && !args.text && (args.x === undefined || args.y === undefined)) {
        return error('Provide "selector", "text", or both "x" and "y" to identify where to hover.');
      }
      const session = resolveSession(args.browserId);
      const state = await session.hover(args);
      return ok(formatPageState(state));
    },
  );
}
