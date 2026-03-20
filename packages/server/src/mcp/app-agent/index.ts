/**
 * MCP tools for app agents — scoped tools for app protocol communication.
 *
 * Three tools:
 * - query: read app state via app protocol
 * - command: send commands to the app via app protocol
 * - relay: hand off a message to the monitor agent
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { handleAppQuery, handleAppCommand } from '../../features/window/app-protocol.js';
import { getWindowId, getSessionId } from '../../agents/session.js';
import { getSessionHub } from '../../session/session-hub.js';
import type { WindowStateRegistry } from '../../session/window-state.js';

export const APP_TOOL_NAMES = ['mcp__app__query', 'mcp__app__command', 'mcp__app__relay'] as const;

export function registerAppAgentTools(server: McpServer): void {
  const getWindowState = (): WindowStateRegistry => {
    const sid = getSessionId();
    const session = sid ? getSessionHub().get(sid) : getSessionHub().getDefault();
    if (!session) throw new Error('No active session.');
    return session.windowState;
  };

  // query — query app state or manifest
  server.registerTool(
    'query',
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
      return {
        ...(await handleAppQuery(windowState, windowId, {
          stateKey: args.stateKey,
        })),
      };
    },
  );

  // command — send a command to the app
  server.registerTool(
    'command',
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
