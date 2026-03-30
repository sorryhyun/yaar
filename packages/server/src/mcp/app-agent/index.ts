/**
 * MCP tools for app agents — scoped tools for app protocol communication.
 *
 * Three tools:
 * - query: read app state via app protocol (also handles app-scoped storage reads)
 * - command: send commands to the app via app protocol (also handles storage write/delete/list)
 * - relay: hand off a message to the monitor agent
 *
 * Storage access is built-in: query/command with storage paths are intercepted server-side
 * and resolved against the app's scoped storage (storage/apps/{appId}/...) automatically.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleAppQuery, handleAppCommand } from '../../features/window/app-protocol.js';
import { getWindowId, getSessionId } from '../../agents/agent-context.js';
import { getSessionHub } from '../../session/session-hub.js';
import type { WindowStateRegistry } from '../../session/window-state.js';
import {
  storageRead,
  storageWrite,
  storageList,
  storageDelete,
} from '../../storage/storage-manager.js';

export const APP_TOOL_NAMES = ['mcp__app__query', 'mcp__app__command', 'mcp__app__relay'] as const;

/** Resolve the appId for the current window context. */
function getAppId(windowState: WindowStateRegistry, windowId: string): string | undefined {
  return windowState.getAppIdForWindow(windowId);
}

/** Convert an app-relative path to the app-scoped storage path. */
function appStoragePath(appId: string, relativePath: string): string {
  const clean = relativePath.replace(/^\//, '');
  return `apps/${appId}/${clean}`;
}

export function registerAppAgentTools(server: McpServer): void {
  const getWindowState = (): WindowStateRegistry => {
    const sid = getSessionId();
    const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
    if (!session) throw new Error('No active session.');
    return session.windowState;
  };

  // query — query app state, manifest, or app-scoped storage
  server.registerTool(
    'query',
    {
      description:
        'Query the app state. Pass a stateKey to read specific state, or omit for the app manifest. ' +
        'Use stateKey starting with "storage/" to read from app-scoped storage (e.g. "storage/config.json").',
      inputSchema: {
        stateKey: z
          .string()
          .optional()
          .describe(
            'State key to query (omit for manifest). Use "storage/{path}" to read app storage.',
          ),
      },
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) {
        return { content: [{ type: 'text', text: 'Error: no active window context.' }] };
      }

      const windowState = getWindowState();

      // Intercept storage reads
      if (args.stateKey?.startsWith('storage/') || args.stateKey === 'storage') {
        const appId = getAppId(windowState, windowId);
        if (!appId) {
          return {
            content: [{ type: 'text', text: 'Error: could not resolve appId for this window.' }],
          };
        }
        const relativePath =
          args.stateKey === 'storage' ? '' : args.stateKey.slice('storage/'.length);
        if (!relativePath) {
          // List root storage
          const result = await storageList(appStoragePath(appId, ''));
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        const result = await storageRead(appStoragePath(appId, relativePath));
        if (!result.success) {
          return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
        }
        return { content: [{ type: 'text', text: result.content ?? '' }] };
      }

      return {
        ...(await handleAppQuery(windowState, windowId, {
          stateKey: args.stateKey,
        })),
      };
    },
  );

  // command — send a command to the app or manage app-scoped storage
  server.registerTool(
    'command',
    {
      description:
        'Send a command to the app. Specify the command name and optional parameters. ' +
        'Built-in storage commands: "storage:write" (params: {path, content}), ' +
        '"storage:delete" (params: {path}), "storage:list" (params: {path?}).',
      inputSchema: {
        command: z
          .string()
          .describe(
            'Command name to execute. Use "storage:write", "storage:delete", or "storage:list" for app storage.',
          ),
        params: z.record(z.string(), z.unknown()).optional().describe('Command parameters'),
      },
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) {
        return { content: [{ type: 'text', text: 'Error: no active window context.' }] };
      }

      const windowState = getWindowState();

      // Intercept storage commands
      if (args.command.startsWith('storage:')) {
        const appId = getAppId(windowState, windowId);
        if (!appId) {
          return {
            content: [{ type: 'text', text: 'Error: could not resolve appId for this window.' }],
          };
        }
        const subCommand = args.command.slice('storage:'.length);
        const path = (args.params?.path as string) ?? '';

        switch (subCommand) {
          case 'write': {
            const content = args.params?.content;
            if (typeof content !== 'string') {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'Error: "content" (string) is required for storage:write.',
                  },
                ],
              };
            }
            const result = await storageWrite(appStoragePath(appId, path), content);
            if (!result.success) {
              return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
            }
            return { content: [{ type: 'text', text: `Written to ${path}` }] };
          }
          case 'delete': {
            if (!path) {
              return {
                content: [{ type: 'text', text: 'Error: "path" is required for storage:delete.' }],
              };
            }
            const result = await storageDelete(appStoragePath(appId, path));
            if (!result.success) {
              return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
            }
            return { content: [{ type: 'text', text: `Deleted ${path}` }] };
          }
          case 'list': {
            const result = await storageList(appStoragePath(appId, path));
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }
          default:
            return {
              content: [
                {
                  type: 'text',
                  text: `Unknown storage command: ${subCommand}. Use storage:write, storage:delete, or storage:list.`,
                },
              ],
            };
        }
      }

      return {
        ...(await handleAppCommand(windowState, windowId, {
          command: args.command,
          params: args.params,
        })),
      };
    },
  );

  // relay — hand off to the monitor agent
  server.registerTool(
    'relay',
    {
      description:
        'Hand off a message to the monitor agent when the request is outside your app domain.',
      inputSchema: {
        message: z.string().describe('Message to send to the monitor agent'),
      },
    },
    async (args) => {
      const sessionId = getSessionId();
      if (!sessionId) {
        return { content: [{ type: 'text', text: 'Error: no active session.' }] };
      }

      const session = getSessionHub().get(sessionId);
      const pool = session?.getPool();
      if (!pool) {
        return { content: [{ type: 'text', text: 'Error: no active pool.' }] };
      }

      const messageId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      pool
        .handleTask({
          type: 'monitor',
          messageId,
          content: args.message,
        })
        .catch((err) => {
          console.error('[AppAgent] Relay error:', err);
        });

      return {
        content: [{ type: 'text', text: 'Message relayed to monitor agent.' }],
      };
    },
  );
}
