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
  // app_get_manifest
  server.registerTool(
    'app_get_manifest',
    {
      description: 'Discover what state queries and commands an iframe app supports. Returns the app manifest with available state keys and command names, their descriptions, and JSON schemas.',
      inputSchema: {
        windowId: z.string().describe('ID of the window containing the iframe app'),
      },
    },
    async (args) => {
      const win = getWindowState().getWindow(args.windowId);
      if (!win) return ok(`Window "${args.windowId}" not found.`);
      if (win.content.renderer !== 'iframe') return ok(`Window "${args.windowId}" is not an iframe app (renderer: ${win.content.renderer}).`);

      const response = await actionEmitter.emitAppProtocolRequest(args.windowId, { kind: 'manifest' }, 5000);
      if (!response) return ok('App did not respond to manifest request (timeout). The app may not support the App Protocol.');
      if (response.kind !== 'manifest') return ok('Unexpected response kind.');
      if (response.error) return ok(`Error: ${response.error}`);
      return ok(JSON.stringify(response.manifest, null, 2));
    }
  );

  // app_query
  server.registerTool(
    'app_query',
    {
      description: 'Read structured state from an iframe app by key. Use app_get_manifest first to discover available state keys.',
      inputSchema: {
        windowId: z.string().describe('ID of the window containing the iframe app'),
        stateKey: z.string().describe('The state key to query (e.g., "cells", "selection")'),
      },
    },
    async (args) => {
      const win = getWindowState().getWindow(args.windowId);
      if (!win) return ok(`Window "${args.windowId}" not found.`);
      if (win.content.renderer !== 'iframe') return ok(`Window "${args.windowId}" is not an iframe app.`);

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
      description: 'Execute a command on an iframe app. Use app_get_manifest first to discover available commands and their parameter schemas.',
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
