/**
 * Browser tools: list, close — browser lifecycle management.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserPool } from '../../../lib/browser/index.js';
import { actionEmitter } from '../../action-emitter.js';
import { ok } from '../../utils.js';

export function registerManageTools(server: McpServer, pool: BrowserPool): void {
  server.registerTool(
    'list',
    {
      description: 'List all open browsers with their IDs, URLs, and titles.',
      inputSchema: {},
    },
    async () => {
      const browsers = pool.getAllSessions();
      if (browsers.size === 0) return ok('No browsers open.');
      const lines = [...browsers.entries()].map(([bid, s]) => {
        let line = `[browser:${bid}] ${s.currentUrl} — ${s.currentTitle || '(no title)'}`;
        if (s.openerBrowserId !== undefined) line += ` (opened by browser:${s.openerBrowserId})`;
        return line;
      });
      return ok(lines.join('\n'));
    },
  );

  server.registerTool(
    'close',
    {
      description:
        'Close a browser and its window. If browserId is given, closes that browser. If omitted and exactly one browser is open, closes it. If multiple are open and no browserId is given, closes all.',
      inputSchema: {
        browserId: z
          .string()
          .optional()
          .describe('Browser ID to close. If omitted, closes the only browser or all browsers.'),
      },
    },
    async (args) => {
      const browsers = pool.getAllSessions();

      if (browsers.size === 0) return ok('No browser to close.');

      if (args.browserId !== undefined) {
        const session = pool.getSession(args.browserId);
        if (!session) return ok(`No browser with ID ${args.browserId}.`);
        if (session.windowId) {
          actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
        }
        await pool.closeSession(args.browserId);
        return ok(`Browser ${args.browserId} closed.`);
      }

      if (browsers.size === 1) {
        const [browserId, session] = [...browsers.entries()][0];
        if (session.windowId) {
          actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
        }
        await pool.closeSession(browserId);
        return ok('Browser closed.');
      }

      // Multiple browsers — close all
      const ids = [...browsers.keys()];
      for (const [browserId, session] of browsers) {
        if (session.windowId) {
          actionEmitter.emitAction({ type: 'window.close', windowId: session.windowId });
        }
        await pool.closeSession(browserId);
      }
      return ok(`All browsers closed (${ids.join(', ')}).`);
    },
  );

  server.registerTool(
    'switch',
    {
      description:
        'Switch the active browser context to another tab by ID. Use browser:list to see available tabs.',
      inputSchema: {
        browserId: z.string().describe('Browser ID to switch to'),
      },
    },
    async (args) => {
      const session = pool.getSession(args.browserId);
      if (!session)
        return ok(`No browser with ID ${args.browserId}. Use browser:list to see open browsers.`);
      return ok(
        `Switched to browser ${args.browserId}: ${session.currentUrl} — ${session.currentTitle || '(no title)'}`,
      );
    },
  );
}
