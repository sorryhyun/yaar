/**
 * MCP tools for app agents — scoped tools for app protocol communication.
 *
 * Three tools:
 * - app_query: read app state via app protocol
 * - app_command: send commands to the app via app protocol
 * - relay: hand off a message to the main agent
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleAppQuery, handleAppCommand } from '../../features/window/app-protocol.js';
import { getWindowId, getSessionId } from '../../agents/session.js';
import { getSessionHub } from '../../session/session-hub.js';
import type { WindowStateRegistry } from '../../session/window-state.js';

export const APP_TOOL_NAMES = [
  'mcp__app__app_query',
  'mcp__app__app_command',
  'mcp__app__relay',
] as const;

export function registerAppAgentTools(server: McpServer): void {
  const getWindowState = (): WindowStateRegistry => {
    const sid = getSessionId();
    const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
    if (!session) throw new Error('No active session.');
    return session.windowState;
  };

  // app_query — query app state or manifest
  server.registerTool(
    'app_query',
    {
      description:
        'Query the app state. Pass a stateKey to read specific state, or omit for the app manifest.',
      inputSchema: {
        stateKey: z.string().optional().describe('State key to query (omit for manifest)'),
      },
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) {
        return { content: [{ type: 'text', text: 'Error: no active window context.' }] };
      }

      const windowState = getWindowState();
      const result = await handleAppQuery(windowState, windowId, {
        stateKey: args.stateKey,
      });

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          },
        ],
      };
    },
  );

  // app_command — send a command to the app
  server.registerTool(
    'app_command',
    {
      description: 'Send a command to the app. Specify the command name and optional parameters.',
      inputSchema: {
        command: z.string().describe('Command name to execute'),
        params: z.record(z.string(), z.unknown()).optional().describe('Command parameters'),
      },
    },
    async (args) => {
      const windowId = getWindowId();
      if (!windowId) {
        return { content: [{ type: 'text', text: 'Error: no active window context.' }] };
      }

      const windowState = getWindowState();
      const result = await handleAppCommand(windowState, windowId, {
        command: args.command,
        params: args.params,
      });

      return {
        content: [
          {
            type: 'text',
            text:
              typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          },
        ],
      };
    },
  );

  // relay — hand off to the main agent
  server.registerTool(
    'relay',
    {
      description:
        'Hand off a message to the main agent when the request is outside your app domain.',
      inputSchema: {
        message: z.string().describe('Message to send to the main agent'),
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
          type: 'main',
          messageId,
          content: args.message,
        })
        .catch((err) => {
          console.error('[AppAgent] Relay error:', err);
        });

      return {
        content: [{ type: 'text', text: 'Message relayed to main agent.' }],
      };
    },
  );
}
