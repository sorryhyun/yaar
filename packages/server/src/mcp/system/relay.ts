/**
 * Relay tool — window/task agent → main agent communication.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { getSessionHub } from '../../session/session-hub.js';
import { getAgentId, getSessionId, getMonitorId } from '../../agents/session.js';

export function registerRelayTools(server: McpServer): void {
  server.registerTool(
    'relay_to_main',
    {
      description:
        'Relay a message to the main agent, triggering a new turn. Use after completing significant work (form processing, data retrieval) that the main agent should act on.',
      inputSchema: {
        message: z
          .string()
          .describe('Summary of what happened and what the main agent should do next'),
      },
    },
    async (args) => {
      const sid = getSessionId();
      const session = sid ? getSessionHub().get(sid) : null;
      if (!session) return error('No active session.');
      const pool = session.getPool();
      if (!pool) return error('Agent pool not initialized.');

      const agentId = getAgentId() ?? 'unknown';
      const monitorId = getMonitorId() ?? 'monitor-0';
      const messageId = `relay-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const content = `<relay from="${agentId}">\n${args.message}\n</relay>`;

      pool
        .handleTask({ type: 'main', messageId, content, monitorId })
        .catch((err) => console.error('[relay_to_main] Failed:', err));

      return ok(`Relayed to main agent (messageId: ${messageId}).`);
    },
  );
}
