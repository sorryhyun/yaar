/**
 * App Protocol tools - agent ↔ iframe app communication.
 *
 * Provides MCP tools for discovering app capabilities (manifest),
 * reading app state (query), and executing app commands (command).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { actionEmitter } from '../action-emitter.js';
import type { WindowStateRegistry } from '../window-state.js';
import { ok } from '../utils.js';

export function registerAppProtocolTools(server: McpServer, getWindowState: () => WindowStateRegistry): void {
  // app_query
  server.registerTool(
    'app_query',
    {
      description: 'Read structured state from an iframe app by key. Use stateKey "manifest" to discover available state keys and commands.',
      inputSchema: {
        windowId: z.string().describe('ID of the window containing the iframe app'),
        stateKey: z.string().describe('The state key to query. Use "manifest" to discover available state keys and commands.'),
      },
    },
    async (args) => {
      const win = getWindowState().getWindow(args.windowId);
      if (!win) return ok(`Window "${args.windowId}" not found.`);
      if (win.content.renderer !== 'iframe') return ok(`Window "${args.windowId}" is not an iframe app.`);

      if (args.stateKey === 'manifest') {
        const response = await actionEmitter.emitAppProtocolRequest(args.windowId, { kind: 'manifest' }, 5000);
        if (!response) return ok('App did not respond to manifest request (timeout). The app may not support the App Protocol.');
        if (response.kind !== 'manifest') return ok('Unexpected response kind.');
        if (response.error) return ok(`Error: ${response.error}`);
        return ok(JSON.stringify(response.manifest, null, 2));
      }

      const response = await actionEmitter.emitAppProtocolRequest(args.windowId, { kind: 'query', stateKey: args.stateKey }, 5000);
      if (!response) return ok('App did not respond (timeout).');
      if (response.kind !== 'query') return ok('Unexpected response kind.');
      if (response.error) return ok(`Error: ${response.error}`);
      return ok(JSON.stringify(response.data, null, 2));
    }
  );

  // app_command
  server.registerTool(
    'app_command',
    {
      description: 'Execute a command on an iframe app. Use app_query with stateKey "manifest" first to discover available commands and their parameter schemas.',
      inputSchema: {
        windowId: z.string().describe('ID of the window containing the iframe app'),
        command: z.string().describe('The command name to execute (e.g., "setCells", "selectCell")'),
        params: z.record(z.string(), z.unknown()).optional().describe('Parameters for the command, as described in the manifest'),
      },
    },
    async (args) => {
      const win = getWindowState().getWindow(args.windowId);
      if (!win) return ok(`Window "${args.windowId}" not found.`);
      if (win.content.renderer !== 'iframe') return ok(`Window "${args.windowId}" is not an iframe app.`);

      const response = await actionEmitter.emitAppProtocolRequest(args.windowId, { kind: 'command', command: args.command, params: args.params }, 5000);
      if (!response) return ok('App did not respond (timeout).');
      if (response.kind !== 'command') return ok('Unexpected response kind.');
      if (response.error) return ok(`Error: ${response.error}`);
      return ok(JSON.stringify(response.result, null, 2));
    }
  );
}
