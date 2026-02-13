/**
 * dispatch_task MCP tool — dispatches tasks to specialized agents.
 *
 * The orchestrator (main agent) calls this to fork its session and run
 * a task agent with a profile-specific tool subset and system prompt.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { getSessionHub } from '../../session/live-session.js';
import { getMonitorId } from '../../agents/session.js';

export function registerDispatchTools(server: McpServer): void {
  server.registerTool(
    'dispatch_task',
    {
      description:
        'Dispatch a task to a specialized agent. ' +
        'The agent inherits conversation context via session fork. ' +
        'Use "profile" to select tool specialization. ' +
        'Returns when the task completes with a summary of actions taken.',
      inputSchema: {
        objective: z
          .string()
          .optional()
          .describe('Brief instruction for the task agent (it has full conversation context via fork).'),
        profile: z
          .enum(['default', 'web', 'code', 'app'])
          .optional()
          .describe('Agent profile: default=full tools, web=HTTP+display, code=sandbox+display, app=apps+HTTP+display.'),
        hint: z
          .string()
          .optional()
          .describe('Short logging label (e.g., "weather-fetch", "code-run").'),
      },
    },
    async (args) => {
      const session = getSessionHub().getDefault();
      const pool = session?.getPool();
      if (!pool) {
        return ok('Error: No active session.');
      }

      const monitorId = getMonitorId() ?? 'monitor-0';
      const result = await pool.dispatchTask({
        objective: args.objective,
        profile: args.profile,
        hint: args.hint,
        monitorId,
      });

      return ok(JSON.stringify(result));
    },
  );
}
