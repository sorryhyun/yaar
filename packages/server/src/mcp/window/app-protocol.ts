/**
 * App Protocol tools - agent <-> iframe app communication.
 *
 * Provides MCP tools for reading app state (query) and executing app commands (command).
 * Both tools use URI-only addressing.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppProtocolRequest } from '@yaar/shared';
import { parseWindowResourceUri } from '@yaar/shared';
import { z } from 'zod';
import { actionEmitter } from '../action-emitter.js';
import type { WindowStateRegistry } from '../window-state.js';
import { ok, error } from '../utils.js';
import { enrichManifestWithUris } from './manifest-utils.js';
import { resolveWindowId } from './resolve-window.js';

export function registerAppProtocolTools(
  server: McpServer,
  getWindowState: () => WindowStateRegistry,
): void {
  // app_query
  server.registerTool(
    'app_query',
    {
      description:
        'Read structured state from an iframe app. Use a resource URI for state, or a bare window URI for the manifest.',
      inputSchema: {
        uri: z
          .string()
          .describe(
            'Window resource URI (e.g., "yaar://monitor-0/win-excel/state/cells") or bare window URI/ID for manifest.',
          ),
      },
    },
    async (args) => {
      let windowId: string;
      let stateKey: string;

      const resource = parseWindowResourceUri(args.uri);
      if (resource) {
        if (resource.resourceType !== 'state')
          return error('URI points to a command. Use app_command instead.');
        windowId = resource.windowId;
        stateKey = resource.key;
      } else {
        windowId = resolveWindowId(args.uri);
        stateKey = 'manifest';
      }

      const win = getWindowState().getWindow(windowId);
      if (!win) return error(`Window "${windowId}" not found.`);
      if (win.content.renderer !== 'iframe')
        return error(`Window "${windowId}" is not an iframe app.`);

      // Wait for the app to register with the App Protocol before querying
      if (!win.appProtocol) {
        const ready = await actionEmitter.waitForAppReady(windowId, 5000);
        if (!ready)
          return error(
            'App did not register with the App Protocol (timeout). The iframe app may not call window.yaar.app.register().',
          );
      }

      if (stateKey === 'manifest') {
        const response = await actionEmitter.emitAppProtocolRequest(
          windowId,
          { kind: 'manifest' },
          5000,
        );
        if (!response)
          return error(
            'App did not respond to manifest request (timeout). The app may not support the App Protocol.',
          );
        if (response.kind !== 'manifest') return error('Unexpected response kind.');
        if (response.error) return error(response.error);
        const manifest = response.manifest;
        if (manifest) enrichManifestWithUris(manifest, win.id);
        return ok(JSON.stringify(manifest, null, 2));
      }

      const response = await actionEmitter.emitAppProtocolRequest(
        windowId,
        { kind: 'query', stateKey },
        5000,
      );
      if (!response) return error('App did not respond (timeout).');
      if (response.kind !== 'query') return error('Unexpected response kind.');
      if (response.error) return error(response.error);
      return ok(JSON.stringify(response.data, null, 2));
    },
  );

  // app_command
  server.registerTool(
    'app_command',
    {
      description: 'Execute a command on an iframe app via a command URI.',
      inputSchema: {
        uri: z
          .string()
          .describe('Window command URI (e.g., "yaar://monitor-0/win-excel/commands/save").'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Parameters for the command, as described in the manifest'),
      },
    },
    async (args) => {
      const resource = parseWindowResourceUri(args.uri);
      if (!resource || resource.resourceType !== 'commands')
        return error('Invalid command URI. Expected yaar://{monitor}/{window}/commands/{name}.');
      const { windowId } = resource;
      const command = resource.key;

      const win = getWindowState().getWindow(windowId);
      if (!win) return error(`Window "${windowId}" not found.`);
      if (win.content.renderer !== 'iframe')
        return error(`Window "${windowId}" is not an iframe app.`);

      // Wait for the app to register with the App Protocol before sending commands
      if (!win.appProtocol) {
        const ready = await actionEmitter.waitForAppReady(windowId, 5000);
        if (!ready)
          return error(
            'App did not register with the App Protocol (timeout). The iframe app may not call window.yaar.app.register().',
          );
      }

      const request: AppProtocolRequest = {
        kind: 'command',
        command,
        params: args.params,
      };
      const response = await actionEmitter.emitAppProtocolRequest(windowId, request, 5000);
      if (!response) return error('App did not respond (timeout).');
      if (response.kind !== 'command') return error('Unexpected response kind.');
      if (response.error) return error(response.error);
      getWindowState().recordAppCommand(windowId, request);
      return ok(JSON.stringify(response.result, null, 2));
    },
  );
}
