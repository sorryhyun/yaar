/**
 * Browser tool: open — open a URL in a visible browser window.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserPool } from '../../../lib/browser/index.js';
import { actionEmitter } from '../../action-emitter.js';
import { isDomainAllowed, extractDomain } from '../../domains.js';
import { ok, error } from '../../utils.js';
import { formatPageState } from '../../../features/browser/shared.js';

export function registerOpenTool(server: McpServer, pool: BrowserPool): void {
  server.registerTool(
    'open',
    {
      description:
        'Open a URL in a visible browser. Always creates a new browser tab/window. Returns page title, URL, text content, and the assigned browser ID.',
      inputSchema: {
        url: z.string().url().describe('The URL to navigate to'),
        browserId: z
          .string()
          .optional()
          .describe('Optional browser ID. If omitted, auto-assigns next available ID.'),
        waitUntil: z
          .enum(['load', 'domcontentloaded', 'networkidle'])
          .optional()
          .describe(
            'When to consider navigation complete: "load" (default), "domcontentloaded", or "networkidle"',
          ),
      },
    },
    async (args) => {
      try {
        const domain = extractDomain(args.url);
        if (!domain) return error('Invalid URL');

        if (!(await isDomainAllowed(domain))) {
          return error(`Domain "${domain}" not allowed. Use request_allowing_domain first.`);
        }

        const { session, browserId } = await pool.createSession(args.browserId);
        const windowId = `browser-${browserId}`;
        session.windowId = windowId;

        // Navigate first so we have a screenshot before showing the window
        const state = await session.navigate(args.url, args.waitUntil);

        // Create YAAR window with browser app iframe
        const osAction = {
          type: 'window.create' as const,
          windowId,
          title: `Browser — ${state.title || domain}`,
          bounds: {
            x: 80 + Number(browserId) * 30,
            y: 60 + Number(browserId) * 30,
            w: 900,
            h: 650,
          },
          content: {
            renderer: 'iframe',
            data: `/api/apps/browser/index.html?browserId=${browserId}`,
          },
        };

        await actionEmitter.emitActionWithFeedback(osAction, 3000);
        console.log(`[browser:open] [browser:${browserId}] → ${state.title || '(no title)'}`);
        return ok(`[browser:${browserId}]\n${formatPageState(state)}`);
      } catch (err) {
        console.error(`[browser:open] Error:`, err);
        return error(`Browser open failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
