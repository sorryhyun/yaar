/**
 * Browser tools: scroll, navigate (history), wait_for — page navigation.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { resolveSession, formatPageState } from './shared.js';

export function registerNavigateTools(server: McpServer): void {
  server.registerTool(
    'scroll',
    {
      description: 'Scroll the page up or down. Returns updated page state.',
      inputSchema: {
        direction: z.enum(['up', 'down']).describe('Scroll direction'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.scroll(args.direction);
      return ok(formatPageState(state));
    },
  );

  server.registerTool(
    'navigate',
    {
      description: 'Navigate browser history back or forward. Returns updated page state.',
      inputSchema: {
        direction: z.enum(['back', 'forward']).describe('Direction to navigate in browser history'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.navigateHistory(args.direction);
      return ok(formatPageState(state));
    },
  );

  server.registerTool(
    'wait_for',
    {
      description:
        'Wait for an element matching a CSS selector to appear on the page. Polls every 250ms. Returns page state when found.',
      inputSchema: {
        selector: z.string().describe('CSS selector to wait for'),
        timeout: z
          .number()
          .optional()
          .describe('Max time to wait in milliseconds (default: 10000)'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const state = await session.waitForSelector(args.selector, args.timeout);
      return ok(formatPageState(state));
    },
  );
}
